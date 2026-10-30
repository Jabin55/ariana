"""외솔온닷 안내 화면: 소개 · 정보마당 · 수강신청 · 강의실 · 교무실."""

from __future__ import annotations

import html
import json
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, insert, select, update

from app import db
from app.auth import KST, current_user, require_user, today_kst
from app.courses import course_grades, sessions_of, subject_info
from app.policy import settings

router = APIRouter()


def site_page(title: str, body: str, lead: str = "", hero: bool = True, main_class: str = "site-main",
              scripts: str = "") -> HTMLResponse:
    head = f'<section class="page-hero"><h1>{html.escape(title)}</h1>{f"<p>{lead}</p>" if lead else ""}</section>' if hero else ""
    return HTMLResponse(f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} · 외솔온닷</title>
<link rel="icon" href="/static/live/favicon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1b6b4a"><link rel="apple-touch-icon" href="/static/live/icons/apple-touch-icon.png"><script src="/static/live/pwa.js" defer></script>
<link rel="stylesheet" href="/static/live/live.css">
<script src="/static/live/thumbs.js"></script>
<script src="/static/live/course-search.js"></script></head>
<body class="site">
<main class="{main_class}">
{head}
{body}
</main>{scripts}
<footer class="site-footer">
  <a href="/live/terms">이용약관</a> · <a href="/live/privacy"><strong>개인정보 처리방침</strong></a> · <a href="/live/notice">보호자 안내문</a>
</footer>
<script src="/static/live/site.js"></script>
</body></html>""")


@router.get("/live/about", response_class=HTMLResponse)
async def about():
    return site_page("외솔온닷 소개", f"""
<section class="g-hero about-hero">
  <div class="g-hero-in">
    <div><p class="bb-kicker">외솔온닷</p>
      <h2>어디서든 연결되는<br><b>실시간 온라인 수업</b></h2>
      <p>선생님과 학생이 함께 배우고 활동하는 온라인 교실이에요.</p></div>
    <div class="about-badge" aria-hidden="true"><b>온닷</b><span>실시간 교실</span></div>
  </div>
</section>
<div class="home-wrap">
<h2 class="home-h g-title">외솔온닷 <span>소개</span></h2>
<section class="info-block">
  <h2>어디서든 함께 배우는 실시간 온라인 수업</h2>
  <p>외솔온닷은 선생님이 온라인 수업을 열고 학생이 실시간으로 참여하며, 수업 자료와 활동 기록을 한곳에서 관리하는 <b>온라인 수업 플랫폼</b>이에요.
  학교 수업과 특강 등 여러 수업에 활용할 수 있고, 서로 다른 학교의 학생이 함께 배우는 <a href="/live/joint">공동교육과정</a> 운영에도 잘 맞아요.</p>
</section>
<h2 class="home-h">외솔온닷의 <span>온라인 수업</span></h2>
<section class="oc-grid">
  <div class="oc-card"><span class="oc-tag">방식</span><h3>어디서든 함께하는 실시간 수업</h3>
    <p>선생님과 학생이 학교나 집 등 각자의 자리에서 <b>실시간·쌍방향</b>으로 만나고 수업에 참여해요.</p></div>
  <div class="oc-card"><span class="oc-tag">의의</span><h3>보기만 하는 동영상 수업이 아니에요</h3>
    <p>선생님과 얼굴을 보며 <b>묻고 답하고, 토론하고, 함께 활동하는</b> 참여형 수업이에요. 거꾸로 수업·블렌디드 러닝·모둠 토론처럼 다양한 방식으로 배워요.</p></div>
  <div class="oc-card"><span class="oc-tag">강점</span><h3>학교를 잇는 수업에도 잘 맞아요</h3>
    <p>강좌 신청과 승인, 실시간 수업, 출결과 활동 기록을 이어서 관리해 <b>여러 학교가 함께 운영하는 공동교육과정</b>에도 활용하기 좋아요.</p></div>
</section>
<h2 class="home-h">외솔온닷 <span>시스템 특징</span></h2>
<section class="sys-feat">
  <div class="sys-col teacher">
    <div class="sys-who"><svg viewBox="0 0 120 110" aria-hidden="true"><rect x="44" y="8" width="70" height="52" rx="4" fill="none" stroke="currentColor" stroke-width="6"/>
      <path d="M56 24h40M56 36h30M56 48h20" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><circle cx="26" cy="36" r="13" fill="currentColor"/>
      <path d="M4 104c0-30 10-46 22-46s16 6 20 10l26-20" stroke="currentColor" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8 104h36V80" fill="currentColor"/><path d="M60 104h50" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg><b>선생님</b></div>
    <ol>
      <li>강좌를 열고 과목·학점·평가 방법과 <b>수업계획서</b>(주차·차시별 계획)를 올려요.</li>
      <li>학교·스튜디오는 물론 <b>어디서든 PC로</b> 실시간 화상 수업을 해요.</li>
      <li>수업 중 <b>PDF·PPT 자료, 판서, 화이트보드, 퀴즈·투표</b>를 함께 나눠요.</li>
      <li>탐구·프로젝트 학습을 위한 <b>모둠별 실시간 화상 토론방</b>을 열어요.</li>
      <li>학생의 <b>출결·질문·퀴즈·과제 기록</b>을 모아 보고 평가에 활용해요.</li>
    </ol>
  </div>
  <div class="sys-col student">
    <div class="sys-who"><svg viewBox="0 0 120 110" aria-hidden="true"><circle cx="60" cy="26" r="20" fill="currentColor"/>
      <path d="M22 106V70c0-12 10-22 22-22h32c12 0 22 10 22 22v36z" fill="currentColor"/><path d="M60 52v40" stroke="#fff" stroke-width="5"/>
      <path d="M50 52l10 14 10-14" fill="#fff"/></svg><b>학생</b></div>
    <ol>
      <li>우리 학교에 없는 <b>듣고 싶은 과목의 개설을 요청</b>해요.</li>
      <li>개설된 <b>모든 강좌</b>와 내가 신청할 수 있는 강좌를 검색해요.</li>
      <li>학교는 물론 <b>집 등 어디서든</b> 실시간 화상 수업에 참여해요.</li>
      <li>출결·퀴즈 결과·과제 점수 등 <b>나의 수강 이력</b>을 확인해요.</li>
      <li>놓친 수업도 <b>지난 수업 자료와 판서</b>로 다시 볼 수 있어요.</li>
    </ol>
  </div>
</section>
<section class="feature-grid">
  <div class="feature"><span class="f-ico">🎥</span><h3>실시간 화상 수업</h3><p>선생님 화면·발표 자료를 크게 보고, 데이터 절약 모드로 휴대폰에서도 부담 없이.</p></div>
  <div class="feature"><span class="f-ico">✍️</span><h3>자료 발표와 판서</h3><p>PDF·PowerPoint를 띄우고 그 위에 바로 판서. 화이트보드도 함께.</p></div>
  <div class="feature"><span class="f-ico">✅</span><h3>퀴즈·투표</h3><p>OX·객관식·주관식으로 바로 확인하고, 결과는 그래프로.</p></div>
  <div class="feature"><span class="f-ico">👥</span><h3>모둠 활동</h3><p>모둠별 회의실에서 토론하고, 선생님은 모든 모둠을 한눈에 살펴요.</p></div>
  <div class="feature"><span class="f-ico">📝</span><h3>과제와 피드백</h3><p>파일로 과제를 내고, 점수와 선생님 피드백을 받아요.</p></div>
