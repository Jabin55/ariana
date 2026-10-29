"""고등학교 정치 과목 질의응답 챗봇 웹 서버.

브라우저가 대화 기록을 들고 있다가 매 질문마다 /api/chat 으로 보내고,
서버는 Claude 응답을 Server-Sent Events(SSE)로 스트리밍한다.
"""

import asyncio
import json
import logging
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware

from app import db
from app.admin import router as admin_router
from app.policy import router as policy_router
from app.materials import router as materials_router
from app.assignments import router as assignments_router
from app.site import router as site_router
from app.auth import router as auth_router
from app.classroom import heartbeat_loop, router as live_router
from app.courses import router as courses_router
from app.grading import router as grading_router
from app.history import router as history_router
from app.prompts import SYSTEM_PROMPT
from app.evidence import retention_loop, router as evidence_router
from app.file_retention import file_retention_loop
from app.access_log import AccessLogMiddleware, router as access_log_router
from app.privacy_filter import known_member_names, redact_messages

# AI 조교는 비용을 아끼기 위해 가장 가벼운(저렴한) 모델을 쓴다. 바꾸려면 CHATBOT_MODEL 설정
MODEL = os.environ.get("CHATBOT_MODEL", "claude-haiku-5-5")
# 채팅은 깊은 추론보다 빠른 응답이 중요하므로 low부터 시작한다.
EFFORT = os.environ.get("CHATBOT_EFFORT", "low")
MAX_TURNS = 40  # 브라우저에서 보내는 대화 기록 최대 길이(메시지 수)
MAX_CHARS = 4000  # 메시지 하나당 최대 글자 수

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

log = logging.getLogger("politics-chatbot")
client = anthropic.AsyncAnthropic()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await db.run(db.init)
    task = asyncio.create_task(heartbeat_loop())
    retention_task = asyncio.create_task(retention_loop())
    files_task = asyncio.create_task(file_retention_loop())  # 과목 끝나고 1년 지난 수업 자료·과제 파일 삭제
    yield
    task.cancel()
    retention_task.cancel()
    files_task.cancel()


SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_urlsafe(32)
if not os.environ.get("SECRET_KEY"):
    log.warning("SECRET_KEY 가 없어 임시 키를 씁니다. 서버가 다시 시작되면 모두 다시 로그인해야 해요.")

