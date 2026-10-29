/* 실시간 수업: 선생님·학생 화면이 함께 쓰는 코드 */
const { Room, RoomEvent, Track, VideoPresets, VideoQuality } = window.LivekitClient || {}; // 화상이 없는 화면(지난 수업 자료 등)에서는 비어 있음

const CODE = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "").toUpperCase();

function $(sel, root = document) { return root.querySelector(sel); }

/** 간단한 DOM 생성 도우미: h("button", {class: "x", onclick: fn}, "텍스트") */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "selected") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 사생활 보호 모드 등 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  };
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : `요청이 실패했어요 (${res.status})`;
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(text, ms = 3000) {
  let el = $(".toast");
  if (!el) { el = h("div", { class: "toast", role: "status" }); document.body.append(el); }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  return el;
}

/** 서버 시계와의 차이(초). 타이머를 학생 기기 시계와 상관없이 맞추기 위함 */
const clock = { offset: 0, now() { return Date.now() / 1000 + this.offset; } };

function fmtRemaining(endsAt) {
  const left = Math.round(endsAt - clock.now());
  const sign = left < 0 ? "-" : "";
  const a = Math.abs(left);
  return { text: `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`, over: left < 0 };
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 수업 상태를 주고받는 WebSocket. 끊기면 자동으로 다시 연결한다. */
class LiveSocket {
  constructor(_unused, onMessage, onStatus) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.retry = 0;
    this.stopped = false;
    this.connect();
    this.pinger = setInterval(() => {
      // 50초 넘게 서버 응답이 없으면 연결이 죽은 것으로 보고 다시 연결한다
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastMsg > 50000) this.ws.close();
      else this.send({ t: "ping" }, true);
    }, 20000);
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // 로그인 쿠키로 누구인지 확인한다
    const studentMode = new URLSearchParams(location.search).has("as_student") ? "?as_student=1" : "";
    const ws = new WebSocket(`${proto}://${location.host}/ws/live/${CODE}${studentMode}`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.lastMsg = Date.now(); this.onStatus(true); };
    ws.onmessage = (e) => {
      this.lastMsg = Date.now();
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === "hello" || msg.t === "pong") clock.offset = msg.now - Date.now() / 1000;
      if (msg.t === "error") this.stop();
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onStatus(false);
      if (this.stopped) return;
      const wait = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    };
  }

  send(obj, quiet = false) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    if (!quiet) toast("서버와 연결이 끊겨 있어요. 다시 연결하는 중…");
    return false;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pinger);
    this.ws?.close();
  }
}

/* ───────────────────────── 영상 타일 ───────────────────────── */

function makeTile() {
  const video = h("video", { autoplay: true, playsinline: true });
  video.muted = true;
  return h("div", { class: "tile" }, h("div", { class: "avatar" }), video, h("div", { class: "flag" }), h("div", { class: "label" }, h("span")));
}

function updateTile(tile, it) {
  const video = tile.querySelector("video");
  if (tile._track !== it.track) {
    if (tile._track) tile._track.detach(video);
    if (it.track) it.track.attach(video);
    tile._track = it.track;
  }
  video.hidden = !it.track;
  const avatar = tile.querySelector(".avatar");
  avatar.hidden = !!it.track;
  avatar.textContent = (it.name || "?").trim(); // 카메라가 꺼져 있으면 이름 전체를 보여 준다
  // 마이크 꺼짐은 스피커(🔇)가 아니라 마이크에 빨간 빗금으로 보여 준다
  tile.querySelector(".label span").replaceChildren(micIcon(!it.micOff), ` ${it.name}${it.isLocal ? " (나)" : ""}`);
  tile.querySelector(".flag").textContent = it.flag || "";
  tile.classList.toggle("speaking", !!it.speaking);
  tile.classList.toggle("screen", !!it.screen);
  tile.classList.toggle("pip", !!it.pip);
  tile.title = it.name;
}

/** 컨테이너 안의 타일을 items 목록과 맞춘다. 기존 타일은 옮기지 않는다(옮기면 영상이 멈출 수 있음). */
function syncTiles(container, items) {
  const existing = new Map();
  for (const c of container.children) if (c._key) existing.set(c._key, c);
  for (const it of items) {
    let t = existing.get(it.key);
    if (t) existing.delete(it.key);
    else { t = makeTile(); t._key = it.key; container.append(t); }
    updateTile(t, it);
  }
  for (const t of existing.values()) {
    if (t._track) t._track.detach(t.querySelector("video"));
    t.remove();
  }
}