</section>
<section class="cta-row">
  <a class="button primary big" href="/live/courses">개설 강좌 보기</a>
  <a class="button big" href="/live/guide">수강 방법 보기</a>
</section>
</div>
""", hero=False, main_class="site-main home")


@router.get("/live/joint", response_class=HTMLResponse)
async def joint_page():
    return site_page("공동교육과정", """
<section class="g-hero joint-hero">
  <div class="g-hero-in">
    <div><p class="bb-kicker">공동교육과정</p>
      <h2>학교가 함께 열고<br><b>학생이 함께 배우는 수업</b></h2>
      <p>한 학교에서 열기 어려운 과목도 학교 간 협력으로 배울 수 있어요.</p></div>
    <div class="joint-badge" aria-hidden="true"><b>함께</b><span>배우는 교실</span></div>
  </div>
</section>
<div class="home-wrap">
<h2 class="home-h g-title">공동교육과정<span>이란?</span></h2>
<section class="joint-overview" aria-label="공동교육과정의 정의와 추진 목적">
  <div class="joint-card"><h3>정의</h3>
    <p>희망 학생이 적거나 교사 수급이 어려운 등의 이유로 한 학교에서 개설하기 어려운 <b>소인수·심화 과목</b>을 학교 간 연계·협력으로 운영하는 정규교육과정이에요.</p></div>
  <div class="joint-card"><h3>추진 목적</h3>
    <ul><li>학생의 소질·적성과 진로에 따른 수요를 반영해 다양한 과목을 개설하고, 과목 선택권과 진로에 맞는 학업 설계를 지원해요.</li>
      <li>학교 간, 학교와 지역·대학, 학교와 교육청의 연계·협력으로 학교 교육력을 높이고 교육 공동체를 만들어요.</li></ul></div>
</section>
<section class="info-block joint-terms"><h2>용어 안내</h2>
  <dl>
    <div><dt>강좌</dt><dd>공동교육과정 과목을 운영하기 위해 개설하는 개별 수업 단위예요.</dd></div>
    <div><dt>거점학교</dt><dd>공동교육과정 과목을 개설하고 강좌 운영, 나이스(NEIS) 편제 등록과 성적 처리를 담당하는 학교예요.</dd></div>
    <div><dt>참여학교</dt><dd>공동교육과정에 참여하는 학생이 다니는 학교예요.</dd></div>
    <div><dt>관리교사</dt><dd>소속 학교의 거점학교 운영과 참여학교 담당 업무를 함께 맡는 교사예요.</dd></div>
    <div><dt>수업교사(강사)</dt><dd>공동교육과정 강좌를 개설하고 수업하는 교사 또는 강사예요. 외솔온닷에서는 강의교사라고 불러요.</dd></div>
    <div><dt>협력교사</dt><dd>강사를 채용해 운영할 때 수업·평가·기록과 나이스(NEIS) 등 행정 업무를 지원하는 교사예요.</dd></div>
  </dl>
</section>
<section class="info-block joint-rules-block">
  <h2>2022 개정 교육과정에 따른 공동교육과정 주요 내용</h2>
  <table class="joint-rules"><tbody>
    <tr><th scope="row">이수 기준</th><td>
      <p>공동교육과정으로 개설되는 모든 과목에 학점 이수 인정 기준이 적용돼요.</p>
      <ul><li><b>공통 과목:</b> 과목 출석률 2/3 이상과 학업성취율 40% 이상</li>
        <li><b>선택 과목·교양 교과 과목:</b> 과목 출석률 2/3 이상</li></ul>
      <p>기준에 도달하지 못하면 최소 성취수준 보장지도 또는 추가학습으로 학점을 취득할 기회가 제공돼요.</p>
    </td></tr>
    <tr><th scope="row">학기당 수강 강좌 수</th><td>
      <p>정규 일과시간 안팎을 구분하지 않고, <b>공동교육과정과 온라인학교 개설 과목을 합쳐 학기당 최대 2강좌</b>까지 이수할 수 있어요.</p>
      <p>부득이하게 초과해야 한다면 시교육청과 사전 협의 및 승인이 필요해요.</p>
    </td></tr>
    <tr><th scope="row">학교생활기록부 반영</th><td>
      <p>이수 기준에 도달하지 못하고 최소 성취수준 보장지도 또는 추가학습도 이수하지 않으면, 교과학습발달상황의 비고란에 <b>미이수</b>로 기재돼요.</p>
      <p>공통 과목은 출석률 2/3 이상·학업성취율 40% 이상, 선택 과목과 교양 교과 과목은 출석률 2/3 이상을 기준으로 해요.</p>
    </td></tr>
    <tr><th scope="row">1학점 수업량</th><td><p>일반계고와 직업계고 모두 <b>1학점당 16회 수업</b>을 기준으로 해요.</p></td></tr>
    <tr><th scope="row">학점 초과 이수 제한</th><td>
      <p>교과 이수 학점이 174학점인 경우 국어·수학·영어 교과의 이수 학점 합계는 <b>81학점 이내</b>예요.</p>
      <p>174학점을 넘겨 이수하면 국어·수학·영어 교과에 추가되는 학점은 <b>전체 초과 이수 학점의 50% 이내</b>로 제한돼요. 과목별 산정은 소속 학교에 확인하세요.</p>
    </td></tr>
  </tbody></table>
</section>
<section class="info-block">
  <h2>외솔온닷에서 운영할 때</h2>
  <p>여러 학교 학생이 같은 강좌를 신청하고, 담당 교사가 승인 상황을 확인할 수 있어요. 수업이 시작되면 실시간 화상·자료 발표·활동을 함께 진행하고, 수업 뒤에는 출결과 수업 자료를 살펴볼 수 있어요.</p>
  <p>외솔온닷은 이런 수업 흐름을 지원하는 온라인 플랫폼이에요. 과목의 개설·이수·성적 처리에 관한 세부 절차는 각 학교와 교육청의 운영 기준을 확인해 주세요.</p>
</section>
<section class="cta-row"><a class="button primary big" href="/live/courses">개설 강좌 보기</a>
  <a class="button big" href="/live/guide">수강 방법 보기</a></section>
</div>
""", hero=False, main_class="site-main home")


@router.get("/live/sitemap", response_class=HTMLResponse)
async def sitemap_page():
    return site_page("사이트맵", """
<div class="sitemap-grid">
  <section class="info-block"><h2>외솔온닷 소개</h2><ul>
    <li><a href="/live/about">기본방향</a></li><li><a href="/live/joint">공동교육과정</a></li><li><a href="/live/credit">고교학점제</a></li>
    <li><a href="/live/sitemap">사이트맵</a></li></ul></section>
  <section class="info-block"><h2>정보마당</h2><ul>
    <li><a href="/live/notices">공지사항</a></li><li><a href="/live/guide">수강안내</a></li>
    <li><a href="/live/help">이용안내</a></li><li><a href="/live/community">소통마당</a></li></ul></section>
  <section class="info-block"><h2>수강신청</h2><ul>
    <li><a href="/live/courses">수강신청</a></li><li><a href="/live/course-requests">희망과목 개설 신청</a></li></ul></section>
  <section class="info-block"><h2>수업 공간</h2><ul>
    <li><a href="/live?classroom=1">강의실</a></li><li><a href="/live?office=1">교무실</a></li></ul></section>
