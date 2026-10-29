"""강좌와 수강신청.

학기 초: 강사가 강좌를 개설한다 → 학생이 수강신청 → 강사가 1차 승인 → 거점학교 관리교사가 최종 승인.
(거점학교에 속하지 않은 강좌는 강사 승인만으로 확정된다.)
수업 때: 선생님이 강좌 수업을 열면, 승인된 학생은 첫 화면에 수업이 떠서 코드 없이 들어간다.
강좌 수업에는 승인된 학생만 들어올 수 있다(코드를 알아도 안 됨).
"""

from __future__ import annotations

import re
import time
import uuid
from datetime import date, datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, func, insert, or_, select, update

from app import auth, db, subjects
from app.auth import require_user, student_no
from app.privacy_filter import known_member_names, redact

router = APIRouter()
KST = ZoneInfo("Asia/Seoul")


def today_kst() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d")
LIVE_LIMIT = 24 * 3600  # classroom.CLASS_REVIVE_LIMIT 과 같게


def is_enrolled(course_id: int, user_id: int) -> bool:
    with db.engine.connect() as c:
        return c.execute(select(db.enrollments.c.id).where(
            db.enrollments.c.course_id == course_id, db.enrollments.c.user_id == user_id,
            db.enrollments.c.status == "approved")).first() is not None


def hub_locked(course, t: dict) -> bool:
    """거점학교 강좌인데 그 거점학교 강사(관리교사) 활동 기간이 아니면 관리할 수 없다.
    (다른 거점학교로 옮겼거나 기간이 끝났거나 해제된 경우)"""
    return (bool(course.hub_id) and not t["is_admin"] and not t.get("teach_any")
            and course.hub_id not in {h["id"] for h in t["teach_hubs"]})


def hub_for_school(c, name: str) -> int:
    """울산 고등학교 이름으로 거점학교 번호를 찾고, 아직 없으면 만든다 (관리교사가 없어도 전체 관리자가 승인)"""
    name = " ".join(name.split())
    hub = c.execute(select(db.hubs).where(func.lower(db.hubs.c.name) == name.lower())).first()
    return hub.id if hub else c.execute(insert(db.hubs).values(name=name, created_at=time.time())).inserted_primary_key[0]


def co_teacher_ids(r) -> list[int]:
    """팀티칭 보조교사 (사용자 번호)"""
    return [int(x) for x in (getattr(r, "co_teachers", "") or "").split(",") if x.strip().isdigit()]


def co_text(ids) -> str:
    ids = sorted(set(ids))
    return f",{','.join(map(str, ids))}," if ids else ""


def teaches(r, uid: int) -> bool:
    """강좌를 연 강사이거나 팀티칭 보조교사"""
    return r.teacher_id == uid or uid in co_teacher_ids(r)


def taught_filter(uid: int):
    """SQL 조건: 내가 열었거나 보조교사로 참여한 강좌"""
    co = db.courses.c
    return or_(co.teacher_id == uid, co.co_teachers.like(f"%,{uid},%"))


def taught_course_ids(c, uid: int) -> set[int]:
    return set(c.execute(select(db.courses.c.id).where(taught_filter(uid))).scalars())


def owned_course(course_id: int, t: dict, lead: bool = False):
    """강좌를 관리할 수 있는지 확인한다. 팀티칭 보조교사도 관리할 수 있다(lead=True 면 강좌를 연 강사만)."""
    with db.engine.connect() as c:
        r = c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()
    if not r or not (r.teacher_id == t["id"] if lead else teaches(r, t["id"])):
        raise HTTPException(404, "강좌를 찾을 수 없어요.")
    if hub_locked(r, t):
        raise HTTPException(403, f"{r.hub_school} 강사 활동 기간이 아니라서 이 강좌를 관리할 수 없어요. "
                                 "계속 강의하려면 그 거점학교에 다시 신청해 주세요.")
    return r


def course_row(r, counts: dict | None = None) -> dict:
    out = {"id": r.id, "title": r.title, "description": r.description, "open": bool(r.open),
           "archived": bool(r.archived), "created_at": r.created_at,
           "instructor": r.instructor, "hub_school": r.hub_school,
           "start_date": r.start_date, "end_date": r.end_date, "hub_id": r.hub_id, "grades": course_grades(r),
           "finished": bool(r.end_date and r.end_date < today_kst()),  # 강의기간이 지남
           "approval": r.approval or "approved", "approval_note": r.approval_note or "",
           **subject_info(r)}
    if counts is not None:
        out.update(counts.get(r.id, {"approved": 0, "pending": 0}))
    return out


def recruit_state(r) -> str:
    """모집 상태: open(모집 중) before(모집 전) closed(마감). 모집 기간은 날짜와 시각까지 본다"""
    today = today_kst()
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M")
    if not r.open or (r.end_date and r.end_date < today):
        return "closed"
    if r.recruit_end and now > f"{r.recruit_end} {r.recruit_end_time or '23:59'}":
        return "closed"
    if r.recruit_start and now < f"{r.recruit_start} {r.recruit_start_time or '00:00'}":
        return "before"
    return "open"


def subject_info(r) -> dict:
    """과목·학점·평가 등 강좌 안내 (누구에게나 보여도 되는 정보)"""
    return {"subject_group": r.subject_group, "subject_area": r.subject_area, "subject_type": r.subject_type,
            "custom_subject": bool(r.custom_subject), "school_year": r.school_year, "term": r.term,
            "credits": r.credits, "hours": r.hours, "achievement": r.achievement, "delivery": r.delivery or subjects.DELIVERY[0],
            "achievement_text": subjects.ACHIEVEMENTS.get(r.achievement, ""), "capacity": r.capacity,
            "rank_grade": r.rank_grade or subjects.default_rank(r.achievement),
            "recruit_start": r.recruit_start, "recruit_end": r.recruit_end, "recruit": recruit_state(r),
            "exam_ratio": r.exam_ratio, "perf_ratio": r.perf_ratio,
            "syllabus": {"name": r.syllabus_name, "url": f"/api/courses/{r.id}/syllabus"} if r.syllabus_id else None,
            "team_teaching": bool(r.team_teaching), "subject": r.subject or r.title,
            "schools": [x for x in (r.schools or "").split("\n") if x],
            "recruit_start_time": r.recruit_start_time, "recruit_end_time": r.recruit_end_time,
            "class_days": [int(x) for x in (r.class_days or "").split(",") if x.isdigit()],
            "class_start": r.class_start, "class_end": r.class_end,
            # 담당 교강사 연락처: 공개로 정한 것만
            "contact_email": r.contact_email if r.show_email else "", "contact_phone": r.contact_phone if r.show_phone else ""}


def sessions_of(c, course_ids) -> dict:
    """강좌별 회차 [{no, date, start, end, topic}]"""
    out: dict = {}
    for x in c.execute(select(db.course_sessions).where(db.course_sessions.c.course_id.in_(list(course_ids) or [-1]))
                       .order_by(db.course_sessions.c.course_id, db.course_sessions.c.no)):
        out.setdefault(x.course_id, []).append({"no": x.no, "date": x.date, "start": x.start, "end": x.end, "topic": x.topic})
    return out


def sessions_by_course(course_ids) -> dict:
    with db.engine.connect() as c:
        return sessions_of(c, course_ids)


def save_sessions(c, course_id: int, sessions: list) -> None:
    c.execute(delete(db.course_sessions).where(db.course_sessions.c.course_id == course_id))
    rows = sorted(sessions, key=lambda x: (x.date, x.start))
    for i, x in enumerate(rows, 1):
        c.execute(insert(db.course_sessions).values(course_id=course_id, no=i, date=x.date, start=x.start, end=x.end,
                                                    topic=x.topic.strip() or f"{i}회차"))


# ───────────────────────── 선생님 ─────────────────────────


DATE = r"^\d{4}-\d{2}-\d{2}$"


def check_period(start: str | None, end: str | None) -> None:
    try:
        if start:
            date.fromisoformat(start)
        if end:
            date.fromisoformat(end)
    except ValueError:
        raise HTTPException(400, "강의기간 날짜가 올바르지 않아요.")
    if start and end and end < start:
        raise HTTPException(400, "강의기간이 끝나는 날이 시작하는 날보다 빨라요.")


TIME = r"^(([01]\d|2[0-3]):[0-5]\d)?$"


class SessionIn(BaseModel):
    date: str = Field(pattern=DATE)
    start: str = Field(default="", pattern=TIME)
    end: str = Field(default="", pattern=TIME)
    topic: str = Field(default="", max_length=120)


