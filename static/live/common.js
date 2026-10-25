/* 실시간 수업: 선생님·학생 화면이 함께 쓰는 코드 */
const { Room, RoomEvent, Track, VideoPresets, VideoQuality } = window.LivekitClient;

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
    const ws = new WebSocket(`${proto}://${location.host}/ws/live/${CODE}`);
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

function shortName(name) {
  const n = (name || "?").trim();
  return n.length >= 3 && /^[가-힣]+$/.test(n) ? n.slice(-2) : n.slice(0, 2);
}

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
  avatar.textContent = shortName(it.name);
  tile.querySelector(".label span").textContent = `${it.micOff ? "🔇 " : "🎙️ "}${it.name}${it.isLocal ? " (나)" : ""}`;
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
  if (name === "NotAllowedError") return "카메라·마이크 권한이 막혀 있어요. 주소창 왼쪽 자물쇠 아이콘에서 허용해 주세요.";
  if (name === "NotFoundError") return "카메라나 마이크를 찾을 수 없어요.";
  if (name === "NotReadableError") return "다른 프로그램이 카메라·마이크를 쓰고 있어요.";
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
  const total = a.total || 0;
  return h("div", { class: "bars" }, a.options.map((opt, i) => {
    const n = a.counts?.[i] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    return h("div", { class: `bar ${a.correct === i ? "correct" : ""}` },
      h("span", { class: "name" }, opt), h("span", { class: "muted" }, `${n}명 (${pct}%)`),
      h("div", { class: "track" }, h("div", { class: "fill", style: `width:${pct}%` })));
  }));
}

const KIND_NAMES = { ox: "OX 퀴즈", choice: "객관식", poll: "투표", text: "주관식" };

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
  // 학생(모둠 활동): 180p·15fps·최대 120kbps 한 층
  return [{ resolution: { ...VideoPresets.h180.resolution, frameRate: 15 } },
    { videoEncoding: { maxBitrate: 120_000, maxFramerate: 15 }, simulcast: false }];
}

/** 화면 공유 [캡처 옵션, 전송 옵션]. 저대역폭 모드면 720p·초당 5장(슬라이드에 충분)·최대 500kbps. */
function screenOptions(lowbw, extra = {}) {
  if (!lowbw) return [{ audio: true, ...extra }, {}];
  return [{ audio: true, contentHint: "detail", resolution: { width: 1280, height: 720, frameRate: 5 }, ...extra },
    { screenShareEncoding: { maxBitrate: 500_000, maxFramerate: 5 }, screenShareSimulcastLayers: [] }];
}