</div>
""", hero=False)


def mock(url: str, body: str) -> str:
    """화면 모형: 브라우저 창 모양 틀 (클릭되지 않는 그림)"""
    return f"""<div class="mock" aria-hidden="true"><div class="mock-bar"><i></i><i></i><i></i><span>{url}</span></div>
<div class="mock-body">{body}</div></div>"""


def pin(n: int, top: str, left: str) -> str:
    return f'<span class="pin" style="top:{top};left:{left}">{n}</span>'


def step(n: int, title: str, points: list[str], picture: str) -> str:
    items = "".join(f'<li><span class="num">{i}</span><p>{p}</p></li>' for i, p in enumerate(points, 1))
    return f"""<section class="g-step">
  <h3 class="g-step-h"><span>STEP {n:02d}.</span> {title}</h3>
  <div class="g-step-in"><ol class="g-points">{items}</ol><div class="g-pic">{picture}</div></div>
</section>"""


SAMPLE = [  # 수강안내 그림에 쓰는 예시 강좌
    {"subject_area": "사회", "grades": [2, 3], "recruit": "open", "title": "법과 사회", "teacher": "박○○ 선생님", "hub": "○○고등학교"},
    {"subject_area": "정보", "grades": [1, 2], "recruit": "open", "title": "인공지능 기초", "teacher": "김○○ 선생님", "hub": "△△고등학교"},
    {"subject_area": "미술", "grades": [], "recruit": "before", "title": "미술 창작", "teacher": "이○○ 선생님", "hub": "□□고등학교"},
]


def sample_tiles() -> str:
    return "".join(f"""<div class="m-tile"><div class="m-thumb" data-course='{json.dumps(c, ensure_ascii=False)}'></div>
<b>{c["title"]}</b><small>{c["hub"]} · {c["teacher"]}</small></div>""" for c in SAMPLE)


@router.get("/live/guide", response_class=HTMLResponse)
async def guide():
    from app.auth import ALLOWED_DOMAINS
    domain = ", ".join(f"@{d}" for d in sorted(ALLOWED_DOMAINS)) or "학교 계정"
    steps = [
        step(1, "회원가입 · 로그인", [
            "메인 화면이나 <b>[강의실]</b>에서 <b>[학생으로 시작]</b>을 눌러요.",
            f"<b>학교에서 받은 구글 계정</b>({html.escape(domain)})으로 로그인해요. 개인 계정으로는 학생 가입이 안 돼요.",
            "<b>학교</b>(목록에서 고르기)·<b>학년·반·번호</b>·<b>이름(실명)</b>을 적고, 이용약관과 개인정보 처리방침에 동의하면 가입 끝!",
        ], mock("class…/live", """
<div class="m-row"><div class="m-choice on">🎒 <b>학생으로 시작</b></div><div class="m-choice">👩‍🏫 <b>선생님으로 시작</b></div></div>
<div class="m-google">G&nbsp; 학교 구글 계정으로 로그인</div>
<div class="m-form"><span>학교 <em>신정고등학교 ▾</em></span><span>학년 <em>2</em></span><span>반 <em>3</em></span><span>번호 <em>15</em></span><span>이름 <em>김외솔</em></span></div>
<div class="m-agree">☑ 이용약관과 개인정보 처리방침에 동의해요</div>"""
            + pin(1, "6%", "4%") + pin(2, "33%", "4%") + pin(3, "55%", "4%"))),
        step(2, "수업 검색", [
            "<b>[수강신청]</b> 메뉴에서 과목·학교 이름으로 듣고 싶은 강좌를 찾아요.",
            "<b>학년</b>을 고르면 내 학년이 들을 수 있는 강좌만 보여요. 1·2학년, 2·3학년처럼 여러 학년이 함께 듣는 강좌도 있어요.",
            "강좌 카드에서 <b>모집 기간·학점·평가 방법·수업계획서</b>를 확인해요. <b>수강모집</b> 표시가 있는 강좌만 신청할 수 있어요.",
        ], mock("class…/live/courses", f"""
<div class="m-row"><div class="m-search">과목, 선생님, 학교 검색</div><div class="m-select">2학년 ▾</div></div>
<div class="m-tiles">{sample_tiles()}</div>"""
            + pin(1, "4%", "2%") + pin(2, "-1%", "93%") + pin(3, "40%", "2%"))),
        step(3, "수강 신청", [
            "학생으로 로그인한 뒤 <b>[수강신청]</b>에서 원하는 강좌의 <b>[수강신청]</b>을 눌러요.",
            "<b>강사 선생님이 승인</b>하면 <b>수강 확정</b>! 확정된 강좌는 [강의실]의 '내 강좌'에서 보여요.",
            "승인 전에는 언제든 신청을 취소할 수 있어요. 정원이 차거나 모집 기간이 끝나면 신청할 수 없어요.",
        ], mock("class…/live/courses", """
<div class="m-line"><div><b>인공지능 기초</b><small>강사 김○○ · △△고등학교 · 1·2학년 · 4학점</small></div><span class="m-btn">수강신청</span></div>
<div class="m-flow"><span class="done">신청</span><i>›</i><span class="now">강사 승인</span><i>›</i><span>수강 확정</span></div>
<div class="m-line"><div><b>법과 사회</b><small>강사 승인 대기</small></div><span class="m-btn ghost">신청 취소</span></div>"""
            + pin(1, "10%", "2%") + pin(2, "42%", "2%") + pin(3, "72%", "2%"))),
        step(4, "실시간 수업 듣기", [
            "수업 시간이 되면 <b>[강의실] → [지금 들어갈 수 있는 수업]</b>에 강좌가 떠요. <b>[들어가기]</b>만 누르면 돼요. 수업 코드는 필요 없어요.",
            "처음 들어갈 때 브라우저가 묻는 <b>카메라·마이크 사용을 [허용]</b>해 주세요. 울림이 없도록 <b>이어폰</b>을 꼭 써요.",
            "말하고 싶으면 <b>[🎤 마이크]</b>를 켜고 말해요(말이 끝나면 꺼 주세요). 할 말이 있으면 <b>[✋ 손 들기]</b>, 궁금한 건 <b>[질문]</b>으로 선생님께 보내요.",
            "선생님이 띄운 <b>발표 자료·판서</b>를 보고, <b>퀴즈·투표</b>와 <b>모둠 활동</b>에도 화면에서 바로 참여해요.",
        ], mock("class…/live/class/…", """
<div class="m-live"><div class="m-now">▶ 지금 들어갈 수 있는 수업 · 법과 사회 <span class="m-btn">들어가기</span></div>
<div class="m-stage"><div class="m-slide"><b>3차시 · 헌법과 기본권</b><span></span><span></span><span class="short"></span><em>✏️</em></div>
<div class="m-cams"><div class="m-cam t">👩‍🏫<small>선생님</small></div><div class="m-cam">🙂<small>나</small></div><div class="m-cam">😀</div></div></div>
<div class="m-quiz">✅ 퀴즈: 기본권을 제한할 수 있는 근거는? <span>① 법률</span><span>② 명령</span></div>
<div class="m-bar"><span>🎤 마이크</span><span>✋ 손 들기</span><span>❓ 질문</span><span>💬 채팅</span></div></div>"""
            + pin(1, "3%", "2%") + pin(2, "22%", "64%") + pin(3, "86%", "2%") + pin(4, "64%", "2%"))),
        step(5, "과제 · 복습", [
            "<b>[강의실] → 내 강좌 → 수행평가</b>에서 파일이나 글로 과제를 내요. 마감 전에는 다시 낼 수 있어요.",
            "<b>[지난 수업 자료]</b>에서 선생님이 띄운 자료와 판서를 다시 봐요. 결석한 날 수업도 따라잡을 수 있어요.",
            "퀴즈 결과와 과제 점수·<b>선생님 피드백</b>도 강의실에서 확인해요.",
        ], mock("class…/live (강의실)", """
