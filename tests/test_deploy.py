"""화상 서버 설치 스크립트 테스트"""

import os
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy" / "livekit"
sys.path.insert(0, str(DEPLOY))
import make_cloud_init  # noqa: E402


def test_cloud_init_matches_setup_script():
    # setup.sh 를 고치면 make_cloud_init.py 로 cloud-init.yaml 도 다시 만들어야 한다
    assert (DEPLOY / "cloud-init.yaml").read_text(encoding="utf-8") == make_cloud_init.build()
    data = yaml.safe_load((DEPLOY / "cloud-init.yaml").read_text(encoding="utf-8"))
    assert data["write_files"][0]["content"] == (DEPLOY / "setup.sh").read_text(encoding="utf-8")


def run_setup(tmp_path, *args):
    env = {**os.environ, "SKIP_SYSTEM": "1", "LIVEKIT_DIR": str(tmp_path), "SERVER_IP": "49.12.34.56",
           "LIVEKIT_INFO": str(tmp_path / "info.txt")}
    out = subprocess.run(["bash", str(DEPLOY / "setup.sh"), *args], env=env, capture_output=True, text=True, check=True)
    return out.stdout


def test_setup_generates_configs_and_keeps_keys(tmp_path):
    out = run_setup(tmp_path)
    assert "LIVEKIT_URL=wss://live.49-12-34-56.sslip.io" in out
    lk = yaml.safe_load((tmp_path / "livekit.yaml").read_text())
    assert lk["turn"]["domain"] == "turn.live.49-12-34-56.sslip.io"
    assert lk["turn"]["external_tls"] and lk["turn"]["proxy_protocol"]
    (key, secret), = lk["keys"].items()
    assert key.startswith("API") and len(secret) >= 32
    caddy = yaml.safe_load((tmp_path / "caddy.yaml").read_text())
    assert caddy["apps"]["tls"]["certificates"]["automate"] == [
        "live.49-12-34-56.sslip.io", "turn.live.49-12-34-56.sslip.io"]
    compose = yaml.safe_load((tmp_path / "docker-compose.yaml").read_text())
    assert all(s["restart"] == "unless-stopped" for s in compose["services"].values())
    # 다시 실행해도(내 도메인으로 바꿔도) 키는 그대로
    out2 = run_setup(tmp_path, "live.myschool.kr")
    assert "LIVEKIT_URL=wss://live.myschool.kr" in out2
    lk2 = yaml.safe_load((tmp_path / "livekit.yaml").read_text())
    assert lk2["keys"] == lk["keys"] and lk2["turn"]["domain"] == "turn.live.myschool.kr"
