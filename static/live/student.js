/* 학생 화면 */
let S = null; // 서버에서 받은 최신 상태
let sock = null;
let media = { id: null, room: null }; // 지금 들어가 있는 화상 방
let joinSeq = 0;
let ended = false;
const prefs = { cam: true, mic: false }; // 학생이 원하는 카메라·마이크 상태 (방을 옮겨도 유지)
let activeTab = "chat";
let unread = 0;
let ai = null;
let activitySig = "";
let textDraft = "";
const MAX_PEER_VIDEOS = 6;
let videoSlots = []; // 영상을 받는 친구들
// 선생님 발표(PDF)·화이트보드: 이때는 자료 화면만 크게 보여 준다(선생님 목소리는 계속 들림)
const presenter = new Presenter($("#present"), { code: CODE, canDraw: false, send: () => {} });

$("#code").textContent = CODE;
api("/api/me").then(({ user }) => {
  if (!user || (user.role !== "student" && !user.is_admin) || user.needs_profile) location.replace(`/live?c=${CODE}`);
  else $("#prejoin-name").textContent = `${user.display} 이름으로 들어가요.`;
}).catch(() => {});

/* ───── 입장 ───── */

$("#prejoin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  prefs.cam = $("#pre-cam").checked;
  prefs.mic = $("#pre-mic").checked;
  $("#prejoin").hidden = true;
  // 입장할 때 마이크·카메라 사용을 미리 허락받아 둔다 → 수업 중에 선생님이 켜면 바로 켜진다
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    st.getTracks().forEach((tr) => tr.stop());
  } catch {
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((tr) => tr.stop()); } catch { /* 나중에 켤 때 다시 물어봄 */ }
  }
  sock = new LiveSocket("", onMessage, (ok) => {
    $("#status").textContent = ok ? "● 연결됨" : "다시 연결하는 중…";
    $("#status").classList.toggle("bad", !ok);
  });
});

function onMessage(msg) {
  switch (msg.t) {
    case "state":
      S = msg;
      render();
      reconcileRoom();
      break;
    case "chat_init":
      $("#chatlog").replaceChildren();
      msg.msgs.forEach((m) => addChat(m, false));
      break;
    case "chat":
      addChat(msg.msg, true);
      break;
    case "cmd":
      if (msg.cmd === "mute" && prefs.mic) { setMic(false); toast("선생님이 마이크를 껐어요."); }
      if (msg.cmd === "cam_off" && prefs.cam) { setCam(false); toast("선생님이 카메라를 껐어요."); }
      // 선생님이 켬: 권한 정보(state)보다 먼저 올 수 있어 여기서 바로 반영하고 켠다
      if (msg.cmd === "mic_on") { if (S) S.me.can_speak = true; setMic(true, true).then(() => prefs.mic && toast("🎤 선생님이 마이크를 켰어요.")); }
      if (msg.cmd === "cam_on") { if (S) S.me.can_cam = true; prefs.cam = true; syncCamera().then(() => prefs.cam && toast("📷 선생님이 카메라를 켰어요.")); }
      break;
    case "strokes":
    case "stroke":
    case "stroke_del":
      presenter.onMessage(msg);
      break;
    case "sticker":
      showSticker(msg, msg.target && msg.target === S?.me?.id);
      break;
    case "kicked":
      finish("선생님이 수업에서 내보냈어요.");
      break;
    case "ended":
      finish("수업이 끝났어요. 수고했어요! 👋");
      break;
    case "error":
      if (msg.code === "login") location.replace(`/live?c=${CODE}`);
      else finish(msg.text);
      break;
  }
}

function finish(text) {
  ended = true;
  sock?.stop();
  joinSeq++;
  disposeRoom(media.room);
  media = { id: null, room: null };
  document.body.append(h("div", { class: "overlay" },
    h("div", { class: "card" }, h("h2", { style: "margin:0" }, text),
      h("button", { class: "primary", onclick: () => { location.href = "/live"; } }, "처음 화면으로"))));
}

/* ───── 화상 방 들어가기·옮기기 ───── */

/** 마이크는 자유. 다만 선생님이 내 마이크를 끈 동안(🔒)은 선생님이 다시 켜 줄 때까지 못 켠다 (모둠에서는 자유) */
function micAllowed() {
  if (!S) return true;
  return !(S.me.mic_blocked && S.room === "main");
}

