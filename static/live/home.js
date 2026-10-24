/* 첫 화면: 구글 로그인 → 내 정보 → 학생은 수업 입장, 선생님은 수업 열기·출결 기록 */
const params = new URLSearchParams(location.search);
let ME = null;
let CONFIG = null;

const views = ["login-view", "profile-view", "student-view", "teacher-view"];
function show(id) {
  for (const v of views) $(`#${v}`).hidden = v !== id;
  $("#student-questions").hidden = true;
}

function qaItem(q, who) {
  return h("div", { class: `q ${q.reply ? "" : "pending-reply"}` },
    h("div", { class: "meta" }, who),
    h("div", {}, `❓ ${q.text}`),
    q.reply ? h("div", { class: "reply" }, `👩‍🏫 ${q.reply}`, h("span", { class: "muted", style: "font-size:0.75rem" }, ` · ${q.reply_time.slice(0, 5)}`))
      : h("div", { class: "muted", style: "font-size:0.85rem" }, "답장 없음"));
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
  $("#code").focus();
  loadMyQuestions();
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
    `${c.start.slice(0, 5)} · ${c.title} (${c.code}) · 참여 ${c.attended}명${c.questions ? ` · 질문 ${c.questions}건` : ""}${c.live ? " · 진행 중" : ""}`)));
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
  loadClassQuestions(id);
}

/* 이 수업의 '선생님께 질문'과 답장 */
async function loadClassQuestions(id) {
  const { questions } = await api(`/api/live/history/${id}/questions`);
  const replied = questions.filter((q) => q.reply).length;
  $("#h-detail").append(h("section", { class: "card", style: "margin-top:12px" },
    h("div", { class: "row" },
      h("h2", { class: "grow", style: "margin:0" }, `💬 질문·답장 ${questions.length}건`),
      questions.length ? h("a", { href: `/api/live/history/${id}/questions.csv`, class: "button" }, "📥 질문·답장 CSV") : null),
    h("p", { class: "muted" }, questions.length ? `답장한 질문 ${replied}건 · 답장 없는 질문 ${questions.length - replied}건` : "이 수업에서 받은 질문이 없어요."),
    h("div", { class: "people" }, questions.map((q) => qaItem(q, `${q.time.slice(0, 5)} · ${q.student_no} ${q.name}`)))));
}

boot().catch((err) => { document.body.prepend(h("p", { class: "error" }, err.message)); });
