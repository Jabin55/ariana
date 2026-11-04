"""[특기사항] 탭: 모든 수행평가 채점이 끝난 뒤 학생 개별 성취 평가지(총괄평가)와
성취도 확정, 과목별 세부능력 및 특기사항(세특) 작성.
수업별 피드백(형성평가)과 달리 수행평가 결과를 주 근거로, 수업 관찰 분석은 보조 근거로 쓴다."""

from __future__ import annotations

import asyncio
import io
import json
import time
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, update

from app import db
from app.achievement import (_course, ai_json, ai_ready, analysis_view, scale_of, standards_of)
from app.auth import student_no
from app.score_confirmations import _snapshot, converted_performance_score, score_totals

router = APIRouter()

# 성취율(수행평가 환산 점수) → 성취도 제안 (확정은 교사가 한다)
CUTS = {"5": [(90, "A"), (80, "B"), (70, "C"), (60, "D"), (0, "E")], "3": [(80, "A"), (60, "B"), (0, "C")], "P": [(40, "P"), (0, "F")]}
SETUK_MAX_BYTES = 1500  # 나이스 과목별 세부능력 및 특기사항 (한글 500자)


def neis_bytes(text: str) -> int:
    """나이스 바이트 계산: 한글 등 3바이트, 영문·숫자·기호 1바이트, 줄바꿈 2바이트"""
    return sum(2 if ch == "\n" else 1 if ord(ch) < 128 else 3 for ch in text or "")


def suggest(scale_key: str, rate: int | None) -> str:
    if rate is None:
        return ""
    return next(g for cut, g in CUTS.get(scale_key, CUTS["5"]) if rate >= cut)


def _rows(course_id: int) -> dict:
    f = db.course_results.c
    with db.engine.connect() as c:
        return {r.user_id: r for r in c.execute(select(db.course_results).where(f.course_id == course_id)).all()}


def results_view(course_id: int) -> dict:
    from app.courses import course_roster
    with db.engine.connect() as c:
        course = c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()
    saved = _rows(course_id)
    students, graded, total, scale_key = [], 0, 0, None
    for u in course_roster(course_id):
        snap = _snapshot(course_id, u.id)
        scale_key = scale_key or snap["achievement"]
        items = snap["items"]
        total += len(items)
        graded += sum(i["score"] is not None for i in items)
        rate = converted_performance_score(items)
        r = saved.get(u.id)
        students.append({"user_id": u.id, "name": u.name or u.google_name or "", "school": u.school or "",
                         "student_no": student_no(dict(u._mapping)), "scores": [i["score"] for i in items],
                         "rate": rate, "suggested": suggest(snap["achievement"], rate),
                         "achievement": r.achievement if r else "", "setuk": r.setuk if r else "", "growth": r.growth if r else "",
                         "bytes": neis_bytes(r.setuk if r else ""), "updated_at": r.updated_at if r else None})
    students.sort(key=lambda s: (s["school"], s["student_no"], s["name"]))
    a = db.assignments.c
    with db.engine.connect() as c:
        assigns = c.execute(select(a.id, a.title, a.max_score, a.weight).where(a.course_id == course_id).order_by(a.created_at, a.id)).all()
    weight_sum = sum(x.weight or 0 for x in assigns)
    ready = bool(assigns) and bool(students) and graded == total
    scale_key = scale_key or (course.achievement or "5")
    return {"ready": ready, "graded": graded, "total": total, "weight_ok": abs(weight_sum - 100) < 1e-6,
            "assignments": [{"id": x.id, "title": x.title, "max_score": x.max_score, "weight": x.weight} for x in assigns],
            "scale": SCALE_LABELS.get(scale_key, scale_key), "grades": [g for _, g in CUTS.get(scale_key, CUTS["5"])],
            "students": students, "ai": ai_ready(), "max_bytes": SETUK_MAX_BYTES}


SCALE_LABELS = {"5": "5단계 (A~E)", "3": "3단계 (A~C)", "P": "P/F"}


