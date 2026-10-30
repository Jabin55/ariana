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

import json
import os
import re
import secrets
import time
import uuid
from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, insert, select, update

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


def admin_user_ids(c) -> set[int]:
    """전체 관리자 계정들: 모든 수업을 볼 수 있지만 수업의 출결·명단·채점에는 나오지 않는다."""
    if not ADMIN_EMAILS:
        return set()
    from sqlalchemy import func as _f, select as _s
    return set(c.execute(_s(db.users.c.id).where(_f.lower(db.users.c.email).in_(ADMIN_EMAILS))).scalars())
KST = ZoneInfo("Asia/Seoul")


def today_kst() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d")


def student_age(birth: str) -> int:
    if not birth:
        raise HTTPException(400, "생년월일을 입력해 주세요.")
    try:
        born = date.fromisoformat(birth)
    except ValueError:
        raise HTTPException(400, "생년월일을 정확하게 입력해 주세요.") from None
    today = datetime.now(KST).date()
    if born > today or born.year < 1900:
        raise HTTPException(400, "생년월일을 정확하게 입력해 주세요.")
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


def check_student_age(birth: str) -> None:
    if student_age(birth) < 14:
        raise HTTPException(403, "만 14세 미만은 가입할 수 없어요.")


def check_school_gender(school: str, gender: str) -> None:
    female_only = "여자고등학교" in school or school.endswith("여고")
    male_only = "남자고등학교" in school or school.endswith("남고")
    if (female_only and gender == "남") or (male_only and gender == "여"):
        raise HTTPException(400, "선택한 학교와 성별을 다시 확인해 주세요. 실제 재학생인데 입력이 맞다면 담당교사에게 문의해 주세요.")
SCHOOLS = [s.strip() for s in os.environ.get("SCHOOLS", "").split(",") if s.strip()]
# 울산 고등학교 (학생 소속 학교 · 거점학교 · 참여학교를 이 목록에서 고른다). 빠진 학교는 여기에 더한다.
ULSAN_SCHOOLS = [
    "신정고등학교", "울산고등학교", "신선여자고등학교", "남창고등학교", "호계고등학교", "울산강남고등학교",
    "삼산고등학교", "울산가온고등학교", "울산중앙고등학교", "우신고등학교", "현대고등학교", "현대청운고등학교",
    "울산외국어고등학교", "울산제일고등학교", "온산고등학교", "성광여자고등학교", "울산여자고등학교", "학성고등학교",
]


def get_schools() -> list[str]:
    """고를 수 있는 학교 목록: 위 울산 고등학교 + SCHOOLS 설정 + 예전에 관리 화면에서 저장해 둔 것 (가나다순)"""
    with db.engine.connect() as c:
        row = c.execute(select(db.site_settings.c.value).where(db.site_settings.c.key == "schools")).first()
    saved = [s.strip() for s in row.value.splitlines() if s.strip()] if row and row.value else []
    return sorted({*ULSAN_SCHOOLS, *SCHOOLS, *saved})


def public_user(u) -> dict:
    d = dict(u._mapping) if hasattr(u, "_mapping") else dict(u)
    return {
        "id": d["id"], "email": d["email"], "role": d["role"], "name": d["name"],
        "school": d["school"], "grade": d["grade"], "class_no": d["class_no"], "number": d["number"],
        "student_no": student_no(d), "display": display_name(d), "needs_profile": needs_profile(d),
        "is_admin": bool(d.get("is_admin")), "memberships": d.get("memberships", []),
        "coordinator_hubs": d.get("coordinator_hubs", []), "teach_hubs": d.get("teach_hubs", []), "lead_hubs": d.get("lead_hubs", []),
        "teach_any": bool(d.get("teach_any")), "lead_any": bool(d.get("lead_any")),
        "participant_schools": d.get("participant_schools", []), "birth": d.get("birth") or "",
        # 이름은 가입 때 적은 실명으로 굳는다 (전체 관리자만 바꿀 수 있음)
        "name_locked": bool(d.get("name_locked")) and not d.get("is_admin"),
        "gender": d.get("gender") or "", "contact_email": d.get("contact_email") or "", "phone": d.get("phone") or "",
        "subjects": d.get("subjects") or "", "position": d.get("position") or "",
        "photo": f"/api/photos/{d['photo']}" if d.get("photo") else "",
        "needs_terms": needs_terms(d), "ai_ok": bool(d.get("ai_ok_at")),
        # 학교 계정으로 처음 들어와 '학생/선생님'을 아직 안 골랐다
        "role_choice": d["role"] == "student" and not d.get("self_role"),
        "can_be_student": school_account(d["email"]) and d["role"] != "teacher",
        "withdraw_requested": bool(d.get("withdraw_at")), "withdraw_note": d.get("withdraw_note") or "",
        "evidence_reader": bool(d.get("is_admin")) or (
            d["role"] == "teacher" and bool(d.get("participant_schools"))),
    }


