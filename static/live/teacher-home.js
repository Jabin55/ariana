/* 선생님 마이페이지: [특강/회의] [과목 개설] [수강생 관리] [과목 운영] [거점학교 운영] [참여학교 담당] (+ 전체 관리) */

let teacherCourses = null; // 아직 못 불러왔으면 null
const editing = new Set(); // 정보 수정 중인 강좌
let runCourseId = null; // 과목 운영에서 연 과목
let runSub = "notice"; // 그 과목 안의 칸: notice(공지사항) open(수업 열기) assess(평가 활동) learn(학습 관리)
let hubSub = "approve"; // 거점학교 운영 안의 칸: approve(강의교사 승인) students(학생 관리)
let detailTarget = null; // 수업 기록(출결·채점)을 그릴 자리
function detailEl() { return detailTarget || $("#run-detail"); }

function today() {
  // 기록은 한국 시간 날짜로 나뉜다 (기기 시간대와 상관없이)
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** replaceChildren에 null·false가 섞여도 글자로 찍히지 않게 */
function fill(box, ...kids) { box.replaceChildren(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false && x !== "")); }

/* 권한: 강의교사는 [특강/회의]~[과목 운영], 거점학교 관리교사는 [거점학교 운영], 참여학교 담당자는 [참여학교 담당].
   역할이 여럿이면 그 탭들이 모두 열리고, 전체 관리자는 모두 열린다. 권한이 없는 탭은 '권한이 없습니다.' */
function canHub() { return ME.is_admin || ME.coordinator_hubs.length > 0; }
function canSchool() { return ME.is_admin || (ME.participant_schools || []).length > 0; }
function canTeach() {
  // 설정으로 등록한 강사(거점학교 등록 없이)도 강의한다: 다른 역할만 가진 게 아니면 강의교사로 본다
  return ME.is_admin || ME.lead_hubs.length > 0 || ME.teach_hubs.length > 0 || !(canHub() || canSchool());
}
function allowed(tab) {
  if (tab === "admin") return ME.is_admin;
  if (tab === "hub") return canHub();
  if (tab === "school") return canSchool();
  return canTeach();
}

function showTeacher() {
  show("teacher-view");
  $("#lead").hidden = true;
  $("#admin-tab").hidden = !ME.is_admin;
  const want = params.get("tab") === "courses" || params.get("tab") === "history" ? "run" : params.get("tab");
  if (params.get("course")) runCourseId = Number(params.get("course"));
  const first = canTeach() ? "run" : canHub() ? "hub" : "school";
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
  if (name === "meet") { loadLive(); loadMeetings(); loadMeetHistory(); }
  if (name === "create") { if (!$("#course-create-box").dataset.ready) drawCreateForm(); drawCreateExtras(); }
  if (name === "students") renderStudents();
  if (name === "run") renderRun();
  if (name === "admin") loadAdmin();
  if (name === "hub") loadHub();
  if (name === "school") loadSchool();
}
$("#home-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
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
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt("복사해서 보내 주세요.", text); }
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
      if (!confirm(`'${m.title}' 예약을 취소할까요?`)) return;
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

async function loadMeetHistory() {
  const { classes } = await api("/api/live/meetings-history");
  const box = $("#meet-history");
  fill(box, ...classes.map((c) => h("button", { class: "class-pick", "data-id": c.id, onclick: () => { detailTarget = $("#meet-detail"); loadDetail(c.id); } },
    `${c.date.replaceAll("-", ".")} ${c.start.slice(0, 5)} · ${c.title} · 참여 ${c.attended}명${c.live ? " · 진행 중" : ""}`)));
  if (!classes.length) box.append(h("span", { class: "muted" }, "아직 연 특강·회의가 없어요."));
  fill($("#meet-detail"), );
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
      drawCreateForm();
      runCourseId = id;
      loadTeacherCourses();
    }));
  } catch (err) { fill(box, h("p", { class: "error" }, err.message)); }
}
$("#more-roles").addEventListener("click", () => showGuest(true));

/** 강좌 개설 탭 아래: 메인 전광판 (선생님 누구나). 외솔온닷 공지사항은 공지사항 페이지에서 바로 쓴다 */
async function drawCreateExtras() {
  const box = $("#create-extras");
  try {
    fill(box, await bannersEditor(drawCreateExtras));
  } catch (err) { fill(box, h("p", { class: "error" }, err.message)); }
}

/* ───────────────────────── 수강생 관리: 수업신청자 조회 ───────────────────────── */

const ENROLL_NAME = { pending: "승인 대기", approved: "수강 확정", rejected: "반려" };
const kstDate = (ts) => (ts ? new Date(ts * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10) : "");
let enrollRows = null; // 내 강좌의 수강신청 전체
const enrollPick = new Set(); // 체크한 신청 (강좌id:학생id)
const enrollQ = {}; // 검색 조건