def _standard_results(course_id: int, user_id: int, items: list[dict], analysis: dict) -> list[dict]:
    """성취기준별 최종 도달: 수행평가(연결된 영역의 득점률) 주 근거 + 수업 관찰 누적 도달 보조"""
    standards, _ = standards_of(course_id)
    s_ = db.assignment_standards.c
    with db.engine.connect() as c:
        links = c.execute(select(s_.assignment_id, s_.standard_id).where(s_.assignment_id.in_([i["id"] for i in items] or [-1]))).all()
    by_item = {i["id"]: i for i in items}
    observed = {p["standard_id"]: p for p in analysis.get("standards_progress", [])}
    # 학생 발언: 수업별 판단 근거 가운데 학생 말((응답)·(자발)·(발언))을 인용한 것, 최근 2개
    said: dict[int, list[str]] = {}
    for x in analysis.get("classes", []):
        for r in x.get("standards", []):
            ev = (r.get("evidence") or "").strip()
            if ev and any(t in ev for t in ("(응답)", "(자발)", "(발언)")):
                said.setdefault(r["standard_id"], []).append(ev)
    out = []
    for s in standards:
        got = [by_item[a] for a, sid in links if sid == s["id"] and a in by_item and by_item[a]["score"] is not None and by_item[a]["max_score"]]
        rate = round(100 * sum(i["score"] for i in got) / sum(i["max_score"] for i in got)) if got else None
        level = None if rate is None else 3 if rate >= 80 else 2 if rate >= 60 else 1
        obs = observed.get(s["id"])
        out.append({"standard_id": s["id"], "code": s["code"], "text": s["text"], "assessments": [i["title"] for i in got],
                    "rate": rate, "level": level, "observed": obs["current"] if obs else None, "observed_status": obs["status"] if obs else "",
                    "speech": said.get(s["id"], [])[-2:]})
    return out


def sheet_view(course_id: int, user_id: int) -> dict:
    """학생 개별 성취 평가지 자료"""
    snap = _snapshot(course_id, user_id)
    items = snap["items"]
    analysis = analysis_view(course_id, user_id)
    r = _rows(course_id).get(user_id)
    rate = converted_performance_score(items)
    weighted = []
    for i in items:
        try:
            weighted.append(round(i["score"] / i["max_score"] * i["weight"], 2) if i["score"] is not None and i["max_score"] and i["weight"] is not None else None)
        except (TypeError, ZeroDivisionError):
            weighted.append(None)
    return {"course": {k: snap[k] for k in ("course_title", "school_year", "term", "hub_school", "instructor")},
            "student": {"name": snap["student_name"], "school": snap["student_school"], "student_no": snap["student_no"]},
            "scale": SCALE_LABELS.get(snap["achievement"], snap["achievement"]),
            "items": [{"title": i["title"], "max_score": i["max_score"], "weight": i["weight"], "score": i["score"], "weighted": w,
                       "feedback": i["feedback"]} for i, w in zip(items, weighted)],
            "totals": score_totals(items), "rate": rate, "suggested": suggest(snap["achievement"], rate),
            "achievement": r.achievement if r else "", "setuk": r.setuk if r else "", "growth": r.growth if r else "",
            "standards": _standard_results(course_id, user_id, items, analysis),
            "competencies": analysis.get("competencies", []), "subject_competencies": analysis.get("subject_competencies", []),
            "participation": [{"date": x["date"], "spontaneous": x["counts"]["spontaneous"], "response": x["counts"]["response"]}
                              for x in analysis.get("tracking", []) if x["counts"]["talk"]]}


async def _ready_course(course_id: int, request: Request):
    course, t = await _course(course_id, request)
    view = await db.run(results_view, course_id)
    return course, view


@router.get("/api/courses/{course_id}/results")
async def get_results(course_id: int, request: Request):
    _, view = await _ready_course(course_id, request)
    return view


def _roster_ids(course_id: int) -> set[int]:
    from app.courses import course_roster
    return {u.id for u in course_roster(course_id)}


@router.get("/api/courses/{course_id}/results/{user_id}/sheet")
async def get_sheet(course_id: int, user_id: int, request: Request):
    await _course(course_id, request)
    if user_id not in await db.run(_roster_ids, course_id):
        raise HTTPException(404, "이 과목 수강생이 아니에요.")
    return await db.run(sheet_view, course_id, user_id)


@router.post("/api/courses/{course_id}/results/draft-all")
async def draft_all(course_id: int, request: Request):
    """세특이 비어 있는 학생 모두 AI 초안 (동시에 4명씩, 이미 쓴 학생은 건너뜀)"""
    course, view = await _ready_course(course_id, request)
    if not view["ready"]:
        raise HTTPException(409, "모든 수행평가 채점이 끝나야 세특 초안을 만들 수 있어요.")
    if not ai_ready():
        raise HTTPException(503, "AI가 설정되지 않아 초안을 만들 수 없어요.")
    gate = asyncio.Semaphore(4)

    async def one(uid):
        async with gate:
            return await _draft_one(course, uid, keep_existing=True)
    results = await asyncio.gather(*(one(s["user_id"]) for s in view["students"]))
    errors = sorted({r for r in results if r not in ("ok", "skip")})
    made = sum(r == "ok" for r in results)
    if errors and not made:
        raise HTTPException(502, errors[0])
    return {"made": made, "skipped": sum(r == "skip" for r in results), "errors": errors}