def membership_active(m: dict) -> bool:
    # 거점학교 관리교사는 거점학교(hub_id), 참여학교 담당교사는 학교 이름(hub_name)이 있어야 한다.
    # 강의교사는 거점학교 없이도 된다 (과목을 열 때마다 거점학교를 고른다)
    if m["status"] != "approved" or not (m.get("hub_id") or m["role"] == "instructor"
                                         or (m["role"] == "participant" and m.get("hub_name"))):
        return False
    today = today_kst()
    return (not m["valid_from"] or m["valid_from"] <= today) and (not m["valid_until"] or today <= m["valid_until"])


def membership_status(m: dict) -> str:
    """화면용 상태: pending approved scheduled(시작 전) expired(기간 끝) rejected revoked"""
    if m["status"] == "approved" and not membership_active(m):
        return "expired" if m["valid_until"] and m["valid_until"] < today_kst() else "scheduled"
    return m["status"]


def school_account(email: str) -> bool:
    """학생용 학교 계정 도메인인가 (울산처럼 선생님도 같은 도메인을 쓸 수 있다)"""
    domain = email.lower().rsplit("@", 1)[-1]
    return not ALLOWED_DOMAINS or domain in ALLOWED_DOMAINS


def effective_role(email: str, memberships: list[dict], self_role: str = "") -> str:
    email = email.lower()
    if email in ADMIN_EMAILS or email in TEACHER_EMAILS or any(
        membership_active(m) or (m["role"] in ("participant", "coordinator") and m["status"] == "pending" and m.get("transfer_from"))
        for m in memberships
    ):
        return "teacher"
    if school_account(email):
        # 학교 계정이라도 '선생님'을 고르면 강사·관리교사 등록 신청 화면(손님)으로. 승인되면 위에서 teacher
        return "guest" if self_role == "staff" else "student"
    return "guest"


def membership_view(m: dict, hub_names: dict) -> dict:
    return {"id": m["id"], "role": m["role"], "hub_id": m["hub_id"],
            "hub": m["hub_name"] if m.get("transfer_from") else (hub_names.get(m["hub_id"]) or m["hub_name"]), "status": membership_status(m),
            "transfer_from": m.get("transfer_from") or "",
            "valid_from": m["valid_from"], "valid_until": m["valid_until"],
            "wish_from": m["wish_from"], "wish_until": m["wish_until"],
            "contact": m["contact"], "message": m["message"], "admin_note": m["admin_note"],
            "kind": m.get("kind") or "", "affil_type": m.get("affil_type") or "", "affiliation": m.get("affiliation") or "", "office": m.get("office") or "",
            "department": m.get("department") or "",
            "license": m.get("license") or "", "email": m.get("email") or ""}


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
    if u.get("role") == "student" and not u.get("self_role"):
        return True  # 학생인지 선생님인지 먼저 고른다
    if needs_terms(u):
        return True  # 내 정보 화면에서 약관 확인을 함께 받는다
    if not u.get("name"):
        return True
    if u.get("role") == "student":
        return not (u.get("school") and u.get("grade") and u.get("class_no") and u.get("number")
                    and u.get("birth") and u.get("gender"))
    return False


def _get_user(uid: int):
    with db.engine.connect() as c:
        return c.execute(select(db.users).where(db.users.c.id == uid)).first()


