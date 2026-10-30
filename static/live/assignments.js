/* 수행평가(과제): 선생님(과목 운영 → 수행평가)과 학생(강의실 → 내 강좌 → 수행평가) */
const openAssign = new Set(); // 과제 칸을 펼친 강좌
const openSubs = new Set(); // (예전) 제출 현황을 펼친 과제
const viewAssign = new Map(); // 강좌 id → 지금 열어 본 평가(게시물) id

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

function dueText(a) {
  if (!a.due_at) return "마감 없음";
  const left = a.due_at - Date.now() / 1000;
  const d = Math.floor(left / 86400);
  const tag = left < 0 ? " (마감 지남)" : d >= 1 ? ` (D-${d})` : ` (${Math.max(1, Math.round(left / 3600))}시간 남음)`;
  return `마감 ${a.due.replaceAll("-", ".")}${tag}`;
}

/** 브라우저에서 파일을 그대로 올린다 (요청 본문 = 파일) */
async function uploadRaw(url, file) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `올리지 못했어요 (${res.status})`);
  return data;
}

/* ───────────── 선생님 ───────────── */

const fmtNum = (v) => (v === null || v === undefined ? "-" : String(Math.round(v * 100) / 100));

/** 평가 올리기·고치기 창: 평가명 · 평가 내용 · 반영 비율(%) · 영역 만점(점) · 마감일 */
function assignmentDialog(c, a, done) {
  const close = () => dlg.remove();
  const title = h("input", { maxlength: 80, required: true, placeholder: "예: 선거 제도 비교 보고서", value: a?.title || "" });
  const desc = h("textarea", { rows: 4, maxlength: 5000, placeholder: "과제 안내, 분량·형식, 평가 기준 등" }, a?.description || "");
  const weight = h("input", { type: "number", min: 0, max: 100, step: 0.5, placeholder: "예: 20", value: a?.weight ?? "", style: "width:7em" });
  const maxScore = h("input", { type: "number", min: 0.5, max: 1000, step: 0.5, placeholder: "예: 100", value: a?.max_score ?? "", style: "width:7em" });
  const [d0, t0] = (a?.due_input || "").split("T");
  const dueDate = h("input", { type: "date", value: d0 || "" });
  const dueTime = h("input", { type: "time", value: t0 || "23:55", step: 300 });
  const late = h("input", { type: "checkbox", checked: a ? a.allow_late : true });
  const row = (label, ...els) => h("label", { class: "assign-field" }, h("span", {}, label), ...els);
  const dlg = h("div", { class: "overlay", onclick: (e) => { if (e.target === dlg) close(); } },
    h("form", { class: "card assign-dialog", onsubmit: async (e) => {
      e.preventDefault();
      const body = {
        title: title.value.trim(), description: desc.value,
        due: dueDate.value ? `${dueDate.value}T${dueTime.value || "23:55"}` : "",
        allow_late: late.checked,
        weight: weight.value === "" ? null : Number(weight.value),
        max_score: maxScore.value === "" ? null : Number(maxScore.value),
      };
      try {
        if (a) await api(`/api/assignments/${a.id}`, body);
        else await api(`/api/courses/${c.id}/assignments`, body);
        toast(a ? "평가를 고쳤어요." : "평가를 올렸어요. 수강생 강의실 '내 강좌 → 수행평가'에 바로 보여요.");
        close();
        done();
      } catch (err) { toast(err.message); }
    } },
      h("div", { class: "row" }, h("h2", { class: "grow", style: "margin:0" }, a ? "평가 영역 수정" : "평가 올리기"), h("button", { type: "button", class: "small", onclick: close }, "닫기")),
      row("평가명", title),
      row("평가 내용", desc),
      h("div", { class: "row" }, row("반영 비율(%)", weight), row("영역 만점(점)", maxScore)),
      row("마감일", h("div", { class: "row" }, dueDate, dueTime)),
      h("label", { class: "switch" }, late, "마감 뒤에도 받기 (지각으로 표시)"),
      h("button", { class: "primary", type: "submit" }, a ? "고친 내용 저장" : "평가 올리기")));
  document.body.append(dlg);
  title.focus();
}

