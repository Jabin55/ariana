"""수업별 피드백지 (과목 운영 중 · 형성평가).
수업 1회가 끝나면 그 수업에 연결된 성취기준만 보고 학생마다 피드백을 만든다.
AI 초안 → 교사가 항목별로 고쳐서 공개 → 학생은 [활동 피드백]에서 수업별로 본다."""

from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, update

from app import db
from app.achievement import (ACH_FEEDBACK_RULES, FEEDBACK_SCHEMA, FeedbackParts, _course, _student_material, ai_json,
                             ai_ready, clean_parts, standards_of)
from app.auth import require_user, student_no

router = APIRouter()

CLASS_FB_SYSTEM = (
    "당신은 한국 고등학교 교사를 돕는 평가 보조자입니다. 수업 한 번이 끝난 뒤, 한 학생의 그 수업 발언(음성 인식 결과라 오탈자가 있을 수 있음), "
    "교사 관찰 기록, 퀴즈 답안을 그 수업에서 다룬 성취기준의 상·중·하 수행 진술에 비추어 판단하고, 다음 수업에 바로 쓸 형성평가 피드백을 만듭니다.\n"
    "학생 발언 앞의 [응답]은 선생님 발문에 대한 대답, [자발]은 스스로 한 말입니다. [응답]은 함께 적힌 발문에 비추어 단답인지 확장했는지 봅니다.\n"
    "규칙:\n"
    "- standards: 이 수업에서 다룬 성취기준(S번호)마다 level 상=3, 중=2, 하=1, 근거가 없으면 0. 근거 없이 추측하지 않습니다. "
    "evidence 에는 근거를 짧게 인용하고 출처를 '(응답)', '(자발)', '(관찰)', '(퀴즈)'로 표시합니다.\n"
    "- 지난 피드백의 '다음 수업에서 해 보기'(번호 붙은 목표)가 주어지면 goal_checks 에 목표마다 이번 수업에서 했는지 판정합니다. "
    "status 는 done(분명히 해냄)·partial(시도했지만 일부)·none(근거 없음 또는 시도 안 함)이고, evidence 에는 근거 발언·관찰을 짧게 인용합니다(none 이면 빈 문자열). "
    "해낸 목표는 잘한 점이나 선생님의 피드백에서 칭찬하고 다음 목표를 한 단계 높이며, 하지 못한 목표는 더 쉬운 방법으로 다시 제안합니다.\n"
    "- changes 는 지난 수업 기록과 비교해 달라진 점이 근거로 드러날 때만 1~2개 씁니다 (before=지난 수업, after=이번 수업). 지난 기록이 없으면 빈 배열입니다.\n"
    + ACH_FEEDBACK_RULES
    + "- 이름·학번 등 개인정보를 쓰지 않습니다. 제공된 기록에 없는 사실을 지어내지 않습니다."
)

CLASS_FB_SCHEMA_BASE = {
    "type": "object",
    "properties": {"feedback": FEEDBACK_SCHEMA},
    "required": ["standards", "feedback"], "additionalProperties": False,
}


def class_fb_schema(std_keys: list[str], n_goals: int = 0) -> dict:
    schema = json.loads(json.dumps(CLASS_FB_SCHEMA_BASE))
    if n_goals:
        schema["properties"]["goal_checks"] = {"type": "array", "items": {
            "type": "object", "properties": {"no": {"type": "integer", "enum": list(range(1, n_goals + 1))},
                                             "status": {"type": "string", "enum": ["done", "partial", "none"]}, "evidence": {"type": "string"}},
            "required": ["no", "status", "evidence"], "additionalProperties": False}}
        schema["required"] = schema["required"] + ["goal_checks"]
    schema["properties"]["standards"] = {"type": "array", "items": {
        "type": "object", "properties": {"key": {"type": "string", "enum": std_keys or ["S1"]},
                                         "level": {"type": "integer", "enum": [0, 1, 2, 3]}, "evidence": {"type": "string"}},
        "required": ["key", "level", "evidence"], "additionalProperties": False}}
    return schema


def previous_goals(course_id: int, user_id: int, class_id: int) -> list[str]:
    """이 수업 바로 앞까지 학생에게 공개한 가장 최근 피드백의 '다음 수업에서 해 보기'"""
    f, cl = db.class_feedback.c, db.classes.c
    with db.engine.connect() as c:
        start = c.execute(select(cl.created_at).where(cl.id == class_id)).scalar()
        if start is None:
            return []
        row = c.execute(select(f.parts).join(db.classes, cl.id == f.class_id)
                        .where(f.course_id == course_id, f.user_id == user_id, f.published == 1, cl.created_at < start)
                        .order_by(cl.created_at.desc()).limit(1)).first()
    try:
        return clean_parts(json.loads(row.parts))["next_actions"] if row and row.parts else []
    except ValueError:
        return []


