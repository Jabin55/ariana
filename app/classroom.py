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
import math
import random
import re
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, insert, select, update

from livekit import api as lk

from app import db
from app.auth import KST, current_user, display_name, needs_profile, require_user
from app.courses import course_roster, is_enrolled, owned_course

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
# 지금은 언제나 데이터 절약 모드(영상 화질을 낮춤). 학생 카메라는 언제든 학생이 켜고 끌 수 있다.
LOW_BANDWIDTH_DEFAULT = True
# 마이크 통제 기본값: 전체 교실에서 학생 마이크는 선생님이 켜 줘야 쓸 수 있다(학생은 손 들기로 요청).
# 학생은 언제나 스스로 마이크를 켜고 끈다. 선생님은 학생 목록에서 마이크를 켜거나 끌 수 있다.
# (예전의 '학생 마이크는 선생님이 켜고 끄기' 설정은 없앴다. MIC_LOCK 설정은 무시)
MIC_LOCK_DEFAULT = False
# 강의 녹화(선생님 컴퓨터에 저장). 학교가 허용하지 않으면 ALLOW_RECORDING=0
ALLOW_RECORDING = os.environ.get("ALLOW_RECORDING", "1") != "0"
# 발표 자료(PDF)는 수업이 끝나도 남겨 둔다(그 수업을 들은 학생·강좌 수강생이 나중에 다시 봄)
SLIDES_DIR = Path(os.environ.get("SLIDES_DIR") or Path(tempfile.gettempdir()) / "live-slides")
MAX_FILE_BYTES = 40 * 1024 * 1024
# 미디어 공유: 선생님이 올린 동영상·음악 (수업이 끝나면 지운다) 또는 유튜브 영상
MAX_MEDIA_BYTES = 500 * 1024 * 1024
MEDIA_TYPES = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4",
               ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg"}
YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
# 칭찬 스티커 (선생님 → 모두 또는 한 학생)
STICKERS = {"👏": "박수", "👍": "좋아요", "⭐": "칭찬", "💯": "최고", "🎉": "축하", "❤️": "하트", "💡": "좋은 생각", "🔥": "열정"}
MAX_FILES = 20  # 수업당 올릴 수 있는 파일 수
MAX_BOARD_PAGES = 50
MAX_STROKES = 1500  # 한 쪽에 남길 수 있는 획 수
MAX_POINTS = 4000  # 한 획의 점 수
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def livekit_ready() -> bool:
    return bool(LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET)


def clean(text: Any, limit: int = TEXT_LIMIT) -> str:
    return str(text or "").strip()[:limit]


# ───────────────────────── 수업 상태 ─────────────────────────


@dataclass
class Student:
    id: str  # 사용자 id (문자열)
    name: str  # 화면에 보이는 이름 (예: 20315 김민준)
    school: str = ""  # 다른 학교 학생도 함께 들을 수 있어 학번만으로는 구분이 안 될 때 쓴다
    conns: int = 0
    hand: bool = False  # ✋ 손 들기: 할 말이 있어요
    mic_req: bool = False  # 🎙️ 마이크를 켜 달라는 요청 (손 들기와 따로)
    help: bool = False  # 모둠 활동 중 '선생님 호출'
    can_speak: bool = False  # 선생님이 마이크를 켜 줌 (마이크 통제 중에도 말할 수 있음)
    can_cam: bool = False  # (예전 설정의 흔적: 카메라는 이제 언제나 학생이 켜고 끈다)
    mic_blocked: bool = False  # 선생님이 이 학생 마이크를 강제로 껐다 → 선생님이 다시 켜 줄 때까지 못 켬
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
        "chat": True, "ai": True, "mic_lock": MIC_LOCK_DEFAULT, "lowbw": LOW_BANDWIDTH_DEFAULT})
    groups: list[dict] = field(default_factory=list)  # [{id, name}]
    breakout: bool = False
    ends_at: float | None = None
    breakout_at: float | None = None  # 모둠 활동을 시작한 시각 (지난 시간 표시용)
    announce: dict | None = None
    listening: list[str] = field(default_factory=list)  # 선생님이 듣고 있는 모둠
    talking: str | None = None  # 선생님이 말하고 있는 모둠
    broadcasting: bool = False  # 선생님이 모든 방에 동시에 말하는 중
    # 학생 화면 구성: teacher(선생님 크게) grid(모두 나열) debate(토론: 학생 둘 크게 나란히)
    layout: dict = field(default_factory=lambda: {"mode": "teacher", "pair": []})
    roster: list = field(default_factory=list)  # 강좌 수업: 수강 확정 학생 명단 [{id, name, school}] (안 들어온 학생도 보이게)
    recording: bool = False  # 선생님이 수업을 녹화하는 중 (학생 화면에 표시)
    events: list[dict] = field(default_factory=list)  # 최근 입·퇴장 (선생님 화면 알림용)
    # 발표(PDF)·화이트보드: {"mode": "slides"|"board", "file": 파일 id, "page": 쪽} / 없으면 None
    present: dict | None = None
    files: list[dict] = field(default_factory=list)  # 올린 발표 자료 [{id, name, pages, size}]
    # 미디어 공유: {"kind": "youtube"|"file", "src", "title", "playing", "pos": 초, "at": pos를 정한 시각} / 없으면 None
    media: dict | None = None
    media_files: list[dict] = field(default_factory=list)  # 올린 동영상·음악 [{id, name, ext, size}]
    stickers: dict[str, int] = field(default_factory=dict)  # 학생별로 받은 칭찬 스티커 수
    board_pages: int = 1  # 화이트보드 쪽 수
    strokes: dict[str, list[dict]] = field(default_factory=dict)  # 쪽마다 선생님 판서
    dirty_boards: set[str] = field(default_factory=set)  # 아직 DB에 저장하지 않은 판서 쪽
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


