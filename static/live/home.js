/* 첫 화면: 구글 로그인 → 내 정보 → 학생은 수업 입장, 선생님은 수업 열기·출결 기록 */
const params = new URLSearchParams(location.search);
let ME = null;
let CONFIG = null;

const views = ["login-view", "consent-view", "done-view", "denied-view", "role-view", "profile-view", "guest-view", "student-view", "teacher-view"];
function show(id) {
  for (const v of views) $(`#${v}`).hidden = v !== id;
  $("#mypage-bar").hidden = ["login-view", "teacher-view", "student-view"].includes(id);
  $("#home-tabs").hidden = id !== "teacher-view";
  const officeBand = document.getElementById("office-submenu-band");
  if (officeBand) officeBand.hidden = id !== "teacher-view" && id !== "student-view";
  $("#student-tabs").hidden = id !== "student-view";
  $("#student-questions").hidden = true;
  $("#student-results").hidden = true;
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
  window.WaesolHeader?.render(ME); // 이름·내 정보·로그아웃은 맨 위 머리글에만
  if (!ME) {
    // 로그인 전에 그냥 /live 로 들어오면 메인 페이지부터 (로그인·회원가입·교무실 등 목적이 있으면 로그인 화면)
    const purpose = ["login", "signup", "start", "wish", "office", "profile", "apply", "tab", "course", "c", "classroom"];
    if (!purpose.some((k) => params.has(k))) { location.replace("/live/home"); return; }
    return showLogin();
  }
  // 회원가입: [회원 유형 선택] → [가입정보 입력] → [약관 동의] → [가입완료 안내]
  if (ME.role_choice) {
    // 학교 계정으로 처음 들어옴: 첫 화면에서 고른 것(학생/선생님)이 있으면 그대로, 없으면 물어본다
    const pick = sessionGet("signup_as");
    if (pick) {
      try { await api("/api/me/self-role", { role: pick }); sessionDel("signup_as"); return boot(); } catch { /* 아래에서 물어본다 */ }
    }
    return showRoleChoice();
  }
  // 가입 중이면 가입정보를 다 적은 뒤에 약관 동의를 받는다. 이미 가입한 사람은 약관이 바뀌었을 때 바로 다시 동의
  const signingUp = ME.role === "guest" ? !ME.memberships.length : !ME.name;
  if (ME.needs_terms && !signingUp) return showConsent();
  if (params.get("profile")) return showProfile();
  if (params.has("classroom") && ME.role !== "student" && !ME.is_admin) {
    show("denied-view");
    $("#lead").hidden = true;
    return;
  }
  if (ME.role === "guest") return showGuest();
  if (params.get("apply")) return showGuest(true);
  if (ME.needs_profile) return showProfile();
  if (params.has("classroom") && ME.is_admin) return showStudent();
  // [교무실]은 선생님 화면: 학생에게는 권한 없음
  if (params.get("office") && ME.role === "student") {
    show("denied-view");
    $("#lead").hidden = true;
    $(".mypage-title").textContent = "교무실";
    return;
  }
  if (ME.role === "teacher") {
    if (params.get("wish")) toast("듣고 싶은 과목 요청은 학생 계정으로 할 수 있어요. 요청 현황은 메인 화면에서 볼 수 있어요.", 6000);
    return showTeacher();
  }
  return showStudent();
}

/* ───── 회원가입 4단계: 가입완료 안내 ───── */

function showDone(kind, role, place) {
  show("done-view");
  $("#lead").hidden = true;
  const go = (label, fn, primary) => h("button", { class: primary ? "primary" : "", onclick: fn }, label);
  if (kind === "student") {
    $("#done-ico").textContent = "🎉";
    $("#done-title").textContent = "가입이 완료되었어요!";
    $("#done-body").replaceChildren(
      h("p", {}, `${ME.name} 학생, 외솔온닷에 오신 걸 환영해요.`),
      h("ul", { class: "done-list" },
        h("li", {}, "마이페이지 '수강신청'에서 듣고 싶은 강좌를 신청하세요."),
        h("li", {}, "강의교사 선생님이 승인하면 수강이 확정되고, 수업 시간에 '지금 들어갈 수 있는 수업'에서 바로 들어가요."),
        h("li", {}, "듣고 싶은 과목이 없으면 '과목 개설 요청'을 남겨 주세요.")));
    $("#done-actions").replaceChildren(go("수강신청하러 가기", () => boot(), true), h("a", { class: "button", href: "/live/courses" }, "개설 강좌 둘러보기"));
    return;
  }
  const WHO = { instructor: "전체 관리자", coordinator: "전체 관리자", participant: "전체 관리자" };
  const NAME = { instructor: "강의교사", coordinator: "관리교사", participant: "관리교사" };
  $("#done-ico").textContent = "📨";
  $("#done-title").textContent = "가입 신청이 완료되었어요";
  $("#done-body").replaceChildren(
    h("p", {}, `${ME.name} 선생님의 `, h("strong", {}, `${place ? `${place} ` : ""}${NAME[role] || "교사"}`), " 가입 신청을 받았어요."),
    h("ul", { class: "done-list" },
      h("li", {}, h("strong", {}, WHO[role] || "관리자"), "가 확인하고 승인하면 바로 이용할 수 있어요."),
      h("li", {}, "승인 상황은 로그인하면 이 화면(신청 현황)에서 볼 수 있어요."),
      role === "instructor" ? h("li", {}, "승인되면 마이페이지 '과목 개설'에서 과목을 열 수 있어요.") : null));
  $("#done-actions").replaceChildren(go("신청 현황 보기", () => boot(), true), h("a", { class: "button", href: "/live/home" }, "처음 화면으로"));
}

/* ───── 회원가입 3단계: 이용약관 · 개인정보 수집·이용 동의 (가입정보를 다 적은 뒤) ───── */

let afterConsent = null; // 동의를 받은 뒤 보낼 가입정보 { view, send }

/** 아직 약관에 동의하지 않았으면 동의 화면을 먼저 띄우고, 동의하면 그때 가입정보를 보낸다 */
function withConsent(view, send) {
  if (!ME.needs_terms) return send();
  afterConsent = { view, send };
  showConsent();
}

async function showConsent() {
  show("consent-view");
  $("#lead").hidden = true;
  for (const id of ["#c-all", "#c-terms", "#c-privacy"]) $(id).checked = false;
  $("#c-next").disabled = true;
  try {
    const t = await api("/api/consent");
    $("#c-terms-text").innerHTML = t.terms; // 서버가 만든 약관 문서
    $("#c-privacy-text").innerHTML = t.privacy;
  } catch (err) { $("#consent-error").textContent = err.message; }
}
function consentChanged() {
  const ok = $("#c-terms").checked && $("#c-privacy").checked;
  $("#c-all").checked = ok;
  $("#c-next").disabled = !ok;
}
document.querySelectorAll(".c-one").forEach((c) => c.addEventListener("change", consentChanged));
$("#c-all").addEventListener("change", (e) => {
  $("#c-terms").checked = $("#c-privacy").checked = e.target.checked;
  consentChanged();
});
$("#c-cancel").addEventListener("click", async () => {
  if (afterConsent) { // 가입정보 화면으로 돌아간다 (적은 내용 그대로)
    show(afterConsent.view);
    afterConsent = null;
    return;
  }
  await fetch("/api/auth/logout", { method: "POST" });
  location.href = "/live/home";
});
$("#c-next").addEventListener("click", async () => {
  $("#consent-error").textContent = "";
  try {
    await api("/api/me/consent", { terms: $("#c-terms").checked, privacy: $("#c-privacy").checked,
      birth: ME.role === "student" ? $("#p-student-birth").value : "" });
    ME.needs_terms = false;
    const next = afterConsent;
    afterConsent = null;
    if (!next) return boot();
    show(next.view); // 가입정보를 보내다 틀린 곳이 있으면 그 화면에서 고친다
    await next.send();
  } catch (err) { $("#consent-error").textContent = err.message; }
});

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

/** 로그인 화면(구글 버튼 바로) ↔ 회원가입 화면(회원 유형 선택부터) */
function showLoginMode(signup) {
  $("#login-box").hidden = signup;
  $("#start-box").hidden = !signup;
  if (!signup) renderLoginButton();
}

async function renderLoginButton() {
  if (!CONFIG.google_client_id) return;
  try {
    await loadGsi();
    google.accounts.id.initialize({ client_id: CONFIG.google_client_id, callback: onGoogleLogin, ux_mode: "popup" });
    $("#google-login-btn").replaceChildren();
    google.accounts.id.renderButton($("#google-login-btn"), { theme: "outline", size: "large", text: "signin_with", locale: "ko", width: 280 });
  } catch (err) { $("#login-only-error").textContent = err.message; }
}

