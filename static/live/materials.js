/* 지난 수업 자료: 목록(/live/materials)과 보기(/live/materials?class=번호) */
const qs = new URLSearchParams(location.search);
const classId = Number(qs.get("class")) || null;
if (qs.get("from") === "courses") {
  $("#m-back").href = "/live?classroom=1&tab=courses";
  $("#m-back").textContent = "← 내 강좌";
}

async function showList() {
  const box = $("#m-list");
  try {
    const { classes } = await api("/api/materials");
    if (!classes.length) {
      box.replaceChildren(h("p", { class: "muted" }, "아직 볼 수 있는 수업 자료가 없어요."));
      return;
    }
    box.replaceChildren(...classes.map((c) => h("a", { class: "card material-item", href: `/live/materials?class=${c.id}` },
      h("div", { class: "muted", style: "font-size:0.85rem" }, `${c.date.replaceAll("-", ".")}${c.course_title ? ` · ${c.course_title}` : ""}${c.live ? " · 진행 중" : ""}`),
      h("strong", {}, c.title),
      h("div", { class: "muted", style: "font-size:0.85rem" },
        [c.files ? `📄 자료 ${c.files}개` : "", c.whiteboard ? "🖊️ 화이트보드" : ""].filter(Boolean).join(" · ")))));
  } catch (err) {
    if (err.status === 401) location.replace("/live");
    $("#m-error").textContent = err.message;
  }
}

async function showViewer() {
  let data;
  try {
    data = await api(`/api/materials/class/${classId}`);
  } catch (err) {
    if (err.status === 401) return location.replace("/live");
    $("#m-error").textContent = err.message;
    return;
  }
  $("#m-title").textContent = data.class.title;
  $("#m-sub").textContent = `${data.class.date.replaceAll("-", ".")}${data.class.course_title ? ` · ${data.class.course_title}` : ""} · 선생님이 띄운 자료와 판서예요.`;
  $("#m-viewer").hidden = false;
  const presenter = new Presenter($("#m-present"), { canDraw: false, send: () => {}, fileUrl: (fid) => `/api/materials/file/${fid}` });
  for (const [key, list] of Object.entries(data.boards)) presenter.setStrokes(key, list);

  // 볼 것: PDF 자료들 + 화이트보드
  const items = data.files.map((f) => ({ mode: "slides", file: f.id, name: f.name, pages: f.pages }));
  if (data.board_pages) items.push({ mode: "board", name: "화이트보드", pages: data.board_pages });
  if (!items.length) {
    $("#m-viewer").replaceChildren(h("p", { class: "muted" }, "남아 있는 자료가 없어요."));
    return;
  }
  let cur = 0;
  let page = 1;

  async function open(i, p = 1) {
    cur = i;
    const it = items[i];
    if (it.mode === "slides" && !it.pages) it.pages = await presenter.pageCount(it.file).catch(() => 1);
    page = Math.min(Math.max(1, p), it.pages || 1);
    const key = it.mode === "board" ? `wb:${page}` : `${it.file}:${page}`;
    await presenter.setView({ mode: it.mode, file: it.file, page, pages: it.pages, key });
    presenter.redrawInk();
    render();
  }

  function render() {
    const it = items[cur];
    $("#m-items").replaceChildren(...items.map((x, i) => h("button", {
      class: `small ${i === cur ? "primary" : ""}`, onclick: () => open(i),
    }, x.mode === "board" ? "🖊️ 화이트보드" : `📄 ${x.name}`)));
    const inked = (k) => (data.boards[k] || []).length > 0;
    $("#m-bar").replaceChildren(...[
      h("button", { class: "small", disabled: page <= 1, onclick: () => open(cur, page - 1), title: "이전 쪽 (←)" }, "◀"),
      h("span", { class: "pageno" }, `${page} / ${it.pages || "?"}`),
      h("button", { class: "small", disabled: page >= it.pages, onclick: () => open(cur, page + 1), title: "다음 쪽 (→)" }, "▶"),
      h("span", { class: "muted", style: "font-size:0.85rem" },
        it.mode === "slides" && inked(`${it.file}:${page}`) ? "🖊️ 이 쪽에 선생님 판서가 있어요" : ""),
      h("span", { class: "grow" }),
      it.mode === "slides" ? h("a", { class: "button small", href: `/api/materials/file/${it.file}`, target: "_blank" }, "PDF 열기") : null,
      data.can_delete && it.mode === "slides" ? h("button", { class: "small danger", onclick: async () => {
        if (!confirm(`'${it.name}' 자료를 지울까요? 학생들도 더 이상 볼 수 없어요. (그 위 판서도 함께 지워져요)`)) return;
        try { await api(`/api/materials/file/${it.file}/delete`, {}); location.reload(); } catch (err) { toast(err.message); }
      } }, "지우기") : null].filter(Boolean));
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") open(cur, page + 1);
    if (e.key === "ArrowLeft") open(cur, page - 1);
  });
  open(0);
}

if (classId) showViewer();
else showList();
