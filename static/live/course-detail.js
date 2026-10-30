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
    const facts = [
      ["과목", subject + (c.custom_subject ? " (고시외 과목)" : "")],
      ["과목 구분", c.subject_type],
      ["대상 학년", grades],
      ["개설 연도·학기", [c.school_year ? `${c.school_year}학년도` : "", c.term].filter(Boolean).join(" ")],
      ["학점·시수", [c.credits ? `${c.credits}학점` : "", c.hours ? `${c.hours}시간` : ""].filter(Boolean).join(" · ")],
      ["운영 방식", c.delivery],
      ["거점학교", c.hub_school],
      ["강의교사", c.instructor + (c.team_teaching ? " (팀티칭)" : "")],
      ["수업 기간", c.start_date ? `${dot(c.start_date)} ~ ${dot(c.end_date)}` : ""],
      ["수업 시간", c.class_days?.length ? `매주 ${c.class_days.map((d) => DAYS[d]).join("·")} ${c.class_start || ""}~${c.class_end || ""}` : ""],
      ["모집 기간", recruit],
      ["모집 인원", c.capacity ? `${c.capacity}명` : "제한 없음"],
      ["성취도", c.achievement_text],
      ["석차 등급", c.rank_grade],
      ["평가 방식", c.exam_ratio != null && c.perf_ratio != null ? `지필 ${c.exam_ratio}% · 수행 ${c.perf_ratio}%` : ""],
      ["참여 학교", (c.schools || []).join(", ")],
      ["문의", [c.contact_email, c.contact_phone].filter(Boolean).join(" · ")],
    ].filter(([, v]) => v);
    const status = mine ? { approved: "수강 확정", pending: "승인 대기", rejected: "신청 반려" }[mine.status] || "" : "";
    let action = "";
    if (!user) action = '<a class="button primary" href="/live?start=student">학생 로그인 후 신청</a>';
    else if (student && mine) {
      if (mine.status === "approved") action = '<a class="button primary" href="/live?classroom=1">강의실로</a> <button type="button" data-act="cancel">수강 취소</button>';
      else if (mine.status === "pending") action = '<button type="button" data-act="cancel">신청 취소</button>';
      else if (mine.recruit === "open") action = `<button type="button" class="primary" data-act="enroll">${mine.status === "rejected" ? "다시 신청" : "수강신청"}</button>`;
      else action = `<span class="muted">${mine.recruit === "before" ? "모집 예정" : "신청 마감"}</span>`;
    } else if (student) action = `<span class="muted">${c.recruit === "before" ? "모집 예정" : c.recruit === "open" ? "대상 학년이 아니에요" : "신청 마감"}</span>`;
    const sessions = c.sessions || [];
    box.innerHTML = `
      <p><a href="/live/courses">← 수강신청 목록</a></p>
      <div class="cd-head">
        ${window.courseThumb ? `<div class="cd-thumb">${window.courseThumb(c)}</div>` : ""}
        <div class="cd-title">
          <h1>${esc(c.title)}</h1>
          <p class="muted">${esc(c.hub_school || "")} · 강의교사 ${esc(c.instructor || "-")}</p>
          ${status ? `<p class="status ${esc(mine.status)}">${status}${mine.note ? ` · ${esc(mine.note)}` : ""}</p>` : ""}
          <div class="row cd-actions">${action}
            ${c.syllabus ? `<a class="button" href="${esc(c.syllabus.url)}" target="_blank" rel="noopener">📄 수업계획서 받기</a>` : '<span class="muted">수업계획서가 아직 없어요</span>'}</div>
        </div>
      </div>
      <section class="info-block"><h2>강좌 정보</h2>
        <dl class="cd-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></section>
      ${c.description ? `<section class="info-block"><h2>강좌 소개</h2><p class="cd-desc">${esc(c.description)}</p></section>` : ""}
      ${sessions.length ? `<section class="info-block"><h2>수업 계획 (${sessions.length}회)</h2>
        <div class="table-wrap"><table class="att"><thead><tr><th>회차</th><th>날짜</th><th>시간</th><th>수업 주제</th></tr></thead><tbody>
        ${sessions.map((x) => `<tr><td class="num">${esc(x.no)}</td><td>${esc(dot(x.date))}</td><td>${esc(x.start || "")}${x.end ? ` ~ ${esc(x.end)}` : ""}</td><td>${esc(x.topic || "-")}</td></tr>`).join("")}
        </tbody></table></div></section>` : ""}`;
  }

  box.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    if (b.dataset.act === "cancel" && !confirm("수강신청을 취소할까요?")) return;
    b.disabled = true;
    try { await read(`/api/courses/${id}/enroll`, b.dataset.act === "cancel" ? "DELETE" : "POST"); await load(); }
    catch (err) { alert(err.message); b.disabled = false; }
  });
  await load();
})();
