/* 수강신청: 누구나 강좌를 조회하고, 학생·전체 관리자가 신청·취소한다. */
(async function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const box = $("catalog"), access = $("courses-access");
  let user = null, list = [], values = {};
  try { user = (await (await fetch("/api/me")).json()).user; } catch { /* 공개 목록은 계속 표시 */ }
  const student = !!user && !user.needs_profile && (user.role === "student" || user.is_admin);
  if (!user) access.innerHTML = '<p><a class="button primary" href="/live?start=student">학생 로그인 후 신청</a></p>';
  async function read(url, method = "GET") {
    const response = await fetch(url, { method });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "강좌 정보를 불러오지 못했어요.");
    return data;
  }
  function action(c) {
    if (!student) return "";
    if (c.status === "approved") return `<a class="button small primary" href="/live?classroom=1">강의실로</a>
      <button type="button" class="small" data-action="cancel" data-id="${c.id}">수강 취소</button>`;
    if (c.status === "pending") return `<button type="button" class="small" data-action="cancel" data-id="${c.id}">신청 취소</button>`;
    if (c.recruit === "open") return `<button type="button" class="small primary" data-action="enroll" data-id="${c.id}">${c.status === "rejected" ? "다시 신청" : "수강신청"}</button>`;
    return `<span class="muted">${c.recruit === "before" ? "모집 예정" : "신청 마감"}</span>`;
  }
  function draw(shown) {
    box.innerHTML = shown.length ? shown.map((c) => {
      const grades = (c.grades?.length ? c.grades : [1, 2, 3]).map((g) => `${g}학년`);
      const facts = [
        ["학점", c.credits ? `${c.credits}학점` : "-"],
        ["인원", c.capacity ? `${c.capacity}명` : "제한 없음"],
        ["거점학교", c.hub_school || "-"],
        ["성취도", c.achievement_text || "-"],
        ["등급", c.rank_grade || "-"],
        ["평가방식", c.exam_ratio != null && c.perf_ratio != null ? `지필 ${c.exam_ratio}% · 수행 ${c.perf_ratio}%` : "-"],
      ];
      const status = { approved: "수강 확정", pending: "승인 대기", rejected: "신청 반려" }[c.status] || "";
      return `<article class="course-tile with-thumb clickable" data-href="/live/courses/${c.id}" title="눌러서 강좌 정보·수업계획서 보기">${window.courseThumb ? window.courseThumb(c) : ""}<div class="ct-body">
        <div class="ct-top">${grades.map((g) => `<span class="tag soft">${esc(g)}</span>`).join("")}</div>
        <h3>${esc(c.title)}</h3>
        <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
        ${status ? `<p class="status ${esc(c.status)}">${status}${c.note ? ` · ${esc(c.note)}` : ""}</p>` : ""}
        <div class="row" style="margin-top:10px">${action(c)}</div>
      </div></article>`;
    }).join("") : '<p class="muted">조건에 맞는 강좌가 없어요.</p>';
  }
  async function load() {
    try {
      ({ courses: list } = await read(student ? "/api/courses/available" : "/api/courses/catalog"));
      const search = window.courseSearch(list, (shown) => { values = search.values(); draw(shown); }, values);
      $("course-search").replaceChildren(search.form);
      draw(search.filter());
    } catch (e) { box.textContent = e.message; }
  }
  box.addEventListener("click", async (event) => {
    // 버튼·링크가 아닌 곳을 누르면 강좌 상세 화면으로
    if (!event.target.closest("button, a")) {
      const card = event.target.closest("article[data-href]");
      if (card) { location.href = card.dataset.href; return; }
    }
    const button = event.target.closest("button[data-action]");
    if (!button || !student) return;
    if (button.dataset.action === "cancel" && !confirm("수강신청을 취소할까요?")) return;
    button.disabled = true;
    try {
      await read(`/api/courses/${button.dataset.id}/enroll`, button.dataset.action === "cancel" ? "DELETE" : "POST");
      await load();
    } catch (e) { alert(e.message); button.disabled = false; }
  });
  await load();
})();