class CourseReq(BaseModel):
    title: str = Field(min_length=1, max_length=60)  # 강의명
    instructor: str = Field(min_length=1, max_length=30)  # 강사명
    hub_id: int | None = None  # 등록된 거점학교 (강사로 승인받은 학교 중에서)
    hub_school: str = Field(default="", max_length=60)  # 거점학교에 속하지 않은 강좌일 때만 직접 입력
    start_date: str = Field(pattern=DATE)  # 강의기간
    end_date: str = Field(pattern=DATE)
    description: str = Field(default="", max_length=3000)  # 수업 소개
    grades: list[int] = Field(default_factory=list)  # 대상 학년 (비우면 모든 학년)
    # 과목 정보 (2022 개정 교육과정): 강좌 개설 화면에서는 모두 필수
    custom_subject: bool = False  # 고시외 과목 (목록에 없는 과목을 직접 적음)
    subject_group: str = Field(default="", max_length=40)  # 교과(군)
    subject_area: str = Field(default="", max_length=20)  # 교과(영역)
    subject_type: str = Field(default="", max_length=10)  # 일반선택·진로선택·융합선택
    school_year: int | None = Field(default=None, ge=2020, le=2100)
    term: str = Field(default="", max_length=10)
    delivery: str = Field(default="", max_length=20)  # 운영방식
    credits: int | None = Field(default=None, ge=1, le=10)
    achievement: str = Field(default="", pattern="^(5|3|P)?$")
    rank_grade: str = Field(default="", pattern="^(산출|미산출)?$")  # 석차 등급
    capacity: int | None = Field(default=None, ge=1, le=500)
    recruit_start: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    recruit_end: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    exam_ratio: int | None = Field(default=None, ge=0, le=100)
    perf_ratio: int | None = Field(default=None, ge=0, le=100)
    team_teaching: bool = False
    co_teachers: list[int] = Field(default_factory=list)  # 팀티칭 보조교사 (그 거점학교 강사 중에서)
    subject: str = Field(default="", max_length=60)  # 과목 (비면 수업명과 같음)
    schools: list[str] = Field(default_factory=list, max_length=80)  # 참여 학교 (비면 울산 모든 고등학교)
    contact_email: str = Field(default="", max_length=200)
    contact_phone: str = Field(default="", max_length=40)
    show_email: bool = False
    show_phone: bool = False
    recruit_start_time: str = Field(default="", pattern=TIME)
    recruit_end_time: str = Field(default="", pattern=TIME)
    class_days: list[int] = Field(default_factory=list)
    class_start: str = Field(default="", pattern=TIME)
    class_end: str = Field(default="", pattern=TIME)
    hours: int | None = Field(default=None, ge=1, le=400)  # 이수 시간 (비면 학점 × 16)
    sessions: list[SessionIn] | None = Field(default=None, max_length=200)  # 회차


SUBJECT_KEYS = ("custom_subject", "subject_group", "subject_area", "subject_type", "school_year", "term", "delivery", "credits",
                "achievement", "rank_grade", "capacity", "recruit_start", "recruit_end", "exam_ratio", "perf_ratio", "team_teaching",
                "subject", "schools", "contact_email", "contact_phone", "show_email", "show_phone",
                "recruit_start_time", "recruit_end_time", "class_days", "class_start", "class_end", "hours", "sessions")


def extra_values(v: dict, schools: list[str]) -> dict:
    """참여 학교·연락처·모집 시각·수업 요일과 시각"""
    out = {}
    if v.get("schools") is not None:
        names = list(dict.fromkeys(" ".join(x.split()) for x in v["schools"] if x.strip()))
        bad = [x for x in names if schools and x not in schools]
        if bad:
            raise HTTPException(400, f"참여 학교는 울산 고등학교 목록에서 골라 주세요. ({', '.join(bad)})")
        out["schools"] = "\n".join(names)
    for k in ("contact_email", "contact_phone", "recruit_start_time", "recruit_end_time", "class_start", "class_end"):
        if v.get(k) is not None:
            out[k] = v[k].strip()
    for k in ("show_email", "show_phone"):
        if v.get(k) is not None:
            out[k] = int(v[k])
    if v.get("class_days") is not None:
        out["class_days"] = ",".join(str(d) for d in sorted({d for d in v["class_days"] if 0 <= d <= 6}))
    if out.get("class_start") and out.get("class_end") and out["class_end"] <= out["class_start"]:
        raise HTTPException(400, "수업 끝나는 시각이 시작 시각보다 빨라요.")
    return out


def subject_values(v: dict, cur=None) -> dict:
    """과목 정보 확인 + 저장할 값 (cur: 고칠 때 지금 값)"""
    get = lambda k: v[k] if k in v and v[k] is not None else (getattr(cur, k) if cur is not None else None)  # noqa: E731
    out = {}
    # 과목: 따로 고르지 않았으면 수업명을 과목으로 본다 (예전 강좌·간단한 개설)
    if v.get("subject"):
        title = v["subject"]
    elif cur is not None and cur.subject:
        title = cur.subject
    else:
        title = v.get("title") or (cur.title if cur is not None else "")
    title = " ".join(title.split())
    custom = bool(get("custom_subject"))
    if any(v.get(k) is not None for k in ("title", "subject", "custom_subject", "subject_group", "subject_area", "subject_type")):
        found = next((x for x in subjects.SUBJECTS if x["name"] == title), None)
        if not custom and get("subject_type") and not found:
            raise HTTPException(400, f"'{title}'은(는) 2022 개정 교육과정 과목 목록에 없어요. 목록에서 고르거나 '고시외 과목'에 체크해 주세요.")
        out["subject"] = title
        if found and not custom:  # 목록 과목이면 교과(군)·교과·과목 구분은 목록대로
            out.update(subject_group=found["group"], subject_area=found["area"], subject_type=found["kind"])
        else:
            if get("subject_group") and get("subject_group") not in subjects.GROUPS:
                raise HTTPException(400, "교과(군)를 목록에서 골라 주세요.")
            if get("subject_type") and get("subject_type") not in subjects.TYPES:
                raise HTTPException(400, "과목 구분(일반선택·진로선택·전문교과)을 골라 주세요.")
            for k in ("subject_group", "subject_area", "subject_type"):
                if k in v and v[k] is not None:
                    out[k] = v[k].strip()
        out["custom_subject"] = int(custom)
    if v.get("term") and v["term"] not in subjects.TERMS:
        raise HTTPException(400, "수업 학기를 골라 주세요.")
    if v.get("delivery"):
        if v["delivery"] not in subjects.DELIVERY:
            raise HTTPException(400, "운영방식을 골라 주세요.")
        out["delivery"] = v["delivery"]
    for k in ("school_year", "term", "achievement", "rank_grade", "capacity", "exam_ratio", "perf_ratio"):
        if k in v and v[k] is not None:
            out[k] = v[k]
    if v.get("credits") is not None:
        out.update(credits=v["credits"], hours=v["credits"] * subjects.HOURS_PER_CREDIT)  # 3학점 → 48시간
    if v.get("hours") is not None:
        out["hours"] = v["hours"]  # 이수 시간을 따로 정함
    if v.get("team_teaching") is not None:
        out["team_teaching"] = int(v["team_teaching"])
    exam, perf = get("exam_ratio"), get("perf_ratio")
    if exam is not None and perf is not None and exam + perf != 100:
        raise HTTPException(400, f"지필평가와 수행평가 비율을 더하면 100%가 되어야 해요. (지금 {exam + perf}%)")
    for k in ("recruit_start", "recruit_end"):
        if k in v and v[k] is not None:
            out[k] = v[k]
    rs, re_ = get("recruit_start") or "", get("recruit_end") or ""
    try:
        for d in (rs, re_):
            if d:
                date.fromisoformat(d)
    except ValueError:
        raise HTTPException(400, "모집 기간 날짜가 올바르지 않아요.")
    if rs and re_ and re_ < rs:
        raise HTTPException(400, "모집 기간이 끝나는 날이 시작하는 날보다 빨라요.")
    return out


def check_co_teachers(c, hub_id: int | None, owner_id: int, ids: list[int]) -> str:
    """보조교사는 그 거점학교에서 활동 중인 강사·관리교사만 (본인 제외)"""
    ids = [i for i in dict.fromkeys(ids) if i != owner_id]
    if not ids:
        return ""
    if hub_id is None:
        raise HTTPException(400, "팀티칭 보조교사는 거점학교 강좌에서만 정할 수 있어요.")
    ok = {x["id"] for x in hub_teachers(c, hub_id)}
    if not set(ids) <= ok:
        raise HTTPException(400, "보조교사는 이 거점학교에서 활동 중인 강사 중에서 골라 주세요.")
    return co_text(ids)


