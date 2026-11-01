"""강좌별 익명 집계 만족도 조사. 교사에게는 개인 응답을 제공하지 않는다."""

from __future__ import annotations

import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictInt
from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.exc import IntegrityError

from app import db
from app.auth import require_user
from app.courses import is_enrolled, owned_course


router = APIRouter()
PRIVATE = {"Cache-Control": "private, no-store"}
QUESTIONS = (
    ("content", "수업 내용과 자료는 학습에 도움이 되었나요?"),
    ("communication", "강의교사의 설명과 소통에 만족했나요?"),
    ("environment", "온라인 수업 환경은 참여하기 편리했나요?"),
)


class SatisfactionAnswer(BaseModel):
    ratings: list[StrictInt] = Field(min_length=3, max_length=3)


@router.get("/api/my/courses/{course_id}/satisfaction")
async def my_satisfaction(course_id: int, request: Request):
    student = await require_user(request, "student")
    if not await db.run(is_enrolled, course_id, student["id"]):
        raise HTTPException(404, "수강 중인 강좌를 찾을 수 없어요.")

    def read():
        with db.engine.connect() as c:
            survey = c.execute(select(db.course_satisfaction_surveys).where(
                db.course_satisfaction_surveys.c.course_id == course_id)).first()
            submitted = c.execute(select(db.course_satisfaction_responses.c.id).where(
                db.course_satisfaction_responses.c.course_id == course_id,
                db.course_satisfaction_responses.c.user_id == student["id"])).first() is not None
        return {"open": bool(survey and survey.closed_at is None),
                "submitted": submitted,
                "questions": [{"key": key, "text": text} for key, text in QUESTIONS]}

    return JSONResponse(await db.run(read), headers=PRIVATE)


@router.post("/api/my/courses/{course_id}/satisfaction")
async def submit_satisfaction(course_id: int, body: SatisfactionAnswer, request: Request):
    student = await require_user(request, "student")
    if not await db.run(is_enrolled, course_id, student["id"]):
        raise HTTPException(404, "수강 중인 강좌를 찾을 수 없어요.")
    if any(score < 1 or score > 5 for score in body.ratings):
        raise HTTPException(400, "각 문항에 1~5점으로 답해 주세요.")

    def save():
        with db.engine.begin() as c:
            survey = c.execute(select(db.course_satisfaction_surveys).where(
                db.course_satisfaction_surveys.c.course_id == course_id)).first()
            if not survey or survey.closed_at is not None:
                raise HTTPException(409, "현재 만족도 조사를 받지 않아요.")
            c.execute(insert(db.course_satisfaction_responses).values(
                course_id=course_id, user_id=student["id"],
                **{key: score for (key, _), score in zip(QUESTIONS, body.ratings)},
                submitted_at=time.time()))

    try:
        await db.run(save)
    except IntegrityError:
        raise HTTPException(409, "이미 만족도 조사에 응답했어요.") from None
    return JSONResponse({"ok": True}, headers=PRIVATE)


@router.get("/api/courses/{course_id}/satisfaction")
async def teacher_satisfaction(course_id: int, request: Request):
    teacher = await require_user(request, "teacher")
    await db.run(owned_course, course_id, teacher)

    def read():
        with db.engine.connect() as c:
            survey = c.execute(select(db.course_satisfaction_surveys).where(
                db.course_satisfaction_surveys.c.course_id == course_id)).first()
            enrolled = c.execute(select(func.count()).select_from(db.enrollments).where(
                db.enrollments.c.course_id == course_id,
                db.enrollments.c.status == "approved")).scalar_one()
            responses = c.execute(select(db.course_satisfaction_responses.c.content,
                                         db.course_satisfaction_responses.c.communication,
                                         db.course_satisfaction_responses.c.environment).where(
                db.course_satisfaction_responses.c.course_id == course_id)).all()
        count = len(responses)
        closed = bool(survey and survey.closed_at is not None)
        result = {"started": bool(survey), "open": bool(survey and not closed),
                  "closed": closed, "responses": count, "enrolled": enrolled,
                  "results_available": closed and count >= 3}
        if result["results_available"]:
            result["results"] = [{"question": text,
                                   "average": round(sum(getattr(row, key) for row in responses) / count, 1),
                                   "counts": [sum(getattr(row, key) == rating for row in responses)
                                              for rating in range(1, 6)]}
                                  for key, text in QUESTIONS]
        return result

    return JSONResponse(await db.run(read), headers=PRIVATE)


