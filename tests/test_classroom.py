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
COURSE = {"title": "강좌", "instructor": "강사", "hub_school": "가나고등학교",
          "start_date": "2026-03-02", "end_date": "2099-12-18"}


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
        r = c.post("/api/me/profile", json={"agree": True, **profile})
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
    # 학교 계정이 아니면 '손님': 강사 등록 신청만 할 수 있고 수업·강좌는 못 쓴다
    assert c.post("/api/auth/dev", json={"email": "kid@gmail.com"}).json()["role"] == "guest"
    assert c.get("/api/courses/available").status_code == 403
    s = login("kid@s.school.kr")
    me = s.get("/api/me").json()["user"]
    assert me["role"] == "student" and me["needs_profile"]
    t = teacher()
    code = create(t)["code"]
    assert s.post(f"/api/live/classes/{code}/join").status_code == 409  # 내 정보 먼저
    assert s.post("/api/live/classes", json={}).status_code in (403, 409)  # 학생은 수업을 못 연다
    prof = {"name": "김민준", "school": SCHOOL, "grade": 2, "class_no": 3, "number": 15}
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
    # 기본값: 마이크 통제 + 데이터 절약 모드 → 전체 교실에서 학생은 아무것도 못 내보냄 (선생님이 켜 줘야 함)
    g = grants(a, "main")
    assert g.can_publish is False
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
        state(sa, lambda m: m["room"] == "main" and not m["settings"]["lowbw"] and not m["settings"]["mic_lock"])
        assert sorted(grants(a, "main").can_publish_sources) == ["camera", "microphone"]


def test_live_site_mode_root_goes_to_class(monkeypatch):
    import app.main as main
    c = TestClient(app)
    assert c.get("/", follow_redirects=False).status_code == 200  # 기본: 정치쌤 챗봇
    monkeypatch.setattr(main, "APP_MODE", "live")
    r = c.get("/", follow_redirects=False)
    assert r.status_code in (302, 307) and r.headers["location"] == "/live"


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
    assert t.post("/api/live/classes", json={"title": "x", "course_id": cid}).status_code == 409
    assert t.post("/api/live/classes", json={"title": "x", "course_id": 999}).status_code == 404


def test_instructor_can_be_outside_school_list(monkeypatch):
    monkeypatch.setattr(auth, "SCHOOLS", [SCHOOL])
    # 대학교수: 학교 목록에 없는 소속도 저장되고, 거점학교는 소속과 다르게 적을 수 있다
    # 강사 목록에 없고 승인도 안 된 대학 계정은 '손님' (강사 기능 없음)
    guest = TestClient(app)
    assert guest.post("/api/auth/dev", json={"email": "prof@univ.ac.kr"}).json()["role"] == "guest"
    assert guest.post("/api/courses", json=COURSE).status_code == 403
    monkeypatch.setattr(auth, "TEACHER_EMAILS", {"teacher@gmail.com", "prof@univ.ac.kr"})
    prof = login("prof@univ.ac.kr", name="김교수", school="한국대학교 정치외교학과")
    assert prof.get("/api/me").json()["user"]["school"] == "한국대학교 정치외교학과"
    cid = prof.post("/api/courses", json={"title": "민주주의 이론", "instructor": "김교수", "hub_school": "가나고등학교",
                                          "start_date": "2026-03-02", "end_date": "2099-12-18"}).json()["id"]
    c = student(1).get("/api/courses/available").json()["courses"][0]
    assert c["id"] == cid and c["instructor"] == "김교수" and c["hub_school"] == "가나고등학교"
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


