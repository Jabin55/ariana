"""AI 제공업체로 보내기 전에 학생 식별정보를 서버에서 가린다."""

from __future__ import annotations

import re

from sqlalchemy import select

from app import db

EMAIL = re.compile(r"(?<![\w@])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w@])")
PHONE = re.compile(r"(?<!\d)(?:0\d{1,2}[- .]?)?\d{3,4}[- .]?\d{4}(?!\d)")
STUDENT_NUMBER = re.compile(r"(?<!\d)\d{5}(?!\d)")
LABELLED_NUMBER = re.compile(r"(학번\s*(?:은|:|：|이)?\s*)[\d -]{3,15}")
CLASS_NUMBER = re.compile(r"\d\s*학년\s*\d{1,2}\s*반\s*\d{1,2}\s*번")
LABELLED_NAME = re.compile(r"((?:제\s*)?(?:이름|성명)\s*(?:은|이|:|：)?\s*)[가-힣]{2,10}")


def known_member_names() -> list[str]:
    with db.engine.connect() as c:
        rows = c.execute(select(db.users.c.name, db.users.c.google_name).where(
            db.users.c.account_state == "active"))
        names = (name.strip() for row in rows for name in row if name)
        return sorted({name for name in names if len(name) >= 2}, key=len, reverse=True)


def redact(text: str, names: list[str]) -> str:
    text = EMAIL.sub("[이메일 삭제]", text)
    text = CLASS_NUMBER.sub("[학번 삭제]", text)
    text = LABELLED_NUMBER.sub(r"\1[학번 삭제]", text)
    text = PHONE.sub("[번호 삭제]", text)
    text = STUDENT_NUMBER.sub("[학번 삭제]", text)
    text = LABELLED_NAME.sub(r"\1[이름 삭제]", text)
    for name in names:
        text = re.sub(r"(?<![가-힣0-9])" + re.escape(name), "[이름 삭제]", text)
    return text


def redact_messages(messages: list[dict], names: list[str]) -> list[dict]:
    return [{**m, "content": redact(m["content"], names)} for m in messages]