<div class="m-line"><div><b>📝 선거 제도 보고서</b><small>마감 11.20 23:59 · 보고서.pdf 제출함</small></div><span class="m-btn ghost">다시 내기</span></div>
<div class="m-line"><div><b>📚 지난 수업 자료</b><small>3차시 헌법과 기본권 · 자료 2개 · 판서 4쪽</small></div><span class="m-btn ghost">보기</span></div>
<div class="m-line"><div><b>💬 선생님 피드백</b><small>근거가 아주 좋아요! · 9점</small></div></div>"""
            + pin(1, "10%", "2%") + pin(2, "42%", "2%") + pin(3, "72%", "2%"))),
    ]
    return site_page("수강안내", f"""
<div class="home-wrap">
  <h2 class="home-h g-title">수강방법 <span>안내</span></h2>
  <nav class="g-toc">
    <a href="#s1"><b>01</b>회원가입</a><a href="#s2"><b>02</b>수업 검색</a><a href="#s3"><b>03</b>수강 신청</a>
    <a href="#s4"><b>04</b>수업 듣기</a><a href="#s5"><b>05</b>과제·복습</a></nav>
  {"".join(f'<div id="s{i}" class="g-anchor"></div>{x}' for i, x in enumerate(steps, 1))}
  <h2 class="home-h g-title">알아 두면 <span>좋아요</span></h2>
  <section class="info-grid">
    <div class="info-card"><h3>🎧 준비물</h3><p>컴퓨터나 휴대폰(크롬 권장), <b>이어폰</b>. 와이파이가 있는 곳에서 들으면 끊기지 않아요.</p></div>
    <div class="info-card"><h3>🕒 출결</h3><p>들어오고 나간 시각이 자동으로 기록돼요. 인터넷이 끊겨도 다시 들어오면 이어서 기록돼요.</p></div>
    <div class="info-card"><h3>📵 지켜 주세요</h3><p>수업 화면을 녹화·캡처해 올리지 마세요. 친구들의 얼굴과 목소리는 소중한 개인정보예요.</p></div>
    <div class="info-card"><h3>🙋 도움이 필요하면</h3><p>로그인이 안 되거나 소리가 안 들리면 <a href="/live/help">자주 묻는 질문</a>을 먼저 확인해 보세요.</p></div>
  </section>
  <section class="cta-row g-cta">
    <a class="button primary big" href="/live/courses">수업 신청하러 가기 →</a>
    <a class="button big" href="/live/help">자주 묻는 질문</a>
  </section>
</div>
<script>
document.querySelectorAll(".m-thumb").forEach((el) => {{ el.outerHTML = window.courseThumb(JSON.parse(el.dataset.course)); }});
</script>
""", hero=False, main_class="site-main home")


@router.get("/live/credit", response_class=HTMLResponse)
async def credit_page():
    """고교학점제 안내 (일반적인 제도 설명 — 세부 기준은 교육부·교육청 지침과 학교 교육과정을 따른다)"""
    return site_page("고교학점제", """
<section class="g-hero credit-hero">
  <div class="g-hero-in">
    <div><p class="bb-kicker">고교학점제</p>
      <h2>내 진로에 맞는 과목을<br><b>골라서 듣고, 학점으로 졸업해요</b></h2>
      <p>2025학년도 고등학교 1학년부터 모든 고등학교에서 시행하고 있어요.</p></div>
    <div class="credit-badge" aria-hidden="true"><b>192</b><span>학점</span><small>3년 동안 이수하면 졸업</small></div>
  </div>
</section>
<div class="home-wrap">
  <h2 class="home-h">고교학점제<span>란?</span></h2>
  <p class="credit-lead">학생이 기초 소양과 기본 학력을 바탕으로 <b>진로·적성에 따라 과목을 선택</b>하고,
    <b>이수 기준에 도달한 과목의 학점</b>을 취득·누적하여 졸업하는 제도예요.</p>
  <section class="credit-flow">
    <div><span class="cf-ico">🧭</span><b>진로 설계</b><p>관심 분야와 진로를 탐색하고 선생님과 상담해요.</p></div>
    <i>›</i>
    <div><span class="cf-ico">🗂️</span><b>과목 선택</b><p>우리 학교 과목에 더해 공동교육과정 과목까지 골라요.</p></div>
    <i>›</i>
    <div><span class="cf-ico">✅</span><b>이수·학점 취득</b><p>출석과 학업성취 기준을 채우면 그 과목의 학점을 받아요.</p></div>
    <i>›</i>
    <div><span class="cf-ico">🎓</span><b>졸업</b><p>3년 동안 192학점 이상을 채우면 졸업해요.</p></div>
  </section>

  <h2 class="home-h">숫자로 보는 <span>고교학점제</span></h2>
  <section class="credit-nums">
    <div><b>192<small>학점</small></b><p>졸업 기준<br><span>교과 174학점 + 창의적 체험활동 18학점</span></p></div>
    <div><b>16<small>회</small></b><p>1학점 = 50분 수업 16회<br><span>3학점 과목이면 48시간</span></p></div>
    <div><b>2/3<small>이상</small></b><p>과목 출석률<br><span>수업 횟수의 3분의 2 이상 출석</span></p></div>
    <div><b>40<small>% 이상</small></b><p>학업성취율<br><span>못 미치면 보충 지도로 다시 도전</span></p></div>
  </section>

  <h2 class="home-h">과목은 <span>이렇게 나뉘어요</span></h2>
  <section class="credit-types">
    <div class="ct common"><b>공통 과목</b><p>모든 학생이 배우는 기초 과목<br><small>공통국어·공통수학·공통영어·한국사·통합사회·통합과학 등</small></p></div>
    <div class="ct general"><b>일반 선택</b><p>교과별 학문의 기본 이해를 위한 과목<br><small>예: 문학, 대수, 영어Ⅰ, 물리학, 사회와 문화</small></p></div>
    <div class="ct career"><b>진로 선택</b><p>교과별 심화 학습과 진로 탐색을 위한 과목<br><small>예: 미적분Ⅱ, 법과 사회, 인공지능 기초</small></p></div>
    <div class="ct fusion"><b>융합 선택</b><p>교과 내·교과 간 주제 융합, 실생활 응용 과목<br><small>예: 금융과 경제생활, 기후변화와 환경생태</small></p></div>
  </section>

  <h2 class="home-h">평가는 <span>이렇게 해요</span></h2>
  <section class="info-grid">
    <div class="info-card"><h3>🅰️ 성취평가</h3><p>정해진 성취기준에 얼마나 도달했는지에 따라 <b>A~E</b>(과목에 따라 A~C, P)로 성취도를 매겨요.</p></div>
    <div class="info-card"><h3>📊 석차 등급</h3><p>대부분 과목은 성취도와 함께 <b>5등급</b> 석차 등급을 적어요. 체육·예술·교양 등 일부 과목은 성취도만 적어요.</p></div>
    <div class="info-card"><h3>🧩 최소 성취수준 보장</h3><p>출석률이나 학업성취율이 기준에 못 미칠 것 같으면 <b>보충 지도</b>를 받아 다시 도전해요.</p></div>
  </section>

  <h2 class="home-h">과목 선택을 넓히는 <span>온라인 수업</span></h2>
  <section class="credit-joint">
    <p>학교에서 개설하기 어려운 과목을 여러 학교가 함께 운영하는 공동교육과정도 과목 선택의 한 방법이에요.
      외솔온닷은 <b>실시간 수업과 수강·출결·활동 기록</b>을 지원해 이런 수업을 온라인으로 운영할 때 활용할 수 있어요.</p>
    <div class="cta-row"><a class="button primary big" href="/live/joint">공동교육과정 알아보기 →</a>
      <a class="button big" href="/live/courses">개설 강좌 보기</a>
      <a class="button big" href="/live/guide">수강 방법 보기</a>
      <a class="button big" href="https://www.hscredit.kr" target="_blank" rel="noopener">고교학점제 지원센터 ↗</a></div>
  </section>
  <p class="muted credit-note">※ 이 안내는 제도의 일반적인 내용이에요. 이수 기준·평가 방법 등 세부 사항은 교육부·교육청 지침과 학교 교육과정에 따라 다를 수 있으니 학교에서 꼭 확인하세요.</p>