def hub_teachers(c, hub_id: int) -> list[dict]:
    m = db.memberships.c
    # 그 거점학교 강사·관리교사 + 거점학교를 정하지 않은(전체 관리자가 승인한) 강의교사
    rows = c.execute(select(db.memberships, db.users.c.name, db.users.c.google_name, db.users.c.school)
                     .join(db.users, db.users.c.id == m.user_id)
                     .where(or_(and_(m.hub_id == hub_id, m.role.in_(["instructor", "coordinator"])),
                                and_(m.hub_id.is_(None), m.role == "instructor")))).all()
    out = {}
    for r in rows:
        if auth.membership_active(dict(r._mapping)):
            prev = out.get(r.user_id)
            assistant = r.kind == "assistant" and (prev is None or prev["assistant"])
            out[r.user_id] = {"id": r.user_id, "name": r.name or r.google_name, "affiliation": r.school,
                              "assistant": assistant}
    return sorted(out.values(), key=lambda x: x["name"])


@router.get("/api/hubs/{hub_id}/teachers")
async def hub_teacher_list(hub_id: int, request: Request):
    """팀티칭 보조교사 고르기: 그 거점학교에서 활동 중인 강사"""
    t = await require_user(request, "teacher")
    if hub_id not in {h["id"] for h in t["teach_hubs"]} and not (t["is_admin"] or t.get("teach_any")):
        raise HTTPException(403, "그 거점학교 강사만 볼 수 있어요.")

    def run():
        with db.engine.connect() as c:
            return hub_teachers(c, hub_id)

    return {"teachers": [x for x in await db.run(run) if x["id"] != t["id"]]}


@router.get("/api/subjects")
async def subject_list():
    """강좌 개설 화면: 2022 개정 교육과정 과목 (검색해서 고른다)"""
    return {"subjects": subjects.SUBJECTS, "groups": subjects.GROUPS, "areas": subjects.AREAS,
            "types": subjects.TYPES, "browse_types": subjects.BROWSE_TYPES, "terms": subjects.TERMS, "delivery": subjects.DELIVERY, "achievements": subjects.ACHIEVEMENTS,
            "offices": subjects.OFFICES, "hours_per_credit": subjects.HOURS_PER_CREDIT}


def grades_text(grades: list[int] | None) -> str:
    return ",".join(str(g) for g in sorted({g for g in (grades or []) if 1 <= g <= 6}))


def course_grades(r) -> list[int]:
    return [int(g) for g in (r.grades or "").split(",") if g.strip().isdigit()]


def grade_ok(r, grade) -> bool:
    """대상 학년이 정해진 강좌면 그 학년 학생만"""
    gs = course_grades(r)
    return not gs or grade in gs


@router.get("/api/courses/mine")
async def my_courses(request: Request):
    t = await require_user(request, "teacher")

    def run():
        with db.engine.connect() as c:
            rows = c.execute(select(db.courses).where(taught_filter(t["id"]))
                             .order_by(db.courses.c.archived, db.courses.c.created_at.desc())).all()
            ids = {i for r in rows for i in [r.teacher_id, *co_teacher_ids(r)]}
            names = {u.id: u.name or u.google_name for u in c.execute(
                select(db.users.c.id, db.users.c.name, db.users.c.google_name).where(db.users.c.id.in_(ids or [-1])))}
            counts: dict = {}
            e = db.enrollments.c
            for cid, status, n in c.execute(
                    select(e.course_id, e.status, func.count()).where(e.course_id.in_([r.id for r in rows] or [-1]))
                    .group_by(e.course_id, e.status)):
                counts.setdefault(cid, {"approved": 0, "pending": 0})
                key = {"approved": "approved", "pending": "pending"}.get(status)
                if key:
                    counts[cid][key] = n
            return rows, counts, names, sessions_of(c, [r.id for r in rows])

    rows, counts, names, sess = await db.run(run)
    return {"courses": [{**course_row(r, counts), "locked": hub_locked(r, t), "description": r.description,
                         "lead": r.teacher_id == t["id"], "owner_name": names.get(r.teacher_id, ""),
                         "sessions": sess.get(r.id, []), "show_email": bool(r.show_email), "show_phone": bool(r.show_phone),
                         "contact_email": r.contact_email, "contact_phone": r.contact_phone,
                         "co_teachers": [{"id": i, "name": names.get(i, "")} for i in co_teacher_ids(r)]}
                        for r in rows]}


@router.post("/api/courses")
async def create_course(req: CourseReq, request: Request):
    t = await require_user(request, "teacher")
    check_period(req.start_date, req.end_date)
    independent = t["email"].lower() in auth.ADMIN_EMAILS | auth.TEACHER_EMAILS  # 거점학교 밖에서도 강좌를 열 수 있음
    teach_hubs = {h["id"]: h["name"] for h in t["lead_hubs"]}
    schools = await db.run(auth.get_schools)
    hub_school = " ".join(req.hub_school.split())
    anywhere = t["is_admin"] or t.get("lead_any")  # 울산 고등학교 어디든 거점학교로 골라 과목을 연다
    if req.hub_id is not None:
        if req.hub_id not in teach_hubs and not anywhere:
            if req.hub_id in {h["id"] for h in t["teach_hubs"]} or t.get("teach_any"):
                raise HTTPException(403, "팀티칭 보조교사는 강좌를 직접 열 수 없어요. 주강사가 강좌를 열 때 보조교사로 넣어 줘요.")
            raise HTTPException(403, "강사로 승인받은 거점학교에만 강좌를 개설할 수 있어요.")
    elif not hub_school:
        raise HTTPException(400, "거점학교를 골라 주세요. 거점학교 없이는 강좌를 열 수 없어요.")
    elif schools and hub_school not in schools:
        raise HTTPException(400, "거점학교는 울산 고등학교 목록에서 골라 주세요.")
    elif not (anywhere or independent):
        if t.get("teach_any"):
            raise HTTPException(403, "팀티칭 보조교사는 강좌를 직접 열 수 없어요. 주강사가 강좌를 열 때 보조교사로 넣어 줘요.")
        raise HTTPException(403, "강사로 승인받은 거점학교에만 강좌를 개설할 수 있어요.")
    extra = {**subject_values(req.model_dump()), **extra_values(req.model_dump(), schools)}

    def run():
        with db.engine.begin() as c:
            hub_id = req.hub_id
            if hub_id is None and anywhere:  # 울산 고등학교 이름 → 거점학교 (없으면 만든다)
                hub_id = hub_for_school(c, hub_school)
            co_teachers = check_co_teachers(c, hub_id, t["id"], req.co_teachers) if req.team_teaching else ""
            name = hub_school
            if hub_id is not None:
                hub = c.execute(select(db.hubs).where(db.hubs.c.id == hub_id)).first()
                if not hub:
                    raise HTTPException(404, "거점학교를 찾을 수 없어요.")
                name = hub.name
            new_id = c.execute(insert(db.courses).values(
                teacher_id=t["id"], title=req.title.strip(), description=req.description.strip(),
                instructor=req.instructor.strip(), hub_school=name, hub_id=hub_id,
                start_date=req.start_date, end_date=req.end_date, grades=grades_text(req.grades),
                school=t["school"] or "", open=1, archived=0, created_at=time.time(),
                co_teachers=co_teachers, approval=new_approval(hub_id, t), **extra)).inserted_primary_key[0]
            if req.sessions:
                save_sessions(c, new_id, req.sessions)
            return new_id

    return {"id": await db.run(run)}


class CourseUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=60)
    instructor: str | None = Field(default=None, min_length=1, max_length=30)
    hub_school: str | None = Field(default=None, min_length=1, max_length=60)  # 거점학교 바꾸기 (울산 고등학교 목록에서)
    hub_id: int | None = None
    start_date: str | None = Field(default=None, pattern=DATE)
    end_date: str | None = Field(default=None, pattern=DATE)
    description: str | None = Field(default=None, max_length=3000)
    open: bool | None = None
    archived: bool | None = None
    grades: list[int] | None = None
    custom_subject: bool | None = None
    subject_group: str | None = Field(default=None, max_length=40)
    subject_area: str | None = Field(default=None, max_length=20)
    subject_type: str | None = Field(default=None, max_length=10)
    school_year: int | None = Field(default=None, ge=2020, le=2100)
    term: str | None = Field(default=None, max_length=10)
    delivery: str | None = Field(default=None, max_length=20)
    credits: int | None = Field(default=None, ge=1, le=10)
    achievement: str | None = Field(default=None, pattern="^(5|3|P)?$")
    rank_grade: str | None = Field(default=None, pattern="^(산출|미산출)?$")  # 석차 등급
    capacity: int | None = Field(default=None, ge=0, le=500)  # 0: 제한 없음
    recruit_start: str | None = Field(default=None, pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    recruit_end: str | None = Field(default=None, pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    exam_ratio: int | None = Field(default=None, ge=0, le=100)
    perf_ratio: int | None = Field(default=None, ge=0, le=100)
    team_teaching: bool | None = None
    co_teachers: list[int] | None = None
    subject: str | None = Field(default=None, max_length=60)
    schools: list[str] | None = Field(default=None, max_length=80)
    contact_email: str | None = Field(default=None, max_length=200)
    contact_phone: str | None = Field(default=None, max_length=40)
    show_email: bool | None = None
    show_phone: bool | None = None
    recruit_start_time: str | None = Field(default=None, pattern=TIME)
    recruit_end_time: str | None = Field(default=None, pattern=TIME)
    class_days: list[int] | None = None
    class_start: str | None = Field(default=None, pattern=TIME)
    class_end: str | None = Field(default=None, pattern=TIME)
    hours: int | None = Field(default=None, ge=1, le=400)
    sessions: list[SessionIn] | None = Field(default=None, max_length=200)


async def new_hub(t: dict, hub_id: int | None, name: str) -> dict:
    """강좌의 거점학교 바꾸기: 강사는 승인받은 거점학교로, 전체 관리자는 울산 고등학교 목록의 어느 학교로든"""
    name = " ".join(name.split())
    lead = {h["id"]: h["name"] for h in t["lead_hubs"]}
    if hub_id is None:
        hub_id = next((i for i, n in lead.items() if n == name), None)
    if hub_id is not None:
        if hub_id not in lead and not (t["is_admin"] or t.get("lead_any")):
            raise HTTPException(403, "강사로 승인받은 거점학교로만 바꿀 수 있어요.")

        def find():
            with db.engine.connect() as c:
                return c.execute(select(db.hubs).where(db.hubs.c.id == hub_id)).first()

        hub = await db.run(find)
        if not hub:
            raise HTTPException(404, "거점학교를 찾을 수 없어요.")
        return {"hub_id": hub.id, "hub_school": hub.name}
    schools = await db.run(auth.get_schools)
    if not name or (schools and name not in schools):
        raise HTTPException(400, "거점학교는 울산 고등학교 목록에서 골라 주세요.")
    if not (t["is_admin"] or t.get("lead_any")):
        if t["email"].lower() in auth.TEACHER_EMAILS:  # 거점학교 밖 강사(설정으로 등록): 학교 이름만
            return {"hub_id": None, "hub_school": name}
        raise HTTPException(403, "강사로 승인받은 거점학교로만 바꿀 수 있어요.")

    def make():
        with db.engine.begin() as c:
            return hub_for_school(c, name)

    return {"hub_id": await db.run(make), "hub_school": name}


@router.post("/api/courses/{course_id}")
async def update_course(course_id: int, req: CourseUpdate, request: Request):
    t = await require_user(request, "teacher")
    data = req.model_dump()
    # 보조교사는 수강신청 받기만 바꿀 수 있고, 강좌 정보·팀티칭 구성은 강좌를 연 강사가 정한다
    lead = any(data[k] is not None for k in data if k != "open")
    cur = await db.run(owned_course, course_id, t, lead)
    extra = {**subject_values(data, cur), **extra_values(data, await db.run(auth.get_schools))}
    if data.get("capacity") == 0:
        extra["capacity"] = None
    simple = {k: v for k, v in data.items()
              if v is not None and k not in SUBJECT_KEYS and k not in ("co_teachers", "hub_id", "hub_school")}
    values = {k: (int(v) if isinstance(v, bool) else grades_text(v) if k == "grades" else v.strip())
              for k, v in simple.items()}
    values.update(extra)
    if data["hub_id"] is not None or data["hub_school"]:
        values.update(await new_hub(t, data["hub_id"], data["hub_school"] or ""))
    check_period(values.get("start_date", cur.start_date), values.get("end_date", cur.end_date))
    if req.archived:
        values["open"] = 0  # 보관하면 수강신청도 닫는다
    edited = any(data[k] is not None for k in data if k not in ("open", "archived"))
    if "hub_id" in values and values["hub_id"] != cur.hub_id:
        # 다른 거점학교로 옮기면 그 학교 관리교사가 다시 승인한다
        values.update(approval=new_approval(values["hub_id"], t), approval_note="")
    elif edited and cur.approval == "rejected":
        values.update(approval="pending", approval_note="")  # 반려된 강좌를 고치면 다시 승인 대기

    def run():
        with db.engine.begin() as c:
            team = values.get("team_teaching", cur.team_teaching)
            if not team:
                values["co_teachers"] = ""
            elif data["co_teachers"] is not None:
                values["co_teachers"] = check_co_teachers(c, cur.hub_id, cur.teacher_id, data["co_teachers"])
            c.execute(update(db.courses).where(db.courses.c.id == course_id).values(**values))
            if data["sessions"] is not None:
                save_sessions(c, course_id, req.sessions)

    if values or data["co_teachers"] is not None or data["sessions"] is not None:
        await db.run(run)
    return {"ok": True}


# ───────────────────────── 수업계획서 파일 ─────────────────────────

SYLLABUS_MAX = 5 * 1024 * 1024  # 수업계획서 파일 5MB까지
SYLLABUS_TYPES = {".pdf": "application/pdf", ".hwp": "application/x-hwp", ".hwpx": "application/haansofthwpx",
                  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  ".doc": "application/msword"}


def syllabus_path(course_id: int, fid: str):
    from app.assignments import FILES_DIR  # 과제 파일과 같은 곳에 둔다
    return FILES_DIR / "syllabus" / str(course_id) / fid


@router.post("/api/courses/{course_id}/syllabus")
async def upload_syllabus(course_id: int, request: Request, name: str = Query(default="수업계획서.pdf", max_length=150)):
    """수업계획서 올리기 (PDF·한글·워드). 다시 올리면 바뀐다. 요청 본문 = 파일 그대로"""
    t = await require_user(request, "teacher")
    cur = await db.run(owned_course, course_id, t, True)
    ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in SYLLABUS_TYPES:
        raise HTTPException(415, "수업계획서는 PDF, 한글(hwp·hwpx), 워드(docx) 파일로 올려 주세요.")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > SYLLABUS_MAX:
            raise HTTPException(413, "수업계획서 파일이 너무 커요. 5MB 이하로 올려 주세요.")
    if not data:
        raise HTTPException(400, "빈 파일이에요.")
    fid = uuid.uuid4().hex[:12]
    fname = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name.strip())[:150]

    def save():
        path = syllabus_path(course_id, fid)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        if cur.syllabus_id:
            syllabus_path(course_id, cur.syllabus_id).unlink(missing_ok=True)
        with db.engine.begin() as c:
            c.execute(update(db.courses).where(db.courses.c.id == course_id)
                      .values(syllabus_id=fid, syllabus_name=fname))

    await db.run(save)
    return {"name": fname}


@router.post("/api/courses/{course_id}/syllabus/delete")
async def delete_syllabus(course_id: int, request: Request):
    t = await require_user(request, "teacher")
    cur = await db.run(owned_course, course_id, t, True)

    def run():
        if cur.syllabus_id:
            syllabus_path(course_id, cur.syllabus_id).unlink(missing_ok=True)
        with db.engine.begin() as c:
            c.execute(update(db.courses).where(db.courses.c.id == course_id).values(syllabus_id="", syllabus_name=""))

    await db.run(run)
    return {"ok": True}


@router.get("/api/courses/{course_id}/syllabus")
async def get_syllabus(course_id: int):
    """수업계획서는 강좌 안내 자료라 로그인 없이도 받을 수 있다 (학생 개인정보 없음)"""
    def run():
        with db.engine.connect() as c:
            return c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()

    r = await db.run(run)
    if not r or not r.syllabus_id or r.archived:
        raise HTTPException(404, "수업계획서가 없어요.")
    path = syllabus_path(course_id, r.syllabus_id)
    if not path.is_file():
        raise HTTPException(404, "수업계획서 파일을 찾을 수 없어요.")
    ext = "." + r.syllabus_name.rsplit(".", 1)[-1].lower()
    media = SYLLABUS_TYPES.get(ext, "application/octet-stream")
    disp = "inline" if media == "application/pdf" else "attachment"
    return FileResponse(path, media_type=media, headers={
        "Content-Disposition": f"{disp}; filename*=UTF-8''{quote(r.syllabus_name)}",
        "X-Content-Type-Options": "nosniff"})


@router.get("/api/courses/{course_id}/enrollments")
async def course_enrollments(course_id: int, request: Request):
    t = await require_user(request, "teacher")
    await db.run(owned_course, course_id, t)

    def run():
        with db.engine.connect() as c:
            return c.execute(select(db.enrollments, db.users)
                             .join(db.users, db.users.c.id == db.enrollments.c.user_id)
                             .where(db.enrollments.c.course_id == course_id)).all()

    out = []
    for r in await db.run(run):
        m = r._mapping
        out.append({"id": m["id"], "user_id": m["user_id"], "student_no": student_no(m),
                    "name": m["name"] or m["google_name"], "school": m["school"], "email": m["email"],
                    "status": m["status"], "note": m["note"], "requested_at": m["requested_at"]})
    out.sort(key=lambda x: (x["student_no"] or "~", x["name"]))
    return {"enrollments": out}


@router.get("/api/my/enrollments")
async def my_enrollments(request: Request):
    """수업신청자 관리: 내가 가르치는 모든 강좌의 수강신청 (화면에서 학기·과목·수업명·상태·학교·이름·기간으로 거른다)"""
    t = await require_user(request, "teacher")

    def run():
        with db.engine.connect() as c:
            courses = {r.id: r for r in c.execute(select(db.courses).where(taught_filter(t["id"]))).all()}
            ok = [i for i, r in courses.items() if not hub_locked(r, t)]
            rows = c.execute(select(db.enrollments, db.users).join(db.users, db.users.c.id == db.enrollments.c.user_id)
                             .where(db.enrollments.c.course_id.in_(ok or [-1]))).all()
            return courses, rows

    courses, rows = await db.run(run)
    out = []
    for r in rows:
        m = r._mapping
        co = courses[m["course_id"]]
        out.append({"course_id": co.id, "course_title": co.title, "subject": co.subject or co.title,
                    "term": f"{co.school_year}학년도 {co.term}" if co.school_year and co.term else (co.term or ""),
                    "instructor": co.instructor, "archived": bool(co.archived),
                    "hub_school": co.hub_school,
                    "user_id": m["user_id"], "student_no": student_no(m), "name": m["name"] or m["google_name"],
                    "grade": m["grade"], "class_no": m["class_no"],
                    "school": m["school"], "status": m["status"], "note": m["note"],
                    "requested_at": m["requested_at"], "decided_at": m["decided_at"]})
    out.sort(key=lambda x: -(x["requested_at"] or 0))
    return {"enrollments": out}


class DecideReq(BaseModel):
    status: str = Field(pattern="^(approved|rejected|removed)$")
    note: str = Field(default="", max_length=300)  # 거절 사유 (학생에게 보임)


def new_approval(hub_id: int | None, t: dict) -> str:
    """새 강좌: 거점학교 관리교사가 승인해야 열린다. 전체 관리자·그 거점학교 관리교사가 직접 만든 강좌,
    거점학교 밖(설정으로 등록한 강사) 강좌는 바로 승인."""
    if hub_id is None or t["is_admin"] or hub_id in {h["id"] for h in t["coordinator_hubs"]}:
        return "approved"
    return "pending"


def course_approved(course) -> bool:
    """거점학교 관리교사가 강좌 개설을 승인했는지 (승인돼야 수강신청을 받고 수업을 연다)"""
    return (course.approval or "approved") == "approved"


@router.post("/api/courses/{course_id}/enrollments/{user_id}")
async def decide(course_id: int, user_id: int, req: DecideReq, request: Request):
    """강사의 승인·거절·빼기 (강사 승인만으로 수강 확정)"""
    t = await require_user(request, "teacher")
    course = await db.run(owned_course, course_id, t)

    def run():
        e = db.enrollments.c
        with db.engine.begin() as c:
            cond = and_(e.course_id == course_id, e.user_id == user_id)
            row = c.execute(select(db.enrollments).where(cond)).first()
            if not row:
                raise HTTPException(404, "수강신청을 찾을 수 없어요.")
            if req.status == "removed":
                c.execute(delete(db.enrollments).where(cond))
            elif req.status == "rejected":
                c.execute(update(db.enrollments).where(cond).values(
                    status="rejected", decided_at=time.time(), instructor_by=t["id"], note=req.note.strip()))
            elif row.status != "approved":
                c.execute(update(db.enrollments).where(cond).values(
                    status="approved", decided_at=time.time(), instructor_by=t["id"], note=""))

    await db.run(run)
    return {"ok": True}


@router.post("/api/courses/{course_id}/approve-all")
async def approve_all(course_id: int, request: Request):
    t = await require_user(request, "teacher")
    await db.run(owned_course, course_id, t)

    def run():
        e = db.enrollments.c
        with db.engine.begin() as c:
            return c.execute(update(db.enrollments).where(e.course_id == course_id, e.status == "pending")
                             .values(status="approved", decided_at=time.time(), instructor_by=t["id"])).rowcount

    return {"approved": await db.run(run)}


# ───────────────────────── 학생 ─────────────────────────


@router.get("/api/courses/my-learning")
async def my_learning_courses(request: Request):
    """학생 본인의 모든 수강신청 이력. 종료·보관된 강좌도 포함한다."""
    u = await require_user(request, "student")

    def run():
        with db.engine.connect() as c:
            mine = {e.course_id: (e.status, e.note) for e in c.execute(
                select(db.enrollments).where(db.enrollments.c.user_id == u["id"]))}
            if not mine:
                return [], mine, {}, {}
            co = db.courses.c
            rows = c.execute(
                select(db.courses, db.users.c.name.label("teacher_name"))
                .join(db.users, db.users.c.id == co.teacher_id)
                .where(co.id.in_(list(mine)))
                .order_by(co.created_at.desc())).all()
            approved = [cid for cid, (status, _) in mine.items() if status == "approved"]
            return rows, mine, sessions_of(c, [r.id for r in rows]), course_notices_of(c, approved)

    rows, mine, sessions, notices = await db.run(run)
    return {"courses": [{**course_row(r), "instructor": r.instructor or r.teacher_name,
                         "status": mine[r.id][0], "note": mine[r.id][1] if mine[r.id][0] == "rejected" else "",
                         "sessions": sessions.get(r.id, []), "notices": notices.get(r.id, [])}
                        for r in rows]}


@router.get("/api/courses/available")
async def available_courses(request: Request):
    """수강신청할 수 있는 강좌 + 내 신청 상태.
    거점학교 공동교육과정처럼 여러 학교 학생이 함께 들으므로 학교로 거르지 않는다."""
    u = await require_user(request, "student")

    def run():
        with db.engine.connect() as c:
            co = db.courses.c
            rows = c.execute(
                select(db.courses, db.users.c.name.label("teacher_name"))
                .join(db.users, db.users.c.id == co.teacher_id)
                .where(co.archived == 0, co.approval == "approved")
                .order_by(co.start_date.desc(), co.title)).all()
            mine = {e.course_id: (e.status, e.note) for e in c.execute(
                select(db.enrollments).where(db.enrollments.c.user_id == u["id"]))}
            ok = [cid for cid, (st, _) in mine.items() if st == "approved"]
            return rows, mine, sessions_of(c, [r.id for r in rows]), course_notices_of(c, ok)

    rows, mine, sess, notes = await db.run(run)
    out = []
    for r in rows:
        status, note = mine.get(r.id, (None, ""))
        row = course_row(r)
        if status is None and (row["recruit"] == "closed" or (not u["is_admin"] and not grade_ok(r, u["grade"]))):
            continue  # 신청 마감·기간 끝남·대상 학년 아님 + 신청한 적 없음
        out.append({**row, "instructor": r.instructor or r.teacher_name, "status": status, "sessions": sess.get(r.id, []),
                    "notices": notes.get(r.id, []),
                    "note": note if status == "rejected" else ""})
    return {"courses": out}


@router.post("/api/courses/{course_id}/enroll")
async def enroll(course_id: int, request: Request):
    u = await require_user(request, "student")

    def run():
        e = db.enrollments.c
        with db.engine.begin() as c:
            co = c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()
            if not co or co.archived or not course_approved(co):
                raise HTTPException(404, "강좌를 찾을 수 없어요.")
            row = c.execute(select(db.enrollments).where(e.course_id == course_id, e.user_id == u["id"])).first()
            if row and row.status in ("approved", "pending"):
                return row.status
            state = recruit_state(co)
            if state == "before":
                raise HTTPException(409, f"모집 기간이 아니에요. ({co.recruit_start.replace('-', '.')}부터 신청할 수 있어요)")
            if state == "closed":
                raise HTTPException(409, "수강신청이 마감된 강좌예요.")
            if co.capacity:
                n = c.execute(select(func.count()).select_from(db.enrollments).where(
                    e.course_id == course_id, e.status.in_(["pending", "approved"]))).scalar()
                if n >= co.capacity:
                    raise HTTPException(409, f"수강 인원({co.capacity}명)이 다 찼어요.")
            joined = [x for x in (co.schools or "").split("\n") if x]
            if joined and not u["is_admin"] and u["school"] not in joined and u["school"] != co.hub_school:
                raise HTTPException(409, f"이 강좌는 참여 학교({', '.join(joined[:5])}{' 등' if len(joined) > 5 else ''}) 학생만 신청할 수 있어요.")
            if not u["is_admin"] and not grade_ok(co, u["grade"]):
                raise HTTPException(409, f"{'·'.join(map(str, course_grades(co)))}학년 대상 강좌예요.")
            if row:  # 거절됐던 강좌에 다시 신청
                c.execute(update(db.enrollments).where(e.id == row.id)
                          .values(status="pending", requested_at=time.time(), decided_at=None,
                                  instructor_by=None, coordinator_by=None, note=""))
            else:
                c.execute(insert(db.enrollments).values(course_id=course_id, user_id=u["id"], status="pending",
                                                        requested_at=time.time()))
            return "pending"

    return {"status": await db.run(run)}


@router.delete("/api/courses/{course_id}/enroll")
async def cancel_enroll(course_id: int, request: Request):
    u = await require_user(request, "student")

    def run():
        e = db.enrollments.c
        with db.engine.begin() as c:
            c.execute(delete(db.enrollments).where(e.course_id == course_id, e.user_id == u["id"],
                                                   e.status.in_(["pending", "approved"])))

    await db.run(run)
    return {"ok": True}


@router.get("/api/courses/live-now")
async def live_now(request: Request):
    """학생: 수강 승인된 강좌에서 지금 열려 있는 수업 → 코드 없이 바로 입장"""
    u = await require_user(request, "student")

    def run():
        with db.engine.connect() as c:
            e, cl, co = db.enrollments.c, db.classes.c, db.courses.c
            # 신청만 하고 아직 확정 전인 강좌의 수업도 알려 준다 (들어갈 수는 없음 → 왜 못 들어가는지 보여 주기)
            return c.execute(
                select(cl.code, cl.title, cl.created_at, co.title.label("course_title"), co.instructor, co.hub_school,
                       e.status)
                .join(db.courses, co.id == cl.course_id)
                .join(db.enrollments, and_(e.course_id == cl.course_id, e.user_id == u["id"],
                                           e.status.in_(["approved", "pending"])))
                .where(cl.ended_at.is_(None), cl.created_at > time.time() - LIVE_LIMIT)
                .order_by(cl.created_at.desc())).all()

    rows = await db.run(run)
    return {"classes": [{"code": r.code, "title": r.title, "course_title": r.course_title, "started_at": r.created_at,
                         "instructor": r.instructor, "hub_school": r.hub_school}
                        for r in rows if r.status == "approved"],
            # 수업은 열렸지만 아직 수강 확정 전 (코드는 알려 주지 않는다)
            "waiting": [{"title": r.title, "course_title": r.course_title, "status": r.status}
                        for r in rows if r.status != "approved"]}


def course_roster(course_id: int) -> list:
    """출결의 '미접속' 계산용: 승인된 수강생"""
    with db.engine.connect() as c:
        return c.execute(select(db.users).join(db.enrollments, db.enrollments.c.user_id == db.users.c.id)
                         .where(db.enrollments.c.course_id == course_id, db.enrollments.c.status == "approved")).all()


# ───────────────────────── 거점학교 관리교사 ─────────────────────────


def managed_hubs(u: dict) -> set[int] | None:
    """관리교사가 맡은 거점학교. 전체 관리자는 None(= 모든 거점학교)."""
    if u["is_admin"]:
        return None
    hubs = {h["id"] for h in u["coordinator_hubs"]}
    if not hubs:
        raise HTTPException(403, "거점학교 관리교사만 할 수 있어요.")
    return hubs


@router.get("/api/hub/overview")
async def hub_overview(request: Request):
    """관리교사: 내 거점학교의 강좌(개설 승인 상태 포함)와 수강생"""
    u = await require_user(request)
    hubs = managed_hubs(u)

    def run():
        co, e = db.courses.c, db.enrollments.c
        with db.engine.connect() as c:
            q = select(db.courses).where(co.hub_id.is_not(None))
            if hubs is not None:
                q = q.where(co.hub_id.in_(hubs))
            courses = c.execute(q.order_by(co.archived, co.start_date.desc())).all()
            rows = c.execute(select(db.enrollments, db.users).join(db.users, db.users.c.id == e.user_id)
                             .where(e.course_id.in_([x.id for x in courses] or [-1]))).all()
            return courses, rows

    courses, rows = await db.run(run)
    titles = {x.id: x for x in courses}
    enrollments = []
    for r in rows:
        m = r._mapping
        cour = titles[m["course_id"]]
        enrollments.append({"id": m["id"], "course_id": m["course_id"], "course_title": cour.title,
                            "instructor": cour.instructor, "hub": cour.hub_school, "status": m["status"],
                            "student_no": student_no(m), "name": m["name"] or m["google_name"],
                            "school": m["school"], "email": m["email"], "note": m["note"],
                            "requested_at": m["requested_at"]})
    enrollments.sort(key=lambda x: (x["course_title"], x["student_no"] or "~", x["name"]))
    counts: dict = {}
    for x in enrollments:
        k = counts.setdefault(x["course_id"], {"approved": 0, "pending": 0})
        key = {"approved": "approved", "pending": "pending"}.get(x["status"])
        if key:
            k[key] += 1
    sess = await db.run(lambda: sessions_by_course([x.id for x in courses]))
    return {"courses": [{**course_row(x, counts), "sessions": sess.get(x.id, []), "teacher_id": x.teacher_id}
                        for x in courses], "enrollments": enrollments}


# ───────────────────────── 거점학교 관리교사: 강좌 개설 승인 ─────────────────────────


class ApprovalReq(BaseModel):
    action: str = Field(pattern="^(approve|reject)$")
    note: str = Field(default="", max_length=300)  # 반려 사유 (강사에게 보임)


@router.post("/api/hub/courses/{course_id}/approval")
async def course_approval(course_id: int, req: ApprovalReq, request: Request):
    """관리교사: 강사가 낸 강좌 개설 신청을 승인하거나 반려한다."""
    u = await require_user(request)
    hubs = managed_hubs(u)

    def run():
        with db.engine.begin() as c:
            row = c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()
            if not row or (hubs is not None and row.hub_id not in hubs):
                raise HTTPException(404, "강좌를 찾을 수 없어요.")
            if req.action == "reject" and not req.note.strip():
                raise HTTPException(400, "반려 사유를 적어 주세요. 강사에게 보여요.")
            c.execute(update(db.courses).where(db.courses.c.id == course_id).values(
                approval="approved" if req.action == "approve" else "rejected",
                approval_note=req.note.strip() if req.action == "reject" else "", approved_by=u["id"]))

    await db.run(run)
    return {"ok": True}


# ───────────────────────── 참여학교 담당교사: 우리 학교 학생 · 탈퇴 승인 ─────────────────────────


def my_schools(u: dict) -> set[str] | None:
    """참여학교 담당교사가 맡은 학교. 전체 관리자는 None(= 모든 학교)."""
    if u["is_admin"]:
        return None
    schools = set(u.get("participant_schools") or [])
    if not schools:
        raise HTTPException(403, "참여학교 담당교사만 할 수 있어요.")
    return schools


@router.get("/api/school/change-requests")
async def school_change_requests(request: Request):
    """새 학교의 참여학교 담당교사에게 학생 전입 신청만 보여 준다."""
    u = await require_user(request)
    schools = set(u.get("participant_schools") or [])
    if not schools:
        raise HTTPException(403, "참여학교 담당교사만 할 수 있어요.")

    def run():
        q = db.profile_change_requests.c
        s = db.users.c
        with db.engine.connect() as c:
            rows = c.execute(select(db.profile_change_requests, s.name, s.role, s.grade, s.class_no, s.number)
                .join(db.users, s.id == q.user_id)
                .where(q.field == "school", q.status == "pending", q.new_value.in_(schools),
                       s.role == "student", s.account_state == "active")
                .order_by(q.requested_at.desc())).all()
            return [{"id": r.id, "name": r.name, "student_no": student_no(r._mapping),
                     "grade": r.grade, "class_no": r.class_no,
                     "old_value": r.old_value, "new_value": r.new_value,
                     "requested_at": r.requested_at} for r in rows]

    return {"requests": await db.run(run)}


class SchoolChangeDecision(BaseModel):
    action: str = Field(pattern="^(approve|reject)$")
    note: str = Field(default="", max_length=300)


@router.post("/api/school/change-requests/{change_id}")
async def decide_school_change(change_id: int, req: SchoolChangeDecision, request: Request):
    u = await require_user(request)
    schools = set(u.get("participant_schools") or [])
    if not schools:
        raise HTTPException(403, "참여학교 담당교사만 할 수 있어요.")
    valid_schools = await db.run(auth.get_schools)

    def run():
        q = db.profile_change_requests.c
        with db.engine.begin() as c:
            row = c.execute(select(db.profile_change_requests).where(q.id == change_id)).first()
            if not row or row.field != "school" or row.new_value not in schools:
                raise HTTPException(404, "우리 학교의 변경 신청을 찾을 수 없어요.")
            if row.status != "pending":
                raise HTTPException(409, "이미 처리한 신청이에요.")
            student = c.execute(select(db.users).where(db.users.c.id == row.user_id)).first()
            if not student or student.role != "student" or student.account_state != "active":
                raise HTTPException(404, "학생을 찾을 수 없어요.")
            if student.school != row.old_value:
                raise HTTPException(409, "학생의 현재 학교가 신청 당시와 달라졌어요. 다시 신청해야 해요.")
            if req.action == "approve":
                if valid_schools and row.new_value not in valid_schools:
                    raise HTTPException(400, "학교 목록에 없는 학교예요.")
                auth.check_school_gender(row.new_value, student.gender or "")
                c.execute(update(db.users).where(db.users.c.id == student.id).values(school=row.new_value))
            c.execute(update(db.profile_change_requests).where(q.id == row.id).values(
                status="approved" if req.action == "approve" else "rejected",
                decided_at=time.time(), decided_by=u["id"], note=req.note.strip()))
            return student.id

    student_id = await db.run(run)
    if req.action == "approve":
        from app.classroom import refresh_user_connections
        await refresh_user_connections(student_id)
    return {"ok": True}


def withdraw_requests(schools: set[str] | None, uid: int | None = None) -> list[dict]:
    """탈퇴를 신청한 학생. 참여학교 담당교사는 자기 학교 학생만, 전체 관리자는 모두 본다."""
    today = auth.today_kst()
    with db.engine.connect() as c:
        u = db.users.c
        q = select(db.users).where(u.withdraw_at.is_not(None), u.role == "student", u.account_state == "active")
        if schools is not None:
            q = q.where(u.school.in_(schools))
        if uid is not None:
            q = q.where(u.id == uid)
        users = c.execute(q.order_by(u.withdraw_at)).all()
        ids = [x.id for x in users] or [-1]
        e, co = db.enrollments.c, db.courses.c
        rows = c.execute(select(e.user_id, e.status, co.title, co.end_date, co.archived)
                         .select_from(db.enrollments.join(db.courses, co.id == e.course_id))
                         .where(e.user_id.in_(ids))).all()
    out = []
    for x in users:
        mine = [r for r in rows if r.user_id == x.id]
        studying = [r.title for r in mine if r.status == "approved" and not r.archived and not (r.end_date and r.end_date < today)]
        out.append({"user_id": x.id, "name": x.name, "school": x.school, "student_no": student_no(dict(x._mapping)),
                    "email": x.email, "reason": x.withdraw_reason, "requested_at": x.withdraw_at,
                    "courses": sorted({r.title for r in mine}), "studying": studying})
    return out


def school_students(schools: set[str] | None) -> list[dict]:
    """우리 학교 학생과 수강신청 (수업신청자 관리와 같은 칸: 교육과정·과목·거점학교·담당교사·신청일·상태)"""
    with db.engine.connect() as c:
        u = db.users.c
        q = select(db.users).where(u.role == "student", u.account_state == "active")
        if schools is not None:
            q = q.where(u.school.in_(schools))
        users = c.execute(q).all()
        e, co = db.enrollments.c, db.courses.c
        rows = c.execute(select(e.user_id, e.status, e.requested_at, co.id, co.title, co.subject, co.school_year, co.term,
                                co.instructor, co.hub_school, co.archived)
                         .select_from(db.enrollments.join(db.courses, co.id == e.course_id))
                         .where(e.user_id.in_([x.id for x in users] or [-1]))).all()
    out = []
    for x in users:
        mine = [r for r in rows if r.user_id == x.id and r.status in ("approved", "pending", "rejected")]
        out.append({"user_id": x.id, "name": x.name or x.google_name, "school": x.school, "grade": x.grade, "class_no": x.class_no,
                    "student_no": student_no(dict(x._mapping)), "withdraw": bool(x.withdraw_at),
                    "withdraw_reason": x.withdraw_reason or "", "withdraw_at": x.withdraw_at,
                    "courses": [{"id": r.id, "title": r.title, "subject": r.subject or r.title,
                                 "term": f"{r.school_year}학년도 {r.term}" if r.school_year and r.term else (r.term or ""),
                                 "instructor": r.instructor, "hub": r.hub_school, "status": r.status,
                                 "requested_at": r.requested_at, "archived": bool(r.archived)} for r in mine]})
    out.sort(key=lambda x: (x["school"] or "", x["student_no"] or "~", x["name"] or ""))
    return out


def withdrawn_rows(schools: set[str] | None) -> list[dict]:
    """탈퇴한 학생 기록 (이름·학교·학번·신청일·승인일만)"""
    with db.engine.connect() as c:
        q = select(db.withdrawn)
        if schools is not None:
            q = q.where(db.withdrawn.c.school.in_(schools))
        return [{"id": r.id, "name": r.name, "school": r.school, "student_no": r.student_no, "grade": r.grade,
                 "class_no": r.class_no, "reason": r.reason, "requested_at": r.requested_at, "approved_at": r.approved_at,
                 "approved_by": r.approved_by} for r in c.execute(q.order_by(db.withdrawn.c.approved_at.desc()))]


@router.get("/api/school/overview")
async def school_overview(request: Request):
    """참여학교 담당교사: 우리 학교 학생의 수강 현황과 탈퇴 신청"""
    u = await require_user(request)
    schools = my_schools(u)
    return {"schools": sorted(schools) if schools is not None else [],
            "students": await db.run(school_students, schools),
            "withdrawals": await db.run(withdraw_requests, schools),
            "withdrawn": [],
            "evidence_url": "/live/evidence" if auth.public_user(u).get("evidence_reader") else None}


class WithdrawDecide(BaseModel):
    action: str = Field(pattern="^(approve|reject)$")
    note: str = Field(default="", max_length=300)  # 반려 사유 (학생에게 보임)


@router.post("/api/school/withdrawals/{uid}")
async def school_withdraw_decide(uid: int, req: WithdrawDecide, request: Request):
    """탈퇴 승인: 이용을 종료하고 수업 증빙을 암호화 보관소로 이동한다."""
    u = await require_user(request)
    schools = my_schools(u)
    if not await db.run(withdraw_requests, schools, uid):
        raise HTTPException(404, "탈퇴 신청을 찾을 수 없어요.")
    if req.action == "approve":
        from app.evidence import archive_student
        archive_id = await archive_student(uid, u["id"])
        return {"ok": True, "evidence_id": archive_id}
    else:
        def run():
            with db.engine.begin() as c:
                c.execute(update(db.users).where(db.users.c.id == uid).values(withdraw_at=None, withdraw_note=req.note.strip()))

        await db.run(run)
    return {"ok": True}


# ───────────────────────── 듣고 싶은 과목 개설 요청 ─────────────────────────


class WishReq(BaseModel):
    school_year: int = Field(ge=2020, le=2100)
    term: str = Field(min_length=1, max_length=10)
    subject: str = Field(min_length=1, max_length=60)
    note: str = Field(default="", max_length=300)  # 듣고 싶은 이유 등 (선택)


async def require_course_requester(request: Request) -> dict:
    u = await require_user(request)
    if u["role"] != "student" and not u["is_admin"]:
        raise HTTPException(403, "학생 또는 전체 관리자만 신청할 수 있어요.")
    return u


@router.get("/api/my/course-requests")
async def my_course_requests(request: Request):
    u = await require_course_requester(request)

    def run():
        with db.engine.connect() as c:
            return c.execute(select(db.course_requests).where(db.course_requests.c.user_id == u["id"])
                             .order_by(db.course_requests.c.created_at.desc())).all()

    return {"requests": [{"id": r.id, "school_year": r.school_year or datetime.fromtimestamp(r.created_at, KST).year,
                          "term": r.term, "subject": r.subject, "note": r.note,
                          "date": datetime.fromtimestamp(r.created_at, KST).strftime("%Y-%m-%d")}
                         for r in await db.run(run)]}


@router.post("/api/course-requests")
async def add_course_request(req: WishReq, request: Request):
    """학생·전체 관리자: 같은 학기에 같은 과목은 한 번, 학기당 5개까지 요청한다."""
    u = await require_course_requester(request)
    if req.term not in subjects.TERMS:
        raise HTTPException(400, "신청 학기를 골라 주세요.")
    subject = " ".join(req.subject.split())
    note = redact(req.note.strip(), await db.run(known_member_names))

    def run():
        cr = db.course_requests.c
        with db.engine.begin() as c:
            mine = c.execute(select(db.course_requests).where(
                cr.user_id == u["id"], cr.school_year == req.school_year, cr.term == req.term)).all()
            if any(r.subject == subject for r in mine):
                raise HTTPException(409, "이미 요청한 과목이에요.")
            if len(mine) >= 5:
                raise HTTPException(409, "한 학기에는 과목을 5개까지 신청할 수 있어요.")
            c.execute(insert(db.course_requests).values(user_id=u["id"], school_year=req.school_year,
                                                        term=req.term, subject=subject, note=note, created_at=time.time()))

    await db.run(run)
    return {"ok": True}


@router.post("/api/course-requests/{rid}/delete")
async def delete_course_request(rid: int, request: Request):
    await require_course_requester(request)
    raise HTTPException(403, "신청한 글은 삭제할 수 없어요.")


@router.get("/api/course-requests/board")
async def course_request_board(request: Request):
    """공개 게시판: 작성자 식별정보 없이 신청 이유와 공감 수를 표시한다."""
    u = await auth.current_user(request)

    def run():
        with db.engine.connect() as c:
            rows = c.execute(select(db.course_requests).order_by(
                db.course_requests.c.created_at.desc(), db.course_requests.c.id.desc())).all()
            likes = dict(c.execute(select(db.course_request_likes.c.request_id, func.count())
                                   .group_by(db.course_request_likes.c.request_id)).all())
            liked = set(c.execute(select(db.course_request_likes.c.request_id).where(
                db.course_request_likes.c.user_id == u["id"])).scalars()) if u else set()
        names = known_member_names()
        return [{"id": r.id, "school_year": r.school_year or datetime.fromtimestamp(r.created_at, KST).year,
                 "term": r.term, "subject": r.subject, "note": redact(r.note, names),
                 "date": datetime.fromtimestamp(r.created_at, KST).strftime("%Y-%m-%d"),
                 "likes": likes.get(r.id, 0), "liked": r.id in liked} for r in rows]

    return {"requests": await db.run(run)}


@router.post("/api/course-requests/{rid}/like")
async def toggle_course_request_like(rid: int, request: Request):
    u = await require_user(request)

    def run():
        likes = db.course_request_likes.c
        with db.engine.begin() as c:
            if c.execute(select(db.course_requests.c.id).where(db.course_requests.c.id == rid)).first() is None:
                raise HTTPException(404, "신청 글을 찾을 수 없어요.")
            mine = c.execute(select(likes.request_id).where(
                likes.request_id == rid, likes.user_id == u["id"])).first()
            if mine:
                c.execute(delete(db.course_request_likes).where(
                    likes.request_id == rid, likes.user_id == u["id"]))
            else:
                c.execute(insert(db.course_request_likes).values(request_id=rid, user_id=u["id"]))
            count = c.execute(select(func.count()).select_from(db.course_request_likes).where(
                likes.request_id == rid)).scalar_one()
        return {"likes": count, "liked": not bool(mine)}

    return await db.run(run)


def request_groups(include_likes: bool = False) -> list[dict]:
    """과목별 개설 요청: 요청 학생 수 · 학년 · 학교 · 하고 싶은 말 (학생 이름 없이)"""
    def run():
        with db.engine.connect() as c:
            # 탈퇴한 학생의 신청(작성자 정보 없음)도 통계에 넣는다
            rows = c.execute(select(db.course_requests, db.users.c.school, db.users.c.grade)
                             .outerjoin(db.users, db.users.c.id == db.course_requests.c.user_id)).all()
            likes = dict(c.execute(select(db.course_requests.c.subject, func.count())
                .select_from(db.course_request_likes.join(db.course_requests,
                    db.course_request_likes.c.request_id == db.course_requests.c.id))
                .group_by(db.course_requests.c.subject)).all()) if include_likes else {}
            return rows, likes

    groups: dict = {}
    rows, likes = run()
    for r in rows:
        g = groups.setdefault(r.subject, {"subject": r.subject, "count": 0, "grades": {}, "schools": {}, "notes": [],
                                          "latest": 0})
        g["count"] += 1
        if r.grade:
            g["grades"][r.grade] = g["grades"].get(r.grade, 0) + 1
        if r.school:
            g["schools"][r.school] = g["schools"].get(r.school, 0) + 1
        if r.note:
            g["notes"].append(r.note)
        g["latest"] = max(g["latest"], r.created_at)
    known = {x["name"]: x for x in subjects.SUBJECTS}
    if include_likes:
        for subject, g in groups.items():
            g["likes"] = likes.get(subject, 0)
            g["count"] += g["likes"]
    out = sorted(groups.values(), key=lambda g: (-g["count"], -g["latest"]))
    for g in out:
        subject = known.get(g["subject"])
        g["in_curriculum"] = subject is not None
        g["subject_area"] = subject["area"] if subject else ""
        g["notes"] = g["notes"][-5:]
    return out


@router.get("/api/hub/course-requests")
async def hub_course_requests(request: Request):
    """관리교사·전체 관리자: 과목별 요청 (학교·하고 싶은 말 포함)"""
    u = await require_user(request)
    managed_hubs(u)  # 관리교사·전체 관리자만
    return {"requests": await db.run(request_groups)}


@router.get("/api/course-requests/summary")
async def course_request_summary():
    """메인 화면: 신청 글 수와 공감 수를 합친 희망 인원을 보여 준다."""
    out = await db.run(request_groups, True)
    return {"requests": [{"subject": g["subject"], "subject_area": g["subject_area"],
                          "count": g["count"], "likes": g["likes"], "grades": g["grades"],
                          "in_curriculum": g["in_curriculum"]} for g in out[:12]]}


# ───────────────────────── 강좌 공지사항 (강사 → 수강생) ─────────────────────────


class CourseNoticeReq(BaseModel):
    id: int | None = None
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(default="", max_length=10000)


def notice_json(n) -> dict:
    return {"id": n.id, "title": n.title, "body": n.body, "author": n.author,
            "date": datetime.fromtimestamp(n.created_at, KST).strftime("%Y-%m-%d"),
            "new": n.created_at > time.time() - 3 * 86400}


def course_notices_of(c, course_ids) -> dict:
    out: dict = {}
    for n in c.execute(select(db.course_notices).where(db.course_notices.c.course_id.in_(list(course_ids) or [-1]))
                       .order_by(db.course_notices.c.created_at.desc())):
        out.setdefault(n.course_id, []).append(notice_json(n))
    return out


@router.get("/api/courses/{course_id}/notices")
async def course_notices(course_id: int, request: Request):
    """강좌 공지: 그 강좌 선생님과 수강 확정 학생만"""
    u = await require_user(request)
    if u["role"] == "student":
        if not await db.run(is_enrolled, course_id, u["id"]):
            raise HTTPException(404, "강좌를 찾을 수 없어요.")
    else:
        await db.run(owned_course, course_id, u)

    def run():
        with db.engine.connect() as c:
            return course_notices_of(c, [course_id]).get(course_id, [])

    return {"notices": await db.run(run)}


@router.post("/api/courses/{course_id}/notices")
async def save_course_notice(course_id: int, req: CourseNoticeReq, request: Request):
    t = await require_user(request, "teacher")
    await db.run(owned_course, course_id, t)
    values = {"title": req.title.strip(), "body": req.body.strip()}

    def run():
        n = db.course_notices.c
        with db.engine.begin() as c:
            if req.id:
                if not c.execute(update(db.course_notices).where(n.id == req.id, n.course_id == course_id)
                                 .values(updated_at=time.time(), **values)).rowcount:
                    raise HTTPException(404, "공지를 찾을 수 없어요.")
                return req.id
            return c.execute(insert(db.course_notices).values(course_id=course_id, author=t["name"] or "",
                                                              created_at=time.time(), **values)).inserted_primary_key[0]

    return {"id": await db.run(run)}


@router.post("/api/courses/{course_id}/notices/{nid}/delete")
async def delete_course_notice(course_id: int, nid: int, request: Request):
    t = await require_user(request, "teacher")
    await db.run(owned_course, course_id, t)

    def run():
        n = db.course_notices.c
        with db.engine.begin() as c:
            c.execute(delete(db.course_notices).where(n.id == nid, n.course_id == course_id))

    await db.run(run)
    return {"ok": True}