/** 마이크 아이콘: 켜짐 🎤, 꺼짐 🎤에 빨간 빗금 */
function micIcon(on) { return h("span", { class: `mic-ico${on ? "" : " off"}`, "aria-label": on ? "마이크 켜짐" : "마이크 꺼짐" }, "🎤"); }

function isTeacher(p) { return p.attributes?.role === "teacher" || p.identity === "teacher"; }

function cameraItem(room, p, extra = {}) {
  const cam = p.getTrackPublication(Track.Source.Camera);
  const mic = p.getTrackPublication(Track.Source.Microphone);
  return {
    key: `${p.identity}:cam`,
    name: p.name || p.identity,
    track: cam && !cam.isMuted && cam.track ? cam.track : null,
    speaking: p.isSpeaking,
    micOff: !mic || mic.isMuted,
    isLocal: p === room.localParticipant,
    ...extra,
  };
}

function screenItem(room, p) {
  const pub = p.getTrackPublication(Track.Source.ScreenShare);
  if (!pub || pub.isMuted || !pub.track) return null;
  return { key: `${p.identity}:screen`, name: `${p.name || p.identity} 화면`, track: pub.track, screen: true, isLocal: p === room.localParticipant };
}

function allParticipants(room) {
  return [room.localParticipant, ...room.remoteParticipants.values()];
}

/** LiveKit 방을 만들고, 무엇이든 바뀌면 onChange를 (프레임당 한 번) 부른다. */
function createRoom(onChange, { audioSink = document.body } = {}) {
  const room = new Room({
    adaptiveStream: true, // 보이지 않거나 작은 타일은 낮은 화질로 받는다
    dynacast: true,
    videoCaptureDefaults: { resolution: VideoPresets.h360.resolution },
    publishDefaults: { simulcast: true, videoSimulcastLayers: [VideoPresets.h180] },
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let queued = false;
  const changed = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; onChange(room); });
  };
  const audioEls = new Map(); // 트랙 → <audio>. 구독이 끝나면 직접 지운다
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      audioEls.set(track, el);
      audioSink.append(el);
    }
    changed();
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      track.detach();
      audioEls.get(track)?.remove();
      audioEls.delete(track);
    }
    changed();
  });
  room.on(RoomEvent.Disconnected, () => {
    for (const el of audioEls.values()) el.remove();
    audioEls.clear();
  });
  for (const ev of [
    RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
    RoomEvent.ActiveSpeakersChanged, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished,
    RoomEvent.ParticipantNameChanged, RoomEvent.ParticipantAttributesChanged,
    RoomEvent.ConnectionStateChanged, RoomEvent.AudioPlaybackStatusChanged, RoomEvent.Disconnected,
  ]) room.on(ev, changed);
  room._changed = changed;
  return room;
}

function disposeRoom(room) {
  if (!room) return;
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) pub.track?.detach().forEach((el) => el.remove());
  }
  return room.disconnect();
}

function mediaError(err) {
  console.error(err);
  const name = err?.name || "";
  if (name === "NotAllowedError") return "카메라·마이크 권한이 막혀 있어요. 주소창 왼쪽 자물쇠(또는 설정) 아이콘 → 카메라·마이크 '허용'으로 바꿔 주세요.";
  if (name === "NotFoundError") return "카메라나 마이크를 찾을 수 없어요. 컴퓨터에 웹캠·마이크가 연결돼 있는지 확인해 주세요.";
  if (name === "NotReadableError") return "다른 프로그램(줌·팀즈·카메라 앱 등)이 카메라·마이크를 쓰고 있어요. 그 프로그램을 닫아 주세요.";
  return "카메라·마이크를 켜지 못했어요.";
}

/* ───────────────────────── 채팅 ───────────────────────── */

function chatBubble(msg, { mine, scopeName }) {
  const cls = ["chatmsg", mine ? "mine" : "", msg.role === "teacher" ? "teacher" : ""].join(" ");
  return h("div", { class: cls },
    h("div", { class: "who" }, `${msg.name} · ${fmtTime(msg.ts)}`,
      scopeName ? h("span", { class: "scope" }, scopeName) : null,
      msg.broadcast ? h("span", { class: "scope" }, "📢 전체 공지") : null),
    h("div", { class: "text" }, msg.text));
}

function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 80; }

/** 입력창에서 Enter로 보내기, Shift+Enter로 줄바꿈 */
function submitOnEnter(textarea, form) {
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
}

/* ───────────────────────── AI 조교 (기존 /api/chat 사용) ───────────────────────── */

