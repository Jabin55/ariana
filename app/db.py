"""회원·수업·출결·퀴즈 결과를 저장하는 데이터베이스.

DATABASE_URL 이 있으면 PostgreSQL(예: Neon 무료), 없으면 로컬 SQLite 파일을 쓴다.
Render 무료 서버는 껐다 켜면 파일이 지워지므로, 배포할 때는 반드시 DATABASE_URL 을 설정한다.
"""

from __future__ import annotations

import asyncio
import os
import time

from sqlalchemy import (
    Column, Float, Integer, MetaData, String, Table, Text, UniqueConstraint, create_engine, inspect, text,
    update,
)

_url = os.environ.get("DATABASE_URL", "sqlite:///./live.db")
if _url.startswith("postgres://"):
    _url = "postgresql://" + _url[len("postgres://"):]
if _url.startswith("postgresql://"):
    _url = "postgresql+psycopg://" + _url[len("postgresql://"):]

_args = {"check_same_thread": False} if _url.startswith("sqlite") else {}
engine = create_engine(_url, pool_pre_ping=True, pool_recycle=280, connect_args=_args)
metadata = MetaData()

users = Table(
    "users", metadata,
    Column("id", Integer, primary_key=True),
    Column("google_sub", String(64), unique=True, nullable=False),
    Column("email", String(200), nullable=False, index=True),
    Column("google_name", String(100), default=""),
    Column("role", String(10), nullable=False),  # student | teacher
    Column("name", String(30), default=""),  # 실명 (학생이 확인·수정)
    Column("school", String(60), default=""),
    Column("grade", Integer),
    Column("class_no", Integer),
    Column("number", Integer),
    Column("created_at", Float, nullable=False),
    Column("last_login", Float),
    Column("terms_version", String(10), nullable=False, default=""),  # 확인(동의)한 이용약관·처리방침 시행일
    Column("terms_at", Float),
    Column("ai_ok_at", Float),  # AI 조교 국외 전송 안내를 확인한 시각
    # 학교 계정으로 처음 로그인했을 때 고른 것: student(학생) staff(선생님 → 강사·관리교사 신청). 비면 아직 안 고름
    Column("self_role", String(10), nullable=False, default=""),
    # 학생 탈퇴 신청: 거점학교 관리교사(또는 전체 관리자)가 승인하면 계정과 기록을 지운다
    Column("birth", String(10), nullable=False, default=""),
    Column("name_locked", Integer, nullable=False, default=0),
    Column("gender", String(2), nullable=False, default=""),  # 성별 (선생님 회원 정보: 남·여)
    Column("contact_email", String(200), nullable=False, default=""),  # 연락받을 이메일 (선생님)
    Column("phone", String(100), nullable=False, default=""),  # 연락처 (선생님)
    Column("position", String(30), nullable=False, default=""),  # 직위 (선생님: 교사·부장교사·교감 등)
    Column("subjects", String(300), nullable=False, default=""),  # 담당과목 (강의교사)  # 가입 때 적은 실명은 바꿀 수 없다 (전체 관리자만)  # 생년월일 (선생님 가입 정보, YYYY-MM-DD)
    Column("withdraw_at", Float),  # 신청한 시각 (비면 신청 안 함)
    Column("withdraw_reason", String(300), nullable=False, default=""),
    Column("withdraw_note", String(300), nullable=False, default=""),  # 반려 사유 (학생에게 보임)
)

site_settings = Table(
    "site_settings", metadata,  # 전체 관리자가 화면에서 바꾸는 설정 (예: 학교 목록)
    Column("key", String(40), primary_key=True),
    Column("value", Text, nullable=False),
)

course_notices = Table(
    "course_notices", metadata,  # 강좌 공지사항 (강사 → 그 강좌 수강생)
    Column("id", Integer, primary_key=True),
    Column("course_id", Integer, nullable=False, index=True),
    Column("title", String(120), nullable=False),
    Column("body", Text, nullable=False, default=""),
    Column("author", String(30), nullable=False, default=""),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float),
)

meetings = Table(
    "meetings", metadata,  # 예약한 특강·회의 (입장 코드를 미리 받아 두고, 그 시각에 연다)
    Column("id", Integer, primary_key=True),
    Column("teacher_id", Integer, nullable=False, index=True),
    Column("title", String(60), nullable=False),
    Column("code", String(8), nullable=False, index=True),
    Column("start_at", Float, nullable=False),  # 예약 시각
    Column("created_at", Float, nullable=False),
    Column("class_id", Integer),  # 연 뒤의 수업 번호
)