/** 카메라는 언제나 내가 켜고 끈다 (데이터 절약 모드는 화질만 낮춘다) */
function camAllowed() {
  return true;
}

async function reconcileRoom() {
  if (ended || !S || !S.livekit) return;
  if (media.id === S.room) return;
  const target = S.room;
  const seq = ++joinSeq;
  const old = media.room;
  media = { id: target, room: null };
  if (old) await disposeRoom(old);
  prefs.screen = false; // 화면 공유는 방을 옮기면 끝난다
  renderMedia(null);
  if (target !== "main") toast(`${S.group?.name || "모둠"}으로 이동해요`);
  try {
    const studentMode = new URLSearchParams(location.search).has("as_student") ? "?as_student=1" : "";
    const { url, token } = await api(`/api/live/classes/${CODE}/token${studentMode}`, { room: target });
    if (seq !== joinSeq) return;
    const room = createRoom(renderMedia);
    room.on(RoomEvent.Disconnected, () => {
      if (media.room !== room || ended) return; // 일부러 나간 경우
      media = { id: null, room: null };
      toast("화상 연결이 끊겼어요. 다시 연결할게요.");
      setTimeout(reconcileRoom, 2000);
    });
    media.room = room;
    await room.connect(url, token);
    if (seq !== joinSeq) { room.disconnect(); return; }
    await applyPrefs();
    renderMedia(room);
  } catch (err) {
    console.error(err);
    if (seq !== joinSeq) return;
    media = { id: null, room: null };
    toast(`화상 연결 실패: ${err.message}`);
    setTimeout(reconcileRoom, 4000);
  }
}

async function applyPrefs() {
  await syncCamera();
  await setMic(prefs.mic && micAllowed(), true);
}

/** 기기 문제(권한 거부 등)는 사용자에게 알리고, 화상 서버 권한이 아직 반영되지 않은 경우는 잠시 뒤 다시 시도한다. */
function retryable(err) { return !MEDIA_ERRORS.has(err?.name); }

async function setMic(on, quiet = false, attempt = 0) {
  if (on && !micAllowed()) { toast("선생님이 마이크를 껐어요. 말하고 싶으면 '✋ 손 들기'를 눌러 주세요."); return; }
  prefs.mic = on;
  const lp = media.room?.localParticipant;
  if (lp && media.room.state === "connected") {
    try {
      await lp.setMicrophoneEnabled(on);
    } catch (err) {
      if (on && retryable(err) && attempt < 3) { setTimeout(() => prefs.mic && setMic(true, true, attempt + 1), 1500); return; }
      prefs.mic = false;
      if (!quiet || on) toast(mediaError(err), 5000);
    }
  }
  renderControls();
}

/** prefs.cam = 학생이 원하는 상태. 실제로 켤지는 지금 방·설정이 허용하는지에 따라 정한다. */
let camOp = null; // 진행 중인 카메라 작업 { room }
let camAgain = false;
let camLowbw = null; // 지금 카메라 트랙이 어떤 화질 설정으로 만들어졌는지

async function syncCamera(attempt = 0) {
  const room = media.room;
  // 옮겨 가는 중이면(곧 닫힐 방) 건드리지 않는다. 새 방에 들어가면 다시 불린다.
  if (!room || room.state !== "connected" || media.id !== S?.room) return renderControls();
  if (camOp?.room === room) { camAgain = true; return; }
  camOp = { room };
  try {
    const lp = room.localParticipant;
    const want = prefs.cam && camAllowed();
    const lowbw = !!S?.settings.lowbw;
    // 화질 설정이 바뀌었으면 트랙을 완전히 내린다(끄기만 하면 예전 화질 설정이 남는다)
    const pub = lp.getTrackPublication(Track.Source.Camera);
    if (pub?.track && camLowbw !== lowbw) await withTimeout(lp.unpublishTrack(pub.track, true));
    if (lp.isCameraEnabled !== want) {
      const [capture, publish] = cameraOptions(lowbw, "student");
      await withTimeout(lp.setCameraEnabled(want, capture, publish));
      if (want) camLowbw = lowbw;
    }
  } catch (err) {
    if (retryable(err) && attempt < 3) setTimeout(() => syncCamera(attempt + 1), 1500);
    else { prefs.cam = false; toast(mediaError(err), 5000); }
  } finally {
    if (camOp?.room === room) camOp = null;
  }
  if (camAgain) { camAgain = false; return syncCamera(); }
  renderControls();
}