class AIChat {
  constructor(root) {
    this.history = [];
    this.log = h("div", { class: "chatlog", "aria-live": "polite" },
      h("div", { class: "chatmsg ai-msg" }, h("div", { class: "who" }, "AI 조교"),
        h("div", { class: "text" }, "수업 내용 중 궁금한 개념을 물어보세요. 답이 틀릴 수 있으니 중요한 건 선생님께 확인하세요.")));
    this.input = h("textarea", { rows: 1, maxlength: 4000, placeholder: "AI 조교에게 질문" });
    this.btn = h("button", { class: "primary", type: "submit" }, "질문");
    const form = h("form", { class: "chatform", onsubmit: (e) => { e.preventDefault(); this.ask(); } }, this.input, this.btn);
    submitOnEnter(this.input, form);
    root.append(this.log, form);
    // 처음 쓸 때 한 번: 질문이 미국 회사로 전송된다는 안내를 확인받는다 (개인정보 처리방침의 국외 이전)
    api("/api/me").then(({ user }) => { if (user && !user.ai_ok) this.showGate(); }).catch(() => {});
  }

  showGate() {
    this.input.disabled = this.btn.disabled = true;
    const gate = h("div", { class: "banner warn ai-gate" },
      h("div", {},
        h("strong", {}, "AI 조교를 쓰기 전에 확인해 주세요"),
        h("div", { style: "font-size:0.9rem;margin-top:4px" },
          "여기 쓴 질문은 답을 만들기 위해 미국의 AI 회사(Anthropic)로 보내져요. ",
          h("strong", {}, "이름·학번·연락처 같은 개인정보는 쓰지 마세요."),
          " AI의 답은 틀릴 수 있으니 중요한 건 선생님께 확인하세요. ",
          h("a", { href: "/live/privacy", target: "_blank" }, "개인정보 처리방침"))),
      h("button", { class: "primary", onclick: async () => {
        try {
          await api("/api/me/ai-ok", {});
          gate.remove();
          this.input.disabled = this.btn.disabled = false;
          this.input.focus();
        } catch (err) { toast(err.message); }
      } }, "확인했어요"));
    this.log.append(gate);
  }

  add(role, text) {
    const textEl = h("div", { class: "text" });
    const el = h("div", { class: `chatmsg ${role === "user" ? "mine" : "ai-msg"}` },
      h("div", { class: "who" }, role === "user" ? "나" : "AI 조교"), textEl);
    if (role === "user") textEl.textContent = text;
    this.log.append(el);
    this.log.scrollTop = this.log.scrollHeight;
    return textEl;
  }

  render(el, md) {
    el.innerHTML = window.DOMPurify && window.marked ? DOMPurify.sanitize(marked.parse(md)) : "";
    if (!window.marked) el.textContent = md;
  }

  async ask() {
    const q = this.input.value.trim();
    if (!q || this.btn.disabled) return;
    this.input.value = "";
    this.history.push({ role: "user", content: q });
    this.add("user", q);
    const out = this.add("assistant", "");
    out.classList.add("pending");
    this.btn.disabled = true;
    let answer = "";
    let failed = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: this.history.slice(-40) }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(chunk)?.[1];
          const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? "{}");
          if (event === "delta") answer += data.text;
          else if (event === "refusal" || event === "error") { answer = data.text; failed = true; }
          out.classList.remove("pending");
          this.render(out, answer);
          if (nearBottom(this.log)) this.log.scrollTop = this.log.scrollHeight;
        }
      }
    } catch (err) {
      console.error(err);
      answer = "AI 조교와 연결하지 못했어요. 잠시 후 다시 시도해 주세요.";
      failed = true;
      out.classList.remove("pending");
      this.render(out, answer);
    }
    if (failed || !answer) this.history.pop();
    else this.history.push({ role: "assistant", content: answer });
    this.btn.disabled = false;
  }
}

/* ───────────────────────── 활동 결과 막대 ───────────────────────── */

function resultBars(a) {
  // 한 줄: [정답 표시] 보기 · 막대 · "n명 / p%" — 맨 아래에 무응답(교실에 있지만 아직 안 낸 학생)
  const none = a.noanswer || 0;
  const all = (a.total || 0) + none;
  const row = (cls, mark, label, n) => {
    const pct = all ? Math.round((n / all) * 100) : 0;
    return h("div", { class: `bar ${cls}` },
      h("span", { class: "mark" }, mark ? "✓" : ""),
      h("span", { class: "name" }, label),
      h("div", { class: "track" }, h("div", { class: "fill", style: `width:${pct}%` })),
      h("span", { class: "num" }, `${n}명 / ${pct}%`));
  };
  return h("div", { class: "bars" },
    a.options.map((opt, i) => row(`${oxClass(a, i)} ${a.correct === i ? "correct" : ""}`, a.correct === i,
      [a.kind === "ox" ? null : h("b", { class: "bar-no" }, i + 1), opt], a.counts?.[i] || 0)),
    row("none", false, "무응답", none));
}