def _load_with_role(uid: int) -> dict | None:
    """사용자 + 관리교사·강사 등록 정보를 읽고, 지금 역할을 판단한다(바뀌었으면 저장해 둔다)."""
    with db.engine.begin() as c:
        row = c.execute(select(db.users).where(db.users.c.id == uid)).first()
        if not row or row.account_state != "active":
            return None
        u = dict(row._mapping)
        ms = [dict(r._mapping) for r in c.execute(
            select(db.memberships).where(db.memberships.c.user_id == uid).order_by(db.memberships.c.id))]
        hub_names = dict(c.execute(select(db.hubs.c.id, db.hubs.c.name)).all())
        role = effective_role(u["email"], ms, u.get("self_role") or "")
        if role != u["role"]:
            c.execute(update(db.users).where(db.users.c.id == uid).values(role=role))
            u["role"] = role
    u["is_admin"] = u["email"].lower() in ADMIN_EMAILS
    u["memberships"] = [membership_view(m, hub_names) for m in ms]
    active = [m for m in ms if membership_active(m)]
    # 관리교사는 같은 학교의 거점학교 운영과 참여학교 담당 권한을 함께 가진다.
    # 예전 participant 가입 기록도 관리교사로 취급한다. 강의는 별도 강의교사 승인이 필요하다.
    u["coordinator_hubs"] = sorted({(m["hub_id"], hub_names.get(m["hub_id"], "")) for m in active
                                    if m["role"] in ("coordinator", "participant") and m["hub_id"]})
    u["teach_hubs"] = sorted({(m["hub_id"], hub_names.get(m["hub_id"], "")) for m in active
                              if m["role"] == "instructor" and m["hub_id"]})
    # 강좌를 직접 열 수 있는 거점학교 (팀티칭 보조교사로만 승인된 곳은 빠진다)
    u["lead_hubs"] = sorted({(m["hub_id"], hub_names.get(m["hub_id"], "")) for m in active
                             if m["role"] == "instructor" and m.get("kind") != "assistant" and m["hub_id"]})
    # 거점학교를 정하지 않고 전체 관리자가 승인한 강의교사: 과목을 열 때마다 거점학교를 고른다
    # (과목 개설은 그 거점학교 관리교사가 승인)
    u["teach_any"] = any(m["role"] == "instructor" and not m["hub_id"] for m in active)
    u["lead_any"] = any(m["role"] == "instructor" and not m["hub_id"] and m.get("kind") != "assistant" for m in active)
    u["participant_schools"] = sorted({m["hub_name"] or hub_names.get(m["hub_id"], "") for m in active
                                       if m["role"] in ("coordinator", "participant") and
                                       (m["hub_name"] or hub_names.get(m["hub_id"], ""))})
    u["lead_hubs"] = [{"id": i, "name": n} for i, n in u["lead_hubs"]]
    u["coordinator_hubs"] = [{"id": i, "name": n} for i, n in u["coordinator_hubs"]]
    u["teach_hubs"] = [{"id": i, "name": n} for i, n in u["teach_hubs"]]
    return u


async def current_user(request_or_ws) -> dict | None:
    uid = request_or_ws.session.get("uid")
    session_key = request_or_ws.session.get("auth_key")
    if not uid or not isinstance(session_key, str):
        return None
    session = request_or_ws.session
    if session.get("remember") is False:
        now = time.time()
        is_http = request_or_ws.scope["type"] == "http"
        # 실시간 수업 연결(WebSocket)은 접속할 때의 쿠키를 계속 들고 있어 '화면이 열려 있다' 시각이 갱신되지 않는다.
        # 연결이 살아 있다는 것 자체가 화면이 열려 있다는 뜻이므로, 여기서는 12시간 제한만 본다.
        if now - (session.get("login_at") or 0) > SHORT_SESSION_SECONDS or (is_http and now - (session.get("seen") or 0) > IDLE_SECONDS):
            if hasattr(session, "clear") and request_or_ws.scope["type"] == "http":
                session.clear()  # 브라우저를 닫았다가 다시 열었다 → 로그아웃
            return None
        if request_or_ws.scope["type"] == "http" and now - (session.get("seen") or 0) > 20:
            session["seen"] = int(now)  # 화면이 열려 있다는 신호
    u = await db.run(_load_with_role, uid)
    return u if u and secrets.compare_digest(u["session_key"], session_key) else None


async def require_user(request: Request, role: str | None = None, profile: bool = True) -> dict:
    u = await current_user(request)
    if not u:
        raise HTTPException(401, "로그인이 필요해요.")
    if role and u["role"] != role and not (role == "student" and u["is_admin"]):
        raise HTTPException(403, "강사만 할 수 있어요." if role == "teacher" else "학생 계정으로 로그인해 주세요.")
    if profile and needs_profile(u):
        raise HTTPException(409, "먼저 내 정보를 입력해 주세요.")
    return u


PLEDGE = ("나는 이 플랫폼에서 알게 된 학생의 개인정보(이름·학번·출결·답안·질문·과제와 수업 녹화본 등)를 수업 목적으로만 쓰고, "
          "외부에 제공하거나 게시·유출하지 않으며, 강의가 끝나면 따로 내려받은 자료와 녹화본을 지체 없이 파기하겠습니다.")


def _upsert_user(sub: str, email: str, gname: str, role: str) -> int:
    now = db.now()
    with db.engine.begin() as c:
        row = c.execute(select(db.users).where(db.users.c.google_sub == sub)).first()
        if row:
            if row.account_state != "active":
                raise HTTPException(403, "탈퇴 처리된 계정이에요. 재가입은 운영기관에 문의해 주세요.")
            c.execute(update(db.users).where(db.users.c.id == row.id)
                      .values(email=email, google_name=gname, role=role, last_login=now))
            return row.id
        return c.execute(insert(db.users).values(
            google_sub=sub, email=email, google_name=gname, role=role,
            name=gname[:30] if role == "teacher" else "", created_at=now, last_login=now,
        )).inserted_primary_key[0]


SHORT_SESSION_SECONDS = 12 * 3600  # '자동 로그인'을 안 고르면 최대 12시간
# '자동 로그인'을 안 고른 로그인은 열린 화면이 30초마다 신호를 보낸다(keepalive.js).
# 신호가 이만큼 끊기면(브라우저를 닫음) 로그아웃: 브라우저가 이전 창을 되살려도 다시 로그인해야 한다.
IDLE_SECONDS = 150


