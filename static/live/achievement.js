/* 성취기준 기반 발언 분석 화면
   - 교사 [과목 정보]: 성취기준·평가기준(상중하)·평가 요소, 과목 성취수준(A~E·A~C·P)(AI 초안 → 수정) 입력, 회차마다 성취기준 연결
   - 교사 [학습 관리 > 학생별 발언 기록 > 학생]: AI 분석, 성취 변화 그래프, 종합 의견, 학생 피드백 공개
   - 학생 [내 강좌 > 학습 활동]: 선생님이 공개한 피드백과 성취 변화 그래프 */

const ACH_COLORS = ["#1b6b4a", "#e8663d", "#2f7fb5", "#8a5cc2", "#c79a1e", "#d0485f", "#3c9a6e", "#5c6bc0"];
const ACH_LEVEL = { 3: "상", 2: "중", 1: "하" };
const achApi = (url, body) => api(url, body);
const achFill = (box, ...kids) => box.replaceChildren(...kids.flat().filter((x) => x !== null && x !== undefined && x !== false && x !== ""));

/* ───────── 교사: 성취기준 입력 ───────── */

const achEditing = new Map(); // 강좌 id → 고치는 중인 성취기준 id (새로 쓰기는 "new")

async function renderStandards(c, box) {
  let d;
  try { d = await achApi(`/api/courses/${c.id}/standards`); } catch (err) { achFill(box, h("p", { class: "error" }, err.message)); return; }
  const again = () => renderStandards(c, box);
  const editing = achEditing.get(c.id);
  const cards = d.standards.map((s, i) => (editing === s.id ? standardForm(c, s, d.ai, again) : standardCard(c, s, i, again)));
  achFill(box,
    h("div", { class: "row", style: "margin:4px 0 8px" },
      h("h3", { class: "grow", style: "margin:0" }, `🎯 성취기준 ${d.standards.length}개`),
      editing ? null : h("a", { class: "button small", href: `/api/courses/${c.id}/standards/template.xlsx` }, "📥 엑셀 양식 받기"),
      editing ? null : importButton(c, d.ai, again),
      editing ? null : h("button", { class: "primary small", type: "button", onclick: () => { achEditing.set(c.id, "new"); again(); } }, "+ 성취기준 추가")),
    h("p", { class: "muted", style: "margin:0 0 10px;font-size:0.88rem" },
      "교육과정 성취기준과 성취기준별 평가기준(상·중·하)을 넣고, 평가 요소를 정해 주세요. 학생 발언 AI 분석은 이 평가 요소를 기준으로 해요. "
      + "교육과정 문서의 '교육과정 성취기준 | 평가기준' 표를 그대로 복사해 [엑셀 양식]의 A1 칸에 붙여넣고 올리면 한 번에 들어가요."),
    courseLevelsBox(c, d),
    d.standards.length || editing ? null : h("p", { class: "muted" }, "아직 넣은 성취기준이 없어요."),
    cards,
    editing === "new" ? standardForm(c, null, d.ai, again) : null,
    d.standards.length && d.sessions.length ? sessionLinks(c, d) : null,
    d.standards.length && !d.sessions.length ? h("p", { class: "muted", style: "margin-top:12px" }, "회차 정보가 없어 회차별 성취기준을 연결할 수 없어요. 회차가 없으면 모든 성취기준으로 분석해요.") : null);
}