/** OX 퀴즈 버튼 그림: 0 → 파란 동그라미, 1 → 빨간 엑스 */
function oxIcon(i) {
  const svg = i === 0
    ? '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="34" fill="none" stroke="#4a8cf0" stroke-width="16"/></svg>'
    : '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M20 20L80 80M80 20L20 80" stroke="#ff5f4c" stroke-width="16" stroke-linecap="round"/></svg>';
  const span = h("span", { class: "ox-ico", title: i === 0 ? "O" : "X" });
  span.innerHTML = svg;
  return span;
}
const oxClass = (a, i) => (a.kind === "ox" ? (i === 0 ? "ox-o" : "ox-x") : `c${i % 8}`);
/** 보기 칸 묶음의 class: OX는 그림 두 칸, 객관식·설문은 번호마다 색이 다른 칸 */
const optsClass = (a) => `options ${a.kind === "ox" ? "ox" : "colored"}`;
/** 보기 버튼 안: OX는 그림, 나머지는 오른쪽 위 번호 + 가운데 글 */
const optBody = (a, i, opt) => (a.kind === "ox" ? oxIcon(i) : [h("span", { class: "opt-no" }, i + 1), h("span", { class: "opt-text" }, opt)]);

const KIND_NAMES = { ox: "OX 퀴즈", choice: "객관식", poll: "설문", text: "주관식" };
const kindName = (a) => KIND_NAMES[a.kind] + (a.multi ? " (여러 개 고르기)" : "");

/** 선생님 화면용: 결과를 공개했을 때 학생 화면에 보이는 모습 (이름 없이, 정답 표시·막대그래프) */
function revealPreview(a) {
  const card = h("section", { class: "activity preview" },
    h("div", { class: "kind" }, `${kindName(a)}${a.open ? "" : " · 마감됨"}`),
    h("h3", {}, a.prompt));
  if (a.kind === "text") {
    const texts = (a.responses || []).map((r) => r.value);
    card.append(h("div", { class: "muted" }, `친구들의 답 (${texts.length}개)`),
      h("div", { class: "texts" }, texts.map((t) => h("div", {}, t))));
  } else {
    card.append(h("div", { class: optsClass(a) }, a.options.map((opt, i) =>
      h("button", { class: [oxClass(a, i), a.correct === i ? "correct" : ""].join(" "), disabled: true, "aria-label": `${i + 1}. ${opt}` }, optBody(a, i, opt)))));
    if (a.correct !== null && a.correct !== undefined) {
      card.append(h("div", { class: "muted", style: "font-size:0.85rem" }, "정답을 맞힌 학생에게는 '⭕ 정답이에요!', 틀린 학생에게는 '❌ 아쉬워요'가 보여요."));
    }
    card.append(resultBars(a));
  }
  return card;
}

/* ───────────────────────── 화질 설정 (저대역폭 모드) ───────────────────────── */

/** 화상 서버 작업이 끝나지 않고 멈추는 경우(방이 닫히는 중 등)를 막는다 */
function withTimeout(promise, ms = 10000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => {
    const err = new Error("시간 초과");
    err.name = "Timeout";
    reject(err);
  }, ms))]);
}

const MEDIA_ERRORS = new Set(["NotAllowedError", "NotFoundError", "NotReadableError", "OverconstrainedError", "AbortError"]);

/** 카메라 [캡처 옵션, 전송 옵션]. 저대역폭 모드면 해상도·프레임·비트레이트 상한을 둔다. */
function cameraOptions(lowbw, role) {
  if (!lowbw) {
    return [{ resolution: VideoPresets.h360.resolution }, { simulcast: true, videoSimulcastLayers: [VideoPresets.h180] }];
  }
  if (role === "teacher") { // 선생님: 360p·15fps·최대 300kbps (+ 작은 화면용 180p 층)
    return [{ resolution: { ...VideoPresets.h360.resolution, frameRate: 15 } },
      { videoEncoding: { maxBitrate: 300_000, maxFramerate: 15 }, simulcast: true, videoSimulcastLayers: [VideoPresets.h180] }];
  }
  // 학생: 360p·15fps·최대 250kbps (+ 작은 칸용 180p 층 — 작게 보는 사람은 이 층만 받아 데이터를 아낀다)
  return [{ resolution: { ...VideoPresets.h360.resolution, frameRate: 15 } },
    { videoEncoding: { maxBitrate: 250_000, maxFramerate: 15 }, simulcast: true, videoSimulcastLayers: [VideoPresets.h180] }];
}