async function renderStudents() {
  const box = $("#students-list");
  if (!enrollRows) fill(box, h("p", { class: "muted" }, "불러오는 중…"));
  ({ enrollments: enrollRows } = await api("/api/my/enrollments"));
  enrollPick.clear();
  const terms = koSort(new Set(enrollRows.map((x) => x.term).filter(Boolean)));
  const schools = koSort(new Set(enrollRows.map((x) => x.school).filter(Boolean)));
  const f = {
    term: h("select", {}, h("option", { value: "" }, "전체"), terms.map((t) => h("option", { value: t }, t))),
    subject: h("input", { placeholder: "예: 법과 사회" }),
    status: h("select", {}, h("option", { value: "" }, "전체"), koSort(Object.entries(ENROLL_NAME), (x) => x[1]).map(([k, v]) => h("option", { value: k }, v))),
    teacher: h("input", { placeholder: "강의교사 이름" }),
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
    h("h2", { style: "margin:0 0 10px" }, "수강생 관리"),
    h("div", { class: "search-form" },
      row(cell("교육과정", f.term), cell("과목명", f.subject)),
      row(cell("신청상태", f.status), cell("강의교사", f.teacher)),
      row(cell("소속학교", f.school), cell("학생이름", f.name)),
      row(cell("기간검색", h("div", { class: "row" }, f.from, "~", f.to,
        ...[["오늘", 0], ["7일", 7], ["1개월", 30], ["6개월", 182]].map(([label, d]) => h("label", { class: "switch" },
          h("input", { type: "radio", name: "enroll-quick", onchange: () => quick(d) }), label))), true))),
    h("div", { class: "row", style: "justify-content:center;margin:12px 0 20px" },
      h("button", { type: "button", onclick: () => { for (const k of Object.keys(enrollQ)) delete enrollQ[k]; renderStudents(); } }, "초기화"),
      h("button", { class: "primary", type: "button", onclick: search }, "검색")),
    result);
  drawEnrollResult(result);
}

function filteredEnrollments() {
  const q = enrollQ;
  const has = (v, w) => !w || (v || "").includes(w);
  return enrollRows.filter((x) => (!q.term || x.term === q.term) && (has(x.subject, q.subject) || has(x.course_title, q.subject))
    && (!q.status || x.status === q.status) && has(x.instructor, q.teacher) && (!q.school || x.school === q.school)
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
      note = prompt(`${picked.length}명의 수강신청을 반려해요. 사유 (학생에게 보여요, 비워도 돼요)`, "");
      if (note === null) return;
    } else if (!confirm(`${picked.length}명을 수강 확정할까요?`)) return;
    let ok = 0;
    for (const x of picked) {
      try { await api(`/api/courses/${x.course_id}/enrollments/${x.user_id}`, { status, note }); ok++; } catch (err) { toast(err.message); }
    }
    toast(status === "approved" ? `${ok}명을 승인했어요.` : `${ok}명을 반려했어요.`);
    loadTeacherCourses();
    renderStudents();
  };
  const csv = () => {
    const head = ["번호", "과목명", "거점학교", "강의교사", "소속학교", "학년", "반", "학생이름", "신청일", "신청상태"];
    const lines = list.map((x, i) => [list.length - i, x.subject, x.hub_school, x.instructor, x.school,
      x.grade ? `${x.grade}학년` : "", x.class_no ? `${x.class_no}반` : "", x.name, kstDate(x.requested_at), ENROLL_NAME[x.status] || x.status]);
    const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const text = "﻿" + [head, ...lines].map((r) => r.map(esc).join(",")).join("\r\n");
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })), download: `수강생_${today()}.csv` });
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
    h("div", { class: "table-wrap" }, h("table", { class: "att enroll-table" },
      h("thead", {}, h("tr", {}, h("th", {}, all), ["번호", "과목명", "거점학교", "강의교사", "소속학교", "학년", "반", "학생이름", "신청일", "신청상태"].map((t) => h("th", {}, t)))),
      h("tbody", {}, list.length ? list.map((x, i) => h("tr", {},
        h("td", {}, h("input", { type: "checkbox", checked: enrollPick.has(key(x)), onchange: (e) => {
          if (e.target.checked) enrollPick.add(key(x)); else enrollPick.delete(key(x));
        } })),
        h("td", { class: "num" }, list.length - i), h("td", {}, x.subject),
        h("td", {}, x.hub_school), h("td", {}, x.instructor), h("td", {}, x.school || "-"),
        h("td", { class: "num" }, x.grade ? `${x.grade}학년` : "-"), h("td", { class: "num" }, x.class_no ? `${x.class_no}반` : "-"),
        h("td", {}, x.name), h("td", {}, kstDate(x.requested_at)),
        h("td", {}, h("span", { class: `status ${x.status === "rejected" ? "rejected" : x.status}`, title: x.note ? `사유: ${x.note}` : "" },
          ENROLL_NAME[x.status] || x.status))))
        : h("tr", {}, h("td", { colspan: 11, class: "muted", style: "text-align:center;padding:24px" }, "조건에 맞는 수강신청이 없어요."))))));
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

function renderRun() {
  if (!teacherCourses) { fill($("#run-list"), h("p", { class: "muted" }, "불러오는 중…")); return; }
  const c = teacherCourses.find((x) => x.id === runCourseId);
  $("#run-list").hidden = !!c;
  $("#run-course").hidden = !c;
  if (c) return renderRunCourse(c);
  const tile = (x) => h("button", { class: "run-tile", type: "button", onclick: () => { runCourseId = x.id; runSub = "notice"; renderRun(); } },
    thumbOf(x),
    h("strong", {}, x.title),
    h("span", { class: "muted" }, `${x.hub_school || ""} · 수강 확정 ${x.approved}명`),
    approvalBadge(x),
    x.pending ? h("span", { class: "status pending" }, `수강 승인 대기 ${x.pending}`) : null,
    x.lead ? null : h("span", { class: "status pending" }, "팀티칭"));
  const active = teacherCourses.filter((x) => !x.archived);
  const archived = teacherCourses.filter((x) => x.archived);
  const grid = (items) => h("div", { class: "run-tiles" }, items.map(tile));
  fill($("#run-list"), 
    h("p", { class: "muted", style: "margin:0 0 10px" }, "과목을 누르면 공지사항·온라인 수업 열기·평가 활동·학습 관리를 볼 수 있어요."),
    active.length ? grid(active) : h("p", { class: "muted" }, "아직 개설한 과목이 없어요. '과목 개설'에서 먼저 강좌를 만들어 주세요."),
    archived.length ? h("details", { style: "margin-top:16px" }, h("summary", { class: "muted" }, `보관한 강좌 ${archived.length}개`), grid(archived)) : null);
}

