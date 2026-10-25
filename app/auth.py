"""구글 계정 로그인과 역할(학생·강사·관리자).

역할은 매 요청마다 다시 판단한다(권한을 빼거나 기간이 끝나면 바로 반영).
- 관리자: ADMIN_EMAILS 에 적힌 계정. 강사 등록 신청을 승인한다. 강사 기능도 모두 쓸 수 있다.
- 강사(teacher): ADMIN_EMAILS·TEACHER_EMAILS 에 적힌 계정, 또는 관리자가 승인했고 활동 기간 안인 계정.
  학교 밖 사람(대학교수, 보충수업 강사 등)도 개인 구글 계정으로 신청할 수 있다.
- 학생: ALLOWED_DOMAINS(학교 구글 계정 도메인) 계정. 처음 로그인하면 학교·학년·반·번호·이름을 입력한다.
- 손님(guest): 그 밖의 계정. 강사 등록 신청만 할 수 있다.
비밀번호를 저장하지 않는다. 로그인 상태는 서명된 쿠키(SECRET_KEY)로 유지한다.
"""

from __future__ import annotations

import os
import re
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, update

from app import db
from app.policy import POLICY_VERSION, policy_ready

router = APIRouter()

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
# (선택) 선생님이 구글 드라이브에서 발표 자료를 고르는 '드라이브에서 열기'용: API 키(웹사이트 주소로 제한)와 프로젝트 번호.
# 선생님이 고른 파일만 여는 권한(drive.file)이라 구글의 별도 앱 검토가 필요 없다. 서버는 구글 토큰을 저장하지 않는다.
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
GOOGLE_APP_ID = os.environ.get("GOOGLE_APP_ID", "")
ALLOWED_DOMAINS = {d.strip().lower().lstrip("@") for d in os.environ.get("ALLOWED_DOMAINS", "").split(",") if d.strip()}
TEACHER_EMAILS = {e.strip().lower() for e in os.environ.get("TEACHER_EMAILS", "").split(",") if e.strip()}
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}
KST = ZoneInfo("Asia/Seoul")


def today_kst() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d")
SCHOOLS = [s.strip() for s in os.environ.get("SCHOOLS", "").split(",") if s.strip()]
# 로컬 개발·자동 테스트 전용 로그인. 배포 서버에서는 절대 켜지 말 것.
DEV_LOGIN = os.environ.get("DEV_LOGIN") == "1"


def public_user(u) -> dict:
    d = dict(u._mapping) if hasattr(u, "_mapping") else dict(u)
    return {
        "id": d["id"], "email": d["email"], "role": d["role"], "name": d["name"],
        "school": d["school"], "grade": d["grade"], "class_no": d["class_no"], "number": d["number"],
        "student_no": student_no(d), "display": display_name(d), "needs_profile": needs_profile(d),
        "is_admin": bool(d.get("is_admin")), "memberships": d.get("memberships", []),
        "coordinator_hubs": d.get("coordinator_hubs", []), "teach_hubs": d.get("teach_hubs", []),
        "needs_terms": needs_terms(d), "ai_ok": bool(d.get("ai_ok_at")),
    }


def membership_active(m: dict) -> bool:
    if m["status"] != "approved" or not m.get("hub_id"):
        return False
    today = today_kst()
    return (not m["valid_from"] or m["valid_from"] <= today) and (not m["valid_until"] or today <= m["valid_until"])


def membership_status(m: dict) -> str:
    """화면용 상태: pending approved scheduled(시작 전) expired(기간 끝) rejected revoked"""
    if m["status"] == "approved" and not membership_active(m):
        return "expired" if m["valid_until"] and m["valid_until"] < today_kst() else "scheduled"
    return m["status"]


def effective_role(email: str, memberships: list[dict]) -> str:
    email = email.lower()
    if email in ADMIN_EMAILS or email in TEACHER_EMAILS or any(membership_active(m) for m in memberships):
        return "teacher"
    domain = email.rsplit("@", 1)[-1]
    if not ALLOWED_DOMAINS or domain in ALLOWED_DOMAINS:
        return "student"
    return "guest"


def membership_view(m: dict, hub_names: dict) -> dict:
    return {"id": m["id"], "role": m["role"], "hub_id": m["hub_id"],
            "hub": hub_names.get(m["hub_id"]) or m["hub_name"], "status": membership_status(m),
            "valid_from": m["valid_from"], "valid_until": m["valid_until"],
            "wish_from": m["wish_from"], "wish_until": m["wish_until"],
            "contact": m["contact"], "message": m["message"], "admin_note": m["admin_note"]}


