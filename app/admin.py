"""관리교사·강사 등록 신청과 승인.

    전체 관리자(ADMIN_EMAILS) ──승인──▶ 거점학교 관리교사 ──승인──▶ 강사

- 관리교사 신청: 거점학교명을 적는다. 전체 관리자가 승인하면 그 거점학교가 만들어진다(이미 있으면 그 학교로).
- 강사 신청: 등록된 거점학교 하나를 고르고 희망 기간을 적는다. 그 거점학교 관리교사(또는 전체 관리자)가
  활동 기간(희망 기간이 미리 채워짐, 끝나는 날 필수)을 정해 승인한다.
- 활동 기간이 지나거나 해제되면 바로 권한이 꺼진다(그 거점학교 강좌 관리·수업 열기도 막힌다. 기록은 남는다).
- 참여학교 담당자 신청: 울산 고등학교 목록에서 소속 학교를 고른다. 전체 관리자가 승인하면 그 학교 학생의
  수강 현황을 보고 탈퇴를 승인한다.
- 한 사람이 여러 거점학교·역할을 가질 수 있다(예: A고 관리교사이면서 B고 강사).
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import date

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, insert, select, update

from app import db
from app.auth import NAME_LOCKED, PLEDGE, current_user, get_schools, membership_status, today_kst
from app.courses import hub_for_school
from app.subjects import OFFICES
from app.policy import POLICY_VERSION

router = APIRouter()
ROLES = {"coordinator": "거점학교 관리교사", "instructor": "강사", "participant": "참여학교 담당자"}


async def login_required(request: Request) -> dict:
    u = await current_user(request)
    if not u:
        raise HTTPException(401, "로그인이 필요해요.")
    return u


def can_manage(u: dict, m) -> bool:
    """관리교사·참여학교 담당자 신청은 전체 관리자만, 강사 신청은 그 거점학교 관리교사나 전체 관리자가 처리한다."""
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
    role: str = Field(pattern="^(coordinator|instructor|participant)$")
    hub_name: str = Field(default="", max_length=60)  # 관리교사: 거점학교명 / 참여학교 담당자: 소속 학교
    hub_id: int | None = None  # 강사: 거점학교 고르기
    name: str = Field(min_length=1, max_length=30)
    affiliation: str = Field(default="", max_length=60)  # 소속 학교·대학·기관 (없으면 비움)
    # 소속 구분: school 학교 교원 / univ 대학 교원 / cert 교원자격 소지자(미임용) / other 기타
    affil_type: str = Field(default="", pattern="^(school|univ|cert|other)?$")
    office: str = Field(default="", max_length=30)  # 소속 교육청 (학교 교원)
    license: str = Field(default="", max_length=100)  # 교원자격 (교원자격 소지자)
    email: str = Field(default="", max_length=200)  # 연락받을 이메일
    contact: str = Field(min_length=1, max_length=100)  # 연락처 (전화번호)
    birth: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")  # 생년월일
    gender: str = Field(default="", pattern="^(남|여)?$")  # 성별
    subjects: str = Field(default="", max_length=300)  # 담당과목 (강의교사만)
    assistant: bool = False  # 강사: 팀티칭 보조교사로 참여 (강좌를 직접 열지 않고 다른 강사의 강좌를 돕는다)
    message: str = Field(default="", max_length=500)  # 관리교사만 (강사 신청서에는 없음)
    wish_from: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")  # 강사: 희망 기간
    wish_until: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    pledge: bool  # 개인정보 보호 서약 동의


def check_dates(start: str, end: str, what: str) -> None:
    try:
        for d in (start, end):
            if d:
                date.fromisoformat(d)
    except ValueError:
        raise HTTPException(400, f"{what} 날짜가 올바르지 않아요.")
    if start and end and end < start:
        raise HTTPException(400, f"{what}이 끝나는 날이 시작하는 날보다 빨라요.")


@router.post("/api/staff/apply")
async def apply(req: ApplyReq, request: Request):
    u = await login_required(request)
    if not req.pledge:
        raise HTTPException(400, "개인정보 보호 서약에 동의해야 신청할 수 있어요.")
    if req.birth:
        check_dates(req.birth, "", "생년월일")
        if not ("1920-01-01" <= req.birth <= today_kst()):
            raise HTTPException(400, "생년월일을 확인해 주세요.")
    hub_name = req.hub_name.strip()
    if req.role in ("coordinator", "participant"):
        what = "거점학교" if req.role == "coordinator" else "소속 학교"
        if not hub_name:
            raise HTTPException(400, f"{what}를 골라 주세요.")
        schools = await db.run(get_schools)  # 울산 시내 학교 목록에서만
        if schools and hub_name not in schools:
            raise HTTPException(400, f"{what}는 목록에 있는 학교 중에서 골라 주세요.")
    if req.affil_type:  # 새 신청서: 소속 구분에 따라 필요한 칸
        if req.affil_type == "school" and not (req.office and req.affiliation.strip()):
            raise HTTPException(400, "소속 교육청과 소속 학교를 적어 주세요.")
        if req.office and req.office not in OFFICES:
            raise HTTPException(400, "소속 교육청을 목록에서 골라 주세요.")
        if req.affil_type == "univ" and not req.affiliation.strip():
            raise HTTPException(400, "소속 대학(학과)을 적어 주세요.")
        if req.affil_type == "cert" and not req.license.strip():
            raise HTTPException(400, "가지고 있는 교원자격을 적어 주세요. (예: 중등학교 2급 정교사(사회))")
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", req.email.strip()):
            raise HTTPException(400, "연락받을 이메일 주소를 정확히 적어 주세요.")
    if req.role == "instructor":
        # 강사: 울산 고등학교 목록에서 거점학교를 고른다 (관리교사가 아직 없는 학교면 전체 관리자가 승인)
        if not req.hub_id and not hub_name:
            raise HTTPException(400, "강의할 거점학교를 골라 주세요.")
        if not req.hub_id:
            schools = await db.run(get_schools)
            if schools and hub_name not in schools:
                raise HTTPException(400, "거점학교는 울산 고등학교 목록에서 골라 주세요.")
        if not (req.wish_from and req.wish_until):
            raise HTTPException(400, "희망 기간(시작일·종료일)을 적어 주세요.")
        check_dates(req.wish_from, req.wish_until, "희망 기간")
        if req.wish_until < today_kst():
            raise HTTPException(400, "희망 기간이 이미 지났어요.")
    now = time.time()

    def run():
        m = db.memberships.c
        with db.engine.begin() as c:
            hub_id = req.hub_id
            if req.role == "instructor" and not hub_id:
                hub_id = hub_for_school(c, hub_name)
            if req.role == "instructor" and not c.execute(select(db.hubs.c.id).where(db.hubs.c.id == hub_id)).first():
                raise HTTPException(404, "거점학교를 찾을 수 없어요.")
            # 신청서의 동의 칸은 개인정보 보호 서약 + 이용약관·개인정보 처리방침 확인을 함께 받는다
            # 이름은 처음 적은 실명으로 굳는다 (전체 관리자만 바꿀 수 있음)
            locked = u.get("name_locked") and not u["is_admin"]
            if locked and req.name.strip() != (u["name"] or ""):
                raise HTTPException(400, NAME_LOCKED)
            who = {"name": req.name.strip(), "school": req.affiliation.strip(), "terms_version": POLICY_VERSION, "terms_at": now,
                   **({} if u["is_admin"] else {"name_locked": 1})}
            if req.birth:
                who["birth"] = req.birth
            if req.gender:
                who["gender"] = req.gender
            if req.email.strip():
                who["contact_email"] = req.email.strip()
            who["phone"] = req.contact.strip()
            if req.role == "instructor" and req.subjects.strip():
                who["subjects"] = " ".join(req.subjects.split())
            c.execute(update(db.users).where(db.users.c.id == u["id"]).values(**who))
            same = (m.hub_id == hub_id) if req.role == "instructor" else (func.lower(m.hub_name) == hub_name.lower())
            row = c.execute(select(db.memberships).where(m.user_id == u["id"], m.role == req.role, same)).first()
            values = {"contact": req.contact.strip(), "pledge_at": now, "affil_type": req.affil_type,
                      "office": req.office if req.affil_type == "school" else "",
                      "license": req.license.strip() if req.affil_type == "cert" else "", "email": req.email.strip(),
                      "kind": "assistant" if req.role == "instructor" and req.assistant else ""}
            if req.role == "instructor":
                values.update(wish_from=req.wish_from, wish_until=req.wish_until)
            else:
                values["message"] = req.message.strip()
            if row and membership_status(dict(row._mapping)) in ("approved", "scheduled"):
                # 지금 활동 중(또는 시작 전)이면 연락처 등만 고친다. 기간이 끝났으면 아래에서 다시 '승인 대기'로.
                # 참여 형태(주강사·보조교사)는 승인받은 그대로 둔다 (바꾸려면 다시 승인받아야 함)
                values.pop("kind")
                c.execute(update(db.memberships).where(m.id == row.id).values(**values))
            elif row:  # 대기 중 수정, 또는 거절·해제 뒤 다시 신청
                c.execute(update(db.memberships).where(m.id == row.id)
                          .values(status="pending", decided_at=None, requested_at=now, **values))
            else:
                c.execute(insert(db.memberships).values(
                    user_id=u["id"], role=req.role, status="pending", requested_at=now,
                    hub_id=hub_id if req.role == "instructor" else None,
                    hub_name=hub_name if req.role != "instructor" else "", **values))

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
            q = (select(db.memberships, db.users.c.name, db.users.c.email, db.users.c.school, db.users.c.google_name,
                        db.users.c.birth, db.users.c.gender)
                 .join(db.users, db.users.c.id == m.user_id).where(m.role == role))
            if not u["is_admin"] and role == "instructor":
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
                    "status": membership_status(x), "valid_from": x["valid_from"], "valid_until": x["valid_until"],
                    "wish_from": x["wish_from"], "wish_until": x["wish_until"], "contact": x["contact"],
                    "message": x["message"], "admin_note": x["admin_note"], "pledged": bool(x["pledge_at"]),
                    "kind": x["kind"], "affil_type": x["affil_type"], "office": x["office"], "license": x["license"],
                    "contact_email": x["email"], "birth": x["birth"] or "", "gender": x["gender"] or "",
                    "requested_at": x["requested_at"]})
    return {"applications": out, "today": today_kst()}


class DecideReq(BaseModel):
    action: str = Field(pattern="^(approve|reject|revoke)$")
    hub_name: str = Field(default="", max_length=60)  # 관리교사 승인 때 거점학교명을 고쳐 정할 수 있음
    valid_from: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    valid_until: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    note: str = Field(default="", max_length=300)  # 신청자에게 보이는 메모 (거절·해제 사유 등)


@router.post("/api/staff/{membership_id}")
async def decide(membership_id: int, req: DecideReq, request: Request):
    u = await login_required(request)
    check_dates(req.valid_from, req.valid_until, "활동 기간")
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
                if row.role == "participant":
                    values.update(hub_name=(req.hub_name or row.hub_name).strip())
                    if not values["hub_name"]:
                        raise HTTPException(400, "소속 학교를 정해 주세요.")
                elif row.role == "instructor":
                    if not req.valid_until:  # 기간이 끝나면 저절로 권한이 꺼지도록 강사는 끝나는 날이 꼭 있어야 한다
                        raise HTTPException(400, "강사는 활동 기간이 끝나는 날을 정해 주세요.")
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


# ───────────────────────── 학교 목록 (학생 가입용) ─────────────────────────


class SchoolsReq(BaseModel):
    text: str = Field(default="", max_length=20000)  # 한 줄에 학교 하나 (정식 이름)


@router.post("/api/admin/schools")
async def save_schools(req: SchoolsReq, request: Request):
    """전체 관리자가 학생이 고를 학교 목록을 저장한다 (비우면 학생이 직접 적음)"""
    u = await login_required(request)
    if not u["is_admin"]:
        raise HTTPException(403, "전체 관리자만 할 수 있어요.")
    names = []
    for line in req.text.splitlines():
        name = " ".join(line.split())[:60]
        if name and name not in names:
            names.append(name)
    names.sort()

    def run():
        with db.engine.begin() as c:
            c.execute(delete(db.site_settings).where(db.site_settings.c.key == "schools"))
            c.execute(insert(db.site_settings).values(key="schools", value="\n".join(names)))

    await db.run(run)
    return {"schools": names}


# ───────────────────────── 나이스(교육정보 개방 포털)에서 울산 고등학교 목록 가져오기 ─────────────────────────

NEIS_URL = "https://open.neis.go.kr/hub/schoolInfo"


def fetch_neis_schools(key: str) -> tuple[list[str], int]:
    """울산광역시교육청(H10) 소속 고등학교 이름. (이름 목록, 나이스가 알려 준 전체 개수)"""
    names, total, page = [], 0, 1
    while page <= 10:
        q = {"Type": "json", "pIndex": page, "pSize": 1000, "ATPT_OFCDC_SC_CODE": "H10", "SCHUL_KND_SC_NM": "고등학교"}
        if key:
            q["KEY"] = key
        with urllib.request.urlopen(f"{NEIS_URL}?{urllib.parse.urlencode(q)}", timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
        info = data.get("schoolInfo")
        if not info:
            msg = (data.get("RESULT") or {}).get("MESSAGE") or "나이스에서 학교 목록을 받지 못했어요."
            raise HTTPException(502, f"나이스 응답: {msg}")
        total = info[0]["head"][0]["list_total_count"]
        rows = info[1]["row"] if len(info) > 1 else []
        names += [r["SCHUL_NM"].strip() for r in rows if r.get("SCHUL_NM")]
        if len(names) >= total or not rows or not key:
            break
        page += 1
    return sorted(set(names)), total


@router.post("/api/admin/schools/neis")
async def schools_from_neis(request: Request):
    """전체 관리자: 나이스에서 울산 고등학교 정식 이름 목록을 받아 '울산 고등학교 목록'에 넣는다"""
    u = await login_required(request)
    if not u["is_admin"]:
        raise HTTPException(403, "전체 관리자만 할 수 있어요.")
    key = os.environ.get("NEIS_API_KEY", "")
    try:
        names, total = await db.run(fetch_neis_schools, key)
    except HTTPException:
        raise
    except Exception as e:  # 연결 실패 등
        raise HTTPException(502, f"나이스에 연결하지 못했어요 ({type(e).__name__}). 잠시 뒤 다시 해 보세요.")
    if not names:
        raise HTTPException(502, "나이스에서 받은 학교가 없어요.")
    partial = len(names) < total
    if partial and not key:
        raise HTTPException(400, f"인증키 없이 받을 수 있는 것은 견본 {len(names)}개뿐이에요 (전체 {total}개). "
                                 "나이스 교육정보 개방 포털(open.neis.go.kr)에서 무료 인증키를 받아 서버에서 "
                                 "live-config NEIS_API_KEY=인증키 로 넣은 뒤 다시 눌러 주세요.")

    def run():
        with db.engine.begin() as c:
            c.execute(delete(db.site_settings).where(db.site_settings.c.key == "schools"))
            c.execute(insert(db.site_settings).values(key="schools", value="\n".join(names)))

    await db.run(run)
    return {"schools": names, "total": total}
