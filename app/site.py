"""외솔온닷 안내 화면: 소개 · 수강안내 · 수업신청(강좌 목록) · 이용안내.
마이페이지는 /live (로그인 뒤 학생·선생님 화면)."""

from __future__ import annotations

import html

from fastapi import APIRouter
from fastapi.responses import HTMLResponse
from sqlalchemy import select

from app import db
from app.auth import today_kst
from app.courses import course_grades, subject_info
from app.policy import settings

router = APIRouter()


def site_page(title: str, body: str, lead: str = "") -> HTMLResponse:
    return HTMLResponse(f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} · 외솔온닷</title>
<link rel="icon" href="/static/live/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/live/live.css"></head>
<body class="site">
<main class="site-main">
<section class="page-hero"><h1>{html.escape(title)}</h1>{f'<p>{lead}</p>' if lead else ''}</section>
{body}
</main>
<footer class="site-footer">
  <a href="/live/terms">이용약관</a> · <a href="/live/privacy"><strong>개인정보 처리방침</strong></a> · <a href="/live/notice">보호자 안내문·동의서</a>
</footer>
<script src="/static/live/site.js"></script>
</body></html>""")


@router.get("/live/about", response_class=HTMLResponse)
async def about():
    op = html.escape(settings()["operator"])
    return site_page("외솔온닷 소개", f"""
<section class="info-block">
  <h2>집에서 듣는, 울산의 실시간 공동 수업</h2>
  <p>외솔온닷은 울산의 고등학생이 자기 학교에 없는 과목도 거점학교 선생님께 실시간으로 배울 수 있도록 만든 온라인 수업 공간이에요.
  학생은 집에서 학교 구글 계정으로 들어오고, 선생님은 어디서든 수업을 열 수 있어요. 운영: {op}</p>
</section>
<section class="feature-grid">
  <div class="feature"><span class="f-ico">🎥</span><h3>실시간 화상 수업</h3><p>선생님 화면·발표 자료를 크게 보고, 데이터 절약 모드로 휴대폰에서도 부담 없이.</p></div>
  <div class="feature"><span class="f-ico">✍️</span><h3>자료 발표와 판서</h3><p>PDF·PowerPoint를 띄우고 그 위에 바로 판서. 화이트보드도 함께.</p></div>
  <div class="feature"><span class="f-ico">✅</span><h3>퀴즈·투표</h3><p>OX·객관식·주관식으로 바로 확인하고, 결과는 그래프로.</p></div>
  <div class="feature"><span class="f-ico">👥</span><h3>모둠 활동</h3><p>모둠별 회의실에서 토론하고, 선생님은 모든 모둠을 한눈에 살펴요.</p></div>
  <div class="feature"><span class="f-ico">📝</span><h3>과제와 피드백</h3><p>파일로 과제를 내고, 점수와 선생님 피드백을 받아요.</p></div>
  <div class="feature"><span class="f-ico">📚</span><h3>지난 수업 다시 보기</h3><p>수업을 놓쳐도 선생님이 띄운 자료와 판서를 다시 볼 수 있어요.</p></div>
</section>
<section class="info-block">
  <h2>누가 쓰나요</h2>
  <ul class="role-list">
    <li><strong>학생</strong> — 울산 지역 고등학생. 학교 구글 계정으로 가입하고 강좌를 수강신청해요.</li>
    <li><strong>강사</strong> — 거점학교에서 강의하는 선생님(학교 교사, 대학교수 등). 등록을 신청해 승인받아요.</li>
    <li><strong>거점학교 관리교사</strong> — 강사 등록과 학생 수강을 최종 승인해요.</li>
  </ul>
</section>
<section class="cta-row">
  <a class="button primary big" href="/live/courses">개설 강좌 보기</a>
  <a class="button big" href="/live/guide">수강 방법 보기</a>
</section>
""", "울산 어디서나, 함께 듣는 실시간 수업")


@router.get("/live/guide", response_class=HTMLResponse)
async def guide():
    return site_page("수강안내", """
<section class="info-block">
  <h2>수강 순서</h2>
  <ol class="steps">
    <li><strong>학생으로 가입</strong><span>마이페이지에서 '학생으로 시작하기'를 고르고 <b>학교 구글 계정</b>으로 로그인해요. 학교·학년·반·번호와 이름을 정확히 적어요.</span></li>
    <li><strong>수강신청</strong><span>'수업신청'에서 강좌를 보고, 마이페이지의 수강신청에서 신청해요. 내 학년이 대상인 강좌만 신청할 수 있어요.</span></li>
    <li><strong>승인 기다리기</strong><span>강사 선생님이 1차로, 거점학교 관리교사가 최종으로 승인하면 <b>수강 확정</b>이에요.</span></li>
    <li><strong>수업 들어가기</strong><span>수업 시간에 마이페이지 '지금 들어갈 수 있는 수업'에서 바로 들어가요. 코드는 필요 없어요.</span></li>
    <li><strong>과제·복습</strong><span>마이페이지의 '과제'에서 과제를 내고, '지난 수업 자료'로 복습해요.</span></li>
  </ol>