</div>
""", hero=False, main_class="site-main home")


@router.get("/api/courses/catalog")
async def catalog():
    """로그인 없이 보는 개설 강좌 목록 (학생 개인정보 없음)"""
    def run():
        with db.engine.connect() as c:
            co = db.courses.c
            return c.execute(select(db.courses).where(co.archived == 0, co.open == 1, co.approval == "approved")
                             .order_by(co.hub_school, co.title)).all()

    def sess(ids):
        with db.engine.connect() as c:
            return sessions_of(c, ids)

    today = today_kst()
    rows = [r for r in await db.run(run) if not (r.end_date and r.end_date < today)]
    ss = await db.run(sess, [r.id for r in rows])
    return {"courses": [{"id": r.id, "title": r.title, "instructor": r.instructor, "hub_school": r.hub_school,
                         "start_date": r.start_date, "end_date": r.end_date, "grades": course_grades(r),
                         "description": r.description, "sessions": ss.get(r.id, []), **subject_info(r)} for r in rows]}


@router.get("/live/courses", response_class=HTMLResponse)
async def courses_page():
    return site_page("수강신청", """
<section class="info-block">
  <div id="courses-access"></div>
  <div id="course-search"></div>
</section>
<section class="catalog" id="catalog"><p class="muted">불러오는 중…</p></section>
""", "지금 신청할 수 있는 강좌", scripts='<script src="/static/live/enroll-page.js"></script>')


@router.get("/live/courses/{course_id}", response_class=HTMLResponse)
async def course_detail_page(course_id: int):
    return site_page("강좌 정보", f"""
<section class="course-detail" id="course-detail" data-id="{int(course_id)}"><p class="muted">불러오는 중…</p></section>
""", hero=False, scripts='<script src="/static/live/course-detail.js"></script>')


@router.get("/api/courses/{course_id}/info")
async def course_info(course_id: int):
    """로그인 없이 보는 강좌 상세 정보 (학생 개인정보 없음). 개설 승인된 강좌만"""
    def run():
        with db.engine.connect() as c:
            r = c.execute(select(db.courses).where(db.courses.c.id == course_id)).first()
            return r, (sessions_of(c, [course_id]).get(course_id, []) if r else [])

    r, sess = await db.run(run)
    if not r or r.archived or (r.approval or "approved") != "approved":
        raise HTTPException(404, "강좌를 찾을 수 없어요.")
    return {"course": {"id": r.id, "title": r.title, "instructor": r.instructor, "hub_school": r.hub_school,
                       "start_date": r.start_date, "end_date": r.end_date, "grades": course_grades(r),
                       "description": r.description, "sessions": sess, **subject_info(r)}}


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
    <p>처음 들어갈 때 브라우저가 묻는 카메라·마이크 사용을 <b>허용</b>해야 해요. 주소창 왼쪽 자물쇠 아이콘 → 권한에서 다시 허용할 수 있어요. 말할 때만 마이크를 켜고, 말이 끝나면 꺼 주세요.</p></details>
  <details><summary>소리가 울리거나 끊겨요</summary>
    <p>이어폰을 쓰면 울림이 사라져요. 영상이 끊기면 와이파이 가까이로 가거나, 다른 앱을 닫아 보세요. 연결이 끊겨도 자동으로 다시 연결돼요.</p></details>
  <details><summary>수업 중 '🔴 녹화 중'이 보여요</summary>
    <p>선생님이 복습 자료 등 수업 목적으로 녹화하고 있다는 뜻이에요. 녹화본은 선생님 컴퓨터에만 저장돼요. 카메라를 꺼 두면 얼굴은 녹화되지 않아요.</p></details>
  <details><summary>선생님(강사)으로 강의하고 싶어요</summary>
    <p>마이페이지에서 '선생님으로 시작하기'로 로그인한 뒤, 희망 기간을 적어 강의교사로 가입을 신청하세요. 전체 관리자가 승인하면 과목을 열 때 거점학교를 골라 개설을 신청할 수 있고, 그 거점학교 관리교사가 과목 개설을 승인하면 학생들이 수강신청해요.</p></details>
  <details><summary>탈퇴하고 싶어요</summary>
    <p>마이페이지 → <b>내 정보</b> 맨 아래 <b>'회원 탈퇴'</b>에서 신청해요. 학생은 <b>우리 학교 참여학교 담당 선생님이 승인</b>하면 탈퇴되고, 그때 출결·과제 등 내 기록이 모두 지워져요. 승인 전에는 신청을 취소할 수 있어요.</p></details>
  <details><summary>내 개인정보는 어떻게 쓰이나요</summary>
    <p><a href="/live/privacy">개인정보 처리방침</a>을 확인해 주세요.</p></details>
</section>
<section class="info-block"><h2>문의</h2><p>{contact}</p></section>
""", "자주 묻는 질문과 도움말")


@router.get("/live/course-requests", response_class=HTMLResponse)
async def course_requests_page():
    return site_page("희망과목 개설 신청", """
<section class="info-block"><h2>학생들이 신청한 과목</h2>
  <div id="wish-page-summary">불러오는 중…</div>
  <p class="error" id="wish-page-board-error" role="alert"></p>
</section>
<section class="info-block" id="wish-page-own" hidden><h2>내가 신청한 과목</h2>
  <div id="wish-page-mine"></div>
  <button class="primary" type="button" id="wish-page-open">신청서 작성</button>
  <form id="wish-page-form" hidden>
    <label>연도 <input id="wish-page-year" type="number" min="2020" max="2100" required></label>
    <label>학기 <select id="wish-page-term" required><option value="">학기 선택</option>
      <option>1학기</option><option>여름학기</option><option>2학기</option><option>겨울학기</option></select></label>
    <label>희망 과목 <input id="wish-page-subject" list="wish-page-subjects" maxlength="60" required placeholder="예: 인공지능 기초"></label>
    <datalist id="wish-page-subjects"></datalist>
    <label>신청 이유 (선택) <input id="wish-page-note" maxlength="300" placeholder="신청 이유"></label>
    <button class="primary" type="submit">신청하기</button>
    <p class="error" id="wish-page-error" role="alert"></p>
  </form>
</section>
""", hero=False, scripts='<script src="/static/live/wish-page.js"></script>')


