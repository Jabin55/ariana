"""수업 자료(PDF)와 과제 제출 파일 자동 삭제: 과목이 끝나고 1년이 지나면 지운다.

- 과목(강좌) 수업: 과목 끝나는 날(end_date)부터 365일이 지나면
  · 그 과목 수업들의 발표 자료(PDF)와 그 위 판서
  · 그 과목 과제에 학생이 낸 파일 (점수·피드백·글 제출은 남긴다)
- 과목 없이 연 수업(특강·회의): 수업을 연 날부터 365일이 지나면 발표 자료와 판서
탈퇴 학생의 분리 보관 증빙(evidence)은 따로 정한 보존 기간을 따른다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import date, timedelta

from sqlalchemy import and_, delete, or_, select

from app import db
from app.wipe import wipe

KEEP_DAYS = 365
log = logging.getLogger(__name__)


def purge_expired_files(today: date | None = None) -> dict:
    from app.assignments import file_path
    from app.classroom import SLIDES_DIR

    today = today or date.today()
    cutoff = (today - timedelta(days=KEEP_DAYS)).isoformat()  # 이 날보다 먼저 끝난 과목
    cutoff_ts = time.mktime((today - timedelta(days=KEEP_DAYS)).timetuple())
    co, cl, m = db.courses.c, db.classes.c, db.materials.c
    removed_materials, removed_files = [], []
    with db.engine.begin() as c:
        done = [r.id for r in c.execute(select(co.id).where(co.end_date != "", co.end_date < cutoff))]
        # 수업 자료: 끝난 지 1년 지난 과목의 수업 + 과목 없이 연 지 1년 지난 수업
        old_classes = select(cl.id).where(or_(cl.course_id.in_(done or [-1]),
                                              and_(cl.course_id.is_(None), cl.created_at < cutoff_ts)))
        mats = c.execute(select(m.id, m.class_id).where(m.class_id.in_(old_classes))).all()
        for x in mats:
            c.execute(delete(db.boards).where(db.boards.c.class_id == x.class_id, db.boards.c.key.like(f"{x.id}:%")))
        c.execute(delete(db.materials).where(m.id.in_([x.id for x in mats] or ["-"])))
        removed_materials = [(x.class_id, x.id) for x in mats]
        # 과제 제출 파일
        a, s, f = db.assignments.c, db.submissions.c, db.submission_files.c
        rows = c.execute(select(f.id, s.assignment_id).join(db.submissions, s.id == f.submission_id)
                         .join(db.assignments, a.id == s.assignment_id)
                         .where(a.course_id.in_(done or [-1]))).all()
        c.execute(delete(db.submission_files).where(f.id.in_([r.id for r in rows] or ["-"])))
        removed_files = [(r.assignment_id, r.id) for r in rows]
    for class_id, fid in removed_materials:
        wipe(SLIDES_DIR / str(class_id) / f"{fid}.pdf")
    for assignment_id, fid in removed_files:
        wipe(file_path(assignment_id, fid))
    return {"materials": len(removed_materials), "submission_files": len(removed_files)}


async def file_retention_loop():
    while True:
        try:
            result = await db.run(purge_expired_files)
            if any(result.values()):
                log.info("보관 기간이 지난 파일 삭제: 수업 자료 %d개, 과제 파일 %d개",
                         result["materials"], result["submission_files"])
        except Exception:
            log.exception("수업 자료·과제 파일 자동 삭제 실패: 운영자 확인 필요")
        await asyncio.sleep(6 * 3600)
