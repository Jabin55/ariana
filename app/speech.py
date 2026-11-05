"""수업 중 발언 기록(자막 스크립트) 보기: 수업별 스크립트, 학생별 발언 모음, 엑셀 내려받기.
기록은 선생님이 수업 화면에서 [발언 기록]을 켠 동안만 쌓이고, 과목이 끝나고 365일 뒤 지운다(file_retention)."""

from __future__ import annotations

import io
import re
from datetime import datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from sqlalchemy import func, select

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


# 교사 발문 응답 / 자발 발언 구분: 학생 발언 직전 RESPONSE_WINDOW 초 안에 선생님의 질문이 있으면 '응답'
RESPONSE_WINDOW = 20.0
_QUESTION = re.compile(r"\?|까요|나요|가요|습니까|니까\b|을까|ㄹ까|는지|인지|볼래|해\s?볼|해\s?보세요|말해|대답|발표|누가|누구|왜|어떻게|무엇|뭐|어떤|어느|몇\s|이유는|생각은|니\s*$|냐\s*$")


def is_question(text: str) -> bool:
    return bool(_QUESTION.search(text or ""))


def tag_turns(rows: list[dict], teacher_rows: list[dict]) -> None:
    """학생 발언마다 kind('응답'|'자발')와 prompt(그 직전 선생님 발문)를 붙인다. rows·teacher_rows 는 ts(초)·class_id 를 가진다"""
    by_class: dict[int, list[dict]] = {}
    for t in teacher_rows:
        if is_question(t["text"]):
            by_class.setdefault(t["class_id"], []).append(t)
    for r in rows:
        if r["role"] != "student":
            continue
        ask = None
        for t in by_class.get(r["class_id"], []):
            if r["ts"] - RESPONSE_WINDOW <= t["ts"] <= r["ts"] + 2:  # 인식 지연으로 몇 초 늦게 저장될 수 있다
                ask = t
            elif t["ts"] > r["ts"] + 2:
                break
        r["kind"] = "응답" if ask else "자발"
        r["prompt"] = ask["text"] if ask else ""


def _entries(course_id: int | None, class_id: int | None = None, user_id: int | None = None) -> list[dict]:
    sl, u, cl = db.speech_logs.c, db.users.c, db.classes.c
    with db.engine.connect() as c:
        adm = admin_user_ids(c)
        q = (select(db.speech_logs, db.users, cl.title.label("class_title"), cl.created_at.label("class_created"), cl.ended_at.label("class_ended"))
             .join(db.users, u.id == sl.user_id).join(db.classes, cl.id == sl.class_id))
        if course_id is not None:
            q = q.where(cl.course_id == course_id)
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
            "class_start": datetime.fromtimestamp(m["class_created"], KST).strftime("%H:%M"),
            "class_end": datetime.fromtimestamp(m["class_ended"], KST).strftime("%H:%M") if m["class_ended"] else "",
            "user_id": m["user_id"], "role": m["role"], "name": m["name"] or m["google_name"] or "",
            "school": m["school"] or "", "student_no": student_no(dict(m)) if m["role"] == "student" else "",
            "text": m["text"], "ts": m["created_at"]})
    # 학생 한 명만 고른 경우에도 같은 수업의 선생님 발문으로 응답·자발을 가린다
    teacher_rows = [r for r in out if r["role"] == "teacher"]
    if user_id is not None and out:
        with db.engine.connect() as c:
            teacher_rows = [{"class_id": t.class_id, "text": t.text, "ts": t.created_at} for t in c.execute(
                select(sl.class_id, sl.text, sl.created_at).where(sl.class_id.in_({r["class_id"] for r in out}), sl.role == "teacher")
                .order_by(sl.created_at)).all()]
    tag_turns(out, teacher_rows)
    return out


def _observation_counts(course_id: int) -> dict[int, int]:
    o = db.observations.c
    with db.engine.connect() as c:
        return dict(c.execute(select(o.user_id, func.count(o.id)).where(o.course_id == course_id)
                              .group_by(o.user_id)).all())


@router.get("/api/courses/{course_id}/speech")
async def speech_summary(course_id: int, request: Request):
    """수업별 발언과 수강생별 발언·교사 관찰 건수"""
    await _course(course_id, request)
    rows = await db.run(_entries, course_id)
    from app.courses import course_roster
    roster = await db.run(course_roster, course_id)
    observation_counts = await db.run(_observation_counts, course_id)
    classes: dict = {}
    students: dict = {}
    for row in roster:
        u = dict(row._mapping)
        students[u["id"]] = {"user_id": u["id"], "name": u["name"] or u["google_name"] or "",
                              "school": u["school"] or "", "student_no": student_no(u),
                              "count": 0, "chars": 0, "classes": set(), "spontaneous": 0}
    for e in rows:
        x = classes.setdefault(e["class_id"], {"id": e["class_id"], "title": e["class_title"], "date": e["date"],
                                                "start": e["class_start"], "end": e["class_end"],
                                                "count": 0, "speakers": set()})
        x["count"] += 1
        x["chars_" + ("student" if e["role"] == "student" else "teacher")] = x.get("chars_" + ("student" if e["role"] == "student" else "teacher"), 0) + len(e["text"])
        if e["role"] == "student":
            x["speakers"].add(e["user_id"])
            st = students.setdefault(e["user_id"], {"user_id": e["user_id"], "name": e["name"], "school": e["school"],
                                                    "student_no": e["student_no"], "count": 0, "chars": 0, "classes": set(), "spontaneous": 0})
            st["count"] += 1
            st["spontaneous"] += e.get("kind") == "자발"
            st["chars"] += len(e["text"])
            st["classes"].add(e["class_id"])
    cls = sorted(classes.values(), key=lambda x: (x["date"], x["id"]))
    for x in cls:
        x["speakers"] = len(x["speakers"])
        # 학생/교사 발언 비율: 그 수업에서 말한 글자 수 기준 학생 몫(%)
        sc, tc = x.pop("chars_student", 0), x.pop("chars_teacher", 0)
        x["student_share"] = round(100 * sc / (sc + tc)) if sc + tc else None
    sts = sorted(students.values(), key=lambda x: (x["school"], x["student_no"], x["name"]))
    status = await db.run(_feedback_status, course_id)
    for x in sts:
        x["classes"] = len(x["classes"])
        x["observations"] = observation_counts.get(x["user_id"], 0)
        x["spontaneous_rate"] = round(100 * x["spontaneous"] / x["count"]) if x["count"] else None
        x.update(status.get(x["user_id"], {"published": 0, "goal_rate": None, "goal_trend": None}))
    return {"classes": cls, "students": sts, "total": len(rows)}


