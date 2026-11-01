"""강좌별 익명 집계 만족도 조사. 교사에게는 개인 응답을 제공하지 않는다."""

from __future__ import annotations

import json
import random
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictInt
from sqlalchemy import delete, exists, func, insert, select, update
from sqlalchemy.exc import IntegrityError

from app import db
from app.auth import require_user
from app.courses import is_enrolled, owned_course
from app.privacy_filter import known_member_names, redact


router = APIRouter()
PRIVATE = {"Cache-Control": "private, no-store"}
LEGACY_QUESTIONS = (
    ("content", "수업 내용과 자료는 학습에 도움이 되었나요?"),
    ("communication", "강의교사의 설명과 소통에 만족했나요?"),
    ("environment", "온라인 수업 환경은 참여하기 편리했나요?"),
)
DEFAULT_QUESTIONS = (
    ("교육과정", "운영학교 수업의 난이도는 이해하기 적절한 수준이었다."),
    ("교육과정", "운영학교 수업이 나의 진학이나 진로에 도움이 되었다."),
    ("교육과정", "운영학교 수업 분량은 적절하다."),
    ("교수학습활동", "강사는 강의 내용에 대해 충분한 지식을 갖고 있었다."),
    ("교수학습활동", "강사는 열정을 가지고 성실하게 강의에 임했다."),
    ("교수학습활동", "강사는 흥미로운 수업방법을 활용하여 효과적인 수업활동을 전개하였다."),
    ("운영", "환경(기자재, 교실, 시간, 수강인원 등)은 만족스러웠다."),
    ("운영", "운영학교의 학생모집 및 선발과정은 적절했다."),
    ("운영", "운영학교의 등·하교 및 출결지도는 만족스러웠다."),
    ("기타", "운영학교 수업운영이 사교육 절감에 많은 도움이 된다고 생각한다."),
    ("기타", "운영학교 수업이 나의 특기와 적성을 살리는 데 도움이 되었다."),
    ("기타", "운영학교 수업에 관심 있는 친구들에게 알리거나 권하고 싶다."),
)


class SatisfactionAnswer(BaseModel):
    ratings: list[StrictInt] = Field(min_length=3, max_length=12)
    comment: str = Field(default="", max_length=2000)


class SurveyPublish(BaseModel):
    questions: list[str] | None = Field(default=None, min_length=12, max_length=12)
    narrative_prompt: str | None = Field(default=None, max_length=500)


def survey_questions(survey) -> list[dict]:
    """새 조사는 12문항, 이미 공개된 예전 조사는 3문항을 유지한다."""
    try:
        saved = json.loads(survey.questions or "") if survey else None
    except (ValueError, TypeError):
        saved = None
    if isinstance(saved, list) and len(saved) == 12 and all(isinstance(x, str) for x in saved):
        return [{"category": category, "text": text} for (category, _), text in zip(DEFAULT_QUESTIONS, saved)]
    if survey:
        if not isinstance(saved, list) or len(saved) != 3 or not all(isinstance(x, str) for x in saved):
            saved = [text for _, text in LEGACY_QUESTIONS]
        return [{"category": "기존 조사", "text": text} for text in saved]
    return [{"category": category, "text": text} for category, text in DEFAULT_QUESTIONS]


def checked_questions(body: SurveyPublish | None) -> list[str]:
    questions = body.questions if body and body.questions is not None else [text for _, text in DEFAULT_QUESTIONS]
    cleaned = [" ".join(question.split()) for question in questions]
    if any(len(question) < 5 or len(question) > 200 for question in cleaned) or len(set(cleaned)) != len(cleaned):
        raise HTTPException(400, "서로 다른 문항 12개를 각각 5~200자로 입력해 주세요.")
    return cleaned


def narrative_prompt(term: str, question_count: int) -> str:
    if question_count != 12:
        return ""
    return (f"※ {term or '이번 학기'} 학교 간 공동교육과정 운영에 관해 좋았던 점과 "
            "개선해야 할 점을 자유롭게 서술하여 주시기 바랍니다.")


def survey_narrative_prompt(survey, term: str, question_count: int) -> str:
    if question_count != 12:
        return ""
    return (survey.narrative_prompt or narrative_prompt(term, question_count)) if survey else narrative_prompt(term, question_count)


