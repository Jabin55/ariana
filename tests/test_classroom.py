"""실시간 수업 서버 테스트: pytest tests/"""

import os

os.environ.setdefault("ANTHROPIC_API_KEY", "test")

import pytest
from fastapi.testclient import TestClient

import app.classroom as cr
from app.main import app


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    monkeypatch.setattr(cr, "TEACHER_PASSWORD", "pw")
    monkeypatch.setattr(cr, "LIVEKIT_URL", "ws://localhost:7880")
    monkeypatch.setattr(cr, "LIVEKIT_API_KEY", "devkey")
    monkeypatch.setattr(cr, "LIVEKIT_API_SECRET", "secret-secret-secret-secret-secret")
    cr.classes.clear()


client = TestClient(app)


def create():
    r = client.post("/api/live/classes", json={"password": "pw", "title": "정치"})
    assert r.status_code == 200
    return r.json()


def join(code, name):
    r = client.post(f"/api/live/classes/{code}/join", json={"name": name})
    assert r.status_code == 200
    return r.json()


def until(ws, pred, limit=50):
    for _ in range(limit):
        msg = ws.receive_json()
        if pred(msg):
            return msg
    raise AssertionError("기다리던 메시지가 오지 않음")


def state(ws, pred=lambda m: True):
    return until(ws, lambda m: m["t"] == "state" and pred(m))


def test_wrong_password():
    r = client.post("/api/live/classes", json={"password": "nope"})
    assert r.status_code == 403


def test_quiz_flow_hides_answers_until_reveal():
    c = create()
    code, tkey = c["code"], c["teacher_key"]
    a = join(code, "김민준")
    b = join(code, "이서연")
    with client.websocket_connect(f"/ws/live/{code}?key={tkey}") as t, \
         client.websocket_connect(f"/ws/live/{code}?key={a['key']}") as sa, \
         client.websocket_connect(f"/ws/live/{code}?key={b['key']}") as sb:
        t.send_json({"t": "activity_start", "kind": "choice", "prompt": "대통령제 국가는?",
                     "options": ["영국", "미국", "일본"], "correct": 1})
        st = state(sa, lambda m: m["activity"])
        act = st["activity"]
        assert "correct" not in act and "counts" not in act
        sa.send_json({"t": "answer", "id": act["id"], "value": 1})
        sb.send_json({"t": "answer", "id": act["id"], "value": 0})
        sb.send_json({"t": "answer", "id": act["id"], "value": 99})  # 잘못된 값은 무시
        ts = state(t, lambda m: m["activity"] and m["activity"]["total"] == 2)
        assert ts["activity"]["counts"] == [1, 1, 0]
        t.send_json({"t": "activity_close"})
        t.send_json({"t": "activity_reveal", "on": True})
        st = state(sa, lambda m: m["activity"]["reveal"])
        assert st["activity"]["correct"] == 1 and st["activity"]["mine"] == 1
        assert st["activity"]["counts"] == [1, 1, 0]
        sa.send_json({"t": "answer", "id": act["id"], "value": 0})  # 마감 후 변경 불가

    r = client.get(f"/api/live/classes/{code}/results.csv", params={"key": tkey})
    assert r.status_code == 200
    body = r.text
    assert "김민준" in body and "미국" in body and ",O" in body and ",X" in body
    assert client.get(f"/api/live/classes/{code}/results.csv", params={"key": a["key"]}).status_code == 403