async function onGoogleLogin(resp) {
  $("#login-only-error").textContent = "";
  try {
    await api("/api/auth/google", { credential: resp.credential, remember: $("#login-remember").checked });
    boot();
  } catch (err) {
    // 가입하지 않은 계정 (서버는 처음 가입이면 생년월일을 요구한다)
    $("#login-only-error").textContent = /생년월일/.test(err.message)
      ? "가입하지 않은 계정이에요. 아래 '회원가입'을 눌러 먼저 가입해 주세요." : err.message;
  }
}
$("#to-signup").addEventListener("click", () => showLoginMode(true));
$("#to-login").addEventListener("click", () => { sessionDel("signup_as"); showLoginMode(false); });

function showLogin() {
  show("login-view");
  $("#login-step").hidden = true;
  document.querySelectorAll("#start-box .start-choices").forEach((x) => { x.hidden = false; });
  if (!CONFIG.google_client_id) {
    const unavailable = () => { $("#login-error").textContent = "서버에 GOOGLE_CLIENT_ID 가 설정되지 않았어요. 선생님께 알려 주세요."; };
    if (["127.0.0.1", "localhost", "::1"].includes(location.hostname)) {
      fetch("/__dev/status", { cache: "no-store" })
        .then((response) => response.ok ? location.replace("/__dev/login") : unavailable())
        .catch(unavailable);
    } else unavailable();
  }
  if (CONFIG.google_client_id) loadGsi().catch((err) => { $("#login-error").textContent = err.message; });
  // 메인 화면의 '학생으로 시작'·'선생님으로 시작'에서 왔으면 바로 그 로그인 단계로
  const start = params.get("start") || (params.get("wish") ? "student" : null); // '듣고 싶은 과목 요청'은 학생 로그인으로
  // 처음 화면의 '학생으로 시작'·'선생님으로 시작'·'회원가입'에서 왔으면 회원가입, 아니면 로그인
  showLoginMode(Boolean(start) || params.has("signup"));
  if (start === "student" || start === "staff") chooseStart(start);
}

/** 첫 화면에서 학생/선생님을 고르면 그에 맞는 구글 로그인 버튼을 보여 준다 */
async function chooseStart(role) {
  sessionSet("signup_as", role);
  $("#start-box .start-choices").hidden = true;
  $("#login-step").hidden = false;
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
    await api("/api/auth/google", { credential: resp.credential, birth: $("#login-birth").value });
    boot();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
}

/* ───── 내 정보 ───── */

/** 그림을 정사각형 400px JPG 로 줄인다 (큰 휴대폰 사진도 가볍게) */
async function squarePhoto(file) {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const size = Math.min(400, side);
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  cv.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((ok) => cv.toBlob(ok, "image/jpeg", 0.88));
}

/** 프로필 사진: 동그라미(사진 또는 이름 첫 글자) + [사진 바꾸기] [사진 지우기] */
function photoPicker() {
  const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
  const after = (u) => { ME = u; window.WaesolHeader?.render(ME); drawTeacherProfile(); };
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      let body = file;
      try { body = await squarePhoto(file); } catch { /* 줄이지 못하면 원본 그대로 */ }
      const r = await fetch(`/api/me/photo?name=${encodeURIComponent(body === file ? file.name : "photo.jpg")}`, { method: "POST", body });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "사진을 올리지 못했어요.");
      toast("프로필 사진을 바꿨어요.");
      after(d);
    } catch (e) { toast(e.message); }
  });
  const avatar = ME.photo ? h("img", { class: "me-avatar", src: ME.photo, alt: "프로필 사진" })
    : h("span", { class: "me-avatar" }, (ME.name || ME.email || "?").slice(0, 1));
  return h("div", { class: "row me-photo" }, avatar, input,
    h("button", { type: "button", class: "small", onclick: () => input.click() }, ME.photo ? "사진 바꾸기" : "사진 올리기"),
    ME.photo ? h("button", { type: "button", class: "small", onclick: async () => {
      if (!confirm("프로필 사진을 지울까요?")) return;
      const r = await fetch("/api/me/photo", { method: "DELETE" });
      if (r.ok) after(await r.json());
    } }, "사진 지우기") : null);
}

/** 선생님 내 정보: 프로필 · 이름 · 성별 · 생년월일 · 소속 · 직위 · 권한정보 · 이메일 · 휴대전화 */
async function drawTeacherProfile() {
  const last = ME.memberships[ME.memberships.length - 1];
  const managedRoles = ME.memberships.filter((m) => ["participant", "coordinator"].includes(m.role) &&
    (m.status === "approved" || (m.status === "pending" && m.transfer_from)));
  const f = {
    name: h("input", { maxlength: 30, value: ME.name || "" }),
    gender: ME.gender ? h("input", { value: ME.gender, readOnly: true })
      : h("select", {}, h("option", { value: "" }, "고르세요"), ["남", "여"].map((g) => h("option", { value: g }, g))),
    birth: h("input", { type: "date", min: "1920-01-01", max: new Date().toISOString().slice(0, 10), value: ME.birth || "" }),
    school: h("input", { maxlength: 60, value: ME.school || "", placeholder: "소속 학교·기관" }),
    position: h("input", { maxlength: 30, value: ME.position || "", placeholder: "예: 교사, 부장교사, 교감" }),
    phone: h("input", { maxlength: 100, value: ME.phone || last?.contact || "", placeholder: "010-0000-0000" }),
  };
  f.name.readOnly = !!ME.name && !ME.is_admin;
  f.school.readOnly = !!ME.name;
  const roles = ME.is_admin ? ["전체 관리자", "관리교사 (모든 학교)", "강의교사 (모든 강좌)", "학생"] : [
    ...ME.coordinator_hubs.map((x) => `관리교사 (${x.name})`),
    ...ME.lead_hubs.map((x) => `거점학교 강의교사 (${x.name})`),
    ...ME.teach_hubs.filter((x) => !ME.lead_hubs.some((y) => y.id === x.id)).map((x) => `팀티칭 보조교사 (${x.name})`),
  ].filter(Boolean);
  const joinedTypes = [...new Set(ME.memberships.filter((m) => ["approved", "scheduled", "pending"].includes(m.status))
    .map((m) => ROLE_NAME[m.role] || m.role))];
  if (ME.is_admin) joinedTypes.splice(0, joinedTypes.length, "전체 관리자", "관리교사", "강의교사", "학생");
  const pending = ME.memberships.filter((m) => m.status === "pending").map((m) =>
    m.transfer_from ? `${m.transfer_from} → ${m.hub} (담당 학교 변경 승인 대기)`
      : `${m.hub} ${ROLE_NAME[m.role] || m.role} (승인 대기)`);
  const err = h("p", { class: "error" });
  const row = (label, ...v) => h("tr", {}, h("th", {}, label), h("td", {}, ...v));
  const nameBox = h("div", { class: "box", hidden: true });
  const schoolBox = h("div", { class: "box", hidden: true });
  const requestBox = (box, field, label) => {
    const input = h("input", { maxlength: field === "name" ? 30 : 60, placeholder: `새 ${label}` });
    fill(box, h("p", { class: "muted" }, `새 ${label}을 입력하면 전체 관리자에게 승인 요청이 전달됩니다. 승인 전에는 현재 정보가 유지됩니다.`),
      h("div", { class: "row" }, input, h("button", { type: "button", class: "primary", onclick: async () => {
        try {
          await api("/api/me/change-requests", { field, value: input.value.trim() });
          toast(`${label} 변경을 신청했어요.`);
          box.hidden = true;
          drawTeacherProfile();
        } catch (e) { err.textContent = e.message; }
      } }, "승인 요청")));
  };
  requestBox(nameBox, "name", "이름");
  requestBox(schoolBox, "school", "소속");
  const changeStatus = h("p", { class: "muted" });
  if (ME.name) api("/api/me/change-requests").then(({ requests }) => {
    changeStatus.textContent = ["name", "school"].map((field) => requests.find((r) => r.field === field))
      .filter(Boolean).map((r) => `${r.field === "name" ? "이름" : "소속"} 변경 신청: ` +
        `${r.old_value} → ${r.new_value} (${r.status === "pending" ? "승인 대기" : r.status === "approved" ? "승인됨" : "반려됨"}${r.note ? ` · ${r.note}` : ""})`).join(" · ");
  }).catch(() => {});
  const transferRole = h("select", {}, managedRoles.map((m) => h("option", { value: m.role }, ROLE_NAME[m.role])));
  const transferSchool = h("input", { list: "transfer-school-options", maxlength: 60, placeholder: "변경할 학교를 입력하세요" });
  const transferBox = h("div", { class: "box", style: "margin:10px 0" },
    h("p", { class: "muted", style: "margin:0 0 8px" }, "전체 관리자 승인 전까지 기존 학교와 새 학교의 담당 정보에 접근할 수 없습니다."),
    h("div", { class: "row" }, transferRole, transferSchool,
      h("datalist", { id: "transfer-school-options" }, CONFIG.schools.map((s) => h("option", { value: s }))),
      h("button", { class: "primary", type: "button", onclick: () => withConsent("profile-view", async () => {
        try {
          ME = await api("/api/me/school-transfer", { role: transferRole.value, school: transferSchool.value.trim() });
          toast("담당 학교 변경 승인을 요청했어요.");
          window.WaesolHeader?.render(ME);
          drawTeacherProfile();
        } catch (e) { err.textContent = e.message; }
      }) }, "승인 요청")));
  transferBox.hidden = true;
  $("#t-profile").replaceChildren(
    h("table", { class: "me-table" }, h("tbody", {},
      row("프로필", photoPicker()),
      row("이름", h("div", { class: "me-school" }, f.name, ME.name && !ME.is_admin ? h("button", { class: "small", type: "button", onclick: () => { nameBox.hidden = !nameBox.hidden; } }, "변경 신청") : null)),
      row("성별", f.gender),
      row("생년월일", f.birth),
      row("소속", h("div", { class: "me-school" }, f.school,
        h("button", { class: "small", type: "button", onclick: () => {
          const box = managedRoles.length ? transferBox : schoolBox;
          box.hidden = !box.hidden;
          if (!transferBox.hidden) transferSchool.focus();
        } }, "변경 신청"))),
      row("직위", f.position),
      row("가입 유형", h("div", { class: "row" },
        h("span", { class: "grow" }, joinedTypes.length ? joinedTypes.join(", ") : "거점학교 강의교사"),
        h("button", { class: "small", type: "button", onclick: () => showGuest(true, true, true) }, "변경 신청"))),
      row("권한 정보", roles.length ? roles.join(", ") : h("span", { class: "muted" }, "아직 승인된 권한이 없어요"),
        pending.length ? h("div", { class: "muted", style: "font-size:0.82rem" }, pending.join(", ")) : null),
      row("이메일", h("strong", {}, ME.email), h("span", { class: "muted", style: "font-size:0.82rem" }, "  (가입한 구글 계정)")),
      row("휴대전화", f.phone))),
    nameBox,
    managedRoles.length ? transferBox : schoolBox,
    changeStatus,
    err,
    h("button", { class: "primary", type: "button", style: "width:100%", onclick: async () => {
      err.textContent = "";
      const profile = {
        name: f.name.value.trim(), school: f.school.value.trim(), gender: f.gender.value, birth: f.birth.value,
        phone: f.phone.value.trim(), position: f.position.value.trim(),
      };
      withConsent("profile-view", async () => {
        try {
          const first = !ME.name;
          ME = await api("/api/me/profile", profile);
          toast(ME.school_transfer_requested ? "담당 학교 변경 승인을 요청했어요." : "내 정보를 저장했어요.");
          window.WaesolHeader?.render(ME);
          if (first) return boot();
          drawTeacherProfile();
        } catch (e) { err.textContent = e.message; }
      });
    } }, "저장"));
}

