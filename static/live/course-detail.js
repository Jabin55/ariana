/* 강좌 상세 정보: 수강신청 목록에서 강좌를 누르면 오는 화면 (누구나 볼 수 있고, 학생은 여기서 바로 신청한다) */
(async function () {
  const box = document.getElementById("course-detail");
  const id = Number(box.dataset.id);
  const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const dot = (d) => (d ? d.replaceAll("-", ".") : "");
  async function read(url, method = "GET") {
    const res = await fetch(url, { method });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "강좌 정보를 불러오지 못했어요.");
    return data;
  }

  let user = null;
  try { user = (await (await fetch("/api/me")).json()).user; } catch { /* 로그인 안 해도 볼 수 있다 */ }
  const student = !!user && !user.needs_profile && (user.role === "student" || user.is_admin);

  async function load() {
    let c;
    try { ({ course: c } = await read(`/api/courses/${id}/info`)); }
    catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p><p><a href="/live/courses">← 수강신청 목록</a></p>`; return; }
    let mine = null; // 학생이면 내 신청 상태
    if (student) {
      try { mine = (await read("/api/courses/available")).courses.find((x) => x.id === id) || null; } catch { /* 상태 없이 보여 줌 */ }
    }
    document.title = `${c.title} · 외솔온닷`;
    const grades = (c.grades?.length ? c.grades : [1, 2, 3]).map((g) => `${g}학년`).join(", ");
    const subject = [c.subject_group, c.subject_area, c.subject].filter(Boolean).join(" > ");
    const recruit = c.recruit_start || c.recruit_end
      ? `${dot(c.recruit_start)} ${c.recruit_start_time || ""} ~ ${dot(c.recruit_end)} ${c.recruit_end_time || ""}`.trim() : "";
    const dash = (v) => v === null || v === undefined || v === "" ? "-" : v;
    const cell = (label, value) => `<th>${esc(label)}</th><td>${esc(dash(value))}</td>`;
    const table = (rows) => `<div class="table-wrap"><table class="info-table basic-info-table"><tbody>${rows.map(([k1, v1, k2, v2]) => `<tr>${cell(k1, v1)}${cell(k2, v2)}</tr>`).join("")}</tbody></table></div>`;
    const term = [c.school_year ? `${c.school_year}학년도` : "", c.term || ""].filter(Boolean).join(" ");
    const period = c.start_date || c.end_date ? `${dot(c.start_date)} ~ ${dot(c.end_date)}` : "";
    const time = c.class_days?.length ? `매주 ${c.class_days.map((d) => DAYS[d]).join("·")} ${c.class_start || ""}~${c.class_end || ""}` : "";
    const sessions = c.sessions || [];
    const basic = table([
      ["학기", term, "강의 기간", period],
      ["대상 학년", grades, "거점학교", c.hub_school],
      ["선택과목 유형", c.custom_subject ? "고시외 과목" : c.subject_type, "교과(군)", c.subject_group],
      ["강의 교사 소속 학교", c.instructor_school, "강의 교사 성명", c.instructor],
      ["운영 학점(운영 시간)", c.credits ? `${c.credits}학점${c.hours ? ` (${c.hours}시간)` : ""}` : "",
        "수업 시간(횟수)", [time, sessions.length ? `(${sessions.length}회)` : ""].filter(Boolean).join(" ")],
      ["수강 인원", c.capacity ? `${c.capacity}명` : "제한 없음",
        "평가 방식", c.exam_ratio != null && c.perf_ratio != null ? `지필 ${c.exam_ratio}% · 수행 ${c.perf_ratio}%` : ""],
      ["성취도", c.achievement_text, "등급", c.rank_grade],
    ]);
    const extra = [
      ["과목", subject + (c.custom_subject ? " (고시외 과목)" : "")],
      ["운영 방식", c.delivery],
      ["모집 기간", recruit],
      ["참여 학교", (c.schools || []).join(", ")],
      ["문의", [c.contact_email, c.contact_phone].filter(Boolean).join(" · ")],
      ...(c.team_teaching ? [["강의 방식", "팀티칭"]] : []),
    ].filter(([, value]) => value);
    const extraRows = [];
    for (let i = 0; i < extra.length; i += 2) extraRows.push([...(extra[i] || ["", ""]), ...(extra[i + 1] || ["", ""])]);
    const area = c.subject_area || "교양";
    const [a, b] = window.courseAreaColors ? window.courseAreaColors(area) : ["#7fc8a9", "#1b6b4a"];
    const [courseStatus] = window.courseState ? window.courseState(c) : [""];
    const icons = { 국어: "📖", 수학: "📐", 영어: "🔤", 사회: "🌏", 역사: "🏛️", 도덕: "⚖️", 과학: "🔬", 체육: "⚽", 음악: "🎵", 미술: "🎨", 연극: "🎭", "기술·가정": "🛠️", 정보: "💻", 제2외국어: "🗣️", 한문: "📜", 교양: "💡" };
    const status = mine ? { approved: "수강 확정", pending: "승인 대기", rejected: "신청 반려" }[mine.status] || "" : "";
    let action = "";
    if (!user) action = '<a class="button primary" href="/live?start=student">학생 로그인 후 신청</a>';
    else if (student && mine) {
      if (mine.status === "approved") action = '<a class="button primary" href="/live?classroom=1">강의실로</a> <button type="button" data-act="cancel">수강 취소</button>';
      else if (mine.status === "pending") action = '<button type="button" data-act="cancel">신청 취소</button>';
      else if (mine.recruit === "open") action = `<button type="button" class="primary" data-act="enroll">${mine.status === "rejected" ? "다시 신청" : "수강신청"}</button>`;
      else action = `<span class="muted">${mine.recruit === "before" ? "모집 예정" : "신청 마감"}</span>`;
    } else if (student) action = `<span class="muted">${c.recruit === "before" ? "모집 예정" : c.recruit === "open" ? "대상 학년이 아니에요" : "신청 마감"}</span>`;
    box.innerHTML = `
      <p><a href="/live/courses">← 수강신청 목록</a></p>
      <div class="course-banner course-detail-banner" style="--a:${a};--b:${b}">
        <span class="cb-area${area.length > 3 ? " long" : ""}">${esc(area)}</span>
        <div class="cb-text">
          <div class="cb-kicker">${esc(term)}</div>
          <h1 class="cb-title">${esc(c.title)}</h1>
          <div class="cb-facts">${esc([c.hub_school, period].filter(Boolean).join(" · "))}</div>
        </div>
        <div class="cb-side"><span class="cb-ico" aria-hidden="true">${icons[area] || "📚"}</span>
          ${courseStatus ? `<div class="cb-chips"><span class="cb-chip">${esc(courseStatus)}</span></div>` : ""}</div>
      </div>
      <div class="row cd-actions">
        ${status ? `<span class="status ${esc(mine.status)}">${status}${mine.note ? ` · ${esc(mine.note)}` : ""}</span>` : ""}
        ${action}
      </div>
      <div class="sc-panel">
        <section><h3>기본 정보</h3>${basic}
          ${c.syllabus ? `<p><a class="button small" href="${esc(c.syllabus.url)}" target="_blank" rel="noopener">📄 수업계획서 받기</a></p>` : ""}</section>
        <section><h3>회차정보</h3>${sessions.length ? `<div class="table-wrap"><table class="att session-board"><thead><tr><th>회차</th><th>날짜</th><th>시간</th><th>수업 주제</th></tr></thead><tbody>
          ${sessions.map((x) => `<tr><td class="num">${esc(x.no)}회</td><td class="num">${esc(dot(x.date))} (${esc(DAYS[new Date(`${x.date}T00:00:00Z`).getUTCDay()])})</td><td class="num">${esc(x.start ? `${x.start}~${x.end || ""}` : "-")}</td><td>${esc(x.topic || "-")}</td></tr>`).join("")}
          </tbody></table></div>` : '<p class="muted">등록된 회차 정보가 없어요.</p>'}</section>
        ${c.description ? `<section><h3>강좌 소개</h3><p class="cd-desc">${esc(c.description)}</p></section>` : ""}
        ${extraRows.length ? `<section><h3>수강신청 안내</h3>${table(extraRows)}</section>` : ""}
      </div>`;
  }

  box.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    if (b.dataset.act === "cancel" && !await appConfirm("수강신청을 취소할까요?")) return;
    b.disabled = true;
    try { await read(`/api/courses/${id}/enroll`, b.dataset.act === "cancel" ? "DELETE" : "POST"); await load(); }
    catch (err) { await appAlert(err.message); b.disabled = false; }
  });
  await load();
})();
