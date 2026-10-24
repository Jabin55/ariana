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

$("#code").textContent = CODE;
api("/api/me").then(({ user }) => {
  if (!user || user.role !== "student" || user.needs_profile) location.replace(`/live?c=${CODE}`);
  else $("#prejoin-name").textContent = `${user.display} 이름으로 들어가요.`;
}).catch(() => {});

/* ───── 입장 ───── */

$("#prejoin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  prefs.cam = $("#pre-cam").checked;
  prefs.mic = $("#pre-mic").checked;
  $("#prejoin").hidden = true;
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

function micAllowed() {
  if (!S) return true;
  return !(S.settings.mic_lock && S.room === "main" && !S.me.can_speak);
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
    const { url, token } = await api(`/api/live/classes/${CODE}/token`, { room: target });
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
  await setCam(prefs.cam, true);
  await setMic(prefs.mic && micAllowed(), true);
}

async function setMic(on, quiet = false) {
  if (on && !micAllowed()) { toast("선생님이 마이크를 잠갔어요. 말하고 싶으면 손을 들어 주세요."); return; }
  prefs.mic = on;
  const lp = media.room?.localParticipant;
  if (lp && media.room.state === "connected") {
    try { await lp.setMicrophoneEnabled(on); } catch (err) { prefs.mic = false; if (!quiet || on) toast(mediaError(err), 5000); }
  }
  renderControls();
}

async function setCam(on, quiet = false) {
  prefs.cam = on;
  const lp = media.room?.localParticipant;
  if (lp && media.room.state === "connected") {
    try { await lp.setCameraEnabled(on); } catch (err) { prefs.cam = false; if (!quiet || on) toast(mediaError(err), 5000); }
  }
  renderControls();
}

function renderMedia(room) {
  if (room && room !== media.room) return;
  const stage = $("#stage");
  const grid = $("#grid");
  const inGroup = S && S.room !== "main";
  stage.hidden = inGroup;
  if (!room) { syncTiles(stage, []); syncTiles(grid, []); $("#stage-empty").hidden = false; renderControls(); return; }

  const people = allParticipants(room);
  const teacher = people.find(isTeacher);
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
    grid.classList.remove("big");
    const stageItems = [];
    if (teacher) {
      const sc = screenItem(room, teacher);
      if (sc) stageItems.push(sc, cameraItem(room, teacher, { pip: true, name: "선생님" }));
      else stageItems.push(cameraItem(room, teacher, { name: "선생님" }));
    }
    syncTiles(stage, stageItems);
    $("#stage-empty").hidden = stageItems.length > 0;
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
    syncTiles(grid, [room.localParticipant, ...peers].map((p) => {
      const it = cameraItem(room, p, { flag: S?.me && p === room.localParticipant && S.me.hand ? "✋" : "" });
      if (p !== room.localParticipant && !videoSlots.includes(p.identity)) it.track = null;
      return it;
    }));
  }
  $("#sound").hidden = room.canPlaybackAudio;
  renderControls();
}

/* ───── 화면 그리기 ───── */

function render() {
  document.title = `${S.title} · 실시간 수업`;
  $("#title").textContent = S.title;
  $("#online").textContent = `👥 ${S.online_count}명`;
  renderBanners();
  renderActivity();
  renderQuestions();
  renderTabs();
  if (!micAllowed() && prefs.mic) setMic(false);
  renderMedia(media.room);
  const note = $("#chat-note");
  note.hidden = S.settings.chat;
  note.textContent = "선생님이 채팅을 잠시 막아 두었어요.";
  $("#chatinput").disabled = !S.settings.chat;
  $("#chatinput").placeholder = S.room === "main" ? "모두에게 보내기" : `${S.group?.name || "모둠"}에 보내기`;
}

function renderControls() {
  const connected = media.room?.state === "connected";
  const mic = $("#mic");
  mic.textContent = prefs.mic ? "🎤 마이크 켜짐" : "🔇 마이크 꺼짐";
  mic.classList.toggle("on", prefs.mic);
  mic.disabled = !connected;
  if (S && !micAllowed()) mic.textContent = "🔒 마이크 잠김";
  const cam = $("#cam");
  cam.textContent = prefs.cam ? "📷 카메라 켜짐" : "📷 카메라 꺼짐";
  cam.classList.toggle("on", prefs.cam);
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
  if (S.settings.mic_lock && S.room === "main") {
    box.append(h("div", { class: "banner warn" }, S.me.can_speak
      ? "🎤 선생님이 발언을 허락했어요. 마이크를 켜고 말해 보세요."
      : "🔒 지금은 선생님만 말할 수 있어요. 말하고 싶으면 ✋ 손을 들어 주세요."));
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
  log.append(chatBubble(m, { mine: m.sid === S?.me?.id }));
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
  if (text && sock?.send({ t: "chat", text })) input.value = "";
});
submitOnEnter($("#chatinput"), $("#chatform"));

$("#askform").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#askinput");
  const text = input.value.trim();
  if (text && sock?.send({ t: "question", text })) { input.value = ""; toast("선생님께 질문을 보냈어요."); }
});
submitOnEnter($("#askinput"), $("#askform"));

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
    await lp.setScreenShareEnabled(on, { audio: true });
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
