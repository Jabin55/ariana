/* 선생님 교무실: [특강/회의] [과목 개설] [수강생 관리] [과목 운영] [거점학교 운영] [참여학교 담당] (+ 전체 운영 관리) */

let teacherCourses = null; // 아직 못 불러왔으면 null
const editing = new Set(); // 정보 수정 중인 강좌
let runCourseId = null; // 과목 운영에서 연 과목
let runSub = "notice"; // 그 과목 안의 칸: notice(공지사항) open(수업 열기) assess(평가 활동) learn(학습 관리)
let hubSub = "courses"; // 거점학교 운영: courses(강좌 개설) days(수업일) attendance(출석부). 강의교사 가입은 전체 관리자가 승인
let hubCourseId = null; // 강좌 개설 승인 목록에서 보고 있는 강좌
let hubRecordCourseId = null; // 수업일·출석부에서 보고 있는 강좌
let hubClassId = null; // 수업일에서 눌러 본 그날의 수강생 출석부
let adminSub = "approve";
let schoolSub = "students";
let detailTarget = null; // 수업 기록(출결·채점)을 그릴 자리
function detailEl() { return detailTarget || $("#run-detail"); }

function today() {
  // 기록은 한국 시간 날짜로 나뉜다 (기기 시간대와 상관없이)
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** replaceChildren에 null·false가 섞여도 글자로 찍히지 않게 */
function fill(box, ...kids) { box.replaceChildren(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false && x !== "")); }

