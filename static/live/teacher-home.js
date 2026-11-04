/* 선생님 교무실: [특강/회의] [과목 운영(+ 과목 개설, 과목마다 수강생 관리)] [거점학교 운영] [참여학교 담당] (+ 전체 운영 관리) */

let teacherCourses = null; // 아직 못 불러왔으면 null
const editing = new Set(); // 정보 수정 중인 강좌
let runCourseId = null; // 과목 운영에서 연 과목
let runSub = "info"; // 그 과목 안의 칸: info(과목 정보) open(수업 열기) notice(공지사항) assess(수행평가) learn(학습 관리) satisfaction(만족도 조사)
const satisfactionSub = new Map(); // 강좌별 만족도 조사 내부 탭
let hubSub = "teachers"; // 거점학교 운영: teachers(강의교사 승인) courses(강좌 개설) days(수업일) attendance(출석부)
let hubCourseId = null; // 강좌 개설 승인 목록에서 보고 있는 강좌
let hubRecordCourseId = null; // 수업일·출석부에서 보고 있는 강좌
let hubClassId = null; // 수업일에서 눌러 본 그날의 수강생 출석부
let adminSub = "approve";
let schoolSub = "signup";
let detailTarget = null; // 수업 기록(출결·채점)을 그릴 자리
function detailEl() { return detailTarget || $("#run-detail"); }

function today() {
  // 기록은 한국 시간 날짜로 나뉜다 (기기 시간대와 상관없이)
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** replaceChildren에 null·false가 섞여도 글자로 찍히지 않게 */
function fill(box, ...kids) { box.replaceChildren(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false && x !== "")); }

/* 권한: 관리교사는 [특강/회의]·[거점학교 운영]·[참여학교 담당],
   강의교사는 [특강/회의]·[과목 운영] (과목 개설은 [+ 과목 개설] 버튼, 수강 승인은 과목 안 [수강생 관리] 탭). */
function canHub() { return ME.is_admin || ME.coordinator_hubs.length > 0; }
function canSchool() { return ME.is_admin || (ME.participant_schools || []).length > 0; }
function canTeach() {
  // 설정으로 등록한 강사(거점학교 등록 없이)도 강의한다: 다른 역할만 가진 게 아니면 강의교사로 본다
  const schoolTransfer = ME.memberships?.some((m) => ["coordinator", "participant"].includes(m.role) && m.transfer_from && m.status === "pending");
  return ME.is_admin || ME.lead_hubs.length > 0 || ME.teach_hubs.length > 0 || !(canHub() || canSchool() || schoolTransfer);
}
function allowed(tab) {
  if (tab === "admin") return ME.is_admin;
  if (tab === "hub") return canHub();
  if (tab === "school") return canSchool();
  if (tab === "meet") return canTeach() || canHub() || canSchool();
  return canTeach();
}

function showTeacher() {
  if (!canTeach() && !canHub() && !canSchool() && !ME.is_admin) {
    showProfile();  // 학교 변경 승인 대기 중에는 담당 정보와 신청 상태를 보여 준다.
    return;
  }
  show("teacher-view");
  $(".mypage-title").textContent = "교무실";
  document.title = "외솔온닷 · 교무실";
  $("#lead").hidden = true;
  $("#admin-tab").hidden = false;
  $("#home-tabs").style.setProperty("--sub-count", 5);
  $("#home-tabs").style.setProperty("--sub-min-width", "560px");
  if (params.get("tab") === "create") runCreating = true; // 예전 [과목 개설] 탭 주소
  if (params.get("tab") === "students" && params.get("course")) runSub = "students";
  const want = ["courses", "history", "create", "students"].includes(params.get("tab")) ? "run" : params.get("tab");
  if (params.get("course")) runCourseId = Number(params.get("course"));
  // 교무실에 들어오면 [특강/회의]부터 (볼 수 없는 역할이면 예전처럼)
  const first = allowed("meet") ? "meet" : canTeach() ? "run" : canHub() ? "hub" : "school";
  showHomeTab(want && document.querySelector(`#home-tabs [data-tab="${want}"]`) && allowed(want) ? want : first);
  if (canTeach()) loadTeacherCourses();
  if (canHub()) loadHub();
  if (canSchool()) loadSchool();
  if (ME.is_admin) loadAdmin();
}

function showHomeTab(name) {
  for (const b of $("#home-tabs").children) b.classList.toggle("active", b.dataset.tab === name);
  const ok = allowed(name);
  $("#no-access").hidden = ok;
  for (const p of document.querySelectorAll("#teacher-view [data-panel]")) p.hidden = !ok || p.dataset.panel !== name;
  if (!ok) return;
  if (name === "meet") { meetView = null; showMeetSub(meetSub); loadLive(); loadMeetings(); loadMeetHistory(); }
  if (name === "run") renderRun();
  if (name === "admin") loadAdmin();
  if (name === "hub") loadHub();
  if (name === "school") loadSchool();
}
$("#home-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b?.dataset.tab === "run") runCreating = false; // [과목 운영] 탭을 누르면 과목 목록으로
  if (b) showHomeTab(b.dataset.tab);
});

async function loadTeacherCourses() {
  ({ courses: teacherCourses } = await api("/api/courses/mine"));
  const active = teacherCourses.filter((c) => !c.archived && !c.locked);
  const pending = active.reduce((n, c) => n + c.pending, 0);
  $("#pending-badge").textContent = pending;
  $("#pending-badge").hidden = !pending;
  if (!$('[data-panel="run"]').hidden) renderRun();
}

const copy = async (text, msg) => {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { await appPrompt("복사해서 보내 주세요.", text); }
};

/* ───────────────────────── 특강/회의 ───────────────────────── */

async function loadLive() {
  const { classes } = await api("/api/live/my-classes");
  const meets = classes.filter((c) => !c.course_id);
  const box = $("#live-classes");
  fill(box, ...meets.map((c) => h("div", { class: "meet-row" },
    h("div", { class: "grow" }, h("strong", {}, c.title), h("div", { class: "muted", style: "font-size:0.85rem" }, `${fmtTime(c.created_at)} 시작 · 입장 코드 ${c.code}`)),
    h("button", { class: "small", onclick: () => copy(c.code, `입장 코드 ${c.code}를 복사했어요.`) }, "코드 복사"),
    h("a", { class: "button small primary", href: `/live/teacher/${c.code}` }, "들어가기"))));
  if (!meets.length) box.append(h("span", { class: "muted" }, "지금 열려 있는 특강·회의가 없어요."));
}

$("#meet-now").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const res = await api("/api/live/classes", { title: $("#meet-title").value.trim() || "특강·회의" });
    location.href = `/live/teacher/${res.code}`;
  } catch (err) { toast(err.message); }
});

$("#meet-book").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/meetings", { title: $("#book-title").value.trim(), date: $("#book-date").value, time: $("#book-time").value });
    toast(`예약했어요. 입장 코드 ${r.code}를 참가자에게 미리 알려 주세요.`, 6000);
    $("#book-title").value = "";
    loadMeetings();
  } catch (err) { toast(err.message); }
});

async function loadMeetings() {
  const { meetings } = await api("/api/meetings");
  const box = $("#meet-list");
  fill(box, ...meetings.map((m) => h("div", { class: "meet-row" },
    h("div", { class: "grow" }, h("strong", {}, m.title),
      h("div", { class: "muted", style: "font-size:0.85rem" }, `${m.start.replaceAll("-", ".")} · 입장 코드 `, h("b", {}, m.code),
        m.live ? h("span", { class: "status approved" }, " 진행 중") : null)),
    h("button", { class: "small", onclick: () => copy(`[${m.title}] ${m.start.replaceAll("-", ".")} · 외솔온닷 입장 코드 ${m.code}`, "안내 문구를 복사했어요.") }, "코드 복사"),
    h("button", { class: "small primary", onclick: async () => {
      try { const r = await api(`/api/meetings/${m.id}/open`, {}); location.href = `/live/teacher/${r.code}`; } catch (err) { toast(err.message); }
    } }, m.live ? "들어가기" : "열기"),
    m.opened ? null : h("button", { class: "small danger", onclick: async () => {
      if (!await appConfirm(`'${m.title}' 예약을 취소할까요?`)) return;
      await api(`/api/meetings/${m.id}/delete`, {});
      loadMeetings();
    } }, "취소"))));
  if (!meetings.length) box.append(h("span", { class: "muted" }, "예약한 특강·회의가 없어요."));
}

$("#meet-join").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#meet-join-error").textContent = "";
  const code = $("#meet-code").value.trim().toUpperCase();
  if (!code) return;
  try {
    const r = await api(`/api/live/classes/${code}/join`, {});
    location.href = r.teacher ? `/live/teacher/${code}` : `/live/class/${code}`;
  } catch (err) { $("#meet-join-error").textContent = err.message; }
});

/* 지난 특강/회의 하나: 위에 제목 띠(이름·일시·입장 코드), 아래 [참석자][자료][퀴즈][설문][발언 기록] */
let meetDetailTab = "people";
let meetSpeaker = null; // [발언기록]에서 열어 본 학생 id
async function renderMeetDetail(m, box) {
  const back = () => { meetView = null; meetSpeaker = null; loadMeetHistory(); };
  const time = (t) => (t || "").slice(0, 5);
  let r;
  try { r = await api(`/api/live/history/${m.id}`); } catch (err) { fill(box, h("p", { class: "error" }, err.message)); return; }
  const c = r.class;
  const when = `${fmtDate(m.date)} ${time(c.start)} ~ ${c.end ? time(c.end) : c.live ? "진행 중" : ""}`;
  const banner = h("div", { class: "course-banner meet-banner", style: "--a:#5aa0e6;--b:#2f5fb3" },
    h("span", { class: "cb-area" }, "특강", h("br"), "회의"),
    h("div", { class: "cb-text" },
      h("div", { class: "cb-kicker" }, "특강·회의 기록"),
      h("h2", { class: "cb-title" }, c.title || "특강·회의"),
      h("div", { class: "cb-facts" }, `🗓 ${when}`)),
    h("div", { class: "cb-side" },
      h("span", { class: "cb-ico", "aria-hidden": "true" }, "🎥"),
      h("div", { class: "cb-chips" },
        h("span", { class: "cb-chip" }, `입장 코드 ${c.code}`),
        h("span", { class: "cb-chip" }, `참석 ${r.students.length}명`),
        c.live ? h("span", { class: "cb-chip warn" }, "진행 중") : h("span", { class: "cb-chip" }, "종료"))));
  const tabs = [["people", "🙋 참석자"], ["files", "📄 자료"], ["quiz", "✅ 퀴즈"], ["poll", "📊 설문"], ["script", "🗒 스크립트"], ["speech", "🧑‍🎓 발언기록"]];
  const nav = h("nav", { class: "tabs sub-tabs" });
  const pane = h("div", { class: "meet-pane" });
  const show = (k) => {
    meetDetailTab = k;
    for (const b of nav.children) b.classList.toggle("active", b.dataset.k === k);
    fill(pane, h("p", { class: "muted" }, "불러오는 중…"));
    detailTarget = pane;
    if (k === "people") meetPeople(m.id, r, pane);
    else if (k === "files") meetFiles(m.id, pane);
    else if (k === "quiz") { fill(pane); pane.dataset.only = "quiz"; renderGrades(m.id, pane); }
    else if (k === "poll") meetPolls(m.id, pane);
    else if (k === "script") meetScript(m.id, pane);
    else meetSpeakers(m.id, pane);
    if (k !== "quiz") delete pane.dataset.only;
  };
  nav.append(...tabs.map(([k, label]) => h("button", { type: "button", "data-k": k, onclick: () => show(k) }, label)));
  fill(box,
    h("div", { class: "row", style: "margin:4px 0 0" }, h("button", { class: "small", onclick: back }, "← 지난 기록 목록")),
    banner, nav, pane);
  show(meetDetailTab);
}

/* [스크립트]: 선생님·학생 발언을 시간 순서대로 */

/** 학생 발언 옆 [응답]/[자발] 표시: 직전 20초 안에 선생님 질문이 있으면 응답 (선생님 말은 발언 기록·자막이 켜져 있을 때만 저장) */
function spKind(e) {
  if (e.role === "teacher" || !e.kind) return null;
  return h("span", { class: `sp-kind ${e.kind === "응답" ? "resp" : "spon"}`, title: e.prompt ? `선생님 발문: ${e.prompt}` : "스스로 한 발언" }, e.kind);
}

async function meetScript(id, box) {
  const { entries } = await api(`/api/live/history/${id}/speech`);
  fill(box,
    h("div", { class: "row", style: "margin:8px 0" },
      h("span", { class: "grow muted" }, `발언 ${entries.length}건`),
      entries.length ? h("a", { href: `/api/live/history/${id}/speech.xlsx`, class: "button small" }, "📥 스크립트 엑셀") : null),
    entries.length ? h("div", { class: "speech-script" }, ...entries.map((e) => h("div", { class: `speech-line ${e.role}` },
      h("span", { class: "sp-time" }, e.time.slice(0, 5)),
      h("span", { class: "sp-who" }, e.role === "teacher" ? "👩‍🏫 선생님" : [e.student_no, e.name].filter(Boolean).join(" ")),
      spKind(e), h("span", { class: "sp-text" }, e.text))))
      : h("p", { class: "muted" }, "이 특강·회의에서 [📝 발언 기록]을 켜지 않았어요. 수업 화면 위쪽의 [📝 발언 기록]을 켜면 마이크를 켠 사람의 말이 글자로 남아요."));
}

/* [발언기록]: 참석자 전체 워드클라우드 → 참석자별 발언 표 → 이름을 누르면 그 사람의 워드클라우드와 발언 모음 */
async function meetSpeakers(id, box) {
  const { entries } = await api(`/api/live/history/${id}/speech`);
  const people = new Map();
  for (const e of entries) if (e.role === "student") {
    const p = people.get(e.user_id) || { user_id: e.user_id, school: e.school, student_no: e.student_no, name: e.name, items: [], chars: 0 };
    p.items.push(e);
    p.chars += e.text.length;
    people.set(e.user_id, p);
  }
  const list = [...people.values()].sort((a, b) => (a.school + a.student_no + a.name).localeCompare(b.school + b.student_no + b.name, "ko"));
  const who = people.get(meetSpeaker);
  if (who) {
    const cloud = h("div", { class: "word-cloud" });
    fill(box,
      h("div", { class: "row", style: "margin:8px 0" }, h("button", { class: "small", onclick: () => { meetSpeaker = null; meetSpeakers(id, box); } }, "← 참석자 목록")),
      h("div", { class: "hub-grid-summary" }, `${[who.school, who.student_no, who.name].filter(Boolean).join(" ")} · 발언 ${who.items.length}건 · ${who.chars.toLocaleString()}자`),
      h("h4", { class: "speech-h" }, "☁️ 워드클라우드 (많이 쓴 낱말)"), cloud,
      h("h4", { class: "speech-h" }, "🗒 발언 모음"),
      h("div", { class: "speech-day" }, ...who.items.map((e) => h("div", { class: "speech-line student" },
        h("span", { class: "sp-time" }, e.time.slice(0, 5)), spKind(e), h("span", { class: "sp-text" }, e.text)))));
    drawWordCloud(cloud, who.items.map((e) => e.text));
    return;
  }
  const allCloud = h("div", { class: "word-cloud" });
  fill(box,
    h("div", { class: "row", style: "margin:8px 0" },
      h("span", { class: "grow muted" }, `발언한 참석자 ${list.length}명`)), // 엑셀은 [스크립트] 탭에
    list.length ? [
      h("h4", { class: "speech-h", style: "margin-top:4px" }, "☁️ 참석자 전체 워드클라우드"), allCloud,
      h("h4", { class: "speech-h" }, "🧑‍🎓 참석자별 발언 (이름을 누르면 자세히)"),
      h("div", { class: "table-wrap" }, h("table", { class: "att assign-board speech-board speech-students" },
        h("thead", {}, h("tr", {}, ["연번", "소속학교", "학번", "이름", "발언 수", "글자 수", "첫 발언"].map((t) => h("th", {}, t)))),
        h("tbody", {}, list.map((x, i) => h("tr", { class: "assign-row", onclick: () => { meetSpeaker = x.user_id; meetSpeakers(id, box); } },
          h("td", { class: "num" }, i + 1), h("td", { class: "num" }, x.school || "-"), h("td", { class: "num" }, x.student_no || "-"),
          h("td", { class: "num" }, h("span", { class: "day-link" }, x.name || "-")),
          h("td", { class: "num" }, `${x.items.length}건`), h("td", { class: "num" }, `${x.chars.toLocaleString()}자`),
          h("td", { class: "num" }, x.items[0].time.slice(0, 5)))))))]
      : h("p", { class: "muted" }, "참석자 발언 기록이 없어요. 수업 화면 위쪽의 [📝 발언 기록]을 켜면 마이크를 켠 참석자의 말이 글자로 남아요."));
  if (list.length) drawWordCloud(allCloud, list.flatMap((x) => x.items.map((e) => e.text)));
}

