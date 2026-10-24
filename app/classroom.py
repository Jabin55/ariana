"""실시간 수업 서버: 화상(LiveKit) 입장권 발급, 수업 상태(퀴즈·채팅·질문·소그룹) 동기화.

- 화상·음성은 LiveKit 서버가 맡고, 이 서버는 누가 어느 방(전체/모둠)에 들어갈 수 있는지만 정해 입장권(JWT)을 준다.
- 나머지 수업 상태는 메모리에 두고 WebSocket(/ws/live/{code})으로 선생님·학생 화면에 실시간으로 보낸다.
  서버가 다시 시작되면 수업 상태는 사라진다(퀴즈 결과는 CSV로 내려받아 두면 된다).
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import os
import random
import secrets
import time
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel, Field

from livekit import api as lk

log = logging.getLogger("live-class")
router = APIRouter()

LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "")
TEACHER_PASSWORD = os.environ.get("TEACHER_PASSWORD", "")

CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 헷갈리는 0/O, 1/I 제외
MAX_STUDENTS = 60
MAX_GROUPS = 12
MAX_CHAT = 300  # 수업당 보관하는 채팅 수
CHAT_INTERVAL = 0.8  # 학생 채팅 최소 간격(초)
CLASS_IDLE_LIMIT = 12 * 3600  # 아무도 접속하지 않은 수업은 12시간 뒤 정리
TEXT_LIMIT = 500


def livekit_ready() -> bool:
    return bool(LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET)


def clean(text: Any, limit: int = TEXT_LIMIT) -> str:
    return str(text or "").strip()[:limit]


# ───────────────────────── 수업 상태 ─────────────────────────


@dataclass
class Student:
    id: str
    name: str
    key: str
    conns: int = 0
    hand: bool = False
    help: bool = False  # 모둠 활동 중 '선생님 호출'
    can_speak: bool = False  # 마이크 잠금 중에도 말할 수 있게 허락받음
    group: str | None = None
    last_chat: float = 0.0


@dataclass
class Conn:
    ws: WebSocket
    role: str  # "teacher" | "student"
    sid: str | None
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    loop: asyncio.AbstractEventLoop = field(default_factory=asyncio.get_running_loop)
    last_state: str = ""
    chat_room: str | None = None  # 학생이 마지막으로 채팅 기록을 받은 방


@dataclass
class Klass:
    code: str
    title: str
    teacher_key: str
    created: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)
    students: dict[str, Student] = field(default_factory=dict)
    keys: dict[str, str] = field(default_factory=dict)  # 학생 key → id
    conns: list[Conn] = field(default_factory=list)
    chat: list[dict] = field(default_factory=list)
    questions: list[dict] = field(default_factory=list)
    activity: dict | None = None
    history: list[dict] = field(default_factory=list)  # 끝난 활동 (CSV 내보내기용)
    settings: dict = field(default_factory=lambda: {"chat": True, "ai": True, "mic_lock": False})
    groups: list[dict] = field(default_factory=list)  # [{id, name}]
    breakout: bool = False
    ends_at: float | None = None
    announce: dict | None = None
    listening: list[str] = field(default_factory=list)  # 선생님이 듣고 있는 모둠
    talking: str | None = None  # 선생님이 말하고 있는 모둠
    seq: int = 0
    flush_scheduled: bool = False

    def next_id(self) -> str:
        self.seq += 1
        return str(self.seq)

    def room_of(self, s: Student) -> str:
        if self.breakout and s.group and any(g["id"] == s.group for g in self.groups):
            return s.group
        return "main"

    def teacher_online(self) -> bool:
        return any(c.role == "teacher" for c in self.conns)


classes: dict[str, Klass] = {}


def get_class(code: str) -> Klass:
    k = classes.get(code.upper())
    if not k:
        raise HTTPException(404, "수업을 찾을 수 없어요. 코드를 다시 확인해 주세요.")
    return k


def prune_classes() -> None:
    now = time.time()
    for code, k in list(classes.items()):
        if not k.conns and now - k.last_active > CLASS_IDLE_LIMIT:
            classes.pop(code, None)


def new_code() -> str:
    while True:
        code = "".join(random.choices(CODE_CHARS, k=6))
        if code not in classes:
            return code


# ───────────────────────── 화면별 상태 만들기 ─────────────────────────


def activity_counts(a: dict) -> list[int]:
    counts = [0] * len(a["options"])
    for v in a["responses"].values():
        if isinstance(v, int) and 0 <= v < len(counts):
            counts[v] += 1
    return counts


def activity_for_teacher(k: Klass, a: dict | None) -> dict | None:
    if not a:
        return None
    return {
        "id": a["id"], "kind": a["kind"], "prompt": a["prompt"], "options": a["options"],
        "correct": a["correct"], "open": a["open"], "reveal": a["reveal"],
        "counts": activity_counts(a), "total": len(a["responses"]),
        "responses": [
            {"sid": sid, "name": k.students[sid].name if sid in k.students else "(나감)", "value": v}
            for sid, v in a["responses"].items()
        ],
    }


def activity_for_student(a: dict | None, sid: str) -> dict | None:
    if not a:
        return None
    view = {
        "id": a["id"], "kind": a["kind"], "prompt": a["prompt"], "options": a["options"],
        "open": a["open"], "reveal": a["reveal"], "mine": a["responses"].get(sid),
    }
    if a["reveal"]:
        view["correct"] = a["correct"]
        view["counts"] = activity_counts(a)
        view["total"] = len(a["responses"])
        if a["kind"] == "text":
            view["texts"] = [v for v in a["responses"].values() if isinstance(v, str)]
    return view


def teacher_state(k: Klass) -> dict:
    return {
        "t": "state", "role": "teacher", "code": k.code, "title": k.title,
        "settings": k.settings, "livekit": livekit_ready(),
        "students": [
            {"id": s.id, "name": s.name, "online": s.conns > 0, "hand": s.hand,
             "help": s.help, "can_speak": s.can_speak, "group": s.group, "room": k.room_of(s)}
            for s in k.students.values()
        ],
        "groups": k.groups, "breakout": k.breakout, "ends_at": k.ends_at,
        "activity": activity_for_teacher(k, k.activity),
        "history_count": len(k.history),
        "questions": k.questions[-100:],
        "announce": k.announce, "listening": k.listening, "talking": k.talking,
    }


def student_state(k: Klass, s: Student) -> dict:
    room = k.room_of(s)
    group = None
    if room != "main":
        g = next(g for g in k.groups if g["id"] == room)
        group = {
            "id": g["id"], "name": g["name"],
            "members": [m.name for m in k.students.values() if m.group == g["id"]],
        }
    return {
        "t": "state", "role": "student", "code": k.code, "title": k.title,
        "settings": k.settings, "livekit": livekit_ready(),
        "me": {"id": s.id, "name": s.name, "hand": s.hand, "help": s.help, "can_speak": s.can_speak},
        "room": room, "group": group, "breakout": k.breakout, "ends_at": k.ends_at,
        "teacher_online": k.teacher_online(),
        "teacher_listening": room != "main" and (room in k.listening or k.talking == room),
        "teacher_talking": room != "main" and k.talking == room,
        "activity": activity_for_student(k.activity, s.id),
        "announce": k.announce,
        "my_questions": [q for q in k.questions if q["sid"] == s.id][-20:],
        "online_count": sum(1 for m in k.students.values() if m.conns > 0),
    }


def chat_visible(msg: dict, room: str) -> bool:
    return msg["scope"] == room


# ───────────────────────── 전송 ─────────────────────────


def send(conn: Conn, obj: dict | str) -> None:
    data = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    try:
        same_loop = asyncio.get_running_loop() is conn.loop
    except RuntimeError:
        same_loop = False
    if same_loop:
        conn.queue.put_nowait(data)
    else:  # 다른 스레드의 이벤트 루프(테스트 클라이언트 등)에서 부른 경우
        conn.loop.call_soon_threadsafe(conn.queue.put_nowait, data)


def push(k: Klass) -> None:
    """상태가 바뀌었음을 표시한다. 짧은 시간에 여러 번 바뀌면 한 번만 보낸다."""
    if k.flush_scheduled:
        return
    k.flush_scheduled = True
    asyncio.get_running_loop().call_later(0.05, flush, k)


def flush(k: Klass) -> None:
    k.flush_scheduled = False
    tstate = None
    for c in list(k.conns):
        if c.role == "teacher":
            tstate = tstate or json.dumps(teacher_state(k), ensure_ascii=False)
            data = tstate
        else:
            s = k.students.get(c.sid or "")
            if not s:
                continue
            data = json.dumps(student_state(k, s), ensure_ascii=False)
            room = k.room_of(s)
            if c.chat_room != room:
                c.chat_room = room
                send(c, {"t": "chat_init", "msgs": [m for m in k.chat if chat_visible(m, room)][-100:]})
        if data != c.last_state:
            c.last_state = data
            send(c, data)


def post_chat(k: Klass, msg: dict) -> None:
    k.chat.append(msg)
    del k.chat[:-MAX_CHAT]
    for c in k.conns:
        if c.role == "teacher":
            send(c, {"t": "chat", "msg": msg})
        else:
            s = k.students.get(c.sid or "")
            if s and chat_visible(msg, k.room_of(s)):
                send(c, {"t": "chat", "msg": msg})


def send_to_students(k: Klass, obj: dict, sid: str | None = None) -> None:
    for c in k.conns:
        if c.role == "student" and (sid is None or c.sid == sid):
            send(c, obj)


# ───────────────────────── LiveKit 서버 API (방 정리·강퇴) ─────────────────────────


def lk_room_name(code: str, room: str) -> str:
    return f"{code}-{room}"


async def lk_call(fn) -> None:
    if not livekit_ready():
        return
    url = LIVEKIT_URL.replace("wss://", "https://").replace("ws://", "http://")
    try:
        async with lk.LiveKitAPI(url=url, api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET) as api:
            await fn(api)
    except Exception:
        log.warning("LiveKit API 호출 실패", exc_info=True)


def remove_from_livekit(k: Klass, sid: str) -> None:
    rooms = ["main"] + [g["id"] for g in k.groups]

    async def run(api):
        for r in rooms:
            try:
                await api.room.remove_participant(
                    lk.RoomParticipantIdentity(room=lk_room_name(k.code, r), identity=f"s-{sid}"))
            except Exception:
                pass  # 그 방에 없으면 오류가 나므로 무시

    asyncio.create_task(lk_call(run))


def close_livekit_rooms(k: Klass) -> None:
    rooms = ["main"] + [g["id"] for g in k.groups]

    async def run(api):
        for r in rooms:
            try:
                await api.room.delete_room(lk.DeleteRoomRequest(room=lk_room_name(k.code, r)))
            except Exception:
                pass

    asyncio.create_task(lk_call(run))


# ───────────────────────── HTTP API ─────────────────────────


class CreateReq(BaseModel):
    password: str = Field(max_length=200)
    title: str = Field(default="", max_length=60)


class JoinReq(BaseModel):
    name: str = Field(min_length=1, max_length=20)
    key: str | None = Field(default=None, max_length=100)


class TokenReq(BaseModel):
    key: str = Field(max_length=100)
    room: str = Field(max_length=10)


@router.post("/api/live/classes")
async def create_class(req: CreateReq):
    if not TEACHER_PASSWORD:
        raise HTTPException(503, "서버에 TEACHER_PASSWORD 환경 변수가 설정되지 않았어요.")
    if not secrets.compare_digest(req.password.encode(), TEACHER_PASSWORD.encode()):
        await asyncio.sleep(1)  # 비밀번호 무작위 대입을 늦춘다
        raise HTTPException(403, "선생님 비밀번호가 맞지 않아요.")
    prune_classes()
    code = new_code()
    k = Klass(code=code, title=clean(req.title, 60) or "실시간 수업", teacher_key=secrets.token_urlsafe(24))
    classes[code] = k
    return {"code": code, "teacher_key": k.teacher_key, "title": k.title}


@router.get("/api/live/classes/{code}")
async def class_info(code: str):
    k = get_class(code)
    return {"code": k.code, "title": k.title, "livekit": livekit_ready()}


@router.post("/api/live/classes/{code}/join")
async def join_class(code: str, req: JoinReq):
    k = get_class(code)
    if req.key and req.key in k.keys:  # 새로고침·재접속
        s = k.students[k.keys[req.key]]
        s.name = clean(req.name, 20) or s.name
        push(k)
        return {"student_id": s.id, "key": s.key, "name": s.name}
    if len(k.students) >= MAX_STUDENTS:
        raise HTTPException(409, "수업 인원이 가득 찼어요.")
    name = clean(req.name, 20)
    if not name:
        raise HTTPException(400, "이름을 입력해 주세요.")
    s = Student(id=k.next_id(), name=name, key=secrets.token_urlsafe(18))
    if k.breakout and k.groups:  # 모둠 활동 중에 들어오면 인원이 가장 적은 모둠으로
        s.group = smallest_group(k)
    k.students[s.id] = s
    k.keys[s.key] = s.id
    k.last_active = time.time()
    push(k)
    return {"student_id": s.id, "key": s.key, "name": s.name}


@router.post("/api/live/classes/{code}/token")
async def livekit_token(code: str, req: TokenReq):
    k = get_class(code)
    if not livekit_ready():
        raise HTTPException(503, "화상 서버(LiveKit)가 아직 설정되지 않았어요.")
    if req.key == k.teacher_key:
        if req.room != "main" and not any(g["id"] == req.room for g in k.groups):
            raise HTTPException(404, "없는 모둠이에요.")
        identity, name, role = "teacher", "선생님", "teacher"
        sources = ["camera", "microphone", "screen_share", "screen_share_audio"]
    elif req.key in k.keys:
        s = k.students[k.keys[req.key]]
        if req.room != k.room_of(s):
            raise HTTPException(403, "지금은 그 방에 들어갈 수 없어요.")
        identity, name, role = f"s-{s.id}", s.name, "student"
        sources = ["camera", "microphone"]
        if req.room != "main":  # 모둠에서는 화면 공유로 발표할 수 있게
            sources += ["screen_share", "screen_share_audio"]
    else:
        raise HTTPException(403, "입장 정보가 올바르지 않아요.")

    grants = lk.VideoGrants(
        room_join=True, room=lk_room_name(k.code, req.room),
        can_publish=True, can_subscribe=True, can_publish_data=False,
        can_publish_sources=sources, room_admin=(role == "teacher"),
    )
    token = (
        lk.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity).with_name(name)
        .with_attributes({"role": role})
        .with_grants(grants).with_ttl(timedelta(hours=6))
        .to_jwt()
    )
    return {"url": LIVEKIT_URL, "token": token, "room": req.room}


@router.get("/api/live/classes/{code}/results.csv")
async def results_csv(code: str, key: str):
    k = get_class(code)
    if not secrets.compare_digest(key.encode(), k.teacher_key.encode()):
        raise HTTPException(403, "선생님만 내려받을 수 있어요.")
    acts = k.history + ([k.activity] if k.activity else [])
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["활동 번호", "유형", "문제", "이름", "응답", "정답 여부"])
    kinds = {"ox": "OX", "choice": "객관식", "poll": "투표", "text": "주관식"}
    for i, a in enumerate(acts, 1):
        for sid, v in a["responses"].items():
            name = k.students[sid].name if sid in k.students else "(나감)"
            shown = a["options"][v] if isinstance(v, int) and v < len(a["options"]) else v
            ok = "" if a["correct"] is None else ("O" if v == a["correct"] else "X")
            w.writerow([i, kinds.get(a["kind"], a["kind"]), a["prompt"], name, shown, ok])
    data = "﻿" + buf.getvalue()  # 엑셀에서 한글이 깨지지 않게 BOM
    return Response(data, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{k.code}-results.csv"'})


# ───────────────────────── 모둠 ─────────────────────────


def smallest_group(k: Klass) -> str:
    sizes = {g["id"]: 0 for g in k.groups}
    for s in k.students.values():
        if s.group in sizes:
            sizes[s.group] += 1
    return min(sizes, key=lambda gid: (sizes[gid], gid))


def plan_groups(k: Klass, n: int) -> None:
    n = max(1, min(MAX_GROUPS, n))
    k.groups = [{"id": f"g{i}", "name": f"{i}모둠"} for i in range(1, n + 1)]
    members = [s for s in k.students.values() if s.conns > 0] or list(k.students.values())
    random.shuffle(members)
    for s in k.students.values():
        s.group = None
    for i, s in enumerate(members):
        s.group = k.groups[i % n]["id"]


# ───────────────────────── WebSocket ─────────────────────────


@router.websocket("/ws/live/{code}")
async def live_socket(ws: WebSocket, code: str, key: str = ""):
    await ws.accept()
    k = classes.get(code.upper())
    if not k:
        await ws.send_text(json.dumps({"t": "error", "code": "no_class", "text": "수업이 끝났거나 없는 수업이에요."}))
        await ws.close()
        return
    if key and secrets.compare_digest(key.encode(), k.teacher_key.encode()):
        conn = Conn(ws=ws, role="teacher", sid=None)
    elif key in k.keys:
        conn = Conn(ws=ws, role="student", sid=k.keys[key])
    else:
        await ws.send_text(json.dumps({"t": "error", "code": "bad_key", "text": "입장 정보가 올바르지 않아요."}))
        await ws.close()
        return

    async def writer():
        try:
            while True:
                data = await conn.queue.get()
                try:
                    await ws.send_text(data)
                finally:
                    conn.queue.task_done()
        except Exception:
            pass

    writer_task = asyncio.create_task(writer())
    send(conn, {"t": "hello", "now": time.time(), "role": conn.role})
    k.conns.append(conn)
    k.last_active = time.time()
    if conn.role == "student":
        k.students[conn.sid].conns += 1
    else:
        send(conn, {"t": "chat_init", "msgs": k.chat[-200:]})
    flush(k)  # 접속하자마자 현재 상태를 보낸다
    if conn.role == "teacher":
        push(k)  # 학생들에게 '선생님 접속' 반영

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("t") == "ping":
                send(conn, {"t": "pong", "now": time.time()})
                continue
            if conn.sid and conn.sid not in k.students:
                break  # 강퇴됨
            k.last_active = time.time()
            if conn.role == "teacher":
                handle_teacher(k, conn, msg)
            else:
                handle_student(k, k.students[conn.sid], msg)
            if code.upper() not in classes:
                break  # 수업 종료됨
            push(k)
        # 강퇴·수업 종료로 끝난 경우: 마지막 안내 메시지를 보낸 뒤 닫는다
        try:
            await asyncio.wait_for(conn.queue.join(), 2)
            await ws.close()
        except Exception:
            pass
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("WebSocket 처리 중 오류")
    finally:
        writer_task.cancel()
        if conn in k.conns:
            k.conns.remove(conn)
        s = k.students.get(conn.sid or "")
        if s:
            s.conns = max(0, s.conns - 1)
        if conn.role == "teacher" and not k.teacher_online():
            k.listening, k.talking = [], None
        k.last_active = time.time()
        if code.upper() in classes:
            push(k)


def handle_student(k: Klass, s: Student, m: dict) -> None:
    t = m.get("t")
    if t == "hand":
        s.hand = bool(m.get("up"))
    elif t == "help":
        s.help = bool(m.get("on")) and k.room_of(s) != "main"
    elif t == "chat":
        text = clean(m.get("text"))
        now = time.time()
        if not text or not k.settings["chat"] or now - s.last_chat < CHAT_INTERVAL:
            return
        s.last_chat = now
        post_chat(k, {"id": k.next_id(), "role": "student", "sid": s.id, "name": s.name,
                      "text": text, "scope": k.room_of(s), "ts": now})
    elif t == "question":
        text = clean(m.get("text"))
        if text:
            k.questions.append({"id": k.next_id(), "sid": s.id, "name": s.name, "text": text,
                                "ts": time.time(), "done": False, "reply": ""})
            del k.questions[:-300]
    elif t == "answer":
        a = k.activity
        if not a or not a["open"] or m.get("id") != a["id"]:
            return
        v = m.get("value")
        if a["kind"] == "text":
            v = clean(v, 300)
            if not v:
                return
        elif not (isinstance(v, int) and 0 <= v < len(a["options"])):
            return
        a["responses"][s.id] = v


def handle_teacher(k: Klass, conn: Conn, m: dict) -> None:
    t = m.get("t")
    if t == "settings":
        for name in ("chat", "ai", "mic_lock"):
            if name in m:
                k.settings[name] = bool(m[name])
        if m.get("mic_lock"):
            for s in k.students.values():
                s.can_speak = False
            send_to_students(k, {"t": "cmd", "cmd": "mute"})
    elif t == "cmd":  # 학생 기기 제어(음소거·카메라 끄기)
        cmd = m.get("cmd")
        if cmd in ("mute", "cam_off"):
            target = m.get("target")
            send_to_students(k, {"t": "cmd", "cmd": cmd}, None if target == "all" else str(target))
    elif t == "allow_mic":  # 마이크 잠금 중 발언권 주기/거두기
        s = k.students.get(str(m.get("target")))
        if s:
            s.can_speak = bool(m.get("on"))
            if s.can_speak:
                s.hand = False
            else:
                send_to_students(k, {"t": "cmd", "cmd": "mute"}, s.id)
    elif t == "lower_hand":
        target = m.get("target")
        for s in k.students.values():
            if target == "all" or s.id == target:
                s.hand = False
    elif t == "kick":
        s = k.students.pop(str(m.get("target")), None)
        if s:
            k.keys.pop(s.key, None)
            send_to_students(k, {"t": "kicked"}, s.id)
            remove_from_livekit(k, s.id)
    elif t == "announce":
        text = clean(m.get("text"))
        k.announce = {"id": k.next_id(), "text": text, "ts": time.time()} if text else None
    elif t == "chat":
        text = clean(m.get("text"))
        scope = m.get("scope") or "main"
        scopes = ["main"] + [g["id"] for g in k.groups]
        if text and scope in scopes:
            post_chat(k, {"id": k.next_id(), "role": "teacher", "sid": None, "name": "선생님",
                          "text": text, "scope": scope, "ts": time.time()})
    elif t == "broadcast":  # 모든 방 채팅에 같은 공지
        text = clean(m.get("text"))
        if text:
            for scope in ["main"] + [g["id"] for g in k.groups]:
                post_chat(k, {"id": k.next_id(), "role": "teacher", "sid": None, "name": "선생님",
                              "text": text, "scope": scope, "ts": time.time(), "broadcast": True})
    elif t == "question_update":
        for q in k.questions:
            if q["id"] == m.get("id"):
                if "done" in m:
                    q["done"] = bool(m["done"])
                if "reply" in m:
                    q["reply"] = clean(m["reply"])
    elif t == "activity_start":
        start_activity(k, m)
    elif t == "activity_close" and k.activity:
        k.activity["open"] = False
    elif t == "activity_reopen" and k.activity:
        k.activity["open"] = True
    elif t == "activity_reveal" and k.activity:
        k.activity["reveal"] = bool(m.get("on"))
    elif t == "activity_clear" and k.activity:
        k.history.append(k.activity)
        k.activity = None
    elif t == "breakout_plan":
        plan_groups(k, int(m.get("n") or 2))
    elif t == "breakout_rename":
        for g in k.groups:
            if g["id"] == m.get("group"):
                g["name"] = clean(m.get("name"), 20) or g["name"]
    elif t == "breakout_assign":
        s = k.students.get(str(m.get("target")))
        gid = m.get("group")
        if s and (gid is None or any(g["id"] == gid for g in k.groups)):
            s.group = gid
            s.help = False
    elif t == "breakout_start":
        if not k.groups:
            plan_groups(k, int(m.get("n") or 4))
        for s in k.students.values():  # 배정되지 않은 학생은 인원이 적은 모둠으로
            if not s.group or not any(g["id"] == s.group for g in k.groups):
                s.group = smallest_group(k)
        k.breakout = True
        minutes = m.get("minutes")
        k.ends_at = time.time() + float(minutes) * 60 if minutes else None
    elif t == "breakout_time":
        minutes = m.get("minutes")
        k.ends_at = time.time() + float(minutes) * 60 if minutes else None
    elif t == "breakout_end":
        k.breakout = False
        k.ends_at = None
        k.listening, k.talking = [], None
        for s in k.students.values():
            s.help = False
    elif t == "listen":
        ids = {g["id"] for g in k.groups}
        k.listening = [g for g in (m.get("groups") or []) if g in ids]
        talking = m.get("talking")
        k.talking = talking if talking in ids else None
        if k.talking:  # 선생님이 들어가면 호출 표시를 끈다
            for s in k.students.values():
                if s.group == k.talking:
                    s.help = False
    elif t == "help_clear":
        for s in k.students.values():
            if s.group == m.get("group"):
                s.help = False
    elif t == "end_class":
        send_to_students(k, {"t": "ended"})
        for c in k.conns:
            if c.role == "teacher":
                send(c, {"t": "ended"})
        close_livekit_rooms(k)
        classes.pop(k.code, None)


def start_activity(k: Klass, m: dict) -> None:
    kind = m.get("kind")
    prompt = clean(m.get("prompt"), 300)
    if kind == "ox":
        options = ["O", "X"]
    elif kind in ("choice", "poll"):
        options = [clean(o, 100) for o in (m.get("options") or []) if clean(o, 100)][:8]
        if len(options) < 2:
            return
    elif kind == "text":
        options = []
    else:
        return
    correct = m.get("correct")
    if kind in ("poll", "text") or not (isinstance(correct, int) and 0 <= correct < len(options)):
        correct = None
    if k.activity:
        k.history.append(k.activity)
    k.activity = {"id": k.next_id(), "kind": kind, "prompt": prompt or "질문", "options": options,
                  "correct": correct, "open": True, "reveal": False, "responses": {}}
