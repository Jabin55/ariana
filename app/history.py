"""선생님용 기록 조회: 날짜별 수업 목록, 학생별 접속·종료 시각, 퀴즈 결과 CSV."""

from __future__ import annotations

import csv
import io
import json
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy import and_, select

from app import db
from app.auth import require_user, student_no
from app.classroom import CLASS_REVIVE_LIMIT, classes as live_classes

router = APIRouter()
KST = ZoneInfo("Asia/Seoul")


def kst(ts: float | None) -> str:
    return datetime.fromtimestamp(ts, KST).strftime("%H:%M:%S") if ts else ""


def day_range(day: str) -> tuple[float, float]:
    try:
        d = date.fromisoformat(day)
    except ValueError:
        raise HTTPException(400, "날짜 형식이 올바르지 않아요.")
    start = datetime(d.year, d.month, d.day, tzinfo=KST)
    return start.timestamp(), (start + timedelta(days=1)).timestamp()


def class_row(r) -> dict:
    return {
        "id": r.id, "code": r.code, "title": r.title, "created_at": r.created_at, "ended_at": r.ended_at,
        "target_grade": r.target_grade, "target_class": r.target_class,
        "live": r.ended_at is None and r.created_at > time.time() - CLASS_REVIVE_LIMIT,
    }


@router.get("/api/live/my-classes")
async def my_classes(request: Request):
    t = await require_user(request, "teacher")

    def run():
        with db.engine.connect() as c:
            return c.execute(select(db.classes).where(
                db.classes.c.teacher_id == t["id"], db.classes.c.ended_at.is_(None),
                db.classes.c.created_at > time.time() - CLASS_REVIVE_LIMIT,
            ).order_by(db.classes.c.id.desc())).all()

    return {"classes": [class_row(r) for r in await db.run(run)]}


@router.get("/api/live/history")
async def history_by_date(request: Request, day: str = Query(alias="date")):
    t = await require_user(request, "teacher")
    start, end = day_range(day)

    def run():
        with db.engine.connect() as c:
            rows = c.execute(select(db.classes).where(
                db.classes.c.teacher_id == t["id"],
                db.classes.c.created_at >= start, db.classes.c.created_at < end,
            ).order_by(db.classes.c.created_at)).all()
            counts = {}
            for r in rows:
                counts[r.id] = len(set(c.execute(select(db.attendance.c.user_id)
                                                 .where(db.attendance.c.class_id == r.id)).scalars()))
            return rows, counts

    rows, counts = await db.run(run)
    return {"classes": [{**class_row(r), "attended": counts[r.id], "start": kst(r.created_at)} for r in rows]}


def _owned_class(class_id: int, teacher_id: int):
    with db.engine.connect() as c:
        r = c.execute(select(db.classes).where(db.classes.c.id == class_id)).first()
    if not r or r.teacher_id != teacher_id:
        raise HTTPException(404, "수업 기록을 찾을 수 없어요.")
    return r


def merged_seconds(spans: list[tuple[float, float]]) -> float:
    """여러 탭으로 겹쳐 접속한 시간은 한 번만 센다."""
    total, cur_s, cur_e = 0.0, None, None
    for s, e in sorted(spans):
        if cur_e is None or s > cur_e:
            if cur_e is not None:
                total += cur_e - cur_s
            cur_s, cur_e = s, e
        else:
            cur_e = max(cur_e, e)
    if cur_e is not None:
        total += cur_e - cur_s
    return total


def attendance_report(cls, teacher_id: int) -> dict:
    now = time.time()
    live = live_classes.get(cls.code)
    live = live if live and live.db_id == cls.id else None
    with db.engine.connect() as c:
        rows = c.execute(
            select(db.attendance, db.users)
            .join(db.users, db.users.c.id == db.attendance.c.user_id)
            .where(db.attendance.c.class_id == cls.id)
            .order_by(db.attendance.c.joined_at)
        ).all()
        roster = []
        if cls.target_grade and cls.target_class:
            cond = [db.users.c.role == "student", db.users.c.grade == cls.target_grade,
                    db.users.c.class_no == cls.target_class]
            if cls.school:
                cond.append(db.users.c.school == cls.school)
            roster = c.execute(select(db.users).where(and_(*cond))).all()

    people: dict[int, dict] = {}
    for r in rows:
        m = r._mapping
        uid = m["user_id"]
        online = m["left_at"] is None and live is not None and str(uid) in live.students \
            and live.students[str(uid)].conns > 0
        end = m["left_at"] or (now if online else m["last_seen"])
        p = people.setdefault(uid, {
            "user_id": uid, "student_no": student_no(m), "name": m["name"] or m["google_name"],
            "school": m["school"], "email": m["email"], "sessions": [], "online": False,
        })
        p["sessions"].append({"joined": m["joined_at"], "left": None if online else end, "_end": end})
        p["online"] = p["online"] or online

    out = []
    for p in people.values():
        spans = [(s["joined"], s["_end"]) for s in p["sessions"]]
        out.append({
            **{k: v for k, v in p.items() if k != "sessions"},
            "first_join": min(s for s, _ in spans), "first_join_text": kst(min(s for s, _ in spans)),
            "last_leave": None if p["online"] else max(e for _, e in spans),
            "last_leave_text": "접속 중" if p["online"] else kst(max(e for _, e in spans)),
            "minutes": round(merged_seconds(spans) / 60),
            "count": len(p["sessions"]),
            "sessions": [{"joined": kst(s["joined"]), "left": kst(s["left"]) if s["left"] else "접속 중"}
                         for s in p["sessions"]],
        })
    out.sort(key=lambda p: (p["student_no"] or "~", p["name"]))
    absent = [
        {"student_no": student_no(u._mapping), "name": u.name, "email": u.email}
        for u in roster if u.id not in people
    ]
    absent.sort(key=lambda a: a["student_no"])
    return {"class": {**class_row(cls), "start": kst(cls.created_at), "end": kst(cls.ended_at)},
            "students": out, "absent": absent}


