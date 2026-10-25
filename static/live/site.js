/* 외솔온닷 공통 머리글: 로고 + 상단 메뉴. 모든 화면 맨 위에 붙는다. */
(function () {
  const MENU = [
    ["/live/about", "외솔온닷 소개"],
    ["/live/credit", "고교학점제"],
    ["/live/guide", "수강안내"],
    ["/live/courses", "수업신청"],
    ["/live/help", "이용안내"],
    ["/live", "마이페이지"],
  ];
  const path = location.pathname.replace(/\/$/, "");
  const active = (href) => (href === "/live" ? path === "/live" || path.startsWith("/live/materials") : path === href);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    for (const k of kids) n.append(k);
    return n;
  };
  const logo = el("a", { class: "brand", href: "/live/home", "aria-label": "외솔온닷 처음으로" },
    el("span", { class: "brand-mark", "aria-hidden": "true" }),
    el("span", { class: "brand-a" }, "외솔"), el("span", { class: "brand-b" }, "온닷"));
  const nav = el("nav", { class: "site-nav", "aria-label": "주 메뉴" },
    ...MENU.map(([href, label]) => el("a", { href, class: active(href) ? "on" : "" }, label)));
  // 오른쪽 위: 로그인 전에는 '로그인', 로그인하면 이름(역할) · 내 정보 · 로그아웃 — 사이트 전체에서 여기에만 보인다
  const user = el("div", { class: "site-user-box" });
  const header = el("header", { class: "site-header" }, el("div", { class: "site-header-in" }, logo, nav, user));
  document.body.prepend(header);

  const roleName = (u) => (u.is_admin ? "전체 관리자" : u.coordinator_hubs?.length ? "관리교사" : u.role_choice ? "가입 중"
    : { teacher: "강사", student: "학생", guest: "등록 신청" }[u.role] || "");
  function render(u) {
    user.replaceChildren();
    if (!u) {
      user.append(el("a", { class: "site-user", href: "/live" }, "로그인"));
      return;
    }
    const name = el("a", { class: "site-me", href: "/live", title: "마이페이지" },
      el("strong", {}, `${u.display || u.name || u.email.split("@")[0]}`), el("span", {}, roleName(u)));
    const info = el("button", { type: "button", class: "small" }, "내 정보");
    info.addEventListener("click", () => {
      if (typeof window.showProfile === "function" && path === "/live") window.showProfile();
      else location.href = "/live?profile=1";
    });
    const out = el("button", { type: "button", class: "small" }, "로그아웃");
    out.addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      try { google.accounts.id.disableAutoSelect(); } catch { /* 구글 스크립트 없음 */ }
      location.href = "/live/home";
    });
    if (u.needs_profile) info.hidden = true; // 가입 중에는 마이페이지가 바로 내 정보 화면
    user.append(name, info, out);
  }
  // 마이페이지에서 로그인·정보 수정을 하면 여기를 다시 그린다
  window.WaesolHeader = { render };
  fetch("/api/me").then((r) => r.json()).then(({ user: u }) => render(u)).catch(() => render(null));
})();
