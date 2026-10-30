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
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from html import escape
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from cryptography.fernet import InvalidToken
from PIL import Image as PILImage, ImageChops, UnidentifiedImageError
from pydantic import BaseModel, Field
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
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
from app import subjects
from app.wipe import wipe

router = APIRouter()
PRIVATE = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
FONT_PATH = Path(__file__).parent / "assets" / "GowunBatang-Regular.ttf"
FONT_BOLD_PATH = Path(__file__).parent / "assets" / "GowunBatang-Bold.ttf"
_FONT_NAME = "ScoreConfirmationGowun"
_FONT_BOLD_NAME = "ScoreConfirmationGowunBold"
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
               "achievement": course.achievement or subjects.default_achievement(
                   course.subject_group, course.subject_area, course.subject_type,
                   course.subject or course.title),
               "rank_grade": course.rank_grade or subjects.default_rank(course.achievement),
               "student_name": user.name or "",
               "student_school": user.school or "", "student_no": student_no(dict(user._mapping)),
               "items": items}
    legacy_details = {key: value for key, value in details.items()
                      if key not in ("achievement", "rank_grade")}
    legacy_payload = json.dumps(legacy_details, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    payload = json.dumps(details, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    details["legacy_snapshot_hash"] = hashlib.sha256(legacy_payload.encode()).hexdigest()
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
    matching_hash = row and row.snapshot_hash in (snap["snapshot_hash"], snap["legacy_snapshot_hash"])
    current = bool(row and not expired and matching_hash and
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
            pdfmetrics.registerFont(TTFont(_FONT_BOLD_NAME, str(FONT_BOLD_PATH)))
            pdfmetrics.registerFontFamily(_FONT_NAME, normal=_FONT_NAME, bold=_FONT_BOLD_NAME)
    return _FONT_NAME


def _number(value) -> str:
    return "-" if value is None else f"{value:g}"


def converted_performance_score(items: list[dict]) -> int | None:
    """모든 평가가 채점되고 반영비율 합계가 100%일 때만 환산점수를 확정한다."""
    if not items:
        return None
    total_weight = Decimal(0)
    converted = Decimal(0)
    for item in items:
        if any(item.get(key) is None for key in ("score", "max_score", "weight")):
            return None
        try:
            score = Decimal(str(item["score"]))
            maximum = Decimal(str(item["max_score"]))
            weight = Decimal(str(item["weight"]))
            if not all(value.is_finite() for value in (score, maximum, weight)):
                return None
            if maximum <= 0 or score < 0 or score > maximum or weight < 0 or weight > 100:
                return None
            total_weight += weight
            converted += score / maximum * weight
        except (InvalidOperation, TypeError, ValueError):
            return None
    if total_weight != 100:
        return None
    return int(converted.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _weighted_score(item: dict) -> str:
    try:
        score = Decimal(str(item["score"]))
        maximum = Decimal(str(item["max_score"]))
        weight = Decimal(str(item["weight"]))
        if not all(v.is_finite() for v in (score, maximum, weight)) or maximum <= 0:
            return "-"
        value = (score / maximum * weight).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        return format(value.normalize(), "f")
    except (InvalidOperation, KeyError, TypeError, ValueError):
        return "-"


def _grading_note(snap: dict) -> str:
    achievement = snap.get("achievement")
    scale = {"5": "성취도 5단계(A/B/C/D/E)", "3": "성취도 3단계(A/B/C)",
             "P": "성취도 P/F"}.get(achievement, "강좌에 정해진 성취도 기준")
    rank = snap.get("rank_grade")
    if rank in ("산출", "미산출"):
        return f"※ 본 과목은 {scale}로 평정하며, 석차 등급 {rank}입니다."
    return f"※ 본 과목은 {scale}로 평정합니다."


def _pdf(snap: dict, signature: bytes | None, signed_at: float | None) -> bytes:
    font = _font()
    normal = ParagraphStyle("normal", fontName=font, fontSize=10, leading=16)
    small = ParagraphStyle("small", parent=normal, fontSize=8.5, leading=13)
    title = ParagraphStyle("title", parent=normal, fontSize=17, leading=24, alignment=TA_CENTER)
    heading = ParagraphStyle("heading", parent=normal, fontSize=12, leading=20)
    centered_heading = ParagraphStyle("centered_heading", parent=heading, alignment=TA_CENTER)
    def p(value, style=normal):
        return Paragraph(escape(str(value or "-")).replace("\n", "<br/>"), style)

    buf = io.BytesIO()
    def frame(canvas, doc):
        canvas.setStrokeColor(colors.HexColor("#49636d"))
        canvas.setLineWidth(0.7)
        canvas.rect(24, 24, A4[0] - 48, A4[1] - 48)
        hub_school = (snap["hub_school"] or "").strip()
        if hub_school:
            addressee = f"{hub_school}장 귀하"
            footer_size = min(30, 30 * (A4[0] - 120) / pdfmetrics.stringWidth(addressee, font, 30))
            canvas.setFont(font, footer_size)
            canvas.drawCentredString(A4[0] / 2, 166, addressee)
        footnote_style = ParagraphStyle("footnote", parent=normal, fontSize=10, leading=14)
        footnote = Paragraph(
            "※ 원점수는 지필평가 및 수행평가의 반영비율에 따른 환산 점수 합계를 "
            "소수 첫째 자리에서 반올림하여 정수로 기록함.", footnote_style)
        footnote.wrapOn(canvas, A4[0] - 84, 55)
        footnote.drawOn(canvas, 42, 111)
        grade_note = Paragraph(escape(_grading_note(snap)), footnote_style)
        grade_note.wrapOn(canvas, A4[0] - 84, 42)
        grade_note.drawOn(canvas, 42, 77)
        canvas.setFont(font, 8)
        canvas.drawRightString(A4[0] - 40, 35, str(doc.page))

    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=42, rightMargin=42,
                            topMargin=66, bottomMargin=211, title="공동교육과정 성적 확인서")
    year = snap["school_year"] or ""
    term = snap["term"] or ""
    document_title = " ".join(part for part in (f"{year}학년도" if year else "", term,
                                                 "공동교육과정 성적 확인서") if part)
    story = [p(document_title, title), Spacer(1, 16)]
    info = [[p("강좌명", small), p(snap["course_title"]), p("학생 소속 학교", small), p(snap["student_school"])],
            [p("거점학교", small), p(snap["hub_school"]), p("학생 학번", small), p(snap["student_no"])],
            [p("강의 교사", small), p(snap["instructor"]), p("학생 이름", small), p(snap["student_name"])]]
    info_table = Table(info, colWidths=[85, 170, 95, 160])
    info_table.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), .6, colors.HexColor("#adbfc1")),
                                    ("INNERGRID", (0, 0), (-1, -1), .35, colors.HexColor("#d6e1e1")),
                                    ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f2f7f5")),
                                    ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#f2f7f5")),
                                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                                    ("TOPPADDING", (0, 0), (-1, -1), 7),
                                    ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    story += [info_table, Spacer(1, 20), p("수행평가 성적일람표", centered_heading), Spacer(1, 7)]
    numeric_small = ParagraphStyle("numeric_small", parent=small, alignment=TA_RIGHT)
    bold_small = ParagraphStyle("bold_small", parent=numeric_small, fontName=_FONT_BOLD_NAME)
    def bold(value):
        return p(value, bold_small)
    head = [p(x, small) for x in ("연번", "평가명", "영역 만점", "반영 비율", "원점수", "반영비율 환산 점수")]
    overview = [head] + [[p(i + 1, small), p(item["title"], small),
                         p(_number(item["max_score"]), numeric_small),
                         p(f'{_number(item["weight"])}%' if item["weight"] is not None else "-", numeric_small),
                         bold(_number(item["score"])) if item["score"] is not None else p("미채점", numeric_small),
                         bold(_weighted_score(item)) if item["score"] is not None else p("-", numeric_small)]
                         for i, item in enumerate(snap["items"])]
    converted = converted_performance_score(snap["items"])
    summary_index = len(overview)
    centered_small = ParagraphStyle("centered_small", parent=small, alignment=TA_CENTER)
    overview.append([p("최종 원점수(총점)", centered_small), "", "", "", "",
                     bold(f"{converted}점") if converted is not None else p("산출 대기", numeric_small)])
    table = Table(overview, colWidths=[32, 174, 64, 64, 62, 114], repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), .6, colors.HexColor("#94a8ac")),
                              ("INNERGRID", (0, 0), (-1, -1), .35, colors.HexColor("#d6e1e1")),
                              ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#edf5f2")),
                              ("BACKGROUND", (0, summary_index), (-1, summary_index), colors.HexColor("#f2f7f5")),
                              ("BACKGROUND", (5, summary_index), (5, summary_index), colors.white),
                              ("SPAN", (0, summary_index), (4, summary_index)),
                              ("LINEABOVE", (0, summary_index), (-1, summary_index), .7, colors.HexColor("#94a8ac")),
                              ("VALIGN", (0, 0), (-1, -1), "TOP"),
                              ("TOPPADDING", (0, 0), (-1, -1), 7),
                              ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    story += [table, Spacer(1, 16), p("위 수행평가 점수를 확인했습니다."), Spacer(1, 25)]
    if signature:
        picture = ImageReader(io.BytesIO(signature))
        w, h = picture.getSize()
        signature_cell = Image(io.BytesIO(signature), width=180, height=180 * h / w)
    else:
        signature_cell = p("서명 전 미리보기", small)
    signature_row = Table([[p("학생 확인(서명)", heading), p(snap["student_name"], heading), signature_cell]],
                          colWidths=[165, 115, 230], hAlign="LEFT")
    signature_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                                       ("LEFTPADDING", (0, 0), (-1, -1), 6),
                                       ("TOPPADDING", (0, 0), (-1, -1), 4),
                                       ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(signature_row)
    if signature:
        story.append(p(f'서명일시: {fmt(signed_at)}', small))
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
        if not snap["student_name"].strip():
            raise HTTPException(409, "가입할 때 입력한 실명이 없어 서명할 수 없어요. 내 정보를 확인해 주세요.")
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
