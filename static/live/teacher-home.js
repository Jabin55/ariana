/* 선생님 마이페이지: [특강/회의] [강좌 개설] [수강생 관리] [강좌 운영] [거점학교 운영] [참여학교 운영] (+ 전체 관리) */

let teacherCourses = null; // 아직 못 불러왔으면 null
const editing = new Set(); // 정보 수정 중인 강좌
let runCourseId = null; // 강좌 운영에서 연 강좌
let runSub = "notice"; // 그 강좌 안의 칸: notice(공지사항) open(수업 열기) record(수업 기록) activity(활동 관리)
let hubSub = "approve"; // 거점학교 운영 안의 칸: approve(강의교사 승인) students(학생 관리)
let detailTarget = null; // 수업 기록(출결·채점)을 그릴 자리
function detailEl() { return detailTarget || $("#run-detail"); }

function today() {
  // 기록은 한국 시간 날짜로 나뉜다 (기기 시간대와 상관없이)
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** replaceChildren에 null·false가 섞여도 글자로 찍히지 않게 */
function fill(box, ...kids) { box.replaceChildren(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false && x !== "")); }

/* 권한: 강의교사는 [특강/회의]~[강좌 운영], 거점학교 관리교사는 [거점학교 운영], 참여학교 교사는 [참여학교 운영].
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
    fill(box, h("p", { class: "muted" }, "팀티칭 보조교사로 승인받았어요. 주강사가 강좌를 열 때 보조교사로 넣으면 '강좌 운영'에 그 강좌가 나타나요."));
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
    title: h("input", { placeholder: "수업명 일부" }),
    status: h("select", {}, h("option", { value: "" }, "전체"), koSort(Object.entries(ENROLL_NAME), (x) => x[1]).map(([k, v]) => h("option", { value: k }, v))),
    teacher: h("input", { placeholder: "담당교사 이름" }),
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
    h("h2", { style: "margin:0 0 10px" }, "수업신청자 관리"),
    h("div", { class: "search-form" },
      row(cell("교육과정", f.term), cell("과목", f.subject)),
      row(cell("수업명", f.title), cell("신청상태", f.status)),
      row(cell("담당교사", f.teacher, true)),
      row(cell("소속학교정보", f.school), cell("학생이름", f.name)),
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
  return enrollRows.filter((x) => (!q.term || x.term === q.term) && has(x.subject, q.subject) && has(x.course_title, q.title)
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
    const head = ["번호", "교육과정", "과목", "수업명", "거점학교", "담당교사", "학생이름", "학번", "학년", "반", "소속학교정보", "신청일", "신청상태"];
    const lines = list.map((x, i) => [list.length - i, x.term, x.subject, x.course_title, x.hub_school, x.instructor, x.name, x.student_no,
      x.grade || "", x.class_no || "", x.school, kstDate(x.requested_at), ENROLL_NAME[x.status] || x.status]);
    const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const text = "﻿" + [head, ...lines].map((r) => r.map(esc).join(",")).join("\r\n");
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })), download: `수업신청자_${today()}.csv` });
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
      h("thead", {}, h("tr", {}, h("th", {}, all), ["번호", "과목", "수업명", "거점학교", "담당교사", "학생이름", "학년", "반", "소속학교정보", "신청일", "신청상태"].map((t) => h("th", {}, t)))),
      h("tbody", {}, list.length ? list.map((x, i) => h("tr", {},
        h("td", {}, h("input", { type: "checkbox", checked: enrollPick.has(key(x)), onchange: (e) => {
          if (e.target.checked) enrollPick.add(key(x)); else enrollPick.delete(key(x));
        } })),
        h("td", { class: "num" }, list.length - i), h("td", {}, x.subject), h("td", {}, x.course_title),
        h("td", {}, x.hub_school), h("td", {}, x.instructor), h("td", {}, x.name),
        h("td", { class: "num" }, x.grade ? `${x.grade}학년` : "-"), h("td", { class: "num" }, x.class_no ? `${x.class_no}반` : "-"),
        h("td", {}, x.school || "-"), h("td", {}, kstDate(x.requested_at)),
        h("td", {}, h("span", { class: `status ${x.status === "rejected" ? "rejected" : x.status}`, title: x.note ? `사유: ${x.note}` : "" },
          ENROLL_NAME[x.status] || x.status))))
        : h("tr", {}, h("td", { colspan: 12, class: "muted", style: "text-align:center;padding:24px" }, "조건에 맞는 수강신청이 없어요."))))));
}

/* ───────────────────────── 강좌 운영 ───────────────────────── */

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
    h("p", { class: "muted", style: "margin:0 0 10px" }, "강좌를 누르면 공지사항·수업 열기·수업 기록·활동 관리를 볼 수 있어요."),
    active.length ? grid(active) : h("p", { class: "muted" }, "아직 개설한 강좌가 없어요. '강좌 개설'에서 먼저 강좌를 만들어 주세요."),
    archived.length ? h("details", { style: "margin-top:16px" }, h("summary", { class: "muted" }, `보관한 강좌 ${archived.length}개`), grid(archived)) : null);
}

