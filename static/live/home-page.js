/* 외솔온닷 메인: 전광판(배너) · 동그란 바로가기 · 공지사항 · 모집 중인 강좌 · 시작하기 */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const d = (s) => (s || "").replaceAll("-", ".");

  // ── 기본 그림 (관리자가 배너를 정하지 않았을 때) ──
  const ART = {
    live: `<svg viewBox="0 0 320 220" aria-hidden="true">
      <rect x="40" y="30" width="240" height="150" rx="16" fill="#fff"/><rect x="40" y="30" width="240" height="150" rx="16" fill="none" stroke="#0f4a33" stroke-width="6"/>
      <rect x="58" y="48" width="120" height="114" rx="10" fill="#cfeadb"/><circle cx="118" cy="92" r="22" fill="#ffd9b8"/><path d="M84 150c6-26 62-26 68 0" fill="#e8663a"/>
      <circle cx="110" cy="90" r="3" fill="#2b2b2b"/><circle cx="126" cy="90" r="3" fill="#2b2b2b"/><path d="M110 102q8 6 16 0" stroke="#2b2b2b" stroke-width="3" fill="none" stroke-linecap="round"/>
      <rect x="190" y="48" width="72" height="34" rx="8" fill="#ffe8a3"/><rect x="190" y="88" width="72" height="34" rx="8" fill="#d6e4ff"/><rect x="190" y="128" width="72" height="34" rx="8" fill="#ffd6e0"/>
      <circle cx="208" cy="65" r="9" fill="#fff"/><circle cx="208" cy="105" r="9" fill="#fff"/><circle cx="208" cy="145" r="9" fill="#fff"/>
      <rect x="130" y="180" width="60" height="14" fill="#0f4a33"/><rect x="100" y="192" width="120" height="10" rx="5" fill="#0f4a33"/>
      <circle cx="292" cy="40" r="14" fill="#e8663a"/><path d="M286 40h12M292 34v12" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
      <path d="M22 70l8 4-8 4z" fill="#ffd34d"/><circle cx="26" cy="140" r="6" fill="#7fc8a9"/></svg>`,
    books: `<svg viewBox="0 0 320 220" aria-hidden="true">
      <rect x="70" y="150" width="180" height="26" rx="6" fill="#e8663a"/><rect x="84" y="122" width="160" height="26" rx="6" fill="#4f7cff"/><rect x="62" y="94" width="170" height="26" rx="6" fill="#1b6b4a"/>
      <rect x="70" y="150" width="14" height="26" fill="#c94f25"/><rect x="84" y="122" width="14" height="26" fill="#3559c9"/><rect x="62" y="94" width="14" height="26" fill="#0f4a33"/>
      <path d="M190 30l14 28 30 4-22 21 6 30-28-15-28 15 6-30-22-21 30-4z" fill="#ffd34d" stroke="#e0a800" stroke-width="3"/>
      <circle cx="60" cy="50" r="10" fill="#ffd6e0"/><circle cx="270" cy="70" r="7" fill="#7fc8a9"/><path d="M40 190h240" stroke="#0f4a33" stroke-width="6" stroke-linecap="round"/></svg>`,
    rocket: `<svg viewBox="0 0 320 220" aria-hidden="true">
      <path d="M160 20c40 30 50 80 30 130h-60c-20-50-10-100 30-130z" fill="#fff" stroke="#0f4a33" stroke-width="6"/>
      <circle cx="160" cy="80" r="18" fill="#4f7cff" stroke="#0f4a33" stroke-width="5"/>
      <path d="M130 150l-30 26 34-6zM190 150l30 26-34-6z" fill="#e8663a" stroke="#0f4a33" stroke-width="5" stroke-linejoin="round"/>
      <path d="M144 156q16 40 32 0" fill="#ffd34d"/><path d="M152 158q8 24 16 0" fill="#e8663a"/>
      <circle cx="60" cy="60" r="5" fill="#ffd34d"/><circle cx="260" cy="40" r="6" fill="#ffd34d"/><circle cx="250" cy="150" r="4" fill="#fff"/><circle cx="80" cy="160" r="6" fill="#7fc8a9"/></svg>`,
  };
  const DEFAULTS = [
    { kicker: "울산 거점학교 공동교육과정", title: "울산 어디서나, 함께 듣는 실시간 수업", text: "우리 학교에 없는 과목도 집에서 거점학교 선생님과!", button: "수업 신청하기", link: "/live/courses", theme: "green", art: "live" },
    { kicker: "처음 오셨나요?", title: "가입부터 수업까지 3분이면 OK", text: "학교 구글 계정으로 시작하고, 마이페이지에서 수강신청해요.", button: "수강 안내 보기", link: "/live/guide", theme: "orange", art: "books" },
    { kicker: "선생님 모집", title: "외솔온닷에서 강의해 주세요", text: "거점학교 강사·팀티칭 보조교사로 등록을 신청할 수 있어요.", button: "선생님으로 시작", link: "/live?start=staff", theme: "blue", art: "rocket" },
  ];

  // ── 전광판 ──
  async function billboard() {
    let list = [];
    try { list = (await (await fetch("/api/banners")).json()).banners; } catch { /* 기본 배너 */ }
    if (!list.length) list = DEFAULTS;
    const track = $("#bb-track");
    const dots = $("#bb-dots");
    track.innerHTML = list.map((b, i) => {
      const img = b.image ? ` style="background-image:url('/api/banners/image/${encodeURIComponent(b.image)}')"` : "";
      const text = b.title ? `<div class="bb-text">
          ${b.kicker ? `<p class="bb-kicker">${esc(b.kicker)}</p>` : ""}
          <h2>${esc(b.title)}</h2>${b.text ? `<p>${esc(b.text)}</p>` : ""}
          ${b.button && b.link ? `<a class="bb-btn" href="${esc(b.link)}">${esc(b.button)} →</a>` : ""}</div>` : "";
      const art = !b.image && ART[b.art || ["live", "books", "rocket"][i % 3]];
      const whole = b.link && !b.button ? `<a class="bb-cover" href="${esc(b.link)}" aria-label="${esc(b.title || "배너")}"></a>` : "";
      return `<div class="bb-slide theme-${esc(b.theme || "green")} ${b.image ? "has-image" : ""}"${img} role="group" aria-label="${i + 1} / ${list.length}">
        <div class="bb-in">${text}${art ? `<div class="bb-art">${art}</div>` : ""}</div>${whole}</div>`;
    }).join("");
    dots.innerHTML = list.map((_, i) => `<button aria-label="${i + 1}번 배너"></button>`).join("");
    let cur = 0;
    let timer = null;
    const go = (n) => {
      cur = (n + list.length) % list.length;
      track.style.transform = `translateX(-${cur * 100}%)`;
      [...dots.children].forEach((x, i) => x.classList.toggle("on", i === cur));
    };
    const play = () => { clearInterval(timer); if (list.length > 1) timer = setInterval(() => go(cur + 1), 5000); };
    dots.addEventListener("click", (e) => { const i = [...dots.children].indexOf(e.target); if (i >= 0) { go(i); play(); } });
    $("#bb-prev").onclick = () => { go(cur - 1); play(); };
    $("#bb-next").onclick = () => { go(cur + 1); play(); };
    $("#bb-prev").hidden = $("#bb-next").hidden = list.length < 2;
    const bb = $("#billboard");
    bb.addEventListener("mouseenter", () => clearInterval(timer));
    bb.addEventListener("mouseleave", play);
    // 휴대폰: 밀어서 넘기기
    let x0 = null;
    bb.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    bb.addEventListener("touchend", (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) { go(cur + (dx < 0 ? 1 : -1)); play(); }
      x0 = null;
    });
    go(0);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) play();
  }

  // ── 동그란 바로가기 그림 ──
  const ICONS = {
    c1: '<path d="M14 30v-8l22-10v28L14 30z" fill="#fff"/><path d="M14 22h-4a4 4 0 0 0 0 8h4" fill="#fff"/><path d="M18 31l3 9h5l-3-9" fill="#fff"/><path d="M40 20q5 6 0 12" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>',
    c2: '<path d="M8 40h40M12 40V22l16-10 16 10v18" stroke="#fff" stroke-width="3.5" fill="none" stroke-linejoin="round"/><rect x="23" y="29" width="10" height="11" fill="#fff"/><circle cx="28" cy="22" r="3.5" fill="#fff"/><path d="M28 6v6M28 6h7l-2 2.5 2 2.5h-7" fill="#fff" stroke="#fff" stroke-width="2"/>',
    c3: '<path d="M10 14q9-4 18 2v26q-9-6-18-2zM46 14q-9-4-18 2v26q9-6 18-2z" fill="#fff"/>',
    c4: '<rect x="12" y="10" width="28" height="34" rx="4" fill="#fff"/><path d="M18 20h16M18 27h16M18 34h9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M36 40l10-12 4 3-10 12-5 2z" fill="#ffd34d" stroke="#fff" stroke-width="1.5"/>',
    c5: '<circle cx="28" cy="28" r="17" fill="#fff"/><path d="M22 23a6 6 0 1 1 8 5.6c-1.6.7-2 1.6-2 3.4" stroke="currentColor" stroke-width="3.5" fill="none" stroke-linecap="round"/><circle cx="28" cy="38" r="2.4" fill="currentColor"/>',
    c6: '<path d="M6 22l22-10 22 10-22 10z" fill="#fff"/><path d="M15 27v9c0 4 6 7 13 7s13-3 13-7v-9l-13 6z" fill="#fff"/><path d="M50 22v12" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="50" cy="36" r="2.6" fill="#ffd34d"/>',
  };
  document.querySelectorAll(".circle").forEach((el) => {
    const k = [...el.classList].find((c) => ICONS[c]);
    if (k) el.innerHTML = `<svg viewBox="0 0 56 56" aria-hidden="true">${ICONS[k]}</svg>`;
  });

  // ── 공지사항 ──
  async function notices() {
    const box = $("#home-notices");
    try {
      const { notices: list } = await (await fetch("/api/notices?limit=5")).json();
      box.innerHTML = list.length ? list.map((n) => `<li class="${n.pinned ? "pinned" : ""}"><a href="/live/notices/${n.id}">${n.pinned ? '<span class="tag">공지</span>' : ""}${esc(n.title)}${n.new ? '<span class="new-dot">N</span>' : ""}</a><span class="muted">${d(n.date)}</span></li>`).join("")
        : '<li class="muted">아직 공지사항이 없어요.</li>';
    } catch { box.innerHTML = '<li class="muted">공지사항을 불러오지 못했어요.</li>'; }
  }

  // ── 모집 중인 강좌 ──
  async function courses() {
    const box = $("#home-courses");
    try {
      const { courses: list } = await (await fetch("/api/courses/catalog")).json();
      const open = list.filter((c) => c.recruit === "open").concat(list.filter((c) => c.recruit === "before")).slice(0, 6);
      box.innerHTML = open.length ? open.map((c) => `<a class="mini-course with-thumb" href="/live/courses">
          ${window.courseThumb ? window.courseThumb(c) : ""}
          <strong>${esc(c.title)}</strong>
          <span class="muted">${esc(c.hub_school)} · ${esc(c.instructor)}</span>
          <span class="mc-meta">${[c.subject_area, c.credits ? `${c.credits}학점` : "", c.grades.length ? `${c.grades.join("·")}학년` : "전 학년"].filter(Boolean).map(esc).join(" · ")}</span>
          ${c.recruit_end ? `<span class="mc-meta">~ ${d(c.recruit_end)} 모집</span>` : ""}</a>`).join("")
        : '<p class="muted">지금 모집 중인 강좌가 없어요. 곧 새 강좌가 열려요!</p>';
    } catch { box.innerHTML = '<p class="muted">강좌를 불러오지 못했어요.</p>'; }
  }

  // ── 시작하기 / 로그인한 사람 ──
  async function who() {
    try {
      const { user: u } = await (await fetch("/api/me")).json();
      if (!u) return;
      const role = u.is_admin ? "전체 관리자" : u.role === "teacher" ? "선생님" : u.role === "student" ? "학생" : "회원";
      $("#home-login .home-box-h h2").textContent = "👋 반가워요";
      $("#home-login-body").innerHTML = `<p class="hello"><strong>${esc(u.name || u.email.split("@")[0])}</strong> ${role}님</p>
        <a class="start-choice" href="/live"><span class="sc-ico">🏠</span><strong>마이페이지로</strong></a>
        <a class="start-choice" href="/live/materials"><span class="sc-ico">📚</span><strong>지난 수업 자료</strong></a>`;
    } catch { /* 로그인 전 화면 그대로 */ }
  }

  billboard();
  notices();
  courses();
  who();
})();