/* [참석자]: 들어오고 나간 기록 (학교 → 학번 → 이름) */
function meetPeople(id, r, box) {
  const listen = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, "0")}초` : `${sec}초`);
  const rows = r.rows.map((x, i) => h("tr", {},
    h("td", { class: "num" }, i + 1), h("td", {}, x.school || "-"), h("td", { class: "num" }, x.student_no || "-"), h("td", {}, x.name),
    h("td", { class: "num" }, x.joined), h("td", { class: "num" }, x.online ? h("strong", { class: "ok-text" }, "접속 중") : x.left),
    h("td", { class: "num" }, listen(x.seconds))));
  const absent = r.absent.map((a) => h("tr", { class: "absent" },
    h("td", {}, ""), h("td", {}, a.school || "-"), h("td", { class: "num" }, a.student_no), h("td", {}, a.name), h("td", { colspan: 3, class: "num" }, "미접속")));
  fill(box,
    h("div", { class: "row", style: "margin:8px 0" },
      h("span", { class: "grow muted" }, `참석 ${r.students.length}명${r.class.target_grade ? ` · 대상 ${r.class.target_grade}학년 ${r.class.target_class}반 (미접속 ${r.absent.length}명)` : ""}`),
      h("a", { href: `/api/live/history/${id}/attendance.csv`, class: "button small" }, "📥 출결 CSV")),
    h("div", { class: "table-wrap" }, h("table", { class: "att meet-people" },
      h("thead", {}, h("tr", {}, ["연번", "학교", "학번", "이름", "접속 시각", "종료 시각", "청취 시간"].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows, absent,
        !rows.length && !absent.length ? h("tr", {}, h("td", { colspan: 7, class: "muted", style: "text-align:center;padding:18px" }, "접속한 사람이 없어요.")) : null))));
}

/* [자료]: 띄운 발표 자료(PDF)와 판서 */
async function meetFiles(id, box) {
  let d;
  try { d = await api(`/api/materials/class/${id}`); }
  catch { fill(box, h("p", { class: "muted", style: "margin:12px 0" }, "이 특강·회의에서 띄운 자료나 판서가 없어요.")); return; }
  const items = d.files.map((f, i) => h("tr", {},
    h("td", { class: "num" }, i + 1), h("td", {}, `📄 ${f.name}`), h("td", { class: "num" }, f.pages ? `${f.pages}쪽` : "-"),
    h("td", { class: "num" }, h("a", { class: "button small", href: `/api/materials/file/${f.id}`, download: f.name }, "받기"))));
  const removed = (d.removed || []).map((f) => h("tr", { class: "absent" },
    h("td", {}, ""), h("td", {}, `🗑 ${f.name}`), h("td", { class: "num" }, f.pages ? `${f.pages}쪽` : "-"), h("td", { class: "num muted" }, "파기됨")));
  fill(box,
    h("div", { class: "row", style: "margin:8px 0" },
      h("span", { class: "grow muted" }, `자료 ${d.files.length}개${d.board_pages ? ` · 화이트보드 ${d.board_pages}쪽` : ""}`),
      d.files.length || d.board_pages ? h("a", { class: "button small", href: `/live/materials?class=${id}`, target: "_blank" }, "📖 자료·판서 화면으로 보기") : null),
    items.length || removed.length ? h("div", { class: "table-wrap" }, h("table", { class: "att" },
      h("thead", {}, h("tr", {}, ["연번", "파일", "쪽수", "내려받기"].map((t) => h("th", {}, t)))),
      h("tbody", {}, items, removed)))
      : h("p", { class: "muted" }, d.board_pages ? "띄운 PDF 자료는 없고 화이트보드 판서만 있어요." : "이 특강·회의에서 띄운 자료가 없어요."),
    removed.length ? h("p", { class: "muted", style: "font-size:0.85rem" }, "특강·회의가 끝나면 PDF 파일은 바로 지워지고 파일 이름만 남아요. 판서는 1년 동안 남아요.") : null);
}

/* [설문]: 보기마다 몇 명이 골랐는지 막대로 */
async function meetPolls(id, box) {
  const book = await api(`/api/live/history/${id}/grades`);
  const polls = book.activities.filter((a) => a.kind === "poll");
  if (!polls.length) { fill(box, h("p", { class: "muted", style: "margin:12px 0" }, "이 특강·회의에서 보낸 설문이 없어요.")); return; }
  fill(box,
    h("div", { class: "row", style: "margin:8px 0" }, h("span", { class: "grow muted" }, `설문 ${polls.length}개`),
      h("a", { href: `/api/live/history/${id}/results.csv`, class: "button small" }, "📥 결과 CSV")),
    ...polls.map((a, i) => {
      const answered = a.rows.filter((x) => x.answered);
      const total = a.rows.length;
      const counts = (a.options || []).map((o) => answered.filter((x) => x.answer === o || x.answer.split(", ").includes(o)).length);
      const max = Math.max(1, ...counts);
      return h("div", { class: "box poll-result" },
        h("strong", {}, `${i + 1}. ${a.prompt}`),
        h("div", { class: "muted", style: "font-size:0.85rem;margin:2px 0 8px" }, `응답 ${answered.length}명${total ? ` / ${total}명` : ""}`),
        ...(a.options || []).map((o, j) => h("div", { class: "poll-bar" },
          h("span", { class: "pb-label" }, o),
          h("span", { class: "pb-track" }, h("span", { class: "pb-fill", style: `width:${Math.round(counts[j] / max * 100)}%` })),
          h("span", { class: "pb-n" }, `${counts[j]}명`))),
        h("details", {}, h("summary", { class: "muted" }, "누가 무엇을 골랐는지"),
          h("div", { class: "table-wrap" }, h("table", { class: "att" },
            h("thead", {}, h("tr", {}, ["학번", "이름", "응답"].map((t) => h("th", {}, t)))),
            h("tbody", {}, a.rows.map((x) => h("tr", {}, h("td", {}, x.student_no || "-"), h("td", {}, x.name),
              h("td", {}, x.answered ? x.answer : h("span", { class: "muted" }, "(미응답)")))))))));
    }));
}

/* 특강/회의 안의 칸: [특강/회의 참여](참가·열기·예약·진행 중) / [지난 특강/회의](기록 게시판) */
let meetSub = "join";
function showMeetSub(k) {
  meetSub = k;
  $("#meet-join-box").hidden = k !== "join";
  $("#meet-past-box").hidden = k !== "past";
  for (const b of $("#meet-tabs").children) b.classList.toggle("active", b.dataset.meet === k);
}
for (const b of document.querySelectorAll("#meet-tabs button")) b.addEventListener("click", () => {
  if (b.dataset.meet === "past" && meetView) { meetView = null; loadMeetHistory(); }
  showMeetSub(b.dataset.meet);
});

/* 지난 특강/회의 기록: 게시판(연번·일시·이름·입장 코드·참여 인원·상태) → 누르면 별도 화면에서 출결·채점·질문·발언 기록 */
let meetView = null; // 지금 열어 본 특강/회의 id
async function loadMeetHistory() {
  const panel = $('[data-panel="meet"]');
  const showBoard = (on) => {
    $("#meet-tabs").hidden = !on;
    $("#meet-history").hidden = !on;
    $("#meet-history-title").hidden = !on; // 기록 화면에서는 제목 띠가 대신한다
  };
  const { classes } = await api("/api/live/meetings-history");
  const viewing = classes.find((c) => c.id === meetView);
  if (viewing) {
    showBoard(false);
    panel.scrollIntoView({ block: "start" });
    await renderMeetDetail(viewing, $("#meet-detail"));
    return;
  }
  meetView = null;
  if (detailTarget && !detailTarget.isConnected) detailTarget = null; // 과목 운영 쪽 기록 화면이 다시 기본 자리를 쓰게
  showBoard(true);
  fill($("#meet-detail"));
  const rows = classes.map((c, i) => h("tr", { class: "assign-row", onclick: () => { meetView = c.id; loadMeetHistory(); } },
    h("td", { class: "num" }, classes.length - i),
    h("td", { class: "num" }, `${fmtDate(c.date)} ${c.start.slice(0, 5)}`),
    h("td", {}, h("span", { class: "day-link" }, c.title || "특강·회의")),
    h("td", { class: "num" }, c.code),
    h("td", { class: "num" }, `${c.attended}명`),
    h("td", { class: "num" }, c.live ? h("span", { class: "tag" }, "진행 중") : "종료")));
  fill($("#meet-history"), h("div", { class: "table-wrap" }, h("table", { class: "att assign-board meet-board" },
    h("thead", {}, h("tr", {}, ["연번", "일시", "특강/회의 이름", "입장 코드", "참여 인원", "상태"].map((t) => h("th", {}, t)))),
    h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: 6, class: "muted", style: "text-align:center;padding:18px" }, "아직 연 특강·회의가 없어요."))))));
}

/* ───────────────────────── 강좌 개설 ───────────────────────── */

async function drawCreateForm() {
  const box = $("#course-create-box");
  box.dataset.ready = "1";
  // 팀티칭 보조교사로만 승인된 선생님은 강좌를 직접 열지 않는다
  if (!ME.is_admin && ME.teach_hubs.length && !ME.lead_hubs.length) {
    fill(box, h("p", { class: "muted" }, "팀티칭 보조교사로 승인받았어요. 주강사가 강좌를 열 때 보조교사로 넣으면 '과목 운영'에 그 강좌가 나타나요."));
    return;
  }
  try {
    fill(box, await courseForm(null, (id) => {
      toast("강좌를 만들었어요. 모집 기간에 학생들이 수강신청할 수 있어요.");
      runCreating = false;
      delete $("#course-create-box").dataset.ready; // 다음에 열 때 빈 양식으로
      runCourseId = id;
      runSub = "info";
      loadTeacherCourses();
    }));
  } catch (err) { fill(box, h("p", { class: "error" }, err.message)); }
}
/* ───────────────────────── 수강생 관리: 수업신청자 조회 ───────────────────────── */

const ENROLL_NAME = { pending: "승인 대기", approved: "수강 확정", rejected: "반려" };
/** 전화번호를 010-0000-0000 모양으로 (숫자만 적었어도). 모양을 알 수 없으면 적힌 그대로 */
function fmtPhone(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (!d) return v || "";
  if (/^01\d{9}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (/^01\d{8}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (/^02\d{7,8}$/.test(d)) return `02-${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
  if (/^0\d{9,10}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, d.length - 4)}-${d.slice(-4)}`;
  return v;
}
const kstDate = (ts) => (ts ? new Date(ts * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10) : "");
let enrollRows = null; // 내 강좌의 수강신청 전체
const enrollPick = new Set(); // 체크한 신청 (강좌id:학생id)
const enrollQ = {}; // 검색 조건

let enrollCourse = null; // 수강생 관리를 보고 있는 과목 ({ box, c })

/** 과목 운영 > 과목 > [👥 수강생 관리]: 그 과목의 수강신청 검색·승인·반려 */
async function renderStudents(box, c) {
  if (enrollCourse?.c.id !== c.id) for (const k of Object.keys(enrollQ)) delete enrollQ[k]; // 다른 과목이면 검색 조건 비움
  enrollCourse = { box, c };
  if (!enrollRows) fill(box, h("p", { class: "muted" }, "불러오는 중…"));
  ({ enrollments: enrollRows } = await api("/api/my/enrollments"));
  enrollRows = enrollRows.filter((x) => x.course_id === c.id);
  enrollPick.clear();
  const schools = koSort(new Set(enrollRows.map((x) => x.school).filter(Boolean)));
  const grades = [...new Set(enrollRows.map((x) => x.grade).filter(Boolean))].sort((a, b) => a - b);
  const f = {
    grade: h("select", {}, h("option", { value: "" }, "전체"), grades.map((g) => h("option", { value: String(g) }, `${g}학년`))),
    status: h("select", {}, h("option", { value: "" }, "전체"), koSort(Object.entries(ENROLL_NAME), (x) => x[1]).map(([k, v]) => h("option", { value: k }, v))),
    school: h("select", {}, h("option", { value: "" }, "전체"), schools.map((x) => h("option", { value: x }, x))),
    name: h("input", { placeholder: "학생 이름" }),
    from: h("input", { type: "date" }),
    to: h("input", { type: "date" }),
  };
  for (const [k, el] of Object.entries(f)) el.value = enrollQ[k] || "";
  const quick = (days) => {
    const t = today();
    f.to.value = t;
    f.from.value = new Date(Date.parse(t) - days * 86400000).toISOString().slice(0, 10);
  };
  const result = h("div");
  const search = () => {
    for (const [k, el] of Object.entries(f)) enrollQ[k] = el.value.trim();
    enrollPick.clear();
    drawEnrollResult(result);
  };
  for (const el of Object.values(f)) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  const row = (...cells) => h("div", { class: "sf-row" }, ...cells.flat());
  const cell = (label, el, wide) => [h("div", { class: "sf-label" }, label), h("div", { class: `sf-field ${wide ? "wide" : ""}` }, el)];
  fill(box,
    h("h3", { style: "margin:4px 0 10px" }, "👥 수강생 관리"),
    h("div", { class: "search-form" },
      row(cell("소속학교", f.school), cell("학년", f.grade)),
      row(cell("학생 이름", f.name), cell("신청 상태", f.status)),
      row(cell("신청일", h("div", { class: "row" }, f.from, "~", f.to,
        ...[["오늘", 0], ["7일", 7], ["1개월", 30], ["6개월", 182]].map(([label, d]) => h("label", { class: "switch" },
          h("input", { type: "radio", name: "enroll-quick", onchange: () => quick(d) }), label))), true))),
    h("div", { class: "row", style: "justify-content:center;margin:12px 0 20px" },
      h("button", { type: "button", onclick: () => { for (const k of Object.keys(enrollQ)) delete enrollQ[k]; renderStudents(box, c); } }, "초기화"),
      h("button", { class: "primary", type: "button", onclick: search }, "검색")),
    result);
  drawEnrollResult(result);
}

function filteredEnrollments() {
  const q = enrollQ;
  const has = (v, w) => !w || (v || "").includes(w);
  return enrollRows.filter((x) => (!q.status || x.status === q.status) && (!q.grade || String(x.grade) === q.grade) && (!q.school || x.school === q.school)
    && has(x.name, q.name) && (!q.from || kstDate(x.requested_at) >= q.from) && (!q.to || kstDate(x.requested_at) <= q.to));
}

function drawEnrollResult(box) {
  const list = filteredEnrollments();
  const key = (x) => `${x.course_id}:${x.user_id}`;
  const decide = async (status) => {
    const picked = list.filter((x) => enrollPick.has(key(x)));
    if (!picked.length) { toast("먼저 학생을 체크해 주세요."); return; }
    let note = "";
    if (status === "rejected") {
      note = await appPrompt(`${picked.length}명의 수강신청을 반려해요. 사유 (학생에게 보여요, 비워도 돼요)`, "");
      if (note === null) return;
    } else if (!await appConfirm(`${picked.length}명을 수강 확정할까요?`)) return;
    let ok = 0;
    for (const x of picked) {
      try { await api(`/api/courses/${x.course_id}/enrollments/${x.user_id}`, { status, note }); ok++; } catch (err) { toast(err.message); }
    }
    toast(status === "approved" ? `${ok}명을 승인했어요.` : `${ok}명을 반려했어요.`);
    loadTeacherCourses(); // 과목 화면을 다시 그리며 수강생 관리 탭도 새로 불러온다
  };
  const csv = () => {
    const head = ["연번", "거점학교", "과목명", "소속학교", "학년", "반", "학생이름", "이메일", "연락처", "신청일", "신청상태"];
    const lines = list.map((x, i) => [list.length - i, x.hub_school, x.subject, x.school,
      x.grade ? `${x.grade}학년` : "", x.class_no ? `${x.class_no}반` : "", x.name, x.email || "", fmtPhone(x.phone), kstDate(x.requested_at), ENROLL_NAME[x.status] || x.status]);
    const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const text = "﻿" + [head, ...lines].map((r) => r.map(esc).join(",")).join("\r\n");
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })), download: `수강생_${today()}.csv` });
    api("/api/access-log/export", { what: `수강생 명단 엑셀 (${list.length}명)` }).catch(() => {});
    document.body.append(a);
    a.click();
    a.remove();
  };
  const all = h("input", { type: "checkbox", onchange: (e) => {
    for (const x of list) { if (e.target.checked) enrollPick.add(key(x)); else enrollPick.delete(key(x)); }
    box.querySelectorAll("tbody input[type=checkbox]").forEach((c) => { c.checked = e.target.checked; });
  } });
  fill(box,
    h("div", { class: "row", style: "margin-bottom:8px" },
      h("strong", {}, "총 ", h("span", { class: "accent-text" }, list.length), "건"),
      h("button", { class: "small primary", onclick: () => decide("approved") }, "승인"),
      h("button", { class: "small", onclick: () => decide("rejected") }, "반려"),
      h("span", { class: "grow" }),
      h("button", { class: "small", onclick: csv, disabled: !list.length }, "📥 엑셀 다운로드")),
    h("div", { class: "table-wrap" }, h("table", { class: "att enroll-table enroll-students" },
      h("thead", {}, h("tr", {}, h("th", {}, all), ["연번", "소속학교", "학년", "반", "학생이름", "이메일", "연락처", "신청일", "신청상태"].map((t) => h("th", {}, t)))),
      h("tbody", {}, list.length ? list.map((x, i) => h("tr", {},
        h("td", {}, h("input", { type: "checkbox", checked: enrollPick.has(key(x)), onchange: (e) => {
          if (e.target.checked) enrollPick.add(key(x)); else enrollPick.delete(key(x));
        } })),
        h("td", { class: "num" }, list.length - i), h("td", {}, x.school || "-"),
        h("td", { class: "num" }, x.grade ? `${x.grade}학년` : "-"), h("td", { class: "num" }, x.class_no ? `${x.class_no}반` : "-"),
        h("td", {}, x.name), h("td", { class: "contact-cell" }, x.email || "-"), h("td", { class: "contact-cell" }, fmtPhone(x.phone) || "-"), h("td", {}, kstDate(x.requested_at)),
        h("td", {}, h("span", { class: `status ${x.status === "rejected" ? "rejected" : x.status}`, title: x.note ? `사유: ${x.note}` : "" },
          ENROLL_NAME[x.status] || x.status))))
        : h("tr", {}, h("td", { colspan: 10, class: "muted", style: "text-align:center;padding:24px" }, "조건에 맞는 수강신청이 없어요."))))));
}

/* ───────────────────────── 과목 운영 ───────────────────────── */

const APPROVAL = { pending: ["pending", "개설 승인 대기"], rejected: ["rejected", "개설 반려"] };
function approvalBadge(c) {
  const a = APPROVAL[c.approval];
  return a ? h("span", { class: `status ${a[0]}` }, a[1]) : null;
}
/** 강좌 개설 승인 안내 (승인 전·반려) */
function approvalNote(c) {
  if (c.approval === "pending") return h("div", { class: "banner warn" }, "⏳ 거점학교 관리교사가 강좌 개설을 승인하면 학생들이 수강신청할 수 있고 수업을 열 수 있어요.");
  if (c.approval === "rejected") return h("div", { class: "banner warn" }, `↩ 강좌 개설이 반려됐어요: ${c.approval_note || "사유 없음"} — '정보 수정'으로 고치면 다시 승인 대기가 돼요.`);
  return null;
}

function thumbOf(c) {
  if (!window.courseThumb) return null;
  const box = h("div", { class: "run-thumb" });
  box.innerHTML = window.courseThumb(c);
  return box;
}

let runCreating = false; // [과목 운영] 안에서 [+ 과목 개설] 화면을 보고 있는지
$("#run-create-back").addEventListener("click", () => { runCreating = false; renderRun(); });

function renderRun() {
  $("#run-create").hidden = !runCreating;
  if (runCreating) {
    $("#run-list").hidden = $("#run-course").hidden = true;
    if (!$("#course-create-box").dataset.ready) drawCreateForm();
    return;
  }
  if (!teacherCourses) { fill($("#run-list"), h("p", { class: "muted" }, "불러오는 중…")); return; }
  const c = teacherCourses.find((x) => x.id === runCourseId);
  $("#run-list").hidden = !!c;
  $("#run-course").hidden = !c;
  if (c) return renderRunCourse(c);
  const tile = (x) => h("button", { class: `run-tile${x.archived ? " archived" : ""}`, type: "button", onclick: () => { runCourseId = x.id; runSub = "info"; renderRun(); } },
    thumbOf(x),
    h("strong", {}, x.title, x.archived ? h("span", { class: "ended-tag" }, "종료") : null),
    h("span", { class: "muted" }, `${x.hub_school || ""} · 수강 확정 ${x.approved}명`),
    approvalBadge(x),
    x.pending ? h("span", { class: "status pending" }, `수강 승인 대기 ${x.pending}`) : null,
    x.lead ? null : h("span", { class: "status pending" }, "팀티칭"));
  const active = teacherCourses.filter((x) => !x.archived);
  const archived = teacherCourses.filter((x) => x.archived);
  const grid = (items) => h("div", { class: "run-tiles" }, items.map(tile));
  // 보관한 강좌도 따로 접지 않고 뒤에 이어서, 회색 카드로 보여 준다
  fill($("#run-list"),
    h("div", { class: "row", style: "margin:0 0 12px;align-items:center" }, h("h2", { class: "grow", style: "margin:0" }, "내가 개설한 강좌"),
      h("button", { class: "primary", type: "button", onclick: () => { runCreating = true; renderRun(); window.scrollTo(0, 0); } }, "+ 과목 개설")),
    active.length || archived.length ? grid([...active, ...archived])
      : h("p", { class: "muted" }, "아직 개설한 과목이 없어요. 위 [+ 과목 개설]을 눌러 먼저 강좌를 만들어 주세요."));
}

/* 과목 운영 안: 과목 카드 머리 그림을 가로로 길게 늘인 제목 띠 */
function courseBanner(c) {
  const [a, b] = window.courseAreaColors ? window.courseAreaColors(c.subject_area) : ["#7fc8a9", "#1b6b4a"];
  const icons = { 국어: "📖", 수학: "📐", 영어: "🔤", 사회: "🌏", 역사: "🏛️", 도덕: "⚖️", 과학: "🔬", 체육: "⚽", 음악: "🎵", 미술: "🎨",
    연극: "🎭", "기술·가정": "🛠️", 정보: "💻", 제2외국어: "🗣️", 한문: "📜", 교양: "💡" };
  const area = c.subject_area || "교양";
  const term = [c.school_year ? `${c.school_year}학년도` : "", c.term || ""].filter(Boolean).join(" ");
  const period = c.start_date ? `${fmtDate(c.start_date)} ~ ${fmtDate(c.end_date)}` : "";
  const facts = [c.hub_school, period].filter(Boolean).join(" · ");
  const [state] = window.courseState ? window.courseState(c) : [""];
  return h("div", { class: `course-banner${c.archived ? " archived" : ""}`, style: `--a:${a};--b:${b}` },
    h("span", { class: `cb-area${area.length > 3 ? " long" : ""}` }, area),
    h("div", { class: "cb-text" },
      h("div", { class: "cb-kicker" }, term),
      h("h2", { class: "cb-title" }, c.title),
      h("div", { class: "cb-facts" }, facts)),
    h("div", { class: "cb-side" },
      h("span", { class: "cb-ico", "aria-hidden": "true" }, icons[area] || "📚"),
      h("div", { class: "cb-chips" },
        c.archived ? h("span", { class: "cb-chip ended" }, "종료") : state ? h("span", { class: "cb-chip" }, state) : null,
        h("span", { class: "cb-chip" }, `수강 확정 ${c.approved || 0}명`),
        c.pending ? h("span", { class: "cb-chip warn" }, `승인 대기 ${c.pending}`) : null)));
}

function renderRunCourse(c) {
  const update = async (values) => { await api(`/api/courses/${c.id}`, values); loadTeacherCourses(); };
  const subBox = h("div", { class: "run-sub" });
  const subs = [["students", c.pending ? `👥 수강생 관리 (대기 ${c.pending})` : "👥 수강생 관리"], ["notice", "📢 과목 공지사항"], ["info", "📘 과목 정보"], ["sessions", "🗓 회차 정보"], ["open", "▶ 온라인 수업 열기"], ["learn", "📊 학습 관리"],
    ["assess", "📝 수행평가"], ["satisfaction", "📋 만족도 조사"], ["results", "🏅 성취도 및 특기 사항"]];
  fill($("#run-course"), 
    h("div", { class: "row" },
      h("button", { class: "small", onclick: () => { runCourseId = null; renderRun(); } }, "← 과목 목록"),
      h("span", { class: "grow" }),
      !c.locked && !c.archived && c.approval === "approved" ? h("label", { class: "switch", style: "font-size:0.9rem" }, h("input", { type: "checkbox", checked: c.open,
        onchange: (e) => update({ open: e.target.checked }) }), "수강신청 받기") : null,
      c.lead && !c.locked && !editing.has(c.id) ? h("button", { class: "small", onclick: () => { editing.add(c.id); runSub = "info"; renderRun(); } }, "정보 수정") : null,
      c.lead && !c.locked ? h("button", { class: "small", onclick: async () => {
        if (c.archived || await appConfirm("학기가 끝난 강좌를 종료할까요? 수강신청이 닫히고 새 수업을 열 수 없어요. 기록은 남아요.")) update({ archived: !c.archived });
      } }, c.archived ? "종료 해제" : "종료 (학기 끝)") : null),
    courseBanner(c),
    approvalNote(c),
    c.lead ? null : h("p", { style: "margin:4px 0" }, h("span", { class: "status pending" }, "팀티칭"), ` 보조교사로 참여 중 · 주강사 ${c.owner_name}`),
    c.locked ? h("p", { class: "error" }, `${c.hub_school} 강사 활동 기간이 아니라서 이 강좌를 관리하거나 수업을 열 수 없어요. 계속 강의하려면 '내 정보'에서 가입 유형·거점학교 변경을 신청하세요.`) : null,
    c.locked ? null : h("nav", { class: "tabs sub-tabs" }, subs.map(([k, label]) => h("button", { class: runSub === k ? "active" : "",
      onclick: () => { runSub = k; renderRunCourse(c); } }, label))),
    c.locked ? h("div", { class: "run-sub" }, courseInformationPanel(c)) : subBox);
  if (c.locked) return;
  if (runSub === "info") {
    if (editing.has(c.id)) fill(subBox, courseEditForm(c));
    else {
      const std = h("section", { class: "std-section" }, h("p", { class: "muted" }, "성취기준을 불러오는 중…"));
      fill(subBox, courseInformationPanel(c, false), std);
      renderStandards(c, std); // 성취기준·성취수준·평가 요소 (achievement.js)
    }
  }
  else if (runSub === "sessions") renderSessionStandards(c, subBox); // 회차 정보 + 회차별 성취기준 (achievement.js)
  else if (runSub === "open") renderOpenClass(c, subBox);
  else if (runSub === "notice") renderCourseNotices(c, subBox);
  else if (runSub === "students") renderStudents(subBox, c);
  else if (runSub === "assess") renderCourseAssignments(c, subBox);
  else if (runSub === "learn") renderLearning(c, subBox);
  else if (runSub === "results") renderResults(c, subBox); // 성취도·세특·학생 개별 성취 평가지 (achievement.js)
  else renderCourseSatisfaction(c, subBox);
}

async function renderCourseSatisfaction(c, box) {
  fill(box, h("p", { class: "muted" }, "만족도 조사를 불러오는 중…"));
  try {
    const data = await api(`/api/courses/${c.id}/satisfaction`);
    const canEdit = !data.responses;
    const scale = [[5, "매우 그렇다"], [4, "그렇다"], [3, "보통"], [2, "그렇지 않다"], [1, "전혀 그렇지 않다"]];
    const inputs = canEdit ? data.questions.map((q) => h("input", {
      type: "text", maxlength: 200, value: q.text,
      style: "display:block;width:100%;box-sizing:border-box;margin-top:4px"
    })) : [];
    const promptInput = canEdit && data.narrative_prompt ? h("textarea", {
      rows: 3, maxlength: 500, style: "width:100%;box-sizing:border-box;margin-top:8px"
    }) : null;
    if (promptInput) promptInput.value = data.narrative_prompt;
    const groupSpan = (items, i) => {
      if (i && items[i - 1].category === items[i].category) return 0;
      let n = 1;
      while (items[i + n]?.category === items[i].category) n++;
      return n;
    };
    const questions = h("div", {}, data.questions.map((q, i) => h("div", {},
      groupSpan(data.questions, i) ? h("h4", { style: "margin:16px 0 6px" }, q.category) : null,
      h("label", { style: "display:block;margin:8px 0" },
        `${data.questions.slice(0, i + 1).filter((x) => x.category === q.category).length}. `,
        canEdit ? inputs[i] : q.text))));
    const resultsRows = (data.results || []).map((r, i) => h("tr", {},
      groupSpan(data.results, i) ? h("th", { rowspan: groupSpan(data.results, i) }, r.category) : null,
      h("td", { class: "satisfaction-question" },
        `${data.results.slice(0, i + 1).filter((x) => x.category === r.category).length}. ${r.question}`),
      h("td", { class: "num" }, `${r.average}점`),
      scale.map(([n]) => h("td", { class: "num" }, `${r.counts[n - 1]}명`))));
    const action = async (verb) => {
      if (verb === "close" && !await appConfirm("조사를 마감할까요? 마감 후 결과를 확인할 수 있고, 나중에 다시 열 수 있습니다.")) return;
      if (verb === "reopen" && !await appConfirm("조사를 다시 열까요? 기존 응답과 문항은 유지되며, 이미 응답한 학생은 다시 제출할 수 없습니다.")) return;
      const body = verb === "open" ? { questions: inputs.map((input) => input.value.trim()),
        narrative_prompt: promptInput?.value.trim() || undefined } : {};
      try {
        await api(`/api/courses/${c.id}/satisfaction/${verb}`, body);
        satisfactionSub.set(c.id, verb === "close" ? "results" : "questions");
        renderCourseSatisfaction(c, box);
      }
      catch (err) { toast(err.message, 6000); }
    };
    const status = data.open ? `진행 중 · ${data.responses}/${data.enrolled}명 응답`
      : data.closed ? `마감 · ${data.responses}/${data.enrolled}명 응답` : "아직 시작하지 않았어요.";
    const selected = satisfactionSub.get(c.id) || "questions";
    const tabs = h("nav", { class: "tabs sub-tabs", "aria-label": "만족도 조사 메뉴" },
      [["questions", "조사 문항"], ["results", "조사 결과"]].map(([key, label]) => h("button", {
        type: "button", class: selected === key ? "active" : "",
        onclick: () => { satisfactionSub.set(c.id, key); renderCourseSatisfaction(c, box); }
      }, label)));
    const questionPane = [
      h("p", { class: "muted" }, "응답 기준: 5 매우 그렇다 · 4 그렇다 · 3 보통 · 2 그렇지 않다 · 1 전혀 그렇지 않다"),
      questions,
      data.narrative_prompt ? h("div", { class: "box", style: "margin:12px 0" },
        h("strong", {}, "서술 의견 (선택)"),
        promptInput || h("p", { style: "margin:6px 0 0" }, data.narrative_prompt)) : null,
      canEdit ? h("button", { class: "primary", onclick: () => action("open") },
        data.closed ? "문항 수정 후 다시 열기" : data.open ? "문항 수정 저장" : "학생에게 내보내기") : null,
      data.open ? h("button", { class: "small", onclick: () => action("close") }, "조사 마감 및 결과 확인") : null,
      data.closed ? h("button", { class: "small", onclick: () => action("reopen") }, "조사 다시 열기") : null];
    const resultPane = data.results_available ? [
      h("p", { style: "text-align:right;margin:0 0 10px" },
        h("a", { class: "button small", href: `/api/courses/${c.id}/satisfaction/export.xlsx` }, "⬇ 엑셀 다운로드")),
      h("div", { class: "table-wrap" }, h("table", { class: "att satisfaction-table" },
        h("thead", {}, h("tr", {}, h("th", { rowspan: 2 }, "영역"), h("th", { rowspan: 2 }, "설문 내용"),
          h("th", { rowspan: 2 }, "평균"), scale.map(([n]) => h("th", {}, n))),
          h("tr", {}, scale.map(([, label]) => h("th", {}, label)))),
        h("tbody", {}, resultsRows))),
      data.results_available && data.narrative_prompt ? h("div", {},
        h("h4", { style: "margin:20px 0 6px" }, "서술 의견"),
        h("p", { class: "muted" }, data.narrative_prompt),
        data.comments?.length ? h("ul", {}, data.comments.map((comment) => h("li", { style: "white-space:pre-wrap;margin-bottom:8px" }, comment)))
          : h("p", { class: "muted" }, "작성된 서술 의견이 없어요.")) : null]
      : [h("p", { class: "muted" }, data.closed ? "아직 제출된 응답이 없어요." : "조사를 마감하면 결과를 볼 수 있어요.")];
    fill(box, h("div", { class: "satisfaction-status" }, status), tabs,
      selected === "questions" ? questionPane : resultPane);
  } catch (err) { fill(box, h("p", { class: "error" }, err.message)); }
}

function courseEditForm(c) {
  const box = h("div", { class: "edit-box" }, h("p", { class: "muted" }, "불러오는 중…"));
  courseForm(c, (saved) => {
    editing.delete(c.id);
    if (saved) toast("강좌 정보를 고쳤어요.");
    loadTeacherCourses();
  }).then((form) => fill(box, form)).catch((err) => fill(box, h("p", { class: "error" }, err.message)));
  return box;
}

/* 공지사항: 이 강좌 수강생에게. 게시판(연번·제목·작성자·작성일) → 누르면 글 보기, [공지 쓰기]·[수정]은 글쓰기 화면 */
const noticeView = new Map(); // 강좌 id → { read: 공지 id } | { write: 공지 id 또는 null }
async function renderCourseNotices(c, box) {
  const { notices } = await api(`/api/courses/${c.id}/notices`);
  const again = () => renderCourseNotices(c, box);
  const go = (v) => { if (v) noticeView.set(c.id, v); else noticeView.delete(c.id); again(); };
  const v = noticeView.get(c.id) || {};
  const day = (d) => (d ? fmtDate(d) : "-");

  if ("write" in v) {
    const cur = notices.find((n) => n.id === v.write) || null;
    const title = h("input", { maxlength: 120, value: cur ? cur.title : "", placeholder: "제목 (예: 다음 주 수업은 줌 대신 외솔온닷에서 해요)" });
    const body = h("textarea", { rows: 8, maxlength: 10000, placeholder: "내용" });
    body.value = cur ? cur.body || "" : "";
    const submit = h("button", { class: "primary", type: "button" }, cur ? "수정 저장" : "공지 올리기");
    submit.onclick = async () => {
      if (!title.value.trim()) { title.focus(); return; }
      submit.disabled = true;
      try {
        const r = await api(`/api/courses/${c.id}/notices`, { id: cur ? cur.id : null, title: title.value, body: body.value });
        toast(cur ? "공지를 고쳤어요." : "공지를 올렸어요. 수강생 마이페이지에 보여요.");
        go(cur ? { read: cur.id } : (r && r.id ? { read: r.id } : null));
      } catch (err) { toast(err.message); submit.disabled = false; }
    };
    fill(box,
      h("div", { class: "row", style: "margin-bottom:10px" },
        h("button", { class: "small", onclick: () => go(cur ? { read: cur.id } : null) }, cur ? "← 공지 보기" : "← 공지 목록"),
        h("h3", { class: "grow", style: "margin:0" }, cur ? "공지 수정" : "공지 쓰기")),
      h("div", { class: "course-form" }, h("label", { class: "wide" }, "제목", title), h("label", { class: "wide" }, "내용", body),
        h("div", { class: "row wide" }, submit,
          h("span", { class: "muted", style: "font-size:0.85rem" }, `수강 확정 학생 ${c.approved}명에게 보여요.`))));
    title.focus();
    return;
  }

  const n = notices.find((x) => x.id === v.read);
  if (n) {
    const no = notices.length - notices.indexOf(n);
    fill(box,
      h("div", { class: "row", style: "margin-bottom:10px" },
        h("button", { class: "small", onclick: () => go(null) }, "← 공지 목록"),
        h("span", { class: "grow" }),
        h("button", { class: "small", onclick: () => go({ write: n.id }) }, "수정"),
        h("button", { class: "small danger", onclick: async () => {
          if (!await appConfirm(`'${n.title}' 공지를 지울까요?`)) return;
          await api(`/api/courses/${c.id}/notices/${n.id}/delete`, {});
          go(null);
        } }, "삭제")),
      h("div", { class: "assign-post notice-post" },
        h("h3", { style: "margin:0 0 6px" }, n.title),
        h("p", { class: "muted", style: "margin:0 0 10px;font-size:0.88rem" }, `${no}번 · 작성자 ${n.author || "-"} · 작성일 ${day(n.date)}`),
        h("div", { class: "notice-body" }, n.body || "(내용 없음)")));
    return;
  }

  const rows = notices.map((x, i) => h("tr", { class: "assign-row", onclick: () => go({ read: x.id }) },
    h("td", { class: "num" }, notices.length - i),
    h("td", {}, h("span", { class: "day-link" }, x.title)),
    h("td", { class: "num" }, x.author || "-"),
    h("td", { class: "num" }, day(x.date))));
  fill(box,
    h("div", { class: "row", style: "margin-bottom:8px" },
      h("span", { class: "grow muted", style: "font-size:0.88rem" }, `공지 ${notices.length}건`),
      h("button", { class: "primary", onclick: () => go({ write: null }) }, "공지 쓰기")),
    h("div", { class: "table-wrap" }, h("table", { class: "att assign-board notice-board" },
      h("thead", {}, h("tr", {}, ["연번", "제목", "작성자", "작성일"].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: 4, class: "muted", style: "text-align:center;padding:18px" }, "아직 올린 공지가 없어요."))))));
}

/* 수업 열기: 열린 수업이 있으면 들어가기, 없으면 회차 이름으로 바로 열기 */
const openPick = {}; // 과목별로 펼친 회차 번호

async function renderOpenClass(c, box) {
  const { classes } = await api("/api/live/my-classes");
  const open = classes.filter((x) => x.course_id === c.id);
  const t = today();
  const sessions = c.sessions || [];
  const next = sessions.find((s) => s.date >= t);
  const notYet = c.pending || 0;
  if (c.approval !== "approved") {
    fill(box, approvalNote(c));
    return;
  }
  // 회차 외 보강·특강에서 고를 성취기준 (과목 정보에 넣은 것)
  let standards = [];
  try { ({ standards } = await api(`/api/courses/${c.id}/standards`)); } catch { /* 성취기준 없이도 연다 */ }
  const start = async (title, standardIds = [], session = null) => {
    if (notYet && !await appConfirm(`아직 수강 확정이 안 된 학생이 ${notYet}명 있어요. 이 학생들은 들어올 수 없어요. '수강생 관리'에서 먼저 승인하는 게 좋아요.\n\n그래도 지금 수업을 열까요?`)) return;
    try {
      const res = await api("/api/live/classes", { title: title || c.title, course_id: c.id,
        ...(session ? { session_no: session.no, session_topic: session.topic } : {}) });
      if (standardIds.length) {  // 보강·특강에서 고른 성취기준 (AI 분석은 회차보다 이것을 먼저 쓴다)
        await api(`/api/courses/${c.id}/classes/${res.class_id}/standards`, { standard_ids: standardIds }).catch(() => {});
      }
      location.href = `/live/teacher/${res.code}`;
    } catch (err) { toast(err.message); }
  };
  // 회차표가 없으면 주제만 적고 바로 연다
  const plain = () => {
    const name = h("input", { maxlength: 60, placeholder: "수업 주제 (예: 3차시 헌법과 기본권)" });
    const picks = standards.map((s, i) => h("label", { class: "std-pick", title: s.text }, h("input", { type: "checkbox", "data-id": s.id }), s.code || `성취기준 ${i + 1}`));
    const chosen = () => picks.map((p) => p.querySelector("input")).filter((x) => x.checked).map((x) => Number(x.dataset.id));
    return h("div", {},
      h("div", { class: "open-box" }, h("label", { class: "grow" }, "수업 주제", name),
        h("button", { class: "primary big", onclick: () => start(name.value.trim(), chosen()) }, "▶ 지금 열기")),
      picks.length ? h("div", { class: "open-std" },
        h("div", { class: "muted", style: "font-size:0.85rem;margin:8px 0 4px" }, "이 수업에서 다루는 성취기준 (선택 — 고르지 않으면 같은 날 회차, 없으면 모든 성취기준으로 분석해요)"),
        h("div", { class: "std-pick-grid" }, ...picks)) : null);
  };
  // 회차표: 늘 펼쳐 두고, 회차를 누르면 그 줄의 '주제' 칸이 입력 칸(원래 주제가 적힌 채)으로 바뀌고 옆에 [지금 열기]
  const table = () => h("table", { class: "sess-table view sess-open" },
    h("tr", {}, ["회차", "날짜", "시간", "주제"].map((x) => h("th", {}, x))),
    sessions.map((s) => {
      const picked = openPick[c.id] === s.no;
      const toggle = () => { openPick[c.id] = picked ? null : s.no; renderOpenClass(c, box); };
      let topicCell;
      if (picked) {
        const topic = h("input", { maxlength: 50, value: s.topic || "", placeholder: "수업 주제 (예: 헌법과 기본권)" });
        const go = () => start("", [], { no: s.no, topic: topic.value.trim() });
        topic.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); go(); }
          if (e.key === "Escape") toggle();
        });
        setTimeout(() => { topic.focus(); topic.setSelectionRange(topic.value.length, topic.value.length); }, 0); // 원래 주제 그대로, 커서는 끝에
        topicCell = h("td", { class: "sess-topic-edit" },
          h("div", { class: "row", style: "gap:6px;flex-wrap:nowrap" }, topic,
            h("button", { class: "primary small", type: "button", onclick: go }, "▶ 지금 열기"),
            h("button", { class: "small", type: "button", title: "취소", onclick: toggle }, "✕")));
      } else topicCell = h("td", {}, s.topic);
      return h("tr", { class: `${picked ? "on" : "pickable"} ${next && next.no === s.no ? "next" : ""}`,
        onclick: picked ? null : toggle, title: picked ? "" : "누르면 이 회차 수업을 열 수 있어요" },
        h("td", {}, s.no),
        h("td", {}, h("button", { type: "button", class: "link-btn", onclick: (e) => { e.stopPropagation(); toggle(); } },
          `${fmtDate(s.date)} (${DAYS[dayOf(s.date)]})`), s.date === t ? h("span", { class: "tag" }, "오늘") : null),
        h("td", {}, s.start ? `${s.start}~${s.end}` : ""), topicCell);
    }));
  fill(box,
    open.length ? h("div", { class: "banner ok" }, h("strong", {}, "진행 중인 수업"), ...open.map((x) =>
      h("a", { class: "button small primary", href: `/live/teacher/${x.code}` }, `▶ ${x.title} 들어가기`))) : null,
    notYet ? h("p", { class: "muted", style: "font-size:0.9rem" }, `⚠️ 승인 대기 ${notYet}명은 아직 못 들어와요.`) : null,
    c.archived ? h("p", { class: "muted" }, "종료한 강좌에는 수업을 열 수 없어요. '종료 해제'를 먼저 눌러 주세요.")
      : sessions.length ? [h("h3", { class: "open-title" }, "📅 회차별 수업"), table(),
        // 회차표에 없는 날(보강·추가 수업)도 주제만 적고 바로 열 수 있게
        h("h3", { class: "open-title", style: "margin-top:22px" }, "➕ 회차 외 보강·특강"),
        plain()] : plain()); // 회차표가 없는 과목은 제목 없이 주제만 적고 열기
}

/* ───── 학습 관리: 위에 [수업참석률][설문][퀴즈][스크립트][학생 맞춤형 피드백] 요약, 누르면 수업별 목록 → 수업을 누르면 학생별 내역 ───── */

const learnState = {}; // 과목별: { card, open: Set(펼친 수업) }
const ACT_LABEL = { survey: "설문", quiz: "퀴즈", activity: "평가" };
const ACT_KINDS = { survey: ["poll"], quiz: ["ox", "choice", "text"] }; // '평가'는 수행평가(과제) 제출

async function renderLearning(c, box) {
  const st = learnState[c.id] ||= { card: "attend", open: new Set() };
  if (["notice", "activity", "speech"].includes(st.card)) st.card = "attend"; // 없앤 카드
  let d;
  try { d = await api(`/api/courses/${c.id}/learning`); } catch (err) { fill(box, h("p", { class: "error" }, err.message)); return; }
  d.classes.reverse(); // 첫 수업(연번 1)부터 차례로
  const S = d.summary;
  const pct = (v) => (v == null ? "-" : `${v}%`);
  const cards = [
    ["attend", "🙋 수업참석률", pct(S.attendance), `수업 ${S.classes}회 · 수강생 ${S.enrolled}명`],
    ["survey", "📊 설문", `${S.survey.count}회`, `응답률 ${pct(S.survey.rate)} · ${S.survey.classes}개 수업`],
    ["quiz", "✅ 퀴즈", `${S.quiz.count}회`, `응답률 ${pct(S.quiz.rate)} · ${S.quiz.classes}개 수업`],
    ["script", "🗒 스크립트", `${S.speech?.classes || 0}회`, `기록한 수업 · 발언 ${S.speech?.count || 0}건`],
    ["speakers", "🧑‍🎓 학생 맞춤형 피드백", `${S.speech?.students || 0}명`, `학생 발언 ${S.speech?.student_count || 0}건`],
    ["classfb", "📝 수업별 피드백", `${S.classes}회`, "수업마다 학생 피드백"],
  ];
  const detail = h("div", { class: "learn-detail" });
  fill(box,
    h("div", { class: "learn-cards" }, cards.map(([k, label, big, small]) => h("button", { type: "button", class: `learn-card ${st.card === k ? "on" : ""}`,
      onclick: () => { st.card = k; st.open.clear(); st.view = null; renderLearning(c, box); } },
      h("span", { class: "lc-label" }, label), h("strong", { class: "lc-big" }, big), h("span", { class: "lc-small" }, small)))),
    detail);
  if (st.card === "classfb") { renderClassFeedback(c, detail); return; }
  if (st.card === "script" || st.card === "speakers") { st.speechTab = st.card === "script" ? "class" : "student"; learnSpeech(c, st, detail); return; }
  if (!d.classes.length && st.card !== "notice") { fill(detail, h("p", { class: "muted" }, "아직 연 수업이 없어요. '수업 열기'에서 수업을 열면 여기에 쌓여요.")); return; }
  if (st.card === "attend") learnAttendance(d, st, detail);
  else if (st.card === "notice") learnNotices(d, detail);
  else learnActivities(d, st, st.card, detail);
}

/* ───── 학습 관리 > 💬 발언 기록: 수업별 스크립트 · 학생별 발언과 워드클라우드 · 엑셀 ─────
   수업 화면에서 [📝 발언 기록]을 켠 동안의 발언만 쌓인다 (과목이 끝나고 1년 뒤 삭제) */
async function learnSpeech(c, st, box) {
  st.speechTab ||= "class";
  let d;
  try { d = await api(`/api/courses/${c.id}/speech`); } catch (err) { fill(box, h("p", { class: "error" }, err.message)); return; }
  const again = () => learnSpeech(c, st, box);
  const head = h("div", { class: "row", style: "margin:4px 0 10px" },
    h("h3", { class: "grow", style: "margin:0" }, st.speechTab === "class" ? "🗒 수업별 스크립트" : "🧑‍🎓 학생 맞춤형 피드백"),
    d.total ? h("a", { class: "button small", href: `/api/courses/${c.id}/speech.xlsx` }, "📥 엑셀 내려받기") : null);
  if (!d.total && !(st.speechTab === "student" && d.students.length)) {
    fill(box, head, h("p", { class: "muted" }, "아직 발언 기록이 없어요. 수업 화면 위쪽의 [📝 발언 기록]을 켜면, 마이크를 켠 학생과 선생님의 말이 글자로 바뀌어 여기에 쌓여요. (크롬·엣지 사용자만 기록돼요)"));
    return;
  }
  const empty = (n, text) => h("tr", {}, h("td", { colspan: n, class: "muted", style: "text-align:center;padding:18px" }, text));
  if (st.speechTab === "class") {
    const viewing = d.classes.find((x) => x.id === st.view);
    if (viewing) {
      const list = h("div", { class: "speech-script" }, h("p", { class: "muted" }, "불러오는 중…"));
      fill(box, head,
        h("div", { class: "row", style: "margin:0 0 8px" }, h("button", { class: "small", onclick: () => { st.view = null; again(); } }, "← 수업 목록")),
        h("div", { class: "hub-grid-summary" }, `${fmtDate(viewing.date)} · ${viewing.title || "(주제 없음)"} · 발언 ${viewing.count}건 · 발언한 학생 ${viewing.speakers}명`),
        list);
      const { entries } = await api(`/api/courses/${c.id}/speech/class/${viewing.id}`);
      fill(list, ...entries.map((e) => h("div", { class: `speech-line ${e.role}` },
        h("span", { class: "sp-time" }, e.time.slice(0, 5)),
        h("span", { class: "sp-who" }, e.role === "teacher" ? "👩‍🏫 선생님" : [e.student_no, e.name].filter(Boolean).join(" ")),
        spKind(e), h("span", { class: "sp-text" }, e.text))));
      return;
    }
    fill(box, head, h("div", { class: "table-wrap" }, h("table", { class: "att assign-board speech-board speech-classes" },
      h("thead", {}, h("tr", {}, ["연번", "수업일", "수업 주제", "발언 수", "발언한 학생"].map((t) => h("th", {}, t)))),
      h("tbody", {}, d.classes.length ? d.classes.map((x, i) => h("tr", { class: "assign-row", onclick: () => { st.view = x.id; again(); } },
        h("td", { class: "num" }, i + 1), h("td", { class: "num" }, fmtDate(x.date)),
        h("td", {}, h("span", { class: "day-link" }, x.title || "(주제 없음)")),
        h("td", { class: "num" }, `${x.count}건`), h("td", { class: "num" }, `${x.speakers}명`))) : empty(5, "기록이 없어요.")))));
    return;
  }
  const who = d.students.find((x) => x.user_id === st.view);
  if (who) {
    // 학생 한 명: 성취 분석 / 교사 관찰 기록 / 학생 발언 기록을 각각 보여 준다
    st.studentTab ||= "analysis";
    const tabs = h("nav", { class: "tabs sub-tabs", style: "margin:4px 0 10px" },
      [["analysis", "📊 성취 분석"], ["observations", "👀 교사 관찰 기록"], ["speech", "🗒 학생 발언 기록"]].map(([k, label]) =>
        h("button", { type: "button", class: st.studentTab === k ? "active" : "", onclick: () => { st.studentTab = k; again(); } }, label)));
    const pane = h("div");
    fill(box, head,
      h("div", { class: "row", style: "margin:0 0 8px" }, h("button", { class: "small", onclick: () => { st.view = null; again(); } }, "← 학생 목록")),
      h("div", { class: "hub-grid-summary" }, `${[who.school, who.student_no, who.name].filter(Boolean).join(" ")} · 발언 ${who.count}건 · ${who.chars.toLocaleString()}자 · ${who.classes}개 수업`),
      tabs, pane);
    if (st.studentTab === "analysis") {
      const anal = h("div", { class: "ach-wrap" }, h("p", { class: "muted" }, "AI 분석을 불러오는 중…"));
      fill(pane, anal);
      renderAnalysis(c.id, who, anal, { obs: false }); // AI 성취 분석·그래프·피드백 (achievement.js)
      return;
    }
    if (st.studentTab === "observations") {
      try {
        const { observations: obs } = await api(`/api/courses/${c.id}/speech/student/${who.user_id}/observations`);
        fill(pane,
          h("h4", { class: "speech-h" }, `👀 교사 관찰 기록 ${obs.length}건`),
          obs.length ? h("div", { class: "speech-day" }, ...obs.map((o) => h("div", { class: "speech-line student" },
            h("span", { class: "sp-time" }, `${fmtDate(o.date).slice(5)} ${o.time}`),
            h("span", { class: "sp-text" }, o.text, h("span", { class: "muted" }, ` · ${o.class_title}`)))))
            : h("p", { class: "muted" }, "아직 관찰 기록이 없어요. 수업 화면 오른쪽 [관찰기록] 탭에서 남길 수 있어요."));
      } catch (err) { fill(pane, h("p", { class: "error" }, err.message)); }
      return;
    }
    // 학생 발언 기록: 워드클라우드를 맨 위에 두고 수업 날짜별 발언을 보여 준다
    let entries;
    try { ({ entries } = await api(`/api/courses/${c.id}/speech/student/${who.user_id}`)); }
    catch (err) { fill(pane, h("p", { class: "error" }, err.message)); return; }
    const days = [];
    for (const e of entries) {
      let g = days[days.length - 1];
      if (!g || g.class_id !== e.class_id) days.push(g = { class_id: e.class_id, date: e.date, title: e.class_title, items: [] });
      g.items.push(e);
    }
    const cloud = h("div", { class: "word-cloud" });
    fill(pane,
      h("h4", { class: "speech-h", style: "margin-top:4px" }, "☁️ 워드클라우드 (많이 쓴 낱말)"), cloud,
      h("h4", { class: "speech-h" }, `🗒 학생 발언 기록 ${entries.length}건 (날짜순)`),
      days.length ? days.map((g) => h("div", { class: "speech-day" },
        h("div", { class: "speech-day-head" }, `${fmtDate(g.date)} · ${g.title || "(주제 없음)"}`, h("span", { class: "muted" }, ` ${g.items.length}건`)),
        ...g.items.map((e) => h("div", { class: "speech-line student" }, h("span", { class: "sp-time" }, e.time.slice(0, 5)), spKind(e), h("span", { class: "sp-text" }, e.text)))))
        : h("p", { class: "muted" }, "발언 기록이 없어요."));
    drawWordCloud(cloud, entries.map((e) => e.text));
    return;
  }
  fill(box, head, h("div", { class: "table-wrap" }, h("table", { class: "att assign-board speech-board speech-students speech-feedback-students" },
    h("thead", {}, h("tr", {}, ["연번", "소속학교", "학번", "이름", "발언 수", "글자 수", "발언한 수업", "교사 관찰 기록"].map((t) => h("th", {}, t)))),
    h("tbody", {}, d.students.length ? d.students.map((x, i) => h("tr", { class: "assign-row", onclick: () => { st.view = x.user_id; st.studentTab = "analysis"; again(); } },
      h("td", { class: "num" }, i + 1), h("td", { class: "num" }, x.school || "-"), h("td", { class: "num" }, x.student_no || "-"),
      h("td", { class: "num" }, h("span", { class: "day-link" }, x.name || "-")),
      h("td", { class: "num" }, `${x.count}건`), h("td", { class: "num" }, `${x.chars.toLocaleString()}자`), h("td", { class: "num" }, `${x.classes}회`),
      h("td", { class: "num" }, x.observations || 0)))
      : empty(8, "수강 확정 학생이 없어요.")))));
}

/* 워드클라우드: 조사·어미를 대강 떼어 낸 낱말의 빈도로 글자 크기를 정한다 */
const WC_STOP = new Set(("그리고 그래서 그런데 하지만 그냥 진짜 너무 정말 이제 저는 제가 저희 우리 그거 이거 저거 그것 이것 저것 거기 여기 " +
  "근데 약간 그러면 그럼 이렇게 그렇게 저렇게 어떻게 무슨 어떤 그런 이런 저런 같은 있는 없는 하는 되는 했던 하면 해서 " +
  "그게 이게 저게 뭔가 혹시 아니 맞아 네네 아니요 그니까 그러니까 일단 때문 때문에 정도 지금 오늘 선생님 다시 많이 조금 " +
  "있어요 없어요 같아요 생각 합니다 있습니다 했습니다 입니다 그래요 아마 또는 대해 대한 통해 위해 하지 있어 없어 있을 없을 " +
  "싶어 싶습 싶다 싶은 되고 되어 보고 해보 하게 되게 있습 없습 따라 있다 없다 같다 하다 되다 됐다 했다 거예요 건데 거죠 해야 그렇 그런가 아닌가 아니라 아니고 맞는 그때 다른 모든 각각").split(" "));
const WC_TAILS = ["에서는", "으로는", "에게서", "이라고", "이라는", "라고", "라는", "에서", "에게", "한테", "으로", "까지", "부터", "처럼", "보다",
  "이랑", "이나", "이고", "이요", "은", "는", "이", "가", "을", "를", "의", "에", "도", "로", "와", "과", "만", "랑", "요"];
const WC_ENDS = ["했습니다", "합니다", "입니다", "했어요", "해요", "이에요", "예요", "였어요", "있어요", "있습니다", "같아요", "거든요", "잖아요",
  "하는데", "한다고", "했는데", "해야", "하면", "해서", "하고", "하는", "한다", "했다", "되는", "된다", "됩니다", "돼요", "니다", "어요", "아요",
  "되면", "될", "할", "된", "한", "적인", "적으로", "해"];

function wordFreq(texts) {
  const freq = new Map();
  for (const t of texts) {
    for (let w of t.toLowerCase().split(/[^0-9a-z가-힣]+/)) {
      if (!w) continue;
      for (const e of WC_ENDS) if (w.length - e.length >= 2 && w.endsWith(e)) { w = w.slice(0, -e.length); break; }
      for (const e of WC_TAILS) if (w.length - e.length >= 2 && w.endsWith(e)) { w = w.slice(0, -e.length); break; }
      if (w.length < 2 || WC_STOP.has(w) || /^\d+$/.test(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 45);
}

function drawWordCloud(box, texts) {
  const words = wordFreq(texts);
  if (!words.length) { fill(box, h("span", { class: "muted" }, "낱말이 아직 충분하지 않아요.")); return; }
  const max = words[0][1], min = words[words.length - 1][1];
  const colors = ["#1b6b4a", "#e8663d", "#2f7fb5", "#8a5cc2", "#c79a1e", "#3c9a6e", "#d0485f"];
  // 큰 낱말이 가운데 오도록: 빈도순으로 가운데에서 양쪽으로 번갈아 놓는다
  const order = [];
  words.forEach((w, i) => (i % 2 ? order.push(w) : order.unshift(w)));
  fill(box, ...order.map(([w, n], i) => {
    const r = max === min ? 0.5 : Math.sqrt((n - min) / (max - min));
    return h("span", { class: "wc-word", title: `${w} · ${n}번`,
      style: `font-size:${Math.round(14 + r * 34)}px;color:${colors[i % colors.length]};font-weight:${r > 0.5 ? 800 : 600}` }, w);
  }));
}

/** 펼침 줄: 버튼을 누르면 표 아래에 내용을 그린다 */
function toggleRow(st, id, draw) {
  if (st.open.has(id)) st.open.delete(id); else st.open.add(id);
  draw();
}

function learnAttendance(d, st, box) {
  const viewing = d.classes.find((x) => x.id === st.view);
  if (viewing) { // 게시물 화면: 그 수업의 학생별 출결
    const x = viewing;
    const list = h("div");
    fill(box,
      h("div", { class: "row", style: "margin:4px 0 8px" },
        h("button", { class: "small", onclick: () => { st.view = null; learnAttendance(d, st, box); } }, "← 수업 목록")),
      h("div", { class: "hub-grid-summary" }, `${fmtDate(x.date)} ${x.start} ~ ${x.end || (x.live ? "진행 중" : "")} · 참여 ${x.attended}명${d.summary.enrolled ? ` / ${d.summary.enrolled}명` : ""}${x.rate == null ? "" : ` · 출석률 ${x.rate}%`}`),
      list);
    attendanceOf(x.id, list);
    return;
  }
  const draw = () => fill(box,
    h("h3", { class: "section-title", style: "margin:4px 0 8px" }, `🙋 수업별 출석 (수강생 ${d.summary.enrolled}명)`),
    h("div", { class: "table-wrap" }, h("table", { class: "att log-table" },
      h("thead", {}, h("tr", {}, ["연번", "날짜", "시각", "수업 주제", "참여 학생", "출석률", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, d.classes.map((x, i) => {
        const row = h("tr", {},
          h("td", { class: "num" }, i + 1), h("td", {}, fmtDate(x.date)),
          h("td", {}, `${x.start} ~ ${x.end || (x.live ? "진행 중" : "")}`), h("td", {}, x.title),
          h("td", { class: "num" }, `${x.attended}명${d.summary.enrolled ? ` / ${d.summary.enrolled}명` : ""}`),
          h("td", { class: "num" }, h("strong", {}, x.rate == null ? "-" : `${x.rate}%`)),
          h("td", {}, h("button", { class: "small", onclick: () => { st.view = x.id; learnAttendance(d, st, box); } }, "출결 확인")));
        return row;
      })))));
  draw();
}

/** 한 수업의 학생별 출결: 소속학교 · 학번 · 이름 · 수업참여시간 · 접속시각 · 종료시각 · 청취 시간 */
async function attendanceOf(classId, box) {
  fill(box, h("span", { class: "muted" }, "불러오는 중…"));
  const r = await api(`/api/live/history/${classId}`);
  const min = (m) => (m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`);
  const rows = [
    ...r.students.map((p) => h("tr", {},
      h("td", {}, p.school || "-"), h("td", {}, p.student_no || "-"), h("td", {}, p.name),
      h("td", { class: "num" }, min(p.minutes + p.away_minutes)),
      h("td", {}, p.first_join_text), h("td", {}, p.online ? h("strong", { class: "ok-text" }, "접속 중") : p.last_leave_text),
      h("td", { class: "num" }, min(p.minutes)))),
    ...r.absent.map((a) => h("tr", { class: "absent" },
      h("td", {}, a.school || "-"), h("td", {}, a.student_no || "-"), h("td", {}, a.name), h("td", { colspan: 4 }, "미접속"))),
  ];
  fill(box,
    h("div", { class: "row", style: "margin-bottom:6px" }, h("strong", { class: "grow" }, `${r.class.title} 출결`),
      h("a", { class: "button small", href: `/api/live/history/${classId}/attendance.csv` }, "📥 출결 CSV")),
    h("table", { class: "att inner-table" },
      h("thead", {}, h("tr", {}, ["소속학교", "학번", "이름", "수업참여시간", "접속시각", "종료시각", "청취 시간"].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: 7, class: "muted" }, "들어온 학생이 없어요.")))),
    h("p", { class: "muted", style: "font-size:0.8rem;margin:4px 0 0" }, "수업참여시간: 처음 들어온 때부터 마지막으로 나간 때까지 · 청취 시간: 그중 실제로 접속해 있던 시간"));
}