def test_hub_structure_and_two_stage_enrollment(monkeypatch):
    """전체 관리자 → 거점학교 관리교사 → 강사 → 학생(강사 1차 + 관리교사 최종 승인)"""
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"admin@gmail.com"})
    admin = login("admin@gmail.com", name="전체관리자")
    pledge = {"contact": "010-0000-0000", "pledge": True}

    def guest(email):
        g = TestClient(app)
        assert g.post("/api/auth/dev", json={"email": email}).json()["role"] == "guest"
        return g

    # 1) 관리교사 신청 → 전체 관리자 승인 → 거점학교가 생긴다
    coord = guest("coord@gmail.com")
    assert coord.post("/api/staff/apply", json={"role": "coordinator", "hub_name": "가나고등학교", "name": "한관리",
                                                "affiliation": "가나고등학교", **pledge, "pledge": False}).status_code == 400
    assert coord.post("/api/staff/apply", json={"role": "coordinator", "hub_name": "가나고등학교", "name": "한관리",
                                                "affiliation": "가나고등학교", **pledge}).status_code == 200
    assert coord.get("/api/staff/applications", params={"role": "coordinator"}).status_code == 403  # 관리자만
    capps = admin.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"]
    assert capps[0]["hub"] == "가나고등학교" and capps[0]["status"] == "pending"
    assert admin.post(f"/api/staff/{capps[0]['id']}", json={"action": "approve"}).status_code == 200
    me = coord.get("/api/me").json()["user"]
    assert me["role"] == "teacher" and me["coordinator_hubs"][0]["name"] == "가나고등학교"
    hub_id = me["coordinator_hubs"][0]["id"]
    assert [h["name"] for h in coord.get("/api/hubs").json()["hubs"]] == ["가나고등학교"]

    # 2) 강사(대학교수) 신청: 거점학교를 골라 신청 → 그 학교 관리교사가 승인 (전체 관리자가 아니어도)
    prof = guest("prof@univ.ac.kr")
    iform = {"role": "instructor", "hub_id": hub_id, "name": "김교수", "affiliation": "한국대학교", **pledge}
    assert prof.post("/api/staff/apply", json=iform).status_code == 400  # 희망 기간 없음
    assert prof.post("/api/staff/apply", json={**iform, "wish_from": "2020-01-01", "wish_until": "2020-02-01"}).status_code == 400
    assert prof.post("/api/staff/apply", json={**iform, "wish_from": "2027-01-01", "wish_until": "2099-02-28",
                                               "message": "무시됨"}).status_code == 200
    other_coord_view = teacher().get("/api/staff/applications", params={"role": "instructor"})
    assert other_coord_view.status_code == 403  # 관리교사가 아니면 못 봄
    iapps = coord.get("/api/staff/applications", params={"role": "instructor"}).json()["applications"]
    assert iapps[0]["name"] == "김교수" and iapps[0]["hub"] == "가나고등학교"
    assert (iapps[0]["wish_from"], iapps[0]["wish_until"], iapps[0]["message"]) == ("2027-01-01", "2099-02-28", "")
    assert coord.post(f"/api/staff/{iapps[0]['id']}", json={"action": "approve"}).status_code == 400  # 끝나는 날 필수
    assert coord.post(f"/api/staff/{iapps[0]['id']}", json={"action": "approve", "valid_until": "2099-02-28"}).status_code == 200
    pme = prof.get("/api/me").json()["user"]
    assert pme["role"] == "teacher" and pme["teach_hubs"] == [{"id": hub_id, "name": "가나고등학교"}] and not pme["coordinator_hubs"]
    # 강사는 관리교사 권한 없음
    assert prof.get("/api/hub/overview").status_code == 403

    # 3) 강사: 승인받은 거점학교에만 강좌 개설 (거점학교명은 자동)
    base = {"title": "정치 보충", "instructor": "김교수", "start_date": "2027-01-05", "end_date": "2099-02-20"}
    assert prof.post("/api/courses", json=base).status_code == 400  # 거점학교 안 고름
    assert prof.post("/api/courses", json={**base, "hub_id": 999}).status_code == 403
    cid = prof.post("/api/courses", json={**base, "hub_id": hub_id}).json()["id"]

    # 4) 학생 수강신청 → 강사 1차 승인 → 관리교사 최종 승인
    s1, s2 = student(1), student(2)
    s1.post(f"/api/courses/{cid}/enroll")
    s2.post(f"/api/courses/{cid}/enroll")
    c = s1.get("/api/courses/available").json()["courses"][0]
    assert c["hub_school"] == "가나고등학교" and c["status"] == "pending"
    ens = {e["student_no"]: e for e in prof.get(f"/api/courses/{cid}/enrollments").json()["enrollments"]}
    # 관리교사는 강사 승인 전에는 최종 승인 불가
    assert coord.post(f"/api/hub/enrollments/{ens['20301']['id']}", json={"status": "approved"}).status_code == 409
    prof.post(f"/api/courses/{cid}/enrollments/{ens['20301']['user_id']}", json={"status": "approved"})
    prof.post(f"/api/courses/{cid}/enrollments/{ens['20302']['user_id']}", json={"status": "rejected", "note": "정원 초과"})
    assert s1.get("/api/courses/available").json()["courses"][0]["status"] == "instructor_ok"
    rej = s2.get("/api/courses/available").json()["courses"][0]
    assert rej["status"] == "rejected" and rej["note"] == "정원 초과"
    # 강사 승인만으로는 아직 수업에 못 들어온다
    code = create(prof, title="1주차", course_id=cid)["code"]
    assert s1.get("/api/courses/live-now").json()["classes"] == []
    assert s1.post(f"/api/live/classes/{code}/join").status_code == 403
    ov = coord.get("/api/hub/overview").json()
    assert ov["courses"][0]["waiting"] == 1
    waiting = [e for e in ov["enrollments"] if e["status"] == "instructor_ok"]
    assert [e["student_no"] for e in waiting] == ["20301"]
    assert coord.post(f"/api/hub/enrollments/{waiting[0]['id']}", json={"status": "approved"}).status_code == 200
    # 최종 승인 뒤에야 수강 확정 → 코드 없이 입장
    assert s1.get("/api/courses/available").json()["courses"][0]["status"] == "approved"
    assert s1.get("/api/courses/live-now").json()["classes"][0]["code"] == code
    assert s1.post(f"/api/live/classes/{code}/join").status_code == 200
    # 관리교사 '모두 최종 승인'
    s3 = student(3)
    s3.post(f"/api/courses/{cid}/enroll")
    prof.post(f"/api/courses/{cid}/approve-all")
    assert coord.post("/api/hub/approve-all", json={"course_id": cid}).json()["approved"] == 1

    # 5) 관리교사 권한을 해제하면 관리 기능이 꺼지고, 강사 기간이 끝나면 강사 기능이 꺼진다
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
        g.post("/api/auth/dev", json={"email": email})
        return g

    def approve(who, role, app_id, **kw):
        return who.post(f"/api/staff/{app_id}", json={"action": "approve", **kw})

    def apps(who, role):
        return who.get("/api/staff/applications", params={"role": role}).json()["applications"]

    # 가나고 관리교사 A
    a = guest("a@gmail.com")
    a.post("/api/staff/apply", json={"role": "coordinator", "hub_name": "가나고등학교", "name": "관리A", **form})
    approve(admin, "coordinator", apps(admin, "coordinator")[0]["id"])
    hub = a.get("/api/me").json()["user"]["coordinator_hubs"][0]["id"]

    # 1) 강사였던 B: 가나고 강사 (작년, 기간 끝남) → 올해 같은 학교 관리교사도 신청
    b = guest("b@gmail.com")
    b.post("/api/staff/apply", json={"role": "instructor", "hub_id": hub, "name": "강사B", **form})
    bi = [x for x in apps(a, "instructor") if x["name"] == "강사B"][0]
    approve(a, "instructor", bi["id"], valid_from="2025-01-01", valid_until="2025-12-31")
    assert b.get("/api/me").json()["user"]["role"] == "guest"  # 기간 끝남
    # 기간이 끝난 강사가 다시 신청하면 '승인 대기'로 돌아가 관리교사에게 보인다 (연장 요청)
    b.post("/api/staff/apply", json={"role": "instructor", "hub_id": hub, "name": "강사B", **form})
    assert [x["status"] for x in apps(a, "instructor") if x["name"] == "강사B"] == ["pending"]
    # 같은 학교 관리교사 신청 → 전체 관리자 승인 → 두 역할을 함께 가진다
    assert b.post("/api/staff/apply", json={"role": "coordinator", "hub_name": "가나고등학교", "name": "강사B", **form}).status_code == 200
    bc = [x for x in apps(admin, "coordinator") if x["name"] == "강사B"][0]
    approve(admin, "coordinator", bc["id"])
    me = b.get("/api/me").json()["user"]
    assert me["coordinator_hubs"] == [{"id": hub, "name": "가나고등학교"}]  # 같은 거점학교로 합쳐짐
    assert sorted(m["role"] for m in me["memberships"]) == ["coordinator", "instructor"]

    # 2) 관리교사 A가 자기 학교 강사로도 등록: 본인 신청은 본인이 승인할 수 없다
    a.post("/api/staff/apply", json={"role": "instructor", "hub_id": hub, "name": "관리A", **form})
    ai = [x for x in apps(a, "instructor") if x["name"] == "관리A"][0]
    assert approve(a, "instructor", ai["id"]).status_code == 403
    # 같은 학교의 다른 관리교사(B)나 전체 관리자가 승인
    assert approve(b, "instructor", ai["id"], valid_until="2099-02-28").status_code == 200
    roles = sorted(m["role"] for m in a.get("/api/me").json()["user"]["memberships"] if m["status"] == "approved")
    assert roles == ["coordinator", "instructor"]


