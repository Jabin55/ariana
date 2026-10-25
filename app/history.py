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
from sqlalchemy import and_, or_, select

from app import db
from app.auth import require_user, student_no
from app.courses import course_roster, hub_locked, managed_hubs, taught_course_ids, taught_filter
from app.classroom import CLASS_REVIVE_LIMIT, classes as live_classes

router = APIRouter()
KST = ZoneInfo("Asia/Seoul")
REASONS = {
    "leave": "나가기 버튼", "closed": "창 닫음·새로고침", "network": "연결 끊김",
    "kicked": "내보냄", "ended": "수업 종료", "server": "서버 재시작",
}


def kst(ts: float | None) -> str:
    return datetime.fromtimestamp(ts, KST).strftime("%H:%M:%S") if ts else ""


def day_range(day: str) -> tuple[float, float]:
    try:
        d = date.fromisoformat(day)
    except ValueError:
        raise HTTPException(400, "날짜 형식이 올바르지 않아요.")
    start = datetime(d.year, d.month, d.day, tzinfo=KST)
    return start.timestamp(), (start + timedelta(days=1)).timestamp()


def class_row(r, course_titles: dict | None = None) -> dict:
    return {
        "id": r.id, "code": r.code, "title": r.title, "created_at": r.created_at, "ended_at": r.ended_at,
        "course_id": r.course_id, "course_title": (course_titles or {}).get(r.course_id, ""),
        "target_grade": r.target_grade, "target_class": r.target_class,
        "live": r.ended_at is None and r.created_at > time.time() - CLASS_REVIVE_LIMIT,
    }


@router.get("/api/live/my-classes")
async def my_classes(request: Request):
    t = await require_user(request, "teacher")

    def run():
        with db.engine.connect() as c:
            rows = c.execute(select(db.classes).where(
                my_class_filter(c, t), db.classes.c.ended_at.is_(None),
                db.classes.c.created_at > time.time() - CLASS_REVIVE_LIMIT,
            ).order_by(db.classes.c.id.desc())).all()
            titles = dict(c.execute(select(db.courses.c.id, db.courses.c.title).where(taught_filter(t["id"]))).all())
            return rows, titles

    rows, titles = await db.run(run)
    return {"classes": [class_row(r, titles) for r in rows]}


@router.get("/api/live/history")
async def history_by_date(request: Request, day: str = Query(alias="date")):
    t = await require_user(request, "teacher")
    start, end = day_range(day)

    def run():
        with db.engine.connect() as c:
            rows = c.execute(select(db.classes).where(
                my_class_filter(c, t),
                db.classes.c.created_at >= start, db.classes.c.created_at < end,
            ).order_by(db.classes.c.created_at)).all()
            locked = locked_course_ids(c, t)
            rows = [r for r in rows if r.course_id not in locked]
            counts, qcounts = {}, {}
            for r in rows:
                counts[r.id] = len(set(c.execute(select(db.attendance.c.user_id)
                                                 .where(db.attendance.c.class_id == r.id)).scalars()))
                qcounts[r.id] = len(c.execute(select(db.questions.c.id)
                                              .where(db.questions.c.class_id == r.id)).all())
            titles = dict(c.execute(select(db.courses.c.id, db.courses.c.title).where(taught_filter(t["id"]))).all())
            return rows, counts, qcounts, titles

    rows, counts, qcounts, titles = await db.run(run)
    return {"classes": [{**class_row(r, titles), "attended": counts[r.id], "questions": qcounts[r.id],
                         "start": kst(r.created_at)} for r in rows]}


def _counts(c, rows) -> dict:
    out = {}
    for r in rows:
        out[r.id] = len(set(c.execute(select(db.attendance.c.user_id).where(db.attendance.c.class_id == r.id)).scalars()))
    return out


@router.get("/api/courses/{course_id}/classes")
async def course_classes(course_id: int, request: Request):
    """수업 운영: 이 강좌에서 연 수업들 (최근 것부터)"""
    from app.courses import owned_course
    t = await require_user(request, "teacher")
    course = await db.run(owned_course, course_id, t)
    if hub_locked(course, t):
        raise HTTPException(403, "그 거점학교 강사 활동 기간이 끝나 이 강좌의 수업 기록을 볼 수 없어요.")

    def run():
        with db.engine.connect() as c:
            rows = c.execute(select(db.classes).where(db.classes.c.course_id == course_id)
                             .order_by(db.classes.c.created_at.desc())).all()
            return rows, _counts(c, rows)

    rows, counts = await db.run(run)
    return {"classes": [{**class_row(r), "attended": counts[r.id], "start": kst(r.created_at),
                         "date": datetime.fromtimestamp(r.created_at, KST).strftime("%Y-%m-%d")} for r in rows]}


