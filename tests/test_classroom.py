"""실시간 수업 서버 테스트: python -m pytest tests"""

import os
import tempfile
import time

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ.setdefault("ANTHROPIC_API_KEY", "test")

import pytest
from fastapi.testclient import TestClient
from google.oauth2 import id_token

import app.auth as auth
import app.classroom as cr
from app import db
from app.main import app

SCHOOL = "가나중학교"
COURSE = {"title": "강좌", "instructor": "강사", "hub_school": "가나고등학교",
          "start_date": "2026-03-02", "end_date": "2099-12-18"}


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    monkeypatch.setattr(auth, "GOOGLE_CLIENT_ID", "test.apps.googleusercontent.com")

    def verify_test_token(credential, request, audience):
        if audience != auth.GOOGLE_CLIENT_ID or not credential.startswith("test-token:"):
            raise ValueError("Invalid test token")
        email = credential.removeprefix("test-token:")
        return {"sub": f"test:{email}", "email": email, "email_verified": True, "name": ""}

    # 구글 외부 요청만 모의 처리하고, 실제 구글 로그인 경로로 세션·역할을 검증한다.
    monkeypatch.setattr(id_token, "verify_oauth2_token", verify_test_token)
    monkeypatch.setattr(auth, "TEACHER_EMAILS", {"teacher@gmail.com", "other@gmail.com"})
    monkeypatch.setattr(auth, "ALLOWED_DOMAINS", {"s.school.kr"})
    monkeypatch.setattr(auth, "ULSAN_SCHOOLS", [])  # 테스트는 학교 목록 없이 시작 (필요하면 테스트에서 저장)
    monkeypatch.setattr(cr, "RECONNECT_GRACE", 0)  # 기존 테스트는 끊기면 바로 나간 것으로 (유예는 따로 테스트)
    monkeypatch.setattr(cr, "LIVEKIT_URL", "ws://localhost:7880")
    monkeypatch.setattr(cr, "LIVEKIT_API_KEY", "devkey")
    monkeypatch.setattr(cr, "LIVEKIT_API_SECRET", "secret-secret-secret-secret-secret")
    db.metadata.drop_all(db.engine)
    db.init()
    cr.classes.clear()


def google_login(client, email):
    return client.post("/api/auth/google", json={"credential": f"test-token:{email}", "birth": "2008-04-03"})


def login(email, **profile):
    c = TestClient(app)
    r = google_login(c, email)
    assert r.status_code == 200, r.text
    if profile:
        if email.endswith("@s.school.kr"):
            profile.setdefault("birth", "2008-04-03")
            profile.setdefault("gender", "남")
        r = c.post("/api/me/profile", json={"agree": True, **profile})
        assert r.status_code == 200, r.text
    return c


def teacher(email="teacher@gmail.com"):
    return login(email, name="박선생", school=SCHOOL)


def student(n, grade=2, class_no=3):
    return login(f"st{n}@s.school.kr", name=f"학생{n}", school=SCHOOL, grade=grade, class_no=class_no, number=n)


def staff_apply(client, payload):
    return client.post("/api/staff/apply", json={"birth": "1980-01-01", **payload})


def create(t, **kw):
    r = t.post("/api/live/classes", json={"title": "정치", **kw})
    assert r.status_code == 200, r.text
    return r.json()


def until(ws, pred, limit=60):
    for _ in range(limit):
        msg = ws.receive_json()
        if pred(msg):
            return msg
    raise AssertionError("기다리던 메시지가 오지 않음")


def state(ws, pred=lambda m: True):
    return until(ws, lambda m: m["t"] == "state" and pred(m))


@pytest.mark.parametrize("dev_login", [None, "0", "1"])
def test_development_login_is_unavailable(monkeypatch, dev_login):
    if dev_login is None:
        monkeypatch.delenv("DEV_LOGIN", raising=False)
    else:
        monkeypatch.setenv("DEV_LOGIN", dev_login)
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"admin@gmail.com"})
    c = TestClient(app)
    assert c.post("/api/auth/dev", json={"email": "admin@gmail.com"}).status_code == 404
    assert c.get("/__dev/login").status_code == 404
    assert c.get("/__dev/status").status_code == 404
    assert c.post("/__dev/login", json={"email": "admin@gmail.com", "key": "anything"}).status_code == 404
    config = c.get("/api/me").json()
    assert config["user"] is None and "dev_login" not in config
    assert c.get("/api/courses/available").status_code == 401
    page = c.get("/live").text
    assert "dev-login" not in page and "개발용 로그인" not in page


DEVELOPMENT_KEY = "local-test-key-" * 3


def development_client(**kwargs):
    from app.dev import create_dev_app

    return TestClient(create_dev_app(DEVELOPMENT_KEY), base_url="http://127.0.0.1:8000",
                      client=kwargs.pop("client", ("127.0.0.1", 50000)), **kwargs)


def test_local_development_login_requires_key(monkeypatch):
    monkeypatch.setattr(auth, "GOOGLE_CLIENT_ID", "")
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"developer@local.test"})
    c = development_client()
    page = c.get("/__dev/login")
    assert page.status_code == 200 and page.headers["cache-control"] == "no-store"
    assert c.get("/__dev/status").json() == {"local_development": True}
    assert DEVELOPMENT_KEY not in page.text
    assert "개발용 로그인" not in c.get("/live").text
    assert c.post("/api/auth/dev", json={"email": "developer@local.test"}).status_code == 404

    for key in ("wrong-key", "잘못된 인증키"):
        assert c.post("/__dev/login", json={"email": "developer@local.test", "key": key}).status_code == 403
        assert c.get("/api/me").json()["user"] is None

    r = c.post("/__dev/login", json={"email": "developer@local.test", "key": DEVELOPMENT_KEY})
    assert r.status_code == 200 and r.json()["is_admin"]
    assert c.get("/api/me").json()["user"]["id"] == r.json()["id"]
    assert c.get("/live").status_code == 200


@pytest.mark.parametrize("email, role", [
    ("teacher@gmail.com", "teacher"), ("kid@s.school.kr", "student"), ("guest@gmail.com", "guest"),
])
def test_local_development_login_preserves_roles(email, role):
    c = development_client()
    r = c.post("/__dev/login", json={"email": email, "key": DEVELOPMENT_KEY})
    assert r.status_code == 200 and r.json()["role"] == role
    assert not r.json()["is_admin"]


@pytest.mark.parametrize("peer, host", [
    ("192.0.2.1", "127.0.0.1:8000"), ("192.0.2.1", "localhost:8000"), ("127.0.0.1", "example.com"),
])
def test_development_server_rejects_remote_access(peer, host):
    c = development_client(client=(peer, 50000))
    headers = {"host": host, "x-forwarded-for": "127.0.0.1"}
    assert c.get("/__dev/login", headers=headers).status_code == 404
    assert c.get("/__dev/status", headers=headers).status_code == 404
    assert c.post("/__dev/login", headers=headers,
                  json={"email": "teacher@gmail.com", "key": DEVELOPMENT_KEY}).status_code == 404


def test_development_login_rejects_cross_origin():
    c = development_client()
    r = c.post("/__dev/login", headers={"origin": "https://example.com"},
               json={"email": "teacher@gmail.com", "key": DEVELOPMENT_KEY})
    assert r.status_code == 403
    assert c.get("/api/me").json()["user"] is None


def test_development_login_refuses_shared_database(monkeypatch):
    from types import SimpleNamespace
    from app.dev import create_dev_app

    monkeypatch.setattr(db, "engine", SimpleNamespace(dialect=SimpleNamespace(name="postgresql")))
    with pytest.raises(RuntimeError, match="SQLite"):
        create_dev_app(DEVELOPMENT_KEY)


def test_google_login_rejects_invalid_token():
    c = TestClient(app)
    assert c.post("/api/auth/google", json={"credential": "invalid-token"}).status_code == 401
    assert c.get("/api/me").json()["user"] is None


def test_google_login_rejects_unverified_email(monkeypatch):
    monkeypatch.setattr(id_token, "verify_oauth2_token", lambda *args: {
        "sub": "unverified", "email": "admin@gmail.com", "email_verified": False,
    })
    c = TestClient(app)
    assert google_login(c, "admin@gmail.com").status_code == 403
    assert c.get("/api/me").json()["user"] is None


def test_google_login_requires_client_id(monkeypatch):
    monkeypatch.setattr(auth, "GOOGLE_CLIENT_ID", "")
    c = TestClient(app)
    assert google_login(c, "teacher@gmail.com").status_code == 503
    assert c.get("/api/me").json()["user"] is None


def test_login_rules():
    c = TestClient(app)
    # 학교 계정이 아니면 '손님': 강사 등록 신청만 할 수 있고 수업·강좌는 못 쓴다
    assert google_login(c, "kid@gmail.com").json()["role"] == "guest"
    assert c.get("/api/courses/available").status_code == 403
    s = login("kid@s.school.kr")
    me = s.get("/api/me").json()["user"]
    assert me["role"] == "student" and me["needs_profile"]
    t = teacher()
    code = create(t)["code"]
    assert s.post(f"/api/live/classes/{code}/join").status_code == 409  # 내 정보 먼저
    assert s.post("/api/live/classes", json={}).status_code in (403, 409)  # 학생은 수업을 못 연다
    prof = {"name": "김민준", "school": SCHOOL, "grade": 2, "class_no": 3, "number": 15,
            "birth": "2008-04-03", "gender": "남"}
    assert s.post("/api/me/profile", json=prof).status_code == 400  # 이용약관·처리방침 확인 필요
    r = s.post("/api/me/profile", json={**prof, "agree": True})
    assert r.json()["student_no"] == "20315" and r.json()["display"] == "20315 김민준"
    assert r.json()["needs_terms"] is False and r.json()["ai_ok"] is False
    assert s.post("/api/me/ai-ok").status_code == 200 and s.get("/api/me").json()["user"]["ai_ok"] is True
    # 약관 내용이 바뀌면(시행일 변경) 다시 확인해야 수업에 들어갈 수 있다
    import app.auth as auth_mod
    old = auth_mod.POLICY_VERSION
    auth_mod.POLICY_VERSION = "2099-01-01"
    try:
        assert s.get("/api/me").json()["user"]["needs_profile"] is True
        assert s.post(f"/api/live/classes/{code}/join").status_code == 409
        s.post("/api/me/profile", json={**prof, "agree": True})
        assert s.get("/api/me").json()["user"]["needs_profile"] is False
    finally:
        auth_mod.POLICY_VERSION = old
    s.post("/api/me/profile", json={**prof, "agree": True})
    assert s.post(f"/api/live/classes/{code}/join").status_code == 200


def test_quiz_flow_and_results_saved():
    t = teacher()
    c = create(t)
    code, cid = c["code"], c["class_id"]
    a, b = student(1), student(2)
    with t.websocket_connect(f"/ws/live/{code}") as tw, \
         a.websocket_connect(f"/ws/live/{code}") as sa, \
         b.websocket_connect(f"/ws/live/{code}") as sb:
        tw.send_json({"t": "activity_start", "kind": "choice", "prompt": "대통령제 국가는?",
                      "options": ["영국", "미국", "일본"], "correct": 1})
        act = state(sa, lambda m: m["activity"])["activity"]
        assert "correct" not in act and "counts" not in act
        sa.send_json({"t": "answer", "id": act["id"], "value": 1})
        sb.send_json({"t": "answer", "id": act["id"], "value": 0})
        ts = state(tw, lambda m: m["activity"] and m["activity"]["total"] == 2)
        assert ts["activity"]["counts"] == [1, 1, 0]
        tw.send_json({"t": "activity_close"})
        tw.send_json({"t": "activity_reveal", "on": True})
        st = state(sa, lambda m: m["activity"]["reveal"])
        assert st["activity"]["correct"] == 1 and st["activity"]["mine"] == 1
        tw.send_json({"t": "activity_clear"})
        state(sa, lambda m: m["activity"] is None)
    time.sleep(0.3)  # 결과 저장은 비동기
    body = t.get(f"/api/live/history/{cid}/results.csv").text
    assert "20301" in body and "미국" in body and ",O" in body and ",X" in body
    assert a.get(f"/api/live/history/{cid}/results.csv").status_code == 403
    assert teacher("other@gmail.com").get(f"/api/live/history/{cid}/results.csv").status_code == 404


def test_breakout_tokens_chat_and_broadcast():
    t = teacher()
    code = create(t)["code"]
    studs = [student(i) for i in range(1, 7)]
    with t.websocket_connect(f"/ws/live/{code}") as tw:
        socks = [s.websocket_connect(f"/ws/live/{code}") for s in studs]
        try:
            for ws in socks:
                ws.__enter__()
            state(tw, lambda m: sum(s["online"] for s in m["students"]) == 6)
            # 모둠만 만들면 배정은 비어 있다 → 직접 고르기
            tw.send_json({"t": "breakout_setup", "n": 3})
            ts = state(tw, lambda m: len(m["groups"]) == 3)
            assert [g["name"] for g in ts["groups"]] == ["A모둠", "B모둠", "C모둠"]
            assert all(s["group"] is None for s in ts["students"])
            first = ts["students"][0]["id"]
            tw.send_json({"t": "breakout_assign", "target": first, "group": "g3"})
            assert state(tw, lambda m: m["students"][0]["group"] == "g3")
            # 무작위 배정 후 시간 제한 없이 시작
            tw.send_json({"t": "breakout_plan", "n": 3})
            tw.send_json({"t": "breakout_start"})
            ts = state(tw, lambda m: m["breakout"])
            assert ts["ends_at"] is None and ts["breakout_at"]
            sizes = [sum(s["group"] == g["id"] for s in ts["students"]) for g in ts["groups"]]
            assert sizes == [2, 2, 2]
            st0 = state(socks[0], lambda m: m["room"] != "main")
            room0 = st0["room"]

            tok = lambda c, room: c.post(f"/api/live/classes/{code}/token", json={"room": room})
            assert tok(studs[0], room0).status_code == 200
            other = next(g["id"] for g in ts["groups"] if g["id"] != room0)
            assert tok(studs[0], other).status_code == 403
            assert tok(studs[0], "main").status_code == 403
            assert all(tok(t, g["id"]).status_code == 200 for g in ts["groups"])
            assert tok(teacher("other@gmail.com"), room0).status_code == 403  # 다른 선생님의 수업

            socks[0].send_json({"t": "chat", "text": "우리 모둠 안녕"})
            assert until(tw, lambda m: m["t"] == "chat")["msg"]["scope"] == room0

            tw.send_json({"t": "listen", "groups": [room0], "talking": None})
            state(socks[0], lambda m: m["teacher_listening"])
            # 모든 모둠에 동시에 말하기
            tw.send_json({"t": "listen", "groups": [], "talking": None, "broadcast": True})
            for ws in socks:
                state(ws, lambda m: m["teacher_broadcast"])
            tw.send_json({"t": "breakout_end"})
            st = state(socks[0], lambda m: m["room"] == "main")
            assert not st["breakout"] and not st["teacher_broadcast"]
        finally:
            for ws in socks:
                ws.__exit__(None, None, None)


def test_attendance_history_and_absent():
    t = teacher()
    c = create(t, target_grade=2, target_class=3)
    code, cid = c["code"], c["class_id"]
    a, b = student(1), student(2)
    student(3)  # 같은 반이지만 접속 안 함
    student(4, class_no=5)  # 다른 반
    with a.websocket_connect(f"/ws/live/{code}") as sa:
        state(sa)
    time.sleep(0.2)
    with a.websocket_connect(f"/ws/live/{code}") as sa, b.websocket_connect(f"/ws/live/{code}") as sb:
        state(sa)
        state(sb)
        rep = t.get(f"/api/live/history/{cid}").json()
        p1 = next(p for p in rep["students"] if p["student_no"] == "20301")
        assert p1["count"] == 2 and p1["online"] and p1["last_leave_text"] == "접속 중"
    deadline = time.monotonic() + 3
    while True:
        rep = t.get(f"/api/live/history/{cid}").json()
        if not any(p["online"] for p in rep["students"]) or time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    assert [p["student_no"] for p in rep["students"]] == ["20301", "20302"]
    assert not any(p["online"] for p in rep["students"])
    assert [x["student_no"] for x in rep["absent"]] == ["20303"]

    from datetime import datetime
    from zoneinfo import ZoneInfo
    today = datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d")
    day = t.get("/api/live/history", params={"date": today}).json()
    assert day["classes"][0]["id"] == cid and day["classes"][0]["attended"] == 2
    csv_text = t.get(f"/api/live/history/{cid}/attendance.csv").text
    assert "20301" in csv_text and "미접속" in csv_text
    assert a.get(f"/api/live/history/{cid}").status_code == 403


def test_kick_mic_lock_end_and_revive():
    t = teacher()
    code = create(t)["code"]
    a = student(1)
    with t.websocket_connect(f"/ws/live/{code}") as tw, a.websocket_connect(f"/ws/live/{code}") as sa:
        sid = state(sa)["me"]["id"]  # 학생 연결이 끝난 뒤에 명령을 보낸다
        tw.send_json({"t": "settings", "mic_lock": True})
        until(sa, lambda m: m["t"] == "cmd" and m["cmd"] == "mute")
        tw.send_json({"t": "allow_mic", "target": sid, "on": True})
        state(sa, lambda m: m["me"]["can_speak"])
        tw.send_json({"t": "kick", "target": sid})
        until(sa, lambda m: m["t"] == "kicked")
    assert a.post(f"/api/live/classes/{code}/join").status_code == 403

    cr.classes.clear()  # 서버 재시작 흉내: 메모리 상태가 사라져도 같은 코드로 이어진다
    b = student(2)
    assert b.post(f"/api/live/classes/{code}/join").status_code == 200
    with t.websocket_connect(f"/ws/live/{code}") as tw:
        assert state(tw)["title"] == "정치"
        tw.send_json({"t": "end_class"})
        until(tw, lambda m: m["t"] == "ended")
    time.sleep(0.2)
    cr.classes.clear()
    assert b.post(f"/api/live/classes/{code}/join").status_code == 404


def test_websocket_rejects_other_origin_and_anonymous():
    t = teacher()
    code = create(t)["code"]
    with t.websocket_connect(f"/ws/live/{code}", headers={"origin": "https://evil.example"}) as ws:
        assert ws.receive_json()["code"] == "bad_origin"
    with TestClient(app).websocket_connect(f"/ws/live/{code}") as ws:
        assert ws.receive_json()["code"] == "login"


def test_rejoin_reasons_are_recorded():
    t = teacher()
    c = create(t)
    code, cid = c["code"], c["class_id"]
    a = student(1)
    with t.websocket_connect(f"/ws/live/{code}") as tw:
        # 1) 창 닫기(정상 종료)
        with a.websocket_connect(f"/ws/live/{code}") as sa:
            state(sa)
        state(tw, lambda m: any(e["kind"] == "leave" for e in m["events"]))
        # 2) 인터넷 끊김(비정상 종료)
        with a.websocket_connect(f"/ws/live/{code}") as sa:
            state(sa)
            sa.close(code=1006)
        ts = state(tw, lambda m: sum(e["kind"] == "leave" for e in m["events"]) == 2)
        assert [e["kind"] for e in ts["events"]] == ["join", "leave", "rejoin", "leave"]
        assert ts["events"][1]["reason"] == "closed" and ts["events"][3]["reason"] == "network"
        assert ts["students"][0]["sessions"] == 2
        # 3) 나가기 버튼
        with a.websocket_connect(f"/ws/live/{code}") as sa:
            state(sa)
            sa.send_json({"t": "leave"})
        state(tw, lambda m: sum(e["kind"] == "leave" for e in m["events"]) == 3)

        # 4) 다시 들어와 있다가 수업 종료
        sa = a.websocket_connect(f"/ws/live/{code}")
        sa.__enter__()
        state(sa)
        state(tw, lambda m: m["students"][0]["online"])
        tw.send_json({"t": "end_class"})
        until(sa, lambda m: m["t"] == "ended")
        sa.__exit__(None, None, None)
    time.sleep(0.3)
    rep = t.get(f"/api/live/history/{cid}").json()
    p = rep["students"][0]
    assert p["count"] == 4 and p["rejoins"] == 3
    assert [s["reason"] for s in p["sessions"]] == ["closed", "network", "leave", "ended"]
    assert p["sessions"][0]["gap_before"] is None and p["sessions"][1]["gap_before"] is not None
    log_csv = t.get(f"/api/live/history/{cid}/attendance-log.csv").text
    assert log_csv.count("20301") == 4 and "연결 끊김" in log_csv and "나가기 버튼" in log_csv and "수업 종료" in log_csv


def test_silent_device_is_recorded_as_network_drop(monkeypatch):
    t = teacher()
    c = create(t)
    code, cid = c["code"], c["class_id"]
    a = student(1)
    # 1) 기기가 멈춰 아무 신호도 없으면 일정 시간 뒤 '연결 끊김'
    monkeypatch.setattr(cr, "SILENCE_LIMIT", 1)
    with a.websocket_connect(f"/ws/live/{code}") as sa:
        state(sa)
        with pytest.raises(Exception):  # 서버가 연결을 끊는다
            for _ in range(20):
                sa.receive_json()
    time.sleep(0.2)  # (유예 0초) 나간 것으로 처리될 때까지
    k = cr.classes[code]
    assert k.events[-1]["kind"] == "leave" and k.events[-1]["reason"] == "network"
    # 2) 끊긴 줄 모르는 사이 다시 연결되면 옛 연결을 '연결 끊김'으로 정리하고 재입장으로 기록 (유예 0초일 때)
    monkeypatch.setattr(cr, "SILENCE_LIMIT", 60)
    monkeypatch.setattr(cr, "STALE_AFTER", 0.5)
    with t.websocket_connect(f"/ws/live/{code}") as tw:
        old = a.websocket_connect(f"/ws/live/{code}")
        old.__enter__()
        state(old)
        time.sleep(1)
        with a.websocket_connect(f"/ws/live/{code}") as new:
            state(new)
            ts = state(tw, lambda m: [e["kind"] for e in m["events"]][-3:] == ["rejoin", "leave", "rejoin"])
            assert ts["events"][-2]["reason"] == "network" and ts["students"][0]["online"]
        try:
            old.__exit__(None, None, None)
        except Exception:
            pass
    time.sleep(0.3)
    p = t.get(f"/api/live/history/{cid}").json()["students"][0]
    assert [s["reason"] for s in p["sessions"]] == ["network", "network", "closed"]


