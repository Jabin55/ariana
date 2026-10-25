"""실시간 수업 서버: 화상(LiveKit) 입장권 발급, 수업 상태(퀴즈·채팅·질문·모둠) 동기화, 출결 기록.

- 화상·음성은 LiveKit 서버가 맡고, 이 서버는 누가 어느 방(전체/모둠)에 들어갈 수 있는지만 정해 입장권(JWT)을 준다.
- 진행 중인 수업 상태는 메모리에 두고 WebSocket(/ws/live/{code})으로 선생님·학생 화면에 실시간으로 보낸다.
- 수업 목록·출결·퀴즈 결과는 DB에 남는다. 서버가 다시 시작돼도 같은 코드로 수업이 이어진다
  (진행 중이던 채팅·질문은 사라지고, 학생들은 자동으로 다시 접속한다).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import insert, select, update

from livekit import api as lk

from app import db
from app.auth import current_user, display_name, needs_profile, require_user
from app.courses import is_enrolled, owned_course

log = logging.getLogger("live-class")
router = APIRouter()

LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "")

CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 헷갈리는 0/O, 1/I 제외
MAX_STUDENTS = 60
MAX_GROUPS = 12
MAX_CHAT = 300  # 수업당 보관하는 채팅 수
CHAT_INTERVAL = 0.8  # 학생 채팅 최소 간격(초)
CLASS_REVIVE_LIMIT = 24 * 3600  # 서버 재시작 뒤 이 시간 안에 만든 수업은 같은 코드로 이어진다
MEMORY_IDLE_LIMIT = 3 * 3600  # 아무도 없는 수업은 메모리에서 내린다(DB에는 남음)
HEARTBEAT = 60  # 접속 중인 학생의 '마지막 확인 시각'을 DB에 적는 간격(초)
# 화면은 20초마다 신호를 보낸다. 이 시간 동안 아무 신호가 없으면 인터넷이 끊긴 것으로 본다.
# (백그라운드 탭은 브라우저가 타이머를 1분 간격까지 늦출 수 있어 여유를 둔다)
SILENCE_LIMIT = 70
# 같은 학생이 새로 연결했을 때, 이만큼 조용하던 옛 연결은 끊긴 것으로 바로 정리한다
STALE_AFTER = 30
TEXT_LIMIT = 500
# 저대역폭 모드 기본값: 전체 교실에서는 학생 카메라를 끄고(모둠 활동 때만 허용) 영상 화질을 낮춘다.
# 화상 서버 데이터 비용과 학생 휴대폰 데이터를 크게 줄인다. LOW_BANDWIDTH=0 이면 기본으로 끔.
LOW_BANDWIDTH_DEFAULT = os.environ.get("LOW_BANDWIDTH", "1") != "0"


def livekit_ready() -> bool:
    return bool(LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET)


def clean(text: Any, limit: int = TEXT_LIMIT) -> str:
    return str(text or "").strip()[:limit]


# ───────────────────────── 수업 상태 ─────────────────────────


@dataclass
class Student:
    id: str  # 사용자 id (문자열)
    name: str  # 화면에 보이는 이름 (예: 20315 김민준)
    conns: int = 0
    hand: bool = False
    help: bool = False  # 모둠 활동 중 '선생님 호출'
    can_speak: bool = False  # 마이크 잠금 중에도 말할 수 있게 허락받음
    group: str | None = None
    last_chat: float = 0.0
    att_id: int | None = None  # 지금 열려 있는 출결 기록
    sessions: int = 0  # 이 수업에 들어온 횟수 (2 이상이면 재입장)


@dataclass
class Conn:
    ws: WebSocket
    role: str  # "teacher" | "student"
    sid: str | None
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    loop: asyncio.AbstractEventLoop = field(default_factory=asyncio.get_running_loop)
    last_state: str = ""
    chat_room: str | None = None  # 학생이 마지막으로 채팅 기록을 받은 방
    kicked_student: Student | None = None  # 강퇴된 학생 (연결이 끊길 때 출결을 닫기 위함)
    last_recv: float = field(default_factory=time.time)  # 학생 기기에서 마지막으로 신호가 온 시각
    leave_reason: str | None = None
    evicted: bool = False  # 새 연결이 들어와 끊긴 것으로 정리됨


@dataclass
class Klass:
    db_id: int
    code: str
    title: str
    teacher_id: int
    created: float = field(default_factory=time.time)
    course_id: int | None = None  # 강좌 수업이면 승인된 수강생만 들어올 수 있다
    last_active: float = field(default_factory=time.time)
    students: dict[str, Student] = field(default_factory=dict)
    banned: set[str] = field(default_factory=set)
    conns: list[Conn] = field(default_factory=list)
    chat: list[dict] = field(default_factory=list)
    questions: list[dict] = field(default_factory=list)
    activity: dict | None = None
    settings: dict = field(default_factory=lambda: {
        "chat": True, "ai": True, "mic_lock": False, "lowbw": LOW_BANDWIDTH_DEFAULT})
    groups: list[dict] = field(default_factory=list)  # [{id, name}]
    breakout: bool = False
    ends_at: float | None = None
    announce: dict | None = None
    listening: list[str] = field(default_factory=list)  # 선생님이 듣고 있는 모둠
    talking: str | None = None  # 선생님이 말하고 있는 모둠
    broadcasting: bool = False  # 선생님이 모든 방에 동시에 말하는 중
    events: list[dict] = field(default_factory=list)  # 최근 입·퇴장 (선생님 화면 알림용)
    seq: int = 0
    flush_scheduled: bool = False
    flush_at: float = 0.0

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


def _load_class(code: str):
    with db.engine.connect() as c:
        return c.execute(
            select(db.classes)
            .where(db.classes.c.code == code, db.classes.c.ended_at.is_(None),
                   db.classes.c.created_at > time.time() - CLASS_REVIVE_LIMIT)
            .order_by(db.classes.c.id.desc())
        ).first()


async def get_class(code: str) -> Klass:
    code = code.upper()
    k = classes.get(code)
    if k:
        return k
    row = await db.run(_load_class, code) if code.isalnum() and len(code) <= 8 else None
    if not row:
        raise HTTPException(404, "수업을 찾을 수 없어요. 코드를 다시 확인해 주세요.")
    saved_questions = await db.run(_load_questions, row.id)  # 서버가 다시 켜져도 질문답변은 이어진다
    k = classes.get(code)  # 기다리는 사이 다른 요청이 먼저 살렸을 수 있다
    if not k:
        k = Klass(db_id=row.id, code=row.code, title=row.title, teacher_id=row.teacher_id, created=row.created_at,
                  course_id=row.course_id)
        k.questions = saved_questions
        classes[code] = k
    return k


def prune_classes() -> None:
    now = time.time()
    for code, k in list(classes.items()):
        if not k.conns and now - k.last_active > MEMORY_IDLE_LIMIT:
            classes.pop(code, None)


def _code_taken(code: str) -> bool:
    with db.engine.connect() as c:
        return c.execute(select(db.classes.c.id).where(
            db.classes.c.code == code, db.classes.c.ended_at.is_(None),
            db.classes.c.created_at > time.time() - CLASS_REVIVE_LIMIT)).first() is not None


async def new_code() -> str:
    while True:
        code = "".join(random.choices(CODE_CHARS, k=6))
        if code not in classes and not await db.run(_code_taken, code):
            return code


# ───────────────────────── DB 기록 (출결·활동) ─────────────────────────


def _att_open(class_id: int, user_id: int) -> int:
    now = time.time()
    with db.engine.begin() as c:
        return c.execute(insert(db.attendance).values(
            class_id=class_id, user_id=user_id, joined_at=now, last_seen=now)).inserted_primary_key[0]


def _att_close(att_id: int, at: float, reason: str) -> None:
    with db.engine.begin() as c:
        c.execute(update(db.attendance).where(db.attendance.c.id == att_id)
                  .values(left_at=at, last_seen=at, left_reason=reason))


def log_event(k: Klass, s: Student, kind: str, reason: str | None = None, ts: float | None = None) -> None:
    k.events.append({"ts": ts or time.time(), "sid": s.id, "name": s.name, "kind": kind, "reason": reason})
    del k.events[:-100]


def drop_conn(k: Klass, conn: Conn, s: Student | None) -> None:
    """연결 하나가 끝났을 때: 그 학생의 마지막 연결이었으면 출결을 닫는다."""
    if conn in k.conns:
        k.conns.remove(conn)
    if not s:
        return
    s.conns = max(0, s.conns - 1)
    if s.conns or not s.att_id:
        return
    att_id, s.att_id = s.att_id, None
    reason = conn.leave_reason or "closed"
    # 연결이 끊긴 경우 실제로 나간 시각은 마지막으로 신호를 받은 때다
    at = conn.last_recv if reason == "network" else time.time()
    log_event(k, s, "leave", reason, at)
    if classes.get(k.code) is k:
        flush(k)  # 선생님 화면에 바로 알린다
    # 기다리지 않고 별도 스레드에 맡긴다: 연결 처리 작업이 취소돼도(서버 종료 등) 기록은 끝까지 저장된다
    fut = asyncio.get_running_loop().run_in_executor(None, _att_close, att_id, at, reason)
    fut.add_done_callback(lambda f: f.exception() and log.warning("출결 기록 실패: %s", f.exception()))


def evict_stale(k: Klass, sid: str) -> None:
    """같은 학생이 새로 연결했는데 옛 연결이 한동안 조용했다면 인터넷이 끊겼던 것이다."""
    now = time.time()
    for old in [c for c in k.conns if c.sid == sid and now - c.last_recv > STALE_AFTER]:
        old.evicted = True
        old.leave_reason = "network"
        drop_conn(k, old, k.students.get(sid))

        async def close(ws=old.ws):
            try:
                await ws.close()
            except Exception:
                pass

        asyncio.get_running_loop().create_task(close())


def _att_touch(ids: list[int]) -> None:
    with db.engine.begin() as c:
        c.execute(update(db.attendance).where(db.attendance.c.id.in_(ids)).values(last_seen=time.time()))


async def heartbeat_loop() -> None:
    while True:
        await asyncio.sleep(HEARTBEAT)
        ids = [s.att_id for k in classes.values() for s in k.students.values() if s.att_id and s.conns]
        if ids:
            try:
                await db.run(_att_touch, ids)
            except Exception:
                log.warning("출결 갱신 실패", exc_info=True)
        prune_classes()


# 질문 저장은 한 줄로 세운 스레드 하나가 순서대로 처리한다(답변이 질문보다 먼저 저장되는 일이 없도록)
_question_writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="question-writer")


def write_question(fn, *args) -> None:
    fut = _question_writer.submit(fn, *args)
    fut.add_done_callback(lambda f: f.exception() and log.warning("질문 저장 실패: %s", f.exception()))


def _question_insert(class_id: int, user_id: int, q: dict) -> None:
    with db.engine.begin() as c:
        c.execute(insert(db.questions).values(
            uid=q["id"], class_id=class_id, user_id=user_id, text=q["text"],
            reply="", done=0, created_at=q["ts"]))


def _question_update(uid: str, values: dict) -> None:
    with db.engine.begin() as c:
        c.execute(update(db.questions).where(db.questions.c.uid == uid).values(**values))


def _load_questions(class_id: int) -> list[dict]:
    with db.engine.connect() as c:
        rows = c.execute(
            select(db.questions, db.users).join(db.users, db.users.c.id == db.questions.c.user_id)
            .where(db.questions.c.class_id == class_id).order_by(db.questions.c.created_at)
        ).all()
    out = []
    for r in rows:
        m = dict(r._mapping)
        out.append({"id": m["uid"], "sid": str(m["user_id"]), "name": display_name(m), "text": m["text"],
                    "ts": m["created_at"], "done": bool(m["done"]), "reply": m["reply"] or ""})
    return out[-300:]


def save_activity(k: Klass, a: dict | None) -> None:
    """활동(퀴즈·투표) 결과를 DB에 저장한다. 같은 활동은 덮어쓴다."""
    if not a or (not a["responses"] and a.get("db_id") is None):
        return
    values = {
        "class_id": k.db_id, "kind": a["kind"], "prompt": a["prompt"],
        "options": json.dumps(a["options"], ensure_ascii=False), "correct": a["correct"],
        "responses": json.dumps(a["responses"], ensure_ascii=False), "created_at": a["created"],
    }

    def run():
        with db.engine.begin() as c:
            if a.get("db_id"):
                c.execute(update(db.activities).where(db.activities.c.id == a["db_id"]).values(**values))
            else:
                a["db_id"] = c.execute(insert(db.activities).values(**values)).inserted_primary_key[0]

    async def task():
        try:
            await db.run(run)
        except Exception:
            log.warning("활동 결과 저장 실패", exc_info=True)

    asyncio.get_running_loop().create_task(task())


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
        "t": "state", "role": "teacher", "code": k.code, "title": k.title, "class_id": k.db_id,
        "course_id": k.course_id,
        "settings": k.settings, "livekit": livekit_ready(),
        "students": [
            {"id": s.id, "name": s.name, "online": s.conns > 0, "hand": s.hand,
             "help": s.help, "can_speak": s.can_speak, "group": s.group, "room": k.room_of(s),
             "sessions": s.sessions}
            for s in k.students.values()
        ],
        "groups": k.groups, "breakout": k.breakout, "ends_at": k.ends_at,
        "activity": activity_for_teacher(k, k.activity),
        "questions": k.questions[-100:],
        "announce": k.announce, "listening": k.listening, "talking": k.talking,
        "broadcasting": k.broadcasting,
        "events": k.events[-50:],
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
        "teacher_broadcast": k.broadcasting,
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
    now = time.time()
    if k.flush_scheduled and now - k.flush_at < 1:  # 1초가 넘게 안 보내졌으면 예약이 사라진 것으로 보고 다시 예약
        return
    k.flush_scheduled = True
    k.flush_at = now
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


SOURCE_ENUM = {
    "camera": lk.TrackSource.CAMERA, "microphone": lk.TrackSource.MICROPHONE,
    "screen_share": lk.TrackSource.SCREEN_SHARE, "screen_share_audio": lk.TrackSource.SCREEN_SHARE_AUDIO,
}


def student_sources(k: Klass, s: Student, room: str) -> list[str]:
    """학생이 그 방에서 내보낼 수 있는 것. 화상 서버가 강제하므로 학생 화면을 고쳐도 우회할 수 없다."""
    if room != "main":  # 모둠: 카메라·마이크·화면 공유(발표) 모두 가능
        return ["camera", "microphone", "screen_share", "screen_share_audio"]
    out = []
    if not (k.settings["mic_lock"] and not s.can_speak):
        out.append("microphone")
    if not (k.settings["lowbw"] and not s.can_speak):  # 저대역폭 모드: 발언권 받은 학생만 카메라
        out.append("camera")
    return out


def enforce_sources(k: Klass, students: list[Student] | None = None) -> None:
    """설정이 바뀌면 전체 교실에 있는 학생들의 권한을 화상 서버에 바로 반영한다.
    권한이 없어진 카메라·마이크는 화상 서버가 즉시 끊는다."""
    targets = [(s.id, student_sources(k, s, "main"))
               for s in (students if students is not None else list(k.students.values()))
               if k.room_of(s) == "main" and s.conns]
    if not targets or not livekit_ready():
        return
    room = lk_room_name(k.code, "main")

    async def run(api):
        async def one(sid: str, src: list[str]):
            # 목록이 비면 '모두 허용'으로 해석되므로 그때는 아예 내보내기를 막는다
            perm = lk.ParticipantPermission(
                can_subscribe=True, can_publish=bool(src), can_publish_data=False,
                can_publish_sources=[SOURCE_ENUM[x] for x in src])
            try:
                await api.room.update_participant(
                    lk.UpdateParticipantRequest(room=room, identity=f"s-{sid}", permission=perm))
            except Exception:
                pass  # 아직 화상에 들어오지 않은 학생

        await asyncio.gather(*(one(sid, src) for sid, src in targets))

    asyncio.get_running_loop().create_task(lk_call(run))


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
    title: str = Field(default="", max_length=60)
    course_id: int | None = None  # 강좌 수업: 승인된 수강생은 코드 없이 들어온다
    target_grade: int | None = Field(default=None, ge=1, le=6)
    target_class: int | None = Field(default=None, ge=1, le=30)


class TokenReq(BaseModel):
    room: str = Field(max_length=10)


@router.post("/api/live/classes")
async def create_class(req: CreateReq, request: Request):
    t = await require_user(request, "teacher")
    if req.course_id is not None:
        course = await db.run(owned_course, req.course_id, t)
        if course.archived:
            raise HTTPException(409, "보관된 강좌에는 수업을 열 수 없어요.")
    prune_classes()
    code = await new_code()
    title = clean(req.title, 60) or "실시간 수업"

    def run():
        with db.engine.begin() as c:
            return c.execute(insert(db.classes).values(
                code=code, title=title, teacher_id=t["id"], school=t["school"] or "",
                target_grade=req.target_grade, target_class=req.target_class, created_at=time.time(),
                course_id=req.course_id,
            )).inserted_primary_key[0]

    class_id = await db.run(run)
    classes[code] = Klass(db_id=class_id, code=code, title=title, teacher_id=t["id"], course_id=req.course_id)
    return {"code": code, "title": title, "class_id": class_id}


@router.get("/api/live/classes/{code}")
async def class_info(code: str):
    k = await get_class(code)
    return {"code": k.code, "title": k.title, "livekit": livekit_ready()}


def add_student(k: Klass, u: dict) -> Student:
    sid = str(u["id"])
    if sid in k.banned:
        raise HTTPException(403, "선생님이 이 수업에서 내보냈어요.")
    s = k.students.get(sid)
    if s:
        s.name = display_name(u)
        return s
    if len(k.students) >= MAX_STUDENTS:
        raise HTTPException(409, "수업 인원이 가득 찼어요.")
    s = Student(id=sid, name=display_name(u))
    if k.breakout and k.groups:  # 모둠 활동 중에 들어오면 인원이 가장 적은 모둠으로
        s.group = smallest_group(k)
    k.students[sid] = s
    return s


async def ensure_enrolled(k: Klass, u: dict) -> None:
    """강좌 수업이면 수강 승인된 학생만 들어온다(코드를 알아도 안 됨)."""
    if k.course_id and not await db.run(is_enrolled, k.course_id, u["id"]):
        raise HTTPException(403, "이 강좌에 수강신청이 승인된 학생만 들어올 수 있어요.")


@router.post("/api/live/classes/{code}/join")
async def join_class(code: str, request: Request):
    u = await require_user(request, "student")
    k = await get_class(code)
    await ensure_enrolled(k, u)
    s = add_student(k, u)
    k.last_active = time.time()
    push(k)
    return {"student_id": s.id, "name": s.name}


@router.post("/api/live/classes/{code}/token")
async def livekit_token(code: str, req: TokenReq, request: Request):
    u = await require_user(request)
    k = await get_class(code)
    if not livekit_ready():
        raise HTTPException(503, "화상 서버(LiveKit)가 아직 설정되지 않았어요.")
    if u["role"] == "teacher" and u["id"] == k.teacher_id:
        if req.room != "main" and not any(g["id"] == req.room for g in k.groups):
            raise HTTPException(404, "없는 모둠이에요.")
        identity, name, role = "teacher", "선생님", "teacher"
        sources = ["camera", "microphone", "screen_share", "screen_share_audio"]
    elif u["role"] == "student" and str(u["id"]) in k.students:
        s = k.students[str(u["id"])]
        if req.room != k.room_of(s):
            raise HTTPException(403, "지금은 그 방에 들어갈 수 없어요.")
        identity, name, role = f"s-{s.id}", s.name, "student"
        sources = student_sources(k, s, req.room)
    else:
        raise HTTPException(403, "이 수업에 들어갈 수 없어요.")

    grants = lk.VideoGrants(
        room_join=True, room=lk_room_name(k.code, req.room),
        # 목록이 비면 '모두 허용'으로 해석되므로 그때는 아예 내보내기를 막는다
        can_publish=bool(sources), can_subscribe=True, can_publish_data=False,
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


def same_origin(ws: WebSocket) -> bool:
    """다른 사이트가 학생의 로그인 쿠키로 몰래 접속하지 못하게 출처를 확인한다."""
    origin = ws.headers.get("origin")
    return not origin or urlparse(origin).netloc == ws.headers.get("host")


async def reject(ws: WebSocket, code: str, text: str) -> None:
    await ws.send_text(json.dumps({"t": "error", "code": code, "text": text}, ensure_ascii=False))
    await ws.close()


@router.websocket("/ws/live/{code}")
async def live_socket(ws: WebSocket, code: str):
    await ws.accept()
    if not same_origin(ws):
        return await reject(ws, "bad_origin", "잘못된 접근이에요.")
    try:
        k = await get_class(code)
    except HTTPException:
        return await reject(ws, "no_class", "수업이 끝났거나 없는 수업이에요.")
    u = await current_user(ws)
    if not u:
        return await reject(ws, "login", "로그인이 필요해요.")
    if u["role"] == "teacher" and u["id"] == k.teacher_id:
        conn = Conn(ws=ws, role="teacher", sid=None)
    elif u["role"] == "student" and not needs_profile(u):
        try:
            await ensure_enrolled(k, u)
            s = add_student(k, u)
        except HTTPException as e:
            return await reject(ws, "denied", e.detail)
        conn = Conn(ws=ws, role="student", sid=s.id)
    else:
        return await reject(ws, "denied", "이 수업에 들어갈 수 없어요.")

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
    if conn.role == "student":
        evict_stale(k, conn.sid)
    k.conns.append(conn)
    k.last_active = time.time()
    if conn.role == "student":
        s = k.students[conn.sid]
        s.conns += 1
        if s.conns == 1 and not s.att_id:  # 출결: 접속 시작
            s.sessions += 1
            log_event(k, s, "rejoin" if s.sessions > 1 else "join")
            try:
                s.att_id = await db.run(_att_open, k.db_id, int(s.id))
            except Exception:
                log.warning("출결 기록 실패", exc_info=True)
    else:
        send(conn, {"t": "chat_init", "msgs": k.chat[-200:]})
    flush(k)  # 접속하자마자 현재 상태를 보낸다
    push(k)

    try:
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), SILENCE_LIMIT)
            except asyncio.TimeoutError:
                conn.leave_reason = "network"  # 기기가 꺼졌거나 인터넷이 끊김
                break
            conn.last_recv = time.time()
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
            if msg.get("t") == "leave":  # 학생이 '나가기'를 눌렀다 (곧 연결을 끊는다)
                conn.leave_reason = "leave"
                continue
            k.last_active = time.time()
            if conn.role == "teacher":
                handle_teacher(k, conn, msg)
            else:
                handle_student(k, k.students[conn.sid], msg)
            if classes.get(k.code) is not k:
                break  # 수업 종료됨
            push(k)
        # 강퇴·수업 종료로 끝난 경우: 마지막 안내 메시지를 보낸 뒤 닫는다
        try:
            await asyncio.wait_for(conn.queue.join(), 2)
            await ws.close()
        except Exception:
            pass
    except WebSocketDisconnect as e:
        # 1000·1001·1005: 창을 닫거나 새로고침·다른 페이지로 이동. 그 밖은 인터넷 끊김·기기 잠듦 등.
        # 정상 종료 코드라도 그 전에 한동안 신호가 없었다면 서버가 응답 없는 연결을 정리한 것이다.
        if not conn.leave_reason:
            normal = e.code in (1000, 1001, 1005) and time.time() - conn.last_recv < STALE_AFTER
            conn.leave_reason = "closed" if normal else "network"
    except Exception:
        conn.leave_reason = conn.leave_reason or "network"
        log.exception("WebSocket 처리 중 오류")
    finally:
        writer_task.cancel()
        if conn.role == "teacher":
            if conn in k.conns:
                k.conns.remove(conn)
            if not k.teacher_online():
                k.listening, k.talking, k.broadcasting = [], None, False
        elif not conn.evicted:  # 이미 정리된 연결은 다시 세지 않는다
            # 강퇴된 학생은 students에서 빠졌으므로 conn에 남은 정보로 출결을 닫는다
            drop_conn(k, conn, k.students.get(conn.sid or "") or conn.kicked_student)
        k.last_active = time.time()
        if classes.get(k.code) is k:
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
            q = {"id": uuid.uuid4().hex, "sid": s.id, "name": s.name, "text": text,
                 "ts": time.time(), "done": False, "reply": ""}
            k.questions.append(q)
            del k.questions[:-300]  # 화면에는 최근 300개만 (DB에는 모두 보관)
            write_question(_question_insert, k.db_id, int(s.id), dict(q))
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
    group_ids = {g["id"] for g in k.groups}
    if t == "settings":
        for name in ("chat", "ai", "mic_lock", "lowbw"):
            if name in m:
                k.settings[name] = bool(m[name])
        if m.get("mic_lock"):
            for s in k.students.values():
                s.can_speak = False
            send_to_students(k, {"t": "cmd", "cmd": "mute"})
        if "mic_lock" in m or "lowbw" in m:
            enforce_sources(k)
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
            enforce_sources(k, [s])
    elif t == "lower_hand":
        target = m.get("target")
        for s in k.students.values():
            if target == "all" or s.id == target:
                s.hand = False
    elif t == "kick":
        s = k.students.pop(str(m.get("target")), None)
        if s:
            k.banned.add(s.id)
            for c in k.conns:
                if c.sid == s.id:
                    c.kicked_student = s  # 연결이 끊길 때 출결을 닫기 위해
                    c.leave_reason = "kicked"
            send_to_students(k, {"t": "kicked"}, s.id)
            remove_from_livekit(k, s.id)
    elif t == "announce":
        text = clean(m.get("text"))
        k.announce = {"id": k.next_id(), "text": text, "ts": time.time()} if text else None
    elif t == "chat":
        text = clean(m.get("text"))
        scope = m.get("scope") or "main"
        if text and (scope == "main" or scope in group_ids):
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
                values = {}
                if "done" in m:
                    q["done"] = bool(m["done"])
                    values["done"] = int(q["done"])
                if "reply" in m:
                    q["reply"] = clean(m["reply"])
                    values.update(reply=q["reply"], replied_at=time.time())
                if values:
                    write_question(_question_update, q["id"], values)
    elif t == "activity_start":
        start_activity(k, m)
    elif t == "activity_close" and k.activity:
        k.activity["open"] = False
        save_activity(k, k.activity)
    elif t == "activity_reopen" and k.activity:
        k.activity["open"] = True
    elif t == "activity_reveal" and k.activity:
        k.activity["reveal"] = bool(m.get("on"))
    elif t == "activity_clear" and k.activity:
        save_activity(k, k.activity)
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
        if s and (gid is None or gid in group_ids):
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
        k.listening, k.talking, k.broadcasting = [], None, False
        for s in k.students.values():
            s.help = False
    elif t == "listen":
        k.listening = [g for g in (m.get("groups") or []) if g in group_ids]
        talking = m.get("talking")
        k.talking = talking if talking in group_ids else None
        k.broadcasting = bool(m.get("broadcast"))
        if k.talking:  # 선생님이 들어가면 호출 표시를 끈다
            for s in k.students.values():
                if s.group == k.talking:
                    s.help = False
    elif t == "help_clear":
        for s in k.students.values():
            if s.group == m.get("group"):
                s.help = False
    elif t == "end_class":
        save_activity(k, k.activity)
        # 접속 중인 학생의 출결을 '수업 종료'로 바로 닫는다
        open_ids = [s.att_id for s in k.students.values() if s.att_id]
        for s in k.students.values():
            s.att_id = None
        ended_at = time.time()
        send_to_students(k, {"t": "ended"})
        for c in k.conns:
            if c.role == "teacher":
                send(c, {"t": "ended"})
        close_livekit_rooms(k)
        classes.pop(k.code, None)
        class_id = k.db_id

        def run():
            with db.engine.begin() as c:
                c.execute(update(db.classes).where(db.classes.c.id == class_id).values(ended_at=ended_at))
                if open_ids:
                    c.execute(update(db.attendance).where(db.attendance.c.id.in_(open_ids))
                              .values(left_at=ended_at, last_seen=ended_at, left_reason="ended"))

        asyncio.get_running_loop().create_task(db.run(run))


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
    save_activity(k, k.activity)
    k.activity = {"id": k.next_id(), "kind": kind, "prompt": prompt or "질문", "options": options,
                  "correct": correct, "open": True, "reveal": False, "responses": {}, "created": time.time()}