def student_no(u: dict) -> str:
    """학번: 학년 1자리 + 반 2자리 + 번호 2자리 (예: 2학년 3반 15번 → 20315)"""
    if u.get("role") != "student" or not (u.get("grade") and u.get("class_no") and u.get("number")):
        return ""
    return f"{u['grade']}{u['class_no']:02d}{u['number']:02d}"


def display_name(u: dict) -> str:
    no = student_no(u)
    name = u.get("name") or u.get("google_name") or u.get("email", "").split("@")[0]
    return f"{no} {name}" if no else name


def needs_terms(u: dict) -> bool:
    """이용약관·개인정보 처리방침을 아직 확인하지 않았거나, 그 뒤에 내용이 바뀌었다."""
    return u.get("terms_version") != POLICY_VERSION


def needs_profile(u: dict) -> bool:
    if u.get("role") == "guest":
        return False  # 손님은 관리교사·강사 등록 신청서에서 이름을 적고 약관을 확인한다
    if needs_terms(u):
        return True  # 내 정보 화면에서 약관 확인을 함께 받는다
    if not u.get("name"):
        return True
    if u.get("role") == "student":
        return not (u.get("school") and u.get("grade") and u.get("class_no") and u.get("number"))
    return False


def _get_user(uid: int):
    with db.engine.connect() as c:
        return c.execute(select(db.users).where(db.users.c.id == uid)).first()


def _load_with_role(uid: int) -> dict | None:
    """사용자 + 관리교사·강사 등록 정보를 읽고, 지금 역할을 판단한다(바뀌었으면 저장해 둔다)."""
    with db.engine.begin() as c:
        row = c.execute(select(db.users).where(db.users.c.id == uid)).first()
        if not row:
            return None
        u = dict(row._mapping)
        ms = [dict(r._mapping) for r in c.execute(
            select(db.memberships).where(db.memberships.c.user_id == uid).order_by(db.memberships.c.id))]
        hub_names = dict(c.execute(select(db.hubs.c.id, db.hubs.c.name)).all())
        role = effective_role(u["email"], ms)
        if role != u["role"]:
            c.execute(update(db.users).where(db.users.c.id == uid).values(role=role))
            u["role"] = role
    u["is_admin"] = u["email"].lower() in ADMIN_EMAILS
    u["memberships"] = [membership_view(m, hub_names) for m in ms]
    active = [m for m in ms if membership_active(m)]
    # 관리교사로 맡은 거점학교 / 강좌를 열 수 있는 거점학교 (관리교사도 강의할 수 있다)
    u["coordinator_hubs"] = sorted({(m["hub_id"], hub_names.get(m["hub_id"], "")) for m in active
                                    if m["role"] == "coordinator"})
    u["teach_hubs"] = sorted({(m["hub_id"], hub_names.get(m["hub_id"], "")) for m in active})
    u["coordinator_hubs"] = [{"id": i, "name": n} for i, n in u["coordinator_hubs"]]
    u["teach_hubs"] = [{"id": i, "name": n} for i, n in u["teach_hubs"]]
    return u


async def current_user(request_or_ws) -> dict | None:
    uid = request_or_ws.session.get("uid")
    if not uid:
        return None
    return await db.run(_load_with_role, uid)


async def require_user(request: Request, role: str | None = None, profile: bool = True) -> dict:
    u = await current_user(request)
    if not u:
        raise HTTPException(401, "로그인이 필요해요.")
    if role and u["role"] != role:
        raise HTTPException(403, "강사만 할 수 있어요." if role == "teacher" else "학생 계정으로 로그인해 주세요.")
    if profile and needs_profile(u):
        raise HTTPException(409, "먼저 내 정보를 입력해 주세요.")
    return u


PLEDGE = ("나는 이 플랫폼에서 알게 된 학생의 개인정보(이름·학번·출결·답안·질문 등)를 수업 목적으로만 쓰고, "
          "외부에 제공하거나 유출하지 않으며, 강의가 끝나면 따로 내려받은 자료를 지체 없이 파기하겠습니다.")


def _upsert_user(sub: str, email: str, gname: str, role: str) -> int:
    now = db.now()
    with db.engine.begin() as c:
        row = c.execute(select(db.users.c.id).where(db.users.c.google_sub == sub)).first()
        if row:
            c.execute(update(db.users).where(db.users.c.id == row.id)
                      .values(email=email, google_name=gname, role=role, last_login=now))
            return row.id
        return c.execute(insert(db.users).values(
            google_sub=sub, email=email, google_name=gname, role=role,
            name=gname[:30] if role == "teacher" else "", created_at=now, last_login=now,
        )).inserted_primary_key[0]