function learnNotices(d, box) {
  const inClass = d.classes.flatMap((x) => x.notices.map((n) => ({ ...n, cls: x })));
  fill(box,
    h("h3", { class: "section-title", style: "margin:4px 0 8px" }, `📢 수업 중 공지 ${inClass.length}회`),
    inClass.length ? h("div", { class: "table-wrap" }, h("table", { class: "att log-table" },
      h("thead", {}, h("tr", {}, ["연번", "날짜", "시각", "수업 주제", "공지 내용"].map((t) => h("th", {}, t)))),
      h("tbody", {}, inClass.map((x, i) => h("tr", {},
        h("td", { class: "num" }, i + 1), h("td", {}, fmtDate(x.cls.date)), h("td", {}, x.time),
        h("td", {}, x.cls.title), h("td", { style: "white-space:normal;text-align:left" }, x.text))))))
      : h("p", { class: "muted" }, "수업 중에 띄운 공지가 없어요. (수업 화면의 '📢 공지'로 띄운 것이 여기에 남아요)"),
    h("h3", { class: "section-title", style: "margin:20px 0 8px" }, `📌 과목 공지사항 ${d.course_notices.length}건`),
    d.course_notices.length ? h("div", { class: "course-notices" }, d.course_notices.map((n) => h("details", { class: "box" },
      h("summary", {}, h("strong", {}, n.title), h("span", { class: "muted", style: "font-size:0.85rem" }, ` · ${fmtDate(n.date)}`)),
      h("p", { style: "white-space:pre-wrap;margin:8px 0" }, n.body || ""))))
      : h("p", { class: "muted" }, "'공지사항' 칸에서 올린 공지가 없어요."));
}

