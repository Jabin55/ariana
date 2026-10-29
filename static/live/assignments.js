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

async function renderCourseAssignments(c, box) {
  let data;
  try { data = await api(`/api/courses/${c.id}/assignments`); } catch (err) { box.replaceChildren(h("p", { class: "error" }, err.message)); return; }
  const reload = () => renderCourseAssignments(c, box);
  const title = h("input", { maxlength: 80, placeholder: "과제 제목 (예: 선거 제도 비교 보고서)", required: true });
  const desc = h("textarea", { rows: 3, maxlength: 5000, placeholder: "안내 (분량, 형식, 평가 기준·배점 등)" });
  const due = h("input", { type: "datetime-local" });
  const late = h("input", { type: "checkbox", checked: true });
  const form = h("form", { class: "box assign-form", onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api(`/api/courses/${c.id}/assignments`, { title: title.value, description: desc.value, due: due.value, allow_late: late.checked });
      toast("과제를 냈어요. 수강생 마이페이지 '평가 활동'에 바로 보여요.");
      reload();
    } catch (err) { toast(err.message); }
  } },
    h("strong", {}, "새 과제 내기 (수행평가)"), title, desc,
    h("div", { class: "row" }, h("span", { class: "muted" }, "마감"), due,
      h("label", { class: "switch" }, late, "마감 뒤에도 받기(지각 표시)")),
    h("button", { class: "primary", type: "submit" }, "과제 내기"));

  const items = data.assignments.map((a) => {
    const subsBox = h("div");
    const card = h("div", { class: "box assign-item" },
      h("div", { class: "row" },
        h("strong", { class: "grow" }, a.title),
        h("span", { class: `status ${a.closed ? "rejected" : a.past_due ? "pending" : "approved"}` },
          a.closed ? "제출 마감함" : a.past_due ? (a.allow_late ? "마감 지남 (지각 받는 중)" : "마감 지남") : "받는 중")),
      h("div", { class: "muted", style: "font-size:0.85rem" },
        `${dueText(a)} · 제출 ${a.submitted}/${data.students}명 · 채점 ${a.graded}명`),
      a.description ? h("div", { class: "assign-desc" }, a.description) : null,
      h("div", { class: "row", style: "margin-top:6px" },
        h("button", { class: `small ${openSubs.has(a.id) ? "on" : ""}`, onclick: () => {
          if (openSubs.has(a.id)) openSubs.delete(a.id); else openSubs.add(a.id);
          reload();
        } }, openSubs.has(a.id) ? "제출 현황 접기" : "제출 현황·채점"),
        h("a", { class: "button small", href: `/api/assignments/${a.id}/download.zip` }, "📥 모두 내려받기"),
        h("span", { class: "grow" }),
        h("button", { class: "small", onclick: async () => {
          const v = prompt("새 마감 (예: 2026-11-10 23:59, 비우면 마감 없음)", a.due);
          if (v === null) return;
          try { await api(`/api/assignments/${a.id}`, { due: v.trim() ? v.trim().replace(" ", "T") : "" }); reload(); } catch (err) { toast(err.message); }
        } }, "마감 바꾸기"),
        h("button", { class: "small", onclick: async () => { await api(`/api/assignments/${a.id}`, { closed: !a.closed }); reload(); } },
          a.closed ? "다시 받기" : "제출 마감"),
        h("button", { class: "small danger", onclick: async () => {
          if (!confirm(`'${a.title}' 과제를 지울까요? 학생들이 낸 파일과 점수도 모두 지워져요.`)) return;
          await api(`/api/assignments/${a.id}/delete`, {});
          reload();
        } }, "지우기")),
      subsBox);
    if (openSubs.has(a.id)) renderSubmissions(a, subsBox, reload);
    return card;
  });
  box.replaceChildren(
    ...items, form);
}

async function renderSubmissions(a, box, reload) {
  const { submissions } = await api(`/api/assignments/${a.id}/submissions`);
  const mixed = new Set(submissions.map((s) => s.school)).size > 1;
  const rows = submissions.map((s) => {
    const score = h("input", { type: "number", min: 0, step: 0.5, value: s.score ?? "", placeholder: "점수", style: "width:5em" });
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
        h("div", { class: "muted", style: "font-size:0.8rem;margin-left:18px" }, dueText(a))),
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
