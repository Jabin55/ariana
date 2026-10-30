"""강좌 과제: 선생님이 과제를 내고, 수강 확정 학생이 파일·글로 제출하고, 선생님이 점수·피드백을 준다.

- 제출 파일은 우리 서버(FILES_DIR)에 보관한다. 학생 개인정보이므로 그 학생과 강좌 선생님만 받을 수 있다.
- 마감 전에는 몇 번이든 고쳐 낼 수 있다. 마감 뒤에는 '지각 제출 받기'를 켠 과제만 받고 지각으로 표시한다.
"""

from __future__ import annotations

import os
import re
import tempfile
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, insert, select, update

from app import db
from app.wipe import wipe
from app.auth import KST, require_user, student_no
from app.courses import course_roster, is_enrolled, owned_course

router = APIRouter()

FILES_DIR = Path(os.environ.get("FILES_DIR") or Path(tempfile.gettempdir()) / "live-files")
MAX_FILE_BYTES = 20 * 1024 * 1024  # 파일 하나 20MB
MAX_FILES = 5  # 한 학생이 한 과제에 낼 수 있는 파일 수
# 브라우저에서 바로 열어도 안전한 형식 (그 밖은 내려받기만: 웹페이지·SVG 등으로 몰래 스크립트를 실행하지 못하게)
INLINE_TYPES = {"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"}
DUE_RE = r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})?$"


def parse_due(s: str) -> float | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s).replace(tzinfo=KST).timestamp()
    except ValueError:
        raise HTTPException(400, "마감 날짜가 올바르지 않아요.")


def fmt(ts: float | None) -> str:
    return datetime.fromtimestamp(ts, KST).strftime("%Y-%m-%d %H:%M") if ts else ""


def due_input(ts: float | None) -> str:
    return datetime.fromtimestamp(ts, KST).strftime("%Y-%m-%dT%H:%M") if ts else ""


def safe_name(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", (name or "").strip()).strip(". ") or "파일"
    return name[-120:]


def file_path(assignment_id: int, fid: str) -> Path:
    return FILES_DIR / "assignments" / str(assignment_id) / fid


def assignment_view(a, now: float) -> dict:
    return {"id": a.id, "course_id": a.course_id, "title": a.title, "description": a.description,
            "due_at": a.due_at, "due": fmt(a.due_at), "due_input": due_input(a.due_at),
            "allow_late": bool(a.allow_late), "closed": bool(a.closed),
            "past_due": bool(a.due_at and now > a.due_at), "created_at": a.created_at,
            "weight": a.weight, "max_score": a.max_score}


def can_submit(a, now: float) -> tuple[bool, str]:
    if a.closed:
        return False, "선생님이 제출을 마감했어요."
    if a.due_at and now > a.due_at and not a.allow_late:
        return False, "마감 시간이 지났어요."
    return True, ""


def _assignment(aid: int):
    with db.engine.connect() as c:
        return c.execute(select(db.assignments).where(db.assignments.c.id == aid)).first()


async def teacher_assignment(aid: int, t: dict):
    a = await db.run(_assignment, aid)
    if not a:
        raise HTTPException(404, "과제를 찾을 수 없어요.")
    await db.run(owned_course, a.course_id, t)  # 강좌 주인 + 그 거점학교 활동 기간 확인
    return a


async def student_assignment(aid: int, u: dict):
    a = await db.run(_assignment, aid)
    if not a or not await db.run(is_enrolled, a.course_id, u["id"]):
        raise HTTPException(404, "과제를 찾을 수 없어요.")
    return a


# ───────────────────────── 선생님 ─────────────────────────


class AssignmentReq(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=5000)
    due: str = Field(default="", pattern=DUE_RE)  # 2026-11-05T23:59 (한국 시각)
    allow_late: bool = True
    weight: float | None = Field(default=None, ge=0, le=100)  # 반영 비율(%)
    max_score: float | None = Field(default=None, gt=0, le=1000)  # 영역 만점(점)


class AssignmentUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=5000)
    due: str | None = Field(default=None, pattern=DUE_RE)
    allow_late: bool | None = None
    closed: bool | None = None
    weight: float | None = Field(default=None, ge=0, le=100)
    max_score: float | None = Field(default=None, gt=0, le=1000)