function renderRunCourse(c) {
  const update = async (values) => { await api(`/api/courses/${c.id}`, values); loadTeacherCourses(); };
  const subBox = h("div", { class: "run-sub" });
  const subs = [["notice", "📢 공지사항"], ["open", "▶ 수업 열기"], ["record", "📋 수업 기록"], ["activity", "📝 활동 관리"]];
  fill($("#run-course"), 
    h("div", { class: "row" },
      h("button", { class: "small", onclick: () => { runCourseId = null; renderRun(); } }, "← 강좌 목록"),
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
    c.locked ? h("p", { class: "error" }, `${c.hub_school} 강사 활동 기간이 아니라서 이 강좌를 관리하거나 수업을 열 수 없어요. 계속 강의하려면 '강좌 개설' 탭의 '다른 거점학교·역할 신청'으로 다시 신청하세요.`) : null,
    editing.has(c.id) && !c.locked ? courseEditForm(c) : h("details", { class: "course-more" }, h("summary", {}, "강좌 정보 자세히"), courseFacts(c),
      c.description ? h("p", { class: "muted", style: "white-space:pre-wrap" }, c.description) : null),
    c.locked ? null : h("nav", { class: "tabs sub-tabs" }, subs.map(([k, label]) => h("button", { class: runSub === k ? "active" : "",
      onclick: () => { runSub = k; renderRunCourse(c); } }, label))),
    c.locked ? null : subBox);
  if (c.locked) return;
  if (runSub === "notice") renderCourseNotices(c, subBox);
  else if (runSub === "open") renderOpenClass(c, subBox);
  else if (runSub === "activity") renderCourseAssignments(c, subBox);
  else renderRecords(c, subBox);
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
  const name = h("input", { maxlength: 60, value: next ? `${next.no}회차${next.topic && next.topic !== `${next.no}회차` ? ` · ${next.topic}` : ""}` : "", placeholder: "수업 이름 (예: 3차시 헌법과 기본권)" });
  const notYet = c.pending || 0;
  if (c.approval !== "approved") {
    fill(box, approvalNote(c));
    return;
  }
  fill(box, 
    open.length ? h("div", { class: "banner ok" }, h("strong", {}, "진행 중인 수업"), ...open.map((x) =>
      h("a", { class: "button small primary", href: `/live/teacher/${x.code}` }, `▶ ${x.title} 들어가기`))) : null,
    c.archived ? h("p", { class: "muted" }, "보관한 강좌에는 수업을 열 수 없어요. '보관 해제'를 먼저 눌러 주세요.") : h("div", { class: "open-box" },
      h("label", { class: "grow" }, "수업 이름", name),
      h("button", { class: "primary big", onclick: async () => {
        if (notYet && !confirm(`아직 수강 확정이 안 된 학생이 ${notYet}명 있어요. 이 학생들은 들어올 수 없어요. '수강생 관리'에서 먼저 승인하는 게 좋아요.\n\n그래도 지금 수업을 열까요?`)) return;
        try {
          const res = await api("/api/live/classes", { title: name.value.trim() || c.title, course_id: c.id });
          location.href = `/live/teacher/${res.code}`;
        } catch (err) { toast(err.message); }
      } }, "▶ 지금 수업 열기")),
    h("p", { class: "muted", style: "font-size:0.9rem" }, `수강 확정 학생 ${c.approved}명은 마이페이지 '지금 들어갈 수 있는 수업'에서 바로 들어와요 (입장 코드 없음).`
      + (notYet ? ` ⚠️ 승인 대기 ${notYet}명은 아직 못 들어와요.` : "")),
    next ? h("p", {}, `다음 회차: ${next.no}회차 ${fmtDate(next.date)} ${next.start || ""}~${next.end || ""}${next.topic ? ` · ${next.topic}` : ""}`) : null,
    courseFacts({ sessions: c.sessions }));
}

/* 수업 기록: 연 수업을 연번을 달아 세로로 죽 나열. 누르면 그 수업 출결·채점·질문 */
async function renderRecords(c, box) {
  const detail = h("div");
  const { classes } = await api(`/api/courses/${c.id}/classes`);
  if (!classes.length) { fill(box, h("p", { class: "muted" }, "아직 연 수업이 없어요.")); return; }
  const n = classes.length;
  const rows = classes.map((x, i) => {
    const tr = h("tr", { class: "pick-row", "data-id": x.id, onclick: () => {
      for (const r of tr.parentNode.children) r.classList.toggle("on", r === tr);
      detailTarget = detail;
      loadDetail(x.id);
      detail.scrollIntoView({ behavior: "smooth", block: "start" });
    } },
    h("td", { class: "num" }, n - i), h("td", {}, fmtDate(x.date)),
    h("td", {}, `${x.start.slice(0, 5)} ~ ${x.ended_at ? fmtTime(x.ended_at) : x.live ? "진행 중" : ""}`),
    h("td", {}, x.title), h("td", { class: "num" }, `${x.attended}명`),
    h("td", {}, h("span", { class: "link" }, "출결 보기")));
    return tr;
  });
  fill(box, h("p", { class: "muted", style: "margin:0 0 8px" }, `모두 ${n}번 수업했어요. 줄을 누르면 그 수업의 출결·퀴즈 채점·질문이 아래에 나와요.`),
    h("div", { class: "table-wrap" }, h("table", { class: "att log-table" },
      h("thead", {}, h("tr", {}, ["연번", "날짜", "시각", "수업 이름", "참여", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows))),
    detail);
}

/* ───────────────────────── 거점학교 운영: [강의교사 승인] [학생 관리] ───────────────────────── */

async function loadHub() {
  const [inst, part, ov, log] = await Promise.all([
    api("/api/staff/applications?role=instructor"), api("/api/staff/applications?role=participant"),
    api("/api/hub/overview"), api("/api/hub/class-log")]);
  inst.applications.forEach((x) => { x.role = "instructor"; });
  part.applications.forEach((x) => { x.role = "participant"; });
  const waitCourses = ov.courses.filter((c) => c.approval === "pending");
  const waitStaff = [...inst.applications, ...part.applications].filter((x) => x.status === "pending").length;
  const badge = waitCourses.length + waitStaff;
  $("#hub-badge").textContent = badge;
  $("#hub-badge").hidden = !badge;
  const box = h("div");
  const subs = [["approve", `강의교사 승인${badge ? ` (${badge})` : ""}`], ["students", "학생 관리"]];
  fill($("#hub-list"),
    h("nav", { class: "tabs sub-tabs" }, subs.map(([k, label]) => h("button", { class: hubSub === k ? "active" : "",
      onclick: () => { hubSub = k; loadHub(); } }, label))),
    box);
  if (hubSub === "approve") fill(box, ...hubApprove(ov, inst, part));
  else fill(box, ...hubStudents(ov, log.classes));
}

/** 강의교사 승인: 강좌 개설 신청 · 강의교사 등록 · 참여학교 교사 등록 */
function hubApprove(ov, inst, part) {
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
    h("h2", { style: "margin:24px 0 0" }, "👩‍🏫 강의교사 등록"),
    staffSections(inst.applications, inst.today, loadHub, "강의교사"),
    h("h2", { style: "margin:24px 0 0" }, "🏫 참여학교 교사 등록"),
    h("p", { class: "muted", style: "font-size:0.9rem;margin:4px 0" }, "참여학교 교사는 자기 학교 학생의 수강 현황을 보고 학생 탈퇴를 승인해요. 그 학교 선생님이 맞는지 확인하고 승인해 주세요."),
    staffSections(part.applications, part.today, loadHub, "참여학교 교사"),
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
        h("thead", {}, h("tr", {}, ["연번", "날짜", "시각", "길이", "수업 이름", "참여"].map((t) => h("th", {}, t)))),
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

/* ───────────────────────── 참여학교 운영: 우리 학교 수강생 관리 · 탈퇴 승인 ───────────────────────── */

async function loadSchool() {
  const ov = await api("/api/school/overview");
  $("#school-badge").textContent = ov.withdrawals.length;
  $("#school-badge").hidden = !ov.withdrawals.length;
  const search = h("input", { placeholder: "이름·학번·강좌로 찾기", style: "max-width:260px" });
  const many = new Set(ov.students.map((x) => x.school)).size > 1;
  const STATUS = { approved: "수강 확정", pending: "강사 승인 대기" };
  const tbody = h("tbody");
  const draw = () => {
    const q = search.value.trim();
    const list = ov.students.filter((x) => !q || [x.name, x.student_no, x.school, ...x.courses.map((c) => c.title)].join(" ").includes(q));
    fill(tbody, list.map((x, i) => h("tr", {},
      h("td", { class: "num" }, i + 1),
      many ? h("td", {}, x.school || "-") : null,
      h("td", {}, x.student_no || "-"), h("td", {}, x.name, x.withdraw ? h("span", { class: "status pending" }, " 탈퇴 신청") : null),
      h("td", {}, x.courses.length ? x.courses.map((c) => h("div", {}, c.title,
        h("span", { class: "muted", style: "font-size:0.8rem" }, ` · ${c.instructor} · ${STATUS[c.status]}${c.archived ? " · 끝남" : ""}`)))
        : h("span", { class: "muted" }, "수강 강좌 없음")))));
    if (!list.length) tbody.append(h("tr", {}, h("td", { colspan: many ? 5 : 4, class: "muted" }, q ? "찾는 학생이 없어요." : "아직 가입한 학생이 없어요.")));
  };
  search.addEventListener("input", draw);
  draw();
  fill($("#school-list"),
    h("p", { class: "muted" }, ME.is_admin && !ov.schools.length ? "전체 관리자: 모든 학교 학생이 보여요."
      : `${ov.schools.join(", ")} 학생만 보여요 (학생이 가입할 때 고른 소속 학교 기준).`),
    h("h2", { style: "margin:8px 0" }, `🚪 탈퇴 신청${ov.withdrawals.length ? ` (${ov.withdrawals.length}명)` : ""}`),
    ov.withdrawals.length ? h("div", { class: "people" }, ov.withdrawals.map(withdrawRow)) : h("p", { class: "muted" }, "탈퇴 신청한 학생이 없어요."),
    h("div", { class: "row", style: "margin:24px 0 8px" }, h("h2", { class: "grow", style: "margin:0" }, `🎒 수강생 관리 · 우리 학교 학생 ${ov.students.length}명`), search),
    h("div", { class: "table-wrap" }, h("table", { class: "att" },
      h("thead", {}, h("tr", {}, ["연번", ...(many ? ["학교"] : []), "학번", "이름", "수강 강좌"].map((t) => h("th", {}, t)))), tbody)));
}

function withdrawRow(q) {
  const decide = async (action) => {
    let note = "";
    if (action === "approve" && !confirm(`${q.name} 학생의 탈퇴를 승인할까요?\n출결·활동·점수 등 이 학생의 기록이 모두 지워지고 되살릴 수 없어요.`)) return;
    if (action === "reject") { note = prompt(`${q.name} 학생의 탈퇴 신청을 반려하는 사유 (학생에게 보여요)`, ""); if (note === null) return; }
    try {
      await api(`/api/school/withdrawals/${q.user_id}`, { action, note });
      toast(action === "approve" ? "탈퇴를 승인했어요." : "반려했어요.");
      loadSchool();
    } catch (err) { toast(err.message); }
  };
  return h("div", { class: "person", style: "flex-wrap:wrap" }, h("span", { class: "dot" }),
    h("span", { class: "grow" }, `${q.student_no || "-"} ${q.name} `, h("span", { class: "muted", style: "font-size:0.8rem" }, `${q.school} · ${new Date(q.requested_at * 1000).toLocaleDateString("ko-KR")} 신청`),
      q.reason ? h("div", { style: "font-size:0.85rem" }, `사유: ${q.reason}`) : null,
      h("div", { class: "muted", style: "font-size:0.8rem" }, q.courses.length ? `신청한 강좌: ${q.courses.join(", ")}` : "수강신청한 강좌 없음"),
      q.studying.length ? h("div", { class: "status pending", style: "font-size:0.8rem" }, `⚠️ 아직 수강 중: ${q.studying.join(", ")} — 승인하면 이 강좌 출결·활동 기록도 지워져요`) : null),
    h("span", { class: "acts" }, h("button", { class: "danger", onclick: () => decide("approve") }, "탈퇴 승인"),
      h("button", { onclick: () => decide("reject") }, "반려")));
}