@router.get("/api/live/meetings-history")
async def meetings_history(request: Request):
    """특강·회의: 강좌와 상관없이 연 지난 모임 (최근 30개)"""
    t = await require_user(request, "teacher")

    def run():
        with db.engine.connect() as c:
            rows = c.execute(select(db.classes).where(db.classes.c.teacher_id == t["id"], db.classes.c.course_id.is_(None))
                             .order_by(db.classes.c.created_at.desc()).limit(30)).all()
            return rows, _counts(c, rows)

    rows, counts = await db.run(run)
    return {"classes": [{**class_row(r), "attended": counts[r.id], "start": kst(r.created_at),
                         "date": datetime.fromtimestamp(r.created_at, KST).strftime("%Y-%m-%d")} for r in rows]}


@router.get("/api/hub/class-log")
async def hub_class_log(request: Request):
    """거점학교 관리교사: 내 거점학교 강좌에서 언제 수업했는지 (수업 날짜·시각·길이·참여 인원)"""
    u = await require_user(request)
    hubs = managed_hubs(u)

    def run():
        co, cl = db.courses.c, db.classes.c
        with db.engine.connect() as c:
            q = select(db.courses).where(co.hub_id.is_not(None))
            if hubs is not None:
                q = q.where(co.hub_id.in_(hubs))
            courses = {x.id: x for x in c.execute(q).all()}
            rows = c.execute(select(db.classes).where(cl.course_id.in_(list(courses) or [-1]))
                             .order_by(cl.created_at.desc()).limit(500)).all()
            return courses, rows, _counts(c, rows)

    courses, rows, counts = await db.run(run)
    out = []
    for r in rows:
        co = courses[r.course_id]
        end = r.ended_at
        out.append({"id": r.id, "course_id": r.course_id, "course_title": co.title, "instructor": co.instructor,
                    "title": r.title, "date": datetime.fromtimestamp(r.created_at, KST).strftime("%Y-%m-%d"),
                    "start": kst(r.created_at)[:5], "end": kst(end)[:5] if end else "",
                    "minutes": round((end - r.created_at) / 60) if end else None,
                    "live": class_row(r)["live"], "attended": counts[r.id]})
    return {"classes": out}


def my_class_filter(c, t: dict):
    """SQL 조건: 내가 연 수업 + 내가 가르치는(팀티칭 보조교사 포함) 강좌의 수업"""
    return or_(db.classes.c.teacher_id == t["id"], db.classes.c.course_id.in_(taught_course_ids(c, t["id"]) or [-1]))


def locked_course_ids(c, t: dict) -> set[int]:
    """그 거점학교 강사 활동 기간이 끝난 강좌: 수업 기록(학생 개인정보)도 볼 수 없다."""
    rows = c.execute(select(db.courses).where(taught_filter(t["id"]), db.courses.c.hub_id.is_not(None))).all()
    return {r.id for r in rows if hub_locked(r, t)}


