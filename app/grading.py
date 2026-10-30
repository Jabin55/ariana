"""수업이 끝난 뒤 퀴즈·활동 답안 보기와 채점.

- 객관식·OX: 정답을 정해 둔 문제는 자동 채점(맞으면 배점, 틀리면 0). 선생님이 점수를 바꿀 수도 있다.
- 주관식(또는 정답 없는 객관식): 선생님이 점수와 피드백을 준다. 매기기 전에는 '미채점'.
- 투표: 채점하지 않는다.
- 선생님이 '학생에게 공개'를 켜면 학생은 첫 화면에서 자기 답·점수·피드백을 본다.
"""

from __future__ import annotations

import json
import time
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from app import db
from app.auth import admin_user_ids, require_user, student_no
from app.history import KST, _owned_class, csv_response

router = APIRouter()
KINDS = {"ox": "OX", "choice": "객관식", "poll": "투표", "text": "주관식"}


def _activities(class_id: int):
    with db.engine.connect() as c:
        acts = [dict(r._mapping) for r in c.execute(
            select(db.activities).where(db.activities.c.class_id == class_id).order_by(db.activities.c.created_at))]
        ids = [a["id"] for a in acts]
        grades = {}
        if ids:
            for g in c.execute(select(db.grades).where(db.grades.c.activity_id.in_(ids))):
                grades[(g.activity_id, g.user_id)] = dict(g._mapping)
        # 채점 대상: 이 수업에 들어온 학생 + 답을 낸 학생
        uids = set(c.execute(select(db.attendance.c.user_id).where(db.attendance.c.class_id == class_id)).scalars())
        for a in acts:
            uids |= {int(u) for u in json.loads(a["responses"])}
        uids -= admin_user_ids(c)  # 전체 관리자는 채점 대상이 아니다
        users = {u.id: dict(u._mapping) for u in c.execute(select(db.users).where(db.users.c.id.in_(uids or {-1})))}
    return acts, grades, users


def score_of(a: dict, value, grade: dict | None) -> float | None:
    """None = 미채점(또는 채점하지 않는 투표)."""
    if a["kind"] == "poll":
        return None
    if grade and grade["score"] is not None:
        return grade["score"]
    if value is None:  # 답을 내지 않으면 0점 (선생님이 바꿀 수 있음)
        return 0.0
    if a["correct"] is not None:
        return float(a["points"]) if value == a["correct"] else 0.0
    return None


def shown(a: dict, value) -> str:
    if value is None:
        return ""
    if isinstance(value, int) and a["options"] and value < len(a["options"]):
        return a["options"][value]
    if isinstance(value, list):  # 여러 개 고른 설문
        return ", ".join(shown(a, x) for x in value)
    return str(value)


def gradebook(cls) -> dict:
    acts, grades, users = _activities(cls.id)
    people = sorted(users.values(), key=lambda u: (u["school"] or "", student_no(u) or "~", u["name"] or ""))
    out_acts = []
    totals = {u["id"]: {"score": 0.0, "max": 0.0, "ungraded": 0} for u in people}
    for i, a in enumerate(acts, 1):
        a["options"] = json.loads(a["options"])
        responses = {int(k): v for k, v in json.loads(a["responses"]).items()}
        rows = []
        for u in people:
            v = responses.get(u["id"])
            g = grades.get((a["id"], u["id"]))
            sc = score_of(a, v, g)
            if a["kind"] != "poll":
                totals[u["id"]]["max"] += a["points"]
                if sc is None:
                    totals[u["id"]]["ungraded"] += 1
                else:
                    totals[u["id"]]["score"] += sc
            rows.append({
                "user_id": u["id"], "student_no": student_no(u), "name": u["name"] or u["google_name"],
                "school": u["school"] or "", "answered": v is not None, "answer": shown(a, v),
                "correct": None if a["correct"] is None or v is None else v == a["correct"],
                "score": sc, "manual": bool(g and g["score"] is not None),
                "feedback": (g or {}).get("feedback", ""),
            })
        out_acts.append({
            "id": a["id"], "no": i, "kind": a["kind"], "kind_name": KINDS.get(a["kind"], a["kind"]),
            "prompt": a["prompt"], "options": a["options"], "points": a["points"],
            "correct_answer": shown(a, a["correct"]) if a["correct"] is not None else "",
            "gradable": a["kind"] != "poll", "auto": a["correct"] is not None, "rows": rows,
        })
    summary = [{"user_id": u["id"], "student_no": student_no(u), "name": u["name"] or u["google_name"],
                "school": u["school"] or "",
                **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in totals[u["id"]].items()}}
               for u in people]
    return {"public": bool(cls.results_public), "activities": out_acts, "summary": summary}


@router.get("/api/live/history/{class_id}/grades")
async def get_grades(class_id: int, request: Request):
    t = await require_user(request, "teacher")
    cls = await db.run(_owned_class, class_id, t)
    return await db.run(gradebook, cls)


def _activity_in_class(activity_id: int, class_id: int):
    with db.engine.connect() as c:
        a = c.execute(select(db.activities).where(db.activities.c.id == activity_id)).first()
    if not a or a.class_id != class_id:
        raise HTTPException(404, "활동을 찾을 수 없어요.")
    return a


class PointsReq(BaseModel):
    points: float = Field(ge=0, le=1000)


@router.post("/api/live/history/{class_id}/activities/{activity_id}/points")
async def set_points(class_id: int, activity_id: int, req: PointsReq, request: Request):
    t = await require_user(request, "teacher")
    await db.run(_owned_class, class_id, t)
    await db.run(_activity_in_class, activity_id, class_id)

    def run():
        with db.engine.begin() as c:
            c.execute(update(db.activities).where(db.activities.c.id == activity_id).values(points=req.points))

    await db.run(run)
    return {"ok": True}