async function setCam(on) {
  prefs.cam = on;
  if (on && !camAllowed()) toast("데이터 절약 모드라 카메라는 모둠 활동 때나 선생님이 켜 줄 때 켜져요.");
  await syncCamera();
}

function renderMedia(room) {
  if (room && room !== media.room) return;
  const stage = $("#stage");
  const grid = $("#grid");
  const inGroup = S && S.room !== "main";
  const presenting = !!S?.present;
  stage.hidden = inGroup || presenting;
  grid.hidden = presenting;
  if (presenting) { // 자료 화면만 보여 준다. 영상은 받지 않아 데이터도 아낀다(소리는 계속).
    syncTiles(stage, []); syncTiles(grid, []);
    $("#sound").hidden = !room || room.canPlaybackAudio;
    renderControls();
    return;
  }
  if (!room) { syncTiles(stage, []); syncTiles(grid, []); $("#stage-empty").hidden = false; renderControls(); return; }

  const people = allParticipants(room);
  const teacher = people.find((p) => p.identity === "teacher") || people.find(isTeacher); // 팀티칭이면 수업을 연 선생님이 크게
  if (inGroup) {
    syncTiles(stage, []);
    // 선생님은 모둠에서 말할 때만 타일로 보인다(듣기만 할 때는 위 배너로 안내)
    const items = [];
    for (const p of people) {
      if (isTeacher(p) && !p.getTrackPublication(Track.Source.Microphone) && !p.getTrackPublication(Track.Source.Camera)) continue;
      items.push(cameraItem(room, p, isTeacher(p) ? { flag: "👩‍🏫" } : {}));
      const sc = screenItem(room, p);
      if (sc) items.push(sc);
    }
    grid.classList.add("big");
    syncTiles(grid, items);
  } else {
    // 선생님이 고른 화면 구성: teacher(선생님 크게) grid(모두 나열) debate(토론: 학생 둘 나란히)
    const mode = S?.layout?.mode || "teacher";
    const sc = teacher ? screenItem(room, teacher) : null;
    const stageItems = [];
    if (mode === "debate" && !sc) {
      for (const x of S.layout.pair || []) {
        const p = x.id === S.me.id ? room.localParticipant : room.remoteParticipants.get(x.identity);
        if (p) stageItems.push(cameraItem(room, p, { name: x.name, flag: "🗣️" }));
      }
    } else if (teacher && (mode === "teacher" || sc)) {
      if (sc) stageItems.push(sc, cameraItem(room, teacher, { pip: true, name: "선생님" }));
      else stageItems.push(cameraItem(room, teacher, { name: "선생님" }));
    }
    stage.hidden = !stageItems.length && mode === "grid";
    stage.classList.toggle("duo", mode === "debate" && stageItems.length === 2);
    grid.classList.toggle("big", mode === "grid");
    syncTiles(stage, stageItems);
    $("#stage-empty").hidden = stageItems.length > 0 || mode === "grid";
    if (mode === "teacher" && !sc) { // 선생님만 크게: 친구 영상은 받지 않고 내 화면만 작게
      syncTiles(grid, [cameraItem(room, room.localParticipant, { flag: S?.me?.hand ? "✋" : "" })]);
      $("#sound").hidden = room.canPlaybackAudio;
      renderControls();
      return;
    }
    // 데이터 절약: 친구 영상은 최대 MAX_PEER_VIDEOS명만 받는다(말하는 친구 우선). 나머지는 이름만.
    const peers = people.filter((p) => !isTeacher(p) && p !== room.localParticipant);
    const ids = new Set(peers.map((p) => p.identity));
    videoSlots = videoSlots.filter((id) => ids.has(id));
    for (const p of peers.filter((x) => x.isSpeaking)) {
      if (videoSlots.includes(p.identity)) continue;
      if (videoSlots.length >= MAX_PEER_VIDEOS) videoSlots.shift();
      videoSlots.push(p.identity);
    }
    for (const p of peers) if (videoSlots.length < MAX_PEER_VIDEOS && !videoSlots.includes(p.identity)) videoSlots.push(p.identity);
    const others = mode === "grid" && teacher ? [teacher] : [];
    const debaters = new Set(mode === "debate" ? (S.layout.pair || []).map((x) => x.identity) : []);
    const me = debaters.has(room.localParticipant.identity) ? [] : [room.localParticipant];
    syncTiles(grid, [...others, ...me, ...peers.filter((p) => !debaters.has(p.identity))].map((p) => {
      if (p === teacher) return cameraItem(room, p, { name: "선생님", flag: "👩‍🏫" });
      const it = cameraItem(room, p, { flag: S?.me && p === room.localParticipant && S.me.hand ? "✋" : "" });
      if (p !== room.localParticipant && !videoSlots.includes(p.identity)) it.track = null;
      return it;
    }));
  }
  $("#sound").hidden = room.canPlaybackAudio;
  renderControls();
}

