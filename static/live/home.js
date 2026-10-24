/* 첫 화면: 구글 로그인 → 내 정보 → 학생은 수업 입장, 선생님은 수업 열기·출결 기록 */
const params = new URLSearchParams(location.search);
let ME = null;
let CONFIG = null;

const views = ["login-view", "profile-view", "student-view", "teacher-view"];
function show(id) {
  for (const v of views) $(`#${v}`).hidden = v !== id;
  $("#student-questions").hidden = true;
  $("#student-results").hidden = true;
}

const fmtScore = (n) => (n === null || n === undefined ? "미채점" : `${Math.round(n * 100) / 100}`);

function qaItem(q, who) {
  return h("div", { class: `q ${q.reply ? "" : "pending-reply"}` },
    h("div", { class: "meta" }, who),
    h("div", {}, `❓ ${q.text}`),
    q.reply ? h("div", { class: "reply" }, `👩‍🏫 ${q.reply}`, h("span", { class: "muted", style: "font-size:0.75rem" }, ` · ${q.reply_time.slice(0, 5)}`))
      : h("div", { class: "muted", style: "font-size:0.85rem" }, "답변 없음"));
}

async function boot() {
  CONFIG = await api("/api/me");
  ME = CONFIG.user;
  $("#logout").hidden = !ME;
  $("#edit-profile").hidden = !ME || ME.needs_profile;
  $("#who").textContent = ME ? `${ME.display} (${ME.role === "teacher" ? "선생님" : "학생"})` : "";
  if (!ME) return showLogin();
  if (ME.needs_profile) return showProfile();
  if (ME.role === "teacher") return showTeacher();
  return showStudent();
}

/* ───── 로그인 ───── */

function showLogin() {
  show("login-view");
  if (CONFIG.domains.length) $("#login-hint").textContent = `학교에서 받은 구글 계정(@${CONFIG.domains.join(", @")})으로 로그인하세요.`;
  $("#dev-login").hidden = !CONFIG.dev_login;
  if (!CONFIG.google_client_id) {
    if (!CONFIG.dev_login) $("#login-error").textContent = "서버에 GOOGLE_CLIENT_ID 가 설정되지 않았어요. 선생님께 알려 주세요.";
    return;
  }
  const s = document.createElement("script");
  s.src = "https://accounts.google.com/gsi/client";
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: CONFIG.google_client_id,
      callback: onGoogle,
      hd: CONFIG.domains.length === 1 ? CONFIG.domains[0] : undefined, // 학교 계정을 먼저 보여 준다
      ux_mode: "popup",
    });
    google.accounts.id.renderButton($("#google-btn"), { theme: "outline", size: "large", text: "signin_with", locale: "ko", width: 280 });
  };
  s.onerror = () => { $("#login-error").textContent = "구글 로그인 화면을 불러오지 못했어요. 인터넷 연결을 확인해 주세요."; };
  document.head.append(s);
}

async function onGoogle(resp) {
  $("#login-error").textContent = "";
  try {
    await api("/api/auth/google", { credential: resp.credential });
    boot();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
}

$("#dev-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/auth/dev", { email: $("#dev-email").value.trim() });
    boot();
  } catch (err) { $("#login-error").textContent = err.message; }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", {});
  try { google.accounts.id.disableAutoSelect(); } catch { /* 구글 스크립트 없음 */ }
  location.href = "/live";
});

/* ───── 내 정보 ───── */

function showProfile() {
  show("profile-view");
  const student = ME.role === "student";
  document.querySelectorAll(".student-only").forEach((el) => { el.hidden = !student; });
  for (const id of ["#p-grade", "#p-class", "#p-number"]) $(id).required = student;
  $("#profile-hint").textContent = student
    ? "선생님이 출석을 확인할 수 있도록 정확하게 적어 주세요. 새 학년이 되면 여기서 고칠 수 있어요."
    : "학생들에게 보일 이름과 학교를 적어 주세요.";
  $("#p-name").value = ME.name || "";
  const sel = $("#p-school-select");
  if (CONFIG.schools.length) {
    sel.hidden = false;
    $("#p-school").hidden = true;
    sel.replaceChildren(h("option", { value: "" }, "학교를 고르세요"),
      ...CONFIG.schools.map((s) => h("option", { value: s, selected: s === ME.school }, s)));
    if (CONFIG.schools.length === 1 && !ME.school) sel.value = CONFIG.schools[0];
  } else {
    $("#p-school").value = ME.school || "";
  }
  $("#p-grade").value = ME.grade || "";
  $("#p-class").value = ME.class_no || "";
  $("#p-number").value = ME.number || "";
  updateNo();
}