async def login_with_identity(request: Request, sub: str, email: str, gname: str, hd: str | None,
                              remember: bool = True) -> dict:
    # 누구나 로그인은 된다. 학교 계정이 아니고 강사로 승인되지 않았으면 '손님'으로 강사 등록 신청만 할 수 있다.
    email = email.lower()
    uid = await db.run(_upsert_user, sub, email, gname, effective_role(email, []))
    request.session.clear()
    request.session["uid"] = uid
    u = await db.run(_load_with_role, uid)
    if not u:
        raise HTTPException(403, "이용할 수 없는 계정이에요.")
    request.session["auth_key"] = u["session_key"]
    # 자동 로그인: 고르면 14일 유지, 안 고르면 브라우저를 닫을 때까지(최대 12시간)
    request.session["remember"] = bool(remember)
    request.session["login_at"] = request.session["seen"] = int(time.time())
    return public_user(u)


class GoogleLogin(BaseModel):
    credential: str = Field(max_length=5000)
    birth: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    remember: bool = False  # 자동 로그인 (로그인 상태 유지)


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
    def already_registered():
        with db.engine.connect() as c:
            return bool(c.execute(select(db.users.c.id).where(db.users.c.google_sub == info["sub"])).first())
    if not await db.run(already_registered):
        if not req.birth:
            raise HTTPException(400, "처음 가입할 때 생년월일을 입력해 주세요.")
        check_student_age(req.birth)
    elif req.birth:
        check_student_age(req.birth)
    return await login_with_identity(request, info["sub"], info["email"], info.get("name", ""), info.get("hd"),
                                     remember=req.remember)


@router.post("/api/auth/ping")
async def ping(request: Request):
    """열린 화면이 30초마다 보내는 신호 (자동 로그인을 안 고른 로그인 유지용)"""
    return {"user": bool(await current_user(request))}


