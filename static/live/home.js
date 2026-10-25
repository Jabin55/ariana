/* 첫 화면: 구글 로그인 → 내 정보 → 학생은 수업 입장, 선생님은 수업 열기·출결 기록 */
const params = new URLSearchParams(location.search);
let ME = null;
let CONFIG = null;

const views = ["login-view", "role-view", "profile-view", "guest-view", "student-view", "teacher-view"];
function show(id) {
  for (const v of views) $(`#${v}`).hidden = v !== id;
  $("#mypage-bar").hidden = id === "login-view"; // 로그인 전에는 첫 화면(소개·시작하기)만
  $("#student-questions").hidden = true;
  $("#student-results").hidden = true;
  $("#student-materials").hidden = true;
  $("#student-assignments").hidden = true;
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
  const roleName = ME?.is_admin ? "전체 관리자" : ME?.coordinator_hubs?.length ? "관리교사" : ME?.role_choice ? "가입 중"
    : { teacher: "강사", student: "학생", guest: "등록 신청" }[ME?.role];
  $("#who").textContent = ME ? `${ME.display || ME.email} (${roleName})` : "";
  if (!ME) return showLogin();
  if (ME.role_choice) {
    // 학교 계정으로 처음 들어옴: 첫 화면에서 고른 것(학생/선생님)이 있으면 그대로, 없으면 물어본다
    const pick = sessionGet("signup_as");
    if (pick) {
      try { await api("/api/me/self-role", { role: pick }); sessionDel("signup_as"); return boot(); } catch { /* 아래에서 물어본다 */ }
    }
    return showRoleChoice();
  }
  if (ME.role === "guest") return showGuest();
  if (params.get("apply")) return showGuest(true);
  if (ME.needs_profile) return showProfile();
  if (ME.role === "teacher") return showTeacher();
  return showStudent();
}

/* ───── 로그인 ───── */

const sessionGet = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const sessionSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* 사생활 보호 모드 */ } };
const sessionDel = (k) => { try { sessionStorage.removeItem(k); } catch { /* 무시 */ } };
let gsiReady = null;

function loadGsi() {
  gsiReady = gsiReady || new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve;
    s.onerror = () => reject(new Error("구글 로그인 화면을 불러오지 못했어요. 인터넷 연결을 확인해 주세요."));
    document.head.append(s);
  });
  return gsiReady;
}

function showLogin() {
  show("login-view");
  $("#dev-login").hidden = !CONFIG.dev_login;
  $("#login-step").hidden = true;
  document.querySelectorAll("#start-box .start-choices").forEach((x) => { x.hidden = false; });
  if (!CONFIG.google_client_id && !CONFIG.dev_login) {
    $("#login-error").textContent = "서버에 GOOGLE_CLIENT_ID 가 설정되지 않았어요. 선생님께 알려 주세요.";
  }
  if (CONFIG.google_client_id) loadGsi().catch((err) => { $("#login-error").textContent = err.message; });
  // 메인 화면의 '학생으로 시작'·'선생님으로 시작'에서 왔으면 바로 그 로그인 단계로
  const start = params.get("start");
  if (start === "student" || start === "staff") chooseStart(start);
}

/** 첫 화면에서 학생/선생님을 고르면 그에 맞는 구글 로그인 버튼을 보여 준다 */
async function chooseStart(role) {
  sessionSet("signup_as", role);
  $("#start-box .start-choices").hidden = true;
  $("#login-step").hidden = false;
  $("#dev-login").hidden = !CONFIG.dev_login;
  const school = CONFIG.domains.length ? `@${CONFIG.domains.join(", @")}` : "학교";
  $("#login-chosen").textContent = role === "student" ? "🎒 학생으로 시작해요" : "👩‍🏫 선생님으로 시작해요";
  $("#login-hint").textContent = role === "student"
    ? `학교에서 받은 구글 계정(${school})으로 로그인하세요.`
    : "학교 계정이든 개인 구글 계정이든 괜찮아요. 로그인한 뒤 강사·관리교사 등록을 신청해요.";
  if (!CONFIG.google_client_id) return;
  try {
    await loadGsi();
    google.accounts.id.initialize({
      client_id: CONFIG.google_client_id,
      callback: onGoogle,
      // 학생은 학교 계정을 먼저 보여 주고, 선생님은 아무 계정이나 고를 수 있게
      hd: role === "student" && CONFIG.domains.length === 1 ? CONFIG.domains[0] : undefined,
      ux_mode: "popup",
    });
    $("#google-btn").replaceChildren();
    google.accounts.id.renderButton($("#google-btn"), { theme: "outline", size: "large", text: "signin_with", locale: "ko", width: 280 });
  } catch (err) { $("#login-error").textContent = err.message; }
}
document.querySelectorAll("#start-box .start-choice").forEach((b) => b.addEventListener("click", () => chooseStart(b.dataset.role)));
$("#login-back").addEventListener("click", () => {
  sessionDel("signup_as");
  $("#login-step").hidden = true;
  $("#start-box .start-choices").hidden = false;
});