def test_student_media_permissions():
    """카메라는 언제나 학생 마음대로. 마이크도 자유지만, 선생님이 한 학생 마이크를 끄면 다시 켜 줄 때까지 못 켠다"""
    from livekit import api as lk
    verifier = lk.TokenVerifier(cr.LIVEKIT_API_KEY, cr.LIVEKIT_API_SECRET)

    def sources(client, room="main"):
        r = client.post(f"/api/live/classes/{code}/token", json={"room": room})
        assert r.status_code == 200, r.text
        return sorted(verifier.verify(r.json()["token"]).video.can_publish_sources)

    t = teacher()
    code = create(t)["code"]
    a = student(1)
    assert a.post(f"/api/live/classes/{code}/join").status_code == 200
    assert sources(a) == ["camera", "microphone", "screen_share", "screen_share_audio"]
    with t.websocket_connect(f"/ws/live/{code}") as tw, a.websocket_connect(f"/ws/live/{code}") as sa:
        st = state(sa)
        assert st["settings"]["lowbw"] is True and st["settings"]["chat"] is True
        sid = st["me"]["id"]
        # 데이터 절약 모드·채팅은 끌 수 없다
        tw.send_json({"t": "settings", "lowbw": False, "chat": False})
        tw.send_json({"t": "cmd", "cmd": "mic_off", "target": sid})  # 한 학생 마이크 강제로 끄기
        assert until(sa, lambda m: m["t"] == "cmd")["cmd"] == "mute"
        st = state(sa, lambda m: m["me"]["mic_blocked"])
        assert st["settings"]["lowbw"] is True and st["settings"]["chat"] is True
        assert sources(a) == ["camera", "screen_share", "screen_share_audio"]  # 카메라는 그대로
        tw.send_json({"t": "cmd", "cmd": "mic_on", "target": sid})
        state(sa, lambda m: not m["me"]["mic_blocked"])
        assert sources(a) == ["camera", "microphone", "screen_share", "screen_share_audio"]
        tw.send_json({"t": "cmd", "cmd": "mute", "target": "all"})  # 모두 음소거는 끄기만
        until(sa, lambda m: m["t"] == "cmd")
        assert not state(sa)["me"]["mic_blocked"] and sources(a) == ["camera", "microphone", "screen_share", "screen_share_audio"]
        tw.send_json({"t": "cmd", "cmd": "cam_off", "target": sid})  # 카메라를 꺼도 학생이 다시 켤 수 있다
        assert until(sa, lambda m: m["t"] == "cmd")["cmd"] == "cam_off"
        assert sources(a) == ["camera", "microphone", "screen_share", "screen_share_audio"]
        # 모둠에서는 화면 공유까지
        tw.send_json({"t": "breakout_plan", "n": 1})
        tw.send_json({"t": "breakout_start"})
        room = state(sa, lambda m: m["room"] != "main")["room"]
        assert sources(a, room) == ["camera", "microphone", "screen_share", "screen_share_audio"]


def test_live_site_mode_root_goes_to_class(monkeypatch):
    import app.main as main
    c = TestClient(app)
    assert c.get("/", follow_redirects=False).status_code == 200  # 기본: 정치쌤 챗봇
    monkeypatch.setattr(main, "APP_MODE", "live")
    r = c.get("/", follow_redirects=False)
    assert r.status_code in (302, 307) and r.headers["location"] == "/live/home"


def test_questions_and_replies_are_kept():
    t = teacher()
    c = create(t, title="선거 제도")
    code, cid = c["code"], c["class_id"]
    a, b = student(1), student(2)
    with t.websocket_connect(f"/ws/live/{code}") as tw, a.websocket_connect(f"/ws/live/{code}") as sa:
        state(sa)
        sa.send_json({"t": "question", "text": "비례대표제는 왜 필요한가요?"})
        qid = state(tw, lambda m: m["questions"])["questions"][0]["id"]
        tw.send_json({"t": "question_update", "id": qid, "reply": "사표를 줄이기 위해서예요.", "done": True})
        state(sa, lambda m: m["my_questions"] and m["my_questions"][0]["reply"])
    time.sleep(0.3)

    # 서버 재시작 흉내: 진행 중인 수업에 다시 들어가도 질문답변이 그대로
    cr.classes.clear()
    with t.websocket_connect(f"/ws/live/{code}") as tw:
        qs = state(tw)["questions"]
        assert qs[0]["text"] == "비례대표제는 왜 필요한가요?" and qs[0]["reply"] == "사표를 줄이기 위해서예요." and qs[0]["done"]
        assert qs[0]["name"] == "20301 학생1"
        tw.send_json({"t": "end_class"})
        until(tw, lambda m: m["t"] == "ended")
    time.sleep(0.3)

    # 수업이 끝나도 선생님 기록·CSV, 학생 본인 기록에 남는다
    hist = t.get(f"/api/live/history/{cid}/questions").json()["questions"]
    assert len(hist) == 1 and hist[0]["student_no"] == "20301" and hist[0]["reply"] and hist[0]["reply_time"]
    csv_text = t.get(f"/api/live/history/{cid}/questions.csv").text
    assert "비례대표제" in csv_text and "사표를 줄이기" in csv_text and "확인함" in csv_text
    mine = a.get("/api/live/my-questions").json()["questions"]
    assert mine[0]["class_title"] == "선거 제도" and mine[0]["reply"] == "사표를 줄이기 위해서예요."
    assert b.get("/api/live/my-questions").json()["questions"] == []  # 다른 학생 것은 안 보임
    assert a.get(f"/api/live/history/{cid}/questions").status_code == 403
    assert teacher("other@gmail.com").get(f"/api/live/history/{cid}/questions").status_code == 404


def test_grading_after_class():
    t = teacher()
    c = create(t, title="선거 제도")
    code, cid = c["code"], c["class_id"]
    a, b = student(1), student(2)
    with t.websocket_connect(f"/ws/live/{code}") as tw, \
         a.websocket_connect(f"/ws/live/{code}") as sa, b.websocket_connect(f"/ws/live/{code}") as sb:
        state(sa)
        state(sb)
        # 1) 객관식 (정답 있음) → 자동 채점
        tw.send_json({"t": "activity_start", "kind": "choice", "prompt": "대통령제 국가는?",
                      "options": ["영국", "미국"], "correct": 1})
        act = state(sa, lambda m: m["activity"])["activity"]
        sa.send_json({"t": "answer", "id": act["id"], "value": 1})
        sb.send_json({"t": "answer", "id": act["id"], "value": 0})
        state(tw, lambda m: m["activity"] and m["activity"]["total"] == 2)
        # 2) 주관식 → 선생님이 채점 (학생2는 답하지 않음)
        tw.send_json({"t": "activity_start", "kind": "text", "prompt": "선거의 4대 원칙을 쓰세요"})
        act2 = state(sa, lambda m: m["activity"] and m["activity"]["kind"] == "text")["activity"]
        sa.send_json({"t": "answer", "id": act2["id"], "value": "보통, 평등, 직접, 비밀"})
        state(tw, lambda m: m["activity"] and m["activity"]["total"] == 1)
        # 3) 투표 → 채점 안 함
        tw.send_json({"t": "activity_start", "kind": "poll", "prompt": "오늘 수업 어땠나요?", "options": ["좋음", "보통"]})
        act3 = state(sa, lambda m: m["activity"] and m["activity"]["kind"] == "poll")["activity"]
        sa.send_json({"t": "answer", "id": act3["id"], "value": 0})
        state(tw, lambda m: m["activity"] and m["activity"]["total"] == 1)
        tw.send_json({"t": "end_class"})
        until(tw, lambda m: m["t"] == "ended")
    time.sleep(0.4)

    book = t.get(f"/api/live/history/{cid}/grades").json()
    assert [x["kind"] for x in book["activities"]] == ["choice", "text", "poll"]
    choice, text, poll = book["activities"]
    r = {x["student_no"]: x for x in choice["rows"]}
    assert r["20301"]["score"] == 1 and r["20302"]["score"] == 0 and r["20301"]["correct"] is True
    assert {x["student_no"]: x["score"] for x in text["rows"]} == {"20301": None, "20302": 0}  # 답한 학생은 미채점, 미응답은 0점
    assert not poll["gradable"]
    s1 = next(p for p in book["summary"] if p["student_no"] == "20301")
    assert s1["score"] == 1 and s1["max"] == 2 and s1["ungraded"] == 1

    # 배점 바꾸고 주관식 채점, 객관식 점수 직접 고치기
    uid1 = r["20301"]["user_id"]
    uid2 = r["20302"]["user_id"]
    base = f"/api/live/history/{cid}/activities"
    assert t.post(f"{base}/{text['id']}/points", json={"points": 4}).status_code == 200
    assert t.post(f"{base}/{text['id']}/grade", json={"user_id": uid1, "score": 3, "feedback": "'직접'의 뜻도 써 보세요"}).status_code == 200
    assert t.post(f"{base}/{text['id']}/grade", json={"user_id": uid2, "score": 9}).status_code == 400  # 배점 초과
    assert t.post(f"{base}/{text['id']}/grade", json={"user_id": uid2, "score": 0, "feedback": "미제출"}).status_code == 200
    assert t.post(f"{base}/{choice['id']}/grade", json={"user_id": uid2, "score": 0.5, "feedback": "부분 점수"}).status_code == 200
    book = t.get(f"/api/live/history/{cid}/grades").json()
    tot = {p["student_no"]: p for p in book["summary"]}
    assert tot["20301"]["score"] == 4 and tot["20301"]["max"] == 5 and tot["20301"]["ungraded"] == 0
    assert tot["20302"]["score"] == 0.5
    csv_text = t.get(f"/api/live/history/{cid}/grades.csv").text
    assert "20301" in csv_text and "'직접'의 뜻도" in csv_text and "부분 점수" in csv_text

    # 공개 전에는 학생이 못 보고, 공개하면 자기 것만 본다
    assert a.get("/api/live/my-results").json()["classes"] == []
    assert t.post(f"/api/live/history/{cid}/publish", json={"on": True}).status_code == 200
    mine = a.get("/api/live/my-results").json()["classes"][0]
    assert mine["title"] == "선거 제도" and mine["score"] == 4 and mine["max"] == 5
    assert [i["score"] for i in mine["items"]] == [1, 3] and mine["items"][1]["feedback"] == "'직접'의 뜻도 써 보세요"
    # 다른 선생님·학생은 채점 불가
    assert a.post(f"{base}/{text['id']}/grade", json={"user_id": uid1, "score": 4}).status_code == 403
    assert teacher("other@gmail.com").get(f"/api/live/history/{cid}/grades").status_code == 404


def test_course_enrollment_join_without_code():
    t = teacher()
    course = {"title": "2026-1 정치", "instructor": "박선생", "hub_school": "가나고등학교",
              "start_date": "2026-03-02", "end_date": "2099-07-17", "description": "화·목"}
    bad = {**course, "start_date": "2026-08-01", "end_date": "2026-03-01"}
    assert t.post("/api/courses", json=bad).status_code == 400  # 끝나는 날이 더 빠름
    assert t.post("/api/courses", json={"title": "x"}).status_code == 422  # 필수 항목 빠짐
    cid = t.post("/api/courses", json=course).json()["id"]
    a, b, outsider = student(1), student(2), student(3)
    # 학생: 강좌 목록(강사명·거점학교·강의기간 표시) → 수강신청 → 승인 대기
    shown = a.get("/api/courses/available").json()["courses"]
    assert [(c["title"], c["instructor"], c["hub_school"], c["start_date"], c["end_date"]) for c in shown] == [
        ("2026-1 정치", "박선생", "가나고등학교", "2026-03-02", "2099-07-17")]
    # 거점학교 공동교육과정: 다른 학교 학생도 보이고 신청할 수 있다
    other = login("far@s.school.kr", name="최다른", school="다라고등학교", grade=1, class_no=1, number=1)
    assert [c["id"] for c in other.get("/api/courses/available").json()["courses"]] == [cid]
    assert other.post(f"/api/courses/{cid}/enroll").json()["status"] == "pending"
    assert other.delete(f"/api/courses/{cid}/enroll").status_code == 200
    assert a.post(f"/api/courses/{cid}/enroll").json()["status"] == "pending"
    assert b.post(f"/api/courses/{cid}/enroll").json()["status"] == "pending"
    assert outsider.post(f"/api/courses/{cid}/enroll").json()["status"] == "pending"
    mine = t.get("/api/courses/mine").json()["courses"][0]
    assert mine["pending"] == 3 and mine["approved"] == 0
    # 선생님: 학생1 승인, 학생3 거절, 나머지 모두 승인(학생2)
    uid = {e["student_no"]: e["user_id"] for e in t.get(f"/api/courses/{cid}/enrollments").json()["enrollments"]}
    assert t.post(f"/api/courses/{cid}/enrollments/{uid['20301']}", json={"status": "approved"}).status_code == 200
    assert t.post(f"/api/courses/{cid}/enrollments/{uid['20303']}", json={"status": "rejected"}).status_code == 200
    assert t.post(f"/api/courses/{cid}/approve-all").json()["approved"] == 1
    # 다른 선생님·학생은 관리 불가
    assert teacher("other@gmail.com").get(f"/api/courses/{cid}/enrollments").status_code == 404
    assert a.post(f"/api/courses/{cid}/approve-all").status_code == 403

    # 강좌 수업을 열면 승인된 학생 첫 화면에 바로 뜬다
    c = create(t, title="3주차 선거 제도", course_id=cid)
    code = c["code"]
    live = a.get("/api/courses/live-now").json()["classes"]
    assert live[0]["code"] == code and live[0]["course_title"] == "2026-1 정치"
    assert outsider.get("/api/courses/live-now").json()["classes"] == []
    # 승인된 학생은 입장, 거절된 학생은 코드를 알아도 못 들어옴 (HTTP·WebSocket·화상 입장권 모두)
    assert a.post(f"/api/live/classes/{code}/join").status_code == 200
    assert outsider.post(f"/api/live/classes/{code}/join").status_code == 403
    with outsider.websocket_connect(f"/ws/live/{code}") as ws:
        assert ws.receive_json()["code"] == "denied"
    assert outsider.post(f"/api/live/classes/{code}/token", json={"room": "main"}).status_code == 403
    with a.websocket_connect(f"/ws/live/{code}") as sa:
        state(sa)
    # 출결의 미접속 대상은 승인된 수강생 (학생2)
    time.sleep(0.3)
    rep = t.get(f"/api/live/history/{c['class_id']}").json()
    assert [p["student_no"] for p in rep["students"]] == ["20301"]
    assert [x["student_no"] for x in rep["absent"]] == ["20302"]
    # 거절된 학생은 다시 신청 가능, 수강 취소도 가능
    assert outsider.post(f"/api/courses/{cid}/enroll").json()["status"] == "pending"
    assert b.delete(f"/api/courses/{cid}/enroll").status_code == 200
    assert b.get("/api/courses/live-now").json()["classes"] == []
    # 정보 수정 (기간 검증 포함)
    assert t.post(f"/api/courses/{cid}", json={"hub_school": "다라고등학교"}).status_code == 200
    assert t.post(f"/api/courses/{cid}", json={"end_date": "2020-01-01"}).status_code == 400
    assert a.get("/api/courses/available").json()["courses"][0]["hub_school"] == "다라고등학교"
    # 수강신청을 닫으면 새 신청 불가, 보관하면 목록에서 사라지고 수업도 못 연다
    t.post(f"/api/courses/{cid}", json={"open": False})
    assert b.post(f"/api/courses/{cid}/enroll").status_code == 409
    t.post(f"/api/courses/{cid}", json={"archived": True})
    assert b.get("/api/courses/available").json()["courses"] == []
    assert [(x["id"], x["status"], x["archived"]) for x in a.get("/api/courses/my-learning").json()["courses"]] == [(cid, "approved", True)]
    assert outsider.get("/api/courses/my-learning").json()["courses"][0]["status"] == "pending"
    assert student(4).get("/api/courses/my-learning").json()["courses"] == []
    assert t.post("/api/live/classes", json={"title": "x", "course_id": cid}).status_code == 409
    assert t.post("/api/live/classes", json={"title": "x", "course_id": 999}).status_code == 404


def test_instructor_can_be_outside_school_list(monkeypatch):
    monkeypatch.setattr(auth, "SCHOOLS", [SCHOOL])
    # 대학교수: 학교 목록에 없는 소속도 저장되고, 거점학교는 소속과 다르게 적을 수 있다
    # 강사 목록에 없고 승인도 안 된 대학 계정은 '손님' (강사 기능 없음)
    guest = TestClient(app)
    assert google_login(guest, "prof@univ.ac.kr").json()["role"] == "guest"
    assert guest.post("/api/courses", json=COURSE).status_code == 403
    monkeypatch.setattr(auth, "TEACHER_EMAILS", {"teacher@gmail.com", "prof@univ.ac.kr"})
    prof = login("prof@univ.ac.kr", name="김교수", school="한국대학교 정치외교학과")
    assert prof.get("/api/me").json()["user"]["school"] == "한국대학교 정치외교학과"
    cid = prof.post("/api/courses", json={"title": "민주주의 이론", "instructor": "김교수", "hub_school": SCHOOL,
                                          "start_date": "2026-03-02", "end_date": "2099-12-18"}).json()["id"]
    c = student(1).get("/api/courses/available").json()["courses"][0]
    assert c["id"] == cid and c["instructor"] == "김교수" and c["hub_school"] == SCHOOL
    # 학생은 여전히 목록에 있는 학교만
    s = login("kid2@s.school.kr")
    assert s.post("/api/me/profile", json={"name": "학생", "school": "아무학교", "grade": 1, "class_no": 1, "number": 1}).status_code == 400


def test_instructor_without_affiliation(monkeypatch):
    # 지금은 학교에 소속되지 않은 강사(예: 전 기간제 교사)가 개인 구글 계정으로 강의
    monkeypatch.setattr(auth, "TEACHER_EMAILS", {"teacher@gmail.com", "freelancer@gmail.com"})
    t = login("freelancer@gmail.com", name="이강사")  # 소속 없이 이름만
    me = t.get("/api/me").json()["user"]
    assert me["role"] == "teacher" and me["school"] == "" and not me["needs_profile"]
    cid = t.post("/api/courses", json={"title": "정치와 법", "instructor": "이강사", "hub_school": "가나고등학교",
                                       "start_date": "2026-03-02", "end_date": "2099-12-18"}).json()["id"]
    a = student(1)
    a.post(f"/api/courses/{cid}/enroll")
    uid = t.get(f"/api/courses/{cid}/enrollments").json()["enrollments"][0]["user_id"]
    t.post(f"/api/courses/{cid}/enrollments/{uid}", json={"status": "approved"})
    code = create(t, title="1주차", course_id=cid)["code"]
    assert a.get("/api/courses/live-now").json()["classes"][0]["code"] == code
    assert a.post(f"/api/live/classes/{code}/join").status_code == 200