def upgrade_empty_legacy_survey(course_id: int) -> None:
    """응답이 전혀 없는 예전 3문항 조사만 현재 기본 양식으로 전환한다."""
    with db.engine.begin() as c:
        survey = c.execute(select(db.course_satisfaction_surveys).where(
            db.course_satisfaction_surveys.c.course_id == course_id).with_for_update()).first()
        if not survey or len(survey_questions(survey)) != 3:
            return
        term = c.execute(select(db.courses.c.term).where(db.courses.c.id == course_id)).scalar() or ""
        no_responses = ~exists(select(db.course_satisfaction_responses.c.id).where(
            db.course_satisfaction_responses.c.course_id == course_id))
        c.execute(update(db.course_satisfaction_surveys).where(
            db.course_satisfaction_surveys.c.course_id == course_id, no_responses).values(
                questions=json.dumps([text for _, text in DEFAULT_QUESTIONS], ensure_ascii=False),
                narrative_prompt=narrative_prompt(term, 12)))


@router.get("/api/my/courses/{course_id}/satisfaction")
async def my_satisfaction(course_id: int, request: Request):
    student = await require_user(request, "student")
    if not await db.run(is_enrolled, course_id, student["id"]):
        raise HTTPException(404, "수강 중인 강좌를 찾을 수 없어요.")
    await db.run(upgrade_empty_legacy_survey, course_id)

    def read():
        with db.engine.connect() as c:
            survey = c.execute(select(db.course_satisfaction_surveys).where(
                db.course_satisfaction_surveys.c.course_id == course_id)).first()
            submitted = c.execute(select(db.course_satisfaction_responses.c.id).where(
                db.course_satisfaction_responses.c.course_id == course_id,
                db.course_satisfaction_responses.c.user_id == student["id"])).first() is not None
            term = c.execute(select(db.courses.c.term).where(db.courses.c.id == course_id)).scalar() or ""
        questions = survey_questions(survey)
        return {"open": bool(survey and survey.closed_at is None),
                "submitted": submitted,
                "questions": questions,
                "narrative_prompt": survey_narrative_prompt(survey, term, len(questions))}

    return JSONResponse(await db.run(read), headers=PRIVATE)


@router.post("/api/my/courses/{course_id}/satisfaction")
async def submit_satisfaction(course_id: int, body: SatisfactionAnswer, request: Request):
    student = await require_user(request, "student")
    if not await db.run(is_enrolled, course_id, student["id"]):
        raise HTTPException(404, "수강 중인 강좌를 찾을 수 없어요.")
    await db.run(upgrade_empty_legacy_survey, course_id)
    if any(score < 1 or score > 5 for score in body.ratings):
        raise HTTPException(400, "각 문항에 1~5점으로 답해 주세요.")
    comment = redact(body.comment.strip(), await db.run(known_member_names)) if body.comment.strip() else ""

    def save():
        with db.engine.begin() as c:
            survey = c.execute(select(db.course_satisfaction_surveys).where(
                db.course_satisfaction_surveys.c.course_id == course_id)).first()
            if not survey or survey.closed_at is not None:
                raise HTTPException(409, "현재 만족도 조사를 받지 않아요.")
            if len(body.ratings) != len(survey_questions(survey)):
                raise HTTPException(400, "공개된 문항 모두에 답해 주세요.")
            c.execute(insert(db.course_satisfaction_responses).values(
                course_id=course_id, user_id=student["id"],
                **{key: score for (key, _), score in zip(LEGACY_QUESTIONS, body.ratings[:3])},
                ratings=json.dumps(body.ratings), comment=comment if len(body.ratings) == 12 else "",
                submitted_at=time.time()))

    try:
        await db.run(save)
    except IntegrityError:
        raise HTTPException(409, "이미 만족도 조사에 응답했어요.") from None
    return JSONResponse({"ok": True}, headers=PRIVATE)