app = FastAPI(title="정치쌤 챗봇", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def private_validation_error(request, exc):
    return JSONResponse({"detail": [{k: e[k] for k in ("type", "loc", "msg") if k in e}
                                    for e in exc.errors()]}, status_code=422)
app.add_middleware(AccessLogMiddleware)  # 세션 안쪽: 누가 학생 정보를 봤는지 남긴다
app.add_middleware(
    SessionMiddleware, secret_key=SECRET_KEY, session_cookie="live_session",
    max_age=14 * 24 * 3600, same_site="lax",
    https_only=bool(os.environ.get("RENDER") or os.environ.get("COOKIE_SECURE")),
)


class BrowserSessionCookie:
    """'자동 로그인'을 안 고른 로그인은 로그인 쿠키를 브라우저를 닫으면 사라지게(만료일 없이) 보낸다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_wrapper(message):
            if message["type"] == "http.response.start" and scope.get("session", {}).get("remember") is False:
                headers = []
                for k, v in message.get("headers", []):
                    if k.lower() == b"set-cookie" and v.startswith(b"live_session="):
                        v = b"; ".join(p for p in v.split(b"; ") if not p.lower().startswith((b"max-age=", b"expires=")))
                    headers.append((k, v))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(BrowserSessionCookie)  # SessionMiddleware 바깥에서 쿠키를 고친다


@app.middleware("http")
async def fresh_pages(request, call_next):
    """화면 파일(HTML·CSS·JS)은 브라우저가 매번 새 버전이 있는지 확인하게 한다 (업데이트가 바로 보이도록).
    바뀌지 않았으면 304로 짧게 끝난다. 글꼴은 잘 안 바뀌므로 일주일 보관."""
    response = await call_next(request)
    path = request.url.path
    if "cache-control" not in response.headers and (path.startswith("/static/") or path == "/live" or path.startswith("/live/")):
        response.headers["Cache-Control"] = "public, max-age=604800" if "/fonts/" in path else "no-cache"
    return response

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(auth_router)
app.include_router(live_router)
app.include_router(history_router)
app.include_router(grading_router)
app.include_router(courses_router)
app.include_router(admin_router)
app.include_router(policy_router)
app.include_router(materials_router)
app.include_router(assignments_router)
app.include_router(site_router)
app.include_router(evidence_router)
app.include_router(access_log_router)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_CHARS)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_TURNS)


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# APP_MODE=live 이면 이 서버는 '실시간 수업' 전용 사이트다: 첫 주소(/)가 바로 수업 화면으로 간다.
APP_MODE = os.environ.get("APP_MODE", "chatbot")


@app.get("/", response_model=None)
async def index() -> FileResponse | RedirectResponse:
    if APP_MODE == "live":
        return RedirectResponse("/live/home")
    return FileResponse(STATIC_DIR / "index.html")


# ── 앱처럼 설치하기 (PWA): 설정 파일과 서비스 워커는 사이트 맨 위 주소에 있어야 사이트 전체를 맡는다 ──
@app.get("/manifest.webmanifest", include_in_schema=False)
async def web_manifest() -> FileResponse:
    return FileResponse(STATIC_DIR / "live" / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js", include_in_schema=False)
async def service_worker() -> FileResponse:
    # 늘 새로 받아 가게 해서, 서비스 워커를 고치면 다음 접속 때 바로 바뀐다
    return FileResponse(STATIC_DIR / "live" / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache"})


# ── 실시간 수업 화면 ──
@app.get("/live")
async def live_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "live" / "index.html")


@app.get("/live/teacher/{code}")
async def live_teacher(code: str) -> FileResponse:
    return FileResponse(STATIC_DIR / "live" / "teacher.html")


@app.get("/live/materials")
async def live_materials() -> FileResponse:
    return FileResponse(STATIC_DIR / "live" / "materials.html")


@app.get("/live/class/{code}")
async def live_student(code: str) -> FileResponse:
    return FileResponse(STATIC_DIR / "live" / "student.html")


@app.post("/api/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    names = await db.run(known_member_names)
    messages = redact_messages([m.model_dump() for m in req.messages], names)
    if messages[0]["role"] != "user" or messages[-1]["role"] != "user":
        raise HTTPException(400, "대화는 학생 질문으로 시작하고 끝나야 합니다.")

    async def generate():
        try:
            # 정책상 거절되면 서버에서 다른 모델로 자동 재시도한다 (Haiku 는 이 기능이 없어 보내지 않는다)
            fallback = {} if "haiku" in MODEL else {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
            async with client.beta.messages.stream(
                model=MODEL,
                max_tokens=16000,
                **fallback,
                system=[{
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }],
                thinking={"type": "adaptive"},
                output_config={"effort": EFFORT},
                messages=messages,
            ) as stream:
                async for text in stream.text_stream:
                    yield sse("delta", {"text": text})
                final = await stream.get_final_message()

            if final.stop_reason == "refusal":
                yield sse("refusal", {
                    "text": "이 질문에는 답변하기 어려워요. 정치 과목과 관련된 다른 질문을 해 주세요.",
                })
            elif final.stop_reason == "max_tokens":
                yield sse("delta", {"text": "\n\n(답변이 너무 길어 중간에 끊겼어요. '이어서 설명해 줘'라고 말해 주세요.)"})
            yield sse("done", {})
        except anthropic.RateLimitError:
            yield sse("error", {"text": "지금 질문이 많이 몰렸어요. 잠시 후 다시 시도해 주세요."})
        except anthropic.APIStatusError as e:
            log.exception("Claude API 오류 (status=%s)", e.status_code)
            yield sse("error", {"text": "답변을 만드는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요."})
        except anthropic.APIConnectionError:
            log.exception("Claude API 연결 실패")
            yield sse("error", {"text": "서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요."})
        except Exception as error:  # 원문 예외에는 개인정보가 들어 있을 수 있다.
            log.error("챗봇 응답 생성 실패 (%s)", type(error).__name__)
            yield sse("error", {"text": "챗봇 설정에 문제가 있어요. 선생님께 알려 주세요."})

    return StreamingResponse(generate(), media_type="text/event-stream")
