"""이용약관·개인정보 처리방침·보호자 안내문(가정통신문) 화면.

학교마다 다른 내용(운영 기관, 개인정보 보호책임자, 연락처, 보유 기간, 서버 위치)은 설정 값으로 채운다.
  live-config OPERATOR_NAME="○○고등학교" PRIVACY_OFFICER="교감 홍길동" PRIVACY_CONTACT="02-000-0000"
문서 내용을 바꾸면 POLICY_VERSION 을 올린다 → 모두 다음 로그인 때 다시 확인(동의)한다.

※ 이 문서는 초안이다. 실제 운영 전에 학교(교육청) 개인정보 담당자의 검토를 받아야 한다.
"""

from __future__ import annotations

import html
import os

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

POLICY_VERSION = "2026-10-25"  # 이용약관·처리방침 시행일 (내용을 바꾸면 날짜를 바꾼다)


def setting(name: str, default: str) -> str:
    return os.environ.get(name, "").strip() or default


MISSING = "(설정 필요)"


def settings() -> dict:
    return {
        "operator": setting("OPERATOR_NAME", MISSING),
        "officer": setting("PRIVACY_OFFICER", MISSING),
        "contact": setting("PRIVACY_CONTACT", MISSING),
        "retention": setting("RETENTION", "수강한 학년도가 끝난 날부터 1년"),
        "region": setting("SERVER_REGION", "독일 또는 핀란드 (EU)"),
        # 보호자 동의서를 받는 곳 (예: 울산광역시교육청). 비우면 '운영 기관장'
        "consent_to": setting("CONSENT_TO", f"{setting('OPERATOR_NAME', MISSING)}장"),
        "ai": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "rec": os.environ.get("ALLOW_RECORDING", "1") != "0",
    }


def policy_ready() -> bool:
    s = settings()
    return MISSING not in (s["operator"], s["officer"], s["contact"])


def page(title: str, body: str, printable: bool = False) -> HTMLResponse:
    extra = ('<button class="small no-print" onclick="print()">🖨️ 인쇄</button>' if printable else "")
    return HTMLResponse(f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} · 외솔온닷</title><link rel="icon" href="/static/live/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/live/live.css"></head>
<body class="site"><main class="landing doc">
<p class="no-print doc-links"><a href="/live/terms">이용약관</a> · <a href="/live/privacy">개인정보 처리방침</a> · <a href="/live/notice">보호자 안내문</a></p>
<div class="row"><h1 class="grow">{html.escape(title)}</h1>{extra}</div>
{body}
</main><script src="/static/live/site.js"></script></body></html>""")


def e(v: str) -> str:
    return html.escape(v)


def terms_body() -> str:
    s = settings()
    op = e(s["operator"])
    ai = s["ai"]
    return f"""
<p class="muted">시행일: {POLICY_VERSION} · 운영 기관: {op}</p>

<h2>제1조 (목적)</h2>
<p>이 약관은 {op}(이하 '운영 기관')가 운영하는 실시간 온라인 수업 서비스(이하 '서비스')를 이용하는 데 필요한 사항을 정합니다.</p>

<h2>제2조 (이용 대상)</h2>
<ul>
<li><strong>학생:</strong> 학교에서 받은 구글 계정으로 로그인한 학생. 강좌는 강의교사가 수강신청을 승인한 뒤 들을 수 있습니다.</li>
<li><strong>강의교사·거점학교 관리교사·참여학교 담당자:</strong> 등록을 신청해 승인받은 사람(강의교사는 대학교수, 보충수업 강사 등 소속 무관). 승인받은 학교와 활동 기간 안에서만 이용할 수 있습니다.</li>
<li>만 14세 미만 학생은 학교가 보호자의 동의를 받은 뒤 이용할 수 있습니다.</li>
</ul>

<h2>제3조 (서비스 내용)</h2>
<p>화상·음성 수업, 수업 자료(PDF) 발표와 판서, 퀴즈·투표, 채팅과 선생님께 질문, 모둠 활동, 출결 기록, 수업 후 채점{', AI 조교' if ai else ''}을 제공합니다.</p>

