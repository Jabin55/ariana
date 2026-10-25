/* 선생님 마이페이지: [특강/회의] [강좌 개설] [수강생 관리] [강좌 운영] [거점학교 운영] (+ 전체 관리) */

let teacherCourses = null; // 아직 못 불러왔으면 null
const editing = new Set(); // 정보 수정 중인 강좌
let runCourseId = null; // 강좌 운영에서 연 강좌
let runSub = "notice"; // 그 강좌 안의 칸: notice(공지사항) open(수업 열기) record(수업 기록)
let detailTarget = null; // 수업 기록(출결·채점)을 그릴 자리
function detailEl() { return detailTarget || $("#run-detail"); }

function today() {
  // 기록은 한국 시간 날짜로 나뉜다 (기기 시간대와 상관없이)
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/* 권한: 거점학교 관리교사는 [거점학교 운영]만, 강사는 [거점학교 운영] 빼고 모두. 전체 관리자는 모두 */
/** replaceChildren에 null·false가 섞여도 글자로 찍히지 않게 */
function fill(box, ...kids) { box.replaceChildren(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false && x !== "")); }

function canTeach() {
  return ME.is_admin || ME.lead_hubs.length > 0 || ME.teach_hubs.length > 0 || !ME.coordinator_hubs.length;
}
function canHub() { return ME.is_admin || ME.coordinator_hubs.length > 0; }
function allowed(tab) {
  if (tab === "admin") return ME.is_admin;
  if (tab === "hub") return canHub();
  return canTeach();
}

function showTeacher() {
  show("teacher-view");
  $("#lead").hidden = true;
  $("#admin-tab").hidden = !ME.is_admin;
  const want = params.get("tab") === "courses" || params.get("tab") === "history" ? "run" : params.get("tab");
  if (params.get("course")) runCourseId = Number(params.get("course"));
  const first = canTeach() ? "run" : "hub";
  showHomeTab(want && document.querySelector(`#home-tabs [data-tab="${want}"]`) && allowed(want) ? want : first);
  if (canTeach()) loadTeacherCourses();
  if (canHub()) loadHub();
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
}
$("#home-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showHomeTab(b.dataset.tab);
});

async function loadTeacherCourses() {
  ({ courses: teacherCourses } = await api("/api/courses/mine"));
  const active = teacherCourses.filter((c) => !c.archived && !c.locked);
  const pending = active.reduce((n, c) => n + c.pending + (c.can_finalize ? c.waiting : 0), 0);
  $("#pending-badge").textContent = pending;
  $("#pending-badge").hidden = !pending;
  if (!$('[data-panel="students"]').hidden) renderStudents();
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

/** 강좌 개설 탭 아래: 메인 전광판·외솔온닷 공지사항 (선생님 누구나) */
async function drawCreateExtras() {
  const box = $("#create-extras");
  try {
    fill(box, await bannersEditor(drawCreateExtras), await noticesEditor(drawCreateExtras));
  } catch (err) { fill(box, h("p", { class: "error" }, err.message)); }
}

/* ───────────────────────── 수강생 관리 ───────────────────────── */

function renderStudents() {
  const box = $("#students-list");
  if (!teacherCourses) { fill(box, h("p", { class: "muted" }, "불러오는 중…")); return; }
  const list = teacherCourses.filter((c) => !c.archived && !c.locked);
  fill(box, ...list.map((c) => {
    const members = h("div", { class: "members-box" });
    renderMembers(c, members);
    return h("section", { class: "card", style: "margin-bottom:12px" },
      h("div", { class: "row" }, h("h2", { class: "grow", style: "margin:0" }, c.title),
        h("span", {}, `수강 확정 ${c.approved}명`),
        c.pending ? h("span", { class: "status pending" }, `내 승인 대기 ${c.pending}`) : null,
        c.waiting ? h("span", { class: "status pending" }, `관리교사 승인 대기 ${c.waiting}`) : null,
        !c.lead ? null : h("label", { class: "switch", style: "font-size:0.9rem" }, h("input", { type: "checkbox", checked: c.open,
          onchange: async (e) => { await api(`/api/courses/${c.id}`, { open: e.target.checked }); loadTeacherCourses(); } }), "수강신청 받기")),
      courseInfo(c), members);
  }));
  if (!list.length) box.append(h("p", { class: "muted" }, "아직 개설한 강좌가 없어요. '강좌 개설'에서 먼저 강좌를 만들어 주세요."));
}

/* ───────────────────────── 강좌 운영 ───────────────────────── */

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
    x.pending || x.waiting ? h("span", { class: "status pending" }, `승인 대기 ${x.pending + x.waiting}`) : null,
    x.lead ? null : h("span", { class: "status pending" }, "팀티칭"));
  const active = teacherCourses.filter((x) => !x.archived);
  const archived = teacherCourses.filter((x) => x.archived);
  const grid = (items) => h("div", { class: "run-tiles" }, items.map(tile));
  fill($("#run-list"), 
    h("p", { class: "muted", style: "margin:0 0 10px" }, "강좌를 누르면 공지사항·수업 열기·수업 기록을 볼 수 있어요."),
    active.length ? grid(active) : h("p", { class: "muted" }, "아직 개설한 강좌가 없어요. '강좌 개설'에서 먼저 강좌를 만들어 주세요."),
    archived.length ? h("details", { style: "margin-top:16px" }, h("summary", { class: "muted" }, `보관한 강좌 ${archived.length}개`), grid(archived)) : null);
}

