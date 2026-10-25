"""강좌와 수강신청.

학기 초: 강사가 강좌를 개설한다 → 학생이 수강신청 → 강사가 1차 승인 → 거점학교 관리교사가 최종 승인.
(거점학교에 속하지 않은 강좌는 강사 승인만으로 확정된다.)
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
from app import auth
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


def hub_locked(course, t: dict) -> bool:
    """거점학교 강좌인데 그 거점학교 강사(관리교사) 활동 기간이 아니면 관리할 수 없다.
    (다른 거점학교로 옮겼거나 기간이 끝났거나 해제된 경우)"""
    return bool(course.hub_id) and not t["is_admin"] and course.hub_id not in {h["id"] for h in t["teach_hubs"]}


def owned_course(course_id: int, t: dict):
    with db.engine.connect() as c:
        r = c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()
    if not r or r.teacher_id != t["id"]:
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
           "finished": bool(r.end_date and r.end_date < today_kst())}  # 강의기간이 지남
    if counts is not None:
        out.update(counts.get(r.id, {"approved": 0, "pending": 0, "waiting": 0}))
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
    hub_id: int | None = None  # 등록된 거점학교 (강사로 승인받은 학교 중에서)
    hub_school: str = Field(default="", max_length=60)  # 거점학교에 속하지 않은 강좌일 때만 직접 입력
    start_date: str = Field(pattern=DATE)  # 강의기간
    end_date: str = Field(pattern=DATE)
    description: str = Field(default="", max_length=300)
    grades: list[int] = Field(default_factory=list)  # 대상 학년 (비우면 모든 학년)


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
            rows = c.execute(select(db.courses).where(db.courses.c.teacher_id == t["id"])
                             .order_by(db.courses.c.archived, db.courses.c.created_at.desc())).all()
            counts: dict = {}
            e = db.enrollments.c
            for cid, status, n in c.execute(
                    select(e.course_id, e.status, func.count()).where(e.course_id.in_([r.id for r in rows] or [-1]))
                    .group_by(e.course_id, e.status)):
                counts.setdefault(cid, {"approved": 0, "pending": 0, "waiting": 0})
                key = {"approved": "approved", "pending": "pending", "instructor_ok": "waiting"}.get(status)
                if key:
                    counts[cid][key] = n
            return rows, counts

    rows, counts = await db.run(run)
    return {"courses": [{**course_row(r, counts), "locked": hub_locked(r, t)} for r in rows]}


@router.post("/api/courses")
async def create_course(req: CourseReq, request: Request):
    t = await require_user(request, "teacher")
    check_period(req.start_date, req.end_date)
    independent = t["email"].lower() in auth.ADMIN_EMAILS | auth.TEACHER_EMAILS  # 거점학교 밖에서도 강좌를 열 수 있음
    teach_hubs = {h["id"]: h["name"] for h in t["teach_hubs"]}
    if req.hub_id is not None:
        if req.hub_id not in teach_hubs and not t["is_admin"]:
            raise HTTPException(403, "강사로 승인받은 거점학교에만 강좌를 개설할 수 있어요.")
    elif not independent:
        raise HTTPException(400, "강좌를 개설할 거점학교를 골라 주세요.")
    elif not req.hub_school.strip():
        raise HTTPException(400, "거점학교명을 적어 주세요.")

    def run():
        with db.engine.begin() as c:
            hub_school = req.hub_school.strip()
            if req.hub_id is not None:
                hub = c.execute(select(db.hubs).where(db.hubs.c.id == req.hub_id)).first()
                if not hub:
                    raise HTTPException(404, "거점학교를 찾을 수 없어요.")
                hub_school = hub.name
            return c.execute(insert(db.courses).values(
                teacher_id=t["id"], title=req.title.strip(), description=req.description.strip(),
                instructor=req.instructor.strip(), hub_school=hub_school, hub_id=req.hub_id,
                start_date=req.start_date, end_date=req.end_date, grades=grades_text(req.grades),
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
    grades: list[int] | None = None


@router.post("/api/courses/{course_id}")
async def update_course(course_id: int, req: CourseUpdate, request: Request):
    t = await require_user(request, "teacher")
    cur = await db.run(owned_course, course_id, t)
    values = {k: (int(v) if isinstance(v, bool) else grades_text(v) if k == "grades" else v.strip())
              for k, v in req.model_dump().items() if v is not None}
    if cur.hub_id:
        values.pop("hub_school", None)  # 등록된 거점학교 강좌는 거점학교를 바꾸지 않는다
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


class DecideReq(BaseModel):
    status: str = Field(pattern="^(approved|rejected|removed)$")
    note: str = Field(default="", max_length=300)  # 거절 사유 (학생에게 보임)


def after_instructor_ok(course) -> str:
    """강사가 승인한 뒤 상태: 거점학교 강좌면 관리교사 최종 승인 대기, 아니면 바로 확정"""
    return "instructor_ok" if course.hub_id else "approved"


@router.post("/api/courses/{course_id}/enrollments/{user_id}")
async def decide(course_id: int, user_id: int, req: DecideReq, request: Request):
    """강사의 1차 승인·거절·빼기"""
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
            elif row.status in ("pending", "rejected"):
                c.execute(update(db.enrollments).where(cond).values(
                    status=after_instructor_ok(course), decided_at=time.time(), instructor_by=t["id"], note=""))

    await db.run(run)
    return {"ok": True}


@router.post("/api/courses/{course_id}/approve-all")
async def approve_all(course_id: int, request: Request):
    t = await require_user(request, "teacher")
    course = await db.run(owned_course, course_id, t)

    def run():
        e = db.enrollments.c
        with db.engine.begin() as c:
            return c.execute(update(db.enrollments).where(e.course_id == course_id, e.status == "pending")
                             .values(status=after_instructor_ok(course), decided_at=time.time(),
                                     instructor_by=t["id"])).rowcount

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
            mine = {e.course_id: (e.status, e.note) for e in c.execute(
                select(db.enrollments).where(db.enrollments.c.user_id == u["id"]))}
            return rows, mine

    rows, mine = await db.run(run)
    out = []
    for r in rows:
        status, note = mine.get(r.id, (None, ""))
        row = course_row(r)
        if status is None and (not r.open or row["finished"] or not grade_ok(r, u["grade"])):
            continue  # 신청 마감·기간 끝남·대상 학년 아님 + 신청한 적 없음
        out.append({**row, "instructor": r.instructor or r.teacher_name, "status": status,
                    "note": note if status == "rejected" else ""})
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
            if row and row.status in ("approved", "pending", "instructor_ok"):
                return row.status
            if not co.open or (co.end_date and co.end_date < today_kst()):
                raise HTTPException(409, "수강신청이 마감된 강좌예요.")
            if not grade_ok(co, u["grade"]):
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
                                                   e.status.in_(["pending", "instructor_ok", "approved"])))

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


# ───────────────────────── 거점학교 관리교사: 최종 승인 ─────────────────────────


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
    """관리교사: 내 거점학교의 강좌와 수강신청(강사 승인 상태 포함)"""
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
        k = counts.setdefault(x["course_id"], {"approved": 0, "pending": 0, "waiting": 0})
        key = {"approved": "approved", "pending": "pending", "instructor_ok": "waiting"}.get(x["status"])
        if key:
            k[key] += 1
    return {"courses": [course_row(x, counts) for x in courses], "enrollments": enrollments}


class FinalReq(BaseModel):
    status: str = Field(pattern="^(approved|rejected|removed)$")
    note: str = Field(default="", max_length=300)


@router.post("/api/hub/enrollments/{enrollment_id}")
async def final_decide(enrollment_id: int, req: FinalReq, request: Request):
    """관리교사의 최종 승인: 강사가 먼저 승인한 학생만 최종 승인할 수 있다."""
    u = await require_user(request)
    hubs = managed_hubs(u)

    def run():
        e = db.enrollments.c
        with db.engine.begin() as c:
            row = c.execute(select(db.enrollments, db.courses.c.hub_id)
                            .join(db.courses, db.courses.c.id == e.course_id).where(e.id == enrollment_id)).first()
            if not row or row.hub_id is None or (hubs is not None and row.hub_id not in hubs):
                raise HTTPException(404, "수강신청을 찾을 수 없어요.")
            cond = e.id == enrollment_id
            if req.status == "removed":
                c.execute(delete(db.enrollments).where(cond))
            elif req.status == "rejected":
                c.execute(update(db.enrollments).where(cond).values(
                    status="rejected", decided_at=time.time(), coordinator_by=u["id"], note=req.note.strip()))
            else:
                if row.status != "instructor_ok":
                    raise HTTPException(409, "강사가 먼저 승인해야 최종 승인할 수 있어요.")
                c.execute(update(db.enrollments).where(cond).values(
                    status="approved", decided_at=time.time(), coordinator_by=u["id"]))

    await db.run(run)
    return {"ok": True}


class FinalAllReq(BaseModel):
    course_id: int | None = None


@router.post("/api/hub/approve-all")
async def final_approve_all(req: FinalAllReq, request: Request):
    """관리교사: 강사 승인이 끝난 학생 모두 최종 승인 (강좌 하나 또는 내 거점학교 전체)"""
    u = await require_user(request)
    hubs = managed_hubs(u)

    def run():
        e, co = db.enrollments.c, db.courses.c
        with db.engine.begin() as c:
            q = select(co.id).where(co.hub_id.is_not(None))
            if hubs is not None:
                q = q.where(co.hub_id.in_(hubs))
            if req.course_id:
                q = q.where(co.id == req.course_id)
            ids = list(c.execute(q).scalars())
            return c.execute(update(db.enrollments).where(e.course_id.in_(ids or [-1]), e.status == "instructor_ok")
                             .values(status="approved", decided_at=time.time(), coordinator_by=u["id"])).rowcount

    return {"approved": await db.run(run)}
