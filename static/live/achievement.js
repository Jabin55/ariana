/* 성취기준 기반 발언 분석 화면
   - 교사 [과목 정보]: 성취기준·평가기준(상중하)·평가 요소, 과목 성취수준(A~E·A~C·P)(AI 초안 → 수정) 입력, 회차마다 성취기준 연결
   - 교사 [학습 관리 > 학생 맞춤형 피드백 > 학생 > 성취 분석]: AI 분석, 역량·성취 변화 그래프, 종합 의견, 학생 피드백 공개
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
    h("details", { class: "std-levels" }, h("summary", { class: "muted" }, "평가기준 (상·중·하) 보기"),
      h("table", { class: "info-table" }, h("tbody", {},
        [["상", s.level_high], ["중", s.level_mid], ["하", s.level_low]].map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", { style: "white-space:pre-wrap" }, v || "-")))))),
    s.elements.length ? h("details", { class: "std-levels" },
      h("summary", { class: "muted" }, `평가 요소 · 척도별 수행 수준 보기 (${s.elements.length}개)`),
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

/* ───────── 교사: 학생 한 명의 AI 성취 분석 ───────── */

async function renderAnalysis(courseId, who, box, opts = {}) { // opts.obs === false: 관찰 기록은 [교사 관찰 기록] 탭에서
  let v, obs = [];
  try {
    [v, { observations: obs }] = await Promise.all([
      achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/analysis`),
      achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/observations`).catch(() => ({ observations: [] }))]);
  } catch (err) { achFill(box, h("p", { class: "error" }, err.message)); return; }
  const again = () => renderAnalysis(courseId, who, box);
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
    h("div", { class: "ach-box" }, h("div", { class: "ach-box-head" }, "🧩 교과 역량 밸런스 차트"),
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
  // 핵심역량 밸런스 차트 제목 + 오른쪽 [📖 핵심역량이란?] (누르면 6가지 뜻을 펼친다)
  const coreHead = () => {
    const comps = v.competencies || [];
    if (!comps.some((c) => c.desc)) return h("div", { class: "ach-box-head" }, "🧭 핵심역량 밸런스 차트");
    const panel = h("div", { class: "ach-comp-info", hidden: true },
      comps.map((c) => h("div", { class: "ach-comp-info-item" }, h("strong", {}, c.label), h("p", {}, h("b", {}, c.desc, "."), " ", c.detail || ""))));
    const btn = h("button", { class: "small", type: "button", "aria-expanded": "false" }, "📖 핵심역량이란?");
    // 팝업으로 띄운다 (차트를 밀어내지 않는다). 바깥을 누르거나 Esc 를 누르면 닫힌다
    const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("click", outside, true); document.removeEventListener("keydown", esc); };
    const outside = (e) => { if (!panel.contains(e.target) && e.target !== btn) close(); };
    const esc = (e) => { if (e.key === "Escape") close(); };
    btn.onclick = () => {
      if (!panel.hidden) { close(); return; }
      panel.hidden = false; btn.setAttribute("aria-expanded", "true");
      document.addEventListener("click", outside, true); document.addEventListener("keydown", esc);
    };
    panel.prepend(h("div", { class: "row", style: "align-items:center;margin-bottom:2px" }, h("strong", { class: "grow" }, "📖 2022 개정 교육과정 핵심역량"),
      h("button", { class: "small", type: "button", "aria-label": "닫기", onclick: close }, "✕")));
    // 머리글과 팝업을 한 칸으로 묶어 두 차트 상자의 줄 맞춤(subgrid)을 지킨다
    return h("div", { class: "ach-comp-head" }, h("div", { class: "ach-box-head row", style: "align-items:center" }, h("span", { class: "grow" }, "🧭 핵심역량 밸런스 차트"), btn), panel);
  };
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
  const fb = h("textarea", { rows: 5, maxlength: 4000, placeholder: "학생에게 보여 줄 피드백" });
  fb.value = v.feedback || "";
  const saveFb = h("button", { class: "small", type: "button" }, "피드백 저장");
  const publishFb = h("button", { class: v.published ? "small" : "primary small", type: "button" }, v.published ? "공개 취소" : "학생에게 공개");
  const saveFeedback = async (published, message) => {
    saveFb.disabled = publishFb.disabled = true;
    try {
      await achApi(`/api/courses/${courseId}/speech/student/${who.user_id}/feedback`, { feedback: fb.value, published });
      toast(message, 4000);
      again();
    } catch (err) { toast(err.message); saveFb.disabled = publishFb.disabled = false; }
  };
  saveFb.onclick = () => saveFeedback(v.published, v.published ? "피드백을 저장했어요. 학생에게 공개 중이에요." : "피드백을 저장했어요. 공개하기 전에는 학생에게 보이지 않아요.");
  publishFb.onclick = () => saveFeedback(!v.published, v.published ? "공개를 취소했어요. 이제 학생에게 보이지 않아요." : "학생의 [내 강좌 > 활동 피드백]에 공개했어요.");
  const when = v.analyzed_at ? new Date(v.analyzed_at * 1000).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }) : "";
  achFill(box,
    h("div", { class: "row", style: "margin:4px 0 8px" },
      h("h4", { class: "grow", style: "margin:0" }, "🤖 AI 성취 분석", when ? h("span", { class: "muted", style: "font-weight:400;font-size:0.82rem" }, ` · ${when} 분석`) : null), run,
      v.analyzed_at && (v.competencies?.length || v.subject_competencies?.length) ? editBtn : null),
    opts.obs === false ? null : h("details", { class: "ach-box", open: obs.length > 0 && !v.analyzed_at },
      h("summary", { class: "ach-box-head" }, `👀 교사 관찰 기록 ${obs.length}건 `, h("span", { class: "muted", style: "font-weight:400" }, "(수업 중 [관찰기록] 탭에서 적은 것 · AI 분석에 함께 써요)")),
      obs.length ? obs.map((o) => h("div", { class: "speech-line student" }, h("span", { class: "sp-time" }, `${fmtDate(o.date).slice(5)} ${o.time}`),
        h("span", { class: "sp-text" }, o.text, h("span", { class: "muted" }, ` · ${o.class_title}`))))
        : h("p", { class: "muted", style: "margin:4px 0" }, "아직 이 학생에 대한 관찰 기록이 없어요.")),
    v.analyzed_at ? null : h("p", { class: "muted" }, v.ai ? "[AI 분석하기]를 누르면 이 학생의 발언·교사 관찰 기록·퀴즈 답안을 성취기준의 평가 요소에 비추어 수업마다 상·중·하로 판단하고, 종합 의견과 피드백 초안을 만들어요. (이름·학번은 가리고 보내요)" : "AI가 설정되지 않아 분석할 수 없어요."),
    v.analyzed_at ? [
      (drawCharts(), charts),
      // 수업별 판단 근거 (성취기준 평가 요소의 상·중·하)
      h("div", { class: "ach-box" }, h("div", { class: "ach-box-head" }, "🔎 수업별 판단 근거 (성취기준 평가 요소)"),
        // 판단 근거가 되는 기록이 없는 회차는 아예 보여 주지 않는다
        v.classes.some((x) => x.ratings.length) ? v.classes.filter((x) => x.ratings.length).map((x) => h("div", { class: "ach-class" },
          h("div", { class: "speech-day-head" }, `${fmtDate(x.date)} · ${x.title || "(주제 없음)"}`),
          x.ratings.map((r) => h("div", { class: "ach-rate" },
            h("span", { class: `ach-lv lv${r.level}` }, ACH_LEVEL[r.level]), h("strong", {}, `${r.code} ${r.element}`),
            h("span", { class: "muted" }, ` “${r.evidence}”`)))))
          : h("p", { class: "muted", style: "margin:4px 0" }, "판단 근거가 되는 수업 기록이 아직 없어요.")),
      h("div", { class: "ach-box" }, h("div", { class: "ach-box-head" }, "📝 AI 종합 의견 ", h("span", { class: "muted", style: "font-weight:400" }, "(선생님만 봐요)")),
        h("p", { style: "white-space:pre-wrap;margin:0;line-height:1.6" }, v.summary || "-")),
    ] : null,
    h("div", { class: "ach-box" },
      h("div", { class: "ach-box-head" }, "💌 학생에게 줄 피드백 ", h("span", { class: "muted", style: "font-weight:400" }, "(AI 초안을 고쳐서 쓰세요)")),
      fb,
      h("div", { class: "row", style: "margin-top:8px;justify-content:flex-end" }, saveFb, publishFb),
      v.published ? h("p", { class: "ok-text", style: "margin:6px 0 0;font-size:0.85rem" }, "✅ 지금 학생에게 공개 중이에요.") : null));
}

/* ───────── 학생: 선생님이 공개한 피드백 ───────── */

async function renderMyFeedback(courseId, box) {
  let v;
  try { v = await achApi(`/api/my/courses/${courseId}/feedback`); }
  catch { achFill(box, h("p", { class: "muted" }, "활동 피드백을 불러오지 못했어요. 잠시 후 다시 열어 주세요.")); return; }
  if (!v.published) { achFill(box, h("p", { class: "muted" }, "아직 선생님이 공개한 활동 피드백이 없어요.")); return; }
  achFill(box,
    h("div", { class: "ach-box my-feedback" },
      h("div", { class: "ach-box-head" }, "💌 선생님 피드백"),
      h("p", { style: "white-space:pre-wrap;margin:0 0 10px;line-height:1.6" }, v.feedback),
      v.classes.length ? [h("div", { class: "ach-box-head", style: "margin-top:6px" }, "📈 나의 성취 변화"), achChart(v.classes)] : null));
}
