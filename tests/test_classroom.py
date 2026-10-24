"""실시간 수업 서버 테스트: python -m pytest tests"""

import os
import tempfile
import time

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ.setdefault("ANTHROPIC_API_KEY", "test")

import pytest
from fastapi.testclient import TestClient

import app.auth as auth
import app.classroom as cr
from app import db
from app.main import app

SCHOOL = "가나중학교"


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    monkeypatch.setattr(auth, "DEV_LOGIN", True)
    monkeypatch.setattr(auth, "TEACHER_EMAILS", {"teacher@gmail.com", "other@gmail.com"})
    monkeypatch.setattr(auth, "ALLOWED_DOMAINS", {"s.school.kr"})
    monkeypatch.setattr(cr, "LIVEKIT_URL", "ws://localhost:7880")
    monkeypatch.setattr(cr, "LIVEKIT_API_KEY", "devkey")
    monkeypatch.setattr(cr, "LIVEKIT_API_SECRET", "secret-secret-secret-secret-secret")
    db.metadata.drop_all(db.engine)
    db.init()
    cr.classes.clear()


def login(email, **profile):
    c = TestClient(app)
    r = c.post("/api/auth/dev", json={"email": email})
    assert r.status_code == 200, r.text
    if profile:
        r = c.post("/api/me/profile", json=profile)
        assert r.status_code == 200, r.text
    return c


def teacher(email="teacher@gmail.com"):
    return login(email, name="박선생", school=SCHOOL)


def student(n, grade=2, class_no=3):
    return login(f"st{n}@s.school.kr", name=f"학생{n}", school=SCHOOL, grade=grade, class_no=class_no, number=n)


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


def test_login_rules():
    c = TestClient(app)
    assert c.post("/api/auth/dev", json={"email": "kid@gmail.com"}).status_code == 403  # 학교 계정 아님
    s = login("kid@s.school.kr")
    me = s.get("/api/me").json()["user"]
    assert me["role"] == "student" and me["needs_profile"]
    t = teacher()
    code = create(t)["code"]
    assert s.post(f"/api/live/classes/{code}/join").status_code == 409  # 내 정보 먼저
    assert s.post("/api/live/classes", json={}).status_code in (403, 409)  # 학생은 수업을 못 연다
    r = s.post("/api/me/profile", json={"name": "김민준", "school": SCHOOL, "grade": 2, "class_no": 3, "number": 15})
    assert r.json()["student_no"] == "20315" and r.json()["display"] == "20315 김민준"
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
            tw.send_json({"t": "breakout_plan", "n": 3})
            tw.send_json({"t": "breakout_start", "minutes": 5})
            ts = state(tw, lambda m: m["breakout"])
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
    time.sleep(0.3)
    rep = t.get(f"/api/live/history/{cid}").json()
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
        state(sa)  # 학생 연결이 끝난 뒤에 명령을 보낸다
        tw.send_json({"t": "settings", "mic_lock": True})
        until(sa, lambda m: m["t"] == "cmd" and m["cmd"] == "mute")
        sid = state(sa, lambda m: m["settings"]["mic_lock"])["me"]["id"]
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
    k = cr.classes[code]
    assert k.events[-1]["kind"] == "leave" and k.events[-1]["reason"] == "network"
    # 2) 끊긴 줄 모르는 사이 다시 연결되면 옛 연결을 '연결 끊김'으로 정리하고 재입장으로 기록
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


def test_low_bandwidth_mode_limits_student_publishing():
    from livekit import api as lk
    verifier = lk.TokenVerifier(cr.LIVEKIT_API_KEY, cr.LIVEKIT_API_SECRET)

    def grants(client, room):
        r = client.post(f"/api/live/classes/{code}/token", json={"room": room})
        assert r.status_code == 200, r.text
        return verifier.verify(r.json()["token"]).video

    t = teacher()
    code = create(t)["code"]
    a = student(1)
    assert a.post(f"/api/live/classes/{code}/join").status_code == 200
    # 기본값: 데이터 절약 모드 → 전체 교실에서 학생은 마이크만
    g = grants(a, "main")
    assert g.can_publish and g.can_publish_sources == ["microphone"]
    assert "camera" in grants(t, "main").can_publish_sources  # 선생님은 제한 없음
    with t.websocket_connect(f"/ws/live/{code}") as tw, a.websocket_connect(f"/ws/live/{code}") as sa:
        st = state(sa)
        assert st["settings"]["lowbw"] is True
        sid = st["me"]["id"]
        # 발언권을 받으면 카메라도 가능
        tw.send_json({"t": "allow_mic", "target": sid, "on": True})
        state(sa, lambda m: m["me"]["can_speak"])
        assert sorted(grants(a, "main").can_publish_sources) == ["camera", "microphone"]
        # 발언권 회수 + 마이크 잠금 → 아무것도 못 내보냄 (빈 목록은 '모두 허용'이 되므로 can_publish=False)
        tw.send_json({"t": "allow_mic", "target": sid, "on": False})
        tw.send_json({"t": "settings", "mic_lock": True})
        state(sa, lambda m: m["settings"]["mic_lock"] and not m["me"]["can_speak"])
        g = grants(a, "main")
        assert g.can_publish is False
        # 모둠에서는 카메라·마이크·화면 공유 모두 가능
        tw.send_json({"t": "breakout_plan", "n": 1})
        tw.send_json({"t": "breakout_start"})
        room = state(sa, lambda m: m["room"] != "main")["room"]
        g = grants(a, room)
        assert g.can_publish and set(g.can_publish_sources) == {"camera", "microphone", "screen_share", "screen_share_audio"}
        tw.send_json({"t": "breakout_end"})
        # 데이터 절약 모드를 끄면 전체 교실에서도 카메라 가능
        tw.send_json({"t": "settings", "lowbw": False, "mic_lock": False})
        state(sa, lambda m: m["room"] == "main" and not m["settings"]["lowbw"])
        assert sorted(grants(a, "main").can_publish_sources) == ["camera", "microphone"]