/* 권한: 관리교사는 [특강/회의]·[거점학교 운영]·[참여학교 담당],
   강의교사는 [특강/회의]·[과목 개설]·[수강생 관리]·[과목 운영]. */
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
  $("#home-tabs").style.setProperty("--sub-count", 7);
  $("#home-tabs").style.setProperty("--sub-min-width", "784px");
  const want = params.get("tab") === "courses" || params.get("tab") === "history" ? "run" : params.get("tab");
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
  if (name === "meet") { loadLive(); loadMeetings(); loadMeetHistory(); }
  if (name === "create") { if (!$("#course-create-box").dataset.ready) drawCreateForm(); }
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
      row(cell("학기", f.term), cell("과목명", f.subject)),
      row(cell("신청상태", f.status), cell("소속학교", f.school)),
      row(cell("학생이름", f.name)),
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
    && (!q.status || x.status === q.status) && (!q.school || x.school === q.school)
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
    const head = ["번호", "과목명", "거점학교", "소속학교", "학년", "반", "학생이름", "신청일", "신청상태"];
    const lines = list.map((x, i) => [list.length - i, x.subject, x.hub_school, x.school,
      x.grade ? `${x.grade}학년` : "", x.class_no ? `${x.class_no}반` : "", x.name, kstDate(x.requested_at), ENROLL_NAME[x.status] || x.status]);
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
    h("div", { class: "table-wrap" }, h("table", { class: "att enroll-table" },
      h("thead", {}, h("tr", {}, h("th", {}, all), ["번호", "과목명", "거점학교", "소속학교", "학년", "반", "학생이름", "신청일", "신청상태"].map((t) => h("th", {}, t)))),
      h("tbody", {}, list.length ? list.map((x, i) => h("tr", {},
        h("td", {}, h("input", { type: "checkbox", checked: enrollPick.has(key(x)), onchange: (e) => {
          if (e.target.checked) enrollPick.add(key(x)); else enrollPick.delete(key(x));
        } })),
        h("td", { class: "num" }, list.length - i), h("td", {}, x.subject),
        h("td", {}, x.hub_school), h("td", {}, x.school || "-"),
        h("td", { class: "num" }, x.grade ? `${x.grade}학년` : "-"), h("td", { class: "num" }, x.class_no ? `${x.class_no}반` : "-"),
        h("td", {}, x.name), h("td", {}, kstDate(x.requested_at)),
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
    c.locked ? h("p", { class: "error" }, `${c.hub_school} 강사 활동 기간이 아니라서 이 강좌를 관리하거나 수업을 열 수 없어요. 계속 강의하려면 '내 정보'에서 가입 유형·거점학교 변경을 신청하세요.`) : null,
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
  const start = async (title) => {
    if (notYet && !confirm(`아직 수강 확정이 안 된 학생이 ${notYet}명 있어요. 이 학생들은 들어올 수 없어요. '수강생 관리'에서 먼저 승인하는 게 좋아요.\n\n그래도 지금 수업을 열까요?`)) return;
    try {
      const res = await api("/api/live/classes", { title: title || c.title, course_id: c.id });
      location.href = `/live/teacher/${res.code}`;
    } catch (err) { toast(err.message); }
  };
  // 회차표가 없으면 주제만 적고 바로 연다
  const plain = () => {
    const name = h("input", { maxlength: 60, placeholder: "수업 주제 (예: 3차시 헌법과 기본권)" });
    return h("div", { class: "open-box" }, h("label", { class: "grow" }, "수업 주제", name),
      h("button", { class: "primary big", onclick: () => start(name.value.trim()) }, "▶ 지금 온라인 수업 열기"));
  };
  // 회차표: 늘 펼쳐 두고, 날짜를 누르면 그 아래에서 주제를 적고 [지금 열기]
  const table = () => h("table", { class: "sess-table view sess-open" },
    h("tr", {}, ["회차", "날짜", "시간", "주제"].map((x) => h("th", {}, x))),
    sessions.flatMap((s) => {
      const picked = openPick[c.id] === s.no;
      const toggle = () => { openPick[c.id] = picked ? null : s.no; renderOpenClass(c, box); };
      const row = h("tr", { class: `${picked ? "on" : ""} ${next && next.no === s.no ? "next" : ""}` },
        h("td", {}, s.no),
        h("td", {}, h("button", { type: "button", class: "link-btn", onclick: toggle },
          `${fmtDate(s.date)} (${DAYS[dayOf(s.date)]})`), s.date === t ? h("span", { class: "tag" }, "오늘") : null),
        h("td", {}, s.start ? `${s.start}~${s.end}` : ""), h("td", {}, s.topic));
      if (!picked) return [row];
      const auto = !s.topic || s.topic === `${s.no}회차`;
      const topic = h("input", { maxlength: 50, value: auto ? "" : s.topic, placeholder: "수업 주제 (예: 헌법과 기본권)" });
      const go = () => start(`${s.no}회차${topic.value.trim() ? ` · ${topic.value.trim()}` : ""}`);
      topic.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
      setTimeout(() => topic.focus(), 0);
      return [row, h("tr", { class: "sess-start" }, h("td", { colspan: 4 },
        h("div", { class: "open-box" }, h("label", { class: "grow" }, `${s.no}회차 수업 주제`, topic),
          h("button", { class: "primary", onclick: go }, "▶ 지금 열기"))))];
    }));
  fill(box,
    open.length ? h("div", { class: "banner ok" }, h("strong", {}, "진행 중인 수업"), ...open.map((x) =>
      h("a", { class: "button small primary", href: `/live/teacher/${x.code}` }, `▶ ${x.title} 들어가기`))) : null,
    notYet ? h("p", { class: "muted", style: "font-size:0.9rem" }, `⚠️ 승인 대기 ${notYet}명은 아직 못 들어와요.`) : null,
    c.archived ? h("p", { class: "muted" }, "보관한 강좌에는 수업을 열 수 없어요. '보관 해제'를 먼저 눌러 주세요.")
      : sessions.length ? [table(),
        // 회차표에 없는 날(보강·추가 수업)도 주제만 적고 바로 열 수 있게
        h("p", { class: "muted", style: "margin:14px 0 6px;font-size:0.9rem" }, "회차표에 없는 날 추가로 수업을 열 때 (보강·특강 등)"),
        plain()] : plain());
}

/* ───── 학습 관리: 위에 [수업참석률][공지][설문][퀴즈][활동] 요약, 누르면 수업별 목록 → 수업을 누르면 학생별 내역 ───── */

const learnState = {}; // 과목별: { card, open: Set(펼친 수업) }
const ACT_LABEL = { survey: "설문", quiz: "퀴즈", activity: "활동" };
const ACT_KINDS = { survey: ["poll"], quiz: ["ox", "choice", "text"] }; // '활동'은 평가 활동(과제) 제출

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
    ["activity", "✍️ 활동", `${S.activity.count}회`, `과제 제출률 ${pct(S.activity.rate)} · 채점 ${S.activity.graded}건`],
  ];
  const detail = h("div", { class: "learn-detail" });
  fill(box,
    h("div", { class: "learn-cards" }, cards.map(([k, label, big, small]) => h("button", { type: "button", class: `learn-card ${st.card === k ? "on" : ""}`,
      onclick: () => { st.card = k; st.open.clear(); renderLearning(c, box); } },
      h("span", { class: "lc-label" }, label), h("strong", { class: "lc-big" }, big), h("span", { class: "lc-small" }, small)))),
    detail);
  if (st.card === "activity") { learnAssignments(c, d, st, detail); return; }
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

/** 활동 = 평가 활동(과제): 낸 과제마다 제출·채점 현황, 펼치면 학생별 제출 내역 */
function learnAssignments(c, d, st, box) {
  const list = d.assignments;
  const n = d.summary.enrolled;
  const COLS = 8;
  const draw = () => fill(box,
    h("div", { class: "row", style: "margin:4px 0 8px" }, h("h3", { class: "section-title grow", style: "margin:0" }, `✍️ 평가 활동(과제) ${list.length}개`),
      h("button", { class: "small", onclick: () => { runSub = "assess"; renderRun(); } }, "📝 평가 활동에서 과제 내기·채점")),
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
      })))) : h("p", { class: "muted" }, "아직 낸 과제가 없어요. '평가 활동'에서 과제를 내면 학생들의 제출 현황이 여기에 쌓여요."));
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
  const COLS = 7;
  const rate = (x) => (x.possible ? `${Math.round((x.answered / x.possible) * 100)}%` : "-");
  const draw = () => fill(box,
    h("h3", { class: "section-title", style: "margin:4px 0 8px" }, `${label}${key === "quiz" ? "를" : "을"} 한 수업 ${list.length}개`),
    list.length ? h("div", { class: "table-wrap" }, h("table", { class: "att log-table" },
      h("thead", {}, h("tr", {}, ["연번", "날짜", "시각", "수업 주제", `${label} 수`, "응답률", ""].map((t) => h("th", {}, t)))),
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
      })))) : h("p", { class: "muted" }, `아직 ${label}${key === "quiz" ? "를" : "을"} 한 수업이 없어요. 수업 화면의 '📊 설문/퀴즈'에서 낼 수 있어요.`));
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