class GradeReq(BaseModel):
    user_id: int
    score: float | None = Field(default=None, ge=0, le=1000)  # None = 자동 채점으로 되돌리기 / 미채점
    feedback: str = Field(default="", max_length=1000)


@router.post("/api/live/history/{class_id}/activities/{activity_id}/grade")
async def set_grade(class_id: int, activity_id: int, req: GradeReq, request: Request):
    t = await require_user(request, "teacher")
    await db.run(_owned_class, class_id, t)
    a = await db.run(_activity_in_class, activity_id, class_id)
    def target_allowed():
        with db.engine.connect() as c:
            active = c.execute(select(db.users.c.id).where(db.users.c.id == req.user_id,
                               db.users.c.account_state == "active")).first()
            attended = c.execute(select(db.attendance.c.id).where(db.attendance.c.class_id == class_id,
                                 db.attendance.c.user_id == req.user_id)).first()
        return bool(active and (attended or str(req.user_id) in json.loads(a.responses or "{}")))
    if not await db.run(target_allowed):
        raise HTTPException(404, "이 수업의 평가 대상 학생을 찾을 수 없어요.")
    if req.score is not None and req.score > a.points:
        raise HTTPException(400, f"배점({a.points:g}점)보다 큰 점수는 줄 수 없어요.")

    def run():
        with db.engine.begin() as c:
            g = db.grades.c
            row = c.execute(select(g.id).where(g.activity_id == activity_id, g.user_id == req.user_id)).first()
            values = {"score": req.score, "feedback": req.feedback.strip(), "graded_at": time.time()}
            if row:
                c.execute(update(db.grades).where(g.id == row.id).values(**values))
            else:
                c.execute(db.grades.insert().values(activity_id=activity_id, user_id=req.user_id, **values))

    await db.run(run)
    return {"ok": True}


class PublishReq(BaseModel):
    on: bool


@router.post("/api/live/history/{class_id}/publish")
async def publish(class_id: int, req: PublishReq, request: Request):
    t = await require_user(request, "teacher")
    await db.run(_owned_class, class_id, t)

    def run():
        with db.engine.begin() as c:
            c.execute(update(db.classes).where(db.classes.c.id == class_id).values(results_public=int(req.on)))

    await db.run(run)
    return {"ok": True}


@router.get("/api/live/history/{class_id}/grades.csv")
async def grades_csv(class_id: int, request: Request):
    t = await require_user(request, "teacher")
    cls = await db.run(_owned_class, class_id, t)
    book = await db.run(gradebook, cls)
    day = datetime.fromtimestamp(cls.created_at, KST).strftime("%Y-%m-%d")
    acts = [a for a in book["activities"] if a["gradable"]]
    head = ["학교", "학번", "이름"] + [f"{a['no']}. {a['prompt'][:20]} ({a['points']:g}점)" for a in acts] + ["총점", "만점", "미채점"]
    rows = [head]
    for p in book["summary"]:
        line = [p["school"], p["student_no"], p["name"]]
        for a in acts:
            r = next(r for r in a["rows"] if r["user_id"] == p["user_id"])
            line.append("" if r["score"] is None else f"{r['score']:g}")
        rows.append(line + [f"{p['score']:g}", f"{p['max']:g}", p["ungraded"]])
    rows.append([])
    rows.append(["학교", "학번", "이름", "문제", "답", "점수", "배점", "피드백"])
    for a in acts:
        for r in a["rows"]:
            rows.append([r["school"], r["student_no"], r["name"], f"{a['no']}. {a['prompt']}", r["answer"] or "(미응답)",
                         "미채점" if r["score"] is None else f"{r['score']:g}", f"{a['points']:g}", r["feedback"]])
    return csv_response(rows, f"grades-{day}-{cls.code}.csv")


def _my_results(user_id: int) -> list[dict]:
    with db.engine.connect() as c:
        class_ids = set(c.execute(select(db.attendance.c.class_id).where(db.attendance.c.user_id == user_id)).scalars())
        cls_rows = c.execute(select(db.classes).where(
            db.classes.c.id.in_(class_ids or {-1}), db.classes.c.results_public == 1
        ).order_by(db.classes.c.created_at.desc()).limit(30)).all()
    out = []
    for cls in cls_rows:
        book = gradebook(cls)
        items, total, maxi = [], 0.0, 0.0
        for a in book["activities"]:
            if not a["gradable"]:
                continue
            r = next((r for r in a["rows"] if r["user_id"] == user_id), None)
            if not r:
                continue
            maxi += a["points"]
            total += r["score"] or 0
            items.append({"no": a["no"], "kind": a["kind_name"], "prompt": a["prompt"], "answer": r["answer"],
                          "correct_answer": a["correct_answer"], "score": r["score"], "points": a["points"],
                          "feedback": r["feedback"]})
        if items:
            out.append({"class_id": cls.id, "course_id": cls.course_id, "title": cls.title, "date": datetime.fromtimestamp(cls.created_at, KST).strftime("%Y-%m-%d"),
                        "score": round(total, 2), "max": round(maxi, 2), "items": items})
    return out


@router.get("/api/live/my-results")
async def my_results(request: Request):
    """학생: 선생님이 공개한 수업의 내 답·점수·피드백"""
    u = await require_user(request, "student")
    return {"classes": await db.run(_my_results, u["id"])}