@router.post("/api/courses/{course_id}/satisfaction/open")
async def open_satisfaction(course_id: int, request: Request):
    teacher = await require_user(request, "teacher")
    await db.run(owned_course, course_id, teacher)

    def open_survey():
        with db.engine.begin() as c:
            survey = c.execute(select(db.course_satisfaction_surveys).where(
                db.course_satisfaction_surveys.c.course_id == course_id)).first()
            if not survey:
                c.execute(insert(db.course_satisfaction_surveys).values(
                    course_id=course_id, opened_at=time.time()))
            elif survey.closed_at is not None:
                count = c.execute(select(func.count()).select_from(db.course_satisfaction_responses).where(
                    db.course_satisfaction_responses.c.course_id == course_id)).scalar_one()
                if count:
                    raise HTTPException(409, "익명 집계 보호를 위해 마감한 조사는 다시 열 수 없어요.")
                c.execute(update(db.course_satisfaction_surveys).where(
                    db.course_satisfaction_surveys.c.course_id == course_id).values(
                        opened_at=time.time(), closed_at=None))

    await db.run(open_survey)
    return JSONResponse({"ok": True}, headers=PRIVATE)


@router.post("/api/courses/{course_id}/satisfaction/close")
async def close_satisfaction(course_id: int, request: Request):
    teacher = await require_user(request, "teacher")
    await db.run(owned_course, course_id, teacher)

    def close_survey():
        with db.engine.begin() as c:
            survey = c.execute(select(db.course_satisfaction_surveys).where(
                db.course_satisfaction_surveys.c.course_id == course_id)).first()
            if not survey:
                raise HTTPException(409, "먼저 만족도 조사를 시작해 주세요.")
            if survey.closed_at is None:
                c.execute(update(db.course_satisfaction_surveys).where(
                    db.course_satisfaction_surveys.c.course_id == course_id).values(closed_at=time.time()))

    await db.run(close_survey)
    return JSONResponse({"ok": True}, headers=PRIVATE)


def purge_old_satisfaction(today: date | None = None) -> int:
    """수강 학년도 종료 후 5년이 지난 개인 응답을 삭제한다."""
    today = today or datetime.now(ZoneInfo("Asia/Seoul")).date()
    with db.engine.begin() as c:
        rows = c.execute(select(db.course_satisfaction_responses.c.id,
                                db.course_satisfaction_responses.c.submitted_at,
                                db.courses.c.school_year,
                                db.courses.c.end_date)
                         .select_from(db.course_satisfaction_responses.outerjoin(
                             db.courses,
                             db.course_satisfaction_responses.c.course_id == db.courses.c.id))).all()
        expired = []
        for row in rows:
            if row.school_year:
                expiry = date(row.school_year + 6, 3, 1)
            elif row.end_date:
                try:
                    expiry = date.fromisoformat(row.end_date) + timedelta(days=1825)
                except ValueError:
                    expiry = datetime.fromtimestamp(row.submitted_at, ZoneInfo("Asia/Seoul")).date() + timedelta(days=1825)
            else:
                expiry = datetime.fromtimestamp(row.submitted_at, ZoneInfo("Asia/Seoul")).date() + timedelta(days=1825)
            if today >= expiry:
                expired.append(row.id)
        if expired:
            c.execute(delete(db.course_satisfaction_responses).where(
                db.course_satisfaction_responses.c.id.in_(expired)))
        return len(expired)
