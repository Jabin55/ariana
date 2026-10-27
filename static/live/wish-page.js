/* 희망과목 개설 신청 게시판: 공개 글·공감, 학생·전체 관리자의 신청 목록. */
(async function () {
  const $ = (id) => document.getElementById(id);
  const item = (tag, text, className = "") => {
    const n = document.createElement(tag);
    n.textContent = text;
    if (className) n.className = className;
    return n;
  };
  async function api(url, body) {
    const response = await fetch(url, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "요청하지 못했어요.");
    return data;
  }
  function requestTable(requests, publicBoard) {
    const wrap = item("div", "", "table-wrap");
    const table = item("table", "", "wish-table");
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const label of ["연도", "학기", "과목", "신청 이유", "작성일", ...(publicBoard ? ["공감"] : [])]) {
      headerRow.append(item("th", label));
    }
    head.append(headerRow);
    const body = document.createElement("tbody");
    if (!requests.length) {
      const row = document.createElement("tr");
      const cell = item("td", "아직 신청한 과목이 없어요.", "muted");
      cell.colSpan = publicBoard ? 6 : 5;
      row.append(cell);
      body.append(row);
    }
    for (const request of requests) {
      const row = document.createElement("tr");
      for (const value of [request.school_year || "—", request.term || "—", request.subject,
        request.note || "—", request.date]) row.append(item("td", value));
      if (publicBoard) {
        const cell = document.createElement("td");
        const button = item("button", `공감 ${request.likes}`, "wish-like small");
        button.type = "button";
        button.setAttribute("aria-pressed", String(request.liked));
        button.addEventListener("click", async () => {
          const error = $("wish-page-board-error");
          error.textContent = "";
          if (!user) { error.textContent = "공감하려면 로그인해 주세요."; return; }
          button.disabled = true;
          try {
            const result = await api(`/api/course-requests/${request.id}/like`, {});
            button.textContent = `공감 ${result.likes}`;
            button.setAttribute("aria-pressed", String(result.liked));
          } catch (e) { error.textContent = e.message; }
          finally { button.disabled = false; }
        });
        cell.append(button);
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    wrap.append(table);
    return wrap;
  }
  async function board() {
    const box = $("wish-page-summary");
    try {
      const { requests } = await api("/api/course-requests/board");
      box.replaceChildren(requestTable(requests, true));
    } catch (e) { box.textContent = e.message; }
  }
  async function mine() {
    const box = $("wish-page-mine");
    try {
      const { requests } = await api("/api/my/course-requests");
      box.replaceChildren(requestTable(requests, false));
    } catch (e) { box.textContent = e.message; }
  }
  let user = null;
  try { user = (await api("/api/me")).user; } catch { /* 공개 게시판은 로그인 없이 읽는다 */ }
  const canApply = user && !user.needs_profile && (user.role === "student" || user.is_admin);
  await Promise.all([board(), ...(canApply ? [mine()] : [])]);
  $("wish-page-own").hidden = !canApply;
  if (!canApply) return;
  const open = $("wish-page-open");
  const form = $("wish-page-form");
  open.addEventListener("click", () => {
    form.hidden = !form.hidden;
    open.textContent = form.hidden ? "신청서 작성" : "신청서 닫기";
    if (!form.hidden) $("wish-page-year").focus();
  });
  $("wish-page-year").value = new Date().getFullYear();
  try {
    const { subjects } = await api("/api/subjects");
    $("wish-page-subjects").replaceChildren(...subjects.map((s) => {
      const option = document.createElement("option"); option.value = s.name; return option;
    }));
  } catch { /* 목록 없이도 직접 적을 수 있다 */ }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    $("wish-page-error").textContent = "";
    try {
      await api("/api/course-requests", {
        school_year: Number($("wish-page-year").value), term: $("wish-page-term").value,
        subject: $("wish-page-subject").value.trim(), note: $("wish-page-note").value.trim(),
      });
      $("wish-page-subject").value = $("wish-page-note").value = "";
      form.hidden = true;
      open.textContent = "신청서 작성";
      await Promise.all([board(), mine()]);
    } catch (e) { $("wish-page-error").textContent = e.message; }
  });
})();