def _row_json(r) -> dict:
    def load(text, default):
        try:
            return json.loads(text) if text else default
        except ValueError:
            return default
    return {"levels": load(r.levels, []), "parts": clean_parts(load(r.parts, {})), "published": bool(r.published),
            "goal_checks": load(r.goal_checks, []), "updated_at": r.updated_at}


def _course_classes(course_id: int) -> list:
    cl = db.classes.c
    with db.engine.connect() as c:
        return c.execute(select(cl.id, cl.title, cl.created_at).where(cl.course_id == course_id).order_by(cl.created_at)).all()


def _feedback_rows(course_id: int, class_id: int | None = None) -> list:
    f = db.class_feedback.c
    q = select(db.class_feedback).where(f.course_id == course_id)
    if class_id is not None:
        q = q.where(f.class_id == class_id)
    with db.engine.connect() as c:
        return c.execute(q).all()


def class_list(course_id: int) -> list[dict]:
    from datetime import datetime
    from app.achievement import KST
    rows = _feedback_rows(course_id)
    out = []
    for n, k in enumerate(_course_classes(course_id), 1):
        mine = [r for r in rows if r.class_id == k.id]
        out.append({"class_id": k.id, "no": n, "title": k.title or "", "date": datetime.fromtimestamp(k.created_at, KST).strftime("%Y-%m-%d"),
                    "made": len(mine), "published": sum(r.published for r in mine)})
    return out


def _student_class(course_id: int, user_id: int, class_id: int):
    """그 학생의 이번 수업 기록 + 바로 전 기록 있는 수업 (변화 비교용)"""
    material, standards, names = _student_material(course_id, user_id)
    idx = next((i for i, x in enumerate(material) if x["class_id"] == class_id), None)
    if idx is None:
        return None, None, standards, names
    return material[idx], (material[idx - 1] if idx > 0 else None), standards, names


def class_detail(course_id: int, class_id: int) -> dict:
    from app.courses import course_roster
    rows = {r.user_id: r for r in _feedback_rows(course_id, class_id)}
    standards, _ = standards_of(course_id)
    out, linked_ids = [], None
    for u in course_roster(course_id):
        x, _, _, _ = _student_class(course_id, u.id, class_id)
        if x is not None and linked_ids is None:
            linked_ids = x["standard_ids"] if x["linked"] else []
        r = rows.get(u.id)
        out.append({"user_id": u.id, "name": u.name or u.google_name or "", "student_no": student_no(dict(u._mapping)),
                    "school": u.school or "", "has_record": x is not None, "counts": x["counts"] if x else None,
                    **(_row_json(r) if r else {"levels": [], "parts": None, "published": False})})
    out.sort(key=lambda s: (s["school"], s["student_no"], s["name"]))
    by_id = {s["id"]: s for s in standards}
    linked = [{"standard_id": i, "code": by_id[i]["code"], "text": by_id[i]["text"]} for i in (linked_ids or []) if i in by_id]
    return {"students": out, "linked": linked, "ai": ai_ready()}


@router.get("/api/courses/{course_id}/class-feedback")
async def list_class_feedback(course_id: int, request: Request):
    await _course(course_id, request)
    return {"classes": await db.run(class_list, course_id), "ai": ai_ready()}


@router.get("/api/courses/{course_id}/class-feedback/{class_id}")
async def get_class_feedback(course_id: int, class_id: int, request: Request):
    await _course(course_id, request)
    if not any(k.id == class_id for k in await db.run(_course_classes, course_id)):
        raise HTTPException(404, "그 수업을 찾을 수 없어요.")
    return await db.run(class_detail, course_id, class_id)