course_sessions = Table(
    "course_sessions", metadata,  # 강좌 회차 (날짜·시각·주제)
    Column("id", Integer, primary_key=True),
    Column("course_id", Integer, nullable=False, index=True),
    Column("no", Integer, nullable=False),
    Column("date", String(10), nullable=False),
    Column("start", String(5), nullable=False, default=""),
    Column("end", String(5), nullable=False, default=""),
    Column("topic", String(120), nullable=False, default=""),
)

announcements = Table(
    "announcements", metadata,  # 수업 중 선생님이 띄운 공지 (학습 관리에서 '언제 어떤 공지를 했는지' 보기)
    Column("id", Integer, primary_key=True),
    Column("class_id", Integer, nullable=False, index=True),
    Column("text", Text, nullable=False),
    Column("created_at", Float, nullable=False),
)

withdrawn = Table(
    "withdrawn", metadata,  # 탈퇴 처리 기록: 탈퇴한 학생은 계정·수업 기록을 지우고 이것만 남긴다 (참여학교 담당교사 목록용)
    Column("id", Integer, primary_key=True),
    Column("name", String(30), nullable=False, default=""),
    Column("school", String(60), nullable=False, default="", index=True),
    Column("student_no", String(10), nullable=False, default=""),
    Column("grade", Integer),
    Column("class_no", Integer),
    Column("reason", String(300), nullable=False, default=""),
    Column("requested_at", Float),
    Column("approved_at", Float, nullable=False),
    Column("approved_by", String(30), nullable=False, default=""),  # 승인한 선생님 이름
)

course_requests = Table(
    "course_requests", metadata,  # 학생이 듣고 싶은 과목 개설 요청 (관리교사·전체 관리자가 모아 본다)
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False, index=True),
    Column("subject", String(60), nullable=False),
    Column("note", String(300), nullable=False, default=""),
    Column("created_at", Float, nullable=False),
)

notices = Table(
    "notices", metadata,  # 공지사항 (전체 관리자가 쓴다, 누구나 본다)
    Column("id", Integer, primary_key=True),
    Column("title", String(120), nullable=False),
    Column("body", Text, nullable=False, default=""),
    Column("pinned", Integer, nullable=False, default=0),  # 위에 고정
    Column("author", String(30), nullable=False, default=""),
    Column("author_id", Integer),  # 쓴 선생님 (고치기·지우기는 쓴 사람과 전체 관리자만)
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float),
)

hubs = Table(
    "hubs", metadata,  # 거점학교 (전체 관리자가 관리교사를 승인할 때 만들어진다)
    Column("id", Integer, primary_key=True),
    Column("name", String(60), nullable=False, unique=True),
    Column("created_at", Float, nullable=False),
)

memberships = Table(
    "memberships", metadata,  # 관리교사·강사 등록 신청과 승인 (한 사람이 여러 거점학교·역할을 가질 수 있음)
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False, index=True),
    Column("role", String(12), nullable=False),  # coordinator(거점학교 관리교사) instructor(강사) participant(참여학교 담당교사)
    Column("hub_id", Integer, index=True),  # 강사: 신청한 거점학교 / 관리교사: 승인 때 정해짐
    Column("hub_name", String(60), nullable=False, default=""),  # 관리교사: 신청한 거점학교명 / 참여학교 담당교사: 소속 학교
    Column("status", String(10), nullable=False),  # pending(대기) approved(승인) rejected(거절) revoked(해제)
    Column("kind", String(15), nullable=False, default=""),  # (더 이상 쓰지 않음: 예전 정규·보충수업 구분)
    Column("contact", String(100), nullable=False, default=""),
    Column("message", String(500), nullable=False, default=""),
    Column("valid_from", String(10), nullable=False, default=""),  # 활동 기간 (비우면 제한 없음)
    Column("valid_until", String(10), nullable=False, default=""),
    Column("wish_from", String(10), nullable=False, default=""),  # 강사가 신청서에 적은 희망 기간
    Column("wish_until", String(10), nullable=False, default=""),
    # 신청서: 소속 구분(school 학교 교원 / univ 대학 교원 / cert 교원자격 소지자 / other 기타)·교육청·교원자격·이메일
    Column("affil_type", String(10), nullable=False, default=""),
    Column("office", String(30), nullable=False, default=""),
    Column("license", String(100), nullable=False, default=""),
    Column("email", String(200), nullable=False, default=""),
    Column("pledge_at", Float),  # 개인정보 보호 서약에 동의한 시각
    Column("requested_at", Float, nullable=False),
    Column("decided_at", Float),
    Column("decided_by", Integer),
    Column("admin_note", String(300), nullable=False, default=""),
)