def _ended_class(code: str) -> bool:
    """이 코드로 열렸다가 끝난(또는 너무 오래된) 수업이 있었는지"""
    with db.engine.connect() as c:
        return c.execute(select(db.classes.c.id).where(db.classes.c.code == code)).first() is not None


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
        waiting = await db.run(_waiting_meeting, code) if code.isalnum() and len(code) <= 8 else None
        if waiting:
            when = datetime.fromtimestamp(waiting.start_at, KST).strftime("%m월 %d일 %H:%M")
            raise HTTPException(404, f"예약된 특강·회의 '{waiting.title}'이에요. {when}에 열려요. 선생님이 열면 다시 들어와 주세요.")
        if code.isalnum() and len(code) <= 8 and await db.run(_ended_class, code):
            raise HTTPException(404, "이미 끝난 수업이에요. 선생님이 새 수업을 열면 다시 들어올 수 있어요.")
        raise HTTPException(404, "수업을 찾을 수 없어요. 코드를 다시 확인해 주세요. (강좌 수업은 코드 없이 마이페이지 '지금 들어갈 수 있는 수업'에서 들어가요)")
    saved_questions = await db.run(_load_questions, row.id)  # 서버가 다시 켜져도 질문답변은 이어진다
    saved_files, saved_boards = await db.run(_load_materials, row.id)  # 발표 자료·판서도
    k = classes.get(code)  # 기다리는 사이 다른 요청이 먼저 살렸을 수 있다
    if not k:
        k = Klass(db_id=row.id, code=row.code, title=row.title, teacher_id=row.teacher_id, created=row.created_at,
                  course_id=row.course_id)
        k.questions = saved_questions
        k.files = saved_files
        k.strokes = saved_boards
        k.board_pages = max([int(x[3:]) for x in saved_boards if x.startswith("wb:")] + [1])
        classes[code] = k
    return k


def _load_materials(class_id: int) -> tuple[list[dict], dict[str, list]]:
    with db.engine.connect() as c:
        files = [{"id": r.id, "name": r.name, "pages": r.pages, "size": r.size} for r in c.execute(
            select(db.materials).where(db.materials.c.class_id == class_id).order_by(db.materials.c.created_at))]
        boards = {r.key: json.loads(r.strokes) for r in c.execute(
            select(db.boards).where(db.boards.c.class_id == class_id))}
    return files, boards


def _boards_save(class_id: int, items: list[tuple[str, str]]) -> None:
    now = time.time()
    with db.engine.begin() as c:
        for key, data in items:
            c.execute(delete(db.boards).where(db.boards.c.class_id == class_id, db.boards.c.key == key))
            if data != "[]":
                c.execute(insert(db.boards).values(class_id=class_id, key=key, strokes=data, updated_at=now))


async def save_boards(k: Klass) -> None:
    """바뀐 판서를 DB에 저장한다 (1분마다, 수업이 끝날 때)."""
    if not k.dirty_boards:
        return
    keys, k.dirty_boards = k.dirty_boards, set()
    items = [(key, json.dumps(k.strokes.get(key, []), ensure_ascii=False)) for key in keys]
    try:
        await db.run(_boards_save, k.db_id, items)
    except Exception:
        k.dirty_boards |= keys  # 다음에 다시 시도
        log.warning("판서 저장 실패", exc_info=True)


def prune_classes() -> None:
    now = time.time()
    for code, k in list(classes.items()):
        if not k.conns and now - k.last_active > MEMORY_IDLE_LIMIT and not k.dirty_boards:
            classes.pop(code, None)  # 자료·판서는 DB와 디스크에 남아 있다


def _code_taken(code: str) -> bool:
    with db.engine.connect() as c:
        return c.execute(select(db.classes.c.id).where(
            db.classes.c.code == code, db.classes.c.ended_at.is_(None),
            db.classes.c.created_at > time.time() - CLASS_REVIVE_LIMIT)).first() is not None \
            or _meeting_by_code(c, code) is not None


def _meeting_by_code(c, code: str):
    """아직 열지 않은(또는 열린 지 얼마 안 된) 예약 특강·회의"""
    return c.execute(select(db.meetings).where(
        db.meetings.c.code == code, db.meetings.c.start_at > time.time() - CLASS_REVIVE_LIMIT)
        .order_by(db.meetings.c.id.desc())).first()


def _waiting_meeting(code: str):
    with db.engine.connect() as c:
        m = _meeting_by_code(c, code)
    return m if m and not m.class_id else None


async def new_code() -> str:
    while True:
        code = "".join(random.choices(CODE_CHARS, k=6))
        if code not in classes and not await db.run(_code_taken, code):
            return code


# ───────────────────────── DB 기록 (출결·활동) ─────────────────────────


def _att_open(class_id: int, user_id: int) -> int:
    now = time.time()
    with db.engine.begin() as c:
        if c.execute(select(db.users.c.account_state).where(db.users.c.id == user_id)).scalar() != "active":
            raise HTTPException(403, "이용이 종료된 계정이에요.")
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
        for k in list(classes.values()):
            for uid in {c.ws.session.get("uid") for c in list(k.conns)}:
                if uid:
                    await refresh_user_connections(uid)
            await save_boards(k)
        prune_classes()


# 질문 저장은 한 줄로 세운 스레드 하나가 순서대로 처리한다(답변이 질문보다 먼저 저장되는 일이 없도록)
_question_writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="question-writer")


def write_question(fn, *args) -> None:
    fut = _question_writer.submit(fn, *args)
    fut.add_done_callback(lambda f: f.exception() and log.warning("질문 저장 실패: %s", f.exception()))


def _question_insert(class_id: int, user_id: int, q: dict) -> None:
    with db.engine.begin() as c:
        if c.execute(select(db.users.c.account_state).where(db.users.c.id == user_id)).scalar() != "active":
            return
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
            # 탈퇴 처리 중 늦게 도착한 저장 작업이 답안을 다시 생성하지 못하게 한다.
            responses = json.loads(values["responses"])
            active = set(c.execute(select(db.users.c.id).where(db.users.c.account_state == "active")).scalars())
            values["responses"] = json.dumps({uid: value for uid, value in responses.items() if int(uid) in active}, ensure_ascii=False)
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


def present_view(k: Klass) -> dict | None:
    p = k.present
    if not p:
        return None
    if p["mode"] == "board":
        return {"mode": "board", "page": p["page"], "pages": k.board_pages, "key": f"wb:{p['page']}"}
    f = next((f for f in k.files if f["id"] == p["file"]), None)
    if not f:
        return None
    return {"mode": "slides", "file": f["id"], "name": f["name"], "page": p["page"], "pages": f["pages"],
            "key": f"{f['id']}:{p['page']}", "zoom": p.get("zoom") or {"z": 1, "x": 0.5, "y": 0.5}}


