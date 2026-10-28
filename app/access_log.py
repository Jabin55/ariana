"""개인정보취급자 접속기록.

교사·관리자가 학생 개인정보를 조회·내려받기·수정·삭제할 때 '누가·언제·어디서(IP)·누구 정보를·무엇을' 남긴다
(개인정보의 안전성 확보조치 기준 제8조). 365일 보관하고, 지나면 자동으로 지운다.
기록은 요청을 처리한 뒤 경로별 규칙으로 한곳에서 남긴다. 학생 본인의 요청은 남기지 않는다.
"""

from __future__ import annotations

import logging
import re
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, insert, select

from app import db

log = logging.getLogger("access_log")
KEEP_DAYS = 365

# (방식, 경로, 행위, 무엇을)
_RULES = [
    ("GET", r"/api/courses/(?P<course>\d+)/enrollments", "조회", "강좌 수강생 명단"),
    ("POST", r"/api/courses/(?P<course>\d+)/enrollments/(?P<user>\d+)", "수정", "수강 승인·반려"),
    ("POST", r"/api/courses/(?P<course>\d+)/approve-all", "수정", "수강 일괄 승인"),
    ("GET", r"/api/hub/overview", "조회", "거점학교 현황"),
    ("GET", r"/api/hub/course-requests", "조회", "희망 과목 신청 현황"),
    ("GET", r"/api/hub/class-log", "조회", "수업 운영 기록"),
    ("GET", r"/api/hub/courses/(?P<course>\d+)/attendance", "조회", "출석부"),
    ("GET", r"/api/school/overview", "조회", "우리 학교 학생 현황"),
    ("POST", r"/api/school/withdrawals/(?P<user>\d+)", "삭제", "학생 탈퇴 처리"),
    ("GET", r"/api/school/change-requests", "조회", "정보 변경 요청 목록"),
    ("POST", r"/api/school/change-requests/\d+", "수정", "정보 변경 요청 처리"),
    ("GET", r"/api/staff/applications", "조회", "교사 가입 신청 목록"),
    ("POST", r"/api/staff/\d+", "수정", "교사 가입 승인·반려"),
    ("GET", r"/api/admin/change-requests", "조회", "이름·소속 변경 요청 목록"),
    ("POST", r"/api/admin/change-requests/\d+", "수정", "이름·소속 변경 처리"),
    ("GET", r"/api/admin/users", "조회", "회원 검색"),
    ("POST", r"/api/admin/users/(?P<user>\d+)/name", "수정", "회원 이름 수정"),
    ("GET", r"/api/admin/access-logs", "조회", "접속 기록"),
    ("GET", r"/api/courses/(?P<course>\d+)/learning", "조회", "학습 기록"),
    ("GET", r"/api/live/history/(?P<class>\d+)", "조회", "수업 기록(출결·답안)"),
    ("GET", r"/api/live/history/(?P<class>\d+)/questions", "조회", "수업 질문"),
    ("GET", r"/api/live/history/(?P<class>\d+)/grades", "조회", "성적"),
    ("GET", r"/api/live/history/(?P<class>\d+)/(?P<file>[\w-]+\.csv)", "다운로드", "수업 기록 파일"),
    ("POST", r"/api/live/history/(?P<class>\d+)/activities/\d+/(points|grade)", "수정", "채점"),
    ("POST", r"/api/live/history/(?P<class>\d+)/publish", "수정", "결과 공개"),
    ("GET", r"/api/assignments/(?P<assignment>\d+)/submissions", "조회", "과제 제출물"),
    ("POST", r"/api/assignments/(?P<assignment>\d+)/grade", "수정", "과제 채점"),
    ("GET", r"/api/assignments/(?P<assignment>\d+)/download\.zip", "다운로드", "과제 제출 파일 전체"),
    ("GET", r"/api/submission-files/\d+", "다운로드", "과제 제출 파일"),
    ("GET", r"/api/evidence/(?P<archive>\d+)", "조회", "수업 증빙 보관함"),
    ("GET", r"/api/evidence/(?P<archive>\d+)/download\.zip", "다운로드", "수업 증빙 보관함"),
]
_COMPILED = [(m, re.compile(p + r"/?$"), a, w) for m, p, a, w in _RULES]


def match(method: str, path: str):
    for m, rx, action, what in _COMPILED:
        if m == method:
            hit = rx.match(path)
            if hit:
                return action, what, {k: v for k, v in hit.groupdict().items() if v}
    return None