@router.post("/api/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@router.get("/api/me")
async def me(request: Request):
    u = await current_user(request)
    return {
        "user": public_user(u) if u else None,
        "google_client_id": GOOGLE_CLIENT_ID,
        "drive_picker": {"api_key": GOOGLE_API_KEY, "app_id": GOOGLE_APP_ID}
        if GOOGLE_CLIENT_ID and GOOGLE_API_KEY and GOOGLE_APP_ID else None,
        "schools": await db.run(get_schools), "domains": sorted(ALLOWED_DOMAINS), "pledge": PLEDGE,
        "policy_version": POLICY_VERSION, "policy_ready": policy_ready(),
        "recording_allowed": os.environ.get("ALLOW_RECORDING", "1") != "0",
    }


class Profile(BaseModel):
    name: str = Field(min_length=1, max_length=30)
    school: str = Field(default="", max_length=60)
    grade: int | None = Field(default=None, ge=1, le=6)
    class_no: int | None = Field(default=None, ge=1, le=30)
    number: int | None = Field(default=None, ge=1, le=60)
    agree: bool = False  # 이용약관·개인정보 처리방침 확인(동의)
    # 학생: 연령·학번·학교 확인. 선생님: 신청 정보 확인.
    birth: str | None = Field(default=None, pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    gender: str | None = Field(default=None, pattern="^(남|여)?$")
    email: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=100)
    office: str | None = Field(default=None, max_length=30)  # 소속 교육청
    subjects: str | None = Field(default=None, max_length=300)  # 담당과목 (강의교사)
    position: str | None = Field(default=None, max_length=30)  # 직위 (교사·부장교사·교감 등)


@router.post("/api/me/profile")
async def save_profile(p: Profile, request: Request):
    u = await require_user(request, profile=False)
    name = re.sub(r"\s+", " ", p.name).strip()
    school = p.school.strip()
    # 학교 목록은 학생에게만 적용. 강사는 대학교수 등 학교 밖 사람일 수 있어 소속을 자유롭게 적는다.
    schools = await db.run(get_schools)
    if u["role"] == "student" and schools and school not in schools:
        raise HTTPException(400, "목록에 있는 학교를 골라 주세요. 학교가 목록에 없으면 선생님께 알려 주세요.")
    if u["name"] and school != (u["school"] or ""):
        approver = "새 학교의 참여학교 담당교사" if u["role"] == "student" else "전체 관리자"
        raise HTTPException(400, f"소속 변경은 내 정보에서 신청한 뒤 {approver}의 승인을 받아야 해요.")
    values = {"name": name, "school": school}
    if u["name"] and name != (u["name"] or "") and not u["is_admin"]:
        raise HTTPException(400, NAME_LOCKED)
    if name and not u["is_admin"]:
        values["name_locked"] = 1
    if needs_terms(u):
        if not p.agree:
            raise HTTPException(400, "먼저 이용약관과 개인정보 수집·이용에 동의해 주세요.")
        values.update(terms_version=POLICY_VERSION, terms_at=time.time())
    if u["role"] == "student":
        birth = p.birth if p.birth is not None else (u.get("birth") or "")
        gender = p.gender if p.gender is not None else (u.get("gender") or "")
        if not birth or not gender:
            raise HTTPException(400, "생년월일과 성별을 입력해 주세요.")
        check_student_age(birth)
        check_school_gender(school, gender)
        values.update(self_role="student", birth=birth, gender=gender)
        if not (school and p.grade and p.class_no and p.number):
            raise HTTPException(400, "학교, 학년, 반, 번호를 모두 입력해 주세요.")
        values.update(grade=p.grade, class_no=p.class_no, number=p.number)
    else:  # 선생님: 생년월일 · 성별 · 이메일 · 연락처
        if p.birth:
            check_student_age(p.birth)
            values["birth"] = p.birth
        if p.gender is not None:
            if u.get("gender") and p.gender != u["gender"]:
                raise HTTPException(400, "등록된 성별은 내 정보에서 직접 바꿀 수 없어요.")
            values["gender"] = p.gender
        if p.email is not None:
            if p.email.strip() and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", p.email.strip()):
                raise HTTPException(400, "이메일 주소를 정확히 적어 주세요.")
            values["contact_email"] = p.email.strip()
        if p.phone is not None:
            values["phone"] = p.phone.strip()
        if p.subjects is not None:
            values["subjects"] = " ".join(p.subjects.split())
        if p.position is not None:
            values["position"] = " ".join(p.position.split())
        if p.office:
            from app.subjects import OFFICES
            if p.office not in OFFICES:
                raise HTTPException(400, "소속 교육청을 목록에서 골라 주세요.")

    def save():
        with db.engine.begin() as c:
            c.execute(update(db.users).where(db.users.c.id == u["id"]).values(**values))
            if u["is_admin"] and u["name"] and name != u["name"]:
                c.execute(update(db.courses).where(db.courses.c.teacher_id == u["id"],
                    db.courses.c.instructor == u["name"]).values(instructor=name))
            # 승인하는 사람이 보는 등록 신청서의 연락처도 함께 고친다
            ms = {k: v for k, v in (("email", values.get("contact_email")), ("contact", values.get("phone")),
                                    ("office", p.office if u["role"] != "student" else None)) if v}
            if ms:
                c.execute(update(db.memberships).where(db.memberships.c.user_id == u["id"]).values(**ms))
    await db.run(save)
    result = public_user(await db.run(_load_with_role, u["id"]))
    result["school_transfer_requested"] = False
    return result


class SchoolTransfer(BaseModel):
    role: str = Field(pattern="^(participant|coordinator)$")
    school: str = Field(min_length=1, max_length=60)


@router.post("/api/me/school-transfer")
async def request_school_transfer(p: SchoolTransfer, request: Request):
    """담당 학교 변경은 즉시 권한을 끄고 전체 관리자 승인 대기로 전환한다."""
    u = await require_user(request)
    school = p.school.strip()
    schools = await db.run(get_schools)
    if not school or (schools and school not in schools):
        raise HTTPException(400, "변경할 학교를 학교 목록에서 골라 주세요.")

    def save():
        m = db.memberships.c
        with db.engine.begin() as c:
            rows = c.execute(select(db.memberships).where(m.user_id == u["id"], m.role == p.role)).all()
            active = [r for r in rows if membership_active(dict(r._mapping)) or
                      (r.status == "pending" and r.transfer_from)]
            if len(rows) != 1 or len(active) != 1:
                raise HTTPException(409, "담당 학교 권한을 확인할 수 없어요. 전체 관리자에게 문의해 주세요.")
            row = active[0]
            if row.hub_name == school or row.transfer_from == school:
                raise HTTPException(400, "현재 담당 학교와 같은 학교예요.")
            others = [r for r in c.execute(select(db.memberships).where(
                m.user_id == u["id"], m.role.in_(["participant", "coordinator"]), m.id != row.id))
                if membership_active(dict(r._mapping)) or (r.status == "pending" and r.transfer_from)]
            if others:
                raise HTTPException(409, "담당 역할이 둘 이상이면 전체 관리자에게 학교 변경을 요청해 주세요.")
            c.execute(update(db.memberships).where(m.id == row.id).values(
                status="pending", transfer_from=row.transfer_from or row.hub_name,
                hub_name=school, requested_at=time.time(), decided_at=None, decided_by=None, admin_note=""))

    await db.run(save)
    from app.classroom import refresh_user_connections
    await refresh_user_connections(u["id"])
    return public_user(await db.run(_load_with_role, u["id"]))


class ProfileChangeReq(BaseModel):
    field: str = Field(pattern="^(name|school)$")
    value: str = Field(min_length=1, max_length=60)


@router.get("/api/me/change-requests")
async def my_profile_change_requests(request: Request):
    u = await require_user(request, profile=False)

    def run():
        q = db.profile_change_requests.c
        with db.engine.connect() as c:
            rows = c.execute(select(db.profile_change_requests).where(q.user_id == u["id"])
                             .order_by(q.requested_at.desc()).limit(20)).all()
            return [{"id": r.id, "field": r.field, "old_value": r.old_value,
                     "new_value": r.new_value, "status": r.status, "note": r.note} for r in rows]

    return {"requests": await db.run(run)}


@router.post("/api/me/change-requests")
async def request_profile_change(req: ProfileChangeReq, request: Request):
    u = await require_user(request)
    value = re.sub(r"\s+", " ", req.value).strip()
    if not u["name"] or not value:
        raise HTTPException(400, "먼저 가입 정보를 완료해 주세요.")
    if req.field == "name":
        if len(value) > 30:
            raise HTTPException(400, "이름은 30자 이하로 적어 주세요.")
    else:
        managers = [m for m in u["memberships"] if m["role"] in ("participant", "coordinator") and
                    (m["status"] in ("approved", "scheduled") or (m["status"] == "pending" and m.get("transfer_from")))]
        if managers:
            raise HTTPException(409, "담당 학교 변경은 소속 옆의 변경 신청 버튼에서 요청해 주세요.")
        if u["role"] == "student":
            schools = await db.run(get_schools)
            if schools and value not in schools:
                raise HTTPException(400, "목록에 있는 학교를 골라 주세요.")
            check_school_gender(value, u.get("gender") or "")
    old = (u[req.field] or "").strip()
    if value == old:
        raise HTTPException(400, "현재 정보와 같아요.")

    def save():
        q = db.profile_change_requests.c
        with db.engine.begin() as c:
            pending = c.execute(select(db.profile_change_requests).where(
                q.user_id == u["id"], q.field == req.field, q.status == "pending")
                .order_by(q.requested_at.desc()).limit(1)).first()
            values = {"old_value": old, "new_value": value, "requested_at": time.time(), "note": ""}
            if pending:
                c.execute(update(db.profile_change_requests).where(q.id == pending.id).values(**values))
                return pending.id
            return c.execute(insert(db.profile_change_requests).values(
                user_id=u["id"], field=req.field, status="pending", **values)).inserted_primary_key[0]

    return {"id": await db.run(save), "status": "pending"}


PHOTO_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}