@router.get("/api/live/history/{class_id}")
async def class_history(class_id: int, request: Request):
    t = await require_user(request, "teacher")
    cls = await db.run(_owned_class, class_id, t["id"])
    return await db.run(attendance_report, cls, t["id"])


def csv_response(rows: list[list], filename: str) -> Response:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",  # 엑셀 한글 깨짐 방지 BOM
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/api/live/history/{class_id}/attendance.csv")
async def attendance_csv(class_id: int, request: Request):
    t = await require_user(request, "teacher")
    cls = await db.run(_owned_class, class_id, t["id"])
    rep = await db.run(attendance_report, cls, t["id"])
    day = datetime.fromtimestamp(cls.created_at, KST).strftime("%Y-%m-%d")
    rows = [["날짜", "수업", "학번", "이름", "학교", "이메일", "첫 접속", "마지막 종료", "접속 시간(분)", "접속 횟수", "접속 기록"]]
    for p in rep["students"]:
        rows.append([day, cls.title, p["student_no"], p["name"], p["school"], p["email"],
                     p["first_join_text"], p["last_leave_text"], p["minutes"], p["count"],
                     " / ".join(f"{s['joined']}~{s['left']}" for s in p["sessions"])])
    for a in rep["absent"]:
        rows.append([day, cls.title, a["student_no"], a["name"], "", a["email"], "미접속", "", 0, 0, ""])
    return csv_response(rows, f"attendance-{day}-{cls.code}.csv")


@router.get("/api/live/history/{class_id}/results.csv")
async def results_csv(class_id: int, request: Request):
    t = await require_user(request, "teacher")
    cls = await db.run(_owned_class, class_id, t["id"])
    live = live_classes.get(cls.code)
    current = live.activity if live and live.db_id == cls.id else None

    def run():
        with db.engine.connect() as c:
            acts = [dict(r._mapping) for r in c.execute(
                select(db.activities).where(db.activities.c.class_id == cls.id).order_by(db.activities.c.created_at))]
            ids = set()
            for a in acts:
                ids |= {int(k) for k in json.loads(a["responses"])}
            if current:
                ids |= {int(k) for k in current["responses"]}
            names = {u.id: u._mapping for u in c.execute(select(db.users).where(db.users.c.id.in_(ids or {-1})))}
            return acts, names

    acts, names = await db.run(run)
    acts = [{"kind": a["kind"], "prompt": a["prompt"], "options": json.loads(a["options"]),
             "correct": a["correct"], "responses": json.loads(a["responses"]), "id": a["id"]} for a in acts]
    if current and not current.get("db_id"):
        acts.append(current)
    elif current:  # 아직 저장되지 않은 최신 응답으로 바꿔 보여 준다
        acts = [current if a["id"] == current["db_id"] else a for a in acts]
    kinds = {"ox": "OX", "choice": "객관식", "poll": "투표", "text": "주관식"}
    rows = [["활동 번호", "유형", "문제", "학번", "이름", "응답", "정답 여부"]]
    for i, a in enumerate(acts, 1):
        for uid, v in a["responses"].items():
            u = names.get(int(uid))
            shown = a["options"][v] if isinstance(v, int) and v < len(a["options"]) else v
            ok = "" if a["correct"] is None else ("O" if v == a["correct"] else "X")
            rows.append([i, kinds.get(a["kind"], a["kind"]), a["prompt"],
                         student_no(u) if u else "", (u["name"] or u["google_name"]) if u else "(알 수 없음)", shown, ok])
    day = datetime.fromtimestamp(cls.created_at, KST).strftime("%Y-%m-%d")
    return csv_response(rows, f"results-{day}-{cls.code}.csv")