/* ───── 화면 그리기 ───── */

const mediaShare = new MediaShare($("#media"), { code: CODE });

function render() {
  document.title = `${S.title} · 실시간 수업`;
  $("#title").textContent = S.title;
  $("#online").textContent = `👥 ${S.online_count}명`;
  renderBanners();
  renderActivity();
  mediaShare.set(S.media);
  $("#present").hidden = !S.present || !!S.media; // 미디어를 다 같이 보는 동안은 문서를 가린다
  presenter.setView(S.present);
  renderQuestions();
  renderTabs();
  if (!micAllowed() && prefs.mic) setMic(false);
  syncCamera(); // 방 이동·설정 변경·발언권에 맞춰 카메라를 켜고 끈다
  renderMedia(media.room);
  const toAll = $("#chat-to").querySelector("option[value=all]");
  toAll.textContent = S.room === "main" ? "모두에게" : `${S.group?.name || "모둠"}에게`;
  $("#chatinput").placeholder = $("#chat-to").value === "teacher" ? "선생님에게만 보내기 (1:1)" : `${toAll.textContent} 보내기`;
}

function renderControls() {
  const connected = media.room?.state === "connected";
  const mic = $("#mic");
  mic.textContent = prefs.mic ? "🎤 마이크 켜짐" : "🔇 마이크 꺼짐";
  mic.classList.toggle("on", prefs.mic);
  mic.disabled = !connected;
  if (S && !micAllowed()) {
    mic.textContent = "🔒 마이크 꺼짐";
    mic.title = "선생님이 마이크를 껐어요. 선생님이 다시 켜 주면 쓸 수 있어요";
    mic.classList.remove("on");
  } else mic.title = "마이크";
  const cam = $("#cam");
  const camOk = camAllowed();
  cam.textContent = prefs.cam ? "📷 카메라 켜짐" : "📷 카메라 꺼짐";
  cam.title = "카메라";
  cam.classList.toggle("on", prefs.cam && camOk);
  cam.disabled = !connected;
  if (!S) return;
  const hand = $("#hand");
  hand.classList.toggle("on", S.me.hand);
  hand.textContent = S.me.hand ? "✋ 손 내리기" : "✋ 손 들기";
  const inGroup = S.room !== "main";
  $("#screen").hidden = !inGroup;
  $("#screen").disabled = !connected;
  $("#screen").classList.toggle("on", !!prefs.screen);
  $("#help").hidden = !inGroup;
  $("#help").classList.toggle("on", S.me.help);
  $("#help").textContent = S.me.help ? "🙋 호출 취소" : "🙋 선생님 호출";
}