def teacher_state(k: Klass) -> dict:
    return {
        "t": "state", "role": "teacher", "code": k.code, "title": k.title, "class_id": k.db_id,
        "course_id": k.course_id,
        "settings": k.settings, "livekit": livekit_ready(), "layout": k.layout,
        "students": roster_rows(k),
        "groups": k.groups, "breakout": k.breakout, "ends_at": k.ends_at, "breakout_at": k.breakout_at, "started_at": k.created,
        "present": present_view(k), "files": k.files, "recording": k.recording,
        "media": k.media, "media_files": k.media_files,
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
        "me": {"id": s.id, "name": s.name, "hand": s.hand, "mic_req": s.mic_req, "help": s.help,
               "can_speak": s.can_speak, "can_cam": s.can_cam, "mic_blocked": s.mic_blocked},
        "room": room, "group": group, "breakout": k.breakout, "ends_at": k.ends_at,
        "teacher_online": k.teacher_online(),
        "teacher_listening": room != "main" and (room in k.listening or k.talking == room),
        "teacher_talking": room != "main" and k.talking == room,
        "teacher_broadcast": k.broadcasting,
        "recording": k.recording,
        "layout": layout_for(k),
        "activity": activity_for_student(k.activity, s.id),
        "present": present_view(k) if room == "main" else None,  # 모둠 활동 중에는 보이지 않음
        "media": k.media if room == "main" else None,
        "announce": k.announce,
        "my_questions": [q for q in k.questions if q["sid"] == s.id][-20:],
        "online_count": sum(1 for m in k.students.values() if m.conns > 0),
    }


def load_roster(course_id: int | None) -> list[dict]:
    if not course_id:
        return []
    return [{"id": str(u.id), "name": display_name(dict(u._mapping)), "school": u.school or ""}
            for u in course_roster(course_id)]


def roster_rows(k: Klass) -> list[dict]:
    """선생님 학생 목록: 들어온 학생 + 아직 안 들어온 수강생(회색)"""
    rows = [{"id": s.id, "name": s.name, "school": s.school, "online": s.conns > 0, "hand": s.hand, "mic_req": s.mic_req,
             "help": s.help, "can_speak": s.can_speak, "can_cam": s.can_cam, "mic_blocked": s.mic_blocked,
             "group": s.group, "room": k.room_of(s), "sessions": s.sessions, "absent": False,
             "stickers": k.stickers.get(s.id, 0)}
            for s in k.students.values()]
    rows += [{"id": r["id"], "name": r["name"], "school": r["school"], "online": False, "hand": False, "mic_req": False,
              "help": False, "can_speak": False, "can_cam": False, "mic_blocked": False, "group": None, "room": None,
              "sessions": 0, "absent": True, "stickers": 0}
             for r in k.roster if r["id"] not in k.students]
    return rows


def layout_for(k: Klass) -> dict:
    """학생 화면 구성 (토론이면 두 학생의 화상 이름표도 함께)"""
    out = {"mode": k.layout["mode"], "pair": []}
    for sid in k.layout.get("pair", []):
        s = k.students.get(sid)
        if s:
            out["pair"].append({"id": sid, "identity": f"s-{sid}", "name": s.name})
    return out


def chat_visible(msg: dict, room: str, sid: str | None = None) -> bool:
    """1:1 채팅(학생 ↔ 선생님)은 그 학생에게만, 나머지는 같은 방 사람에게"""
    if msg["scope"].startswith("dm:"):
        return sid is not None and msg["scope"] == f"dm:{sid}"
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
        try:
            conn.loop.call_soon_threadsafe(conn.queue.put_nowait, data)
        except RuntimeError:
            pass  # 이미 닫힌 연결


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
                send(c, {"t": "chat_init", "msgs": [m for m in k.chat if chat_visible(m, room, s.id)][-100:]})
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
            if s and chat_visible(msg, k.room_of(s), s.id):
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
    if not s.mic_blocked:  # 선생님이 이 학생 마이크를 강제로 끈 동안은 못 켠다
        out.append("microphone")
    out.append("camera")  # 카메라는 언제나 학생이 켜고 끈다 (데이터 절약 모드는 화질만 낮춘다)
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
        if (course.approval or "approved") != "approved":
            raise HTTPException(409, "거점학교 관리교사가 강좌 개설을 승인해야 수업을 열 수 있어요.")
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


# ───────────────────────── 특강·회의 예약 ─────────────────────────


