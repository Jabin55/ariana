(function () {
  const $ = (id) => document.getElementById(id);
  const purpose = () => $("purpose").value;
  const error = (message) => { $("error").textContent = message; };
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
      $("record").textContent = JSON.stringify(data.record, null, 2);
      $("download").href = `/api/evidence/${encodeURIComponent(id)}/download.zip?purpose=${encodeURIComponent(purpose())}`;
      $("detail").hidden = false;
    } catch (e) { error(e.message); }
  }

  $("search").addEventListener("click", async () => {
    error("");
    $("detail").hidden = true;
    $("results").replaceChildren();
    if (!purpose()) { error("조회 사유를 선택해 주세요."); return; }
    try {
      const params = new URLSearchParams({ purpose: purpose(), school: $("school").value.trim() });
      const data = await read(`/api/evidence?${params}`);
      $("policy").hidden = !!data.policy.days;
      $("policy").textContent = data.policy.days ? "" : "증빙 보존기간과 근거가 아직 정해지지 않았습니다. 운영 기관에서 확정해야 합니다.";
      if (!data.archives.length) { $("results").textContent = "조회할 증빙이 없습니다."; return; }
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
      $("results").append(table);
    } catch (e) { error(e.message); }
  });
})();