<h2>제4조 (이용자가 지켜야 할 것)</h2>
<ol>
<li><strong>학생은 수업 화면·영상·음성을 녹화·녹음·캡처하거나 다른 곳에 올리지 않습니다.</strong> 다른 학생과 선생님의 얼굴·목소리·이름이 담겨 있어 초상권과 개인정보를 침해할 수 있습니다.</li>
<li>수업 링크·코드를 수업과 관계없는 사람에게 알려 주지 않습니다.</li>
<li>다른 사람의 계정으로 로그인하거나, 다른 사람인 척하지 않습니다.</li>
<li>채팅·질문·판서에 욕설, 따돌림, 혐오 표현, 다른 사람의 개인정보를 쓰지 않습니다.</li>
<li>강사·관리교사는 수업에서 알게 된 학생 개인정보를 수업 목적으로만 쓰고, 등록할 때 동의한 개인정보 보호 서약을 지킵니다.</li>
</ol>

<h2>제5조 (선생님의 수업 관리 권한)</h2>
<p>원활한 수업을 위해 선생님은 학생의 마이크·카메라를 켜고 끄기, 채팅 제한, 모둠 배정, 수업에서 내보내기를 할 수 있습니다. 모둠 활동 중 선생님이 모둠 대화를 들을 때는 학생 화면에 "선생님이 듣고 있어요"가 표시됩니다.</p>
{'<p><strong>강의 녹화:</strong> 선생님은 복습 자료 등 수업 목적으로 수업을 녹화할 수 있습니다. 녹화본은 선생님 컴퓨터에만 저장되고 서버에는 올라가지 않으며, 녹화 중에는 학생 화면에 "🔴 녹화 중"이 표시됩니다. 선생님은 녹화본을 수업 목적으로만 쓰고 다른 곳에 공유·게시하지 않으며, 보유 기간이 지나면 지웁니다.</p>' if s['rec'] else ''}

{'''<h2>제6조 (AI 조교)</h2>
<p>AI 조교의 답은 틀릴 수 있으니 중요한 내용은 선생님께 확인하세요. AI 조교에 쓴 질문은 답을 만들기 위해 미국의 Anthropic 회사로 보내지므로, <strong>이름·학번·연락처 같은 개인정보를 쓰지 마세요.</strong> 선생님은 수업 중 AI 조교를 끌 수 있습니다.</p>''' if ai else ''}

<h2>제{7 if ai else 6}조 (이용 제한)</h2>
<p>제4조를 어기면 선생님 또는 운영 기관이 수업에서 내보내거나 이용을 제한할 수 있고, 학교 규정에 따라 처리될 수 있습니다.</p>

<h2>제{8 if ai else 7}조 (서비스 중단)</h2>
<p>서버 점검·보안 업데이트(새벽 4시 무렵 자동 재시작), 장애, 천재지변 등으로 서비스가 잠시 중단될 수 있습니다. 운영 기관은 중단 시간을 줄이도록 노력합니다.</p>

<h2>제{9 if ai else 8}조 (자료의 권리)</h2>
<p>수업 자료의 권리는 자료를 만든 선생님(또는 원저작자)에게 있습니다. 지난 수업 자료는 그 수업을 들은 학생과 강좌 수강생이 복습 목적으로만 볼 수 있으며, 다른 곳에 복제·배포하지 않습니다. 선생님은 저작권이 있는 자료를 올릴 때 수업 목적 이용 범위를 지켜 주세요.</p>

<h2>제{10 if ai else 9}조 (약관 변경)</h2>
<p>약관을 바꾸면 시행일 전에 서비스 화면에 알리고, 다음 로그인 때 다시 확인을 받습니다.</p>

<p class="muted">문의: {e(s['contact'])}</p>
"""


def consent_privacy_body() -> str:
    """회원가입 때 받는 '개인정보 수집·이용 동의' (개인정보 보호법 제15조: 목적·항목·보유 기간·거부 권리)"""
    s = settings()
    return f"""