async function renderCourseAssignments(c, box) {
  let data;
  try { data = await api(`/api/courses/${c.id}/assignments`); } catch (err) { box.replaceChildren(h("p", { class: "error" }, err.message)); return; }
  const reload = () => renderCourseAssignments(c, box);
  const list = data.assignments; // 최근에 올린 것이 위
  const viewing = list.find((x) => x.id === viewAssign.get(c.id));
  if (viewing) { renderAssignmentPost(c, viewing, data, box, reload); return; }
  const total = list.reduce((sum, a) => sum + (a.weight || 0), 0);
  const rows = list.map((a, i) => h("tr", { class: "assign-row", onclick: () => { viewAssign.set(c.id, a.id); reload(); }, title: "누르면 제출 현황·채점" },
    h("td", { class: "num" }, list.length - i),
    h("td", {}, h("strong", {}, a.title)),
    h("td", { class: "assign-desc-cell" }, a.description || "-"),
    h("td", { class: "num" }, a.weight === null || a.weight === undefined ? "-" : `${fmtNum(a.weight)}%`),
    h("td", { class: "num" }, a.max_score ? `${fmtNum(a.max_score)}점` : "-"),
    h("td", {}, a.due ? a.due.replaceAll("-", ".") : "없음",
      h("div", { class: "muted", style: "font-size:0.78rem" }, a.closed ? "제출 마감함" : a.past_due ? (a.allow_late ? "마감 지남(지각 받음)" : "마감 지남") : "받는 중"))));
  box.replaceChildren(
    h("div", { class: "row", style: "margin-bottom:8px" },
      list.length ? h("div", { class: "hub-grid-summary grow", style: "margin:0" }, `반영 비율 합계 ${fmtNum(total)}%`) : h("span", { class: "grow" }),
      h("button", { class: "primary", onclick: () => assignmentDialog(c, null, reload) }, "평가 올리기")),
    h("div", { class: "table-wrap" }, h("table", { class: "att assign-board" },
      h("thead", {}, h("tr", {}, ["연번", "평가명", "평가 내용", "반영 비율", "영역 만점", "마감일"].map((x) => h("th", {}, x)))),
      h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: 6, class: "muted", style: "text-align:center;padding:18px" }, "올린 평가가 없어요."))))),
    h("h3", { style: "margin:24px 0 10px" }, "점수 확인서"),
    h("div", { class: "table-wrap", id: `score-confirmations-${c.id}` }, h("p", { class: "muted" }, "확인서를 불러오는 중…")));
  loadTeacherConfirmations(c.id, box.querySelector(`#score-confirmations-${c.id}`));
}

async function loadTeacherConfirmations(courseId, box) {
  try {
    const { confirmations } = await api(`/api/courses/${courseId}/score-confirmations`);
    const rows = confirmations.map((item) => h("tr", {},
      h("td", { class: "num" }, item.number),
      h("td", { class: "center" }, item.school || "-"),
      h("td", { class: "center" }, item.student_no || "-"),
      h("td", { class: "center" }, item.name),
      h("td", { class: "center" }, item.signed
        ? h("a", { href: `/api/courses/${courseId}/score-confirmations/${item.user_id}/file`, class: "button small" }, "PDF 내려받기")
        : item.needs_resign ? "점수 변경 · 재서명 대기" : "서명 대기")));
    box.replaceChildren(h("table", { class: "att grade-table" },
      h("thead", {}, h("tr", {}, ["연번", "소속학교", "학번", "이름", "확인서(파일)"].map((x) => h("th", {}, x)))),
      h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: 5, class: "muted", style: "text-align:center;padding:18px" }, "수강 확정된 학생이 없어요.")))));
  } catch (err) { box.replaceChildren(h("p", { class: "error" }, err.message)); }
}