/** 화면 공유 [캡처 옵션, 전송 옵션]. 저대역폭 모드면 720p·초당 5장(슬라이드에 충분)·최대 500kbps. */
function screenOptions(lowbw, extra = {}) {
  if (!lowbw) return [{ audio: true, ...extra }, {}];
  return [{ audio: true, contentHint: "detail", resolution: { width: 1280, height: 720, frameRate: 5 }, ...extra },
    { screenShareEncoding: { maxBitrate: 500_000, maxFramerate: 5 }, screenShareSimulcastLayers: [] }];
}

/* ───────────────────────── 마이크 소리 막대 · 들어가기 전 장치 확인 ───────────────────────── */

let meterCtx = null;
function audioCtx() {
  meterCtx = meterCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (meterCtx.state === "suspended") meterCtx.resume().catch(() => {});
  return meterCtx;
}
// 브라우저는 사용자가 한 번 누르기 전에는 소리 분석을 멈춰 두므로, 처음 누를 때 깨운다
["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, () => { if (meterCtx?.state === "suspended") meterCtx.resume().catch(() => {}); }, { capture: true }));

/** 마이크 소리 크기를 막대(el 안의 <i>)로 보여 준다. 멈추는 함수를 돌려준다 */
function micMeter(track, el) {
  if (!track || !el) return () => {};
  let stopped = false;
  let src = null;
  const bar = el.querySelector("i") || el.appendChild(document.createElement("i"));
  try {
    const ctx = audioCtx();
    src = ctx.createMediaStreamSource(new MediaStream([track]));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const data = new Uint8Array(an.fftSize);
    let level = 0;
    const tick = () => {
      if (stopped) return;
      an.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      level = Math.max(peak / 128, level * 0.85); // 천천히 내려가게
      bar.style.width = `${Math.min(100, Math.round(level * 160))}%`;
      el.classList.toggle("loud", level > 0.08);
      requestAnimationFrame(tick);
    };
    tick();
  } catch { el.hidden = true; }
  el.hidden = false;
  return () => { stopped = true; try { src?.disconnect(); } catch { /* 무시 */ } bar.style.width = "0"; el.classList.remove("loud"); };
}

/** 들어가기 전 화면: 내 카메라 미리보기 + 마이크 막대. 문제가 있으면 이유를 err 칸에 남긴다 */
function devicePreview({ video, meter, err, camBox, micBox }) {
  let stream = null;
  let stopMeter = () => {};
  const stop = () => {
    stopMeter();
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  };
  const start = async () => {
    stop();
    err.textContent = "";
    const want = { video: camBox.checked, audio: micBox.checked };
    video.closest(".preview").classList.toggle("off", !want.video);
    meter.hidden = !want.audio;
    if (!want.video && !want.audio) return;
    if (!navigator.mediaDevices?.getUserMedia) { err.textContent = "이 브라우저에서는 카메라·마이크를 쓸 수 없어요. 크롬으로 열어 주세요."; return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: want.video ? { width: 640, height: 360 } : false, audio: want.audio });
      if (want.video) video.srcObject = stream;
      const a = stream.getAudioTracks()[0];
      if (a) stopMeter = micMeter(a, meter);
    } catch (e) {
      err.textContent = mediaError(e);
      video.closest(".preview").classList.add("off");
    }
  };
  camBox.addEventListener("change", start);
  micBox.addEventListener("change", start);
  start();
  return stop;
}

/** 드롭다운 목록은 모두 가나다(오름차순)순으로. key: 정렬 기준 글자를 꺼내는 함수 */
function koSort(list, key = (x) => x) {
  return [...list].sort((a, b) => String(key(a) ?? "").localeCompare(String(key(b) ?? ""), "ko", { numeric: true }));
}

/* ───── 미디어 공유: 선생님이 튼 동영상·음악·유튜브를 학생 화면에서 같은 곳으로 맞춰 재생 ───── */
let ytReady = null;
function loadYouTube() {
  if (!ytReady) {
    ytReady = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.append(s);
    });
  }
  return ytReady;
}

