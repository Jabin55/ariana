/* 공지사항 페이지: 선생님에게만 [글쓰기], 내가 쓴 글(전체 관리자는 모든 글)에 [수정][삭제] */
(function () {
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, "");
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    n.append(...kids.flat().filter((x) => x != null && x !== false));
    return n;
  };
  const post = async (url, body) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || "저장하지 못했어요.");
    return data;
  };

  /** 글쓰기·수정 칸 */
  function editor(me, cur, done) {
    const title = el("input", { maxlength: 120, placeholder: "제목", value: cur?.title || "" });
    const body = el("textarea", { rows: 10, maxlength: 20000, placeholder: "내용" });
    body.value = cur?.body || "";
    const pinned = el("input", { type: "checkbox" });
    pinned.checked = !!cur?.pinned;
    const err = el("p", { class: "error" });
    // 첨부 파일: 고르면 바로 올리고, [올리기/수정 저장] 때 이 글에 붙는다
    const files = [...(cur?.files || [])];
    const fileList = el("ul", { class: "notice-files edit" });
    const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
    const drawFiles = () => fileList.replaceChildren(...files.map((f) => el("li", {},
      `📎 ${f.name} `, el("span", { class: "muted" }, `(${kb(f.size)})`), " ",
      el("button", { type: "button", class: "small", onclick: () => { files.splice(files.indexOf(f), 1); drawFiles(); } }, "빼기"))));
    const picker = el("input", { type: "file", multiple: true, hidden: true });
    const uploading = el("span", { class: "muted" });
    picker.addEventListener("change", async () => {
      err.textContent = "";
      const chosen = [...picker.files]; // 올리는 동안 목록이 바뀌지 않게 먼저 복사
      for (const file of chosen) {
        if (files.length >= 10) { err.textContent = "파일은 10개까지 붙일 수 있어요."; break; }
        uploading.textContent = `올리는 중… ${file.name}`;
        try {
          const r = await fetch(`/api/admin/notices/files?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(`${file.name}: ${d.detail || "올리지 못했어요."}`);
          files.push(d);
          drawFiles();
        } catch (e) { err.textContent = e.message; }
      }
      uploading.textContent = "";
      picker.value = "";
    });
    drawFiles();
    const box = el("section", { class: "info-block notice-editor" },
      el("h2", {}, cur ? "공지 수정" : "공지 쓰기"),
      el("label", {}, "제목", title), el("label", {}, "내용", body),
      el("div", { class: "notice-attach" }, el("div", { class: "row" }, el("strong", {}, "첨부 파일"),
        el("button", { type: "button", class: "small", onclick: () => picker.click() }, "📎 파일 첨부"), uploading, picker),
        el("span", { class: "muted", style: "font-size:0.85rem" }, "한 파일 20MB, 10개까지 (PDF·한글·오피스·그림·ZIP 등)"), fileList),
      me.is_admin ? el("label", { class: "switch" }, pinned, " 맨 위에 고정") : null,
      err,
      el("div", { class: "row" },
        el("button", { class: "primary", type: "button", onclick: async () => {
          if (!title.value.trim()) { title.focus(); return; }
          try {
            const r = await post("/api/admin/notices", { id: cur?.id || null, title: title.value, body: body.value, pinned: pinned.checked, files: files.map((f) => f.id) });
            location.href = `/live/notices/${r.id}`;
          } catch (e) { err.textContent = e.message; }
        } }, cur ? "수정 저장" : "올리기"),
        el("button", { type: "button", onclick: done }, "취소")));
    setTimeout(() => title.focus(), 0);
    return box;
  }

  async function start() {
    let me = null;
    try { me = (await (await fetch("/api/me")).json()).user; } catch { return; }
    if (!me || me.role !== "teacher") return;
    const tools = $("#notice-tools");
    const view = $("#notice-view");
    if (!view) { // 목록: [글쓰기]
      const list = document.querySelector(".info-block");
      const btn = el("button", { class: "primary", onclick: () => {
        tools.replaceChildren(editor(me, null, () => { tools.replaceChildren(wrap); }));
      } }, "✏️ 글쓰기");
      const wrap = el("div", { class: "row notice-actions" }, el("span", { class: "grow" }), btn);
      tools.replaceChildren(wrap);
      list?.before(tools);
      return;
    }
    // 글 보기: 내가 쓴 글이거나 전체 관리자면 [수정][삭제]
    const id = Number(view.dataset.id);
    if (!(me.is_admin || Number(view.dataset.author) === me.id)) return;
    tools.replaceChildren(
      el("button", { onclick: async () => {
        const { notices } = await (await fetch("/api/notices")).json();
        const cur = notices.find((n) => n.id === id);
        view.hidden = true;
        tools.hidden = true; // 고치는 동안에는 [수정][삭제]를 숨긴다
        view.after(editor(me, cur, () => location.reload()));
      } }, "✏️ 수정"),
      el("button", { class: "danger", onclick: async () => {
        if (!confirm("이 공지를 지울까요? 되살릴 수 없어요.")) return;
        try { await post(`/api/admin/notices/${id}/delete`, {}); location.href = "/live/notices"; } catch (e) { alert(e.message); }
      } }, "🗑 삭제"));
  }
  start();
})();