def photo_dir():
    from app.assignments import FILES_DIR  # 과제 파일과 같은 곳에 둔다
    return FILES_DIR / "photos"


def _set_photo(uid: int, fid: str) -> None:
    """프로필 사진을 바꾸거나(fid) 지운다(""). 예전 사진 파일은 지운다."""
    with db.engine.begin() as c:
        old = c.execute(select(db.users.c.photo).where(db.users.c.id == uid)).scalar() or ""
        c.execute(update(db.users).where(db.users.c.id == uid).values(photo=fid))
    if old and old != fid:
        from app.wipe import wipe
        wipe(photo_dir() / old)


@router.post("/api/me/photo")
async def upload_photo(request: Request, name: str = Query(default="photo.jpg", max_length=150)):
    """프로필 사진 올리기 (PNG·JPG·WEBP, 2MB까지). 요청 본문 = 그림 파일 그대로"""
    u = await require_user(request, profile=False)
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in PHOTO_TYPES:
        raise HTTPException(415, "사진은 PNG, JPG, WEBP 파일로 올려 주세요.")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > 2 * 1024 * 1024:
            raise HTTPException(413, "사진이 너무 커요. 2MB 이하로 올려 주세요.")
    if not data:
        raise HTTPException(400, "사진 파일이 비어 있어요.")
    fid = f"{uuid.uuid4().hex}.{'jpg' if ext == 'jpeg' else ext}"

    def save():
        photo_dir().mkdir(parents=True, exist_ok=True)
        (photo_dir() / fid).write_bytes(data)
        _set_photo(u["id"], fid)

    await db.run(save)
    return public_user(await db.run(_load_with_role, u["id"]))


@router.delete("/api/me/photo")
async def delete_photo(request: Request):
    u = await require_user(request, profile=False)
    await db.run(_set_photo, u["id"], "")
    return public_user(await db.run(_load_with_role, u["id"]))


@router.get("/api/photos/{fid}")
async def photo(fid: str, request: Request):
    """프로필 사진: 로그인한 사람만 본다 (파일 이름은 추측할 수 없는 무작위 값)"""
    await require_user(request, profile=False)
    stem, _, ext = fid.partition(".")
    if not stem.isalnum() or ext not in PHOTO_TYPES:
        raise HTTPException(404)
    path = photo_dir() / fid
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type=PHOTO_TYPES[ext], headers={"Cache-Control": "private, max-age=86400"})


