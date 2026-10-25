/* 강좌 개설·수정 양식 (2022 개정 교육과정 과목 검색, 학점·시수, 평가, 모집, 팀티칭, 수업계획서) */

/** c: 고칠 강좌(없으면 새 강좌). done(): 저장한 뒤 할 일 */
async function courseForm(c, done) {
  const meta = await subjectMeta();
  const isNew = !c;
  c = c || {};
  const year = new Date(Date.now() + 9 * 3600 * 1000).getUTCFullYear();
  const opt = (list, cur, first) => [first ? h("option", { value: "" }, first) : null,
    ...list.map((x) => (Array.isArray(x) ? h("option", { value: x[0], selected: x[0] === cur }, x[1])
      : h("option", { value: x, selected: x === cur }, x)))];
  const field = (label, el, attrs = {}) => h("label", attrs, label, el);
  const dl = h("datalist", { id: `subj-${c.id || "new"}` }, meta.subjects.map((x) => h("option", { value: x.name }, `${x.area} · ${x.type}`)));

  const title = h("input", { name: "title", value: c.title || "", maxlength: 60, required: true, list: dl.id, autocomplete: "off",
    placeholder: "과목명 일부를 입력해 검색 (예: 법과)" });
  const custom = h("input", { type: "checkbox", checked: c.custom_subject });
  const group = h("select", { required: true }, opt(meta.groups, c.subject_group, "교과(군)을 고르세요"));
  const area = h("select", { required: true }, opt(meta.areas, c.subject_area, "교과를 고르세요"));
  const type = h("select", { required: true }, opt(meta.types, c.subject_type, "과목 구분을 고르세요"));
  const schoolYear = h("input", { type: "number", min: 2020, max: 2100, value: c.school_year || year, required: true, style: "width:6em" });
  const term = h("select", { required: true }, opt(meta.terms, c.term, "학기를 고르세요"));
  const credits = h("input", { type: "number", min: 1, max: 10, value: c.credits || 4, required: true, style: "width:5em" });
  const hours = h("strong", {}, "");
  const achievement = h("select", { required: true }, opt(Object.entries(meta.achievements), c.achievement, "성취도를 고르세요"));
  const capacity = h("input", { type: "number", min: 1, max: 500, value: c.capacity || "", required: true, style: "width:6em", placeholder: "예: 20" });
  const rStart = h("input", { type: "date", value: c.recruit_start || "", required: true });
  const rEnd = h("input", { type: "date", value: c.recruit_end || "", required: true });
  const start = h("input", { type: "date", value: c.start_date || "", required: true });
  const end = h("input", { type: "date", value: c.end_date || "", required: true });
  const exam = h("input", { type: "number", min: 0, max: 100, value: c.exam_ratio ?? 0, required: true, style: "width:5em" });
  const perf = h("input", { type: "number", min: 0, max: 100, value: c.perf_ratio ?? 100, required: true, style: "width:5em" });
  const instructor = h("input", { value: c.instructor || ME.name || "", maxlength: 30, required: true });
  const desc = h("textarea", { rows: 5, maxlength: 3000, placeholder: "수업 목표, 진행 방식(요일·시간), 준비물, 이런 학생에게 추천 등" }, c.description || "");
  desc.value = c.description || "";
  const grades = [1, 2, 3].map((g) => h("input", { type: "checkbox", value: g, checked: (c.grades || []).includes(g) }));
  const file = h("input", { type: "file", accept: ".pdf,.hwp,.hwpx,.docx,.doc" });

  // 거점학교: 새 강좌는 강의할 수 있는 거점학교 중에서 (보조교사로만 승인된 곳 제외)
  const leadHubs = ME.lead_hubs || [];
  const hubSel = h("select", {}, leadHubs.map((x) => h("option", { value: x.id }, x.name)));
  const hubText = h("input", { maxlength: 60, placeholder: "강의를 운영하는 학교" });
  const hubBox = isNew
    ? (leadHubs.length ? field("거점학교", hubSel) : field("거점학교명", hubText))
    : h("div", {}, "거점학교 ", h("strong", {}, c.hub_school || "-"));

  // 팀티칭: 같은 거점학교에서 활동 중인 강사 중 보조교사를 고른다
  const team = h("input", { type: "checkbox", checked: c.team_teaching });
  const coBox = h("div", { class: "co-teachers" });
  const coChosen = new Set((c.co_teachers || []).map((x) => x.id));
  async function loadCo() {
    coBox.replaceChildren();
    if (!team.checked) return;
    const hubId = isNew ? Number(hubSel.value) : c.hub_id;
    if (!hubId) { coBox.append(h("p", { class: "muted" }, "팀티칭은 거점학교 강좌에서만 할 수 있어요.")); return; }
    try {
      const { teachers } = await api(`/api/hubs/${hubId}/teachers`);
      coBox.append(h("div", { class: "muted", style: "font-size:0.85rem" }, "보조교사 (이 거점학교에서 승인받은 강사 중에서 골라요)"),
        ...(teachers.length ? teachers.map((x) => h("label", { class: "switch" },
          h("input", { type: "checkbox", value: x.id, checked: coChosen.has(x.id),
            onchange: (e) => { if (e.target.checked) coChosen.add(x.id); else coChosen.delete(x.id); } }),
          ` ${x.name}`, h("span", { class: "muted", style: "font-size:0.8rem" }, `${x.assistant ? " · 보조교사" : " · 강사"}${x.affiliation ? ` · ${x.affiliation}` : ""}`)))
          : [h("p", { class: "muted", style: "margin:4px 0" }, "아직 이 거점학교에 승인된 다른 강사가 없어요. 보조교사가 '팀티칭 보조교사'로 강사 등록을 신청하고 관리교사 승인을 받으면 여기에 나와요.")]));
    } catch (err) { coBox.append(h("p", { class: "error" }, err.message)); }
  }
  team.addEventListener("change", loadCo);
  hubSel.addEventListener("change", loadCo);
  if (team.checked) loadCo();

  // 과목을 고르면 교과(군)·교과·과목 구분·기본 학점·성취도를 채운다
  const lockSubject = () => {
    const found = !custom.checked && meta.subjects.find((x) => x.name === title.value.trim());
    for (const el of [group, area, type]) el.disabled = !!found;
    return found;
  };
  title.addEventListener("input", () => {
    const found = lockSubject();
    if (found) {
      group.value = found.group;
      area.value = found.area;
      type.value = found.type;
      credits.value = found.credits;
      achievement.value = found.achievement;
      updateHours();
    }
  });
  custom.addEventListener("change", lockSubject);
  const updateHours = () => { hours.textContent = credits.value ? `${Number(credits.value) * meta.hours_per_credit}시간` : "-"; };
  credits.addEventListener("input", updateHours);
  exam.addEventListener("input", () => { if (exam.value !== "") perf.value = Math.max(0, 100 - Number(exam.value)); });
  perf.addEventListener("input", () => { if (perf.value !== "") exam.value = Math.max(0, 100 - Number(perf.value)); });
  lockSubject();
  updateHours();

  const err = h("p", { class: "error" });
  // 칸에서 엔터를 쳐도 개설·저장되지 않게: 버튼을 눌렀을 때만 (과목 목록에서 엔터로 고르는 것은 그대로)
  let enterAt = 0;
  const form = h("form", { class: "course-form course-form-full", onsubmit: async (e) => {
    e.preventDefault();
    if (performance.now() - enterAt < 500) return;
    err.textContent = "";
    const body = {
      title: title.value.trim(), custom_subject: custom.checked,
      subject_group: group.value, subject_area: area.value, subject_type: type.value,
      school_year: Number(schoolYear.value), term: term.value, credits: Number(credits.value), achievement: achievement.value,
      grades: grades.filter((x) => x.checked).map((x) => Number(x.value)), capacity: Number(capacity.value),
      recruit_start: rStart.value, recruit_end: rEnd.value, start_date: start.value, end_date: end.value,
      exam_ratio: Number(exam.value), perf_ratio: Number(perf.value), instructor: instructor.value.trim(),
      description: desc.value.trim(), team_teaching: team.checked, co_teachers: team.checked ? [...coChosen] : [],
    };
    if (isNew) {
      body.hub_id = leadHubs.length ? Number(hubSel.value) : null;
      body.hub_school = leadHubs.length ? "" : hubText.value;
    }
    if (body.exam_ratio + body.perf_ratio !== 100) { err.textContent = "지필평가와 수행평가 비율을 더하면 100%가 되어야 해요."; return; }
    try {
      let id = c.id;
      if (isNew) ({ id } = await api("/api/courses", body));
      else await api(`/api/courses/${c.id}`, body);
      if (file.files[0]) {
        const f = file.files[0];
        const res = await fetch(`/api/courses/${id}/syllabus?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
        if (!res.ok) toast(`강좌는 저장했지만 수업계획서를 올리지 못했어요: ${(await res.json().catch(() => ({}))).detail || res.status}`, 6000);
      }
      done(id);
    } catch (e2) { err.textContent = e2.message; }
  } },
    h("fieldset", { class: "wide" }, h("legend", {}, "과목"),
      h("div", { class: "course-grid" },
        field("과목명 (2022 개정 교육과정)", title, { class: "wide" }), dl,
        h("label", { class: "switch wide" }, custom, " 고시외 과목 (목록에 없는 과목 — 직접 적고 아래 칸을 골라요)"),
        field("교과(군)", group), field("교과", area), field("과목 구분", type))),
    h("fieldset", { class: "wide" }, h("legend", {}, "학기·학점·평가"),
      h("div", { class: "course-grid" },
        h("div", { class: "row" }, field("학년도", schoolYear), field("수업 학기", term)),
        h("div", { class: "row" }, field("수업 학점", credits), h("span", {}, "수업 시수 ", hours)),
        field("성취도", achievement),
        h("div", { class: "row" }, field("지필평가 %", exam), field("수행평가 %", perf)))),
    h("fieldset", { class: "wide" }, h("legend", {}, "모집"),
      h("div", { class: "course-grid" },
        h("div", { class: "grade-pick" }, "대상 학년 ", h("span", { class: "muted", style: "font-size:0.85rem" }, "(고르지 않으면 모든 학년)"),
          h("div", { class: "row" }, grades.map((x) => h("label", { class: "switch" }, x, ` ${x.value}학년`)))),
        field("수강 인원 (명)", capacity),
        h("div", { class: "period" }, "모집 기간", h("div", { class: "row" }, rStart, " ~ ", rEnd)),
        h("div", { class: "period" }, "수업 기간 (시작일 ~ 종료일)", h("div", { class: "row" }, start, " ~ ", end)))),
    h("fieldset", { class: "wide" }, h("legend", {}, "강사·거점학교"),
      h("div", { class: "course-grid" },
        field("강사명", instructor), hubBox,
        h("label", { class: "switch wide" }, team, " 팀티칭 (보조교사가 함께 수업에 들어와 도와요)"),
        h("div", { class: "wide" }, coBox))),
    h("fieldset", { class: "wide" }, h("legend", {}, "수업 소개·수업계획서"),
      field("수업 소개", desc, { class: "wide" }),
      h("label", { class: "wide" }, "수업계획서 파일 (PDF·한글·워드, 20MB까지)", file,
        c.syllabus ? h("span", { class: "muted", style: "font-size:0.85rem" }, `지금 파일: ${c.syllabus.name} (새로 고르면 바뀌어요)`) : null)),
    h("div", { class: "row wide" }, h("button", { class: "primary", type: "submit" }, isNew ? "강좌 개설" : "저장"),
      isNew ? null : h("button", { type: "button", onclick: () => done(null) }, "취소")),
    err);
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") enterAt = performance.now();
  });
  return form;
}

/** 강좌 안내 (학생·선생님 화면 공통): 과목·학점·평가·모집 */
function courseFacts(c) {
  const rows = [];
  if (c.subject_area || c.subject_type) {
    rows.push(["과목", [c.subject_group, c.subject_area, c.custom_subject ? "고시외 과목" : c.subject_type].filter(Boolean).join(" · ")]);
  }
  if (c.term) rows.push(["학기", `${c.school_year || ""}학년도 ${c.term}`]);
  if (c.credits) rows.push(["학점", `${c.credits}학점 (${c.hours}시간)`]);
  if (c.achievement_text) rows.push(["성취도", c.achievement_text]);
  if (c.exam_ratio != null && c.perf_ratio != null) rows.push(["평가", `지필 ${c.exam_ratio}% · 수행 ${c.perf_ratio}%`]);
  if (c.recruit_start || c.recruit_end) rows.push(["모집 기간", `${fmtDate(c.recruit_start)} ~ ${fmtDate(c.recruit_end)}`]);
  if (c.capacity) rows.push(["수강 인원", `${c.capacity}명`]);
  if (c.team_teaching) rows.push(["팀티칭", c.co_teachers?.length ? `보조교사 ${c.co_teachers.map((x) => x.name).join(", ")}` : "예"]);
  if (!rows.length && !c.syllabus) return null;
  return h("dl", { class: "facts" }, rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]),
    c.syllabus ? [h("dt", {}, "수업계획서"), h("dd", {}, h("a", { href: c.syllabus.url, target: "_blank" }, `📄 ${c.syllabus.name}`))] : null);
}