/** 엑셀(.xlsx)로 성취기준 한꺼번에 넣기 → 평가 요소가 없는 것은 AI가 뽑아 저장 */
function importButton(c, aiOn, again) {
  const file = h("input", { type: "file", accept: ".xlsx", hidden: true });
  const btn = h("button", { class: "small", type: "button", onclick: () => file.click() }, "📤 엑셀로 올리기");
  file.onchange = async () => {
    const f = file.files[0];
    file.value = "";
    if (!f) return;
    btn.disabled = true; btn.textContent = "📤 올리는 중…";
    try {
      const res = await fetch(`/api/courses/${c.id}/standards/import`, { method: "POST", body: f,
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.detail || "엑셀을 올리지 못했어요.");
      toast(`성취기준 ${r.added}개를 넣었어요${r.updated ? `, ${r.updated}개는 새 내용으로 바꿨어요` : ""}${r.levels ? ` · 과목 성취수준 ${r.levels}단계` : ""}.`, 5000);
      if (aiOn) await draftMissing(c, r.ids, btn);
    } catch (err) { toast(err.message, 6000); }
    btn.disabled = false; btn.textContent = "📤 엑셀로 올리기";
    again();
  };
  return h("span", {}, btn, file);
}

/** 올린 성취기준 가운데 평가 요소가 없는 것은 AI 초안을 만들어 저장한다 (선생님이 나중에 [수정]으로 고친다) */
async function draftMissing(c, ids, btn) {
  const { standards } = await achApi(`/api/courses/${c.id}/standards`);
  const todo = standards.filter((s) => ids.includes(s.id) && !s.elements.length && (s.level_high || s.level_mid || s.level_low));
  if (!todo.length) return;
  if (!confirm(`평가 요소가 없는 성취기준 ${todo.length}개는 AI가 평가기준에서 평가 요소를 뽑아 넣을까요?\n(하나에 10초쯤 걸려요. 나중에 [수정]에서 고칠 수 있어요)`)) return;
  let done = 0;
  for (const s of todo) {
    btn.textContent = `🤖 평가 요소 뽑는 중… ${done + 1}/${todo.length}`;
    try {
      const r = await achApi(`/api/courses/${c.id}/standards/draft-elements`, s);
      await achApi(`/api/courses/${c.id}/standards`, { ...s, elements: r.elements });
      done += 1;
    } catch (err) { toast(`${s.code || "성취기준"}: ${err.message}`, 5000); }
  }
  toast(`AI가 성취기준 ${done}개의 평가 요소를 뽑았어요. 확인하고 필요하면 [수정]에서 고쳐 주세요.`, 6000);
}

/** 과목 전체의 성취수준별 일반적 특성 (성취도에 따라 A~E / A~C / P) */
function courseLevelsBox(c, d) {
  const inputs = d.scale.map((k) => { const t = h("textarea", { rows: 2, maxlength: 3000, placeholder: `${k} 수준의 일반적 특성` }); t.value = d.course_levels[k] || ""; return [k, t]; });
  const filled = inputs.filter(([, t]) => t.value.trim()).length;
  const save = h("button", { class: "primary small", type: "button" }, "과목 성취수준 저장");
  save.onclick = async () => {
    try {
      await achApi(`/api/courses/${c.id}/achievement-levels`, { levels: Object.fromEntries(inputs.map(([k, t]) => [k, t.value])) });
      toast("과목 성취수준을 저장했어요.");
    } catch (err) { toast(err.message); }
  };
  return h("details", { class: "std-card course-levels", open: !filled },
    h("summary", {}, h("strong", {}, "📚 과목 성취수준 "), h("span", { class: "muted", style: "font-size:0.85rem" },
      `${d.achievement_text} · ${filled}/${d.scale.length}단계 입력`)),
    h("p", { class: "muted", style: "margin:6px 0;font-size:0.85rem" }, "과목 전체의 성취수준별 일반적 특성이에요. AI 종합 의견에서 참고로만 써요."),
    h("table", { class: "info-table" }, h("tbody", {}, inputs.map(([k, t]) => h("tr", {}, h("th", { style: "width:60px;text-align:center" }, k), h("td", {}, t))))),
    h("div", { class: "row", style: "justify-content:flex-end;margin-top:8px" }, save));
}

function standardCard(c, s, i, again) {
  return h("div", { class: "std-card" },
    h("div", { class: "row" },
      h("strong", { class: "grow" }, h("span", { class: "std-code" }, s.code || `성취기준 ${i + 1}`), " ", s.text),
      h("button", { class: "small", type: "button", onclick: () => { achEditing.set(c.id, s.id); again(); } }, "수정"),
      h("button", { class: "small danger", type: "button", onclick: async () => {
        if (!confirm(`'${s.code || s.text.slice(0, 20)}' 성취기준을 지울까요? 회차 연결도 함께 지워져요.`)) return;
        await achApi(`/api/courses/${c.id}/standards/${s.id}/delete`, {});
        again();
      } }, "삭제")),
    h("details", { class: "std-levels" }, h("summary", { class: "muted" }, "평가기준 (상·중·하) 보기"),
      h("table", { class: "info-table" }, h("tbody", {},
        [["상", s.level_high], ["중", s.level_mid], ["하", s.level_low]].map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", { style: "white-space:pre-wrap" }, v || "-")))))),
    s.elements.length ? h("div", { class: "table-wrap" }, h("table", { class: "att std-elements" },
      h("thead", {}, h("tr", {}, ["평가 요소", "상", "중", "하"].map((t) => h("th", {}, t)))),
      h("tbody", {}, s.elements.map((e) => h("tr", {}, h("td", {}, h("strong", {}, e.name)), h("td", {}, e.high), h("td", {}, e.mid), h("td", {}, e.low))))))
      : h("p", { class: "error", style: "margin:6px 0 0" }, "평가 요소가 없어요. [수정]에서 평가 요소를 넣어야 AI 분석에 쓰여요."));
}

function standardForm(c, s, aiOn, again) {
  const code = h("input", { maxlength: 40, value: s?.code || "", placeholder: "예: [12법사02-03]" });
  const text = h("textarea", { rows: 2, maxlength: 2000, placeholder: "성취기준 내용" });
  text.value = s?.text || "";
  const lv = ["level_high", "level_mid", "level_low"].map((k) => { const t = h("textarea", { rows: 3, maxlength: 3000 }); t.value = s?.[k] || ""; return t; });
  const rows = h("tbody");
  const addRow = (e = {}) => {
    const cells = ["name", "high", "mid", "low"].map((k) => {
      const el = k === "name" ? h("input", { maxlength: 60, value: e[k] || "", placeholder: "예: 근거 제시" }) : h("textarea", { rows: 2, maxlength: 1000 });
      if (k !== "name") el.value = e[k] || "";
      el.dataset.k = k;
      return h("td", {}, el);
    });
    const tr = h("tr", {}, ...cells, h("td", {}, h("button", { class: "small danger", type: "button", onclick: () => tr.remove() }, "✕")));
    rows.append(tr);
  };
  (s?.elements || []).forEach(addRow);
  if (!s?.elements?.length) addRow();
  const read = () => [...rows.children].map((tr) => Object.fromEntries([...tr.querySelectorAll("[data-k]")].map((el) => [el.dataset.k, el.value.trim()]))).filter((e) => e.name);
  const draftBtn = h("button", { class: "small", type: "button", disabled: !aiOn, title: aiOn ? "" : "AI가 설정되지 않았어요" }, "🤖 평가기준에서 평가 요소 뽑기 (AI)");
  draftBtn.onclick = async () => {
    if (read().length && !confirm("지금 적힌 평가 요소를 AI 초안으로 바꿀까요?")) return;
    draftBtn.disabled = true; draftBtn.textContent = "🤖 뽑는 중…";
    try {
      const r = await achApi(`/api/courses/${c.id}/standards/draft-elements`, { code: code.value, text: text.value, level_high: lv[0].value, level_mid: lv[1].value, level_low: lv[2].value });
      rows.replaceChildren();
      r.elements.forEach(addRow);
      toast("AI가 평가 요소 초안을 만들었어요. 확인하고 고친 뒤 [저장]을 눌러 주세요.", 5000);
    } catch (err) { toast(err.message, 5000); }
    draftBtn.disabled = false; draftBtn.textContent = "🤖 평가기준에서 평가 요소 뽑기 (AI)";
  };
  const save = h("button", { class: "primary", type: "button" }, "저장");
  save.onclick = async () => {
    if (!text.value.trim()) { text.focus(); return; }
    save.disabled = true;
    try {
      await achApi(`/api/courses/${c.id}/standards`, { id: s?.id || null, code: code.value, text: text.value, level_high: lv[0].value,
        level_mid: lv[1].value, level_low: lv[2].value, elements: read() });
      achEditing.delete(c.id);
      toast("성취기준을 저장했어요.");
      again();
    } catch (err) { toast(err.message, 5000); save.disabled = false; }
  };
  return h("div", { class: "std-card editing" },
    h("div", { class: "std-form" },
      h("label", {}, "성취기준 코드", code),
      h("label", { class: "wide" }, "성취기준", text),
      h("label", { class: "wide" }, "평가기준 상", lv[0]),
      h("label", { class: "wide" }, "평가기준 중", lv[1]),
      h("label", { class: "wide" }, "평가기준 하", lv[2])),
    h("div", { class: "row", style: "margin:12px 0 6px" }, h("strong", { class: "grow" }, "평가 요소"), draftBtn),
    h("div", { class: "table-wrap" }, h("table", { class: "att std-elements edit" },
      h("thead", {}, h("tr", {}, ["평가 요소", "상", "중", "하", ""].map((t) => h("th", {}, t)))), rows)),
    h("div", { class: "row", style: "margin-top:8px" },
      h("button", { class: "small", type: "button", onclick: () => addRow() }, "+ 평가 요소 추가"), h("span", { class: "grow" }),
      h("button", { type: "button", onclick: () => { achEditing.delete(c.id); again(); } }, "취소"), save));
}

/** 회차마다 다루는 성취기준 고르기 (바로 저장) */
function sessionLinks(c, d) {
  return h("div", { style: "margin-top:16px" },
    h("h4", { style: "margin:0 0 6px" }, "📅 회차별 성취기준 연결"),
    h("p", { class: "muted", style: "margin:0 0 8px;font-size:0.85rem" }, "수업은 같은 날짜의 회차와 연결돼요. 연결하지 않은 회차의 수업은 모든 성취기준으로 분석해요."),
    h("div", { class: "table-wrap" }, h("table", { class: "att std-links" },
      h("thead", {}, h("tr", {}, ["회차", "날짜", "수업 주제", "성취기준"].map((t) => h("th", {}, t)))),
      h("tbody", {}, d.sessions.map((x) => {
        const picks = d.standards.map((s, i) => {
          const box = h("input", { type: "checkbox", checked: x.standard_ids.includes(s.id) });
          box.onchange = async () => {
            const ids = [...cell.querySelectorAll("input")].map((el, j) => (el.checked ? d.standards[j].id : null)).filter(Boolean);
            try { await achApi(`/api/courses/${c.id}/sessions/${x.no}/standards`, { standard_ids: ids }); toast(`${x.no}회차 연결을 저장했어요.`); }
            catch (err) { toast(err.message); }
          };
          return h("label", { class: "std-pick", title: s.text }, box, s.code || `성취기준 ${i + 1}`);
        });
        const cell = h("td", {}, ...picks);
        return h("tr", {}, h("td", { class: "num" }, `${x.no}회`), h("td", { class: "num" }, fmtDate(x.date)), h("td", {}, x.topic || "-"), cell);
      })))));
}

/* ───────── 그래프: 수업(회차)마다 평가 요소별 수준(하 1 · 중 2 · 상 3) ───────── */

function achSeries(classes) {
  const keys = [];
  for (const x of classes) for (const r of x.ratings) {
    const k = `${r.code} ${r.element}`.trim();
    if (!keys.includes(k)) keys.push(k);
  }
  return keys.map((k, i) => ({ key: k, color: ACH_COLORS[i % ACH_COLORS.length],
    points: classes.map((x) => { const r = x.ratings.find((y) => `${y.code} ${y.element}`.trim() === k); return r ? r.level : null; }) }));
}

function achChart(classes) {
  const series = achSeries(classes);
  if (!series.length) return h("p", { class: "muted" }, "판단할 수 있는 발언이 아직 없어요.");
  const W = 640, H = 230, L = 44, R = 16, T = 16, B = 40;
  const n = classes.length;
  const X = (i) => (n === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const Y = (v) => T + ((3 - v) * (H - T - B)) / 2;
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; return e; };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ach-chart", role: "img", "aria-label": "회차별 평가 요소 수준 그래프" });
  for (const v of [1, 2, 3]) {
    svg.append(el("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: "#e3e6e8", "stroke-dasharray": v === 2 ? "4 4" : "" }));
    svg.append(el("text", { x: L - 10, y: Y(v) + 4, "text-anchor": "end", "font-size": 13, fill: "#59636b", "font-weight": 700 }, ACH_LEVEL[v]));
  }
  classes.forEach((x, i) => svg.append(el("text", { x: X(i), y: H - 14, "text-anchor": "middle", "font-size": 11, fill: "#59636b" },
    `${i + 1}회 ${x.date.slice(5).replace("-", ".")}`)));
  series.forEach((s, si) => {
    const off = (si - (series.length - 1) / 2) * 3; // 같은 점이 겹치지 않게 살짝 비킨다
    const pts = s.points.map((v, i) => (v ? [X(i), Y(v) + off] : null));
    let d = "";
    pts.forEach((p, i) => { if (p) d += `${d && pts[i - 1] ? "L" : "M"}${p[0]},${p[1]} `; });
    svg.append(el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2.5, "stroke-linejoin": "round" }));
    pts.forEach((p, i) => {
      if (!p) return;
      const dot = el("circle", { cx: p[0], cy: p[1], r: 5, fill: s.color, stroke: "#fff", "stroke-width": 1.5 });
      dot.append(el("title", {}, `${classes[i].date} ${s.key}: ${ACH_LEVEL[s.points[i]]}`));
      svg.append(dot);
    });
  });
  const legend = h("div", { class: "ach-legend" }, series.map((s) => h("span", {}, h("i", { style: `background:${s.color}` }), s.key)));
  return h("div", { class: "ach-chart-wrap" }, svg, legend);
}

/* ───────── 교사: 학생 한 명의 AI 성취 분석 ───────── */

async function renderAnalysis(courseId, who, box) {
  let v;
  try { v = await achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/analysis`); } catch (err) { achFill(box, h("p", { class: "error" }, err.message)); return; }
  const again = () => renderAnalysis(courseId, who, box);
  const run = h("button", { class: "primary small", type: "button", disabled: !v.ai, title: v.ai ? "" : "AI가 설정되지 않았어요" },
    v.analyzed_at ? "🤖 다시 분석하기" : "🤖 AI 분석하기");
  run.onclick = async () => {
    run.disabled = true; run.textContent = "🤖 분석 중… (30초쯤 걸려요)";
    try { await achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/analyze`, {}); toast("AI 분석을 마쳤어요."); again(); }
    catch (err) { toast(err.message, 6000); run.disabled = false; run.textContent = "🤖 AI 분석하기"; }
  };
  const fb = h("textarea", { rows: 5, maxlength: 4000, placeholder: "학생에게 보여 줄 피드백" });
  fb.value = v.feedback || "";
  const pub = h("input", { type: "checkbox", checked: v.published });
  const saveFb = h("button", { class: "primary small", type: "button" }, "피드백 저장");
  saveFb.onclick = async () => {
    try {
      await achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/feedback`, { feedback: fb.value, published: pub.checked });
      toast(pub.checked ? "저장했어요. 학생의 [내 강좌 > 학습 활동]에 보여요." : "저장했어요. 공개하기 전에는 학생에게 보이지 않아요.", 4000);
      again();
    } catch (err) { toast(err.message); }
  };
  const when = v.analyzed_at ? new Date(v.analyzed_at * 1000).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }) : "";
  achFill(box,
    h("div", { class: "row", style: "margin:4px 0 8px" },
      h("h4", { class: "grow", style: "margin:0" }, "🤖 AI 성취 분석", when ? h("span", { class: "muted", style: "font-weight:400;font-size:0.82rem" }, ` · ${when} 분석`) : null), run),
    v.analyzed_at ? null : h("p", { class: "muted" }, v.ai ? "[AI 분석하기]를 누르면 이 학생의 발언을 성취기준의 평가 요소에 비추어 수업마다 상·중·하로 판단하고, 종합 의견과 피드백 초안을 만들어요. (이름·학번은 가리고 보내요)" : "AI가 설정되지 않아 분석할 수 없어요."),
    v.analyzed_at ? [
      h("div", { class: "ach-box" }, h("div", { class: "ach-box-head" }, "📈 성취 변화 (수업별 평가 요소 수준)"), achChart(v.classes)),
      h("div", { class: "ach-box" }, h("div", { class: "ach-box-head" }, "📝 AI 종합 의견 ", h("span", { class: "muted", style: "font-weight:400" }, "(선생님만 봐요)")),
        h("p", { style: "white-space:pre-wrap;margin:0;line-height:1.6" }, v.summary || "-")),
      h("details", { class: "ach-box" }, h("summary", { class: "ach-box-head" }, "🔎 수업별 판단 근거"),
        v.classes.map((x) => h("div", { class: "ach-class" },
          h("div", { class: "speech-day-head" }, `${fmtDate(x.date)} · ${x.title || "(주제 없음)"}`),
          x.ratings.length ? x.ratings.map((r) => h("div", { class: "ach-rate" },
            h("span", { class: `ach-lv lv${r.level}` }, ACH_LEVEL[r.level]), h("strong", {}, `${r.code} ${r.element}`),
            h("span", { class: "muted" }, ` “${r.evidence}”`))) : h("p", { class: "muted", style: "margin:4px 0" }, "판단할 근거가 되는 발언이 없었어요.")))),
    ] : null,
    h("div", { class: "ach-box" },
      h("div", { class: "ach-box-head" }, "💌 학생에게 줄 피드백 ", h("span", { class: "muted", style: "font-weight:400" }, "(AI 초안을 고쳐서 쓰세요)")),
      fb,
      h("div", { class: "row", style: "margin-top:8px" },
        h("label", { class: "switch grow" }, pub, "학생에게 공개 (피드백과 성취 변화 그래프)"), saveFb),
      v.published ? h("p", { class: "ok-text", style: "margin:6px 0 0;font-size:0.85rem" }, "✅ 지금 학생에게 공개 중이에요.") : null));
}

/* ───────── 학생: 선생님이 공개한 피드백 ───────── */

async function renderMyFeedback(courseId, box) {
  let v;
  try { v = await achApi(`/api/my/courses/${courseId}/feedback`); } catch { return; }
  if (!v.published) { box.hidden = true; return; }
  box.hidden = false;
  achFill(box,
    h("div", { class: "ach-box my-feedback" },
      h("div", { class: "ach-box-head" }, "💌 선생님 피드백"),
      h("p", { style: "white-space:pre-wrap;margin:0 0 10px;line-height:1.6" }, v.feedback),
      v.classes.length ? [h("div", { class: "ach-box-head", style: "margin-top:6px" }, "📈 나의 성취 변화"), achChart(v.classes)] : null));
}
