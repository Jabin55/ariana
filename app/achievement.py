"""성취기준 기반 수업 기록 분석.

1) 강좌에 성취기준과 성취기준별 평가기준(상·중·하)을 넣어 두고, 거기서 평가 요소를 뽑는다(AI 초안 → 교사 수정).
   과목 전체의 성취수준(성취도 A~E / A~C / P 별 일반적 특성)도 함께 넣어 둔다.
2) 강좌 회차마다 다루는 성취기준을 고른다. 수업(실시간)은 같은 날짜의 회차와 연결된다.
3) 교사가 [AI 분석]을 누르면 그 학생의 발언·교사 관찰·퀴즈 답안(이름·학번은 가림)을 평가 요소에 비추어
   수업마다 상(3)·중(2)·하(1)로 판단하고, 판단 근거·종합 의견(교사용)·피드백 초안(학생용)을 만든다.
4) 피드백은 교사가 [학생에게 공개]해야 학생에게 보인다. 기록은 과목이 끝나고 365일 뒤 지운다(file_retention).
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, insert, select, update

from app import db
from app.auth import require_user

router = APIRouter()
log = logging.getLogger(__name__)
KST = ZoneInfo("Asia/Seoul")
# 비용을 아끼려고 AI 조교와 같은 가장 가벼운(저렴한) Haiku 를 쓴다. 바꾸려면 ANALYSIS_MODEL 설정
ANALYSIS_MODEL = os.environ.get("ANALYSIS_MODEL", "claude-haiku-5-5")
LEVELS = {3: "상", 2: "중", 1: "하"}
_client = None


def ai_ready() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def ai_error_text(status: int, message: str) -> str:
    """Claude API 오류를 선생님이 알아볼 수 있는 말로 (원인이 무엇인지 화면에 바로 보이게)"""
    m = message.lower()
    if status == 401:
        return "AI 서비스가 API 키 인증을 거부했어요. 서버에 적용된 키가 만료·비활성화됐거나 잘못 입력됐는지 확인해 주세요."
    if status == 403:
        return "이 API 키로는 AI를 쓸 권한이 없어요. console.anthropic.com에서 키와 조직 설정을 확인해 주세요."
    if status in (429, 529):
        return "AI 요청이 몰렸거나 사용 한도에 닿았어요. 잠시 후 다시 시도하거나 console.anthropic.com의 Limits를 확인해 주세요."
    if status == 404:
        return f"AI 모델({ANALYSIS_MODEL})을 쓸 수 없어요. 서버 설정 ANALYSIS_MODEL을 확인해 주세요."
    if "credit" in m or "billing" in m or "balance" in m:
        return "AI 사용 크레딧이 부족해요. console.anthropic.com의 Billing에서 충전한 뒤 다시 시도해 주세요."
    if "model" in m:
        return f"AI 모델({ANALYSIS_MODEL})을 쓸 수 없어요. 서버 설정 ANALYSIS_MODEL을 확인해 주세요."
    return f"AI 분석 중 문제가 생겼어요 (오류 {status}). 잠시 후 다시 시도해 주세요."


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
        log.error("AI 분석 오류 (status=%s, model=%s): %s", e.status_code, ANALYSIS_MODEL, str(e.message)[:300])
        raise HTTPException(502, ai_error_text(e.status_code, str(e.message))) from None
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

ELEMENT_CATEGORIES = ("지식·이해", "과정·기능", "가치·태도")


class Element(BaseModel):
    name: str = Field(max_length=60)
    category: Literal["", "지식·이해", "과정·기능", "가치·태도"] = ""  # 기존 요소는 미분류로 유지
    evidence: str = Field(default="", max_length=300)  # 교사가 확인할 수업 기록·결과물
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
    class_links = await db.run(class_links_of, course_id)
    return {"standards": standards, "ai": ai_ready(), "scale": scale_of(course), "course_levels": course_levels(course),
            "subject_competencies": subject_competencies_of(course),
            "class_links": {str(k): v for k, v in class_links.items()},
            "achievement_text": subjects.ACHIEVEMENTS.get(course.achievement or "", "성취도 미정 (5단계로 표시)"),
            "sessions": [{**s, "standard_ids": links.get(s["no"], [])} for s in sessions]}


def subject_competencies_of(course) -> list[str]:
    try:
        items = json.loads(getattr(course, "subject_competencies", "") or "[]")
    except ValueError:
        items = []
    return [str(x) for x in items if str(x).strip()][:8]


class SubjectCompetenciesReq(BaseModel):
    items: list[str] = Field(default_factory=list, max_length=8)


@router.post("/api/courses/{course_id}/subject-competencies")
async def save_subject_competencies(course_id: int, req: SubjectCompetenciesReq, request: Request):
    """이 과목의 교과 역량 (3~8개). 학생 맞춤형 분석의 '교과 역량 밸런스 차트' 꼭짓점이 된다"""
    await _course(course_id, request)
    items = list(dict.fromkeys(" ".join(x.split())[:30] for x in req.items if x.strip()))[:8]

    def run():
        with db.engine.begin() as c:
            c.execute(update(db.courses).where(db.courses.c.id == course_id)
                      .values(subject_competencies=json.dumps(items, ensure_ascii=False)))

    await db.run(run)
    return {"items": items}


SUBJECT_COMP_SYSTEM = (
    "당신은 한국 고등학교 교육과정 전문가입니다. 주어진 과목의 2022 개정 교육과정 문서가 제시하는 교과 역량(교과에서 기르고자 하는 역량)을 "
    "3~6개의 짧은 이름(15자 이내)으로 적습니다. 문서의 표현을 우선하고, 확실하지 않으면 그 과목 성취기준에서 공통으로 드러나는 사고·탐구 능력으로 정리합니다. "
    "교사가 확인하고 고칠 초안입니다."
)


@router.post("/api/courses/{course_id}/subject-competencies/draft")
async def draft_subject_competencies(course_id: int, request: Request):
    course, _ = await _course(course_id, request)
    if not ai_ready():
        raise HTTPException(503, "AI가 설정되지 않았어요. 교과 역량을 직접 적어 주세요.")
    standards, _ = await db.run(standards_of, course_id)
    prompt = (f"교과(군): {course.subject_group or '-'} / 과목: {course.subject or course.title}\n"
              + ("성취기준:\n" + "\n".join(f"- {s['code']} {s['text']}" for s in standards[:30]) if standards else "(성취기준 없음)"))
    data = await ai_json(SUBJECT_COMP_SYSTEM, prompt, {
        "type": "object", "properties": {"items": {"type": "array", "items": {"type": "string"}}},
        "required": ["items"], "additionalProperties": False}, 2000)
    return {"items": [" ".join(str(x).split())[:30] for x in data.get("items", []) if str(x).strip()][:8]}


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
            c.execute(delete(db.class_standards).where(db.class_standards.c.standard_id == sid))
            c.execute(delete(db.assignment_standards).where(db.assignment_standards.c.standard_id == sid))

    await db.run(run)
    return {"ok": True}


def class_links_of(course_id: int) -> dict[int, list[int]]:
    """이 과목 수업(class)마다 직접 고른 성취기준"""
    cs, cl = db.class_standards.c, db.classes.c
    out: dict[int, list[int]] = {}
    with db.engine.connect() as c:
        for r in c.execute(select(cs.class_id, cs.standard_id).join(db.classes, cl.id == cs.class_id)
                           .where(cl.course_id == course_id)):
            out.setdefault(r.class_id, []).append(r.standard_id)
    return out


class SessionLinkReq(BaseModel):
    standard_ids: list[int] = Field(default_factory=list, max_length=30)


@router.post("/api/courses/{course_id}/classes/{class_id}/standards")
async def link_class(course_id: int, class_id: int, req: SessionLinkReq, request: Request):
    """회차 외 수업(보강·특강)에 다룬 성취기준을 직접 고른다. 빈 목록이면 같은 날 회차 → 모든 성취기준으로 돌아간다"""
    await _course(course_id, request)

    def run():
        cs = db.class_standards.c
        with db.engine.begin() as c:
            r = c.execute(select(db.classes.c.id).where(db.classes.c.id == class_id, db.classes.c.course_id == course_id)).first()
            if not r:
                raise HTTPException(404, "이 과목의 수업이 아니에요.")
            mine = set(c.execute(select(db.course_standards.c.id).where(
                db.course_standards.c.course_id == course_id)).scalars())
            c.execute(delete(db.class_standards).where(cs.class_id == class_id))
            for sid in dict.fromkeys(req.standard_ids):
                if sid in mine:
                    c.execute(insert(db.class_standards).values(class_id=class_id, standard_id=sid))

    await db.run(run)
    return {"ok": True}


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
    "학생이 실제로 보여 줄 수 있는 구체적인 평가 요소를 1~4개 제안합니다. 학생 발언만으로 판단할 요소로 제한하지 마세요. "
    "각 요소에는 지식·이해, 과정·기능, 가치·태도 중 해당 범주 하나와 확인할 자료(퀴즈 답안, 보고서, 발표, 토론, 교사 관찰 등)를 적습니다. "
    "모든 범주를 억지로 채우지 말고, 성취기준·평가기준에 근거가 없는 가치·태도나 일반적인 성실성은 추가하지 마세요. "
    "요소 이름은 관찰 가능한 수행을 나타내는 짧은 말(15자 이내)로, 상·중·하에서 그 수행이 어떻게 드러나는지 한 문장씩 씁니다. "
    "평가기준에 없는 내용을 지어내지 마세요. 교사가 검토할 초안입니다."
)
ELEMENT_SCHEMA = {
    "type": "object",
    "properties": {"elements": {"type": "array", "items": {
        "type": "object",
        "properties": {"name": {"type": "string"}, "category": {"type": "string", "enum": list(ELEMENT_CATEGORIES)},
                       "evidence": {"type": "string"}, "high": {"type": "string"}, "mid": {"type": "string"},
                       "low": {"type": "string"}},
        "required": ["name", "category", "evidence", "high", "mid", "low"], "additionalProperties": False}}},
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
    return {"elements": [{"name": str(e.get("name", ""))[:60],
                          "category": e.get("category") if e.get("category") in ELEMENT_CATEGORIES else "",
                          "evidence": str(e.get("evidence") or "")[:300],
                          **{k: str(e.get(k, ""))[:1000] for k in ("high", "mid", "low")}}
                         for e in data.get("elements", []) if isinstance(e, dict)][:4]}


# ───────── 수업 중 교사 관찰 기록 ─────────

class ObservationReq(BaseModel):
    user_id: int
    text: str = Field(max_length=2000)


async def _live_teacher(code: str, request: Request):
    from app.classroom import get_class, is_class_teacher
    u = await require_user(request, "teacher")
    k = await get_class(code)
    if not await is_class_teacher(k, u):
        raise HTTPException(403, "이 수업의 강의교사만 관찰 기록을 쓸 수 있어요.")
    return k, u


def _observation_rows(class_id: int) -> list[dict]:
    o = db.observations.c
    with db.engine.connect() as c:
        rows = c.execute(select(db.observations, db.users.c.name, db.users.c.google_name)
                         .join(db.users, db.users.c.id == o.user_id)
                         .where(o.class_id == class_id).order_by(o.created_at.desc())).all()
    return [{"id": r.id, "user_id": r.user_id, "name": r.name or r.google_name or "", "text": r.text,
             "time": datetime.fromtimestamp(r.created_at, KST).strftime("%H:%M")} for r in rows]


@router.get("/api/live/classes/{code}/observations")
async def list_observations(code: str, request: Request):
    k, _ = await _live_teacher(code, request)
    return {"observations": await db.run(_observation_rows, k.db_id)}


@router.post("/api/live/classes/{code}/observations")
async def add_observation(code: str, req: ObservationReq, request: Request):
    """수업 중 관찰 기록 한 건 (이 수업에 들어왔거나 수강 명단에 있는 학생만)"""
    k, u = await _live_teacher(code, request)
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "관찰 내용을 적어 주세요.")
    sid = str(req.user_id)
    s = k.students.get(sid)
    if not ((s and not s.observer) or any(str(r["id"]) == sid for r in k.roster)):
        raise HTTPException(400, "이 수업의 학생을 골라 주세요.")

    def run():
        with db.engine.begin() as c:
            c.execute(insert(db.observations).values(class_id=k.db_id, course_id=k.course_id, user_id=req.user_id,
                                                     teacher_id=u["id"], text=text, created_at=time.time()))

    await db.run(run)
    return {"observations": await db.run(_observation_rows, k.db_id)}


@router.post("/api/live/classes/{code}/observations/{oid}/delete")
async def delete_observation(code: str, oid: int, request: Request):
    k, _ = await _live_teacher(code, request)

    def run():
        with db.engine.begin() as c:
            c.execute(delete(db.observations).where(db.observations.c.id == oid, db.observations.c.class_id == k.db_id))

    await db.run(run)
    return {"observations": await db.run(_observation_rows, k.db_id)}


def student_observations(course_id: int, user_id: int) -> list[dict]:
    """과목 운영 화면용: 그 학생의 이 과목 관찰 기록 (수업 순서)"""
    o, cl = db.observations.c, db.classes.c
    with db.engine.connect() as c:
        rows = c.execute(select(db.observations, cl.title, cl.created_at.label("class_created"))
                         .join(db.classes, cl.id == o.class_id)
                         .where(cl.course_id == course_id, o.user_id == user_id).order_by(o.created_at)).all()
    return [{"class_id": r.class_id, "class_title": r.title or "", "text": r.text,
             "date": datetime.fromtimestamp(r.class_created, KST).strftime("%Y-%m-%d"),
             "time": datetime.fromtimestamp(r.created_at, KST).strftime("%H:%M")} for r in rows]


@router.get("/api/courses/{course_id}/speech/student/{user_id}/observations")
async def get_student_observations(course_id: int, user_id: int, request: Request):
    await _course(course_id, request)
    return {"observations": await db.run(student_observations, course_id, user_id)}


# ───────── 학생 발언 AI 분석 ─────────

def _student_material(course_id: int, user_id: int):
    """그 학생의 수업별 발언·관찰·퀴즈 답안과 연결된 성취기준"""
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
                                                "texts": [], "notes": [], "quizzes": []})
        x["texts"].append(e["text"])
    for o in student_observations(course_id, user_id):  # 교사 관찰 기록도 그 수업의 근거로
        x = classes.setdefault(o["class_id"], {"class_id": o["class_id"], "date": o["date"], "title": o["class_title"],
                                                "texts": [], "notes": [], "quizzes": []})
        x["notes"].append(o["text"])
    a, cl = db.activities.c, db.classes.c
    with db.engine.connect() as c:
        quiz_rows = c.execute(select(a.kind, a.prompt, a.options, a.correct, a.responses,
                                     cl.id.label("class_id"), cl.title, cl.created_at.label("class_created"))
                              .join(db.classes, cl.id == a.class_id)
                              .where(cl.course_id == course_id, a.kind.in_(("ox", "choice", "text")))
                              .order_by(a.created_at, a.id)).all()
    for q in quiz_rows:
        try:
            answers = json.loads(q.responses)
            if not isinstance(answers, dict) or str(user_id) not in answers:
                continue
            answer = answers[str(user_id)]
            options = json.loads(q.options)
        except (ValueError, TypeError):
            continue
        if q.kind == "text":
            if not isinstance(answer, str) or not answer.strip():
                continue
            shown = answer.strip()
        else:
            if not isinstance(options, list) or type(answer) is not int or not 0 <= answer < len(options):
                continue
            shown = str(options[answer])
        kind = {"ox": "OX", "choice": "객관식", "text": "주관식"}[q.kind]
        record = f"[{kind}] 문항: {q.prompt} / 학생 답: {shown}"
        if q.kind != "text" and type(q.correct) is int and 0 <= q.correct < len(options):
            record += f" / 정답: {options[q.correct]} ({'정답' if answer == q.correct else '오답'})"
        x = classes.setdefault(q.class_id, {"class_id": q.class_id,
                                             "date": datetime.fromtimestamp(q.class_created, KST).strftime("%Y-%m-%d"),
                                             "title": q.title or "", "texts": [], "notes": [], "quizzes": []})
        x["quizzes"].append(record)
    every = [s["id"] for s in standards]
    direct = class_links_of(course_id)
    for x in classes.values():
        # 수업에 직접 고른 성취기준 → 같은 날 회차의 성취기준 → 모든 성취기준
        x["standard_ids"] = direct.get(x["class_id"]) or by_date.get(x["date"]) or every
    with db.engine.connect() as c:
        u = c.execute(select(db.users.c.name, db.users.c.google_name).where(db.users.c.id == user_id)).first()
    names = [n for n in ((u.name, u.google_name) if u else ()) if n]
    return sorted(classes.values(), key=lambda x: (x["date"], x["class_id"])), standards, names


ANALYSIS_SYSTEM = (
    "당신은 한국 고등학교 교사를 돕는 평가 보조자입니다. 한 학생의 수업별 발언(음성 인식 결과라 오탈자가 있을 수 있음), "
    "교사 관찰 기록, 퀴즈 문항과 그 학생의 답을 성취기준의 평가 요소와 상·중·하 기준에 비추어 판단합니다.\n"
    "규칙:\n- 수업마다 연결된 평가 요소 가운데 발언·관찰·퀴즈 답안에 직접 근거가 있는 것만 판단합니다. 근거가 없으면 판단하지 않습니다.\n"
    "- 퀴즈의 정오 여부 한 번만으로 학생의 전체 성취수준이나 발표·협력 역량을 단정하지 않습니다. 정답이 없는 문항은 답안 내용만 봅니다.\n"
    "- 가치·태도는 학생의 말이 적거나 정답을 틀렸다는 이유로 추정하지 않습니다. 해당 성취기준과 관련된 행동의 관찰 근거가 있을 때만 판단합니다. "
    "제안된 확인 자료가 입력에 없으면 그 자료를 본 것처럼 쓰지 않습니다.\n"
    "- level 은 상=3, 중=2, 하=1 입니다. evidence 에는 판단 근거를 짧게 인용하고 출처를 '(발언)', '(관찰)', '(퀴즈)'로 표시합니다.\n"
    "- summary(교사용)는 수업이 이어지면서 성취가 어떻게 달라졌는지 4~6문장으로 씁니다. 과목 성취수준(일반적 특성)이 주어지면 "
    "지금 모습이 어느 수준의 특성에 가까운지 참고로 한 문장 덧붙이되, 성취도를 확정하는 말은 하지 않습니다. 근거가 적으면 그 한계를 밝힙니다.\n"
    "- feedback(학생용 초안)은 학생에게 직접 말하듯 존댓말로 4~6문장으로 씁니다. 관찰된 잘한 점 1~2가지와 "
    "보완할 점 1가지를 비난 없이 설명하고, 다음 수업에서 해 볼 구체적인 행동 1가지를 제안합니다. "
    "학생이 어려움을 느낄 수 있음을 배려하며 질문·재시도·교사 도움을 받을 수 있다는 따뜻한 격려를 포함합니다. "
    "기록에 없는 감정이나 개인 사정을 안다고 단정하거나, 근거 없이 칭찬하거나, 다른 학생과 비교하지 않습니다.\n"
    "- competencies 는 2022 개정 교육과정 핵심역량 6가지(자기관리, 지식정보처리, 창의적 사고, 심미적 감성, 협력적 소통, 공동체)를 "
    "발언·관찰·퀴즈 답안 전체에서 드러난 만큼 1~5점으로 매기고(3=보통), reason 에 근거를 한 문장으로 씁니다. "
    "근거가 거의 없는 역량은 3점으로 두고 reason 에 '근거 부족'이라고 씁니다.\n"
    "- 이름·학번 등 개인정보를 쓰지 않습니다. 제공된 기록에 없는 사실을 지어내지 않습니다."
)


# 2022 개정 교육과정 핵심역량 (화면 6각형 차트 순서)
COMPETENCIES = [("self_management", "자기관리 역량"), ("knowledge_info", "지식정보처리 역량"),
                ("creative_thinking", "창의적 사고 역량"), ("aesthetic", "심미적 감성 역량"),
                ("communication", "협력적 소통 역량"), ("community", "공동체 역량")]


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
            "competencies": {"type": "object", "properties": {
                k: {"type": "object", "properties": {"score": {"type": "integer", "enum": [1, 2, 3, 4, 5]},
                                                     "reason": {"type": "string"}},
                    "required": ["score", "reason"], "additionalProperties": False} for k, _ in COMPETENCIES},
                "required": [k for k, _ in COMPETENCIES], "additionalProperties": False},
        },
        "required": ["classes", "summary", "feedback", "competencies"], "additionalProperties": False,
    }


def with_subject_comps(schema: dict, subject_comps: list[str]) -> dict:
    """교과 역량이 정해진 과목이면 'subject_competencies'(역량 이름 → 1~5점·근거)도 받는다"""
    if not subject_comps:
        return schema
    item = {"type": "object", "properties": {"name": {"type": "string", "enum": subject_comps},
                                             "score": {"type": "integer", "enum": [1, 2, 3, 4, 5]},
                                             "reason": {"type": "string"}},
            "required": ["name", "score", "reason"], "additionalProperties": False}
    schema["properties"]["subject_competencies"] = {"type": "array", "items": item}
    schema["required"] = schema["required"] + ["subject_competencies"]
    return schema


@router.post("/api/courses/{course_id}/speech/student/{user_id}/analyze")
async def analyze_student(course_id: int, user_id: int, request: Request):
    course, _ = await _course(course_id, request)
    if not ai_ready():
        raise HTTPException(503, "AI가 설정되지 않아 분석할 수 없어요.")
    from app.privacy_filter import redact
    classes, standards, names = await db.run(_student_material, course_id, user_id)
    if not classes:
        raise HTTPException(400, "이 학생의 발언·관찰·퀴즈 기록이 없어요.")
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
            category = e.get("category") or "미분류"
            evidence = e.get("evidence") or "미지정"
            std_lines.append(f"  - 요소 '{k}' / 범주: {category} / 확인 자료: {evidence}: "
                             f"상) {e['high']} / 중) {e['mid']} / 하) {e['low']}")
    sno = {s["id"]: i for i, s in enumerate(usable, 1)}
    cls_lines = []
    for n, x in enumerate(classes, 1):
        linked = [f"S{sno[sid]}" for sid in x["standard_ids"] if sid in sno] or [f"S{i}" for i in range(1, len(usable) + 1)]
        said = "\n".join(f"  · {redact(t, names)}" for t in x["texts"]) or "  (발언 기록 없음)"
        notes = "\n".join(f"  · {redact(t, names)}" for t in x["notes"])
        quizzes = "\n".join(f"  · {redact(t, names)}" for t in x["quizzes"])
        cls_lines.append(f"<수업 {n}> {x['date']} 주제: {x['title'] or '-'} / 연결된 성취기준: {', '.join(linked)}\n"
                         f"[학생 발언]\n{said}" + (f"\n[교사 관찰 기록]\n{notes}" if notes else "")
                         + (f"\n[학생 퀴즈 응답]\n{quizzes}" if quizzes else ""))
    levels = {k: v for k, v in course_levels(course).items() if v}
    level_text = ("\n\n# 과목 성취수준별 일반적 특성 (참고)\n" + "\n".join(f"[{k}] {v}" for k, v in levels.items())) if levels else ""
    prompt = (f"과목: {course.subject or course.title}{level_text}\n\n# 성취기준과 평가 요소\n" + "\n".join(std_lines)
              + "\n\n# 수업별 학생 발언·교사 관찰 기록·학생 퀴즈 응답 (수업 순서)\n" + "\n\n".join(cls_lines))
    subject_comps = subject_competencies_of(course)
    if subject_comps:
        prompt += ("\n\n# 이 과목의 교과 역량 (subject_competencies 에 각각 1~5점, 3=보통, 근거 한 문장. 근거가 거의 없으면 3점·'근거 부족')\n"
                   + "\n".join(f"- {x}" for x in subject_comps))
    data = await ai_json(ANALYSIS_SYSTEM, prompt, with_subject_comps(analysis_schema(keys, len(classes)), subject_comps), 12000)
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
            comp = data.get("competencies") or {}
            comp = {k: {"score": int(v.get("score", 3)) if str(v.get("score", "")).isdigit() and 1 <= int(v.get("score")) <= 5 else 3,
                        "reason": str(v.get("reason", ""))[:300]}
                    for k, v in comp.items() if k in dict(COMPETENCIES) and isinstance(v, dict)}
            subj = {}
            for v in data.get("subject_competencies") or []:
                if isinstance(v, dict) and v.get("name") in subject_comps and v["name"] not in subj:
                    sc = v.get("score")
                    subj[v["name"]] = {"score": sc if isinstance(sc, int) and 1 <= sc <= 5 else 3, "reason": str(v.get("reason", ""))[:300]}
            values = {"summary": str(data.get("summary", ""))[:4000], "analyzed_at": now, "updated_at": now,
                      "competencies": json.dumps(comp, ensure_ascii=False) if comp else "",
                      "subject_competencies": json.dumps(subj, ensure_ascii=False) if subj else ""}
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
    try:
        comp = json.loads(fb.competencies) if fb and fb.competencies else {}
    except ValueError:
        comp = {}
    competencies = [{"key": k, "label": label, **comp[k]} for k, label in COMPETENCIES if k in comp]
    try:
        subj = json.loads(fb.subject_competencies) if fb and fb.subject_competencies else {}
    except ValueError:
        subj = {}
    with db.engine.connect() as c:
        course = c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()
    names = subject_competencies_of(course) if course else []
    subject = [{"key": n, "label": n, **subj[n]} for n in names if n in subj]
    return {"classes": classes, "summary": fb.summary if fb else "", "feedback": fb.feedback if fb else "",
            "competencies": competencies, "subject_competencies": subject, "subject_competency_names": names,
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
        if h in ("범주", "요소범주", "평가요소범주", "분류"):
            roles.setdefault("el_category", i)
        elif h in ("확인자료", "평가자료", "근거자료", "요소확인자료"):
            roles.setdefault("el_evidence", i)
        elif "요소" in h:
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


def _element_category(raw: str) -> str:
    if not raw.strip():
        return ""  # 기존 엑셀 양식의 평가 요소는 분류를 요구하지 않는다
    category = next((x for x in ELEMENT_CATEGORIES if _norm(x) == _norm(raw)), None)
    if category is None:
        raise HTTPException(400, f"평가 요소 범주 '{raw}'를 확인해 주세요. 지식·이해, 과정·기능, 가치·태도 중에서 골라 주세요.")
    return category


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
            last["elements"].append({"name": name[:60], "category": _element_category(_cell(r, roles, "el_category")),
                                     "evidence": _cell(r, roles, "el_evidence")[:300], "high": _cell(r, roles, "el_high")[:1000],
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


def _parse_elements(rows: list) -> dict:
    """[평가 요소] 시트: 성취기준 코드 · 범주 · 평가 요소 · 확인 자료 · 요소 상·중·하"""
    head_at, roles = None, {}
    for i, r in enumerate(rows[:10]):
        found = _column_roles(r)
        if "el_name" in found:
            head_at, roles = i, found
            break
    if head_at is None:
        return {}
    out: dict[str, list] = {}
    last_code = ""
    for r in rows[head_at + 1:]:
        code = _cell(r, roles, "code")
        if code:
            m = _CODE.search(code)
            last_code = (m.group(0) if m else f"[{code.strip('[] ')}]").replace(" ", "")
        name = _cell(r, roles, "el_name")
        if not (last_code and name):
            continue
        items = out.setdefault(last_code, [])
        if len(items) < 8 and name not in [e["name"] for e in items]:
            items.append({"name": name[:60], "category": _element_category(_cell(r, roles, "el_category")),
                          "evidence": _clean(_cell(r, roles, "el_evidence"))[:300],
                          "high": _clean(_cell(r, roles, "el_high"))[:1000],
                          "mid": _clean(_cell(r, roles, "el_mid"))[:1000], "low": _clean(_cell(r, roles, "el_low"))[:1000]})
    return out


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
    standards, levels, elements = [], {}, {}
    for sheet in book.worksheets:
        rows = [list(r) for r in sheet.iter_rows(values_only=True)]
        title = sheet.title.replace(" ", "")
        if "성취수준" in title:
            levels.update(_parse_levels(rows))
        elif "요소" in title:
            elements.update(_parse_elements(rows))
        elif not standards:
            # 국가 평가기준 표를 그대로 붙여넣은 모양(상·중·하가 세로로)이 먼저, 아니면 한 줄에 한 성취기준
            vertical = any(_clean(x) in _LEVEL_KEY for r in rows for x in r)
            standards = _parse_vertical(rows) if vertical else _parse_standards(rows)
    if not standards and not levels and not elements:
        raise HTTPException(400, "엑셀에서 성취기준이나 과목 성취수준을 찾지 못했어요. [엑셀 양식 받기]로 받은 양식에 채워 주세요.")
    for it in standards:  # [평가 요소] 시트에 적은 요소를 그 성취기준에 붙인다
        if it["code"] in elements and not it["elements"]:
            it["elements"] = elements.pop(it["code"])
    return standards, levels, elements


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
    items, levels, extra_elements = await db.run(parse_standards_xlsx, bytes(data))
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
            # [평가 요소] 시트에만 있는 코드: 이미 들어 있는 성취기준에 평가 요소를 넣는다
            for code, els in extra_elements.items():
                if code in have:
                    c.execute(update(db.course_standards).where(t.id == have[code])
                              .values(elements=json.dumps(els, ensure_ascii=False)))
                    ids.append(have[code])
                    updated += 1
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
    el = book.create_sheet("평가 요소")
    el.append(["성취기준 코드", "범주", "평가 요소", "확인 자료", "요소 상", "요소 중", "요소 하"])
    el.append(["[12법사02-03]", "과정·기능", "근거 제시", "발표·토론·보고서", "타당하고 구체적인 근거를 든다", "근거를 들지만 일부만 타당하다", "근거 없이 주장한다"])
    el.append(["[12법사02-03]", "과정·기능", "반론 고려", "토론·교사 관찰", "상대 주장을 이해하고 반박한다", "상대 주장을 언급한다", "상대 주장을 고려하지 않는다"])
    for col, w in zip("ABCDEFG", (16, 18, 18, 25, 40, 40, 40)):
        el.column_dimensions[col].width = w
    lv = book.create_sheet("과목 성취수준")
    lv.append(["성취수준", "일반적 특성"])
    have = course_levels(course)
    for k in scale_of(course):
        lv.append([k, have.get(k, "")])
    lv.column_dimensions["A"].width = 12
    lv.column_dimensions["B"].width = 110
    for s in (sh, el, lv):
        for cell in s[1]:
            cell.font, cell.fill = Font(bold=True), fill
        for row in s.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(wrap_text=True, vertical="top")
    note = book.create_sheet("사용법")
    for line in ("1. [성취기준] 시트: 교육과정 문서(PDF·한글)의 '교육과정 성취기준 | 평가기준' 표를 그대로 복사해 A1 칸에 붙여넣으면 돼요. (예시 줄은 지우세요)",
                 "   성취기준 하나에 상·중·하 세 줄이고, 성취기준 칸은 첫 줄에만 있어도 돼요. 단원 제목이나 표 머리 줄이 섞여 있어도 알아서 건너뛰어요.",
                 "   '평가준거 성취기준' 칸이 있는 표도 그대로 붙여넣어도 돼요. (성취기준 아래에 함께 저장돼요)",
                 "2. [평가 요소] 시트(선택): 성취기준 코드 · 범주(지식·이해/과정·기능/가치·태도) · 평가 요소 · 확인 자료 · 요소 상·중·하를 적어요.",
                 "   해당하지 않는 범주를 억지로 채우지 마세요. 시트를 비워 두면 AI가 초안을 제안하며, [수정]에서 확인하고 고칠 수 있어요.",
                 f"3. [과목 성취수준] 시트: 이 과목의 성취도({'·'.join(scale_of(course))})별 일반적 특성을 적어요.",
                 "4. 이미 있는 성취기준 코드를 다시 올리면 내용이 새것으로 바뀌어요."):
        note.append([line])
    note.column_dimensions["A"].width = 110
    out = _io.BytesIO()
    book.save(out)
    return Response(out.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": "attachment; filename=\"standards-template.xlsx\"; filename*=UTF-8''%EC%84%B1%EC%B7%A8%EA%B8%B0%EC%A4%80_%EC%96%91%EC%8B%9D.xlsx",
                             "Cache-Control": "private, no-store"})