function renderRunCourse(c) {
  const update = async (values) => { await api(`/api/courses/${c.id}`, values); loadTeacherCourses(); };
  const subBox = h("div", { class: "run-sub" });
  const subs = [["notice", "📢 공지사항"], ["open", "▶ 수업 열기"], ["record", "📋 수업 기록"]];
  fill($("#run-course"), 
    h("div", { class: "row" },
      h("button", { class: "small", onclick: () => { runCourseId = null; renderRun(); } }, "← 강좌 목록"),
      h("h2", { class: "grow", style: "margin:0" }, c.title, c.archived ? h("span", { class: "muted" }, " (보관됨)") : null),
      c.lead && !c.locked && !editing.has(c.id) ? h("button", { class: "small", onclick: () => { editing.add(c.id); renderRun(); } }, "정보 수정") : null,
      c.lead && !c.locked ? h("button", { class: "small", onclick: () => {
        if (c.archived || confirm("학기가 끝난 강좌를 보관할까요? 수강신청이 닫히고 새 수업을 열 수 없어요. 기록은 남아요.")) update({ archived: !c.archived });
      } }, c.archived ? "보관 해제" : "보관 (학기 끝)") : null),
    courseInfo(c),
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
  const notYet = (c.pending || 0) + (c.waiting || 0);
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

/* 수업 기록: 출결(수업별) · 과제 */
async function renderRecords(c, box) {
  const recBox = h("div");
  const detail = h("div");
  const assignBox = h("div", { class: "assign-box" });
  fill(box, 
    h("h3", { class: "section-title" }, "🕒 출결 기록 (수업별)"), recBox, detail,
    h("div", { style: "margin-top:20px" }), assignBox);
  renderCourseAssignments(c, assignBox);
  const { classes } = await api(`/api/courses/${c.id}/classes`);
  fill(recBox, ...classes.map((x) => h("button", { class: "class-pick", "data-id": x.id, onclick: () => { detailTarget = detail; loadDetail(x.id); } },
    `${x.date.replaceAll("-", ".")} ${x.start.slice(0, 5)} · ${x.title} · 참여 ${x.attended}명${x.live ? " · 진행 중" : ""}`)));
  if (!classes.length) recBox.append(h("p", { class: "muted" }, "아직 연 수업이 없어요."));
}