/* 학교 계정: 학생/선생님 고르기 */
function showRoleChoice() { show("role-view"); }
async function setSelfRole(role) {
  try { await api("/api/me/self-role", { role }); sessionDel("signup_as"); boot(); }
  catch (err) { toast(err.message); $("#role-error").textContent = err.message; }
}
document.querySelectorAll("#role-view .start-choice").forEach((b) => b.addEventListener("click", () => setSelfRole(b.dataset.self)));
$("#to-staff").addEventListener("click", () => {
  if (confirm("강사·관리교사 등록 신청 화면으로 갈까요? 승인되기 전까지는 학생 기능을 쓸 수 없어요.")) setSelfRole("staff");
});
$("#to-student").addEventListener("click", () => setSelfRole("student"));

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
  $("#withdraw-box").open = false;
  const student = ME.role === "student";
  document.querySelectorAll(".student-only").forEach((el) => { el.hidden = !student; });
  for (const id of ["#p-grade", "#p-class", "#p-number"]) $(id).required = student;
  $("#profile-hint").textContent = student
    ? "선생님이 출석을 확인할 수 있도록 정확하게 적어 주세요. 새 학년이 되면 여기서 고칠 수 있어요."
    : "학생들에게 보일 이름을 적어 주세요. 소속은 있으면 적고, 없으면 비워 두세요(대학교수, 현재 학교에 소속되지 않은 강사 등 누구나 강의할 수 있어요).";
  $("#p-name").value = ME.name || "";
  $("#p-school-label").textContent = student ? "학교" : "소속 (선택 — 없으면 비워 두세요)";
  $("#p-school").placeholder = student ? "예: 가나중학교" : "예: 한국대학교 정치외교학과";
  const sel = $("#p-school-select");
  sel.hidden = true;
  $("#p-school").hidden = false;
  if (student && CONFIG.schools.length) {
    sel.hidden = false;
    sel.required = true;
    $("#p-school").hidden = true;
    sel.replaceChildren(h("option", { value: "" }, "학교를 고르세요"),
      ...CONFIG.schools.map((s) => h("option", { value: s, selected: s === ME.school }, s)));
    if (CONFIG.schools.length === 1 && !ME.school) sel.value = CONFIG.schools[0];
  } else {
    $("#p-school").value = ME.school || "";
  }
  // 처음 로그인했거나 약관이 바뀌었으면 확인(동의)을 함께 받는다
  $("#p-agree-wrap").hidden = !ME.needs_terms;
  $("#p-agree").required = !!ME.needs_terms;
  $("#p-agree").checked = false;
  $("#p-agree-note").textContent = student
    ? "수업 영상은 녹화하지 않아요. 수업 화면을 녹화·캡처해 올리지 말아 주세요. 만 14세 미만 학생은 학교가 보호자 동의를 받은 뒤 이용할 수 있어요."
    : "수업에서 알게 된 학생 개인정보는 수업 목적으로만 쓰고, 내려받은 자료는 강의가 끝나면 지체 없이 지워 주세요.";
  $("#p-grade").value = ME.grade || "";
  $("#p-class").value = ME.class_no || "";
  $("#p-number").value = ME.number || "";
  updateNo();
  drawWithdraw();
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
    school: ME.role === "student" && CONFIG.schools.length ? $("#p-school-select").value : $("#p-school").value.trim(),
    agree: $("#p-agree").checked,
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

const WITHDRAW_TEXT = {
  student: "탈퇴를 신청하면 수강한 강좌의 <b>거점학교 관리교사 선생님이 승인</b>한 뒤 탈퇴돼요. 승인되면 내 정보와 출결, 질문, 퀴즈 답·점수, 과제 제출물, 수강신청 기록이 <b>모두 지워지고 되살릴 수 없어요.</b> 승인 전에는 신청을 취소할 수 있어요.",
  other: "탈퇴하면 내 정보와 등록 신청 기록이 <b>바로 지워지고 되살릴 수 없어요.</b> 직접 연 강좌나 수업이 있으면 학생 기록 보호를 위해 바로 탈퇴할 수 없어요.",
};

function drawWithdraw() {
  const student = ME.role === "student";
  $("#withdraw-box").hidden = !!ME.needs_profile;
  $("#withdraw-text").innerHTML = WITHDRAW_TEXT[student ? "student" : "other"] + " 같은 구글 계정으로 다시 로그인하면 새로 가입돼요.";
  $("#withdraw-btn").textContent = student ? "탈퇴 신청" : "탈퇴하기";
  $("#withdraw").hidden = !!ME.withdraw_requested;
  $("#withdraw-error").textContent = "";
  const st = $("#withdraw-status");
  st.replaceChildren();
  if (ME.withdraw_requested) {
    $("#withdraw-box").open = true;
    st.append(h("div", { class: "row" }, h("span", { class: "status pending grow" }, "탈퇴 신청함 · 관리교사 승인 대기 중"),
      h("button", { class: "small", onclick: async () => {
        try { await api("/api/me/withdraw/cancel", {}); ME = (await api("/api/me")).user; drawWithdraw(); toast("탈퇴 신청을 취소했어요."); } catch (err) { toast(err.message); }
      } }, "신청 취소")));
  } else if (ME.withdraw_note) {
    $("#withdraw-box").open = true;
    st.append(h("p", { class: "error" }, `탈퇴 신청이 반려됐어요: ${ME.withdraw_note}`));
  }
}

$("#withdraw").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#withdraw-error").textContent = "";
  if ($("#withdraw-confirm").value.trim() !== "탈퇴") {
    $("#withdraw-error").textContent = "확인 칸에 '탈퇴'라고 적어 주세요.";
    return;
  }
  const student = ME.role === "student";
  if (!confirm(student ? "탈퇴를 신청할까요? 관리교사 선생님이 승인하면 내 기록이 모두 지워져요." : "정말 탈퇴할까요? 내 기록이 모두 지워지고 되살릴 수 없어요.")) return;
  try {
    const r = await api("/api/me/withdraw", { confirm: "탈퇴", reason: $("#withdraw-reason").value.trim() });
    if (r.requested) {
      ME = (await api("/api/me")).user;
      $("#withdraw-confirm").value = "";
      drawWithdraw();
      toast("탈퇴를 신청했어요. 관리교사 선생님이 승인하면 탈퇴돼요.");
      return;
    }
    try { google.accounts.id.disableAutoSelect(); } catch { /* 구글 스크립트 없음 */ }
    alert("탈퇴했어요. 그동안 이용해 주셔서 고마워요.");
    location.href = "/live/about";
  } catch (err) { $("#withdraw-error").textContent = err.message; }
});

/* ───── 관리교사·강사 등록 신청 ───── */

const ROLE_NAME = { coordinator: "거점학교 관리교사", instructor: "강사" };
const MEMBER_STATUS = {
  pending: ["pending", "승인 대기"], approved: ["approved", "활동 중"], scheduled: ["pending", "활동 시작 전"],
  expired: ["rejected", "기간 끝남"], rejected: ["rejected", "거절됨"], revoked: ["rejected", "해제됨"],
};
const period = (x) => (x.valid_from || x.valid_until ? `${fmtDate(x.valid_from) || "제한 없음"} ~ ${fmtDate(x.valid_until) || "제한 없음"}` : "");
const wishPeriod = (x) => (x.wish_from || x.wish_until ? `${fmtDate(x.wish_from)} ~ ${fmtDate(x.wish_until)}` : "");