class Consent(BaseModel):
    terms: bool = False  # 이용약관 동의 (필수)
    privacy: bool = False  # 개인정보 수집·이용 동의 (필수)
    birth: str = ""  # 학생은 동의 확정 전에 연령 확인


@router.post("/api/me/consent")
async def consent(req: Consent, request: Request):
    """회원가입 첫 단계: 학생·선생님 모두 이용약관과 개인정보 수집·이용에 동의해야 다음으로 간다."""
    u = await require_user(request, profile=False)
    if not (req.terms and req.privacy):
        raise HTTPException(400, "이용약관과 개인정보 수집·이용에 모두 동의해야 가입할 수 있어요.")
    if u["role"] == "student":
        check_student_age(req.birth or u.get("birth") or "")

    def save():
        with db.engine.begin() as c:
            values = {"terms_version": POLICY_VERSION, "terms_at": time.time()}
            if u["role"] == "student":
                values["birth"] = req.birth or u.get("birth")
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


class SelfRole(BaseModel):
    role: str = Field(pattern="^(student|staff)$")


@router.post("/api/me/self-role")
async def choose_self_role(req: SelfRole, request: Request):
    """학교 계정으로 들어온 사람이 학생인지 선생님(강사·관리교사 신청)인지 고른다.
    선생님을 골라도 승인 전에는 아무 권한이 없으므로 학생이 잘못 골라도 위험하지 않다."""
    u = await current_user(request)
    if not u:
        raise HTTPException(401, "로그인이 필요해요.")
    if not school_account(u["email"]) or u["email"].lower() in ADMIN_EMAILS | TEACHER_EMAILS:
        raise HTTPException(400, "학교 계정만 고를 수 있어요.")

    def save():
        with db.engine.begin() as c:
            c.execute(update(db.users).where(db.users.c.id == u["id"]).values(self_role=req.role))

    await db.run(save)
    return public_user(await db.run(_load_with_role, u["id"]))


NAME_LOCKED = "이름 변경은 내 정보에서 신청한 뒤 전체 관리자 승인을 받아야 해요."


class Withdraw(BaseModel):
    confirm: str
    reason: str = Field(default="", max_length=300)
    keep_name_ok: bool = False  # 직접 연 과목·수업이 있는 선생님: '이름은 기록에 남는다'는 안내를 확인함


def _purge_user_rows(c, uid: int, keep_account: bool = False) -> list:
    """활성 표에서 제거한다. 학생은 암호화 증빙을 만든 트랜잭션 안에서만 호출한다."""
    from app.assignments import file_path  # 순환 import 를 피한다

    photo = c.execute(select(db.users.c.photo).where(db.users.c.id == uid)).scalar() or ""
    for a in c.execute(select(db.activities.c.id, db.activities.c.responses)).all():
        resp = json.loads(a.responses or "{}")
        if str(uid) in resp:
            resp.pop(str(uid))
            c.execute(update(db.activities).where(db.activities.c.id == a.id)
                      .values(responses=json.dumps(resp, ensure_ascii=False)))
    subs = c.execute(select(db.submissions.c.id, db.submissions.c.assignment_id)
                     .where(db.submissions.c.user_id == uid)).all()
    files = c.execute(select(db.submission_files.c.id, db.submission_files.c.submission_id)
                      .where(db.submission_files.c.submission_id.in_([s.id for s in subs] or [-1]))).all()
    aid_of = {s.id: s.assignment_id for s in subs}
    c.execute(delete(db.submission_files).where(db.submission_files.c.submission_id.in_(list(aid_of) or [-1])))
    c.execute(delete(db.submissions).where(db.submissions.c.user_id == uid))
    # 희망과목 신청 글과 공감은 통계용으로 남기고, 누가 썼는지·누가 공감했는지만 알 수 없게 한다
    from app.privacy_filter import redact
    who = c.execute(select(db.users.c.name, db.users.c.google_name).where(db.users.c.id == uid)).first()
    names = [n for n in ((who.name, who.google_name) if who else ()) if n]
    for r in c.execute(select(db.course_requests.c.id, db.course_requests.c.note)
                       .where(db.course_requests.c.user_id == uid)).all():
        c.execute(update(db.course_requests).where(db.course_requests.c.id == r.id)
                  .values(user_id=0, note=redact(r.note or "", names)))
    for rid in c.execute(select(db.course_request_likes.c.request_id)
                         .where(db.course_request_likes.c.user_id == uid)).scalars().all():
        c.execute(update(db.course_request_likes).where(db.course_request_likes.c.request_id == rid,
                                                       db.course_request_likes.c.user_id == uid)
                  .values(user_id=-secrets.randbelow(2 ** 31 - 2) - 1))  # 누구 것인지 알 수 없는 번호
    for table in (db.grades, db.questions, db.attendance, db.enrollments, db.memberships):
        c.execute(delete(table).where(table.c.user_id == uid))
    c.execute(delete(db.community_posts).where(db.community_posts.c.author_id == uid))
    c.execute(delete(db.profile_change_requests).where(db.profile_change_requests.c.user_id == uid))
    if keep_account:
        # 접속 차단에 필요한 Google 주체 ID와 무작위 세션 키만 남긴다.
        c.execute(update(db.users).where(db.users.c.id == uid).values(
            account_state="withdrawn", session_key=uuid.uuid4().hex, role="withdrawn", email="", google_name="",
            name="", school="", grade=None, class_no=None, number=None, birth="", gender="", contact_email="",
            phone="", subjects="", position="", photo="", withdraw_at=None, withdraw_reason="", withdraw_note="",
            terms_version="", terms_at=None, ai_ok_at=None, self_role="", last_login=None))
    else:
        c.execute(delete(db.users).where(db.users.c.id == uid))
    paths = [file_path(aid_of[f.submission_id], f.id) for f in files]
    if photo:
        paths.append(photo_dir() / photo)
    return paths


