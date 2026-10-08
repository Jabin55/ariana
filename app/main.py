"""고등학교 정치 과목 질의응답 챗봇 웹 서버.

브라우저가 대화 기록을 들고 있다가 매 질문마다 /api/chat 으로 보내고,
서버는 Claude 응답을 Server-Sent Events(SSE)로 스트리밍한다.
"""

import json
import logging
import os
from pathlib import Path
from typing import Literal

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.prompts import SYSTEM_PROMPT

MODEL = os.environ.get("CHATBOT_MODEL", "claude-opus-5-5")
# 채팅은 깊은 추론보다 빠른 응답이 중요하므로 low부터 시작한다.
EFFORT = os.environ.get("CHATBOT_EFFORT", "low")
MAX_TURNS = 40  # 브라우저에서 보내는 대화 기록 최대 길이(메시지 수)
MAX_CHARS = 4000  # 메시지 하나당 최대 글자 수

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

log = logging.getLogger("politics-chatbot")
client = anthropic.AsyncAnthropic()
app = FastAPI(title="정치쌤 챗봇")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_CHARS)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_TURNS)


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    messages = [m.model_dump() for m in req.messages]
    if messages[0]["role"] != "user" or messages[-1]["role"] != "user":
        raise HTTPException(400, "대화는 학생 질문으로 시작하고 끝나야 합니다.")

    async def generate():
        try:
            async with client.beta.messages.stream(
                model=MODEL,
                max_tokens=16000,
                # 정책상 거절되면 서버에서 다른 모델로 자동 재시도한다.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
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
        except Exception:  # API 키 누락 등 설정 오류
            log.exception("챗봇 응답 생성 실패")
            yield sse("error", {"text": "챗봇 설정에 문제가 있어요. 선생님께 알려 주세요."})

    return StreamingResponse(generate(), media_type="text/event-stream")
