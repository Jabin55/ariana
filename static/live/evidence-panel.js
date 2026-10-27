/* [참여학교 담당] 안에서 탈퇴자 증빙을 조회한다. 서버가 학교별 권한을 검사한다. */
window.renderEvidence = function (box) {
  box.innerHTML = `<section class="card" style="margin-top:12px">
    <h2>탈퇴자 증빙</h2>
    <p class="muted">수업 증빙에 필요한 경우에만 조회하세요. 목록·열람·다운로드 사유와 시각이 기록됩니다.</p>
    <p data-ev="policy" class="banner warn" hidden></p>
    <div class="row"><label>조회 사유 <select data-ev="purpose">
      <option value="">사유 선택</option><option value="record_check">수업 기록 확인</option>
      <option value="certificate">증빙서류 발급</option><option value="appeal">이의 신청 처리</option>
    </select></label>
    <label>학교 <input data-ev="school" maxlength="60" placeholder="전체 또는 학교명"></label>
    <button data-ev="search" type="button">조회</button></div>
    <p data-ev="error" class="error" role="alert"></p>
    <div data-ev="results"></div>
    <section data-ev="detail" hidden><h3>증빙 기록</h3>
      <a data-ev="download" href="#">ZIP 내려받기</a>
      <pre data-ev="record" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
    </section></section>`;
  const get = (key) => box.querySelector(`[data-ev="${key}"]`);
  const purpose = () => get("purpose").value;
  const error = (message) => { get("error").textContent = message; };
  const date = (seconds) => seconds ? new Date(seconds * 1000).toLocaleString("ko-KR") : "미정";
  async function read(url) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "조회에 실패했습니다.");
    return data;
  }
  async function detail(id) {
    error("");
    try {
      const data = await read(`/api/evidence/${encodeURIComponent(id)}?purpose=${encodeURIComponent(purpose())}`);
      get("record").textContent = JSON.stringify(data.record, null, 2);
      get("download").href = `/api/evidence/${encodeURIComponent(id)}/download.zip?purpose=${encodeURIComponent(purpose())}`;
      get("detail").hidden = false;
    } catch (e) { error(e.message); }
  }
  get("search").addEventListener("click", async () => {
    error("");
    get("detail").hidden = true;
    get("results").replaceChildren();
    if (!purpose()) { error("조회 사유를 선택해 주세요."); return; }
    try {
      const params = new URLSearchParams({ purpose: purpose(), school: get("school").value.trim() });
      const data = await read(`/api/evidence?${params}`);
      get("policy").hidden = !!data.policy.days;
      get("policy").textContent = data.policy.days ? "" : "증빙 보존기간과 근거가 아직 정해지지 않았습니다. 운영 기관에서 확정해야 합니다.";
      if (!data.archives.length) { get("results").textContent = "조회할 증빙이 없습니다."; return; }
      const table = document.createElement("table");
      table.className = "att";
      const head = document.createElement("tr");
      for (const name of ["학교", "학번", "이름", "탈퇴 승인", "보존 만료", ""]) {
        const th = document.createElement("th"); th.textContent = name; head.append(th);
      }
      table.append(head);
      for (const item of data.archives) {
        const row = document.createElement("tr");
        for (const value of [item.subject.school, item.subject.student_no, item.subject.name,
                             date(item.created_at), date(item.expires_at)]) {
          const cell = document.createElement("td"); cell.textContent = value || ""; row.append(cell);
        }
        const cell = document.createElement("td");
        const button = document.createElement("button");
        button.type = "button"; button.textContent = "기록 보기";
        button.addEventListener("click", () => detail(item.id));
        cell.append(button); row.append(cell); table.append(row);
      }
      get("results").append(table);
    } catch (e) { error(e.message); }
  });
};
