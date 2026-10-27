/* 강좌 카드 머리 그림: 교과별 색·그림 + 과목군 동그라미 + 과목명 + 학년도·학기 띠 (수업신청·메인·수강안내 공통) */
(function () {
  const AREA = {
    국어: ["📖", "#ff8a5c", "#e8663a"], 수학: ["📐", "#6d8cf0", "#3d63dd"], 영어: ["🔤", "#b18cf2", "#7a4fd6"],
    사회: ["🌏", "#3fa77a", "#1b6b4a"], 역사: ["🏛️", "#c79a5b", "#8a6230"], 도덕: ["⚖️", "#5fb3b3", "#2f7f7f"],
    과학: ["🔬", "#4fc3f7", "#1e88c8"], 체육: ["⚽", "#7ccf5a", "#3f9a2a"], 음악: ["🎵", "#ff8fb1", "#e5507e"],
    미술: ["🎨", "#ffb74d", "#f08a00"], 연극: ["🎭", "#ef7a7a", "#c94747"], "기술·가정": ["🛠️", "#a1887f", "#6d4c41"],
    정보: ["💻", "#4db6ac", "#00897b"], 제2외국어: ["🗣️", "#9fa8da", "#5c6bc0"], 한문: ["📜", "#d4a373", "#a0703c"],
    교양: ["💡", "#ffd54f", "#f4a300"],
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const courseAreaColors = (area) => (AREA[area] || ["📚", "#7fc8a9", "#1b6b4a"]).slice(1);

  /** 모집 상태 글자: 수강모집 · 모집예정 · 수업중 · 마감 */
  function courseState(c) {
    if (c.recruit === "open") return ["수강모집", "open"];
    if (c.recruit === "before") return ["모집예정", "before"];
    const t = today();
    if (c.start_date && c.start_date <= t && (!c.end_date || t <= c.end_date)) return ["수업중", "running"];
    return ["마감", "closed"];
  }

  /** 카드 머리 그림 HTML */
  function courseThumb(c) {
    const [ico] = AREA[c.subject_area] || ["📚"];
    const [a, b] = courseAreaColors(c.subject_area);
    // 동그라미: 과목군(사회·국어…). 네 글자 이상이면 두 줄로
    const area = c.subject_area || "교양";
    const cut = area.includes("·") ? area.indexOf("·") + 1 : Math.floor(area.length / 2);
    const circle = area.length > 3 ? `${esc(area.slice(0, cut))}<br>${esc(area.slice(cut))}` : esc(area);
    const term = c.term ? `${c.school_year ? `${c.school_year}학년도 ` : ""}${c.term}` : "";
    const [state] = courseState(c);
    return `<div class="thumb" style="--a:${a};--b:${b}">
      <span class="thumb-grade${area.length > 3 ? " long" : ""}">${circle}</span>
      <span class="thumb-ico" aria-hidden="true">${ico}</span>
      <span class="thumb-sub">${esc(c.subject || c.title || "")}</span>
      <span class="thumb-state" title="${state}">${esc(term || state)}</span></div>`;
  }

  window.courseThumb = courseThumb;
  window.courseAreaColors = courseAreaColors;
  window.courseState = courseState;
})();