def test_hub_structure_and_course_approval(monkeypatch):
    """전체 관리자 → 거점학교 관리교사 → 강사(강좌 개설은 관리교사 승인) → 학생(강사 승인만으로 확정)"""
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"admin@gmail.com"})
    admin = login("admin@gmail.com", name="전체관리자")
    pledge = {"contact": "010-0000-0000", "pledge": True}

    def guest(email):
        g = TestClient(app)
        assert google_login(g, email).json()["role"] == "guest"
        return g

    # 1) 관리교사 신청 → 전체 관리자 승인 → 거점학교가 생긴다
    coord = guest("coord@gmail.com")
    assert staff_apply(coord, {"role": "coordinator", "hub_name": "가나고등학교", "name": "한관리",
                                                "affiliation": "가나고등학교", **pledge, "pledge": False}).status_code == 400
    assert staff_apply(coord, {"role": "coordinator", "hub_name": "가나고등학교", "name": "한관리",
                                                "affiliation": "가나고등학교", **pledge}).status_code == 200
    assert coord.get("/api/staff/applications", params={"role": "coordinator"}).status_code == 403  # 관리자만
    capps = admin.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"]
    assert capps[0]["hub"] == "가나고등학교" and capps[0]["status"] == "pending"
    assert admin.post(f"/api/staff/{capps[0]['id']}", json={"action": "approve"}).status_code == 200
    me = coord.get("/api/me").json()["user"]
    assert me["role"] == "teacher" and me["coordinator_hubs"][0]["name"] == "가나고등학교"
    hub_id = me["coordinator_hubs"][0]["id"]
    assert [h["name"] for h in coord.get("/api/hubs").json()["hubs"]] == ["가나고등학교"]

    # 2) 강의교사(대학교수) 신청: 거점학교를 정하지 않는다 → 전체 관리자가 승인
    prof = guest("prof@univ.ac.kr")
    iform = {"role": "instructor", "name": "김교수", "affiliation": "한국대학교", **pledge}
    assert staff_apply(prof, iform).status_code == 400  # 희망 기간 없음
    assert staff_apply(prof, {**iform, "wish_from": "2020-01-01", "wish_until": "2020-02-01"}).status_code == 400
    assert staff_apply(prof, {**iform, "wish_from": "2027-01-01", "wish_until": "2099-02-28",
                                               "message": "무시됨"}).status_code == 200
    other_coord_view = teacher().get("/api/staff/applications", params={"role": "instructor"})
    assert other_coord_view.status_code == 403  # 관리교사가 아니면 못 봄
    assert coord.get("/api/staff/applications", params={"role": "instructor"}).json()["applications"] == []  # 관리교사에겐 안 보임
    iapps = admin.get("/api/staff/applications", params={"role": "instructor"}).json()["applications"]
    assert iapps[0]["name"] == "김교수" and iapps[0]["hub_id"] is None
    assert (iapps[0]["wish_from"], iapps[0]["wish_until"], iapps[0]["message"]) == ("2027-01-01", "2099-02-28", "")
    assert coord.post(f"/api/staff/{iapps[0]['id']}", json={"action": "approve", "valid_until": "2099-02-28"}).status_code == 403
    assert admin.post(f"/api/staff/{iapps[0]['id']}", json={"action": "approve"}).status_code == 400  # 끝나는 날 필수
    assert admin.post(f"/api/staff/{iapps[0]['id']}", json={"action": "approve", "valid_until": "2099-02-28"}).status_code == 200
    pme = prof.get("/api/me").json()["user"]
    assert pme["role"] == "teacher" and pme["teach_hubs"] == [] and pme["lead_any"] and not pme["coordinator_hubs"]
    # 강사는 관리교사 권한 없음
    assert prof.get("/api/hub/overview").status_code == 403

    # 3) 강의교사: 과목을 열 때 거점학교를 고른다 (울산 고등학교 어디든, 개설은 그 학교 관리교사가 승인)
    base = {"title": "정치 보충", "instructor": "김교수", "start_date": "2027-01-05", "end_date": "2099-02-20"}
    assert prof.post("/api/courses", json=base).status_code == 400  # 거점학교 안 고름
    assert prof.post("/api/courses", json={**base, "hub_id": 999}).status_code == 404
    cid = prof.post("/api/courses", json={**base, "hub_school": "가나고등학교"}).json()["id"]
    assert prof.get("/api/courses/mine").json()["courses"][0]["hub_id"] == hub_id

    # 4) 강좌 개설은 거점학교 관리교사가 승인해야 열린다 (그 전엔 학생 목록에 없고 수업도 못 연다)
    s1, s2 = student(1), student(2)
    mine = prof.get("/api/courses/mine").json()["courses"][0]
    assert mine["approval"] == "pending"
    assert s1.get("/api/courses/available").json()["courses"] == []
    assert s1.post(f"/api/courses/{cid}/enroll").status_code == 404
    assert prof.post("/api/live/classes", json={"title": "1주차", "course_id": cid}).status_code == 409
    assert prof.post(f"/api/hub/courses/{cid}/approval", json={"action": "approve"}).status_code == 403  # 강사는 못 함
    assert coord.post(f"/api/hub/courses/{cid}/approval", json={"action": "reject"}).status_code == 400  # 사유 필수
    coord.post(f"/api/hub/courses/{cid}/approval", json={"action": "reject", "note": "수업계획서를 올려 주세요"})
    mine = prof.get("/api/courses/mine").json()["courses"][0]
    assert (mine["approval"], mine["approval_note"]) == ("rejected", "수업계획서를 올려 주세요")
    prof.post(f"/api/courses/{cid}", json={"description": "고쳤어요"})  # 고치면 다시 승인 대기
    assert prof.get("/api/courses/mine").json()["courses"][0]["approval"] == "pending"
    ov = coord.get("/api/hub/overview").json()
    assert [(x["title"], x["approval"]) for x in ov["courses"]] == [("정치 보충", "pending")]
    assert coord.post(f"/api/hub/courses/{cid}/approval", json={"action": "approve"}).status_code == 200

    # 5) 학생 수강신청 → 강사 승인만으로 수강 확정
    s1.post(f"/api/courses/{cid}/enroll")
    s2.post(f"/api/courses/{cid}/enroll")
    c = s1.get("/api/courses/available").json()["courses"][0]
    assert c["hub_school"] == "가나고등학교" and c["status"] == "pending"
    ens = {e["student_no"]: e for e in prof.get(f"/api/courses/{cid}/enrollments").json()["enrollments"]}
    code = create(prof, title="1주차", course_id=cid)["code"]
    assert s1.post(f"/api/live/classes/{code}/join").status_code == 403  # 승인 전
    prof.post(f"/api/courses/{cid}/enrollments/{ens['20301']['user_id']}", json={"status": "approved"})
    prof.post(f"/api/courses/{cid}/enrollments/{ens['20302']['user_id']}", json={"status": "rejected", "note": "정원 초과"})
    assert s1.get("/api/courses/available").json()["courses"][0]["status"] == "approved"
    rej = s2.get("/api/courses/available").json()["courses"][0]
    assert rej["status"] == "rejected" and rej["note"] == "정원 초과"
    assert s1.get("/api/courses/live-now").json()["classes"][0]["code"] == code
    assert s1.post(f"/api/live/classes/{code}/join").status_code == 200
    # 수업신청자 관리: 내 모든 강좌의 신청을 한 번에 (학년·반·소속학교 포함)
    rows = prof.get("/api/my/enrollments").json()["enrollments"]
    assert sorted((x["name"], x["status"], x["grade"], x["class_no"], x["hub_school"]) for x in rows) == [
        ("학생1", "approved", 2, 3, "가나고등학교"), ("학생2", "rejected", 2, 3, "가나고등학교")]
    assert s1.get("/api/my/enrollments").status_code == 403
    s3 = student(3)
    s3.post(f"/api/courses/{cid}/enroll")
    assert prof.post(f"/api/courses/{cid}/approve-all").json()["approved"] == 1
    # 관리교사: 수업 기록(언제 수업했는지)
    log = coord.get("/api/hub/class-log").json()["classes"]
    assert [(x["course_title"], x["title"], x["attended"]) for x in log] == [("정치 보충", "1주차", 0)]
    assert [x["id"] for x in coord.get("/api/hub/class-log", params={"course_id": cid}).json()["classes"]] == [log[0]["id"]]
    assert prof.get("/api/hub/class-log").status_code == 403
    with db.engine.begin() as conn:
        conn.execute(db.attendance.insert().values(class_id=log[0]["id"],
                     user_id=s1.get("/api/me").json()["user"]["id"],
                     joined_at=db.now(), left_at=db.now(), last_seen=db.now()))
    sheet = coord.get(f"/api/hub/courses/{cid}/attendance").json()
    assert [(x["title"], x["date"]) for x in sheet["classes"]] == [("1주차", log[0]["date"])]
    assert [(x["student_no"], x["attendance"]) for x in sheet["students"]] == [
        ("20301", [True]), ("20303", [False])]
    assert prof.get(f"/api/hub/courses/{cid}/attendance").status_code == 403
    assert coord.get("/api/hub/courses/999999/attendance").status_code == 404

    # 6) 관리교사 권한을 해제하면 관리 기능이 꺼지고, 강사 기간이 끝나면 강사 기능이 꺼진다
    admin.post(f"/api/staff/{capps[0]['id']}", json={"action": "revoke", "note": "임기 종료"})
    assert coord.get("/api/hub/overview").status_code in (403, 409)
    assert coord.post(f"/api/staff/{iapps[0]['id']}", json={"action": "approve", "valid_until": "2099-12-31"}).status_code == 403
    admin.post(f"/api/staff/{iapps[0]['id']}", json={"action": "approve", "valid_from": "2020-01-01", "valid_until": "2020-12-31"})
    pme = prof.get("/api/me").json()["user"]
    assert pme["role"] == "guest" and pme["memberships"][0]["status"] == "expired"


def test_same_person_both_roles_at_same_hub(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"admin@gmail.com"})
    admin = login("admin@gmail.com", name="전체관리자")
    form = {"contact": "010", "pledge": True, "affiliation": "", "wish_from": "2026-03-01", "wish_until": "2099-02-28"}

    def guest(email):
        g = TestClient(app)
        google_login(g, email)
        return g

    def approve(who, role, app_id, **kw):
        return who.post(f"/api/staff/{app_id}", json={"action": "approve", **kw})

    def apps(who, role):
        return who.get("/api/staff/applications", params={"role": role}).json()["applications"]

    # 가나고 관리교사 A
    a = guest("a@gmail.com")
    staff_apply(a, {"role": "coordinator", "hub_name": "가나고등학교", "name": "관리A", **form})
    approve(admin, "coordinator", apps(admin, "coordinator")[0]["id"])
    hub = a.get("/api/me").json()["user"]["coordinator_hubs"][0]["id"]

    # 1) 강사였던 B: 가나고 강사 (작년, 기간 끝남) → 올해 같은 학교 관리교사도 신청
    b = guest("b@gmail.com")
    staff_apply(b, {"role": "instructor", "name": "강사B", **form})
    assert [x for x in apps(a, "instructor") if x["name"] == "강사B"] == []  # 강의교사 가입은 전체 관리자가 승인
    bi = [x for x in apps(admin, "instructor") if x["name"] == "강사B"][0]
    approve(admin, "instructor", bi["id"], valid_from="2025-01-01", valid_until="2025-12-31")
    assert b.get("/api/me").json()["user"]["role"] == "guest"  # 기간 끝남
    # 기간이 끝난 강사가 다시 신청하면 '승인 대기'로 돌아간다 (연장 요청)
    staff_apply(b, {"role": "instructor", "name": "강사B", **form})
    assert [x["status"] for x in apps(admin, "instructor") if x["name"] == "강사B"] == ["pending"]
    # 같은 학교 관리교사 신청 → 전체 관리자 승인 → 두 역할을 함께 가진다
    assert staff_apply(b, {"role": "coordinator", "hub_name": "가나고등학교", "name": "강사B", **form}).status_code == 200
    bc = [x for x in apps(admin, "coordinator") if x["name"] == "강사B"][0]
    approve(admin, "coordinator", bc["id"])
    me = b.get("/api/me").json()["user"]
    assert me["coordinator_hubs"] == [{"id": hub, "name": "가나고등학교"}]  # 같은 거점학교로 합쳐짐
    assert sorted(m["role"] for m in me["memberships"]) == ["coordinator", "instructor"]

    # 2) 관리교사 A가 자기 학교 강사로도 등록: 본인 신청은 본인이 승인할 수 없다
    staff_apply(a, {"role": "instructor", "name": "관리A", **form,
                    "affil_type": "univ", "affiliation": "울산대학교", "department": "교육학과",
                    "email": "a@univ.ac.kr"})
    ai = [x for x in apps(admin, "instructor") if x["name"] == "관리A"][0]
    assert ai["affiliation"] == "울산대학교"
    assert a.get("/api/me").json()["user"]["school"] == "가나고등학교"
    assert approve(a, "instructor", ai["id"]).status_code == 403
    # 관리교사(B)는 강의교사 가입을 승인할 수 없고, 전체 관리자가 승인
    assert approve(b, "instructor", ai["id"], valid_until="2099-02-28").status_code == 403
    assert approve(admin, "instructor", ai["id"], valid_until="2099-02-28").status_code == 200
    roles = sorted(m["role"] for m in a.get("/api/me").json()["user"]["memberships"] if m["status"] == "approved")
    assert roles == ["coordinator", "instructor"]
    assert a.get("/api/me").json()["user"]["school"] == "가나고등학교"


def test_instructor_opens_courses_at_any_hub(monkeypatch):
    """강의교사는 거점학교에 묶이지 않는다: 과목마다 거점학교를 고르고, 그 학교 관리교사만 관리한다"""
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"admin@gmail.com"})
    admin = login("admin@gmail.com", name="전체관리자")
    form = {"contact": "010", "pledge": True, "affiliation": "", "wish_from": "2026-03-01", "wish_until": "2099-02-28"}

    def guest(email):
        g = TestClient(app)
        google_login(g, email)
        return g

    coordinators = {}
    for index, school in enumerate(("가나고", "다라고")):
        coordinator = guest(f"coordinator-{index}@gmail.com")
        assert staff_apply(coordinator, {"role": "coordinator", "hub_name": school,
                          "name": "관리", **form}).status_code == 200
        coordinators[school] = coordinator
    for x in admin.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"]:
        admin.post(f"/api/staff/{x['id']}", json={"action": "approve"})
    hubs = {h["name"]: h["id"] for h in admin.get("/api/hubs").json()["hubs"]}
    t = guest("t@gmail.com")
    staff_apply(t, {"role": "instructor", "name": "강사", **form})
    iid = admin.get("/api/staff/applications", params={"role": "instructor"}).json()["applications"][0]["id"]
    admin.post(f"/api/staff/{iid}", json={"action": "approve", "valid_until": "2099-02-28"})
    cid = t.post("/api/courses", json={**COURSE, "hub_id": hubs["가나고"]}).json()["id"]
    cid2 = t.post("/api/courses", json={**COURSE, "title": "경제", "hub_id": hubs["다라고"]}).json()["id"]
    assert coordinators["다라고"].post(f"/api/hub/courses/{cid}/approval", json={"action": "approve"}).status_code in (403, 404)
    coordinators["가나고"].post(f"/api/hub/courses/{cid}/approval", json={"action": "approve"})
    coordinators["다라고"].post(f"/api/hub/courses/{cid2}/approval", json={"action": "approve"})
    assert create(t, title="1주차", course_id=cid)["code"]
    assert coordinators["가나고"].get(f"/api/hub/courses/{cid}/attendance").status_code == 200
    assert coordinators["다라고"].get(f"/api/hub/courses/{cid}/attendance").status_code == 404
    assert coordinators["다라고"].get("/api/hub/class-log", params={"course_id": cid}).json()["classes"] == []

    # 강의교사 권한을 해제하면 과목이 잠기고, 다시 승인받으면 풀린다
    admin.post(f"/api/staff/{iid}", json={"action": "revoke"})
    assert t.post("/api/live/classes", json={"title": "2주차", "course_id": cid}).status_code == 403
    admin.post(f"/api/staff/{iid}", json={"action": "approve", "valid_until": "2099-02-28"})
    assert all(not c["locked"] for c in t.get("/api/courses/mine").json()["courses"])


def test_students_from_other_schools(monkeypatch):
    """거점학교 강좌는 다른 학교 학생도 신청해 듣는다. 학번이 같아도 학교로 구분된다."""
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"admin@gmail.com"})
    admin = login("admin@gmail.com", name="전체관리자")
    staff_apply(admin, {"role": "coordinator", "hub_name": "가나고", "name": "관리", "contact": "010", "pledge": True})
    admin.post(f"/api/staff/{admin.get('/api/staff/applications', params={'role': 'coordinator'}).json()['applications'][0]['id']}",
               json={"action": "approve"})
    hub = admin.get("/api/hubs").json()["hubs"][0]["id"]
    cid = admin.post("/api/courses", json={**COURSE, "hub_id": hub}).json()["id"]
    # 가나고 학생과 다라고 학생, 둘 다 학번 20315
    a = login("a@s.school.kr", name="김민수", school="가나고", grade=2, class_no=3, number=15)
    b = login("b@s.school.kr", name="김민수", school="다라고", grade=2, class_no=3, number=15)
    for s in (a, b):
        assert s.post(f"/api/courses/{cid}/enroll").status_code == 200
    assert admin.post(f"/api/courses/{cid}/approve-all").json()["approved"] == 2  # 전체 관리자는 한 번에 확정
    c = create(admin, title="1주차", course_id=cid)
    code, cls_id = c["code"], c["class_id"]
    with admin.websocket_connect(f"/ws/live/{code}") as tw:
        for s in (a, b):
            assert s.post(f"/api/live/classes/{code}/join").status_code == 200
        with a.websocket_connect(f"/ws/live/{code}"), b.websocket_connect(f"/ws/live/{code}"):
            st = state(tw, lambda m: sum(x["online"] for x in m["students"]) == 2)
            assert sorted(x["school"] for x in st["students"]) == ["가나고", "다라고"]
    rep = admin.get(f"/api/live/history/{cls_id}").json()
    assert [(p["school"], p["student_no"]) for p in rep["students"]] == [("가나고", "20315"), ("다라고", "20315")]
    assert "가나고" in admin.get(f"/api/live/history/{cls_id}/attendance.csv").text


def test_presentation_whiteboard_and_files(monkeypatch, tmp_path):
    monkeypatch.setattr(cr, "SLIDES_DIR", tmp_path)
    t = teacher()
    c = create(t)
    code = c["code"]
    s1, s2 = student(1), student(2)
    s1.post(f"/api/live/classes/{code}/join")
    pdf = b"%PDF-1.4\n%fake\n"
    # PDF만, 선생님만 올릴 수 있다
    assert t.post(f"/api/live/classes/{code}/files?name=a.pptx", content=b"PK\x03\x04").status_code == 415
    assert s1.post(f"/api/live/classes/{code}/files", content=pdf).status_code == 403
    fid = t.post(f"/api/live/classes/{code}/files?name=선거제도.pdf", content=pdf).json()["id"]
    # 들어온 학생만 받을 수 있다
    assert s1.get(f"/api/live/classes/{code}/files/{fid}").content == pdf
    assert s2.get(f"/api/live/classes/{code}/files/{fid}").status_code == 403
    assert s1.get(f"/api/live/classes/{code}/files/nope").status_code == 404

    with t.websocket_connect(f"/ws/live/{code}") as tw, s1.websocket_connect(f"/ws/live/{code}") as sw:
        state(tw)
        tw.send_json({"t": "present_open", "file": fid, "pages": 3})
        st = state(sw, lambda m: m["present"] is not None)
        assert st["present"] == {"mode": "slides", "file": fid, "name": "선거제도.pdf", "page": 1, "pages": 3, "key": f"{fid}:1",
                                 "zoom": {"z": 1, "x": 0.5, "y": 0.5}}
        # 확대: 선생님이 확대하면 학생 화면도 같은 곳을 같은 배율로 (최대 4배)
        tw.send_json({"t": "present_zoom", "z": 9, "x": 0.25, "y": 0.75})
        assert state(sw, lambda m: m["present"]["zoom"]["z"] > 1)["present"]["zoom"] == {"z": 4.0, "x": 0.25, "y": 0.75}
        sw.send_json({"t": "present_zoom", "z": 1})  # 학생은 바꿀 수 없다
        # 판서: 그리는 중에 나눠 보낸 점이 학생에게 바로 간다 (상태 전체를 다시 보내지 않음)
        tw.send_json({"t": "stroke", "key": f"{fid}:1", "id": "a1", "color": "#d92d20", "size": 3, "pts": [[0.1, 0.1], [0.2, 0.2]]})
        tw.send_json({"t": "stroke", "key": f"{fid}:1", "id": "a1", "pts": [[0.3, 0.3]]})
        m = until(sw, lambda m: m["t"] == "stroke" and m["pts"] == [[0.3, 0.3]])
        assert m["color"] == "#d92d20"
        tw.send_json({"t": "stroke", "key": "wrong:1", "id": "x", "pts": [[0.5, 0.5]]})  # 지금 쪽이 아니면 무시
        # 다음 쪽 → 그 쪽 판서(빈 것)를 받는다. 마지막 쪽 너머로는 안 간다
        tw.send_json({"t": "present_page", "page": 2})
        assert until(sw, lambda m: m["t"] == "strokes")["key"] == f"{fid}:2"
        assert state(sw, lambda m: m["present"]["page"] == 2)["present"]["zoom"]["z"] == 1  # 쪽을 넘기면 확대가 풀린다
        tw.send_json({"t": "present_page", "page": 9})
        assert state(sw, lambda m: m["present"]["page"] == 3)["present"]["page"] == 3
        tw.send_json({"t": "present_page", "page": 1})
        back = until(sw, lambda m: m["t"] == "strokes" and m["key"] == f"{fid}:1")
        assert back["strokes"][0]["pts"] == [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]]
        tw.send_json({"t": "stroke_del", "key": f"{fid}:1", "ids": ["a1"]})
        assert until(sw, lambda m: m["t"] == "stroke_del")["ids"] == ["a1"]
        # 화이트보드: 마지막 쪽에서 다음 쪽으로 가면 새 쪽이 생긴다
        tw.send_json({"t": "present_board"})
        assert state(sw, lambda m: (m["present"] or {}).get("mode") == "board")["present"]["key"] == "wb:1"
        tw.send_json({"t": "present_page", "page": 2})
        assert state(sw, lambda m: m["present"]["pages"] == 2)["present"]["key"] == "wb:2"
        # 학생은 발표를 조작할 수 없다 (화이트보드에 자기 획을 쓰는 것만 된다)
        sw.send_json({"t": "present_close"})
        sw.send_json({"t": "stroke", "key": "wb:2", "id": "s", "pts": [[0.1, 0.1]]})
        time.sleep(0.2)
        assert cr.classes[code].present is not None
        assert [(x["id"], x.get("by")) for x in cr.classes[code].strokes.get("wb:2")] == [("s", "2")]
        tw.send_json({"t": "stroke", "key": "wb:2", "id": "w1", "pts": [[0.2, 0.2], [0.4, 0.4]]})
        time.sleep(0.2)
        tw.send_json({"t": "present_close"})
        state(sw, lambda m: m["present"] is None)
    # 서버가 다시 켜져도 자료와 판서가 이어진다 (1분마다·수업 종료 때 DB에 저장)
    import asyncio
    asyncio.run(cr.save_boards(cr.classes[code]))
    cr.classes.clear()
    with t.websocket_connect(f"/ws/live/{code}") as tw:
        st = state(tw)
        assert [f["id"] for f in st["files"]] == [fid] and st["files"][0]["pages"] == 3
        assert cr.classes[code].board_pages == 2
        tw.send_json({"t": "end_class"})
        until(tw, lambda m: m["t"] == "ended")
    time.sleep(0.3)
    # 과목 없이 연 수업(특강·회의)을 끝내면 자료 내용은 바로 파기되고, 공유한 기록(파일명)만 남는다
    cid = c["class_id"]
    for _ in range(30):
        if not (tmp_path / str(cid) / f"{fid}.pdf").exists():
            break
        time.sleep(0.1)
    assert not (tmp_path / str(cid) / f"{fid}.pdf").exists()
    lst = s1.get("/api/materials").json()["classes"]
    assert [(x["id"], x["files"], x["removed"]) for x in lst] == [(cid, 0, 1)]
    detail = s1.get(f"/api/materials/class/{cid}").json()
    assert detail["files"] == [] and [x["name"] for x in detail["removed"]] == ["선거제도.pdf"]
    assert s1.get(f"/api/materials/file/{fid}").status_code == 410
    # 수업에 들어오지 않았고 수강생도 아닌 학생은 기록도 볼 수 없다
    assert s2.get("/api/materials").json()["classes"] == []
    assert s2.get(f"/api/materials/class/{cid}").status_code == 403


def test_groups_by_size_and_teacher_controls_mic():
    from livekit import api as lk
    verifier = lk.TokenVerifier(cr.LIVEKIT_API_KEY, cr.LIVEKIT_API_SECRET)

    def grants(client, room):
        r = client.post(f"/api/live/classes/{code}/token", json={"room": room})
        assert r.status_code == 200, r.text
        return verifier.verify(r.json()["token"]).video

    t = teacher()
    code = create(t)["code"]
    studs = [student(i) for i in range(1, 8)]
    for s in studs:
        s.post(f"/api/live/classes/{code}/join")
    with t.websocket_connect(f"/ws/live/{code}") as tw:
        state(tw)
        tw.send_json({"t": "breakout_plan", "size": 3})  # 7명을 3명씩 → 3개 모둠
        st = state(tw, lambda m: len(m["groups"]) == 3)
        sizes = sorted(sum(1 for s in st["students"] if s["group"] == g["id"]) for g in st["groups"])
        assert sizes == [2, 2, 3]
        # 마이크는 언제나 학생이 자유롭게 켠다. 선생님은 학생 마이크를 켜거나(학생 화면이 바로 켬) 끌 수 있다
        sid = st["students"][0]["id"]
        who = next(s for s in studs if str(s.get("/api/me").json()["user"]["id"]) == sid)
        with who.websocket_connect(f"/ws/live/{code}") as sw:
            assert state(sw)["settings"]["mic_lock"] is False
            assert sorted(grants(who, "main").can_publish_sources) == ["camera", "microphone", "screen_share", "screen_share_audio"]  # 카메라·마이크는 학생 마음대로
            sw.send_json({"t": "mic_req", "on": True})  # 마이크 요청은 이제 필요 없어 무시
            sw.send_json({"t": "hand", "up": True})
            st2 = state(tw, lambda m: any(x["hand"] for x in m["students"]))
            assert sum(x["mic_req"] for x in st2["students"]) == 0
            tw.send_json({"t": "cmd", "cmd": "mic_on", "target": sid})
            assert until(sw, lambda m: m["t"] == "cmd")["cmd"] == "mic_on"
            me = state(sw, lambda m: m["me"]["can_speak"])["me"]
            assert me["hand"] is True and me["can_cam"] is False  # 손은 그대로
            # 카메라는 선생님이 켠다 (데이터 절약 모드)
            tw.send_json({"t": "cmd", "cmd": "cam_on", "target": sid})
            assert until(sw, lambda m: m["t"] == "cmd")["cmd"] == "cam_on"
            state(sw, lambda m: m["me"]["can_cam"])
            assert sorted(grants(who, "main").can_publish_sources) == ["camera", "microphone", "screen_share", "screen_share_audio"]
            # 선생님이 한 학생 마이크를 끄면 다시 켜 줄 때까지 못 켠다
            tw.send_json({"t": "cmd", "cmd": "mic_off", "target": sid})
            assert until(sw, lambda m: m["t"] == "cmd")["cmd"] == "mute"
            state(sw, lambda m: m["me"]["mic_blocked"])
            assert grants(who, "main").can_publish_sources == ["camera", "screen_share", "screen_share_audio"]
            tw.send_json({"t": "cmd", "cmd": "mute", "target": "all"})
            assert until(sw, lambda m: m["t"] == "cmd")["cmd"] == "mute"