class MeetingReq(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


def meeting_row(m, live_codes: set[str]) -> dict:
    return {"id": m.id, "title": m.title, "code": m.code, "start_at": m.start_at,
            "start": datetime.fromtimestamp(m.start_at, KST).strftime("%Y-%m-%d %H:%M"),
            "opened": bool(m.class_id), "live": m.code in live_codes}


@router.get("/api/meetings")
async def my_meetings(request: Request):
    """예약한 특강·회의 (지난 지 하루가 넘은 것은 빼고)"""
    t = await require_user(request, "teacher")

    def run():
        with db.engine.connect() as c:
            return c.execute(select(db.meetings).where(
                db.meetings.c.teacher_id == t["id"], db.meetings.c.start_at > time.time() - CLASS_REVIVE_LIMIT)
                .order_by(db.meetings.c.start_at)).all()

    live = {k.code for k in classes.values() if k.teacher_id == t["id"]}
    return {"meetings": [meeting_row(m, live) for m in await db.run(run)]}


@router.post("/api/meetings")
async def add_meeting(req: MeetingReq, request: Request):
    """특강·회의 예약: 입장 코드를 미리 받아 참가자에게 알려 줄 수 있다"""
    t = await require_user(request, "teacher")
    try:
        start = datetime.fromisoformat(f"{req.date}T{req.time}").replace(tzinfo=KST).timestamp()
    except ValueError:
        raise HTTPException(400, "날짜·시각이 올바르지 않아요.")
    if start < time.time() - 600:
        raise HTTPException(400, "이미 지난 시각이에요. 지금 열려면 '지금 바로 열기'를 써 주세요.")
    code = await new_code()

    def run():
        with db.engine.begin() as c:
            return c.execute(insert(db.meetings).values(teacher_id=t["id"], title=clean(req.title, 60), code=code,
                                                        start_at=start, created_at=time.time())).inserted_primary_key[0]

    return {"id": await db.run(run), "code": code}


def _my_meeting(mid: int, uid: int):
    with db.engine.connect() as c:
        m = c.execute(select(db.meetings).where(db.meetings.c.id == mid)).first()
    if not m or m.teacher_id != uid:
        raise HTTPException(404, "예약을 찾을 수 없어요.")
    return m


@router.post("/api/meetings/{mid}/open")
async def open_meeting(mid: int, request: Request):
    """예약한 특강·회의를 연다 (미리 알려 준 입장 코드 그대로)"""
    t = await require_user(request, "teacher")
    m = await db.run(_my_meeting, mid, t["id"])
    if m.code in classes:
        return {"code": m.code}
    prune_classes()

    def run():
        with db.engine.begin() as c:
            cid = c.execute(insert(db.classes).values(
                code=m.code, title=m.title, teacher_id=t["id"], school=t["school"] or "", created_at=time.time(),
                course_id=None)).inserted_primary_key[0]
            c.execute(update(db.meetings).where(db.meetings.c.id == mid).values(class_id=cid))
            return cid

    class_id = await db.run(run)
    classes[m.code] = Klass(db_id=class_id, code=m.code, title=m.title, teacher_id=t["id"], course_id=None)
    return {"code": m.code}


@router.post("/api/meetings/{mid}/delete")
async def delete_meeting(mid: int, request: Request):
    t = await require_user(request, "teacher")
    await db.run(_my_meeting, mid, t["id"])

    def run():
        with db.engine.begin() as c:
            c.execute(delete(db.meetings).where(db.meetings.c.id == mid))

    await db.run(run)
    return {"ok": True}


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
        s.name, s.school = display_name(u), u.get("school") or ""
        return s
    if len(k.students) >= MAX_STUDENTS:
        raise HTTPException(409, "수업 인원이 가득 찼어요.")
    s = Student(id=sid, name=display_name(u), school=u.get("school") or "")
    if k.breakout and k.groups:  # 모둠 활동 중에 들어오면 인원이 가장 적은 모둠으로
        s.group = smallest_group(k)
    k.students[sid] = s
    return s


async def ensure_enrolled(k: Klass, u: dict) -> None:
    """강좌 수업이면 수강 승인된 학생만 들어온다(코드를 알아도 안 됨)."""
    if k.course_id and not await db.run(is_enrolled, k.course_id, u["id"]):
        raise HTTPException(403, "이 강좌에 수강이 확정된 학생만 들어올 수 있어요. 마이페이지 '내 강좌'에서 승인 상태를 확인해 주세요.")


@router.post("/api/live/classes/{code}/join")
async def join_class(code: str, request: Request):
    """입장: 강좌 수업은 수강 확정 학생만, 특강·회의는 로그인한 사람 누구나(다른 선생님도) 참가자로"""
    u = await require_user(request)
    k = await get_class(code)
    as_student = u["is_admin"] and request.query_params.get("as_student") == "1"
    if not as_student and await is_class_teacher(k, u):
        return {"teacher": True, "code": k.code}  # 이 수업의 선생님이면 선생님 화면으로
    if u["role"] != "student" and not u["is_admin"] and k.course_id:
        raise HTTPException(403, "강좌 수업은 수강 확정된 학생만 들어올 수 있어요.")
    await ensure_enrolled(k, u)
    s = add_student(k, u)
    k.last_active = time.time()
    push(k)
    return {"student_id": s.id, "name": s.name}


def _teaches_course(course_id: int, uid: int) -> bool:
    from app.courses import teaches  # 순환 import 를 피한다

    with db.engine.connect() as c:
        r = c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()
    return bool(r) and teaches(r, uid)


async def is_class_teacher(k: Klass, u: dict) -> bool:
    """이 수업의 선생님: 수업을 연 사람, 또는 그 강좌를 함께 가르치는 팀티칭 선생님"""
    if u["role"] != "teacher":
        return False
    if k.course_id:
        from app.courses import hub_locked
        def allowed():
            with db.engine.connect() as c:
                course = c.execute(select(db.courses).where(db.courses.c.id == k.course_id)).first()
            return course is not None and not hub_locked(course, u)
        if not await db.run(allowed):
            return False
    if u["id"] == k.teacher_id:
        return True
    return bool(k.course_id) and await db.run(_teaches_course, k.course_id, u["id"])


@router.post("/api/live/classes/{code}/token")
async def livekit_token(code: str, req: TokenReq, request: Request):
    u = await require_user(request)
    k = await get_class(code)
    if not livekit_ready():
        raise HTTPException(503, "화상 서버(LiveKit)가 아직 설정되지 않았어요.")
    as_student = u["is_admin"] and request.query_params.get("as_student") == "1"
    if not as_student and await is_class_teacher(k, u):
        if req.room != "main" and not any(g["id"] == req.room for g in k.groups):
            raise HTTPException(404, "없는 모둠이에요.")
        # 팀티칭: 수업을 연 선생님은 'teacher', 함께 가르치는 선생님은 따로 (같은 이름이면 서로 밀어냄)
        identity, name, role = ("teacher", "선생님", "teacher") if u["id"] == k.teacher_id \
            else (f"t-{u['id']}", f"{u['name'] or '보조'} 선생님", "teacher")
        sources = ["camera", "microphone", "screen_share", "screen_share_audio"]
    elif str(u["id"]) in k.students:  # 참가자 (학생, 또는 특강·회의에 참가한 다른 선생님)
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


# ───────────────────────── 발표 자료(PDF)·화이트보드 ─────────────────────────


def class_dir(k: Klass) -> Path:
    return SLIDES_DIR / str(k.db_id)


@router.post("/api/live/classes/{code}/files")
async def upload_file(code: str, request: Request, name: str = Query(default="자료.pdf", max_length=200)):
    """선생님이 발표할 PDF를 올린다. (요청 본문 = PDF 파일 그대로)"""
    t = await require_user(request, "teacher")
    k = await get_class(code)
    if not await is_class_teacher(k, t):
        raise HTTPException(403, "이 수업의 선생님만 올릴 수 있어요.")
    if len(k.files) >= MAX_FILES:
        raise HTTPException(409, f"한 수업에 자료는 {MAX_FILES}개까지 올릴 수 있어요.")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(413, f"파일이 너무 커요. {MAX_FILE_BYTES // 1024 // 1024}MB 이하로 올려 주세요.")
    if not data.startswith(b"%PDF-"):
        raise HTTPException(415, "PDF 파일만 올릴 수 있어요. PowerPoint는 '파일 → 내보내기 → PDF'로 저장해서 올려 주세요.")
    fid = uuid.uuid4().hex[:12]
    path = class_dir(k) / f"{fid}.pdf"
    fname = clean(name, 80) or "자료.pdf"

    def save():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        with db.engine.begin() as c:
            c.execute(insert(db.materials).values(id=fid, class_id=k.db_id, teacher_id=k.teacher_id, name=fname,
                                                  pages=0, size=len(data), created_at=time.time()))

    await asyncio.to_thread(save)
    k.files.append({"id": fid, "name": fname, "pages": 0, "size": len(data)})
    push(k)
    return {"id": fid}


@router.post("/api/live/classes/{code}/media")
async def upload_media(code: str, request: Request, name: str = Query(default="영상.mp4", max_length=200)):
    """미디어 공유: 선생님이 동영상·음악 파일을 올린다 (요청 본문 = 파일 그대로). 수업이 끝나면 지운다."""
    t = await require_user(request, "teacher")
    k = await get_class(code)
    if not await is_class_teacher(k, t):
        raise HTTPException(403, "이 수업의 선생님만 올릴 수 있어요.")
    ext = Path(name).suffix.lower()
    if ext not in MEDIA_TYPES:
        raise HTTPException(415, "동영상(mp4·webm·mov)이나 음악(mp3·m4a·wav·ogg) 파일만 올릴 수 있어요.")
    if len(k.media_files) >= MAX_FILES:
        raise HTTPException(409, f"한 수업에 미디어는 {MAX_FILES}개까지 올릴 수 있어요.")
    fid = uuid.uuid4().hex[:12]
    path = media_dir(k) / f"{fid}{ext}"
    path.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with path.open("wb") as out:  # 큰 파일이라 메모리에 담지 않고 바로 디스크에 쓴다
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_MEDIA_BYTES:
                    raise HTTPException(413, f"파일이 너무 커요. {MAX_MEDIA_BYTES // 1024 // 1024}MB 이하로 올려 주세요.")
                out.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    if not size:
        path.unlink(missing_ok=True)
        raise HTTPException(400, "빈 파일이에요.")
    k.media_files.append({"id": fid, "name": clean(name, 80) or "미디어", "ext": ext, "size": size})
    push(k)
    return {"id": fid}


@router.get("/api/live/classes/{code}/media/{fid}")
async def get_media(code: str, fid: str, request: Request):
    """이 수업의 선생님과 들어온 학생만 본다 (구간 요청을 지원해 원하는 곳부터 재생)."""
    u = await require_user(request)
    k = await get_class(code)
    if not (await is_class_teacher(k, u) or ((u["role"] == "student" or u["is_admin"]) and str(u["id"]) in k.students)):
        raise HTTPException(403, "이 수업에 들어온 사람만 볼 수 있어요.")
    f = next((x for x in k.media_files if x["id"] == fid), None)
    path = media_dir(k) / f"{fid}{f['ext']}" if f else None
    if not path or not path.is_file():
        raise HTTPException(404, "미디어를 찾을 수 없어요.")
    return FileResponse(path, media_type=MEDIA_TYPES[f["ext"]], headers={"Cache-Control": "private, max-age=3600"})


@router.get("/api/live/classes/{code}/files/{fid}")
async def download_file(code: str, fid: str, request: Request):
    """이 수업의 선생님과 들어온 학생만 받을 수 있다."""
    u = await require_user(request)
    k = await get_class(code)
    ok = await is_class_teacher(k, u) or ((u["role"] == "student" or u["is_admin"]) and str(u["id"]) in k.students)
    if not ok:
        raise HTTPException(403, "이 수업에 들어온 사람만 볼 수 있어요.")
    if not any(f["id"] == fid for f in k.files):
        raise HTTPException(404, "자료를 찾을 수 없어요.")
    path = class_dir(k) / f"{fid}.pdf"
    if not path.is_file():
        raise HTTPException(404, "자료를 찾을 수 없어요. 선생님이 다시 올려야 해요.")
    return FileResponse(path, media_type="application/pdf", headers={"Cache-Control": "private, max-age=86400"})


def present_key(k: Klass) -> str | None:
    v = present_view(k)
    return v["key"] if v else None


def send_strokes(k: Klass, conn: Conn | None = None) -> None:
    """지금 쪽의 판서 전체를 보낸다(쪽이 바뀔 때, 새로 들어왔을 때)."""
    key = present_key(k)
    if not key:
        return
    msg = json.dumps({"t": "strokes", "key": key, "strokes": k.strokes.get(key, [])}, ensure_ascii=False)
    for c in [conn] if conn else k.conns:
        send(c, msg)


def relay(k: Klass, sender: Conn, obj: dict) -> None:
    """판서는 상태 전체를 다시 보내지 않고 바뀐 획만 다른 사람에게 바로 보낸다."""
    data = json.dumps(obj, ensure_ascii=False)
    for c in k.conns:
        if c is not sender:
            send(c, data)


def clean_points(pts) -> list[list[float]]:
    out = []
    if not isinstance(pts, list):
        return out
    for p in pts[:500]:
        if (isinstance(p, list) and len(p) == 2 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in p)):
            out.append([round(min(1.5, max(-0.5, float(p[0]))), 4), round(min(1.5, max(-0.5, float(p[1]))), 4)])
    return out