<table class="att consent-table"><tbody>
<tr><th>수집·이용 목적</th><td>회원 확인과 로그인, 수강신청·승인, 실시간 수업 진행(화상·음성·발표·퀴즈·질문), 출결 확인, 수업 후 채점과 피드백, 강의교사·관리교사 등록과 승인, 부정 이용 방지</td></tr>
<tr><th>수집 항목</th><td><b>모든 회원:</b> 구글 계정 이메일·이름·고유 번호, 접속 시각<br>
<b>학생:</b> 실명, 학교, 학년·반·번호, 수강신청 기록, 수업 입장·퇴장 시각, 질문·답변, 퀴즈·활동 답과 점수·피드백, 활동 제출물<br>
<b>선생님:</b> 이름(실명), 소속, 생년월일, 연락처·이메일, 신청한 거점학교·학교, 활동 기간</td></tr>
<tr><th>보유·이용 기간</th><td><b>{e(s['retention'])}</b>까지 보관한 뒤 파기해요. 회원 탈퇴가 승인되면 지체 없이 파기하고, 탈퇴 확인 기록(이름·학교·학번·탈퇴일)만 같은 기간 동안 남겨요.</td></tr>
<tr><th>동의를 거부할 권리</th><td>동의를 거부할 수 있어요. 다만 위 정보는 수업에 꼭 필요한 최소한의 정보라서, 거부하면 회원가입과 수업 이용을 할 수 없어요.</td></tr>
</tbody></table>
<p class="muted" style="font-size:0.85rem">수업 중 영상·음성·채팅은 서버에 녹화·저장하지 않아요. 서버는 EU(독일·핀란드)에 있으며, EU는 개인정보보호위원회가 국내와 같은 수준이라고 인정한 지역이에요. 자세한 내용은 <a href="/live/privacy" target="_blank">개인정보 처리방침</a>을 확인해 주세요.</p>
"""


@router.get("/api/consent")
async def consent_texts():
    """회원가입 첫 단계: 이용약관 전문과 개인정보 수집·이용 동의 내용"""
    return {"version": POLICY_VERSION, "terms": terms_body(), "privacy": consent_privacy_body()}


@router.get("/live/terms", response_class=HTMLResponse)
async def terms():
    return page("이용약관", terms_body())


@router.get("/live/privacy", response_class=HTMLResponse)
async def privacy():
    s = settings()
    op, ai = e(s["operator"]), s["ai"]
    ai_rows = """<tr><td>Anthropic, PBC (미국)<br><span class="muted">anthropic.com/legal/privacy</span></td><td>AI 조교 답변 생성</td>
<td>학생이 AI 조교에 입력한 질문 내용 (이름·학번은 보내지 않음)</td><td>미국</td>
<td>AI 조교를 쓸 때마다 암호화된 인터넷 연결로 전송</td><td>답변을 만든 뒤 해당 회사 정책에 따라 처리 (학습에 쓰지 않는 API 이용)</td>
<td>AI 조교를 쓰지 않으면 이전되지 않음 (수업 이용에는 지장 없음)</td></tr>""" if ai else ""
    return page("개인정보 처리방침", f"""
<p class="muted">시행일: {POLICY_VERSION} · 운영 기관: {op}</p>
<p>{op}(이하 '운영 기관')는 「개인정보 보호법」에 따라 실시간 온라인 수업 서비스 이용자의 개인정보를 다음과 같이 처리합니다.</p>

<h2>1. 처리 목적</h2>
<p>로그인과 본인 확인, 수강신청과 승인, 실시간 수업 진행(화상·음성·발표·퀴즈·질문), 출결 확인, 수업 후 채점과 피드백, 강사·관리교사 등록과 승인, 부정 이용 방지.</p>

