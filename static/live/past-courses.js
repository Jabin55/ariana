/* 보관 처리된 강좌의 공개 정보: 수강신청 기능 없이 지난 개설 과목만 보여 준다. */
(async function () {
  const searchBox = document.getElementById("past-course-search");
  const box = document.getElementById("past-catalog");
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
  const date = (value) => value ? value.replaceAll("-", ".") : "";
  const draw = (courses) => {
    box.innerHTML = courses.length ? courses.map((course) => {
      const grades = (course.grades?.length ? course.grades : [1, 2, 3]).map((grade) => `${grade}학년`);
      const facts = [
        ["개설 학기", [course.school_year ? `${course.school_year}학년도` : "", course.term].filter(Boolean).join(" ")],
        ["과목", course.subject],
        ["학점", course.credits ? `${course.credits}학점` : "-"],
        ["거점학교", course.hub_school || "-"],
        ["강의교사", course.instructor || "-"],
        ["운영 기간", [date(course.start_date), date(course.end_date)].filter(Boolean).join(" ~ ") || "-"],
      ];
      return `<article class="course-tile with-thumb">${window.courseThumb ? window.courseThumb(course) : ""}
        <div class="ct-body"><div class="ct-top">${grades.map((grade) => `<span class="tag soft">${esc(grade)}</span>`).join("")}</div>
        <h3>${esc(course.title)}</h3><dl class="facts">${facts.map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`).join("")}</dl>
        </div></article>`;
    }).join("") : '<p class="muted">조건에 맞는 지난 개설 과목이 없어요.</p>';
  };
  try {
    const response = await fetch("/api/courses/archived");
    if (!response.ok) throw new Error("지난 개설 과목을 불러오지 못했어요.");
    const { courses } = await response.json();
    const search = window.courseSearch(courses, draw);
    searchBox.replaceChildren(search.form);
    draw(search.filter());
  } catch (error) { box.textContent = error.message; }
})();