courses = Table(
    "courses", metadata,  # 학기 초에 선생님이 여는 강좌. 학생은 수강신청하고 선생님이 승인한다.
    Column("id", Integer, primary_key=True),
    Column("teacher_id", Integer, nullable=False, index=True),
    Column("title", String(60), nullable=False),  # 강의명
    Column("description", Text, nullable=False, default=""),  # 수업 소개
    Column("school", String(60), nullable=False, default=""),  # 개설한 선생님의 학교 (참고용)
    Column("instructor", String(30), nullable=False, default=""),  # 강사명
    Column("hub_school", String(60), nullable=False, default=""),  # 거점학교명
    Column("start_date", String(10), nullable=False, default=""),  # 강의기간 시작 (YYYY-MM-DD)
    Column("end_date", String(10), nullable=False, default=""),  # 강의기간 끝
    Column("hub_id", Integer, index=True),  # 거점학교 강좌면 관리교사의 최종 승인이 필요
    Column("grades", String(10), nullable=False, default=""),  # 대상 학년 (예: "1,2"). 비면 모든 학년
    # 과목 정보 (2022 개정 교육과정). title 이 과목명
    Column("subject_group", String(40), nullable=False, default=""),  # 교과(군)
    Column("subject_area", String(20), nullable=False, default=""),  # 교과(영역): 국어·수학·사회 등
    Column("subject_type", String(10), nullable=False, default=""),  # 과목 구분: 일반선택·진로선택·융합선택
    Column("custom_subject", Integer, nullable=False, default=0),  # 고시외 과목
    Column("school_year", Integer),  # 학년도
    Column("term", String(10), nullable=False, default=""),  # 수업 학기: 1학기·여름학기·2학기·겨울학기
    Column("credits", Integer),  # 학점
    Column("hours", Integer),  # 수업 시수 (학점 × 16)
    Column("achievement", String(2), nullable=False, default=""),  # 성취도: 5(A~E) 3(A~C) P(P/F)
    Column("capacity", Integer),  # 수강 인원 (비면 제한 없음)
    Column("recruit_start", String(10), nullable=False, default=""),  # 모집 기간 (비면 제한 없음)
    Column("recruit_end", String(10), nullable=False, default=""),
    Column("exam_ratio", Integer),  # 지필평가 비율(%)
    Column("perf_ratio", Integer),  # 수행평가 비율(%)
    Column("syllabus_id", String(16), nullable=False, default=""),  # 수업계획서 파일 (FILES_DIR/syllabus/강좌번호/id)
    Column("syllabus_name", String(150), nullable=False, default=""),
    Column("team_teaching", Integer, nullable=False, default=0),  # 팀티칭
    Column("co_teachers", String(300), nullable=False, default=""),  # 팀티칭 보조교사 사용자 번호 (",3,7,")
    Column("subject", String(60), nullable=False, default=""),  # 과목 (2022 개정 교육과정). title 은 수업명
    Column("schools", Text, nullable=False, default=""),  # 참여 학교 (한 줄에 하나). 비면 울산 모든 고등학교
    Column("contact_email", String(200), nullable=False, default=""),  # 담당 교강사 연락처
    Column("contact_phone", String(40), nullable=False, default=""),
    Column("show_email", Integer, nullable=False, default=0),  # 수강생·방문자에게 공개
    Column("show_phone", Integer, nullable=False, default=0),
    Column("recruit_start_time", String(5), nullable=False, default=""),  # 모집 시작·끝 시각 (HH:MM)
    Column("recruit_end_time", String(5), nullable=False, default=""),
    Column("class_days", String(20), nullable=False, default=""),  # 수업 요일 (0=일 … 6=토, 예: "2,4")
    Column("class_start", String(5), nullable=False, default=""),  # 수업 시각
    Column("class_end", String(5), nullable=False, default=""),
    Column("open", Integer, nullable=False, default=1),  # 수강신청을 받는 중
    Column("archived", Integer, nullable=False, default=0),  # 학기가 끝나 보관함으로
    # 강좌 개설 승인 (거점학교 관리교사): pending(대기) approved(승인) rejected(반려). 승인돼야 수강신청·수업을 받는다
    Column("approval", String(10), nullable=False, default="approved"),
    Column("approval_note", String(300), nullable=False, default=""),  # 반려 사유 (강사에게 보임)
    Column("approved_by", Integer),
    Column("created_at", Float, nullable=False),
)