async def _generate_one(course, class_id: int, user_id: int) -> str:
    """학생 한 명의 이 수업 피드백 초안을 만든다. 반환: ok | skip(기록 없음·공개 중) | 오류 메시지"""
    from app.privacy_filter import redact
    x, prev, standards, names = await db.run(_student_class, course.id, user_id, class_id)
    if x is None:
        return "skip"
    f = db.class_feedback.c

    def existing():
        with db.engine.connect() as c:
            return c.execute(select(db.class_feedback).where(f.class_id == class_id, f.user_id == user_id)).first()
    row = await db.run(existing)
    if row and row.published:
        return "skip"  # 공개한 피드백은 선생님이 고친 글일 수 있어 그대로 둔다
    by_id = {s["id"]: s for s in standards}
    used = [by_id[i] for i in x["standard_ids"] if i in by_id]
    if not used:
        return "먼저 [과목 정보]에서 성취기준을 넣어 주세요."
    key_of = {f"S{i}": s for i, s in enumerate(used, 1)}
    std_lines = "\n".join(f"[{k}] {s['code']} {s['text']}\n  수행 진술: 상) {s.get('level_high') or '-'} / 중) {s.get('level_mid') or '-'} / 하) {s.get('level_low') or '-'}"
                          for k, s in key_of.items())

    def said(m):
        return "\n".join(f"  · [응답] (선생님 발문: {redact(t['prompt'], names)}) {redact(t['text'], names)}" if t["kind"] == "응답"
                         else f"  · [자발] {redact(t['text'], names)}" for t in m.get("turns", [])) or "  (발언 기록 없음)"

    def block(m):
        notes = "\n".join(f"  · {redact(t, names)}" for t in m["notes"])
        quizzes = "\n".join(f"  · {redact(t, names)}" for t in m["quizzes"])
        return (f"[학생 발언]\n{said(m)}" + (f"\n[교사 관찰 기록]\n{notes}" if notes else "")
                + (f"\n[학생 퀴즈 응답]\n{quizzes}" if quizzes else ""))
    prompt = (f"과목: {course.subject or course.title}\n\n# 이 수업에서 다룬 성취기준(수행 진술)\n{std_lines}\n\n"
              f"# 이번 수업 ({x['date']} {x['title'] or ''})\n{block(x)}")
    if prev is not None:
        prompt += f"\n\n# 지난 수업 ({prev['date']} {prev['title'] or ''}) 기록 (비교용)\n{block(prev)}"

    goals = await db.run(previous_goals, course.id, user_id, class_id)
    if goals:
        prompt += "\n\n# 지난 피드백의 '다음 수업에서 해 보기' (goal_checks 로 판정)\n" + "\n".join(f"{i}. {g}" for i, g in enumerate(goals, 1))
    try:
        data = await ai_json(CLASS_FB_SYSTEM, prompt, class_fb_schema(list(key_of), len(goals)), 6000)
    except HTTPException as err:
        return str(err.detail)
    levels, seen = [], set()
    for r in data.get("standards") or []:
        if isinstance(r, dict) and r.get("key") in key_of and r["key"] not in seen:
            seen.add(r["key"])
            s = key_of[r["key"]]
            lv = r.get("level") if r.get("level") in (1, 2, 3) else 0
            levels.append({"standard_id": s["id"], "code": s["code"], "text": s["text"], "level": lv,
                           "evidence": str(r.get("evidence", ""))[:300] if lv else ""})
    parts = clean_parts(data.get("feedback"))
    checks, seen_no = [], set()
    for g in data.get("goal_checks") or []:
        n = g.get("no") if isinstance(g, dict) else None
        if isinstance(n, int) and 1 <= n <= len(goals) and n not in seen_no and g.get("status") in ("done", "partial", "none"):
            seen_no.add(n)
            checks.append({"goal": goals[n - 1], "status": g["status"], "evidence": str(g.get("evidence", ""))[:300] if g["status"] != "none" else ""})
    checks.sort(key=lambda x: goals.index(x["goal"]))
    now = time.time()

    def save():
        values = {"levels": json.dumps(levels, ensure_ascii=False), "parts": json.dumps(parts, ensure_ascii=False),
                  "goal_checks": json.dumps(checks, ensure_ascii=False), "updated_at": now}
        with db.engine.begin() as c:
            cur = c.execute(select(f.id).where(f.class_id == class_id, f.user_id == user_id)).first()
            if cur:
                c.execute(update(db.class_feedback).where(f.id == cur.id).values(**values))
            else:
                c.execute(insert(db.class_feedback).values(course_id=course.id, class_id=class_id, user_id=user_id,
                                                           published=0, created_at=now, **values))
    await db.run(save)
    return "ok"


class GenerateReq(BaseModel):
    user_ids: list[int] | None = Field(default=None, max_length=300)  # 비우면 기록이 있는 학생 모두