async function showGuest(fromTeacher = false) {
  show("guest-view");
  $("#lead").hidden = true;
  $("#apply-back").hidden = !fromTeacher;
  $("#guest-hint").hidden = fromTeacher;
  $("#to-student").hidden = fromTeacher || !ME.can_be_student;
  if (sessionGet("signup_as") === "student" && !ME.can_be_student) {
    // 학생을 골랐는데 학교 계정이 아닌 개인 계정으로 로그인함
    toast(`학생은 학교 구글 계정(@${CONFIG.domains.join(", @")})으로 로그인해야 해요. 오른쪽 위 '로그아웃' 후 다시 로그인해 주세요.`, 9000);
  }
  sessionDel("signup_as");
  $("#pledge-text").textContent = CONFIG.pledge;
  $("#a-name").value = ME.name || "";
  $("#a-aff").value = ME.school || "";
  const last = ME.memberships[ME.memberships.length - 1];
  $("#a-contact").value = last?.contact || "";
  $("#a-email").value = last?.email || ME.email || "";
  const meta = await subjectMeta();
  $("#a-office").replaceChildren(h("option", { value: "" }, "교육청을 고르세요"), ...meta.offices.map((x) => h("option", { value: x }, x)));
  if (last?.affil_type) {
    $("#a-affil-type").value = last.affil_type;
    $("#a-office").value = last.office || "";
    $("#a-license").value = last.license || "";
  } else {
    $("#a-office").value = "울산광역시교육청";
  }
  // 거점학교(관리교사 신청)는 울산 학교 목록에서 검색해서 고른다
  $("#school-options").replaceChildren(...CONFIG.schools.map((x) => h("option", { value: x })));
  updateAffil();
  // 내 신청 현황
  $("#my-apps").replaceChildren(...ME.memberships.map((m) => {
    const [cls, label] = MEMBER_STATUS[m.status] || ["pending", m.status];
    return h("div", { class: "box", style: "margin-bottom:6px" },
      h("div", { class: "row" }, h("strong", {}, `${m.hub} ${m.kind === "assistant" ? "팀티칭 보조교사" : ROLE_NAME[m.role]}`), h("span", { class: `status ${cls}` }, label)),
      m.status === "pending" && wishPeriod(m) ? h("div", { class: "muted", style: "font-size:0.85rem" }, `희망 기간 ${wishPeriod(m)}`) : null,
      m.status !== "pending" && period(m) ? h("div", { class: "muted", style: "font-size:0.85rem" }, `활동 기간 ${period(m)}`) : null,
      m.admin_note ? h("div", { style: "font-size:0.9rem" }, `메모: ${m.admin_note}`) : null,
      m.status === "pending" ? h("div", { class: "muted", style: "font-size:0.85rem" },
        m.role === "coordinator" ? "전체 관리자가 승인하면 관리교사 기능이 켜져요." : `${m.hub} 관리교사가 승인하면 강좌를 개설할 수 있어요.`) : null);
  }));
  // 거점학교 목록 (강사 신청용)
  const { hubs } = await api("/api/hubs");
  $("#a-hub").replaceChildren(...(hubs.length ? hubs.map((x) => h("option", { value: x.id }, x.name))
    : [h("option", { value: "" }, "아직 등록된 거점학교가 없어요")]));
  updateApplyRole();
}

let META = null;
async function subjectMeta() {
  META = META || await api("/api/subjects");
  return META;
}

// 소속 구분에 따라 칸이 바뀐다: 학교 교원은 교육청·학교, 대학 교원은 대학(학과), 미임용은 교원자격
const AFFIL = {
  school: ["소속 학교", "예: 신정고등학교", true],
  univ: ["소속 대학 (학과)", "예: 울산대학교 사회과교육과", true],
  cert: ["소속 (있으면)", "없으면 비워 두세요", false],
  other: ["소속 기관 (있으면)", "예: ○○연구소", false],
};
function updateAffil() {
  const t = $("#a-affil-type").value;
  const [label, ph, req] = AFFIL[t];
  $("#a-aff-label").textContent = label;
  $("#a-aff").placeholder = ph;
  $("#a-aff").required = req;
  $("#a-office-wrap").hidden = t !== "school";
  $("#a-office").required = t === "school";
  $("#a-license-wrap").hidden = t !== "cert";
  $("#a-license").required = t === "cert";
}
$("#a-affil-type").addEventListener("change", updateAffil);

function updateApplyRole() {
  const role = document.querySelector("input[name=a-role]:checked").value;
  $("#a-kind-wrap").hidden = role !== "instructor";
  $("#a-hub-pick").hidden = role !== "instructor";
  $("#a-hub").required = role === "instructor";
  $("#a-hub-name-wrap").hidden = role !== "coordinator";
  $("#a-hub-name").required = role === "coordinator";
  $("#a-wish-wrap").hidden = role !== "instructor";
  $("#a-wish-from").required = $("#a-wish-until").required = role === "instructor";
  $("#a-msg-wrap").hidden = role !== "coordinator";
}
document.querySelectorAll("input[name=a-role]").forEach((r) => r.addEventListener("change", updateApplyRole));
$("#apply-back").addEventListener("click", () => boot());

$("#apply").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#apply-error").textContent = "";
  const role = document.querySelector("input[name=a-role]:checked").value;
  try {
    await api("/api/staff/apply", {
      role, hub_id: role === "instructor" ? Number($("#a-hub").value) || null : null,
      hub_name: role === "coordinator" ? $("#a-hub-name").value : "",
      name: $("#a-name").value, affiliation: $("#a-aff").value, contact: $("#a-contact").value,
      affil_type: $("#a-affil-type").value, office: $("#a-affil-type").value === "school" ? $("#a-office").value : "",
      license: $("#a-affil-type").value === "cert" ? $("#a-license").value : "", email: $("#a-email").value,
      assistant: role === "instructor" && document.querySelector("input[name=a-kind]:checked").value === "assistant",
      message: role === "coordinator" ? $("#a-msg").value : "",
      wish_from: role === "instructor" ? $("#a-wish-from").value : "",
      wish_until: role === "instructor" ? $("#a-wish-until").value : "",
      pledge: $("#a-pledge").checked,
    });
    toast(role === "coordinator" ? "신청했어요. 전체 관리자가 승인하면 관리교사 기능이 켜져요."
      : "신청했어요. 거점학교 관리교사가 승인하면 강좌를 개설할 수 있어요.");
    CONFIG = await api("/api/me");
    ME = CONFIG.user;
    showGuest(!$("#apply-back").hidden);
  } catch (err) { $("#apply-error").textContent = err.message; }
});

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
  loadMyMaterials();
  loadMyAssignments();
}

/* 수강 승인된 강좌에서 지금 열린 수업 → 코드 없이 입장 */
async function loadLiveNow() {
  try {
    const { classes } = await api("/api/courses/live-now");
    const box = $("#live-now");
    box.replaceChildren(...classes.map((c) => h("div", { class: "live-item" },
      h("div", { class: "grow" }, h("div", { class: "muted", style: "font-size:0.85rem" },
        `${c.course_title}${c.instructor ? ` · ${c.instructor}` : ""} · ${fmtTime(c.started_at)} 시작`),
        h("strong", {}, c.title)),
      h("button", { class: "primary", onclick: () => join(c.code) }, "입장하기"))));
    if (!classes.length) {
      box.append(h("span", { class: "muted" }, "지금 열린 수업이 없어요. 선생님이 수업을 열면 여기에 바로 나타나요."));
    }
  } catch { /* 다음 새로고침 때 다시 시도 */ }
}