function showProfile() {
  show("profile-view");
  const teacherView = ME.role === "teacher";
  $("#t-profile").hidden = !teacherView;
  $("#profile").hidden = teacherView;
  if (teacherView) drawTeacherProfile();
  $("#withdraw-box").open = false;
  const student = ME.role === "student";
  document.querySelectorAll(".student-only").forEach((el) => { el.hidden = !student; });
  document.querySelectorAll(".teacher-only").forEach((el) => { el.hidden = student; });
  if (!student) {
    const last = ME.memberships[ME.memberships.length - 1];
    $("#p-birth").value = ME.birth || "";
    $("#p-birth").max = new Date().toISOString().slice(0, 10);
    $("#p-gender").value = ME.gender || "";
    $("#p-gender").disabled = !!ME.gender;
    $("#p-email").value = ME.contact_email || last?.email || ME.email || "";
    $("#p-phone").value = ME.phone || last?.contact || "";
  }
  for (const id of ["#p-grade", "#p-class", "#p-number"]) $(id).required = student;
  $("#p-student-birth").required = student;
  $("#p-student-gender").required = student;
  $("#p-student-birth").value = student ? (ME.birth || $("#login-birth").value || "") : "";
  $("#p-student-birth").max = new Date().toISOString().slice(0, 10);
  $("#p-student-gender").value = student ? (ME.gender || "") : "";
  $("#profile-hint").hidden = !student;
  $("#profile-hint").textContent = student
    ? "선생님이 출석을 확인할 수 있도록 정확하게 적어 주세요. 새 학년이 되면 여기서 고칠 수 있어요."
    : "";
  $("#p-name").value = ME.name || "";
  $("#p-name").readOnly = !!ME.name && !ME.is_admin;
  $("#p-name-request").hidden = !ME.name || ME.is_admin;
  $("#p-name-note").textContent = ME.is_admin ? "전체 관리자는 이름을 바로 수정할 수 있어요."
    : ME.name ? "이름 변경은 전체 관리자에게 신청해 주세요."
    : "실명으로 적어 주세요. 가입한 뒤에는 이름을 바꿀 수 없어요.";
  $("#p-school-label").textContent = student ? "학교" : "소속";
  $("#p-school").placeholder = student ? "예: 가나중학교" : "예: 한국대학교 정치외교학과";
  const sel = $("#p-school-select");
  sel.hidden = true;
  $("#p-school").hidden = false;
  if (student && CONFIG.schools.length) {
    sel.hidden = false;
    sel.required = true;
    $("#p-school").hidden = true;
    sel.replaceChildren(h("option", { value: "" }, "학교를 고르세요"),
      ...koSort(CONFIG.schools).map((s) => h("option", { value: s, selected: s === ME.school }, s)));
    if (CONFIG.schools.length === 1 && !ME.school) sel.value = CONFIG.schools[0];
  } else {
    $("#p-school").value = ME.school || "";
  }
  sel.disabled = !!ME.name;
  $("#p-school").readOnly = !!ME.name;
  $("#p-school-request").hidden = !ME.name;
  $("#profile-change-box").hidden = true;
  $("#profile-change-status").textContent = "";
  if (ME.name) api("/api/me/change-requests").then(({ requests }) => {
    if (ME.role !== "student") return;
    const latest = ["school", "name"].map((field) => requests.find((r) => r.field === field)).filter(Boolean);
    $("#profile-change-status").textContent = latest.map((r) =>
      `${r.field === "school" ? "소속학교" : "이름"} 변경 신청: ${r.old_value} → ${r.new_value} ` +
      `(${r.status === "pending" ? "승인 대기" : r.status === "approved" ? "승인됨" : "반려됨"}${r.note ? ` · ${r.note}` : ""})`).join(" · ");
  }).catch(() => {});
  // 처음 가입할 때(정보를 아직 안 적음): 가입 단계 표시와 안내
  $("#profile-steps").hidden = !ME.needs_profile;
  $("#p-agree-note").hidden = !ME.needs_profile;
  $("#p-agree-note").textContent = student
    ? "만 14세 이상만 가입할 수 있어요. 생년월일은 연령과 학번 점검에, 성별은 학교 입력 점검에 사용합니다."
    : "수업에서 알게 된 학생 개인정보는 수업 목적으로만 쓰고, 내려받은 자료는 강의가 끝나면 지체 없이 지워 주세요.";
  $("#p-grade").value = ME.grade || "";
  $("#p-class").value = ME.class_no || "";
  $("#p-number").value = ME.number || "";
  updateNo();
  drawWithdraw();
}

function openStudentChange(field) {
  const box = $("#profile-change-box");
  if (!box.hidden && box.dataset.field === field) { box.hidden = true; return; }
  box.dataset.field = field;
  box.hidden = false;
  const label = field === "school" ? "소속학교" : "이름";
  const input = field === "school" && CONFIG.schools.length
    ? h("select", {}, h("option", { value: "" }, "새 학교를 고르세요"),
      koSort(CONFIG.schools).filter((s) => s !== ME.school).map((s) => h("option", { value: s }, s)))
    : h("input", { maxlength: field === "name" ? 30 : 60, placeholder: `새 ${label}` });
  const approver = field === "school" ? "새 학교의 참여학교 담당교사" : "전체 관리자";
  fill(box, h("p", { class: "muted" }, `${approver}가 승인하면 ${label}가 바뀝니다. 승인 전에는 현재 정보가 유지됩니다.`),
    h("div", { class: "row" }, input, h("button", { type: "button", class: "primary", onclick: async () => {
      try {
        await api("/api/me/change-requests", { field, value: input.value.trim() });
        toast(`${label} 변경을 신청했어요.`);
        showProfile();
      } catch (e) { $("#profile-error").textContent = e.message; }
    } }, "승인 요청")));
}
$("#p-name-request").onclick = () => openStudentChange("name");
$("#p-school-request").onclick = () => openStudentChange("school");

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
  };
  if (ME.role === "student") {
    Object.assign(body, { grade: Number($("#p-grade").value), class_no: Number($("#p-class").value), number: Number($("#p-number").value),
      birth: $("#p-student-birth").value, gender: $("#p-student-gender").value });
  } else {
    Object.assign(body, { birth: $("#p-birth").value, gender: $("#p-gender").value, email: $("#p-email").value.trim(), phone: $("#p-phone").value.trim() });
  }
  const first = !ME.name; // 처음 가입이면 '가입완료' 안내로
  withConsent("profile-view", async () => {
    try {
      ME = await api("/api/me/profile", body);
      if (first && ME.role === "student") showDone("student");
      else boot();
    } catch (err) { $("#profile-error").textContent = err.message; }
  });
});
window.showProfile = showProfile; // 머리글의 '내 정보' 버튼