def _owned_class(class_id: int, t: dict):
    with db.engine.connect() as c:
        r = c.execute(select(db.classes).where(db.classes.c.id == class_id)).first()
        locked = r is not None and r.course_id is not None and r.course_id in locked_course_ids(c, t)
        mine = r is not None and (r.teacher_id == t["id"] or r.course_id in taught_course_ids(c, t["id"]))
    if not r or not mine:
        raise HTTPException(404, "수업 기록을 찾을 수 없어요.")
    if locked:
        raise HTTPException(403, "그 거점학교 강사 활동 기간이 끝나 이 수업 기록을 볼 수 없어요.")
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
        if cls.course_id:  # 강좌 수업: 승인된 수강생이 출석 대상
            roster = course_roster(cls.course_id)
        elif cls.target_grade and cls.target_class:
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
        reason = None if online else (m["left_reason"] or ("server" if m["left_at"] is None else "closed"))
        p["sessions"].append({"joined": m["joined_at"], "end": end, "online": online, "reason": reason})
        p["online"] = p["online"] or online

    out = []
    for p in people.values():
        sess = sorted(p["sessions"], key=lambda x: x["joined"])
        spans = [(x["joined"], x["end"]) for x in sess]
        first, last = min(a for a, _ in spans), max(b for _, b in spans)
        total = merged_seconds(spans)
        shown, prev_end = [], None
        for x in sess:
            gap = max(0.0, x["joined"] - prev_end) if prev_end is not None else None
            prev_end = x["end"] if prev_end is None else max(prev_end, x["end"])
            shown.append({
                "joined": kst(x["joined"]), "left": "접속 중" if x["online"] else kst(x["end"]),
                "minutes": round((x["end"] - x["joined"]) / 60, 1),
                "reason": x["reason"], "reason_text": "접속 중" if x["online"] else REASONS.get(x["reason"], x["reason"]),
                "gap_before": None if gap is None else round(gap / 60, 1),  # 직전에 나갔다가 다시 들어오기까지(분)
            })
        out.append({
            **{k: v for k, v in p.items() if k != "sessions"},
            "first_join": first, "first_join_text": kst(first),
            "last_leave": None if p["online"] else last,
            "last_leave_text": "접속 중" if p["online"] else kst(last),
            "last_reason_text": "" if p["online"] else shown[-1]["reason_text"],
            "minutes": round(total / 60),
            "away_minutes": round(max(0.0, (last - first) - total) / 60),  # 중간에 자리를 비운 시간
            "count": len(sess),
            "rejoins": len(sess) - 1,
            "sessions": shown,
        })
    # 다른 학교 학생도 함께 듣는 강좌가 있어 학교 → 학번 순으로 정렬 (학번은 학교마다 겹칠 수 있음)
    out.sort(key=lambda p: (p["school"] or "", p["student_no"] or "~", p["name"]))
    absent = [
        {"student_no": student_no(u._mapping), "name": u.name, "school": u.school or "", "email": u.email}
        for u in roster if u.id not in people
    ]
    absent.sort(key=lambda a: (a["school"], a["student_no"]))
    # 출결 목록: 들어오고 나간 기록 하나당 한 줄 (학교 → 학번 → 이름 → 접속 시각 순)
    flat = []
    for p in people.values():
        for x in sorted(p["sessions"], key=lambda x: x["joined"]):
            flat.append({"school": p["school"] or "", "student_no": p["student_no"], "name": p["name"],
                         "joined": kst(x["joined"]), "left": "접속 중" if x["online"] else kst(x["end"]),
                         "online": x["online"], "seconds": round(max(0.0, x["end"] - x["joined"])), "_t": x["joined"]})
    flat.sort(key=lambda r: (r["school"], r["student_no"] or "~", r["name"], r["_t"]))
    for r in flat:
        r.pop("_t")
    return {"class": {**class_row(cls), "start": kst(cls.created_at), "end": kst(cls.ended_at)},
            "students": out, "absent": absent, "rows": flat}


def listen_text(seconds: int) -> str:
    """청취 시간: 12분 30초"""
    m, sec = divmod(int(seconds), 60)
    return f"{m}분 {sec:02d}초" if m else f"{sec}초"


@router.get("/api/live/history/{class_id}")
async def class_history(class_id: int, request: Request):
    t = await require_user(request, "teacher")
    cls = await db.run(_owned_class, class_id, t)
    return await db.run(attendance_report, cls, t["id"])