# ───────────────────────── 메인 화면 ─────────────────────────


@router.get("/live/home", response_class=HTMLResponse)
async def home_page():
    """메인: 전광판(배너) · 외솔온닷 안내(동그란 바로가기) · 공지사항 · 모집 중인 강좌 · 로그인"""
    return site_page("외솔온닷", """
<section class="billboard" id="billboard" aria-roledescription="carousel" aria-label="알림판">
  <div class="bb-track" id="bb-track"></div>
  <button class="bb-nav prev" id="bb-prev" aria-label="이전">‹</button>
  <button class="bb-nav next" id="bb-next" aria-label="다음">›</button>
  <div class="bb-dots" id="bb-dots"></div>
</section>
<div class="home-wrap">
  <section class="guide-circles">
    <h2 class="home-h">외솔온닷 <span>안내</span></h2>
    <nav class="circles">
      <a href="/live/notices"><span class="circle c1"></span>공지사항</a>
      <a href="/live/credit"><span class="circle c6"></span>고교학점제</a>
      <a href="/live/about"><span class="circle c2"></span>사업 소개</a>
      <a href="/live/guide"><span class="circle c3"></span>수강 안내</a>
      <a href="/live/courses"><span class="circle c4"></span>수강 신청</a>
      <a href="/live/help"><span class="circle c5"></span>자주 묻는 질문</a>
    </nav>
  </section>
  <div class="home-cols">
    <section class="home-box">
      <div class="home-box-h"><h2>📢 공지사항</h2><a href="/live/notices">더보기 +</a></div>
      <ul class="notice-list" id="home-notices"><li class="muted">불러오는 중…</li></ul>
    </section>
    <section class="home-box login-box" id="home-login">
      <div class="home-box-h"><h2>🔑 시작하기</h2></div>
      <div id="home-login-body">
        <a class="start-choice" href="/live?start=student"><span class="sc-ico">🎒</span><strong>학생으로 시작</strong></a>
        <a class="start-choice" href="/live?start=staff"><span class="sc-ico">👩‍🏫</span><strong>선생님으로 시작</strong></a>
      </div>
    </section>
  </div>
  <section class="home-box">
    <div class="home-box-h"><h2>✨ 지금 모집 중인 강좌</h2><a href="/live/courses">전체 보기 +</a></div>
    <div class="home-courses" id="home-courses"><p class="muted">불러오는 중…</p></div>
  </section>
  <section class="home-box">
    <div class="home-box-h"><h2>🙋 학생들이 듣고 싶은 과목</h2><a href="/live/course-requests" id="wish-link">희망과목 개설 신청 +</a></div>
    <div class="wish-cloud" id="home-wishes"><p class="muted">불러오는 중…</p></div>
  </section>
</div>
""", hero=False, main_class="site-main home", scripts='<script src="/static/live/home-page.js"></script>')


# ───────────────────────── 공지사항 ─────────────────────────


def notice_rows(limit: int | None = None):
    with db.engine.connect() as c:
        q = select(db.notices).order_by(db.notices.c.pinned.desc(), db.notices.c.created_at.desc())
        if limit:
            q = q.limit(limit)
        return c.execute(q).all()


def notice_json(r, body: bool = False, files: list | None = None) -> dict:
    out = {"id": r.id, "title": r.title, "pinned": bool(r.pinned), "author": r.author, "author_id": r.author_id,
           "date": datetime.fromtimestamp(r.created_at, KST).strftime("%Y-%m-%d"),
           "new": r.created_at > time.time() - 7 * 86400}
    if body:
        out["body"] = r.body
    if files is not None:
        out["files"] = files
    return out


# ── 공지사항 첨부 파일: 선생님이 올리고, 누구나 내려받는다 (공지는 공개 글) ──
NOTICE_FILE_MAX = 20 * 1024 * 1024  # 한 파일 20MB
NOTICE_FILES_PER = 10  # 글 하나에 10개까지
NOTICE_FILE_EXTS = {"pdf", "hwp", "hwpx", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
                    "jpg", "jpeg", "png", "gif", "webp", "zip", "mp3", "mp4"}


def notice_file_path(fid: str) -> Path:
    from app.assignments import FILES_DIR
    return FILES_DIR / "notices" / fid


def file_json(f) -> dict:
    return {"id": f.id, "name": f.name, "size": f.size, "url": f"/api/notices/files/{f.id}"}


def files_of(c, nids: list[int]) -> dict[int, list]:
    out: dict[int, list] = {}
    for f in c.execute(select(db.notice_files).where(db.notice_files.c.notice_id.in_(nids or [-1]))
                       .order_by(db.notice_files.c.created_at)):
        out.setdefault(f.notice_id, []).append(file_json(f))
    return out


@router.get("/api/notices")
async def list_notices(limit: int = Query(default=0, ge=0, le=200)):
    def run():
        rows = notice_rows(limit or None)
        with db.engine.connect() as c:
            fs = files_of(c, [r.id for r in rows])
        return [notice_json(r, body=True, files=fs.get(r.id, [])) for r in rows]

    return {"notices": await db.run(run)}