@router.get("/api/courses/{course_id}/assignments")
async def course_assignments(course_id: int, request: Request):
    t = await require_user(request, "teacher")
    await db.run(owned_course, course_id, t)
    now = time.time()

    def run():
        with db.engine.connect() as c:
            rows = c.execute(select(db.assignments).where(db.assignments.c.course_id == course_id)
                             .order_by(db.assignments.c.created_at.desc())).all()
            s = db.submissions.c
            stats = {r.assignment_id: (r.n, r.g) for r in c.execute(
                select(s.assignment_id, func.count().label("n"), func.count(s.graded_at).label("g"))
                .where(s.assignment_id.in_([r.id for r in rows] or [-1]), s.submitted_at.is_not(None))
                .group_by(s.assignment_id))}
            return rows, stats, len(course_roster(course_id))

    rows, stats, students = await db.run(run)
    return {"students": students, "assignments": [
        {**assignment_view(a, now), "submitted": stats.get(a.id, (0, 0))[0], "graded": stats.get(a.id, (0, 0))[1]}
        for a in rows]}


@router.post("/api/courses/{course_id}/assignments")
async def create_assignment(course_id: int, req: AssignmentReq, request: Request):
    t = await require_user(request, "teacher")
    await db.run(owned_course, course_id, t)
    due = parse_due(req.due)

    def run():
        with db.engine.begin() as c:
            return c.execute(insert(db.assignments).values(
                course_id=course_id, teacher_id=t["id"], title=req.title.strip(), description=req.description.strip(),
                due_at=due, allow_late=int(req.allow_late), closed=0, created_at=time.time(),
                weight=req.weight, max_score=req.max_score)).inserted_primary_key[0]

    return {"id": await db.run(run)}


@router.post("/api/assignments/{aid}")
async def update_assignment(aid: int, req: AssignmentUpdate, request: Request):
    t = await require_user(request, "teacher")
    await teacher_assignment(aid, t)
    values = {}
    for k, v in req.model_dump().items():
        if v is None:
            continue
        if k == "due":
            values["due_at"] = parse_due(v)
        elif isinstance(v, bool):
            values[k] = int(v)
        elif isinstance(v, (int, float)):
            values[k] = float(v)
        else:
            values[k] = v.strip()

    def run():
        with db.engine.begin() as c:
            c.execute(update(db.assignments).where(db.assignments.c.id == aid).values(**values))

    if values:
        await db.run(run)
    return {"ok": True}


@router.post("/api/assignments/{aid}/delete")
async def delete_assignment(aid: int, request: Request):
    """과제와 학생 제출물을 모두 지운다."""
    t = await require_user(request, "teacher")
    await teacher_assignment(aid, t)

    def run():
        with db.engine.begin() as c:
            subs = [r.id for r in c.execute(select(db.submissions.c.id).where(db.submissions.c.assignment_id == aid))]
            c.execute(delete(db.submission_files).where(db.submission_files.c.submission_id.in_(subs or [-1])))
            c.execute(delete(db.submissions).where(db.submissions.c.assignment_id == aid))
            c.execute(delete(db.assignments).where(db.assignments.c.id == aid))
        folder = FILES_DIR / "assignments" / str(aid)
        if folder.is_dir():
            for f in folder.iterdir():
                wipe(f)
            folder.rmdir()

    await db.run(run)
    return {"ok": True}


