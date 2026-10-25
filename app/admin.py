"""관리교사·강사 등록 신청과 승인.

    전체 관리자(ADMIN_EMAILS) ──승인──▶ 거점학교 관리교사 ──승인──▶ 강사

- 관리교사 신청: 거점학교명을 적는다. 전체 관리자가 승인하면 그 거점학교가 만들어진다(이미 있으면 그 학교로).
- 강사 신청: 등록된 거점학교 중 하나를 고른다. 그 거점학교 관리교사(또는 전체 관리자)가 구분·활동 기간을 정해 승인한다.
- 활동 기간이 지나거나 해제되면 바로 권한이 꺼진다(수업 기록은 남는다).
- 한 사람이 여러 거점학교·역할을 가질 수 있다(예: A고 관리교사이면서 B고 강사).
"""

from __future__ import annotations

import time
from datetime import date

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, insert, select, update

from app import db
from app.auth import PLEDGE, current_user, membership_status, today_kst

router = APIRouter()
KINDS = {"regular": "정규 강사", "supplementary": "보충수업 강사"}
ROLES = {"coordinator": "거점학교 관리교사", "instructor": "강사"}


async def login_required(request: Request) -> dict:
    u = await current_user(request)
    if not u:
        raise HTTPException(401, "로그인이 필요해요.")
    return u


def can_manage(u: dict, m) -> bool:
    """관리교사 신청은 전체 관리자만, 강사 신청은 그 거점학교 관리교사나 전체 관리자가 처리한다."""
    if u["is_admin"]:
        return True
    return m.role == "instructor" and m.hub_id in {h["id"] for h in u["coordinator_hubs"]}


@router.get("/api/hubs")
async def list_hubs(request: Request):
    await login_required(request)

    def run():
        with db.engine.connect() as c:
            return c.execute(select(db.hubs).order_by(db.hubs.c.name)).all()

    return {"hubs": [{"id": h.id, "name": h.name} for h in await db.run(run)]}


# ───────────────────────── 등록 신청 ─────────────────────────


class ApplyReq(BaseModel):
    role: str = Field(pattern="^(coordinator|instructor)$")
    hub_name: str = Field(default="", max_length=60)  # 관리교사: 거점학교명
    hub_id: int | None = None  # 강사: 거점학교 고르기
    name: str = Field(min_length=1, max_length=30)
    affiliation: str = Field(default="", max_length=60)  # 소속 (없으면 비움)
    contact: str = Field(min_length=1, max_length=100)
    message: str = Field(default="", max_length=500)
    pledge: bool  # 개인정보 보호 서약 동의


@router.post("/api/staff/apply")
async def apply(req: ApplyReq, request: Request):
    u = await login_required(request)
    if not req.pledge:
        raise HTTPException(400, "개인정보 보호 서약에 동의해야 신청할 수 있어요.")
    hub_name = req.hub_name.strip()
    if req.role == "coordinator" and not hub_name:
        raise HTTPException(400, "거점학교명을 적어 주세요.")
    if req.role == "instructor" and not req.hub_id:
        raise HTTPException(400, "강의할 거점학교를 골라 주세요.")
    now = time.time()

    def run():
        m = db.memberships.c
        with db.engine.begin() as c:
            if req.role == "instructor" and not c.execute(select(db.hubs.c.id).where(db.hubs.c.id == req.hub_id)).first():
                raise HTTPException(404, "거점학교를 찾을 수 없어요.")
            c.execute(update(db.users).where(db.users.c.id == u["id"])
                      .values(name=req.name.strip(), school=req.affiliation.strip()))
            same = (m.hub_id == req.hub_id) if req.role == "instructor" else (func.lower(m.hub_name) == hub_name.lower())
            row = c.execute(select(db.memberships).where(m.user_id == u["id"], m.role == req.role, same)).first()
            values = {"contact": req.contact.strip(), "message": req.message.strip(), "pledge_at": now}
            if row and row.status == "approved":  # 이미 승인됨: 연락처 등만 고친다
                c.execute(update(db.memberships).where(m.id == row.id).values(**values))
            elif row:  # 대기 중 수정, 또는 거절·해제 뒤 다시 신청
                c.execute(update(db.memberships).where(m.id == row.id)
                          .values(status="pending", decided_at=None, requested_at=now, **values))
            else:
                c.execute(insert(db.memberships).values(
                    user_id=u["id"], role=req.role, status="pending", requested_at=now,
                    hub_id=req.hub_id if req.role == "instructor" else None, hub_name=hub_name, **values))

    await db.run(run)
    return {"ok": True}