@router.post("/api/courses/{course_id}/class-feedback/{class_id}/generate")
async def generate_class_feedback(course_id: int, class_id: int, req: GenerateReq, request: Request):
    """AI 초안 만들기 (학생마다 따로 묻고, 동시에 4명씩). 이미 공개한 학생은 건너뛴다"""
    course, _ = await _course(course_id, request)
    if not ai_ready():
        raise HTTPException(503, "AI가 설정되지 않아 초안을 만들 수 없어요.")
    if not any(k.id == class_id for k in await db.run(_course_classes, course_id)):
        raise HTTPException(404, "그 수업을 찾을 수 없어요.")
    from app.courses import course_roster
    roster = [u.id for u in await db.run(course_roster, course_id)]
    targets = [i for i in (req.user_ids or roster) if i in roster]
    gate = asyncio.Semaphore(4)

    async def one(uid):
        async with gate:
            return await _generate_one(course, class_id, uid)
    results = await asyncio.gather(*(one(u) for u in targets))
    errors = sorted({r for r in results if r not in ("ok", "skip")})
    made = sum(r == "ok" for r in results)
    if errors and not made:
        raise HTTPException(502, errors[0])
    return {"made": made, "skipped": sum(r == "skip" for r in results), "errors": errors,
            **(await db.run(class_detail, course_id, class_id))}


class LevelEdit(BaseModel):
    standard_id: int
    level: int = Field(ge=0, le=3)


class ClassFeedbackReq(BaseModel):
    parts: FeedbackParts
    levels: list[LevelEdit] | None = Field(default=None, max_length=30)
    published: bool = False


@router.post("/api/courses/{course_id}/class-feedback/{class_id}/student/{user_id}")
async def save_class_feedback(course_id: int, class_id: int, user_id: int, req: ClassFeedbackReq, request: Request):
    """교사가 항목별로 고치고 공개 여부를 정한다"""
    await _course(course_id, request)
    from app.courses import course_roster
    if user_id not in {u.id for u in await db.run(course_roster, course_id)}:
        raise HTTPException(404, "이 과목 수강생이 아니에요.")
    if not any(k.id == class_id for k in await db.run(_course_classes, course_id)):
        raise HTTPException(404, "그 수업을 찾을 수 없어요.")
    parts = clean_parts(req.parts.model_dump())
    now = time.time()
    f = db.class_feedback.c

    def run():
        with db.engine.begin() as c:
            cur = c.execute(select(db.class_feedback).where(f.class_id == class_id, f.user_id == user_id)).first()
            values = {"parts": json.dumps(parts, ensure_ascii=False), "published": int(req.published), "updated_at": now}
            if req.levels is not None:
                old = json.loads(cur.levels) if cur and cur.levels else []
                want = {e.standard_id: e.level for e in req.levels}
                for lv in old:
                    if lv["standard_id"] in want:
                        lv["level"] = want[lv["standard_id"]]
                values["levels"] = json.dumps(old, ensure_ascii=False)
            if cur:
                c.execute(update(db.class_feedback).where(f.id == cur.id).values(**values))
            else:
                c.execute(insert(db.class_feedback).values(course_id=course_id, class_id=class_id, user_id=user_id,
                                                           created_at=now, **{"levels": "", **values}))
    await db.run(run)
    return {"ok": True}


class PublishAllReq(BaseModel):
    published: bool


@router.post("/api/courses/{course_id}/class-feedback/{class_id}/publish-all")
async def publish_all(course_id: int, class_id: int, req: PublishAllReq, request: Request):
    """만들어 둔 피드백을 한꺼번에 공개(또는 공개 취소)"""
    await _course(course_id, request)
    f = db.class_feedback.c

    def run():
        with db.engine.begin() as c:
            return c.execute(update(db.class_feedback).where(f.course_id == course_id, f.class_id == class_id)
                             .values(published=int(req.published), updated_at=time.time())).rowcount
    return {"changed": await db.run(run)}


@router.get("/api/my/courses/{course_id}/class-feedback")
async def my_class_feedback(course_id: int, request: Request):
    """학생: 선생님이 공개한 수업별 피드백 (최근 수업부터)"""
    u = await require_user(request, "student")
    from datetime import datetime
    from app.achievement import KST
    f, cl = db.class_feedback.c, db.classes.c

    def run():
        with db.engine.connect() as c:
            rows = c.execute(select(db.class_feedback, cl.title, cl.created_at.label("class_created"))
                             .join(db.classes, cl.id == f.class_id)
                             .where(f.course_id == course_id, f.user_id == u["id"], f.published == 1)
                             .order_by(cl.created_at.desc())).all()
        material = {x["class_id"]: x for x in _student_material(course_id, u["id"])[0]} if rows else {}
        out = []
        for r in rows:
            j = _row_json(r)
            counts = material.get(r.class_id, {}).get("counts") or {}
            out.append({"class_id": r.class_id, "title": r.title or "", "date": datetime.fromtimestamp(r.class_created, KST).strftime("%Y-%m-%d"),
                        # 학생에게는 상·중·하만 (판단 근거 문장은 교사용)
                        "standards": [{"code": x["code"], "text": x["text"], "level": x["level"]} for x in j["levels"]],
                        "parts": j["parts"], "goal_checks": [{"goal": g["goal"], "status": g["status"]} for g in j["goal_checks"]],
                        "participation": {"spontaneous": counts.get("spontaneous", 0), "response": counts.get("response", 0)}})
        return out
    return {"items": await db.run(run)}


