"""자막 서버의 인증과 본문 제한. 실제 모델 호출 대신 작은 가짜 모델을 사용한다."""

import importlib.util
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient


def test_caption_worker_auth_and_audio_limit(monkeypatch):
    class FakeModel:
        def __init__(self, *args, **kwargs):
            pass

        def transcribe(self, audio, **kwargs):
            assert audio.read() == b"audio" * 30
            assert kwargs["language"] == "ko"
            return [types.SimpleNamespace(text=" 안녕하세요. ")], None

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=FakeModel))
    monkeypatch.setenv("CAPTION_WORKER_TOKEN", "private-test-token")
    path = Path(__file__).resolve().parents[1] / "caption-worker" / "app.py"
    spec = importlib.util.spec_from_file_location("caption_worker_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    headers = {"Authorization": "Bearer private-test-token", "Content-Type": "audio/webm"}
    with TestClient(module.app) as client:
        assert client.post("/transcribe", content=b"audio" * 30).status_code == 401
        assert client.post("/transcribe", content=b"audio" * 30,
                           headers={**headers, "Authorization": "Bearer wrong"}).status_code == 401
        assert client.post("/transcribe", content=b"audio" * 30, headers=headers).json() == {"text": "안녕하세요."}
        assert client.post("/transcribe", content=b"x" * (module.MAX_AUDIO_BYTES + 1),
                           headers=headers).status_code == 413