<h2>2. 처리하는 개인정보 항목</h2>
<table class="att"><thead><tr><th>대상</th><th>항목</th></tr></thead><tbody>
<tr><td>모든 이용자</td><td>구글 계정 이메일·이름·고유 번호(로그인 확인용), 접속 시각, 로그인 유지 쿠키</td></tr>
<tr><td>학생</td><td>실명, 학교, 학년·반·번호(학번), 수강신청·승인 기록, 수업별 입장·퇴장 시각과 나간 이유, 선생님께 한 질문과 답변, 퀴즈·활동 답과 점수·피드백, 과제 제출물(파일·글)과 제출 시각, 과제 점수·피드백</td></tr>
<tr><td>강의교사·관리교사·참여학교 담당자</td><td>이름(실명), 소속, 생년월일, 이메일, 연락처, 신청한 거점학교·학교, 희망·승인 활동 기간, 개인정보 보호 서약 동의 시각</td></tr>
<tr><td>수업 자료</td><td>선생님이 수업 때 띄운 발표 자료(PDF)와 선생님 판서 — 그 수업을 들은 학생과 강좌 수강생이 나중에 다시 볼 수 있도록 보관합니다(학생 개인정보는 들어 있지 않음).</td></tr>
<tr><td>수업 중 (서버에 저장하지 않음)</td><td>카메라 영상, 마이크 음성, 화면 공유, 채팅 — 서버를 거쳐 실시간으로 전달만 하고 서버에 녹화·저장하지 않습니다.</td></tr>
{'<tr><td>강의 녹화 (선생님이 녹화할 때만)</td><td>선생님 화면에 보인 학생의 영상·이름과 수업 중 목소리 — <strong>선생님 컴퓨터에만</strong> 동영상 파일로 저장되고 서버에는 올라가지 않습니다. 녹화 중에는 학생 화면에 "🔴 녹화 중"이 표시되고, 녹화 시작·종료가 수업 채팅에 남습니다.</td></tr>' if s['rec'] else ''}
</tbody></table>

<h2>3. 보유 기간과 파기</h2>
<ul>
<li>학생·수업 기록(출결, 질문답변, 퀴즈 답·점수, 과제 제출물·점수)과 수업 자료·판서: <strong>{e(s['retention'])}</strong>까지 보관한 뒤 파기합니다. 선생님은 수업 자료를 언제든 지울 수 있습니다.</li>
<li>강사·관리교사 등록 정보: 활동 기간이 끝나거나 해제된 뒤 같은 기간까지 보관합니다.</li>
<li>백업: 매일 자동으로 만들고 14일이 지나면 자동으로 지웁니다.</li>
<li>회원 탈퇴: 마이페이지 → 내 정보 → '회원 탈퇴'에서 합니다. 학생은 강좌 출결·평가 기록 보호를 위해 탈퇴를 신청하면 그 학생 학교의 참여학교 담당자(없으면 전체 관리자)가 확인해 승인하며, 승인하는 즉시 그 학생의 정보와 기록(출결, 질문, 퀴즈 답·점수, 과제 제출물, 수강신청)을 파기합니다. 강사·관리교사 등은 바로 탈퇴할 수 있으나, 직접 강좌·수업을 연 강사는 개인정보 보호책임자에게 요청하면 확인 후 지체 없이 처리합니다.</li>
<li>탈퇴 처리 기록: 학생 탈퇴를 승인하면 확인 기록으로 이름·학교·학번·탈퇴 신청일·승인일만 남겨 그 학교 참여학교 담당자가 볼 수 있게 하고, 위 학생·수업 기록과 같은 보유 기간이 지나면 파기합니다.</li>
<li>파기 방법: 데이터베이스에서 지우고 다시 살릴 수 없게 합니다. 내려받은 파일(CSV 등)은 강사가 개인정보 보호 서약에 따라 지체 없이 지웁니다.</li>
</ul>

<h2>4. 제3자 제공</h2>
<p>개인정보를 다른 기관이나 회사에 제공하지 않습니다. 다만 법령에 따라 요청받은 경우는 예외입니다.</p>