@router.get("/api/courses/{course_id}/satisfaction")
async def teacher_satisfaction(course_id: int, request: Request):
    teacher = await require_user(request, "teacher")
    course = await db.run(owned_course, course_id, teacher)
    await db.run(upgrade_empty_legacy_survey, course_id)

    def read():
        with db.engine.connect() as c:
            survey = c.execute(select(db.course_satisfaction_surveys).where(
                db.course_satisfaction_surveys.c.course_id == course_id)).first()
            enrolled = c.execute(select(func.count()).select_from(db.enrollments).where(
                db.enrollments.c.course_id == course_id,
                db.enrollments.c.status == "approved")).scalar_one()
            responses = c.execute(select(db.course_satisfaction_responses.c.content,
                                         db.course_satisfaction_responses.c.communication,
                                         db.course_satisfaction_responses.c.environment,
                                         db.course_satisfaction_responses.c.ratings,
                                         db.course_satisfaction_responses.c.comment).where(
                db.course_satisfaction_responses.c.course_id == course_id)).all()
        questions = survey_questions(survey)
        scored = []
        for row in responses:
            try:
                ratings = json.loads(row.ratings) if row.ratings else [row.content, row.communication, row.environment]
            except (ValueError, TypeError):
                continue
            if len(ratings) == len(questions) and all(type(score) is int and 1 <= score <= 5 for score in ratings):
                scored.append((ratings, row.comment))
        count = len(scored)
        closed = bool(survey and survey.closed_at is not None)
        if closed and not responses and len(questions) == 3:
            questions = survey_questions(None)
        result = {"started": bool(survey), "open": bool(survey and not closed),
                  "closed": closed, "responses": count, "enrolled": enrolled,
                  "results_available": closed and count > 0,
                  "questions": questions,
                  "narrative_prompt": survey_narrative_prompt(survey, course.term, len(questions))}
        if result["results_available"]:
            result["results"] = [{"category": question["category"], "question": question["text"],
                                   "average": round(sum(ratings[i] for ratings, _ in scored) / count, 1),
                                   "counts": [sum(ratings[i] == rating for ratings, _ in scored)
                                              for rating in range(1, 6)]}
                                  for i, question in enumerate(questions)]
            comments = [comment for _, comment in scored if comment]
            random.SystemRandom().shuffle(comments)
            result["comments"] = comments
        return result

    return JSONResponse(await db.run(read), headers=PRIVATE)


@router.post("/api/courses/{course_id}/satisfaction/open")
async def open_satisfaction(course_id: int, request: Request, body: SurveyPublish | None = None):
    teacher = await require_user(request, "teacher")
    course = await db.run(owned_course, course_id, teacher)
    questions = checked_questions(body)
    prompt = (body.narrative_prompt if body and body.narrative_prompt is not None
              else narrative_prompt(course.term, len(questions))).strip()
    if len(prompt) < 10:
        raise HTTPException(400, "서술 의견 안내 문구를 10자 이상 입력해 주세요.")

    def open_survey():
        with db.engine.begin() as c:
            survey = c.execute(select(db.course_satisfaction_surveys).where(
                db.course_satisfaction_surveys.c.course_id == course_id)).first()
            if not survey:
                c.execute(insert(db.course_satisfaction_surveys).values(
                    course_id=course_id, opened_at=time.time(),
                    questions=json.dumps(questions, ensure_ascii=False), narrative_prompt=prompt))
            elif survey.closed_at is not None:
                count = c.execute(select(func.count()).select_from(db.course_satisfaction_responses).where(
                    db.course_satisfaction_responses.c.course_id == course_id)).scalar_one()
                if count:
                    raise HTTPException(409, "기존 응답이 있으므로 문항 수정 없이 '조사 다시 열기'를 이용해 주세요.")
                c.execute(update(db.course_satisfaction_surveys).where(
                    db.course_satisfaction_surveys.c.course_id == course_id).values(
                        opened_at=time.time(), closed_at=None,
                        questions=json.dumps(questions, ensure_ascii=False), narrative_prompt=prompt))
            elif body and body.questions is not None and questions != [q["text"] for q in survey_questions(survey)]:
                raise HTTPException(409, "이미 공개한 조사 문항은 변경할 수 없어요.")
            elif body and body.narrative_prompt is not None and prompt != survey_narrative_prompt(survey, course.term, 12):
                raise HTTPException(409, "이미 공개한 서술 의견 문구는 변경할 수 없어요.")

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


@router.post("/api/courses/{course_id}/satisfaction/reopen")
async def reopen_satisfaction(course_id: int, request: Request):
    teacher = await require_user(request, "teacher")
    await db.run(owned_course, course_id, teacher)

    def reopen_survey():
        with db.engine.begin() as c:
            survey = c.execute(select(db.course_satisfaction_surveys).where(
                db.course_satisfaction_surveys.c.course_id == course_id)).first()
            if not survey:
                raise HTTPException(409, "먼저 만족도 조사를 시작해 주세요.")
            if survey.closed_at is not None:
                c.execute(update(db.course_satisfaction_surveys).where(
                    db.course_satisfaction_surveys.c.course_id == course_id).values(
                        opened_at=time.time(), closed_at=None))

    await db.run(reopen_survey)
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