def _submissions(a) -> list[dict]:
    """수강 확정 학생 모두 + (수강이 취소됐지만) 이미 낸 학생"""
    with db.engine.connect() as c:
        roster = {u.id: u for u in course_roster(a.course_id)}
        subs = {s.user_id: s for s in c.execute(select(db.submissions).where(db.submissions.c.assignment_id == a.id))}
        extra = [uid for uid in subs if uid not in roster]
        if extra:
            roster.update({u.id: u for u in c.execute(select(db.users).where(db.users.c.id.in_(extra)))})
        files: dict[int, list] = {}
        if subs:
            for f in c.execute(select(db.submission_files).where(
                    db.submission_files.c.submission_id.in_([s.id for s in subs.values()]))
                    .order_by(db.submission_files.c.created_at)):
                files.setdefault(f.submission_id, []).append({"id": f.id, "name": f.name, "size": f.size})
    out = []
    for uid, u in roster.items():
        m = u._mapping
        s = subs.get(uid)
        done = bool(s and s.submitted_at)
        out.append({
            "user_id": uid, "student_no": student_no(m), "name": m["name"] or m["google_name"], "school": m["school"] or "",
            "submitted": done, "submitted_at": fmt(s.submitted_at) if done else "",
            "late": bool(done and a.due_at and s.submitted_at > a.due_at),
            "text": s.text if s else "", "files": files.get(s.id, []) if s else [],
            "score": s.score if s else None, "feedback": s.feedback if s else "", "graded": bool(s and s.graded_at),
            "enrolled": uid not in extra,
        })
    out.sort(key=lambda x: (x["school"], x["student_no"] or "~", x["name"]))
    return out


@router.get("/api/assignments/{aid}/submissions")
async def assignment_submissions(aid: int, request: Request):
    t = await require_user(request, "teacher")
    a = await teacher_assignment(aid, t)
    return {"assignment": assignment_view(a, time.time()), "submissions": await db.run(_submissions, a)}


class GradeReq(BaseModel):
    user_id: int
    score: float | None = Field(default=None, ge=0, le=1000)
    feedback: str = Field(default="", max_length=3000)


@router.post("/api/assignments/{aid}/grade")
async def grade_submission(aid: int, req: GradeReq, request: Request):
    t = await require_user(request, "teacher")
    await teacher_assignment(aid, t)
    a = await db.run(_assignment, aid)
    if not await db.run(is_enrolled, a.course_id, req.user_id):
        raise HTTPException(404, "이 과제의 수강생을 찾을 수 없어요.")
    if req.score is not None and a.max_score and req.score > a.max_score:
        raise HTTPException(400, f"점수는 영역 만점({a.max_score:g}점)을 넘을 수 없어요.")

    def run():
        s = db.submissions.c
        with db.engine.begin() as c:
            row = c.execute(select(db.submissions).where(s.assignment_id == aid, s.user_id == req.user_id)).first()
            values = {"score": req.score, "feedback": req.feedback.strip(),
                      "graded_at": time.time() if (req.score is not None or req.feedback.strip()) else None}
            if row:
                c.execute(update(db.submissions).where(s.id == row.id).values(**values))
            else:  # 내지 않은 학생에게도 점수·피드백을 줄 수 있다(예: 미제출 0점)
                c.execute(insert(db.submissions).values(assignment_id=aid, user_id=req.user_id, text="", **values))

    await db.run(run)
    return {"ok": True}


@router.get("/api/assignments/{aid}/download.zip")
async def download_all(aid: int, request: Request):
    """제출물 모두 내려받기: 학번_이름 폴더마다 파일과 제출 글"""
    t = await require_user(request, "teacher")
    a = await teacher_assignment(aid, t)
    subs = await db.run(_submissions, a)

    def build():
        buf = tempfile.SpooledTemporaryFile(max_size=50 * 1024 * 1024)
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for s in subs:
                if not s["submitted"]:
                    continue
                folder = safe_name(f"{s['student_no'] or ''}_{s['name']}".strip("_"))
                if s["school"]:
                    folder = safe_name(f"{s['school']}_{folder}")
                if s["late"]:
                    folder += " (지각)"
                if s["text"]:
                    z.writestr(f"{folder}/제출글.txt", s["text"])
                for f in s["files"]:
                    p = file_path(aid, f["id"])
                    if p.is_file():
                        z.write(p, f"{folder}/{safe_name(f['name'])}")
        buf.seek(0)
        return buf

    buf = await db.run(build)
    name = quote(f"{a.title}_제출물.zip")
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": f"attachment; filename=\"submissions-{aid}.zip\"; filename*=UTF-8''{name}"})