const fmtDate = (d) => (d ? d.replaceAll("-", ".") : "");
// 다른 학교 학생이 섞여 있으면 학번이 겹칠 수 있어 이름 아래에 학교를 보여 준다
const mixedSchools = (...lists) => new Set(lists.flat().map((p) => p.school || "")).size > 1;
const nameTd = (p, mixed) => h("td", {}, p.name, mixed && p.school ? h("div", { class: "muted", style: "font-size:0.75rem" }, p.school) : null);
function courseInfo(c) {
  const bits = [];
  if (c.instructor) bits.push(`강사 ${c.instructor}`);
  if (c.hub_school) bits.push(`거점학교 ${c.hub_school}`);
  if (c.start_date || c.end_date) bits.push(`강의기간 ${fmtDate(c.start_date)} ~ ${fmtDate(c.end_date)}`);
  bits.push(c.grades?.length ? `대상 ${c.grades.join("·")}학년` : "대상 전 학년");
  return h("div", { class: "course-info" }, bits.join(" · "), c.finished ? h("span", { class: "status rejected" }, "기간 종료") : null);
}

const ENROLL_STATUS = { approved: "수강 확정", pending: "강사 승인 대기", instructor_ok: "관리교사 승인 대기", rejected: "거절됨" };

async function loadCourses() {
  const { courses } = await api("/api/courses/available");
  const mine = courses.filter((c) => ["approved", "pending", "instructor_ok"].includes(c.status));
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
    h("div", { class: "grow" }, h("strong", {}, c.title), courseInfo(c),
      (c.description || courseFacts(c)) ? h("details", { class: "course-more" }, h("summary", {}, "자세히 보기"),
        courseFacts(c), c.description ? h("p", { style: "white-space:pre-wrap;margin:6px 0" }, c.description) : null) : null),
    c.status ? h("span", { class: `status ${c.status === "instructor_ok" ? "pending" : c.status}`,
      title: c.note ? `사유: ${c.note}` : "" }, ENROLL_STATUS[c.status] + (c.note ? ` (${c.note})` : "")) : null);
  $("#my-courses").replaceChildren(...mine.map((c) => h("div", { class: "row" }, line(c),
    h("button", { class: "small", onclick: () => enrollBtn(c, "DELETE") }, c.status === "pending" ? "신청 취소" : "수강 취소"))));
  if (!mine.length) $("#my-courses").append(h("span", { class: "muted" }, "아직 수강 중인 강좌가 없어요."));
  $("#open-courses").replaceChildren(...others.map((c) => h("div", { class: "row" }, line(c),
    c.recruit === "open" ? h("button", { class: "small primary", onclick: () => enrollBtn(c, "POST") }, c.status === "rejected" ? "다시 신청" : "수강신청")
      : c.recruit === "before" ? h("span", { class: "muted" }, `모집 예정 (${fmtDate(c.recruit_start)}부터)`)
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

async function loadMyMaterials() {
  try {
    const { classes } = await api("/api/materials");
    if (!classes.length) return;
    $("#my-materials").replaceChildren(...classes.slice(0, 5).map((c) => h("a", { class: "person material-link", href: `/live/materials?class=${c.id}` },
      h("span", { class: "grow" }, h("strong", {}, c.title),
        h("span", { class: "muted", style: "font-size:0.8rem" }, ` ${c.date.replaceAll("-", ".")}${c.course_title ? ` · ${c.course_title}` : ""}`)),
      h("span", { class: "muted", style: "font-size:0.85rem" }, [c.files ? `📄${c.files}` : "", c.whiteboard ? "🖊️" : ""].join(" ")))));
    $("#student-materials").hidden = false;
  } catch { /* 못 불러와도 입장에는 지장 없음 */ }
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
  const coordinator = ME.is_admin || ME.coordinator_hubs.length > 0;
  $("#admin-tab").hidden = !ME.is_admin;
  $("#hub-tab").hidden = !coordinator;
  if (ME.is_admin) loadAdmin();
  if (coordinator) loadHub();
  if (params.get("tab") === "admin" && ME.is_admin) showHomeTab("admin");
  if (params.get("tab") === "hub" && coordinator) showHomeTab("hub");
  if (params.get("tab") === "history" || params.get("class")) showHomeTab("history");
}

function showHomeTab(name) {
  for (const b of $("#home-tabs").children) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of document.querySelectorAll("#teacher-view [data-panel]")) p.hidden = p.dataset.panel !== name;
  if (name === "history") loadHistory();
  if (name === "courses") loadTeacherCourses();
  if (name === "admin") loadAdmin();
  if (name === "hub") loadHub();
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
    });
    location.href = `/live/teacher/${res.code}`;
  } catch (err) { $("#create-error").textContent = err.message; }
});

/* 강좌·수강생 관리 */

let teacherCourses = [];
const editing = new Set(); // 정보 수정 중인 강좌

function courseEditForm(c) {
  const box = h("div", { class: "edit-box" }, h("p", { class: "muted" }, "불러오는 중…"));
  courseForm(c, (saved) => {
    editing.delete(c.id);
    if (saved) toast("강좌 정보를 고쳤어요.");
    loadTeacherCourses();
  }).then((form) => box.replaceChildren(form)).catch((err) => box.replaceChildren(h("p", { class: "error" }, err.message)));
  return box;
}
const openCourse = new Set(); // 수강생 목록을 펼친 강좌

async function loadTeacherCourses() {
  ({ courses: teacherCourses } = await api("/api/courses/mine"));
  if (!$("#course-create-box").dataset.ready) drawCreateForm();
  const active = teacherCourses.filter((c) => !c.archived && !c.locked);
  // 수업 열기: 강좌 고르기
  const sel = $("#t-course");
  const cur = sel.value;
  sel.replaceChildren(...active.map((c) => h("option", { value: c.id }, c.title)),
    h("option", { value: "" }, "특강·모임 (강좌와 상관없이 수업 코드로 입장)"));
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
    ? `수강 확정된 학생 ${c.approved}명은 첫 화면에서 바로 들어와요(코드 필요 없음). 확정되지 않은 학생은 들어올 수 없어요.`
    : teacherCourses.length ? "특강·보충수업·상담처럼 한 번 여는 수업이에요. 수업 코드를 아는 학생은 누구나 들어와요."
      : "강좌를 먼저 개설하면 수강생이 코드 없이 들어올 수 있어요 ('강좌·수강생' 탭). 지금 열면 특강·모임(코드로 입장)이 돼요.";
  document.querySelectorAll(".no-course").forEach((el) => { el.hidden = !!c; });
}
$("#t-course").addEventListener("change", updateCourseHint);
$("#more-roles").addEventListener("click", () => showGuest(true));