enrollments = Table(
    "enrollments", metadata,
    Column("id", Integer, primary_key=True),
    Column("course_id", Integer, nullable=False, index=True),
    Column("user_id", Integer, nullable=False, index=True),
    # pending(강사 승인 대기) approved(수강 확정) rejected(거절). (instructor_ok: 예전 관리교사 최종 승인 대기 → approved로 바꿔 둠)
    Column("status", String(15), nullable=False),
    Column("requested_at", Float, nullable=False),
    Column("decided_at", Float),
    Column("instructor_by", Integer),  # 1차 승인한 강사
    Column("coordinator_by", Integer),  # 최종 승인한 관리교사
    Column("note", String(300), nullable=False, default=""),  # 거절 사유 등 (학생에게 보임)
    UniqueConstraint("course_id", "user_id"),
)

classes = Table(
    "classes", metadata,
    Column("id", Integer, primary_key=True),
    Column("code", String(8), nullable=False, index=True),
    Column("title", String(60), nullable=False),
    Column("teacher_id", Integer, nullable=False, index=True),
    Column("school", String(60), default=""),
    Column("target_grade", Integer),
    Column("target_class", Integer),
    Column("created_at", Float, nullable=False, index=True),
    Column("ended_at", Float),
    Column("results_public", Integer, nullable=False, default=0),  # 채점 결과를 학생에게 공개
    Column("course_id", Integer, index=True),  # 강좌 수업이면 승인된 수강생만, 코드 없이 입장
)

attendance = Table(
    "attendance", metadata,
    Column("id", Integer, primary_key=True),
    Column("class_id", Integer, nullable=False, index=True),
    Column("user_id", Integer, nullable=False, index=True),
    Column("joined_at", Float, nullable=False),
    Column("left_at", Float),
    Column("last_seen", Float, nullable=False),
    # 나간 이유: leave(나가기 버튼) closed(창 닫음·새로고침) network(연결 끊김)
    #           kicked(내보냄) ended(수업 종료) server(서버 재시작)
    Column("left_reason", String(10)),
)

questions = Table(
    "questions", metadata,  # 수업 중 '선생님께 질문'과 선생님 답변 (영구 보관)
    Column("id", Integer, primary_key=True),
    Column("uid", String(32), unique=True, nullable=False),  # 화면에서 쓰는 질문 번호
    Column("class_id", Integer, nullable=False, index=True),
    Column("user_id", Integer, nullable=False, index=True),
    Column("text", Text, nullable=False),
    Column("reply", Text, nullable=False, default=""),
    Column("done", Integer, nullable=False, default=0),
    Column("created_at", Float, nullable=False),
    Column("replied_at", Float),
)

activities = Table(
    "activities", metadata,
    Column("id", Integer, primary_key=True),
    Column("class_id", Integer, nullable=False, index=True),
    Column("kind", String(10), nullable=False),
    Column("prompt", Text, nullable=False),
    Column("options", Text, nullable=False),  # JSON 목록
    Column("correct", Integer),
    Column("responses", Text, nullable=False),  # JSON {user_id: 값}
    Column("created_at", Float, nullable=False),
    Column("points", Float, nullable=False, default=1),  # 배점
)

materials = Table(
    "materials", metadata,  # 수업 때 올린 발표 자료(PDF). 수업이 끝나도 남아 못 들은 학생도 다시 본다
    Column("id", String(16), primary_key=True),  # 파일 이름으로도 쓴다 (SLIDES_DIR/수업번호/id.pdf)
    Column("class_id", Integer, nullable=False, index=True),
    Column("teacher_id", Integer, nullable=False),
    Column("name", String(120), nullable=False),
    Column("pages", Integer, nullable=False, default=0),
    Column("size", Integer, nullable=False, default=0),
    Column("created_at", Float, nullable=False),
)

boards = Table(
    "boards", metadata,  # 쪽마다 선생님 판서 (자료 위 판서 'id:쪽', 화이트보드 'wb:쪽')
    Column("id", Integer, primary_key=True),
    Column("class_id", Integer, nullable=False, index=True),
    Column("key", String(40), nullable=False),
    Column("strokes", Text, nullable=False),  # JSON 목록
    Column("updated_at", Float, nullable=False),
    UniqueConstraint("class_id", "key"),
)