def test_policy_pages(monkeypatch):
    monkeypatch.delenv("RETENTION", raising=False)
    c = TestClient(app)
    for path in ("/live/terms", "/live/privacy", "/live/notice"):
        r = c.get(path)
        assert r.status_code == 200 and "(설정 필요)" in r.text  # 운영 기관 등을 아직 안 정함
    for path in ("/live/privacy", "/live/notice"):
        r = c.get(path)
        assert "수강한 학년도가 끝난 날부터 5년" in r.text
    assert "수강한 학년도가 끝난 날부터 5년" in c.get("/api/consent").json()["privacy"]
    monkeypatch.setenv("RETENTION", "수강한 학년도가 끝난 날부터 1년")
    assert "1년" not in c.get("/live/privacy").text
    assert "수강한 학년도가 끝난 날부터 5년" in c.get("/live/privacy").text
    monkeypatch.delenv("RETENTION")
    monkeypatch.setenv("OPERATOR_NAME", "가나고등학교<script>")
    monkeypatch.setenv("PRIVACY_OFFICER", "교감 홍길동")
    monkeypatch.setenv("PRIVACY_CONTACT", "02-123-4567")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    p = c.get("/live/privacy").text
    assert "가나고등학교&lt;script&gt;" in p and "<script>" not in p  # 설정 값은 그대로 출력하지 않는다
    assert "Hetzner" in p and "Anthropic, PBC" in p and "이전 국가" in p  # AI 조교 설정과 상관없이 미국 이전 항목은 늘 보인다
    assert "고객센터 +49 (0)9831 505-0" in p
    assert "회원 탈퇴 신청 또는 서비스 이용 중단을 통해 향후 국외 이전을 거부" in p
    assert "가장 최근 성공 로그인 시각 1건만 저장" in p
    assert "다른 법령이 해당 개인정보를 수집 대상으로 명시한 경우" in p
    assert "수업 자료라는 이유만으로 요청을 일괄 제한하지 않으며" in p
    assert "백업 생성일부터 14일이 지난 사본은 다음 자동 백업 작업에서 삭제" in p
    assert "시행일 최소 7일 전에" in p and "탈퇴 승인일부터 최대 365일" in p and "복구할 수 없도록" in p
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert "Anthropic" in c.get("/live/privacy").text and "AI 조교" in c.get("/live/terms").text
    assert c.get("/api/me").json()["policy_ready"] is True
    n = c.get("/live/notice").text  # 보호자 안내문: 만 14세 이상 본인 동의라 서명 양식이 없다
    assert "가나고등학교&lt;script&gt;" in n and "제22조의2" in n
    assert "서명" not in n and "국외 이전 동의서" not in n
    # 강사 신청서의 동의는 이용약관 확인으로도 기록된다
    g = TestClient(app)
    google_login(g, "guest@gmail.com")
    assert g.get("/api/me").json()["user"]["needs_terms"] is True
    staff_apply(g, {"role": "coordinator", "hub_name": "가나고", "name": "관리", "contact": "010", "pledge": True})
    assert g.get("/api/me").json()["user"]["needs_terms"] is False


def test_course_materials_for_absent_students(monkeypatch, tmp_path):
    """수업을 못 들은 수강생도 지난 수업 자료를 볼 수 있다"""
    monkeypatch.setattr(cr, "SLIDES_DIR", tmp_path)
    t = teacher()
    cid = t.post("/api/courses", json=COURSE).json()["id"]
    absent = student(5)
    absent.post(f"/api/courses/{cid}/enroll")
    t.post(f"/api/courses/{cid}/approve-all")
    c = create(t, title="3주차", course_id=cid)
    t.post(f"/api/live/classes/{c['code']}/files?name=a.pdf", content=b"%PDF-1.4 x")
    lst = absent.get("/api/materials").json()["classes"]
    assert [(x["id"], x["course_title"]) for x in lst] == [(c["class_id"], COURSE["title"])]
    assert [x["id"] for x in absent.get(f"/api/materials?course_id={cid}").json()["classes"]] == [c["class_id"]]
    assert absent.get(f"/api/materials?course_id={cid + 1}").json()["classes"] == []
    # 수강 승인이 취소되면 볼 수 없다
    me = absent.get("/api/me").json()["user"]["id"]
    t.post(f"/api/courses/{cid}/enrollments/{me}", json={"status": "removed"})
    assert absent.get("/api/materials").json()["classes"] == []


def test_drive_picker_config(monkeypatch):
    c = TestClient(app)
    assert c.get("/api/me").json()["drive_picker"] is None  # 설정하지 않으면 버튼이 안 보인다
    monkeypatch.setattr(auth, "GOOGLE_CLIENT_ID", "x.apps.googleusercontent.com")
    monkeypatch.setattr(auth, "GOOGLE_API_KEY", "AIzaTEST")
    monkeypatch.setattr(auth, "GOOGLE_APP_ID", "123")
    assert c.get("/api/me").json()["drive_picker"] == {"api_key": "AIzaTEST", "app_id": "123"}


def test_assignments(monkeypatch, tmp_path):
    import io
    import zipfile
    import app.assignments as asg
    monkeypatch.setattr(asg, "FILES_DIR", tmp_path)
    t = teacher()
    cid = t.post("/api/courses", json=COURSE).json()["id"]
    a, b, outsider = student(1), student(2), student(3)
    for s in (a, b):
        s.post(f"/api/courses/{cid}/enroll")
    t.post(f"/api/courses/{cid}/approve-all")
    # 과제 내기 (마감: 먼 미래)
    assert outsider.post(f"/api/courses/{cid}/assignments", json={"title": "x"}).status_code == 403
    aid = t.post(f"/api/courses/{cid}/assignments", json={
        "title": "선거 제도 보고서", "description": "A4 1장", "due": "2099-11-05T23:59", "allow_late": False}).json()["id"]
    mine = a.get("/api/my/assignments").json()["assignments"]
    assert [x["title"] for x in mine] == ["선거 제도 보고서"] and mine[0]["can_submit"] and mine[0]["due"] == "2099-11-05 23:59"
    assert outsider.get("/api/my/assignments").json()["assignments"] == []  # 수강생이 아니면 안 보임
    assert outsider.post(f"/api/assignments/{aid}/files", content=b"x").status_code == 404
    # 제출: 파일 + 글. 다시 내면 고쳐진다
    fid = a.post(f"/api/assignments/{aid}/files?name=보고서.pdf", content=b"%PDF-1.4 report",
                 headers={"Content-Type": "application/pdf"}).json()["id"]
    a.post(f"/api/assignments/{aid}/files?name=<script>.html", content=b"<script>alert(1)</script>",
           headers={"Content-Type": "text/html"})
    a.post(f"/api/assignments/{aid}/text", json={"text": "참고 자료는 교과서 3단원"})
    m = a.get("/api/my/assignments").json()["assignments"][0]["mine"]
    assert m["submitted"] and len(m["files"]) == 2 and m["text"] == "참고 자료는 교과서 3단원" and not m["late"]
    # 파일은 낸 학생과 선생님만. HTML 같은 형식은 브라우저에서 열리지 않고 내려받기로만
    assert a.get(f"/api/submission-files/{fid}").content == b"%PDF-1.4 report"
    assert t.get(f"/api/submission-files/{fid}").status_code == 200
    assert b.get(f"/api/submission-files/{fid}").status_code == 404
    html_id = [f["id"] for f in m["files"] if f["name"].endswith(".html")][0]
    r = a.get(f"/api/submission-files/{html_id}")
    assert r.headers["content-type"] == "application/octet-stream" and r.headers["content-disposition"].startswith("attachment")
    assert a.post(f"/api/submission-files/{html_id}/delete").status_code == 200
    # 선생님: 제출 현황 (낸 학생·안 낸 학생), 점수·피드백
    subs = {s["student_no"]: s for s in t.get(f"/api/assignments/{aid}/submissions").json()["submissions"]}
    assert subs["20301"]["submitted"] and len(subs["20301"]["files"]) == 1 and not subs["20302"]["submitted"]
    assert t.get(f"/api/courses/{cid}/assignments").json()["assignments"][0]["submitted"] == 1
    t.post(f"/api/assignments/{aid}/grade", json={"user_id": subs["20301"]["user_id"], "score": 9, "feedback": "근거가 좋아요"})
    m = a.get("/api/my/assignments").json()["assignments"][0]["mine"]
    assert m["score"] == 9 and m["feedback"] == "근거가 좋아요"
    # 모두 내려받기
    z = zipfile.ZipFile(io.BytesIO(t.get(f"/api/assignments/{aid}/download.zip").content))
    assert sorted(z.namelist()) == ["가나중학교_20301_학생1/보고서.pdf", "가나중학교_20301_학생1/제출글.txt"]
    # 마감이 지나면(지각 제출 안 받음) 낼 수 없고, 지각 제출을 켜면 '지각'으로 받는다
    t.post(f"/api/assignments/{aid}", json={"due": "2020-01-01T00:00"})
    assert b.post(f"/api/assignments/{aid}/text", json={"text": "늦었어요"}).status_code == 409
    t.post(f"/api/assignments/{aid}", json={"allow_late": True})
    assert b.post(f"/api/assignments/{aid}/text", json={"text": "늦었어요"}).status_code == 200
    assert b.get("/api/my/assignments").json()["assignments"][0]["mine"]["late"] is True
    t.post(f"/api/assignments/{aid}", json={"closed": True})
    assert b.post(f"/api/assignments/{aid}/text", json={"text": "또"}).status_code == 409
    # 과제를 지우면 제출물도 지워진다
    assert t.post(f"/api/assignments/{aid}/delete").status_code == 200
    assert not (tmp_path / "assignments" / str(aid)).exists()
    assert a.get(f"/api/submission-files/{fid}").status_code == 404


def test_recording_notice(monkeypatch):
    t = teacher()
    code = create(t)["code"]
    a = student(1)
    a.post(f"/api/live/classes/{code}/join")
    assert t.get("/api/me").json()["recording_allowed"] is True
    with t.websocket_connect(f"/ws/live/{code}") as tw, a.websocket_connect(f"/ws/live/{code}") as sa:
        assert state(sa)["recording"] is False
        tw.send_json({"t": "recording", "on": True})
        assert "녹화를 시작" in until(sa, lambda m: m["t"] == "chat")["msg"]["text"]  # 채팅에 안내가 먼저
        assert state(sa, lambda m: m["recording"])["recording"] is True  # 학생 화면에 '녹화 중'
        ev = state(tw, lambda m: any(e["kind"] == "record_on" for e in m["events"]))
        assert ev["recording"] is True
    # 선생님 화면이 닫히면 녹화 표시도 꺼진다
    assert cr.classes[code].recording is False
    # 학교가 녹화를 허용하지 않으면
    monkeypatch.setattr(cr, "ALLOW_RECORDING", False)
    monkeypatch.setenv("ALLOW_RECORDING", "0")
    assert t.get("/api/me").json()["recording_allowed"] is False
    with t.websocket_connect(f"/ws/live/{code}") as tw:
        state(tw)
        tw.send_json({"t": "recording", "on": True})
        time.sleep(0.2)
    assert cr.classes[code].recording is False
    assert "강의 녹화" not in TestClient(app).get("/live/privacy").text


def test_signup_choice_schools_and_grades(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"admin@gmail.com"})
    admin = login("admin@gmail.com", name="관리자")
    # 학교 계정(선생님도 같은 도메인)으로 처음 들어오면 학생/선생님을 고른다
    tch = TestClient(app)
    google_login(tch, "kim@s.school.kr")
    me = tch.get("/api/me").json()["user"]
    assert me["role"] == "student" and me["role_choice"] and me["needs_profile"]
    me = tch.post("/api/me/self-role", json={"role": "staff"}).json()
    assert me["role"] == "guest" and not me["role_choice"] and me["can_be_student"]  # 강사·관리교사 신청 화면으로
    assert tch.get("/api/courses/available").status_code == 403  # 학생 기능은 못 씀
    # 학교 계정이 아니면 고를 수 없다
    g = TestClient(app)
    google_login(g, "someone@gmail.com")
    assert g.post("/api/me/self-role", json={"role": "student"}).status_code == 400
    # 학교 목록: 전체 관리자만 저장, 학생은 목록에 있는 정식 이름만
    assert tch.post("/api/admin/schools", json={"text": "가나고"}).status_code == 403
    r = admin.post("/api/admin/schools", json={"text": "신정고등학교\n  울산고등학교 \n\n신정고등학교"}).json()
    assert r["schools"] == ["신정고등학교", "울산고등학교"]
    assert admin.get("/api/me").json()["schools"] == ["신정고등학교", "울산고등학교"]
    s = TestClient(app)
    google_login(s, "st9@s.school.kr")
    prof = {"name": "학생", "grade": 2, "class_no": 1, "number": 9, "agree": True,
            "birth": "2008-04-03", "gender": "남"}
    assert s.post("/api/me/profile", json={**prof, "school": "신정고"}).status_code == 400
    me = s.post("/api/me/profile", json={**prof, "school": "신정고등학교"}).json()
    assert me["role"] == "student" and not me["needs_profile"]
    # 대상 학년: 1학년 강좌는 2학년에게 안 보이고 신청도 안 된다
    t = teacher()
    assert t.post("/api/courses", json={**COURSE, "hub_school": ""}).status_code == 400  # 거점학교 없이는 못 연다
    assert t.post("/api/courses", json=COURSE).status_code == 400  # 울산 고등학교 목록에 없는 거점학교
    hub = {"hub_school": "신정고등학교"}
    c1 = t.post("/api/courses", json={**COURSE, **hub, "title": "1학년 강좌", "grades": [1]}).json()["id"]
    c2 = t.post("/api/courses", json={**COURSE, **hub, "title": "2·3학년 강좌", "grades": [3, 2]}).json()["id"]
    titles = [x["title"] for x in s.get("/api/courses/available").json()["courses"]]
    assert "1학년 강좌" not in titles and "2·3학년 강좌" in titles
    assert s.post(f"/api/courses/{c1}/enroll").status_code == 409
    assert s.post(f"/api/courses/{c2}/enroll").status_code == 200
    assert [x["grades"] for x in t.get("/api/courses/mine").json()["courses"] if x["id"] == c2] == [[2, 3]]
    t.post(f"/api/courses/{c1}", json={"grades": []})  # 학년 제한을 풀면 보인다
    assert "1학년 강좌" in [x["title"] for x in s.get("/api/courses/available").json()["courses"]]


def test_withdraw(monkeypatch, tmp_path):
    """학생 탈퇴는 그 학생 소속 학교의 참여학교 교사(없으면 전체 관리자)가 승인한다"""
    import app.assignments as asg
    monkeypatch.setattr(asg, "FILES_DIR", tmp_path)
    monkeypatch.delenv("EVIDENCE_RETENTION_DAYS", raising=False)
    monkeypatch.delenv("EVIDENCE_RETENTION_BASIS", raising=False)
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    # 참여학교 교사: 가나중(학생들 학교) p1, 다른 학교 p2
    ps = {}
    participant_ids = {}
    for email, school in (("p1@gmail.com", SCHOOL), ("p2@gmail.com", "마바중학교")):
        c = TestClient(app)
        google_login(c, email)
        r = staff_apply(c, {"role": "participant", "name": "담당", "hub_name": school,
                                             "affiliation": school, "contact": "010", "pledge": True})
        assert r.status_code == 200, r.text
        apps = boss.get("/api/staff/applications", params={"role": "participant"}).json()["applications"]
        assert apps[0]["hub"] == school and apps[0]["status"] == "pending"
        assert c.get("/api/staff/applications", params={"role": "participant"}).status_code == 403
        assert boss.post(f"/api/staff/{apps[0]['id']}", json={"action": "approve"}).status_code == 200
        participant_ids[school] = apps[0]["id"]
        me = c.get("/api/me").json()["user"]
        assert me["role"] == "teacher" and me["participant_schools"] == [school]
        assert not (me["teach_hubs"] or me["lead_hubs"])
        assert [hub["name"] for hub in me["coordinator_hubs"]] == [school]
        ps[school] = c
    p1, p2 = ps[SCHOOL], ps["마바중학교"]
    t = boss  # 전체 관리자가 연 강좌는 바로 개설 승인
    cid = t.post("/api/courses", json=COURSE).json()["id"]
    a, b = student(1), student(2)
    for s in (a, b):
        s.post(f"/api/courses/{cid}/enroll")
    t.post(f"/api/courses/{cid}/approve-all")
    aid = t.post(f"/api/courses/{cid}/assignments", json={"title": "보고서"}).json()["id"]
    a.post(f"/api/assignments/{aid}/files?name=r.pdf", content=b"%PDF a", headers={"Content-Type": "application/pdf"})
    b.post(f"/api/assignments/{aid}/files?name=r.pdf", content=b"%PDF b", headers={"Content-Type": "application/pdf"})
    # 참여학교 교사는 우리 학교 학생과 수강 강좌를 본다
    ov = p1.get("/api/school/overview").json()
    assert [(x["student_no"], [c["title"] for c in x["courses"]]) for x in ov["students"]] == [("20301", ["강좌"]), ("20302", ["강좌"])]
    assert p2.get("/api/school/overview").json()["students"] == []
    assert a.get("/api/school/overview").status_code == 403
    # 확인 글자가 없으면 안 되고, 강좌를 연 선생님은 바로 탈퇴할 수 없다
    assert a.post("/api/me/withdraw", json={"confirm": "네"}).status_code == 400
    assert t.post("/api/me/withdraw", json={"confirm": "탈퇴"}).status_code == 409
    # 학생은 신청만 → 우리 학교 참여학교 교사·전체 관리자에게만 보인다
    r = a.post("/api/me/withdraw", json={"confirm": "탈퇴", "reason": "전학"}).json()
    assert r["requested"] and a.get("/api/me").json()["user"]["withdraw_requested"]
    q = p1.get("/api/school/overview").json()["withdrawals"]
    assert [x["student_no"] for x in q] == ["20301"] and q[0]["reason"] == "전학" and q[0]["studying"] == ["강좌"]
    assert p2.get("/api/school/overview").json()["withdrawals"] == []
    assert p2.post(f"/api/school/withdrawals/{q[0]['user_id']}", json={"action": "approve"}).status_code == 404
    assert a.post(f"/api/school/withdrawals/{q[0]['user_id']}", json={"action": "approve"}).status_code == 403
    # 반려하면 사유가 학생에게 보이고, 다시 신청·취소할 수 있다
    p1.post(f"/api/school/withdrawals/{q[0]['user_id']}", json={"action": "reject", "note": "학기 끝나고 해요"})
    me = a.get("/api/me").json()["user"]
    assert not me["withdraw_requested"] and me["withdraw_note"] == "학기 끝나고 해요"
    a.post("/api/me/withdraw", json={"confirm": "탈퇴"})
    a.post("/api/me/withdraw/cancel")
    assert p1.get("/api/school/overview").json()["withdrawals"] == []
    a.post("/api/me/withdraw", json={"confirm": "탈퇴"})
    original = next(path for path in (tmp_path / "assignments" / str(aid)).iterdir() if path.read_bytes() == b"%PDF a")
    original.unlink()
    assert p1.post(f"/api/school/withdrawals/{q[0]['user_id']}", json={"action": "approve"}).status_code == 409
    assert a.get("/api/me").json()["user"] is not None
    original.write_bytes(b"%PDF a")
    # 승인하면 일반 자료에서 제거하고 암호화된 수업 증빙으로 분리한다.
    approved = p1.post(f"/api/school/withdrawals/{q[0]['user_id']}", json={"action": "approve"})
    assert approved.status_code == 200, approved.text
    evidence_id = approved.json()["evidence_id"]
    assert a.get("/api/me").json()["user"] is None
    assert p1.get("/api/school/overview").json()["withdrawn"] == []
    assert p2.get("/api/school/overview").json()["withdrawn"] == []
    subs = t.get(f"/api/assignments/{aid}/submissions").json()["submissions"]
    assert [s["student_no"] for s in subs] == ["20302"] and subs[0]["submitted"]
    assert len(list((tmp_path / "assignments" / str(aid)).iterdir())) == 1
    assert google_login(TestClient(app), "st1@s.school.kr").status_code == 403
    params = {"purpose": "record_check"}
    assert p1.get("/live/evidence").status_code == 200
    assert p2.get("/live/evidence").status_code == 200
    assert a.get("/live/evidence").status_code == 401
    assert p1.get("/api/evidence").status_code == 422
    listing = p1.get("/api/evidence", params=params)
    assert listing.status_code == 200 and listing.json()["policy"]["days"] == 365
    assert [x["id"] for x in listing.json()["archives"]] == [evidence_id]
    assert p2.get("/api/evidence", params=params).json()["archives"] == []
    assert p2.get(f"/api/evidence/{evidence_id}", params=params).status_code == 404
    record = p1.get(f"/api/evidence/{evidence_id}", params=params).json()["record"]
    assert record["subject"]["student_no"] == "20301"
    assert len(record["submissions"]) == len(record["files"]) == 1
    import io
    import zipfile
    with zipfile.ZipFile(io.BytesIO(p1.get(f"/api/evidence/{evidence_id}/download.zip", params=params).content)) as archive:
        assert archive.read(f"files/{record['files'][0]['evidence_file_id']}") == b"%PDF a"
    from sqlalchemy import select
    with db.engine.connect() as conn:
        encrypted = conn.execute(select(db.evidence_archives.c.payload).where(db.evidence_archives.c.id == evidence_id)).scalar_one()
        assert "학생1" not in encrypted and "20301" not in encrypted
        tombstone = conn.execute(select(db.users.c.account_state, db.users.c.last_login).where(db.users.c.id == q[0]["user_id"])).one()
        assert tombstone.account_state == "withdrawn" and tombstone.last_login is None
        assert [x.action for x in conn.execute(select(db.evidence_audit)) if x.archive_id == evidence_id] == ["archive_created", "view", "download_requested"]
    monkeypatch.setenv("EVIDENCE_RETENTION_DAYS", "1")
    monkeypatch.setenv("EVIDENCE_RETENTION_BASIS", "검증용 보존 근거")
    from app.evidence import maintain_retention
    maintain_retention()
    with db.engine.connect() as conn:
        assert conn.execute(select(db.evidence_archives.c.expires_at).where(db.evidence_archives.c.id == evidence_id)).scalar_one() is not None
    with db.engine.begin() as conn:
        conn.execute(db.evidence_archives.update().where(db.evidence_archives.c.id == evidence_id).values(expires_at=1))
    maintain_retention()
    with db.engine.connect() as conn:
        assert conn.execute(select(db.evidence_archives.c.id).where(db.evidence_archives.c.id == evidence_id)).first() is None
        assert conn.execute(select(db.evidence_files.c.id).where(db.evidence_files.c.archive_id == evidence_id)).first() is None
    # 참여학교 교사가 없는 학교 학생은 전체 관리자가 승인
    c = login("st9@s.school.kr", name="학생9", school="사아중학교", grade=1, class_no=1, number=9)
    c.post("/api/me/withdraw", json={"confirm": "탈퇴"})
    assert p1.get("/api/school/overview").json()["withdrawals"] == []
    uid = boss.get("/api/school/overview").json()["withdrawals"][0]["user_id"]
    assert boss.post(f"/api/school/withdrawals/{uid}", json={"action": "approve"}).status_code == 200
    # 학생이 아닌 사람(강사 신청만 한 사람)은 바로 탈퇴
    g = login("guest@gmail.com", name="손님")
    assert g.post("/api/me/withdraw", json={"confirm": "탈퇴"}).json()["requested"] is False
    assert g.get("/api/me").json()["user"] is None
    assert boss.post(f"/api/staff/{participant_ids[SCHOOL]}", json={"action": "revoke"}).status_code == 200
    assert p1.get("/live/evidence").status_code == 403