/** 게시물 화면: 평가 한 건의 내용·관리 버튼·학생별 제출과 채점. [← 평가 목록]으로 돌아간다 */
function renderAssignmentPost(c, a, data, box, reload) {
  const back = () => { viewAssign.delete(c.id); reload(); };
  const subsBox = h("div", {}, h("p", { class: "muted" }, "제출 현황을 불러오는 중…"));
  const info = (label, value) => h("div", { class: "assign-info" }, h("span", {}, label), h("strong", {}, value));
  box.replaceChildren(
    h("div", { class: "row", style: "margin-bottom:10px" },
      h("button", { class: "small", onclick: back }, "← 평가 목록"),
      h("h3", { class: "grow", style: "margin:0" }, a.title),
      h("button", { class: "small", onclick: () => assignmentDialog(c, a, reload) }, "평가 영역 수정"),
      h("a", { class: "button small", href: `/api/assignments/${a.id}/download.zip` }, "📥 모두 내려받기"),
      h("button", { class: "small", onclick: async () => { await api(`/api/assignments/${a.id}`, { closed: !a.closed }); reload(); } },
        a.closed ? "다시 받기" : "제출 마감"),
      h("button", { class: "small danger", onclick: async () => {
        if (!confirm(`'${a.title}' 평가를 지울까요? 학생들이 낸 파일과 점수도 모두 지워져요.`)) return;
        await api(`/api/assignments/${a.id}/delete`, {});
        back();
      } }, "지우기")),
    h("div", { class: "assign-post" },
      h("div", { class: "assign-infos" },
        info("반영 비율", a.weight === null || a.weight === undefined ? "-" : `${fmtNum(a.weight)}%`),
        info("영역 만점", a.max_score ? `${fmtNum(a.max_score)}점` : "-"),
        info("마감일", a.due ? a.due.replaceAll("-", ".") : "없음"),
        info("상태", a.closed ? "제출 마감함" : a.past_due ? (a.allow_late ? "마감 지남(지각 받음)" : "마감 지남") : "받는 중"),
        info("제출·채점", `제출 ${a.submitted}/${data.students}명 · 채점 ${a.graded}명`)),
      a.description ? h("div", { class: "assign-desc" }, a.description) : null),
    h("h4", { style: "margin:14px 0 6px" }, "학생별 제출과 채점"),
    subsBox);
  renderSubmissions(a, subsBox, reload);
}

const viewSub = new Map(); // 평가 id → 지금 열어 본 학생 id (학생 제출 상세 화면)

async function renderSubmissions(a, box, reload) {
  const { submissions } = await api(`/api/assignments/${a.id}/submissions`);
  const again = () => renderSubmissions(a, box, reload);
  const viewing = submissions.find((s) => s.user_id === viewSub.get(a.id));
  if (viewing) { renderSubmissionPost(a, viewing, box, again); return; }
  const scoreInput = (s) => h("input", { type: "number", min: 0, max: a.max_score ?? undefined, step: 0.5, value: s.score ?? "",
    placeholder: a.max_score ? `/${fmtNum(a.max_score)}` : "점수", class: "grade-score" });
  const rows = submissions.map((s, i) => {
    const score = scoreInput(s);
    const save = h("button", { class: "small", onclick: () => saveGrade(a, s, score, null, save) }, "저장");
    score.addEventListener("input", () => save.classList.add("primary"));
    score.addEventListener("keydown", (e) => { if (e.key === "Enter") save.click(); });
    return h("tr", { class: s.submitted ? "" : "absent" },
      h("td", { class: "num" }, i + 1),
      h("td", { class: "center" }, s.school || "-"),
      h("td", { class: "center" }, s.student_no || "-"),
      h("td", { class: "center" }, h("button", { type: "button", class: "day-link", title: "메모·제출 파일 자세히 보기", onclick: () => { viewSub.set(a.id, s.user_id); again(); } }, s.name),
        s.enrolled ? null : h("div", { class: "muted", style: "font-size:0.75rem" }, "(수강 취소됨)")),
      h("td", { class: "center" }, s.submitted ? [s.submitted_at.slice(5), s.late ? h("span", { class: "status pending", style: "margin-left:4px" }, "지각") : null] : "미제출"),
      h("td", { class: "center" }, s.files.length ? s.files.map((f) => h("a", { class: "file-ico", href: `/api/submission-files/${f.id}`, title: `${f.name} (${fmtSize(f.size)}) 받기` }, "📄")) : "-"),
      h("td", { class: "center" }, score),
      h("td", { class: "center" }, save));
  });
  box.replaceChildren(...[
    h("div", { class: "table-wrap" }, h("table", { class: "att grade-table" },
      h("thead", {}, h("tr", {}, ["연번", "소속학교", "학번", "이름", "제출일", "첨부파일", a.max_score ? `점수 (/${fmtNum(a.max_score)})` : "점수", "저장"].map((x) => h("th", {}, x)))),
      h("tbody", {}, rows))),
    submissions.length ? null : h("p", { class: "muted" }, "수강 확정된 학생이 없어요.")].filter(Boolean));
}

