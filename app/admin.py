"""강사 등록 신청(누구나) → 관리자 승인.

관리자는 승인할 때 구분(정규 강사 / 보충수업 강사)과 활동 기간을 정한다.
활동 기간이 지나거나 권한을 해제하면 바로 강사 기능을 쓸 수 없다(수업 기록은 남는다).
"""

from __future__ import annotations

import time
from datetime import date

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, update

from app import db
from app import auth
from app.auth import PLEDGE, current_user, instructor_view, today_kst

router = APIRouter()
KINDS = {"regular": "정규 강사", "supplementary": "보충수업 강사"}


async def require_admin(request: Request) -> dict:
    u = await current_user(request)
    if not u:
        raise HTTPException(401, "로그인이 필요해요.")
    if not u["is_admin"]:
        raise HTTPException(403, "관리자만 할 수 있어요.")
    return u


# ───────────────────────── 강사 등록 신청 ─────────────────────────


class ApplyReq(BaseModel):
    name: str = Field(min_length=1, max_length=30)
    affiliation: str = Field(default="", max_length=60)  # 소속 (없으면 비움)
    contact: str = Field(min_length=1, max_length=100)  # 연락처 (전화·이메일)
    message: str = Field(default="", max_length=500)  # 강의 계획 등 하고 싶은 말
    pledge: bool  # 개인정보 보호 서약 동의


@router.post("/api/instructor/apply")
async def apply(req: ApplyReq, request: Request):
    u = await current_user(request)
    if not u:
        raise HTTPException(401, "로그인이 필요해요.")
    if u["email"].lower() in auth.TEACHER_EMAILS | auth.ADMIN_EMAILS:
        raise HTTPException(409, "이미 강사로 등록된 계정이에요.")
    if not req.pledge:
        raise HTTPException(400, "개인정보 보호 서약에 동의해야 신청할 수 있어요.")
    now = time.time()

    def run():
        i = db.instructors.c
        with db.engine.begin() as c:
            c.execute(update(db.users).where(db.users.c.id == u["id"])
                      .values(name=req.name.strip(), school=req.affiliation.strip()))
            row = c.execute(select(db.instructors).where(i.user_id == u["id"])).first()
            values = {"contact": req.contact.strip(), "message": req.message.strip(), "pledge_at": now,
                      "requested_at": now}
            if row and row.status == "approved":
                # 이미 승인된 강사가 연락처 등을 고치는 경우: 승인 상태는 그대로
                values.pop("requested_at")
                c.execute(update(db.instructors).where(i.id == row.id).values(**values))
            elif row:  # 대기 중 수정, 또는 거절·해제 뒤 다시 신청
                c.execute(update(db.instructors).where(i.id == row.id)
                          .values(status="pending", decided_at=None, **values))
            else:
                c.execute(insert(db.instructors).values(user_id=u["id"], status="pending", **values))

    await db.run(run)
    return {"ok": True, "pledge": PLEDGE}


# ───────────────────────── 관리자 ─────────────────────────


@router.get("/api/admin/instructors")
async def list_instructors(request: Request):
    await require_admin(request)

    def run():
        with db.engine.connect() as c:
            return c.execute(select(db.instructors, db.users.c.name, db.users.c.email, db.users.c.school,
                                    db.users.c.google_name)
                             .join(db.users, db.users.c.id == db.instructors.c.user_id)
                             .order_by(db.instructors.c.requested_at.desc())).all()

    out = []
    for r in await db.run(run):
        m = dict(r._mapping)
        view = instructor_view(m)
        out.append({"user_id": m["user_id"], "name": m["name"] or m["google_name"], "email": m["email"],
                    "affiliation": m["school"], "requested_at": m["requested_at"], "pledged": bool(m["pledge_at"]),
                    **view, "kind_name": KINDS.get(m["kind"], "")})
    return {"instructors": out, "env_teachers": sorted(auth.TEACHER_EMAILS), "admins": sorted(auth.ADMIN_EMAILS),
            "today": today_kst()}


class DecideReq(BaseModel):
    action: str = Field(pattern="^(approve|reject|revoke)$")
    kind: str = Field(default="regular", pattern="^(regular|supplementary)$")
    valid_from: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    valid_until: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    note: str = Field(default="", max_length=300)  # 거절 사유 등 (신청자에게 보임)


@router.post("/api/admin/instructors/{user_id}")
async def decide(user_id: int, req: DecideReq, request: Request):
    admin = await require_admin(request)
    try:
        for d in (req.valid_from, req.valid_until):
            if d:
                date.fromisoformat(d)
    except ValueError:
        raise HTTPException(400, "활동 기간 날짜가 올바르지 않아요.")
    if req.valid_from and req.valid_until and req.valid_until < req.valid_from:
        raise HTTPException(400, "활동 기간이 끝나는 날이 시작하는 날보다 빨라요.")
    if req.action == "approve" and req.kind == "supplementary" and not req.valid_until:
        raise HTTPException(400, "보충수업 강사는 활동 기간이 끝나는 날을 정해 주세요.")
    status = {"approve": "approved", "reject": "rejected", "revoke": "revoked"}[req.action]

    def run():
        i = db.instructors.c
        with db.engine.begin() as c:
            row = c.execute(select(db.instructors).where(i.user_id == user_id)).first()
            if not row:
                raise HTTPException(404, "신청을 찾을 수 없어요.")
            values = {"status": status, "decided_at": time.time(), "decided_by": admin["id"], "admin_note": req.note.strip()}
            if req.action == "approve":
                values.update(kind=req.kind, valid_from=req.valid_from, valid_until=req.valid_until)
            c.execute(update(db.instructors).where(i.id == row.id).values(**values))

    await db.run(run)
    return {"ok": True}
