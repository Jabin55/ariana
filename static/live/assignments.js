/* 평가 활동(수행평가 과제): 선생님(과목 운영 → 평가 활동)과 학생(마이페이지 📝 평가 활동) */
const openAssign = new Set(); // 과제 칸을 펼친 강좌
const openSubs = new Set(); // 제출 현황을 펼친 과제

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
        toast(a ? "평가를 고쳤어요." : "평가를 올렸어요. 수강생 마이페이지 '평가 활동'에 바로 보여요.");
        close();
        done();
      } catch (err) { toast(err.message); }
    } },
      h("div", { class: "row" }, h("h2", { class: "grow", style: "margin:0" }, a ? "평가 고치기" : "평가 올리기"), h("button", { type: "button", class: "small", onclick: close }, "닫기")),
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
  const total = list.reduce((sum, a) => sum + (a.weight || 0), 0);
  const rows = list.flatMap((a, i) => {
    const open = openSubs.has(a.id);
    const toggle = () => { if (open) openSubs.delete(a.id); else openSubs.add(a.id); reload(); };
    const main = h("tr", { class: `assign-row ${open ? "open-row" : ""}`, onclick: toggle, title: "누르면 제출 현황·채점" },
      h("td", { class: "num" }, list.length - i),
      h("td", {}, h("strong", {}, a.title)),
      h("td", { class: "assign-desc-cell" }, a.description || "-"),
      h("td", { class: "num" }, fmtNum(a.weight)),
      h("td", { class: "num" }, fmtNum(a.max_score)),
      h("td", {}, a.due ? a.due.replaceAll("-", ".") : "없음",
        h("div", { class: "muted", style: "font-size:0.78rem" }, a.closed ? "제출 마감함" : a.past_due ? (a.allow_late ? "마감 지남(지각 받음)" : "마감 지남") : "받는 중")));
    if (!open) return [main];
    const subsBox = h("div");
    renderSubmissions(a, subsBox, reload);
    const detail = h("tr", { class: "detail-row" }, h("td", { colspan: 6 },
      h("div", { class: "row", style: "margin-bottom:8px" },
        h("span", { class: "muted grow" }, `제출 ${a.submitted}/${data.students}명 · 채점 ${a.graded}명`),
        h("button", { class: "small", onclick: () => assignmentDialog(c, a, reload) }, "고치기"),
        h("a", { class: "button small", href: `/api/assignments/${a.id}/download.zip` }, "📥 모두 내려받기"),
        h("button", { class: "small", onclick: async () => { await api(`/api/assignments/${a.id}`, { closed: !a.closed }); reload(); } },
          a.closed ? "다시 받기" : "제출 마감"),
        h("button", { class: "small danger", onclick: async () => {
          if (!confirm(`'${a.title}' 평가를 지울까요? 학생들이 낸 파일과 점수도 모두 지워져요.`)) return;
          await api(`/api/assignments/${a.id}/delete`, {});
          reload();
        } }, "지우기")),
      subsBox));
    return [main, detail];
  });
  box.replaceChildren(
    h("div", { class: "row", style: "margin-bottom:8px" },
      h("span", { class: "grow muted", style: "font-size:0.88rem" }, list.length ? `반영 비율 합계 ${fmtNum(total)}%` : ""),
      h("button", { class: "primary", onclick: () => assignmentDialog(c, null, reload) }, "평가 올리기")),
    h("div", { class: "table-wrap" }, h("table", { class: "att assign-board" },
      h("thead", {}, h("tr", {}, ["연번", "평가명", "평가 내용", "반영 비율(%)", "영역 만점(점)", "마감일"].map((x) => h("th", {}, x)))),
      h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: 6, class: "muted", style: "text-align:center;padding:18px" }, "올린 평가가 없어요."))))));
}

async function renderSubmissions(a, box, reload) {
  const { submissions } = await api(`/api/assignments/${a.id}/submissions`);
  const mixed = new Set(submissions.map((s) => s.school)).size > 1;
  const rows = submissions.map((s) => {
    const score = h("input", { type: "number", min: 0, max: a.max_score ?? undefined, step: 0.5, value: s.score ?? "", placeholder: a.max_score ? `/${fmtNum(a.max_score)}` : "점수", style: "width:5em" });
    const fb = h("input", { class: "grow", maxlength: 3000, value: s.feedback, placeholder: "피드백 (학생에게 보여요)" });
    const save = async () => {
      try {
        await api(`/api/assignments/${a.id}/grade`, { user_id: s.user_id, score: score.value === "" ? null : Number(score.value), feedback: fb.value });
        toast(`${s.name} 학생 점수·피드백을 저장했어요.`);
      } catch (err) { toast(err.message); }
    };
    score.addEventListener("change", save);
    fb.addEventListener("change", save);
    return h("tr", { class: s.submitted ? "" : "absent" },
      h("td", {}, s.student_no || "-"),
      h("td", {}, s.name, mixed && s.school ? h("div", { class: "muted", style: "font-size:0.75rem" }, s.school) : null,
        s.enrolled ? null : h("div", { class: "muted", style: "font-size:0.75rem" }, "(수강 취소됨)")),
      h("td", {}, s.submitted ? [s.submitted_at.slice(5), s.late ? h("span", { class: "status pending", style: "margin-left:4px" }, "지각") : null] : "미제출"),
      h("td", { class: "answer" },
        s.files.map((f) => h("div", {}, h("a", { href: `/api/submission-files/${f.id}`, target: "_blank" }, `📎 ${f.name}`),
          h("span", { class: "muted", style: "font-size:0.75rem" }, ` ${fmtSize(f.size)}`))),
        s.text ? h("details", {}, h("summary", { class: "muted" }, "제출 글"), h("div", { style: "white-space:pre-wrap" }, s.text)) : null),
      h("td", {}, h("div", { class: "row" }, score, fb)));
  });
  box.replaceChildren(...[h("div", { class: "table-wrap" }, h("table", { class: "att" },
    h("thead", {}, h("tr", {}, ["학번", "이름", "제출", "파일·글", "점수·피드백 (입력하면 저장)"].map((x) => h("th", {}, x)))),
    h("tbody", {}, rows))),
  submissions.length ? null : h("p", { class: "muted" }, "수강 확정된 학생이 없어요.")].filter(Boolean));
}

