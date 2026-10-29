/* 온라인 공동교육과정 수업 개설 신청 (3단계)
   1. 학교 및 교사 정보  2. 수업 개설 정보  3. 회차 정보 */

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const pad2 = (n) => String(n).padStart(2, "0");
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dayOf = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`)).getUTCDay();
const minutes = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : 0);

/** c: 고칠 강좌(없으면 새 강좌). done(id|null): 저장(또는 취소)한 뒤 할 일 */
async function courseForm(c, done) {
  const meta = await subjectMeta();
  const isNew = !c;
  c = c || {};
  const year = new Date(Date.now() + 9 * 3600 * 1000).getUTCFullYear();
  const opt = (list, cur, first, keepOrder = false) => [first ? h("option", { value: "" }, first) : null,
    ...(keepOrder ? list : koSort(list, (x) => (Array.isArray(x) ? x[1] : x))).map((x) => (Array.isArray(x) ? h("option", { value: x[0], selected: x[0] === cur }, x[1])
      : h("option", { value: x, selected: x === cur }, x)))];
  const row = (label, ...cells) => h("div", { class: "wz-row" }, h("div", { class: "wz-label" }, label), h("div", { class: "wz-cell" }, ...cells));
  const toggle = (checked, on = "공개", off = "비공개") => {
    const box = h("input", { type: "checkbox", checked });
    const text = h("span", {}, checked ? on : off);
    box.addEventListener("change", () => { text.textContent = box.checked ? on : off; });
    return [h("label", { class: "wz-toggle" }, box, h("i"), text), box];
  };
  const schools = (typeof CONFIG !== "undefined" && CONFIG?.schools) || [];

  /* ───── 1. 학교 및 교사 정보 ───── */
  const last = [...(ME.memberships || [])].reverse().find((m) => m.affil_type || m.email) || {};
  const AFFIL = { school: "교사", univ: "대학 교원", cert: "교원자격 소지자", other: "기타" };
  const kind = last.affil_type ? AFFIL[last.affil_type] : ME.is_admin ? "전체 관리자" : "교사";
  // 교강사 정보는 가입(등록 신청) 때 적은 그대로 보여 준다. 여기서는 고치지 않는다 (공개 여부만)
  const instructorName = c.instructor || ME.name || "";
  const emailText = c.contact_email || last.email || ME.email || "";
  const phoneText = c.contact_phone || last.contact || "";
  const [emailToggle, showEmail] = toggle(!!c.show_email);
  const [phoneToggle, showPhone] = toggle(!!c.show_phone);

  // 개설학교 정보: 소속 교육청과 거점학교를 목록에서만 고른다 (고칠 때도 바꿀 수 있음, 정식 이름만)
  // 강사는 승인받은 거점학교 중에서, 전체 관리자는 울산 고등학교 목록 전체에서
  const leadHubs = ME.lead_hubs || [];
  const byName = !leadHubs.length || ME.is_admin || ME.lead_any; // 울산 고등학교 어디든 거점학교로 고른다
  const schoolNames = [...new Set([...leadHubs.map((x) => x.name), ...schools, ...(c.hub_school ? [c.hub_school] : [])])].sort();
  const office = h("select", { required: true }, koSort(meta.offices).map((o) => h("option", { value: o, selected: o === "울산광역시교육청" }, o)));
  const hubSel = h("select", { required: true }, h("option", { value: "" }, "거점학교를 고르세요"),
    byName ? koSort(schoolNames).map((n) => h("option", { value: n, selected: n === c.hub_school }, n))
      : koSort(leadHubs, (x) => x.name).map((x) => h("option", { value: x.id, selected: x.id === c.hub_id }, x.name)));
  if (isNew && !byName && leadHubs.length === 1) hubSel.value = String(leadHubs[0].id);
  const officeNote = h("span", { class: "muted", style: "font-size:0.85rem" });
  office.addEventListener("change", () => {
    const ulsan = office.value === "울산광역시교육청";
    hubSel.disabled = !ulsan;
    officeNote.textContent = ulsan ? "" : "거점학교는 울산광역시교육청 소속 고등학교만 고를 수 있어요.";
  });
  const hubIdNow = () => (byName ? (leadHubs.find((x) => x.name === hubSel.value)?.id || (hubSel.value === c.hub_school ? c.hub_id : null)) : Number(hubSel.value) || null);

  const joined = [...(c.schools || [])]; // (참여 학교 칸은 없앴다. 예전 강좌 값은 그대로 둔다)
  const dlId = `cf-${c.id || "new"}-${Math.random().toString(36).slice(2, 7)}`;

  // 팀티칭: 같은 거점학교에서 승인받은 강사 중 보조교사
  const [teamToggle, team] = toggle(!!c.team_teaching, "함", "안 함");
  const coBox = h("div", { class: "co-teachers" });
  const coChosen = new Set((c.co_teachers || []).map((x) => x.id));
  async function loadCo() {
    coBox.replaceChildren();
    if (!team.checked) return;
    // 거점학교 번호를 모르면 이름으로 찾고, 아직 없는 학교면 0 (거점학교를 정하지 않은 강의교사만 나온다)
    let hubId = hubIdNow();
    if (!hubId && hubSel.value) {
      try { hubId = (await api("/api/hubs")).hubs.find((x) => x.name === hubSel.value)?.id || 0; } catch { hubId = 0; }
    }
    if (hubId == null || !hubSel.value) { coBox.append(h("p", { class: "muted" }, "먼저 거점학교를 골라 주세요.")); return; }
    try {
      const { teachers } = await api(`/api/hubs/${hubId}/teachers`);
      coBox.append(...(teachers.length ? teachers.map((x) => h("label", { class: "switch" },
        h("input", { type: "checkbox", value: x.id, checked: coChosen.has(x.id),
          onchange: (e) => { if (e.target.checked) coChosen.add(x.id); else coChosen.delete(x.id); } }),
        ` ${x.name}`, h("span", { class: "muted", style: "font-size:0.8rem" }, `${x.assistant ? " · 보조교사" : " · 강사"}${x.affiliation ? ` · ${x.affiliation}` : ""}`)))
        : [h("p", { class: "muted", style: "margin:4px 0" }, "아직 이 거점학교에 승인된 다른 강사가 없어요. 보조교사가 '팀티칭 보조교사'로 강사 등록을 신청해 승인받으면 여기에 나와요.")]));
    } catch (err) { coBox.append(h("p", { class: "error" }, err.message)); }
  }
  team.addEventListener("change", loadCo);
  hubSel.addEventListener("change", loadCo);
  if (team.checked) loadCo();

  const step1 = h("section", { class: "wz-step" },
    h("h3", { class: "wz-h" }, "수업 담당 교강사 정보"),
    h("div", { class: "wz-table two" },
      row("교사명", h("strong", {}, instructorName || "-")), row("유형", kind),
      row("소속 교육청", last.office || "-"), row("소속 학교", ME.school || "-"),
      row("이메일", h("span", {}, emailText || "-"), emailToggle), row("연락처", h("span", {}, phoneText || "-"), phoneToggle)),
    h("p", { class: "muted", style: "margin:0;font-size:0.85rem" }, "교강사 정보는 등록 신청 때 적은 내용이에요. 바꾸려면 '내 정보'나 등록 신청서에서 고쳐 주세요."),
    h("h3", { class: "wz-h" }, "개설학교 정보"),
    h("div", { class: "wz-table two" },
      row("소속 교육청", office, officeNote),
      row("거점학교", hubSel,
        byName && !schoolNames.length ? h("span", { class: "error", style: "font-size:0.85rem" }, "울산 고등학교 목록이 비어 있어요. 전체 운영 관리자에게 문의해 주세요.") : null)),
    h("h3", { class: "wz-h" }, "팀 티칭 교강사 정보"),
    h("div", { class: "wz-table" }, row("팀티칭 여부", teamToggle, coBox)));

  /* ───── 2. 수업 개설 정보 ───── */
  // 수업명은 교육과정 문서상의 과목명 그대로 쓴다 (따로 적지 않음)
  const sdl = h("datalist", { id: `${dlId}-s` }, koSort(meta.subjects, (x) => x.name).map((x) => h("option", { value: x.name }, `${x.area} · ${x.type}${x.special ? " *" : ""}`)));
  const subject = h("input", { value: c.subject || c.title || "", maxlength: 60, required: true, list: sdl.id, autocomplete: "off", placeholder: "과목명을 입력해 검색 (예: 법과 사회)" });
  const custom = h("input", { type: "checkbox", checked: c.custom_subject });
  const group = h("select", { required: true }, opt(meta.groups, c.subject_group, "교과(군)", true)); // 교과(군)은 교육과정 순서 그대로
  const area = h("select", { required: true }, opt(meta.areas, c.subject_area, "교과"));
  const type = h("select", { required: true }, opt(meta.types, c.subject_type, "과목 구분"));
  // '찾기': 교과(군)을 고르면 과목이 버튼으로 나온다
  const browse = h("div", { class: "subject-browse", hidden: true });
  const browseGroup = h("select", {}, opt(meta.groups, c.subject_group || meta.groups[0], null, true));
  const browseList = h("div", { class: "subject-list" });
  const drawBrowse = () => {
    const list = meta.subjects.filter((x) => x.group === browseGroup.value);
    browseList.replaceChildren(...meta.types.map((t) => {
      const items = list.filter((x) => x.type === t);
      return items.length ? h("div", {}, h("b", {}, t), h("div", { class: "row" }, koSort(items, (x) => x.name).map((x) => h("button", { type: "button", class: "small", onclick: () => {
        subject.value = x.name;
        subject.dispatchEvent(new Event("input"));
        browse.hidden = true;
      }, title: x.special ? "특수 목적 고등학교 과목 (교육과정 총론 <표 6>)" : null }, x.special ? `${x.name}*` : x.name)))) : null;
    }));
  };
  browseGroup.addEventListener("change", drawBrowse);
  browse.append(h("div", { class: "row" }, "교과(군) ", browseGroup), browseList);
  const schoolYear = h("input", { type: "number", min: 2020, max: 2100, value: c.school_year || year, required: true, style: "width:6.5em" });
  const termName = `term-${dlId}`;
  const terms = meta.terms.map((t) => h("label", { class: "switch" }, h("input", { type: "radio", name: termName, value: t, checked: (c.term || meta.terms[0]) === t }), ` ${t}`));
  const credits = h("input", { type: "number", min: 1, max: 10, value: c.credits || 4, required: true, style: "width:5em" });
  const achievement = h("select", { required: true }, opt(Object.entries(meta.achievements), c.achievement, "성취도를 고르세요"));
  const grades = [1, 2, 3].map((g) => h("input", { type: "checkbox", value: g, checked: (c.grades || []).includes(g) }));
  const capacity = h("input", { type: "number", min: 1, max: 500, value: c.capacity || "", required: true, style: "width:6em", placeholder: "예: 20" });
  const rStart = h("input", { type: "date", value: c.recruit_start || "", required: true });
  const rStartT = h("input", { type: "time", value: c.recruit_start_time || "09:00", required: true });
  const rEnd = h("input", { type: "date", value: c.recruit_end || "", required: true });
  const rEndT = h("input", { type: "time", value: c.recruit_end_time || "23:59", required: true });
  const exam = h("input", { type: "number", min: 0, max: 100, value: c.exam_ratio ?? 0, required: true, style: "width:5em" });
  const perf = h("input", { type: "number", min: 0, max: 100, value: c.perf_ratio ?? 100, required: true, style: "width:5em" });
  const desc = h("textarea", { rows: 5, maxlength: 3000, placeholder: "수업 목표, 진행 방식, 준비물, 이런 학생에게 추천 등" });
  desc.value = c.description || "";
  const file = h("input", { type: "file", accept: ".pdf,.hwp,.hwpx,.docx,.doc" });

  // 수업 시수: 학점 × 16시간 (예: 3학점 → 48시간)
  const hoursText = h("strong", {}, "");
  const showHours = () => { hoursText.textContent = credits.value ? `${Number(credits.value) * meta.hours_per_credit}시간` : "-"; };
  credits.addEventListener("input", showHours);
  showHours();
  const lockSubject = () => {
    const found = !custom.checked && meta.subjects.find((x) => x.name === subject.value.trim());
    for (const el of [group, area, type]) el.disabled = !!found;
    return found;
  };
  subject.addEventListener("input", () => {
    const found = lockSubject();
    if (found) {
      group.value = found.group;
      area.value = found.area;
      type.value = found.type;
      credits.value = found.credits;
      achievement.value = found.achievement;
      credits.dispatchEvent(new Event("input"));
    }
  });
  custom.addEventListener("change", lockSubject);
  exam.addEventListener("input", () => { if (exam.value !== "") perf.value = Math.max(0, 100 - Number(exam.value)); });
  perf.addEventListener("input", () => { if (perf.value !== "") exam.value = Math.max(0, 100 - Number(perf.value)); });
  lockSubject();

  const step2 = h("section", { class: "wz-step", hidden: true },
    h("h3", { class: "wz-h" }, "수업 개설 정보"),
    h("div", { class: "wz-table" },
      row("과목명", h("div", { class: "row" }, subject, sdl,
        h("button", { type: "button", onclick: () => { browse.hidden = !browse.hidden; if (!browse.hidden) drawBrowse(); } }, "찾기")),
        browse, h("label", { class: "switch" }, custom, " 고시외 과목 (목록에 없는 과목 — 직접 적고 아래 칸을 골라요)"))),
    h("div", { class: "wz-table two" },
      row("교과(군)", group), row("교과 영역", area),
      row("과목 선택 구분", type), row("학년도", schoolYear),
      row("학점", credits), row("수업 시수", hoursText), row("성취도", achievement)),
    h("div", { class: "wz-table" },
      row("수업 학기", h("div", { class: "row" }, terms)),
      row("대상 학년", h("div", { class: "row" }, grades.map((x) => h("label", { class: "switch" }, x, ` ${x.value}학년`)),
        h("span", { class: "muted", style: "font-size:0.85rem" }, "고르지 않으면 모든 학년"))),
      row("수강 인원", h("div", { class: "row" }, capacity, "명")),
      row("모집 기간", h("div", { class: "row" }, rStart, rStartT, "~", rEnd, rEndT)),
      row("평가 비율", h("div", { class: "row" }, "지필", exam, "% · 수행", perf, "%")),
      row("수업 소개", desc),
      row("수업계획서", file, c.syllabus ? h("span", { class: "muted", style: "font-size:0.85rem" }, `지금 파일: ${c.syllabus.name} (새로 고르면 바뀌어요)`)
        : h("span", { class: "muted", style: "font-size:0.85rem" }, "PDF·한글·워드, 20MB까지"))));

  /* ───── 3. 회차 정보 ───── */
  const hours = h("input", { type: "number", min: 1, max: 400, value: c.hours || (c.credits || 4) * meta.hours_per_credit, required: true, style: "width:6em" });
  let hoursTouched = !!c.hours && c.hours !== (c.credits || 4) * meta.hours_per_credit;
  hours.addEventListener("input", () => { hoursTouched = true; });
  const unit = h("strong", {}, "");
  credits.addEventListener("input", () => {
    unit.textContent = `${credits.value || "-"}학점`;
    if (!hoursTouched && credits.value) hours.value = Number(credits.value) * meta.hours_per_credit;
  });
  unit.textContent = `${credits.value}학점`;
  const start = h("input", { type: "date", value: c.start_date || "", required: true });
  const end = h("input", { type: "date", value: c.end_date || "", required: true });
  const days = DAYS.map((d, i) => h("input", { type: "checkbox", value: i, checked: (c.class_days || []).includes(i) }));
  const tStart = h("input", { type: "time", value: c.class_start || "16:00" });
  const tEnd = h("input", { type: "time", value: c.class_end || "17:40" });
  const count = h("input", { type: "number", min: 1, max: 200, style: "width:5em" });
  const periodsPer = () => Math.max(1, Math.round((minutes(tEnd.value) - minutes(tStart.value)) / 50));
  const updateCount = () => { count.value = Math.ceil(Number(hours.value || 0) / periodsPer()) || ""; };
  [hours, tStart, tEnd, credits].forEach((el) => el.addEventListener("input", updateCount));
  updateCount();
  let sessions = (c.sessions || []).map((x) => ({ ...x }));
  const sessBox = h("div", { class: "sessions" });
  const drawSessions = () => {
    sessions.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    if (sessions.length) end.value = sessions[sessions.length - 1].date;
    sessBox.replaceChildren(sessions.length ? h("table", { class: "sess-table" },
      h("tr", {}, h("th", {}, "회차"), h("th", {}, "날짜"), h("th", {}, "시간"), h("th", {}, "주제 (선택)"), h("th", {}, "")),
      sessions.map((x, i) => h("tr", {},
        h("td", {}, `${i + 1}`),
        h("td", {}, h("input", { type: "date", value: x.date, onchange: (e) => { x.date = e.target.value; drawSessions(); } }),
          h("small", { class: "muted" }, ` (${DAYS[dayOf(x.date)]})`)),
        h("td", { class: "nowrap" }, h("input", { type: "time", value: x.start, onchange: (e) => { x.start = e.target.value; } }), "~",
          h("input", { type: "time", value: x.end, onchange: (e) => { x.end = e.target.value; } })),
        h("td", {}, h("input", { value: x.topic || "", maxlength: 120, placeholder: `${i + 1}회차`, oninput: (e) => { x.topic = e.target.value; } })),
        h("td", {}, h("button", { type: "button", class: "small danger", onclick: () => { sessions.splice(i, 1); drawSessions(); } }, "삭제"))))) :
      h("p", { class: "muted" }, "요일과 시간을 고르고 '일괄 생성'을 누르면 회차표가 만들어져요. 회차마다 날짜·시간·주제를 고칠 수 있어요."),
    h("div", { class: "row", style: "margin-top:6px" },
      h("button", { type: "button", class: "small", onclick: () => {
        const lastS = sessions[sessions.length - 1];
        sessions.push({ date: lastS ? addDays(lastS.date, 7) : (start.value || addDays(new Date().toISOString().slice(0, 10), 1)), start: tStart.value, end: tEnd.value, topic: "" });
        drawSessions();
      } }, "+ 회차 추가"),
      sessions.length ? h("span", { class: "muted", style: "font-size:0.85rem" }, `모두 ${sessions.length}회차 · ${sessions[0].date.replaceAll("-", ".")} ~ ${sessions[sessions.length - 1].date.replaceAll("-", ".")}`) : null));
  };
  const generate = () => {
    const picked = days.filter((d) => d.checked).map((d) => Number(d.value));
    if (!start.value) { toast("수업 시작일을 먼저 정해 주세요."); start.focus(); return; }
    if (!picked.length) { toast("수업 요일을 하나 이상 골라 주세요."); return; }
    if (minutes(tEnd.value) <= minutes(tStart.value)) { toast("수업 끝나는 시각이 시작 시각보다 늦어야 해요."); return; }
    const n = Number(count.value) || 1;
    if (sessions.length && !confirm(`지금 회차표(${sessions.length}회차)를 지우고 새로 만들까요?`)) return;
    const out = [];
    for (let d = start.value, guard = 0; out.length < n && guard < 800; d = addDays(d, 1), guard++) {
      if (picked.includes(dayOf(d))) out.push({ date: d, start: tStart.value, end: tEnd.value, topic: "" });
    }
    sessions = out;
    drawSessions();
  };
  drawSessions();

  const step3 = h("section", { class: "wz-step", hidden: true },
    h("h3", { class: "wz-h" }, "회차 운영 개요"),
    h("div", { class: "wz-table" },
      row("학점·시수", h("div", { class: "row" }, unit, "(수업 시수", hours, "시간)")),
      row("수업 시작일", start),
      row("수업 요일", h("div", { class: "row" }, days.map((x, i) => h("label", { class: "switch" }, x, ` ${DAYS[i]}`)))),
      row("수업 시간", h("div", { class: "row" }, tStart, "~", tEnd)),
      row("회차 수", h("div", { class: "row" }, count, "회", h("button", { type: "button", class: "primary", onclick: generate }, "일괄 생성"),
        h("span", { class: "muted", style: "font-size:0.85rem" }, "이수 시간과 한 번의 수업 길이(50분 = 1차시)로 계산돼요"))),
      row("수업 종료일", end, h("span", { class: "muted", style: "font-size:0.85rem" }, "회차를 만들면 마지막 회차 날짜로 채워져요"))),
    h("h3", { class: "wz-h" }, "회차표"), sessBox);

  /* ───── 단계 이동 ───── */
  const stepEls = [step1, step2, step3];
  const labels = ["1. 학교 및 교사 정보", "2. 수업 개설 정보", "3. 회차 정보"];
  let cur = 0;
  const bar = h("div", { class: "wz-steps" });
  const err = h("p", { class: "error" });
  const prev = h("button", { type: "button" }, "← 이전");
  const next = h("button", { type: "button", class: "primary" }, "다음 →");
  const submit = h("button", { type: "submit", class: "primary" }, isNew ? "수업 개설 신청" : "저장");
  const go = (n) => {
    cur = n;
    stepEls.forEach((el, i) => { el.hidden = i !== n; });
    bar.replaceChildren(...labels.map((l, i) => h("button", { type: "button", class: `wz-step-btn ${i <= n ? "on" : ""} ${i === n ? "now" : ""}`,
      onclick: () => { if (i < n || validStep(n)) go(i); } }, l)));
    prev.hidden = n === 0;
    next.hidden = n === 2;
    submit.hidden = n !== 2;
    err.textContent = "";
    bar.scrollIntoView({ block: "nearest" });
  };
  const validStep = (n) => {
    for (const el of stepEls[n].querySelectorAll("input, select, textarea")) {
      if (!el.disabled && !el.checkValidity()) { el.reportValidity(); return false; }
    }
    if (n === 0 && !hubSel.value) { err.textContent = "거점학교를 골라 주세요. 거점학교 없이는 수업을 열 수 없어요."; return false; }
    if (n === 1 && Number(exam.value) + Number(perf.value) !== 100) { err.textContent = "지필평가와 수행평가 비율을 더하면 100%가 되어야 해요."; return false; }
    return true;
  };
  prev.addEventListener("click", () => go(cur - 1));
  next.addEventListener("click", () => { if (validStep(cur)) go(cur + 1); });

  // 칸에서 엔터를 쳐도 개설·저장되지 않게: 버튼을 눌렀을 때만
  let enterAt = 0;
  const form = h("form", { class: "course-form-full wizard", novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (performance.now() - enterAt < 500) return;
    for (let i = 0; i < 3; i++) if (!validStep(i)) { if (cur !== i) go(i); validStep(i); return; }
    if (!sessions.length && !end.value) { err.textContent = "수업 종료일을 정하거나 회차를 만들어 주세요."; return; }
    const body = {
      title: subject.value.trim(), subject: subject.value.trim(), custom_subject: custom.checked,
      subject_group: group.value, subject_area: area.value, subject_type: type.value,
      school_year: Number(schoolYear.value), term: form.querySelector(`input[name="${termName}"]:checked`)?.value || meta.terms[0],
      credits: Number(credits.value), hours: Number(hours.value), achievement: achievement.value,
      grades: grades.filter((x) => x.checked).map((x) => Number(x.value)), capacity: Number(capacity.value),
      recruit_start: rStart.value, recruit_start_time: rStartT.value, recruit_end: rEnd.value, recruit_end_time: rEndT.value,
      start_date: start.value, end_date: end.value, exam_ratio: Number(exam.value), perf_ratio: Number(perf.value),
      instructor: instructorName, description: desc.value.trim(),
      contact_email: emailText, contact_phone: phoneText, show_email: showEmail.checked, show_phone: showPhone.checked,
      schools: joined, team_teaching: team.checked, co_teachers: team.checked ? [...coChosen] : [],
      class_days: days.filter((x) => x.checked).map((x) => Number(x.value)), class_start: tStart.value, class_end: tEnd.value,
      sessions: sessions.map((x) => ({ date: x.date, start: x.start || "", end: x.end || "", topic: x.topic || "" })),
    };
    // 거점학교 (새로 만들 때와 고칠 때 모두): 승인받은 거점학교는 번호로, 그 밖에는 울산 고등학교 이름으로
    const hid = byName ? (leadHubs.find((x) => x.name === hubSel.value)?.id || null) : Number(hubSel.value);
    if (isNew) {
      body.hub_id = hid;
      body.hub_school = hid ? "" : hubSel.value;
    } else if (hubSel.value !== (byName ? c.hub_school : String(c.hub_id))) {
      if (hid) body.hub_id = hid; else body.hub_school = hubSel.value;
    }
    try {
      let id = c.id;
      if (isNew) ({ id } = await api("/api/courses", body));
      else await api(`/api/courses/${c.id}`, body);
      if (file.files[0]) {
        const f = file.files[0];
        const res = await fetch(`/api/courses/${id}/syllabus?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
        if (!res.ok) toast(`수업은 저장했지만 수업계획서를 올리지 못했어요: ${(await res.json().catch(() => ({}))).detail || res.status}`, 6000);
      }
      done(id);
    } catch (e2) { err.textContent = e2.message; }
  } },
    isNew ? null : h("h2", { class: "wz-title" }, `수업 정보 수정 · ${c.title}`),
    bar, step1, step2, step3, err,
    h("div", { class: "row wz-nav" }, prev, h("span", { class: "grow" }),
      isNew ? null : h("button", { type: "button", onclick: () => done(null) }, "취소"), next, submit));
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") enterAt = performance.now();
  });
  go(0);
  return form;
}

