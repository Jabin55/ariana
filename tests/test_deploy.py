"""수업 서버 설치 스크립트 테스트 (수업 사이트 + 화상 서버 + 데이터베이스를 한 서버에)"""

import os
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy" / "server"
sys.path.insert(0, str(DEPLOY))
import make_cloud_init  # noqa: E402


def test_cloud_init_matches_setup_script():
    # setup.sh 를 고치면 make_cloud_init.py 로 cloud-init.yaml 도 다시 만들어야 한다
    assert (DEPLOY / "cloud-init.yaml").read_text(encoding="utf-8") == make_cloud_init.build()
    data = yaml.safe_load((DEPLOY / "cloud-init.yaml").read_text(encoding="utf-8"))
    files = {f["path"]: f["content"] for f in data["write_files"]}
    assert files["/root/setup.sh"] == (DEPLOY / "setup.sh").read_text(encoding="utf-8")
    assert "ADMIN_EMAILS=\n" in files["/root/live-settings.env"]


def env_dict(path: Path) -> dict:
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if line and not line.startswith("#"))


def run_setup(tmp_path, *args):
    settings = tmp_path / "settings.env"
    settings.write_text("# 메모\nADMIN_EMAILS=boss@gmail.com\nALLOWED_DOMAINS=s.school.kr\r\n")
    env = {**os.environ, "SKIP_SYSTEM": "1", "LIVE_DIR": str(tmp_path / "live"), "SERVER_IP": "49.12.34.56",
           "LIVE_INFO": str(tmp_path / "info.txt"), "LIVE_BIN": str(tmp_path / "bin"), "LIVE_SETTINGS": str(settings)}
    out = subprocess.run(["bash", str(DEPLOY / "setup.sh"), *args], env=env, capture_output=True, text=True, check=True)
    return out.stdout