@router.post("/api/admin/notices/files")
async def upload_notice_file(request: Request, name: str = Query(min_length=1, max_length=200)):
    """첨부 파일 올리기 (요청 본문 = 파일 그대로). 글을 저장할 때 그 글에 붙는다."""
    u = await require_teacher(request)
    name = Path(name.replace("\\", "/")).name.strip() or "file"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in NOTICE_FILE_EXTS:
        raise HTTPException(415, "올릴 수 있는 파일: PDF, 한글(HWP), 워드, 엑셀, 파워포인트, 그림, ZIP, 텍스트, MP3, MP4")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > NOTICE_FILE_MAX:
            raise HTTPException(413, "파일이 너무 커요. 20MB 이하로 올려 주세요.")
    if not data:
        raise HTTPException(400, "빈 파일이에요.")
    fid = uuid.uuid4().hex[:16]

    def run():
        p = notice_file_path(fid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        with db.engine.begin() as c:
            c.execute(insert(db.notice_files).values(id=fid, notice_id=None, name=name, size=len(data),
                                                     uploader_id=u["id"], created_at=time.time()))
            # 올려 두고 글에 붙이지 않은 지 하루 지난 파일은 지운다
            old = c.execute(select(db.notice_files.c.id).where(db.notice_files.c.notice_id.is_(None),
                                                               db.notice_files.c.created_at < time.time() - 86400)).scalars().all()
            c.execute(delete(db.notice_files).where(db.notice_files.c.id.in_(old or ["-"])))
        for o in old:
            notice_file_path(o).unlink(missing_ok=True)

    await db.run(run)
    return {"id": fid, "name": name, "size": len(data), "url": f"/api/notices/files/{fid}"}


@router.get("/api/notices/files/{fid}")
async def notice_file(fid: str):
    def run():
        with db.engine.connect() as c:
            return c.execute(select(db.notice_files).where(db.notice_files.c.id == fid)).first()

    f = await db.run(run) if fid.isalnum() else None
    if not f or f.notice_id is None or not notice_file_path(fid).is_file():
        raise HTTPException(404, "파일을 찾을 수 없어요.")
    return FileResponse(notice_file_path(fid), media_type="application/octet-stream", headers={
        "Content-Disposition": f"attachment; filename=\"file{Path(f.name).suffix[:10]}\"; filename*=UTF-8''{quote(f.name)}",
        "X-Content-Type-Options": "nosniff"})


# 공지사항 쓰기·고치기·지우기: 선생님은 누구나 쓰고, 내가 쓴 글만(전체 관리자는 모두) 고치거나 지운다
NOTICE_SCRIPT = '<script src="/static/live/notices.js"></script>'


@router.get("/live/notices", response_class=HTMLResponse)
async def notices_page():
    rows = await db.run(notice_rows)
    next_number = sum(not r.pinned for r in rows)
    items = []
    for r in rows:
        j = notice_json(r)
        number = "공지" if r.pinned else str(next_number)
        if not r.pinned:
            next_number -= 1
        items.append(
            f'<tr class="{"pinned" if r.pinned else ""}"><td>{number}</td>'
            f'<td><a href="/live/notices/{r.id}">{html.escape(r.title)}'
            f'{"<span class=new-dot>N</span>" if j["new"] else ""}</a></td>'
            f'<td>{html.escape(r.author or "—")}</td><td>{j["date"]}</td></tr>')
    body = "".join(items) or '<tr><td colspan="4" class="muted">아직 공지사항이 없어요.</td></tr>'
    return site_page("공지사항", '<div id="notice-tools"></div>'
                     f'<section class="info-block"><div class="table-wrap"><table class="att community-board notice-board" aria-label="공지사항 목록">'
                     '<thead><tr><th scope="col">번호</th><th scope="col">제목</th><th scope="col">작성자</th>'
                     f'<th scope="col">작성일</th></tr></thead><tbody>{body}</tbody></table></div></section>',
                     hero=False, scripts=NOTICE_SCRIPT)


@router.get("/live/notices/{nid}", response_class=HTMLResponse)
async def notice_page(nid: int):
    def run():
        with db.engine.connect() as c:
            return c.execute(select(db.notices).where(db.notices.c.id == nid)).first()

    r = await db.run(run)
    if not r:
        raise HTTPException(404, "공지사항을 찾을 수 없어요.")
    j = notice_json(r)

    def files():
        with db.engine.connect() as c:
            return files_of(c, [r.id]).get(r.id, [])

    fl = await db.run(files)
    size = lambda n: f"{n / 1024 / 1024:.1f}MB" if n >= 1024 * 1024 else f"{max(1, n // 1024)}KB"  # noqa: E731
    attach = ("" if not fl else '<ul class="notice-files">' + "".join(
        f'<li><a href="{f["url"]}">📎 {html.escape(f["name"])}</a> <span class="muted">({size(f["size"])})</span></li>' for f in fl) + "</ul>")
    return site_page("공지사항", f"""
<article class="info-block notice-view" id="notice-view" data-id="{r.id}" data-author="{r.author_id or ''}" data-pinned="{int(bool(r.pinned))}">
  <h2>{html.escape(r.title)}</h2>
  <p class="muted">{j["date"]}{f" · {html.escape(r.author)}" if r.author else ""}</p>
  <div class="notice-body">{html.escape(r.body)}</div>
  {attach}
</article>
<p class="row"><a class="button" href="/live/notices">← 목록으로</a><span class="grow"></span><span id="notice-tools"></span></p>""",
                     hero=False, scripts=NOTICE_SCRIPT)


class NoticeReq(BaseModel):
    id: int | None = None
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(default="", max_length=20000)
    pinned: bool = False
    files: list[str] = Field(default_factory=list, max_length=NOTICE_FILES_PER)  # 붙일 첨부 파일 (빠진 것은 지운다)


async def require_admin(request: Request) -> dict:
    u = await require_user(request, profile=False)
    if not u["is_admin"]:
        raise HTTPException(403, "전체 관리자만 할 수 있어요.")
    return u


async def require_teacher(request: Request) -> dict:
    """선생님(승인받은 강사·관리교사·전체 관리자)"""
    u = await require_user(request, profile=False)
    if u["role"] != "teacher" and not u["is_admin"]:
        raise HTTPException(403, "선생님만 할 수 있어요.")
    return u


def _own_notice(c, nid: int, u: dict):
    n = c.execute(select(db.notices).where(db.notices.c.id == nid)).first()
    if not n:
        raise HTTPException(404, "공지사항을 찾을 수 없어요.")
    if not u["is_admin"] and n.author_id != u["id"]:
        raise HTTPException(403, "내가 쓴 공지만 고치거나 지울 수 있어요.")
    return n


@router.post("/api/admin/notices")
async def save_notice(req: NoticeReq, request: Request):
    """외솔온닷 공지사항: 선생님 누구나 쓴다. 고치기는 쓴 사람과 전체 관리자만, 맨 위 고정은 전체 관리자만"""
    u = await require_teacher(request)
    values = {"title": req.title.strip(), "body": req.body.strip()}
    if u["is_admin"]:
        values["pinned"] = int(req.pinned)

    def run():
        removed = []
        with db.engine.begin() as c:
            if req.id:
                _own_notice(c, req.id, u)
                c.execute(update(db.notices).where(db.notices.c.id == req.id).values(updated_at=time.time(), **values))
                nid = req.id
            else:
                nid = c.execute(insert(db.notices).values(created_at=time.time(), author=u["name"] or "",
                                                          author_id=u["id"], **values)).inserted_primary_key[0]
            nf = db.notice_files.c
            keep = set(req.files)
            # 이 글에 있던 파일 중 빠진 것은 지운다
            for f in c.execute(select(nf.id).where(nf.notice_id == nid)).scalars().all():
                if f not in keep:
                    removed.append(f)
            c.execute(delete(db.notice_files).where(nf.id.in_(removed or ["-"])))
            # 내가 올려 둔(아직 글에 안 붙은) 파일만 이 글에 붙인다
            c.execute(update(db.notice_files).where(nf.id.in_(keep or ["-"]), nf.notice_id.is_(None), nf.uploader_id == u["id"])
                      .values(notice_id=nid))
        for f in removed:
            notice_file_path(f).unlink(missing_ok=True)
        return nid

    return {"id": await db.run(run)}


@router.post("/api/admin/notices/{nid}/delete")
async def delete_notice(nid: int, request: Request):
    u = await require_teacher(request)

    def run():
        with db.engine.begin() as c:
            _own_notice(c, nid, u)
            fids = c.execute(select(db.notice_files.c.id).where(db.notice_files.c.notice_id == nid)).scalars().all()
            c.execute(delete(db.notice_files).where(db.notice_files.c.notice_id == nid))
            c.execute(delete(db.notices).where(db.notices.c.id == nid))
        for f in fids:
            notice_file_path(f).unlink(missing_ok=True)

    await db.run(run)
    return {"ok": True}


# ───────────────────────── 소통마당: 비회원도 글쓰기 ─────────────────────────

COMMUNITY_PAGE_SIZE = 20
COMMUNITY_SCRIPT = '<script src="/static/live/community.js"></script>'


@router.get("/live/community", response_class=HTMLResponse)
async def community_page(page: int = Query(default=1, ge=1)):
    def run():
        with db.engine.connect() as c:
            count = c.execute(select(func.count()).select_from(db.community_posts)).scalar_one()
            rows = c.execute(select(db.community_posts).order_by(db.community_posts.c.created_at.desc(),
                db.community_posts.c.id.desc()).offset((page - 1) * COMMUNITY_PAGE_SIZE).limit(COMMUNITY_PAGE_SIZE)).all()
            return count, rows

    count, rows = await db.run(run)
    items = "".join(f'<tr><td>{count - (page - 1) * COMMUNITY_PAGE_SIZE - i}</td>'
        f'<td><a href="/live/community/{r.id}">{html.escape(r.title)}</a></td>'
        f'<td>{html.escape(r.author)}</td>'
        f'<td>{datetime.fromtimestamp(r.created_at, KST):%Y-%m-%d}</td></tr>' for i, r in enumerate(rows))
    pagination = '<nav class="row" aria-label="소통마당 페이지">' + (
        f'<a class="button small" href="/live/community?page={page - 1}">← 이전</a>' if page > 1 else '') + (
        f'<a class="button small" href="/live/community?page={page + 1}">다음 →</a>'
        if page * COMMUNITY_PAGE_SIZE < count else '') + '</nav>'
    return site_page("소통마당", f"""
<div class="row notice-actions"><span class="grow"></span><button class="primary" type="button" id="community-write">글쓰기</button></div>
<div id="community-editor"></div>
<section class="info-block"><div class="table-wrap"><table class="att community-board">
  <thead><tr><th>번호</th><th>제목</th><th>작성자</th><th>날짜</th></tr></thead>
  <tbody>{items or '<tr><td colspan="4" class="muted">아직 글이 없어요.</td></tr>'}</tbody>
</table></div></section>{pagination}
""", "누구나 의견을 나누는 공간", scripts=COMMUNITY_SCRIPT)


@router.get("/live/community/{pid}", response_class=HTMLResponse)
async def community_detail(pid: int):
    def run():
        with db.engine.connect() as c:
            return c.execute(select(db.community_posts).where(db.community_posts.c.id == pid)).first()

    r = await db.run(run)
    if not r:
        raise HTTPException(404, "글을 찾을 수 없어요.")
    date = datetime.fromtimestamp(r.created_at, KST).strftime("%Y-%m-%d %H:%M")
    return site_page("소통마당", f"""
<article class="info-block notice-view"><h2>{html.escape(r.title)}</h2>
  <p class="muted">{html.escape(r.author)} · {date}</p>
  <div class="notice-body">{html.escape(r.body)}</div></article>
<p class="row"><a class="button" href="/live/community">← 목록으로</a>
  <span class="grow"></span><button class="danger" type="button" id="community-delete" data-id="{pid}" hidden>관리자 삭제</button></p>
""", "누구나 의견을 나누는 공간", scripts=COMMUNITY_SCRIPT)


class CommunityPostReq(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=10000)
    nickname: str = Field(default="", max_length=30)


@router.post("/api/community")
async def add_community_post(req: CommunityPostReq, request: Request):
    title, body, nickname = req.title.strip(), req.body.strip(), req.nickname.strip()
    if not title or not body:
        raise HTTPException(400, "제목과 내용을 적어 주세요.")
    u = await current_user(request)
    author = f"{'회원' if u else '비회원'} · {nickname or '익명'}"

    def run():
        with db.engine.begin() as c:
            return c.execute(insert(db.community_posts).values(title=title, body=body, author=author,
                author_id=u["id"] if u else None, created_at=time.time())).inserted_primary_key[0]

    return {"id": await db.run(run)}


@router.post("/api/admin/community/{pid}/delete")
async def delete_community_post(pid: int, request: Request):
    await require_admin(request)

    def run():
        with db.engine.begin() as c:
            return c.execute(delete(db.community_posts).where(db.community_posts.c.id == pid)).rowcount

    if not await db.run(run):
        raise HTTPException(404, "글을 찾을 수 없어요.")
    return {"ok": True}


# ───────────────────────── 메인 배너(전광판) ─────────────────────────

THEMES = ("green", "orange", "blue", "purple", "yellow")
IMAGE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}