const WITHDRAW_TEXT = {
  student: "탈퇴를 신청하면 우리 학교 <b>참여학교 담당 선생님이 승인</b>한 뒤 탈퇴돼요. 승인되면 로그인과 일반 수업 화면에서 내 정보와 기록이 제거됩니다. 수업 증빙에 필요한 기록은 암호화해 별도로 보관하며 승인된 우리 학교 담당자와 전체 관리자만 사유를 남기고 열람할 수 있습니다. 승인 전에는 신청을 취소할 수 있어요.",
  other: "탈퇴하면 내 정보와 등록 신청 기록이 <b>바로 지워지고 되살릴 수 없어요.</b> 직접 연 강좌나 수업이 있으면 학생 기록 보호를 위해 바로 탈퇴할 수 없어요.",
};

function drawWithdraw() {
  const student = ME.role === "student";
  $("#withdraw-box").hidden = !!ME.needs_profile;
  $("#withdraw-text").innerHTML = WITHDRAW_TEXT[student ? "student" : "other"] + (student ? " 다시 이용하려면 운영 담당자에게 재가입을 문의해 주세요." : " 같은 구글 계정으로 다시 로그인하면 새로 가입돼요.");
  $("#withdraw-btn").textContent = student ? "탈퇴 신청" : "탈퇴하기";
  $("#withdraw").hidden = !!ME.withdraw_requested;
  $("#withdraw-error").textContent = "";
  const st = $("#withdraw-status");
  st.replaceChildren();
  if (ME.withdraw_requested) {
    $("#withdraw-box").open = true;
    st.append(h("div", { class: "row" }, h("span", { class: "status pending grow" }, "탈퇴 신청함 · 우리 학교 선생님 승인 대기 중"),
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
  if (!confirm(student ? "탈퇴를 신청할까요? 승인되면 로그인할 수 없고 수업 증빙 기록은 별도로 보관됩니다." : "정말 탈퇴할까요? 내 기록이 모두 지워지고 되살릴 수 없어요.")) return;
  try {
    const r = await api("/api/me/withdraw", { confirm: "탈퇴", reason: $("#withdraw-reason").value.trim() });
    if (r.requested) {
      ME = (await api("/api/me")).user;
      $("#withdraw-confirm").value = "";
      drawWithdraw();
      toast("탈퇴를 신청했어요. 우리 학교 선생님이 승인하면 탈퇴돼요.");
      return;
    }
    try { google.accounts.id.disableAutoSelect(); } catch { /* 구글 스크립트 없음 */ }
    alert("탈퇴했어요. 그동안 이용해 주셔서 고마워요.");
    location.href = "/live/about";
  } catch (err) { $("#withdraw-error").textContent = err.message; }
});

/* ───── 관리교사·강사 등록 신청 ───── */

const ROLE_NAME = { coordinator: "관리교사", instructor: "강의교사", participant: "관리교사" };
const MEMBER_STATUS = {
  pending: ["pending", "승인 대기"], approved: ["approved", "활동 중"], scheduled: ["pending", "활동 시작 전"],
  expired: ["rejected", "기간 끝남"], rejected: ["rejected", "거절됨"], revoked: ["rejected", "해제됨"],
};
const period = (x) => (x.valid_from || x.valid_until ? `${fmtDate(x.valid_from) || "제한 없음"} ~ ${fmtDate(x.valid_until) || "제한 없음"}` : "");
const wishPeriod = (x) => (x.wish_from || x.wish_until ? `${fmtDate(x.wish_from)} ~ ${fmtDate(x.wish_until)}` : "");

let guestReturnToProfile = false;
let guestReplacingRole = false;
async function showGuest(fromTeacher = false, returnToProfile = false, replacingRole = false) {
  guestReturnToProfile = returnToProfile;
  guestReplacingRole = replacingRole;
  show("guest-view");
  $("#lead").hidden = true;
  $("#apply-back").hidden = !fromTeacher;
  const firstApply = !fromTeacher && !ME.memberships.length;
  $("#guest-steps").hidden = !firstApply;
  $("#guest-title").textContent = firstApply ? "교사 가입정보 입력" : replacingRole ? "가입 유형·거점학교 변경 신청" : "역할 추가 신청 · 신청 현황";
  $("#a-birth").max = new Date().toISOString().slice(0, 10);
  if (ME.birth) $("#a-birth").value = ME.birth;
  $("#a-gender").value = ME.gender || "";
  $("#a-gender").disabled = !!ME.gender;
  $("#guest-hint").hidden = fromTeacher;
  $("#to-student").hidden = fromTeacher || !ME.can_be_student;
  if (sessionGet("signup_as") === "student" && !ME.can_be_student) {
    // 학생을 골랐는데 학교 계정이 아닌 개인 계정으로 로그인함
    toast(`학생은 학교 구글 계정(@${CONFIG.domains.join(", @")})으로 로그인해야 해요. 오른쪽 위 '로그아웃' 후 다시 로그인해 주세요.`, 9000);
  }
  sessionDel("signup_as");
  $("#pledge-text").textContent = CONFIG.pledge;
  $("#a-name").value = ME.name || "";
  $("#a-name").readOnly = !!ME.name && !ME.is_admin;
  $("#a-name").title = $("#a-name").readOnly ? "이름 변경은 내 정보에서 신청해 주세요." : "실명으로 적어 주세요. 가입한 뒤에는 바꿀 수 없어요.";
  $("#a-aff").value = ME.school || "";
  const last = ME.memberships[ME.memberships.length - 1];
  const activeRoles = ME.memberships.filter((m) => ["approved", "scheduled"].includes(m.status));
  $("#a-replace-wrap").hidden = !replacingRole || !activeRoles.length;
  $("#a-replace").required = replacingRole && !!activeRoles.length;
  $("#a-replace").replaceChildren(...activeRoles.map((m) => h("option", { value: m.id },
    `${ROLE_NAME[m.role] || m.role} (${m.hub})`)));
  $("#a-contact").value = last?.contact || "";
  $("#a-email").value = last?.email || ME.email || "";
  const meta = await subjectMeta();
  $("#a-office").replaceChildren(h("option", { value: "" }, "교육청을 고르세요"), ...koSort(meta.offices).map((x) => h("option", { value: x }, x)));
  if (last?.affil_type) {
    $("#a-affil-type").value = last.affil_type;
    $("#a-office").value = last.office || "";
    $("#a-license").value = last.license || "";
  } else {
    $("#a-office").value = "울산광역시교육청";
  }
  $("#a-dept").value = last?.department || "";
  // 거점학교(관리교사 신청)는 울산 학교 목록에서 검색해서 고른다
  $("#school-options").replaceChildren(...koSort(CONFIG.schools).map((x) => h("option", { value: x })));
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
        m.role === "coordinator" ? "전체 관리자가 승인하면 관리교사 기능이 켜져요."
          : m.role === "participant" ? "전체 관리자가 승인하면 우리 학교 학생을 관리할 수 있어요."
            : "전체 관리자가 승인하면 과목을 개설할 수 있어요.") : null);
  }));
  // 강의교사는 거점학교를 정하지 않는다 (과목을 열 때마다 고른다)
  updateApplyRole();
}

let META = null;
async function subjectMeta() {
  META = META || await api("/api/subjects");
  return META;
}

// 소속 구분에 따라 칸이 바뀐다: 학교 교원은 교육청·학교, 대학 교원은 대학·학과, 미임용은 교원자격
const AFFIL = {
  school: ["소속 학교", "예: 신정고등학교", true],
  univ: ["소속 대학", "예: 울산대학교", true],
  cert: ["소속 (있으면)", "없으면 비워 두세요", false],
  other: ["소속 기관 (있으면)", "예: ○○연구소", false],
};
function syncManagedSchool() {
  const role = document.querySelector("input[name=a-role]:checked").value;
  const sameSchool = role !== "instructor" && $("#a-affil-type").value === "school";
  $("#a-aff").readOnly = sameSchool;
  if (sameSchool) $("#a-aff").value = $("#a-hub-name").value.trim();
}
function updateAffil() {
  const t = $("#a-affil-type").value;
  const [label, ph, req] = AFFIL[t];
  $("#a-aff-label").textContent = label;
  $("#a-aff").placeholder = ph;
  $("#a-aff").required = req;
  $("#a-aff-required").hidden = !req;
  $("#a-office-wrap").hidden = t !== "school";
  $("#a-office").required = t === "school";
  $("#a-dept-wrap").hidden = t !== "univ";
  $("#a-dept").required = t === "univ";
  $("#a-license-wrap").hidden = t !== "cert";
  $("#a-license").required = t === "cert";
  syncManagedSchool();
}
$("#a-affil-type").addEventListener("change", updateAffil);
$("#a-hub-name").addEventListener("input", syncManagedSchool);