function renderRunCourse(c) {
  const update = async (values) => { await api(`/api/courses/${c.id}`, values); loadTeacherCourses(); };
  const subBox = h("div", { class: "run-sub" });
  const subs = [["notice", "📢 공지사항"], ["open", "▶ 온라인 수업 열기"], ["assess", "📝 평가 활동"], ["learn", "📊 학습 관리"]];
  fill($("#run-course"), 
    h("div", { class: "row" },
      h("button", { class: "small", onclick: () => { runCourseId = null; renderRun(); } }, "← 과목 목록"),
      h("h2", { class: "grow", style: "margin:0" }, c.title, c.archived ? h("span", { class: "muted" }, " (보관됨)") : null),
      !c.locked && !c.archived && c.approval === "approved" ? h("label", { class: "switch", style: "font-size:0.9rem" }, h("input", { type: "checkbox", checked: c.open,
        onchange: (e) => update({ open: e.target.checked }) }), "수강신청 받기") : null,
      c.lead && !c.locked && !editing.has(c.id) ? h("button", { class: "small", onclick: () => { editing.add(c.id); renderRun(); } }, "정보 수정") : null,
      c.lead && !c.locked ? h("button", { class: "small", onclick: () => {
        if (c.archived || confirm("학기가 끝난 강좌를 보관할까요? 수강신청이 닫히고 새 수업을 열 수 없어요. 기록은 남아요.")) update({ archived: !c.archived });
      } }, c.archived ? "보관 해제" : "보관 (학기 끝)") : null),
    courseInfo(c),
    approvalNote(c),
    c.lead ? null : h("p", { style: "margin:4px 0" }, h("span", { class: "status pending" }, "팀티칭"), ` 보조교사로 참여 중 · 주강사 ${c.owner_name}`),
    c.locked ? h("p", { class: "error" }, `${c.hub_school} 강사 활동 기간이 아니라서 이 강좌를 관리하거나 수업을 열 수 없어요. 계속 강의하려면 '과목 개설' 탭의 '다른 거점학교·역할 신청'으로 다시 신청하세요.`) : null,
    editing.has(c.id) && !c.locked ? courseEditForm(c) : h("details", { class: "course-more" }, h("summary", {}, "과목 정보 자세히"), courseFacts(c),
      c.description ? h("p", { class: "muted", style: "white-space:pre-wrap" }, c.description) : null),
    c.locked ? null : h("nav", { class: "tabs sub-tabs" }, subs.map(([k, label]) => h("button", { class: runSub === k ? "active" : "",
      onclick: () => { runSub = k; renderRunCourse(c); } }, label))),
    c.locked ? null : subBox);
  if (c.locked) return;
  if (runSub === "notice") renderCourseNotices(c, subBox);
  else if (runSub === "open") renderOpenClass(c, subBox);
  else if (runSub === "assess") renderCourseAssignments(c, subBox);
  else renderLearning(c, subBox);
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

/* 공지사항: 이 강좌 수강생에게 */
async function renderCourseNotices(c, box) {
  const { notices } = await api(`/api/courses/${c.id}/notices`);
  const title = h("input", { maxlength: 120, placeholder: "제목 (예: 다음 주 수업은 줌 대신 외솔온닷에서 해요)" });
  const body = h("textarea", { rows: 4, maxlength: 10000, placeholder: "내용" });
  let editId = null;
  const submit = h("button", { class: "primary", type: "button" }, "공지 올리기");
  const reset = () => { editId = null; title.value = ""; body.value = ""; submit.textContent = "공지 올리기"; };
  submit.onclick = async () => {
    if (!title.value.trim()) { title.focus(); return; }
    try {
      await api(`/api/courses/${c.id}/notices`, { id: editId, title: title.value, body: body.value });
      toast(editId ? "공지를 고쳤어요." : "공지를 올렸어요. 수강생 마이페이지에 보여요.");
      renderCourseNotices(c, box);
    } catch (err) { toast(err.message); }
  };
  fill(box, 
    h("div", { class: "course-form" }, h("label", { class: "wide" }, "제목", title), h("label", { class: "wide" }, "내용", body),
      h("div", { class: "row wide" }, submit, h("button", { type: "button", onclick: reset }, "새로 쓰기"),
        h("span", { class: "muted", style: "font-size:0.85rem" }, `수강 확정 학생 ${c.approved}명에게 보여요.`))),
    h("div", { class: "course-notices" }, notices.length ? notices.map((n) => h("details", { class: "box" },
      h("summary", {}, h("strong", {}, n.title), h("span", { class: "muted", style: "font-size:0.85rem" }, ` · ${fmtDate(n.date)}${n.author ? ` · ${n.author}` : ""}`)),
      h("p", { style: "white-space:pre-wrap;margin:8px 0" }, n.body || ""),
      h("div", { class: "row" },
        h("button", { class: "small", onclick: () => { editId = n.id; title.value = n.title; body.value = n.body; submit.textContent = "고친 내용 저장"; title.focus(); } }, "고치기"),
        h("button", { class: "small danger", onclick: async () => {
          if (!confirm(`'${n.title}' 공지를 지울까요?`)) return;
          await api(`/api/courses/${c.id}/notices/${n.id}/delete`, {});
          renderCourseNotices(c, box);
        } }, "지우기")))) : h("p", { class: "muted" }, "아직 올린 공지가 없어요.")));
}

/* 수업 열기: 열린 수업이 있으면 들어가기, 없으면 회차 이름으로 바로 열기 */
async function renderOpenClass(c, box) {
  const { classes } = await api("/api/live/my-classes");
  const open = classes.filter((x) => x.course_id === c.id);
  const t = today();
  const next = (c.sessions || []).find((s) => s.date >= t);
  const name = h("input", { maxlength: 60, value: next ? `${next.no}회차${next.topic && next.topic !== `${next.no}회차` ? ` · ${next.topic}` : ""}` : "", placeholder: "수업 주제 (예: 3차시 헌법과 기본권)" });
  const notYet = c.pending || 0;
  if (c.approval !== "approved") {
    fill(box, approvalNote(c));
    return;
  }
  fill(box, 
    open.length ? h("div", { class: "banner ok" }, h("strong", {}, "진행 중인 수업"), ...open.map((x) =>
      h("a", { class: "button small primary", href: `/live/teacher/${x.code}` }, `▶ ${x.title} 들어가기`))) : null,
    c.archived ? h("p", { class: "muted" }, "보관한 강좌에는 수업을 열 수 없어요. '보관 해제'를 먼저 눌러 주세요.") : h("div", { class: "open-box" },
      h("label", { class: "grow" }, "수업 주제", name),
      h("button", { class: "primary big", onclick: async () => {
        if (notYet && !confirm(`아직 수강 확정이 안 된 학생이 ${notYet}명 있어요. 이 학생들은 들어올 수 없어요. '수강생 관리'에서 먼저 승인하는 게 좋아요.\n\n그래도 지금 수업을 열까요?`)) return;
        try {
          const res = await api("/api/live/classes", { title: name.value.trim() || c.title, course_id: c.id });
          location.href = `/live/teacher/${res.code}`;
        } catch (err) { toast(err.message); }
      } }, "▶ 지금 온라인 수업 열기")),
    notYet ? h("p", { class: "muted", style: "font-size:0.9rem" }, `⚠️ 승인 대기 ${notYet}명은 아직 못 들어와요.`) : null,
    next ? h("p", {}, `다음 회차: ${next.no}회차 ${fmtDate(next.date)} ${next.start || ""}~${next.end || ""}${next.topic ? ` · ${next.topic}` : ""}`) : null,
    courseFacts({ sessions: c.sessions }));
}

/* ───── 학습 관리: 위에 [수업참석률][공지][설문][퀴즈][활동] 요약, 누르면 수업별 목록 → 수업을 누르면 학생별 내역 ───── */

const learnState = {}; // 과목별: { card, open: Set(펼친 수업) }
const ACT_LABEL = { survey: "설문", quiz: "퀴즈", activity: "활동" };
const ACT_KINDS = { survey: ["poll"], quiz: ["ox", "choice"], activity: ["text"] };

async function renderLearning(c, box) {
  const st = learnState[c.id] ||= { card: "attend", open: new Set() };
  let d;
  try { d = await api(`/api/courses/${c.id}/learning`); } catch (err) { fill(box, h("p", { class: "error" }, err.message)); return; }
  d.classes.reverse(); // 첫 수업(연번 1)부터 차례로
  const S = d.summary;
  const pct = (v) => (v == null ? "-" : `${v}%`);
  const cards = [
    ["attend", "🙋 수업참석률", pct(S.attendance), `수업 ${S.classes}회 · 수강생 ${S.enrolled}명`],
    ["notice", "📢 공지", `${S.notices}회`, `수업 중 ${S.class_notices} · 공지사항 ${S.course_notices}`],
    ["survey", "📊 설문", `${S.survey.count}회`, `응답률 ${pct(S.survey.rate)} · ${S.survey.classes}개 수업`],
    ["quiz", "✅ 퀴즈", `${S.quiz.count}회`, `응답률 ${pct(S.quiz.rate)} · ${S.quiz.classes}개 수업`],
    ["activity", "✍️ 활동", `${S.activity.count}회`, `참여율 ${pct(S.activity.rate)} · ${S.activity.classes}개 수업`],
  ];
  const detail = h("div", { class: "learn-detail" });
  fill(box,
    h("div", { class: "learn-cards" }, cards.map(([k, label, big, small]) => h("button", { type: "button", class: `learn-card ${st.card === k ? "on" : ""}`,
      onclick: () => { st.card = k; st.open.clear(); renderLearning(c, box); } },
      h("span", { class: "lc-label" }, label), h("strong", { class: "lc-big" }, big), h("span", { class: "lc-small" }, small)))),
    detail);
  if (!d.classes.length && st.card !== "notice") { fill(detail, h("p", { class: "muted" }, "아직 연 수업이 없어요. '수업 열기'에서 수업을 열면 여기에 쌓여요.")); return; }
  if (st.card === "attend") learnAttendance(d, st, detail);
  else if (st.card === "notice") learnNotices(d, detail);
  else learnActivities(d, st, st.card, detail);
}

/** 펼침 줄: 버튼을 누르면 표 아래에 내용을 그린다 */
function toggleRow(st, id, draw) {
  if (st.open.has(id)) st.open.delete(id); else st.open.add(id);
  draw();
}

function learnAttendance(d, st, box) {
  const COLS = 7;
  const draw = () => fill(box,
    h("h3", { class: "section-title", style: "margin:4px 0 8px" }, `🙋 수업별 출석 (수강생 ${d.summary.enrolled}명)`),
    h("div", { class: "table-wrap" }, h("table", { class: "att log-table" },
      h("thead", {}, h("tr", {}, ["연번", "날짜", "시각", "수업 주제", "참여 학생", "출석률", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, d.classes.flatMap((x, i) => {
        const open = st.open.has(x.id);
        const sub = h("td", { colspan: COLS });
        const row = h("tr", { class: open ? "on" : "" },
          h("td", { class: "num" }, i + 1), h("td", {}, fmtDate(x.date)),
          h("td", {}, `${x.start} ~ ${x.end || (x.live ? "진행 중" : "")}`), h("td", {}, x.title),
          h("td", { class: "num" }, `${x.attended}명${d.summary.enrolled ? ` / ${d.summary.enrolled}명` : ""}`),
          h("td", { class: "num" }, h("strong", {}, x.rate == null ? "-" : `${x.rate}%`)),
          h("td", {}, h("button", { class: `small ${open ? "on" : ""}`, onclick: () => toggleRow(st, x.id, draw) }, open ? "접기" : "출결 확인")));
        if (open) attendanceOf(x.id, sub);
        return open ? [row, h("tr", { class: "detail-row" }, sub)] : [row];
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

function learnActivities(d, st, key, box) {
  const label = ACT_LABEL[key];
  const list = d.classes.filter((x) => x.acts[key].count);
  const COLS = 7;
  const rate = (x) => (x.possible ? `${Math.round((x.answered / x.possible) * 100)}%` : "-");
  const draw = () => fill(box,
    h("h3", { class: "section-title", style: "margin:4px 0 8px" }, `${label}을(를) 한 수업 ${list.length}개`),
    list.length ? h("div", { class: "table-wrap" }, h("table", { class: "att log-table" },
      h("thead", {}, h("tr", {}, ["연번", "날짜", "시각", "수업 주제", `${label} 수`, key === "activity" ? "참여율" : "응답률", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, list.flatMap((x, i) => {
        const open = st.open.has(x.id);
        const sub = h("td", { colspan: COLS });
        const row = h("tr", { class: open ? "on" : "" },
          h("td", { class: "num" }, i + 1), h("td", {}, fmtDate(x.date)), h("td", {}, x.start),
          h("td", {}, x.title), h("td", { class: "num" }, `${x.acts[key].count}개`),
          h("td", { class: "num" }, h("strong", {}, rate(x.acts[key]))),
          h("td", {}, h("button", { class: `small ${open ? "on" : ""}`, onclick: () => toggleRow(st, x.id, draw) }, open ? "접기" : "내역 보기")));
        if (open) activitiesOf(x.id, key, sub);
        return open ? [row, h("tr", { class: "detail-row" }, sub)] : [row];
      })))) : h("p", { class: "muted" }, `아직 ${label}을(를) 한 수업이 없어요. 수업 화면의 '📊 설문/퀴즈'에서 낼 수 있어요.`));
  draw();
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
    h("div", { class: "row" }, h("button", { class: "small", onclick: () => { detailTarget = full; loadDetail(classId); } }, "✏️ 채점·피드백 (점수 고치기·학생에게 공개)")),
    full);
}

/* ───────────────────────── 거점학교 운영: [강의교사 승인] [학생 관리] ───────────────────────── */

async function loadHub() {
  const [inst, ov, log] = await Promise.all([
    api("/api/staff/applications?role=instructor"), api("/api/hub/overview"), api("/api/hub/class-log")]);
  inst.applications.forEach((x) => { x.role = "instructor"; });
  const waitCourses = ov.courses.filter((c) => c.approval === "pending");
  const waitStaff = inst.applications.filter((x) => x.status === "pending").length;
  const badge = waitCourses.length + waitStaff;
  $("#hub-badge").textContent = badge;
  $("#hub-badge").hidden = !badge;
  const box = h("div");
  const subs = [["approve", `강의교사 승인${badge ? ` (${badge})` : ""}`], ["students", "학생 관리"]];
  fill($("#hub-list"),
    h("nav", { class: "tabs sub-tabs" }, subs.map(([k, label]) => h("button", { class: hubSub === k ? "active" : "",
      onclick: () => { hubSub = k; loadHub(); } }, label))),
    box);
  if (hubSub === "approve") fill(box, ...hubApprove(ov, inst));
  else fill(box, ...hubStudents(ov, log.classes));
}

/** 강의교사 승인: 강좌 개설 신청 · 강의교사 등록 (참여학교 담당자는 전체 관리자가 승인) */
function hubApprove(ov, inst) {
  const decide = async (c, action) => {
    let note = "";
    if (action === "reject") {
      note = prompt(`'${c.title}' 강좌 개설을 반려하는 사유 (강사에게 보여요)`, "");
      if (note === null) return;
    } else if (!confirm(`'${c.title}' 강좌 개설을 승인할까요? 승인하면 모집 기간에 학생들이 수강신청할 수 있어요.`)) return;
    try {
      await api(`/api/hub/courses/${c.id}/approval`, { action, note });
      toast(action === "approve" ? "강좌 개설을 승인했어요." : "반려했어요. 강사가 고치면 다시 올라와요.");
      loadHub();
    } catch (err) { toast(err.message); }
  };
  const courseCard = (c) => h("div", { class: "box", style: "margin-bottom:10px" },
    h("div", { class: "row" }, h("strong", { class: "grow" }, c.title), approvalBadge(c) || h("span", { class: "status approved" }, "개설 승인")),
    courseInfo(c), courseFacts(c),
    c.description ? h("details", { class: "course-more" }, h("summary", {}, "수업 소개"), h("p", { style: "white-space:pre-wrap" }, c.description)) : null,
    c.approval === "rejected" && c.approval_note ? h("p", { class: "muted", style: "font-size:0.9rem" }, `반려 사유: ${c.approval_note}`) : null,
    h("div", { class: "row", style: "margin-top:6px" },
      c.approval !== "approved" ? h("button", { class: "primary", onclick: () => decide(c, "approve") }, "개설 승인") : null,
      c.approval !== "rejected" ? h("button", { class: c.approval === "approved" ? "small" : "", onclick: () => decide(c, "reject") },
        c.approval === "approved" ? "승인 취소(반려)" : "반려") : null));
  const pending = ov.courses.filter((c) => c.approval === "pending");
  const done = ov.courses.filter((c) => c.approval !== "pending");
  return [
    h("h2", { style: "margin:8px 0" }, `📋 강좌 개설 신청${pending.length ? ` (${pending.length}건 대기)` : ""}`),
    pending.length ? pending.map(courseCard) : h("p", { class: "muted" }, "승인을 기다리는 강좌가 없어요."),
    done.length ? h("details", {}, h("summary", { class: "muted" }, `처리한 강좌 ${done.length}개`), done.map(courseCard)) : null,
    h("div", { style: "margin-top:24px" }, staffBoard("hub", inst.applications, inst.today, loadHub, "👩‍🏫 강의교사 등록")),
  ];
}

/** 학생 관리: 강좌별 수강생과 수업 기록(언제 수업했는지). '학생들이 듣고 싶은 과목'은 메인 화면에 */
function hubStudents(ov, classes) {
  const byCourse = new Map();
  for (const x of classes) {
    if (!byCourse.has(x.course_id)) byCourse.set(x.course_id, []);
    byCourse.get(x.course_id).push(x);
  }
  const courses = ov.courses.filter((c) => c.approval === "approved");
  const card = (c) => {
    const ok = ov.enrollments.filter((e) => e.course_id === c.id && e.status === "approved");
    const log = byCourse.get(c.id) || [];
    return h("details", { class: "box", style: "margin-bottom:10px" },
      h("summary", {}, h("strong", {}, c.title), h("span", { class: "muted" }, ` · 강사 ${c.instructor} · ${fmtDate(c.start_date)} ~ ${fmtDate(c.end_date)}`),
        h("span", {}, ` · 수강 ${ok.length}명 · 수업 ${log.length}회`), c.archived ? h("span", { class: "muted" }, " (보관됨)") : null),
      h("h3", { class: "section-title", style: "margin:10px 0 6px" }, `🕒 수업 기록 ${log.length}회`),
      log.length ? h("div", { class: "table-wrap" }, h("table", { class: "att log-table" },
        h("thead", {}, h("tr", {}, ["연번", "날짜", "시각", "길이", "수업 주제", "참여"].map((t) => h("th", {}, t)))),
        h("tbody", {}, log.map((x, i) => h("tr", {},
          h("td", { class: "num" }, log.length - i), h("td", {}, fmtDate(x.date)),
          h("td", {}, `${x.start} ~ ${x.end || (x.live ? "진행 중" : "")}`),
          h("td", { class: "num" }, x.minutes != null ? `${x.minutes}분` : "-"),
          h("td", {}, x.title), h("td", { class: "num" }, `${x.attended}명`)))))) : h("p", { class: "muted" }, "아직 연 수업이 없어요."),
      h("h3", { class: "section-title", style: "margin:12px 0 6px" }, `🎒 수강생 ${ok.length}명`),
      ok.length ? h("div", { class: "muted", style: "font-size:0.9rem" },
        ok.map((e) => `${e.student_no || "-"} ${e.name}${e.school ? `(${e.school})` : ""}`).join(", ")) : h("p", { class: "muted" }, "아직 수강생이 없어요."));
  };
  return [
    h("h2", { style: "margin:8px 0" }, "📚 강좌별 수업 기록·수강생"),
    courses.length ? courses.map(card) : h("p", { class: "muted" }, "아직 개설 승인한 강좌가 없어요."),
  ];
}

/* ───────────────────────── 참여학교 담당: 우리 학교 수강생 관리 · 탈퇴 승인 ───────────────────────── */

let schoolData = null; // 참여학교 담당: 우리 학교 학생
const schoolPick = new Set(); // 체크한 학생 id
const schoolOpen = new Set(); // 수강 강좌를 펼친 학생
const schoolQ = {};

/** 참여학교 담당 = 수강생 관리: 수업신청자 관리와 같은 검색 칸 + 학생 목록(이름을 누르면 들은 강좌) + 탈퇴 승인 */
async function loadSchool() {
  const box = $("#school-list");
  if (!schoolData) fill(box, h("p", { class: "muted" }, "불러오는 중…"));
  schoolData = await api("/api/school/overview");
  const quits = schoolData.withdrawals.length;
  $("#school-badge").textContent = quits;
  $("#school-badge").hidden = !quits;
  schoolPick.clear();
  const all = schoolData.students.flatMap((x) => x.courses);
  const terms = koSort(new Set(all.map((c) => c.term).filter(Boolean)));
  const schools = koSort(new Set(schoolData.students.map((x) => x.school).filter(Boolean)));
  const f = {
    term: h("select", {}, h("option", { value: "" }, "전체"), terms.map((t) => h("option", { value: t }, t))),
    subject: h("input", { placeholder: "예: 법과 사회" }),
    status: h("select", {}, h("option", { value: "" }, "전체"), koSort(Object.entries(ENROLL_NAME), (x) => x[1]).map(([k, v]) => h("option", { value: k }, v)),
      h("option", { value: "none" }, "수강신청 없음")),
    teacher: h("input", { placeholder: "담당교사 이름" }),
    school: h("select", {}, h("option", { value: "" }, "전체"), schools.map((x) => h("option", { value: x }, x))),
    name: h("input", { placeholder: "학생 이름" }),
    quit: h("select", {}, h("option", { value: "" }, "전체"), h("option", { value: "yes" }, "탈퇴 신청한 학생"),
      h("option", { value: "done" }, "탈퇴한 학생 (탈퇴 완료)"), h("option", { value: "no" }, "탈퇴하지 않은 학생")),
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
    schoolPick.clear();
    drawSchoolResult(result);
  };
  for (const el of Object.values(f)) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  const row = (...cells) => h("div", { class: "sf-row" }, ...cells.flat());
  const cell = (label, el, wide) => [h("div", { class: "sf-label" }, label), h("div", { class: `sf-field ${wide ? "wide" : ""}` }, el)];
  fill(box,
    h("h2", { style: "margin:0 0 6px" }, "수강생 관리"),
    h("p", { class: "muted", style: "margin:0 0 10px;font-size:0.9rem" }, ME.is_admin && !schoolData.schools.length ? "전체 관리자: 모든 학교 학생이 보여요."
      : `${schoolData.schools.join(", ")} 학생만 보여요 (학생이 가입할 때 고른 소속 학교 기준). 학생 이름을 누르면 지금까지 들은 강좌가 보여요.`),
    quits ? h("div", { class: "banner warn", style: "margin-bottom:10px" }, h("span", { class: "grow" }, `🚪 탈퇴를 신청한 학생이 ${quits}명 있어요.`),
      h("button", { class: "small", onclick: () => { for (const k of Object.keys(schoolQ)) delete schoolQ[k]; schoolQ.quit = "yes"; loadSchool(); } }, "탈퇴 신청만 보기")) : null,
    h("div", { class: "search-form" },
      row(cell("교육과정", f.term), cell("과목", f.subject)),
      row(cell("신청상태", f.status), cell("담당교사", f.teacher)),
      row(cell("소속학교", f.school), cell("학생이름", f.name)),
      row(cell("탈퇴", f.quit, true)),
      row(cell("기간검색", h("div", { class: "row" }, f.from, "~", f.to,
        ...[["오늘", 0], ["7일", 7], ["1개월", 30], ["6개월", 182]].map(([label, d]) => h("label", { class: "switch" },
          h("input", { type: "radio", name: "school-quick", onchange: () => quick(d) }), label))), true))),
    h("div", { class: "row", style: "justify-content:center;margin:12px 0 20px" },
      h("button", { type: "button", onclick: () => { for (const k of Object.keys(schoolQ)) delete schoolQ[k]; loadSchool(); } }, "초기화"),
      h("button", { class: "primary", type: "button", onclick: search }, "검색")),
    result);
  drawSchoolResult(result);
}

/** 검색 조건에 맞는 강좌가 있는 학생 (강좌 조건이 없으면 모든 학생) */
function filteredSchool() {
  const q = schoolQ;
  const has = (v, w) => !w || (v || "").includes(w);
  const courseCond = q.term || q.subject || (q.status && q.status !== "none") || q.teacher || q.from || q.to;
  const okCourse = (c) => (!q.term || c.term === q.term) && (has(c.subject, q.subject) || has(c.title, q.subject))
    && (!q.status || q.status === "none" || c.status === q.status) && has(c.instructor, q.teacher)
    && (!q.from || kstDate(c.requested_at) >= q.from) && (!q.to || kstDate(c.requested_at) <= q.to);
  const live = schoolData.students.filter((x) => has(x.name, q.name) && (!q.school || x.school === q.school)
    && (q.quit !== "yes" || x.withdraw) && q.quit !== "done" && (q.status !== "none" || !x.courses.length)
    && (!courseCond || x.courses.some(okCourse)));
  // 탈퇴한 학생은 계정·기록이 지워지고 탈퇴 기록만 남는다 → 강좌 조건으로는 찾지 않는다
  const gone = courseCond || q.status || ["yes", "no"].includes(q.quit) ? [] : schoolData.withdrawn
    .filter((x) => has(x.name, q.name) && (!q.school || x.school === q.school))
    .map((x) => ({ ...x, gone: true, user_id: `w${x.id}`, courses: [] }));
  return [...live, ...gone];
}

function drawSchoolResult(box) {
  const list = filteredSchool();
  const quitsById = new Map(schoolData.withdrawals.map((w) => [w.user_id, w]));
  const decide = async (action, only) => {
    const picked = only ? [only] : list.filter((x) => schoolPick.has(x.user_id) && !x.gone);
    if (!picked.length) { toast("먼저 학생을 체크해 주세요."); return; }
    const asked = picked.filter((x) => x.withdraw);
    if (!asked.length) { toast("체크한 학생 중 탈퇴를 신청한 학생이 없어요."); return; }
    const skip = picked.length - asked.length;
    let note = "";
    if (action === "approve") {
      const studying = asked.filter((x) => quitsById.get(x.user_id)?.studying.length);
      if (!confirm(`${asked.length}명의 탈퇴를 승인할까요?${skip ? ` (탈퇴를 신청하지 않은 ${skip}명은 건너뛰어요)` : ""}\n` +
        (studying.length ? `⚠️ 아직 수강 중인 학생: ${studying.map((x) => x.name).join(", ")}\n` : "") +
        "출결·활동·점수 등 이 학생들의 기록이 모두 지워지고 되살릴 수 없어요.")) return;
    } else {
      note = prompt(`${asked.length}명의 탈퇴 신청을 반려해요. 사유 (학생에게 보여요)`, "");
      if (note === null) return;
    }
    let ok = 0;
    for (const x of asked) {
      try { await api(`/api/school/withdrawals/${x.user_id}`, { action, note }); ok++; } catch (err) { toast(err.message); }
    }
    toast(action === "approve" ? `${ok}명의 탈퇴를 승인했어요.` : `${ok}명의 탈퇴 신청을 반려했어요.`);
    loadSchool();
  };
  const csv = () => {
    const head = ["번호", "학생이름", "학번", "학년", "반", "소속학교", "교육과정", "과목", "거점학교", "담당교사", "신청일", "신청상태", "탈퇴"];
    const lines = list.flatMap((x, i) => (x.courses.length ? x.courses : [null]).map((c) => [list.length - i, x.name, x.student_no,
      x.grade || "", x.class_no || "", x.school, c?.term || "", c?.subject || "", c?.hub || "", c?.instructor || "",
      c ? kstDate(c.requested_at) : "", c ? ENROLL_NAME[c.status] || c.status : x.gone ? "-" : "수강신청 없음",
      x.gone ? `탈퇴 완료 (${kstDate(x.approved_at)})` : x.withdraw ? "신청" : ""]));
    const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const text = "﻿" + [head, ...lines].map((r) => r.map(esc).join(",")).join("\r\n");
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })), download: `우리학교_수강생_${today()}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  };
  const all = h("input", { type: "checkbox", onchange: (e) => {
    for (const x of list) { if (x.gone) continue; if (e.target.checked) schoolPick.add(x.user_id); else schoolPick.delete(x.user_id); }
    box.querySelectorAll("tbody input[type=checkbox]").forEach((c) => { c.checked = e.target.checked; });
  } });
  const COLS = 10;
  const rows = list.flatMap((x, i) => {
    const open = schoolOpen.has(x.user_id);
    const w = quitsById.get(x.user_id);
    if (x.gone) {
      return [h("tr", { class: "gone-row", title: x.approved_by ? `${x.approved_by} 선생님이 탈퇴 승인` : "" },
        h("td", {}), h("td", { class: "num" }, list.length - i), h("td", {}, x.name), h("td", {}, x.student_no || "-"),
        h("td", { class: "num" }, x.grade ? `${x.grade}학년` : "-"), h("td", { class: "num" }, x.class_no ? `${x.class_no}반` : "-"),
        h("td", {}, x.school || "-"), h("td", { class: "num" }, "-"), h("td", { class: "num" }, "-"),
        h("td", {}, h("span", { class: "status rejected", title: x.reason ? `사유: ${x.reason}` : "" }, `탈퇴 완료 (${kstDate(x.approved_at)})`)))];
    }
    const main = h("tr", { class: open ? "open-row" : "" },
      h("td", {}, h("input", { type: "checkbox", checked: schoolPick.has(x.user_id), onchange: (e) => {
        if (e.target.checked) schoolPick.add(x.user_id); else schoolPick.delete(x.user_id);
      } })),
      h("td", { class: "num" }, list.length - i),
      h("td", {}, h("button", { class: "link-btn name-btn", title: "들은 강좌 보기", onclick: () => {
        if (open) schoolOpen.delete(x.user_id); else schoolOpen.add(x.user_id);
        drawSchoolResult(box);
      } }, `${open ? "▾" : "▸"} ${x.name}`)),
      h("td", {}, x.student_no || "-"),
      h("td", { class: "num" }, x.grade ? `${x.grade}학년` : "-"), h("td", { class: "num" }, x.class_no ? `${x.class_no}반` : "-"),
      h("td", {}, x.school || "-"),
      h("td", { class: "num" }, `${x.courses.filter((c) => c.status === "approved").length}개`),
      h("td", { class: "num" }, `${x.courses.filter((c) => c.status === "pending").length || "-"}`),
      h("td", {}, x.withdraw ? h("div", { class: "quit-cell" },
        h("span", { class: "status pending", title: x.withdraw_reason ? `사유: ${x.withdraw_reason}` : "" },
          `탈퇴 신청${x.withdraw_at ? ` (${kstDate(x.withdraw_at)})` : ""}`),
        h("button", { class: "small danger", onclick: () => decide("approve", x) }, "승인"),
        h("button", { class: "small", onclick: () => decide("reject", x) }, "반려")) : "-"));
    if (!open) return [main];
    const detail = h("tr", { class: "detail-row" }, h("td", { colspan: COLS },
      w ? h("div", { class: "banner warn", style: "margin:0 0 8px" },
        `🚪 ${kstDate(w.requested_at)} 탈퇴 신청${w.reason ? ` · 사유: ${w.reason}` : ""}`,
        w.studying.length ? ` · ⚠️ 아직 수강 중: ${w.studying.join(", ")}` : "") : null,
      x.courses.length ? h("table", { class: "att inner-table" },
        h("thead", {}, h("tr", {}, ["교육과정", "과목", "거점학교", "담당교사", "신청일", "상태"].map((t) => h("th", {}, t)))),
        h("tbody", {}, koSort(x.courses, (c) => `${c.term} ${c.subject}`).map((c) => h("tr", {},
          h("td", {}, c.term || "-"), h("td", {}, c.subject, c.archived ? h("span", { class: "muted" }, " (끝남)") : null),
          h("td", {}, c.hub || "-"), h("td", {}, c.instructor || "-"), h("td", {}, kstDate(c.requested_at)),
          h("td", {}, h("span", { class: `status ${c.status}` }, ENROLL_NAME[c.status] || c.status))))))
        : h("p", { class: "muted", style: "margin:4px 0" }, "아직 수강신청한 강좌가 없어요.")));
    return [main, detail];
  });
  fill(box,
    h("div", { class: "row", style: "margin-bottom:8px" },
      h("strong", {}, "총 ", h("span", { class: "accent-text" }, list.length), "명"),
      h("span", { class: "muted", style: "font-size:0.85rem" }, "체크한 학생 한꺼번에:"),
      h("button", { class: "small danger", onclick: () => decide("approve") }, "탈퇴 승인"),
      h("button", { class: "small", onclick: () => decide("reject") }, "탈퇴 반려"),
      h("span", { class: "grow" }),
      h("button", { class: "small", onclick: csv, disabled: !list.length }, "📥 엑셀 다운로드")),
    h("div", { class: "table-wrap" }, h("table", { class: "att enroll-table" },
      h("thead", {}, h("tr", {}, h("th", {}, all), ["번호", "학생이름", "학번", "학년", "반", "소속학교", "수강 확정", "승인 대기", "탈퇴"].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows.length ? rows
        : h("tr", {}, h("td", { colspan: COLS, class: "muted", style: "text-align:center;padding:24px" }, "조건에 맞는 학생이 없어요."))))));
}