async def login_with_identity(request: Request, sub: str, email: str, gname: str, hd: str | None) -> dict:
    # 누구나 로그인은 된다. 학교 계정이 아니고 강사로 승인되지 않았으면 '손님'으로 강사 등록 신청만 할 수 있다.
    email = email.lower()
    uid = await db.run(_upsert_user, sub, email, gname, effective_role(email, []))
    request.session.clear()
    request.session["uid"] = uid
    return public_user(await db.run(_load_with_role, uid))


class GoogleLogin(BaseModel):
    credential: str = Field(max_length=5000)


@router.post("/api/auth/google")
async def google_login(req: GoogleLogin, request: Request):
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(503, "서버에 GOOGLE_CLIENT_ID 가 설정되지 않았어요.")
    from google.auth.transport import requests as g_requests
    from google.oauth2 import id_token

    try:
        info = await db.run(lambda: id_token.verify_oauth2_token(req.credential, g_requests.Request(), GOOGLE_CLIENT_ID))
    except ValueError:
        raise HTTPException(401, "구글 로그인을 확인하지 못했어요. 다시 시도해 주세요.")
    if not info.get("email_verified"):
        raise HTTPException(403, "확인되지 않은 이메일이에요.")
    return await login_with_identity(request, info["sub"], info["email"], info.get("name", ""), info.get("hd"))


class DevLogin(BaseModel):
    email: str
    name: str = ""


@router.post("/api/auth/dev")
async def dev_login(req: DevLogin, request: Request):
    if not DEV_LOGIN:
        raise HTTPException(404)
    return await login_with_identity(request, f"dev:{req.email}", req.email, req.name, req.email.split("@")[-1])


@router.post("/api/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@router.get("/api/me")
async def me(request: Request):
    u = await current_user(request)
    return {
        "user": public_user(u) if u else None,
        "google_client_id": GOOGLE_CLIENT_ID, "dev_login": DEV_LOGIN,
        "drive_picker": {"api_key": GOOGLE_API_KEY, "app_id": GOOGLE_APP_ID}
        if GOOGLE_CLIENT_ID and GOOGLE_API_KEY and GOOGLE_APP_ID else None,
        "schools": SCHOOLS, "domains": sorted(ALLOWED_DOMAINS), "pledge": PLEDGE,
        "policy_version": POLICY_VERSION, "policy_ready": policy_ready(),
    }


class Profile(BaseModel):
    name: str = Field(min_length=1, max_length=30)
    school: str = Field(default="", max_length=60)
    grade: int | None = Field(default=None, ge=1, le=6)
    class_no: int | None = Field(default=None, ge=1, le=30)
    number: int | None = Field(default=None, ge=1, le=60)
    agree: bool = False  # 이용약관·개인정보 처리방침 확인(동의)


@router.post("/api/me/profile")
async def save_profile(p: Profile, request: Request):
    u = await require_user(request, profile=False)
    name = re.sub(r"\s+", " ", p.name).strip()
    school = p.school.strip()
    # 학교 목록은 학생에게만 적용. 강사는 대학교수 등 학교 밖 사람일 수 있어 소속을 자유롭게 적는다.
    if u["role"] == "student" and SCHOOLS and school and school not in SCHOOLS:
        raise HTTPException(400, "목록에 있는 학교를 골라 주세요.")
    values = {"name": name, "school": school}
    if needs_terms(u):
        if not p.agree:
            raise HTTPException(400, "이용약관과 개인정보 처리방침을 확인하고 동의해 주세요.")
        values.update(terms_version=POLICY_VERSION, terms_at=time.time())
    if u["role"] == "student":
        if not (school and p.grade and p.class_no and p.number):
            raise HTTPException(400, "학교, 학년, 반, 번호를 모두 입력해 주세요.")
        values.update(grade=p.grade, class_no=p.class_no, number=p.number)

    def save():
        with db.engine.begin() as c:
            c.execute(update(db.users).where(db.users.c.id == u["id"]).values(**values))

    await db.run(save)
    return public_user(await db.run(_load_with_role, u["id"]))


@router.post("/api/me/ai-ok")
async def ai_ok(request: Request):
    """AI 조교 안내(질문이 미국 회사로 전송됨, 개인정보 쓰지 말 것)를 확인했다."""
    u = await require_user(request, profile=False)

    def save():
        with db.engine.begin() as c:
            c.execute(update(db.users).where(db.users.c.id == u["id"]).values(ai_ok_at=time.time()))

    await db.run(save)
    return {"ok": True}