/** 활동 = 수행평가(과제): 낸 과제마다 제출·채점 현황, 펼치면 학생별 제출 내역 */
function learnAssignments(c, d, st, box) {
  const list = d.assignments;
  const n = d.summary.enrolled;
  const COLS = 8;
  const draw = () => fill(box,
    h("div", { class: "row", style: "margin:4px 0 8px" }, h("h3", { class: "section-title grow", style: "margin:0" }, `✍️ 수행평가 ${list.length}개`),
      h("button", { class: "small", onclick: () => { runSub = "assess"; renderRun(); } }, "📝 수행평가에서 과제 내기·채점")),
    list.length ? h("div", { class: "table-wrap" }, h("table", { class: "att log-table" },
      h("thead", {}, h("tr", {}, ["연번", "낸 날", "과제", "마감", "제출", "제출률", "채점", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, list.flatMap((a, i) => {
        const key = `a${a.id}`;
        const open = st.open.has(key);
        const sub = h("td", { colspan: COLS });
        const row = h("tr", { class: open ? "on" : "" },
          h("td", { class: "num" }, i + 1), h("td", {}, fmtDate(a.date)), h("td", { style: "white-space:normal;text-align:left" }, a.title),
          h("td", {}, a.due ? a.due.replaceAll("-", ".") : "없음"),
          h("td", { class: "num" }, `${a.submitted}명${n ? ` / ${n}명` : ""}`),
          h("td", { class: "num" }, h("strong", {}, n ? `${Math.round((a.submitted / n) * 100)}%` : "-")),
          h("td", { class: "num" }, `${a.graded}명`),
          h("td", {}, h("button", { class: `small ${open ? "on" : ""}`, onclick: () => toggleRow(st, key, draw) }, open ? "접기" : "제출 내역")));
        if (open) submissionsOf(a.id, sub);
        return open ? [row, h("tr", { class: "detail-row" }, sub)] : [row];
      })))) : h("p", { class: "muted" }, "아직 낸 과제가 없어요. '수행평가'에서 과제를 내면 학생들의 제출 현황이 여기에 쌓여요."));
  draw();
}

/** 한 과제의 학생별 제출 내역 */
async function submissionsOf(aid, box) {
  fill(box, h("span", { class: "muted" }, "불러오는 중…"));
  const { submissions } = await api(`/api/assignments/${aid}/submissions`);
  const fmt = (v) => (v == null ? "-" : `${Math.round(v * 100) / 100}점`);
  fill(box, h("table", { class: "att inner-table" },
    h("thead", {}, h("tr", {}, ["소속학교", "학번", "이름", "제출", "제출 시각", "점수", "피드백"].map((t) => h("th", {}, t)))),
    h("tbody", {}, submissions.length ? submissions.map((x) => h("tr", { class: x.submitted ? "" : "absent" },
      h("td", {}, x.school || "-"), h("td", {}, x.student_no || "-"), h("td", {}, x.name),
      h("td", {}, x.submitted ? (x.late ? "지각 제출" : "제출") : "미제출"),
      h("td", {}, x.submitted_at || "-"), h("td", { class: "num" }, x.graded ? fmt(x.score) : x.submitted ? "미채점" : "-"),
      h("td", { style: "white-space:normal;text-align:left" }, x.feedback || "-")))
      : h("tr", {}, h("td", { colspan: 7, class: "muted" }, "수강생이 없어요.")))));
}

function learnActivities(d, st, key, box) {
  const label = ACT_LABEL[key];
  const list = d.classes.filter((x) => x.acts[key].count);
  const rate = (x) => (x.possible ? `${Math.round((x.answered / x.possible) * 100)}%` : "-");
  const go = (id) => { st.view = id; learnActivities(d, st, key, box); };
  // 게시물 화면: 수업 하나의 문제별 응답 (아래로 펼치지 않고 따로 연다)
  const i = list.findIndex((x) => x.id === st.view);
  if (i >= 0) {
    const x = list[i];
    const sub = h("div");
    fill(box,
      h("div", { class: "row", style: "margin:4px 0 8px" }, h("button", { class: "small", onclick: () => go(null) }, "← 수업 목록")),
      h("div", { class: "hub-grid-summary" }, `${i + 1}번 · ${fmtDate(x.date)} ${x.start} · ${x.title} · ${label} ${x.acts[key].count}개 · 응답률 ${rate(x.acts[key])}`),
      sub);
    activitiesOf(x.id, key, sub);
    return;
  }
  fill(box,
    h("h3", { class: "section-title", style: "margin:4px 0 8px" }, `${label}${key === "quiz" ? "를" : "을"} 한 수업 ${list.length}개`),
    list.length ? h("div", { class: "table-wrap" }, h("table", { class: "att log-table" },
      h("thead", {}, h("tr", {}, ["연번", "날짜", "시각", "수업 주제", `${label} 수`, "응답률", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, list.map((x, n) => h("tr", { class: "assign-row", onclick: () => go(x.id) },
        h("td", { class: "num" }, n + 1), h("td", {}, fmtDate(x.date)), h("td", {}, x.start),
        h("td", {}, h("span", { class: "day-link" }, x.title)), h("td", { class: "num" }, `${x.acts[key].count}개`),
        h("td", { class: "num" }, h("strong", {}, rate(x.acts[key]))),
        h("td", {}, h("button", { class: "small", onclick: (e) => { e.stopPropagation(); go(x.id); } }, "내역 보기")))))))
      : h("p", { class: "muted" }, `아직 ${label}${key === "quiz" ? "를" : "을"} 한 수업이 없어요. 수업 화면의 '📊 설문/퀴즈'에서 낼 수 있어요.`));
}

/** 한 수업에서 낸 설문·퀴즈·활동: 문제와 학생별 답 (채점은 '채점·피드백'에서) */
async function activitiesOf(classId, key, box) {
  fill(box, h("span", { class: "muted" }, "불러오는 중…"));
  const book = await api(`/api/live/history/${classId}/grades`);
  const acts = book.activities.filter((a) => ACT_KINDS[key].includes(a.kind));
  const fmt = (n) => (n == null ? "-" : `${Math.round(n * 100) / 100}`);
  const full = h("div");
  fill(box,
    ...acts.map((a) => {
      const answered = a.rows.filter((r) => r.answered);
      const tally = a.options?.length ? a.options.map((o, i) => [o, answered.filter((r) => r.answer === o).length]) : [];
      return h("div", { class: "box", style: "margin-bottom:10px" },
        h("div", { class: "row" }, h("strong", { class: "grow" }, `${a.no}. [${a.kind_name}] ${a.prompt}`),
          h("span", { class: "muted" }, `응답 ${answered.length}/${a.rows.length}명`)),
        a.correct_answer ? h("div", { class: "muted", style: "font-size:0.85rem" }, `정답: ${a.correct_answer} · 배점 ${a.points}점`) : null,
        tally.length ? h("div", { class: "tally" }, tally.map(([o, n]) => h("div", { class: "tally-row" },
          h("span", { class: "tally-label" }, o), h("span", { class: "tally-bar" }, h("i", { style: `width:${answered.length ? Math.round((n / answered.length) * 100) : 0}%` })),
          h("span", { class: "tally-n" }, `${n}명`)))) : null,
        h("table", { class: "att inner-table", style: "margin-top:6px" },
          h("thead", {}, h("tr", {}, ["소속학교", "학번", "이름", "답", ...(a.gradable ? ["정오", "점수"] : [])].map((t) => h("th", {}, t)))),
          h("tbody", {}, a.rows.map((r) => h("tr", { class: r.answered ? "" : "absent" },
            h("td", {}, r.school || "-"), h("td", {}, r.student_no || "-"), h("td", {}, r.name),
            h("td", { style: "white-space:normal;text-align:left" }, r.answered ? r.answer : "(미응답)"),
            ...(a.gradable ? [h("td", {}, r.correct === true ? "⭕" : r.correct === false ? "❌" : "-"), h("td", { class: "num" }, fmt(r.score))] : []))))));
    }),
    acts.length ? null : h("p", { class: "muted" }, "내역이 없어요."),
    // 채점 칸만 연다 (출결·발언 기록은 여기서 보이지 않게). 설문은 채점이 없어 버튼도 없다
    key === "survey" ? null : h("div", { class: "row" }, h("button", { class: "small", onclick: () => {
      const grades = h("section", { class: "card", style: "margin-top:12px" });
      if (key === "quiz") grades.dataset.only = "quiz";
      fill(full, grades);
      renderGrades(classId, grades);
    } }, "✏️ 채점·피드백 (점수 고치기·학생에게 공개)")),
    full);
}

/* ───────────────────────── 거점학교 운영: 승인·수업일·출석부 ───────────────────────── */

async function loadHub() {
  // 강의교사 승인: '강의할 거점학교'로 우리 거점학교를 고른 강의교사 신청 (전체 관리자는 모두)
  const [ov, ins] = await Promise.all([api("/api/hub/overview"),
    api("/api/staff/applications?role=instructor").catch(() => ({ applications: [], today: today() }))]);
  ins.applications.forEach((x) => { x.role = "instructor"; });
  const teachers = ins.applications.filter((x) => !x.change_only);
  const waitTeachers = teachers.filter((x) => x.status === "pending").length;
  const waitCourses = ov.courses.filter((c) => c.approval === "pending");
  const badge = waitCourses.length + waitTeachers;
  $("#hub-badge").textContent = badge;
  $("#hub-badge").hidden = !badge;
  const box = h("div");
  const subs = [
    ["teachers", `강의교사 승인${waitTeachers ? ` (${waitTeachers})` : ""}`],
    ["courses", `강좌 개설 승인${waitCourses.length ? ` (${waitCourses.length})` : ""}`],
    ["days", "강좌별 수업일"],
    ["attendance", "강좌별 출석부"],
  ];
  fill($("#hub-list"),
    h("nav", { class: "tabs sub-tabs", "aria-label": "거점학교 운영 메뉴" }, subs.map(([k, label]) => h("button", { type: "button", class: hubSub === k ? "active" : "",
      onclick: () => { hubSub = k; hubCourseId = null; hubRecordCourseId = null; hubClassId = null; loadHub(); } }, label))),
    box);
  if (hubSub === "teachers") fill(box, staffBoard("hub", teachers, ins.today || today(), loadHub, ""));
  else if (hubSub === "courses") fill(box, ...hubCourseApprove(ov));
  else if (hubSub === "days") {
    if (hubRecordCourseId && hubClassId) await hubClassAttendance(box, ov);
    else if (hubRecordCourseId) {
      const log = await api(`/api/hub/class-log?course_id=${hubRecordCourseId}`);
      fill(box, ...hubCourseDays(ov, log.classes));
    } else fill(box, ...hubCourseDays(ov, []));
  } else {
    await hubCourseAttendance(box, ov);
  }
}

/** 강좌 개설 승인: 표에서 일괄 처리하거나 강좌명을 눌러 상세 화면에서 처리한다. */
function hubCourseApprove(ov) {
  const courses = [...ov.courses].sort((a, b) => Number(b.approval === "pending") - Number(a.approval === "pending"));
  const termOf = (c) => c.school_year && c.term ? `${c.school_year}학년도 ${c.term}` : c.term || "-";
  const capacityOf = (c) => c.capacity ? `${c.capacity}명` : c.capacity === 0 ? "제한 없음" : "-";
  const decide = async (c, action) => {
    let note = "";
    if (action === "reject") {
      note = await appPrompt(`'${c.title}' 강좌 개설을 반려하는 사유 (강사에게 보여요)`, "");
      if (note === null) return;
      if (!note.trim()) { toast("반려 사유를 적어 주세요."); return; }
    } else if (!await appConfirm(`'${c.title}' 강좌 개설을 승인할까요? 승인하면 모집 기간에 학생들이 수강신청할 수 있어요.`)) return;
    try {
      await api(`/api/hub/courses/${c.id}/approval`, { action, note });
      toast(action === "approve" ? "강좌 개설을 승인했어요." : "반려했어요. 강사가 고치면 다시 올라와요.");
      await loadHub();
    } catch (err) { toast(err.message); }
  };
  const detail = (c) => {
    const sessions = c.sessions || [];
    const classTime = c.class_days?.length
      ? `매주 ${c.class_days.map((d) => DAYS[d]).join("·")} ${c.class_start || ""}~${c.class_end || ""}`
      : c.class_start || c.class_end ? `${c.class_start || ""}~${c.class_end || ""}` : "-";
    const evaluation = c.exam_ratio != null && c.perf_ratio != null
      ? `지필 ${c.exam_ratio}% · 수행 ${c.perf_ratio}%` : "-";
    // 요청한 순서의 2칸 표: 신청 학기·강의 기간 / 교과 상세·교과(군) / 대상 학년·수강 인원 /
    // 강의교사 소속학교·강의교사 이름 / 학점(수업시간)·평가 방식 / 성취도·등급 / 모집기간
    const dash = (v) => (v === null || v === undefined || v === "" ? "-" : v);
    const subjectDetail = [c.subject_area, c.subject && c.subject !== c.title ? c.subject : "",
      c.custom_subject ? "고시외 과목" : c.subject_type].filter(Boolean).join(" · ");
    const credits = c.credits ? `${c.credits}학점${c.hours ? ` (${c.hours}시간)` : ""}` : (c.hours ? `${c.hours}시간` : "");
    const pairs = [
      ["신청 학기", termOf(c), "강의 기간", c.start_date || c.end_date ? `${fmtDate(c.start_date)} ~ ${fmtDate(c.end_date)}` : ""],
      ["교과 상세", subjectDetail, "교과(군)", c.subject_group],
      ["대상 학년", (c.grades?.length ? c.grades : [1, 2, 3]).map((g) => `${g}학년`).join(", "), "수강 인원", capacityOf(c)],
      ["강의교사 소속학교", c.instructor_school, "강의교사 이름", c.instructor],
      ["학점(수업시간)", credits, "평가 방식", evaluation === "-" ? "" : evaluation],
      ["성취도", c.achievement_text, "등급", c.rank_grade],
    ];
    const recruit = c.recruit_start || c.recruit_end
      ? `${fmtDate(c.recruit_start)} ${c.recruit_start_time || ""} ~ ${fmtDate(c.recruit_end)} ${c.recruit_end_time || ""}` : "";
    const infoTable = h("div", { class: "table-wrap" }, h("table", { class: "info-table hub-info-table" }, h("tbody", {},
      ...pairs.map(([k1, v1, k2, v2]) => h("tr", {}, h("th", {}, k1), h("td", {}, dash(v1)), h("th", {}, k2), h("td", {}, dash(v2)))),
      h("tr", {}, h("th", {}, "모집기간"), h("td", { colspan: 3 }, dash(recruit))))));
    // 표 밖의 참고 정보 (있을 때만)
    const facts = [];
    if (classTime !== "-") facts.push(["수업 시간", classTime]);
    if (c.schools?.length) facts.push(["참여 학교", c.schools.join(", ")]);
    if (c.team_teaching) facts.push(["팀티칭", c.co_teachers?.length
      ? `보조교사 ${c.co_teachers.map((x) => x.name).join(", ")}` : "예"]);
    const contact = [c.show_email !== false && c.contact_email, c.show_phone !== false && c.contact_phone].filter(Boolean);
    if (contact.length) facts.push(["연락처", contact.join(" · ")]);
    if (c.syllabus) facts.push(["수업계획서", h("a", {
      href: c.syllabus.url, target: "_blank", rel: "noopener noreferrer"
    }, `📄 ${c.syllabus.name}`)]);
    return [h("article", { class: "info-block notice-view hub-course-view" },
      h("h2", {}, c.title),
      h("p", {}, approvalBadge(c) || h("span", { class: "status approved" }, "개설 승인")),
      infoTable,
      facts.length ? h("dl", { class: "facts", style: "margin-top:10px" }, facts.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])) : null,
      c.description ? h("section", {}, h("h3", {}, "강좌 소개"), h("div", { class: "notice-body" }, c.description)) : null,
      h("section", {}, h("h3", {}, `회차 정보${sessions.length ? ` (${sessions.length}회)` : ""}`),
        sessions.length ? h("div", { class: "table-wrap" }, h("table", { class: "sess-table view" },
          h("thead", {}, h("tr", {}, ["회차", "날짜", "시간", "주제"].map((label) => h("th", {}, label)))),
          h("tbody", {}, sessions.map((s) => h("tr", {}, h("td", {}, s.no), h("td", {}, fmtDate(s.date)),
            h("td", {}, s.start ? `${s.start}~${s.end || ""}` : "-"), h("td", {}, s.topic || "-"))))))
          : h("p", { class: "muted" }, "등록된 회차가 없어요.")),
      c.approval === "rejected" && c.approval_note ? h("p", { class: "muted" }, `반려 사유: ${c.approval_note}`) : null),
      h("div", { class: "row hub-course-actions" },
        h("button", { type: "button", onclick: () => { hubCourseId = null; loadHub(); } }, "← 목록으로"),
        h("span", { class: "grow" }),
        c.approval !== "approved" ? h("button", { class: "primary", onclick: () => decide(c, "approve") }, "개설 승인") : null,
        c.approval !== "rejected" ? h("button", { class: c.approval === "approved" ? "small" : "", onclick: () => decide(c, "reject") },
          c.approval === "approved" ? "승인 취소(반려)" : "반려") : null)];
  };
  const activeCourse = courses.find((c) => c.id === hubCourseId);
  if (activeCourse) return detail(activeCourse);
  hubCourseId = null;

  const selected = new Set();
  const tbody = h("tbody");
  const all = h("input", { type: "checkbox", "aria-label": "강좌 전체 선택" });
  const count = h("span", { class: "muted" }, "선택한 강좌 0개");
  const approveSelected = h("button", { type: "button", class: "primary", disabled: true }, "선택 승인");
  const rejectSelected = h("button", { type: "button", disabled: true }, "선택 반려");
  const sync = () => {
    count.textContent = `선택한 강좌 ${selected.size}개`;
    all.checked = courses.length > 0 && selected.size === courses.length;
    all.indeterminate = selected.size > 0 && selected.size < courses.length;
    approveSelected.disabled = ![...selected].some((id) => courses.find((c) => c.id === id)?.approval !== "approved");
    rejectSelected.disabled = ![...selected].some((id) => courses.find((c) => c.id === id)?.approval !== "rejected");
  };
  all.addEventListener("change", () => {
    selected.clear();
    if (all.checked) courses.forEach((c) => selected.add(c.id));
    tbody.querySelectorAll("input[data-course-id]").forEach((box) => { box.checked = all.checked; });
    sync();
  });
  const batch = async (action) => {
    const targets = courses.filter((c) => selected.has(c.id) && c.approval !== (action === "approve" ? "approved" : "rejected"));
    if (!targets.length) return;
    let note = "";
    if (action === "reject") {
      note = await appPrompt(`선택한 ${targets.length}개 강좌에 적용할 반려 사유 (강사에게 보여요)`, "");
      if (note === null) return;
      if (!note.trim()) { toast("반려 사유를 적어 주세요."); return; }
    } else if (!await appConfirm(`선택한 ${targets.length}개 강좌 개설을 승인할까요?`)) return;
    approveSelected.disabled = true;
    rejectSelected.disabled = true;
    let done = 0;
    const failed = [];
    for (const c of targets) {
      try { await api(`/api/hub/courses/${c.id}/approval`, { action, note }); done++; }
      catch (err) { failed.push(`${c.title}: ${err.message}`); }
    }
    await loadHub();
    toast(`${done}개 강좌를 ${action === "approve" ? "승인" : "반려"}했어요.${failed.length ? ` 처리하지 못한 강좌 ${failed.length}개: ${failed.join("; ")}` : ""}`);
  };
  approveSelected.addEventListener("click", () => batch("approve"));
  rejectSelected.addEventListener("click", () => batch("reject"));
  fill(tbody, courses.length ? courses.map((c, i) =>
    h("tr", {},
        h("td", { "data-label": "선택" }, h("input", { type: "checkbox", "data-course-id": c.id, "aria-label": `${c.title} 선택`,
          onchange: (e) => { if (e.target.checked) selected.add(c.id); else selected.delete(c.id); sync(); } })),
        h("td", { class: "num", "data-label": "연번" }, i + 1),
        h("td", { "data-label": "신청 학기" }, termOf(c)), h("td", { "data-label": "교과(군)" }, c.subject_group || "-"),
        h("td", { "data-label": "강좌명" }, h("button", { type: "button", class: "link-btn name-btn",
          onclick: () => { hubCourseId = c.id; loadHub(); } }, c.title)),
        h("td", { "data-label": "학점" }, c.credits ? `${c.credits}학점` : "-"),
        h("td", { "data-label": "강의교사" }, c.instructor || "-"),
        h("td", { "data-label": "수강 인원" }, capacityOf(c)),
        h("td", { "data-label": "상태" }, approvalBadge(c) || h("span", { class: "status approved" }, "개설 승인"))))
    : h("tr", {}, h("td", { colspan: 9, class: "muted" }, "아직 개설 신청한 강좌가 없어요.")));
  const pending = courses.filter((c) => c.approval === "pending").length;
  return [
    h("div", { class: "row hub-course-actions" }, h("label", { class: "hub-select-all" }, all, "전체 선택"), count,
      h("span", { class: "grow" }), approveSelected, rejectSelected),
    h("div", { class: "table-wrap" }, h("table", { class: "att enroll-table hub-approval-table" },
      h("thead", {}, h("tr", {}, ["선택", "연번", "신청 학기", "교과(군)", "강좌명", "학점", "강의교사", "수강 인원", "상태"].map((label) => h("th", {}, label)))),
      tbody)),
  ];
}

/** 과목 운영과 같은 카드에서 수업일 또는 출석부를 연다. */
function hubRecordCards(ov, kind) {
  const courses = ov.courses.filter((c) => c.approval === "approved");
  const tile = (c) => h("button", { class: `run-tile${c.archived ? " archived" : ""}`, type: "button", onclick: () => {
    hubRecordCourseId = c.id;
    loadHub();
  } },
    thumbOf(c), h("strong", {}, c.title, c.archived ? h("span", { class: "ended-tag" }, "종료") : null),
    h("span", { class: "muted" }, `${c.hub_school || ""} · 강의교사 ${c.instructor || "-"}`),
    h("span", { class: "muted" }, kind === "days"
      ? "수업 기록 보기" : `수강 확정 ${c.approved || 0}명`));
  const active = courses.filter((c) => !c.archived);
  const archived = courses.filter((c) => c.archived);
  const grid = (list) => h("div", { class: "run-tiles" }, list.map(tile));
  // 보관한 강좌도 접지 않고 뒤에 이어서 회색 카드로
  return [active.length || archived.length ? grid([...active, ...archived]) : h("p", { class: "muted" }, "아직 개설 승인한 강좌가 없어요.")];
}

function hubRecordHeading(c) {
  return h("div", { class: "hub-record-banner" },
    h("button", { type: "button", class: "small", onclick: () => {
      hubRecordCourseId = null;
      loadHub();
    } }, "← 과목 목록"),
    courseBanner(c));
}

function hubCourseDays(ov, classes) {
  const course = ov.courses.find((c) => c.id === hubRecordCourseId && c.approval === "approved");
  if (!course) {
    hubRecordCourseId = null;
    return hubRecordCards(ov, "days");
  }
  const rows = classes.filter((x) => x.course_id === course.id);
  return [hubRecordHeading(course),
    rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "att hub-days-table" },
      h("thead", {}, h("tr", {}, ["연번", "수업일", "수업시간", "수업 주제", "참여 인원"].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows.map((x, i) => h("tr", {},
        h("td", { class: "num" }, rows.length - i), h("td", {}, fmtDate(x.date)),
        h("td", {}, `${x.start} ~ ${x.end || (x.live ? "진행 중" : "-")}`),
        h("td", {}, h("button", { type: "button", class: "day-link", title: "이 수업일의 수강생 출석부", onclick: () => openDay(x.id) }, x.title || "(주제 없음)")),
        h("td", {}, h("button", { type: "button", class: "day-link", title: "이 수업일의 수강생 출석부", onclick: () => openDay(x.id) }, `${x.attended}명`)))))))
      : h("p", { class: "muted" }, "아직 연 수업이 없어요.")];
}