# ───────────────────────── 학생 ─────────────────────────


@router.get("/api/my/assignments")
async def my_assignments(request: Request):
    """수강 확정된 강좌의 과제와 내 제출"""
    u = await require_user(request, "student")
    now = time.time()

    def run():
        with db.engine.connect() as c:
            courses = dict(c.execute(select(db.courses.c.id, db.courses.c.title).join(
                db.enrollments, db.enrollments.c.course_id == db.courses.c.id).where(
                db.enrollments.c.user_id == u["id"], db.enrollments.c.status == "approved")).all())
            rows = c.execute(select(db.assignments).where(db.assignments.c.course_id.in_(list(courses) or [-1]))
                             .order_by(db.assignments.c.due_at.is_(None), db.assignments.c.due_at,
                                       db.assignments.c.created_at.desc())).all()
            subs = {s.assignment_id: s for s in c.execute(select(db.submissions).where(
                db.submissions.c.user_id == u["id"], db.submissions.c.assignment_id.in_([r.id for r in rows] or [-1])))}
            files: dict[int, list] = {}
            if subs:
                for f in c.execute(select(db.submission_files).where(
                        db.submission_files.c.submission_id.in_([s.id for s in subs.values()]))
                        .order_by(db.submission_files.c.created_at)):
                    files.setdefault(f.submission_id, []).append({"id": f.id, "name": f.name, "size": f.size})
            return courses, rows, subs, files

    courses, rows, subs, files = await db.run(run)
    out = []
    for a in rows:
        s = subs.get(a.id)
        ok, why = can_submit(a, now)
        done = bool(s and s.submitted_at)
        out.append({**assignment_view(a, now), "course_title": courses.get(a.course_id, ""),
                    "can_submit": ok, "why_not": why,
                    "mine": {"submitted": done, "submitted_at": fmt(s.submitted_at) if done else "",
                             "late": bool(done and a.due_at and s.submitted_at > a.due_at),
                             "text": s.text if s else "", "files": files.get(s.id, []) if s else [],
                             "score": s.score if s and s.graded_at else None,
                             "feedback": s.feedback if s and s.graded_at else "", "graded": bool(s and s.graded_at)}})
    return {"assignments": out}


def _my_submission(c, aid: int, uid: int, create: bool):
    s = db.submissions.c
    row = c.execute(select(db.submissions).where(s.assignment_id == aid, s.user_id == uid)).first()
    if row or not create:
        return row
    c.execute(insert(db.submissions).values(assignment_id=aid, user_id=uid, text=""))
    return c.execute(select(db.submissions).where(s.assignment_id == aid, s.user_id == uid)).first()


def _refresh_submitted(c, sub_id: int) -> None:
    """파일이나 글이 하나라도 있으면 '낸 것', 다 지우면 '안 낸 것'"""
    sub = c.execute(select(db.submissions).where(db.submissions.c.id == sub_id)).first()
    has_files = c.execute(select(func.count()).select_from(db.submission_files)
                          .where(db.submission_files.c.submission_id == sub_id)).scalar()
    done = bool(has_files or sub.text.strip())
    c.execute(update(db.submissions).where(db.submissions.c.id == sub_id)
              .values(submitted_at=time.time() if done else None))