/** 점수(·피드백) 저장: fb가 없으면 지금 피드백은 그대로 둔다 */
async function saveGrade(a, s, score, fb, btn) {
  if (score.value !== "" && a.max_score && Number(score.value) > a.max_score) {
    toast(`점수는 영역 만점(${fmtNum(a.max_score)}점)을 넘을 수 없어요.`, 5000);
    return;
  }
  btn.disabled = true;
  try {
    const feedback = fb ? fb.value : s.feedback;
    await api(`/api/assignments/${a.id}/grade`, { user_id: s.user_id, score: score.value === "" ? null : Number(score.value), feedback });
    s.score = score.value === "" ? null : Number(score.value);
    s.feedback = feedback;
    btn.classList.remove("primary");
    toast(`${s.name} 학생 점수를 저장했어요.`);
  } catch (err) { toast(err.message, 5000); }
  btn.disabled = false;
}

/** 학생 한 명의 제출 상세: 메모·제출 파일·제출일, 여기서도 점수·피드백 저장 */
function renderSubmissionPost(a, s, box, again) {
  const back = () => { viewSub.delete(a.id); again(); };
  const score = h("input", { type: "number", min: 0, max: a.max_score ?? undefined, step: 0.5, value: s.score ?? "",
    placeholder: a.max_score ? `/${fmtNum(a.max_score)}` : "점수", class: "grade-score" });
  const fb = h("textarea", { rows: 3, maxlength: 3000, placeholder: "피드백 (학생에게 보여요)" }, s.feedback || "");
  const save = h("button", { class: "primary", onclick: () => saveGrade(a, s, score, fb, save) }, "저장");
  const info = (label, value) => h("div", { class: "assign-info" }, h("span", {}, label), h("strong", {}, value));
  box.replaceChildren(...[
    h("div", { class: "row", style: "margin-bottom:10px" },
      h("button", { class: "small", onclick: back }, "← 제출 목록"),
      h("h4", { class: "grow", style: "margin:0" }, `${s.name} 학생의 제출`)),
    h("div", { class: "assign-post" },
      h("div", { class: "assign-infos" },
        info("소속학교", s.school || "-"), info("학번", s.student_no || "-"), info("이름", s.name),
        info("제출일", s.submitted ? `${s.submitted_at}${s.late ? " (지각)" : ""}` : "미제출")),
      h("h5", { style: "margin:10px 0 4px" }, "메모"),
      s.text ? h("div", { class: "assign-desc" }, s.text) : h("p", { class: "muted", style: "margin:0" }, "작성한 메모가 없어요."),
      h("h5", { style: "margin:12px 0 4px" }, "제출한 파일"),
      s.files.length ? h("div", { class: "people" }, s.files.map((f) => h("div", { class: "person" },
        h("a", { class: "grow", href: `/api/submission-files/${f.id}`, target: "_blank" }, `📄 ${f.name}`),
        h("span", { class: "muted", style: "font-size:0.75rem" }, fmtSize(f.size)),
        h("a", { class: "button small", href: `/api/submission-files/${f.id}` }, "받기"))))
        : h("p", { class: "muted", style: "margin:0" }, "제출한 파일이 없어요.")),
    h("div", { class: "box grade-box" },
      h("div", { class: "row" }, h("strong", {}, "점수"), score, h("span", { class: "muted" }, a.max_score ? `/ ${fmtNum(a.max_score)}점` : "")),
      fb,
      h("div", { class: "row", style: "justify-content:flex-end" }, save))].filter(Boolean));
}

