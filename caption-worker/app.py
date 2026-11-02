"""외솔온닷의 교사 음성 조각을 한국어로 인식하는 별도 서버.

음성·인식 결과를 파일이나 DB에 기록하지 않는다. 서버 접근 로그에도 본문은 남기지 않는다.
"""

import asyncio
import hmac
import os
from contextlib import asynccontextmanager
from io import BytesIO

from fastapi import FastAPI, HTTPException, Request
from faster_whisper import WhisperModel

MAX_AUDIO_BYTES = 512 * 1024
model = None
recognition_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global model
    if not os.environ.get("CAPTION_WORKER_TOKEN"):
        raise RuntimeError("CAPTION_WORKER_TOKEN is required")
    model = await asyncio.to_thread(
        WhisperModel, os.environ.get("CAPTION_MODEL", "small"),
        device="cpu", compute_type="int8", cpu_threads=int(os.environ.get("CAPTION_CPU_THREADS", "4")),
        num_workers=1,
    )
    yield


app = FastAPI(title="외솔온닷 자막 서버", docs_url=None, redoc_url=None,
              openapi_url=None, lifespan=lifespan)


def recognize(audio: bytes) -> str:
    segments, _ = model.transcribe(BytesIO(audio), language="ko", beam_size=1,
                                   vad_filter=True, condition_on_previous_text=False)
    return " ".join(segment.text.strip() for segment in segments).strip()[:300]


@app.post("/transcribe")
async def transcribe(request: Request):
    configured = os.environ.get("CAPTION_WORKER_TOKEN", "")
    supplied = request.headers.get("authorization", "")
    if not configured or not hmac.compare_digest(supplied, f"Bearer {configured}"):
        raise HTTPException(401, "인증이 필요합니다.")
    mime = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if mime not in {"audio/webm", "audio/mp4", "video/webm", "video/mp4"}:
        raise HTTPException(415, "지원하지 않는 형식입니다.")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_AUDIO_BYTES:
            raise HTTPException(413, "음성 조각이 너무 큽니다.")
    if len(data) < 100:
        raise HTTPException(400, "음성 조각이 비어 있습니다.")
    if recognition_lock.locked():
        raise HTTPException(429, "음성인식 중입니다.")
    async with recognition_lock:
        try:
            return {"text": await asyncio.to_thread(recognize, bytes(data))}
        except Exception:
            raise HTTPException(422, "음성을 인식할 수 없습니다.") from None