<h2>5. 처리 위탁과 국외 이전</h2>
<p>서비스는 해외 서버에서 운영되어 개인정보가 국외로 이전됩니다(「개인정보 보호법」 제28조의8).
EU(유럽연합)는 2025년 9월 개인정보보호위원회가 국내와 실질적으로 동등한 보호 수준을 갖췄다고 인정(적정성 인정)한 지역이므로,
같은 법 제28조의8 제1항 제5호에 따라 <strong>별도의 국외 이전 동의 없이</strong> 이전할 수 있습니다. 이 서비스의 서버(데이터 보관·처리)는 모두 EU에 있습니다.
{'다만 AI 조교(미국)는 이 인정 대상이 아니어서, 처음 쓸 때 안내를 확인한 경우에만 질문 내용이 전송됩니다.' if ai else ''}</p>
<div class="table-wrap"><table class="att"><thead><tr><th>받는 자</th><th>목적</th><th>항목</th><th>국가</th><th>시기·방법</th><th>보유 기간</th><th>거부 방법과 결과</th></tr></thead><tbody>
<tr><td>Hetzner Online GmbH (독일)<br><span class="muted">hetzner.com/legal/privacy-policy</span></td><td>서버 호스팅 (데이터 보관·전송)</td>
<td>2번의 모든 항목</td><td>{e(s['region'])}</td><td>서비스를 이용할 때 암호화된 인터넷 연결로 전송</td><td>3번 보유 기간과 같음</td>
<td>서비스 운영에 꼭 필요해 거부하면 서비스를 이용할 수 없음</td></tr>
{ai_rows}
</tbody></table></div>
<p>구글 로그인은 이용자가 이미 가진 구글 계정으로 본인을 확인하는 것으로, 운영 기관이 구글에 개인정보를 제공하지 않습니다(로그인 화면은 구글이 직접 제공합니다).</p>

<h2>6. 만 14세 미만 아동</h2>
<p>만 14세 미만 학생의 개인정보는 보호자의 동의를 받아 처리합니다. 학교가 가정통신문(보호자 동의서)으로 동의를 받습니다.</p>

<h2>7. 정보주체(학생·보호자·강사)의 권리</h2>
<p>자기 개인정보의 열람, 정정, 삭제, 처리 정지를 요구할 수 있습니다. 학생은 첫 화면의 '내 정보'에서 이름·학번을 직접 고칠 수 있고, 그 밖의 요구는 아래 개인정보 보호책임자에게 하면 지체 없이 처리합니다. 만 14세 미만 학생은 보호자가 대신 요구할 수 있습니다.</p>

<h2>8. 안전성 확보 조치</h2>
<ul>
<li>모든 연결은 암호화(HTTPS)되고, 비밀번호를 저장하지 않습니다(구글 로그인).</li>
<li>학생 정보는 담당 강사, 거점학교 관리교사, 그 학생 학교의 참여학교 담당자, 전체 관리자만 볼 수 있고(과제 제출 파일은 낸 학생 본인과 담당 강사만), 강사·관리교사의 활동 기간이 끝나면 접근 권한이 바로 꺼집니다.</li>
<li>강사·관리교사는 등록할 때 개인정보 보호 서약에 동의합니다.</li>
<li>서버의 데이터베이스와 백업은 외부에서 접속할 수 없고 관리자만 읽을 수 있으며, 보안 업데이트를 매일 자동으로 설치합니다.</li>
</ul>

<h2>9. 자동 수집 장치(쿠키)</h2>
<p>로그인을 유지하는 쿠키 하나만 씁니다(14일). 광고·분석 쿠키는 쓰지 않습니다. 브라우저 설정에서 쿠키를 막으면 로그인할 수 없습니다.</p>

<h2>10. 개인정보 보호책임자</h2>
<p>운영 기관: {op}<br>개인정보 보호책임자: {e(s['officer'])}<br>연락처: {e(s['contact'])}</p>

<h2>11. 권익 침해 구제 방법</h2>
<p>개인정보분쟁조정위원회 1833-6972 (kopico.go.kr) · 개인정보침해신고센터 118 (privacy.kisa.or.kr) · 대검찰청 1301 · 경찰청 182</p>

<h2>12. 변경</h2>
<p>이 처리방침을 바꾸면 시행일 전에 서비스 화면에 알립니다.</p>
""")


@router.get("/live/notice", response_class=HTMLResponse)
async def notice():
    s = settings()
    op, ai = e(s["operator"]), s["ai"]
    return page("실시간 온라인 수업 이용 안내 및 개인정보 수집·이용 동의서", f"""