function updateNo() {
  const g = Number($("#p-grade").value), c = Number($("#p-class").value), n = Number($("#p-number").value);
  $("#p-no").textContent = g && c && n ? `${g}${String(c).padStart(2, "0")}${String(n).padStart(2, "0")}` : "-";
}
for (const id of ["#p-grade", "#p-class", "#p-number"]) $(id).addEventListener("input", updateNo);

$("#profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#profile-error").textContent = "";
  const body = {
    name: $("#p-name").value.trim(),
    school: CONFIG.schools.length ? $("#p-school-select").value : $("#p-school").value.trim(),
  };
  if (ME.role === "student") {
    Object.assign(body, { grade: Number($("#p-grade").value), class_no: Number($("#p-class").value), number: Number($("#p-number").value) });
  }
  try {
    await api("/api/me/profile", body);
    boot();
  } catch (err) { $("#profile-error").textContent = err.message; }
});
$("#edit-profile").addEventListener("click", showProfile);

/* ───── 학생 ───── */

function showStudent() {
  show("student-view");
  const code = (params.get("c") || "").toUpperCase();
  if (code) {
    $("#code").value = code;
    join(code); // 링크로 들어왔으면 바로 입장
    return;
  }
  loadLiveNow();
  setInterval(loadLiveNow, 15000); // 선생님이 수업을 열면 곧바로 보이게
  loadCourses();
  loadMyResults();
  loadMyQuestions();
}

/* 수강 승인된 강좌에서 지금 열린 수업 → 코드 없이 입장 */
async function loadLiveNow() {
  try {
    const { classes } = await api("/api/courses/live-now");
    const box = $("#live-now");
    box.replaceChildren(...classes.map((c) => h("div", { class: "live-item" },
      h("div", { class: "grow" }, h("div", { class: "muted", style: "font-size:0.85rem" }, `${c.course_title} · ${fmtTime(c.started_at)} 시작`),
        h("strong", {}, c.title)),
      h("button", { class: "primary", onclick: () => join(c.code) }, "입장하기"))));
    if (!classes.length) {
      box.append(h("span", { class: "muted" }, "지금 열린 수업이 없어요. 선생님이 수업을 열면 여기에 바로 나타나요."));
    }
  } catch { /* 다음 새로고침 때 다시 시도 */ }
}

const ENROLL_STATUS = { approved: "수강 중", pending: "승인 대기", rejected: "거절됨" };

async function loadCourses() {
  const { courses } = await api("/api/courses/available");
  const mine = courses.filter((c) => c.status === "approved" || c.status === "pending");
  const others = courses.filter((c) => !mine.includes(c));
  const enrollBtn = async (c, method) => {
    try {
      if (method === "DELETE") {
        if (!confirm(`'${c.title}' 수강을 취소할까요?`)) return;
        await fetch(`/api/courses/${c.id}/enroll`, { method: "DELETE" });
      } else {
        await api(`/api/courses/${c.id}/enroll`, {});
        toast("수강신청했어요. 선생님이 승인하면 수업에 들어갈 수 있어요.");
      }
    } catch (err) { toast(err.message); }
    loadCourses();
  };
  const line = (c) => h("div", { class: "course-line" },
    h("div", { class: "grow" }, h("strong", {}, c.title), h("span", { class: "muted" }, ` · ${c.teacher || ""} 선생님`),
      c.description ? h("div", { class: "muted", style: "font-size:0.85rem" }, c.description) : null),
    c.status ? h("span", { class: `status ${c.status}` }, ENROLL_STATUS[c.status]) : null);
  $("#my-courses").replaceChildren(...mine.map((c) => h("div", { class: "row" }, line(c),
    h("button", { class: "small", onclick: () => enrollBtn(c, "DELETE") }, c.status === "pending" ? "신청 취소" : "수강 취소"))));
  if (!mine.length) $("#my-courses").append(h("span", { class: "muted" }, "아직 수강 중인 강좌가 없어요."));
  $("#open-courses").replaceChildren(...others.map((c) => h("div", { class: "row" }, line(c),
    c.open ? h("button", { class: "small primary", onclick: () => enrollBtn(c, "POST") }, c.status === "rejected" ? "다시 신청" : "수강신청")
      : h("span", { class: "muted" }, "마감"))));
  if (!others.length) $("#open-courses").append(h("span", { class: "muted" }, "신청할 수 있는 강좌가 없어요."));
}