def test_instructor_moves_to_another_hub(monkeypatch):
    """거점학교를 옮기면 예전 거점학교 강좌는 관리할 수 없다 (다른 학교에서 강사로 활동 중이어도)"""
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"admin@gmail.com"})
    admin = login("admin@gmail.com", name="전체관리자")
    form = {"contact": "010", "pledge": True, "affiliation": "", "wish_from": "2026-03-01", "wish_until": "2099-02-28"}

    def guest(email):
        g = TestClient(app)
        g.post("/api/auth/dev", json={"email": email})
        return g

    for school in ("가나고", "다라고"):
        admin.post("/api/staff/apply", json={"role": "coordinator", "hub_name": school, "name": "관리", **form})
    for x in admin.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"]:
        admin.post(f"/api/staff/{x['id']}", json={"action": "approve"})
    hubs = {h["name"]: h["id"] for h in admin.get("/api/hubs").json()["hubs"]}
    t = guest("t@gmail.com")
    for school in ("가나고", "다라고"):
        t.post("/api/staff/apply", json={"role": "instructor", "hub_id": hubs[school], "name": "강사", **form})
    ids = {x["hub"]: x["id"] for x in admin.get("/api/staff/applications", params={"role": "instructor"}).json()["applications"]}
    for i in ids.values():
        admin.post(f"/api/staff/{i}", json={"action": "approve", "valid_until": "2099-02-28"})
    cid = t.post("/api/courses", json={**COURSE, "hub_id": hubs["가나고"]}).json()["id"]
    assert create(t, title="1주차", course_id=cid)["code"]

    # 가나고 강사 해제 → 다라고에서는 여전히 강사지만 가나고 강좌는 잠긴다
    admin.post(f"/api/staff/{ids['가나고']}", json={"action": "revoke"})
    me = t.get("/api/me").json()["user"]
    assert me["role"] == "teacher" and me["teach_hubs"] == [{"id": hubs["다라고"], "name": "다라고"}]
    assert t.get("/api/courses/mine").json()["courses"][0]["locked"] is True
    assert t.post("/api/live/classes", json={"title": "2주차", "course_id": cid}).status_code == 403
    assert t.get(f"/api/courses/{cid}/enrollments").status_code == 403
    assert t.post(f"/api/courses/{cid}", json={"open": False}).status_code == 403
    # 다시 승인받으면 풀린다
    admin.post(f"/api/staff/{ids['가나고']}", json={"action": "approve", "valid_until": "2099-02-28"})
    assert t.get("/api/courses/mine").json()["courses"][0]["locked"] is False