# ───────────────────────── 승인 ─────────────────────────


@router.get("/api/staff/applications")
async def applications(role: str, request: Request):
    """role=coordinator: 전체 관리자용 / role=instructor: 관리교사(자기 거점학교)·전체 관리자용"""
    u = await login_required(request)
    if role not in ROLES:
        raise HTTPException(400)
    hubs = {h["id"] for h in u["coordinator_hubs"]}
    if not (u["is_admin"] or (role == "instructor" and hubs)):
        raise HTTPException(403, "관리 권한이 없어요.")

    def run():
        m = db.memberships.c
        with db.engine.connect() as c:
            q = (select(db.memberships, db.users.c.name, db.users.c.email, db.users.c.school, db.users.c.google_name)
                 .join(db.users, db.users.c.id == m.user_id).where(m.role == role))
            if not u["is_admin"]:
                q = q.where(m.hub_id.in_(hubs))
            rows = c.execute(q.order_by(m.requested_at.desc())).all()
            names = dict(c.execute(select(db.hubs.c.id, db.hubs.c.name)).all())
            return rows, names

    rows, names = await db.run(run)
    out = []
    for r in rows:
        x = dict(r._mapping)
        out.append({"id": x["id"], "user_id": x["user_id"], "name": x["name"] or x["google_name"], "email": x["email"],
                    "affiliation": x["school"], "hub_id": x["hub_id"], "hub": names.get(x["hub_id"]) or x["hub_name"],
                    "status": membership_status(x), "kind": x["kind"], "kind_name": KINDS.get(x["kind"], ""),
                    "valid_from": x["valid_from"], "valid_until": x["valid_until"], "contact": x["contact"],
                    "message": x["message"], "admin_note": x["admin_note"], "pledged": bool(x["pledge_at"]),
                    "requested_at": x["requested_at"]})
    return {"applications": out, "today": today_kst()}


class DecideReq(BaseModel):
    action: str = Field(pattern="^(approve|reject|revoke)$")
    kind: str = Field(default="regular", pattern="^(regular|supplementary)$")  # 강사만
    hub_name: str = Field(default="", max_length=60)  # 관리교사 승인 때 거점학교명을 고쳐 정할 수 있음
    valid_from: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    valid_until: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    note: str = Field(default="", max_length=300)  # 신청자에게 보이는 메모 (거절·해제 사유 등)


@router.post("/api/staff/{membership_id}")
async def decide(membership_id: int, req: DecideReq, request: Request):
    u = await login_required(request)
    try:
        for d in (req.valid_from, req.valid_until):
            if d:
                date.fromisoformat(d)
    except ValueError:
        raise HTTPException(400, "활동 기간 날짜가 올바르지 않아요.")
    if req.valid_from and req.valid_until and req.valid_until < req.valid_from:
        raise HTTPException(400, "활동 기간이 끝나는 날이 시작하는 날보다 빨라요.")
    status = {"approve": "approved", "reject": "rejected", "revoke": "revoked"}[req.action]

    def run():
        m = db.memberships.c
        with db.engine.begin() as c:
            row = c.execute(select(db.memberships).where(m.id == membership_id)).first()
            if not row:
                raise HTTPException(404, "신청을 찾을 수 없어요.")
            if not can_manage(u, row):
                raise HTTPException(403, "관리 권한이 없어요.")
            if row.user_id == u["id"] and not u["is_admin"]:
                raise HTTPException(403, "자기 신청은 처리할 수 없어요.")
            values = {"status": status, "decided_at": time.time(), "decided_by": u["id"], "admin_note": req.note.strip()}
            if req.action == "approve":
                values.update(valid_from=req.valid_from, valid_until=req.valid_until)
                if row.role == "instructor":
                    if req.kind == "supplementary" and not req.valid_until:
                        raise HTTPException(400, "보충수업 강사는 활동 기간이 끝나는 날을 정해 주세요.")
                    values["kind"] = req.kind
                else:  # 관리교사: 거점학교를 찾거나 새로 만든다
                    name = (req.hub_name or row.hub_name).strip()
                    if not name:
                        raise HTTPException(400, "거점학교명을 정해 주세요.")
                    hub = c.execute(select(db.hubs).where(func.lower(db.hubs.c.name) == name.lower())).first()
                    hub_id = hub.id if hub else c.execute(
                        insert(db.hubs).values(name=name, created_at=time.time())).inserted_primary_key[0]
                    values.update(hub_id=hub_id, hub_name=name)
            c.execute(update(db.memberships).where(m.id == membership_id).values(**values))

    await db.run(run)
    return {"ok": True}