/* ───────────────────────── 거점학교 운영: 승인·수업일·출석부 ───────────────────────── */

async function loadHub() {
  const ov = await api("/api/hub/overview");
  const waitCourses = ov.courses.filter((c) => c.approval === "pending");
  const badge = waitCourses.length;
  $("#hub-badge").textContent = badge;
  $("#hub-badge").hidden = !badge;
  const box = h("div");
  const subs = [
    ["courses", `강좌 개설 승인${waitCourses.length ? ` (${waitCourses.length})` : ""}`],
    ["days", "강좌별 수업일"],
    ["attendance", "강좌별 출석부"],
  ];
  fill($("#hub-list"),
    h("nav", { class: "tabs sub-tabs", "aria-label": "거점학교 운영 메뉴" }, subs.map(([k, label]) => h("button", { type: "button", class: hubSub === k ? "active" : "",
      onclick: () => { hubSub = k; hubCourseId = null; hubRecordCourseId = null; hubClassId = null; loadHub(); } }, label))),
    box);
  if (hubSub === "courses") fill(box, ...hubCourseApprove(ov));
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
      note = prompt(`'${c.title}' 강좌 개설을 반려하는 사유 (강사에게 보여요)`, "");
      if (note === null) return;
      if (!note.trim()) { toast("반려 사유를 적어 주세요."); return; }
    } else if (!confirm(`'${c.title}' 강좌 개설을 승인할까요? 승인하면 모집 기간에 학생들이 수강신청할 수 있어요.`)) return;
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
    const facts = [["신청 학기", termOf(c)], ["교과(군)", c.subject_group || "-"],
      ["학점", c.credits ? `${c.credits}학점` : "-"], ["강의교사", c.instructor || "-"],
      ["수강 인원", capacityOf(c)], ["거점학교", c.hub_school || "-"],
      ["대상 학년", (c.grades?.length ? c.grades : [1, 2, 3]).map((g) => `${g}학년`).join(", ")],
      ["성취도", c.achievement_text || "-"], ["등급", c.rank_grade || "-"], ["평가방식", evaluation], ["수업시간", classTime]];
    if (c.subject && c.subject !== c.title) facts.push(["과목", c.subject]);
    if (c.subject_area || c.subject_type) facts.push(["교과 상세", [c.subject_area,
      c.custom_subject ? "고시외 과목" : c.subject_type].filter(Boolean).join(" · ")]);
    if (c.hours) facts.push(["총 수업시간", `${c.hours}시간`]);
    if (c.start_date || c.end_date) facts.push(["강의기간", `${fmtDate(c.start_date)} ~ ${fmtDate(c.end_date)}`]);
    if (c.recruit_start || c.recruit_end) facts.push(["모집 기간",
      `${fmtDate(c.recruit_start)} ${c.recruit_start_time || ""} ~ ${fmtDate(c.recruit_end)} ${c.recruit_end_time || ""}`]);
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
      h("dl", { class: "facts" }, facts.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])),
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
      note = prompt(`선택한 ${targets.length}개 강좌에 적용할 반려 사유 (강사에게 보여요)`, "");
      if (note === null) return;
      if (!note.trim()) { toast("반려 사유를 적어 주세요."); return; }
    } else if (!confirm(`선택한 ${targets.length}개 강좌 개설을 승인할까요?`)) return;
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
    h("h2", { style: "margin:8px 0" }, `강좌 개설 승인${pending ? ` (${pending}건 대기)` : ""}`),
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
  const tile = (c) => h("button", { class: "run-tile", type: "button", onclick: () => {
    hubRecordCourseId = c.id;
    loadHub();
  } },
    thumbOf(c), h("strong", {}, c.title),
    h("span", { class: "muted" }, `${c.hub_school || ""} · 강의교사 ${c.instructor || "-"}`),
    h("span", { class: "muted" }, kind === "days"
      ? "수업 기록 보기" : `수강 확정 ${c.approved || 0}명`));
  const active = courses.filter((c) => !c.archived);
  const archived = courses.filter((c) => c.archived);
  const grid = (list) => h("div", { class: "run-tiles" }, list.map(tile));
  return [active.length ? grid(active) : h("p", { class: "muted" }, "아직 개설 승인한 강좌가 없어요."),
    archived.length ? h("details", { class: "hub-archived" },
      h("summary", {}, `보관한 강좌 ${archived.length}개`), grid(archived)) : null];
}