async function loadMyResults() {
  try {
    const { classes } = await api("/api/live/my-results");
    if (!classes.length) return;
    $("#my-results").replaceChildren(...classes.map((c) => h("details", { class: "result-class" },
      h("summary", {}, h("strong", {}, `${c.date} · ${c.title}`), h("span", { class: "muted" }, `  ${fmtScore(c.score)} / ${fmtScore(c.max)}점`)),
      ...c.items.map((it) => h("div", { class: "q" },
        h("div", { class: "meta" }, `${it.no}. ${it.kind} · ${fmtScore(it.score)} / ${fmtScore(it.points)}점`),
        h("div", {}, it.prompt),
        h("div", {}, h("span", { class: "muted" }, "내 답: "), it.answer || "(답하지 않음)"),
        it.correct_answer ? h("div", {}, h("span", { class: "muted" }, "정답: "), it.correct_answer) : null,
        it.feedback ? h("div", { class: "reply" }, `👩‍🏫 ${it.feedback}`) : null)))));
    $("#student-results").hidden = false;
  } catch { /* 결과를 못 불러와도 입장에는 지장 없음 */ }
}

async function loadMyQuestions() {
  try {
    const { questions } = await api("/api/live/my-questions");
    if (!questions.length) return;
    $("#my-q").replaceChildren(...questions.map((q) => qaItem(q, `${q.date} ${q.time.slice(0, 5)} · ${q.class_title}`)));
    $("#student-questions").hidden = false;
  } catch { /* 기록을 못 불러와도 입장에는 지장 없음 */ }
}

async function join(code) {
  $("#join-error").textContent = "";
  try {
    await api(`/api/live/classes/${code}/join`, {});
    location.href = `/live/class/${code}`;
  } catch (err) { $("#join-error").textContent = err.message; }
}

$("#join").addEventListener("submit", (e) => {
  e.preventDefault();
  join($("#code").value.trim().toUpperCase());
});

/* ───── 선생님 ───── */

function today() {
  // 기록은 한국 시간 날짜로 나뉜다 (기기 시간대와 상관없이)
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function showTeacher() {
  show("teacher-view");
  $("#lead").hidden = true;
  $("#h-date").value = params.get("date") || today();
  loadLive();
  loadTeacherCourses();
  if (params.get("tab") === "history" || params.get("class")) showHomeTab("history");
}

function showHomeTab(name) {
  for (const b of $("#home-tabs").children) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of document.querySelectorAll("#teacher-view [data-panel]")) p.hidden = p.dataset.panel !== name;
  if (name === "history") loadHistory();
  if (name === "courses") loadTeacherCourses();
}
$("#home-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showHomeTab(b.dataset.tab);
});

async function loadLive() {
  const { classes } = await api("/api/live/my-classes");
  const box = $("#live-classes");
  box.replaceChildren(...classes.map((c) => h("a", { href: `/live/teacher/${c.code}` },
    `▶ ${c.course_title ? `[${c.course_title}] ` : ""}${c.title} (${c.code}) · ${fmtTime(c.created_at)} 시작`)));
  if (!classes.length) box.append(h("span", { class: "muted" }, "없어요."));
}

$("#create").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#create-error").textContent = "";
  try {
    const courseId = Number($("#t-course").value) || null;
    const res = await api("/api/live/classes", {
      title: $("#title").value,
      course_id: courseId,
      target_grade: Number($("#t-grade").value) || null,
      target_class: Number($("#t-class").value) || null,
    });
    location.href = `/live/teacher/${res.code}`;
  } catch (err) { $("#create-error").textContent = err.message; }
});

/* 강좌·수강생 관리 */

