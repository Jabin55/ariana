/* 성취기준 기반 발언 분석 화면
   - 교사 [과목 정보]: 성취기준·평가기준(상중하)·평가 요소, 과목 성취수준(A~E·A~C·P)(AI 초안 → 수정) 입력, 회차마다 성취기준 연결
   - 교사 [학습 관리 > 활동 피드백 > 학생 > 성취 분석]: AI 분석, 역량·성취 변화 그래프, 종합 의견, 학생 피드백 공개
   - 학생 [내 강좌 > 활동 피드백]: 선생님이 공개한 피드백과 성취 변화 그래프 */

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
      "평가 요소는 [평가 요소] 시트에 적거나 AI 초안을 받아 교사가 확인·수정해 주세요."),
    courseLevelsBox(c, d),
    d.standards.length || editing ? null : h("p", { class: "muted" }, "아직 넣은 성취기준이 없어요."),
    cards,
    editing === "new" ? standardForm(c, null, d.ai, again) : null,
    d.standards.length ? h("p", { class: "muted", style: "margin-top:12px;font-size:0.88rem" }, "회차마다 다루는 성취기준은 [🗓 회차 정보] 탭에서 골라요.") : null);
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
  if (!confirm(`평가 요소가 없는 성취기준 ${todo.length}개에 AI 초안을 넣을까요?\n성취기준·평가기준에 맞는 범주와 확인 자료를 제안합니다. [수정]에서 반드시 확인해 주세요. (하나에 10초쯤 걸려요)`)) return;
  let done = 0;
  for (const s of todo) {
    btn.textContent = `🤖 평가 요소 뽑는 중… ${done + 1}/${todo.length}`;
    try {
      const r = await achApi(`/api/courses/${c.id}/standards/draft-elements`, s);
      await achApi(`/api/courses/${c.id}/standards`, { ...s, elements: r.elements });
      done += 1;
    } catch (err) { toast(`${s.code || "성취기준"}: ${err.message}`, 5000); }
  }
  toast(`AI가 성취기준 ${done}개의 평가 요소 초안을 넣었어요. [수정]에서 확인하고 고쳐 주세요.`, 6000);
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
    h("details", { class: "std-levels" }, h("summary", { class: "muted" }, "성취 기준별 평가 기준"),
      h("table", { class: "info-table" }, h("tbody", {},
        [["상", s.level_high], ["중", s.level_mid], ["하", s.level_low]].map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", { style: "white-space:pre-wrap" }, v || "-")))))),
    s.elements.length ? h("details", { class: "std-levels" },
      h("summary", { class: "muted" }, "평가 요소에 따른 수준별 수행 진술문"),
      h("div", { class: "table-wrap" }, h("table", { class: "att std-elements" },
        h("colgroup", {}, Array.from({ length: 6 }, () => h("col"))),
        h("thead", {},
          h("tr", {}, ["범주", "평가 요소", "평가 자료"].map((t) => h("th", { rowspan: 2 }, t)),
            h("th", { colspan: 3 }, "척도별 수행 수준")),
          h("tr", {}, ["상", "중", "하"].map((t) => h("th", {}, t)))),
        h("tbody", {}, s.elements.map((e) => h("tr", {},
          h("td", {}, h("span", { class: "std-element-category" }, e.category || "미분류")),
          h("td", {}, h("strong", {}, e.name)), h("td", {}, e.evidence || "-"),
          h("td", {}, e.high), h("td", {}, e.mid), h("td", {}, e.low)))))))
      : h("p", { class: "error", style: "margin:6px 0 0" }, "평가 요소가 없어요. [수정]에서 평가 요소를 넣어야 AI 분석에 쓰여요."));
}

function standardForm(c, s, aiOn, again) {
  const code = h("input", { maxlength: 40, value: s?.code || "", placeholder: "[12법사02-03]", "aria-label": "성취기준 코드" });
  const text = h("textarea", { rows: 2, maxlength: 2000, placeholder: "성취기준 내용", "aria-label": "성취기준" });
  text.value = s?.text || "";
  const lv = ["level_high", "level_mid", "level_low"].map((k, i) => { const t = h("textarea", { rows: 2, maxlength: 3000, "aria-label": `평가기준 ${"상중하"[i]}` }); t.value = s?.[k] || ""; return t; });
  const rows = h("tbody");
  const addRow = (e = {}) => {
    const category = h("select", { "data-k": "category", "aria-label": "평가 요소 범주" },
      [["", "범주 선택"], ["지식·이해", "지식·이해"], ["과정·기능", "과정·기능"], ["가치·태도", "가치·태도"]]
        .map(([value, label]) => h("option", { value, selected: (e.category || "") === value }, label)));
    const name = h("input", { "data-k": "name", "aria-label": "평가 요소 이름", maxlength: 60, value: e.name || "", placeholder: "예: 근거 제시" });
    const evidence = h("input", { "data-k": "evidence", "aria-label": "평가 자료", maxlength: 300, value: e.evidence || "", placeholder: "평가 자료: 퀴즈·보고서 등" });
    const cells = [h("td", {}, category), h("td", {}, name), h("td", {}, evidence), ...["high", "mid", "low"].map((k) => {
      const el = h("textarea", { rows: 2, maxlength: 1000 });
      el.value = e[k] || "";
      el.dataset.k = k;
      return h("td", {}, el);
    })];
    const tr = h("tr", {}, ...cells, h("td", {}, h("button", { class: "small danger", type: "button", onclick: () => tr.remove() }, "✕")));
    rows.append(tr);
  };
  (s?.elements || []).forEach(addRow);
  if (!s?.elements?.length) addRow();
  const read = () => [...rows.children].map((tr) => Object.fromEntries([...tr.querySelectorAll("[data-k]")].map((el) => [el.dataset.k, el.value.trim()]))).filter((e) => e.name);
  const draftBtn = h("button", { class: "small", type: "button", disabled: !aiOn, title: aiOn ? "" : "AI가 설정되지 않았어요" }, "🤖 평가 요소 초안 제안 (AI)");
  draftBtn.onclick = async () => {
    if (read().length && !confirm("지금 적힌 평가 요소를 AI 초안으로 바꿀까요?")) return;
    draftBtn.disabled = true; draftBtn.textContent = "🤖 뽑는 중…";
    try {
      const r = await achApi(`/api/courses/${c.id}/standards/draft-elements`, { code: code.value, text: text.value, level_high: lv[0].value, level_mid: lv[1].value, level_low: lv[2].value });
      rows.replaceChildren();
      r.elements.forEach(addRow);
      toast("AI가 평가 요소 초안을 만들었어요. 확인하고 고친 뒤 [저장]을 눌러 주세요.", 5000);
    } catch (err) { toast(err.message, 5000); }
    draftBtn.disabled = false; draftBtn.textContent = "🤖 평가 요소 초안 제안 (AI)";
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
    // 표 모양: 성취기준 코드 / 성취기준, 그 아래 평가기준 상·중·하
    h("div", { class: "table-wrap" }, h("table", { class: "att std-head-form" },
      h("colgroup", {}, h("col", { class: "c-label" }), h("col", { class: "c-level" }), h("col")),
      h("tbody", {},
        h("tr", {}, h("th", { colspan: 2 }, "성취기준 코드"), h("th", {}, "성취기준")),
        h("tr", {}, h("td", { colspan: 2 }, code), h("td", {}, text)),
        ["상", "중", "하"].map((t, i) => h("tr", {}, i ? null : h("th", { rowspan: 3 }, "평가기준"), h("th", {}, t), h("td", {}, lv[i])))))),
    h("div", { class: "row", style: "margin:12px 0 6px" }, h("strong", { class: "grow" }, "평가 요소"), draftBtn),
    h("div", { class: "table-wrap" }, h("table", { class: "att std-elements edit" },
      h("colgroup", {}, Array.from({ length: 7 }, () => h("col"))),
      h("thead", {},
        h("tr", {}, ["범주", "평가 요소", "평가 자료"].map((t) => h("th", { rowspan: 2 }, t)),
          h("th", { colspan: 3 }, "척도별 수행 수준"), h("th", { rowspan: 2 }, "")),
        h("tr", {}, ["상", "중", "하"].map((t) => h("th", {}, t)))), rows)),
    h("div", { class: "row", style: "margin-top:8px" },
      h("button", { class: "small", type: "button", onclick: () => addRow() }, "+ 평가 요소 추가"), h("span", { class: "grow" }),
      h("button", { type: "button", onclick: () => { achEditing.delete(c.id); again(); } }, "취소"), save));
}

/* ───────── 교사 [회차 정보] 탭: 과목 개설 때 넣은 회차 + 회차마다 다루는 성취기준 (체크하면 바로 저장) ───────── */
async function renderSessionStandards(c, box) {
  achFill(box, h("p", { class: "muted" }, "회차 정보를 불러오는 중…"));
  let d;
  try { d = await achApi(`/api/courses/${c.id}/standards`); } catch (err) { achFill(box, h("p", { class: "error" }, err.message)); return; }
  const DAYNAMES = ["일", "월", "화", "수", "목", "금", "토"];
  const dow = (iso) => DAYNAMES[new Date(`${iso}T00:00:00Z`).getUTCDay()];
  if (!d.sessions.length) {
    const extra0 = h("div");
    achFill(box, h("p", { class: "muted", style: "margin:12px 0" },
      "과목 개설 때 넣은 회차 정보가 없어요. [📘 과목 정보] 오른쪽 위의 [정보 수정]에서 회차를 넣어 주세요. (아래에서 이미 연 수업마다 성취기준을 고를 수도 있어요)"), extra0);
    extraClasses(c, d, extra0);
    return;
  }
  const linked = d.sessions.filter((x) => x.standard_ids.length).length;
  const extra = h("div"); // 회차 외 보강·특강
  achFill(box,
    h("div", { class: "row", style: "margin:8px 0" },
      h("span", { class: "grow muted" }, `회차 ${d.sessions.length}개 · 성취기준을 연결한 회차 ${linked}개`)),
    d.standards.length ? h("p", { class: "muted", style: "margin:0 0 8px;font-size:0.85rem" },
      "회차마다 다루는 성취기준을 체크하면 바로 저장돼요. 실시간 수업은 같은 날짜의 회차와 연결되고, 연결하지 않은 회차의 수업은 모든 성취기준으로 분석해요.")
      : h("p", { class: "error", style: "margin:0 0 8px" }, "아직 성취기준이 없어요. [📘 과목 정보]에서 성취기준을 먼저 넣어 주세요."),
    h("div", { class: "table-wrap" }, h("table", { class: "att std-links" },
      h("thead", {}, h("tr", {}, ["회차", "날짜", "시간", "수업 주제", "성취기준"].map((t) => h("th", {}, t)))),
      h("tbody", {}, d.sessions.map((x) => {
        const cell = h("td", {});
        const picks = d.standards.map((s, i) => {
          const tick = h("input", { type: "checkbox", checked: x.standard_ids.includes(s.id) });
          tick.onchange = async () => {
            const ids = [...cell.querySelectorAll("input")].map((el, j) => (el.checked ? d.standards[j].id : null)).filter(Boolean);
            try { await achApi(`/api/courses/${c.id}/sessions/${x.no}/standards`, { standard_ids: ids }); toast(`${x.no}회차 성취기준을 저장했어요.`); }
            catch (err) { toast(err.message); tick.checked = !tick.checked; }
          };
          return h("label", { class: "std-pick", title: s.text }, tick, s.code || `성취기준 ${i + 1}`);
        });
        // 줄마다 같은 칸 너비의 격자에 놓아 위아래 체크 상자가 한 줄로 맞는다
        cell.append(picks.length ? h("div", { class: "std-pick-grid" }, ...picks) : h("span", { class: "muted" }, "-"));
        return h("tr", {}, h("td", { class: "num" }, `${x.no}회`), h("td", { class: "num" }, `${fmtDate(x.date)} (${dow(x.date)})`),
          h("td", { class: "num" }, x.start ? `${x.start}~${x.end || ""}` : "-"), h("td", {}, x.topic || "-"), cell);
      })))),
    extra);
  extraClasses(c, d, extra);
}

/** [회차 정보] 아래: 회차표에 없는 날 연 수업(보강·특강)도 성취기준을 고른다 */
async function extraClasses(c, d, box) {
  let classes = [];
  try { ({ classes } = await achApi(`/api/courses/${c.id}/classes`)); } catch { return; }
  const days = new Set(d.sessions.map((x) => x.date));
  const list = classes.filter((x) => !days.has(x.date)).reverse(); // 오래된 수업부터
  if (!list.length || !d.standards.length) return;
  achFill(box,
    h("h4", { style: "margin:22px 0 6px" }, "➕ 회차 외 보강·특강"),
    h("p", { class: "muted", style: "margin:0 0 8px;font-size:0.85rem" }, "회차표에 없는 날 연 수업이에요. 다룬 성취기준을 체크하면 바로 저장돼요. (고르지 않으면 모든 성취기준으로 분석해요)"),
    h("div", { class: "table-wrap" }, h("table", { class: "att std-links" },
      h("thead", {}, h("tr", {}, ["", "날짜", "시간", "수업 주제", "성취기준"].map((t) => h("th", {}, t)))),
      h("tbody", {}, list.map((x) => {
        const have = d.class_links[String(x.id)] || [];
        const cell = h("td", {});
        const picks = d.standards.map((s, i) => {
          const tick = h("input", { type: "checkbox", checked: have.includes(s.id) });
          tick.onchange = async () => {
            const ids = [...cell.querySelectorAll("input")].map((el, j) => (el.checked ? d.standards[j].id : null)).filter(Boolean);
            try { await achApi(`/api/courses/${c.id}/classes/${x.id}/standards`, { standard_ids: ids }); toast(`'${x.title}' 성취기준을 저장했어요.`); }
            catch (err) { toast(err.message); tick.checked = !tick.checked; }
          };
          return h("label", { class: "std-pick", title: s.text }, tick, s.code || `성취기준 ${i + 1}`);
        });
        cell.append(h("div", { class: "std-pick-grid" }, ...picks));
        return h("tr", {}, h("td", { class: "num" }, "보강"), h("td", { class: "num" }, fmtDate(x.date)),
          h("td", { class: "num" }, (x.start || "").slice(0, 5) || "-"), h("td", {}, x.title || "-"), cell);
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
  if (!series.length) return h("p", { class: "muted" }, "판단할 수 있는 수업 기록이 아직 없어요.");
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
  // 양 끝 날짜는 안쪽으로 붙여 잘리지 않게
  const anchorAt = (i) => (n > 1 && i === 0 ? "start" : n > 1 && i === n - 1 ? "end" : "middle");
  classes.forEach((x, i) => svg.append(el("text", { x: X(i) + (anchorAt(i) === "start" ? -6 : anchorAt(i) === "end" ? 6 : 0), y: H - 14, "text-anchor": anchorAt(i), "font-size": 11, fill: "#59636b" },
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

/* ───────── 핵심역량 6각형(레이더) 차트: 1~5점 ───────── */
function achRadar(comps, color = "#1b6b4a", fill = "rgba(27,107,74,0.22)", aria = "핵심역량 밸런스 차트") {
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
  const W = 460, H = 330, cx = W / 2, cy = H / 2 + 4, R = 108; // 양옆 글자가 잘리지 않게 가로 여백을 넉넉히
  const n = comps.length;
  const pt = (i, r) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const poly = (r) => comps.map((_, i) => pt(i, r).join(",")).join(" ");
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ach-radar", role: "img", "aria-label": aria });
  for (let lv = 1; lv <= 5; lv++) svg.append(el("polygon", { points: poly((R * lv) / 5), fill: lv === 5 ? "#f6faf8" : "none", stroke: "#dfe6e3", "stroke-width": 1 }));
  comps.forEach((_, i) => { const [x, y] = pt(i, R); svg.append(el("line", { x1: cx, y1: cy, x2: x, y2: y, stroke: "#dfe6e3" })); });
  const shape = comps.map((c, i) => pt(i, (R * c.score) / 5).join(",")).join(" ");
  svg.append(el("polygon", { points: shape, fill, stroke: color, "stroke-width": 2.5, "stroke-linejoin": "round" }));
  comps.forEach((c, i) => {
    const [x, y] = pt(i, (R * c.score) / 5);
    const dot = el("circle", { cx: x, cy: y, r: 4.5, fill: color, stroke: "#fff", "stroke-width": 1.5 });
    dot.append(el("title", {}, `${c.label} ${c.score}점 · ${c.reason || ""}`));
    svg.append(dot);
    const [lx, ly] = pt(i, R + 26);
    const anchor = Math.abs(lx - cx) < 8 ? "middle" : lx > cx ? "start" : "end";
    const name = c.label.replace(" 역량", "");
    const t = el("text", { x: lx, y: ly + 4, "text-anchor": anchor, "font-size": 12.5, "font-weight": 700, fill: "#33403b" }, name.length > 10 ? `${name.slice(0, 10)}…` : name);
    const s = el("tspan", { fill: color, "font-weight": 800 }, ` ${c.score}`);
    t.append(s);
    svg.append(t);
  });
  return svg;
}

function achRadarReasons(comps, edit = null) { // edit(c, i) → [점수 칸, 근거 칸] (교사가 수정할 때)
  return h("div", { class: "ach-reasons" }, h("div", { class: "ach-sub-head" }, edit ? "✏️ 역량별 판단 근거 수정" : "🔎 역량별 판단 근거"),
    h("div", {}, h("table", { class: "att ach-reason-table" },
      h("colgroup", {}, h("col", { class: "c-name" }), h("col", { class: "c-score" }), h("col")),
      h("thead", {}, h("tr", {}, h("th", {}, "역량"), h("th", {}, "점수"), h("th", {}, "근거"))),
      h("tbody", {}, comps.map((c, i) => {
        const [score, reason] = edit ? edit(c, i) : [`${c.score}점`, c.reason || "-"];
        // ⓘ: 마우스를 올리거나 누르면 역량의 뜻이 말풍선으로
        const info = c.desc ? h("span", { class: "ach-info", tabindex: 0, role: "button", "aria-label": `${c.label}의 뜻: ${c.desc}`, "data-tip": c.desc }, "ⓘ") : null;
        return h("tr", {}, h("td", {}, c.label, info), h("td", { class: "c-score" }, score), h("td", {}, reason));
      })))));
}

const ACH_TREND = { up: "↗ 상승", down: "↘ 하락", flat: "→ 유지" };
const achMD = (iso) => (iso || "").slice(5).replace("-", "/");

/** 작은 꺾은선 (값이 없는 회차는 건너뜀) */
function achSpark(values, max) {
  const ns = "http://www.w3.org/2000/svg", W = 70, H = 20;
  const pts = values.map((v, i) => (v === null || v === undefined ? null : [values.length > 1 ? (i * (W - 6)) / (values.length - 1) + 3 : W / 2, H - 3 - ((H - 6) * v) / (max || 1)])).filter(Boolean);
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "ach-spark"); svg.setAttribute("aria-hidden", "true");
  if (pts.length > 1) { const pl = document.createElementNS(ns, "polyline"); pl.setAttribute("points", pts.map((p) => p.join(",")).join(" ")); svg.append(pl); }
  for (const [x, y] of pts) { const c = document.createElementNS(ns, "circle"); c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", 2); svg.append(c); }
  return svg;
}
const achTrendOf = (vals) => { const xs = vals.filter((v) => v !== null && v !== undefined); return xs.length < 2 ? null : xs.at(-1) > xs[0] ? "up" : xs.at(-1) < xs[0] ? "down" : "flat"; };
const achTrendCell = (t) => h("td", { class: `ach-trend ${t || ""}` }, t ? ACH_TREND[t] : "–");

/** 🎯 성취기준별 도달 상태: 회차별 상·중·하 → 현재 도달·추세, 그리고 다음 단계 */
function achProgressTable(v) {
  const rows = v.standards_progress || [];
  if (!rows.length || !v.classes.length) return null;
  return h("div", { class: "ach-box" },
    h("div", { class: "ach-box-head" }, "🎯 성취기준별 도달 상태 ",
      h("span", { class: "muted", style: "font-weight:400;font-size:0.82rem" }, "(성취기준의 상·중·하 수행 진술 기준 · 현재 도달은 최근 2회 판단이 같으면 확정)")),
    h("div", { class: "table-wrap" }, h("table", { class: "att ach-progress" },
      h("thead", {}, h("tr", {}, h("th", {}, "성취기준"), v.classes.map((x) => h("th", { title: x.title }, achMD(x.date))),
        h("th", { title: "판단 횟수 / 다룬 수업 수" }, "판단/다룸"), h("th", {}, "현재 도달"), h("th", {}, "추세"))),
      h("tbody", {}, rows.flatMap((r) => [
        h("tr", {},
          h("td", { class: "ach-std-name" }, h("strong", {}, r.code || ""), " ", h("span", { class: "muted" }, r.text)),
          r.cells.map((c) => c.state === "off" ? h("td", { class: "ach-cell ach-off", title: "이 수업에서 다루지 않은 성취기준" })
            : h("td", { class: `ach-cell${c.level ? "" : " ach-gap"}`, title: c.evidence || "이 수업에서 다뤘지만 판단할 근거가 없어요 (관찰 필요)" },
              c.level ? h("span", { class: `ach-lv lv${c.level}` }, ACH_LEVEL[c.level]) : h("span", { class: "ach-q" }, "?"))),
          h("td", { class: "ach-cell", title: "다룬 수업 가운데 판단한 횟수" }, `${r.judged}/${r.taught}`),
          h("td", { class: "ach-cell" }, r.current ? h("span", { class: `ach-lv lv${r.current}` }, ACH_LEVEL[r.current]) : null,
            h("div", { class: "muted", style: "font-size:0.75rem" }, r.status)),
          achTrendCell(r.trend)),
        r.next_step ? h("tr", { class: "ach-next" }, h("td", { colspan: v.classes.length + 4 }, "➡️ 다음 단계: ", r.next_step)) : null,
      ].filter(Boolean))))),
    h("p", { class: "muted", style: "margin:6px 0 0;font-size:0.8rem" }, "칸에 마우스를 올리면 판단 근거가 보여요. 회색 빈칸은 그 수업에서 다루지 않은 성취기준([회차 정보]에서 연결), ? 는 다뤘지만 근거가 없어 관찰이 필요한 것이에요."));
}

/** 📈 반복 관찰 지표: 회차마다 같은 잣대 (자동 집계 + AI 판단) */
function achTrackingTable(v) {
  const t = v.tracking || [];
  if (!t.length) return null;
  const num = [
    ["talk", "발언 수", ""], ["spontaneous", "└ 자발 발언", "스스로 한 발언"], ["response", "└ 발문 응답", "선생님 질문 뒤 20초 안의 대답"],
    ["avg_len", "평균 발언 길이(자)", ""], ["quiz_rate", "퀴즈 정답률(%)", "정답이 있는 퀴즈만"],
    ["quiz_score", "퀴즈 점수율(%)", "채점한 퀴즈의 점수 ÷ 배점 (선생님이 고친 점수 포함)"]];
  const numRows = num.map(([k, label, tip]) => {
    const vals = t.map((x) => x.counts[k]);
    return h("tr", {}, h("th", { title: tip }, label), vals.map((x) => h("td", { class: "ach-cell" }, x === null || x === undefined ? "–" : String(x))),
      h("td", { class: "ach-cell" }, achSpark(vals, Math.max(1, ...vals.filter((x) => x !== null && x !== undefined)))), achTrendCell(achTrendOf(vals)));
  });
  const aiRows = (v.indicator_names || []).map((ind) => {
    const vals = t.map((x) => x.indicators?.[ind.key]?.level ?? null);
    return h("tr", {}, h("th", { title: ind.desc }, `🤖 ${ind.label}`),
      t.map((x) => { const c = x.indicators?.[ind.key]; return h("td", { class: "ach-cell", title: c?.evidence || (x.analyzed ? "그 수업에서 드러나지 않음" : "아직 분석 전") },
        c ? h("span", { class: `ach-lv lv${c.level}` }, ACH_LEVEL[c.level]) : h("span", { class: "muted" }, "–")); }),
      h("td", { class: "ach-cell" }, achSpark(vals, 3)), achTrendCell(achTrendOf(vals)));
  });
  return h("div", { class: "ach-box" },
    h("div", { class: "ach-box-head" }, "📈 반복 관찰 지표 ",
      h("span", { class: "muted", style: "font-weight:400;font-size:0.82rem" }, "(회차마다 같은 잣대 · 숫자는 자동 집계, 🤖는 AI 판단)")),
    h("div", { class: "table-wrap" }, h("table", { class: "att ach-progress ach-tracking" },
      h("thead", {}, h("tr", {}, h("th", {}, "지표"), t.map((x) => h("th", { title: x.title }, achMD(x.date))), h("th", {}, "변화"), h("th", {}, "추세"))),
      h("tbody", {}, numRows, aiRows))),
    h("p", { class: "muted", style: "margin:6px 0 0;font-size:0.8rem" },
      "발문 응답은 선생님 질문 뒤 20초 안에 한 대답이에요. 선생님 말은 수업 중 [발언 기록]과 선생님 마이크 음성 인식이 켜져 있을 때만 저장돼서, 꺼져 있으면 모두 '자발'로 세요."));
}

/* 학생 피드백 항목: 선생님의 피드백 · 달라진 점(이전→현재) · 잘한 점 · 다음 수업에서 해 보기 · 생각을 돕는 문장 */
const FB_SECTIONS = [
  ["strengths", "👍 잘한 점", "예: 반대 의견의 근거를 짚어 냈어요"],
  ["next_actions", "🎯 다음 수업에서 해 보기", "예: 발표할 때 이유를 두 가지 들어 말하기"],
  ["sentence_starters", "💡 생각을 돕는 문장", "예: 제 생각은 ~입니다. 왜냐하면 ~"]];

/** 교사용 항목별 피드백 편집기: { el, read() } */
function feedbackEditor(parts) {
  const msg = h("textarea", { rows: 5, maxlength: 2000, placeholder: "학생에게 보여 줄 피드백" });
  msg.value = parts.message || "";
  const changeRows = h("div", { class: "fb-list" });
  const addChange = (c = {}) => {
    const before = h("input", { maxlength: 200, value: c.before || "", placeholder: "이전 모습", "aria-label": "이전" });
    const after = h("input", { maxlength: 200, value: c.after || "", placeholder: "지금 모습", "aria-label": "현재" });
    const row = h("div", { class: "fb-change-edit" }, before, h("span", { class: "fb-arrow" }, "→"), after,
      h("button", { class: "small danger", type: "button", "aria-label": "삭제", onclick: () => row.remove() }, "✕"));
    changeRows.append(row);
  };
  (parts.changes || []).forEach(addChange);
  const lists = {};
  const listBox = (key, placeholder) => {
    const box = h("div", { class: "fb-list" });
    const add = (text = "") => {
      const input = h("input", { maxlength: 300, value: text, placeholder });
      const row = h("div", { class: "fb-item-edit" }, input, h("button", { class: "small danger", type: "button", "aria-label": "삭제", onclick: () => row.remove() }, "✕"));
      box.append(row);
    };
    (parts[key] || []).forEach(add);
    if (!(parts[key] || []).length) add();
    lists[key] = box;
    return [box, h("button", { class: "small", type: "button", onclick: () => add() }, "+ 추가")];
  };
  if (!(parts.changes || []).length) addChange();
  const el = h("div", { class: "fb-editor" },
    h("div", { class: "fb-sec" }, h("div", { class: "fb-sec-head" }, "💬 선생님의 피드백"), msg),
    h("div", { class: "fb-sec" }, h("div", { class: "fb-sec-head" }, "📈 이전에 비해 달라진 점 ", h("span", { class: "muted" }, "(이전 → 현재)")),
      changeRows, h("button", { class: "small", type: "button", onclick: () => addChange() }, "+ 추가")),
    FB_SECTIONS.map(([key, title, ph]) => h("div", { class: "fb-sec" }, h("div", { class: "fb-sec-head" }, title), listBox(key, ph))));
  const read = () => ({
    message: msg.value.trim(),
    changes: [...changeRows.children].map((r) => { const [b, a] = r.querySelectorAll("input"); return { before: b.value.trim(), after: a.value.trim() }; })
      .filter((c) => c.before || c.after),
    ...Object.fromEntries(FB_SECTIONS.map(([key]) => [key, [...lists[key].querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean)])),
  });
  return { el, read };
}

/** 학생 화면: 회차별 발언 참여 막대 (자발 발언 + 발문 응답 쌓기) */
function participationChart(list) {
  const W = 640, H = 210, L = 34, R = 12, T = 14, B = 42, n = list.length;
  const max = Math.max(1, ...list.map((x) => x.spontaneous + x.response));
  const step = (W - L - R) / n, bw = Math.min(46, step * 0.6);
  const Y = (v) => T + (H - T - B) * (1 - v / max);
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ach-chart", role: "img", "aria-label": "회차별 발언 참여 그래프" });
  const ticks = [...new Set([0, Math.round(max / 2), max])];
  for (const v of ticks) {
    svg.append(el("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: "#e3e6e8" }));
    svg.append(el("text", { x: L - 8, y: Y(v) + 4, "text-anchor": "end", "font-size": 12, fill: "#59636b" }, String(v)));
  }
  list.forEach((x, i) => {
    const cx = L + step * i + step / 2, total = x.spontaneous + x.response;
    if (x.response) svg.append(el("rect", { x: cx - bw / 2, y: Y(x.response), width: bw, height: Y(0) - Y(x.response), fill: "#9cbbe0", rx: 3 }));
    if (x.spontaneous) svg.append(el("rect", { x: cx - bw / 2, y: Y(total), width: bw, height: Y(x.response) - Y(total), fill: "#1b6b4a", rx: 3 }));
    svg.append(el("text", { x: cx, y: Y(total) - 5, "text-anchor": "middle", "font-size": 12, "font-weight": 700, fill: "#1d2330" }, String(total)));
    svg.append(el("text", { x: cx, y: H - B + 18, "text-anchor": "middle", "font-size": 12, fill: "#59636b" }, achMD(x.date)));
  });
  return h("div", {}, svg, h("div", { class: "part-legend" },
    h("span", {}, h("i", { style: "background:#1b6b4a" }), "스스로 한 발언"), h("span", {}, h("i", { style: "background:#9cbbe0" }), "선생님 질문에 대한 대답")));
}

/** 학생 화면: 항목별 피드백 카드 */
function feedbackView(p, participation = []) {
  const sec = (title, body) => h("div", { class: "fb-card" }, h("div", { class: "fb-card-head" }, title), body);
  return [
    p.message ? sec("💬 선생님의 피드백", h("p", { class: "fb-message" }, p.message)) : null,
    p.changes?.length ? sec("📈 이전에 비해 달라진 점", p.changes.map((c) => h("div", { class: "fb-change" },
      h("span", { class: "fb-before" }, h("small", {}, "이전"), c.before || "-"), h("span", { class: "fb-arrow" }, "→"),
      h("span", { class: "fb-after" }, h("small", {}, "현재"), c.after || "-")))) : null,
    participation.length ? sec("🗣️ 나의 발언 참여 변화", participationChart(participation)) : null,
    p.strengths?.length ? sec("👍 잘한 점", h("ul", { class: "fb-ul" }, p.strengths.map((x) => h("li", {}, x)))) : null,
    p.next_actions?.length ? sec("🎯 다음 수업에서 해 보기", h("ul", { class: "fb-ul fb-goals" }, p.next_actions.map((x) => h("li", {}, x)))) : null,
    p.sentence_starters?.length ? sec("💡 생각을 돕는 문장", p.sentence_starters.map((x) => h("div", { class: "fb-starter" }, `“${x}”`))) : null,
  ];
}

/* ───────── 교사: 학생 한 명의 AI 성취 분석 ───────── */

async function renderAnalysis(courseId, who, box, opts = {}) { // opts.obs === false: 관찰 기록은 [교사 관찰 기록] 탭에서
  let v, obs = [];
  try {
    [v, { observations: obs }] = await Promise.all([
      achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/analysis`),
      achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/observations`).catch(() => ({ observations: [] }))]);
  } catch (err) { achFill(box, h("p", { class: "error" }, err.message)); return; }
  const again = () => renderAnalysis(courseId, who, box, opts);
  const run = h("button", { class: "primary small", type: "button", disabled: !v.ai, title: v.ai ? "" : "AI가 설정되지 않았어요" },
    v.analyzed_at ? "🤖 다시 분석하기" : "🤖 AI 분석하기");
  run.onclick = async () => {
    run.disabled = true; run.textContent = "🤖 분석 중… (30초쯤 걸려요)";
    try { await achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/analyze`, {}); toast("AI 분석을 마쳤어요."); again(); }
    catch (err) { toast(err.message, 6000); run.disabled = false; run.textContent = "🤖 AI 분석하기"; }
  };
  // [수정]: 교사가 역량 점수·판단 근거를 고치면 차트도 그 점수로 다시 그려진다
  let editing = false;
  const editBtn = h("button", { class: "small", type: "button" }, "✏️ 수정");
  const charts = h("div");
  const drawCharts = () => achFill(charts, h("div", { class: "ach-two" },
    h("div", { class: "ach-box" }, coreHead(),
      v.competencies?.length ? compPanel(v.competencies, "#1b6b4a", "rgba(27,107,74,0.22)", "핵심역량 밸런스 차트")
        : h("p", { class: "muted" }, "[다시 분석하기]를 누르면 핵심역량 6가지 차트가 생겨요.")),
    // 오른쪽: 이 과목의 교과 역량 밸런스 차트 (2022 개정 교육과정 교과 역량으로 자동)
    h("div", { class: "ach-box" }, subjectHead(),
      v.subject_competencies?.length ? compPanel(v.subject_competencies, "#2f6fb3", "rgba(47,111,179,0.20)", "교과 역량 밸런스 차트")
        : h("p", { class: "muted" }, v.subject_competency_names?.length
          ? "[다시 분석하기]를 누르면 교과 역량 차트가 생겨요."
          : "이 과목의 교과는 2022 개정 교육과정 교과 역량 표에 없어 교과 역량 차트를 그리지 않아요."))),
    editing ? h("div", { class: "row", style: "justify-content:flex-end;margin:-4px 0 10px;gap:6px" },
      h("span", { class: "muted grow", style: "font-size:0.82rem" }, "점수를 바꾸면 차트가 바로 바뀌어요. [다시 분석하기]를 하면 AI 판단으로 다시 바뀌어요."),
      h("button", { class: "small", type: "button", onclick: () => { editing = false; again(); } }, "취소"),
      h("button", { class: "primary small", type: "button", onclick: async (e) => {
        e.target.disabled = true;
        const pick = (list) => (list || []).map((c) => ({ key: c.key, score: c.score, reason: c.reason || "" }));
        try {
          await achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/competencies`,
            { competencies: pick(v.competencies), subject_competencies: pick(v.subject_competencies) });
          toast("역량 점수와 판단 근거를 저장했어요."); editing = false; again();
        } catch (err) { toast(err.message, 5000); e.target.disabled = false; }
      } }, "저장")) : null);
  // 차트 제목 + 오른쪽 [📖 …이란?] 버튼: 누르면 역량의 뜻을 팝업으로 (차트를 밀어내지 않는다)
  const infoHead = (title, items, label, popTitle) => {
    if (!items.some((c) => c.desc)) return h("div", { class: "ach-box-head" }, title);
    const panel = h("div", { class: "ach-comp-info", hidden: true },
      items.map((c) => h("div", { class: "ach-comp-info-item" }, h("strong", {}, c.label),
        c.desc ? h("p", {}, c.detail ? [h("b", {}, c.desc, "."), " ", c.detail] : c.desc) : null)));
    const btn = h("button", { class: "small", type: "button", "aria-expanded": "false" }, label);
    // 바깥을 누르거나 Esc 를 누르면 닫힌다
    const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("click", outside, true); document.removeEventListener("keydown", esc); };
    const outside = (e) => { if (!panel.contains(e.target) && e.target !== btn) close(); };
    const esc = (e) => { if (e.key === "Escape") close(); };
    btn.onclick = () => {
      if (!panel.hidden) { close(); return; }
      panel.hidden = false; btn.setAttribute("aria-expanded", "true");
      document.addEventListener("click", outside, true); document.addEventListener("keydown", esc);
    };
    panel.prepend(h("div", { class: "row", style: "align-items:center;margin-bottom:2px" }, h("strong", { class: "grow" }, popTitle),
      h("button", { class: "small", type: "button", "aria-label": "닫기", onclick: close }, "✕")));
    // 머리글과 팝업을 한 칸으로 묶어 두 차트 상자의 줄 맞춤(subgrid)을 지킨다
    return h("div", { class: "ach-comp-head" }, h("div", { class: "ach-box-head row", style: "align-items:center" }, h("span", { class: "grow" }, title), btn), panel);
  };
  const coreHead = () => infoHead("🧭 핵심역량 밸런스 차트", v.competencies || [], "📖 핵심역량이란?", "📖 2022 개정 교육과정 핵심역량");
  const subjectHead = () => infoHead("🧩 교과 역량 밸런스 차트", v.subject_competency_info || [], "📖 교과 역량이란?",
    `📖 ${v.subject_competency_area || ""} 교과 역량 (2022 개정 교육과정)`);
  // 차트 + 역량별 판단 근거 (수정 중이면 점수 1~5·근거를 고칠 수 있다)
  const compPanel = (comps, color, fillColor, aria) => {
    const chart = h("div", {}, achRadar(comps, color, fillColor, aria));
    const redraw = () => achFill(chart, achRadar(comps, color, fillColor, aria));
    if (!editing) return [chart, achRadarReasons(comps)];
    return [chart, achRadarReasons(comps, (c) => {
      const score = h("select", { "aria-label": `${c.label} 점수` }, [1, 2, 3, 4, 5].map((n) => h("option", { value: n, selected: n === c.score }, `${n}점`)));
      score.onchange = () => { c.score = Number(score.value); redraw(); };
      const reason = h("textarea", { rows: 2, maxlength: 300, "aria-label": `${c.label} 판단 근거` });
      reason.value = c.reason || "";
      reason.oninput = () => { c.reason = reason.value; };
      return [score, reason];
    })];
  };
  editBtn.onclick = () => { editing = true; editBtn.disabled = true; drawCharts(); };
  const fb = feedbackEditor(v.feedback_parts || { message: v.feedback || "" });
  const saveFb = h("button", { class: "small", type: "button" }, "피드백 저장");
  const publishFb = h("button", { class: v.published ? "small" : "primary small", type: "button" }, v.published ? "공개 취소" : "학생에게 공개");
  const saveFeedback = async (published, message) => {
    saveFb.disabled = publishFb.disabled = true;
    try {
      await achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/feedback`, { parts: fb.read(), published });
      toast(message, 4000);
      again();
    } catch (err) { toast(err.message); saveFb.disabled = publishFb.disabled = false; }
  };
  saveFb.onclick = () => saveFeedback(v.published, v.published ? "피드백을 저장했어요. 학생에게 공개 중이에요." : "피드백을 저장했어요. 공개하기 전에는 학생에게 보이지 않아요.");
  publishFb.onclick = () => saveFeedback(!v.published, v.published ? "공개를 취소했어요. 이제 학생에게 보이지 않아요." : "학생의 [내 강좌 > 활동 피드백]에 공개했어요.");
  const when = v.analyzed_at ? new Date(v.analyzed_at * 1000).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }) : "";
  const fbBox = h("div", { class: "ach-box" },
    h("div", { class: "ach-box-head" }, "💌 학생에게 줄 종합 피드백 ", h("span", { class: "muted", style: "font-weight:400" }, "(AI 초안을 항목별로 고쳐서 쓰세요 · 학생 화면에도 이 순서로 보여요)")),
    fb.el,
    h("div", { class: "row", style: "margin-top:8px;justify-content:flex-end" }, saveFb, publishFb),
    v.published ? h("p", { class: "ok-text", style: "margin:6px 0 0;font-size:0.85rem" }, "✅ 지금 학생에게 공개 중이에요.") : null);
  if (opts.only === "feedback") { // [💌 피드백 전송] 탭: 종합 피드백만 (초안은 [🎯 성취 분석]의 AI 분석에서 만들어진다)
    achFill(box, v.analyzed_at ? null : h("p", { class: "muted", style: "margin:0 0 8px" }, "종합 피드백 초안은 [🎯 역량 분석]에서 [AI 분석하기]를 누르면 만들어져요. 직접 써도 돼요."), fbBox);
    return;
  }
  achFill(box,
    h("div", { class: "row", style: "margin:4px 0 8px" },
      h("h4", { class: "grow", style: "margin:0" }, "🤖 AI 역량 분석", when ? h("span", { class: "muted", style: "font-weight:400;font-size:0.82rem" }, ` · ${when} 분석`) : null), run,
      v.analyzed_at && (v.competencies?.length || v.subject_competencies?.length) ? editBtn : null),
    opts.obs === false ? null : h("details", { class: "ach-box", open: obs.length > 0 && !v.analyzed_at },
      h("summary", { class: "ach-box-head" }, `👀 교사 관찰 기록 ${obs.length}건 `, h("span", { class: "muted", style: "font-weight:400" }, "(수업 중 [관찰기록] 탭에서 적은 것 · AI 분석에 함께 써요)")),
      obs.length ? obs.map((o) => h("div", { class: "speech-line student" }, h("span", { class: "sp-time" }, `${fmtDate(o.date).slice(5)} ${o.time}`),
        h("span", { class: "sp-text" }, o.text, h("span", { class: "muted" }, ` · ${o.class_title}`))))
        : h("p", { class: "muted", style: "margin:4px 0" }, "아직 이 학생에 대한 관찰 기록이 없어요.")),
    v.analyzed_at ? null : h("p", { class: "muted" }, v.ai ? "[AI 분석하기]를 누르면 이 학생의 발언(발문 응답·자발 구분)·교사 관찰 기록·퀴즈 답안을 성취기준의 상·중·하 수행 진술에 비추어 수업마다 판단해 도달 상태와 반복 관찰 지표의 변화를 추적하고, 성취기준별 다음 단계와 피드백 초안을 만들어요. (이름·학번은 가리고 보내요)" : "AI가 설정되지 않아 분석할 수 없어요."),
    // 순서: 역량 밸런스 차트 → 성취기준별 도달 상태 → 수업별 판단 근거 → 반복 관찰 지표 → AI 종합 의견 → 학생에게 줄 피드백
    v.analyzed_at ? [
      (drawCharts(), charts),
      achProgressTable(v),
      // 수업별 판단 근거 (성취기준 평가 요소의 상·중·하)
      h("div", { class: "ach-box" }, h("div", { class: "ach-box-head" }, "🔎 수업별 판단 근거 (성취기준·평가 요소)"),
        // 판단 근거가 되는 기록이 없는 회차는 아예 보여 주지 않는다
        v.classes.some((x) => x.ratings.length || x.standards?.length) ? v.classes.filter((x) => x.ratings.length || x.standards?.length).map((x) => h("div", { class: "ach-class" },
          h("div", { class: "speech-day-head" }, `${fmtDate(x.date)} · ${x.title || "(주제 없음)"}`),
          (x.standards || []).map((r) => h("div", { class: "ach-rate" },
            h("span", { class: `ach-lv lv${r.level}` }, ACH_LEVEL[r.level]), h("strong", {}, `${r.code} 성취기준`),
            h("span", { class: "muted" }, ` “${r.evidence}”`))),
          x.ratings.map((r) => h("div", { class: "ach-rate" },
            h("span", { class: `ach-lv lv${r.level}` }, ACH_LEVEL[r.level]), h("strong", {}, `${r.code} ${r.element}`),
            h("span", { class: "muted" }, ` “${r.evidence}”`)))))
          : h("p", { class: "muted", style: "margin:4px 0" }, "판단 근거가 되는 수업 기록이 아직 없어요.")),
      h("div", { class: "ach-box" }, h("div", { class: "ach-box-head" }, "📝 AI 종합 의견"),
        h("p", { style: "white-space:pre-wrap;margin:0;line-height:1.6" }, v.summary || "-")),
    ] : null,
    opts.feedback === false ? null : fbBox);
}

/* ───────── 교사 [학습 관리 > 📝 수업별 피드백]: 수업 1회마다 학생별 형성평가 피드백 ───────── */
const classFbView = new Map(); // 과목별로 보고 있는 수업

async function renderClassFeedback(c, box) {
  const viewing = classFbView.get(c.id);
  if (viewing) return renderClassFeedbackDetail(c, viewing, box);
  achFill(box, h("p", { class: "muted" }, "수업 목록을 불러오는 중…"));
  let d;
  try { d = await achApi(`/api/courses/${c.id}/class-feedback`); } catch (err) { achFill(box, h("p", { class: "error" }, err.message)); return; }
  const open = (k) => { classFbView.set(c.id, k); renderClassFeedback(c, box); };
  achFill(box,
    h("p", { class: "muted", style: "margin:0 0 10px;font-size:0.88rem" },
      "수업이 끝나면 그 수업에 연결된 성취기준([회차 정보])만 보고 학생마다 피드백을 만들어요. AI 초안을 고쳐서 공개하면 학생의 [활동 피드백]에 수업별로 쌓여요."),
    d.classes.length ? h("div", { class: "table-wrap" }, h("table", { class: "att assign-board" },
      h("thead", {}, h("tr", {}, ["연번", "수업일", "수업 주제", "만든 피드백", "공개", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, [...d.classes].reverse().map((k) => h("tr", {},
        h("td", {}, String(k.no)), h("td", {}, fmtDate(k.date)), h("td", { style: "white-space:normal" }, k.title || "(주제 없음)"),
        h("td", {}, `${k.made}명`), h("td", {}, k.published ? h("strong", { class: "ok-text" }, `${k.published}명`) : "0명"),
        h("td", {}, h("button", { class: "small primary", type: "button", onclick: () => open(k) }, "열기")))))))
      : h("p", { class: "muted" }, "아직 연 수업이 없어요."));
}

async function renderClassFeedbackDetail(c, k, box) {
  const again = () => renderClassFeedbackDetail(c, k, box);
  achFill(box, h("p", { class: "muted" }, "불러오는 중…"));
  let d;
  try { d = await achApi(`/api/courses/${c.id}/class-feedback/${k.class_id}`); } catch (err) { achFill(box, h("p", { class: "error" }, err.message)); return; }
  const withRec = d.students.filter((s) => s.has_record);
  const made = d.students.filter((s) => s.parts);
  const gen = h("button", { class: "primary small", type: "button", disabled: !d.ai || !withRec.length, title: d.ai ? "" : "AI가 설정되지 않았어요" },
    `🤖 AI 초안 만들기 (기록 있는 학생 ${withRec.length}명)`);
  gen.onclick = async () => {
    gen.disabled = true; gen.textContent = "🤖 만드는 중… (학생 수에 따라 1~2분)";
    try {
      const r = await achApi(`/api/courses/${c.id}/class-feedback/${k.class_id}/generate`, {});
      toast(`초안 ${r.made}명 만들었어요.${r.skipped ? ` (기록 없음·공개 중 ${r.skipped}명은 건너뜀)` : ""}${r.errors.length ? ` 일부 오류: ${r.errors[0]}` : ""}`, 6000);
      again();
    } catch (err) { toast(err.message, 6000); gen.disabled = false; gen.textContent = "🤖 AI 초안 만들기"; }
  };
  const allPub = made.length && made.every((s) => s.published);
  const pubAll = h("button", { class: "small", type: "button", disabled: !made.length }, allPub ? "모두 공개 취소" : "만든 피드백 모두 공개");
  pubAll.onclick = async () => {
    if (!allPub && !confirm(`만든 피드백 ${made.length}명을 모두 학생에게 공개할까요?`)) return;
    try { await achApi(`/api/courses/${c.id}/class-feedback/${k.class_id}/publish-all`, { published: !allPub }); toast(allPub ? "공개를 취소했어요." : "학생들에게 공개했어요."); again(); }
    catch (err) { toast(err.message); }
  };
  achFill(box,
    h("div", { class: "row", style: "margin:0 0 8px" }, h("button", { class: "small", type: "button", onclick: () => { classFbView.delete(c.id); renderClassFeedback(c, box); } }, "← 수업 목록")),
    h("div", { class: "hub-grid-summary" }, `${fmtDate(k.date)} · ${k.title || "(주제 없음)"}`),
    h("div", { class: "ach-box", style: "margin-top:8px" }, h("div", { class: "ach-box-head" }, "🎯 이 수업에서 다룬 성취기준"),
      d.linked.length ? d.linked.map((x) => h("div", { class: "ach-rate" }, h("strong", {}, x.code), " ", h("span", { class: "muted" }, x.text)))
        : h("p", { class: "muted", style: "margin:0" }, "[회차 정보]에서 이 수업의 성취기준을 고르지 않아 모든 성취기준을 후보로 봐요. 고르면 그 성취기준만 피드백해요.")),
    h("div", { class: "row", style: "margin:8px 0;gap:6px;justify-content:flex-end" }, pubAll, gen),
    d.students.map((s) => classFbStudent(c, k, s, again)));
}

function classFbStudent(c, k, s, again) {
  const who = [s.student_no, s.name].filter(Boolean).join(" ");
  const counts = s.counts ? `발언 ${s.counts.talk} (자발 ${s.counts.spontaneous} · 응답 ${s.counts.response})` : "이 수업 기록 없음";
  const badge = s.published ? h("span", { class: "fb-badge pub" }, "공개 중") : s.parts ? h("span", { class: "fb-badge" }, "초안") : null;
  if (!s.parts) return h("div", { class: "cfb-row muted" }, h("strong", {}, who), ` · ${counts}`);
  const ed = feedbackEditor(s.parts);
  const lvSel = s.levels.map((x) => {
    const sel = h("select", { "aria-label": `${x.code} 수준` }, [[0, "– (근거 없음)"], [3, "상"], [2, "중"], [1, "하"]].map(([v, t]) => h("option", { value: v, selected: v === x.level }, t)));
    return { x, sel };
  });
  const save = async (published) => {
    try {
      await achApi(`/api/courses/${c.id}/class-feedback/${k.class_id}/student/${s.user_id}`,
        { parts: ed.read(), levels: lvSel.map(({ x, sel }) => ({ standard_id: x.standard_id, level: Number(sel.value) })), published });
      toast(published ? "학생에게 공개했어요." : s.published ? "공개를 취소했어요." : "저장했어요.");
      again();
    } catch (err) { toast(err.message); }
  };
  return h("details", { class: "cfb-row" },
    h("summary", {}, h("strong", {}, who), h("span", { class: "muted" }, ` · ${counts} `), badge),
    h("div", { class: "cfb-body" },
      lvSel.length ? h("div", { class: "cfb-levels" }, lvSel.map(({ x, sel }) => h("div", { class: "ach-rate" },
        sel, " ", h("strong", {}, x.code), " ", h("span", { class: "muted" }, x.evidence ? `“${x.evidence}”` : x.text)))) : null,
      ed.el,
      h("div", { class: "row", style: "margin-top:8px;gap:6px;justify-content:flex-end" },
        h("button", { class: "small", type: "button", onclick: () => save(s.published) }, "저장"),
        h("button", { class: s.published ? "small" : "primary small", type: "button", onclick: () => save(!s.published) }, s.published ? "공개 취소" : "학생에게 공개"))));
}

/* ───────── 교사 [🏅 특기사항]: 모든 수행평가 채점 뒤 성취도 확정·세특·학생 개별 성취도 평가서 ───────── */
const resultsView = new Map(); // 과목별로 열어 본 학생

const neisBytes = (t) => [...(t || "")].reduce((n, ch) => n + (ch === "\n" ? 2 : ch.charCodeAt(0) < 128 ? 1 : 3), 0);
const rsNum = (v) => (v === null || v === undefined ? "-" : String(Math.round(v * 100) / 100));

async function renderResults(c, box) {
  const uid = resultsView.get(c.id);
  if (uid) return renderResultSheet(c, uid, box);
  achFill(box, h("p", { class: "muted" }, "불러오는 중…"));
  let v;
  try { v = await achApi(`/api/courses/${c.id}/results`); } catch (err) { achFill(box, h("p", { class: "error" }, err.message)); return; }
  const again = () => renderResults(c, box);
  const draftAll = h("button", { class: "primary small", type: "button", disabled: !v.ready || !v.ai, title: v.ai ? "" : "AI가 설정되지 않았어요" },
    "🤖 세특 초안 모두 만들기 (빈 학생만)");
  draftAll.onclick = async () => {
    draftAll.disabled = true; draftAll.textContent = "🤖 만드는 중… (학생 수에 따라 1~3분)";
    try { const r = await achApi(`/api/courses/${c.id}/results/draft-all`, {}); toast(`세특 초안 ${r.made}명 만들었어요.${r.skipped ? ` (이미 쓴 ${r.skipped}명은 그대로)` : ""}`, 5000); again(); }
    catch (err) { toast(err.message, 6000); draftAll.disabled = false; }
  };
  const gradeSel = (s) => {
    const sel = h("select", { disabled: !v.ready, "aria-label": `${s.name} 성취도` }, h("option", { value: "" }, "미정"),
      v.grades.map((g) => h("option", { value: g, selected: s.achievement === g }, g)));
    sel.onchange = async () => {
      try { await achApi(`/api/courses/${c.id}/results/${s.user_id}`, { achievement: sel.value, setuk: s.setuk }); s.achievement = sel.value; toast("성취도를 저장했어요."); }
      catch (err) { toast(err.message); sel.value = s.achievement; }
    };
    return sel;
  };
  achFill(box,
    h("div", { class: "row", style: "margin:4px 0 6px;gap:6px" }, h("span", { class: "grow" }),
      h("a", { class: "button small", href: `/api/courses/${c.id}/results.xlsx` }, "📥 엑셀 (나이스 입력용)"), draftAll),
    v.ready ? null : h("div", { class: "warn-box" }, `⏳ 아직 채점하지 않은 수행평가가 있어요 (채점 ${v.graded}/${v.total}). [📝 수행평가]에서 채점을 모두 마치면 작성할 수 있어요.`),
    v.weight_ok || !v.assignments.length ? null : h("div", { class: "warn-box" }, "⚠️ 수행평가 반영 비율 합계가 100%가 아니라 환산 점수를 계산할 수 없어요. [📝 수행평가]에서 반영 비율을 확인해 주세요."),
    v.students.length ? h("div", { class: "table-wrap" }, h("table", { class: "att ach-progress results-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "연번"), h("th", {}, "학번"), h("th", {}, "이름"),
        v.assignments.map((a) => h("th", { title: `만점 ${rsNum(a.max_score)}점 · 반영 ${rsNum(a.weight)}%` }, a.title)),
        h("th", {}, "환산 점수"), h("th", {}, "성취도"), h("th", {}, "세특"), h("th", {}, ""))),
      h("tbody", {}, v.students.map((s, i) => h("tr", {},
        h("td", { class: "ach-cell" }, String(i + 1)), h("td", { class: "ach-cell" }, s.student_no), h("td", {}, s.name),
        s.scores.map((x) => h("td", { class: "ach-cell" }, x === null || x === undefined ? "-" : `${rsNum(x)}점`)),
        h("td", { class: "ach-cell" }, h("strong", {}, s.rate === null || s.rate === undefined ? "-" : `${rsNum(s.rate)}점`)),
        h("td", { class: "ach-cell" }, gradeSel(s)),
        h("td", { class: "ach-cell" }, s.setuk ? h("span", { class: s.bytes > v.max_bytes ? "error" : "ok-text" }, `${s.bytes}B`) : h("span", { class: "muted" }, "미작성")),
        h("td", { class: "ach-cell" }, h("button", { class: "small primary", type: "button", onclick: () => { resultsView.set(c.id, s.user_id); renderResults(c, box); } }, "개인 평가서"))))))) 
      : h("p", { class: "muted" }, "수강생이 없어요."));
}

async function renderResultSheet(c, uid, box) {
  const back = () => { resultsView.delete(c.id); renderResults(c, box); };
  achFill(box, h("p", { class: "muted" }, "평가서를 불러오는 중…"));
  let v, list;
  try { [v, list] = await Promise.all([achApi(`/api/courses/${c.id}/results/${uid}/sheet`), achApi(`/api/courses/${c.id}/results`)]); }
  catch (err) { achFill(box, h("p", { class: "error" }, err.message)); return; }
  const ready = list.ready;
  const grade = h("select", { disabled: !ready }, h("option", { value: "" }, "미정"), list.grades.map((g) => h("option", { value: g, selected: v.achievement === g }, g)));
  const setuk = h("textarea", { rows: 8, maxlength: 3000, disabled: !ready, placeholder: "과목별 세부능력 및 특기사항 (나이스 1500바이트, 한글 약 500자)" });
  setuk.value = v.setuk || "";
  const counter = h("span", { class: "muted" });
  const count = () => { const n = neisBytes(setuk.value.trim()); counter.textContent = `${[...setuk.value.trim()].length}자 · ${n} / ${list.max_bytes}바이트`; counter.className = n > list.max_bytes ? "error" : "muted"; };
  setuk.oninput = count; count();
  const save = h("button", { class: "primary small", type: "button", disabled: !ready }, "저장");
  save.onclick = async () => {
    try { await achApi(`/api/courses/${c.id}/results/${uid}`, { achievement: grade.value, setuk: setuk.value }); toast("저장했어요."); renderResultSheet(c, uid, box); }
    catch (err) { toast(err.message, 5000); }
  };
  const draft = h("button", { class: "small", type: "button", disabled: !ready || !list.ai, title: list.ai ? "" : "AI가 설정되지 않았어요" }, "🤖 AI 초안 (세특·성장 요약)");
  draft.onclick = async () => {
    if (setuk.value.trim() && !confirm("지금 쓴 세특을 AI 초안으로 바꿀까요?")) return;
    draft.disabled = true; draft.textContent = "🤖 만드는 중…";
    try { await achApi(`/api/courses/${c.id}/results/${uid}/draft`, {}); toast("AI 초안이에요. 사실과 다른 곳이 없는지 꼭 확인하고 고쳐 주세요.", 5000); renderResultSheet(c, uid, box); }
    catch (err) { toast(err.message, 6000); draft.disabled = false; draft.textContent = "🤖 AI 초안 (세특·성장 요약)"; }
  };
  const print = () => { document.body.classList.add("print-sheet-only"); window.print(); setTimeout(() => document.body.classList.remove("print-sheet-only"), 500); };
  achFill(box,
    h("div", { class: "row", style: "margin:0 0 10px;gap:6px" }, h("button", { class: "small", type: "button", onclick: back }, "← 학생 목록"),
      h("span", { class: "grow" }), h("button", { class: "small", type: "button", onclick: print }, "🖨 평가서 인쇄·PDF")),
    ready ? null : h("div", { class: "warn-box" }, `⏳ 아직 채점하지 않은 수행평가가 있어 성취도·세특은 채점을 모두 마친 뒤 작성할 수 있어요 (채점 ${list.graded}/${list.total}).`),
    resultSheet(v),
    h("div", { class: "ach-box", style: "margin-top:12px" },
      h("div", { class: "row", style: "align-items:center;margin-bottom:8px" }, h("div", { class: "ach-box-head grow", style: "margin:0" }, "✍️ 성취도·세특 작성 (선생님)"), draft),
      h("label", { class: "row", style: "gap:8px;align-items:center;margin-bottom:8px" }, h("strong", {}, "성취도 확정"), grade,
        h("span", { class: "muted", style: "font-size:0.85rem" }, `제안: ${v.suggested || "-"} (환산 ${rsNum(v.rate)}점)`)),
      h("div", { class: "row", style: "margin-top:10px" }, h("div", { class: "fb-sec-head grow", style: "margin:0" }, "📝 과목별 세부능력 및 특기사항"), counter), setuk,
      h("p", { class: "muted", style: "margin:4px 0 0;font-size:0.8rem" }, "학생 이름·교외 수상·사교육·부모 정보·특정 대학이나 기관명 등 기재 금지 사항이 없는지 확인해 주세요."),
      h("div", { class: "row", style: "margin-top:8px;justify-content:flex-end" }, save)));
}

/** 학생 개별 성취도 평가서 (인쇄용) */
function resultSheet(v) {
  const L = ACH_LEVEL;
  let n = 0;
  const no = () => ++n; // 보이는 항목만 차례로 번호 (역량·발언 참여가 없으면 건너뜀)
  const info = [["학년도·학기", [v.course.school_year, v.course.term].filter(Boolean).join(" ")], ["과목", v.course.course_title], ["거점학교", v.course.hub_school],
    ["담당 교사", v.course.instructor], ["소속학교", v.student.school], ["학번", v.student.student_no], ["이름", v.student.name]];
  return h("div", { class: "print-sheet result-sheet" },
    h("h2", { class: "rs-title" }, "학생 개별 성취도 평가서"),
    h("table", { class: "rs-info" }, h("tbody", {}, h("tr", {}, info.slice(0, 4).flatMap(([k, x]) => [h("th", {}, k), h("td", {}, x || "-")])),
      h("tr", {}, info.slice(4).flatMap(([k, x]) => [h("th", {}, k), h("td", {}, x || "-")]), h("th", {}, "성취도"), h("td", {}, h("strong", {}, v.achievement || "미정"))))),
    h("h3", { class: "rs-head" }, `${no()}. 수행평가 결과`),
    h("table", { class: "rs-table" },
      h("thead", {}, h("tr", {}, ["평가 영역", "영역 만점", "반영 비율", "점수", "환산 점수"].map((t) => h("th", {}, t)))),
      h("tbody", {}, v.items.map((i) => h("tr", {}, h("td", { class: "left" }, i.title), h("td", {}, rsNum(i.max_score)), h("td", {}, `${rsNum(i.weight)}%`),
        h("td", {}, rsNum(i.score)), h("td", {}, rsNum(i.weighted)))),
        h("tr", { class: "rs-sum" }, h("td", {}, "합계"), h("td", {}, v.totals.max_score ?? "-"), h("td", {}, v.totals.weight ? `${v.totals.weight}%` : "-"),
          h("td", {}, v.totals.score ?? "-"), h("td", {}, h("strong", {}, v.rate ?? v.totals.weighted ?? "-"))))),
    h("p", { class: "rs-note" }, `성취도 체계: ${v.scale} · 성취도: ${v.achievement || "미정"}${v.rate !== null && v.rate !== undefined ? ` (환산 ${v.rate}점)` : ""}`),
    v.competencies.length || v.subject_competencies.length ? [h("h3", { class: "rs-head" }, `${no()}. 역량`),
      h("div", { class: "ach-two rs-two" },
        v.competencies.length ? h("div", {}, h("div", { class: "rs-sub-head" }, "핵심역량"), achRadar(v.competencies)) : h("div"),
        v.subject_competencies.length ? h("div", {}, h("div", { class: "rs-sub-head" }, "교과 역량"), achRadar(v.subject_competencies, "#2f6fb3", "rgba(47,111,179,0.20)", "교과 역량")) : h("div"))] : null,
    h("h3", { class: "rs-head" }, `${no()}. 성취기준별 도달`),
    v.standards.length ? h("table", { class: "rs-table" },
      h("thead", {}, h("tr", {}, ["성취기준", "수행평가", "수업 관찰", "학생 발언"].map((t) => h("th", {}, t)))),
      h("tbody", {}, v.standards.map((s) => h("tr", {}, h("td", { class: "left" }, h("strong", {}, s.code), " ", s.text),
        h("td", {}, s.level ? [h("span", { class: `ach-lv lv${s.level}` }, L[s.level]), ` ${s.rate}%`, h("div", { class: "rs-sub" }, s.assessments.join(", "))] : "-"),
        h("td", {}, s.observed ? [h("span", { class: `ach-lv lv${s.observed}` }, L[s.observed]), h("div", { class: "rs-sub" }, s.observed_status)] : "-"),
        h("td", { class: "left rs-speech" }, s.speech?.length ? s.speech.map((q) => h("div", {}, `“${q}”`)) : "-")))))
      : h("p", { class: "muted" }, "성취기준이 없어요."),
    v.participation.length ? [h("h3", { class: "rs-head" }, `${no()}. 발언 참여 변화`), participationChart(v.participation)] : null,
    h("h3", { class: "rs-head" }, `${no()}. 성장 과정 요약 (AI 분석)`), h("p", { class: "rs-text" }, v.growth || "-"),
    h("h3", { class: "rs-head" }, `${no()}. 과목별 세부능력 및 특기사항`), h("p", { class: "rs-text" }, v.setuk || "-"));
}

/* ───────── 활동 피드백 > 📈 성장 흐름: 회차마다 발언·관찰·판단·피드백 목표와 그 목표를 해냈는지 ───────── */
const GOAL_MARK = { done: ["✅", "해냄"], partial: ["🔸", "일부 시도"], none: ["⬜", "아직"] };

/** 회차별 목표 달성률 막대 (지난 피드백 목표를 그 수업에서 해낸 비율) */
function goalChart(list) {
  const pts = list.filter((x) => x.goal_rate !== null && x.goal_rate !== undefined);
  if (!pts.length) return h("p", { class: "muted", style: "margin:0" }, "아직 판정한 목표가 없어요. 회차별 피드백을 공개하고, 다음 수업이 끝난 뒤 그 수업의 피드백을 만들면 지난 목표를 해냈는지 판정돼요.");
  const W = 640, H = 180, L = 36, R = 12, T = 16, B = 34, step = (W - L - R) / pts.length, bw = Math.min(40, step * 0.55);
  const Y = (v) => T + (H - T - B) * (1 - v / 100);
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "ach-chart goal-chart", role: "img", "aria-label": "회차별 목표 달성률" });
  for (const v of [0, 50, 100]) {
    svg.append(el("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: "#e3e6e8" }));
    svg.append(el("text", { x: L - 6, y: Y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "#59636b" }, `${v}%`));
  }
  pts.forEach((x, i) => {
    const cx = L + step * i + step / 2;
    svg.append(el("rect", { x: cx - bw / 2, y: Y(x.goal_rate), width: bw, height: Y(0) - Y(x.goal_rate), rx: 3, fill: x.goal_rate >= 75 ? "#1b6b4a" : x.goal_rate >= 40 ? "#d4a017" : "#e5847a" }));
    svg.append(el("text", { x: cx, y: Y(x.goal_rate) - 5, "text-anchor": "middle", "font-size": 12, "font-weight": 700, fill: "#1d2330" }, `${x.goal_rate}%`));
    svg.append(el("text", { x: cx, y: H - B + 16, "text-anchor": "middle", "font-size": 11, fill: "#59636b" }, `${x.no}회 ${achMD(x.date)}`));
  });
  return svg;
}

async function renderGrowth(courseId, who, box, openFeedback) {
  achFill(box, h("p", { class: "muted" }, "불러오는 중…"));
  let tl, v;
  try {
    [tl, v] = await Promise.all([achApi(`/api/courses/${courseId}/students/${who.user_id}/timeline`),
      achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/analysis`).catch(() => null)]);
  } catch (err) { achFill(box, h("p", { class: "error" }, err.message)); return; }
  const list = tl.classes;
  const checks = list.flatMap((x) => x.goal_checks);
  const done = checks.filter((g) => g.status === "done").length, part = checks.filter((g) => g.status === "partial").length;
  const card = (x) => h("div", { class: "tl-card" },
    h("div", { class: "tl-head" }, h("strong", {}, `${x.no}회 · ${fmtDate(x.date)}`), h("span", { class: "muted" }, ` ${x.title || ""}`),
      h("span", { class: "grow" }),
      h("span", { class: "tl-chip" }, `발언 ${x.counts.talk} (자발 ${x.counts.spontaneous} · 응답 ${x.counts.response})`),
      x.counts.quiz_score !== null && x.counts.quiz_score !== undefined ? h("span", { class: "tl-chip" }, `퀴즈 ${x.counts.quiz_score}%`) : null,
      x.feedback ? h("span", { class: `fb-badge${x.published ? " pub" : ""}` }, x.published ? "피드백 공개" : "피드백 초안") : null),
    x.goal_checks.length ? h("div", { class: "tl-row" }, h("span", { class: "tl-label" }, "🎯 지난 목표"),
      h("div", {}, x.goal_checks.map((g) => h("div", { class: `tl-goal ${g.status}` }, `${GOAL_MARK[g.status][0]} ${g.goal} `,
        h("span", { class: "muted" }, `· ${GOAL_MARK[g.status][1]}${g.evidence ? ` “${g.evidence}”` : ""}`))))) : null,
    x.levels.length ? h("div", { class: "tl-row" }, h("span", { class: "tl-label" }, "📏 판단"),
      h("div", {}, x.levels.map((l) => h("span", { class: "tl-lv" }, l.level ? h("span", { class: `ach-lv lv${l.level}` }, ACH_LEVEL[l.level]) : h("span", { class: "ach-lv lv0" }, "–"), ` ${l.code}`)))) : null,
    x.notes.length ? h("div", { class: "tl-row" }, h("span", { class: "tl-label" }, "👀 관찰"), h("div", {}, x.notes.map((t) => h("div", {}, t)))) : null,
    x.turns.length ? h("div", { class: "tl-row" }, h("span", { class: "tl-label" }, "🗣️ 발언"),
      h("div", {}, x.turns.map((t) => h("div", {}, h("span", { class: `sp-kind ${t.kind === "응답" ? "resp" : "spon"}` }, t.kind), t.text)))) : null,
    x.feedback?.next_actions?.length ? h("div", { class: "tl-row" }, h("span", { class: "tl-label" }, "➡️ 다음 목표"),
      h("div", {}, x.feedback.next_actions.map((g) => h("div", {}, `☐ ${g}`)))) : null,
    h("div", { class: "row", style: "justify-content:flex-end;margin-top:6px" },
      h("button", { class: "small", type: "button", onclick: () => openFeedback(x.class_id) }, x.feedback ? "이 회차 피드백 보기·고치기" : "이 회차 피드백 만들기")));
  achFill(box,
    h("div", { class: "ach-box" }, h("div", { class: "ach-box-head" }, "🎯 목표 달성 흐름 ",
      h("span", { class: "muted", style: "font-weight:400;font-size:0.85rem" }, checks.length ? `(지금까지 목표 ${checks.length}개 중 해냄 ${done} · 일부 ${part})` : "")),
      goalChart(list)),
    v && v.analyzed_at ? achProgressTable(v) : null,
    v ? achTrackingTable(v) : null,
    h("div", { class: "ach-box" }, h("div", { class: "ach-box-head" }, "🗓️ 회차 타임라인"),
      list.length ? [...list].sort((a, b) => a.no - b.no).map(card) : h("p", { class: "muted", style: "margin:0" }, "아직 이 학생의 수업 기록이 없어요.")));
}

/** 항상 아래로 펼쳐지는 드롭다운 (기본 select 는 고른 항목이 아래쪽이면 위로 펼쳐진다) */
function achDropdown(options, value, onChange, label = "") {
  let cur = options.find(([v]) => v === value) || options[0] || [null, "-"];
  const text = h("span", { class: "grow" }, cur[1]);
  const items = options.map((o) => h("button", { type: "button", role: "option", class: `ach-dd-item${o[0] === cur[0] ? " on" : ""}`,
    onclick: () => {
      close();
      if (o[0] === cur[0]) return;
      cur = o; text.textContent = o[1];
      items.forEach((b, i) => b.classList.toggle("on", options[i][0] === o[0]));
      onChange(o[0]);
    } }, o[1]));
  const menu = h("div", { class: "ach-dd-menu", role: "listbox", hidden: true }, items);
  const btn = h("button", { type: "button", class: "ach-dd-btn", "aria-label": label, "aria-haspopup": "listbox",
    onclick: (e) => { e.stopPropagation(); menu.hidden ? open() : close(); } }, text, h("span", { "aria-hidden": "true" }, "▾"));
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };
  function open() { menu.hidden = false; document.addEventListener("click", outside); menu.querySelector(".on")?.scrollIntoView({ block: "nearest" }); }
  function close() { menu.hidden = true; document.removeEventListener("click", outside); }
  const wrap = h("div", { class: "ach-dd" }, btn, menu);
  return wrap;
}

/** 활동 피드백 > 💌 피드백: 회차별 피드백(고르고 만들고 공개) + 종합 피드백 */
async function renderStudentFeedback(c, who, box, pick = null) {
  const again = (k) => renderStudentFeedback(c, who, box, k ?? pick);
  achFill(box, h("p", { class: "muted" }, "불러오는 중…"));
  let list;
  try { ({ classes: list } = await achApi(`/api/courses/${c.id}/class-feedback`)); } catch (err) { achFill(box, h("p", { class: "error" }, err.message)); return; }
  if (!pick && list.length) pick = list[list.length - 1].class_id;
  const ordered = [...list].sort((a, b) => (a.no || 0) - (b.no || 0));
  const sel = achDropdown(ordered.map((k) => [k.class_id, `${k.no}회 · ${fmtDate(k.date)} ${k.title || ""}`]), pick, (v) => again(Number(v)), "회차");
  const per = h("div", {}, h("p", { class: "muted" }, list.length ? "불러오는 중…" : "아직 연 수업이 없어요."));
  const total = h("div", { class: "ach-wrap" });
  achFill(box,
    h("div", { class: "ach-box" },
      h("div", { class: "row", style: "align-items:center;margin-bottom:8px" }, h("div", { class: "ach-box-head grow", style: "margin:0" }, "📝 회차별 피드백"), list.length ? sel : null),
      h("p", { class: "muted", style: "margin:0 0 8px;font-size:0.85rem" }, "수업이 끝나면 그 회차의 피드백을 만들어 공개해요. 다음 회차 피드백을 만들 때 AI가 이번 '다음 수업에서 해 보기'를 해냈는지 판정해요."),
      per),
    total);
  renderAnalysis(c.id, who, total, { obs: false, only: "feedback" });
  if (!pick) return;
  const k = list.find((x) => x.class_id === pick);
  let d;
  try { d = await achApi(`/api/courses/${c.id}/class-feedback/${pick}`); } catch (err) { achFill(per, h("p", { class: "error" }, err.message)); return; }
  const s = d.students.find((x) => x.user_id === who.user_id);
  if (!s) { achFill(per, h("p", { class: "muted" }, "이 학생은 수강생 명단에 없어요.")); return; }
  const gen = h("button", { class: "small primary", type: "button", disabled: !d.ai || !s.has_record || s.published, title: s.published ? "공개 중인 피드백은 다시 만들지 않아요" : "" },
    s.parts ? "🤖 AI 초안 다시 만들기" : "🤖 AI 초안 만들기");
  gen.onclick = async () => {
    gen.disabled = true; gen.textContent = "🤖 만드는 중…";
    try { await achApi(`/api/courses/${c.id}/class-feedback/${pick}/generate`, { user_ids: [who.user_id] }); toast("초안을 만들었어요. 고쳐서 공개해 주세요."); again(pick); }
    catch (err) { toast(err.message, 6000); gen.disabled = false; }
  };
  const row = s.parts ? classFbStudent(c, k, s, () => again(pick)) : null;
  if (row && row.tagName === "DETAILS") row.open = true;
  achFill(per,
    h("div", { class: "row", style: "justify-content:flex-end;margin-bottom:6px" }, s.has_record ? null : h("span", { class: "muted grow", style: "font-size:0.85rem" }, "이 회차에 이 학생의 발언·관찰·퀴즈 기록이 없어요."), gen),
    s.goal_checks?.length ? h("div", { class: "tl-row" }, h("span", { class: "tl-label" }, "🎯 지난 목표"),
      h("div", {}, s.goal_checks.map((g) => h("div", { class: `tl-goal ${g.status}` }, `${GOAL_MARK[g.status][0]} ${g.goal} `,
        h("span", { class: "muted" }, `· ${GOAL_MARK[g.status][1]}${g.evidence ? ` “${g.evidence}”` : ""}`))))) : null,
    row || h("p", { class: "muted" }, "아직 이 회차 피드백이 없어요. [🤖 AI 초안 만들기]를 누르세요."));
}

/* ───────── 학생: 선생님이 공개한 피드백 ───────── */

async function renderMyFeedback(courseId, box) {
  let v, cf;
  try {
    [v, cf] = await Promise.all([achApi(`/api/my/courses/${courseId}/feedback`),
      achApi(`/api/my/courses/${courseId}/class-feedback`).catch(() => ({ items: [] }))]);
  } catch { achFill(box, h("p", { class: "muted" }, "활동 피드백을 불러오지 못했어요. 잠시 후 다시 열어 주세요.")); return; }
  const items = cf.items || [];
  if (!v.published && !items.length) { achFill(box, h("p", { class: "muted" }, "아직 선생님이 공개한 활동 피드백이 없어요.")); return; }
  achFill(box,
    // 수업별 피드백 (최근 수업부터, 가장 최근 것만 펼침)
    items.length ? h("div", { class: "my-class-fb" }, h("h3", { class: "section-title" }, "📝 수업별 피드백"),
      items.map((x, i) => h("details", { class: "fb-class", open: i === 0 },
        h("summary", {}, h("strong", {}, `${fmtDate(x.date)} · ${x.title || "수업"}`),
          h("span", { class: "muted" }, ` · 스스로 한 발언 ${x.participation.spontaneous} · 질문에 대답 ${x.participation.response}`)),
        h("div", { class: "my-feedback" },
          x.standards.length ? h("div", { class: "fb-card" }, h("div", { class: "fb-card-head" }, "🎯 이번 수업의 성취기준"),
            x.standards.map((s) => h("div", { class: "ach-rate" },
              s.level ? h("span", { class: `ach-lv lv${s.level}` }, ACH_LEVEL[s.level]) : h("span", { class: "ach-lv lv0" }, "–"),
              h("strong", {}, ` ${s.code} `), h("span", { class: "muted" }, s.text)))) : null,
          x.goal_checks?.length ? h("div", { class: "fb-card" }, h("div", { class: "fb-card-head" }, "🎯 지난 목표, 이번 수업에서 해냈나요?"),
            x.goal_checks.map((g) => h("div", { class: `tl-goal ${g.status}`, style: "line-height:1.8" }, `${GOAL_MARK[g.status][0]} ${g.goal} `,
              h("strong", {}, `· ${GOAL_MARK[g.status][1]}`)))) : null,
          feedbackView(x.parts))))) : null,
    v.published ? h("div", { class: "my-total-fb" }, items.length ? h("h3", { class: "section-title" }, "📚 종합 피드백") : null,
      h("div", { class: "my-feedback" }, feedbackView(v.parts || { message: v.feedback }, v.participation || []))) : null);
}
