/* 첫 화면: 구글 로그인 → 내 정보 → 학생은 수업 입장, 선생님은 수업 열기·출결 기록 */
const params = new URLSearchParams(location.search);
let ME = null;
let CONFIG = null;

const views = ["login-view", "profile-view", "student-view", "teacher-view"];
function show(id) {
  for (const v of views) $(`#${v}`).hidden = v !== id;
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
  } else $("#code").focus();
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
  if (params.get("tab") === "history" || params.get("class")) showHomeTab("history");
}

function showHomeTab(name) {
  for (const b of $("#home-tabs").children) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of document.querySelectorAll("#teacher-view [data-panel]")) p.hidden = p.dataset.panel !== name;
  if (name === "history") loadHistory();
}
$("#home-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showHomeTab(b.dataset.tab);
});

async function loadLive() {
  const { classes } = await api("/api/live/my-classes");
  const box = $("#live-classes");
  box.replaceChildren(...classes.map((c) => h("a", { href: `/live/teacher/${c.code}` },
    `▶ ${c.title} (${c.code}) · ${fmtTime(c.created_at)} 시작`)));
  if (!classes.length) box.append(h("span", { class: "muted" }, "없어요."));
}

$("#create").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#create-error").textContent = "";
  try {
    const res = await api("/api/live/classes", {
      title: $("#title").value,
      target_grade: Number($("#t-grade").value) || null,
      target_class: Number($("#t-class").value) || null,
    });
    location.href = `/live/teacher/${res.code}`;
  } catch (err) { $("#create-error").textContent = err.message; }
});

/* 출결 기록 */

async function loadHistory() {
  const day = $("#h-date").value;
  const { classes } = await api(`/api/live/history?date=${day}`);
  $("#h-summary").textContent = `수업 ${classes.length}개`;
  const box = $("#h-classes");
  box.replaceChildren(...classes.map((c) => h("button", { class: "class-pick", "data-id": c.id, onclick: () => loadDetail(c.id) },
    `${c.start.slice(0, 5)} · ${c.title} (${c.code}) · 참여 ${c.attended}명${c.live ? " · 진행 중" : ""}`)));
  if (!classes.length) box.append(h("span", { class: "muted" }, "이 날짜에 연 수업이 없어요."));
  $("#h-detail").replaceChildren();
  const want = Number(params.get("class"));
  const pick = classes.find((c) => c.id === want) || (classes.length === 1 ? classes[0] : null);
  if (pick) loadDetail(pick.id);
}
$("#h-date").addEventListener("change", () => { params.delete("class"); loadHistory(); });

async function loadDetail(id) {
  for (const b of document.querySelectorAll(".class-pick")) b.classList.toggle("on", Number(b.dataset.id) === id);
  const r = await api(`/api/live/history/${id}`);
  const c = r.class;
  const rows = r.students.map((p) => h("tr", {},
    h("td", {}, p.student_no || "-"), h("td", {}, p.name), h("td", {}, p.first_join_text),
    h("td", {}, p.online ? h("strong", { class: "ok-text" }, "접속 중") : p.last_leave_text),
    h("td", { class: "num" }, `${p.minutes}분`), h("td", { class: "num" }, p.count),
    h("td", {}, h("details", {}, h("summary", { class: "muted" }, "기록"),
      h("div", { class: "sessions" }, p.sessions.map((s) => h("div", {}, `${s.joined} ~ ${s.left}`)))))));
  const absent = r.absent.map((a) => h("tr", { class: "absent" },
    h("td", {}, a.student_no), h("td", {}, a.name), h("td", { colspan: 5 }, "미접속")));
  $("#h-detail").replaceChildren(h("section", { class: "card", style: "margin-top:12px" },
    h("div", { class: "row" },
      h("h2", { class: "grow", style: "margin:0" }, c.title),
      h("a", { href: `/api/live/history/${id}/attendance.csv`, class: "button" }, "📥 출결 CSV"),
      h("a", { href: `/api/live/history/${id}/results.csv`, class: "button" }, "📥 퀴즈 결과 CSV")),
    h("p", { class: "muted" }, `코드 ${c.code} · ${c.start} 시작 · ${c.end ? `${c.end} 종료` : (c.live ? "진행 중" : "종료 기록 없음")} · 참여 ${r.students.length}명`
      + (c.target_grade ? ` · 대상 ${c.target_grade}학년 ${c.target_class}반 (미접속 ${r.absent.length}명)` : "")),
    h("div", { class: "table-wrap" }, h("table", { class: "att" },
      h("thead", {}, h("tr", {}, ["학번", "이름", "첫 접속", "마지막 종료", "접속 시간", "횟수", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows, absent))),
    !rows.length && !absent.length ? h("p", { class: "muted" }, "접속한 학생이 없어요.") : null,
    h("p", { class: "muted", style: "font-size:0.85rem;margin-bottom:0" },
      "접속 시간은 여러 번 들어왔다 나간 시간을 합친 값이에요. 새로고침이나 인터넷 끊김도 한 번의 나감·들어옴으로 기록돼요.")));
}

boot().catch((err) => { document.body.prepend(h("p", { class: "error" }, err.message)); });