assignments = Table(
    "assignments", metadata,  # 강좌 과제 (선생님이 내고, 수강 확정 학생이 파일·글로 제출)
    Column("id", Integer, primary_key=True),
    Column("course_id", Integer, nullable=False, index=True),
    Column("teacher_id", Integer, nullable=False),
    Column("title", String(80), nullable=False),
    Column("description", Text, nullable=False, default=""),
    Column("due_at", Float),  # 마감 시각 (없으면 마감 없음)
    Column("allow_late", Integer, nullable=False, default=1),  # 마감 뒤에도 제출 받기(지각 표시)
    Column("closed", Integer, nullable=False, default=0),  # 제출 막기
    Column("created_at", Float, nullable=False),
)

submissions = Table(
    "submissions", metadata,
    Column("id", Integer, primary_key=True),
    Column("assignment_id", Integer, nullable=False, index=True),
    Column("user_id", Integer, nullable=False, index=True),
    Column("text", Text, nullable=False, default=""),
    Column("submitted_at", Float),  # 마지막으로 낸 시각 (비면 아직 안 냄)
    Column("score", Float),
    Column("feedback", Text, nullable=False, default=""),
    Column("graded_at", Float),
    UniqueConstraint("assignment_id", "user_id"),
)

submission_files = Table(
    "submission_files", metadata,
    Column("id", String(16), primary_key=True),  # 파일 이름으로도 쓴다 (FILES_DIR/assignments/과제번호/id)
    Column("submission_id", Integer, nullable=False, index=True),
    Column("name", String(150), nullable=False),
    Column("size", Integer, nullable=False),
    Column("content_type", String(100), nullable=False, default="application/octet-stream"),
    Column("created_at", Float, nullable=False),
)

grades = Table(
    "grades", metadata,  # 수업이 끝난 뒤 선생님이 매긴 점수·피드백 (자동 채점을 덮어쓸 수도 있음)
    Column("id", Integer, primary_key=True),
    Column("activity_id", Integer, nullable=False, index=True),
    Column("user_id", Integer, nullable=False),
    Column("score", Float),
    Column("feedback", Text, nullable=False, default=""),
    Column("graded_at", Float, nullable=False),
    UniqueConstraint("activity_id", "user_id"),
)