def _material_pages(fid: str, pages: int) -> None:
    with db.engine.begin() as c:
        c.execute(update(db.materials).where(db.materials.c.id == fid).values(pages=pages))


def _material_delete(class_id: int, fid: str, path: Path) -> None:
    with db.engine.begin() as c:
        c.execute(delete(db.materials).where(db.materials.c.id == fid))
        c.execute(delete(db.boards).where(db.boards.c.class_id == class_id, db.boards.c.key.like(f"{fid}:%")))
    path.unlink(missing_ok=True)


def handle_present(k: Klass, conn: Conn, m: dict) -> bool:
    """발표·판서 메시지. 처리했으면 True. (상태가 바뀌면 push는 호출한 쪽에서)"""
    t = m.get("t")
    before = present_key(k)
    if t == "present_open":  # PDF 발표 시작 (쪽 수는 선생님 화면이 PDF를 읽어서 알려 준다)
        f = next((f for f in k.files if f["id"] == m.get("file")), None)
        if not f:
            return True
        pages = m.get("pages")
        if isinstance(pages, int) and 1 <= pages <= 2000 and f["pages"] != pages:
            f["pages"] = pages
            fid = f["id"]
            asyncio.get_running_loop().run_in_executor(None, _material_pages, fid, pages)
        page = m.get("page")
        k.present = {"mode": "slides", "file": f["id"],
                     "page": page if isinstance(page, int) and 1 <= page <= max(1, f["pages"]) else 1}
    elif t == "present_board":  # 화이트보드
        k.present = {"mode": "board", "page": min(k.board_pages, max(1, int(m.get("page") or 1)))}
    elif t == "present_page" and k.present:
        page = m.get("page")
        if not isinstance(page, int):
            return True
        if k.present["mode"] == "board":
            if page == k.board_pages + 1 and k.board_pages < MAX_BOARD_PAGES:
                k.board_pages += 1  # 새 쪽
            k.present["page"] = min(k.board_pages, max(1, page))
        else:
            f = next((f for f in k.files if f["id"] == k.present["file"]), None)
            k.present["page"] = min(max(1, f["pages"] if f else 1), max(1, page))
            k.present["zoom"] = None  # 쪽을 넘기면 확대를 풀어 쪽 전체를 보여 준다
    elif t == "present_zoom" and k.present and k.present["mode"] == "slides":  # 자료 확대 (학생 화면도 같이)
        try:
            z = min(4.0, max(1.0, float(m.get("z", 1))))
            x = min(1.0, max(0.0, float(m.get("x", 0.5))))
            y = min(1.0, max(0.0, float(m.get("y", 0.5))))
        except (TypeError, ValueError):
            return True
        k.present["zoom"] = None if z <= 1.001 else {"z": round(z, 2), "x": round(x, 4), "y": round(y, 4)}
    elif t == "present_close":
        k.present = None
    elif t == "file_remove":
        fid = m.get("file")
        k.files = [f for f in k.files if f["id"] != fid]
        if k.present and k.present.get("file") == fid:
            k.present = None
        for key in [x for x in k.strokes if x.startswith(f"{fid}:")]:
            del k.strokes[key]
            k.dirty_boards.discard(key)
        if isinstance(fid, str) and fid.isalnum():
            asyncio.get_running_loop().run_in_executor(None, _material_delete, k.db_id, fid, class_dir(k) / f"{fid}.pdf")
    elif t == "stroke":  # 획 그리기 (그리는 중에도 조금씩 나눠 보낸다)
        key, sid = m.get("key"), m.get("id")
        if key != before or not isinstance(sid, str) or not 0 < len(sid) <= 24:
            return True
        pts = clean_points(m.get("pts"))
        page = k.strokes.setdefault(key, [])
        st = next((x for x in reversed(page) if x["id"] == sid), None)
        if st is None:
            if len(page) >= MAX_STROKES:
                return True
            color = m.get("color") if isinstance(m.get("color"), str) and COLOR_RE.match(m["color"]) else "#222222"
            size = m.get("size")
            size = float(size) if isinstance(size, (int, float)) and 0.5 <= size <= 60 else 3.0
            st = {"id": sid, "color": color, "size": size, "hl": bool(m.get("hl")), "pts": []}
            page.append(st)
        room = MAX_POINTS - len(st["pts"])
        pts = pts[:max(0, room)]
        if not pts:
            return True
        st["pts"].extend(pts)
        k.dirty_boards.add(key)
        relay(k, conn, {"t": "stroke", "key": key, "id": sid, "color": st["color"], "size": st["size"],
                        "hl": st["hl"], "pts": pts})
    elif t == "stroke_del":  # 지우개·되돌리기
        key, ids = m.get("key"), m.get("ids")
        if key != before or not isinstance(ids, list):
            return True
        ids = {i for i in ids[:200] if isinstance(i, str)}
        k.strokes[key] = [x for x in k.strokes.get(key, []) if x["id"] not in ids]
        k.dirty_boards.add(key)
        relay(k, conn, {"t": "stroke_del", "key": key, "ids": sorted(ids)})
    elif t == "board_clear":
        key = m.get("key")
        if key == before:
            k.strokes[key] = []
            k.dirty_boards.add(key)
            relay(k, conn, {"t": "strokes", "key": key, "strokes": []})
    else:
        return False
    if present_key(k) != before:
        send_strokes(k)
    return True