def _withdraw(uid: int) -> None:
    """수업을 보유하지 않은 비학생 계정의 탈퇴."""
    with db.engine.begin() as c:
        cleanup = _purge_user_rows(c, uid)
    from app.wipe import wipe
    for path in cleanup:
        wipe(path)


def _withdraw_teacher_keep_name(uid: int) -> None:
    """직접 연 과목·수업이 있는 선생님의 탈퇴: 계정과 개인정보는 지우고, 과목·수업과 학생 기록은 남긴다.
    나중에 문제가 생겼을 때 찾을 수 있도록 '이름'만 기록에 남긴다. 같은 구글 계정으로 다시 가입할 수 있다."""
    with db.engine.begin() as c:
        name = c.execute(select(db.users.c.name, db.users.c.google_name).where(db.users.c.id == uid)).first()
        keep = (name.name or name.google_name or "") if name else ""
        cleanup = _purge_user_rows(c, uid, keep_account=True)
        c.execute(update(db.users).where(db.users.c.id == uid).values(
            name=keep[:30], google_sub=f"withdrawn-{uuid.uuid4().hex}"))  # 로그인 연결은 끊는다 (다시 가입하면 새 계정)
        c.execute(update(db.courses).where(db.courses.c.teacher_id == uid).values(open=0))  # 더는 수강신청을 받지 않는다
    from app.wipe import wipe
    for path in cleanup:
        wipe(path)


def owns_classes(uid: int) -> bool:
    """직접 연 강좌·수업이 있는지 (있으면 학생 기록이 딸려 있어 탈퇴로 지울 수 없다)"""
    with db.engine.connect() as c:
        return bool(c.execute(select(db.courses.c.id).where(db.courses.c.teacher_id == uid).limit(1)).first()
                    or c.execute(select(db.classes.c.id).where(db.classes.c.teacher_id == uid).limit(1)).first())


@router.post("/api/me/withdraw")
async def withdraw(req: Withdraw, request: Request):
    """회원 탈퇴.
    - 학생: 탈퇴 신청만 한다. 그 학생 소속 학교의 참여학교 담당교사(없으면 전체 관리자)가 승인하면 지워진다.
      강좌 중간에 기록이 사라지는 일을 막기 위해서다.
    - 그 밖의 사람: 바로 지운다. 다만 직접 연 강좌·수업이 있으면(학생 기록이 딸려 있음) 탈퇴할 수 없다."""
    u = await current_user(request)
    if not u:
        raise HTTPException(401, "로그인이 필요해요.")
    if req.confirm.strip() != "탈퇴":
        raise HTTPException(400, "확인 칸에 '탈퇴'라고 적어 주세요.")
    if u["role"] != "student" and await db.run(owns_classes, u["id"]):
        if not req.keep_name_ok:
            raise HTTPException(409, "직접 연 과목이나 수업이 있어요. 학생 기록을 지키기 위해 과목·수업 기록과 선생님 이름은 남는다는 안내를 확인해 주세요.")
        await db.run(_withdraw_teacher_keep_name, u["id"])
        request.session.clear()
        return {"ok": True, "requested": False, "kept_name": True}
    if u["role"] == "student":
        def ask():
            with db.engine.begin() as c:
                c.execute(update(db.users).where(db.users.c.id == u["id"]).values(
                    withdraw_at=time.time(), withdraw_reason=req.reason.strip(), withdraw_note=""))

        await db.run(ask)
        return {"ok": True, "requested": True}
    await db.run(_withdraw, u["id"])
    request.session.clear()
    return {"ok": True, "requested": False}


@router.post("/api/me/withdraw/cancel")
async def withdraw_cancel(request: Request):
    u = await require_user(request, profile=False)

    def run():
        with db.engine.begin() as c:
            c.execute(update(db.users).where(db.users.c.id == u["id"]).values(withdraw_at=None, withdraw_note=""))

    await db.run(run)
    return {"ok": True}