async function drawCreateForm() {
  const box = $("#course-create-box");
  box.dataset.ready = "1";
  // 팀티칭 보조교사로만 승인된 선생님은 강좌를 직접 열지 않는다
  if (!ME.is_admin && ME.teach_hubs.length && !ME.lead_hubs.length) {
    box.replaceChildren(h("p", { class: "muted" }, "팀티칭 보조교사로 승인받았어요. 주강사가 강좌를 열 때 보조교사로 넣으면 아래 목록에 그 강좌가 나타나요."));
    return;
  }
  try {
    box.replaceChildren(await courseForm(null, () => {
      toast("강좌를 만들었어요. 모집 기간에 학생들이 수강신청할 수 있어요.");
      drawCreateForm();
      loadTeacherCourses();
    }));
  } catch (err) { box.replaceChildren(h("p", { class: "error" }, err.message)); }
}

function renderCourseList() {
  const box = $("#course-list");
  box.replaceChildren(...teacherCourses.map((c) => {
    const update = async (values) => { await api(`/api/courses/${c.id}`, values); loadTeacherCourses(); };
    const members = h("div", { class: "members-box" });
    const assignBox = h("div", { class: "assign-box" });
    const card = h("section", { class: `card course-card ${c.archived ? "archived" : ""}`, style: "margin-bottom:12px" },
      h("div", { class: "row" },
        h("h2", { class: "grow", style: "margin:0" }, c.title, c.archived ? h("span", { class: "muted" }, " (보관됨)") : null),
        h("span", {}, `수강 확정 ${c.approved}명`),
        c.pending ? h("span", { class: "status pending" }, `내 승인 대기 ${c.pending}`) : null,
        c.waiting ? h("span", { class: "status pending" }, `관리교사 승인 대기 ${c.waiting}`) : null),
      courseInfo(c),
      c.lead ? null : h("p", { style: "margin:4px 0" }, h("span", { class: "status pending" }, "팀티칭"), ` 보조교사로 참여 중 · 주강사 ${c.owner_name}`),
      courseFacts(c),
      c.description ? h("p", { class: "muted", style: "margin:4px 0;white-space:pre-wrap" }, c.description) : null,
      c.locked ? h("p", { class: "error", style: "margin:4px 0" },
        `${c.hub_school} 강사 활동 기간이 아니라서 이 강좌를 관리하거나 수업을 열 수 없어요. 계속 강의하려면 '다른 거점학교·역할 신청'으로 다시 신청하세요. 학생 개인정보 보호를 위해 이 강좌의 지난 수업 기록도 볼 수 없어요(다시 승인받으면 보여요).`) : null,
      c.locked ? null : editing.has(c.id) ? courseEditForm(c) : null,
      c.locked ? null : h("div", { class: "row", style: "margin-top:6px" },
        !c.archived ? h("label", { class: "switch" }, h("input", { type: "checkbox", checked: c.open, onchange: (e) => update({ open: e.target.checked }) }), "수강신청 받기") : null,
        h("button", { class: "small", onclick: () => { if (openCourse.has(c.id)) openCourse.delete(c.id); else openCourse.add(c.id); renderCourseList(); } },
          openCourse.has(c.id) ? "수강생 목록 접기" : "수강생 관리"),
        h("button", { class: `small ${openAssign.has(c.id) ? "on" : ""}`, onclick: () => { if (openAssign.has(c.id)) openAssign.delete(c.id); else openAssign.add(c.id); renderCourseList(); } },
          openAssign.has(c.id) ? "과제 접기" : "📝 과제"),
        h("span", { class: "grow" }),
        c.lead && !editing.has(c.id) ? h("button", { class: "small", onclick: () => { editing.add(c.id); renderCourseList(); } }, "정보 수정") : null,
        !c.lead ? null : h("button", { class: "small", onclick: () => {
          if (c.archived || confirm("학기가 끝난 강좌를 보관할까요? 수강신청이 닫히고 새 수업을 열 수 없어요. 기록은 남아요.")) update({ archived: !c.archived });
        } }, c.archived ? "보관 해제" : "보관 (학기 끝)")),
      members, assignBox);
    if (openCourse.has(c.id)) renderMembers(c, members);
    if (openAssign.has(c.id) && !c.locked) renderCourseAssignments(c, assignBox);
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
    group("pending", "승인 대기 (강사 1차 승인)", [["승인", "approved", "primary"], ["거절", "rejected"]]),
    group("instructor_ok", "관리교사 최종 승인 대기", [["빼기", "removed", "danger"]]),
    group("approved", "수강 확정", [["빼기", "removed", "danger"]]),
    group("rejected", "거절함", [["승인", "approved"], ["삭제", "removed"]]),
  ].filter(Boolean));
  if (!enrollments.length) box.append(h("p", { class: "muted" }, "아직 수강신청한 학생이 없어요."));
}

/* ───── 관리자: 강사 등록 승인 ───── */

const statusBadge = (st) => {
  const [cls, label] = MEMBER_STATUS[st] || ["pending", st];
  return h("span", { class: `status ${cls}` }, label);
};

/** 관리교사·강사 신청 카드 (승인 폼 포함) */
const AFFIL_NAME = { school: "학교 교원", univ: "대학 교원", cert: "교원자격 소지자(미임용)", other: "기타" };
function applicantInfo(x) {
  const bits = [];
  if (x.affil_type) bits.push(AFFIL_NAME[x.affil_type]);
  if (x.office) bits.push(x.office);
  bits.push(`소속 ${x.affiliation || "없음"}`);
  if (x.license) bits.push(`자격 ${x.license}`);
  bits.push(`이메일 ${x.contact_email || x.email}`);
  if (x.contact_email && x.contact_email !== x.email) bits.push(`(로그인 ${x.email})`);
  bits.push(`연락처 ${x.contact}`, `개인정보 서약 ${x.pledged ? "동의함" : "없음"}`);
  return bits.join(" · ");
}

function staffCard(x, today, reload) {
  const isCoord = x.role === "coordinator";
  const decide = async (body) => {
    try {
      await api(`/api/staff/${x.id}`, body);
      toast({ approve: "승인했어요.", reject: "거절했어요.", revoke: "권한을 해제했어요." }[body.action]);
      reload();
    } catch (err) { toast(err.message); }
  };
  const hubName = h("input", { value: x.hub, maxlength: 60, style: "width:12em" });
  // 승인 대기면 강사가 적은 희망 기간을 미리 채운다 (관리교사가 고쳐서 승인할 수 있음)
  const usesWish = x.status === "pending" && x.wish_until;
  const from = h("input", { type: "date", value: (usesWish ? x.wish_from : x.valid_from) || today });
  const until = h("input", { type: "date", value: (usesWish ? x.wish_until : x.valid_until) || "" });
  const note = h("input", { class: "grow", maxlength: 300, placeholder: "메모 (거절·해제 사유 등, 신청자에게 보여요)", value: x.admin_note || "" });
  const active = ["approved", "expired", "scheduled"].includes(x.status);
  const mine = x.user_id === ME.id && !ME.is_admin; // 본인 신청은 다른 관리교사나 전체 관리자가 처리
  return h("div", { class: "box", style: "margin-bottom:10px" },
    h("div", { class: "row" }, h("strong", {}, x.name), statusBadge(x.status),
      h("span", { class: "muted" }, x.hub),
      h("span", { class: "grow" }), h("span", { class: "muted", style: "font-size:0.8rem" }, `신청 ${new Date(x.requested_at * 1000).toLocaleDateString("ko-KR")}`)),
    h("div", { class: "muted", style: "font-size:0.9rem" }, applicantInfo(x)),
    !isCoord && x.kind === "assistant" ? h("div", { style: "font-size:0.9rem" }, h("span", { class: "status pending" }, "팀티칭 보조교사"), " 강좌를 직접 열지 않고, 주강사가 연 강좌에 함께 들어가요.") : null,
    isCoord && x.message ? h("div", { style: "font-size:0.9rem;white-space:pre-wrap" }, x.message) : null,
    !isCoord && wishPeriod(x) ? h("div", { style: "font-size:0.9rem" }, `희망 기간 ${wishPeriod(x)}`) : null,
    x.status !== "pending" && period(x) ? h("div", { class: "muted", style: "font-size:0.85rem" }, `활동 기간 ${period(x)}`) : null,
    mine ? h("div", { class: "muted", style: "font-size:0.85rem" }, "본인 신청이에요. 같은 거점학교의 다른 관리교사나 전체 관리자가 승인해요.") :
    h("div", { class: "approve-form" },
      h("div", { class: "row" },
        isCoord ? h("span", {}, "거점학교명") : null, isCoord ? hubName : null,
        "활동 기간", from, "~", until, h("span", { class: "muted", style: "font-size:0.8rem" },
          isCoord ? "(끝나는 날을 비우면 제한 없음)" : "(끝나는 날이 지나면 강사 권한이 저절로 꺼져요)")),
      h("div", { class: "row" }, note,
        h("button", { class: "primary", onclick: () => decide({ action: "approve", hub_name: hubName.value, valid_from: from.value, valid_until: until.value, note: note.value }) },
          x.status === "pending" ? "승인" : active ? "고치기" : "다시 승인"),
        x.status === "pending" ? h("button", { class: "danger", onclick: () => decide({ action: "reject", note: note.value }) }, "거절") : null,
        active ? h("button", { class: "danger", onclick: () => {
          if (confirm(`${x.name}의 권한을 해제할까요? 수업 기록은 남아요.`)) decide({ action: "revoke", note: note.value });
        } }, "권한 해제") : null)));
}

function staffSections(list, today, reload, label) {
  const section = (title, items) => items.length ? [h("h3", { class: "section-title", style: "margin:14px 0 8px" }, `${title} ${items.length}명`), ...items.map((x) => staffCard(x, today, reload))] : [];
  return [
    ...section("승인 대기", list.filter((x) => x.status === "pending")),
    ...section(label, list.filter((x) => ["approved", "scheduled", "expired"].includes(x.status))),
    ...section("거절·해제", list.filter((x) => ["rejected", "revoked"].includes(x.status))),
    ...(list.length ? [] : [h("p", { class: "muted" }, "아직 신청이 없어요.")]),
  ];
}

/* 전체 관리자: 관리교사 승인 */
/** 전체 관리자: 학생이 가입할 때 고르는 학교 목록 (정식 이름, 한 줄에 하나) */
function schoolsEditor() {
  const ta = h("textarea", { rows: 8, placeholder: "한 줄에 학교 하나씩, 정식 이름으로\n예)\n신정고등학교\n울산고등학교", value: (CONFIG.schools || []).join("\n") });
  const count = h("span", { class: "muted" }, `지금 ${CONFIG.schools.length}개`);
  return h("details", { class: "card", style: "margin:12px 0", open: !CONFIG.schools.length || null },
    h("summary", {}, h("strong", {}, "🏫 학생 학교 목록 "), count),
    h("p", { class: "muted", style: "font-size:0.9rem" }, "학생은 가입할 때 이 목록에서 학교를 골라요(직접 쓸 수 없어 이름이 줄여 쓰이지 않아요). 비워 두면 학생이 직접 적어요."),
    ta,
    h("div", { class: "row", style: "margin-top:8px" }, h("button", { class: "primary", onclick: async () => {
      try {
        const { schools } = await api("/api/admin/schools", { text: ta.value });
        CONFIG.schools = schools;
        ta.value = schools.join("\n");
        count.textContent = `지금 ${schools.length}개`;
        toast(`학교 ${schools.length}개를 저장했어요.`);
      } catch (err) { toast(err.message); }
    } }, "저장")));
}

/** 전체 관리자: 공지사항 쓰기·고치기·지우기 */
async function noticesEditor() {
  const { notices } = await api("/api/notices");
  const title = h("input", { maxlength: 120, placeholder: "제목" });
  const body = h("textarea", { rows: 6, maxlength: 20000, placeholder: "내용" });
  const pinned = h("input", { type: "checkbox" });
  let editId = null;
  const submit = h("button", { class: "primary" }, "공지 올리기");
  const reset = () => { editId = null; title.value = ""; body.value = ""; pinned.checked = false; submit.textContent = "공지 올리기"; };
  submit.onclick = async () => {
    try {
      await api("/api/admin/notices", { id: editId, title: title.value, body: body.value, pinned: pinned.checked });
      toast(editId ? "공지를 고쳤어요." : "공지를 올렸어요. 메인 화면에 보여요.");
      reset();
      loadAdmin();
    } catch (err) { toast(err.message); }
  };
  return h("details", { class: "card", style: "margin:12px 0" },
    h("summary", {}, h("strong", {}, "📢 공지사항 "), h("span", { class: "muted" }, `${notices.length}개`)),
    h("div", { class: "course-form", style: "margin-top:10px" }, h("label", { class: "wide" }, "제목", title),
      h("label", { class: "wide" }, "내용", body),
      h("label", { class: "switch" }, pinned, " 맨 위에 고정"),
      h("div", { class: "row wide" }, submit, h("button", { onclick: reset }, "새로 쓰기"))),
    h("ul", { class: "notice-list", style: "margin-top:12px" }, notices.map((n) => h("li", {},
      h("a", { href: `/live/notices/${n.id}`, target: "_blank" }, n.pinned ? "📌 " : "", n.title),
      h("span", { class: "row", style: "gap:6px;flex:0 0 auto" }, h("span", { class: "muted" }, n.date),
        h("button", { class: "small", onclick: () => {
          editId = n.id; title.value = n.title; body.value = n.body; pinned.checked = n.pinned; submit.textContent = "고친 내용 저장";
          title.focus();
        } }, "고치기"),
        h("button", { class: "small danger", onclick: async () => {
          if (!confirm(`'${n.title}' 공지를 지울까요?`)) return;
          await api(`/api/admin/notices/${n.id}/delete`, {});
          loadAdmin();
        } }, "지우기"))))));
}

/** 전체 관리자: 메인 전광판(배너). 비워 두면 기본 배너가 보여요 */
async function bannersEditor() {
  const { banners } = await api("/api/banners");
  const list = banners.map((b) => ({ ...b }));
  const THEME_NAMES = { green: "초록", orange: "주황", blue: "파랑", purple: "보라", yellow: "노랑" };
  const box = h("div");
  const draw = () => {
    box.replaceChildren(...list.map((b, i) => {
      const inp = (k, label, attrs = {}) => h("label", {}, label, h("input", { value: b[k] || "", ...attrs, oninput: (e) => { b[k] = e.target.value; } }));
      const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", onchange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const res = await fetch(`/api/admin/banners/image?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { toast(data.detail || "그림을 올리지 못했어요."); return; }
        b.image = data.image;
        draw();
      } });
      return h("div", { class: "box", style: "margin-bottom:10px" },
        h("div", { class: "row" }, h("strong", { class: "grow" }, `배너 ${i + 1}`),
          i > 0 ? h("button", { class: "small", onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); } }, "▲") : null,
          h("button", { class: "small danger", onclick: () => { list.splice(i, 1); draw(); } }, "빼기")),
        h("div", { class: "course-form" },
          inp("kicker", "작은 머리글", { maxlength: 40, placeholder: "예: 2026 여름학기" }),
          inp("title", "제목", { maxlength: 60, placeholder: "예: 여름학기 수강신청 시작!" }),
          inp("text", "설명", { maxlength: 120 }),
          inp("button", "버튼 글자", { maxlength: 20, placeholder: "예: 신청하러 가기" }),
          inp("link", "링크", { maxlength: 300, placeholder: "/live/courses 또는 https://..." }),
          h("label", {}, "배경색", h("select", { onchange: (e) => { b.theme = e.target.value; } },
            Object.entries(THEME_NAMES).map(([k, v]) => h("option", { value: k, selected: (b.theme || "green") === k }, v)))),
          h("label", { class: "wide" }, "그림 (선택 — 가로로 긴 그림, 1600×500 정도 권장. 올리면 배경으로 꽉 차요)", file,
            b.image ? h("span", { class: "row" }, h("img", { src: `/api/banners/image/${b.image}`, alt: "", style: "height:60px;border-radius:8px" }),
              h("button", { class: "small", onclick: () => { b.image = ""; draw(); } }, "그림 빼기")) : null)));
    }), list.length ? "" : h("p", { class: "muted" }, "지금은 기본 배너 3개가 보여요. 배너를 추가하면 그 배너만 보여요."));
  };
  draw();
  return h("details", { class: "card", style: "margin:12px 0" },
    h("summary", {}, h("strong", {}, "🖼️ 메인 전광판(배너) "), h("span", { class: "muted" }, list.length ? `${list.length}개` : "기본 배너")),
    h("p", { class: "muted", style: "font-size:0.9rem" }, "메인 화면 맨 위에 5초마다 넘어가며 보여요. 제목이나 그림 중 하나는 있어야 해요."),
    box,
    h("div", { class: "row" },
      h("button", { onclick: () => { if (list.length < 10) { list.push({ theme: "green" }); draw(); } } }, "+ 배너 추가"),
      h("button", { class: "primary", onclick: async () => {
        try {
          const { banners: saved } = await api("/api/admin/banners", { banners: list });
          toast(saved.length ? `배너 ${saved.length}개를 저장했어요.` : "기본 배너로 돌아갔어요.");
          loadAdmin();
        } catch (err) { toast(err.message); }
      } }, "저장"),
      h("a", { href: "/live/home", target: "_blank" }, "메인 화면 보기")));
}

