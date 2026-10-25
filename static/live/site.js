/* 외솔온닷 공통 머리글: 로고 + 상단 메뉴. 모든 화면 맨 위에 붙는다. */
(function () {
  const MENU = [
    ["/live/about", "외솔온닷 소개"],
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
  const logo = el("a", { class: "brand", href: "/live/about", "aria-label": "외솔온닷 처음으로" },
    el("span", { class: "brand-mark", "aria-hidden": "true" }),
    el("span", { class: "brand-a" }, "외솔"), el("span", { class: "brand-b" }, "온닷"));
  const nav = el("nav", { class: "site-nav", "aria-label": "주 메뉴" },
    ...MENU.map(([href, label]) => el("a", { href, class: active(href) ? "on" : "" }, label)));
  const user = el("a", { class: "site-user", href: "/live" }, "로그인");
  const header = el("header", { class: "site-header" }, el("div", { class: "site-header-in" }, logo, nav, user));
  document.body.prepend(header);
  fetch("/api/me").then((r) => r.json()).then(({ user: u }) => {
    if (!u) return;
    user.textContent = `${u.name || u.email.split("@")[0]}님`;
    user.title = "마이페이지";
  }).catch(() => {});
})();