def test_participant_school_change_needs_admin_approval(monkeypatch, tmp_path):
    import app.assignments as asg
    monkeypatch.setattr(asg, "FILES_DIR", tmp_path)
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    assert boss.post("/api/admin/schools", json={"text": "A학교\nB학교"}).status_code == 200
    staff = login("school-staff@gmail.com")
    applied = staff_apply(staff, {
        "role": "participant", "name": "담당교사", "hub_name": "A학교",
        "affiliation": "A학교", "contact": "010", "pledge": True,
    })
    assert applied.status_code == 200, applied.text
    membership = boss.get("/api/staff/applications", params={"role": "participant"}).json()["applications"][0]
    mid = membership["id"]
    assert boss.post(f"/api/staff/{mid}", json={"action": "approve"}).status_code == 200
    initial = staff.get("/api/me").json()["user"]
    assert initial["participant_schools"] == ["A학교"]
    assert [hub["name"] for hub in initial["coordinator_hubs"]] == ["A학교"]
    a = login("a-student@s.school.kr", name="A학생", school="A학교", grade=1, class_no=1, number=1)
    b = login("b-student@s.school.kr", name="B학생", school="B학교", grade=1, class_no=1, number=1)
    assert staff.get("/api/school/overview").json()["schools"] == ["A학교"]
    assert staff.get("/api/hub/overview").status_code == 200
    assert staff.get("/live/evidence").status_code == 200
    import json
    import time
    from app.evidence import cipher
    from sqlalchemy import insert
    crypt = cipher()
    with db.engine.begin() as conn:
        for school, archive_id in (("A학교", "a" * 32), ("B학교", "b" * 32)):
            payload = json.dumps({"subject": {"school": school, "name": "가상 학생"}, "files": []}, ensure_ascii=False)
            conn.execute(insert(db.evidence_archives).values(
                id=archive_id, school=school, created_at=time.time(),
                payload=crypt.encrypt(payload.encode()).decode()))
    params = {"purpose": "record_check"}
    assert [x["id"] for x in staff.get("/api/evidence", params=params).json()["archives"]] == ["a" * 32]

    assert staff.post("/api/me/profile", json={"name": "담당교사", "school": "B학교"}).status_code == 400
    changed = staff.post("/api/me/school-transfer", json={"role": "participant", "school": "B학교"})
    assert changed.status_code == 200, changed.text
    me = changed.json()
    assert me["school"] == "A학교"
    assert me["role"] == "teacher" and me["participant_schools"] == []
    assert me["memberships"][0]["transfer_from"] == "A학교"
    assert staff.get("/api/school/overview").status_code == 403
    assert staff.get("/live/evidence").status_code == 403
    assert staff.get("/api/evidence", params=params).status_code == 403
    assert staff.post(f"/api/staff/{mid}", json={"action": "approve", "hub_name": "B학교"}).status_code == 403
    request = boss.get("/api/staff/applications", params={"role": "participant"}).json()["applications"][0]
    assert (request["id"], request["status"], request["transfer_from"], request["hub"]) == (
        mid, "pending", "A학교", "B학교")

    approved = boss.post(f"/api/staff/{mid}", json={"action": "approve", "hub_name": "B학교"})
    assert approved.status_code == 200, approved.text
    after_transfer = staff.get("/api/me").json()["user"]
    assert after_transfer["participant_schools"] == ["B학교"] and after_transfer["school"] == "B학교"
    overview = staff.get("/api/school/overview").json()
    assert overview["schools"] == ["B학교"]
    assert [x["name"] for x in overview["students"]] == ["B학생"]
    assert staff.get("/live/evidence").status_code == 200
    assert [x["id"] for x in staff.get("/api/evidence", params=params).json()["archives"]] == ["b" * 32]
    assert staff.get(f"/api/evidence/{'a' * 32}", params=params).status_code == 404
    assert a.get("/api/school/overview").status_code == 403
    assert b.get("/api/school/overview").status_code == 403
    assert staff.post("/api/me/school-transfer", json={"role": "participant", "school": "A학교"}).status_code == 200
    assert boss.post(f"/api/staff/{mid}", json={"action": "reject", "note": "전근 확인 불가"}).status_code == 200
    assert staff.get("/api/school/overview").status_code == 403
    assert staff.get("/api/evidence", params=params).status_code == 403


