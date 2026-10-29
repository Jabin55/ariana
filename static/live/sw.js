/* 외솔온닷 앱(설치형)용 서비스 워커.
   화면·자료는 저장해 두지 않고 늘 서버에서 새로 받는다 → 서버를 고치면 앱도 바로 최신이 된다.
   인터넷이 끊겼을 때만 안내 화면을 보여 준다. */
const OFFLINE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>외솔온닷</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#1d2330;text-align:center;padding:24px}
button{font:inherit;padding:10px 20px;border-radius:10px;border:0;background:#1b6b4a;color:#fff;cursor:pointer}</style></head>
<body><div><h1 style="font-size:1.3rem">인터넷에 연결되어 있지 않아요</h1><p>연결을 확인한 뒤 다시 시도해 주세요.</p>
<button onclick="location.reload()">다시 시도</button></div></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return; // 화면 이동만 지켜보고, 나머지는 브라우저가 평소처럼 처리
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