function updateApplyRole() {
  const role = document.querySelector("input[name=a-role]:checked").value;
  const affiliationType = $("#a-affil-type");
  if (role !== "instructor") affiliationType.value = "school";
  affiliationType.disabled = role !== "instructor";
  updateAffil();
  $("#a-kind-wrap").hidden = role !== "instructor";
  $("#a-hub-name-wrap").hidden = role === "instructor";
  $("#a-hub-name").required = role !== "instructor";
  $("#a-hub-name-label").textContent = "근무 중인 학교";
  $("#a-wish-wrap").hidden = role !== "instructor";
  $("#a-wish-from").required = $("#a-wish-until").required = role === "instructor";
  $("#a-msg-wrap").hidden = role !== "coordinator";
  syncManagedSchool();
}
document.querySelectorAll("input[name=a-role]").forEach((r) => r.addEventListener("change", updateApplyRole));
$("#apply-back").addEventListener("click", () => guestReturnToProfile ? showProfile() : boot());

$("#apply").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#apply-error").textContent = "";
  const role = document.querySelector("input[name=a-role]:checked").value;
  const first = !ME.memberships.length; // 처음 가입 신청이면 '가입완료' 안내로
  const place = role === "instructor" ? "" : $("#a-hub-name").value.trim();
  withConsent("guest-view", () => sendApply(role, first, place));
});

async function sendApply(role, first, place) {
  try {
    await api("/api/staff/apply", {
      role, hub_id: null,
      replace_membership_id: guestReplacingRole ? Number($("#a-replace").value) || null : null,
      hub_name: role !== "instructor" ? $("#a-hub-name").value : "",
      name: $("#a-name").value, affiliation: $("#a-aff").value, contact: $("#a-contact").value, birth: $("#a-birth").value, gender: $("#a-gender").value,
      affil_type: $("#a-affil-type").value, office: $("#a-affil-type").value === "school" ? $("#a-office").value : "",
      department: $("#a-affil-type").value === "univ" ? $("#a-dept").value.trim() : "",
      license: $("#a-affil-type").value === "cert" ? $("#a-license").value : "", email: $("#a-email").value,
      assistant: role === "instructor" && document.querySelector("input[name=a-kind]:checked").value === "assistant",
      message: role === "coordinator" ? $("#a-msg").value : "",
      wish_from: role === "instructor" ? $("#a-wish-from").value : "",
      wish_until: role === "instructor" ? $("#a-wish-until").value : "",
      pledge: $("#a-pledge").checked,
    });
    toast(role === "coordinator" ? "신청했어요. 전체 관리자가 승인하면 학교 운영·학생 관리 기능이 켜져요."
      : role === "participant" ? "신청했어요. 전체 관리자가 승인하면 우리 학교 학생을 관리할 수 있어요."
        : "신청했어요. 전체 관리자가 승인하면 과목을 개설할 수 있어요.");
    CONFIG = await api("/api/me");
    ME = CONFIG.user;
    if (first) return showDone("teacher", role, place);
    showGuest(!$("#apply-back").hidden, guestReturnToProfile, guestReplacingRole);
  } catch (err) { $("#apply-error").textContent = err.message; }
}

/* ───── 학생 ───── */

function showStudent() {
  show("student-view");
  $(".mypage-title").textContent = "강의실";
  document.title = "외솔온닷 · 강의실";
  if (params.get("wish")) { location.replace("/live/course-requests"); return; }
  const coursesTab = params.get("tab") === "courses";
  $("#student-listen-panel").hidden = coursesTab;
  $("#student-courses-panel").hidden = !coursesTab;
  document.querySelectorAll("#student-tabs a").forEach((a) => a.classList.toggle("on", a.dataset.studentTab === (coursesTab ? "courses" : "listen")));
  const code = (params.get("c") || "").toUpperCase();
  if (code) {
    $("#code").value = code;
    join(code); // 링크로 들어왔으면 바로 입장
    return;
  }
  if (coursesTab) loadCourses();
  else {
    loadLiveNow();
    setInterval(loadLiveNow, 15000); // 선생님이 수업을 열면 곧바로 보이게
  }
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
  bits.push(`대상 ${(c.grades?.length ? c.grades : [1, 2, 3]).map((g) => `${g}학년`).join(", ")}`);
  return h("div", { class: "course-info" }, bits.join(" · "), c.finished ? h("span", { class: "status rejected" }, "기간 종료") : null);
}

async function loadCourses() {
  try {
    const { courses } = await api("/api/courses/my-learning");
    const box = $("#my-courses");
    if (!courses.length) return box.replaceChildren(h("p", { class: "muted" }, "신청한 강좌가 없어요."),
      h("a", { href: "/live/courses" }, "수강신청으로 이동"));
    box.replaceChildren(h("table", { class: "classroom-course-board" },
      h("thead", {}, h("tr", {}, ["번호", "신청 학기", "강좌명", "거점학교", "강의교사", "상태"].map((x) => h("th", {}, x)))),
      h("tbody", {}, courses.map((c, i) => {
        const [state, label] = classroomCourseStatus(c);
        return h("tr", {}, h("td", {}, String(courses.length - i)),
          h("td", {}, [c.school_year ? `${c.school_year}학년도` : "", c.term || ""].filter(Boolean).join(" ") || "-"),
          h("td", {}, h("button", { class: "link-btn classroom-course-open", onclick: () => openStudentCourse(c) }, c.title)),
          h("td", {}, c.hub_school || "-"), h("td", {}, c.instructor || "-"),
          h("td", {}, h("span", { class: `status ${state}` }, label)));
      }))));
  } catch (err) {
    $("#my-courses").textContent = err.message;
  }
}

function classroomCourseStatus(c) {
  if (c.status === "pending") return ["pending", "승인 대기"];
  if (c.status === "rejected") return ["rejected", "반려"];
  if (c.status === "removed") return ["rejected", "수강 취소"];
  if (c.archived || c.finished) return ["approved", "수강 완료"];
  if (c.start_date && c.start_date > new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })) return ["approved", "수강 확정"];
  return ["approved", "수강 중"];
}

let selectedStudentCourseId = null;
function openStudentCourse(c) {
  selectedStudentCourseId = c.id;
  $("#student-course-list").hidden = true;
  const detail = $("#student-course-detail");
  detail.hidden = false;
  for (const id of ["student-assignments", "student-results", "student-questions"]) {
    const section = $(`#${id}`);
    section.hidden = true;
    detail.append(section);
  }
  const content = $("#student-course-content");
  const [state, label] = classroomCourseStatus(c);
  const materials = h("div", { class: "course-materials" });
  content.replaceChildren(
    h("div", { class: "row" }, h("h2", { class: "grow" }, c.title), h("span", { class: `status ${state}` }, label)),
    courseInfo(c), courseFacts(c),
    c.description ? h("p", { style: "white-space:pre-wrap" }, c.description) : null,
    c.note ? h("p", { class: "error" }, `반려 사유: ${c.note}`) : null,
    c.notices?.length ? h("section", {}, h("h3", {}, "강좌 공지"), ...c.notices.map((n) => h("details", { class: "box" },
      h("summary", {}, n.title, ` · ${fmtDate(n.date)}`), h("p", { style: "white-space:pre-wrap" }, n.body)))) : null,
    c.status === "approved" ? h("section", {}, h("h3", {}, "수업별 자료"), materials) :
      h("p", { class: "muted" }, "수강이 확정되면 각 수업의 자료를 볼 수 있어요."));
  if (c.status === "approved") {
    loadCourseMaterials(c.id, materials);
    loadMyAssignments(c.id);
    loadMyResults(c.id);
    loadMyQuestions(c.id);
  }
  $("#student-course-detail").scrollIntoView({ block: "start" });
}

$("#student-course-back").addEventListener("click", () => {
  selectedStudentCourseId = null;
  $("#student-course-detail").hidden = true;
  $("#student-course-list").hidden = false;
});

async function loadCourseMaterials(courseId, box) {
  box.replaceChildren(h("span", { class: "muted" }, "불러오는 중…"));
  try {
    const { classes } = await api(`/api/materials?course_id=${courseId}`);
    if (!classes.length) return box.replaceChildren(h("p", { class: "muted" }, "아직 볼 수 있는 지난 수업 자료가 없어요."));
    box.replaceChildren(...classes.map((c) => h("a", { class: "person material-link", href: `/live/materials?class=${c.id}&from=courses` },
      h("span", { class: "grow" }, h("strong", {}, c.title),
        h("span", { class: "muted", style: "font-size:0.8rem" }, ` ${fmtDate(c.date)}`)),
      h("span", { class: "muted", style: "font-size:0.85rem" }, [c.files ? `자료 ${c.files}개` : "", c.whiteboard ? "판서" : ""].filter(Boolean).join(" · ")))));
  } catch (err) { box.textContent = err.message; }
}

