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
)

instructors = Table(
    "instructors", metadata,  # 강사 등록 신청과 관리자 승인
    Column("id", Integer, primary_key=True),
    Column("user_id", Integer, nullable=False, unique=True),
    Column("status", String(10), nullable=False),  # pending(대기) approved(승인) rejected(거절) revoked(해제)
    Column("kind", String(15), nullable=False, default=""),  # regular(정규 강사) supplementary(보충수업 강사)
    Column("contact", String(100), nullable=False, default=""),
    Column("message", String(500), nullable=False, default=""),
    Column("valid_from", String(10), nullable=False, default=""),  # 활동 기간 (YYYY-MM-DD, 비우면 제한 없음)
    Column("valid_until", String(10), nullable=False, default=""),
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
    Column("description", String(300), nullable=False, default=""),
    Column("school", String(60), nullable=False, default=""),  # 개설한 선생님의 학교 (참고용)
    Column("instructor", String(30), nullable=False, default=""),  # 강사명
    Column("hub_school", String(60), nullable=False, default=""),  # 거점학교명
    Column("start_date", String(10), nullable=False, default=""),  # 강의기간 시작 (YYYY-MM-DD)
    Column("end_date", String(10), nullable=False, default=""),  # 강의기간 끝
    Column("open", Integer, nullable=False, default=1),  # 수강신청을 받는 중
    Column("archived", Integer, nullable=False, default=0),  # 학기가 끝나 보관함으로
    Column("created_at", Float, nullable=False),
)

enrollments = Table(
    "enrollments", metadata,
    Column("id", Integer, primary_key=True),
    Column("course_id", Integer, nullable=False, index=True),
    Column("user_id", Integer, nullable=False, index=True),
    Column("status", String(10), nullable=False),  # pending(승인 대기) approved(승인) rejected(거절)
    Column("requested_at", Float, nullable=False),
    Column("decided_at", Float),
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
             ("courses", "end_date", "VARCHAR(10) NOT NULL DEFAULT ''")]
    for table, col, kind in added:
        if col not in {c["name"] for c in inspect(engine).get_columns(table)}:
            with engine.begin() as c:
                c.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {kind}"))
    # 서버가 갑자기 꺼져 '접속 중'으로 남은 기록은 마지막 확인 시각에 나간 것으로 정리
    with engine.begin() as c:
        c.execute(update(attendance).where(attendance.c.left_at.is_(None))
                  .values(left_at=attendance.c.last_seen, left_reason="server"))


async def run(fn, *args):
    """DB 작업은 이벤트 루프를 막지 않도록 별도 스레드에서 실행한다."""
    return await asyncio.to_thread(fn, *args)


def now() -> float:
    return time.time()