let teacherCourses = [];
const openCourse = new Set(); // 수강생 목록을 펼친 강좌

async function loadTeacherCourses() {
  ({ courses: teacherCourses } = await api("/api/courses/mine"));
  const active = teacherCourses.filter((c) => !c.archived);
  // 수업 열기: 강좌 고르기
  const sel = $("#t-course");
  const cur = sel.value;
  sel.replaceChildren(...active.map((c) => h("option", { value: c.id }, c.title)),
    h("option", { value: "" }, "강좌 없이 열기 (수업 코드로 입장)"));
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  updateCourseHint();
  const pending = active.reduce((n, c) => n + c.pending, 0);
  $("#pending-badge").textContent = pending;
  $("#pending-badge").hidden = !pending;
  renderCourseList();
}

function updateCourseHint() {
  const id = Number($("#t-course").value);
  const c = teacherCourses.find((x) => x.id === id);
  $("#t-course-hint").textContent = c
    ? `승인된 수강생 ${c.approved}명은 첫 화면에서 바로 들어와요(코드 필요 없음). 수강생이 아니면 들어올 수 없어요.`
    : teacherCourses.length ? "학생들에게 수업 코드를 알려 줘야 해요." : "강좌를 먼저 만들면 학생들이 코드 없이 들어올 수 있어요 ('강좌·수강생' 탭).";
  document.querySelectorAll(".no-course").forEach((el) => { el.hidden = !!c; });
}
$("#t-course").addEventListener("change", updateCourseHint);

$("#course-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#course-error").textContent = "";
  try {
    await api("/api/courses", { title: $("#c-title").value, description: $("#c-desc").value });
    $("#c-title").value = "";
    $("#c-desc").value = "";
    toast("강좌를 만들었어요. 학생들이 첫 화면에서 수강신청할 수 있어요.");
    loadTeacherCourses();
  } catch (err) { $("#course-error").textContent = err.message; }
});

function renderCourseList() {
  const box = $("#course-list");
  box.replaceChildren(...teacherCourses.map((c) => {
    const update = async (values) => { await api(`/api/courses/${c.id}`, values); loadTeacherCourses(); };
    const members = h("div", { class: "members-box" });
    const card = h("section", { class: `card course-card ${c.archived ? "archived" : ""}`, style: "margin-bottom:12px" },
      h("div", { class: "row" },
        h("h2", { class: "grow", style: "margin:0" }, c.title, c.archived ? h("span", { class: "muted" }, " (보관됨)") : null),
        h("span", {}, `수강생 ${c.approved}명`),
        c.pending ? h("span", { class: "status pending" }, `승인 대기 ${c.pending}`) : null),
      c.description ? h("p", { class: "muted", style: "margin:4px 0" }, c.description) : null,
      h("div", { class: "row", style: "margin-top:6px" },
        !c.archived ? h("label", { class: "switch" }, h("input", { type: "checkbox", checked: c.open, onchange: (e) => update({ open: e.target.checked }) }), "수강신청 받기") : null,
        h("button", { class: "small", onclick: () => { if (openCourse.has(c.id)) openCourse.delete(c.id); else openCourse.add(c.id); renderCourseList(); } },
          openCourse.has(c.id) ? "수강생 목록 접기" : "수강생 관리"),
        h("span", { class: "grow" }),
        h("button", { class: "small", onclick: () => {
          if (c.archived || confirm("학기가 끝난 강좌를 보관할까요? 수강신청이 닫히고 새 수업을 열 수 없어요. 기록은 남아요.")) update({ archived: !c.archived });
        } }, c.archived ? "보관 해제" : "보관 (학기 끝)")),
      members);
    if (openCourse.has(c.id)) renderMembers(c, members);
    return card;
  }));
  if (!teacherCourses.length) box.append(h("p", { class: "muted" }, "아직 만든 강좌가 없어요."));
}