# ───────── 학생 한 명의 회차 흐름: 발언·관찰·판단·피드백·목표 달성 ─────────

def student_timeline(course_id: int, user_id: int) -> dict:
    from datetime import datetime
    from app.achievement import KST
    material = {x["class_id"]: x for x in _student_material(course_id, user_id)[0]}
    rows = {r.class_id: r for r in _feedback_rows(course_id) if r.user_id == user_id}
    out = []
    for n, k in enumerate(_course_classes(course_id), 1):
        m, r = material.get(k.id), rows.get(k.id)
        if not m and not r:
            continue
        j = _row_json(r) if r else None
        checks = j["goal_checks"] if j else []
        score = round(100 * sum({"done": 1, "partial": 0.5}.get(g["status"], 0) for g in checks) / len(checks)) if checks else None
        out.append({"class_id": k.id, "no": n, "title": k.title or "", "date": datetime.fromtimestamp(k.created_at, KST).strftime("%Y-%m-%d"),
                    "counts": m["counts"] if m else {"talk": 0, "spontaneous": 0, "response": 0, "avg_len": 0, "quiz_rate": None},
                    "notes": m["notes"] if m else [],
                    "turns": [{"kind": t["kind"], "text": t["text"]} for t in (m.get("turns", []) if m else [])][:3],
                    "levels": j["levels"] if j else [], "feedback": j["parts"] if j else None, "published": bool(j and j["published"]),
                    "goal_checks": checks, "goal_rate": score})
    return {"classes": out, "ai": ai_ready()}


@router.get("/api/courses/{course_id}/students/{user_id}/timeline")
async def get_student_timeline(course_id: int, user_id: int, request: Request):
    await _course(course_id, request)
    return await db.run(student_timeline, course_id, user_id)


def current_goals(course_id: int, user_ids: list[int], before: float | None = None) -> dict[int, list[str]]:
    """학생마다 가장 최근에 공개한 피드백의 '다음 수업에서 해 보기' (수업 중 '오늘의 목표'로 보여 준다)"""
    f, cl = db.class_feedback.c, db.classes.c
    q = (select(f.user_id, f.parts, cl.created_at).join(db.classes, cl.id == f.class_id)
         .where(f.course_id == course_id, f.published == 1, f.user_id.in_(user_ids or [-1])))
    if before is not None:
        q = q.where(cl.created_at < before)
    with db.engine.connect() as c:
        rows = c.execute(q.order_by(cl.created_at)).all()
    out: dict[int, list[str]] = {}
    for r in rows:  # 시간순이라 마지막 것이 남는다
        try:
            goals = clean_parts(json.loads(r.parts))["next_actions"]
        except ValueError:
            goals = []
        if goals:
            out[r.user_id] = goals
    return out


async def _live_class(code: str):
    from app.classroom import get_class
    k = await get_class(code)
    if not k.course_id:
        return k, None
    with db.engine.connect() as c:
        start = c.execute(select(db.classes.c.created_at).where(db.classes.c.id == k.db_id)).scalar()
    return k, start


@router.get("/api/live/classes/{code}/my-goals")
async def my_live_goals(code: str, request: Request):
    """학생 수업 화면: 지난 피드백에서 받은 '오늘의 내 목표'"""
    u = await require_user(request)
    k, start = await _live_class(code)
    if not k.course_id:
        return {"goals": []}
    goals = await db.run(current_goals, k.course_id, [u["id"]], start)
    return {"goals": goals.get(u["id"], [])}


@router.get("/api/live/classes/{code}/goals")
async def live_goals(code: str, request: Request):
    """교사 수업 화면: 학생마다 '오늘의 목표' (발문할 때 참고)"""
    from app.classroom import is_class_teacher
    u = await require_user(request, "teacher")
    k, start = await _live_class(code)
    if not await is_class_teacher(k, u):
        raise HTTPException(403, "이 수업의 강의교사만 볼 수 있어요.")
    if not k.course_id:
        return {"goals": {}}
    from app.courses import course_roster
    ids = [r.id for r in await db.run(course_roster, k.course_id)]
    goals = await db.run(current_goals, k.course_id, ids, start)
    return {"goals": {str(i): g for i, g in goals.items()}}