# 상태(state)를 바꾸지 않는 메시지: 받을 때마다 모든 학생 상태를 다시 계산하지 않는다
NO_PUSH = {"stroke", "stroke_del", "board_clear"}


# ───────────────────────── 모둠 ─────────────────────────


def smallest_group(k: Klass) -> str:
    sizes = {g["id"]: 0 for g in k.groups}
    for s in k.students.values():
        if s.group in sizes:
            sizes[s.group] += 1
    return min(sizes, key=lambda gid: (sizes[gid], gid))


def groups_needed(k: Klass, m: dict) -> int:
    """모둠 수를 정하거나(n), 모둠당 인원(size)을 정하면 필요한 모둠 수를 계산한다."""
    size = m.get("size")
    if isinstance(size, int) and size >= 1:
        count = sum(1 for s in k.students.values() if s.conns > 0) or len(k.students)
        return max(1, math.ceil(count / size))
    n = m.get("n")
    return n if isinstance(n, int) and n >= 1 else 4


def group_name(i: int) -> str:
    return f"{chr(64 + i)}모둠"  # 1 → A모둠, 2 → B모둠 …


def setup_groups(k: Klass, n: int) -> None:
    """모둠 수만 정한다 (배정은 그대로 두고, 없어진 모둠에 있던 학생은 미배정으로)."""
    n = max(1, min(MAX_GROUPS, n))
    k.groups = [{"id": f"g{i}", "name": group_name(i)} for i in range(1, n + 1)]
    ids = {g["id"] for g in k.groups}
    for s in k.students.values():
        if s.group not in ids:
            s.group = None


def plan_groups(k: Klass, n: int) -> None:
    """모둠을 만들고 접속한 학생을 무작위로 고르게 나눈다."""
    n = max(1, min(MAX_GROUPS, n))
    k.groups = [{"id": f"g{i}", "name": group_name(i)} for i in range(1, n + 1)]
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


async def connection_allowed(k: Klass, conn: Conn) -> bool:
    if conn.evicted:
        return False
    u = await current_user(conn.ws)
    if not u:
        return False
    if conn.role == "teacher":
        return await is_class_teacher(k, u)
    if needs_profile(u) or (k.course_id and u["role"] != "student" and not u["is_admin"]):
        return False
    return not k.course_id or await db.run(is_enrolled, k.course_id, u["id"])


async def disconnect_connection(k: Klass, conn: Conn):
    conn.evicted = True
    conn.leave_reason = "revoked"
    uid = conn.ws.session.get("uid")
    if conn.sid:
        drop_conn(k, conn, k.students.get(conn.sid))
    elif conn in k.conns:
        k.conns.remove(conn)

    async def close():
        try:
            await conn.ws.close(code=1008)
        except Exception:
            pass
    if conn.loop is asyncio.get_running_loop():
        await close()
    elif conn.loop.is_running():
        future = asyncio.run_coroutine_threadsafe(close(), conn.loop)
        try:
            await asyncio.wait_for(asyncio.wrap_future(future), 2)
        except Exception:
            pass

    if uid and livekit_ready():
        identity = f"s-{uid}" if conn.sid else ("teacher" if uid == k.teacher_id else f"t-{uid}")
        async def remove(api):
            for room in ["main"] + [g["id"] for g in k.groups]:
                try:
                    await api.room.remove_participant(lk.RoomParticipantIdentity(room=lk_room_name(k.code, room), identity=identity))
                except Exception:
                    pass
        try:
            await asyncio.wait_for(lk_call(remove), 3)
        except Exception:
            log.warning("권한 회수 후 화상 연결 종료를 확인해야 합니다.")


async def disconnect_user(uid: int):
    for k in list(classes.values()):
        for conn in list(k.conns):
            if conn.ws.session.get("uid") == uid:
                await disconnect_connection(k, conn)


async def refresh_user_connections(uid: int):
    for k in list(classes.values()):
        for conn in list(k.conns):
            if conn.ws.session.get("uid") == uid and not await connection_allowed(k, conn):
                await disconnect_connection(k, conn)