/** 강좌 안내 (학생·선생님 화면 공통): 과목·학점·평가·모집·일정 */
function courseFacts(c) {
  const rows = [];
  if (c.subject && c.subject !== c.title) rows.push(["과목", c.subject]);
  if (c.subject_area || c.subject_type) {
    rows.push(["교과", [c.subject_group, c.subject_area, c.custom_subject ? "고시외 과목" : c.subject_type].filter(Boolean).join(" · ")]);
  }
  if (c.term) rows.push(["학기", `${c.school_year || ""}학년도 ${c.term}`]);
  if (c.credits) rows.push(["학점", `${c.credits}학점 (${c.hours}시간)`]);
  if (c.class_days?.length) rows.push(["수업 시간", `매주 ${c.class_days.map((d) => DAYS[d]).join("·")} ${c.class_start || ""}~${c.class_end || ""}`]);
  if (c.sessions?.length) rows.push(["회차", `${c.sessions.length}회 (${fmtDate(c.sessions[0].date)} ~ ${fmtDate(c.sessions[c.sessions.length - 1].date)})`]);
  if (c.achievement_text) rows.push(["성취도", c.achievement_text]);
  if (c.exam_ratio != null && c.perf_ratio != null) rows.push(["평가", `지필 ${c.exam_ratio}% · 수행 ${c.perf_ratio}%`]);
  if (c.recruit_start || c.recruit_end) {
    rows.push(["모집 기간", `${fmtDate(c.recruit_start)} ${c.recruit_start_time || ""} ~ ${fmtDate(c.recruit_end)} ${c.recruit_end_time || ""}`]);
  }
  if (c.capacity) rows.push(["수강 인원", `${c.capacity}명`]);
  if (c.schools?.length) rows.push(["참여 학교", c.schools.join(", ")]);
  if (c.team_teaching) rows.push(["팀티칭", c.co_teachers?.length ? `보조교사 ${c.co_teachers.map((x) => x.name).join(", ")}` : "예"]);
  const contact = [c.show_email !== false && c.contact_email, c.show_phone !== false && c.contact_phone].filter(Boolean);
  if (contact.length) rows.push(["연락처", contact.join(" · ")]);
  if (!rows.length && !c.syllabus) return null;
  const dl = h("dl", { class: "facts" }, rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]),
    c.syllabus ? [h("dt", {}, "수업계획서"), h("dd", {}, h("a", { href: c.syllabus.url, target: "_blank" }, `📄 ${c.syllabus.name}`))] : null);
  if (!c.sessions?.length) return dl;
  return h("div", {}, dl,
    h("table", { class: "sess-table view" }, h("tr", {}, h("th", {}, "회차"), h("th", {}, "날짜"), h("th", {}, "시간"), h("th", {}, "주제")),
      c.sessions.map((x) => h("tr", {}, h("td", {}, x.no), h("td", {}, `${fmtDate(x.date)} (${DAYS[dayOf(x.date)]})`),
        h("td", {}, x.start ? `${x.start}~${x.end}` : ""), h("td", {}, x.topic)))));
}