async function loadMyResults(courseId = null) {
  try {
    const { classes } = await api("/api/live/my-results");
    if (courseId !== null && selectedStudentCourseId !== courseId) return;
    const mine = courseId === null ? classes : classes.filter((c) => c.course_id === courseId);
    if (!mine.length) return;
    $("#my-results").replaceChildren(...mine.map((c) => h("details", { class: "result-class" },
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

async function loadMyQuestions(courseId = null) {
  try {
    const { questions } = await api("/api/live/my-questions");
    if (courseId !== null && selectedStudentCourseId !== courseId) return;
    const mine = courseId === null ? questions : questions.filter((q) => q.course_id === courseId);
    if (!mine.length) return;
    $("#my-q").replaceChildren(...mine.map((q) => qaItem(q, `${q.date} ${q.time.slice(0, 5)} · ${q.class_title}`)));
    $("#student-questions").hidden = false;
  } catch { /* 기록을 못 불러와도 입장에는 지장 없음 */ }
}

async function join(code) {
  $("#join-error").textContent = "";
  try {
    const studentMode = ME.is_admin ? "?as_student=1" : "";
    await api(`/api/live/classes/${code}/join${studentMode}`, {});
    location.href = `/live/class/${code}${studentMode}`;
  } catch (err) { $("#join-error").textContent = err.message; }
}

$("#join").addEventListener("submit", (e) => {
  e.preventDefault();
  join($("#code").value.trim().toUpperCase());
});

/* 선생님 마이페이지 탭은 teacher-home.js */

async function renderMembers(c, box) {
  const { enrollments } = await api(`/api/courses/${c.id}/enrollments`);
  const decide = async (e, status) => {
    if (status === "removed" && !confirm(`${e.name} 학생을 이 강좌에서 뺄까요?`)) return;
    try {
      await api(`/api/courses/${c.id}/enrollments/${e.user_id}`, { status });
      if (status === "approved") toast(`${e.name} 학생이 수강 확정됐어요.`);
    } catch (err) { toast(err.message, 6000); }
    loadTeacherCourses();
  };
  const group = (status, title, actions) => {
    const list = enrollments.filter((e) => e.status === status);
    if (!list.length) return null;
    return h("div", { class: "box", style: "margin-top:8px" },
      h("div", { class: "row" }, h("strong", { class: "grow" }, `${title} ${list.length}명`),
        status === "pending" ? h("button", { class: "small primary", onclick: async () => {
          try {
            const r = await api(`/api/courses/${c.id}/approve-all`, {});
            toast(`${r.approved}명을 승인했어요.`);
          } catch (err) { toast(err.message, 6000); }
          loadTeacherCourses();
        } }, "모두 승인") : null),
      h("div", { class: "people" }, list.map((e) => h("div", { class: "person" },
        h("span", { class: `dot ${status === "approved" ? "on" : ""}` }),
        h("span", {}, `${e.student_no || "-"} ${e.name} `, h("span", { class: "muted", style: "font-size:0.8rem" }, e.school)),
        h("span", { class: "acts" }, actions.map(([label, st, cls]) => h("button", { class: cls || "", onclick: () => decide(e, st) }, label)))))));
  };
  box.replaceChildren(...[
    group("pending", "승인 대기", [["승인", "approved", "primary"], ["거절", "rejected"]]),
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
  bits.push(`${x.affil_type === "univ" ? "소속 대학" : "소속"} ${x.affiliation || "없음"}`);
  if (x.department) bits.push(`학과 ${x.department}`);
  if (x.birth) bits.push(`생년월일 ${x.birth.replaceAll("-", ".")}`);
  if (x.license) bits.push(`자격 ${x.license}`);
  bits.push(`이메일 ${x.contact_email || x.email}`);
  if (x.contact_email && x.contact_email !== x.email) bits.push(`(로그인 ${x.email})`);
  bits.push(`연락처 ${x.contact}`, `개인정보 서약 ${x.pledged ? "동의함" : "없음"}`);
  return bits.join(" · ");
}

function staffCard(x, today, reload) {
  const isCoord = x.role === "coordinator";
  const named = x.role !== "instructor"; // 관리교사: 거점학교명 / 참여학교 담당교사: 소속 학교를 고쳐 승인할 수 있다
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
    x.transfer_from ? h("div", { class: "banner warn" }, `담당 학교 변경 요청: ${x.transfer_from} → ${x.hub}. 승인 전에는 두 학교 모두 열람할 수 없습니다.`) : null,
    x.status === "pending" && x.replace_from ? h("div", { class: "banner warn" },
      `가입 유형·담당 학교 변경 요청: ${x.replace_from} → ${STAFF_ROLE[x.role] || x.role} (${x.hub}). 승인하면 이전 권한이 해제됩니다.`) : null,
    !isCoord && x.kind === "assistant" ? h("div", { style: "font-size:0.9rem" }, h("span", { class: "status pending" }, "팀티칭 보조교사"), " 강좌를 직접 열지 않고, 주강사가 연 강좌에 함께 들어가요.") : null,
    isCoord && x.message ? h("div", { style: "font-size:0.9rem;white-space:pre-wrap" }, `자기 소개: ${x.message}`) : null,
    !isCoord && wishPeriod(x) ? h("div", { style: "font-size:0.9rem" }, `희망 기간 ${wishPeriod(x)}`) : null,
    x.status !== "pending" && period(x) ? h("div", { class: "muted", style: "font-size:0.85rem" }, `활동 기간 ${period(x)}`) : null,
    mine ? h("div", { class: "muted", style: "font-size:0.85rem" }, "본인 신청이에요. 다른 관리교사나 전체 관리자가 승인해요.") :
    h("div", { class: "approve-form" },
      h("div", { class: "row" },
        named ? h("span", {}, isCoord ? "거점학교명" : "소속 학교") : null, named ? hubName : null,
        "활동 기간", from, "~", until, h("span", { class: "muted", style: "font-size:0.8rem" },
          named ? "(끝나는 날을 비우면 제한 없음)" : "(끝나는 날이 지나면 강사 권한이 저절로 꺼져요)")),
      h("div", { class: "row" }, note,
        h("button", { class: "primary", onclick: () => decide({ action: "approve", hub_name: hubName.value, valid_from: from.value, valid_until: until.value, note: note.value }) },
          x.status === "pending" ? "승인" : active ? "고치기" : "다시 승인"),
        x.status === "pending" ? h("button", { class: "danger", onclick: () => decide({ action: "reject", note: note.value }) }, "거절") : null,
        active ? h("button", { class: "danger", onclick: () => {
          if (confirm(`${x.name}의 권한을 해제할까요? 수업 기록은 남아요.`)) decide({ action: "revoke", note: note.value });
        } }, "권한 해제") : null)));
}

/* ───── 교사 목록: 수강생 관리처럼 위에 검색 칸, 아래에 목록 (줄의 '관리'를 누르면 승인 칸) ───── */

const STAFF_ROLE = { coordinator: "관리교사", participant: "관리교사", instructor: "강의교사" };
const staffBoards = {}; // 보드마다 검색 조건·체크·펼침

function staffBoard(id, list, today, reload, title) {
  const st = staffBoards[id] ||= { q: {}, pick: new Set(), open: new Set() };
  const box = h("div", { class: "staff-board" });
  const roles = [...new Set(list.map((x) => x.role))];
  const schools = koSort(new Set(list.map((x) => x.hub).filter(Boolean)));
  const f = {
    role: h("select", {}, h("option", { value: "" }, "전체"), koSort(roles, (r) => STAFF_ROLE[r]).map((r) => h("option", { value: r }, STAFF_ROLE[r]))),
    status: h("select", {}, h("option", { value: "" }, "전체"),
      koSort(Object.entries(MEMBER_STATUS), (x) => x[1][1]).map(([k, v]) => h("option", { value: k }, v[1]))),
    school: h("select", {}, h("option", { value: "" }, "전체"), schools.map((x) => h("option", { value: x }, x))),
    name: h("input", { placeholder: "이름" }),
    aff: h("input", { placeholder: "소속 학교·기관" }),
    from: h("input", { type: "date" }),
    to: h("input", { type: "date" }),
  };
  for (const [k, el] of Object.entries(f)) el.value = st.q[k] || "";
  const result = h("div");
  const search = () => {
    for (const [k, el] of Object.entries(f)) st.q[k] = el.value.trim();
    st.pick.clear();
    draw();
  };
  for (const el of Object.values(f)) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  const quick = (days) => {
    f.to.value = today;
    f.from.value = new Date(Date.parse(today) - days * 86400000).toISOString().slice(0, 10);
  };
  const row = (...cells) => h("div", { class: "sf-row" }, ...cells.flat());
  const cell = (label, el, wide) => [h("div", { class: "sf-label" }, label), h("div", { class: `sf-field ${wide ? "wide" : ""}` }, el)];
  const day = (ts) => (ts ? new Date(ts * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10) : "");

  function filtered() {
    const q = st.q;
    const has = (v, w) => !w || (v || "").includes(w);
    return list.filter((x) => (!q.role || x.role === q.role) && (!q.status || x.status === q.status) && (!q.school || x.hub === q.school)
      && has(x.name, q.name) && has(x.affiliation, q.aff)
      && (!q.from || day(x.requested_at) >= q.from) && (!q.to || day(x.requested_at) <= q.to))
      .sort((a, b) => (a.status === "pending") - (b.status === "pending") || a.requested_at - b.requested_at).reverse();
  }

  function draw() {
    const rows = filtered();
    const decide = async (action) => {
      const picked = rows.filter((x) => st.pick.has(x.id) && x.status === "pending");
      if (!picked.length) { toast("승인 대기인 신청을 먼저 체크해 주세요."); return; }
      // 강의교사는 끝나는 날이 꼭 있어야 한다 → 신청서의 희망 기간으로 승인 (다르게 정하려면 '관리'에서 한 명씩)
      const noEnd = action === "approve" ? picked.filter((x) => x.role === "instructor" && !x.wish_until) : [];
      if (!confirm(`${picked.length}건을 ${action === "approve" ? "승인" : "거절"}할까요?` +
        (action === "approve" ? "\n학교 변경 요청은 기존 활동 기간을 유지합니다." : ""))) return;
      let ok = 0;
      for (const x of picked) {
        if (noEnd.includes(x)) continue;
        const body = action === "approve"
          ? { action, hub_name: x.hub,
              valid_from: x.transfer_from ? x.valid_from || today : x.wish_from || today,
              valid_until: x.transfer_from ? x.valid_until || "" : x.wish_until || "" }
          : { action, note: "" };
        try { await api(`/api/staff/${x.id}`, body); ok++; } catch (err) { toast(err.message); }
      }
      st.pick.clear();
      toast(`${ok}건을 ${action === "approve" ? "승인" : "거절"}했어요.` + (noEnd.length ? ` (희망 기간이 없는 ${noEnd.length}건은 '관리'에서 기간을 정해 주세요)` : ""), 6000);
      reload();
    };
    const all = h("input", { type: "checkbox", onchange: (e) => {
      for (const x of rows) { if (e.target.checked) st.pick.add(x.id); else st.pick.delete(x.id); }
      result.querySelectorAll("tbody input.pick").forEach((c) => { c.checked = e.target.checked; });
    } });
    const hubApproval = id === "hub";
    const COLS = hubApproval ? 7 : 11;
    const trs = rows.flatMap((x, i) => {
      const open = st.open.has(x.id);
      const [cls, label] = MEMBER_STATUS[x.status] || ["pending", x.status];
      const toggle = () => { if (open) st.open.delete(x.id); else st.open.add(x.id); draw(); };
      const pick = h("input", { type: "checkbox", class: "pick", checked: st.pick.has(x.id), "aria-label": `${x.name} 신청 선택`, onchange: (e) => {
          if (e.target.checked) st.pick.add(x.id); else st.pick.delete(x.id);
        } });
      const main = hubApproval ? h("tr", { class: open ? "open-row" : "" },
        h("td", { class: "num" }, pick, ` ${rows.length - i}`),
        h("td", {}, day(x.requested_at)),
        h("td", {}, x.affiliation || "-"),
        h("td", {}, x.position || "-"),
        h("td", {}, h("button", { class: "link-btn name-btn", onclick: toggle }, `${open ? "▾" : "▸"} ${x.name}`)),
        h("td", {}, x.contact || x.contact_email || x.email || "-"),
        h("td", {}, h("span", { class: `status ${cls}` }, label), " ",
          h("button", { class: "small", onclick: toggle }, open ? "닫기" : "관리")))
        : h("tr", { class: open ? "open-row" : "" },
        h("td", {}, pick),
        h("td", { class: "num" }, rows.length - i),
        h("td", {}, STAFF_ROLE[x.role] + (x.kind === "assistant" ? " (보조)" : "")),
        h("td", {}, h("button", { class: "link-btn name-btn", onclick: toggle },
          `${open ? "▾" : "▸"} ${x.name}`)),
        h("td", {}, x.hub || "-"), h("td", {}, x.affiliation || "-"),
        h("td", {}, x.birth ? x.birth.replaceAll("-", ".") : "-"),
        h("td", { class: "contact-cell" }, x.contact_email || x.email, h("br"), h("span", { class: "muted" }, x.contact || "-")),
        h("td", {}, day(x.requested_at)),
        h("td", {}, h("span", { class: `status ${cls}` }, label)),
        h("td", {}, h("button", { class: "small", onclick: toggle }, open ? "닫기" : "관리")));
      return open ? [main, h("tr", { class: "detail-row" }, h("td", { colspan: COLS }, staffCard(x, today, reload)))] : [main];
    });
    result.replaceChildren(
      h("div", { class: "row", style: "margin-bottom:8px" },
        h("strong", {}, "총 ", h("span", { class: "accent-text" }, rows.length), "건"),
        h("span", { class: "muted", style: "font-size:0.85rem" }, "체크한 신청 한꺼번에:"),
        hubApproval ? h("label", { class: "switch" }, all, "전체 선택") : null,
        h("button", { class: "small primary", onclick: () => decide("approve") }, "승인"),
        h("button", { class: "small", onclick: () => decide("reject") }, "거절")),
      h("div", { class: "table-wrap" }, h("table", { class: `att enroll-table ${hubApproval ? "instructor-approval-table" : ""}` },
        h("thead", {}, h("tr", {}, hubApproval
          ? ["연번", "신청일", "소속", "직위", "이름", "연락처", "상태"].map((t) => h("th", {}, t))
          : [h("th", {}, all), ...["번호", "회원 구분", "이름", "학교", "소속", "생년월일", "이메일·연락처", "신청일", "상태", ""].map((t) => h("th", {}, t))])),
        h("tbody", {}, trs.length ? trs
          : h("tr", {}, h("td", { colspan: COLS, class: "muted", style: "text-align:center;padding:24px" }, list.length ? "조건에 맞는 신청이 없어요." : "아직 신청이 없어요."))))));
  }

  const pending = list.filter((x) => x.status === "pending").length;
  box.append(
    h("h2", { style: "margin:8px 0 6px" }, title, pending ? h("span", { class: "status pending", style: "margin-left:8px;font-size:0.85rem" }, `승인 대기 ${pending}`) : null),
    h("div", { class: "search-form" },
      row(cell("회원 구분", f.role), cell("상태", f.status)),
      row(cell("학교", f.school), cell("이름", f.name)),
      row(cell("소속", f.aff, true)),
      row(cell("기간검색", h("div", { class: "row" }, f.from, "~", f.to,
        ...[["오늘", 0], ["7일", 7], ["1개월", 30], ["6개월", 182]].map(([label, d]) => h("label", { class: "switch" },
          h("input", { type: "radio", name: `${id}-quick`, onchange: () => quick(d) }), label))), true))),
    h("div", { class: "row", style: "justify-content:center;margin:12px 0 20px" },
      h("button", { type: "button", onclick: () => { st.q = {}; for (const el of Object.values(f)) el.value = ""; st.pick.clear(); draw(); } }, "초기화"),
      h("button", { class: "primary", type: "button", onclick: search }, "검색")),
    result);
  draw();
  return box;
}


/* 전체 관리자: 관리교사 승인 */
/** 메인 전광판(배너): 전체 운영 관리에서 꾸민다. 비워 두면 기본 배너가 보여요 */
async function bannersEditor(reload) {
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
            koSort(Object.entries(THEME_NAMES), (x) => x[1]).map(([k, v]) => h("option", { value: k, selected: (b.theme || "green") === k }, v)))),
          h("label", { class: "wide" }, "그림 (선택 — 가로로 긴 그림, 1600×500 정도 권장. 올리면 배경으로 꽉 차요)", file,
            b.image ? h("span", { class: "row" }, h("img", { src: `/api/banners/image/${b.image}`, alt: "", style: "height:60px;border-radius:8px" }),
              h("button", { class: "small", onclick: () => { b.image = ""; draw(); } }, "그림 빼기")) : null)));
    }), list.length ? "" : h("p", { class: "muted" }, "지금은 기본 배너 4개가 보여요. 배너를 추가하면 그 배너만 보여요."));
  };
  draw();
  return h("details", { class: "card", style: "margin:12px 0", open: true },
    h("summary", {}, h("strong", {}, "🖼️ 메인 전광판(배너) "), h("span", { class: "muted" }, list.length ? `${list.length}개` : "기본 배너")),
    h("p", { class: "muted", style: "font-size:0.9rem" }, "메인 화면 맨 위에 5초마다 넘어가며 보여요. 제목이나 그림 중 하나는 있어야 해요."),
    box,
    h("div", { class: "row" },
      h("button", { onclick: () => { if (list.length < 10) { list.push({ theme: "green" }); draw(); } } }, "+ 배너 추가"),
      h("button", { class: "primary", onclick: async () => {
        try {
          const { banners: saved } = await api("/api/admin/banners", { banners: list });
          toast(saved.length ? `배너 ${saved.length}개를 저장했어요.` : "기본 배너로 돌아갔어요.");
          reload();
        } catch (err) { toast(err.message); }
      } }, "저장"),
      h("a", { href: "/live/home", target: "_blank" }, "메인 화면 보기")));
}