def test_students_from_other_schools(monkeypatch):
    """거점학교 강좌는 다른 학교 학생도 신청해 듣는다. 학번이 같아도 학교로 구분된다."""
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"admin@gmail.com"})
    admin = login("admin@gmail.com", name="전체관리자")
    admin.post("/api/staff/apply", json={"role": "coordinator", "hub_name": "가나고", "name": "관리", "contact": "010", "pledge": True})
    admin.post(f"/api/staff/{admin.get('/api/staff/applications', params={'role': 'coordinator'}).json()['applications'][0]['id']}",
               json={"action": "approve"})
    hub = admin.get("/api/hubs").json()["hubs"][0]["id"]
    cid = admin.post("/api/courses", json={**COURSE, "hub_id": hub}).json()["id"]
    # 가나고 학생과 다라고 학생, 둘 다 학번 20315
    a = login("a@s.school.kr", name="김민수", school="가나고", grade=2, class_no=3, number=15)
    b = login("b@s.school.kr", name="김민수", school="다라고", grade=2, class_no=3, number=15)
    for s in (a, b):
        assert s.post(f"/api/courses/{cid}/enroll").status_code == 200
    admin.post(f"/api/courses/{cid}/approve-all")
    assert admin.post("/api/hub/approve-all", json={"course_id": cid}).json()["approved"] == 2
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
        assert st["present"] == {"mode": "slides", "file": fid, "name": "선거제도.pdf", "page": 1, "pages": 3, "key": f"{fid}:1"}
        # 판서: 그리는 중에 나눠 보낸 점이 학생에게 바로 간다 (상태 전체를 다시 보내지 않음)
        tw.send_json({"t": "stroke", "key": f"{fid}:1", "id": "a1", "color": "#d92d20", "size": 3, "pts": [[0.1, 0.1], [0.2, 0.2]]})
        tw.send_json({"t": "stroke", "key": f"{fid}:1", "id": "a1", "pts": [[0.3, 0.3]]})
        m = until(sw, lambda m: m["t"] == "stroke" and m["pts"] == [[0.3, 0.3]])
        assert m["color"] == "#d92d20"
        tw.send_json({"t": "stroke", "key": "wrong:1", "id": "x", "pts": [[0.5, 0.5]]})  # 지금 쪽이 아니면 무시
        # 다음 쪽 → 그 쪽 판서(빈 것)를 받는다. 마지막 쪽 너머로는 안 간다
        tw.send_json({"t": "present_page", "page": 2})
        assert until(sw, lambda m: m["t"] == "strokes")["key"] == f"{fid}:2"
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
        # 학생은 발표·판서를 조작할 수 없다
        sw.send_json({"t": "present_close"})
        sw.send_json({"t": "stroke", "key": "wb:2", "id": "s", "pts": [[0.1, 0.1]]})
        time.sleep(0.2)
        assert cr.classes[code].present is not None and not cr.classes[code].strokes.get("wb:2")
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
    # 수업이 끝나도 자료는 남는다 → 지난 수업 자료
    cid = c["class_id"]
    assert (tmp_path / str(cid) / f"{fid}.pdf").exists()
    lst = s1.get("/api/materials").json()["classes"]
    assert [x["id"] for x in lst] == [cid] and lst[0]["files"] == 1
    detail = s1.get(f"/api/materials/class/{cid}").json()
    assert detail["files"][0]["name"] == "선거제도.pdf" and detail["can_delete"] is False
    assert s1.get(f"/api/materials/file/{fid}").content == pdf
    # 수업에 들어오지 않았고 수강생도 아닌 학생은 볼 수 없다
    assert s2.get("/api/materials").json()["classes"] == []
    assert s2.get(f"/api/materials/class/{cid}").status_code == 403
    assert s2.get(f"/api/materials/file/{fid}").status_code == 403
    # 다른 선생님은 지울 수 없고, 수업을 연 선생님은 지울 수 있다
    other = teacher("other@gmail.com")
    assert other.post(f"/api/materials/file/{fid}/delete").status_code == 404
    assert t.get(f"/api/materials/class/{cid}").json()["can_delete"] is True
    assert t.post(f"/api/materials/file/{fid}/delete").status_code == 200
    assert not (tmp_path / str(cid) / f"{fid}.pdf").exists()
    assert s1.get(f"/api/materials/class/{cid}").json()["files"] == []


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
        # 마이크 통제(기본): 학생은 스스로 못 켜고, 선생님이 켜면 권한이 생기며 학생 화면이 바로 켠다
        sid = st["students"][0]["id"]
        who = next(s for s in studs if str(s.get("/api/me").json()["user"]["id"]) == sid)
        with who.websocket_connect(f"/ws/live/{code}") as sw:
            assert state(sw)["settings"]["mic_lock"] is True
            assert grants(who, "main").can_publish is False
            # 마이크 요청(🎙️)과 손 들기(✋, 할 말 있음)는 따로
            sw.send_json({"t": "mic_req", "on": True})
            sw.send_json({"t": "hand", "up": True})
            st2 = state(tw, lambda m: any(x["mic_req"] and x["hand"] for x in m["students"]))
            assert sum(x["mic_req"] for x in st2["students"]) == 1
            tw.send_json({"t": "cmd", "cmd": "mic_on", "target": sid})
            assert until(sw, lambda m: m["t"] == "cmd")["cmd"] == "mic_on"
            me = state(sw, lambda m: m["me"]["can_speak"])["me"]
            assert me["mic_req"] is False and me["hand"] is True and me["can_cam"] is False  # 손은 그대로
            sw.send_json({"t": "mic_req", "on": True})  # 이미 켜 줬으면 요청은 무시
            assert grants(who, "main").can_publish_sources == ["microphone"]
            # 카메라도 선생님이 켠다 (데이터 절약 모드)
            tw.send_json({"t": "cmd", "cmd": "cam_on", "target": sid})
            assert until(sw, lambda m: m["t"] == "cmd")["cmd"] == "cam_on"
            state(sw, lambda m: m["me"]["can_cam"])
            assert sorted(grants(who, "main").can_publish_sources) == ["camera", "microphone"]
            # 선생님이 끄면 권한도 사라져 학생이 다시 켤 수 없다
            tw.send_json({"t": "cmd", "cmd": "mic_off", "target": sid})
            assert until(sw, lambda m: m["t"] == "cmd")["cmd"] == "mute"
            state(sw, lambda m: not m["me"]["can_speak"])
            assert grants(who, "main").can_publish_sources == ["camera"]
            # 모두 음소거 → 모두 권한 회수
            tw.send_json({"t": "cmd", "cmd": "mic_on", "target": sid})
            state(sw, lambda m: m["me"]["can_speak"])
            tw.send_json({"t": "cmd", "cmd": "mute", "target": "all"})
            state(sw, lambda m: not m["me"]["can_speak"])