async function renderMembers(c, box) {
  const { enrollments } = await api(`/api/courses/${c.id}/enrollments`);
  const decide = async (e, status) => {
    if (status === "removed" && !confirm(`${e.name} 학생을 이 강좌에서 뺄까요?`)) return;
    await api(`/api/courses/${c.id}/enrollments/${e.user_id}`, { status });
    loadTeacherCourses();
  };
  const group = (status, title, actions) => {
    const list = enrollments.filter((e) => e.status === status);
    if (!list.length) return null;
    return h("div", { class: "box", style: "margin-top:8px" },
      h("div", { class: "row" }, h("strong", { class: "grow" }, `${title} ${list.length}명`),
        status === "pending" ? h("button", { class: "small primary", onclick: async () => {
          const r = await api(`/api/courses/${c.id}/approve-all`, {});
          toast(`${r.approved}명을 승인했어요.`);
          loadTeacherCourses();
        } }, "모두 승인") : null),
      h("div", { class: "people" }, list.map((e) => h("div", { class: "person" },
        h("span", { class: `dot ${status === "approved" ? "on" : ""}` }),
        h("span", {}, `${e.student_no || "-"} ${e.name} `, h("span", { class: "muted", style: "font-size:0.8rem" }, e.school)),
        h("span", { class: "acts" }, actions.map(([label, st, cls]) => h("button", { class: cls || "", onclick: () => decide(e, st) }, label)))))));
  };
  box.replaceChildren(...[
    group("pending", "승인 대기", [["승인", "approved", "primary"], ["거절", "rejected"]]),
    group("approved", "수강생", [["빼기", "removed", "danger"]]),
    group("rejected", "거절함", [["승인", "approved"], ["삭제", "removed"]]),
  ].filter(Boolean));
  if (!enrollments.length) box.append(h("p", { class: "muted" }, "아직 수강신청한 학생이 없어요."));
}

/* 출결 기록 */

async function loadHistory() {
  const day = $("#h-date").value;
  const { classes } = await api(`/api/live/history?date=${day}`);
  $("#h-summary").textContent = `수업 ${classes.length}개`;
  const box = $("#h-classes");
  box.replaceChildren(...classes.map((c) => h("button", { class: "class-pick", "data-id": c.id, onclick: () => loadDetail(c.id) },
    `${c.start.slice(0, 5)} · ${c.course_title ? `[${c.course_title}] ` : ""}${c.title} (${c.code}) · 참여 ${c.attended}명${c.questions ? ` · 질문 ${c.questions}건` : ""}${c.live ? " · 진행 중" : ""}`)));
  if (!classes.length) box.append(h("span", { class: "muted" }, "이 날짜에 연 수업이 없어요."));
  $("#h-detail").replaceChildren();
  const want = Number(params.get("class"));
  const pick = classes.find((c) => c.id === want) || (classes.length === 1 ? classes[0] : null);
  if (pick) loadDetail(pick.id);
}
$("#h-date").addEventListener("change", () => { params.delete("class"); loadHistory(); });

function fmtGap(min) {
  return min < 1 ? `${Math.round(min * 60)}초` : `${Math.round(min * 10) / 10}분`;
}

