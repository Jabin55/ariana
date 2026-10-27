"""탈퇴 계정과 분리된 암호화 증빙. 일반 수업 API에서는 원본을 제거한다."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import tempfile
import time
import uuid
import zipfile
from pathlib import Path
from typing import Literal

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from sqlalchemy import delete, insert, select, update

from app import db
from app.wipe import wipe

router = APIRouter()
Purpose = Literal["record_check", "certificate", "appeal"]
PRIVATE = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
MAX_DAYS = 365  # 탈퇴 증빙 최대 보존 기간 (탈퇴 승인일부터 1년)


def retention_policy() -> tuple[int | None, str]:
    # 운영 기준: 탈퇴 승인 후 최대 1년(365일). 더 짧은 기간만 설정할 수 있다.
    basis = os.environ.get("EVIDENCE_RETENTION_BASIS", "").strip() or "운영 기관의 수업·활동 증빙 보존 기준"
    try:
        days = int(os.environ.get("EVIDENCE_RETENTION_DAYS", str(MAX_DAYS)))
    except ValueError:
        days = MAX_DAYS
    days = max(1, min(days, MAX_DAYS))
    if len(basis) > 500:
        basis = basis[:500]
    return days, basis


def cipher() -> Fernet:
    """키는 DB 밖에 둔다. DB 백업에 키를 넣지 않는다. 설정이 없어도 탈퇴는 가능하다."""
    value = os.environ.get("EVIDENCE_ENCRYPTION_KEY", "").strip()
    if not value:
        from app.assignments import FILES_DIR

        path = Path(os.environ.get("EVIDENCE_KEY_FILE") or FILES_DIR / ".evidence-key")
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            with db.engine.connect() as c:
                if c.execute(select(db.evidence_archives.c.id).limit(1)).first():
                    raise HTTPException(503, "기존 증빙 암호화 키를 복구해야 합니다.")
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                with os.fdopen(fd, "wb") as f:
                    f.write(Fernet.generate_key())
        value = path.read_text(encoding="ascii").strip()
    try:
        return Fernet(value.encode("ascii"))
    except (ValueError, UnicodeError):
        raise HTTPException(503, "증빙 암호화 키 설정을 확인해 주세요.") from None


def reader_schools(u: dict) -> set[str] | None:
    if u.get("is_admin"):
        return None
    schools = set(u.get("participant_schools") or [])
    if u["role"] != "teacher" or not schools:
        raise HTTPException(403, "증빙 열람 담당자만 이용할 수 있어요.")
    return schools


def can_read(u: dict) -> bool:
    try:
        reader_schools(u)
        return True
    except HTTPException:
        return False


def audit(actor_id: int | None, action: str, archive_id: str = "", purpose: str = ""):
    with db.engine.begin() as c:
        c.execute(insert(db.evidence_audit).values(actor_id=actor_id, action=action,
                   archive_id=archive_id, purpose=purpose, created_at=time.time()))


def rows(c, table, condition) -> list[dict]:
    return [dict(r._mapping) for r in c.execute(select(table).where(condition))]


def _archive(uid: int, actor_id: int, live: list[dict], crypt: Fernet) -> tuple[str, list[Path]]:
    from app import auth
    from app.assignments import file_path

    now = time.time()
    days, basis = retention_policy()
    archive_id = uuid.uuid4().hex
    with db.engine.begin() as c:
        user = c.execute(select(db.users).where(db.users.c.id == uid)).first()
        if not user or user.account_state != "archiving":
            raise HTTPException(409, "탈퇴 처리 상태가 바뀌었어요. 다시 확인해 주세요.")
        identity = {k: user._mapping[k] for k in ("id", "name", "school", "grade", "class_no", "number")}
        identity["student_no"] = auth.student_no(dict(user._mapping))
        snapshot = {"format": "ariana-student-evidence-v1", "subject": identity,
                    "approved_at": now, "approved_by": actor_id, "requested_at": user.withdraw_at,
                    "live_records": live}
        for key in ("attendance", "questions", "enrollments", "grades", "submissions"):
            table = getattr(db, key)
            snapshot[key] = rows(c, table, table.c.user_id == uid)
        course_ids = {r["course_id"] for r in snapshot["enrollments"]}
        class_ids = {r["class_id"] for r in snapshot["attendance"] + snapshot["questions"]}
        graded_activity_ids = {r["activity_id"] for r in snapshot["grades"]}
        activities = []
        for activity in rows(c, db.activities, db.activities.c.id.in_(graded_activity_ids or [-1])):
            activities.append(activity)
            class_ids.add(activity["class_id"])
        # 응답만 있고 출결 행이 없는 수업도 누락하지 않는다.
        for activity in rows(c, db.activities, db.activities.c.id.not_in(graded_activity_ids or [-1])):
            answers = json.loads(activity["responses"] or "{}")
            if str(uid) in answers:
                activities.append(activity)
                class_ids.add(activity["class_id"])
        snapshot["classes"] = rows(c, db.classes, db.classes.c.id.in_(class_ids or [-1]))
        course_ids |= {r["course_id"] for r in snapshot["classes"] if r["course_id"] is not None}
        snapshot["activities"] = []
        for activity in activities:
            answers = json.loads(activity["responses"] or "{}")
            activity["responses"] = {str(uid): answers[str(uid)]} if str(uid) in answers else {}
            snapshot["activities"].append(activity)
        assignment_ids = {r["assignment_id"] for r in snapshot["submissions"]}
        snapshot["assignments"] = rows(c, db.assignments, db.assignments.c.id.in_(assignment_ids or [-1]))
        course_ids |= {r["course_id"] for r in snapshot["assignments"]}
        course_fields = ("id", "title", "instructor", "hub_school", "start_date", "end_date", "school_year", "term")
        snapshot["courses"] = [{k: r[k] for k in course_fields}
                               for r in rows(c, db.courses, db.courses.c.id.in_(course_ids or [-1]))]
        submission_ids = {r["id"] for r in snapshot["submissions"]}
        files = rows(c, db.submission_files, db.submission_files.c.submission_id.in_(submission_ids or [-1]))
        assignment_of = {r["id"]: r["assignment_id"] for r in snapshot["submissions"]}
        snapshot["files"] = []
        for f in files:
            path = file_path(assignment_of[f["submission_id"]], f["id"])
            if not path.is_file():
                raise HTTPException(409, "제출 파일이 없어 증빙을 보존하지 못했어요. 원본을 확인해 주세요.")
            data = path.read_bytes()
            file_id = uuid.uuid4().hex
            c.execute(insert(db.evidence_files).values(id=file_id, archive_id=archive_id,
                                                      payload=crypt.encrypt(data).decode("ascii")))
            snapshot["files"].append({**f, "evidence_file_id": file_id, "sha256": hashlib.sha256(data).hexdigest()})
        c.execute(insert(db.evidence_archives).values(
            id=archive_id, subject_id=uid, school=user.school, created_at=now,
            expires_at=now + days * 86400 if days else None, basis=basis,
            payload=crypt.encrypt(json.dumps(snapshot, ensure_ascii=False).encode("utf-8")).decode("ascii")))
        cleanup = auth._purge_user_rows(c, uid, keep_account=True)
        c.execute(insert(db.evidence_audit).values(actor_id=actor_id, action="archive_created",
                  archive_id=archive_id, purpose="withdrawal", created_at=now))
    return archive_id, cleanup


async def archive_student(uid: int, actor_id: int) -> str:
    from app import classroom

    crypt = await db.run(cipher)

    def freeze():
        with db.engine.begin() as c:
            result = c.execute(update(db.users).where(db.users.c.id == uid, db.users.c.role == "student",
                      db.users.c.account_state == "active", db.users.c.withdraw_at.is_not(None))
                      .values(account_state="archiving"))
            if result.rowcount != 1:
                raise HTTPException(409, "이미 처리 중이거나 탈퇴 신청이 없는 계정이에요.")

    await db.run(freeze)
    try:
        live = classroom.student_evidence(uid)
        await classroom.disconnect_user(uid)
        archive_id, cleanup = await db.run(_archive, uid, actor_id, live, crypt)
    except BaseException:
        def unfreeze():
            with db.engine.begin() as c:
                c.execute(update(db.users).where(db.users.c.id == uid, db.users.c.account_state == "archiving")
                          .values(account_state="active"))
        await db.run(unfreeze)
        raise
    classroom.forget_student(uid)
    for path in cleanup:
        try:
            await db.run(wipe, path)
        except OSError:
            # 원본 API에서는 이미 조회 불가. 디스크 정리 실패를 민감정보 없이 기록한다.
            audit(None, "source_cleanup_failed", archive_id)
    return archive_id


def maintain_retention():
    """탈퇴 승인일부터 최대 365일 보관하고, 만료 자료는 내용을 지운 뒤 삭제한다(되살릴 수 없음)."""
    now = time.time()
    days, basis = retention_policy()
    with db.engine.begin() as c:
        for row in c.execute(select(db.evidence_archives)).all():
            limit = row.created_at + days * 86400
            if row.expires_at is None or row.expires_at > limit:
                c.execute(update(db.evidence_archives).where(db.evidence_archives.c.id == row.id)
                          .values(expires_at=limit, basis=basis))
        expired = c.execute(select(db.evidence_archives).where(db.evidence_archives.c.expires_at <= now)).all()
        for row in expired:
            # 지우기 전에 암호문을 비워 둔다 (DB 안에 내용이 남지 않게)
            c.execute(update(db.evidence_files).where(db.evidence_files.c.archive_id == row.id).values(payload=""))
            c.execute(update(db.evidence_archives).where(db.evidence_archives.c.id == row.id).values(payload=""))
            c.execute(delete(db.evidence_files).where(db.evidence_files.c.archive_id == row.id))
            c.execute(delete(db.evidence_archives).where(db.evidence_archives.c.id == row.id))
            c.execute(delete(db.users).where(db.users.c.id == row.subject_id, db.users.c.account_state == "withdrawn"))
            c.execute(insert(db.evidence_audit).values(archive_id=row.id, actor_id=None, action="expired_purged",
                      purpose="retention", created_at=now))


async def retention_loop():
    while True:
        try:
            await db.run(maintain_retention)
        except Exception:
            import logging
            logging.getLogger(__name__).error("증빙 보존기간 정리 실패: 운영자 확인 필요")
        await asyncio.sleep(3600)


async def reader(request: Request):
    from app.auth import require_user

    u = await require_user(request, "teacher")
    try:
        schools = reader_schools(u)
    except HTTPException:
        await db.run(audit, u["id"], "access_denied")
        raise
    return u, schools


def _get(archive_id: str, schools: set[str] | None):
    with db.engine.connect() as c:
        row = c.execute(select(db.evidence_archives).where(db.evidence_archives.c.id == archive_id)).first()
    if not row or (schools is not None and row.school not in schools) or (
        min(row.expires_at or float("inf"), row.created_at + MAX_DAYS * 86400) <= time.time()
    ):
        raise HTTPException(404, "증빙을 찾을 수 없어요.")
    return row


def decode(row) -> dict:
    try:
        return json.loads(cipher().decrypt(row.payload.encode("ascii")))
    except (InvalidToken, ValueError):
        raise HTTPException(503, "증빙 무결성 또는 암호화 키를 확인해야 합니다.") from None


@router.get("/live/evidence")
async def page(request: Request):
    await reader(request)
    return FileResponse(Path(__file__).resolve().parent.parent / "static/live/evidence.html", headers=PRIVATE)


@router.get("/api/evidence")
async def list_evidence(request: Request, purpose: Purpose, school: str = Query(default="", max_length=60)):
    u, schools = await reader(request)

    def run():
        with db.engine.connect() as c:
            now = time.time()
            q = select(db.evidence_archives).where(
                db.evidence_archives.c.created_at > now - MAX_DAYS * 86400,
                (db.evidence_archives.c.expires_at.is_(None)) |
                (db.evidence_archives.c.expires_at > now))
            if schools is not None:
                q = q.where(db.evidence_archives.c.school.in_(schools))
            if school:
                q = q.where(db.evidence_archives.c.school == school)
            found = c.execute(q.order_by(db.evidence_archives.c.created_at.desc()).limit(100)).all()
        audit(u["id"], "list", purpose=purpose)
        return [{"id": r.id, "subject": decode(r)["subject"], "created_at": r.created_at,
                 "expires_at": r.expires_at, "basis": r.basis, "policy_pending": r.expires_at is None} for r in found]

    days, basis = retention_policy()
    return JSONResponse({"archives": await db.run(run), "policy": {"days": days, "basis": basis}}, headers=PRIVATE)


@router.get("/api/evidence/{archive_id}")
async def get_evidence(archive_id: str, request: Request, purpose: Purpose):
    u, schools = await reader(request)
    row = await db.run(_get, archive_id, schools)
    await db.run(audit, u["id"], "view", archive_id, purpose)
    return JSONResponse({"record": await db.run(decode, row), "expires_at": row.expires_at,
                         "basis": row.basis, "policy_pending": row.expires_at is None}, headers=PRIVATE)


@router.get("/api/evidence/{archive_id}/download.zip")
async def download(archive_id: str, request: Request, purpose: Purpose):
    u, schools = await reader(request)
    row = await db.run(_get, archive_id, schools)
    await db.run(audit, u["id"], "download_requested", archive_id, purpose)

    def build():
        snapshot = decode(row)
        output = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
        try:
            with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("records.json", json.dumps(snapshot, ensure_ascii=False, indent=2))
                archive.writestr("retention.json", json.dumps({"expires_at": row.expires_at, "basis": row.basis,
                                                               "policy_pending": row.expires_at is None}, ensure_ascii=False))
                crypt = cipher()
                for f in snapshot["files"]:
                    with db.engine.connect() as c:
                        encrypted = c.execute(select(db.evidence_files.c.payload).where(
                            db.evidence_files.c.id == f["evidence_file_id"], db.evidence_files.c.archive_id == archive_id)).scalar()
                    if not encrypted:
                        raise InvalidToken
                    data = crypt.decrypt(encrypted.encode("ascii"))
                    if hashlib.sha256(data).hexdigest() != f["sha256"]:
                        raise InvalidToken
                    archive.writestr(f"files/{f['evidence_file_id']}", data)
            output.seek(0)
            return output
        except (InvalidToken, ValueError):
            output.close()
            raise HTTPException(503, "증빙 파일 무결성을 확인해야 합니다.") from None
        except BaseException:
            output.close()
            raise

    output = await db.run(build)

    async def chunks():
        try:
            while chunk := await db.run(output.read, 65536):
                yield chunk
        finally:
            output.close()

    return StreamingResponse(chunks(), media_type="application/zip", headers={**PRIVATE,
                             "Content-Disposition": f'attachment; filename="evidence-{archive_id}.zip"'})


@router.get("/api/evidence-audit")
async def access_log(request: Request):
    from app.admin import require_admin

    u = await require_admin(request)
    await db.run(audit, u["id"], "audit_view")
    def run():
        with db.engine.connect() as c:
            return [dict(r._mapping) for r in c.execute(select(db.evidence_audit)
                    .order_by(db.evidence_audit.c.id.desc()).limit(200))]
    return JSONResponse({"events": await db.run(run)}, headers=PRIVATE)