def test_setup_generates_configs_and_keeps_keys(tmp_path):
    live = tmp_path / "live"
    out = run_setup(tmp_path)
    assert "https://class.49-12-34-56.sslip.io" in out
    lk = yaml.safe_load((live / "livekit.yaml").read_text())
    assert lk["turn"]["domain"] == "turn.class.49-12-34-56.sslip.io"
    assert lk["turn"]["external_tls"] and lk["turn"]["proxy_protocol"]
    (key, secret), = lk["keys"].items()
    assert key.startswith("API") and len(secret) >= 32
    # Caddy: 이름에 따라 수업 사이트(8000)·화상 서버(7880)·TURN(5349)으로 나눈다
    caddy = yaml.safe_load((live / "caddy.yaml").read_text())
    assert caddy["apps"]["tls"]["certificates"]["automate"] == [
        "class.49-12-34-56.sslip.io", "rtc.class.49-12-34-56.sslip.io", "turn.class.49-12-34-56.sslip.io"]
    routes = {r["match"][0]["tls"]["sni"][0]: r["handle"][-1]["upstreams"][0]["dial"][0]
              for r in caddy["apps"]["layer4"]["servers"]["main"]["routes"]}
    assert routes == {"class.49-12-34-56.sslip.io": "127.0.0.1:8001", "rtc.class.49-12-34-56.sslip.io": "localhost:7880",
                      "turn.class.49-12-34-56.sslip.io": "localhost:5349"}
    # 수업 사이트는 실제 접속 IP(접속기록용)를 PROXY 프로토콜로 안쪽 관문(8001)에 넘기고, 관문이 앱(8000)으로 보낸다
    site = caddy["apps"]["http"]["servers"]["site"]
    assert site["listen"] == ["127.0.0.1:8001"] and site["listener_wrappers"][0]["wrapper"] == "proxy_protocol"
    assert site["routes"][0]["handle"][0]["upstreams"][0]["dial"] == "127.0.0.1:8000"
    compose = yaml.safe_load((live / "docker-compose.yaml").read_text())
    assert set(compose["services"]) == {"caddy", "livekit", "db", "app"}
    assert all(s["restart"] == "unless-stopped" for s in compose["services"].values())
    assert compose["services"]["app"]["env_file"] == ["app.env", "auto.env"]  # 자동 설정이 우선
    # 수업 사이트 설정: 자동 설정(비밀값·DB·화상 서버)과 선생님 설정(cloud-init에서 채운 값)
    auto = env_dict(live / "auto.env")
    assert auto["LIVEKIT_URL"] == "wss://rtc.class.49-12-34-56.sslip.io"
    assert auto["LIVEKIT_API_KEY"] == key and auto["LIVEKIT_API_SECRET"] == secret
    assert auto["COOKIE_SECURE"] == "1" and auto["APP_MODE"] == "live"
    assert auto["DATABASE_URL"].startswith("postgresql://live:") and auto["DATABASE_URL"].endswith("@127.0.0.1:5432/live")
    assert compose["services"]["db"]["environment"]["POSTGRES_PASSWORD"] in auto["DATABASE_URL"]
    app = env_dict(live / "app.env")
    assert app["ADMIN_EMAILS"] == "boss@gmail.com" and app["ALLOWED_DOMAINS"] == "s.school.kr" and app["GOOGLE_CLIENT_ID"] == ""

    # live-config 로 설정을 바꾼다 (허용된 이름만)
    cfg = {**os.environ, "LIVE_NO_RESTART": "1"}
    r = subprocess.run([str(tmp_path / "bin" / "live-config"), "GOOGLE_CLIENT_ID=123-abc.apps.googleusercontent.com",
                        "SCHOOLS=가나고,다라고"], env=cfg, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    app = env_dict(live / "app.env")
    assert app["GOOGLE_CLIENT_ID"] == "123-abc.apps.googleusercontent.com" and app["SCHOOLS"] == "가나고,다라고"
    bad = subprocess.run([str(tmp_path / "bin" / "live-config"), "DATABASE_URL=x"], env=cfg, capture_output=True, text=True)
    assert bad.returncode != 0 and "DATABASE_URL" not in env_dict(live / "app.env")
    subprocess.run([str(tmp_path / "bin" / "live-config"), "ANTHROPIC_API_KEY=sk-ant-secret123456"], env=cfg, check=True)
    shown = subprocess.run([str(tmp_path / "bin" / "live-config")], env=cfg, capture_output=True, text=True).stdout
    assert "secret123456" not in shown and "123-abc" in shown  # API 키는 가려서 보여 준다

    # 주소를 적지 않고 다시 실행해도(live-update) 같은 주소, 설정 이름이 늘어나도 live-config 가 따라온다
    assert "https://class.49-12-34-56.sslip.io" in run_setup(tmp_path)
    assert "CONSENT_TO" in (tmp_path / "bin" / "live-config").read_text()
    # 다시 실행해도(내 도메인으로 바꿔도) 키·비밀번호·선생님 설정은 그대로
    out2 = run_setup(tmp_path, "class.myschool.kr")
    assert "https://class.myschool.kr" in out2
    lk2 = yaml.safe_load((live / "livekit.yaml").read_text())
    assert lk2["keys"] == lk["keys"] and lk2["turn"]["domain"] == "turn.class.myschool.kr"
    auto2 = env_dict(live / "auto.env")
    assert auto2["LIVEKIT_URL"] == "wss://rtc.class.myschool.kr"
    assert auto2["SECRET_KEY"] == auto["SECRET_KEY"] and auto2["DATABASE_URL"] == auto["DATABASE_URL"]
    assert env_dict(live / "app.env")["GOOGLE_CLIENT_ID"] == "123-abc.apps.googleusercontent.com"
    # 도메인을 한 번 바꾸면 그다음 실행(live-update)에서도 그 도메인을 쓴다
    assert "https://class.myschool.kr" in run_setup(tmp_path)