async function loadDetail(id) {
  for (const b of document.querySelectorAll(".class-pick")) b.classList.toggle("on", Number(b.dataset.id) === id);
  const r = await api(`/api/live/history/${id}`);
  const c = r.class;
  const rows = r.students.map((p) => h("tr", { class: p.rejoins ? "rejoined" : "" },
    h("td", {}, p.student_no || "-"), h("td", {}, p.name), h("td", {}, p.first_join_text),
    h("td", {}, p.online ? h("strong", { class: "ok-text" }, "접속 중") : `${p.last_leave_text} `,
      p.online ? null : h("span", { class: "muted" }, `(${p.last_reason_text})`)),
    h("td", { class: "num" }, `${p.minutes}분`),
    h("td", { class: "num" }, p.rejoins ? h("strong", {}, `${p.rejoins}회`) : "-"),
    h("td", { class: "num" }, p.away_minutes ? `${p.away_minutes}분` : "-"),
    h("td", {}, h("details", { open: p.rejoins > 0 }, h("summary", { class: "muted" }, `기록 ${p.count}건`),
      h("div", { class: "sessions" }, p.sessions.map((s, i) => h("div", {},
        i && s.gap_before !== null ? h("div", { class: "gap" }, `… ${fmtGap(s.gap_before)} 뒤 다시 들어옴`) : null,
        `${s.joined} 들어옴 → ${s.left}${s.reason_text !== "접속 중" ? ` 나감 (${s.reason_text})` : ""}`)))))));
  const absent = r.absent.map((a) => h("tr", { class: "absent" },
    h("td", {}, a.student_no), h("td", {}, a.name), h("td", { colspan: 6 }, "미접속")));
  $("#h-detail").replaceChildren(h("section", { class: "card", style: "margin-top:12px" },
    h("div", { class: "row" },
      h("h2", { class: "grow", style: "margin:0" }, c.title),
      h("a", { href: `/api/live/history/${id}/attendance.csv`, class: "button" }, "📥 출결 요약 CSV"),
      h("a", { href: `/api/live/history/${id}/attendance-log.csv`, class: "button" }, "📥 입·퇴장 전체 기록 CSV"),
      h("a", { href: `/api/live/history/${id}/results.csv`, class: "button" }, "📥 퀴즈 결과 CSV")),
    h("p", { class: "muted" }, `코드 ${c.code} · ${c.start} 시작 · ${c.end ? `${c.end} 종료` : (c.live ? "진행 중" : "종료 기록 없음")} · 참여 ${r.students.length}명`
      + (c.target_grade ? ` · 대상 ${c.target_grade}학년 ${c.target_class}반 (미접속 ${r.absent.length}명)` : "")),
    h("div", { class: "table-wrap" }, h("table", { class: "att" },
      h("thead", {}, h("tr", {}, ["학번", "이름", "첫 접속", "마지막 종료 (사유)", "접속 시간", "재입장", "중간 이탈", "입·퇴장 기록"].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows, absent))),
    !rows.length && !absent.length ? h("p", { class: "muted" }, "접속한 학생이 없어요.") : null,
    h("p", { class: "muted", style: "font-size:0.85rem;margin-bottom:0" },
      "접속 시간은 실제로 수업에 들어와 있던 시간의 합, 중간 이탈은 첫 접속부터 마지막 종료 사이에 나가 있던 시간이에요. "
      + "새로고침·인터넷 끊김도 모두 한 번의 나감·들어옴으로 기록되고, 연결이 끊긴 경우 나간 시각은 학생 기기에서 마지막으로 신호가 온 때예요.")));
  await loadGrades(id);
  loadClassQuestions(id);
}

/* 퀴즈·활동 채점: 수업이 끝난 뒤에도 답을 보고 점수·피드백을 줄 수 있다 */
async function loadGrades(id) {
  const box = h("section", { class: "card", id: "grades-box", style: "margin-top:12px" });
  $("#h-detail").append(box);
  await renderGrades(id, box);
}

async function renderGrades(id, box) {
  const book = await api(`/api/live/history/${id}/grades`);
  const acts = book.activities;
  const ungraded = book.summary.reduce((n, p) => n + p.ungraded, 0);
  box.replaceChildren(...[
    h("div", { class: "row" },
      h("h2", { class: "grow", style: "margin:0" }, `📝 퀴즈·활동 채점 ${acts.length}개`),
      acts.length ? h("a", { href: `/api/live/history/${id}/grades.csv`, class: "button" }, "📥 점수 CSV") : null),
    acts.length ? h("div", { class: "row" },
      h("label", { class: "switch" }, h("input", {
        type: "checkbox", checked: book.public,
        onchange: async (e) => {
          await api(`/api/live/history/${id}/publish`, { on: e.target.checked });
          toast(e.target.checked ? "학생들이 첫 화면에서 자기 점수와 피드백을 볼 수 있어요." : "학생에게 보이지 않게 했어요.");
        },
      }), "채점 결과를 학생에게 공개"),
      h("span", { class: "muted" }, ungraded ? `미채점 ${ungraded}건` : "모두 채점됨")) : null,
    !acts.length ? h("p", { class: "muted" }, "이 수업에서 보낸 퀴즈·활동이 없어요.") : null,
    ...acts.map((a) => gradeActivity(id, a, box)),
    acts.length ? h("details", { open: true }, h("summary", {}, h("strong", {}, "학생별 총점")),
      h("div", { class: "table-wrap" }, h("table", { class: "att" },
        h("thead", {}, h("tr", {}, ["학번", "이름", "총점", "만점", "미채점"].map((t) => h("th", {}, t)))),
        h("tbody", {}, book.summary.map((p) => h("tr", {},
          h("td", {}, p.student_no || "-"), h("td", {}, p.name), h("td", { class: "num" }, h("strong", {}, fmtScore(p.score))),
          h("td", { class: "num" }, fmtScore(p.max)), h("td", { class: "num" }, p.ungraded || "-"))))))) : null,
  ].filter(Boolean));
}

function gradeActivity(classId, a, box) {
  const base = `/api/live/history/${classId}/activities/${a.id}`;
  const points = h("input", { type: "number", min: 0, step: 0.5, value: a.points, style: "width:5em",
    onchange: async (e) => { await api(`${base}/points`, { points: Number(e.target.value) || 0 }); await renderGrades(classId, box); } });
  const head = h("div", { class: "row" },
    h("strong", { class: "grow" }, `${a.no}. [${a.kind_name}] ${a.prompt}`),
    a.gradable ? h("label", { class: "row" }, "배점", points, "점") : h("span", { class: "muted" }, "투표 (채점 안 함)"));
  const info = a.correct_answer ? h("div", { class: "muted" }, `정답: ${a.correct_answer} · 자동 채점됨 (점수를 바꾸면 덮어써요)`)
    : a.gradable ? h("div", { class: "muted" }, "정답이 없는 문제예요. 학생마다 점수를 주세요.") : null;
  const rows = a.rows.map((r) => {
    const save = async (score, feedback) => {
      try {
        await api(`${base}/grade`, { user_id: r.user_id, score, feedback });
        await renderGrades(classId, box);
      } catch (err) { toast(err.message); }
    };
    const scoreIn = h("input", { type: "number", min: 0, max: a.points, step: 0.5, value: r.score ?? "", placeholder: "점수", style: "width:5em" });
    const fbIn = h("input", { class: "grow", maxlength: 1000, value: r.feedback, placeholder: "피드백 (선택)" });
    const saveRow = () => save(scoreIn.value === "" ? null : Number(scoreIn.value), fbIn.value);
    scoreIn.addEventListener("change", saveRow);
    fbIn.addEventListener("change", saveRow);
    return h("tr", { class: r.score === null && a.gradable && r.answered ? "ungraded" : "" },
      h("td", {}, r.student_no || "-"), h("td", {}, r.name),
      h("td", { class: "answer" }, r.answered ? r.answer : h("span", { class: "muted" }, "(미응답)"),
        r.correct === true ? " ⭕" : r.correct === false ? " ❌" : ""),
      a.gradable ? h("td", {}, h("div", { class: "row" }, scoreIn,
        h("button", { class: "small", title: "만점", onclick: () => save(a.points, fbIn.value) }, "⭕"),
        h("button", { class: "small", title: "0점", onclick: () => save(0, fbIn.value) }, "❌"),
        r.manual ? h("span", { class: "muted", style: "font-size:0.75rem" }, "직접 채점") : null)) : null,
      a.gradable ? h("td", {}, fbIn) : null);
  });
  return h("div", { class: "box", style: "margin-top:10px" }, head, info,
    h("div", { class: "table-wrap" }, h("table", { class: "att grade" },
      h("thead", {}, h("tr", {}, ["학번", "이름", "답", ...(a.gradable ? ["점수", "피드백"] : [])].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows))));
}

/* 이 수업의 '선생님께 질문'과 답변 */
async function loadClassQuestions(id) {
  const { questions } = await api(`/api/live/history/${id}/questions`);
  const replied = questions.filter((q) => q.reply).length;
  $("#h-detail").append(h("section", { class: "card", style: "margin-top:12px" },
    h("div", { class: "row" },
      h("h2", { class: "grow", style: "margin:0" }, `💬 질문답변 ${questions.length}건`),
      questions.length ? h("a", { href: `/api/live/history/${id}/questions.csv`, class: "button" }, "📥 질문답변 CSV") : null),
    h("p", { class: "muted" }, questions.length ? `답변한 질문 ${replied}건 · 답변 없는 질문 ${questions.length - replied}건` : "이 수업에서 받은 질문이 없어요."),
    h("div", { class: "people" }, questions.map((q) => qaItem(q, `${q.time.slice(0, 5)} · ${q.student_no} ${q.name}`)))));
}

boot().catch((err) => { document.body.prepend(h("p", { class: "error" }, err.message)); });