def csv_response(rows: list[list], filename: str) -> Response:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return Response("\ufeff" + buf.getvalue(), media_type="text/csv; charset=utf-8",  # 엑셀 한글 깨짐 방지 BOM
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/api/live/history/{class_id}/attendance.csv")
async def attendance_csv(class_id: int, request: Request):
    """들어오고 나간 기록 하나당 한 줄: 학교·학번·이름·접속 시각·종료 시각·청취 시간 (학교·학번·이름 순)"""
    t = await require_user(request, "teacher")
    cls = await db.run(_owned_class, class_id, t)
    rep = await db.run(attendance_report, cls, t["id"])
    day = datetime.fromtimestamp(cls.created_at, KST).strftime("%Y-%m-%d")
    rows = [["학교", "학번", "이름", "접속 시각", "종료 시각", "청취 시간"]]
    for r in rep["rows"]:
        rows.append([r["school"], r["student_no"], r["name"], r["joined"], r["left"], listen_text(r["seconds"])])
    for a in rep["absent"]:
        rows.append([a["school"], a["student_no"], a["name"], "미접속", "", ""])
    return csv_response(rows, f"attendance-{day}-{cls.code}.csv")


@router.get("/api/live/history/{class_id}/attendance-log.csv")
async def attendance_log_csv(class_id: int, request: Request):
    """들어오고 나간 기록 하나당 한 줄 (재입장까지 모두)"""
    t = await require_user(request, "teacher")
    cls = await db.run(_owned_class, class_id, t)
    rep = await db.run(attendance_report, cls, t["id"])
    day = datetime.fromtimestamp(cls.created_at, KST).strftime("%Y-%m-%d")
    rows = [["날짜", "수업", "학번", "이름", "순서", "들어옴", "나감", "나간 사유", "머문 시간(분)", "직전 이탈 후 다시 들어오기까지(분)"]]
    for p in rep["students"]:
        for i, x in enumerate(p["sessions"], 1):
            rows.append([day, cls.title, p["student_no"], p["name"], i, x["joined"], x["left"], x["reason_text"],
                         x["minutes"], "" if x["gap_before"] is None else x["gap_before"]])
    return csv_response(rows, f"attendance-log-{day}-{cls.code}.csv")


def _questions(class_id: int, user_id: int | None = None) -> list[dict]:
    """수업 중 '선생님께 질문'과 답변. user_id 를 주면 그 학생 것만."""
    with db.engine.connect() as c:
        q = (select(db.questions, db.users, db.classes.c.title, db.classes.c.code,
                    db.classes.c.created_at.label("class_created"))
             .join(db.users, db.users.c.id == db.questions.c.user_id)
             .join(db.classes, db.classes.c.id == db.questions.c.class_id))
        q = q.where(db.questions.c.class_id == class_id) if class_id else q.where(db.questions.c.user_id == user_id)
        rows = c.execute(q.order_by(db.questions.c.created_at)).all()
    out = []
    for r in rows:
        m = r._mapping
        out.append({
            "student_no": student_no(m), "name": m["name"] or m["google_name"], "school": m["school"] or "",
            "class_title": m["title"], "class_code": m["code"],
            "date": datetime.fromtimestamp(m["class_created"], KST).strftime("%Y-%m-%d"),
            "time": kst(m["created_at"]), "text": m["text"], "reply": m["reply"] or "",
            "reply_time": kst(m["replied_at"]), "done": bool(m["done"]),
        })
    return out


@router.get("/api/live/history/{class_id}/questions")
async def class_questions(class_id: int, request: Request):
    t = await require_user(request, "teacher")
    await db.run(_owned_class, class_id, t)
    return {"questions": await db.run(_questions, class_id)}


@router.get("/api/live/history/{class_id}/questions.csv")
async def class_questions_csv(class_id: int, request: Request):
    t = await require_user(request, "teacher")
    cls = await db.run(_owned_class, class_id, t)
    qs = await db.run(_questions, class_id)
    day = datetime.fromtimestamp(cls.created_at, KST).strftime("%Y-%m-%d")
    rows = [["날짜", "수업", "학교", "학번", "이름", "질문 시각", "질문", "답변 시각", "답변", "확인"]]
    for q in qs:
        rows.append([day, cls.title, q["school"], q["student_no"], q["name"], q["time"], q["text"],
                     q["reply_time"], q["reply"], "확인함" if q["done"] else ""])
    return csv_response(rows, f"questions-{day}-{cls.code}.csv")


@router.get("/api/live/my-questions")
async def my_questions(request: Request):
    """학생: 지난 수업들에서 선생님께 한 질문과 받은 답변"""
    u = await require_user(request, "student")
    qs = await db.run(_questions, 0, u["id"])
    return {"questions": [{k: q[k] for k in ("class_title", "date", "time", "text", "reply", "reply_time")}
                          for q in reversed(qs[-100:])]}


@router.get("/api/live/history/{class_id}/results.csv")
async def results_csv(class_id: int, request: Request):
    t = await require_user(request, "teacher")
    cls = await db.run(_owned_class, class_id, t)
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