async function loadAdmin() {
  const { applications, today } = await api("/api/staff/applications?role=coordinator");
  applications.forEach((x) => { x.role = "coordinator"; });
  const pending = applications.filter((x) => x.status === "pending").length;
  $("#admin-badge").textContent = pending;
  $("#admin-badge").hidden = !pending;
  $("#admin-list").replaceChildren(
    ...(CONFIG.policy_ready ? [] : [h("div", { class: "banner warn" },
      h("span", {}, "📄 개인정보 처리방침에 들어갈 운영 기관·개인정보 보호책임자·연락처가 아직 비어 있어요. 서버 콘솔에서: ",
        h("code", {}, 'live-config OPERATOR_NAME="○○고등학교" PRIVACY_OFFICER="교감 홍길동" PRIVACY_CONTACT="02-000-0000"'),
        " ", h("a", { href: "/live/privacy", target: "_blank" }, "처리방침 보기")))]),
    schoolsEditor(), await noticesEditor(), await bannersEditor(),
    h("h2", { style: "margin:8px 0 0" }, "거점학교 관리교사"),
    ...staffSections(applications, today, loadAdmin, "관리교사"));
}

/* 거점학교 관리교사: 강사 승인 + 수강신청 최종 승인 */
async function loadHub() {
  const [{ applications, today }, ov, { requests: quits }] = await Promise.all([
    api("/api/staff/applications?role=instructor"), api("/api/hub/overview"), api("/api/hub/withdrawals")]);
  applications.forEach((x) => { x.role = "instructor"; });
  const waiting = ov.enrollments.filter((e) => e.status === "instructor_ok");
  const pendingStaff = applications.filter((x) => x.status === "pending").length;
  $("#hub-badge").textContent = pendingStaff + waiting.length + quits.length;
  $("#hub-badge").hidden = !(pendingStaff + waiting.length + quits.length);
  const final = async (e, status) => {
    let note = "";
    if (status === "rejected") note = prompt(`${e.name} 학생의 수강신청을 거절하는 사유 (학생에게 보여요)`, "") ?? null;
    if (note === null) return;
    try { await api(`/api/hub/enrollments/${e.id}`, { status, note }); loadHub(); } catch (err) { toast(err.message); }
  };
  const byCourse = new Map();
  for (const e of ov.enrollments) {
    if (!byCourse.has(e.course_id)) byCourse.set(e.course_id, []);
    byCourse.get(e.course_id).push(e);
  }
  const courseBoxes = ov.courses.map((c) => {
    const list = byCourse.get(c.id) || [];
    const w = list.filter((e) => e.status === "instructor_ok");
    const p = list.filter((e) => e.status === "pending");
    const ok = list.filter((e) => e.status === "approved");
    return h("details", { class: "box", style: "margin-bottom:10px", open: w.length > 0 },
      h("summary", {}, h("strong", {}, c.title), h("span", { class: "muted" }, ` · ${c.hub_school} · 강사 ${c.instructor} · ${fmtDate(c.start_date)} ~ ${fmtDate(c.end_date)}`),
        h("span", {}, `  확정 ${ok.length}명`), w.length ? h("span", { class: "status pending" }, ` 최종 승인 대기 ${w.length}`) : null,
        p.length ? h("span", { class: "muted" }, ` · 강사 승인 전 ${p.length}명`) : null),
      w.length ? h("div", { class: "row", style: "margin-top:8px" }, h("strong", { class: "grow" }, "최종 승인 대기 (강사 승인 완료)"),
        h("button", { class: "small primary", onclick: async () => {
          const r = await api("/api/hub/approve-all", { course_id: c.id });
          toast(`${r.approved}명을 최종 승인했어요.`);
          loadHub();
        } }, "모두 최종 승인")) : null,
      h("div", { class: "people" }, w.map((e) => h("div", { class: "person" }, h("span", { class: "dot" }),
        h("span", {}, `${e.student_no || "-"} ${e.name} `, h("span", { class: "muted", style: "font-size:0.8rem" }, e.school)),
        h("span", { class: "acts" }, h("button", { class: "primary", onclick: () => final(e, "approved") }, "최종 승인"),
          h("button", { onclick: () => final(e, "rejected") }, "거절"))))),
      p.length ? h("div", { class: "muted", style: "font-size:0.85rem;margin-top:6px" }, `강사 승인 전: ${p.map((e) => e.name).join(", ")}`) : null,
      ok.length ? h("div", { class: "muted", style: "font-size:0.85rem;margin-top:6px" }, `수강 확정: ${ok.map((e) => `${e.student_no} ${e.name}${mixedSchools(ok) && e.school ? `(${e.school})` : ""}`).join(", ")}`) : null);
  });
  $("#hub-list").replaceChildren(
    h("h2", { style: "margin:8px 0" }, `📋 수강신청 최종 승인${waiting.length ? ` (${waiting.length}명 대기)` : ""}`),
    ...(courseBoxes.length ? courseBoxes : [h("p", { class: "muted" }, "아직 개설된 강좌가 없어요.")]),
    h("h2", { style: "margin:20px 0 0" }, "👩‍🏫 강사 등록"),
    ...staffSections(applications, today, loadHub, "강사"),
    h("h2", { style: "margin:20px 0 8px" }, `🚪 학생 탈퇴 신청${quits.length ? ` (${quits.length}명)` : ""}`),
    quits.length ? h("div", { class: "people" }, quits.map((q) => withdrawRow(q))) : h("p", { class: "muted" }, "없어요."));
}