</section>
<section class="info-grid">
  <div class="info-card"><h3>🎧 준비물</h3><p>컴퓨터나 휴대폰(크롬 권장), <b>이어폰</b>. 처음 들어갈 때 카메라·마이크 사용을 <b>허용</b>해 주세요.</p></div>
  <div class="info-card"><h3>🙋 말하고 싶을 때</h3><p>마이크는 선생님이 켜 줘요. '🔒 마이크 요청'을 누르거나, 할 말이 있으면 '✋ 손 들기'.</p></div>
  <div class="info-card"><h3>🕒 출결</h3><p>들어오고 나간 시각이 자동으로 기록돼요. 인터넷이 끊겨도 다시 들어오면 이어서 기록돼요.</p></div>
  <div class="info-card"><h3>📵 지켜 주세요</h3><p>수업 화면을 녹화·캡처해 올리지 마세요. 친구들의 얼굴과 목소리는 소중한 개인정보예요.</p></div>
</section>
""", "가입부터 수업까지, 이렇게 해요")


@router.get("/api/courses/catalog")
async def catalog():
    """로그인 없이 보는 개설 강좌 목록 (학생 개인정보 없음)"""
    def run():
        with db.engine.connect() as c:
            co = db.courses.c
            return c.execute(select(db.courses).where(co.archived == 0, co.open == 1)
                             .order_by(co.hub_school, co.title)).all()

    today = today_kst()
    rows = [r for r in await db.run(run) if not (r.end_date and r.end_date < today)]
    return {"courses": [{"id": r.id, "title": r.title, "instructor": r.instructor, "hub_school": r.hub_school,
                         "start_date": r.start_date, "end_date": r.end_date, "grades": course_grades(r),
                         "description": r.description, **subject_info(r)} for r in rows]}


@router.get("/live/courses", response_class=HTMLResponse)
async def courses_page():
    return site_page("수업신청", """
<section class="info-block">
  <div class="row"><p class="grow" style="margin:0">지금 수강신청을 받는 강좌예요. 신청은 <b>학교 구글 계정으로 로그인</b>한 뒤 마이페이지에서 해요.</p>
  <a class="button primary" href="/live">로그인하고 신청하기</a></div>
  <div class="row" style="margin-top:12px">
    <input id="q" placeholder="강좌·선생님·학교 검색" style="flex:1;min-width:180px">
    <select id="g"><option value="">모든 학년</option><option value="1">1학년</option><option value="2">2학년</option><option value="3">3학년</option></select>
  </div>
</section>
<section class="catalog" id="catalog"><p class="muted">불러오는 중…</p></section>
<script>
(async () => {
  const box = document.getElementById("catalog");
  const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const d = (s) => (s || "").replaceAll("-", ".");
  let list = [];
  try { list = (await (await fetch("/api/courses/catalog")).json()).courses; } catch { box.innerHTML = '<p class="error">강좌 목록을 불러오지 못했어요.</p>'; return; }
  const draw = () => {
    const q = document.getElementById("q").value.trim();
    const g = Number(document.getElementById("g").value);
    const shown = list.filter((c) => (!q || [c.title, c.instructor, c.hub_school, c.description, c.subject_area, c.subject_group].join(" ").includes(q))
      && (!g || !c.grades.length || c.grades.includes(g)));
    const state = { open: ["모집 중", "ok"], before: ["모집 예정", "soft"], closed: ["마감", "off"] };
    box.innerHTML = shown.length ? shown.map((c) => {
      const [label, cls] = state[c.recruit] || state.open;
      const facts = [
        c.subject_area || c.subject_type ? ["과목", [c.subject_area, c.custom_subject ? "고시외 과목" : c.subject_type].filter(Boolean).join(" · ")] : null,
        c.term ? ["학기", `${c.school_year || ""}학년도 ${c.term}`] : null,
        c.credits ? ["학점", `${c.credits}학점 (${c.hours}시간)`] : null,
        c.achievement_text ? ["성취도", c.achievement_text] : null,
        c.exam_ratio != null && c.perf_ratio != null ? ["평가", `지필 ${c.exam_ratio}% · 수행 ${c.perf_ratio}%`] : null,
        c.recruit_start ? ["모집", `${d(c.recruit_start)} ~ ${d(c.recruit_end)}`] : null,
        c.capacity ? ["인원", `${c.capacity}명`] : null,
        c.team_teaching ? ["팀티칭", "예"] : null,
      ].filter(Boolean);
      return `<article class="course-tile">
      <div class="ct-top"><span class="tag ${cls}">${label}</span><span class="tag">${esc(c.hub_school)}</span>${c.grades.length ? `<span class="tag soft">${c.grades.join("·")}학년</span>` : '<span class="tag soft">전 학년</span>'}</div>
      <h3>${esc(c.title)}</h3>
      <p class="muted">강사 ${esc(c.instructor)} · 수업 ${d(c.start_date)} ~ ${d(c.end_date)}</p>
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}
      ${c.description ? `<p class="ct-desc">${esc(c.description)}</p>` : ""}
      ${c.syllabus ? `<p><a href="${c.syllabus.url}" target="_blank">📄 수업계획서 (${esc(c.syllabus.name)})</a></p>` : ""}
    </article>`;
    }).join("") : '<p class="muted">조건에 맞는 강좌가 없어요.</p>';
  };
  document.getElementById("q").addEventListener("input", draw);
  document.getElementById("g").addEventListener("change", draw);
  draw();
})();
</script>
""", "지금 신청할 수 있는 강좌")


@router.get("/live/help", response_class=HTMLResponse)
async def help_page():
    s = settings()
    contact = html.escape(f"{s['officer']} {s['contact']}")
    return site_page("이용안내", f"""