def _target(c, params: dict) -> str:
    parts = []
    if "course" in params:
        t = c.execute(select(db.courses.c.title).where(db.courses.c.id == int(params["course"]))).scalar()
        parts.append(f"강좌 {t or '#' + params['course']}")
    if "class" in params:
        t = c.execute(select(db.classes.c.title).where(db.classes.c.id == int(params["class"]))).scalar()
        parts.append(f"수업 {t or '#' + params['class']}")
    if "assignment" in params:
        t = c.execute(select(db.assignments.c.title).where(db.assignments.c.id == int(params["assignment"]))).scalar()
        parts.append(f"과제 {t or '#' + params['assignment']}")
    if "archive" in params:
        parts.append(f"보관함 #{params['archive']}")
    if "user" in params:
        r = c.execute(select(db.users.c.name, db.users.c.school).where(db.users.c.id == int(params["user"]))).first()
        parts.append(f"회원 {r.name} ({r.school})" if r and r.name else f"회원 #{params['user']}")
    if "file" in params:
        parts.append(params["file"])
    return " · ".join(parts)[:200]


def record(uid: int, ip: str, action: str, what: str, params: dict | None = None, path: str = "") -> None:
    from app.auth import ADMIN_EMAILS

    with db.engine.begin() as c:
        u = c.execute(select(db.users.c.name, db.users.c.email, db.users.c.role).where(db.users.c.id == uid)).first()
        if not u or (u.role == "student" and u.email.lower() not in ADMIN_EMAILS):
            return  # 학생이 자기 정보를 보는 것은 접속기록 대상이 아니다
        c.execute(insert(db.access_logs).values(
            at=time.time(), actor_id=uid, actor_name=(u.name or "")[:60], actor_email=u.email[:200],
            ip=(ip or "")[:64], action=action, what=what[:80], target=_target(c, params or {}), path=path[:200]))


def purge_old(now: float | None = None) -> int:
    cutoff = (now or time.time()) - KEEP_DAYS * 86400
    with db.engine.begin() as c:
        return c.execute(delete(db.access_logs).where(db.access_logs.c.at < cutoff)).rowcount or 0


def client_ip(scope) -> str:
    client = scope.get("client")
    return client[0] if client else ""


class AccessLogMiddleware:
    """요청을 처리한 뒤, 학생 정보를 다루는 경로이고 성공했으면 접속기록을 남긴다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        hit = match(scope["method"], scope["path"])
        if not hit:
            return await self.app(scope, receive, send)
        status = {}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        await self.app(scope, receive, send_wrapper)
        uid = (scope.get("session") or {}).get("uid")
        if uid and status.get("code", 500) < 400:
            action, what, params = hit
            try:
                await db.run(record, uid, client_ip(scope), action, what, params, scope["path"])
            except Exception:
                log.exception("접속기록 저장 실패")


router = APIRouter()


class Export(BaseModel):
    what: str = Field(min_length=1, max_length=80)


@router.post("/api/access-log/export")
async def log_export(body: Export, request: Request):
    """화면에서 바로 만드는 엑셀(CSV) 내려받기도 기록한다."""
    from app.auth import require_user

    u = await require_user(request)
    await db.run(record, u["id"], client_ip(request.scope), "다운로드", body.what, None, "/api/access-log/export")
    return {"ok": True}


@router.get("/api/admin/access-logs")
async def list_logs(request: Request, q: str = "", action: str = "", days: int = 30, size: int = 30, page: int = 1):
    """접속 기록 목록: 한 쪽에 size(30·50·100)개씩, page쪽 (최근 것부터)"""
    from app.auth import require_user

    u = await require_user(request)
    if not u["is_admin"]:
        raise HTTPException(403, "전체 관리자만 볼 수 있어요.")
    days = max(1, min(days, KEEP_DAYS))
    size = size if size in (30, 50, 100) else 30
    page = max(1, page)

    def load():
        t = db.access_logs.c
        stmt = select(db.access_logs).where(t.at >= time.time() - days * 86400)
        if action:
            stmt = stmt.where(t.action == action)
        if q.strip():
            like = f"%{q.strip()}%"
            stmt = stmt.where(t.actor_name.like(like) | t.actor_email.like(like) | t.target.like(like)
                              | t.what.like(like) | t.ip.like(like))
        with db.engine.begin() as c:
            total = c.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0
            rows = [dict(r._mapping) for r in c.execute(stmt.order_by(t.at.desc()).limit(size).offset((page - 1) * size))]
            return total, rows

    total, rows = await db.run(load)
    return {"logs": rows, "total": total, "page": page, "size": size, "keep_days": KEEP_DAYS}
