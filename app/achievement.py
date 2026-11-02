"""성취기준 기반 발언 분석.

1) 강좌에 성취기준과 성취기준별 평가기준(상·중·하)을 넣어 두고, 거기서 평가 요소를 뽑는다(AI 초안 → 교사 수정).
   과목 전체의 성취수준(성취도 A~E / A~C / P 별 일반적 특성)도 함께 넣어 둔다.
2) 강좌 회차마다 다루는 성취기준을 고른다. 수업(실시간)은 같은 날짜의 회차와 연결된다.
3) 교사가 [AI 분석]을 누르면 그 학생의 발언(이름·학번은 가림)을 평가 요소에 비추어
   수업마다 상(3)·중(2)·하(1)로 판단하고, 근거 발언·종합 의견(교사용)·피드백 초안(학생용)을 만든다.
4) 피드백은 교사가 [학생에게 공개]해야 학생에게 보인다. 기록은 과목이 끝나고 365일 뒤 지운다(file_retention).
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, insert, select, update

from app import db
from app.auth import require_user

router = APIRouter()
log = logging.getLogger(__name__)
KST = ZoneInfo("Asia/Seoul")
# 분석은 판단의 질이 중요해서 AI 조교보다 한 단계 좋은 모델을 쓴다. 바꾸려면 ANALYSIS_MODEL 설정
ANALYSIS_MODEL = os.environ.get("ANALYSIS_MODEL", "claude-sonnet-5-5")
LEVELS = {3: "상", 2: "중", 1: "하"}
_client = None


def ai_ready() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


async def ai_json(system: str, prompt: str, schema: dict, max_tokens: int = 8000) -> dict:
    """Claude 에 묻고 정해진 JSON 형식으로 받는다 (테스트에서는 이 함수를 바꿔 끼운다)."""
    global _client
    import anthropic
    if _client is None:
        _client = anthropic.AsyncAnthropic()
    try:
        async with _client.messages.stream(
            model=ANALYSIS_MODEL,
            max_tokens=max_tokens,
            system=system,
            thinking={"type": "adaptive"},
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            final = await stream.get_final_message()
    except anthropic.RateLimitError:
        raise HTTPException(429, "AI 요청이 몰렸어요. 잠시 후 다시 시도해 주세요.") from None
    except anthropic.APIStatusError as e:
        log.error("AI 분석 오류 (status=%s)", e.status_code)
        raise HTTPException(502, "AI 분석 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.") from None
    except anthropic.APIConnectionError:
        raise HTTPException(502, "AI 서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.") from None
    if final.stop_reason == "refusal":
        raise HTTPException(422, "AI가 이 내용을 분석하지 못했어요.")
    if final.stop_reason == "max_tokens":
        raise HTTPException(422, "분석할 내용이 너무 많아 끝까지 만들지 못했어요.")
    text = next((b.text for b in final.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except ValueError:
        raise HTTPException(502, "AI 답을 읽지 못했어요. 다시 시도해 주세요.") from None


async def _course(course_id: int, request: Request):
    from app.courses import owned_course
    t = await require_user(request, "teacher")
    return await db.run(owned_course, course_id, t), t


def _standard_json(r) -> dict:
    try:
        elements = json.loads(r.elements or "[]")
    except ValueError:
        elements = []
    return {"id": r.id, "code": r.code, "text": r.text, "level_high": r.level_high, "level_mid": r.level_mid,
            "level_low": r.level_low, "elements": elements}


def standards_of(course_id: int) -> tuple[list[dict], dict[int, list[int]]]:
    """성취기준 목록과 회차 번호 → 성취기준 id 목록"""
    with db.engine.connect() as c:
        rows = c.execute(select(db.course_standards).where(db.course_standards.c.course_id == course_id)
                         .order_by(db.course_standards.c.sort, db.course_standards.c.id)).all()
        links: dict[int, list[int]] = {}
        for x in c.execute(select(db.session_standards).where(db.session_standards.c.course_id == course_id)):
            links.setdefault(x.session_no, []).append(x.standard_id)
    return [_standard_json(r) for r in rows], links


# ───────── 성취기준·평가 요소 ─────────

class Element(BaseModel):
    name: str = Field(max_length=60)
    high: str = Field(default="", max_length=1000)
    mid: str = Field(default="", max_length=1000)
    low: str = Field(default="", max_length=1000)


class StandardReq(BaseModel):
    id: int | None = None
    code: str = Field(default="", max_length=40)
    text: str = Field(max_length=2000)
    level_high: str = Field(default="", max_length=3000)
    level_mid: str = Field(default="", max_length=3000)
    level_low: str = Field(default="", max_length=3000)
    elements: list[Element] = Field(default_factory=list, max_length=8)


SCALES = {"5": ["A", "B", "C", "D", "E"], "3": ["A", "B", "C"], "P": ["P"]}


def scale_of(course) -> list[str]:
    """과목 성취도에 따른 성취수준 단계 (정하지 않았으면 5단계로 본다)"""
    return SCALES.get(course.achievement or "", SCALES["5"])


def course_levels(course) -> dict:
    try:
        levels = json.loads(course.achievement_levels or "{}")
    except ValueError:
        levels = {}
    return {k: str(levels.get(k, "")) for k in scale_of(course)}


@router.get("/api/courses/{course_id}/standards")
async def list_standards(course_id: int, request: Request):
    course, _ = await _course(course_id, request)
    from app.courses import sessions_by_course
    from app import subjects
    standards, links = await db.run(standards_of, course_id)
    sessions = (await db.run(sessions_by_course, [course_id])).get(course_id, [])
    return {"standards": standards, "ai": ai_ready(), "scale": scale_of(course), "course_levels": course_levels(course),
            "achievement_text": subjects.ACHIEVEMENTS.get(course.achievement or "", "성취도 미정 (5단계로 표시)"),
            "sessions": [{**s, "standard_ids": links.get(s["no"], [])} for s in sessions]}


class CourseLevelsReq(BaseModel):
    levels: dict[str, str] = Field(default_factory=dict)


@router.post("/api/courses/{course_id}/achievement-levels")
async def save_course_levels(course_id: int, req: CourseLevelsReq, request: Request):
    """과목 전체의 성취수준별 일반적 특성 (A~E / A~C / P)"""
    course, _ = await _course(course_id, request)
    keep = {k: str(req.levels.get(k, "")).strip()[:3000] for k in scale_of(course)}

    def run():
        with db.engine.begin() as c:
            c.execute(update(db.courses).where(db.courses.c.id == course_id)
                      .values(achievement_levels=json.dumps(keep, ensure_ascii=False)))

    await db.run(run)
    return {"levels": keep}


@router.post("/api/courses/{course_id}/standards")
async def save_standard(course_id: int, req: StandardReq, request: Request):
    await _course(course_id, request)
    if not req.text.strip():
        raise HTTPException(400, "성취기준 내용을 적어 주세요.")
    names = [e.name.strip() for e in req.elements if e.name.strip()]
    if len(set(names)) != len(names):
        raise HTTPException(400, "평가 요소 이름이 겹쳐요. 서로 다르게 적어 주세요.")
    values = {"code": req.code.strip(), "text": req.text.strip(), "level_high": req.level_high.strip(),
              "level_mid": req.level_mid.strip(), "level_low": req.level_low.strip(),
              "elements": json.dumps([{**e.model_dump(), "name": e.name.strip()} for e in req.elements if e.name.strip()],
                                     ensure_ascii=False)}

    def run():
        t = db.course_standards.c
        with db.engine.begin() as c:
            if req.id:
                if not c.execute(update(db.course_standards).where(t.id == req.id, t.course_id == course_id)
                                 .values(**values)).rowcount:
                    raise HTTPException(404, "성취기준을 찾을 수 없어요.")
                return req.id
            n = len(c.execute(select(t.id).where(t.course_id == course_id)).all())
            return c.execute(insert(db.course_standards).values(course_id=course_id, sort=n, created_at=time.time(),
                                                                **values)).inserted_primary_key[0]

    return {"id": await db.run(run)}


@router.post("/api/courses/{course_id}/standards/{sid}/delete")
async def delete_standard(course_id: int, sid: int, request: Request):
    await _course(course_id, request)

    def run():
        with db.engine.begin() as c:
            c.execute(delete(db.course_standards).where(db.course_standards.c.id == sid,
                                                        db.course_standards.c.course_id == course_id))
            c.execute(delete(db.session_standards).where(db.session_standards.c.standard_id == sid,
                                                         db.session_standards.c.course_id == course_id))

    await db.run(run)
    return {"ok": True}


class SessionLinkReq(BaseModel):
    standard_ids: list[int] = Field(default_factory=list, max_length=30)


@router.post("/api/courses/{course_id}/sessions/{no}/standards")
async def link_session(course_id: int, no: int, req: SessionLinkReq, request: Request):
    await _course(course_id, request)

    def run():
        ss = db.session_standards.c
        with db.engine.begin() as c:
            mine = set(c.execute(select(db.course_standards.c.id).where(
                db.course_standards.c.course_id == course_id)).scalars())
            c.execute(delete(db.session_standards).where(ss.course_id == course_id, ss.session_no == no))
            for sid in dict.fromkeys(req.standard_ids):
                if sid in mine:
                    c.execute(insert(db.session_standards).values(course_id=course_id, session_no=no, standard_id=sid))

    await db.run(run)
    return {"ok": True}


ELEMENT_SYSTEM = (
    "당신은 한국 고등학교 교육과정 평가 전문가입니다. 교사가 준 성취기준과 그 성취기준의 평가기준(상·중·하)을 읽고, "
    "수업 중 학생의 '말(발언)'로 관찰할 수 있는 평가 요소를 2~4개 뽑습니다. 각 요소는 짧은 이름(15자 이내)과 "
    "상·중·하 수준에서 그 요소가 어떻게 드러나는지 한 문장씩으로 씁니다. 평가기준 문장에 근거하고, 없는 내용을 지어내지 마세요."
)
ELEMENT_SCHEMA = {
    "type": "object",
    "properties": {"elements": {"type": "array", "items": {
        "type": "object",
        "properties": {"name": {"type": "string"}, "high": {"type": "string"}, "mid": {"type": "string"},
                       "low": {"type": "string"}},
        "required": ["name", "high", "mid", "low"], "additionalProperties": False}}},
    "required": ["elements"], "additionalProperties": False,
}


class DraftReq(BaseModel):
    code: str = Field(default="", max_length=40)
    text: str = Field(max_length=2000)
    level_high: str = Field(default="", max_length=3000)
    level_mid: str = Field(default="", max_length=3000)
    level_low: str = Field(default="", max_length=3000)


@router.post("/api/courses/{course_id}/standards/draft-elements")
async def draft_elements(course_id: int, req: DraftReq, request: Request):
    """AI 가 성취기준·평가기준에서 평가 요소 초안을 뽑는다 (저장은 교사가 고친 뒤 [저장])"""
    course, _ = await _course(course_id, request)
    if not ai_ready():
        raise HTTPException(503, "AI가 설정되지 않았어요. 평가 요소를 직접 적어 주세요.")
    if not (req.level_high.strip() or req.level_mid.strip() or req.level_low.strip()):
        raise HTTPException(400, "평가기준(상·중·하)을 먼저 넣어 주세요.")
    prompt = (f"과목: {course.subject or course.title}\n성취기준 {req.code}: {req.text}\n\n"
              f"[평가기준 상]\n{req.level_high}\n\n[평가기준 중]\n{req.level_mid}\n\n[평가기준 하]\n{req.level_low}")
    data = await ai_json(ELEMENT_SYSTEM, prompt, ELEMENT_SCHEMA, 4000)
    return {"elements": [{k: str(e.get(k, ""))[:1000] for k in ("name", "high", "mid", "low")}
                         for e in data.get("elements", [])][:6]}


# ───────── 학생 발언 AI 분석 ─────────

def _student_material(course_id: int, user_id: int):
    """그 학생의 수업별 발언과 수업마다 연결된 성취기준"""
    from app.speech import _entries
    from app.courses import sessions_by_course
    entries = [e for e in _entries(course_id, None, user_id) if e["role"] == "student"]
    standards, links = standards_of(course_id)
    sessions = sessions_by_course([course_id]).get(course_id, [])
    by_date = {}
    for s in sessions:
        by_date.setdefault(s["date"], []).extend(links.get(s["no"], []))
    classes: dict[int, dict] = {}
    for e in entries:
        x = classes.setdefault(e["class_id"], {"class_id": e["class_id"], "date": e["date"], "title": e["class_title"],
                                                "texts": []})
        x["texts"].append(e["text"])
    every = [s["id"] for s in standards]
    for x in classes.values():
        x["standard_ids"] = by_date.get(x["date"]) or every  # 회차와 연결되지 않은 수업은 모든 성취기준으로
    with db.engine.connect() as c:
        u = c.execute(select(db.users.c.name, db.users.c.google_name).where(db.users.c.id == user_id)).first()
    names = [n for n in ((u.name, u.google_name) if u else ()) if n]
    return sorted(classes.values(), key=lambda x: (x["date"], x["class_id"])), standards, names


ANALYSIS_SYSTEM = (
    "당신은 한국 고등학교 교사를 돕는 평가 보조자입니다. 한 학생이 여러 수업에서 한 발언(음성 인식 결과라 오탈자가 있을 수 있음)을 "
    "성취기준의 평가 요소와 상·중·하 기준에 비추어 판단합니다.\n"
    "규칙:\n- 수업마다, 그 수업에 연결된 평가 요소 가운데 발언에서 근거를 찾을 수 있는 것만 판단합니다. 근거가 없으면 판단하지 않습니다.\n"
    "- level 은 상=3, 중=2, 하=1 입니다. evidence 에는 판단 근거가 된 학생 발언을 짧게 그대로 인용합니다.\n"
    "- summary(교사용)는 수업이 이어지면서 성취가 어떻게 달라졌는지 4~6문장으로 씁니다. 과목 성취수준(일반적 특성)이 주어지면 "
    "지금 모습이 어느 수준의 특성에 가까운지 참고로 한 문장 덧붙이되, 성취도를 확정하는 말은 하지 않습니다. 발언 수가 적으면 그 한계를 밝힙니다.\n"
    "- feedback(학생용 초안)은 학생에게 직접 말하듯 존댓말로, 잘한 점 1~2가지·보완할 점 1가지·다음 수업에서 해 볼 행동 1가지를 3~5문장으로 씁니다.\n"
    "- 이름·학번 등 개인정보를 쓰지 않습니다. 발언에 없는 사실을 지어내지 않습니다."
)


def analysis_schema(keys: list[str], n_classes: int) -> dict:
    return {
        "type": "object",
        "properties": {
            "classes": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "class_no": {"type": "integer", "enum": list(range(1, n_classes + 1))},
                    "ratings": {"type": "array", "items": {
                        "type": "object",
                        "properties": {"key": {"type": "string", "enum": keys},
                                       "level": {"type": "integer", "enum": [1, 2, 3]},
                                       "evidence": {"type": "string"}},
                        "required": ["key", "level", "evidence"], "additionalProperties": False}},
                },
                "required": ["class_no", "ratings"], "additionalProperties": False}},
            "summary": {"type": "string"},
            "feedback": {"type": "string"},
        },
        "required": ["classes", "summary", "feedback"], "additionalProperties": False,
    }


@router.post("/api/courses/{course_id}/speech/student/{user_id}/analyze")
async def analyze_student(course_id: int, user_id: int, request: Request):
    course, _ = await _course(course_id, request)
    if not ai_ready():
        raise HTTPException(503, "AI가 설정되지 않아 분석할 수 없어요.")
    from app.privacy_filter import redact
    classes, standards, names = await db.run(_student_material, course_id, user_id)
    if not classes:
        raise HTTPException(400, "이 학생의 발언 기록이 없어요.")
    usable = [s for s in standards if s["elements"]]
    if not usable:
        raise HTTPException(400, "먼저 [과목 정보]에서 성취기준과 평가 요소를 넣어 주세요.")
    by_id = {s["id"]: s for s in usable}
    # 평가 요소 열쇠: "S번호|요소 이름" (AI 가 이 목록에서만 고르게 한다)
    keys, key_of = [], {}
    std_lines = []
    for i, s in enumerate(usable, 1):
        std_lines.append(f"[S{i}] {s['code']} {s['text']}")
        for e in s["elements"]:
            k = f"S{i}|{e['name']}"
            keys.append(k)
            key_of[k] = (s["id"], s["code"], e["name"])
            std_lines.append(f"  - 요소 '{k}': 상) {e['high']} / 중) {e['mid']} / 하) {e['low']}")
    sno = {s["id"]: i for i, s in enumerate(usable, 1)}
    cls_lines = []
    for n, x in enumerate(classes, 1):
        linked = [f"S{sno[sid]}" for sid in x["standard_ids"] if sid in sno] or [f"S{i}" for i in range(1, len(usable) + 1)]
        said = "\n".join(f"  · {redact(t, names)}" for t in x["texts"])
        cls_lines.append(f"<수업 {n}> {x['date']} 주제: {x['title'] or '-'} / 연결된 성취기준: {', '.join(linked)}\n{said}")
    levels = {k: v for k, v in course_levels(course).items() if v}
    level_text = ("\n\n# 과목 성취수준별 일반적 특성 (참고)\n" + "\n".join(f"[{k}] {v}" for k, v in levels.items())) if levels else ""
    prompt = (f"과목: {course.subject or course.title}{level_text}\n\n# 성취기준과 평가 요소\n" + "\n".join(std_lines)
              + "\n\n# 학생 발언 (수업 순서)\n" + "\n\n".join(cls_lines))
    data = await ai_json(ANALYSIS_SYSTEM, prompt, analysis_schema(keys, len(classes)), 12000)
    now = time.time()

    def save():
        with db.engine.begin() as c:
            c.execute(delete(db.speech_analyses).where(db.speech_analyses.c.course_id == course_id,
                                                       db.speech_analyses.c.user_id == user_id))
            seen = set()
            for item in data.get("classes", []):
                n = item.get("class_no")
                if not isinstance(n, int) or not 1 <= n <= len(classes) or n in seen:
                    continue
                seen.add(n)
                ratings = []
                for r in item.get("ratings", []):
                    if r.get("key") in key_of and r.get("level") in (1, 2, 3):
                        sid, code, name = key_of[r["key"]]
                        ratings.append({"standard_id": sid, "code": code, "element": name, "level": r["level"],
                                        "evidence": str(r.get("evidence", ""))[:300]})
                c.execute(insert(db.speech_analyses).values(course_id=course_id, user_id=user_id,
                                                            class_id=classes[n - 1]["class_id"],
                                                            result=json.dumps(ratings, ensure_ascii=False), created_at=now))
            f = db.speech_feedback.c
            row = c.execute(select(db.speech_feedback).where(f.course_id == course_id, f.user_id == user_id)).first()
            values = {"summary": str(data.get("summary", ""))[:4000], "analyzed_at": now, "updated_at": now}
            if row:
                # 이미 학생에게 공개한 피드백은 선생님이 고친 글일 수 있어 그대로 두고, 공개 전이면 새 초안으로 바꾼다
                if not row.published:
                    values["feedback"] = str(data.get("feedback", ""))[:4000]
                c.execute(update(db.speech_feedback).where(f.id == row.id).values(**values))
            else:
                c.execute(insert(db.speech_feedback).values(course_id=course_id, user_id=user_id, published=0,
                                                            feedback=str(data.get("feedback", ""))[:4000], **values))

    await db.run(save)
    return await db.run(analysis_view, course_id, user_id)


def analysis_view(course_id: int, user_id: int) -> dict:
    with db.engine.connect() as c:
        rows = c.execute(select(db.speech_analyses, db.classes.c.title, db.classes.c.created_at.label("class_created"))
                         .join(db.classes, db.classes.c.id == db.speech_analyses.c.class_id)
                         .where(db.speech_analyses.c.course_id == course_id, db.speech_analyses.c.user_id == user_id)
                         .order_by(db.classes.c.created_at)).all()
        fb = c.execute(select(db.speech_feedback).where(db.speech_feedback.c.course_id == course_id,
                                                        db.speech_feedback.c.user_id == user_id)).first()
    classes = [{"class_id": r.class_id, "title": r.title or "",
                "date": datetime.fromtimestamp(r.class_created, KST).strftime("%Y-%m-%d"),
                "ratings": json.loads(r.result)} for r in rows]
    return {"classes": classes, "summary": fb.summary if fb else "", "feedback": fb.feedback if fb else "",
            "published": bool(fb and fb.published), "analyzed_at": fb.analyzed_at if fb else None, "ai": ai_ready()}


@router.get("/api/courses/{course_id}/speech/student/{user_id}/analysis")
async def get_analysis(course_id: int, user_id: int, request: Request):
    await _course(course_id, request)
    return await db.run(analysis_view, course_id, user_id)


class FeedbackReq(BaseModel):
    feedback: str = Field(default="", max_length=4000)
    published: bool = False


@router.post("/api/courses/{course_id}/speech/student/{user_id}/feedback")
async def save_feedback(course_id: int, user_id: int, req: FeedbackReq, request: Request):
    """학생에게 줄 피드백을 고치고, 공개할지 정한다"""
    await _course(course_id, request)
    now = time.time()

    def run():
        f = db.speech_feedback.c
        with db.engine.begin() as c:
            row = c.execute(select(db.speech_feedback.c.id).where(f.course_id == course_id, f.user_id == user_id)).first()
            values = {"feedback": req.feedback.strip(), "published": int(req.published), "updated_at": now}
            if row:
                c.execute(update(db.speech_feedback).where(f.id == row.id).values(**values))
            else:
                c.execute(insert(db.speech_feedback).values(course_id=course_id, user_id=user_id, summary="", **values))

    await db.run(run)
    return {"ok": True, "published": req.published}


@router.get("/api/my/courses/{course_id}/feedback")
async def my_feedback(course_id: int, request: Request):
    """학생: 선생님이 공개한 내 발언 피드백과 성취 변화 (공개 전이면 비어 있음)"""
    u = await require_user(request, "student")
    view = await db.run(analysis_view, course_id, u["id"])
    if not view["published"]:
        return {"published": False}
    return {"published": True, "feedback": view["feedback"], "classes": view["classes"]}


# ───────── 엑셀로 성취기준 한꺼번에 넣기 ─────────
# 양식: [성취기준] 시트 — 성취기준 코드 · 성취기준 · 평가기준 상 · 중 · 하 · (선택) 평가 요소 · 요소 상 · 중 · 하
#       [과목 성취수준] 시트 — 성취수준(A~E / A~C / P) · 일반적 특성

import io as _io
import re as _re

_CODE = _re.compile(r"\[[^\[\]]{3,30}\]")
MAX_IMPORT = 60


def _norm(v) -> str:
    return _re.sub(r"\s+", "", str(v or "")).replace("·", "").lower()


def _column_roles(header: list) -> dict:
    """첫 줄 제목으로 칸의 쓰임을 찾는다 (코드 · 성취기준 · 평가기준 상중하 · 평가 요소)."""
    roles = {}
    for i, raw in enumerate(header):
        h = _norm(raw)
        if not h:
            continue
        if "요소" in h:
            for key, word in (("el_high", "상"), ("el_mid", "중"), ("el_low", "하")):
                if h.endswith(word):
                    roles.setdefault(key, i)
                    break
            else:
                roles.setdefault("el_name", i)
        elif "코드" in h or h in ("번호", "성취기준번호"):
            roles.setdefault("code", i)
        elif h in ("상", "중", "하") or (h[-1:] in ("상", "중", "하") and ("기준" in h or "수준" in h)):
            roles.setdefault({"상": "high", "중": "mid", "하": "low"}[h[-1]], i)
        elif "성취기준" in h:
            roles.setdefault("text", i)
    return roles


def _cell(r, roles, key) -> str:
    i = roles.get(key)
    return str(r[i]).strip() if i is not None and i < len(r) and r[i] is not None else ""


def _parse_standards(rows: list) -> list[dict]:
    head_at, roles = None, {}
    for i, r in enumerate(rows[:15]):  # 위쪽에 제목·설명 줄이 있어도 제목 줄을 찾는다
        found = _column_roles(r)
        if "text" in found:
            head_at, roles = i, found
            break
    if head_at is None:
        return []
    out: dict[str, dict] = {}
    last = None
    for r in rows[head_at + 1:]:
        text, code = _cell(r, roles, "text"), _cell(r, roles, "code")
        if not code and text:
            m = _CODE.search(text)
            if m:
                code, text = m.group(0), (text[:m.start()] + text[m.end():]).strip()
        if code and code[0] != "[":
            code = f"[{code.strip('[] ')}]"
        key = code or text
        if key:
            if key not in out:
                if len(out) >= MAX_IMPORT:
                    raise HTTPException(400, f"성취기준은 한 번에 {MAX_IMPORT}개까지 올릴 수 있어요.")
                out[key] = {"code": code[:40], "text": (text or code)[:2000], "level_high": _cell(r, roles, "high")[:3000],
                            "level_mid": _cell(r, roles, "mid")[:3000], "level_low": _cell(r, roles, "low")[:3000], "elements": []}
            last = out[key]
        if last is None:
            continue
        name = _cell(r, roles, "el_name")
        if name and len(last["elements"]) < 8 and name not in [e["name"] for e in last["elements"]]:
            last["elements"].append({"name": name[:60], "high": _cell(r, roles, "el_high")[:1000],
                                     "mid": _cell(r, roles, "el_mid")[:1000], "low": _cell(r, roles, "el_low")[:1000]})
    return list(out.values())


_LEVEL_KEY = {"상": "level_high", "중": "level_mid", "하": "level_low"}


def _clean(v) -> str:
    return _re.sub(r"\s+", " ", str(v or "")).strip()


def _parse_vertical(rows: list) -> list[dict]:
    """국가 평가기준 표를 그대로 붙여넣은 모양: [교육과정 성취기준 | (평가준거 성취기준) | 상·중·하 | 평가기준]
    - 성취기준 칸은 병합돼 첫 줄(상)에만 있고, 중·하 줄은 비어 있다.
    - 페이지가 넘어가며 성취기준 문장이나 평가기준이 다음 줄로 이어질 수 있다.
    - 단원 제목·표 머리 줄은 건너뛴다."""
    out: list[dict] = []
    cur, last_key, closed = None, None, True
    for r in rows:
        cells = [_clean(x) for x in r]
        if not any(cells):
            continue
        joined = "".join(cells).replace(" ", "")
        if "교육과정성취기준" in joined or (joined in ("평가기준", "교육과정성취기준평가기준")):
            continue  # 표 머리
        at = next((i for i, x in enumerate(cells) if x in _LEVEL_KEY), None)
        left = [x for x in (cells[:at] if at is not None else cells) if x]
        right = " ".join(x for x in cells[at + 1:] if x) if at is not None else ""
        code_cell = next((x for x in left if _CODE.search(x)), None)
        if code_cell:  # 새 성취기준
            if len(out) >= MAX_IMPORT:
                raise HTTPException(400, f"성취기준은 한 번에 {MAX_IMPORT}개까지 올릴 수 있어요.")
            m = _CODE.search(code_cell)
            rest = [x for x in left if x is not code_cell]
            cur = {"code": m.group(0).replace(" ", "")[:40], "text": _clean(code_cell[:m.start()] + code_cell[m.end():]),
                   "criterion": " ".join(rest), "level_high": "", "level_mid": "", "level_low": "", "elements": []}
            out.append(cur)
            closed, last_key = False, None
        elif cur and not closed and at is None and last_key and not cells[0]:
            # 첫 칸이 비고 글만 있는 줄: 바로 위 평가기준(상·중·하)이 다음 줄로 이어진 것
            cur[last_key] = _clean(cur[last_key] + " " + " ".join(left))
            continue
        elif cur and not closed and left and at is None and not right:
            # 페이지가 넘어가며 이어진 성취기준 문장 (첫 칸) · 평가준거 성취기준 (둘째 칸)
            cur["text"] = _clean(cur["text"] + " " + left[0])
            if len(left) > 1:
                cur["criterion"] = _clean(cur["criterion"] + " " + " ".join(left[1:]))
            continue
        elif cur and not closed and left and at is not None:
            cur["text"] = _clean(cur["text"] + " " + left[0])
            if len(left) > 1:
                cur["criterion"] = _clean(cur["criterion"] + " " + " ".join(left[1:]))
        if cur is None or closed:
            continue
        if at is not None:
            last_key = _LEVEL_KEY[cells[at]]
            cur[last_key] = _clean(cur[last_key] + " " + right)
            if cells[at] == "하" and right:
                closed = True  # 하까지 왔으면 이 성취기준은 끝 (뒤의 단원 제목 등은 붙이지 않는다)
    for it in out:
        crit = _clean(_re.sub(r"\[?\s*평가\s*준거\s*성취\s*기준\s*[①-⑳0-9]*\s*\]?", "", it["criterion"]))
        if crit:  # 평가준거 성취기준이 따로 있으면 성취기준 문장 뒤에 덧붙여 둔다
            it["text"] = f"{it['text']}\n[평가준거 성취기준] {crit}"
        del it["criterion"]
        for k in ("text", "level_high", "level_mid", "level_low"):
            it[k] = it[k][:3000 if k != "text" else 2000]
    return [it for it in out if it["text"] or it["level_high"]]


def _parse_levels(rows: list) -> dict:
    """[과목 성취수준] 시트: 첫 칸이 A·B·C·D·E·P 인 줄의 설명 (첫 칸 '성취수준', 둘째 칸 '일반적 특성')"""
    levels = {}
    for r in rows:
        cells = [str(x).strip() for x in r if x is not None and str(x).strip()]
        if len(cells) >= 2:
            k = cells[0].upper().replace("수준", "").strip()
            if k in ("A", "B", "C", "D", "E", "P"):
                levels[k] = "\n".join(cells[1:])[:3000]
    return levels


def parse_standards_xlsx(data: bytes) -> tuple[list[dict], dict]:
    from openpyxl import load_workbook
    try:
        book = load_workbook(_io.BytesIO(data), read_only=True, data_only=True)
    except Exception:
        raise HTTPException(400, "엑셀 파일(.xlsx)을 읽지 못했어요. 엑셀에서 '다른 이름으로 저장 → Excel 통합 문서(.xlsx)'로 저장해 올려 주세요.") from None
    standards, levels = [], {}
    for sheet in book.worksheets:
        rows = [list(r) for r in sheet.iter_rows(values_only=True)]
        if "성취수준" in sheet.title.replace(" ", ""):
            levels.update(_parse_levels(rows))
        elif not standards:
            # 국가 평가기준 표를 그대로 붙여넣은 모양(상·중·하가 세로로)이 먼저, 아니면 한 줄에 한 성취기준
            vertical = any(_clean(x) in _LEVEL_KEY for r in rows for x in r)
            standards = _parse_vertical(rows) if vertical else _parse_standards(rows)
    if not standards and not levels:
        raise HTTPException(400, "엑셀에서 성취기준이나 과목 성취수준을 찾지 못했어요. [엑셀 양식 받기]로 받은 양식에 채워 주세요.")
    return standards, levels


@router.post("/api/courses/{course_id}/standards/import")
async def import_standards(course_id: int, request: Request):
    """엑셀(.xlsx)의 성취기준·평가기준과 과목 성취수준을 넣는다.
    같은 코드가 이미 있으면 새 내용으로 바꾼다(평가 요소는 엑셀에 있을 때만)."""
    course, _ = await _course(course_id, request)
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 5 * 1024 * 1024:
            raise HTTPException(413, "파일이 너무 커요. (5MB까지)")
    items, levels = await db.run(parse_standards_xlsx, bytes(data))
    scale = scale_of(course)

    def run():
        t = db.course_standards.c
        added, updated, ids = 0, 0, []
        with db.engine.begin() as c:
            have = {r.code: r.id for r in c.execute(select(t.id, t.code).where(t.course_id == course_id)) if r.code}
            n = len(c.execute(select(t.id).where(t.course_id == course_id)).all())
            for it in items:
                values = {k: it[k] for k in ("code", "text", "level_high", "level_mid", "level_low")}
                if it["elements"]:
                    values["elements"] = json.dumps(it["elements"], ensure_ascii=False)
                if it["code"] in have:
                    c.execute(update(db.course_standards).where(t.id == have[it["code"]]).values(**values))
                    ids.append(have[it["code"]])
                    updated += 1
                else:
                    sid = c.execute(insert(db.course_standards).values(
                        course_id=course_id, sort=n, created_at=time.time(), elements=values.pop("elements", "[]"), **values)
                    ).inserted_primary_key[0]
                    have[it["code"]] = sid
                    ids.append(sid)
                    n += 1
                    added += 1
            got = {k: v for k, v in levels.items() if k in scale}
            if got:
                c.execute(update(db.courses).where(db.courses.c.id == course_id).values(
                    achievement_levels=json.dumps({**course_levels(course), **got}, ensure_ascii=False)))
        return added, updated, ids, len(got)

    added, updated, ids, level_count = await db.run(run)
    return {"added": added, "updated": updated, "ids": ids, "levels": level_count}


@router.get("/api/courses/{course_id}/standards/template.xlsx")
async def standards_template(course_id: int, request: Request):
    """엑셀 양식: [성취기준] 시트(성취기준 + 평가기준 상중하) · [과목 성취수준] 시트(이 과목 성취도의 단계별 일반적 특성)"""
    course, _ = await _course(course_id, request)
    from fastapi.responses import Response
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    fill = PatternFill("solid", fgColor="E8F1EC")
    book = Workbook()
    sh = book.active
    sh.title = "성취기준"
    # 국가 평가기준 표와 같은 모양: 성취기준 하나에 상·중·하 세 줄 (표를 그대로 복사해 A1에 붙여넣어도 된다)
    sh.append(["교육과정 성취기준", "수준", "평가기준"])
    sh.append(["[12법사02-03] 기본권 제한의 요건과 한계를 이해하고 구체적 사례에 적용하여 판단할 수 있다.", "상",
               "기본권 제한의 요건과 한계를 정확히 이해하고, 다양한 사례에 적용하여 타당하게 판단할 수 있다."])
    sh.append([None, "중", "기본권 제한의 요건을 이해하고, 사례에 적용하여 판단할 수 있다."])
    sh.append([None, "하", "기본권 제한의 의미를 설명할 수 있다."])
    for col, w in zip("ABC", (50, 8, 90)):
        sh.column_dimensions[col].width = w
    lv = book.create_sheet("과목 성취수준")
    lv.append(["성취수준", "일반적 특성"])
    have = course_levels(course)
    for k in scale_of(course):
        lv.append([k, have.get(k, "")])
    lv.column_dimensions["A"].width = 12
    lv.column_dimensions["B"].width = 110
    for s in (sh, lv):
        for cell in s[1]:
            cell.font, cell.fill = Font(bold=True), fill
        for row in s.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(wrap_text=True, vertical="top")
    note = book.create_sheet("사용법")
    for line in ("1. [성취기준] 시트: 교육과정 문서(PDF·한글)의 '교육과정 성취기준 | 평가기준' 표를 그대로 복사해 A1 칸에 붙여넣으면 돼요. (예시 줄은 지우세요)",
                 "   성취기준 하나에 상·중·하 세 줄이고, 성취기준 칸은 첫 줄에만 있어도 돼요. 단원 제목이나 표 머리 줄이 섞여 있어도 알아서 건너뛰어요.",
                 "   '평가준거 성취기준' 칸이 있는 표도 그대로 붙여넣어도 돼요. (성취기준 아래에 함께 저장돼요)",
                 "2. 평가 요소는 올린 뒤 AI가 평가기준에서 뽑아 줘요. 나중에 [수정]에서 고칠 수 있어요.",
                 f"3. [과목 성취수준] 시트: 이 과목의 성취도({'·'.join(scale_of(course))})별 일반적 특성을 적어요.",
                 "4. 이미 있는 성취기준 코드를 다시 올리면 내용이 새것으로 바뀌어요."):
        note.append([line])
    note.column_dimensions["A"].width = 110
    out = _io.BytesIO()
    book.save(out)
    return Response(out.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": "attachment; filename=\"standards-template.xlsx\"; filename*=UTF-8''%EC%84%B1%EC%B7%A8%EA%B8%B0%EC%A4%80_%EC%96%91%EC%8B%9D.xlsx",
                             "Cache-Control": "private, no-store"})