class MediaShare {
  /** box: 넣을 자리, teacher: 선생님이면 조작 가능(바뀌면 onCtrl로 알림), code: 수업 코드 */
  constructor(box, { teacher = false, code, onCtrl, onClose } = {}) {
    Object.assign(this, { box, teacher, code, onCtrl, onClose, key: "", media: null, el: null, yt: null });
    if (!teacher) setInterval(() => this.sync(), 1000);
  }

  set(media) {
    this.media = media;
    const key = media ? `${media.kind}:${media.src}` : "";
    if (key !== this.key) this.build(key);
    if (this.title && media) this.title.textContent = `🎬 ${media.title}`;
    this.sync();
  }

  build(key) {
    this.key = key;
    if (this.yt) { try { this.yt.destroy(); } catch { /* 이미 없어짐 */ } }
    this.yt = this.el = null;
    this.box.replaceChildren();
    this.box.hidden = !this.media;
    if (!this.media) return;
    const m = this.media;
    this.title = h("strong", { class: "grow" }, `🎬 ${m.title}`);
    // 브라우저가 소리 있는 자동 재생을 막으면: 소리 없이 먼저 재생해 선생님과 맞추고, 이 버튼 한 번으로 소리를 켠다
    this.tap = h("button", { class: "primary media-tap", hidden: true, onclick: () => {
      this.tap.hidden = true;
      this.muted = false;
      try { this.yt?.unMute?.(); } catch { /* 무시 */ }
      if (this.el) this.el.muted = false;
      this.sync(true);
    } }, "🔊 소리 켜기");
    this.muted = false;
    this.ytTry = 0;
    const bar = h("div", { class: "media-bar" }, this.title, this.tap,
      this.teacher ? h("button", { class: "small danger", onclick: () => this.onClose?.() }, "공유 끝내기") : null);
    const stage = h("div", { class: "media-stage" });
    this.box.append(bar, stage);
    if (m.kind === "youtube") {
      const slot = h("div");
      stage.append(slot);
      loadYouTube().then((YT) => {
        if (this.key !== key) return;
        this.yt = new YT.Player(slot, {
          videoId: m.src, width: "100%", height: "100%",
          playerVars: { controls: this.teacher ? 1 : 0, rel: 0, modestbranding: 1, playsinline: 1, disablekb: this.teacher ? 0 : 1 },
          events: {
            onReady: () => this.sync(),
            onStateChange: (e) => {
              if (!this.teacher) return;
              if (e.data === YT.PlayerState.PLAYING) this.onCtrl?.(true, this.yt.getCurrentTime());
              if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) this.onCtrl?.(false, this.yt.getCurrentTime());
            },
          },
        });
      });
      return;
    }
    const audio = [".mp3", ".m4a", ".wav", ".ogg"].includes(m.ext);
    this.el = h(audio ? "audio" : "video", { src: `/api/live/classes/${this.code}/media/${m.src}`, playsinline: true, preload: "auto" });
    this.el.controls = this.teacher;
    if (audio) stage.append(h("div", { class: "media-audio" }, "🎵"));
    stage.append(this.el);
    if (this.teacher) {
      const tell = () => this.onCtrl?.(!this.el.paused, this.el.currentTime);
      this.el.addEventListener("play", tell);
      this.el.addEventListener("pause", tell);
      this.el.addEventListener("seeked", tell);
    }
  }

  showSoundButton() {
    this.muted = true;
    this.tap.textContent = "🔊 소리 켜기";
    this.tap.hidden = false;
  }

  /** 학생: 선생님이 정한 곳(시작 위치 + 지난 시간)에 맞춘다 */
  sync(fromTap = false) {
    const m = this.media;
    if (this.teacher || !m) return;
    const target = m.pos + (m.playing ? Math.max(0, clock.now() - m.at) : 0);
    if (this.yt?.getPlayerState) {
      const p = this.yt;
      if (Math.abs((p.getCurrentTime() || 0) - target) > 2) p.seekTo(target, true);
      const playing = p.getPlayerState() === 1 || p.getPlayerState() === 3;
      if (m.playing && !playing) {
        p.playVideo();
        // 1.5초가 지나도 시작되지 않으면 소리 없이 재생하고 [소리 켜기]를 보여 준다
        if (!this.ytTry) this.ytTry = Date.now();
        else if (!fromTap && Date.now() - this.ytTry > 1500) { p.mute(); p.playVideo(); this.showSoundButton(); }
      } else this.ytTry = 0;
      if (!m.playing && playing) p.pauseVideo();
      return;
    }
    const el = this.el;
    if (!el) return;
    if (el.readyState >= 1 && Math.abs(el.currentTime - target) > 2) el.currentTime = target;
    if (m.playing && el.paused) {
      el.play().then(() => { if (!this.muted) this.tap.hidden = true; }).catch(() => {
        if (fromTap) return;
        el.muted = true; // 소리 없이라도 먼저 맞춰 재생
        el.play().then(() => this.showSoundButton()).catch(() => { this.tap.textContent = "▶ 눌러서 함께 보기"; this.tap.hidden = false; });
      });
    }
    if (!m.playing && !el.paused) el.pause();
  }
}