/* ───────────── 학생 ───────────── */

let activeStudentCourseId = null;
async function loadMyAssignments(courseId = activeStudentCourseId) {
  activeStudentCourseId = courseId;
  let list;
  try { ({ assignments: list } = await api("/api/my/assignments")); } catch { return; }
  if (courseId !== activeStudentCourseId) return;
  if (courseId !== null) list = list.filter((a) => a.course_id === courseId);
  if (!list.length) { $("#student-assignments").hidden = true; return; }
  $("#student-assignments").hidden = false;
  const box = $("#my-assignments");
  const open = new Set([...box.querySelectorAll("details[open]")].map((d) => d.dataset.id));
  box.replaceChildren(...list.map((a) => {
    const m = a.mine;
    const badge = m.graded ? ["approved", `채점됨${m.score !== null ? ` ${m.score}점` : ""}`]
      : m.submitted ? (m.late ? ["pending", "지각 제출"] : ["approved", "제출함"])
        : a.past_due || a.closed ? ["rejected", "미제출"] : ["pending", "미제출"];
    const fileInput = h("input", { type: "file", multiple: true, hidden: true, onchange: async (e) => {
      const files = [...e.target.files];
      e.target.value = "";
      for (const f of files) {
        try { toast(`${f.name} 올리는 중…`, 20000); await uploadRaw(`/api/assignments/${a.id}/files?name=${encodeURIComponent(f.name)}`, f); }
        catch (err) { toast(`${f.name}: ${err.message}`, 6000); return loadMyAssignments(); }
      }
      toast("제출했어요. 마감 전까지 고칠 수 있어요.");
      loadMyAssignments();
    } });
    const text = h("textarea", { rows: 3, maxlength: 20000, placeholder: "글로 내거나, 선생님께 남길 말 (선택)", value: m.text });
    return h("details", { class: "assign-student", "data-id": String(a.id), open: open.has(String(a.id)) || null },
      h("summary", {}, h("span", { class: "row", style: "display:inline-flex;width:calc(100% - 20px)" },
        h("span", { class: "grow" }, h("strong", {}, a.title),
          h("span", { class: "muted", style: "font-size:0.8rem" }, ` ${a.course_title}`)),
        h("span", { class: `status ${badge[0]}` }, badge[1])),
        h("div", { class: "muted", style: "font-size:0.8rem;margin-left:18px" }, [dueText(a),
          a.weight !== null && a.weight !== undefined ? `반영 비율 ${fmtNum(a.weight)}%` : null,
          a.max_score ? `만점 ${fmtNum(a.max_score)}점` : null].filter(Boolean).join(" · "))),
      a.description ? h("div", { class: "assign-desc" }, a.description) : null,
      m.graded && m.feedback ? h("div", { class: "reply" }, `👩‍🏫 ${m.feedback}`) : null,
      h("div", { class: "people" }, m.files.map((f) => h("div", { class: "person" },
        h("a", { class: "grow", href: `/api/submission-files/${f.id}`, target: "_blank" }, `📎 ${f.name}`),
        h("span", { class: "muted", style: "font-size:0.75rem" }, fmtSize(f.size)),
        a.can_submit ? h("button", { class: "small", onclick: async () => {
          if (!confirm(`${f.name} 파일을 지울까요?`)) return;
          try { await api(`/api/submission-files/${f.id}/delete`, {}); loadMyAssignments(); } catch (err) { toast(err.message); }
        } }, "지우기") : null))),
      m.submitted ? h("div", { class: "muted", style: "font-size:0.8rem" }, `마지막 제출 ${m.submitted_at}${m.late ? " (지각)" : ""}`) : null,
      a.can_submit
        ? h("div", { class: "assign-submit" },
          h("button", { onclick: () => fileInput.click() }, "📎 파일 올리기"), fileInput,
          h("span", { class: "muted", style: "font-size:0.8rem" }, "파일 5개까지, 하나에 20MB까지"),
          text,
          h("button", { class: "primary", onclick: async () => {
            try { await api(`/api/assignments/${a.id}/text`, { text: text.value }); toast("저장했어요."); loadMyAssignments(); } catch (err) { toast(err.message); }
          } }, "글 저장"))
        : h("p", { class: "muted", style: "margin:6px 0 0" }, a.why_not));
  }));
}
