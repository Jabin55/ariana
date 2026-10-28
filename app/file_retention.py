"""수업 자료(PDF)와 과제 제출 파일 자동 삭제.

- 발표 자료(PDF) 파일: 과목 수업은 과목 끝나는 날(end_date)이 지나면 바로, 특강·회의는 끝내면 바로 (서버 공간 절약)
  [수업 종료]를 누르지 않고 닫은 회의는 다시 이어서 열 수 있는 시간(24시간)이 지나면.
  파일 내용만 지우고 공유한 기록(파일명)은 남긴다.
- 판서·화이트보드: 학생 복습용으로 남긴다. 과목이 끝나고(특강·회의는 연 날부터) 365일이 지나면 지운다
- 과제에 학생이 낸 파일: 과목이 끝나고 365일이 지나면 (점수·피드백·글 제출은 남긴다)
탈퇴 학생의 분리 보관 증빙(evidence)은 따로 정한 보존 기간을 따른다.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import date, timedelta

from sqlalchemy import and_, delete, or_, select, update

from app import db
from app.wipe import wipe

KEEP_DAYS = 365  # 판서·화이트보드, 과제 제출 파일
MATERIAL_KEEP_DAYS = 0  # 과목 수업의 발표 자료(PDF): 과목이 끝나면 바로
log = logging.getLogger(__name__)
_MEDIABOX = re.compile(rb"/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]")


def pdf_ratio(path) -> float | None:
    """PDF 첫 쪽의 가로/세로 비율 (MediaBox). 못 읽으면 None"""
    try:
        with open(path, "rb") as f:
            hit = _MEDIABOX.search(f.read(4 * 1024 * 1024))
        if not hit:
            return None
        x0, y0, x1, y1 = (float(v) for v in hit.groups())
        w, h = abs(x1 - x0), abs(y1 - y0)
        return round(w / h, 4) if w > 0 and h > 0 else None
    except (OSError, ValueError):
        return None


def _mark_deleted(c, class_id: int, fid: str) -> None:
    """공유한 기록은 남기고 파기 표시. 남은 판서를 같은 모양으로 보이게 쪽 비율도 적어 둔다"""
    from app.classroom import SLIDES_DIR

    ratio = pdf_ratio(SLIDES_DIR / str(class_id) / f"{fid}.pdf")
    c.execute(update(db.materials).where(db.materials.c.id == fid).values(deleted_at=time.time(), ratio=ratio))


def purge_expired_files(today: date | None = None) -> dict:
    from app.assignments import file_path
    from app.classroom import SLIDES_DIR

    today = today or date.today()
    cutoff = (today - timedelta(days=KEEP_DAYS)).isoformat()  # 이 날보다 먼저 끝난 과목
    co, cl, m = db.courses.c, db.classes.c, db.materials.c
    removed_materials, removed_files = [], []
    with db.engine.begin() as c:
        done = [r.id for r in c.execute(select(co.id).where(co.end_date != "", co.end_date < cutoff))]
        mat_cutoff = (today - timedelta(days=MATERIAL_KEEP_DAYS)).isoformat()
        ended = [r.id for r in c.execute(select(co.id).where(co.end_date != "", co.end_date < mat_cutoff))]
        # 수업 자료: 끝난 과목의 수업 + 끝난 특강·회의
        from app.classroom import CLASS_REVIVE_LIMIT
        meeting_done = and_(cl.course_id.is_(None),
                            or_(cl.ended_at.isnot(None), cl.created_at < time.time() - CLASS_REVIVE_LIMIT))
        old_classes = select(cl.id).where(or_(cl.course_id.in_(ended or [-1]), meeting_done))
        mats = c.execute(select(m.id, m.class_id).where(m.class_id.in_(old_classes), m.deleted_at.is_(None))).all()
        # 판서·화이트보드: 과목이 끝나고 365일, 과목 없는 수업은 연 날부터 365일이 지나면 지운다
        old_boards = select(cl.id).where(or_(cl.course_id.in_(done or [-1]),
                                             and_(cl.course_id.is_(None), cl.created_at < time.time() - KEEP_DAYS * 86400)))
        c.execute(delete(db.boards).where(db.boards.c.class_id.in_(old_boards)))
        # 공유한 기록(파일명·쪽수)은 남기고 파기 표시만 한다. 파일 내용은 아래에서 복구할 수 없게 지운다
        for x in mats:
            _mark_deleted(c, x.class_id, x.id)
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


def purge_meeting(class_id: int) -> int:
    """특강·회의를 끝낸 직후: 그 회의의 발표 자료(PDF) 파일을 바로 지운다. (판서·화이트보드는 복습용으로 남긴다)"""
    from app.classroom import SLIDES_DIR

    m = db.materials.c
    with db.engine.begin() as c:
        mats = [r.id for r in c.execute(select(m.id).where(m.class_id == class_id, m.deleted_at.is_(None)))]
        for fid in mats:
            _mark_deleted(c, class_id, fid)  # 기록은 남긴다
    for fid in mats:
        wipe(SLIDES_DIR / str(class_id) / f"{fid}.pdf")
    return len(mats)


async def file_retention_loop():
    while True:
        try:
            from app.access_log import purge_old

            old_logs = await db.run(purge_old)
            if old_logs:
                log.info("보관 기간(365일)이 지난 접속기록 삭제: %d건", old_logs)
            result = await db.run(purge_expired_files)
            if any(result.values()):
                log.info("보관 기간이 지난 파일 삭제: 수업 자료 %d개, 과제 파일 %d개",
                         result["materials"], result["submission_files"])
        except Exception:
            log.exception("수업 자료·과제 파일 자동 삭제 실패: 운영자 확인 필요")
        await asyncio.sleep(6 * 3600)