def test_policy_pages(monkeypatch):
    c = TestClient(app)
    for path in ("/live/terms", "/live/privacy", "/live/notice"):
        r = c.get(path)
        assert r.status_code == 200 and "(설정 필요)" in r.text  # 운영 기관 등을 아직 안 정함
    monkeypatch.setenv("OPERATOR_NAME", "가나고등학교<script>")
    monkeypatch.setenv("PRIVACY_OFFICER", "교감 홍길동")
    monkeypatch.setenv("PRIVACY_CONTACT", "02-123-4567")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    p = c.get("/live/privacy").text
    assert "가나고등학교&lt;script&gt;" in p and "<script>" not in p  # 설정 값은 그대로 출력하지 않는다
    assert "Hetzner" in p and "Anthropic" not in p  # AI 조교를 안 쓰면 미국 이전 항목 없음
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert "Anthropic" in c.get("/live/privacy").text and "AI 조교" in c.get("/live/terms").text
    assert c.get("/api/me").json()["policy_ready"] is True
    assert "가나고등학교&lt;script&gt;장 귀하" in c.get("/live/notice").text  # 동의서 받는 곳: 기본은 운영 기관장
    monkeypatch.setenv("CONSENT_TO", "울산광역시교육청")
    assert "울산광역시교육청 귀하" in c.get("/live/notice").text
    # 강사 신청서의 동의는 이용약관 확인으로도 기록된다
    g = TestClient(app)
    g.post("/api/auth/dev", json={"email": "guest@gmail.com"})
    assert g.get("/api/me").json()["user"]["needs_terms"] is True
    g.post("/api/staff/apply", json={"role": "coordinator", "hub_name": "가나고", "name": "관리", "contact": "010", "pledge": True})
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
    tch.post("/api/auth/dev", json={"email": "kim@s.school.kr"})
    me = tch.get("/api/me").json()["user"]
    assert me["role"] == "student" and me["role_choice"] and me["needs_profile"]
    me = tch.post("/api/me/self-role", json={"role": "staff"}).json()
    assert me["role"] == "guest" and not me["role_choice"] and me["can_be_student"]  # 강사·관리교사 신청 화면으로
    assert tch.get("/api/courses/available").status_code == 403  # 학생 기능은 못 씀
    # 학교 계정이 아니면 고를 수 없다
    g = TestClient(app)
    g.post("/api/auth/dev", json={"email": "someone@gmail.com"})
    assert g.post("/api/me/self-role", json={"role": "student"}).status_code == 400
    # 학교 목록: 전체 관리자만 저장, 학생은 목록에 있는 정식 이름만
    assert tch.post("/api/admin/schools", json={"text": "가나고"}).status_code == 403
    r = admin.post("/api/admin/schools", json={"text": "신정고등학교\n  울산고등학교 \n\n신정고등학교"}).json()
    assert r["schools"] == ["신정고등학교", "울산고등학교"]
    assert admin.get("/api/me").json()["schools"] == ["신정고등학교", "울산고등학교"]
    s = TestClient(app)
    s.post("/api/auth/dev", json={"email": "st9@s.school.kr"})
    prof = {"name": "학생", "grade": 2, "class_no": 1, "number": 9, "agree": True}
    assert s.post("/api/me/profile", json={**prof, "school": "신정고"}).status_code == 400
    me = s.post("/api/me/profile", json={**prof, "school": "신정고등학교"}).json()
    assert me["role"] == "student" and not me["needs_profile"]
    # 대상 학년: 1학년 강좌는 2학년에게 안 보이고 신청도 안 된다
    t = teacher()
    c1 = t.post("/api/courses", json={**COURSE, "title": "1학년 강좌", "grades": [1]}).json()["id"]
    c2 = t.post("/api/courses", json={**COURSE, "title": "2·3학년 강좌", "grades": [3, 2]}).json()["id"]
    titles = [x["title"] for x in s.get("/api/courses/available").json()["courses"]]
    assert "1학년 강좌" not in titles and "2·3학년 강좌" in titles
    assert s.post(f"/api/courses/{c1}/enroll").status_code == 409
    assert s.post(f"/api/courses/{c2}/enroll").status_code == 200
    assert [x["grades"] for x in t.get("/api/courses/mine").json()["courses"] if x["id"] == c2] == [[2, 3]]
    t.post(f"/api/courses/{c1}", json={"grades": []})  # 학년 제한을 풀면 보인다
    assert "1학년 강좌" in [x["title"] for x in s.get("/api/courses/available").json()["courses"]]