function openDay(classId) { hubClassId = classId; loadHub(); }

/** 수업일 하나의 수강생 출석부: 연번 · 소속학교 · 학번 · 이름 · 출결 · 참여 시간 */
async function hubClassAttendance(box, ov) {
  const course = ov.courses.find((c) => c.id === hubRecordCourseId);
  const back = h("button", { type: "button", class: "small", onclick: () => { hubClassId = null; loadHub(); } }, "← 수업일 목록");
  fill(box, h("p", { class: "muted" }, "출석부를 불러오는 중…"));
  let d;
  try { d = await api(`/api/hub/classes/${hubClassId}/attendance`); }
  catch (err) { fill(box, h("div", { class: "row" }, back), h("p", { class: "error" }, err.message)); return; }
  const present = d.rows.filter((r) => r.present).length;
  const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`);
  fill(box,
    h("div", { class: "hub-record-banner" }, back, courseBanner(course || d.course)),
    h("h2", { class: "hub-day-title" }, "수강생 출석부"),
    h("p", { class: "muted" }, `${fmtDate(d.class.date)} ${d.class.start}${d.class.end ? ` ~ ${d.class.end}` : ""} · ${d.class.title || "(주제 없음)"} · 출석 ${present}/${d.rows.length}명`),
    h("div", { class: "table-wrap" }, h("table", { class: "att hub-day-table" },
      h("thead", {}, h("tr", {}, ["연번", "소속학교", "학번", "이름", "출결", "참여 시간"].map((t) => h("th", {}, t)))),
      h("tbody", {}, d.rows.length ? d.rows.map((r, i) => h("tr", { class: r.present ? "" : "absent" },
        h("td", { class: "num" }, i + 1), h("td", {}, r.school || "-"), h("td", {}, r.student_no || "-"), h("td", {}, r.name),
        h("td", {}, h("span", { class: `status ${r.present ? "approved" : "rejected"}` }, r.present ? (r.online ? "출석 (접속 중)" : "출석") : "결석")),
        h("td", {}, r.present ? mins(r.minutes) : "-")))
        : h("tr", {}, h("td", { colspan: 6, class: "muted" }, "수강 확정된 학생이 없어요."))))));
}

async function hubCourseAttendance(box, ov) {
  const course = ov.courses.find((c) => c.id === hubRecordCourseId && c.approval === "approved");
  if (!course) {
    hubRecordCourseId = null;
    fill(box, ...hubRecordCards(ov, "attendance"));
    return;
  }
  fill(box, hubRecordHeading(course), h("p", { class: "muted" }, "출석부를 불러오는 중…"));
  let sheet;
  try { sheet = await api(`/api/hub/courses/${course.id}/attendance`); }
  catch (err) { fill(box, hubRecordHeading(course), h("p", { class: "error" }, err.message)); return; }
  if (hubSub !== "attendance" || hubRecordCourseId !== course.id) return;
  const cls = sheet.classes; // 수업일 (먼저 연 수업부터)
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const counts = cls.map((_, j) => sheet.students.filter((st) => st.attendance[j]).length);
  const fixed = ["연번", "소속학교", "학번", "이름"];
  fill(box, hubRecordHeading(course),
    h("div", { class: "hub-grid-summary" }, `수강 확정 ${sheet.students.length}명 · 수업 ${cls.length}회 · 한 번이라도 들어오면 O`),
    h("div", { class: "row hub-export-actions" },
      h("a", { class: "button", href: `/api/hub/courses/${course.id}/attendance.xlsx` }, "📥 엑셀 받기")),
    h("div", { class: "table-wrap" }, h("table", { class: "att hub-grid-table" },
      h("thead", {},
        h("tr", {}, fixed.map((t) => h("th", { rowspan: 2 }, t)),
          cls.length ? h("th", { colspan: cls.length, class: "center" }, "수업일") : h("th", { rowspan: 2 }, "수업일"),
          h("th", { rowspan: 2, class: "center" }, "참여횟수")),
        cls.length ? h("tr", {}, cls.map((c, j) => h("th", { class: "center", title: `${j + 1}회 · ${c.title || "주제 없음"} · ${c.start}` }, md(c.date)))) : null),
      h("tbody", {},
        sheet.students.length ? sheet.students.map((st, i) => h("tr", {},
          h("td", { class: "num" }, i + 1), h("td", {}, st.school || "-"), h("td", {}, st.student_no || "-"), h("td", {}, st.name),
          cls.length ? cls.map((_, j) => h("td", { class: `center ${st.attendance[j] ? "ox-o-mark" : "ox-x-mark"}` }, st.attendance[j] ? "O" : "X"))
            : h("td", { class: "muted" }, "수업 기록 없음"),
          h("td", { class: "center hub-grid-count" }, `${st.attendance.filter(Boolean).length}/${cls.length}회`)))
          : h("tr", {}, h("td", { colspan: 5 + Math.max(1, cls.length), class: "muted" }, "수강 확정된 학생이 없어요."))),
      cls.length && sheet.students.length ? h("tfoot", {}, h("tr", { class: "hub-grid-total" },
        h("td", { colspan: 4 }, "참여 인원"),
        counts.map((n) => h("td", { class: "center" }, `${n}명`)), h("td", {}))) : null)));
}

/* ───────────────────────── 참여학교 담당: 우리 학교 수강생 관리 · 탈퇴 승인 ───────────────────────── */

let schoolData = null; // 참여학교 담당: 우리 학교 학생
const withdrawPick = new Set(); // 탈퇴 승인 탭에서 체크한 학생 id
const schoolQ = {};

/** 참여학교 담당: 학생 가입 승인, 학생 명단, 전입 승인, 탈퇴 승인, 탈퇴자 증빙 */
async function loadSchool() {
  const outer = $("#school-list");
  const box = h("div");
  fill(outer,
    h("nav", { class: "tabs sub-tabs", "aria-label": "참여학교 담당 메뉴" },
      [["signup", "학생 가입 승인"], ["transfer", "소속학교 변경 승인"], ["students", "학생 수강 관리"], ["withdraw", "탈퇴 승인"], ["evidence", "탈퇴자 증빙"]].map(([key, label]) => h("button", {
        type: "button", class: schoolSub === key ? "active" : "",
        onclick: () => { schoolSub = key; loadSchool(); }
      }, label))), box);
  if (schoolSub === "evidence") { window.renderEvidence(box); return; }
  if (schoolSub === "transfer") { await renderStudentSchoolChanges(box); return; }
  const selectedTab = schoolSub;
  fill(box, h("p", { class: "muted" }, "불러오는 중…"));
  try { schoolData = await api("/api/school/overview"); }
  catch (e) { fill(box, h("p", { class: "error" }, e.message)); return; }
  if (schoolSub !== selectedTab) return;
  const quits = schoolData.withdrawals.length + (schoolData.signups || 0); // 탈퇴 + 가입 승인 대기
  $("#school-badge").textContent = quits;
  $("#school-badge").hidden = !quits;
  if (selectedTab === "withdraw") { renderSchoolWithdrawals(box); return; }
  if (selectedTab === "signup") { await renderSchoolSignups(box); return; }
  const all = schoolData.students.flatMap((x) => x.courses);
  const terms = koSort(new Set(all.map((c) => c.term).filter(Boolean)));
  const hubs = koSort(new Set(all.map((c) => c.hub).filter(Boolean)));
  const f = {
    term: h("select", {}, h("option", { value: "" }, "전체"), terms.map((t) => h("option", { value: t }, t))),
    subject: h("input", { placeholder: "예: 법과 사회" }),
    status: h("select", {}, h("option", { value: "" }, "전체"), koSort(Object.entries(ENROLL_NAME), (x) => x[1]).map(([k, v]) => h("option", { value: k }, v)),
      h("option", { value: "none" }, "수강신청 없음")),
    teacher: h("input", { placeholder: "강의교사 이름" }),
    hub: h("select", {}, h("option", { value: "" }, "전체"), hubs.map((x) => h("option", { value: x }, x))),
    name: h("input", { placeholder: "학생 이름" }),
    from: h("input", { type: "date" }),
    to: h("input", { type: "date" }),
  };
  for (const [k, el] of Object.entries(f)) el.value = schoolQ[k] || "";
  const quick = (days) => {
    const t = today();
    f.to.value = t;
    f.from.value = new Date(Date.parse(t) - days * 86400000).toISOString().slice(0, 10);
  };
  const result = h("div");
  const search = () => {
    for (const [k, el] of Object.entries(f)) schoolQ[k] = el.value.trim();
    drawSchoolResult(result);
  };
  for (const el of Object.values(f)) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  const row = (...cells) => h("div", { class: "sf-row" }, ...cells.flat());
  const cell = (label, el, wide) => [h("div", { class: "sf-label" }, label), h("div", { class: `sf-field ${wide ? "wide" : ""}` }, el)];
  fill(box,
    h("h2", { style: "margin:0 0 6px" }, "학생 수강 관리"),
    ME.is_admin && !schoolData.schools.length ? null
      : h("p", { class: "muted", style: "margin:0 0 10px;font-size:0.9rem" },
        `${schoolData.schools.join(", ")} 학생만 보여요 (학생이 가입할 때 고른 소속 학교 기준).`),
    h("div", { class: "search-form" },
      row(cell("학기", f.term), cell("과목명", f.subject)),
      row(cell("거점학교", f.hub), cell("강의 교사", f.teacher)),
      row(cell("신청 상태", f.status), cell("학생 이름", f.name)),
      row(cell("모집 시기", h("div", { class: "row" }, f.from, "~", f.to,
        ...[["오늘", 0], ["7일", 7], ["1개월", 30], ["6개월", 182]].map(([label, d]) => h("label", { class: "switch" },
          h("input", { type: "radio", name: "school-quick", onchange: () => quick(d) }), label))), true))),
    h("div", { class: "row", style: "justify-content:center;margin:12px 0 20px" },
      h("button", { type: "button", onclick: () => { for (const k of Object.keys(schoolQ)) delete schoolQ[k]; loadSchool(); } }, "초기화"),
      h("button", { class: "primary", type: "button", onclick: search }, "검색")),
    result);
  drawSchoolResult(result);
}

const signupPick = new Set();
let signupNoTeacher = false; // 전체 관리자: 담당 선생님 없는 학교만 보기
const teacherCell = (names) => (names?.length ? names.filter(Boolean).join(", ") || "담당 선생님"
  : h("span", { class: "status rejected", title: "이 학교에는 참여학교 담당 선생님이 없어 전체 관리자가 승인해요" }, "담당 선생님 없음"));

/** [학생 가입 승인]: 우리 학교로 가입한 학생을 확인해 승인·반려 (승인해야 학생이 이용할 수 있다) */
async function renderSchoolSignups(box) {
  let list;
  try { ({ signups: list } = await api("/api/school/signups")); } catch (e) { fill(box, h("p", { class: "error" }, e.message)); return; }
  const orphan = list.filter((x) => !x.teachers.length);
  if (ME.is_admin && signupNoTeacher) list = orphan;
  signupPick.clear();
  const decide = async (action, only = null) => {
    const picked = only ? [only] : list.filter((x) => signupPick.has(x.user_id));
    if (!picked.length) { toast("학생을 선택해 주세요."); return; }
    let note = "";
    if (action === "approve") {
      if (!await appConfirm(`${picked.length}명의 가입을 승인할까요?\n승인하면 학생이 수강신청과 수업에 참여할 수 있어요.`)) return;
    } else {
      note = await appPrompt(`${picked.length}명의 가입을 반려해요. 사유 (학생에게 보여요, 예: 우리 학교 학생이 아니에요)`, "");
      if (note === null) return;
    }
    let done = 0;
    for (const x of picked) {
      try { await api(`/api/school/signups/${x.user_id}`, { action, note }); done++; } catch (err) { toast(`${x.name}: ${err.message}`); }
    }
    toast(action === "approve" ? `${done}명의 가입을 승인했어요.` : `${done}명의 가입을 반려했어요.`);
    schoolData = null;
    loadSchool();
  };
  const pending = list.filter((x) => x.status === "pending");
  const all = h("input", { type: "checkbox", "aria-label": "승인 대기 전체 선택", onchange: (e) => {
    for (const x of pending) { if (e.target.checked) signupPick.add(x.user_id); else signupPick.delete(x.user_id); }
    box.querySelectorAll(".signup-check").forEach((c) => { c.checked = e.target.checked; });
  } });
  fill(box,
    h("h2", { style: "margin:0 0 6px" }, "학생 가입 승인"),
    h("p", { class: "muted", style: "margin:0 0 10px;font-size:0.9rem" },
      "우리 학교를 소속 학교로 골라 가입한 학생이에요. 우리 학교 학생이 맞는지 확인하고 승인하면 학생이 수강신청과 수업에 참여할 수 있어요."),
    h("div", { class: "row", style: "margin-bottom:8px" },
      h("strong", {}, "승인 대기 ", h("span", { class: "accent-text" }, pending.length), "명"),
      h("button", { class: "small primary", type: "button", disabled: !pending.length, onclick: () => decide("approve") }, "선택 승인"),
      h("button", { class: "small", type: "button", disabled: !pending.length, onclick: () => decide("reject") }, "선택 반려"),
      h("span", { class: "grow" }),
      ME.is_admin ? h("label", { class: "switch" }, h("input", { type: "checkbox", checked: signupNoTeacher,
        onchange: (e) => { signupNoTeacher = e.target.checked; renderSchoolSignups(box); } }),
        `담당 선생님 없는 학교만 보기 (${orphan.filter((x) => x.status === "pending").length}명 대기)`) : null),
    h("div", { class: "table-wrap" }, h("table", { class: "att signup-table" },
      h("thead", {}, h("tr", {}, h("th", {}, all), ["연번", "소속학교", "승인 담당", "학년", "반", "번호", "이름", "생년월일", "성별", "이메일", "연락처", "신청일", "상태", "승인/반려"].map((t) => h("th", {}, t)))),
      h("tbody", {}, list.length ? list.map((x, i) => h("tr", {},
        h("td", {}, x.status === "pending" ? h("input", { type: "checkbox", class: "signup-check", "aria-label": `${x.name} 선택`, onchange: (e) => {
          if (e.target.checked) signupPick.add(x.user_id); else signupPick.delete(x.user_id);
        } }) : null),
        h("td", {}, i + 1), h("td", {}, x.school || "-"), h("td", {}, teacherCell(x.teachers)), h("td", {}, x.grade ? `${x.grade}학년` : "-"),
        h("td", {}, x.class_no ? `${x.class_no}반` : "-"), h("td", {}, x.number ? `${x.number}번` : "-"), h("td", {}, h("strong", {}, x.name)),
        h("td", {}, x.birth || "-"), h("td", {}, x.gender || "-"), h("td", { class: "contact-cell" }, x.email || "-"),
        h("td", { class: "contact-cell" }, fmtPhone(x.phone) || "-"), h("td", {}, kstDate(x.requested_at)),
        h("td", {}, x.status === "pending" ? h("span", { class: "status pending" }, "승인 대기")
          : h("span", { class: "status rejected", title: x.note ? `사유: ${x.note}` : "" }, "반려 (학생 수정 대기)")),
        h("td", {}, x.status === "pending" ? h("div", { class: "row school-change-actions" },
          h("button", { class: "small primary", type: "button", onclick: () => decide("approve", x) }, "승인"),
          h("button", { class: "small", type: "button", onclick: () => decide("reject", x) }, "반려")) : "-")))
        : h("tr", {}, h("td", { colspan: 15, class: "muted", style: "text-align:center;padding:24px" }, "가입 승인을 기다리는 학생이 없어요."))))));
}

function renderSchoolWithdrawals(box) {
  const pending = schoolData.withdrawals;
  withdrawPick.clear();
  const decide = async (action, only = null) => {
    const picked = only ? [only] : pending.filter((x) => withdrawPick.has(x.user_id));
    if (!picked.length) { toast("탈퇴 신청 학생을 선택해 주세요."); return; }
    let note = "";
    if (action === "approve") {
      const studying = picked.filter((x) => x.studying.length);
      if (!await appConfirm(`${picked.length}명의 탈퇴를 승인할까요?\n` +
        (studying.length ? `⚠️ 아직 수강 중인 학생: ${studying.map((x) => x.name).join(", ")}\n` : "") +
        "일반 수업 기록은 제거하고 출결·활동·점수 등 증빙 기록은 암호화해 별도 보관합니다.")) return;
    } else {
      note = await appPrompt(`${picked.length}명의 탈퇴 신청을 반려해요. 사유 (학생에게 보여요)`, "");
      if (note === null) return;
    }
    let done = 0;
    for (const x of picked) {
      try { await api(`/api/school/withdrawals/${x.user_id}`, { action, note }); done++; }
      catch (err) { toast(`${x.name}: ${err.message}`); }
    }
    toast(action === "approve" ? `${done}명의 탈퇴를 승인했어요.` : `${done}명의 탈퇴 신청을 반려했어요.`);
    schoolData = null;
    loadSchool();
  };
  const all = h("input", { type: "checkbox", onchange: (e) => {
    for (const x of pending) { if (e.target.checked) withdrawPick.add(x.user_id); else withdrawPick.delete(x.user_id); }
    box.querySelectorAll(".withdraw-student-check").forEach((input) => { input.checked = e.target.checked; });
  } });
  fill(box,
    h("h2", {}, "탈퇴 승인"),
    h("p", { class: "muted" }, `탈퇴 승인 대기 ${pending.length}명`),
    pending.length ? h("div", { class: "row", style: "margin-bottom:12px" },
      h("label", { class: "switch" }, all, "전체 선택"),
      h("button", { class: "small danger", onclick: () => decide("approve") }, "선택 탈퇴 승인"),
      h("button", { class: "small", onclick: () => decide("reject") }, "선택 탈퇴 반려"))
      : h("p", { class: "muted" }, "탈퇴 승인 대기 중인 학생이 없어요."),
    pending.map((x) => h("div", { class: "card", style: "margin:10px 0" },
      h("div", { class: "row" },
        h("input", { type: "checkbox", class: "withdraw-student-check", "aria-label": `${x.name} 학생 선택`, onchange: (e) => {
          if (e.target.checked) withdrawPick.add(x.user_id); else withdrawPick.delete(x.user_id);
          all.checked = withdrawPick.size === pending.length;
        } }),
        h("strong", {}, `${x.school} · ${x.student_no || "학번 없음"} · ${x.name}`)),
      h("p", { class: "muted" }, `신청일: ${kstDate(x.requested_at)}${x.reason ? ` · 사유: ${x.reason}` : ""}`),
      x.courses.length ? h("p", {}, `신청 강좌: ${x.courses.join(", ")}`) : null,
      x.studying.length ? h("p", { class: "banner warn" }, `현재 수강 중: ${x.studying.join(", ")}`) : null,
      h("div", { class: "row" },
        h("button", { class: "small danger", onclick: () => decide("approve", x) }, "탈퇴 승인"),
        h("button", { class: "small", onclick: () => decide("reject", x) }, "반려")))));
}

async function renderStudentSchoolChanges(box) {
  fill(box, h("p", { class: "muted" }, "불러오는 중…"));
  try {
    const { requests } = await api("/api/school/change-requests");
    const head = ["연번", "이름", "변경 전 소속학교", "학년", "반", "번호", "변경 후 소속학교", "학년", "반", "번호", "승인/반려"];
    fill(box,
      ME.is_admin ? null : h("p", { class: "muted" }, "우리 학교로 옮기려는 학생의 신청입니다. 승인하면 학생이 우리 학교 명단에 표시됩니다."),
      h("div", { class: "table-wrap" }, h("table", { class: "att school-change-table" },
        // 머리글 두 줄: 변경 전·후 아래에 소속학교·학년·반·번호 (가로 폭을 줄인다)
        h("thead", {},
          h("tr", {}, h("th", { rowspan: 2 }, "연번"), h("th", { rowspan: 2 }, "이름"), h("th", { colspan: 4 }, "변경 전"),
            h("th", { colspan: 4 }, "변경 후"), h("th", { rowspan: 2, title: "변경 후 학교의 참여학교 담당 선생님이 승인해요" }, "승인 담당"), h("th", { rowspan: 2 }, "승인/반려")),
          h("tr", {}, [0, 1].flatMap(() => ["소속학교", "학년", "반", "번호"].map((label) => h("th", {}, label))))),
        h("tbody", {}, requests.length ? requests.map((r, i) => {
          return h("tr", {},
          h("td", {}, i + 1),
          h("td", {}, r.name || "-"),
          h("td", {}, r.old_value || "-"),
          h("td", {}, r.grade ? `${r.grade}학년` : "-"),
          h("td", {}, r.class_no ? `${r.class_no}반` : "-"),
          h("td", {}, r.number ? `${r.number}번` : "-"),
          h("td", {}, r.new_value || "-"),
          h("td", {}, (r.new_grade ?? r.grade) ? `${r.new_grade ?? r.grade}학년` : "-"),
          h("td", {}, (r.new_class_no ?? r.class_no) ? `${r.new_class_no ?? r.class_no}반` : "-"),
          h("td", {}, (r.new_number ?? r.number) ? `${r.new_number ?? r.number}번` : "-"),
          h("td", {}, teacherCell(r.teachers)),
          h("td", {}, (ME.is_admin || (ME.participant_schools || []).includes(r.new_value))
            ? h("div", { class: "row school-change-actions" }, ["approve", "reject"].map((action) => h("button", {
            type: "button", class: action === "approve" ? "small primary" : "small", onclick: async () => {
              if (action === "approve" && !await appConfirm(`${r.name} 학생의 소속학교를 ${r.new_value}(으)로 변경할까요?`)) return;
              const note = action === "reject" ? await appPrompt("반려 사유를 입력하세요. 학생에게 표시됩니다.", "") : "";
              if (note === null) return;
              try {
                await api(`/api/school/change-requests/${r.id}`, { action, note });
                toast(action === "approve" ? "소속학교 변경을 승인했어요." : "소속학교 변경을 반려했어요.");
                schoolData = null;
                loadSchool();
              } catch (e) { toast(e.message); }
            }
          }, action === "approve" ? "승인" : "반려")))
            : h("span", { class: "muted" }, "해당 학교 담당교사 처리")));
        }) : h("tr", {}, h("td", { colspan: head.length, class: "muted" }, "승인 대기 중인 신청이 없어요."))))));
  } catch (e) { fill(box, h("p", { class: "error" }, e.message)); }
}

/** 검색 조건에 맞는 강좌가 있는 학생 (강좌 조건이 없으면 모든 학생) */
/** 검색 칸의 과목 조건 (조건이 없으면 null) */
/** 과목 조건: 학기·과목명·거점학교·강의 교사·신청 상태·모집 시기(과목 모집 기간이 고른 기간과 겹치면, 모집 기간이 없으면 늘 포함) */
function schoolCourseOk(c) {
  const q = schoolQ;
  const has = (v, w) => !w || (v || "").includes(w);
  return (!q.term || c.term === q.term) && (has(c.subject, q.subject) || has(c.title, q.subject))
    && (!q.hub || c.hub === q.hub) && (!q.status || q.status === "none" || c.status === q.status) && has(c.instructor, q.teacher)
    && (!q.from || !c.recruit_end || c.recruit_end >= q.from) && (!q.to || !c.recruit_start || c.recruit_start <= q.to);
}

function schoolCourseFilter() {
  const q = schoolQ;
  const courseCond = q.term || q.subject || (q.status && q.status !== "none") || q.teacher || q.hub || q.from || q.to;
  if (!courseCond) return null;
  return schoolCourseOk;
}

function filteredSchool() {
  const q = schoolQ;
  const has = (v, w) => !w || (v || "").includes(w);
  const courseCond = q.term || q.subject || (q.status && q.status !== "none") || q.teacher || q.hub || q.from || q.to;
  return schoolData.students.filter((x) => has(x.name, q.name)
    && (q.status !== "none" || !x.courses.length) && (!courseCond || x.courses.some(schoolCourseOk)));
}

function drawSchoolResult(box) {
  const list = filteredSchool();
  // 한 줄 = 학생 한 명의 과목 하나 (과목이 없으면 한 줄). 과목 조건으로 찾았으면 맞는 과목만
  const pick = schoolCourseFilter();
  const coursesOf = (x) => koSort(pick ? x.courses.filter(pick) : x.courses, (c) => `${c.term} ${c.subject}`);
  const HEAD = ["연번", "소속학교", "학년", "반", "이름", "거점학교", "과목명", "강의교사", "승인여부"];
  const csv = () => {
    const lines = list.flatMap((x, i) => {
      const cs = coursesOf(x);
      return (cs.length ? cs : [null]).map((c) => [i + 1, x.school, x.grade ? `${x.grade}학년` : "", x.class_no ? `${x.class_no}반` : "", x.name,
        c?.hub || "", c?.subject || "", c?.instructor || "", c ? ENROLL_NAME[c.status] || c.status : ""]);
    });
    const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const text = "\ufeff" + [HEAD, ...lines].map((r) => r.map(esc).join(",")).join("\r\n");
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })), download: `우리학교_학생수강관리_${today()}.csv` });
    api("/api/access-log/export", { what: `우리 학교 학생 수강 관리 엑셀 (${list.length}명)` }).catch(() => {});
    document.body.append(a);
    a.click();
    a.remove();
  };
  const rows = list.flatMap((x, i) => {
    const cs = coursesOf(x);
    const span = Math.max(1, cs.length);
    // 학생 칸(연번·소속학교·학년·반·이름)은 과목 줄을 묶어 한 칸으로 표시한다.
    const who = [
      h("td", { rowspan: span }, i + 1),
      h("td", { rowspan: span }, x.school || "-"),
      h("td", { rowspan: span }, x.grade ? `${x.grade}학년` : "-"),
      h("td", { rowspan: span }, x.class_no ? `${x.class_no}반` : "-"),
      h("td", { rowspan: span }, h("strong", {}, x.name)),
    ];
    const courseCells = (c) => c ? [h("td", {}, c.hub || "-"),
      h("td", {}, c.subject, c.archived ? h("span", { class: "muted" }, " (끝남)") : null),
      h("td", {}, c.instructor || "-"),
      h("td", {}, h("span", { class: `status ${c.status}` }, ENROLL_NAME[c.status] || c.status))]
      : [h("td", {}, "-"), h("td", { class: "muted" }, "수강신청 없음"), h("td", {}, "-"), h("td", {}, "-")];
    if (!cs.length) return [h("tr", {}, ...who, ...courseCells(null))];
    return cs.map((c, i) => h("tr", { class: i ? "cont-row" : "" }, ...(i ? [] : who), ...courseCells(c)));
  });
  fill(box,
    h("div", { class: "row", style: "margin-bottom:8px" },
      h("strong", {}, "총 ", h("span", { class: "accent-text" }, list.length), "명"),
      h("span", { class: "grow" }),
      h("button", { class: "small", onclick: csv, disabled: !list.length }, "📥 엑셀 다운로드")),
    h("div", { class: "table-wrap" }, h("table", { class: "att enroll-table school-table" },
      h("thead", {}, h("tr", {}, HEAD.map((t) => h("th", {}, t)))),
      h("tbody", {}, rows.length ? rows
        : h("tr", {}, h("td", { colspan: HEAD.length, class: "muted", style: "text-align:center;padding:24px" }, "조건에 맞는 학생이 없어요."))))));
}