class ResultReq(BaseModel):
    achievement: str = Field(default="", max_length=4)
    setuk: str = Field(default="", max_length=3000)
    growth: str = Field(default="", max_length=3000)


def _save(course_id: int, user_id: int, values: dict) -> None:
    f = db.course_results.c
    with db.engine.begin() as c:
        cur = c.execute(select(f.id).where(f.course_id == course_id, f.user_id == user_id)).first()
        if cur:
            c.execute(update(db.course_results).where(f.id == cur.id).values(**values))
        else:
            c.execute(insert(db.course_results).values(course_id=course_id, user_id=user_id,
                                                       **{"achievement": "", "setuk": "", "growth": "", **values}))


@router.post("/api/courses/{course_id}/results/{user_id}")
async def save_result(course_id: int, user_id: int, req: ResultReq, request: Request):
    """성취도 확정·세특·성장 요약 저장 (모든 수행평가 채점이 끝난 뒤에만)"""
    course, view = await _ready_course(course_id, request)
    if not view["ready"]:
        raise HTTPException(409, "모든 수행평가 채점이 끝나야 성취도와 세특을 작성할 수 있어요.")
    if user_id not in {s["user_id"] for s in view["students"]}:
        raise HTTPException(404, "이 과목 수강생이 아니에요.")
    if req.achievement and req.achievement not in view["grades"]:
        raise HTTPException(422, f"성취도는 {', '.join(view['grades'])} 가운데에서 골라 주세요.")
    if neis_bytes(req.setuk.strip()) > SETUK_MAX_BYTES:
        raise HTTPException(422, f"세특은 나이스 기준 {SETUK_MAX_BYTES}바이트(한글 약 500자)까지 쓸 수 있어요.")
    await db.run(_save, course_id, user_id, {"achievement": req.achievement, "setuk": req.setuk.strip(),
                                             "growth": req.growth.strip(), "updated_at": time.time()})
    return {"ok": True, "bytes": neis_bytes(req.setuk.strip())}


SETUK_SYSTEM = (
    "당신은 한국 고등학교 교사가 학교생활기록부 '과목별 세부능력 및 특기사항(세특)'과 학생 개별 성취 평가지를 쓰도록 돕는 보조자입니다. "
    "한 학생의 수행평가 결과(영역·점수·교사 피드백), 성취기준별 도달, 수업 중 발언·관찰 분석 요약, 역량 판단을 바탕으로 초안을 씁니다.\n"
    "규칙:\n"
    "- setuk: 교사가 관찰한 사실에 근거해 학생의 학업 역량·탐구 과정·성장을 구체적으로 서술합니다. "
    "어떤 활동(수행평가·토론·발표 등)에서 무엇을 했고 그 과정에서 어떤 역량이 드러났는지를 성취기준과 연결해 씁니다. "
    "문장은 '~함', '~임', '~보임'처럼 명사형으로 끝내고, 학생 이름·학교명·학번을 쓰지 않습니다. "
    "교외 수상, 사교육, 부모의 사회·경제적 지위, 특정 대학·기관·상호명, 논문·도서 출간 등 학교생활기록부 기재 금지 사항을 쓰지 않습니다. "
    "근거 없는 칭찬이나 과장, 다른 학생과의 비교를 하지 않습니다. 한글 기준 400~480자(나이스 1500바이트 이내)로 씁니다.\n"
    "- growth: 학생 개별 성취 평가지에 실을 성장 과정 요약입니다. 학기 초와 비교해 무엇이 달라졌는지, 강점과 앞으로의 과제를 학생에게 직접 말하듯 존댓말 3~5문장으로 씁니다.\n"
    "- 제공된 기록에 없는 사실을 지어내지 않습니다. 기록이 적으면 있는 근거 안에서만 씁니다."
)
SETUK_SCHEMA = {"type": "object", "properties": {"setuk": {"type": "string"}, "growth": {"type": "string"}},
                "required": ["setuk", "growth"], "additionalProperties": False}


def _n(v) -> str:
    return "-" if v is None else f"{v:g}" if isinstance(v, (int, float)) else str(v)