def student_evidence(uid: int) -> list[dict]:
    sid = str(uid)
    result = []
    for k in list(classes.values()):
        if sid not in k.students and not any(q.get("sid") == sid for q in k.questions):
            continue
        activity = None
        if k.activity:
            activity = {**k.activity, "responses": {sid: k.activity["responses"][sid]} if sid in k.activity["responses"] else {}}
        result.append({"class_id": k.db_id, "title": k.title, "activity": activity,
                       "questions": [dict(q) for q in k.questions if q.get("sid") == sid],
                       "events": [dict(e) for e in k.events if e.get("sid") == sid],
                       "stickers": k.stickers.get(sid, 0)})
    return result


def forget_student(uid: int):
    sid = str(uid)
    for k in list(classes.values()):
        k.students.pop(sid, None)
        k.roster = [r for r in k.roster if str(r["id"]) != sid]
        k.questions = [q for q in k.questions if q.get("sid") != sid]
        k.events = [e for e in k.events if e.get("sid") != sid]
        k.chat = [m for m in k.chat if str(m.get("sid")) != sid and str(m.get("to")) != sid]
        k.stickers.pop(sid, None)
        if k.activity:
            k.activity["responses"].pop(sid, None)
        k.layout["pair"] = [p for p in k.layout.get("pair", []) if p != sid]
        flush(k)  # 탈퇴 직후 연결된 교사 화면에서도 즉시 제거한다.


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
    as_student = u["is_admin"] and ws.query_params.get("as_student") == "1"
    if not as_student and await is_class_teacher(k, u):
        conn = Conn(ws=ws, role="teacher", sid=None)
        k.roster = await db.run(load_roster, k.course_id)  # 선생님이 들어올 때마다 수강생 명단을 새로 읽는다
    elif not needs_profile(u) and (u["role"] == "student" or u["is_admin"] or not k.course_id):
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
                att_id = await db.run(_att_open, k.db_id, int(s.id))
                if classes.get(k.code) is k:
                    s.att_id = att_id
                else:  # 기록하는 사이에 선생님이 수업을 끝냈다
                    await db.run(_att_close, att_id, time.time(), "ended")
            except Exception:
                log.warning("출결 기록 실패", exc_info=True)
    else:
        send(conn, {"t": "chat_init", "msgs": k.chat[-200:]})
    flush(k)  # 접속하자마자 현재 상태를 보낸다
    send_strokes(k, conn)
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
            if msg.get("t") == "leave":  # 종료 의사는 즉시 기록한다.
                if not conn.evicted:
                    conn.leave_reason = "leave"
                continue
            if not await connection_allowed(k, conn):
                await disconnect_connection(k, conn)
                break
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
            if classes.get(k.code) is not k:
                break  # 수업 종료됨
            if msg.get("t") not in NO_PUSH:
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
                if k.recording:  # 선생님 화면이 닫히면 녹화도 끝난다
                    k.recording = False
                    log_recording(k, False)
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
    elif t == "mic_req":  # 마이크 통제 중 '마이크 요청' (이미 켜 줬으면 무시)
        s.mic_req = bool(m.get("on")) and k.settings["mic_lock"] and not s.can_speak
    elif t == "help":
        s.help = bool(m.get("on")) and k.room_of(s) != "main"
    elif t == "chat":
        text = clean(m.get("text"))
        now = time.time()
        if not text or now - s.last_chat < CHAT_INTERVAL:
            return
        s.last_chat = now
        private = m.get("to") == "teacher"  # 선생님에게만 1:1 (학생끼리 1:1 채팅은 없다)
        post_chat(k, {"id": k.next_id(), "role": "student", "sid": s.id, "name": s.name, "text": text,
                      "scope": f"dm:{s.id}" if private else k.room_of(s), "private": private, "ts": now})
        if private:  # 선생님에게 보낸 1:1 은 질문 기록으로도 남긴다 (수업이 끝나도 질문·답변 기록에서 볼 수 있게)
            q = {"id": uuid.uuid4().hex, "sid": s.id, "name": s.name, "text": text, "ts": now, "done": False, "reply": ""}
            k.questions.append(q)
            del k.questions[:-300]
            write_question(_question_insert, k.db_id, int(s.id), dict(q))
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
    if handle_present(k, conn, m):
        return
    if t == "settings":
        for name in ("ai",):  # 학생 채팅·데이터 절약 모드는 언제나 켜져 있다
            if name in m:
                k.settings[name] = bool(m[name])
        if "mic_lock" in m:  # 통제를 바꾸면 남아 있는 마이크 요청은 지운다
            for s in k.students.values():
                s.mic_req = False
        if m.get("mic_lock"):  # 통제를 켜면 지금 켜진 마이크를 모두 끈다
            for s in k.students.values():
                s.can_speak = False
            send_to_students(k, {"t": "cmd", "cmd": "mute"})
        if m.get("lowbw"):
            for s in k.students.values():
                s.can_cam = False
        if "mic_lock" in m or "lowbw" in m:
            enforce_sources(k)
    elif t == "recording":  # 선생님 컴퓨터에서 녹화를 시작·종료했다 → 학생 화면에 표시
        on = bool(m.get("on")) and ALLOW_RECORDING
        if on != k.recording:
            k.recording = on
            log_recording(k, on)
    elif t == "cmd":  # 선생님이 학생 마이크·카메라를 켜고 끈다
        device_cmd(k, m.get("cmd"), m.get("target"))
    elif t == "allow_mic":  # (예전 화면용) 마이크·카메라 권한 주기/거두기
        on = bool(m.get("on"))
        device_cmd(k, "mic_on" if on else "mic_off", m.get("target"))
        device_cmd(k, "cam_on" if on else "cam_off", m.get("target"), quiet=True)
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
        if text:  # 학습 관리에서 볼 수 있게 남긴다
            class_id = k.db_id

            def save_notice():
                with db.engine.begin() as c:
                    c.execute(insert(db.announcements).values(class_id=class_id, text=text, created_at=time.time()))

            asyncio.get_running_loop().create_task(db.run(save_notice))
    elif t == "chat":
        text = clean(m.get("text"))
        scope = m.get("scope") or "main"
        dm = scope.startswith("dm:") and scope[3:] in k.students  # 한 학생에게만 1:1 답장
        if text and (scope == "main" or scope in group_ids or dm):
            post_chat(k, {"id": k.next_id(), "role": "teacher", "sid": None, "name": "선생님",
                          "text": text, "scope": scope, "private": dm,
                          "to_name": k.students[scope[3:]].name if dm else None, "ts": time.time()})
            if dm:  # 1:1 답장은 그 학생의 가장 최근 질문 기록에 답변으로 남긴다
                mine = [q for q in k.questions if q["sid"] == scope[3:]]
                if mine:
                    q = next((x for x in reversed(mine) if not x["reply"]), mine[-1])
                    q["reply"] = f"{q['reply']}\n{text}".strip()
                    q["done"] = True
                    write_question(_question_update, q["id"], {"reply": q["reply"], "done": 1, "replied_at": time.time()})
    elif t == "layout":  # 학생 화면 구성
        mode = m.get("mode")
        if mode in ("teacher", "grid", "debate"):
            pair = [str(x) for x in (m.get("pair") or []) if str(x) in k.students][:2] if mode == "debate" else []
            k.layout = {"mode": mode, "pair": pair}
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
        plan_groups(k, groups_needed(k, m))
    elif t == "breakout_setup":
        setup_groups(k, groups_needed(k, m))
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
            plan_groups(k, groups_needed(k, m))
        for s in k.students.values():  # 배정되지 않은 학생은 인원이 적은 모둠으로
            if not s.group or not any(g["id"] == s.group for g in k.groups):
                s.group = smallest_group(k)
        k.breakout = True
        k.breakout_at = time.time()
        # 시간은 미리 정하지 않는다 (선생님이 보고 끝낸다). 예전 화면이 보낸 minutes는 그대로 받아 준다
        minutes = m.get("minutes")
        k.ends_at = time.time() + float(minutes) * 60 if minutes else None
    elif t == "breakout_time":
        minutes = m.get("minutes")
        k.ends_at = time.time() + float(minutes) * 60 if minutes else None
    elif t == "breakout_end":
        k.breakout = False
        k.ends_at = k.breakout_at = None
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
    elif t == "media_open":
        kind, src = m.get("kind"), str(m.get("src") or "")
        ok = (kind == "youtube" and YOUTUBE_ID.match(src)) or (kind == "file" and any(f["id"] == src for f in k.media_files))
        if ok:
            name = next((f["name"] for f in k.media_files if f["id"] == src), "") if kind == "file" else ""
            k.media = {"kind": kind, "src": src, "title": clean(m.get("title"), 80) or name or "유튜브 영상",
                       "ext": next((f["ext"] for f in k.media_files if f["id"] == src), "") if kind == "file" else "",
                       "playing": False, "pos": 0.0, "at": time.time()}
    elif t == "media_ctrl" and k.media:
        try:
            k.media["pos"] = max(0.0, float(m.get("pos") or 0))
        except (TypeError, ValueError):
            pass
        k.media["playing"] = bool(m.get("playing"))
        k.media["at"] = time.time()
    elif t == "media_close":
        k.media = None
    elif t == "sticker" and m.get("s") in STICKERS:
        target = m.get("target")
        st = k.students.get(str(target)) if target else None
        if target and not st:
            return
        if st:
            k.stickers[st.id] = k.stickers.get(st.id, 0) + 1
        fx = {"t": "sticker", "s": m["s"], "label": STICKERS[m["s"]], "target": st.id if st else None,
              "name": st.name if st else None, "ts": time.time()}
        for c in k.conns:
            send(c, fx)
    elif t == "end_class":
        save_activity(k, k.activity)
        remove_media_files(k)
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
        asyncio.get_running_loop().create_task(save_boards(k))  # 자료·판서는 남겨 둔다(지난 수업 자료)
        class_id = k.db_id

        def run():
            with db.engine.begin() as c:
                c.execute(update(db.classes).where(db.classes.c.id == class_id).values(ended_at=ended_at))
                if open_ids:
                    c.execute(update(db.attendance).where(db.attendance.c.id.in_(open_ids))
                              .values(left_at=ended_at, last_seen=ended_at, left_reason="ended"))

        asyncio.get_running_loop().create_task(db.run(run))