async function loadAdmin() {
  const selected = adminSub;
  const tabs = [["approve", "교사 승인"], ["school", "소속 변경 승인"], ["name", "이름 변경 승인"], ["banner", "메인 전광판 배너"]];
  $("#admin-sub-tabs").replaceChildren(...tabs.map(([key, label]) => h("button", {
    type: "button", class: adminSub === key ? "active" : "", onclick: () => { adminSub = key; loadAdmin(); }
  }, label)));
  const box = $("#admin-list");
  fill(box, h("p", { class: "muted" }, "불러오는 중…"));
  if (selected === "school") {
    const board = await profileChangeBoard("school");
    if (adminSub === selected) fill(box, h("h2", {}, "소속 변경 승인"), board);
    return;
  }
  if (selected === "name") {
    const board = await profileChangeBoard("name");
    if (adminSub === selected) fill(box, h("h2", {}, "이름 변경 승인"), board, nameFixer());
    return;
  }
  if (selected === "banner") {
    try { const editor = await bannersEditor(loadAdmin); if (adminSub === selected) fill(box, editor); }
    catch (err) { if (adminSub === selected) fill(box, h("p", { class: "error" }, err.message)); }
    return;
  }
  let co, pa, ins;
  try { [co, pa, ins] = await Promise.all([api("/api/staff/applications?role=coordinator"), api("/api/staff/applications?role=participant"),
    api("/api/staff/applications?role=instructor")]); }
  catch (err) { if (adminSub === selected) fill(box, h("p", { class: "error" }, err.message)); return; }
  if (adminSub !== selected) return;
  co.applications.forEach((x) => { x.role = "coordinator"; });
  pa.applications.forEach((x) => { x.role = "participant"; });
  ins.applications.forEach((x) => { x.role = "instructor"; });
  const list = [...co.applications, ...pa.applications, ...ins.applications];
  const pending = list.filter((x) => x.status === "pending").length;
  $("#admin-badge").textContent = pending;
  $("#admin-badge").hidden = !pending;
  fill(box, staffBoard("admin", list, co.today, loadAdmin, "관리교사 · 강의교사"));
}