/* ───────────── 학생 ───────────── */

let activeStudentCourseId = null;
let viewMyAssign = null; // 학생이 열어 본 수행평가(게시물) id
async function loadMyAssignments(courseId = activeStudentCourseId) {
  if (courseId !== activeStudentCourseId) viewMyAssign = null;
  activeStudentCourseId = courseId;
  let list;
  try { ({ assignments: list } = await api("/api/my/assignments")); } catch { return; }
  if (courseId !== activeStudentCourseId) return;
  if (courseId !== null) list = list.filter((a) => a.course_id === courseId);
  if (!list.length) { $("#student-assignments").hidden = true; return; }
  $("#student-assignments").hidden = false;
  const box = $("#my-assignments");
  const viewing = list.find((a) => a.id === viewMyAssign);
  if (viewing) { renderMyAssignmentPost(viewing, box); return; }
  const badgeOf = (a) => {
    const m = a.mine;
    return m.graded ? ["approved", `채점됨${m.score !== null ? ` ${m.score}점` : ""}`]
      : m.submitted ? (m.late ? ["pending", "지각 제출"] : ["approved", "제출함"])
        : a.past_due || a.closed ? ["rejected", "미제출"] : ["pending", "미제출"];
  };
  const open = (a) => { viewMyAssign = a.id; loadMyAssignments(); };
  box.replaceChildren(h("div", { class: "table-wrap" }, h("table", { class: "att assign-board my-assign-board" },
    h("thead", {}, h("tr", {}, ["연번", "평가명", "반영 비율", "영역 만점", "마감일", "내 점수"].map((x) => h("th", {}, x)))),
    h("tbody", {}, list.map((a, i) => {
      const scored = a.mine.graded && a.mine.score !== null && a.mine.score !== undefined;
      const [cls, label] = badgeOf(a);
      return h("tr", { class: "assign-row", onclick: () => open(a), title: "눌러서 제출하기" },
        h("td", { class: "num" }, list.length - i),
        h("td", {}, h("strong", {}, a.title), " ", h("span", { class: `status ${cls}`, style: "margin-left:6px" }, label)),
        h("td", { class: "num" }, a.weight === null || a.weight === undefined ? "-" : `${fmtNum(a.weight)}%`),
        h("td", { class: "num" }, a.max_score ? `${fmtNum(a.max_score)}점` : "-"),
        h("td", { class: "num" }, a.due ? a.due.replaceAll("-", ".") : "없음"),
        h("td", { class: "num" }, scored ? h("strong", { class: "my-score" }, `${fmtNum(a.mine.score)}점`) : h("span", { class: "muted" }, "평가 중")));
    })))),
    h("h3", { style: "margin:24px 0 10px" }, "평가 확인"),
    h("div", { id: `my-score-confirmation-${courseId}` }, h("p", { class: "muted" }, "점수를 불러오는 중…")));
  loadMyScoreConfirmation(courseId, box.querySelector(`#my-score-confirmation-${courseId}`));
}