def media_dir(k: Klass) -> Path:
    return class_dir(k) / "media"


def remove_media_files(k: Klass) -> None:
    """미디어 공유로 올린 동영상·음악은 수업이 끝나면 지운다 (자료·판서와 달리 남기지 않음)."""
    for f in k.media_files:
        (media_dir(k) / f"{f['id']}{f['ext']}").unlink(missing_ok=True)
    k.media_files.clear()
    k.media = None


def log_recording(k: Klass, on: bool) -> None:
    """녹화 시작·종료를 입·퇴장 기록과 채팅에 남긴다 (누가 언제 녹화했는지 확인할 수 있게)"""
    now = time.time()
    k.events.append({"ts": now, "sid": None, "name": "선생님", "kind": "record_on" if on else "record_off", "reason": None})
    del k.events[:-100]
    post_chat(k, {"id": k.next_id(), "role": "system", "sid": None, "name": "안내",
                  "text": "🔴 선생님이 수업 녹화를 시작했어요." if on else "⏹ 수업 녹화가 끝났어요.",
                  "scope": "main", "ts": now})


def device_cmd(k: Klass, cmd: str | None, target, quiet: bool = False) -> None:
    """선생님 권한으로 학생 마이크·카메라 켜기/끄기.
    - 켜기: 권한을 주고(화상 서버에 반영) 학생 화면이 바로 켠다(입장할 때 받은 기기 사용 허락으로 켬).
    - 끄기: 학생 화면이 끄고, 마이크 통제·데이터 절약 모드라면 권한도 거둬 학생이 다시 켤 수 없다.
    target 이 "all" 이면 모든 학생."""
    if cmd == "mute":
        cmd = "mic_off"
    if cmd not in ("mic_on", "mic_off", "cam_on", "cam_off"):
        return
    targets = list(k.students.values()) if target == "all" else [x for x in [k.students.get(str(target))] if x]
    if not targets:
        return
    mic = cmd.startswith("mic")
    on = cmd.endswith("_on")
    for s in targets:
        if mic:
            s.mic_req = False  # 요청을 처리했으므로 지운다 (✋ 손 들기는 그대로 둔다)
            s.can_speak = on
            # 한 학생의 마이크를 끄면 선생님이 다시 켜 줄 때까지 그 학생은 못 켠다 (모두 음소거는 끄기만)
            s.mic_blocked = (not on) and target != "all"
        else:
            s.can_cam = on  # 카메라는 켜고 끄기만 한다. 학생이 언제든 다시 켤 수 있다
    enforce_sources(k, targets)
    if not quiet or on:
        # 예전 화면과 맞추기 위해 끄기는 mute·cam_off 이름으로 보낸다
        name = {"mic_off": "mute", "cam_off": "cam_off"}.get(cmd, cmd)
        for s in targets:
            send_to_students(k, {"t": "cmd", "cmd": name}, s.id)


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