def test_withdraw(monkeypatch, tmp_path):
    import app.assignments as asg
    monkeypatch.setattr(asg, "FILES_DIR", tmp_path)
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    # 거점학교 두 곳: 가나고(관리교사 coord), 다라고(관리교사 other)
    hubs = {}
    for email, hub in (("coord@gmail.com", "가나고등학교"), ("coord2@gmail.com", "다라고등학교")):
        c = TestClient(app)
        c.post("/api/auth/dev", json={"email": email})
        r = c.post("/api/staff/apply", json={"role": "coordinator", "name": "관리", "hub_name": hub, "contact": "010", "pledge": True})
        assert r.status_code == 200, r.text
        mid = boss.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"][0]["id"]
        assert boss.post(f"/api/staff/{mid}", json={"action": "approve"}).status_code == 200
        hubs[hub] = c
    coord, other = hubs["가나고등학교"], hubs["다라고등학교"]
    hub_id = {h["name"]: h["id"] for h in boss.get("/api/hubs").json()["hubs"]}["가나고등학교"]
    t = boss  # 전체 관리자가 가나고등학교 강좌를 연다 (강사 승인 → 관리교사 최종 승인)
    cid = t.post("/api/courses", json={**COURSE, "hub_id": hub_id}).json()["id"]
    a, b = student(1), student(2)
    for s in (a, b):
        s.post(f"/api/courses/{cid}/enroll")
    t.post(f"/api/courses/{cid}/approve-all")
    coord.post("/api/hub/approve-all", json={"course_id": cid})
    aid = t.post(f"/api/courses/{cid}/assignments", json={"title": "보고서"}).json()["id"]
    a.post(f"/api/assignments/{aid}/files?name=r.pdf", content=b"%PDF a", headers={"Content-Type": "application/pdf"})
    b.post(f"/api/assignments/{aid}/files?name=r.pdf", content=b"%PDF b", headers={"Content-Type": "application/pdf"})
    # 확인 글자가 없으면 안 되고, 강좌를 연 선생님은 바로 탈퇴할 수 없다
    assert a.post("/api/me/withdraw", json={"confirm": "네"}).status_code == 400
    assert t.post("/api/me/withdraw", json={"confirm": "탈퇴"}).status_code == 409
    # 학생은 신청만 → 그 강좌 거점학교 관리교사·전체 관리자에게만 보인다
    r = a.post("/api/me/withdraw", json={"confirm": "탈퇴", "reason": "전학"}).json()
    assert r["requested"] and a.get("/api/me").json()["user"]["withdraw_requested"]
    q = coord.get("/api/hub/withdrawals").json()["requests"]
    assert [x["student_no"] for x in q] == ["20301"] and q[0]["reason"] == "전학" and q[0]["studying"] == ["강좌"]
    assert other.get("/api/hub/withdrawals").json()["requests"] == []
    assert other.post(f"/api/hub/withdrawals/{q[0]['user_id']}", json={"action": "approve"}).status_code == 404
    assert a.post(f"/api/hub/withdrawals/{q[0]['user_id']}", json={"action": "approve"}).status_code == 403
    # 반려하면 사유가 학생에게 보이고, 다시 신청·취소할 수 있다
    coord.post(f"/api/hub/withdrawals/{q[0]['user_id']}", json={"action": "reject", "note": "학기 끝나고 해요"})
    me = a.get("/api/me").json()["user"]
    assert not me["withdraw_requested"] and me["withdraw_note"] == "학기 끝나고 해요"
    a.post("/api/me/withdraw", json={"confirm": "탈퇴"})
    a.post("/api/me/withdraw/cancel")
    assert coord.get("/api/hub/withdrawals").json()["requests"] == []
    a.post("/api/me/withdraw", json={"confirm": "탈퇴"})
    # 승인하면 그 학생의 기록·파일만 모두 지워진다
    assert coord.post(f"/api/hub/withdrawals/{q[0]['user_id']}", json={"action": "approve"}).status_code == 200
    assert a.get("/api/me").json()["user"] is None
    subs = t.get(f"/api/assignments/{aid}/submissions").json()["submissions"]
    assert [s["student_no"] for s in subs] == ["20302"] and subs[0]["submitted"]
    assert len(list((tmp_path / "assignments" / str(aid)).iterdir())) == 1
    again = login("st1@s.school.kr")  # 같은 계정으로 다시 로그인하면 새로 가입
    assert again.get("/api/me").json()["user"]["needs_profile"]
    # 어느 거점학교와도 상관없는 학생은 전체 관리자가 승인
    c = student(5)
    c.post("/api/me/withdraw", json={"confirm": "탈퇴"})
    assert coord.get("/api/hub/withdrawals").json()["requests"] == []
    uid = boss.get("/api/hub/withdrawals").json()["requests"][0]["user_id"]
    assert boss.post(f"/api/hub/withdrawals/{uid}", json={"action": "approve"}).status_code == 200
    # 학생이 아닌 사람(강사 신청만 한 사람)은 바로 탈퇴
    g = login("guest@gmail.com", name="손님")
    assert g.post("/api/me/withdraw", json={"confirm": "탈퇴"}).json()["requested"] is False
    assert g.get("/api/me").json()["user"] is None


