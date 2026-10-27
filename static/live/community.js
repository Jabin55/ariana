/* 소통마당: 비회원 글쓰기, 관리자 삭제. 글 본문은 서버에서 HTML 이스케이프해 표시한다. */
(async function () {
  const $ = (id) => document.getElementById(id);
  let user = null;
  try { user = (await (await fetch("/api/me")).json()).user; } catch { /* 비회원으로 표시 */ }

  async function post(url, body) {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "처리하지 못했어요.");
    return data;
  }

  const write = $("community-write");
  if (write) write.addEventListener("click", () => {
    write.hidden = true;
    const box = $("community-editor");
    box.innerHTML = `<section class="info-block notice-editor">
      <h2>소통마당 글쓰기</h2>
      <p class="muted">공개 게시글입니다. 학생 이름·학번·연락처 등 개인정보를 적지 마세요.</p>
      <label data-community="nickname-wrap">표시할 이름 <input data-community="nickname" maxlength="30" placeholder="익명"></label>
      <label>제목 <input data-community="title" maxlength="120" required></label>
      <label>내용 <textarea data-community="body" rows="9" maxlength="10000" required></textarea></label>
      <p class="error" data-community="error" role="alert"></p>
      <div class="row"><button class="primary" type="button" data-community="submit">올리기</button>
      <button type="button" data-community="cancel">취소</button></div>
    </section>`;
    const get = (key) => box.querySelector(`[data-community="${key}"]`);
    get("cancel").addEventListener("click", () => { box.replaceChildren(); write.hidden = false; });
    get("submit").addEventListener("click", async () => {
      const title = get("title").value.trim(), body = get("body").value.trim();
      if (!title || !body) { get("error").textContent = "제목과 내용을 적어 주세요."; return; }
      const button = get("submit");
      button.disabled = true;
      try {
        const result = await post("/api/community", {
          title, body, nickname: get("nickname").value.trim(),
        });
        location.href = `/live/community/${result.id}`;
      } catch (e) { get("error").textContent = e.message; button.disabled = false; }
    });
    get("title").focus();
  });

  const remove = $("community-delete");
  if (remove && user?.is_admin) {
    remove.hidden = false;
    remove.addEventListener("click", async () => {
      if (!confirm("이 글을 삭제할까요?")) return;
      try {
        await post(`/api/admin/community/${remove.dataset.id}/delete`, {});
        location.href = "/live/community";
      } catch (e) { alert(e.message); }
    });
  }
})();