async function loadMyScoreConfirmation(courseId, box) {
  try {
    const data = await api(`/api/my/courses/${courseId}/score-confirmation`);
    if (!data.has_scores) {
      box.replaceChildren(h("p", { class: "muted" }, "선생님이 점수를 입력하면 여기에서 확인하고 서명할 수 있어요."));
      return;
    }
    const rows = data.items.map((item, i) => h("tr", {},
      h("td", { class: "num" }, i + 1),
      h("td", {}, item.title),
      h("td", {}, item.description || "-"),
      h("td", { class: "num" }, item.weight == null ? "-" : `${fmtNum(item.weight)}%`),
      h("td", { class: "num" }, item.max_score == null ? "-" : `${fmtNum(item.max_score)}점`),
      h("td", { class: "num" }, item.score === null ? "미채점" : `${fmtNum(item.score)}점`),
      h("td", {}, item.feedback || "-")));
    const table = h("div", { class: "table-wrap" }, h("table", { class: "att grade-table" },
      h("thead", {}, h("tr", {}, ["연번", "평가명", "평가 내용", "반영 비율", "영역 만점", "내 점수", "피드백"].map((x) => h("th", {}, x)))),
      h("tbody", {}, rows)));
    const download = h("a", { class: "button small", href: `/api/my/courses/${courseId}/score-confirmation/${data.signed ? "file" : "draft"}`, target: "_blank" },
      data.signed ? "서명한 확인서 보기" : "확인서 미리보기");
    if (data.signed) {
      box.replaceChildren(table, h("div", { class: "row", style: "margin-top:12px" },
        h("span", {}, `${data.signed_at}에 서명해 제출했어요.`), download));
      return;
    }
    const canvas = h("canvas", { width: 520, height: 170, class: "score-signature", "aria-label": "학생 서명란" });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#142a30"; ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
    let active = false, drawn = false;
    const point = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
    canvas.addEventListener("pointerdown", (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); active = true; const [x, y] = point(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + .1, y + .1); ctx.stroke(); drawn = true; });
    canvas.addEventListener("pointermove", (e) => { if (!active) return; e.preventDefault(); const [x, y] = point(e); ctx.lineTo(x, y); ctx.stroke(); });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(event, () => { active = false; });
    const checked = h("input", { type: "checkbox" });
    const submit = h("button", { class: "primary", onclick: async () => {
      if (!drawn) { toast("서명란에 서명해 주세요."); return; }
      if (!checked.checked) { toast("점수와 평가 내용을 확인해 주세요."); return; }
      submit.disabled = true;
      try {
        await api(`/api/my/courses/${courseId}/score-confirmation`, { signature: canvas.toDataURL("image/png"), snapshot_hash: data.snapshot_hash });
        toast("서명한 점수 확인서를 제출했어요.");
        loadMyScoreConfirmation(courseId, box);
      } catch (err) { toast(err.message, 6000); submit.disabled = false; if (err.message.includes("바뀌었어요")) loadMyScoreConfirmation(courseId, box); }
    } }, "서명하여 제출");
    box.replaceChildren(...[table,
      data.needs_resign ? h("p", { class: "error" }, "점수 또는 평가 내용이 변경되어 다시 확인하고 서명해야 해요.") : null,
      h("div", { class: "row", style: "margin:12px 0" }, download),
      h("p", { class: "muted" }, "위 점수와 평가 내용을 확인한 뒤 아래에 직접 서명해 주세요."),
      canvas,
      h("div", { class: "row", style: "margin:8px 0 12px" },
        h("button", { class: "small", onclick: () => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); drawn = false; } }, "서명 지우기")),
      h("label", { class: "row", style: "margin:6px 0 12px" }, checked, h("span", {}, "표의 점수와 평가 내용을 확인했습니다.")),
      submit].filter(Boolean));
  } catch (err) { box.replaceChildren(h("p", { class: "error" }, err.message)); }
}

