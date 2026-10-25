/* 강좌 카드 머리 그림: 교과별 색·그림 + 대상 학년 동그라미 + 모집 상태 띠 (수업신청·메인·수강안내 공통) */
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
    const [ico, a, b] = AREA[c.subject_area] || ["📚", "#7fc8a9", "#1b6b4a"];
    const g = c.grades?.length ? (c.grades.length === 1 ? `${c.grades[0]}학년` : `${c.grades.join(",")}<br>학년`) : "전<br>학년";
    const [label, cls] = courseState(c);
    return `<div class="thumb" style="--a:${a};--b:${b}">
      <span class="thumb-grade">${g}</span>
      <span class="thumb-ico" aria-hidden="true">${ico}</span>
      <span class="thumb-sub">${esc(c.subject_area || "")}</span>
      <span class="thumb-state ${cls}">${label}</span></div>`;
  }

  window.courseThumb = courseThumb;
  window.courseState = courseState;
})();
