/* 로그인 유지 신호: 화면이 열려 있는 동안 30초마다 서버에 알린다.
   '자동 로그인'을 안 고른 로그인은 이 신호가 끊기면(브라우저를 닫으면) 로그아웃된다. */
(function () {
  if (window.__keepalive) return;
  window.__keepalive = true;
  let wasIn = null;
  async function ping() {
    try {
      const r = await fetch("/api/auth/ping", { method: "POST", credentials: "same-origin", cache: "no-store" });
      const { user } = await r.json();
      if (wasIn && !user) location.replace("/live?login=1"); // 로그인이 끝났으면 로그인 화면으로
      wasIn = user;
    } catch { /* 인터넷이 잠깐 끊김: 다음에 다시 */ }
  }
  ping();
  setInterval(ping, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ping(); });
})();