<p>학부모님 안녕하십니까. {op}에서는 실시간 온라인 수업(공동교육과정·보충수업 등)을 운영합니다.
학생이 집에서 학교 구글 계정으로 접속해 화상으로 수업을 듣고, 출결과 퀴즈 결과가 기록됩니다. 아래 내용을 읽어 보시고 동의 여부를 표시해 주시기 바랍니다.</p>

<h2>1. 수집·이용하는 개인정보</h2>
<ul>
<li><strong>목적:</strong> 수강신청·승인, 실시간 수업 진행, 출결 확인, 퀴즈·활동 채점과 피드백</li>
<li><strong>항목:</strong> 학교 구글 계정 이메일·이름, 실명, 학교, 학년·반·번호, 수업 입장·퇴장 시각, 선생님께 한 질문과 답변, 퀴즈·활동 답과 점수, 과제 제출물과 점수·피드백</li>
<li><strong>보유 기간:</strong> {e(s['retention'])}</li>
<li>수업 중 영상·음성·채팅은 <strong>서버에 녹화·저장하지 않습니다.</strong></li>
{'<li><strong>강의 녹화:</strong> 선생님이 복습 자료 등 수업 목적으로 수업을 녹화할 수 있습니다. 녹화본은 선생님 컴퓨터에만 저장되고, 녹화 중에는 학생 화면에 "녹화 중"이 표시됩니다. 카메라를 꺼 두면 학생 얼굴은 녹화되지 않습니다. 선생님은 녹화본을 수업 목적으로만 쓰고 공유·게시하지 않으며 보유 기간이 지나면 지웁니다.</li>' if s['rec'] else ''}
</ul>

<h2>2. 개인정보 국외 이전</h2>
<ul>
<li>Hetzner Online GmbH (독일) 서버, {e(s['region'])} — 서비스 운영(데이터 보관·전송). EU는 개인정보보호위원회가 국내와 동등한 보호 수준으로 인정한 지역(2025년 9월 적정성 인정, 개인정보 보호법 제28조의8 제1항 제5호)이라 별도 동의 없이 이전할 수 있습니다.</li>
{'<li>Anthropic, PBC (미국) — AI 조교 답변 생성. 학생이 AI 조교에 입력한 질문만 전송되며 이름·학번은 보내지 않습니다. AI 조교를 쓰지 않아도 수업에는 지장이 없습니다.</li>' if ai else ''}
</ul>

<h2>3. 동의를 거부할 권리</h2>
<p>동의를 거부할 수 있습니다. 다만 거부하면 실시간 온라인 수업에 참여할 수 없으며, 학교와 다른 학습 방법을 협의하게 됩니다.</p>

<h2>4. 가정에서 지도해 주실 점</h2>
<ul>
<li>수업 화면을 녹화·캡처하거나 인터넷에 올리지 않도록 지도해 주세요 (다른 학생의 초상권·개인정보 침해).</li>
<li>처음 접속할 때 카메라·마이크 사용을 <strong>허용</strong>해야 선생님이 수업 중 마이크·카메라를 켜고 끌 수 있습니다.</li>
<li>이어폰을 쓰면 소리가 울리지 않습니다.</li>
</ul>
<p>자세한 내용: 개인정보 처리방침 (서비스 첫 화면 아래 링크) · 문의: {e(s['officer'])} {e(s['contact'])}</p>

<div class="consent-form">
<p class="cut">✂ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -</p>
<h2 style="text-align:center">개인정보 수집·이용 및 국외 이전 동의서</h2>
<p>위 내용을 읽고 실시간 온라인 수업 참여를 위한 개인정보 수집·이용 및 국외 이전에</p>
<p style="text-align:center;font-size:1.1rem">□ 동의합니다 &nbsp;&nbsp;&nbsp; □ 동의하지 않습니다</p>
<table class="att sign"><tbody>
<tr><td>학생</td><td>____학년 ____반 ____번 &nbsp; 이름 ______________</td></tr>
<tr><td>보호자</td><td>이름 ______________ (서명) &nbsp; 학생과의 관계 ________</td></tr>
<tr><td>날짜</td><td>20____년 ____월 ____일</td></tr>
</tbody></table>
<p style="text-align:right">{e(s['consent_to'])} 귀하</p>
</div>
""", printable=True)
