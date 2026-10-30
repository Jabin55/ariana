"""학생이 확인한 수행평가 점수와 자필 서명을 PDF로 보관한다."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import threading
import time
import uuid
from datetime import date, datetime, time as day_time, timedelta
from html import escape
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from cryptography.fernet import InvalidToken
from PIL import Image as PILImage, ImageChops, UnidentifiedImageError
from pydantic import BaseModel, Field
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import insert, select, update

from app import db
from app.assignments import FILES_DIR, fmt, safe_name
from app.auth import KST, require_user, student_no
from app.courses import course_roster, is_enrolled, owned_course
from app.wipe import wipe

router = APIRouter()
PRIVATE = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
FONT_PATH = Path(__file__).parent / "assets" / "GowunBatang-Regular.ttf"
_FONT_NAME = "ScoreConfirmationGowun"
_FONT_LOCK = threading.Lock()


def confirmation_path(course_id: int, user_id: int, file_id: str) -> Path:
    return FILES_DIR / "score-confirmations" / str(course_id) / str(user_id) / f"{file_id}.enc"


def confirmation_expires_at(end_date: str, signed_at: float) -> float:
    """과목 종료일부터 365일, 종료일이 없으면 서명일부터 365일."""
    if end_date:
        try:
            end = date.fromisoformat(end_date)
        except ValueError:
            end = None
        if end:
            return datetime.combine(end + timedelta(days=365), day_time.min, KST).timestamp()
    return signed_at + 365 * 86400


def record_expires_at(row, end_date: str) -> float:
    return row.expires_at or confirmation_expires_at(end_date, row.signed_at)


def _snapshot(course_id: int, user_id: int) -> dict:
    with db.engine.connect() as c:
        course = c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()
        user = c.execute(select(db.users).where(db.users.c.id == user_id)).first()
        if not course or not user:
            raise HTTPException(404, "강좌 또는 학생을 찾을 수 없어요.")
        a, s = db.assignments.c, db.submissions.c
        rows = c.execute(select(a.id, a.title, a.description, a.weight, a.max_score,
                                s.score, s.feedback, s.graded_at)
                         .select_from(db.assignments.outerjoin(db.submissions,
                             (s.assignment_id == a.id) & (s.user_id == user_id)))
                         .where(a.course_id == course_id).order_by(a.created_at, a.id)).all()
    items = [{"id": r.id, "title": r.title, "description": r.description,
              "weight": r.weight, "max_score": r.max_score,
              "score": r.score if r.graded_at else None,
              "feedback": r.feedback if r.graded_at else ""} for r in rows]
    details = {"course_id": course_id, "course_title": course.title,
               "end_date": course.end_date or "",
               "school_year": course.school_year, "term": course.term,
               "hub_school": course.hub_school, "instructor": course.instructor,
               "student_name": user.name or user.google_name,
               "student_school": user.school or "", "student_no": student_no(dict(user._mapping)),
               "items": items}
    payload = json.dumps(details, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    details["snapshot_hash"] = hashlib.sha256(payload.encode()).hexdigest()
    return details


def _record(course_id: int, user_id: int):
    with db.engine.connect() as c:
        return c.execute(select(db.score_confirmations).where(
            db.score_confirmations.c.course_id == course_id,
            db.score_confirmations.c.user_id == user_id)).first()


def _status(snap: dict, row) -> dict:
    has_scores = any(item["score"] is not None for item in snap["items"])
    now = time.time()
    expired = bool((row and record_expires_at(row, snap["end_date"]) <= now) or
                   confirmation_expires_at(snap["end_date"], now) <= now)
    current = bool(row and not expired and row.snapshot_hash == snap["snapshot_hash"] and
                   confirmation_path(snap["course_id"], row.user_id, row.id).is_file())
    return {"items": snap["items"], "has_scores": has_scores,
            "snapshot_hash": snap["snapshot_hash"],
            "signed": current, "needs_resign": bool(row and not current and not expired),
            "expired": expired,
            "signed_at": fmt(row.signed_at) if current else ""}


def _font() -> str:
    with _FONT_LOCK:
        if _FONT_NAME not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(_FONT_NAME, str(FONT_PATH)))
    return _FONT_NAME


def _number(value) -> str:
    return "-" if value is None else f"{value:g}"


def _pdf(snap: dict, signature: bytes | None, signed_at: float | None) -> bytes:
    font = _font()
    normal = ParagraphStyle("normal", fontName=font, fontSize=10, leading=16)
    small = ParagraphStyle("small", parent=normal, fontSize=8.5, leading=13)
    title = ParagraphStyle("title", parent=normal, fontSize=17, leading=24, alignment=TA_CENTER)
    heading = ParagraphStyle("heading", parent=normal, fontSize=12, leading=20)
    def p(value, style=normal):
        return Paragraph(escape(str(value or "-")).replace("\n", "<br/>"), style)

    buf = io.BytesIO()
    def frame(canvas, doc):
        canvas.setStrokeColor(colors.HexColor("#49636d"))
        canvas.setLineWidth(0.7)
        canvas.rect(24, 24, A4[0] - 48, A4[1] - 48)
        hub_school = (snap["hub_school"] or "").strip()
        if hub_school:
            canvas.setFont(font, 10)
            canvas.drawCentredString(A4[0] / 2, 38, f"{hub_school}장 귀하")
        canvas.setFont(font, 8)
        canvas.drawRightString(A4[0] - 40, 35, str(doc.page))

    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=42, rightMargin=42,
                            topMargin=46, bottomMargin=50, title="공동교육과정 성적 확인서")
    year = snap["school_year"] or ""
    term = snap["term"] or ""
    document_title = " ".join(part for part in (f"{year}학년도" if year else "", term,
                                                 "공동교육과정 성적 확인서") if part)
    story = [p(document_title, title), Spacer(1, 16)]
    info = [[p("강좌명", small), p(snap["course_title"]), p("거점학교", small), p(snap["hub_school"])],
            [p("소속학교", small), p(snap["student_school"]), p("학번", small), p(snap["student_no"])],
            [p("학생 이름", small), p(snap["student_name"]), p("강의교사", small), p(snap["instructor"])]]
    info_table = Table(info, colWidths=[65, 190, 65, 190])
    info_table.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), .6, colors.HexColor("#adbfc1")),
                                    ("INNERGRID", (0, 0), (-1, -1), .35, colors.HexColor("#d6e1e1")),
                                    ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f2f7f5")),
                                    ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#f2f7f5")),
                                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                                    ("TOPPADDING", (0, 0), (-1, -1), 7),
                                    ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    story += [info_table, Spacer(1, 20), p("성적일람표", heading), Spacer(1, 7)]
    head = [p(x, small) for x in ("연번", "평가명", "반영 비율", "영역 만점", "점수")]
    overview = [head] + [[p(i + 1, small), p(item["title"], small),
                         p(f'{_number(item["weight"])}%' if item["weight"] is not None else "-", small),
                         p(_number(item["max_score"]), small), p(_number(item["score"]) if item["score"] is not None else "미채점", small)]
                         for i, item in enumerate(snap["items"])]
    table = Table(overview, colWidths=[38, 244, 80, 75, 73], repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), .6, colors.HexColor("#94a8ac")),
                              ("INNERGRID", (0, 0), (-1, -1), .35, colors.HexColor("#d6e1e1")),
                              ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#edf5f2")),
                              ("VALIGN", (0, 0), (-1, -1), "TOP"),
                              ("TOPPADDING", (0, 0), (-1, -1), 7),
                              ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    story += [table, Spacer(1, 14)]
    for i, item in enumerate(snap["items"], 1):
        story.append(p(f'{i}. {item["title"]}', heading))
        story.append(p(f'평가 내용: {item["description"] or "기재 없음"}', small))
        if item["feedback"]:
            story.append(p(f'교사 피드백: {item["feedback"]}', small))
        story.append(Spacer(1, 8))
    story += [Spacer(1, 12), p("위 수행평가 내용과 점수를 확인했습니다."), Spacer(1, 9),
              p("학생 확인(서명)", heading)]
    if signature:
        picture = ImageReader(io.BytesIO(signature))
        w, h = picture.getSize()
        story.append(Image(io.BytesIO(signature), width=180, height=180 * h / w))
        story.append(p(f'서명일시: {fmt(signed_at)}', small))
    else:
        story.append(p("서명 전 미리보기", small))
    doc.build(story, onFirstPage=frame, onLaterPages=frame)
    return buf.getvalue()


def _signature(data: str) -> bytes:
    prefix = "data:image/png;base64,"
    if not data.startswith(prefix) or len(data) > 350_000:
        raise HTTPException(400, "서명 이미지가 올바르지 않아요.")
    try:
        raw = base64.b64decode(data[len(prefix):], validate=True)
        im = PILImage.open(io.BytesIO(raw))
        if im.format != "PNG" or im.width < 150 or im.height < 50 or im.width > 1200 or im.height > 600:
            raise ValueError("size or format")
        im.verify()
        im = PILImage.open(io.BytesIO(raw)).convert("RGB")
        if ImageChops.difference(im, PILImage.new("RGB", im.size, "white")).getbbox() is None:
            raise ValueError("blank")
        result = io.BytesIO()
        im.save(result, format="PNG", optimize=True)
        return result.getvalue()
    except (ValueError, OSError, UnidentifiedImageError):
        raise HTTPException(400, "서명을 다시 그려 주세요.") from None


@router.get("/api/my/courses/{course_id}/score-confirmation")
async def my_confirmation(course_id: int, request: Request):
    u = await require_user(request, "student")
    if not await db.run(is_enrolled, course_id, u["id"]):
        raise HTTPException(404, "수강 중인 강좌를 찾을 수 없어요.")
    snap = await db.run(_snapshot, course_id, u["id"])
    row = await db.run(_record, course_id, u["id"])
    return JSONResponse(_status(snap, row), headers=PRIVATE)


@router.get("/api/my/courses/{course_id}/score-confirmation/draft")
async def draft_confirmation(course_id: int, request: Request):
    u = await require_user(request, "student")
    if not await db.run(is_enrolled, course_id, u["id"]):
        raise HTTPException(404, "수강 중인 강좌를 찾을 수 없어요.")
    snap = await db.run(_snapshot, course_id, u["id"])
    if not any(item["score"] is not None for item in snap["items"]):
        raise HTTPException(409, "채점된 수행평가가 없어요.")
    if _status(snap, None)["expired"]:
        raise HTTPException(410, "점수 확인서 보관 기간이 지났어요.")
    return Response(await db.run(_pdf, snap, None, None), media_type="application/pdf", headers=PRIVATE)


class SignRequest(BaseModel):
    signature: str = Field(min_length=100, max_length=350_000)
    snapshot_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


@router.post("/api/my/courses/{course_id}/score-confirmation")
async def sign_confirmation(course_id: int, body: SignRequest, request: Request):
    u = await require_user(request, "student")
    if not await db.run(is_enrolled, course_id, u["id"]):
        raise HTTPException(404, "수강 중인 강좌를 찾을 수 없어요.")
    signature = await db.run(_signature, body.signature)

    def save():
        snap = _snapshot(course_id, u["id"])
        if not any(item["score"] is not None for item in snap["items"]):
            raise HTTPException(409, "채점된 수행평가가 없어요.")
        if snap["snapshot_hash"] != body.snapshot_hash:
            raise HTTPException(409, "점수 또는 평가 내용이 바뀌었어요. 새 내용을 확인한 뒤 다시 서명해 주세요.")
        signed_at = time.time()
        expires_at = confirmation_expires_at(snap["end_date"], signed_at)
        previous = _record(course_id, u["id"])
        if previous:
            expires_at = min(expires_at, record_expires_at(previous, snap["end_date"]))
        if expires_at <= signed_at:
            raise HTTPException(409, "이 강좌의 점수 확인서 보관 기간이 지났어요.")
        pdf = _pdf(snap, signature, signed_at)
        from app.evidence import cipher
        encrypted = cipher().encrypt(pdf)
        file_id = uuid.uuid4().hex
        path = confirmation_path(course_id, u["id"], file_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(encrypted)
            with db.engine.begin() as c:
                old = c.execute(select(db.score_confirmations).where(
                    db.score_confirmations.c.course_id == course_id,
                    db.score_confirmations.c.user_id == u["id"])).first()
                values = {"id": file_id, "snapshot_hash": snap["snapshot_hash"],
                          "signed_at": signed_at, "expires_at": expires_at}
                if old:
                    c.execute(update(db.score_confirmations).where(db.score_confirmations.c.id == old.id).values(**values))
                else:
                    c.execute(insert(db.score_confirmations).values(course_id=course_id, user_id=u["id"], **values))
        except BaseException:
            wipe(path)
            raise
        if old:
            wipe(confirmation_path(course_id, u["id"], old.id))
        return signed_at

    signed_at = await db.run(save)
    return {"ok": True, "signed_at": fmt(signed_at)}


@router.get("/api/my/courses/{course_id}/score-confirmation/file")
async def my_confirmation_file(course_id: int, request: Request):
    u = await require_user(request, "student")
    if not await db.run(is_enrolled, course_id, u["id"]):
        raise HTTPException(404, "수강 중인 강좌를 찾을 수 없어요.")
    return await _file(course_id, u["id"])


@router.get("/api/courses/{course_id}/score-confirmations")
async def teacher_confirmations(course_id: int, request: Request):
    t = await require_user(request, "teacher")
    await db.run(owned_course, course_id, t)

    def run():
        roster = course_roster(course_id)
        with db.engine.connect() as c:
            signed = {r.user_id: r for r in c.execute(select(db.score_confirmations).where(
                db.score_confirmations.c.course_id == course_id))}
        out = []
        for i, u in enumerate(sorted(roster, key=lambda x: (x.school or "", student_no(dict(x._mapping)), x.name or "")), 1):
            snap = _snapshot(course_id, u.id)
            status = _status(snap, signed.get(u.id))
            out.append({"number": i, "user_id": u.id, "school": u.school or "",
                        "student_no": student_no(dict(u._mapping)), "name": u.name or u.google_name,
                        "signed": status["signed"], "needs_resign": status["needs_resign"],
                        "expired": status["expired"],
                        "signed_at": status["signed_at"]})
        return out

    return JSONResponse({"confirmations": await db.run(run)}, headers=PRIVATE)


@router.get("/api/courses/{course_id}/score-confirmations/{user_id}/file")
async def teacher_confirmation_file(course_id: int, user_id: int, request: Request):
    t = await require_user(request, "teacher")
    await db.run(owned_course, course_id, t)
    if not await db.run(is_enrolled, course_id, user_id):
        raise HTTPException(404, "수강생을 찾을 수 없어요.")
    return await _file(course_id, user_id)


async def _file(course_id: int, user_id: int):
    snap = await db.run(_snapshot, course_id, user_id)
    row = await db.run(_record, course_id, user_id)
    if not _status(snap, row)["signed"]:
        raise HTTPException(404, "현재 점수에 대한 확인서가 없어요.")
    from app.evidence import cipher
    try:
        encrypted = await db.run(confirmation_path(course_id, user_id, row.id).read_bytes)
        pdf = await db.run(cipher().decrypt, encrypted)
    except (InvalidToken, OSError):
        raise HTTPException(503, "점수 확인서의 무결성을 확인해야 합니다.") from None
    name = safe_name(f'{snap["course_title"]}_{snap["student_name"]}_점수확인서.pdf')
    headers = {**PRIVATE, "Content-Disposition": f"attachment; filename=score-confirmation.pdf; filename*=UTF-8''{quote(name)}"}
    return Response(pdf, media_type="application/pdf", headers=headers)
