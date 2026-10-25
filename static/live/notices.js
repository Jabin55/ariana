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
    const box = el("section", { class: "info-block notice-editor" },
      el("h2", {}, cur ? "공지 수정" : "공지 쓰기"),
      el("label", {}, "제목", title), el("label", {}, "내용", body),
      me.is_admin ? el("label", { class: "switch" }, pinned, " 맨 위에 고정") : null,
      err,
      el("div", { class: "row" },
        el("button", { class: "primary", type: "button", onclick: async () => {
          if (!title.value.trim()) { title.focus(); return; }
          try {
            const r = await post("/api/admin/notices", { id: cur?.id || null, title: title.value, body: body.value, pinned: pinned.checked });
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
        view.after(editor(me, cur, () => location.reload()));
      } }, "✏️ 수정"),
      el("button", { class: "danger", onclick: async () => {
        if (!confirm("이 공지를 지울까요? 되살릴 수 없어요.")) return;
        try { await post(`/api/admin/notices/${id}/delete`, {}); location.href = "/live/notices"; } catch (e) { alert(e.message); }
      } }, "🗑 삭제"));
  }
  start();
})();