/** 학생 게시물 화면: 평가 내용을 보고, 파일을 붙이고 메모를 써서 [제출] */
function renderMyAssignmentPost(a, box) {
  const m = a.mine;
  const back = () => { viewMyAssign = null; loadMyAssignments(); };
  const pending = []; // 아직 올리지 않은 파일 (제출을 눌러야 올라간다)
  const pendList = h("div", { class: "people" });
  const drawPending = () => pendList.replaceChildren(...pending.map((f, i) => h("div", { class: "person" },
    h("span", { class: "grow" }, `📎 ${f.name}`), h("span", { class: "muted", style: "font-size:0.75rem" }, fmtSize(f.size)),
    h("button", { class: "small", onclick: () => { pending.splice(i, 1); drawPending(); } }, "빼기"))));
  const fileInput = h("input", { type: "file", multiple: true, hidden: true, onchange: (e) => {
    pending.push(...e.target.files);
    e.target.value = "";
    drawPending();
  } });
  const memo = h("textarea", { rows: 4, maxlength: 20000, placeholder: "간단한 메모 (선택) — 글로 내거나 선생님께 남길 말", value: m.text });
  const submit = h("button", { class: "primary", onclick: async () => {
    if (!pending.length && !memo.value.trim() && !m.files.length) { toast("파일을 붙이거나 메모를 써 주세요."); return; }
    submit.disabled = true;
    try {
      for (const f of pending) {
        toast(`${f.name} 올리는 중…`, 20000);
        await uploadRaw(`/api/assignments/${a.id}/files?name=${encodeURIComponent(f.name)}`, f);
      }
      await api(`/api/assignments/${a.id}/text`, { text: memo.value });
      toast("제출했어요. 마감 전까지 다시 고쳐 낼 수 있어요.");
      loadMyAssignments();
    } catch (err) { toast(err.message, 6000); submit.disabled = false; loadMyAssignments(); }
  } }, m.submitted ? "다시 제출" : "제출");
  const info = (label, value) => h("div", { class: "assign-info" }, h("span", {}, label), h("strong", {}, value));
  box.replaceChildren(...[ // 빈 칸(null)이 "null" 글자로 찍히지 않게 걸러 낸다
    h("div", { class: "row", style: "margin-bottom:10px" },
      h("button", { class: "small", onclick: back }, "← 수행평가 목록"),
      h("h3", { class: "grow", style: "margin:0" }, a.title)),
    h("div", { class: "assign-post" },
      h("div", { class: "assign-infos" },
        info("반영 비율", a.weight === null || a.weight === undefined ? "-" : `${fmtNum(a.weight)}%`),
        info("영역 만점", a.max_score ? `${fmtNum(a.max_score)}점` : "-"),
        info("마감일", a.due ? a.due.replaceAll("-", ".") : "없음"),
        info("내 제출", m.submitted ? `${m.submitted_at}${m.late ? " (지각)" : ""}` : "아직 안 냄"),
        m.graded ? info("점수", m.score !== null ? `${m.score}점` : "-") : null),
      a.description ? h("div", { class: "assign-desc" }, a.description) : null,
      m.graded && m.feedback ? h("div", { class: "reply" }, `👩‍🏫 ${m.feedback}`) : null),
    h("h4", { style: "margin:14px 0 6px" }, "제출하기"),
    m.files.length ? h("div", { class: "people" }, m.files.map((f) => h("div", { class: "person" },
      h("a", { class: "grow", href: `/api/submission-files/${f.id}`, target: "_blank" }, `📎 ${f.name} (낸 파일)`),
      h("span", { class: "muted", style: "font-size:0.75rem" }, fmtSize(f.size)),
      a.can_submit ? h("button", { class: "small", onclick: async () => {
        if (!confirm(`${f.name} 파일을 지울까요?`)) return;
        try { await api(`/api/submission-files/${f.id}/delete`, {}); loadMyAssignments(); } catch (err) { toast(err.message); }
      } }, "지우기") : null))) : null,
    a.can_submit
      ? h("div", { class: "assign-submit" },
        pendList,
        h("div", { class: "row" }, h("button", { onclick: () => fileInput.click() }, "📎 파일 첨부"), fileInput,
          h("span", { class: "muted", style: "font-size:0.8rem" }, "파일 5개까지, 하나에 20MB까지")),
        memo,
        h("div", { class: "row", style: "justify-content:flex-end" }, submit))
      : h("p", { class: "muted", style: "margin:6px 0 0" }, a.why_not)].filter(Boolean));
}