function renderBanners() {
  const box = $("#banners");
  box.replaceChildren();
  if (S.recording) box.append(h("div", { class: "banner rec" }, h("strong", {}, "🔴 녹화 중"),
    h("span", {}, "선생님이 수업을 녹화하고 있어요. 녹화본은 선생님 컴퓨터에 저장되고 수업 목적으로만 쓰여요.")));
  if (!S.livekit) box.append(h("div", { class: "banner warn" }, "화상 서버가 아직 설정되지 않아 영상 없이 진행돼요."));
  if (!S.teacher_online) box.append(h("div", { class: "banner warn" }, "선생님이 아직 들어오지 않았어요."));
  if (S.announce) box.append(h("div", { class: "banner" }, h("strong", {}, "📢 공지"), h("span", {}, S.announce.text)));
  if (S.room !== "main" && S.group) {
    const timer = h("span", { class: "timer", id: "group-timer" });
    box.append(h("div", { class: "banner ok" },
      h("strong", {}, `👥 ${S.group.name}`), h("span", { class: "muted" }, S.group.members.join(", ")),
      h("span", { class: "grow" }), S.ends_at ? timer : null));
    if (S.teacher_broadcast) box.append(h("div", { class: "banner warn" }, "📢 선생님이 모든 모둠에 안내하고 있어요. 잘 들어 주세요."));
    else if (S.teacher_talking) box.append(h("div", { class: "banner" }, "👩‍🏫 선생님이 우리 모둠에 들어와 말하고 있어요."));
    else if (S.teacher_listening) box.append(h("div", { class: "banner" }, "🎧 선생님이 우리 모둠 이야기를 듣고 있어요."));
    tickTimer();
  }
  if (S.me.mic_blocked && S.room === "main") {
    box.append(h("div", { class: "banner warn" }, "🔒 선생님이 내 마이크를 껐어요. 말하고 싶으면 '✋ 손 들기'를 눌러 주세요."));
  }
}

function tickTimer() {
  const el = $("#group-timer");
  if (!el || !S?.ends_at) return;
  const r = fmtRemaining(S.ends_at);
  el.textContent = r.over ? "⏰ 시간 끝" : `⏱ ${r.text}`;
  el.classList.toggle("over", r.over);
}
setInterval(tickTimer, 1000);

function renderActivity() {
  const a = S.activity;
  const sig = JSON.stringify(a);
  if (sig === activitySig) return;
  const changedId = !a || JSON.parse(activitySig || "null")?.id !== a.id;
  activitySig = sig;
  if (changedId) textDraft = "";
  const box = $("#activity");
  box.replaceChildren();
  if (!a) return;

  const card = h("section", { class: "activity", "aria-live": "polite" },
    h("div", { class: "kind" }, `${KIND_NAMES[a.kind]}${a.open ? "" : " · 마감됨"}`),
    h("h3", {}, a.prompt));

  if (a.kind === "text") {
    if (a.open) {
      const input = h("textarea", { rows: 2, maxlength: 300, placeholder: "답을 적어 주세요", value: textDraft || (typeof a.mine === "string" ? a.mine : "") });
      input.addEventListener("input", () => { textDraft = input.value; });
      card.append(h("form", { class: "row", onsubmit: (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (v && sock.send({ t: "answer", id: a.id, value: v })) toast("답을 보냈어요. 마감 전까지 고칠 수 있어요.");
      } }, input, h("button", { class: "primary", type: "submit" }, a.mine ? "고쳐서 내기" : "제출")));
    }
    if (a.mine) card.append(h("div", { class: "muted" }, `내 답: ${a.mine}`));
    if (a.reveal && a.texts) {
      card.append(h("div", { class: "muted" }, `친구들의 답 (${a.texts.length}개)`),
        h("div", { class: "texts" }, a.texts.map((t) => h("div", {}, t))));
    }
  } else {
    const opts = h("div", { class: `options ${a.kind === "ox" ? "ox" : ""}` }, a.options.map((opt, i) =>
      h("button", {
        class: [a.mine === i ? "chosen" : "", a.reveal && a.correct === i ? "correct" : ""].join(" "),
        disabled: !a.open,
        onclick: () => sock.send({ t: "answer", id: a.id, value: i }),
      }, a.kind === "ox" ? opt : `${i + 1}. ${opt}`)));
    card.append(opts);
    if (a.mine === null || a.mine === undefined) {
      if (a.open) card.append(h("div", { class: "muted" }, "답을 골라 주세요. 마감 전까지 바꿀 수 있어요."));
    } else if (a.reveal && a.correct !== null && a.correct !== undefined) {
      card.append(h("div", { style: "font-weight:700" }, a.mine === a.correct ? "⭕ 정답이에요!" : "❌ 아쉬워요. 다시 생각해 볼까요?"));
    }
    if (a.reveal) card.append(resultBars(a));
  }
  box.append(card);
}