class Banner(BaseModel):
    kicker: str = Field(default="", max_length=40)  # 작은 머리글
    title: str = Field(default="", max_length=60)
    text: str = Field(default="", max_length=120)
    button: str = Field(default="", max_length=20)
    link: str = Field(default="", max_length=300)
    theme: str = Field(default="green", max_length=10)
    image: str = Field(default="", max_length=40)  # 올린 그림 (있으면 배경으로)


class BannersReq(BaseModel):
    banners: list[Banner] = Field(default_factory=list, max_length=10)


def get_banners() -> list[dict]:
    with db.engine.connect() as c:
        r = c.execute(select(db.site_settings.c.value).where(db.site_settings.c.key == "banners")).first()
    try:
        return json.loads(r.value) if r else []
    except ValueError:
        return []


@router.get("/api/banners")
async def banners():
    """메인 전광판. 비어 있으면 화면이 기본 배너를 보여 준다."""
    return {"banners": await db.run(get_banners)}


def banner_dir():
    from app.assignments import FILES_DIR
    return FILES_DIR / "banners"


@router.post("/api/admin/banners")
async def save_banners(req: BannersReq, request: Request):
    u = await require_teacher(request)
    if not u["is_admin"]:
        raise HTTPException(403, "전체 관리자만 할 수 있어요.")
    out = []
    for b in req.banners:
        d = b.model_dump()
        d = {k: v.strip() for k, v in d.items()}
        if d["theme"] not in THEMES:
            d["theme"] = "green"
        if d["link"] and not (d["link"].startswith("/") or d["link"].startswith("https://")):
            raise HTTPException(400, "링크는 /로 시작하는 사이트 안 주소나 https:// 주소로 적어 주세요.")
        if d["image"] and not (banner_dir() / d["image"]).is_file():
            d["image"] = ""
        if d["title"] or d["image"]:
            out.append(d)

    def run():
        with db.engine.begin() as c:
            c.execute(delete(db.site_settings).where(db.site_settings.c.key == "banners"))
            c.execute(insert(db.site_settings).values(key="banners", value=json.dumps(out, ensure_ascii=False)))
        used = {b["image"] for b in out}
        if banner_dir().is_dir():  # 안 쓰는 그림은 지운다
            for f in banner_dir().iterdir():
                if f.name not in used and f.stat().st_mtime < time.time() - 3600:
                    f.unlink(missing_ok=True)

    await db.run(run)
    return {"banners": out}


@router.post("/api/admin/banners/image")
async def upload_banner_image(request: Request, name: str = Query(default="banner.png", max_length=150)):
    """배너 그림 올리기 (PNG·JPG·WEBP·GIF, 5MB까지). 요청 본문 = 그림 파일 그대로"""
    u = await require_teacher(request)
    if not u["is_admin"]:
        raise HTTPException(403, "전체 관리자만 할 수 있어요.")
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in IMAGE_TYPES:
        raise HTTPException(415, "그림은 PNG, JPG, WEBP, GIF 파일로 올려 주세요.")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > 5 * 1024 * 1024:
            raise HTTPException(413, "그림이 너무 커요. 5MB 이하로 올려 주세요.")
    fid = f"{uuid.uuid4().hex[:12]}.{'jpg' if ext == 'jpeg' else ext}"

    def save():
        banner_dir().mkdir(parents=True, exist_ok=True)
        (banner_dir() / fid).write_bytes(data)

    await db.run(save)
    return {"image": fid}


@router.get("/api/banners/image/{fid}")
async def banner_image(fid: str):
    stem, _, ext = fid.partition(".")
    if not stem.isalnum() or ext not in IMAGE_TYPES:
        raise HTTPException(404)
    path = banner_dir() / fid
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type=IMAGE_TYPES[ext], headers={"Cache-Control": "public, max-age=86400"})
