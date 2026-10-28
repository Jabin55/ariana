"""지난 수업 자료: 수업 때 올린 PDF와 판서(화이트보드 포함)를 수업이 끝난 뒤에도 다시 본다.

볼 수 있는 사람
- 학생: 그 강좌에 수강 확정된 학생(수업을 못 들었어도), 또는 그 수업에 들어왔던 학생(특강·모임)
- 선생님: 그 수업을 연 선생님 (그 거점학교 활동 기간이 끝나면 볼 수 없음), 전체 관리자
"""

from __future__ import annotations

import json
import time
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy import delete, or_, select, update

from app import db
from app.wipe import wipe
from app.auth import KST, require_user
from app import classroom
from app.classroom import classes as live_classes, push
from app.courses import taught_course_ids
from app.history import locked_course_ids, my_class_filter

router = APIRouter()


def _live(class_id: int):
    return next((k for k in live_classes.values() if k.db_id == class_id), None)


def _allowed_class_ids(c, u: dict, class_ids: list[int] | None = None) -> set[int]:
    """이 사람이 자료를 볼 수 있는 수업 번호."""
    cl = db.classes.c
    if u["role"] == "teacher":
        q = select(cl.id, cl.course_id).where(my_class_filter(c, u))
        if class_ids is not None:
            q = q.where(cl.id.in_(class_ids))
        locked = locked_course_ids(c, u)
        out = {r.id for r in c.execute(q) if r.course_id not in locked}
        if u["is_admin"] and class_ids is not None:
            out |= set(class_ids)
        return out
    if u["role"] != "student":
        return set()
    courses = select(db.enrollments.c.course_id).where(
        db.enrollments.c.user_id == u["id"], db.enrollments.c.status == "approved")
    attended = select(db.attendance.c.class_id).where(db.attendance.c.user_id == u["id"])
    q = select(cl.id).where(or_(cl.course_id.in_(courses), cl.id.in_(attended)))
    if class_ids is not None:
        q = q.where(cl.id.in_(class_ids))
    return set(c.execute(q).scalars())


def _class_info(r, titles: dict) -> dict:
    return {"id": r.id, "course_id": r.course_id, "title": r.title, "course_title": titles.get(r.course_id, ""),
            "date": datetime.fromtimestamp(r.created_at, KST).strftime("%Y-%m-%d"),
            "live": r.ended_at is None and _live(r.id) is not None}


@router.get("/api/materials")
async def list_materials(request: Request, course_id: int | None = None):
    """자료나 판서가 남아 있는 지난 수업 목록 (최근 것부터)"""
    u = await require_user(request)

    def run():
        with db.engine.connect() as c:
            with_files = set(c.execute(select(db.materials.c.class_id)).scalars())  # 파기한 자료도 기록은 보인다
            with_boards = set(c.execute(select(db.boards.c.class_id)).scalars())
            ids = _allowed_class_ids(c, u, sorted(with_files | with_boards))
            if not ids:
                return []
            q = select(db.classes).where(db.classes.c.id.in_(ids))
            if course_id is not None:
                q = q.where(db.classes.c.course_id == course_id)
            q = q.order_by(db.classes.c.created_at.desc())
            rows = c.execute(q if course_id is not None else q.limit(100)).all()
            titles = dict(c.execute(select(db.courses.c.id, db.courses.c.title)).all())
            counts: dict[int, int] = {}
            removed: dict[int, int] = {}
            for cid, gone in c.execute(select(db.materials.c.class_id, db.materials.c.deleted_at)
                                       .where(db.materials.c.class_id.in_(ids))).all():
                bucket = removed if gone is not None else counts
                bucket[cid] = bucket.get(cid, 0) + 1
            boards = set(c.execute(select(db.boards.c.class_id).where(
                db.boards.c.class_id.in_(ids), db.boards.c.key.like("wb:%"))).scalars())
            return [{**_class_info(r, titles), "files": counts.get(r.id, 0), "removed": removed.get(r.id, 0),
                     "whiteboard": r.id in boards} for r in rows]

    return {"classes": await db.run(run)}