function hubRecordHeading(c, label) {
  return h("div", { class: "row hub-record-heading" },
    h("button", { type: "button", class: "small", onclick: () => {
      hubRecordCourseId = null;
      loadHub();
    } }, "← 과목 목록"),
    h("h2", { class: "grow" }, `${c.title} · ${label}`));
}

function hubCourseDays(ov, classes) {
  const course = ov.courses.find((c) => c.id === hubRecordCourseId && c.approval === "approved");
  if (!course) {
    hubRecordCourseId = null;
    return hubRecordCards(ov, "days");
  }
  const rows = classes.filter((x) => x.course_id === course.id);
  return [hubRecordHeading(course, "수업일"),
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
    h("div", { class: "row hub-record-heading" }, back,
      h("h2", { class: "grow" }, `${course?.title || d.course.title} · 수강생 출석부`)),
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
  fill(box, hubRecordHeading(course, "출석부"), h("p", { class: "muted" }, "출석부를 불러오는 중…"));
  let sheet;
  try { sheet = await api(`/api/hub/courses/${course.id}/attendance`); }
  catch (err) { fill(box, hubRecordHeading(course, "출석부"), h("p", { class: "error" }, err.message)); return; }
  if (hubSub !== "attendance" || hubRecordCourseId !== course.id) return;
  const cls = sheet.classes; // 수업일 (먼저 연 수업부터)
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const counts = cls.map((_, j) => sheet.students.filter((st) => st.attendance[j]).length);
  const fixed = ["연번", "소속학교", "학번", "이름"];
  fill(box, hubRecordHeading(course, "출석부"),
    h("p", { class: "muted" }, `수강 확정 ${sheet.students.length}명 · 수업 ${cls.length}회 · 한 번이라도 들어오면 O`),
    h("div", { class: "table-wrap" }, h("table", { class: "att hub-grid-table" },
      h("thead", {},
        h("tr", {}, fixed.map((t) => h("th", { rowspan: 2 }, t)),
          cls.length ? h("th", { colspan: cls.length, class: "center" }, "수업일") : h("th", { rowspan: 2 }, "수업일")),
        cls.length ? h("tr", {}, cls.map((c, j) => h("th", { class: "center", title: `${j + 1}회 · ${c.title || "주제 없음"} · ${c.start}` }, md(c.date)))) : null),
      h("tbody", {},
        sheet.students.length ? sheet.students.map((st, i) => h("tr", {},
          h("td", { class: "num" }, i + 1), h("td", {}, st.school || "-"), h("td", {}, st.student_no || "-"), h("td", {}, st.name),
          cls.length ? cls.map((_, j) => h("td", { class: `center ${st.attendance[j] ? "ox-o-mark" : "ox-x-mark"}` }, st.attendance[j] ? "O" : "X"))
            : h("td", { class: "muted" }, "수업 기록 없음")))
          : h("tr", {}, h("td", { colspan: 4 + Math.max(1, cls.length), class: "muted" }, "수강 확정된 학생이 없어요."))),
      cls.length && sheet.students.length ? h("tfoot", {}, h("tr", { class: "hub-grid-total" },
        h("td", { colspan: 4 }, "참여 인원"),
        counts.map((n) => h("td", { class: "center" }, `${n}명`)))) : null)));
}

/* ───────────────────────── 참여학교 담당: 우리 학교 수강생 관리 · 탈퇴 승인 ───────────────────────── */

let schoolData = null; // 참여학교 담당: 우리 학교 학생
const withdrawPick = new Set(); // 탈퇴 승인 탭에서 체크한 학생 id
const schoolQ = {};

/** 참여학교 담당: 학생 명단, 전입 승인, 탈퇴 승인, 탈퇴자 증빙 */
async function loadSchool() {
  const outer = $("#school-list");
  const box = h("div");
  fill(outer,
    h("nav", { class: "tabs sub-tabs", "aria-label": "참여학교 담당 메뉴" },
      [["students", "학생 관리"], ["transfer", "소속학교 변경 승인"], ["withdraw", "탈퇴 승인"], ["evidence", "탈퇴자 증빙"]].map(([key, label]) => h("button", {
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
  const quits = schoolData.withdrawals.length;
  $("#school-badge").textContent = quits;
  $("#school-badge").hidden = !quits;
  if (selectedTab === "withdraw") { renderSchoolWithdrawals(box); return; }
  const all = schoolData.students.flatMap((x) => x.courses);
  const terms = koSort(new Set(all.map((c) => c.term).filter(Boolean)));
  const schools = koSort(new Set(schoolData.students.map((x) => x.school).filter(Boolean)));
  const f = {
    term: h("select", {}, h("option", { value: "" }, "전체"), terms.map((t) => h("option", { value: t }, t))),
    subject: h("input", { placeholder: "예: 법과 사회" }),
    status: h("select", {}, h("option", { value: "" }, "전체"), koSort(Object.entries(ENROLL_NAME), (x) => x[1]).map(([k, v]) => h("option", { value: k }, v)),
      h("option", { value: "none" }, "수강신청 없음")),
    teacher: h("input", { placeholder: "강의교사 이름" }),
    school: h("select", {}, h("option", { value: "" }, "전체"), schools.map((x) => h("option", { value: x }, x))),
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
    h("h2", { style: "margin:0 0 6px" }, "학생 관리"),
    ME.is_admin && !schoolData.schools.length ? null
      : h("p", { class: "muted", style: "margin:0 0 10px;font-size:0.9rem" },
        `${schoolData.schools.join(", ")} 학생만 보여요 (학생이 가입할 때 고른 소속 학교 기준).`),
    h("div", { class: "search-form" },
      row(cell("학기", f.term), cell("과목", f.subject)),
      row(cell("신청상태", f.status), cell("강의교사", f.teacher)),
      row(cell("소속학교", f.school), cell("학생이름", f.name)),
      row(cell("기간검색", h("div", { class: "row" }, f.from, "~", f.to,
        ...[["오늘", 0], ["7일", 7], ["1개월", 30], ["6개월", 182]].map(([label, d]) => h("label", { class: "switch" },
          h("input", { type: "radio", name: "school-quick", onchange: () => quick(d) }), label))), true))),
    h("div", { class: "row", style: "justify-content:center;margin:12px 0 20px" },
      h("button", { type: "button", onclick: () => { for (const k of Object.keys(schoolQ)) delete schoolQ[k]; loadSchool(); } }, "초기화"),
      h("button", { class: "primary", type: "button", onclick: search }, "검색")),
    result);
  drawSchoolResult(result);
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
      if (!confirm(`${picked.length}명의 탈퇴를 승인할까요?\n` +
        (studying.length ? `⚠️ 아직 수강 중인 학생: ${studying.map((x) => x.name).join(", ")}\n` : "") +
        "일반 수업 기록은 제거하고 출결·활동·점수 등 증빙 기록은 암호화해 별도 보관합니다.")) return;
    } else {
      note = prompt(`${picked.length}명의 탈퇴 신청을 반려해요. 사유 (학생에게 보여요)`, "");
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
    const head = ["연번", "변경 전 소속학교", "학년", "반", "이름", "변경 후 소속학교", "승인/반려"];
    fill(box, h("h2", {}, "소속학교 변경 승인"),
      h("p", { class: "muted" }, "우리 학교로 옮기려는 학생의 신청입니다. 승인하면 학생이 우리 학교 명단에 표시됩니다."),
      h("div", { class: "table-wrap" }, h("table", { class: "att school-change-table" },
        h("thead", {}, h("tr", {}, head.map((label) => h("th", {}, label)))),
        h("tbody", {}, requests.length ? requests.map((r, i) => h("tr", {},
          h("td", {}, i + 1),
          h("td", {}, r.old_value || "-"),
          h("td", {}, r.grade ? `${r.grade}학년` : "-"),
          h("td", {}, r.class_no ? `${r.class_no}반` : "-"),
          h("td", {}, r.name || "-"),
          h("td", {}, r.new_value || "-"),
          h("td", {}, h("div", { class: "row school-change-actions" }, ["approve", "reject"].map((action) => h("button", {
            type: "button", class: action === "approve" ? "small primary" : "small", onclick: async () => {
              if (action === "approve" && !confirm(`${r.name} 학생의 소속학교를 ${r.new_value}(으)로 변경할까요?`)) return;
              const note = action === "reject" ? prompt("반려 사유를 입력하세요. 학생에게 표시됩니다.", "") : "";
              if (note === null) return;
              try {
                await api(`/api/school/change-requests/${r.id}`, { action, note });
                toast(action === "approve" ? "소속학교 변경을 승인했어요." : "소속학교 변경을 반려했어요.");
                schoolData = null;
                loadSchool();
              } catch (e) { toast(e.message); }
            }
          }, action === "approve" ? "승인" : "반려"))))
        )) : h("tr", {}, h("td", { colspan: head.length, class: "muted" }, "승인 대기 중인 신청이 없어요."))))));
  } catch (e) { fill(box, h("p", { class: "error" }, e.message)); }
}

/** 검색 조건에 맞는 강좌가 있는 학생 (강좌 조건이 없으면 모든 학생) */
/** 검색 칸의 과목 조건 (조건이 없으면 null) */
function schoolCourseFilter() {
  const q = schoolQ;
  const has = (v, w) => !w || (v || "").includes(w);
  const courseCond = q.term || q.subject || (q.status && q.status !== "none") || q.teacher || q.from || q.to;
  if (!courseCond) return null;
  return (c) => (!q.term || c.term === q.term) && (has(c.subject, q.subject) || has(c.title, q.subject))
    && (!q.status || q.status === "none" || c.status === q.status) && has(c.instructor, q.teacher)
    && (!q.from || kstDate(c.requested_at) >= q.from) && (!q.to || kstDate(c.requested_at) <= q.to);
}

function filteredSchool() {
  const q = schoolQ;
  const has = (v, w) => !w || (v || "").includes(w);
  const courseCond = q.term || q.subject || (q.status && q.status !== "none") || q.teacher || q.from || q.to;
  const okCourse = (c) => (!q.term || c.term === q.term) && (has(c.subject, q.subject) || has(c.title, q.subject))
    && (!q.status || q.status === "none" || c.status === q.status) && has(c.instructor, q.teacher)
    && (!q.from || kstDate(c.requested_at) >= q.from) && (!q.to || kstDate(c.requested_at) <= q.to);
  return schoolData.students.filter((x) => has(x.name, q.name) && (!q.school || x.school === q.school)
    && (q.status !== "none" || !x.courses.length) && (!courseCond || x.courses.some(okCourse)));
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
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" })), download: `우리학교_학생관리_${today()}.csv` });
    api("/api/access-log/export", { what: `우리 학교 학생 관리 엑셀 (${list.length}명)` }).catch(() => {});
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
