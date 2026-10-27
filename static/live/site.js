/* 외솔온닷 공통 머리글: 로고 + 상단 메뉴. 모든 화면 맨 위에 붙는다. */
(function () {
  const path = location.pathname.replace(/\/$/, "");
  const policyMode = ["/live/terms", "/live/privacy", "/live/notice"].includes(path);
  const MENU = policyMode ? [
    ["/live/terms", "이용약관"],
    ["/live/privacy", "개인정보 처리방침"],
    ["/live/notice", "보호자 안내문"],
  ] : [
    ["/live/about", "외솔온닷 소개"],
    ["/live/notices", "정보마당"],
    ["/live/courses", "수강신청"],
    ["/live?classroom=1", "강의실"],
    ["/live?office=1", "교무실"], // 선생님 화면 (학생이 누르면 '접근 권한이 없습니다.')
  ];
  const SUBMENUS = {
    about: [["/live/about", "기본방향"], ["/live/joint", "공동교육과정"], ["/live/credit", "고교학점제"], ["/live/sitemap", "사이트맵"]],
    info: [["/live/notices", "공지사항"], ["/live/guide", "수강안내"], ["/live/help", "이용안내"], ["/live/community", "소통마당"]],
    enroll: [["/live/courses", "수강신청"], ["/live/course-requests", "희망과목 개설 신청"]],
  };
  const params = new URLSearchParams(location.search);
  const group = ["/live/about", "/live/joint", "/live/credit", "/live/sitemap"].includes(path) ? "about"
    : ["/live/notices", "/live/guide", "/live/help", "/live/community"].includes(path) || path.startsWith("/live/notices/") || path.startsWith("/live/community/") ? "info"
      : ["/live/courses", "/live/course-requests"].includes(path) ? "enroll" : "";
  const active = (href, u) => {
    if (policyMode) return href === path;
    if (href === "/live/about") return group === "about";
    if (href === "/live/notices") return group === "info";
    if (href === "/live/courses") return group === "enroll";
    if (href === "/live?classroom=1") return path.startsWith("/live/student/") ||
      (path.startsWith("/live/materials") && u?.role === "student") ||
      (path === "/live" && (params.has("classroom") || (!params.has("office") && u?.role === "student")));
    return path.startsWith("/live/teacher/") ||
      (path.startsWith("/live/materials") && (u?.role === "teacher" || u?.is_admin)) ||
      (path === "/live" && (params.has("office") || (!params.has("classroom") && (u?.role === "teacher" || u?.is_admin))));
  };
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    for (const k of kids) n.append(k);
    return n;
  };
  const logo = el("a", { class: "brand", href: "/live/home", "aria-label": "외솔온닷 처음으로" },
    el("span", { class: "brand-mark", "aria-hidden": "true" }),
    el("span", { class: "brand-a" }, "외솔"), el("span", { class: "brand-b" }, "온닷"));
  const policyTitle = policyMode ? el("span", { class: "policy-header-title" }, "이용 약관 및 개인정보 보호") : null;
  const nav = el("nav", { class: "site-nav", "aria-label": "주 메뉴" },
    ...MENU.map(([href, label]) => el("a", { href }, label)));
  // 오른쪽 위: 로그인 전에는 '로그인'·'회원가입', 로그인하면 이름(역할) · 내 정보 · 로그아웃
  const user = el("div", { class: "site-user-box" });
  // 위: 외솔온닷 로고 + (오른쪽) 이름·내 정보·로그아웃 / 아래: 메뉴 바 (내려도 위에 붙어 있다)
  const header = el("header", { class: "site-header" }, el("div", { class: "site-header-in" },
    logo, ...(policyTitle ? [policyTitle] : []), el("span", { class: "grow" }), user));
  const menuInner = el("div", { class: "site-menu-in" }, nav);
  const menu = el("div", { class: "site-menu" }, menuInner);
  if (policyMode) menu.classList.add("policy-menu");
  document.body.prepend(header, menu);
  const officeTabs = path === "/live" ? document.getElementById("home-tabs") : null;
  const studentTabs = path === "/live" ? document.getElementById("student-tabs") : null;
  const subBand = group || officeTabs || studentTabs ? el("div", { class: "site-submenu-band" }) : null;
  const subInner = subBand ? el("div", { class: "site-submenu-inner" }) : null;
  if (subBand) { subBand.append(subInner); menu.append(subBand); menu.classList.add("has-submenu"); }
  if (officeTabs) {
    officeTabs.setAttribute("aria-label", "교무실 세부 메뉴");
    officeTabs.hidden = document.getElementById("teacher-view").hidden;
    subBand.id = "office-submenu-band";
    subBand.hidden = officeTabs.hidden;
    subInner.append(officeTabs);
  }
  if (studentTabs) {
    studentTabs.style.setProperty("--sub-count", "2");
    studentTabs.hidden = document.getElementById("student-view").hidden;
    for (const link of studentTabs.querySelectorAll("a")) {
      link.classList.toggle("on", link.dataset.studentTab === (params.get("tab") === "courses" ? "courses" : "listen"));
    }
    subInner.append(studentTabs);
  }
  if (group) {
    const sub = el("nav", { class: "site-subnav", "aria-label": `${MENU.find(([href]) => active(href))?.[1] || ""} 세부 메뉴` },
      ...SUBMENUS[group].map(([href, label]) => el("a", {
        href, class: path === href || path.startsWith(`${href}/`) ? "on" : ""
      }, label)));
    sub.style.setProperty("--sub-count", SUBMENUS[group].length);
    sub.style.setProperty("--sub-min-width", `${SUBMENUS[group].length * 68}px`);
    subInner.append(sub);
  }

  const roleName = (u) => {
    if (u.is_admin) return "전체 관리자";
    if (u.role_choice) return "가입 중";
    if (u.role !== "teacher") return { student: "학생", guest: "등록 신청" }[u.role] || "";
    // 선생님: 가진 역할을 모두 (강의교사 · 거점학교 관리교사 · 참여학교 담당교사)
    const names = [];
    if (u.lead_hubs?.length || u.teach_hubs?.length) names.push("강의교사");
    if (u.coordinator_hubs?.length || u.participant_schools?.length) names.push("관리교사");
    if (u.memberships?.some((m) => ["participant", "coordinator"].includes(m.role) && m.transfer_from && m.status === "pending")) names.push("담당 학교 변경 승인 대기");
    return names.join("·") || "강의교사";
  };
  function render(u) {
    // 모든 이용자에게 같은 다섯 메뉴를 보여 주고, 역할별로 현재 메뉴만 표시한다.
    const staff = !!u && (u.role === "teacher" || u.is_admin);
    [...nav.children].forEach((link, i) => link.classList.toggle("on", active(MENU[i][0], u)));
    user.replaceChildren();
    if (!u) {
      user.append(
        el("a", { class: "site-user", href: "/live" }, "로그인"),
        el("a", { class: "site-user site-signup", href: "/live?signup=1" }, "회원가입")
      );
      return;
    }
    const name = el("a", { class: "site-me", href: staff ? "/live?office=1" : "/live?classroom=1", title: staff ? "교무실" : "강의실" },
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

/* 로그인 유지 신호 (자동 로그인을 안 고른 로그인은 브라우저를 닫으면 끝난다) */
(function () {
  const s = document.createElement("script");
  s.src = "/static/live/keepalive.js";
  document.head.append(s);
})();