def init() -> None:
    metadata.create_all(engine)
    # 예전 버전으로 만든 표에 새 칸 추가
    added = [("attendance", "left_reason", "VARCHAR(10)"),
             ("classes", "results_public", "INTEGER NOT NULL DEFAULT 0"),
             ("activities", "points", "FLOAT NOT NULL DEFAULT 1"),
             ("classes", "course_id", "INTEGER"),
             ("courses", "instructor", "VARCHAR(30) NOT NULL DEFAULT ''"),
             ("courses", "hub_school", "VARCHAR(60) NOT NULL DEFAULT ''"),
             ("courses", "start_date", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("courses", "end_date", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("courses", "hub_id", "INTEGER"),
             ("enrollments", "instructor_by", "INTEGER"),
             ("enrollments", "coordinator_by", "INTEGER"),
             ("enrollments", "note", "VARCHAR(300) NOT NULL DEFAULT ''"),
             ("memberships", "wish_from", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("memberships", "wish_until", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("users", "terms_version", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("users", "terms_at", "FLOAT"),
             ("users", "ai_ok_at", "FLOAT"),
             ("users", "self_role", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("courses", "grades", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("users", "withdraw_at", "FLOAT"),
             ("users", "withdraw_reason", "VARCHAR(300) NOT NULL DEFAULT ''"),
             ("users", "withdraw_note", "VARCHAR(300) NOT NULL DEFAULT ''"),
             ("courses", "subject_group", "VARCHAR(40) NOT NULL DEFAULT ''"),
             ("courses", "subject_area", "VARCHAR(20) NOT NULL DEFAULT ''"),
             ("courses", "subject_type", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("courses", "custom_subject", "INTEGER NOT NULL DEFAULT 0"),
             ("courses", "school_year", "INTEGER"),
             ("courses", "term", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("courses", "credits", "INTEGER"),
             ("courses", "hours", "INTEGER"),
             ("courses", "achievement", "VARCHAR(2) NOT NULL DEFAULT ''"),
             ("courses", "capacity", "INTEGER"),
             ("courses", "recruit_start", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("courses", "recruit_end", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("courses", "exam_ratio", "INTEGER"),
             ("courses", "perf_ratio", "INTEGER"),
             ("courses", "syllabus_id", "VARCHAR(16) NOT NULL DEFAULT ''"),
             ("courses", "syllabus_name", "VARCHAR(150) NOT NULL DEFAULT ''"),
             ("courses", "team_teaching", "INTEGER NOT NULL DEFAULT 0"),
             ("courses", "co_teachers", "VARCHAR(300) NOT NULL DEFAULT ''"),
             ("courses", "subject", "VARCHAR(60) NOT NULL DEFAULT ''"),
             ("courses", "schools", "TEXT NOT NULL DEFAULT ''"),
             ("courses", "contact_email", "VARCHAR(200) NOT NULL DEFAULT ''"),
             ("courses", "contact_phone", "VARCHAR(40) NOT NULL DEFAULT ''"),
             ("courses", "show_email", "INTEGER NOT NULL DEFAULT 0"),
             ("courses", "show_phone", "INTEGER NOT NULL DEFAULT 0"),
             ("courses", "recruit_start_time", "VARCHAR(5) NOT NULL DEFAULT ''"),
             ("courses", "recruit_end_time", "VARCHAR(5) NOT NULL DEFAULT ''"),
             ("courses", "class_days", "VARCHAR(20) NOT NULL DEFAULT ''"),
             ("courses", "class_start", "VARCHAR(5) NOT NULL DEFAULT ''"),
             ("courses", "class_end", "VARCHAR(5) NOT NULL DEFAULT ''"),
             ("notices", "author_id", "INTEGER"),
             ("memberships", "affil_type", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("memberships", "office", "VARCHAR(30) NOT NULL DEFAULT ''"),
             ("memberships", "license", "VARCHAR(100) NOT NULL DEFAULT ''"),
             ("memberships", "email", "VARCHAR(200) NOT NULL DEFAULT ''"),
             ("courses", "approval", "VARCHAR(10) NOT NULL DEFAULT 'approved'"),
             ("users", "birth", "VARCHAR(10) NOT NULL DEFAULT ''"),
             ("users", "name_locked", "INTEGER NOT NULL DEFAULT 0"),
             ("users", "gender", "VARCHAR(2) NOT NULL DEFAULT ''"),
             ("users", "contact_email", "VARCHAR(200) NOT NULL DEFAULT ''"),
             ("users", "phone", "VARCHAR(100) NOT NULL DEFAULT ''"),
             ("users", "subjects", "VARCHAR(300) NOT NULL DEFAULT ''"),
             ("users", "position", "VARCHAR(30) NOT NULL DEFAULT ''"),
             ("courses", "approval_note", "VARCHAR(300) NOT NULL DEFAULT ''"),
             ("courses", "approved_by", "INTEGER")]
    fresh = set()
    for table, col, kind in added:
        if col not in {c["name"] for c in inspect(engine).get_columns(table)}:
            with engine.begin() as c:
                c.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {kind}"))
            fresh.add((table, col))
    if ("users", "name_locked") in fresh:  # 이미 가입을 마친 사람의 이름은 그대로 굳힌다
        with engine.begin() as c:
            c.execute(update(users).where(users.c.name != "").values(name_locked=1))
    if engine.dialect.name == "postgresql":  # 수업 소개를 길게 쓸 수 있도록 (예전: 300자)
        with engine.begin() as c:
            c.execute(text("ALTER TABLE courses ALTER COLUMN description TYPE TEXT"))
    # 수강신청은 강사 승인만으로 확정된다 (예전 '관리교사 최종 승인 대기'는 확정으로)
    with engine.begin() as c:
        c.execute(update(enrollments).where(enrollments.c.status == "instructor_ok").values(status="approved"))
    # 서버가 갑자기 꺼져 '접속 중'으로 남은 기록은 마지막 확인 시각에 나간 것으로 정리
    with engine.begin() as c:
        c.execute(update(attendance).where(attendance.c.left_at.is_(None))
                  .values(left_at=attendance.c.last_seen, left_reason="server"))


async def run(fn, *args):
    """DB 작업은 이벤트 루프를 막지 않도록 별도 스레드에서 실행한다."""
    return await asyncio.to_thread(fn, *args)


def now() -> float:
    return time.time()