def test_student_school_change_needs_new_school_participant_approval(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    assert boss.post("/api/admin/schools", json={"text": "A학교\nB학교\nC학교"}).status_code == 200
    teachers, membership_ids = {}, {}
    for school in ("A학교", "B학교", "C학교"):
        teacher_client = login(f"manager-{school}@gmail.com")
        assert staff_apply(teacher_client, {"role": "participant", "name": "담당교사",
            "hub_name": school, "affiliation": school, "contact": "010", "pledge": True}).status_code == 200
        applications = boss.get("/api/staff/applications", params={"role": "participant"}).json()["applications"]
        mid = next(x["id"] for x in applications if x["hub"] == school)
        assert boss.post(f"/api/staff/{mid}", json={"action": "approve"}).status_code == 200
        teachers[school] = teacher_client
        membership_ids[school] = mid
    student_client = login("move-student@s.school.kr", name="학생", school="A학교",
                           grade=1, class_no=2, number=3)
    assert student_client.post("/api/me/profile", json={"name": "학생", "school": "B학교",
        "grade": 1, "class_no": 2, "number": 3}).status_code == 400
    requested = student_client.post("/api/me/change-requests", json={"field": "school", "value": "B학교"})
    assert requested.status_code == 200, requested.text
    change_id = requested.json()["id"]
    assert student_client.get("/api/me").json()["user"]["school"] == "A학교"
    assert [x["name"] for x in teachers["A학교"].get("/api/school/overview").json()["students"]] == ["학생"]
    assert teachers["B학교"].get("/api/school/overview").json()["students"] == []
    assert teachers["A학교"].get("/api/school/change-requests").json()["requests"] == []
    assert teachers["C학교"].get("/api/school/change-requests").json()["requests"] == []
    pending_changes = teachers["B학교"].get("/api/school/change-requests").json()["requests"]
    assert [(x["id"], x["grade"], x["class_no"]) for x in pending_changes] == [(change_id, 1, 2)]
    assert boss.get("/api/admin/change-requests?field=school").json()["requests"] == []
    assert boss.post(f"/api/admin/change-requests/{change_id}", json={"action": "approve"}).status_code == 403
    assert student_client.post(f"/api/school/change-requests/{change_id}", json={"action": "approve"}).status_code == 403
    assert teachers["A학교"].post(f"/api/school/change-requests/{change_id}", json={"action": "approve"}).status_code == 404
    approved = teachers["B학교"].post(f"/api/school/change-requests/{change_id}", json={"action": "approve"})
    assert approved.status_code == 200, approved.text
    assert student_client.get("/api/me").json()["user"]["school"] == "B학교"
    assert teachers["A학교"].get("/api/school/overview").json()["students"] == []
    assert [x["name"] for x in teachers["B학교"].get("/api/school/overview").json()["students"]] == ["학생"]
    next_request = student_client.post("/api/me/change-requests", json={"field": "school", "value": "C학교"})
    assert next_request.status_code == 200
    next_id = next_request.json()["id"]
    assert boss.post(f"/api/staff/{membership_ids['C학교']}", json={"action": "revoke"}).status_code == 200
    assert teachers["C학교"].post(f"/api/school/change-requests/{next_id}", json={"action": "approve"}).status_code == 403
    assert student_client.get("/api/me").json()["user"]["school"] == "B학교"


def test_admin_can_view_classroom_overview_without_student_enrollment(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    t = teacher()
    course = t.post("/api/courses", json=COURSE)
    assert course.status_code == 200, course.text
    cid = course.json()["id"]
    assert t.post("/api/live/classes", json={"title": "첫 수업", "course_id": cid}).status_code == 200
    assert t.get("/api/admin/classroom").status_code == 403
    assert TestClient(app).get("/api/admin/classroom").status_code == 401
    overview = boss.get("/api/admin/classroom")
    assert overview.status_code == 200, overview.text
    assert [(x["id"], x["title"], [live["title"] for live in x["live"]])
            for x in overview.json()["courses"]] == [(cid, COURSE["title"], ["첫 수업"])]
    page = boss.get("/live?classroom=1").text
    assert 'id="student-view"' in page and 'id="admin-classroom-view"' not in page


def test_admin_student_actions_require_enrollment(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    t = teacher()
    cid = t.post("/api/courses", json=COURSE).json()["id"]
    boss_id = boss.get("/api/me").json()["user"]["id"]
    code = create(t, title="첫 수업", course_id=cid)["code"]
    aid = t.post(f"/api/courses/{cid}/assignments", json={"title": "수업 과제"}).json()["id"]

    assert boss.get("/api/courses/available").status_code == 200
    assert cr.load_roster(cid) == []
    assert boss.get("/api/my/assignments").json()["assignments"] == []
    assert boss.post(f"/api/assignments/{aid}/text", json={"text": "제출"}).status_code == 404
    assert boss.post(f"/api/live/classes/{code}/join?as_student=1").status_code == 403
    with db.engine.connect() as c:
        assert not c.execute(db.attendance.select().where(db.attendance.c.user_id == boss_id)).first()

    assert boss.post(f"/api/courses/{cid}/enroll").json()["status"] == "pending"
    assert cr.load_roster(cid) == []
    assert t.post(f"/api/courses/{cid}/approve-all").json()["approved"] == 1
    assert [int(r["id"]) for r in cr.load_roster(cid)] == [boss_id]
    assert [x["title"] for x in boss.get("/api/my/assignments").json()["assignments"]] == ["수업 과제"]
    assert boss.post(f"/api/assignments/{aid}/text", json={"text": "관리자 제출"}).status_code == 200
    assert boss.get("/api/my/assignments").json()["assignments"][0]["mine"]["text"] == "관리자 제출"
    assert boss.post(f"/api/live/classes/{code}/join?as_student=1").status_code == 200
    with boss.websocket_connect(f"/ws/live/{code}?as_student=1") as ws:
        state(ws)
    with db.engine.connect() as c:
        assert c.execute(db.attendance.select().where(db.attendance.c.user_id == boss_id)).first()


@pytest.mark.parametrize("role", ["participant", "coordinator"])
def test_school_manager_has_one_school_per_role(monkeypatch, role):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    boss.post("/api/admin/schools", json={"text": "A학교\nB학교"})
    staff = login(f"one-{role}@gmail.com")
    def apply_to(school):
        return staff_apply(staff, {"role": role, "name": "담당교사",
                          "hub_name": school, "affiliation": school, "contact": "010", "pledge": True})

    assert apply_to("A학교").status_code == 200
    mid = boss.get("/api/staff/applications", params={"role": role}).json()["applications"][0]["id"]
    assert apply_to("B학교").status_code == 200  # 승인 대기 중에는 같은 신청의 학교를 고칠 수 있다.
    applications = boss.get("/api/staff/applications", params={"role": role}).json()["applications"]
    assert len(applications) == 1 and applications[0]["id"] == mid and applications[0]["hub"] == "B학교"
    assert boss.post(f"/api/staff/{mid}", json={"action": "approve"}).status_code == 200
    assert apply_to("A학교").status_code == 409  # 승인된 상태에서 두 번째 학교 권한을 만들 수 없다.
    assert len(boss.get("/api/staff/applications", params={"role": role}).json()["applications"]) == 1
    assert boss.post(f"/api/staff/{mid}", json={"action": "revoke"}).status_code == 200
    assert apply_to("A학교").status_code == 200
    applications = boss.get("/api/staff/applications", params={"role": role}).json()["applications"]
    assert len(applications) == 1 and applications[0]["id"] == mid and applications[0]["status"] == "pending"


@pytest.mark.parametrize("role", ["participant", "coordinator"])
def test_profile_school_change_button_requests_approval(monkeypatch, role):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    boss.post("/api/admin/schools", json={"text": "A학교\nB학교"})
    staff = login(f"transfer-{role}@gmail.com")
    payload = {"role": role, "name": "담당교사", "hub_name": "A학교",
               "affiliation": "A학교", "contact": "010", "pledge": True}
    assert staff_apply(staff, payload).status_code == 200
    mid = boss.get("/api/staff/applications", params={"role": role}).json()["applications"][0]["id"]
    assert boss.post(f"/api/staff/{mid}", json={"action": "approve"}).status_code == 200
    changed = staff.post("/api/me/school-transfer", json={"role": role, "school": "B학교"})
    assert changed.status_code == 200, changed.text
    me = changed.json()
    assert me["memberships"][0]["status"] == "pending"
    assert me["memberships"][0]["transfer_from"] == "A학교"
    assert not me["participant_schools"] and not me["coordinator_hubs"]
    assert staff.post("/api/me/school-transfer", json={"role": role, "school": "A학교"}).status_code == 400
    pending = boss.get("/api/staff/applications", params={"role": role}).json()["applications"][0]
    assert pending["hub"] == "B학교"
    assert boss.post(f"/api/staff/{mid}", json={"action": "approve"}).status_code == 200
    me = staff.get("/api/me").json()["user"]
    assert me["school"] == "B학교"
    assert me["participant_schools"] == ["B학교"]
    assert [hub["name"] for hub in me["coordinator_hubs"]] == ["B학교"]
    assert staff.get("/api/school/overview").status_code == 200
    assert staff.get("/api/hub/overview").status_code == 200


def test_approved_role_change_replaces_old_access(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    boss.post("/api/admin/schools", json={"text": "A학교\nB학교"})
    staff = login("role-change@gmail.com")
    base = {"name": "담당교사", "affiliation": "A학교", "contact": "010", "pledge": True}
    assert staff_apply(staff, {**base, "role": "participant", "hub_name": "A학교"}).status_code == 200
    old_id = boss.get("/api/staff/applications", params={"role": "participant"}).json()["applications"][0]["id"]
    assert boss.post(f"/api/staff/{old_id}", json={"action": "approve"}).status_code == 200
    assert staff_apply(staff, {**base, "role": "coordinator", "hub_name": "B학교",
                               "affiliation": "B학교"}).status_code == 200
    duplicate = boss.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"][0]
    assert boss.post(f"/api/staff/{duplicate['id']}", json={"action": "approve"}).status_code == 409
    assert staff_apply(staff, {**base, "role": "coordinator", "hub_name": "B학교", "affiliation": "B학교",
                               "replace_membership_id": old_id}).status_code == 200
    pending = boss.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"][0]
    assert pending["replace_membership_id"] == old_id
    pending_me = staff.get("/api/me").json()["user"]
    assert pending_me["participant_schools"] == ["A학교"] and pending_me["school"] == "A학교"
    assert boss.post(f"/api/staff/{pending['id']}", json={"action": "approve"}).status_code == 200
    me = staff.get("/api/me").json()["user"]
    assert me["participant_schools"] == ["B학교"] and me["coordinator_hubs"][0]["name"] == "B학교"
    assert me["school"] == "B학교"
    assert staff.get("/api/school/overview").status_code == 200


def test_teacher_signup_course_fields_and_team_teaching(monkeypatch, tmp_path):
    import app.assignments as asg
    from livekit import api as lk
    monkeypatch.setattr(asg, "FILES_DIR", tmp_path)
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    boss.post("/api/admin/schools", json={"text": "가나고등학교\n다라고등학교"})

    def guest(email):
        g = TestClient(app)
        google_login(g, email)
        return g

    base = {"name": "한선생", "contact": "010-1111-2222", "pledge": True, "affil_type": "school",
            "office": "울산광역시교육청", "affiliation": "가나고등학교", "email": "han@use.go.kr"}
    # 관리교사: 거점학교는 울산 학교 목록에서만, 소속 구분별 필수 칸
    coord = guest("coord@gmail.com")
    assert staff_apply(coord, {**base, "role": "coordinator", "hub_name": "가나고"}).status_code == 400
    assert staff_apply(coord, {**base, "role": "coordinator", "hub_name": "가나고등학교", "office": ""}).status_code == 400
    assert staff_apply(coord, {**base, "role": "coordinator", "hub_name": "가나고등학교", "email": "x"}).status_code == 400
    assert staff_apply(coord, {**base, "role": "coordinator", "hub_name": "가나고등학교",
                               "affiliation": "다라고등학교"}).status_code == 400
    assert staff_apply(coord, {**base, "role": "coordinator", "hub_name": "가나고등학교"}).status_code == 200
    app_ = boss.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"][0]
    assert app_["office"] == "울산광역시교육청" and app_["affil_type"] == "school" and app_["contact_email"] == "han@use.go.kr"
    boss.post(f"/api/staff/{app_['id']}", json={"action": "approve"})
    manager = coord.get("/api/me").json()["user"]
    assert manager["school"] == "가나고등학교"
    assert manager["participant_schools"] == ["가나고등학교"]
    assert manager["teach_hubs"] == [] and manager["lead_hubs"] == []
    hub_id = manager["coordinator_hubs"][0]["id"]
    # 강사: 대학 교원(주강사) / 미임용 교원자격 소지자(팀티칭 보조교사)
    prof = guest("prof@univ.ac.kr")
    pform = {**base, "role": "instructor", "name": "김교수", "affil_type": "univ", "office": "",
             "affiliation": "", "email": "kim@univ.ac.kr", "wish_from": "2026-03-01", "wish_until": "2099-02-28"}
    assert staff_apply(prof, pform).status_code == 400  # 대학 이름 필요
    assert staff_apply(prof, {**pform, "affiliation": "울산대학교"}).status_code == 400  # 학과도 필요
    assert staff_apply(prof, {**pform, "affiliation": "울산대학교", "department": "사회과교육과"}).status_code == 200
    prof_me = prof.get("/api/me").json()["user"]
    assert prof_me["school"] == "울산대학교" and prof_me["memberships"][0]["department"] == "사회과교육과"
    asst = guest("asst@gmail.com")
    aform = {**pform, "name": "이보조", "affil_type": "cert", "email": "lee@gmail.com", "assistant": True}
    assert staff_apply(asst, aform).status_code == 400  # 교원자격 필요
    assert staff_apply(asst, {**aform, "license": "중등학교 2급 정교사(사회)"}).status_code == 200
    for x in boss.get("/api/staff/applications", params={"role": "instructor"}).json()["applications"]:
        assert boss.post(f"/api/staff/{x['id']}", json={"action": "approve", "valid_until": "2099-02-28"}).status_code == 200
    instructor = prof.get("/api/me").json()["user"]
    assert instructor["participant_schools"] == [] and instructor["coordinator_hubs"] == []
    assert instructor["teach_hubs"] == [] and instructor["lead_any"]
    assert prof.get("/api/school/overview").status_code == 403
    assert prof.get("/api/hub/overview").status_code == 403
    ame = asst.get("/api/me").json()["user"]
    assert ame["role"] == "teacher" and ame["lead_hubs"] == [] and ame["memberships"][0]["kind"] == "assistant"
    asst_id = ame["id"]

    # 강좌 개설: 2022 개정 과목을 고르면 교과(군)·교과·과목 구분이 정해지고, 학점 → 시수
    course = {"title": "법과 사회", "instructor": "김교수", "hub_id": hub_id, "start_date": "2026-03-02",
              "end_date": "2099-07-20", "subject_type": "일반선택", "school_year": 2026, "term": "1학기", "credits": 3,
              "achievement": "5", "capacity": 2, "recruit_start": "2026-01-01", "recruit_end": "2099-03-01",
              "exam_ratio": 40, "perf_ratio": 60, "grades": [2, 3], "description": "판례로 배우는 법\n화·목 7교시"}
    assert prof.post("/api/courses", json={**course, "exam_ratio": 50}).status_code == 400  # 합이 100이 아님
    assert prof.post("/api/courses", json={**course, "title": "법과 생활"}).status_code == 400  # 목록에 없음
    assert asst.post("/api/courses", json=course).status_code == 403  # 보조교사는 강좌를 열 수 없음
    r = prof.post("/api/courses", json={**course, "team_teaching": True, "co_teachers": [asst_id]})
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    assert coord.post(f"/api/hub/courses/{cid}/approval", json={"action": "approve"}).status_code == 200
    c = prof.get("/api/courses/mine").json()["courses"][0]
    assert (c["subject_group"], c["subject_area"], c["subject_type"]) == ("사회(역사/도덕 포함)", "사회", "진로선택")
    assert c["credits"] == 3 and c["hours"] == 48 and c["achievement_text"] == "5단계 (A~E)" and c["recruit"] == "open"
    assert c["co_teachers"] == [{"id": asst_id, "name": "이보조"}] and c["lead"]
    # 고시외 과목은 직접 적는다
    r = prof.post("/api/courses", json={**course, "title": "울산 지역사 탐구", "custom_subject": True,
                                        "subject_group": "사회(역사/도덕 포함)", "subject_area": "역사", "subject_type": "융합선택"})
    assert r.status_code == 200, r.text
    assert prof.post(f"/api/courses/{r.json()['id']}", json={"archived": True}).status_code == 200

    # 수업계획서: 강사만 올리고, 누구나 받아 본다 (학생 개인정보 없음)
    assert prof.post(f"/api/courses/{cid}/syllabus?name=a.exe", content=b"MZ").status_code == 415
    assert prof.post(f"/api/courses/{cid}/syllabus?name=수업계획서.pdf", content=b"%PDF-1.4 plan").status_code == 200
    assert TestClient(app).get(f"/api/courses/{cid}/syllabus").content == b"%PDF-1.4 plan"
    cat = TestClient(app).get("/api/courses/catalog").json()["courses"]
    assert [x["title"] for x in cat] == ["법과 사회"] and cat[0]["syllabus"]["name"] == "수업계획서.pdf"

    # 모집: 대상 학년·정원
    s1, s2, s3 = (login(f"st{n}@s.school.kr", name=f"학생{n}", school="가나고등학교", grade=2, class_no=1, number=n, agree=True)
                  for n in (1, 2, 3))
    assert s1.post(f"/api/courses/{cid}/enroll").status_code == 200
    assert s2.post(f"/api/courses/{cid}/enroll").status_code == 200
    r = s3.post(f"/api/courses/{cid}/enroll")
    assert r.status_code == 409 and "2명" in r.json()["detail"]
    prof.post(f"/api/courses/{cid}", json={"recruit_start": "2099-01-01", "recruit_end": "2099-02-01", "capacity": 0})
    r = s3.post(f"/api/courses/{cid}/enroll")
    assert r.status_code == 409 and "모집 기간" in r.json()["detail"]

    # 팀티칭: 보조교사도 강좌·수강생을 보고 수업에 선생님으로 들어간다. 강좌 정보는 주강사만 고친다
    mine = asst.get("/api/courses/mine").json()["courses"]
    assert [x["id"] for x in mine] == [cid] and not mine[0]["lead"] and mine[0]["owner_name"] == "김교수"
    assert len(asst.get(f"/api/courses/{cid}/enrollments").json()["enrollments"]) == 2
    assert asst.post(f"/api/courses/{cid}", json={"title": "정치"}).status_code == 404
    assert asst.post(f"/api/courses/{cid}", json={"open": False}).status_code == 200
    code = prof.post("/api/live/classes", json={"title": "1차시", "course_id": cid}).json()["code"]
    verifier = lk.TokenVerifier(cr.LIVEKIT_API_KEY, cr.LIVEKIT_API_SECRET)
    ids = {verifier.verify(x.post(f"/api/live/classes/{code}/token", json={"room": "main"}).json()["token"]).identity
           for x in (prof, asst)}
    assert ids == {"teacher", f"t-{asst_id}"}
    assert [x["code"] for x in asst.get("/api/live/my-classes").json()["classes"]] == [code]
    with asst.websocket_connect(f"/ws/live/{code}") as ws:
        assert until(ws, lambda m: m["t"] == "hello")["role"] == "teacher"
    # 팀티칭을 끄면 보조교사는 더 이상 이 강좌·수업에 들어가지 못한다
    prof.post(f"/api/courses/{cid}", json={"team_teaching": False})
    assert asst.get("/api/courses/mine").json()["courses"] == []
    assert asst.post(f"/api/live/classes/{code}/token", json={"room": "main"}).status_code == 403
    # 다른 거점학교 강사는 보조교사로 넣을 수 없다
    assert prof.post(f"/api/courses/{cid}", json={"team_teaching": True, "co_teachers": [s1.get("/api/me").json()["user"]["id"]]}).status_code == 400


def test_home_notices_and_banners(monkeypatch, tmp_path):
    import app.assignments as asg
    monkeypatch.setattr(asg, "FILES_DIR", tmp_path)
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss, anyone, t = login("boss@gmail.com", name="관리자"), TestClient(app), teacher()
    assert anyone.get("/live/home").status_code == 200
    # 공지사항: 선생님 누구나 쓰고, 누구나 본다. 학생은 못 쓴다. 고정 공지가 맨 위(고정은 전체 관리자만)
    assert student(9).post("/api/admin/notices", json={"title": "x"}).status_code == 403
    tid = t.post("/api/admin/notices", json={"title": "강사 공지", "pinned": True}).json()["id"]
    a = boss.post("/api/admin/notices", json={"title": "첫 공지", "body": "<b>안녕</b>"}).json()["id"]
    assert t.post("/api/admin/notices", json={"id": a, "title": "남의 공지 고치기"}).status_code == 403
    assert t.post(f"/api/admin/notices/{a}/delete", json={}).status_code == 403
    assert t.post(f"/api/admin/notices/{tid}/delete", json={}).status_code == 200  # 내가 쓴 공지는 지울 수 있다
    boss.post("/api/admin/notices", json={"title": "수강신청 안내", "pinned": True})
    assert [n["title"] for n in anyone.get("/api/notices?limit=5").json()["notices"]] == ["수강신청 안내", "첫 공지"]
    page = anyone.get(f"/live/notices/{a}").text
    assert "&lt;b&gt;안녕" in page and "<b>안녕" not in page  # 글은 그대로(태그로 해석하지 않음)
    boss.post("/api/admin/notices", json={"id": a, "title": "첫 공지(수정)"})
    assert "첫 공지(수정)" in anyone.get("/live/notices").text
    boss.post(f"/api/admin/notices/{a}/delete", json={})
    assert anyone.get(f"/live/notices/{a}").status_code == 404
    # 배너: 비면 기본 배너. 그림을 올려 배경으로 쓸 수 있다
    assert anyone.get("/api/banners").json()["banners"] == []
    assert boss.post("/api/admin/banners/image?name=x.svg", content=b"<svg/>").status_code == 415
    img = boss.post("/api/admin/banners/image?name=ad.png", content=b"\x89PNG fake").json()["image"]
    assert anyone.get(f"/api/banners/image/{img}").headers["content-type"] == "image/png"
    assert boss.post("/api/admin/banners", json={"banners": [{"title": "a", "link": "javascript:alert(1)"}]}).status_code == 400
    r = boss.post("/api/admin/banners", json={"banners": [{"title": "여름학기 신청", "link": "/live/courses", "theme": "red"},
                                                          {"image": img}, {"text": "제목도 그림도 없음"}]})
    saved = r.json()["banners"]
    assert [b["title"] for b in saved] == ["여름학기 신청", ""] and saved[0]["theme"] == "green" and saved[1]["image"] == img
    assert t.post("/api/admin/banners", json={"banners": []}).status_code == 403  # 전체 운영 관리자만 편집한다
    assert boss.post("/api/admin/banners", json={"banners": []}).status_code == 200
    assert student(8).post("/api/admin/banners", json={"banners": []}).status_code == 403


def test_pages_are_revalidated():
    c = TestClient(app)
    assert c.get("/static/live/live.css").headers["cache-control"] == "no-cache"
    assert c.get("/live").headers["cache-control"] == "no-cache"
    assert "max-age" in c.get("/static/live/fonts/jua-subset.woff2").headers["cache-control"]


def test_community_allows_anonymous_posts_and_admin_moderation(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    visitor = TestClient(app)
    assert visitor.get("/live/sitemap").status_code == 200
    assert visitor.get("/live/course-requests").status_code == 200
    assert "글쓰기" in visitor.get("/live/community").text
    posted = visitor.post("/api/community", json={
        "title": "<img src=x>", "body": "<script>alert(1)</script>", "nickname": "<b>손님</b>",
    })
    assert posted.status_code == 200, posted.text
    pid = posted.json()["id"]
    detail = visitor.get(f"/live/community/{pid}").text
    assert "&lt;img src=x&gt;" in detail and "<img src=x>" not in detail
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in detail
    assert "<b>손님</b>" not in visitor.get("/live/community").text
    assert visitor.post(f"/api/admin/community/{pid}/delete", json={}).status_code == 401
    boss = login("boss@gmail.com", name="관리자")
    assert boss.post(f"/api/admin/community/{pid}/delete", json={}).status_code == 200
    assert visitor.get(f"/live/community/{pid}").status_code == 404
    learner = student(1)
    own = learner.post("/api/community", json={"title": "의견", "body": "내용", "nickname": "별"})
    assert own.status_code == 200
    detail = visitor.get(f"/live/community/{own.json()['id']}").text
    assert "회원 · 별" in detail and "학생1" not in detail


def test_course_requests_and_info_pages(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss, t = login("boss@gmail.com", name="관리자"), teacher()
    a, b = student(1, grade=1), student(2, grade=2)
    def wish(client, subject, note=""):
        return client.post("/api/course-requests", json={
            "school_year": 2026, "term": "2학기", "subject": subject, "note": note})

    assert wish(a, "인공지능  기초", "코딩을 배우고 싶어요").status_code == 200
    assert wish(a, "인공지능 기초").status_code == 409  # 같은 학기·과목은 한 번
    assert wish(b, "인공지능 기초").status_code == 200
    assert wish(b, "울산의 역사", "연락처 010-1234-5678, 학번 12345").status_code == 200
    for n in range(4):
        assert wish(a, f"과목{n}").status_code == 200
    assert wish(a, "과목9").status_code == 409  # 학기당 5개까지
    assert wish(t, "x").status_code == 403  # 학생·전체 관리자만
    assert t.get("/api/hub/course-requests").status_code == 403  # 관리교사·전체 관리자만
    reqs = boss.get("/api/hub/course-requests").json()["requests"]
    top = reqs[0]
    assert top["subject"] == "인공지능 기초" and top["count"] == 2 and top["grades"] == {"1": 1, "2": 1}
    assert top["in_curriculum"] and top["notes"] == ["코딩을 배우고 싶어요"] and "name" not in top
    assert not next(r for r in reqs if r["subject"] == "울산의 역사")["in_curriculum"]
    # 메인 화면: 누구나 본다 (과목·요청 수·학년만 — 학교·하고 싶은 말은 빠짐)
    pub = TestClient(app).get("/api/course-requests/summary").json()["requests"]
    assert pub[0] == {"subject": "인공지능 기초", "subject_area": "정보", "count": 2, "likes": 0,
                      "grades": {"1": 1, "2": 1}, "in_curriculum": True}
    assert "외솔" not in str(pub) and "home-wishes" in TestClient(app).get("/live/home").text
    board = TestClient(app).get("/api/course-requests/board").json()["requests"]
    assert "010-1234-5678" not in str(board) and "12345" not in str(board)
    requested = next(r for r in board if r["subject"] == "인공지능 기초" and r["note"])
    assert requested["school_year"] == 2026 and requested["term"] == "2학기"
    assert requested["note"] == "코딩을 배우고 싶어요" and requested["likes"] == 0
    assert "user_id" not in requested and "email" not in requested
    assert TestClient(app).post(f"/api/course-requests/{requested['id']}/like").status_code == 401
    assert b.post(f"/api/course-requests/{requested['id']}/like").json() == {"likes": 1, "liked": True}
    summary = TestClient(app).get("/api/course-requests/summary").json()["requests"]
    assert summary[0]["count"] == 3 and summary[0]["likes"] == 1
    assert summary[0]["grades"] == {"1": 1, "2": 1}
    assert next(r for r in boss.get("/api/hub/course-requests").json()["requests"]
                if r["subject"] == "인공지능 기초")["count"] == 2
    assert b.get("/api/course-requests/board").json()["requests"][-1]["liked"] is True
    second = next(r for r in board if r["subject"] == "인공지능 기초" and not r["note"])
    assert a.post(f"/api/course-requests/{second['id']}/like").json() == {"likes": 1, "liked": True}
    assert TestClient(app).get("/api/course-requests/summary").json()["requests"][0]["count"] == 4
    assert a.post(f"/api/course-requests/{second['id']}/like").json() == {"likes": 0, "liked": False}
    assert b.post(f"/api/course-requests/{requested['id']}/like").json() == {"likes": 0, "liked": False}
    assert TestClient(app).get("/api/course-requests/summary").json()["requests"][0]["count"] == 2
    assert wish(b, "사회와 문화").status_code == 200
    assert wish(b, "물리학").status_code == 200
    areas = {r["subject"]: r["subject_area"] for r in TestClient(app).get(
        "/api/course-requests/summary").json()["requests"]}
    assert areas["사회와 문화"] == "사회" and areas["물리학"] == "과학"
    mine = a.get("/api/my/course-requests").json()["requests"]
    assert a.post(f"/api/course-requests/{mine[0]['id']}/delete").status_code == 403
    assert len(a.get("/api/my/course-requests").json()["requests"]) == 5
    assert wish(boss, "관리자 희망 과목").status_code == 200
    admin_request = boss.get("/api/my/course-requests").json()["requests"][0]
    assert admin_request["subject"] == "관리자 희망 과목"
    assert boss.post(f"/api/course-requests/{admin_request['id']}/delete").status_code == 403
    assert "신청서 작성" in TestClient(app).get("/live/course-requests").text
    c = TestClient(app)
    for page in ("/live/about", "/live/credit", "/live/guide"):
        assert c.get(page).status_code == 200
    assert "192" in c.get("/live/credit").text and "시스템 특징" in c.get("/live/about").text


def test_student_sees_why_cannot_enter():
    t = teacher()
    cid = t.post("/api/courses", json=COURSE).json()["id"]
    a = student(1)
    a.post(f"/api/courses/{cid}/enroll")  # 신청만 함 (승인 전)
    code = t.post("/api/live/classes", json={"title": "1차시", "course_id": cid}).json()["code"]
    now = a.get("/api/courses/live-now").json()
    assert now["classes"] == [] and now["waiting"] == [{"title": "1차시", "course_title": "강좌", "status": "pending"}]
    assert "code" not in now["waiting"][0]  # 확정 전에는 코드를 알려 주지 않는다
    r = a.post(f"/api/live/classes/{code}/join")
    assert r.status_code == 403 and "확정" in r.json()["detail"]
    uid = a.get("/api/me").json()["user"]["id"]
    t.post(f"/api/courses/{cid}/enrollments/{uid}", json={"status": "approved"})
    now = a.get("/api/courses/live-now").json()
    assert [c["code"] for c in now["classes"]] == [code] and now["waiting"] == []
    # 끝난 수업 코드 / 없는 코드는 서로 다르게 알려 준다
    with t.websocket_connect(f"/ws/live/{code}") as tw:
        state(tw)
        tw.send_json({"t": "end_class"})
        until(tw, lambda m: m["t"] == "ended")
    assert "끝난 수업" in a.post(f"/api/live/classes/{code}/join").json()["detail"]
    assert "코드를 다시" in a.post("/api/live/classes/ZZZZZZ/join").json()["detail"]


def test_roles_are_separate_and_one_step_enrollment(monkeypatch):
    """거점학교 관리교사는 강의하려면 강사로도 등록해야 한다. 수강신청은 강사 승인 한 번으로 확정."""
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    coord = TestClient(app)
    google_login(coord, "coord@gmail.com")
    staff_apply(coord, {"role": "coordinator", "name": "한관리", "hub_name": "가나고등학교", "contact": "010", "pledge": True})
    mid = boss.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"][0]["id"]
    boss.post(f"/api/staff/{mid}", json={"action": "approve"})
    me = coord.get("/api/me").json()["user"]
    hub_id = me["coordinator_hubs"][0]["id"]
    assert me["lead_hubs"] == [] and me["teach_hubs"] == []
    assert coord.post("/api/courses", json={**COURSE, "hub_id": hub_id}).status_code == 403
    # 참여학교 담당교사 신청은 전체 관리자만 승인한다 (거점학교 관리교사는 못 함)
    p = TestClient(app)
    google_login(p, "p@gmail.com")
    assert staff_apply(p, {"role": "participant", "name": "참여", "hub_name": SCHOOL, "contact": "010", "pledge": True}).status_code == 200
    assert coord.get("/api/staff/applications", params={"role": "participant"}).status_code == 403
    pid = boss.get("/api/staff/applications", params={"role": "participant"}).json()["applications"][0]["id"]
    assert coord.post(f"/api/staff/{pid}", json={"action": "approve"}).status_code == 403
    assert boss.post(f"/api/staff/{pid}", json={"action": "approve"}).status_code == 200
    legacy_manager = p.get("/api/me").json()["user"]
    assert legacy_manager["participant_schools"] == [SCHOOL]
    assert [hub["name"] for hub in legacy_manager["coordinator_hubs"]] == [SCHOOL]
    assert p.get("/api/hub/overview").status_code == 200
    # 전체 관리자가 연 강좌는 바로 개설 승인, 강사 승인 한 번이면 수강 확정
    cid = boss.post("/api/courses", json={**COURSE, "title": "정치", "hub_id": hub_id}).json()["id"]
    a, b = student(1), student(2)
    for s in (a, b):
        s.post(f"/api/courses/{cid}/enroll")
    uid = a.get("/api/me").json()["user"]["id"]
    boss.post(f"/api/courses/{cid}/enrollments/{uid}", json={"status": "approved"})
    assert [c["status"] for c in a.get("/api/courses/available").json()["courses"]] == ["approved"]
    boss.post(f"/api/courses/{cid}/approve-all")
    assert [c["status"] for c in b.get("/api/courses/available").json()["courses"]] == ["approved"]


def test_instructor_applies_to_any_ulsan_school(monkeypatch):
    """강의교사는 가입 때 거점학교를 고르지 않는다. 과목을 열 때 울산 고등학교 목록에서 고른다"""
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    boss.post("/api/admin/schools", json={"text": "신정고등학교\n울산고등학교"})
    prof = TestClient(app)
    google_login(prof, "prof@univ.ac.kr")
    form = {"role": "instructor", "name": "김교수", "contact": "010", "pledge": True,
            "wish_from": "2026-03-01", "wish_until": "2099-02-28"}
    assert staff_apply(prof, form).status_code == 200
    app_ = boss.get("/api/staff/applications", params={"role": "instructor"}).json()["applications"][0]
    assert app_["hub_id"] is None
    boss.post(f"/api/staff/{app_['id']}", json={"action": "approve", "valid_until": "2099-02-28"})
    me = prof.get("/api/me").json()["user"]
    assert me["lead_hubs"] == [] and me["lead_any"]
    assert prof.post("/api/courses", json={**COURSE, "hub_school": "아무고"}).status_code == 400  # 목록에 없는 학교
    cid = prof.post("/api/courses", json={**COURSE, "hub_school": "울산고등학교"}).json()["id"]
    cid2 = prof.post("/api/courses", json={**COURSE, "title": "경제", "hub_school": "신정고등학교"}).json()["id"]
    ov = {c["id"]: c["hub_school"] for c in boss.get("/api/hub/overview").json()["courses"]}
    assert ov[cid] == "울산고등학교" and ov[cid2] == "신정고등학교"


def test_course_sessions_joined_schools_and_recruit_time(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    boss.post("/api/admin/schools", json={"text": "신정고등학교\nX고등학교\nY고등학교"})
    body = {**COURSE, "title": "판례로 배우는 법과 사회", "subject": "법과 사회", "subject_type": "진로선택", "hub_school": "신정고등학교",
            "schools": ["X고등학교", "없는고"], "class_days": [2, 4], "class_start": "16:00", "class_end": "17:40",
            "sessions": [{"date": "2026-03-05", "start": "16:00", "end": "17:40"},
                         {"date": "2026-03-03", "start": "16:00", "end": "17:40", "topic": "오리엔테이션"}],
            "contact_email": "koo@use.go.kr", "show_email": True, "contact_phone": "010-1", "show_phone": False}
    assert boss.post("/api/courses", json=body).status_code == 400  # 목록에 없는 참여 학교
    cid = boss.post("/api/courses", json={**body, "schools": ["X고등학교"]}).json()["id"]
    c = boss.get("/api/courses/mine").json()["courses"][0]
    assert c["subject"] == "법과 사회" and c["subject_area"] == "사회" and c["title"] == "판례로 배우는 법과 사회"
    assert [(x["no"], x["date"], x["topic"]) for x in c["sessions"]] == [(1, "2026-03-03", "오리엔테이션"), (2, "2026-03-05", "2회차")]
    cat = TestClient(app).get("/api/courses/catalog").json()["courses"][0]
    assert cat["contact_email"] == "koo@use.go.kr" and cat["contact_phone"] == "" and len(cat["sessions"]) == 2  # 비공개 연락처는 안 보임
    # 참여 학교(+ 거점학교) 학생만 신청
    x = login("x@s.school.kr", name="엑스", school="X고등학교", grade=2, class_no=1, number=1, agree=True)
    y = login("y@s.school.kr", name="와이", school="Y고등학교", grade=2, class_no=1, number=1, agree=True)
    h = login("h@s.school.kr", name="거점", school="신정고등학교", grade=2, class_no=1, number=1, agree=True)
    assert x.post(f"/api/courses/{cid}/enroll").status_code == 200
    assert h.post(f"/api/courses/{cid}/enroll").status_code == 200
    r = y.post(f"/api/courses/{cid}/enroll")
    assert r.status_code == 409 and "참여 학교" in r.json()["detail"]
    # 회차 고치기, 모집 마감 시각이 지나면 마감
    boss.post(f"/api/courses/{cid}", json={"sessions": [{"date": "2026-03-10"}]})
    assert len(boss.get("/api/courses/mine").json()["courses"][0]["sessions"]) == 1
    boss.post(f"/api/courses/{cid}", json={"recruit_start": "2026-01-01", "recruit_end": "2026-01-02", "recruit_end_time": "18:00",
                                           "schools": []})
    assert y.post(f"/api/courses/{cid}/enroll").status_code == 409


def test_ai_assistant_uses_cheapest_model(monkeypatch):
    """AI 조교는 가장 저렴한 모델(Haiku)을 쓰고, Haiku 가 지원하지 않는 거절 대비 옵션은 보내지 않는다"""
    import app.main as main
    seen = {}

    class FakeStream:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        @property
        def text_stream(self):
            async def gen():
                yield "안녕"
            return gen()

        async def get_final_message(self):
            return type("M", (), {"stop_reason": "end_turn"})()

    def fake_stream(**kw):
        seen.update(kw)
        return FakeStream()

    monkeypatch.setattr(main.client.beta.messages, "stream", fake_stream)
    student(1)
    r = TestClient(app).post("/api/chat", json={"messages": [{"role": "user", "content":
        "학생1의 학번은 20301이고 이름은 김민준이에요. 연락처 010-1234-5678, 이메일 a@school.kr. 선거구가 뭐예요?"}]})
    assert r.status_code == 200 and "안녕" in r.text
    sent = seen["messages"][0]["content"]
    assert all(v not in sent for v in ("학생1", "20301", "김민준", "010-1234-5678", "a@school.kr"))
    assert seen["model"] == "claude-haiku-5-5" and "fallbacks" not in seen and "betas" not in seen


def test_student_signup_rejects_under_fourteen_and_school_mismatch():
    fresh = TestClient(app)
    denied = fresh.post("/api/auth/google", json={"credential": "test-token:under14@s.school.kr",
                                                  "birth": "2015-01-01"})
    assert denied.status_code == 403
    with db.engine.connect() as conn:
        assert conn.execute(db.users.select().where(db.users.c.email == "under14@s.school.kr")).first() is None
    c = login("young@s.school.kr")
    assert c.post("/api/me/consent", json={"terms": True, "privacy": True,
                                      "birth": "2015-01-01"}).status_code == 403
    profile = {"name": "학생", "school": "신선여자고등학교", "grade": 1, "class_no": 1,
               "number": 1, "birth": "2015-01-01", "gender": "여", "agree": True}
    assert c.post("/api/me/profile", json=profile).status_code == 403
    profile["birth"] = "2008-04-03"
    profile["gender"] = "남"
    assert c.post("/api/me/profile", json=profile).status_code == 400
    profile["gender"] = "여"
    assert c.post("/api/me/profile", json=profile).status_code == 200
    guest = login("young-staff@gmail.com")
    assert staff_apply(guest, {"role": "participant", "name": "신청자", "hub_name": "신정고등학교",
                               "contact": "010", "pledge": True, "birth": "2015-01-01"}).status_code == 403


def test_evidence_retention_never_exceeds_one_year(monkeypatch):
    from app.evidence import retention_policy
    monkeypatch.delenv("EVIDENCE_RETENTION_DAYS", raising=False)
    assert retention_policy()[0] == 365
    monkeypatch.setenv("EVIDENCE_RETENTION_DAYS", "3000")
    assert retention_policy()[0] == 365
    monkeypatch.setenv("EVIDENCE_RETENTION_DAYS", "90")
    assert retention_policy()[0] == 90


def test_wipe_overwrites_then_deletes(tmp_path):
    from app.wipe import wipe
    f = tmp_path / "a.bin"
    f.write_bytes(b"secret" * 1000)
    seen = []
    real_unlink = type(f).unlink

    def check(self, missing_ok=False):
        seen.append(self.read_bytes())
        real_unlink(self, missing_ok=missing_ok)

    import pathlib
    pathlib.Path.unlink, old = check, pathlib.Path.unlink
    try:
        wipe(f)
    finally:
        pathlib.Path.unlink = old
    assert seen == [bytes(6000)] and not f.exists()  # 지우기 직전 내용은 모두 0
    wipe(tmp_path / "없는파일")  # 없으면 조용히 넘어간다


def test_private_chat_layout_and_roster():
    t = teacher()
    cid = t.post("/api/courses", json=COURSE).json()["id"]
    a, b, c = student(1), student(2), student(3)
    for s in (a, b, c):
        s.post(f"/api/courses/{cid}/enroll")
    t.post(f"/api/courses/{cid}/approve-all")
    code = t.post("/api/live/classes", json={"title": "1차시", "course_id": cid}).json()["code"]
    for s in (a, b):
        assert s.post(f"/api/live/classes/{code}/join").status_code == 200
    with t.websocket_connect(f"/ws/live/{code}") as tw, a.websocket_connect(f"/ws/live/{code}") as sa, \
            b.websocket_connect(f"/ws/live/{code}") as sb:
        # 수강생 명단: 안 들어온 학생(20303)도 보인다
        st = state(tw, lambda m: sum(x["online"] for x in m["students"]) == 2)
        rows = {x["name"].split()[0]: x for x in st["students"]}
        assert rows["20303"]["absent"] and not rows["20303"]["online"] and rows["20301"]["online"]
        sid_a = state(sa)["me"]["id"]
        sid_b = state(sb)["me"]["id"]
        # 학생 → 선생님 1:1: 선생님과 보낸 학생에게만
        sa.send_json({"t": "chat", "text": "선생님 질문 있어요", "to": "teacher"})
        msg = until(tw, lambda m: m["t"] == "chat")["msg"]
        assert msg["scope"] == f"dm:{sid_a}" and msg["private"]
        assert until(sa, lambda m: m["t"] == "chat")["msg"]["text"] == "선생님 질문 있어요"
        # 선생님 1:1 답장 → 그 학생에게만
        tw.send_json({"t": "chat", "text": "말해 보세요", "scope": f"dm:{sid_a}"})
        assert until(sa, lambda m: m["t"] == "chat")["msg"]["text"] == "말해 보세요"
        # 전체 채팅은 모두에게, b 는 1:1 메시지를 받지 않았다
        sb.send_json({"t": "chat", "text": "안녕"})
        got = until(sb, lambda m: m["t"] == "chat")["msg"]
        assert got["text"] == "안녕"  # b 가 받은 첫 채팅이 자기 전체 채팅 (1:1 은 안 옴)
        # 화면 구성: 토론(학생 둘)
        tw.send_json({"t": "layout", "mode": "debate", "pair": [sid_a, sid_b, "999"]})
        lay = state(sa, lambda m: m["layout"]["mode"] == "debate")["layout"]
        assert [x["identity"] for x in lay["pair"]] == [f"s-{sid_a}", f"s-{sid_b}"]
        tw.send_json({"t": "layout", "mode": "grid"})
        assert state(sb, lambda m: m["layout"]["mode"] == "grid")["layout"]["pair"] == []


def test_course_hub_can_be_changed_to_listed_school(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    boss.post("/api/admin/schools", json={"text": "신정고등학교\n울산고등학교"})
    cid = boss.post("/api/courses", json={**COURSE, "hub_school": "신정고등학교"}).json()["id"]
    assert boss.post(f"/api/courses/{cid}", json={"hub_school": "아무고"}).status_code == 400  # 목록에 없는 이름
    assert boss.post(f"/api/courses/{cid}", json={"hub_school": "울산고등학교"}).status_code == 200
    c = boss.get("/api/courses/mine").json()["courses"][0]
    assert c["hub_school"] == "울산고등학교" and c["hub_id"]


def test_ulsan_school_list_is_built_in(monkeypatch):
    monkeypatch.setattr(auth, "ULSAN_SCHOOLS", ["신정고등학교", "울산고등학교"])
    schools = TestClient(app).get("/api/me").json()["schools"]
    assert schools == ["신정고등학교", "울산고등학교"]
    st = login("st1@s.school.kr")
    st.post("/api/me/self-role", json={"role": "student"})
    assert st.post("/api/me/profile", json={"name": "학생", "school": "없는고등학교", "grade": 1, "class_no": 1, "number": 1,
                                            "agree": True}).status_code == 400
    assert st.post("/api/me/profile", json={"name": "학생", "school": "신정고등학교", "grade": 1, "class_no": 1, "number": 1,
                                            "birth": "2008-04-03", "gender": "남", "agree": True}).status_code == 200


def test_policy_version_fits_database_column():
    from app.policy import POLICY_VERSION

    assert db.users.c.terms_version.type.length >= len(POLICY_VERSION)


def test_signup_starts_with_two_required_consents():
    """회원가입 첫 단계: 학생·선생님 모두 이용약관과 개인정보 수집·이용에 동의해야 다음으로"""
    texts = TestClient(app).get("/api/consent").json()
    assert "이용약관" not in texts["privacy"] and "수집·이용 목적" in texts["privacy"] and "거부할 권리" in texts["privacy"]
    assert "제1조" in texts["terms"]
    for email in ("st1@s.school.kr", "guest@gmail.com"):
        c = login(email)
        assert c.get("/api/me").json()["user"]["needs_terms"]
        assert c.post("/api/me/consent", json={"terms": True}).status_code == 400  # 하나만은 안 됨
        assert c.post("/api/me/consent", json={"terms": True, "privacy": False}).status_code == 400
        me = c.post("/api/me/consent", json={"terms": True, "privacy": True,
                                              "birth": "2008-04-03" if email.endswith("@s.school.kr") else ""}).json()
        assert me["needs_terms"] is False
    # 동의한 뒤에는 정보 입력에 동의 칸이 필요 없다
    st = login("st1@s.school.kr")
    st.post("/api/me/self-role", json={"role": "student"})
    assert st.post("/api/me/profile", json={"name": "학생", "school": SCHOOL, "grade": 1, "class_no": 1, "number": 1,
                                            "birth": "2008-04-03", "gender": "남"}).status_code == 200
    assert TestClient(app).post("/api/me/consent", json={"terms": True, "privacy": True}).status_code == 401


def test_media_share_and_stickers(monkeypatch, tmp_path):
    monkeypatch.setattr(cr, "SLIDES_DIR", tmp_path)
    t = teacher()
    code = create(t)["code"]
    a = student(1)
    a.post(f"/api/live/classes/{code}/join")
    # 동영상 올리기: 동영상·음악만, 학생은 못 올림
    assert t.post(f"/api/live/classes/{code}/media?name=a.exe", content=b"x").status_code == 415
    assert a.post(f"/api/live/classes/{code}/media?name=a.mp4", content=b"x").status_code == 403
    r = t.post(f"/api/live/classes/{code}/media?name=수업영상.mp4", content=b"\x00\x00\x00\x18ftypmp42" + b"0" * 2000)
    assert r.status_code == 200, r.text
    fid = r.json()["id"]
    # 들어온 학생은 구간 요청으로 받아 볼 수 있다
    part = a.get(f"/api/live/classes/{code}/media/{fid}", headers={"Range": "bytes=0-9"})
    assert part.status_code == 206 and len(part.content) == 10
    assert login("st9@s.school.kr", name="학생9", school=SCHOOL, grade=1, class_no=1, number=9).get(
        f"/api/live/classes/{code}/media/{fid}").status_code == 403
    with t.websocket_connect(f"/ws/live/{code}") as tw, a.websocket_connect(f"/ws/live/{code}") as sw:
        state(tw)
        tw.send_json({"t": "media_open", "kind": "youtube", "src": "not-an-id"})  # 잘못된 유튜브 id는 무시
        tw.send_json({"t": "media_open", "kind": "file", "src": fid})
        st = state(sw, lambda m: m.get("media"))
        assert st["media"]["title"] == "수업영상.mp4" and st["media"]["playing"] is False
        tw.send_json({"t": "media_ctrl", "playing": True, "pos": 12.5})
        st = state(sw, lambda m: m["media"] and m["media"]["playing"])
        assert st["media"]["pos"] == 12.5
        tw.send_json({"t": "media_open", "kind": "youtube", "src": "dQw4w9WgXcQ"})
        assert state(sw, lambda m: m["media"] and m["media"]["kind"] == "youtube")["media"]["src"] == "dQw4w9WgXcQ"
        # 스티커: 한 학생에게 → 모두의 화면에 뜨고, 받은 수가 쌓인다
        sid = state(tw, lambda m: m["students"] and m["students"][0]["online"])["students"][0]["id"]
        tw.send_json({"t": "sticker", "s": "⭐", "target": sid})
        fx = until(sw, lambda m: m["t"] == "sticker")
        assert fx["target"] == sid and fx["label"] == "칭찬" and fx["name"] == "20301 학생1"
        tw.send_json({"t": "sticker", "s": "💩"})  # 정해진 스티커만
        tw.send_json({"t": "sticker", "s": "👏"})  # 모두에게
        assert until(sw, lambda m: m["t"] == "sticker")["target"] is None
        assert state(tw, lambda m: m["students"][0]["stickers"] == 1)
        sw.send_json({"t": "sticker", "s": "⭐"})  # 학생은 못 보냄
        tw.send_json({"t": "media_close"})
        assert state(sw, lambda m: m["media"] is None)
        tw.send_json({"t": "end_class"})
        until(tw, lambda m: m["t"] == "ended")
    assert not list((tmp_path).rglob("*.mp4"))  # 수업이 끝나면 올린 미디어는 지운다


def test_teacher_signup_birth(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    g = TestClient(app)
    google_login(g, "t@gmail.com")
    form = {"role": "coordinator", "hub_name": "가나고등학교", "name": "한선생", "contact": "010", "pledge": True}
    assert staff_apply(g, {**form, "birth": "1985-13-01"}).status_code == 400
    assert staff_apply(g, {**form, "birth": "2999-01-01"}).status_code == 400
    assert staff_apply(g, {**form, "birth": "1985-03-07"}).status_code == 200
    assert g.get("/api/me").json()["user"]["birth"] == "1985-03-07"
    app_ = boss.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"][0]
    assert app_["birth"] == "1985-03-07"


def test_learning_overview(monkeypatch, tmp_path):
    """학습 관리: 수업 참석률·공지·설문·퀴즈 횟수와 참여율, 활동 = 평가 활동(과제) 제출률"""
    import app.assignments as asg
    monkeypatch.setattr(asg, "FILES_DIR", tmp_path)
    t = teacher()
    cid = t.post("/api/courses", json=COURSE).json()["id"]
    a, b, c = student(1), student(2), student(3)
    for s in (a, b, c):
        s.post(f"/api/courses/{cid}/enroll")
    t.post(f"/api/courses/{cid}/approve-all")
    t.post(f"/api/courses/{cid}/notices", json={"title": "첫 수업 안내", "body": "교과서"})
    code = create(t, title="1차시 헌법", course_id=cid)["code"]
    with t.websocket_connect(f"/ws/live/{code}") as tw, a.websocket_connect(f"/ws/live/{code}") as sa, \
         b.websocket_connect(f"/ws/live/{code}") as sb:
        state(tw, lambda m: sum(x["online"] for x in m["students"]) == 2)
        tw.send_json({"t": "announce", "text": "5분 뒤 퀴즈"})
        for kind, extra in (("choice", {"options": ["가", "나"], "correct": 0}), ("poll", {"options": ["좋아요", "싫어요"]})):
            tw.send_json({"t": "activity_start", "kind": kind, "prompt": f"{kind} 문제", **extra})
            act = state(sa, lambda m: m["activity"] and m["activity"]["prompt"] == f"{kind} 문제")["activity"]
            sa.send_json({"t": "answer", "id": act["id"], "value": 0})
            state(tw, lambda m: m["activity"] and m["activity"]["total"] == 1)
            tw.send_json({"t": "activity_clear"})
            state(sa, lambda m: m["activity"] is None)
        tw.send_json({"t": "end_class"})
        until(tw, lambda m: m["t"] == "ended")
    time.sleep(0.3)
    aid = t.post(f"/api/courses/{cid}/assignments", json={"title": "보고서"}).json()["id"]
    a.post(f"/api/assignments/{aid}/files?name=r.pdf", content=b"%PDF a", headers={"Content-Type": "application/pdf"})
    r = t.get(f"/api/courses/{cid}/learning").json()
    assert r["summary"]["activity"] == {"count": 1, "graded": 0, "rate": 33}
    assert [(x["title"], x["submitted"]) for x in r["assignments"]] == [("보고서", 1)]
    s = r["summary"]
    assert s["classes"] == 1 and s["enrolled"] == 3 and s["attendance"] == 67  # 3명 중 2명
    assert s["notices"] == 2 and s["class_notices"] == 1 and s["course_notices"] == 1
    assert s["quiz"] == {"count": 1, "classes": 1, "rate": 50} and s["survey"]["count"] == 1
    cl = r["classes"][0]
    assert cl["title"] == "1차시 헌법" and cl["attended"] == 2 and cl["rate"] == 67 and cl["notices"][0]["text"] == "5분 뒤 퀴즈"
    assert a.get(f"/api/courses/{cid}/learning").status_code == 403


def test_name_is_locked_and_teacher_profile(monkeypatch):
    """가입 때 적은 실명은 바꿀 수 없다 (전체 관리자만). 선생님 내 정보: 생년월일·성별·이메일·연락처"""
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    s = student(1)
    me = s.get("/api/me").json()["user"]
    assert me["name_locked"] is True
    r = s.post("/api/me/profile", json={"name": "다른이름", "school": SCHOOL, "grade": 2, "class_no": 3, "number": 1})
    assert r.status_code == 400 and "승인" in r.json()["detail"]
    assert s.post("/api/me/profile", json={"name": "학생1", "school": SCHOOL, "grade": 3, "class_no": 3, "number": 1}).status_code == 200
    # 선생님: 등록 신청 때 이름이 정해지고, 내 정보에서 나머지를 고친다 (신청서 연락처도 함께)
    g = TestClient(app)
    google_login(g, "t@gmail.com")
    form = {"role": "coordinator", "hub_name": "가나고등학교", "name": "한선생", "contact": "010-1", "pledge": True, "gender": "여", "birth": "1980-01-02"}
    assert staff_apply(g, form).status_code == 200
    assert staff_apply(g, {**form, "name": "한바꿈"}).status_code == 400
    assert staff_apply(g, {**form, "gender": "남"}).status_code == 400
    boss = login("boss@gmail.com", name="관리자")
    mid = boss.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"][0]["id"]
    boss.post(f"/api/staff/{mid}", json={"action": "approve"})
    r = g.post("/api/me/profile", json={"name": "한선생", "school": g.get("/api/me").json()["user"]["school"], "birth": "1980-01-03", "gender": "여",
                                        "email": "han@use.go.kr", "phone": "010-9999-0000"})
    assert r.status_code == 200, r.text
    me = r.json()
    assert (me["birth"], me["gender"], me["contact_email"], me["phone"]) == ("1980-01-03", "여", "han@use.go.kr", "010-9999-0000")
    assert g.post("/api/me/profile", json={"name": "한선생", "school": me["school"], "gender": "남"}).status_code == 400
    assert g.get("/api/me").json()["user"]["gender"] == "여"
    app_ = boss.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"][0]
    assert (app_["contact"], app_["contact_email"], app_["gender"]) == ("010-9999-0000", "han@use.go.kr", "여")
    # 전체 관리자는 자기 이름을 즉시 수정하고, 다른 회원은 변경 신청 후 승인을 받는다.
    changed_boss = boss.post("/api/me/profile", json={"name": "새관리자", "school": ""})
    assert changed_boss.status_code == 200 and changed_boss.json()["name"] == "새관리자"
    requested = s.post("/api/me/change-requests", json={"field": "name", "value": "새학생이름"})
    assert requested.status_code == 200
    change_id = requested.json()["id"]
    assert s.get("/api/me").json()["user"]["name"] == "학생1"
    reqs = boss.get("/api/admin/change-requests?field=name").json()["requests"]
    assert [(r["id"], r["role"], r["school"], r["old_value"], r["new_value"]) for r in reqs] == [
        (change_id, "student", SCHOOL, "학생1", "새학생이름")]
    assert boss.post(f"/api/admin/change-requests/{change_id}", json={"action": "approve"}).status_code == 200
    assert s.get("/api/me").json()["user"]["name"] == "새학생이름"


def test_profile_photo_upload_view_and_delete():
    t = teacher()
    assert t.post("/api/me/photo?name=a.exe", content=b"x").status_code == 415
    assert t.post("/api/me/photo?name=a.jpg", content=b"x" * (2 * 1024 * 1024 + 1)).status_code == 413
    r = t.post("/api/me/photo?name=me.jpg", content=b"\xff\xd8fakejpeg")
    assert r.status_code == 200, r.text
    url = r.json()["photo"]
    assert url.startswith("/api/photos/") and url.endswith(".jpg")
    assert t.get(url).content == b"\xff\xd8fakejpeg"
    assert TestClient(app).get(url).status_code == 401  # 로그인한 사람만
    # 새 사진을 올리면 예전 사진은 지워진다
    url2 = t.post("/api/me/photo?name=me.png", content=b"png").json()["photo"]
    assert t.get(url).status_code == 404 and t.get(url2).status_code == 200
    assert t.delete("/api/me/photo").json()["photo"] == ""
    assert t.get(url2).status_code == 404


def test_notice_attachments():
    t = teacher()
    assert t.post("/api/admin/notices/files?name=x.exe", content=b"x").status_code == 415
    f1 = t.post("/api/admin/notices/files?name=" + "안내문.hwp", content=b"hwpdata").json()
    f2 = t.post("/api/admin/notices/files?name=b.pdf", content=b"%PDF").json()
    anon = TestClient(app)
    assert anon.get(f1["url"]).status_code == 404  # 글에 붙기 전에는 못 받는다
    nid = t.post("/api/admin/notices", json={"title": "수강신청 안내", "body": "첨부 참고", "files": [f1["id"], f2["id"]]}).json()["id"]
    r = anon.get(f1["url"])  # 공지는 누구나 본다
    assert r.status_code == 200 and r.content == b"hwpdata" and "attachment" in r.headers["content-disposition"]
    n = next(x for x in anon.get("/api/notices").json()["notices"] if x["id"] == nid)
    assert [x["name"] for x in n["files"]] == ["안내문.hwp", "b.pdf"]
    assert "안내문.hwp" in anon.get(f"/live/notices/{nid}").text
    # 다른 선생님이 올린 파일은 내 글에 붙일 수 없다
    o = teacher("other@gmail.com")
    f3 = o.post("/api/admin/notices/files?name=c.pdf", content=b"c").json()
    t.post("/api/admin/notices", json={"id": nid, "title": "수강신청 안내", "files": [f1["id"], f3["id"]]})
    n = next(x for x in anon.get("/api/notices").json()["notices"] if x["id"] == nid)
    assert [x["id"] for x in n["files"]] == [f1["id"]]  # f2는 빠졌고, f3은 붙지 않았다
    assert anon.get(f2["url"]).status_code == 404
    t.post(f"/api/admin/notices/{nid}/delete", json={})
    assert anon.get(f1["url"]).status_code == 404


def test_admin_fixes_names(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    s = student(1)
    t = teacher()
    r = t.post("/api/courses", json={"title": "정치", "instructor": "박선생", "hub_school": SCHOOL,
                                     "start_date": "2026-03-02", "end_date": "2099-01-01"})
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    boss = login("boss@gmail.com", name="관리자", school=SCHOOL)
    assert s.post("/api/me/profile", json={"name": "다른이름", "school": SCHOOL, "grade": 2, "class_no": 3, "number": 1}).status_code == 400
    assert t.get("/api/admin/users?q=학생").status_code == 403  # 전체 관리자만
    found = boss.get("/api/admin/users?q=학생1").json()["users"]
    assert [u["email"] for u in found] == ["st1@s.school.kr"]
    assert boss.post(f"/api/admin/users/{found[0]['id']}/name", json={"name": " 김 학생 "}).json()["name"] == "김 학생"
    assert s.get("/api/me").json()["user"]["name"] == "김 학생"
    tid = boss.get("/api/admin/users?q=박선생").json()["users"][0]["id"]
    boss.post(f"/api/admin/users/{tid}/name", json={"name": "박선생님"})
    assert next(c for c in t.get("/api/courses/mine").json()["courses"] if c["id"] == cid)["instructor"] == "박선생님"


def test_old_course_files_are_deleted_after_a_year(monkeypatch, tmp_path):
    """수업 자료(PDF) 파일은 과목이 끝나면 바로, 판서와 과제 제출 파일은 1년이 지나면 지운다 (점수·피드백은 남는다)"""
    import app.assignments as asg
    from datetime import date
    from app import classroom as cr_mod
    from app.file_retention import purge_expired_files
    from sqlalchemy import select
    monkeypatch.setattr(asg, "FILES_DIR", tmp_path / "files")
    monkeypatch.setattr(cr_mod, "SLIDES_DIR", tmp_path / "slides")
    now = time.time()
    with db.engine.begin() as c:
        old = c.execute(db.courses.insert().values(teacher_id=1, title="옛 과목", instructor="t", start_date="2024-03-01",
                        end_date="2024-07-20", open=1, archived=0, created_at=now)).inserted_primary_key[0]
        new = c.execute(db.courses.insert().values(teacher_id=1, title="새 과목", instructor="t", start_date="2026-03-01",
                        end_date="2099-07-20", open=1, archived=0, created_at=now)).inserted_primary_key[0]
        ids = {}
        for name, course in (("old", old), ("new", new)):
            cls = c.execute(db.classes.insert().values(code=f"C{name}", title="1주차", teacher_id=1, created_at=now,
                            course_id=course)).inserted_primary_key[0]
            c.execute(db.materials.insert().values(id=f"m{name}", class_id=cls, teacher_id=1, name="a.pdf", created_at=now))
            c.execute(db.boards.insert().values(class_id=cls, key=f"m{name}:1", strokes="[]", updated_at=now))
            aid = c.execute(db.assignments.insert().values(course_id=course, teacher_id=1, title="과제",
                            created_at=now)).inserted_primary_key[0]
            sid = c.execute(db.submissions.insert().values(assignment_id=aid, user_id=9, score=90,
                            feedback="잘했어요")).inserted_primary_key[0]
            c.execute(db.submission_files.insert().values(id=f"f{name}", submission_id=sid, name="r.hwp", size=1,
                      created_at=now))
            ids[name] = (cls, aid)
    for name, (cls, aid) in ids.items():
        (tmp_path / "slides" / str(cls)).mkdir(parents=True)
        (tmp_path / "slides" / str(cls) / f"m{name}.pdf").write_bytes(b"pdf")
        asg.file_path(aid, f"f{name}").parent.mkdir(parents=True, exist_ok=True)
        asg.file_path(aid, f"f{name}").write_bytes(b"hwp")
    # 과목 마지막 날까지는 그대로 → 다음 날 PDF·판서 삭제 → 1년 뒤 과제 파일 삭제
    assert purge_expired_files(date(2024, 7, 20)) == {"materials": 0, "submission_files": 0}
    assert purge_expired_files(date(2024, 7, 21)) == {"materials": 1, "submission_files": 0}
    assert asg.file_path(ids["old"][1], "fold").exists()
    with db.engine.connect() as c:
        assert sorted(r.key for r in c.execute(select(db.boards))) == ["mnew:1", "mold:1"]  # 판서는 남는다
    assert purge_expired_files(date(2025, 7, 1)) == {"materials": 0, "submission_files": 0}
    assert purge_expired_files(date(2025, 7, 25)) == {"materials": 0, "submission_files": 1}
    assert not (tmp_path / "slides" / str(ids["old"][0]) / "mold.pdf").exists()
    assert not asg.file_path(ids["old"][1], "fold").exists()
    assert (tmp_path / "slides" / str(ids["new"][0]) / "mnew.pdf").exists() and asg.file_path(ids["new"][1], "fnew").exists()
    with db.engine.connect() as c:
        assert [r.key for r in c.execute(select(db.boards))] == ["mnew:1"]
        assert c.execute(select(db.submissions.c.score)).scalars().all() == [90, 90]  # 점수는 남는다


def test_remember_me_controls_login_cookie(monkeypatch):
    """자동 로그인을 고르면 14일 쿠키, 안 고르면 브라우저를 닫으면 사라지는 쿠키 + 12시간 제한"""
    from app import auth as auth_mod
    c = TestClient(app)
    r = c.post("/api/auth/google", json={"credential": "test-token:short@gmail.com", "birth": "2000-01-01"})
    cookie = r.headers["set-cookie"].lower()
    assert "live_session=" in cookie and "max-age" not in cookie and "expires" not in cookie
    assert c.get("/api/me").json()["user"]["email"] == "short@gmail.com"
    real = time.time
    # 화면이 열려 있으면(30초마다 신호) 로그인이 이어진다
    for minutes in (1, 2, 3, 4):
        monkeypatch.setattr(auth_mod.time, "time", lambda m=minutes: real() + m * 60)
        assert c.post("/api/auth/ping").json()["user"] is True
    # 브라우저를 닫아 신호가 끊기면, 다시 열었을 때 바로 로그아웃 (브라우저가 창을 되살려도)
    monkeypatch.setattr(auth_mod.time, "time", lambda: real() + 4 * 60 + 200)
    assert c.get("/api/me").json()["user"] is None
    monkeypatch.setattr(auth_mod.time, "time", lambda: real() + 4 * 60 + 201)
    assert c.get("/api/me").json()["user"] is None  # 한번 끝난 로그인은 되살아나지 않는다
    monkeypatch.setattr(auth_mod.time, "time", real)
    k = TestClient(app)
    r = k.post("/api/auth/google", json={"credential": "test-token:keep@gmail.com", "birth": "2000-01-01", "remember": True})
    assert "max-age=1209600" in r.headers["set-cookie"].lower()
    monkeypatch.setattr(auth_mod.time, "time", lambda: real() + 13 * 3600)
    assert k.get("/api/me").json()["user"]["email"] == "keep@gmail.com"


def test_coordinator_school_comes_from_affiliation(monkeypatch):
    """관리교사 신청: 따로 고르지 않아도 소속 학교가 관리할 거점학교가 된다"""
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    boss.post("/api/admin/schools", json={"text": "가나고등학교\n다라고등학교"})
    g = TestClient(app)
    google_login(g, "coord2@gmail.com")
    form = {"role": "coordinator", "name": "한관리", "contact": "010", "pledge": True, "affil_type": "school",
            "office": "울산광역시교육청", "email": "han@use.go.kr"}
    assert staff_apply(g, {**form, "affiliation": "없는학교"}).status_code == 400  # 목록에 없는 학교
    assert staff_apply(g, {**form, "affiliation": "다라고등학교"}).status_code == 200
    a = boss.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"][0]
    assert a["hub"] == "다라고등학교"
    boss.post(f"/api/staff/{a['id']}", json={"action": "approve"})
    assert [h["name"] for h in g.get("/api/me").json()["user"]["coordinator_hubs"]] == ["다라고등학교"]


def test_teacher_with_courses_withdraws_but_name_stays(monkeypatch):
    """직접 연 과목이 있는 선생님도 탈퇴할 수 있다: 개인정보는 지우고, 과목·학생 기록과 이름은 남긴다"""
    from sqlalchemy import select
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    t = teacher()
    tid = t.get("/api/me").json()["user"]["id"]
    cid = t.post("/api/courses", json=COURSE).json()["id"]
    boss.post(f"/api/hub/courses/{cid}/approval", json={"action": "approve"})
    s = student(1)
    s.post(f"/api/courses/{cid}/enroll")
    assert t.post("/api/me/withdraw", json={"confirm": "탈퇴"}).status_code == 409  # 안내 확인 전
    r = t.post("/api/me/withdraw", json={"confirm": "탈퇴", "keep_name_ok": True}).json()
    assert r["kept_name"] is True
    assert t.get("/api/me").json()["user"] is None  # 로그아웃
    with db.engine.connect() as c:
        u = c.execute(select(db.users).where(db.users.c.id == tid)).first()
        co = c.execute(select(db.courses).where(db.courses.c.id == cid)).first()
        enrolled = c.execute(select(db.enrollments).where(db.enrollments.c.course_id == cid)).all()
    assert u.name == "박선생" and u.email == "" and u.account_state == "withdrawn" and u.phone == ""
    assert co.instructor and co.open == 0 and len(enrolled) == 1  # 과목·학생 기록은 그대로, 수강신청은 닫힘
    # 같은 구글 계정으로 다시 로그인하면 새 계정
    again = TestClient(app)
    google_login(again, "teacher@gmail.com")
    assert again.get("/api/me").json()["user"]["id"] != tid


def test_old_student_reconsent_asks_birth():
    """생년월일 없이 예전에 가입한 학생이 바뀐 약관에 다시 동의할 때 생년월일을 함께 받는다"""
    from sqlalchemy import update
    s = student(7)
    uid = s.get("/api/me").json()["user"]["id"]
    with db.engine.begin() as c:
        c.execute(update(db.users).where(db.users.c.id == uid).values(birth="", terms_version="old"))
    me = s.get("/api/me").json()["user"]
    assert me["needs_terms"] and me["birth"] == ""
    r = s.post("/api/me/consent", json={"terms": True, "privacy": True})
    assert r.status_code == 400 and r.json()["detail"] == "생년월일을 입력해 주세요."
    assert s.post("/api/me/consent", json={"terms": True, "privacy": True, "birth": "2015-01-01"}).status_code == 403
    r = s.post("/api/me/consent", json={"terms": True, "privacy": True, "birth": "2008-05-05"})
    assert r.status_code == 200 and r.json()["birth"] == "2008-05-05" and not r.json()["needs_terms"]


def test_withdrawn_student_course_requests_stay_anonymous():
    """탈퇴해도 희망과목 신청 글과 공감 수는 남고, 작성자·공감한 사람만 알 수 없게 된다"""
    from app.auth import _purge_user_rows
    from sqlalchemy import select
    s1, s2 = student(1), student(2)
    sub = {"school_year": 2026, "subject": "경제", "term": "1학기", "note": "학생1 입니다. 경제를 배우고 싶어요"}
    assert s1.post("/api/course-requests", json=sub).status_code == 200
    rid = s1.get("/api/course-requests/board").json()["requests"][0]["id"]
    s1.post(f"/api/course-requests/{rid}/like")
    s2.post(f"/api/course-requests/{rid}/like")
    uid = s1.get("/api/me").json()["user"]["id"]
    with db.engine.begin() as c:
        _purge_user_rows(c, uid)
    with db.engine.connect() as c:
        r = c.execute(select(db.course_requests)).first()
        likes = c.execute(select(db.course_request_likes.c.user_id)).scalars().all()
    assert r.user_id == 0 and "학생1" not in r.note and r.subject == "경제"
    assert len(likes) == 2 and uid not in likes
    board = TestClient(app).get("/api/course-requests/board").json()["requests"]
    assert board[0]["likes"] == 2


def test_access_logs_record_staff_handling_of_student_data(monkeypatch):
    """교사가 학생 정보를 보거나 고치면 접속기록이 남고, 전체 관리자만 볼 수 있으며, 365일 지나면 지워진다."""
    from app import access_log

    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"admin@gmail.com"})
    t = teacher()
    cid = t.post("/api/courses", json={**COURSE, "title": "기록 강좌"}).json()["id"]
    a = student(1)
    assert a.post(f"/api/courses/{cid}/enroll").status_code == 200
    uid = t.get(f"/api/courses/{cid}/enrollments").json()["enrollments"][0]["user_id"]
    assert t.post(f"/api/courses/{cid}/enrollments/{uid}", json={"status": "approved"}).status_code == 200
    assert t.post("/api/access-log/export", json={"what": "수강생 명단 엑셀 (1명)"}).status_code == 200
    a.get("/api/my/enrollments")  # 학생 본인 조회는 기록하지 않는다
    assert t.get("/api/courses/999/enrollments").status_code == 404  # 실패한 요청도 남기지 않는다

    assert t.get("/api/admin/access-logs").status_code == 403
    admin = login("admin@gmail.com", name="관리자", school=SCHOOL)
    logs = admin.get("/api/admin/access-logs").json()["logs"]
    rows = [(x["actor_email"], x["action"], x["what"], x["target"]) for x in reversed(logs)]
    assert rows == [
        ("teacher@gmail.com", "조회", "강좌 수강생 명단", "강좌 기록 강좌"),
        ("teacher@gmail.com", "수정", "수강 승인·반려", f"강좌 기록 강좌 · 회원 학생1 ({SCHOOL})"),
        ("teacher@gmail.com", "다운로드", "수강생 명단 엑셀 (1명)", ""),
    ]
    assert all(x["ip"] for x in logs) and logs[0]["actor_name"] == "박선생"
    assert admin.get("/api/admin/access-logs?action=다운로드").json()["logs"][0]["what"].startswith("수강생 명단")
    # 관리자가 접속기록을 본 것도 남는다
    assert admin.get("/api/admin/access-logs?q=admin@gmail.com").json()["logs"][0]["what"] == "접속기록"

    with db.engine.begin() as c:
        c.execute(db.access_logs.update().where(db.access_logs.c.what == "강좌 수강생 명단").values(at=time.time() - 366 * 86400))
    assert access_log.purge_old() == 1
    with db.engine.begin() as c:
        assert c.execute(db.access_logs.select().where(db.access_logs.c.what == "강좌 수강생 명단")).first() is None


def test_privacy_mentions_access_logs():
    html = TestClient(app).get("/live/privacy").text
    assert "별도의 로그인 이력 데이터베이스는 운영하지 않습니다" not in html
    assert "접속기록" in html and "365일간 보관" in html


def test_reconnect_within_grace_keeps_attendance(monkeypatch):
    """연결이 끊겨도 유예 시간 안에 다시 붙으면 계속 접속 중이고 출결이 한 번으로 이어진다. 넘기면 나간 것으로."""
    monkeypatch.setattr(cr, "RECONNECT_GRACE", 1.0)
    t = teacher()
    c = create(t, target_grade=2, target_class=3)
    code, cid = c["code"], c["class_id"]
    a = student(1)
    with a.websocket_connect(f"/ws/live/{code}") as sa:
        state(sa)
    time.sleep(0.2)
    p1 = next(p for p in t.get(f"/api/live/history/{cid}").json()["students"] if p["student_no"] == "20301")
    assert p1["online"]  # 끊긴 지 1초가 안 됨 → 아직 접속 중
    with a.websocket_connect(f"/ws/live/{code}") as sa:
        state(sa)
        p1 = next(p for p in t.get(f"/api/live/history/{cid}").json()["students"] if p["student_no"] == "20301")
        assert p1["count"] == 1 and p1["online"]  # 다시 붙음 → 새 접속으로 세지 않는다
    time.sleep(1.5)
    p1 = next(p for p in t.get(f"/api/live/history/{cid}").json()["students"] if p["student_no"] == "20301")
    assert p1["count"] == 1 and not p1["online"]  # 유예가 지나 나간 것으로 처리


def test_websocket_not_dropped_by_idle_check(monkeypatch):
    """자동 로그인 없이 들어온 사람의 수업 연결은 '화면 열림' 시각이 갱신되지 않아도 끊지 않는다."""
    import asyncio

    class FakeWS:
        scope = {"type": "websocket"}

        def __init__(self, session):
            self.session = session

    t = teacher()
    uid = t.get("/api/me").json()["user"]["id"]
    with db.engine.begin() as c:
        key = c.execute(db.users.select().where(db.users.c.id == uid)).first().session_key
    old = time.time() - 600
    ws = FakeWS({"uid": uid, "auth_key": key, "remember": False, "login_at": old, "seen": old})
    assert asyncio.run(auth.current_user(ws))["id"] == uid
    ws.session["login_at"] = time.time() - 13 * 3600  # 12시간 제한은 그대로
    assert asyncio.run(auth.current_user(ws)) is None


def test_mirror_setting_toggles_for_everyone():
    """카메라 좌우 반전은 기본으로 켜져 있고, 선생님이 끄면 학생 상태에도 같이 반영된다."""
    t = teacher()
    code = create(t)["code"]
    a = student(1)
    with t.websocket_connect(f"/ws/live/{code}") as tw, a.websocket_connect(f"/ws/live/{code}") as sa:
        assert state(tw)["settings"]["mirror"] is True
        tw.send_json({"t": "settings", "mirror": False})
        assert state(sa, lambda m: m["settings"]["mirror"] is False)["settings"]["mirror"] is False
        sa.send_json({"t": "settings", "mirror": True})  # 학생은 바꿀 수 없다
        tw.send_json({"t": "ping"})
        assert cr.classes[code].settings["mirror"] is False


def test_students_draw_on_whiteboard_only_own_strokes():
    """화이트보드일 때만 학생도 쓸 수 있고, 학생은 자기 획만 지운다. 선생님이 끄면 못 쓴다."""
    t = teacher()
    code = create(t)["code"]
    a, b = student(1), student(2)
    with t.websocket_connect(f"/ws/live/{code}") as tw, a.websocket_connect(f"/ws/live/{code}") as sa, \
            b.websocket_connect(f"/ws/live/{code}") as sb:
        state(tw)
        k = cr.classes[code]
        sa.send_json({"t": "stroke", "key": "board:1", "id": "a1", "color": "#d92d20", "size": 3, "pts": [[0.1, 0.1]]})
        state(sa)
        assert not k.strokes.get("board:1")  # 아직 화이트보드가 아님
        tw.send_json({"t": "present_board", "page": 1})
        key = state(sa, lambda m: m.get("present") and m["present"]["mode"] == "board") and cr.present_key(k)
        tw.send_json({"t": "stroke", "key": key, "id": "t1", "color": "#222222", "size": 3, "pts": [[0.5, 0.5]]})
        sa.send_json({"t": "stroke", "key": key, "id": "a1", "color": "#d92d20", "size": 3, "pts": [[0.1, 0.1], [0.2, 0.2]]})
        time.sleep(0.3)  # 학생 둘의 메시지는 처리 순서가 정해져 있지 않다 → a의 획이 먼저 들어가게
        sb.send_json({"t": "stroke", "key": key, "id": "a1", "color": "#1d5fd6", "size": 3, "pts": [[0.9, 0.9]]})  # 남의 획에 이어 쓰기
        sb.send_json({"t": "stroke_del", "key": key, "ids": ["t1", "a1"]})  # 남의 획 지우기
        tw.send_json({"t": "ping"})
        time.sleep(0.3)
        page = {s["id"]: s for s in k.strokes[key]}
        assert set(page) == {"t1", "a1"} and page["a1"]["by"] == a_id(a) and len(page["a1"]["pts"]) == 2
        sa.send_json({"t": "stroke_del", "key": key, "ids": ["a1", "t1"]})
        time.sleep(0.3)
        assert [s["id"] for s in k.strokes[key]] == ["t1"]  # 자기 획만 지워짐
        tw.send_json({"t": "settings", "board_draw": False})
        state(sa, lambda m: m["settings"]["board_draw"] is False)
        sa.send_json({"t": "stroke", "key": key, "id": "a2", "color": "#d92d20", "size": 3, "pts": [[0.3, 0.3]]})
        time.sleep(0.3)
        assert [s["id"] for s in k.strokes[key]] == ["t1"]


def a_id(client):
    return str(client.get("/api/me").json()["user"]["id"])


def test_admin_storage_report(monkeypatch):
    """전체 관리자는 서버 남은 공간과 항목별 사용량을 볼 수 있다."""
    from app.assignments import FILES_DIR

    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"admin@gmail.com"})
    (FILES_DIR / "notices").mkdir(parents=True, exist_ok=True)
    (FILES_DIR / "notices" / "storage-test").write_bytes(b"x" * 2048)
    assert teacher().get("/api/admin/storage").status_code == 403
    d = login("admin@gmail.com", name="관리자", school=SCHOOL).get("/api/admin/storage").json()
    assert d["disk"]["total"] >= d["disk"]["free"] > 0
    parts = {p["name"]: p for p in d["parts"]}
    assert parts["공지 첨부 파일"]["bytes"] >= 2048 and parts["데이터베이스(회원·수업 기록)"]["bytes"] > 0
    (FILES_DIR / "notices" / "storage-test").unlink()



def test_pdf_upload_limit_is_2mb():
    t = teacher()
    code = create(t)["code"]
    big = b"%PDF-1.4\n" + b"0" * (2 * 1024 * 1024)
    r = t.post(f"/api/live/classes/{code}/files?name=big.pdf", content=big)
    assert r.status_code == 413 and "2MB" in r.json()["detail"]
    assert t.post(f"/api/live/classes/{code}/files?name=ok.pdf", content=b"%PDF-1.4\nsmall").status_code == 200


def test_meeting_materials_deleted_when_meeting_ends(monkeypatch, tmp_path):
    """과목 없이 연 특강·회의는 끝내면 발표 자료(PDF) 파일을 바로 지운다(회의·공유 기록과 판서는 남음). 끝내지 않고 닫은 회의도 하루 뒤 정리."""
    from app.file_retention import purge_expired_files
    from sqlalchemy import select
    monkeypatch.setattr(cr, "SLIDES_DIR", tmp_path / "slides")
    t = teacher()
    c = create(t)
    code, cid = c["code"], c["class_id"]
    fid = t.post(f"/api/live/classes/{code}/files?name=a.pdf", content=b"%PDF-1.4\nsmall").json()["id"]
    pdf = tmp_path / "slides" / str(cid) / f"{fid}.pdf"
    assert pdf.exists()
    with t.websocket_connect(f"/ws/live/{code}") as tw:
        state(tw)
        tw.send_json({"t": "present_board", "page": 1})
        state(tw, lambda m: m.get("present"))
        tw.send_json({"t": "stroke", "key": "wb:1", "id": "w1", "pts": [[0.2, 0.2]]})
        tw.send_json({"t": "end_class"})
        until(tw, lambda m: m["t"] == "ended")
    for _ in range(30):
        if not pdf.exists():
            break
        time.sleep(0.1)
    assert not pdf.exists()
    with db.engine.connect() as conn:
        row = conn.execute(select(db.materials).where(db.materials.c.class_id == cid)).first()
        assert row.name == "a.pdf" and row.deleted_at is not None  # 공유한 기록은 남고 파기 표시만
        assert conn.execute(select(db.boards).where(db.boards.c.class_id == cid)).first() is not None  # 판서는 복습용으로 남음
    # 끝내지 않고 닫은 회의: 하루가 지나면 정기 정리에서 지운다
    now = time.time()
    with db.engine.begin() as conn:
        old = conn.execute(db.classes.insert().values(code="OLDMTG", title="회의", teacher_id=1,
                           created_at=now - 2 * 86400)).inserted_primary_key[0]
        conn.execute(db.materials.insert().values(id="mold", class_id=old, teacher_id=1, name="a.pdf", created_at=now))
    (tmp_path / "slides" / str(old)).mkdir(parents=True)
    (tmp_path / "slides" / str(old) / "mold.pdf").write_bytes(b"pdf")
    assert purge_expired_files()["materials"] == 1
    assert not (tmp_path / "slides" / str(old) / "mold.pdf").exists()
