"""강좌와 수강신청.

학기 초: 선생님이 강좌를 만든다 → 학생이 수강신청 → 선생님이 승인.
수업 때: 선생님이 강좌 수업을 열면, 승인된 학생은 첫 화면에 수업이 떠서 코드 없이 들어간다.
강좌 수업에는 승인된 학생만 들어올 수 있다(코드를 알아도 안 됨).
"""

from __future__ import annotations

import time
from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, func, insert, select, update

from app import db
from app.auth import require_user, student_no

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


def owned_course(course_id: int, teacher_id: int):
    with db.engine.connect() as c:
        r = c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()
    if not r or r.teacher_id != teacher_id:
        raise HTTPException(404, "강좌를 찾을 수 없어요.")
    return r


def course_row(r, counts: dict | None = None) -> dict:
    out = {"id": r.id, "title": r.title, "description": r.description, "open": bool(r.open),
           "archived": bool(r.archived), "created_at": r.created_at,
           "instructor": r.instructor, "hub_school": r.hub_school,
           "start_date": r.start_date, "end_date": r.end_date,
           "finished": bool(r.end_date and r.end_date < today_kst())}  # 강의기간이 지남
    if counts is not None:
        out.update(counts.get(r.id, {"approved": 0, "pending": 0}))
    return out


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


class CourseReq(BaseModel):
    title: str = Field(min_length=1, max_length=60)  # 강의명
    instructor: str = Field(min_length=1, max_length=30)  # 강사명
    hub_school: str = Field(min_length=1, max_length=60)  # 거점학교명
    start_date: str = Field(pattern=DATE)  # 강의기간
    end_date: str = Field(pattern=DATE)
    description: str = Field(default="", max_length=300)


@router.get("/api/courses/mine")
async def my_courses(request: Request):
    t = await require_user(request, "teacher")

    def run():
        with db.engine.connect() as c:
            rows = c.execute(select(db.courses).where(db.courses.c.teacher_id == t["id"])
                             .order_by(db.courses.c.archived, db.courses.c.created_at.desc())).all()
            counts: dict = {}
            e = db.enrollments.c
            for cid, status, n in c.execute(
                    select(e.course_id, e.status, func.count()).where(e.course_id.in_([r.id for r in rows] or [-1]))
                    .group_by(e.course_id, e.status)):
                counts.setdefault(cid, {"approved": 0, "pending": 0})
                if status in ("approved", "pending"):
                    counts[cid][status] = n
            return rows, counts

    rows, counts = await db.run(run)
    return {"courses": [course_row(r, counts) for r in rows]}


@router.post("/api/courses")
async def create_course(req: CourseReq, request: Request):
    t = await require_user(request, "teacher")
    check_period(req.start_date, req.end_date)

    def run():
        with db.engine.begin() as c:
            return c.execute(insert(db.courses).values(
                teacher_id=t["id"], title=req.title.strip(), description=req.description.strip(),
                instructor=req.instructor.strip(), hub_school=req.hub_school.strip(),
                start_date=req.start_date, end_date=req.end_date,
                school=t["school"] or "", open=1, archived=0, created_at=time.time())).inserted_primary_key[0]

    return {"id": await db.run(run)}


class CourseUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=60)
    instructor: str | None = Field(default=None, min_length=1, max_length=30)
    hub_school: str | None = Field(default=None, min_length=1, max_length=60)
    start_date: str | None = Field(default=None, pattern=DATE)
    end_date: str | None = Field(default=None, pattern=DATE)
    description: str | None = Field(default=None, max_length=300)
    open: bool | None = None
    archived: bool | None = None


@router.post("/api/courses/{course_id}")
async def update_course(course_id: int, req: CourseUpdate, request: Request):
    t = await require_user(request, "teacher")
    cur = await db.run(owned_course, course_id, t["id"])
    values = {k: (int(v) if isinstance(v, bool) else v.strip()) for k, v in req.model_dump().items() if v is not None}
    check_period(values.get("start_date", cur.start_date), values.get("end_date", cur.end_date))
    if req.archived:
        values["open"] = 0  # 보관하면 수강신청도 닫는다

    def run():
        with db.engine.begin() as c:
            c.execute(update(db.courses).where(db.courses.c.id == course_id).values(**values))

    if values:
        await db.run(run)
    return {"ok": True}


