"""회원·수업·출결·퀴즈 결과를 저장하는 데이터베이스.

DATABASE_URL 이 있으면 PostgreSQL(예: Neon 무료), 없으면 로컬 SQLite 파일을 쓴다.
Render 무료 서버는 껐다 켜면 파일이 지워지므로, 배포할 때는 반드시 DATABASE_URL 을 설정한다.
"""

from __future__ import annotations

import asyncio
import os
import time

from sqlalchemy import (
    Column, Float, Integer, MetaData, String, Table, Text, create_engine, update,
)

_url = os.environ.get("DATABASE_URL", "sqlite:///./live.db")
if _url.startswith("postgres://"):
    _url = "postgresql://" + _url[len("postgres://"):]
if _url.startswith("postgresql://"):
    _url = "postgresql+psycopg://" + _url[len("postgresql://"):]

_args = {"check_same_thread": False} if _url.startswith("sqlite") else {}
engine = create_engine(_url, pool_pre_ping=True, pool_recycle=280, connect_args=_args)
metadata = MetaData()

users = Table(
    "users", metadata,
    Column("id", Integer, primary_key=True),
    Column("google_sub", String(64), unique=True, nullable=False),
    Column("email", String(200), nullable=False, index=True),
    Column("google_name", String(100), default=""),
    Column("role", String(10), nullable=False),  # student | teacher
    Column("name", String(30), default=""),  # 실명 (학생이 확인·수정)
    Column("school", String(60), default=""),
    Column("grade", Integer),
    Column("class_no", Integer),
    Column("number", Integer),
    Column("created_at", Float, nullable=False),
    Column("last_login", Float),
)

classes = Table(
    "classes", metadata,
    Column("id", Integer, primary_key=True),
    Column("code", String(8), nullable=False, index=True),
    Column("title", String(60), nullable=False),
    Column("teacher_id", Integer, nullable=False, index=True),
    Column("school", String(60), default=""),
    Column("target_grade", Integer),
    Column("target_class", Integer),
    Column("created_at", Float, nullable=False, index=True),
    Column("ended_at", Float),
)

attendance = Table(
    "attendance", metadata,
    Column("id", Integer, primary_key=True),
    Column("class_id", Integer, nullable=False, index=True),
    Column("user_id", Integer, nullable=False, index=True),
    Column("joined_at", Float, nullable=False),
    Column("left_at", Float),
    Column("last_seen", Float, nullable=False),
)

activities = Table(
    "activities", metadata,
    Column("id", Integer, primary_key=True),
    Column("class_id", Integer, nullable=False, index=True),
    Column("kind", String(10), nullable=False),
    Column("prompt", Text, nullable=False),
    Column("options", Text, nullable=False),  # JSON 목록
    Column("correct", Integer),
    Column("responses", Text, nullable=False),  # JSON {user_id: 값}
    Column("created_at", Float, nullable=False),
)


def init() -> None:
    metadata.create_all(engine)
    # 서버가 갑자기 꺼져 '접속 중'으로 남은 기록은 마지막 확인 시각에 나간 것으로 정리
    with engine.begin() as c:
        c.execute(update(attendance).where(attendance.c.left_at.is_(None))
                  .values(left_at=attendance.c.last_seen))


async def run(fn, *args):
    """DB 작업은 이벤트 루프를 막지 않도록 별도 스레드에서 실행한다."""
    return await asyncio.to_thread(fn, *args)


def now() -> float:
    return time.time()
