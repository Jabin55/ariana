/* 수강신청 강좌 조회: 개설연도 · 개설학기 · 대상학년 · 거점학교 · 강좌명 (공개 수강신청 페이지·학생 마이페이지 공통) */
(function () {
  const TERMS = ["1학기", "여름학기", "2학기", "겨울학기"];
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    n.append(...kids.flat());
    return n;
  };
  const ko = (a, b) => String(a).localeCompare(String(b), "ko");
  const select = (values, label = (v) => v) => el("select", {}, el("option", { value: "" }, "-- 선택 --"),
    values.map((v) => el("option", { value: v }, label(v))));

  /** 검색 칸을 만든다. 고를 때마다 onChange(거른 목록). init: 전에 고른 값 (목록을 다시 불러와도 그대로) */
  function courseSearch(list, onChange, init = {}) {
    const years = [...new Set(list.map((c) => c.school_year).filter(Boolean))].sort((a, b) => b - a);
    const terms = TERMS.filter((t) => list.some((c) => c.term === t));
    const hubs = [...new Set(list.map((c) => c.hub_school).filter(Boolean))].sort(ko);
    const f = {
      year: select(years, (y) => `${y}학년도`), term: select(terms),
      grade: select([1, 2, 3], (g) => `${g}학년`), hub: select(hubs), name: el("input", { placeholder: "강좌명·과목명" }),
    };
    for (const [k, x] of Object.entries(f)) if (init[k] != null) x.value = init[k];
    const values = () => Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value]));
    const filter = () => list.filter((c) => (!f.year.value || String(c.school_year) === f.year.value)
      && (!f.term.value || c.term === f.term.value)
      && (!f.grade.value || !c.grades?.length || c.grades.includes(Number(f.grade.value)))
      && (!f.hub.value || c.hub_school === f.hub.value)
      && (!f.name.value.trim() || [c.title, c.subject].join(" ").includes(f.name.value.trim())));
    const run = () => onChange(filter());
    for (const x of Object.values(f)) x.addEventListener(x.tagName === "INPUT" ? "input" : "change", run);
    const cell = (label, x, wide) => [el("div", { class: "sf-label" }, label), el("div", { class: `sf-field ${wide ? "wide" : ""}` }, x)];
    const row = (...cells) => el("div", { class: "sf-row" }, ...cells.flat());
    const reset = el("button", { type: "button", class: "small" }, "초기화");
    reset.addEventListener("click", () => { for (const x of Object.values(f)) x.value = ""; run(); });
    const form = el("div", { class: "course-search" },
      el("div", { class: "search-form" },
        row(cell("개설연도", f.year), cell("개설학기", f.term)),
        row(cell("대상학년", f.grade), cell("거점학교", f.hub)),
        row(cell("강좌명", f.name, true))),
      el("div", { class: "row", style: "justify-content:flex-end;margin:8px 0 14px" }, reset));
    return { form, filter, values };
  }
  window.courseSearch = courseSearch;
})();