def _feedback_status(course_id: int) -> dict[int, dict]:
    """학생마다: 공개한 회차별 피드백 수, 가장 최근 목표 달성률과 그 앞과 비교한 추세"""
    import json as _json
    f, cl = db.class_feedback.c, db.classes.c
    with db.engine.connect() as c:
        rows = c.execute(select(f.user_id, f.published, f.goal_checks).join(db.classes, cl.id == f.class_id)
                         .where(f.course_id == course_id).order_by(cl.created_at)).all()
    out: dict[int, dict] = {}
    for r in rows:
        x = out.setdefault(r.user_id, {"published": 0, "rates": []})
        x["published"] += r.published
        try:
            checks = _json.loads(r.goal_checks) if r.goal_checks else []
        except ValueError:
            checks = []
        if checks:
            x["rates"].append(round(100 * sum({"done": 1, "partial": 0.5}.get(g.get("status"), 0) for g in checks) / len(checks)))
    for x in out.values():
        rates = x.pop("rates")
        x["goal_rate"] = rates[-1] if rates else None
        x["goal_trend"] = None if len(rates) < 2 else "up" if rates[-1] > rates[-2] else "down" if rates[-1] < rates[-2] else "flat"
    return out


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


def speech_workbook(course, rows: list[dict], label: str = "강좌") -> bytes:
    book = Workbook()
    head_fill = PatternFill("solid", fgColor="E8F1EC")
    sheet = book.active
    sheet.title = "발언 기록"
    sheet.append([label, xlsx_text(course.title)])
    sheet.append([])
    sheet.append(["연번", "수업일", "수업 주제", "시각", "구분", "소속학교", "학번", "이름", "발언"])
    for i, e in enumerate(rows, 1):
        sheet.append([i, e["date"], xlsx_text(e["class_title"]), e["time"], f"학생({e.get('kind', '자발')})" if e["role"] == "student" else "교사",
                      xlsx_text(e["school"]), e["student_no"], xlsx_text(e["name"]), xlsx_text(e["text"])])
    for cell in sheet[3]:
        cell.font, cell.fill = Font(bold=True), head_fill
    for col, width in zip("ABCDEFGHI", (6, 12, 24, 10, 11, 16, 8, 10, 80)):
        sheet.column_dimensions[col].width = width
    for row in sheet.iter_rows(min_row=4, min_col=9, max_col=9):
        row[0].alignment = Alignment(wrap_text=True, vertical="top")
    sheet.freeze_panes = "A4"
    summary = book.create_sheet("학생별 요약")
    summary.append(["소속학교", "학번", "이름", "발언 수", "자발 발언", "발문 응답", "글자 수", "발언한 수업 수"])
    stats: dict = {}
    for e in rows:
        if e["role"] != "student":
            continue
        x = stats.setdefault(e["user_id"], [e["school"], e["student_no"], e["name"], 0, 0, 0, 0, set()])
        x[3] += 1
        x[4 if e.get("kind", "자발") == "자발" else 5] += 1
        x[6] += len(e["text"])
        x[7].add(e["class_id"])
    for x in sorted(stats.values(), key=lambda x: (x[0], x[1], x[2])):
        summary.append([xlsx_text(x[0]), x[1], xlsx_text(x[2]), x[3], x[4], x[5], x[6], len(x[7])])
    for cell in summary[1]:
        cell.font, cell.fill = Font(bold=True), head_fill
    for col, width in zip("ABCDEFGH", (18, 8, 12, 10, 10, 10, 10, 14)):
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


# ── 수업 하나(특강·회의 포함)의 발언 기록: 교무실 > 특강/회의 > 지난 기록에서 본다
async def _class(class_id: int, request: Request):
    from app.history import _owned_class
    t = await require_user(request, "teacher")
    return await db.run(_owned_class, class_id, t)


@router.get("/api/live/history/{class_id}/speech")
async def class_speech(class_id: int, request: Request):
    await _class(class_id, request)
    return {"entries": await db.run(_entries, None, class_id)}


@router.get("/api/live/history/{class_id}/speech.xlsx")
async def class_speech_export(class_id: int, request: Request):
    r = await _class(class_id, request)
    rows = await db.run(_entries, None, class_id)
    name = quote(f"{r.title or '수업'} 발언 기록.xlsx")
    return Response(speech_workbook(r, rows, "수업"), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={**PRIVATE, "Content-Disposition": f"attachment; filename=\"speech-class-{class_id}.xlsx\"; filename*=UTF-8''{name}"})