function withdrawRow(q) {
  const decide = async (action) => {
    let note = "";
    if (action === "approve" && !confirm(`${q.name} 학생의 탈퇴를 승인할까요?\n출결·과제·점수 등 이 학생의 기록이 모두 지워지고 되살릴 수 없어요.`)) return;
    if (action === "reject") { note = prompt(`${q.name} 학생의 탈퇴 신청을 반려하는 사유 (학생에게 보여요)`, ""); if (note === null) return; }
    try { await api(`/api/hub/withdrawals/${q.user_id}`, { action, note }); toast(action === "approve" ? "탈퇴를 승인했어요." : "반려했어요."); loadHub(); } catch (err) { toast(err.message); }
  };
  return h("div", { class: "person", style: "flex-wrap:wrap" }, h("span", { class: "dot" }),
    h("span", { class: "grow" }, `${q.student_no || "-"} ${q.name} `, h("span", { class: "muted", style: "font-size:0.8rem" }, `${q.school} · ${new Date(q.requested_at * 1000).toLocaleDateString("ko-KR")} 신청`),
      q.reason ? h("div", { style: "font-size:0.85rem" }, `사유: ${q.reason}`) : null,
      h("div", { class: "muted", style: "font-size:0.8rem" }, q.courses.length ? `신청한 강좌: ${q.courses.join(", ")}` : "수강신청한 강좌 없음"),
      q.studying.length ? h("div", { class: "status pending", style: "font-size:0.8rem" }, `⚠️ 아직 수강 중: ${q.studying.join(", ")} — 승인하면 이 강좌 출결·과제 기록도 지워져요`) : null),
    h("span", { class: "acts" }, h("button", { class: "danger", onclick: () => decide("approve") }, "탈퇴 승인"),
      h("button", { onclick: () => decide("reject") }, "반려")));
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
  const mixed = mixedSchools(r.students, r.absent);
  const rows = r.students.map((p) => h("tr", { class: p.rejoins ? "rejoined" : "" },
    h("td", {}, p.student_no || "-"), nameTd(p, mixed), h("td", {}, p.first_join_text),
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
    h("td", {}, a.student_no), nameTd(a, mixed), h("td", { colspan: 6 }, "미접속")));
  $("#h-detail").replaceChildren(h("section", { class: "card", style: "margin-top:12px" },
    h("div", { class: "row" },
      h("h2", { class: "grow", style: "margin:0" }, c.title),
      h("a", { href: `/api/live/history/${id}/attendance.csv`, class: "button" }, "📥 출결 요약 CSV"),
      h("a", { href: `/api/live/history/${id}/attendance-log.csv`, class: "button" }, "📥 입·퇴장 전체 기록 CSV"),
      h("a", { href: `/api/live/history/${id}/results.csv`, class: "button" }, "📥 퀴즈 결과 CSV"),
      h("a", { href: `/live/materials?class=${id}`, class: "button", target: "_blank" }, "📄 수업 자료·판서")),
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
          h("td", {}, p.student_no || "-"), nameTd(p, mixedSchools(book.summary)), h("td", { class: "num" }, h("strong", {}, fmtScore(p.score))),
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
      h("td", {}, r.student_no || "-"), nameTd(r, mixedSchools(a.rows)),
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
    h("div", { class: "people" }, questions.map((q) => qaItem(q, `${q.time.slice(0, 5)} · ${q.student_no} ${q.name}${mixedSchools(questions) && q.school ? ` (${q.school})` : ""}`)))));
}

boot().catch((err) => { document.body.prepend(h("p", { class: "error" }, err.message)); });