def test_teacher_signup_course_fields_and_team_teaching(monkeypatch, tmp_path):
    import app.assignments as asg
    from livekit import api as lk
    monkeypatch.setattr(asg, "FILES_DIR", tmp_path)
    monkeypatch.setattr(auth, "ADMIN_EMAILS", {"boss@gmail.com"})
    boss = login("boss@gmail.com", name="관리자")
    boss.post("/api/admin/schools", json={"text": "가나고등학교\n다라고등학교"})

    def guest(email):
        g = TestClient(app)
        g.post("/api/auth/dev", json={"email": email})
        return g

    base = {"name": "한선생", "contact": "010-1111-2222", "pledge": True, "affil_type": "school",
            "office": "울산광역시교육청", "affiliation": "가나고등학교", "email": "han@use.go.kr"}
    # 관리교사: 거점학교는 울산 학교 목록에서만, 소속 구분별 필수 칸
    coord = guest("coord@gmail.com")
    assert coord.post("/api/staff/apply", json={**base, "role": "coordinator", "hub_name": "가나고"}).status_code == 400
    assert coord.post("/api/staff/apply", json={**base, "role": "coordinator", "hub_name": "가나고등학교", "office": ""}).status_code == 400
    assert coord.post("/api/staff/apply", json={**base, "role": "coordinator", "hub_name": "가나고등학교", "email": "x"}).status_code == 400
    assert coord.post("/api/staff/apply", json={**base, "role": "coordinator", "hub_name": "가나고등학교"}).status_code == 200
    app_ = boss.get("/api/staff/applications", params={"role": "coordinator"}).json()["applications"][0]
    assert app_["office"] == "울산광역시교육청" and app_["affil_type"] == "school" and app_["contact_email"] == "han@use.go.kr"
    boss.post(f"/api/staff/{app_['id']}", json={"action": "approve"})
    hub_id = coord.get("/api/me").json()["user"]["coordinator_hubs"][0]["id"]
    # 강사: 대학 교원(주강사) / 미임용 교원자격 소지자(팀티칭 보조교사)
    prof = guest("prof@univ.ac.kr")
    pform = {**base, "role": "instructor", "hub_id": hub_id, "name": "김교수", "affil_type": "univ", "office": "",
             "affiliation": "", "email": "kim@univ.ac.kr", "wish_from": "2026-03-01", "wish_until": "2099-02-28"}
    assert prof.post("/api/staff/apply", json=pform).status_code == 400  # 대학 이름 필요
    assert prof.post("/api/staff/apply", json={**pform, "affiliation": "울산대학교"}).status_code == 200
    asst = guest("asst@gmail.com")
    aform = {**pform, "name": "이보조", "affil_type": "cert", "email": "lee@gmail.com", "assistant": True}
    assert asst.post("/api/staff/apply", json=aform).status_code == 400  # 교원자격 필요
    assert asst.post("/api/staff/apply", json={**aform, "license": "중등학교 2급 정교사(사회)"}).status_code == 200
    for x in coord.get("/api/staff/applications", params={"role": "instructor"}).json()["applications"]:
        assert coord.post(f"/api/staff/{x['id']}", json={"action": "approve", "valid_until": "2099-02-28"}).status_code == 200
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
