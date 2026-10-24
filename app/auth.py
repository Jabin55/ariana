"""학교 구글 계정 로그인과 학생·선생님 정보.

- 학생: ALLOWED_DOMAINS(학교 구글 계정 도메인) 계정만 로그인할 수 있다. 처음 로그인하면 학교·학년·반·번호·이름을 입력한다.
- 선생님: TEACHER_EMAILS 에 적힌 계정이면 도메인과 상관없이 선생님으로 로그인한다.
- 비밀번호를 저장하지 않는다. 로그인 상태는 서명된 쿠키(SECRET_KEY)로 유지한다.
"""

from __future__ import annotations

import os
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, update

from app import db

router = APIRouter()

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
ALLOWED_DOMAINS = {d.strip().lower().lstrip("@") for d in os.environ.get("ALLOWED_DOMAINS", "").split(",") if d.strip()}
TEACHER_EMAILS = {e.strip().lower() for e in os.environ.get("TEACHER_EMAILS", "").split(",") if e.strip()}
SCHOOLS = [s.strip() for s in os.environ.get("SCHOOLS", "").split(",") if s.strip()]
# 로컬 개발·자동 테스트 전용 로그인. 배포 서버에서는 절대 켜지 말 것.
DEV_LOGIN = os.environ.get("DEV_LOGIN") == "1"


def public_user(u) -> dict:
    d = dict(u._mapping) if hasattr(u, "_mapping") else dict(u)
    return {
        "id": d["id"], "email": d["email"], "role": d["role"], "name": d["name"],
        "school": d["school"], "grade": d["grade"], "class_no": d["class_no"], "number": d["number"],
        "student_no": student_no(d), "display": display_name(d), "needs_profile": needs_profile(d),
    }


def student_no(u: dict) -> str:
    """학번: 학년 1자리 + 반 2자리 + 번호 2자리 (예: 2학년 3반 15번 → 20315)"""
    if u.get("role") != "student" or not (u.get("grade") and u.get("class_no") and u.get("number")):
        return ""
    return f"{u['grade']}{u['class_no']:02d}{u['number']:02d}"


def display_name(u: dict) -> str:
    no = student_no(u)
    name = u.get("name") or u.get("google_name") or u.get("email", "").split("@")[0]
    return f"{no} {name}" if no else name


def needs_profile(u: dict) -> bool:
    if not u.get("name"):
        return True
    if u.get("role") == "student":
        return not (u.get("school") and u.get("grade") and u.get("class_no") and u.get("number"))
    return False


def _get_user(uid: int):
    with db.engine.connect() as c:
        return c.execute(select(db.users).where(db.users.c.id == uid)).first()


async def current_user(request_or_ws) -> dict | None:
    uid = request_or_ws.session.get("uid")
    if not uid:
        return None
    row = await db.run(_get_user, uid)
    if not row:
        return None
    u = dict(row._mapping)
    # 선생님 목록에서 빠지면 바로 권한을 잃도록 매번 확인
    if u["role"] == "teacher" and u["email"].lower() not in TEACHER_EMAILS:
        return None
    return u


async def require_user(request: Request, role: str | None = None, profile: bool = True) -> dict:
    u = await current_user(request)
    if not u:
        raise HTTPException(401, "로그인이 필요해요.")
    if role and u["role"] != role:
        raise HTTPException(403, "선생님만 할 수 있어요." if role == "teacher" else "학생 계정으로 로그인해 주세요.")
    if profile and needs_profile(u):
        raise HTTPException(409, "먼저 내 정보를 입력해 주세요.")
    return u


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
    email = email.lower()
    if email in TEACHER_EMAILS:
        role = "teacher"
    else:
        domain = (hd or "").lower()
        if ALLOWED_DOMAINS and domain not in ALLOWED_DOMAINS:
            raise HTTPException(403, "학교에서 받은 구글 계정으로만 로그인할 수 있어요.")
        role = "student"
    uid = await db.run(_upsert_user, sub, email, gname, role)
    request.session.clear()
    request.session["uid"] = uid
    return public_user(await db.run(_get_user, uid))


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
    domain = req.email.split("@")[-1]
    return await login_with_identity(request, f"dev:{req.email}", req.email, req.name, domain)


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
        "schools": SCHOOLS, "domains": sorted(ALLOWED_DOMAINS),
    }


class Profile(BaseModel):
    name: str = Field(min_length=1, max_length=30)
    school: str = Field(default="", max_length=60)
    grade: int | None = Field(default=None, ge=1, le=6)
    class_no: int | None = Field(default=None, ge=1, le=30)
    number: int | None = Field(default=None, ge=1, le=60)


@router.post("/api/me/profile")
async def save_profile(p: Profile, request: Request):
    u = await require_user(request, profile=False)
    name = re.sub(r"\s+", " ", p.name).strip()
    school = p.school.strip()
    # 학교 목록은 학생에게만 적용. 강사는 대학교수 등 학교 밖 사람일 수 있어 소속을 자유롭게 적는다.
    if u["role"] == "student" and SCHOOLS and school and school not in SCHOOLS:
        raise HTTPException(400, "목록에 있는 학교를 골라 주세요.")
    values = {"name": name, "school": school}
    if u["role"] == "student":
        if not (school and p.grade and p.class_no and p.number):
            raise HTTPException(400, "학교, 학년, 반, 번호를 모두 입력해 주세요.")
        values.update(grade=p.grade, class_no=p.class_no, number=p.number)

    def save():
        with db.engine.begin() as c:
            c.execute(update(db.users).where(db.users.c.id == u["id"]).values(**values))

    await db.run(save)
    return public_user(await db.run(_get_user, u["id"]))
