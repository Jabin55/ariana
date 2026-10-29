/* 앱처럼 설치하기: 서비스 워커 등록 + 머리글의 [앱 설치] 버튼 (설치할 수 있는 브라우저에서만 보인다) */
(function () {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* 설치 기능만 빠질 뿐 사이트는 그대로 쓴다 */ });
  }
  let prompt = null;
  let btn = null;
  const installed = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const place = () => {
    const box = document.querySelector(".site-header-in .site-user-box");
    if (!prompt || installed() || !box || btn) return;
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "small app-install-btn";
    btn.textContent = "앱 설치";
    btn.title = "외솔온닷을 컴퓨터·휴대폰에 앱처럼 설치해요 (바탕화면 아이콘으로 바로 열기)";
    btn.addEventListener("click", async () => {
      if (!prompt) return;
      prompt.prompt();
      await prompt.userChoice.catch(() => null);
      prompt = null;
      btn.remove();
      btn = null;
    });
    box.before(btn);
  };
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // 브라우저 기본 안내 대신 머리글 버튼으로
    prompt = e;
    place();
  });
  addEventListener("appinstalled", () => { prompt = null; btn?.remove(); btn = null; });
  addEventListener("DOMContentLoaded", place);
})();