<section class="faq">
  <details open><summary>로그인이 안 돼요 ("관리자에게 액세스 요청"이 떠요)</summary>
    <p>학생은 <b>학교에서 받은 구글 계정</b>으로 로그인해야 해요. 학교 계정인데도 막히면 학교(교육청) 구글 관리자가 이 사이트를 아직 허용하지 않은 거예요. 선생님께 알려 주세요.</p></details>
  <details><summary>선생님인데 학교 계정으로 로그인했더니 학생 화면이 나와요</summary>
    <p>처음 화면에서 <b>'선생님으로 시작하기'</b>를 고르고 로그인하세요. 이미 학생으로 들어왔다면 마이페이지의 '내 정보'에서 '선생님이신가요?'를 눌러 강사·관리교사 등록을 신청할 수 있어요.</p></details>
  <details><summary>카메라·마이크가 안 켜져요</summary>
    <p>처음 들어갈 때 브라우저가 묻는 카메라·마이크 사용을 <b>허용</b>해야 해요. 주소창 왼쪽 자물쇠 아이콘 → 권한에서 다시 허용할 수 있어요. 수업 중 마이크는 선생님이 켜 줘요.</p></details>
  <details><summary>소리가 울리거나 끊겨요</summary>
    <p>이어폰을 쓰면 울림이 사라져요. 영상이 끊기면 와이파이 가까이로 가거나, 다른 앱을 닫아 보세요. 연결이 끊겨도 자동으로 다시 연결돼요.</p></details>
  <details><summary>수업 중 '🔴 녹화 중'이 보여요</summary>
    <p>선생님이 복습 자료 등 수업 목적으로 녹화하고 있다는 뜻이에요. 녹화본은 선생님 컴퓨터에만 저장돼요. 카메라를 꺼 두면 얼굴은 녹화되지 않아요.</p></details>
  <details><summary>선생님(강사)으로 강의하고 싶어요</summary>
    <p>마이페이지에서 '선생님으로 시작하기'로 로그인한 뒤, 강의할 거점학교와 희망 기간을 적어 강사 등록을 신청하세요. 거점학교 관리교사가 승인하면 강좌를 열 수 있어요.</p></details>
  <details><summary>탈퇴하고 싶어요</summary>
    <p>마이페이지 → <b>내 정보</b> 맨 아래 <b>'회원 탈퇴'</b>에서 신청해요. 학생은 수강한 강좌의 <b>거점학교 관리교사 선생님이 승인</b>하면 탈퇴되고, 그때 출결·과제 등 내 기록이 모두 지워져요. 승인 전에는 신청을 취소할 수 있어요.</p></details>
  <details><summary>내 개인정보는 어떻게 쓰이나요</summary>
    <p><a href="/live/privacy">개인정보 처리방침</a>을 확인해 주세요. 수업 영상은 서버에 녹화·저장하지 않아요.</p></details>
</section>
<section class="info-block"><h2>문의</h2><p>{contact}</p></section>
""", "자주 묻는 질문과 도움말")