async def _draft_one(course, user_id: int, keep_existing: bool) -> str:
    from app.privacy_filter import redact
    sheet = await db.run(sheet_view, course.id, user_id)
    if keep_existing and sheet["setuk"]:
        return "skip"
    names = [n for n in (sheet["student"]["name"],) if n]
    with db.engine.connect() as c:
        fb = c.execute(select(db.speech_feedback.c.summary).where(db.speech_feedback.c.course_id == course.id,
                                                                  db.speech_feedback.c.user_id == user_id)).scalar() or ""
    lines = [f"과목: {course.subject or course.title}",
             "\n# 수행평가 결과"] + [
        f"- {i['title']}: {_n(i['score'])}/{_n(i['max_score'])}점 (반영 {_n(i['weight'])}%)" + (f" / 교사 피드백: {redact(i['feedback'], names)}" if i["feedback"] else "")
        for i in sheet["items"]] + [
        f"\n# 수행평가 환산 성취율: {sheet['rate']}점" if sheet["rate"] is not None else "",
        "\n# 성취기준별 도달 (수행평가 주 근거 / 수업 관찰 보조)"] + [
        f"- {s['code']} {s['text']}: 수행평가 {'상중하'[3 - s['level']] if s['level'] else '근거 없음'}"
        + (f" ({s['rate']}%)" if s["rate"] is not None else "") + (f" / 수업 관찰 {'상중하'[3 - s['observed']]}" if s["observed"] else "")
        for s in sheet["standards"]]
    if fb:
        lines.append(f"\n# 수업 중 발언·관찰 분석 요약 (교사용)\n{redact(fb, names)}")
    comps = sheet["competencies"] + sheet["subject_competencies"]
    if comps:
        lines.append("\n# 역량 판단 (1~5점)\n" + "\n".join(f"- {c['label']} {c['score']}점: {redact(c.get('reason', ''), names)}" for c in comps))
    try:
        data = await ai_json(SETUK_SYSTEM, "\n".join(x for x in lines if x is not None), SETUK_SCHEMA, 4000)
    except HTTPException as err:
        return str(err.detail)
    setuk = str(data.get("setuk", "")).strip()
    while neis_bytes(setuk) > SETUK_MAX_BYTES:  # 길면 마지막 문장부터 줄인다
        cut = setuk.rstrip("。. ").rfind(".")
        setuk = setuk[:cut + 1] if cut > 0 else setuk[:480]
    values = {"setuk": setuk, "growth": str(data.get("growth", "")).strip()[:3000], "updated_at": time.time()}
    await db.run(_save, course.id, user_id, values)
    return "ok"


@router.post("/api/courses/{course_id}/results/{user_id}/draft")
async def draft_result(course_id: int, user_id: int, request: Request):
    """학생 한 명의 세특·성장 요약 AI 초안 (지금 쓴 글을 바꾼다)"""
    course, view = await _ready_course(course_id, request)
    if not view["ready"]:
        raise HTTPException(409, "모든 수행평가 채점이 끝나야 세특 초안을 만들 수 있어요.")
    if not ai_ready():
        raise HTTPException(503, "AI가 설정되지 않아 초안을 만들 수 없어요.")
    if user_id not in {s["user_id"] for s in view["students"]}:
        raise HTTPException(404, "이 과목 수강생이 아니에요.")
    result = await _draft_one(course, user_id, keep_existing=False)
    if result != "ok":
        raise HTTPException(502, result)
    return await db.run(sheet_view, course_id, user_id)


@router.get("/api/courses/{course_id}/results.xlsx")
async def results_export(course_id: int, request: Request):
    """나이스 입력용: 학번·이름·환산 점수·성취도·세특 (바이트)"""
    course, view = await _ready_course(course_id, request)
    book = Workbook()
    sheet = book.active
    sheet.title = "성취도·세특"
    sheet.append(["과목", course.title])
    sheet.append([])
    head = ["연번", "소속학교", "학번", "이름"] + [a["title"] for a in view["assignments"]] + ["환산 점수", "성취도(제안)", "성취도(확정)", "세부능력 및 특기사항", "바이트"]
    sheet.append(head)
    for n, s in enumerate(view["students"], 1):
        sheet.append([n, s["school"], s["student_no"], s["name"], *s["scores"], s["rate"], s["suggested"], s["achievement"], s["setuk"], s["bytes"]])
    fill = PatternFill("solid", fgColor="E8F1EC")
    for cell in sheet[3]:
        cell.font, cell.fill = Font(bold=True), fill
    setuk_col = len(head) - 1
    for row in sheet.iter_rows(min_row=4, min_col=setuk_col, max_col=setuk_col):
        row[0].alignment = Alignment(wrap_text=True, vertical="top")
    sheet.column_dimensions[sheet.cell(3, setuk_col).column_letter].width = 80
    out = io.BytesIO()
    book.save(out)
    name = quote(f"{course.title} 성취도·세특.xlsx")
    return Response(out.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{name}", "Cache-Control": "private, no-store"})