@router.get("/api/courses/{course_id}/enrollments")
async def course_enrollments(course_id: int, request: Request):
    t = await require_user(request, "teacher")
    await db.run(owned_course, course_id, t["id"])

    def run():
        with db.engine.connect() as c:
            return c.execute(select(db.enrollments, db.users)
                             .join(db.users, db.users.c.id == db.enrollments.c.user_id)
                             .where(db.enrollments.c.course_id == course_id)).all()

    out = []
    for r in await db.run(run):
        m = r._mapping
        out.append({"user_id": m["user_id"], "student_no": student_no(m), "name": m["name"] or m["google_name"],
                    "school": m["school"], "email": m["email"], "status": m["status"],
                    "requested_at": m["requested_at"]})
    out.sort(key=lambda x: (x["student_no"] or "~", x["name"]))
    return {"enrollments": out}


class DecideReq(BaseModel):
    status: str = Field(pattern="^(approved|rejected|removed)$")


@router.post("/api/courses/{course_id}/enrollments/{user_id}")
async def decide(course_id: int, user_id: int, req: DecideReq, request: Request):
    t = await require_user(request, "teacher")
    await db.run(owned_course, course_id, t["id"])

    def run():
        e = db.enrollments.c
        with db.engine.begin() as c:
            cond = and_(e.course_id == course_id, e.user_id == user_id)
            if req.status == "removed":
                c.execute(delete(db.enrollments).where(cond))
            else:
                c.execute(update(db.enrollments).where(cond).values(status=req.status, decided_at=time.time()))

    await db.run(run)
    return {"ok": True}


@router.post("/api/courses/{course_id}/approve-all")
async def approve_all(course_id: int, request: Request):
    t = await require_user(request, "teacher")
    await db.run(owned_course, course_id, t["id"])

    def run():
        e = db.enrollments.c
        with db.engine.begin() as c:
            return c.execute(update(db.enrollments).where(e.course_id == course_id, e.status == "pending")
                             .values(status="approved", decided_at=time.time())).rowcount

    return {"approved": await db.run(run)}


# ───────────────────────── 학생 ─────────────────────────


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
                .where(co.archived == 0)
                .order_by(co.start_date.desc(), co.title)).all()
            mine = {e.course_id: e.status for e in c.execute(
                select(db.enrollments).where(db.enrollments.c.user_id == u["id"]))}
            return rows, mine

    rows, mine = await db.run(run)
    out = []
    for r in rows:
        status = mine.get(r.id)
        row = course_row(r)
        if status is None and (not r.open or row["finished"]):
            continue  # 신청 마감·기간 끝남 + 신청한 적 없음
        out.append({**row, "instructor": r.instructor or r.teacher_name, "status": status})
    return {"courses": out}


@router.post("/api/courses/{course_id}/enroll")
async def enroll(course_id: int, request: Request):
    u = await require_user(request, "student")

    def run():
        e = db.enrollments.c
        with db.engine.begin() as c:
            co = c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()
            if not co or co.archived:
                raise HTTPException(404, "강좌를 찾을 수 없어요.")
            row = c.execute(select(db.enrollments).where(e.course_id == course_id, e.user_id == u["id"])).first()
            if row and row.status in ("approved", "pending"):
                return row.status
            if not co.open or (co.end_date and co.end_date < today_kst()):
                raise HTTPException(409, "수강신청이 마감된 강좌예요.")
            if row:  # 거절됐던 강좌에 다시 신청
                c.execute(update(db.enrollments).where(e.id == row.id)
                          .values(status="pending", requested_at=time.time(), decided_at=None))
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
            return c.execute(
                select(cl.code, cl.title, cl.created_at, co.title.label("course_title"), co.instructor, co.hub_school)
                .join(db.courses, co.id == cl.course_id)
                .join(db.enrollments, and_(e.course_id == cl.course_id, e.user_id == u["id"], e.status == "approved"))
                .where(cl.ended_at.is_(None), cl.created_at > time.time() - LIVE_LIMIT)
                .order_by(cl.created_at.desc())).all()

    return {"classes": [{"code": r.code, "title": r.title, "course_title": r.course_title, "started_at": r.created_at,
                         "instructor": r.instructor, "hub_school": r.hub_school}
                        for r in await db.run(run)]}


def course_roster(course_id: int) -> list:
    """출결의 '미접속' 계산용: 승인된 수강생"""
    with db.engine.connect() as c:
        return c.execute(select(db.users).join(db.enrollments, db.enrollments.c.user_id == db.users.c.id)
                         .where(db.enrollments.c.course_id == course_id, db.enrollments.c.status == "approved")).all()