@router.post("/api/assignments/{aid}/files")
async def upload_submission_file(aid: int, request: Request, name: str = Query(default="파일", max_length=300)):
    """제출 파일 올리기 (요청 본문 = 파일 그대로)"""
    u = await require_user(request, "student")
    a = await student_assignment(aid, u)
    ok, why = can_submit(a, time.time())
    if not ok:
        raise HTTPException(409, why)
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(413, f"파일이 너무 커요. {MAX_FILE_BYTES // 1024 // 1024}MB 이하로 올려 주세요.")
    if not data:
        raise HTTPException(400, "빈 파일이에요.")
    ctype = (request.headers.get("content-type") or "application/octet-stream").split(";")[0].strip()[:100]
    fid = uuid.uuid4().hex[:16]

    def run():
        with db.engine.begin() as c:
            sub = _my_submission(c, aid, u["id"], create=True)
            count = c.execute(select(func.count()).select_from(db.submission_files)
                              .where(db.submission_files.c.submission_id == sub.id)).scalar()
            if count >= MAX_FILES:
                raise HTTPException(409, f"파일은 {MAX_FILES}개까지 낼 수 있어요. 필요 없는 파일을 지우고 올려 주세요.")
            p = file_path(aid, fid)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            c.execute(insert(db.submission_files).values(id=fid, submission_id=sub.id, name=safe_name(name),
                                                         size=len(data), content_type=ctype, created_at=time.time()))
            _refresh_submitted(c, sub.id)

    await db.run(run)
    return {"id": fid}


class TextReq(BaseModel):
    text: str = Field(default="", max_length=20000)


@router.post("/api/assignments/{aid}/text")
async def save_submission_text(aid: int, req: TextReq, request: Request):
    u = await require_user(request, "student")
    a = await student_assignment(aid, u)
    ok, why = can_submit(a, time.time())
    if not ok:
        raise HTTPException(409, why)

    def run():
        with db.engine.begin() as c:
            sub = _my_submission(c, aid, u["id"], create=True)
            c.execute(update(db.submissions).where(db.submissions.c.id == sub.id).values(text=req.text.strip()))
            _refresh_submitted(c, sub.id)

    await db.run(run)
    return {"ok": True}


def _file(fid: str):
    with db.engine.connect() as c:
        return c.execute(select(db.submission_files, db.submissions.c.user_id, db.submissions.c.assignment_id)
                         .join(db.submissions, db.submissions.c.id == db.submission_files.c.submission_id)
                         .where(db.submission_files.c.id == fid)).first()


@router.post("/api/submission-files/{fid}/delete")
async def delete_submission_file(fid: str, request: Request):
    u = await require_user(request, "student")
    f = await db.run(_file, fid) if fid.isalnum() else None
    if not f or f.user_id != u["id"]:
        raise HTTPException(404, "파일을 찾을 수 없어요.")
    a = await student_assignment(f.assignment_id, u)
    ok, why = can_submit(a, time.time())
    if not ok:
        raise HTTPException(409, why)

    def run():
        with db.engine.begin() as c:
            c.execute(delete(db.submission_files).where(db.submission_files.c.id == fid))
            _refresh_submitted(c, f.submission_id)
        wipe(file_path(f.assignment_id, fid))

    await db.run(run)
    return {"ok": True}


@router.get("/api/submission-files/{fid}")
async def get_submission_file(fid: str, request: Request):
    """낸 학생 본인과 강좌 선생님만"""
    u = await require_user(request)
    f = await db.run(_file, fid) if fid.isalnum() else None
    if not f:
        raise HTTPException(404, "파일을 찾을 수 없어요.")
    if f.user_id != u["id"]:
        if u["role"] != "teacher":
            raise HTTPException(404, "파일을 찾을 수 없어요.")
        await teacher_assignment(f.assignment_id, u)
    p = file_path(f.assignment_id, fid)
    if not p.is_file():
        raise HTTPException(404, "파일이 없어요.")
    inline = f.content_type in INLINE_TYPES
    return FileResponse(p, media_type=f.content_type if inline else "application/octet-stream", headers={
        "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename=\"file{Path(f.name).suffix[:10]}\"; "
                               f"filename*=UTF-8''{quote(f.name)}",
        "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
    })
