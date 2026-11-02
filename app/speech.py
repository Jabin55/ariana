"""수업 중 발언 기록(자막 스크립트) 보기: 수업별 스크립트, 학생별 발언 모음, 엑셀 내려받기.
기록은 선생님이 수업 화면에서 [발언 기록]을 켠 동안만 쌓이고, 과목이 끝나고 365일 뒤 지운다(file_retention)."""

from __future__ import annotations

import io
from datetime import datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from sqlalchemy import select

from app import db
from app.auth import admin_user_ids, require_user, student_no
from app.satisfaction import xlsx_text

router = APIRouter()
KST = ZoneInfo("Asia/Seoul")
PRIVATE = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}


async def _course(course_id: int, request: Request):
    from app.courses import hub_locked, owned_course
    t = await require_user(request, "teacher")
    course = await db.run(owned_course, course_id, t)
    if hub_locked(course, t):
        raise HTTPException(403, "그 거점학교 강사 활동 기간이 끝나 이 과목의 기록을 볼 수 없어요.")
    return course


def _entries(course_id: int, class_id: int | None = None, user_id: int | None = None) -> list[dict]:
    sl, u, cl = db.speech_logs.c, db.users.c, db.classes.c
    with db.engine.connect() as c:
        adm = admin_user_ids(c)
        q = (select(db.speech_logs, db.users, cl.title.label("class_title"), cl.created_at.label("class_created"))
             .join(db.users, u.id == sl.user_id).join(db.classes, cl.id == sl.class_id)
             .where(cl.course_id == course_id))
        if class_id is not None:
            q = q.where(sl.class_id == class_id)
        if user_id is not None:
            q = q.where(sl.user_id == user_id)
        rows = c.execute(q.order_by(sl.created_at)).all()
    out = []
    for r in rows:
        m = r._mapping
        if m["user_id"] in adm and m["role"] == "student":
            continue
        out.append({
            "class_id": m["class_id"], "class_title": m["class_title"] or "",
            "date": datetime.fromtimestamp(m["class_created"], KST).strftime("%Y-%m-%d"),
            "time": datetime.fromtimestamp(m["created_at"], KST).strftime("%H:%M:%S"),
            "user_id": m["user_id"], "role": m["role"], "name": m["name"] or m["google_name"] or "",
            "school": m["school"] or "", "student_no": student_no(dict(m)) if m["role"] == "student" else "",
            "text": m["text"]})
    return out


@router.get("/api/courses/{course_id}/speech")
async def speech_summary(course_id: int, request: Request):
    """수업별·학생별 발언 수"""
    await _course(course_id, request)
    rows = await db.run(_entries, course_id)
    classes: dict = {}
    students: dict = {}
    for e in rows:
        x = classes.setdefault(e["class_id"], {"id": e["class_id"], "title": e["class_title"], "date": e["date"],
                                                "count": 0, "speakers": set()})
        x["count"] += 1
        if e["role"] == "student":
            x["speakers"].add(e["user_id"])
            st = students.setdefault(e["user_id"], {"user_id": e["user_id"], "name": e["name"], "school": e["school"],
                                                    "student_no": e["student_no"], "count": 0, "chars": 0, "classes": set()})
            st["count"] += 1
            st["chars"] += len(e["text"])
            st["classes"].add(e["class_id"])
    cls = sorted(classes.values(), key=lambda x: (x["date"], x["id"]))
    for x in cls:
        x["speakers"] = len(x["speakers"])
    sts = sorted(students.values(), key=lambda x: (x["school"], x["student_no"], x["name"]))
    for x in sts:
        x["classes"] = len(x["classes"])
    return {"classes": cls, "students": sts, "total": len(rows)}


@router.get("/api/courses/{course_id}/speech/class/{class_id}")
async def speech_of_class(course_id: int, class_id: int, request: Request):
    """수업 하나의 전체 스크립트 (선생님·학생 발언을 시간 순서대로)"""
    await _course(course_id, request)
    return {"entries": await db.run(_entries, course_id, class_id)}


@router.get("/api/courses/{course_id}/speech/student/{user_id}")
async def speech_of_student(course_id: int, user_id: int, request: Request):
    """학생 한 명의 이 과목 발언 모음 (날짜 순서대로)"""
    await _course(course_id, request)
    return {"entries": [e for e in await db.run(_entries, course_id, None, user_id) if e["role"] == "student"]}


def speech_workbook(course, rows: list[dict]) -> bytes:
    book = Workbook()
    head_fill = PatternFill("solid", fgColor="E8F1EC")
    sheet = book.active
    sheet.title = "발언 기록"
    sheet.append(["강좌", xlsx_text(course.title)])
    sheet.append([])
    sheet.append(["연번", "수업일", "수업 주제", "시각", "구분", "소속학교", "학번", "이름", "발언"])
    for i, e in enumerate(rows, 1):
        sheet.append([i, e["date"], xlsx_text(e["class_title"]), e["time"], "학생" if e["role"] == "student" else "교사",
                      xlsx_text(e["school"]), e["student_no"], xlsx_text(e["name"]), xlsx_text(e["text"])])
    for cell in sheet[3]:
        cell.font, cell.fill = Font(bold=True), head_fill
    for col, width in zip("ABCDEFGHI", (6, 12, 24, 10, 6, 16, 8, 10, 80)):
        sheet.column_dimensions[col].width = width
    for row in sheet.iter_rows(min_row=4, min_col=9, max_col=9):
        row[0].alignment = Alignment(wrap_text=True, vertical="top")
    sheet.freeze_panes = "A4"
    summary = book.create_sheet("학생별 요약")
    summary.append(["소속학교", "학번", "이름", "발언 수", "글자 수", "발언한 수업 수"])
    stats: dict = {}
    for e in rows:
        if e["role"] != "student":
            continue
        x = stats.setdefault(e["user_id"], [e["school"], e["student_no"], e["name"], 0, 0, set()])
        x[3] += 1
        x[4] += len(e["text"])
        x[5].add(e["class_id"])
    for x in sorted(stats.values(), key=lambda x: (x[0], x[1], x[2])):
        summary.append([xlsx_text(x[0]), x[1], xlsx_text(x[2]), x[3], x[4], len(x[5])])
    for cell in summary[1]:
        cell.font, cell.fill = Font(bold=True), head_fill
    for col, width in zip("ABCDEF", (18, 8, 12, 10, 10, 14)):
        summary.column_dimensions[col].width = width
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


@router.get("/api/courses/{course_id}/speech.xlsx")
async def speech_export(course_id: int, request: Request):
    course = await _course(course_id, request)
    rows = await db.run(_entries, course_id)
    name = quote(f"{course.title} 발언 기록.xlsx")
    return Response(speech_workbook(course, rows), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={**PRIVATE, "Content-Disposition": f"attachment; filename=\"speech-{course_id}.xlsx\"; filename*=UTF-8''{name}"})