@router.get("/api/materials/class/{class_id}")
async def class_materials(class_id: int, request: Request):
    u = await require_user(request)

    def run():
        with db.engine.connect() as c:
            if class_id not in _allowed_class_ids(c, u, [class_id]):
                raise HTTPException(403, "이 수업 자료를 볼 수 없어요.")
            r = c.execute(select(db.classes).where(db.classes.c.id == class_id)).first()
            titles = dict(c.execute(select(db.courses.c.id, db.courses.c.title)).all())
            rows = c.execute(select(db.materials).where(db.materials.c.class_id == class_id)
                             .order_by(db.materials.c.created_at)).all()
            files = [{"id": m.id, "name": m.name, "pages": m.pages} for m in rows if m.deleted_at is None]
            # 공유했지만 파기한 자료: 파일명과 파기 시각만 (내용은 볼 수 없다)
            removed = [{"id": m.id, "name": m.name, "pages": m.pages, "ratio": m.ratio, "deleted_at": m.deleted_at}
                       for m in rows if m.deleted_at is not None]
            boards = {b.key: json.loads(b.strokes) for b in c.execute(
                select(db.boards).where(db.boards.c.class_id == class_id))}
            return r, titles, files, removed, boards

    r, titles, files, removed, boards = await db.run(run)
    k = _live(class_id)
    if k:  # 진행 중인 수업이면 아직 저장 전인 판서까지
        boards.update({key: v for key, v in k.strokes.items()})
    boards = {key: v for key, v in boards.items() if v}
    wb_pages = max([int(x[3:]) for x in boards if x.startswith("wb:")] + [0])
    return {"class": _class_info(r, titles), "files": files, "removed": removed, "boards": boards, "board_pages": wb_pages,
            "can_delete": u["role"] == "teacher" and await db.run(can_edit_class, r.id, u)}


def can_edit_class(class_id: int, u: dict) -> bool:
    """수업을 연 선생님 또는 그 강좌를 가르치는 선생님(팀티칭)"""
    with db.engine.connect() as c:
        r = c.execute(select(db.classes).where(db.classes.c.id == class_id)).first()
        return bool(r) and (r.teacher_id == u["id"] or r.course_id in taught_course_ids(c, u["id"]))


def _material(fid: str):
    with db.engine.connect() as c:
        return c.execute(select(db.materials, db.classes.c.teacher_id.label("owner"))
                         .join(db.classes, db.classes.c.id == db.materials.c.class_id)
                         .where(db.materials.c.id == fid)).first()


@router.get("/api/materials/file/{fid}")
async def material_file(fid: str, request: Request):
    u = await require_user(request)
    m = await db.run(_material, fid) if fid.isalnum() else None
    if not m:
        raise HTTPException(404, "자료를 찾을 수 없어요.")
    if m.deleted_at is not None:
        raise HTTPException(410, "파기된 자료라 볼 수 없어요.")

    def allowed():
        with db.engine.connect() as c:
            return m.class_id in _allowed_class_ids(c, u, [m.class_id])

    if not await db.run(allowed):
        raise HTTPException(403, "이 수업 자료를 볼 수 없어요.")
    path = classroom.SLIDES_DIR / str(m.class_id) / f"{fid}.pdf"
    if not path.is_file():
        raise HTTPException(404, "자료 파일이 없어요.")
    return FileResponse(path, media_type="application/pdf", headers={"Cache-Control": "private, max-age=86400"})


@router.post("/api/materials/file/{fid}/delete")
async def delete_material(fid: str, request: Request):
    """수업을 연 선생님이 자료를 지운다 (그 자료 위 판서도 함께)."""
    u = await require_user(request, "teacher")
    m = await db.run(_material, fid) if fid.isalnum() else None
    if not m or m.deleted_at is not None or not await db.run(can_edit_class, m.class_id, u):
        raise HTTPException(404, "자료를 찾을 수 없어요.")

    def run():
        with db.engine.begin() as c:
            # 공유한 기록(파일명)은 남기고 파기 표시만 한다
            c.execute(update(db.materials).where(db.materials.c.id == fid).values(deleted_at=time.time()))
            c.execute(delete(db.boards).where(db.boards.c.class_id == m.class_id, db.boards.c.key.like(f"{fid}:%")))
        wipe(classroom.SLIDES_DIR / str(m.class_id) / f"{fid}.pdf")

    await db.run(run)
    k = _live(m.class_id)
    if k:  # 진행 중인 수업 화면에서도 뺀다
        k.files = [f for f in k.files if f["id"] != fid]
        if k.present and k.present.get("file") == fid:
            k.present = None
        for key in [x for x in k.strokes if x.startswith(f"{fid}:")]:
            del k.strokes[key]
            k.dirty_boards.discard(key)
        push(k)
    return {"ok": True, "at": time.time()}