function renderQuestions() {
  if (!$("#myquestions")) return; // 질문 탭은 없앴다 (선생님에게 1:1 채팅으로)
  $("#myquestions").replaceChildren(...S.my_questions.slice().reverse().map((q) =>
    h("div", { class: `q ${q.done ? "done" : ""}` },
      h("div", { class: "meta" }, `${fmtTime(q.ts)} · ${q.done ? "선생님이 확인했어요" : "확인 대기 중"}`),
      h("div", {}, q.text),
      q.reply ? h("div", { class: "reply" }, `👩‍🏫 ${q.reply}`) : null)));
}

function renderTabs() {
  $("#ai-tab").hidden = !S.settings.ai;
  if (!S.settings.ai && activeTab === "ai") showTab("chat");
  if (S.settings.ai && !ai) ai = new AIChat($("#ai-panel"));
}

function showTab(name) {
  activeTab = name;
  for (const b of $("#tabs").children) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
  if (name === "chat") { unread = 0; $("#chat-badge").hidden = true; const log = $("#chatlog"); log.scrollTop = log.scrollHeight; }
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
});

function addChat(m, live) {
  const log = $("#chatlog");
  const stick = nearBottom(log);
  const dm = m.scope?.startsWith("dm:");
  const bubble = chatBubble(m, { mine: m.sid === S?.me?.id, scopeName: dm ? (m.role === "teacher" ? "🔒 나에게 1:1" : "🔒 선생님에게 1:1") : null });
  if (dm) bubble.classList.add("private");
  log.append(bubble);
  if (stick || m.sid === S?.me?.id) log.scrollTop = log.scrollHeight;
  if (live && activeTab !== "chat") {
    unread++;
    $("#chat-badge").textContent = unread;
    $("#chat-badge").hidden = false;
  }
}

/* ───── 버튼 ───── */

$("#chatform").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#chatinput");
  const text = input.value.trim();
  const to = $("#chat-to").value === "teacher" ? "teacher" : undefined;
  if (text && sock?.send({ t: "chat", text, to })) input.value = "";
});
submitOnEnter($("#chatinput"), $("#chatform"));

$("#askform")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#askinput");
  const text = input.value.trim();
  if (text && sock?.send({ t: "question", text })) { input.value = ""; toast("선생님께 질문을 보냈어요."); }
});
if ($("#askinput")) submitOnEnter($("#askinput"), $("#askform"));

$("#mic").addEventListener("click", () => setMic(!prefs.mic));
$("#cam").addEventListener("click", () => setCam(!prefs.cam));
$("#hand").addEventListener("click", () => sock?.send({ t: "hand", up: !S?.me.hand }));
$("#help").addEventListener("click", () => sock?.send({ t: "help", on: !S?.me.help }));
$("#sound").addEventListener("click", () => media.room?.startAudio().then(() => renderMedia(media.room)));

async function setScreen(on) {
  const lp = media.room?.localParticipant;
  prefs.screen = false;
  if (!lp) return renderControls();
  try {
    const [capture, publish] = screenOptions(!!S?.settings.lowbw);
    await lp.setScreenShareEnabled(on, capture, publish);
    prefs.screen = on;
  } catch (err) {
    if (err?.name !== "NotAllowedError") toast("화면 공유를 시작하지 못했어요. 휴대폰에서는 지원되지 않을 수 있어요.");
  }
  renderControls();
}
$("#screen").addEventListener("click", () => setScreen(!prefs.screen));

$("#leave").addEventListener("click", () => {
  if (!confirm("수업에서 나갈까요? 코드로 다시 들어올 수 있어요.")) return;
  ended = true;
  sock?.send({ t: "leave" }, true); // 출결에 '나가기 버튼'으로 남긴다
  sock?.stop();
  disposeRoom(media.room);
  location.href = "/live";
});

$("#chat-to").addEventListener("change", () => {
  $("#chatinput").placeholder = $("#chat-to").value === "teacher" ? "선생님에게만 보내기 (1:1)" : "모두에게 보내기";
  $("#chatinput").focus();
});