async function profileChangeBoard(field) {
  try {
    const { requests } = await api(`/api/admin/change-requests?field=${field}`);
    const pending = requests.filter((r) => r.status === "pending");
    return pending.length ? pending.map((r) => h("div", { class: "card", style: "margin:10px 0" },
      h("strong", {}, `${r.name} (${r.email})`),
      h("p", {}, `${r.old_value || "-"} → ${r.new_value}`),
      h("div", { class: "row" }, ["approve", "reject"].map((action) => h("button", {
        type: "button", class: action === "approve" ? "primary" : "small", onclick: async () => {
          if (action === "approve" && !confirm(`${r.name}님의 ${field === "name" ? "이름" : "소속"} 변경을 승인할까요?`)) return;
          const note = action === "reject" ? prompt("반려 사유를 입력하세요.", "") : "";
          if (note === null) return;
          try {
            await api(`/api/admin/change-requests/${r.id}`, { action, note });
            toast(action === "approve" ? "변경을 승인했어요." : "변경을 반려했어요.");
            loadAdmin();
          } catch (e) { toast(e.message); }
        }
      }, action === "approve" ? "승인" : "반려")))))
      : h("p", { class: "muted" }, "승인 대기 중인 신청이 없어요.");
  } catch (e) { return h("p", { class: "error" }, e.message); }
}

/** 전체 관리자: 다른 사람의 이름 고치기 (가입 뒤에는 본인이 이름을 못 바꾼다 — 오타 등) */
function nameFixer() {
  const q = h("input", { placeholder: "이름 또는 이메일", maxlength: 60 });
  const result = h("div");
  const find = async () => {
    if (!q.value.trim()) { q.focus(); return; }
    let users;
    try { ({ users } = await api(`/api/admin/users?q=${encodeURIComponent(q.value.trim())}`)); } catch (err) { toast(err.message); return; }
    if (!users.length) { fill(result, h("p", { class: "muted" }, "찾는 회원이 없어요.")); return; }
    fill(result, h("div", { class: "table-wrap" }, h("table", { class: "att" },
      h("thead", {}, h("tr", {}, ["구분", "이름", "이메일", "소속", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, users.map((x) => {
        const name = h("input", { value: x.name, maxlength: 30, style: "width:9em" });
        const where = [x.school, x.grade ? `${x.grade}학년 ${x.class_no || ""}반 ${x.number || ""}번` : ""].filter(Boolean).join(" · ");
        return h("tr", {}, h("td", {}, x.role), h("td", {}, name), h("td", {}, x.email), h("td", {}, where || "-"),
          h("td", {}, h("button", { class: "small primary", onclick: async () => {
            const v = name.value.trim();
            if (!v || v === x.name) return;
            if (!confirm(`이름을 '${x.name || "(없음)"}' → '${v}'(으)로 고칠까요?`)) return;
            try { await api(`/api/admin/users/${x.id}/name`, { name: v }); x.name = v; toast("이름을 고쳤어요."); } catch (err) { toast(err.message); }
          } }, "저장")));
      })))));
  };
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); find(); } });
  return h("section", { class: "box", style: "margin-top:24px" },
    h("h3", { style: "margin:0 0 8px" }, "✏️ 회원 이름 고치기"),
    h("div", { class: "row" }, q, h("button", { class: "primary", onclick: find }, "검색")),
    result);
}

/* 수업 기록 (출결·채점·질문) — 그릴 자리는 detailEl() */

function fmtGap(min) {
  return min < 1 ? `${Math.round(min * 60)}초` : `${Math.round(min * 10) / 10}분`;
}

async function loadDetail(id) {
  for (const b of document.querySelectorAll(".class-pick")) b.classList.toggle("on", Number(b.dataset.id) === id);
  const r = await api(`/api/live/history/${id}`);
  const c = r.class;
  // 들어오고 나간 기록 하나당 한 줄 (학교 → 학번 → 이름 순, 같은 학생이 여러 번 들어오면 여러 줄)
  const listen = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, "0")}초` : `${sec}초`);
  const rows = r.rows.map((x) => h("tr", {},
    h("td", {}, x.school || "-"), h("td", {}, x.student_no || "-"), h("td", {}, x.name),
    h("td", {}, x.joined), h("td", {}, x.online ? h("strong", { class: "ok-text" }, "접속 중") : x.left),
    h("td", { class: "num" }, listen(x.seconds))));
  const absent = r.absent.map((a) => h("tr", { class: "absent" },
    h("td", {}, a.school || "-"), h("td", {}, a.student_no), h("td", {}, a.name), h("td", { colspan: 3 }, "미접속")));
  detailEl().replaceChildren(h("section", { class: "card", style: "margin-top:12px" },
    h("div", { class: "row" },
      h("h2", { class: "grow", style: "margin:0" }, c.title),
      h("a", { href: `/api/live/history/${id}/attendance.csv`, class: "button" }, "📥 출결 CSV"),
      h("a", { href: `/api/live/history/${id}/results.csv`, class: "button" }, "📥 퀴즈 결과 CSV"),
      h("a", { href: `/live/materials?class=${id}`, class: "button", target: "_blank" }, "📄 수업 자료·판서")),
    h("p", { class: "muted" }, `코드 ${c.code} · ${c.start} 시작 · ${c.end ? `${c.end} 종료` : (c.live ? "진행 중" : "종료 기록 없음")} · 참여 ${r.students.length}명`
      + (c.target_grade ? ` · 대상 ${c.target_grade}학년 ${c.target_class}반 (미접속 ${r.absent.length}명)` : "")),
    h("div", { class: "table-wrap" }, h("table", { class: "att" },
      h("thead", {}, h("tr", {}, ["학교", "학번", "이름", "접속 시각", "종료 시각", "청취 시간"].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows, absent))),
    !rows.length && !absent.length ? h("p", { class: "muted" }, "접속한 학생이 없어요.") : null));
  await loadGrades(id);
  loadClassQuestions(id);
}

/* 퀴즈·활동 채점: 수업이 끝난 뒤에도 답을 보고 점수·피드백을 줄 수 있다 */
async function loadGrades(id) {
  const box = h("section", { class: "card", id: "grades-box", style: "margin-top:12px" });
  detailEl().append(box);
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
  detailEl().append(h("section", { class: "card", style: "margin-top:12px" },
    h("div", { class: "row" },
      h("h2", { class: "grow", style: "margin:0" }, `💬 질문답변 ${questions.length}건`),
      questions.length ? h("a", { href: `/api/live/history/${id}/questions.csv`, class: "button" }, "📥 질문답변 CSV") : null),
    h("p", { class: "muted" }, questions.length ? `답변한 질문 ${replied}건 · 답변 없는 질문 ${questions.length - replied}건` : "이 수업에서 받은 질문이 없어요."),
    h("div", { class: "people" }, questions.map((q) => qaItem(q, `${q.time.slice(0, 5)} · ${q.student_no} ${q.name}${mixedSchools(questions) && q.school ? ` (${q.school})` : ""}`)))));
}

boot().catch((err) => { document.body.prepend(h("p", { class: "error" }, err.message)); });