/** 칭찬 스티커: 화면 가운데 크게 떠올랐다 사라진다 */
function showSticker(fx, mine) {
  const el = h("div", { class: `sticker-fx ${mine ? "mine" : ""}` },
    h("span", { class: "sticker-ico" }, fx.s),
    h("span", { class: "sticker-text" }, mine ? `선생님이 나에게 '${fx.label}' 스티커를 줬어요!` : fx.name ? `${fx.name} 학생에게 '${fx.label}'` : `모두에게 '${fx.label}'`));
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

/* ───────────────────────── 날짜 입력: 년·월·일 고르기 + 달력 ─────────────────────────
 * 모든 <input type="date">를 [년▼][월▼][일▼][📅]로 바꿔 보여 준다. 실제 값은 원래 입력칸에 그대로 들어가므로
 * 다른 코드(input.value 읽기·쓰기, change 이벤트)는 바꿀 필요가 없다.
 * 빈 칸을 처음 고를 때는 2027년 3월 1일부터 (생년월일 칸은 기본값 없이 최근 연도부터). */
const DATE_DEFAULT = { y: 2027, m: 3, d: 1 };
const dateNative = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

function enhanceDateInput(input) {
  if (input.dataset.ymd) return;
  input.dataset.ymd = "1";
  const birth = /birth/i.test(input.id || "") || input.min?.startsWith("19");
  const nowY = new Date().getFullYear();
  const opt = (v, t) => h("option", { value: v }, t);
  const ys = h("select", { class: "ymd-y", "aria-label": "년" });
  const ms = h("select", { class: "ymd-m", "aria-label": "월" }, opt("", "월"), ...Array.from({ length: 12 }, (_, i) => opt(i + 1, `${i + 1}월`)));
  const ds = h("select", { class: "ymd-d", "aria-label": "일" });
  const cal = h("button", { type: "button", class: "ymd-cal", title: "달력에서 고르기" }, "📅");
  const wrap = h("span", { class: "ymd" }, ys, ms, ds, cal);
  input.before(wrap);
  wrap.append(input);
  input.classList.add("ymd-native");

  const fillYears = (keep) => {
    const lo = birth ? 1920 : Math.min(nowY - 2, keep || nowY);
    const hi = birth ? nowY : Math.max(2035, keep || 0);
    const list = [];
    for (let y = hi; y >= lo; y--) list.push(y);
    if (!birth) list.reverse(); // 수업 날짜는 가까운 해부터 위로, 생년월일은 최근 해부터
    ys.replaceChildren(opt("", "년"), ...list.map((y) => opt(y, `${y}년`)));
  };
  const fillDays = () => {
    const y = Number(ys.value) || 2027, m = Number(ms.value) || 1;
    const last = new Date(y, m, 0).getDate();
    const cur = ds.value;
    ds.replaceChildren(opt("", "일"), ...Array.from({ length: last }, (_, i) => opt(i + 1, `${i + 1}일`)));
    ds.value = Number(cur) > last ? String(last) : cur;
  };
  const show = () => { // 입력칸 값 → 세 칸
    const v = dateNative.get.call(input);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || "");
    fillYears(m ? Number(m[1]) : null);
    ys.value = m ? String(Number(m[1])) : "";
    ms.value = m ? String(Number(m[2])) : "";
    fillDays();
    ds.value = m ? String(Number(m[3])) : "";
    for (const s of [ys, ms, ds]) s.disabled = input.disabled;
  };
  const commit = () => { // 세 칸 → 입력칸 (셋 다 골라야 값이 생긴다)
    const two = (n) => String(n).padStart(2, "0");
    const v = ys.value && ms.value && ds.value ? `${ys.value}-${two(ms.value)}-${two(ds.value)}` : "";
    if (v === dateNative.get.call(input)) return;
    dateNative.set.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  // 빈 칸을 처음 누르면 기본 날짜(2027.3.1)로 시작한다
  const startDefault = () => {
    if (birth || dateNative.get.call(input) || ys.value || ms.value || ds.value) return;
    ys.value = String(DATE_DEFAULT.y); ms.value = String(DATE_DEFAULT.m); fillDays(); ds.value = String(DATE_DEFAULT.d);
    commit();
  };
  for (const s of [ys, ms, ds]) {
    s.addEventListener("mousedown", startDefault);
    s.addEventListener("keydown", startDefault);
    s.addEventListener("change", () => { if (s !== ds) fillDays(); commit(); });
  }
  cal.addEventListener("click", () => {
    if (!birth && !dateNative.get.call(input)) { dateNative.set.call(input, "2027-03-01"); show(); }
    try { input.showPicker(); } catch { input.focus(); }
  });
  input.addEventListener("change", show);
  input.addEventListener("input", show);
  // 코드에서 input.value = "…" 로 바꿔도 세 칸이 따라오게
  Object.defineProperty(input, "value", {
    configurable: true,
    get() { return dateNative.get.call(this); },
    set(v) { dateNative.set.call(this, v); show(); },
  });
  show();
}

/* 시간 입력: [오전/오후▼][시▼][분▼][🕐] (분은 5분 단위, 이미 들어 있는 값은 그대로 보인다) */
function enhanceTimeInput(input) {
  if (input.dataset.ymd) return;
  input.dataset.ymd = "1";
  const opt = (v, t) => h("option", { value: v }, t);
  const ap = h("select", { class: "ymd-ap", "aria-label": "오전/오후" }, opt("am", "오전"), opt("pm", "오후"));
  const hs = h("select", { class: "ymd-h", "aria-label": "시" }, opt("", "시"), ...Array.from({ length: 12 }, (_, i) => opt(i + 1, `${i + 1}시`)));
  const ms = h("select", { class: "ymd-min", "aria-label": "분" });
  const clock = h("button", { type: "button", class: "ymd-cal", title: "시계에서 고르기" }, "🕐");
  const wrap = h("span", { class: "ymd" }, ap, hs, ms, clock);
  input.before(wrap);
  wrap.append(input);
  input.classList.add("ymd-native");
  const fillMinutes = (keep) => {
    const list = Array.from({ length: 12 }, (_, i) => i * 5);
    if (keep != null && !list.includes(keep)) { list.push(keep); list.sort((a, b) => a - b); }
    ms.replaceChildren(opt("", "분"), ...list.map((m) => opt(m, `${String(m).padStart(2, "0")}분`)));
  };
  const show = () => {
    const m = /^(\d{2}):(\d{2})/.exec(dateNative.get.call(input) || "");
    fillMinutes(m ? Number(m[2]) : null);
    if (!m) { ap.value = "pm"; hs.value = ms.value = ""; return; } // 비어 있으면 '오후'부터
    const H = Number(m[1]);
    ap.value = H < 12 ? "am" : "pm";
    hs.value = String(H % 12 || 12);
    ms.value = String(Number(m[2]));
    for (const s of [ap, hs, ms]) s.disabled = input.disabled;
  };
  const commit = () => {
    if (hs.value && !ap.value) ap.value = "pm"; // 시를 고르면 나머지는 오후·00분부터
    if (hs.value && !ms.value) ms.value = "0";
    const two = (n) => String(n).padStart(2, "0");
    const H = hs.value ? (Number(hs.value) % 12) + (ap.value === "pm" ? 12 : 0) : null;
    const v = H != null && ms.value !== "" ? `${two(H)}:${two(ms.value)}` : "";
    if (v === dateNative.get.call(input)) return;
    dateNative.set.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  for (const s of [ap, hs, ms]) s.addEventListener("change", commit);
  clock.addEventListener("click", () => { try { input.showPicker(); } catch { input.focus(); } });
  input.addEventListener("change", show);
  input.addEventListener("input", show);
  Object.defineProperty(input, "value", {
    configurable: true,
    get() { return dateNative.get.call(this); },
    set(v) { dateNative.set.call(this, v); show(); },
  });
  show();
}

function enhanceDates(root) {
  if (root.matches?.('input[type="date"]')) enhanceDateInput(root);
  root.querySelectorAll?.('input[type="date"]').forEach(enhanceDateInput);
  if (root.matches?.('input[type="time"]')) enhanceTimeInput(root);
  root.querySelectorAll?.('input[type="time"]').forEach(enhanceTimeInput);
}
if (typeof document !== "undefined") {
  const startDates = () => {
    enhanceDates(document.body);
    new MutationObserver((list) => { for (const r of list) for (const n of r.addedNodes) if (n.nodeType === 1) enhanceDates(n); })
      .observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) startDates(); else document.addEventListener("DOMContentLoaded", startDates);
}