def test_breakout_rooms_tokens_and_scoped_chat():
    c = create()
    code, tkey = c["code"], c["teacher_key"]
    students = [join(code, f"학생{i}") for i in range(6)]
    with client.websocket_connect(f"/ws/live/{code}?key={tkey}") as t:
        socks = [client.websocket_connect(f"/ws/live/{code}?key={s['key']}") for s in students]
        try:
            for ws in socks:
                ws.__enter__()
            state(t, lambda m: sum(s["online"] for s in m["students"]) == 6)
            t.send_json({"t": "breakout_plan", "n": 3})
            t.send_json({"t": "breakout_start", "minutes": 5})
            ts = state(t, lambda m: m["breakout"])
            assert len(ts["groups"]) == 3
            assert all(s["room"] in ("g1", "g2", "g3") for s in ts["students"])
            sizes = [sum(s["group"] == g["id"] for s in ts["students"]) for g in ts["groups"]]
            assert sizes == [2, 2, 2]

            st0 = state(socks[0], lambda m: m["room"] != "main")
            room0 = st0["room"]
            assert st0["group"]["name"].endswith("모둠") and len(st0["group"]["members"]) == 2

            # 입장권: 자기 모둠만 가능, 선생님은 모든 모둠 가능
            tok = lambda key, room: client.post(f"/api/live/classes/{code}/token", json={"key": key, "room": room})
            assert tok(students[0]["key"], room0).status_code == 200
            other = next(g["id"] for g in ts["groups"] if g["id"] != room0)
            assert tok(students[0]["key"], other).status_code == 403
            assert tok(students[0]["key"], "main").status_code == 403
            assert all(tok(tkey, g["id"]).status_code == 200 for g in ts["groups"])

            # 모둠 채팅은 같은 모둠에만
            socks[0].send_json({"t": "chat", "text": "우리 모둠 안녕"})
            msg = until(t, lambda m: m["t"] == "chat")
            assert msg["msg"]["scope"] == room0
            mate = next(i for i, s in enumerate(ts["students"]) if s["group"] == room0 and s["name"] != "학생0")
            until(socks[mate], lambda m: m["t"] == "chat" and m["msg"]["text"] == "우리 모둠 안녕")

            # 선생님 듣기 표시
            t.send_json({"t": "listen", "groups": [room0], "talking": None})
            assert state(socks[0], lambda m: m["teacher_listening"])["teacher_talking"] is False

            # 학생 옮기기
            sid0 = next(s["id"] for s in ts["students"] if s["name"] == "학생0")
            t.send_json({"t": "breakout_assign", "target": sid0, "group": other})
            assert state(socks[0], lambda m: m["room"] == other)["teacher_listening"] is False

            t.send_json({"t": "breakout_end"})
            st = state(socks[0], lambda m: m["room"] == "main")
            assert not st["breakout"]
            assert tok(students[0]["key"], "main").status_code == 200
        finally:
            for ws in socks:
                ws.__exit__(None, None, None)


def test_mic_lock_kick_and_end():
    c = create()
    code, tkey = c["code"], c["teacher_key"]
    a = join(code, "김민준")
    with client.websocket_connect(f"/ws/live/{code}?key={tkey}") as t, \
         client.websocket_connect(f"/ws/live/{code}?key={a['key']}") as sa:
        t.send_json({"t": "settings", "mic_lock": True})
        until(sa, lambda m: m["t"] == "cmd" and m["cmd"] == "mute")
        st = state(sa, lambda m: m["settings"]["mic_lock"])
        assert st["me"]["can_speak"] is False
        sid = st["me"]["id"]
        t.send_json({"t": "allow_mic", "target": sid, "on": True})
        state(sa, lambda m: m["me"]["can_speak"])

        sa.send_json({"t": "question", "text": "질문 있어요"})
        ts = state(t, lambda m: m["questions"])
        qid = ts["questions"][0]["id"]
        t.send_json({"t": "question_update", "id": qid, "reply": "좋은 질문!", "done": True})
        st = state(sa, lambda m: m["my_questions"] and m["my_questions"][0]["reply"])
        assert st["my_questions"][0]["reply"] == "좋은 질문!"

        t.send_json({"t": "kick", "target": sid})
        until(sa, lambda m: m["t"] == "kicked")
    assert client.post(f"/api/live/classes/{code}/token", json={"key": a["key"], "room": "main"}).status_code == 403

    with client.websocket_connect(f"/ws/live/{code}?key={tkey}") as t:
        t.send_json({"t": "end_class"})
        until(t, lambda m: m["t"] == "ended")
    assert client.get(f"/api/live/classes/{code}").status_code == 404


def test_rejoin_keeps_identity():
    c = create()
    a = join(c["code"], "김민준")
    r = client.post(f"/api/live/classes/{c['code']}/join", json={"name": "김민준", "key": a["key"]})
    assert r.json()["student_id"] == a["student_id"]
