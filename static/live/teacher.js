/* 선생님 화면 */
let CFG = null; // /api/me 설정 (구글 드라이브 연결 등)
api("/api/me").then((cfg) => {
  CFG = cfg;
  if (!cfg.user || cfg.user.role !== "teacher") location.replace(cfg.user ? "/live" : "/live?login=1");
  $("#rec-btn").hidden = !cfg.recording_allowed;
}).catch(() => {});

let S = null;
let sock = null;
let mainRoom = null;
const prefs = { cam: true, mic: true, screen: false };
const studentLink = `${location.origin}/live?c=${CODE}`;

// 모둠 관찰: 모둠마다 별도의 화상 연결을 연다
const monitors = new Map(); // gid → { room, card, grid }
const listening = new Set();
let talking = null;
let broadcast = null; // 모든 모둠에 동시에 말하기: { src, pubs: [{ room, track }] }
let focusGroup = null;
const monitorAudio = h("div", { hidden: true });
document.body.append(monitorAudio);
const presenter = new Presenter($("#present"), { code: CODE, canDraw: true, send: (m) => sock?.send(m) });
let showStudents = store.get("present-show-students") ?? true; // 발표 중에 학생 영상도 볼지 (선생님 화면만)
let lastDevSig = "";

$("#code").textContent = CODE;
$("#share-code").textContent = CODE;
$("#share-url").textContent = studentLink;

/* ───── 시작 ───── */

// 들어가기 전에 내 카메라·마이크가 되는지 바로 보여 준다
const stopPreview = devicePreview({ video: $("#pre-video"), meter: $("#pre-meter"), err: $("#pre-err"),
  camBox: $("#pre-cam"), micBox: $("#pre-mic") });

$("#prejoin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  stopPreview(); // 미리보기로 잡고 있던 카메라를 놓아 줘야 수업에서 켤 수 있다
  prefs.cam = $("#pre-cam").checked;
  prefs.mic = $("#pre-mic").checked;
  $("#prejoin").hidden = true;
  sock = new LiveSocket("", onMessage, (ok) => {
    $("#status").textContent = ok ? "● 연결됨" : "다시 연결하는 중…";
    $("#status").classList.toggle("bad", !ok);
    if (ok && S) sendListen(); // 재접속하면 듣기 상태를 다시 알린다
    if (ok && rec.recorder) sock.send({ t: "recording", on: true }); // 녹화 중이면 학생 화면 표시도 다시
  });
});

function onMessage(msg) {
  switch (msg.t) {
    case "state": {
      const first = !S;
      S = msg;
      S.everyone = msg.students; // 수강생 명단 전체 (안 들어온 학생 포함)
      S.students = msg.students.filter((x) => !x.absent); // 수업에 들어온 적 있는 학생
      render();
      if (first) connectMain();
      break;
    }
    case "chat_init":
      $("#chatlog").replaceChildren();
      msg.msgs.forEach((m) => addChat(m, false));
      break;
    case "chat":
      addChat(msg.msg, true);
      break;
    case "sticker":
      showSticker(msg, false);
      break;
    case "strokes":
    case "stroke":
    case "stroke_del":
      presenter.onMessage(msg);
      break;
    case "ended":
      finish("수업을 종료했어요.");
      break;
    case "error":
      if (msg.code === "login") location.replace("/live?login=1");
      else finish(msg.text);
      break;
  }
}

function finish(text) {
  sock?.stop();
  disposeRoom(mainRoom);
  mainRoom = null;
  for (const gid of [...monitors.keys()]) closeMonitor(gid);
  document.body.append(h("div", { class: "overlay" },
    h("div", { class: "card" }, h("h2", { style: "margin:0" }, text),
      h("button", { class: "primary", onclick: () => { location.href = "/live"; } }, "처음 화면으로"))));
}

/* ───── 전체 교실 화상 ───── */

/** 화상 연결·카메라 문제를 화면에 계속 보여 준다 (잠깐 뜨는 알림만으로는 놓치기 쉬움) */
function rtcState(text, bad = false) {
  $("#rtc-status").textContent = text;
  $("#rtc-status").classList.toggle("bad", bad);
}
let mediaProblem = { cam: "", mic: "" };
function showMediaProblem() {
  const msgs = [...new Set([mediaProblem.cam, mediaProblem.mic].filter(Boolean))];
  $("#rtc-warn").hidden = !msgs.length;
  $("#rtc-warn").replaceChildren(h("span", {}, "⚠️ ", msgs.join(" "),
    " 해결한 뒤 아래 '📷 카메라' 버튼을 다시 누르거나 새로고침하세요."));
}
let rtcFails = 0;

async function connectMain() {
  if (!S.livekit) { rtcState("📡 화상 서버 없음", true); return; }
  try {
    rtcState(rtcFails ? `📡 화상 다시 연결 중… (${rtcFails}번째)` : "📡 화상 연결 중…");
    const { url, token } = await api(`/api/live/classes/${CODE}/token`, { room: "main" });
    const room = createRoom(renderMain);
    room.on(RoomEvent.Disconnected, () => {
      if (mainRoom !== room) return;
      mainRoom = null;
      rtcState("📡 화상 끊김 · 다시 연결 중", true);
      toast("화상 연결이 끊겼어요. 다시 연결할게요.");
      setTimeout(connectMain, 2000);
    });
    mainRoom = room;
    await room.connect(url, token);
    rtcFails = 0;
    rtcState("📡 화상 연결됨");
    $("#rtc-warn").hidden = true;
    await setCam(prefs.cam);
    await setMic(prefs.mic);
    renderMain(room);
  } catch (err) {
    console.error(err);
    mainRoom = null;
    rtcFails += 1;
    rtcState("📡 화상 연결 실패", true);
    // 여러 번 실패하면 원인을 화면에 남긴다 (학교망이 막았거나 화상 서버가 꺼져 있을 수 있음)
    if (rtcFails >= 2) {
      $("#rtc-warn").hidden = false;
      $("#rtc-warn").replaceChildren(h("span", {}, `⚠️ 화상 서버에 연결하지 못하고 있어요 (${err.message || err}). `,
        "다른 인터넷(휴대폰 핫스팟 등)에서도 안 되면 서버 콘솔에서 'cd /opt/live && docker compose ps'로 livekit이 켜져 있는지 확인해 주세요."));
    }
    setTimeout(connectMain, 4000);
  }
}

async function setMic(on) {
  prefs.mic = on;
  if (on && talking) await toggleTalk(talking); // 모둠에서 말하는 중이면 그만두고 전체로
  try {
    await mainRoom?.localParticipant.setMicrophoneEnabled(on);
    mediaProblem.mic = "";
  } catch (err) { prefs.mic = false; mediaProblem.mic = mediaError(err); toast(mediaProblem.mic, 5000); }
  showMediaProblem();
  updateMicMeter();
  renderControls();
}

// 마이크 버튼 옆 소리 막대: 내 목소리가 실제로 나가고 있는지 보여 준다
let stopMicMeter = () => {};
let meterTrack = null;
function updateMicMeter() {
  const track = prefs.mic ? mainRoom?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack : null;
  if (track === meterTrack) return;
  stopMicMeter();
  meterTrack = track || null;
  $("#mic-meter").hidden = !track;
  stopMicMeter = track ? micMeter(track, $("#mic-meter")) : () => {};
}

let camLowbw = null; // 지금 켜진 카메라의 화질 설정

async function setCam(on) {
  prefs.cam = on;
  const lp = mainRoom?.localParticipant;
  try {
    const lowbw = !!S?.settings.lowbw;
    const [capture, publish] = cameraOptions(lowbw, "teacher");
    const pub = lp?.getTrackPublication(Track.Source.Camera);
    if (on && pub?.track && camLowbw !== lowbw) await lp.unpublishTrack(pub.track, true); // 꺼 둔 사이 화질 설정이 바뀜
    await lp?.setCameraEnabled(on, capture, publish);
    if (on) camLowbw = lowbw;
    mediaProblem.cam = "";
  } catch (err) {
    prefs.cam = false;
    mediaProblem.cam = mediaError(err);
    toast(mediaProblem.cam, 5000);
  }
  showMediaProblem();
  renderControls();
}

/** 저대역폭 모드를 바꾸면 켜져 있는 카메라를 새 화질로 다시 켠다 */
async function applyQuality() {
  const lp = mainRoom?.localParticipant;
  if (!lp || !prefs.cam || camLowbw === !!S.settings.lowbw) return;
  camLowbw = !!S.settings.lowbw;
  // 끄기만 하면 예전 화질 설정이 남으므로 트랙을 완전히 내렸다가 다시 올린다
  const pub = lp.getTrackPublication(Track.Source.Camera);
  if (pub?.track) await lp.unpublishTrack(pub.track, true);
  await setCam(true);
  if (prefs.screen) toast("화면 공유는 다시 시작하면 새 화질이 적용돼요.");
}

async function setScreen(on) {
  try {
    const [capture, publish] = screenOptions(!!S?.settings.lowbw, { selfBrowserSurface: "exclude" });
    await mainRoom?.localParticipant.setScreenShareEnabled(on, capture, publish);
    prefs.screen = on;
  } catch (err) {
    prefs.screen = false;
    if (err?.name !== "NotAllowedError") toast("화면 공유를 시작하지 못했어요.");
  }
  renderControls();
}

function renderMain(room) {
  if (room !== mainRoom) return;
  const stage = $("#stage");
  const lp = room.localParticipant;
  const sc = screenItem(room, lp);
  prefs.screen = !!lp.getTrackPublication(Track.Source.ScreenShare);
  const presenting = !!S?.present;
  // 선생님이 고른 화면 구성을 선생님 화면에도 똑같이: teacher(선생님 크게) grid(모두 보기) debate(학생 둘 나란히)
  const mode = S?.layout?.mode || "grid";
  const pair = mode === "debate" ? (S.layout.pair || []).map((id) => `s-${id}`) : [];
  const duo = pair.map((id) => room.remoteParticipants.get(id)).filter(Boolean).map((p) => cameraItem(room, p, { flag: "🗣️" }));
  const me = cameraItem(room, lp, { name: "선생님 (나)" });
  // 학생이 화면을 공유하면 크게 보여 준다 (선생님이 공유 중이면 선생님 화면이 먼저)
  const sharer = sc ? null : [...room.remoteParticipants.values()].find((p) => !isTeacher(p) && screenItem(room, p));
  const ssc = sharer ? screenItem(room, sharer) : null;
  const stageItems = presenting ? [] : sc ? [sc, { ...me, pip: true }]
    : ssc ? [ssc, cameraItem(room, sharer, { pip: true })] : duo.length ? duo : mode === "teacher" ? [me] : [];
  stage.hidden = !stageItems.length;
  stage.classList.toggle("duo", !sc && duo.length === 2);
  syncTiles(stage, stageItems);
  const flags = new Map((S?.students || []).map((s) => [`s-${s.id}`, `${s.mic_req ? "🎙️" : ""}${s.hand ? "✋" : ""}`]));
  const students = [...room.remoteParticipants.values()].filter((p) => !isTeacher(p));
  // 발표 중에 '학생 화면 보기'를 끄면 영상을 받지 않는다(소리는 계속)
  const hideGrid = presenting && !showStudents;
  const selfInStage = stageItems.some((x) => x.key === me.key);
  $("#grid").hidden = hideGrid;
  $("#grid").classList.toggle("strip", selfInStage || duo.length > 0); // 크게 보이는 화면이 있으면 학생은 아래 작은 줄로
  syncTiles($("#grid"), hideGrid ? [] : [...(selfInStage ? [] : [me]),
    ...students.filter((p) => !pair.includes(p.identity)).map((p) => cameraItem(room, p, { flag: flags.get(p.identity) || "" }))]);
  // 학생 마이크·카메라가 켜졌는지는 화상 연결에서 알 수 있다 → 바뀌었을 때만 학생 목록을 다시 그린다
  const devSig = students.map((p) => `${p.identity}:${+p.isMicrophoneEnabled}${+p.isCameraEnabled}`).join(",");
  if (devSig !== lastDevSig) { lastDevSig = devSig; if (S) renderPeople(); }
  $("#grid").classList.toggle("big", students.length < 9 && !$("#grid").classList.contains("strip")); // 학생이 적으면 타일을 크게
  $("#grid-empty").hidden = students.length > 0;
  $("#sound").hidden = room.canPlaybackAudio;
  renderControls();
}

function renderControls() {
  const ok = mainRoom?.state === "connected";
  $("#mic").textContent = prefs.mic ? "🎤" : "🔇";
  $("#mic").title = prefs.mic ? "내 마이크 켜짐 (누르면 꺼져요)" : "내 마이크 꺼짐 (누르면 켜져요)";
  $("#mic").classList.toggle("on", prefs.mic);
  $("#cam").textContent = "📷";
  $("#cam").title = prefs.cam ? "내 카메라 켜짐 (누르면 꺼져요)" : "내 카메라 꺼짐 (누르면 켜져요)";
  $("#cam").classList.toggle("on", prefs.cam);
  $("#screen .rl").textContent = prefs.screen ? "공유 중지" : "화면공유";
  $("#screen").classList.toggle("on", prefs.screen);
  for (const id of ["#mic", "#cam", "#screen"]) $(id).disabled = !ok;
  if (rec.micGain) rec.micGain.gain.value = prefs.mic ? 1 : 0; // 마이크를 끄면 녹화에도 목소리가 안 들어간다
  $("#rec-btn").hidden = CFG ? !CFG.recording_allowed : true;
}

/* ───── 강의 녹화 ─────
 * 선생님 컴퓨터의 브라우저가 이 수업 화면(탭)과 소리를 직접 녹화해 선생님 컴퓨터에 저장한다. 서버에는 올라가지 않는다.
 * - 크롬·엣지: 녹화를 시작할 때 저장할 파일을 고르고, 녹화하는 동안 조금씩 바로 그 파일에 쓴다(4시간 수업도 메모리 걱정 없음).
 * - 그 밖의 브라우저: 끝날 때 한 번에 내려받는다(1시간 이내 권장).
 * 녹화 중에는 학생 화면에 '녹화 중'이 표시된다. */
const rec = { recorder: null, display: null, mic: null, ctx: null, micGain: null, writable: null, chunks: [], chain: Promise.resolve(), started: 0, timer: null, name: "" };

function recMime() {
  // MP4(H.264)를 먼저: 학교 컴퓨터의 기본 동영상 앱·한글 문서·유튜브에서 바로 열린다. 안 되면 WebM.
  const types = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4;codecs=avc1,opus", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
}

async function startRecording() {
  if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
    alert("이 브라우저에서는 녹화할 수 없어요. 컴퓨터의 크롬이나 엣지에서 해 주세요.");
    return;
  }
  if (!confirm("수업을 녹화할까요?\n\n· 이 수업 화면과 소리(선생님 목소리, 학생 목소리)가 이 컴퓨터에 동영상 파일로 저장돼요. 서버에는 올라가지 않아요.\n"
    + "· 녹화하는 동안 학생 화면에 '🔴 녹화 중'이 표시돼요.\n· 녹화본에는 학생의 얼굴·목소리·이름이 담기니 수업 목적으로만 쓰고, 다른 곳에 올리거나 공유하지 말고, 보관 기간이 지나면 지워 주세요.\n\n"
    + "다음 화면에서 녹화할 화면으로 '이 탭'을 고르고 '탭 오디오 공유'를 켜 주세요.")) return;
  const date = new Date().toISOString().slice(0, 10);
  const mime = recMime();
  const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
  rec.name = `${(S?.title || "수업").replace(/[\\/:*?"<>|]/g, "_")}_${date}.${ext}`;
  rec.writable = null;
  rec.chunks = [];
  // 1) 저장할 파일 고르기 (크롬·엣지): 녹화하는 동안 바로 그 파일에 쓴다
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: rec.name, types: [{ description: "동영상", accept: { [mime.split(";")[0] || "video/webm"]: [`.${ext}`] } }] });
      rec.writable = await handle.createWritable();
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }
  try {
    // 2) 이 탭 화면과 탭 소리(학생 목소리 등)
    rec.display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 15, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: true, preferCurrentTab: true, selfBrowserSurface: "include", systemAudio: "exclude",
    });
    // 3) 선생님 마이크를 섞는다 (마이크를 끄면 녹화에도 안 들어감)
    rec.ctx = new AudioContext();
    const dest = rec.ctx.createMediaStreamDestination();
    if (rec.display.getAudioTracks().length) rec.ctx.createMediaStreamSource(new MediaStream(rec.display.getAudioTracks())).connect(dest);
    try {
      rec.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      rec.micGain = rec.ctx.createGain();
      rec.micGain.gain.value = prefs.mic ? 1 : 0;
      rec.ctx.createMediaStreamSource(rec.mic).connect(rec.micGain).connect(dest);
    } catch { toast("마이크를 쓸 수 없어 선생님 목소리 없이 녹화해요.", 5000); }
    const out = new MediaStream([...rec.display.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    rec.recorder = new MediaRecorder(out, { mimeType: mime || undefined, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000 });
    rec.recorder.ondataavailable = (e) => {
      if (!e.data?.size) return;
      if (rec.writable) { const w = rec.writable; rec.chain = rec.chain.then(() => w.write(e.data)).catch((err) => console.error(err)); }
      else rec.chunks.push(e.data);
    };
    rec.recorder.onstop = finishRecording;
    rec.display.getVideoTracks()[0].addEventListener("ended", () => stopRecording()); // 브라우저의 '공유 중지'를 눌렀을 때
    rec.recorder.start(5000); // 5초마다 저장
    rec.started = Date.now();
    rec.timer = setInterval(renderRecButton, 1000);
    if (!rec.display.getAudioTracks().length) toast("탭 오디오 공유를 켜지 않아 학생 목소리는 녹화되지 않아요.", 7000);
    sock?.send({ t: "recording", on: true });
    renderRecButton();
  } catch (err) {
    cleanupRecording();
    if (err?.name !== "NotAllowedError") toast(`녹화를 시작하지 못했어요: ${err.message}`, 6000);
  }
}

function stopRecording() {
  if (rec.recorder && rec.recorder.state !== "inactive") rec.recorder.stop();
}

async function finishRecording() {
  clearInterval(rec.timer);
  sock?.send({ t: "recording", on: false });
  try {
    if (rec.writable) {
      await rec.chain;
      await rec.writable.close();
      toast(`녹화본을 저장했어요: ${rec.name}`, 6000);
    } else if (rec.chunks.length) {
      const url = URL.createObjectURL(new Blob(rec.chunks, { type: rec.recorder.mimeType || "video/webm" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = rec.name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(`녹화본을 내려받았어요: ${rec.name}`, 6000);
    }
  } catch (err) {
    toast(`녹화본을 저장하지 못했어요: ${err.message}`, 8000);
  }
  cleanupRecording();
}

function cleanupRecording() {
  clearInterval(rec.timer);
  rec.display?.getTracks().forEach((tr) => tr.stop());
  rec.mic?.getTracks().forEach((tr) => tr.stop());
  rec.ctx?.close().catch(() => {});
  Object.assign(rec, { recorder: null, display: null, mic: null, ctx: null, micGain: null, writable: null, chunks: [], chain: Promise.resolve(), timer: null });
  renderRecButton();
}

function renderRecButton() {
  const b = $("#rec-btn");
  const on = !!rec.recorder;
  b.classList.toggle("recording", on);
  if (!on) { b.textContent = "⏺ 녹화"; return; }
  const sec = Math.floor((Date.now() - rec.started) / 1000);
  const hh = Math.floor(sec / 3600), mm = String(Math.floor((sec % 3600) / 60)).padStart(2, "0"), ss = String(sec % 60).padStart(2, "0");
  b.textContent = `⏹ 녹화 중 ${hh ? `${hh}:` : ""}${mm}:${ss}`;
}

$("#rec-btn").addEventListener("click", () => (rec.recorder ? stopRecording() : startRecording()));
window.addEventListener("beforeunload", (e) => { if (rec.recorder) { e.preventDefault(); e.returnValue = ""; } });

$("#mic").addEventListener("click", () => setMic(!prefs.mic));
$("#cam").addEventListener("click", () => setCam(!prefs.cam));
$("#screen").addEventListener("click", () => setScreen(!prefs.screen));
$("#sound").addEventListener("click", async () => {
  await mainRoom?.startAudio();
  for (const m of monitors.values()) await m.room?.startAudio();
  $("#sound").hidden = true;
});

/* ───── 모둠 관찰 (여러 방에 동시에 접속) ───── */

function groupName(gid) { return S?.groups.find((g) => g.id === gid)?.name || gid; }

function syncMonitors() {
  const want = new Set(S.breakout && S.livekit ? S.groups.map((g) => g.id) : []);
  for (const gid of [...monitors.keys()]) if (!want.has(gid)) closeMonitor(gid);
  for (const g of S.groups) {
    if (want.has(g.id) && !monitors.has(g.id)) openMonitor(g.id);
  }
  // 카드 순서를 모둠 순서대로 (카드 안 영상 요소는 그대로라 괜찮다)
  const rooms = $("#rooms");
  for (const g of S.groups) {
    const m = monitors.get(g.id);
    if (m && m.card.parentNode !== rooms) rooms.append(m.card);
  }
  for (const gid of monitors.keys()) renderMonitor(gid);
}

function openMonitor(gid) {
  const grid = h("div", { class: "grid" });
  const card = h("section", { class: "roomcard" },
    h("header", {}, h("span", { class: "talk-dot" }), h("h3", {}), h("span", { class: "muted count" }),
      h("span", { class: "grow" }), h("span", { class: "flags" })),
    grid,
    h("div", { class: "actions" },
      h("button", { class: "listen", onclick: () => toggleListen(gid), title: "이 모둠 소리 듣기" }, "🔇"),
      h("button", { class: "talk", onclick: () => toggleTalk(gid), title: "모둠에 들어가서 말하기 (영상·소리)" }, "🎤"),
      h("button", { class: "focus-btn", onclick: () => { focusGroup = focusGroup === gid ? null : gid; syncMonitors(); } }, "🔍 크게")));
  const m = { room: null, card, grid };
  monitors.set(gid, m);
  $("#rooms").append(card);
  connectMonitor(gid);
}

async function connectMonitor(gid) {
  const m = monitors.get(gid);
  if (!m) return;
  try {
    const { url, token } = await api(`/api/live/classes/${CODE}/token`, { room: gid });
    if (monitors.get(gid) !== m) return;
    const room = createRoom(() => renderMonitor(gid), { audioSink: monitorAudio });
    room.on(RoomEvent.TrackPublished, () => applySubs(gid));
    room.on(RoomEvent.ParticipantConnected, () => applySubs(gid));
    room.on(RoomEvent.Disconnected, () => {
      if (monitors.get(gid)?.room !== room) return;
      m.room = null;
      setTimeout(() => { if (monitors.get(gid) === m) connectMonitor(gid); }, 3000);
    });
    m.room = room;
    // 관찰용 연결은 영상만 받고, 소리는 '듣기'를 켠 모둠만 받는다(데이터 절약)
    await room.connect(url, token, { autoSubscribe: false });
    applySubs(gid);
    if (broadcast) await publishBroadcast(room); // 방송 중에 새로 연결된 모둠에도
    renderMonitor(gid);
  } catch (err) {
    console.error(err);
    if (monitors.get(gid) === m) setTimeout(() => connectMonitor(gid), 4000);
  }
}

function closeMonitor(gid) {
  const m = monitors.get(gid);
  if (!m) return;
  monitors.delete(gid);
  listening.delete(gid);
  if (talking === gid) talking = null;
  stopTalkCam(m.room); // 모둠 연결을 닫을 때 복제한 카메라도 끈다
  syncTiles(m.grid, []);
  disposeRoom(m.room);
  m.card.remove();
}

function applySubs(gid) {
  const room = monitors.get(gid)?.room;
  if (!room) return;
  const hear = listening.has(gid) || talking === gid;
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      const want = pub.kind === Track.Kind.Video ? true : hear;
      if (pub.isSubscribed !== want) pub.setSubscribed(want);
    }
  }
}

function renderMonitor(gid) {
  const m = monitors.get(gid);
  if (!m || !S) return;
  const room = m.room;
  const members = S.students.filter((s) => s.group === gid);
  const helpNeeded = members.some((s) => s.help);
  const hear = listening.has(gid);
  const people = room ? [...room.remoteParticipants.values()].filter((p) => !isTeacher(p)) : [];
  const anySpeaking = people.some((p) => p.isSpeaking);

  m.card.querySelector("h3").textContent = groupName(gid);
  m.card.querySelector(".count").textContent = room?.state === "connected" ? `${people.length}명 접속` : "연결 중…";
  m.card.querySelector(".flags").textContent = helpNeeded ? "🙋 도움 요청" : "";
  m.card.querySelector(".talk-dot").classList.toggle("on", anySpeaking);
  m.card.classList.toggle("help", helpNeeded);
  m.card.classList.toggle("listening", hear);
  m.card.classList.toggle("active-talk", talking === gid);
  m.card.classList.toggle("focus", focusGroup === gid);
  const listenBtn = m.card.querySelector(".listen");
  listenBtn.classList.toggle("on", hear || talking === gid);
  listenBtn.textContent = hear || talking === gid ? "🔊" : "🔇"; // 켜졌는지는 버튼 색으로 보인다
  listenBtn.disabled = talking === gid;
  const talkBtn = m.card.querySelector(".talk");
  talkBtn.classList.toggle("on", talking === gid);
  talkBtn.textContent = "🎤";
  talkBtn.title = talking === gid ? "말하는 중 (누르면 나와요)" : "모둠에 들어가서 말하기 (영상·소리)";
  m.card.classList.toggle("active-talk", talking === gid || !!broadcast);
  m.card.querySelector(".focus-btn").textContent = focusGroup === gid ? "↙ 작게" : "🔍 크게";
  if (room) {
    const items = [];
    for (const p of people) {
      items.push(cameraItem(room, p, { flag: S.students.find((s) => `s-${s.id}` === p.identity)?.help ? "🙋" : "" }));
      const sc = screenItem(room, p);
      if (sc) items.push(sc);
    }
    syncTiles(m.grid, items);
    if (!room.canPlaybackAudio && (hear || talking)) $("#sound").hidden = false;
  }
}

function sendListen() {
  sock?.send({ t: "listen", groups: [...listening], talking, broadcast: !!broadcast }, true);
}

function toggleListen(gid) {
  if (listening.has(gid)) listening.delete(gid);
  else listening.add(gid);
  applySubs(gid);
  sendListen();
  renderMonitor(gid);
}

async function toggleTalk(gid) {
  if (broadcast) await stopBroadcast();
  const prev = talking;
  if (prev) {
    talking = null;
    try { await monitors.get(prev)?.room?.localParticipant.setMicrophoneEnabled(false); } catch { /* 무시 */ }
    await stopTalkCam(monitors.get(prev)?.room);
    applySubs(prev);
    renderMonitor(prev);
  }
  if (prev !== gid) {
    const room = monitors.get(gid)?.room;
    if (!room || room.state !== "connected") { toast("아직 모둠에 연결 중이에요."); sendListen(); return; }
    if (prefs.mic) { prefs.mic = false; await mainRoom?.localParticipant.setMicrophoneEnabled(false); renderControls(); }
    talking = gid;
    applySubs(gid);
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      await startTalkCam(room);
    } catch (err) {
      talking = null;
      await stopTalkCam(room);
      toast(mediaError(err), 5000);
    }
    renderMonitor(gid);
  }
  sendListen();
}

/* 모둠에 들어가서 말할 때 학생들에게 선생님 얼굴도 보이게: 전체 방에서 켜 둔 카메라를 복제해 모둠 방에 보낸다.
   (카메라를 꺼 두었으면 소리만) */
let talkCam = null; // { room, track }
async function startTalkCam(room) {
  const src = mainRoom?.localParticipant.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack;
  if (!prefs.cam || !src || src.readyState !== "live") return;
  try {
    const pub = await room.localParticipant.publishTrack(src.clone(), { source: Track.Source.Camera, name: "talk-cam", simulcast: true });
    talkCam = { room, track: pub.track };
  } catch (err) { console.error(err); }
}
async function stopTalkCam(room) {
  if (!talkCam || (room && talkCam.room !== room)) return;
  const { room: r, track } = talkCam;
  talkCam = null;
  try { await r.localParticipant.unpublishTrack(track, true); } catch { track?.stop(); }
}

/* 모든 모둠에 동시에 말하기: 마이크 하나를 복제해 모든 모둠 방에 내보낸다 */
async function publishBroadcast(room) {
  try {
    const pub = await room.localParticipant.publishTrack(broadcast.src.clone(), { source: Track.Source.Microphone, name: "broadcast" });
    broadcast.pubs.push({ room, track: pub.track });
  } catch (err) {
    console.error(err);
  }
}

async function startBroadcast() {
  if (talking) await toggleTalk(talking);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    toast(mediaError(err), 5000);
    return;
  }
  broadcast = { src: stream.getAudioTracks()[0], pubs: [] };
  const rooms = [...monitors.values()].map((m) => m.room).filter((r) => r?.state === "connected");
  await Promise.all(rooms.map(publishBroadcast));
  toast(`모든 모둠(${broadcast?.pubs.length || 0}개)에 말하고 있어요.`);
  renderBroadcast();
  sendListen();
}

async function stopBroadcast() {
  const b = broadcast;
  if (!b) return;
  broadcast = null;
  await Promise.all(b.pubs.map(({ room, track }) => room.localParticipant.unpublishTrack(track, true).catch(() => {})));
  b.src.stop();
  renderBroadcast();
  sendListen();
}

function renderBroadcast() {
  const btn = $("#bo-voice");
  btn.classList.toggle("solid", !!broadcast);
  btn.textContent = broadcast ? "🔴 모든 모둠에 말하는 중 (끄기)" : "📢 모든 모둠에 말하기";
  for (const gid of monitors.keys()) renderMonitor(gid);
}
$("#bo-voice").addEventListener("click", () => (broadcast ? stopBroadcast() : startBroadcast()));

/** 모둠 활동: 시간 제한 없이, 시작한 뒤 지난 시간만 보여 준다 */
function tickTimer() {
  const el = $("#bo-timer");
  if (!S?.breakout || !S.breakout_at) { el.textContent = ""; return; }
  const sec = Math.max(0, Math.floor(clock.now() - S.breakout_at));
  el.textContent = `⏱ ${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, "0")}초 지남`;
}
setInterval(tickTimer, 1000);
$("#bo-end").addEventListener("click", () => sock.send({ t: "breakout_end" }));
$("#bo-broadcast").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#bo-broadcast-text");
  if (input.value.trim() && sock.send({ t: "broadcast", text: input.value.trim() })) { input.value = ""; toast("모든 모둠에 보냈어요."); }
});

/* ───── 전체 그리기 ───── */

function render() {
  document.title = `${S.title} · 선생님`;
  $("#title").textContent = S.title;
  const online = S.students.filter((s) => s.online).length;
  $("#online").textContent = `👥 ${online}명 접속`;
  $("#csv-link").href = `/api/live/history/${S.class_id}/results.csv`;
  // 강좌 수업은 입장 코드가 없다: 수강 확정된 학생만 마이페이지에서 들어온다. 특강·모임만 코드로 입장
  const course = !!S.course_id;
  $("#code").hidden = course;
  $("#copy-link").hidden = course;
  $(".sharebox").hidden = course; // 강좌 수업은 입장 코드 안내 칸 자체를 보이지 않는다
  $("#share-url").textContent = studentLink;
  $("#history-link").href = `/live?tab=history&class=${S.class_id}`;

  const banners = $("#banners");
  banners.replaceChildren();
  if (!S.livekit) banners.append(h("div", { class: "banner warn" }, "화상 서버(LiveKit)가 설정되지 않아 영상 없이 퀴즈·채팅·질문만 동작해요. README의 설정 방법을 확인해 주세요."));
  if (S.announce) banners.append(h("div", { class: "banner" }, h("strong", {}, "📢 공지 중"), h("span", { class: "grow" }, S.announce.text),
    h("button", { class: "small", onclick: () => sock.send({ t: "announce", text: "" }) }, "공지 내리기")));

  $("#main-view").hidden = S.breakout;
  $("#main-view").style.display = S.breakout ? "none" : "contents";
  $("#monitor-view").hidden = !S.breakout;
  if (!S.breakout) {
    listening.clear(); talking = null; focusGroup = null;
    if (broadcast) stopBroadcast();
  }
  syncMonitors();
  tickTimer();

  $("#set-ai").checked = S.settings.ai;
  document.body.classList.toggle("no-mirror", S.settings.mirror === false);
  $("#mirror-btn").classList.toggle("on", S.settings.mirror !== false);
  renderLayout();
  applyQuality();
  renderPeople();
  renderActivity();
  renderQuestions();
  renderGroups();
  renderScopes();
  renderPresent();
  renderMediaShare();
  if (mainRoom) renderMain(mainRoom);
}

/* ───── 미디어공유 · 설문/퀴즈 · 스티커 ───── */

const mediaShare = new MediaShare($("#media"), {
  teacher: true, code: CODE,
  onCtrl: (playing, pos) => sock.send({ t: "media_ctrl", playing, pos }),
  onClose: () => sock.send({ t: "media_close" }),
});
function renderMediaShare() {
  mediaShare.set(S.breakout ? null : S.media);
  $("#media-btn").classList.toggle("on", !!S.media);
}

/** 유튜브 주소에서 영상 id 꺼내기 (youtu.be/…, watch?v=…, shorts/…, embed/…) */
function youtubeId(text) {
  const t = text.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  try {
    const u = new URL(t);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1, 12);
    if (u.searchParams.get("v")) return u.searchParams.get("v").slice(0, 11);
    const m = u.pathname.match(/\/(shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
    return m ? m[2] : null;
  } catch { return null; }
}

function openMediaDialog() {
  $("#media-dialog")?.remove();
  const close = () => dlg.remove();
  const yt = h("input", { class: "grow", placeholder: "유튜브 주소 붙여 넣기 (예: https://youtu.be/…)" });
  const showYt = () => {
    const id = youtubeId(yt.value);
    if (!id) { toast("유튜브 주소를 확인해 주세요."); return; }
    sock.send({ t: "media_open", kind: "youtube", src: id });
    close();
  };
  yt.addEventListener("keydown", (e) => { if (e.key === "Enter") showYt(); });
  const list = S.media_files.map((f) => h("div", { class: "person" },
    h("span", { class: "grow" }, `${[".mp3", ".m4a", ".wav", ".ogg"].includes(f.ext) ? "🎵" : "🎞️"} ${f.name}`),
    h("span", { class: "acts" }, h("button", { class: "primary", onclick: () => { sock.send({ t: "media_open", kind: "file", src: f.id }); close(); } }, "띄우기"))));
  const dlg = h("div", { class: "overlay", id: "media-dialog", onclick: (e) => { if (e.target === dlg) close(); } },
    h("div", { class: "card" },
      h("div", { class: "row" }, h("h2", { class: "grow", style: "margin:0" }, "🎬 미디어 공유"), h("button", { class: "small", onclick: close }, "닫기")),
      h("p", { class: "muted", style: "margin:0;font-size:0.88rem" }, "선생님이 재생·멈춤·건너뛰기를 하면 학생 화면도 같은 곳으로 맞춰져요."),
      h("strong", {}, "유튜브 영상"),
      h("div", { class: "row" }, yt, h("button", { class: "primary", onclick: showYt }, "띄우기")),
      h("strong", {}, "내 컴퓨터의 동영상·음악"),
      list.length ? h("div", { class: "people" }, list) : null,
      h("div", { class: "row" }, h("button", { onclick: () => { close(); $("#media-input").click(); } }, "＋ 파일 올리기")),
      h("p", { class: "muted", style: "margin:0;font-size:0.85rem" }, "mp4·webm·mov·mp3·m4a, 500MB까지 · 올린 파일은 수업이 끝나면 지워져요."),
      S.media ? h("button", { class: "danger", onclick: () => { sock.send({ t: "media_close" }); close(); } }, "지금 공유 끝내기") : null));
  document.body.append(dlg);
  yt.focus();
}
$("#media-btn").addEventListener("click", openMediaDialog);
$("#media-input").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  $("#media-dialog")?.remove();
  const note = toast(`'${f.name}' 올리는 중…`, 600000);
  try {
    // 큰 파일: 진행률을 보여 주려고 XMLHttpRequest로 올린다
    const id = await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", `/api/live/classes/${CODE}/media?name=${encodeURIComponent(f.name)}`);
      x.upload.onprogress = (ev) => { if (ev.lengthComputable && note) note.textContent = `'${f.name}' 올리는 중… ${Math.round((ev.loaded / ev.total) * 100)}%`; };
      x.onload = () => {
        let data = {};
        try { data = JSON.parse(x.responseText); } catch { /* 무시 */ }
        if (x.status === 200) resolve(data.id); else reject(new Error(data.detail || "올리지 못했어요."));
      };
      x.onerror = () => reject(new Error("인터넷 연결을 확인해 주세요."));
      x.send(f);
    });
    if (note) note.hidden = true;
    sock.send({ t: "media_open", kind: "file", src: id });
  } catch (err) { toast(err.message, 6000); }
});

$("#quiz-btn").addEventListener("click", () => showTab("activity"));

const STICKERS = [["👏", "박수"], ["👍", "좋아요"], ["⭐", "칭찬"], ["💯", "최고"], ["🎉", "축하"], ["❤️", "하트"], ["💡", "좋은 생각"], ["🔥", "열정"]];
$("#sticker-btn").addEventListener("click", () => {
  $("#sticker-dialog")?.remove();
  const close = () => dlg.remove();
  const online = koSort(S.students.filter((s) => s.online), (s) => s.name);
  const to = h("select", {}, h("option", { value: "" }, "👥 모두에게"), online.map((s) => h("option", { value: s.id }, `${s.name}${s.stickers ? ` (⭐${s.stickers})` : ""}`)));
  const dlg = h("div", { class: "overlay", id: "sticker-dialog", onclick: (e) => { if (e.target === dlg) close(); } },
    h("div", { class: "card" },
      h("div", { class: "row" }, h("h2", { class: "grow", style: "margin:0" }, "🏅 칭찬 스티커"), h("button", { class: "small", onclick: close }, "닫기")),
      h("label", { class: "row" }, "받을 사람", to),
      h("div", { class: "sticker-grid" }, STICKERS.map(([s, label]) => h("button", { type: "button", title: label, onclick: () => {
        sock.send({ t: "sticker", s, target: to.value || null });
        toast(`${s} ${label} 스티커를 ${to.value ? to.selectedOptions[0].textContent.replace(/ \(⭐\d+\)$/, "") : "모두"}에게 보냈어요.`);
        close();
      } }, h("span", { class: "sticker-ico" }, s), h("small", {}, label)))),
      h("p", { class: "muted", style: "margin:0;font-size:0.85rem" }, "학생을 고르면 그 학생 화면에 크게 뜨고, 받은 스티커 수가 학생 목록에 쌓여요.")));
  document.body.append(dlg);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".sticker-wrap")) { const bp = $("#board-sticker-pop"); if (bp) bp.hidden = true; }
});

/* ───── 자료 발표(PDF)·화이트보드 ───── */

let presentSig = "";
function renderPresent() {
  const v = S.present;
  $("#present").hidden = !v || S.breakout || !!S.media;
  $("#present-btn").classList.toggle("on", v?.mode === "slides");
  $("#board-btn").classList.toggle("on", v?.mode === "board");
  presenter.setView(v);
  presenter.inkCanvas.classList.toggle("pan", presenter.tool.kind === "pan");
  const sig = JSON.stringify([v, S.files, showStudents, presenter.tool, presenter.zoomZ(), S.settings.board_draw]);
  if (sig === presentSig) return;
  presentSig = sig;
  const bar = $("#present-bar");
  if (!v) { bar.replaceChildren(); return; }
  const tool = (kind, color, label, title) => h("button", {
    class: `small tool ${presenter.tool.kind === kind && (!color || presenter.tool.color === color) ? "on" : ""}`, title,
    style: color ? `color:${color}` : null,
    onclick: () => { presenter.tool = { kind, color: color || presenter.tool.color }; renderPresent(); },
  }, label);
  const last = v.page >= v.pages;
  bar.replaceChildren(...[ // 빈 칸(null)이 "null" 글자로 찍히지 않게 걸러 낸다
    h("button", { class: "small", disabled: v.page <= 1, onclick: () => goPage(v.page - 1), title: "이전 쪽 (←)" }, "◀"),
    h("span", { class: "pageno" }, `${v.page} / ${v.pages || "?"}`),
    v.mode === "board" && last
      ? h("button", { class: "small", onclick: () => goPage(v.page + 1), title: "새 쪽 추가" }, "＋ 새 쪽")
      : h("button", { class: "small", disabled: last, onclick: () => goPage(v.page + 1), title: "다음 쪽 (→)" }, "▶"),
    h("span", { class: "sep" }),
    ...PEN_COLORS.map((c, i) => tool("pen", c, "●", ["검정 펜", "빨강 펜", "파랑 펜", "초록 펜"][i])),
    tool("hl", "#f5c400", "▮", "형광펜"),
    tool("eraser", null, "🧽", "지우개 (선을 문지르면 지워져요)"),
    tool("text", null, "가", "글자 쓰기 (누른 곳에 입력 · Enter로 올리기, Shift+Enter 줄바꿈) — 지금 고른 펜 색으로 써져요"),
    h("span", { class: "sticker-wrap" },
      h("button", { class: `small tool ${presenter.tool.kind === "sticker" ? "on" : ""}`, title: "이모지 스티커 붙이기",
        onclick: (e) => {
          e.stopPropagation();
          const pop = $("#board-sticker-pop");
          pop.hidden = !pop.hidden;
          if (pop.hidden) return;
          // 막대가 옆으로 밀리는 칸이라 그 안에서는 잘린다 → 화면 기준으로 버튼 바로 아래에 띄운다
          const r = e.currentTarget.getBoundingClientRect();
          const half = pop.offsetWidth / 2;
          pop.style.left = `${Math.min(window.innerWidth - half - 8, Math.max(half + 8, r.left + r.width / 2))}px`;
          pop.style.top = `${r.bottom + 8}px`;
        } }, presenter.tool.kind === "sticker" ? presenter.tool.emoji : "😀"),
      h("div", { class: "sticker-pop", id: "board-sticker-pop", hidden: true },
        h("div", { class: "board-stickers" }, BOARD_STICKERS.map((em) => h("button", { type: "button", class: "small", onclick: () => {
          presenter.tool = { kind: "sticker", emoji: em, color: presenter.tool.color };
          $("#board-sticker-pop").hidden = true;
          renderPresent();
        } }, em))),
        h("p", { class: "muted", style: "margin:4px 0 0;font-size:0.8rem" }, "고른 뒤 화면을 누르면 그 자리에 붙어요. 지우개로 지울 수 있어요."))),
    ...(v.mode === "slides" ? [
      h("span", { class: "sep" }),
      h("button", { class: "small", title: "확대 (Ctrl + 마우스 휠로도 돼요)", onclick: () => presenter.setZoom(presenter.zoomZ() * 1.5) }, "🔍＋"),
      h("button", { class: "small", title: "축소", disabled: presenter.zoomZ() <= 1, onclick: () => presenter.setZoom(presenter.zoomZ() / 1.5) }, "🔍－"),
      h("span", { class: "pageno", title: "확대 배율 (학생 화면도 같이 확대돼요)" }, `${Math.round(presenter.zoomZ() * 100)}%`),
      // 확대하지 않았을 때도 늘 보이게 (누를 수 없게만 해 둔다)
      (() => { const b = tool("pan", null, "✋", "이동: 확대한 자료를 끌어서 보고 싶은 곳으로 옮겨요"); b.disabled = presenter.zoomZ() <= 1; return b; })(),
      h("button", { class: "small", title: "쪽 전체 보기", disabled: presenter.zoomZ() <= 1, onclick: () => { presenter.setZoom(1, 0.5, 0.5); if (presenter.tool.kind === "pan") presenter.tool = { kind: "pen", color: PEN_COLORS[0] }; } }, "맞춤"),
    ] : []),
    h("button", { class: "small", title: "되돌리기", onclick: () => presenter.undo() }, "↶"),
    h("button", { class: "small", title: "이 쪽 판서 모두 지우기", onclick: () => { if (confirm("이 쪽에 그린 것을 모두 지울까요?")) presenter.clear(); } }, "🗑"),
    h("span", { class: "grow" }),
    v.mode === "board" ? h("label", { class: "switch small-switch", title: "켜 두면 학생도 화이트보드에 펜으로 쓸 수 있어요 (학생은 자기가 쓴 것만 지울 수 있고, 선생님은 모두 지울 수 있어요)" },
      h("input", { type: "checkbox", checked: S.settings.board_draw !== false, onchange: (e) => sock.send({ t: "settings", board_draw: e.target.checked }) }),
      "학생도 쓰기") : null,
    h("label", { class: "switch small-switch", title: "끄면 발표하는 동안 학생 영상을 받지 않아 화면이 넓어지고 데이터도 아껴요" },
      h("input", { type: "checkbox", checked: showStudents, onchange: (e) => {
        showStudents = e.target.checked; store.set("present-show-students", showStudents); renderPresent(); if (mainRoom) renderMain(mainRoom);
      } }), "영상 보기"),
    h("button", { class: "small", title: "발표 자료 (올리기·고르기)", onclick: openFiles }, "문서"),
    h("button", { class: "small danger", onclick: () => sock.send({ t: "present_close" }) }, "발표 끝내기")].filter(Boolean));
}

function goPage(page) { if (S.present) sock.send({ t: "present_page", page }); }
document.addEventListener("keydown", (e) => {
  if (!S?.present || e.target.closest("input, textarea, select")) return;
  if (e.key === "ArrowRight" || e.key === "PageDown") goPage(Math.min(S.present.pages, S.present.page + 1));
  if (e.key === "ArrowLeft" || e.key === "PageUp") goPage(Math.max(1, S.present.page - 1));
});

async function startSlides(fid) {
  try {
    const pages = await presenter.pageCount(fid);
    sock.send({ t: "present_open", file: fid, pages });
  } catch (err) {
    console.error(err);
    toast("PDF를 열지 못했어요. 다른 파일로 해 보세요.");
  }
}

function openFiles() {
  $("#files-dialog")?.remove();
  const close = () => dlg.remove();
  const list = S.files.map((f) => h("div", { class: "person" },
    h("span", { class: "grow" }, `📄 ${f.name}`, h("span", { class: "muted", style: "font-size:0.8rem" }, f.pages ? ` · ${f.pages}쪽` : "")),
    h("span", { class: "acts" },
      h("button", { class: "primary", onclick: () => { close(); startSlides(f.id); } }, "발표하기"),
      h("button", { class: "danger", onclick: () => { if (confirm(`'${f.name}'을 지울까요?`)) { sock.send({ t: "file_remove", file: f.id }); close(); } } }, "지우기"))));
  const dlg = h("div", { class: "overlay", id: "files-dialog", onclick: (e) => { if (e.target === dlg) close(); } },
    h("div", { class: "card" },
      h("div", { class: "row" }, h("h2", { class: "grow", style: "margin:0" }, "📄 발표 자료"), h("button", { class: "small", onclick: close }, "닫기")),
      list.length ? h("div", { class: "people" }, list) : h("p", { class: "muted", style: "margin:0" }, "아직 올린 자료가 없어요."),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: () => { close(); $("#file-input").click(); } }, "＋ 내 컴퓨터에서 PDF 올리기"),
        CFG?.drive_picker ? h("button", { onclick: () => { close(); openFromDrive(); } }, "📁 구글 드라이브에서 열기") : null),
      CFG?.drive_picker ? h("p", { class: "muted", style: "margin:0;font-size:0.85rem" },
        "드라이브에서는 PDF뿐 아니라 PowerPoint·구글 프레젠테이션도 고를 수 있어요(PDF로 바꿔서 띄워요). 고른 파일 하나만 열 수 있는 권한이고, 서버는 드라이브에 접근하지 않아요.") : null,
      h("p", { class: "muted", style: "margin:0;font-size:0.85rem" },
        CFG?.drive_picker ? "내 컴퓨터의 PowerPoint는 PDF로 저장해서 올리거나, 드라이브에 올려 두고 드라이브에서 열어 주세요. 애니메이션·영상이 필요하면 '화면 공유'를 쓰세요. "
          : "PowerPoint(PPT)는 '파일 → 내보내기 → PDF'로 저장해서 올려 주세요. 애니메이션·영상이 필요하면 '화면 공유'를 쓰세요. ",
        "PDF는 한 파일에 2MB까지 올릴 수 있어요. 올린 자료와 판서는 수업이 끝나도 남아서, 수업을 못 들은 학생도 첫 화면 '지난 수업 자료'에서 다시 볼 수 있어요. PDF 파일은 과목이 끝나면(특강·회의는 끝내면) 바로 지워지고, 판서는 복습용으로 365일 남아요.")));
  document.body.append(dlg);
}

$("#present-btn").addEventListener("click", () => {
  if (S?.present?.mode === "slides") return openFiles();
  if (S?.files.length || CFG?.drive_picker) openFiles(); else $("#file-input").click(); // 드라이브를 쓸 수 있으면 고를 수 있게
});
$("#board-btn").addEventListener("click", () => {
  if (S?.present?.mode === "board") sock.send({ t: "present_close" });
  else sock.send({ t: "present_board", page: 1 });
});
/** PDF를 이 수업 자료로 올리고 바로 발표를 시작한다 */
const MAX_PDF_MB = 2; // 서버와 같게: 발표 PDF 하나 2MB까지
async function uploadPdf(blob, name) {
  if (blob.size > MAX_PDF_MB * 1024 * 1024) {
    throw new Error(`PDF가 너무 커요 (${(blob.size / 1024 / 1024).toFixed(1)}MB). ${MAX_PDF_MB}MB 이하로 줄여서 올려 주세요. PDF로 저장할 때 '최소 크기'·'웹용'을 고르거나 큰 사진을 줄이면 작아져요.`);
  }
  toast("자료를 올리는 중…", 20000);
  const res = await fetch(`/api/live/classes/${CODE}/files?name=${encodeURIComponent(name)}`, {
    method: "POST", headers: { "Content-Type": "application/pdf" }, body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `올리지 못했어요 (${res.status})`);
  toast("올렸어요. 발표를 시작해요.");
  await startSlides(data.id);
}

$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (/\.pptx?$/i.test(file.name)) {
    alert("PowerPoint 파일은 바로 띄울 수 없어요.\n\nPowerPoint에서 '파일 → 내보내기 → PDF/XPS 문서 만들기'(또는 '다른 이름으로 저장 → PDF')로 저장한 뒤 그 PDF를 올려 주세요."
      + (CFG?.drive_picker ? "\n\n또는 PowerPoint 파일을 구글 드라이브에 올려 두고 '📁 구글 드라이브에서 열기'로 고르면 바로 띄울 수 있어요." : "")
      + "\n\n애니메이션·동영상이 꼭 필요하면 '🖥️ 화면 공유'로 PowerPoint 창을 공유하세요.");
    return;
  }
  try { await uploadPdf(file, file.name); } catch (err) { toast(err.message, 6000); }
});

/* ───── 구글 드라이브에서 열기 ─────
 * 선생님 브라우저 안에서만 동작한다: 구글 파일 선택 창(Picker)으로 파일 하나를 고르면
 * 그 파일만 읽을 수 있는 권한(drive.file)으로 PDF를 받아 이 수업 자료로 올린다. 서버는 구글 토큰을 받지도 저장하지도 않는다. */
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const MIME = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  gslides: "application/vnd.google-apps.presentation",
  gdoc: "application/vnd.google-apps.document",
};
const drive = { token: null, expires: 0 };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)?.dataset.loaded) return resolve();
    const el = h("script", { src, async: true });
    el.onload = () => { el.dataset.loaded = "1"; resolve(); };
    el.onerror = () => reject(new Error("구글 화면을 불러오지 못했어요. 인터넷 연결을 확인해 주세요."));
    document.head.append(el);
  });
}

async function driveToken() {
  if (drive.token && Date.now() < drive.expires) return drive.token;
  await loadScript("https://accounts.google.com/gsi/client");
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CFG.google_client_id, scope: DRIVE_SCOPE, hint: CFG.user?.email,
      callback: (r) => {
        if (r.error) return reject(new Error("구글 드라이브 사용 권한을 받지 못했어요."));
        drive.token = r.access_token;
        drive.expires = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
        resolve(r.access_token);
      },
      error_callback: (err) => reject(new Error(err?.type === "popup_closed" ? "구글 창을 닫았어요."
        : "구글 창을 열지 못했어요. 브라우저의 팝업 차단을 풀어 주세요.")),
    });
    client.requestAccessToken({ prompt: "" });
  });
}

async function pickDriveFile(token) {
  await loadScript("https://apis.google.com/js/api.js");
  await new Promise((resolve) => gapi.load("picker", resolve));
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes(Object.values(MIME).join(",")).setMode(google.picker.DocsViewMode.LIST).setIncludeFolders(true);
    new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token).setDeveloperKey(CFG.drive_picker.api_key).setAppId(CFG.drive_picker.app_id)
      .setLocale("ko").setTitle("발표할 자료 고르기")
      .setCallback((d) => {
        if (d.action === google.picker.Action.PICKED) resolve(d.docs[0]);
        else if (d.action === google.picker.Action.CANCEL) resolve(null);
      })
      .build().setVisible(true);
  });
}

async function driveFetch(url, token, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).error?.message || ""; } catch { /* 본문 없음 */ }
    if (/exportSizeLimitExceeded|too large/i.test(msg)) throw new Error("파일이 너무 커서 PDF로 바꿀 수 없어요(구글 제한 10MB). PDF로 저장해서 올려 주세요.");
    throw new Error(`구글 드라이브에서 파일을 받지 못했어요 (${res.status}).`);
  }
  return res;
}

/** 고른 파일을 PDF로 받는다. PowerPoint는 잠시 구글 프레젠테이션으로 바꿔 PDF로 내보내고 그 사본은 지운다. */
async function driveFileAsPdf(doc, token) {
  const id = encodeURIComponent(doc.id);
  const base = (doc.name || "자료").replace(/\.(pdf|pptx?)$/i, "");
  if (doc.mimeType === MIME.pdf) {
    return [await (await driveFetch(`${DRIVE_API}/${id}?alt=media&supportsAllDrives=true`, token)).blob(), `${base}.pdf`];
  }
  const exportPdf = async (fid) => (await driveFetch(`${DRIVE_API}/${encodeURIComponent(fid)}/export?mimeType=application/pdf`, token)).blob();
  if (doc.mimeType === MIME.gslides || doc.mimeType === MIME.gdoc) return [await exportPdf(doc.id), `${base}.pdf`];
  if (doc.mimeType === MIME.pptx || doc.mimeType === MIME.ppt) {
    const copy = await (await driveFetch(`${DRIVE_API}/${id}/copy?supportsAllDrives=true`, token, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `(임시·수업 자료 변환) ${base}`, mimeType: MIME.gslides }),
    })).json();
    try {
      return [await exportPdf(copy.id), `${base}.pdf`];
    } finally {
      fetch(`${DRIVE_API}/${encodeURIComponent(copy.id)}?supportsAllDrives=true`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })
        .catch(() => { /* 사본은 드라이브 휴지통에서 지울 수 있음 */ });
    }
  }
  throw new Error("PDF, PowerPoint, 구글 프레젠테이션·문서만 띄울 수 있어요.");
}

async function openFromDrive() {
  try {
    const token = await driveToken();
    const doc = await pickDriveFile(token);
    if (!doc) return;
    toast(doc.mimeType === MIME.pdf ? "드라이브에서 받는 중…" : "PDF로 바꾸는 중… (몇 초 걸려요)", 30000);
    const [blob, name] = await driveFileAsPdf(doc, token);
    await uploadPdf(blob, name);
  } catch (err) {
    toast(err.message, 7000);
  }
}

let lastEventTs = 0;

function renderEvents() {
  // 입·퇴장 목록은 화면에 두지 않는다 (출결은 수업 기록에서). 연결이 끊긴 학생만 바로 알려 준다
  // 수업 중 연결이 끊긴 학생은 바로 알려 준다
  for (const e of S.events || []) {
    if (e.ts > lastEventTs && lastEventTs && e.kind === "leave" && e.reason === "network") toast(`${e.name} 학생의 연결이 끊겼어요.`);
  }
  if (S.events?.length) lastEventTs = Math.max(lastEventTs, S.events[S.events.length - 1].ts);
  else lastEventTs = lastEventTs || 1;
}

function roomLabel(s) {
  if (s.room !== "main") return groupName(s.room);
  if (s.group && S.groups.some((g) => g.id === s.group)) return `(${groupName(s.group)} 예정)`;
  return "";
}

/** 학생 마이크·카메라 버튼: 선생님 권한으로 켜고 끈다.
 *  마이크 통제 중에는 선생님이 꺼 두면 학생이 스스로 켤 수 없다(손 들기로 요청). */
function deviceButtons(s) {
  const p = mainRoom?.remoteParticipants.get(`s-${s.id}`);
  const inMain = s.room === "main";
  const micOn = inMain ? !!p?.isMicrophoneEnabled : null; // 모둠에 있는 학생은 이 화면에서 상태를 모름
  const camOn = inMain ? !!p?.isCameraEnabled : null;
  const btn = (on, icon, offIcon, name, cmd) => h("button", {
    class: `dev-btn ${on ? "on" : on === false ? "off" : ""}`,
    title: on === null ? `${name} 끄기` : on ? `${name} 켜짐 — 누르면 꺼요` : `${name} 꺼짐 — 누르면 선생님이 켜요`,
    onclick: () => {
      const turnOn = on === false;
      sock.send({ t: "cmd", cmd: `${cmd}_${turnOn ? "on" : "off"}`, target: s.id });
      if (turnOn) toast(`${s.name} 학생의 ${name}를 켰어요.`);
    },
  }, on === false ? offIcon : icon);
  if (s.mic_blocked) {  // 선생님이 끈 마이크: 다시 켜 줄 때까지 학생이 못 켬
    return [btn(camOn, "🎥", "🎥", "카메라", "cam"),
      h("button", { class: "dev-btn off locked", title: "선생님이 마이크를 껐어요 — 누르면 다시 켜요(학생도 다시 켤 수 있게 돼요)",
        onclick: () => { sock.send({ t: "cmd", cmd: "mic_on", target: s.id }); toast(`${s.name} 학생의 마이크를 켰어요.`); } }, "🎤")];
  }
  // 참여자 목록: 🎥 카메라 · 🎤 마이크 (꺼진 것은 흐리게 · 사선, 누르면 켜고 끔)
  return [btn(camOn, "🎥", "🎥", "카메라", "cam"), btn(micOn, "🎤", "🎤", "마이크", "mic")];
}

function renderPeople() {
  // 마이크 요청(🎙️)·손 든 학생(✋)을 위로
  // 강좌 수업은 수강생 명단이 모두 보이고, 들어온 학생은 초록불 (손 든 학생은 위로)
  const everyone = S.everyone || S.students;
  const list = everyone.slice().sort((a, b) =>
    (b.mic_req - a.mic_req) || (b.hand - a.hand) || (a.school || "").localeCompare(b.school || "", "ko") || a.name.localeCompare(b.name, "ko"));
  const onlineN = everyone.filter((x) => x.online).length;
  $("#people-count").textContent = S.course_id ? `접속 ${onlineN} / ${everyone.length}명` : `접속 ${onlineN}명`;
  const hands = S.students.filter((s) => s.hand).length;
  const reqs = S.students.filter((s) => s.mic_req).length;
  $("#hand-badge").textContent = [reqs ? `🎙️${reqs}` : "", hands ? `✋${hands}` : ""].filter(Boolean).join(" ");
  $("#hand-badge").hidden = !hands && !reqs;
  const mixed = new Set(everyone.map((s) => s.school || "")).size > 1; // 다른 학교 학생이 섞이면 학교도 표시
  $("#people").replaceChildren(...list.map((s) => s.absent ? h("div", { class: "person absent" },
    h("span", { class: "dot", title: "아직 안 들어옴" }), h("span", {}, `${s.name} `, h("span", { class: "muted", style: "font-size:0.8rem" },
      mixed && s.school ? `${s.school} · ` : "", "미접속"))) : h("div", { class: `person ${s.hand || s.mic_req ? "hand" : ""}` },
    h("span", { class: `dot ${s.online ? "on" : ""}`, title: s.online ? "접속 중" : "나감" }),
    h("span", {}, s.mic_req ? h("span", { title: "마이크를 켜 달라고 요청했어요 — 🔇를 누르면 켜져요" }, "🎙️ ") : null,
      s.hand ? h("span", { title: "할 말이 있어요" }, "✋ ") : null, `${s.name} `,
      s.stickers ? h("span", { class: "sticker-count", title: "받은 칭찬 스티커" }, `⭐${s.stickers} `) : null, h("span", { class: "muted", style: "font-size:0.8rem" },
      mixed && s.school ? `${s.school} · ` : "", roomLabel(s), s.sessions > 1 ? ` 재입장 ${s.sessions - 1}회` : "")),
    h("span", { class: "acts" },
      s.hand ? h("button", { title: "손 내리기", onclick: () => sock.send({ t: "lower_hand", target: s.id }) }, "✋↓") : null,
      ...deviceButtons(s),
      h("button", { title: "내보내기", class: "danger", onclick: () => {
        if (confirm(`${s.name} 학생을 수업에서 내보낼까요?`)) sock.send({ t: "kick", target: s.id });
      } }, "✕")))));
  if (!list.length) $("#people").append(h("p", { class: "muted", style: "margin:0" }, S.course_id ? "수강 확정된 학생이 없어요." : "아직 들어온 학생이 없어요."));
  renderEvents();
}

$("#set-ai").addEventListener("change", (e) => sock.send({ t: "settings", ai: e.target.checked }));
$("#mirror-btn").addEventListener("click", () => sock.send({ t: "settings", mirror: S?.settings.mirror === false }));
$("#mute-all").addEventListener("click", () => { sock.send({ t: "cmd", cmd: "mute", target: "all" }); toast("모든 학생의 마이크를 껐어요."); });

/* ───── 학생 화면 구성: 모두 보기 / 선생님 크게 / 토론(학생 둘) ───── */

function renderLayout() {
  const mode = S.layout?.mode || "grid";
  if (document.activeElement !== $("#layout-sel")) $("#layout-sel").value = mode;
  const debating = $("#layout-sel").value === "debate";
  $("#debate-bar").hidden = !debating;
  if (!debating) return;
  const online = S.students.filter((x) => x.online && x.room === "main");
  const sig = JSON.stringify(online.map((x) => [x.id, x.name]));
  for (const [sel, i] of [[$("#debate-a"), 0], [$("#debate-b"), 1]]) {
    if (sel.dataset.sig === sig && document.activeElement === sel) continue;
    const cur = sel.value || (S.layout?.pair || [])[i] || "";
    sel.dataset.sig = sig;
    sel.replaceChildren(h("option", { value: "" }, "학생 고르기"), ...koSort(online, (x) => x.name).map((x) => h("option", { value: x.id, selected: x.id === cur }, x.name)));
  }
}
$("#layout-sel").addEventListener("change", (e) => {
  const mode = e.target.value;
  if (mode === "debate") { renderLayout(); toast("토론할 학생 둘을 고르고 '학생 화면에 띄우기'를 눌러 주세요."); return; }
  sock.send({ t: "layout", mode });
  toast(mode === "grid" ? "학생 화면에 모두가 나란히 보여요." : "학생 화면에 선생님이 크게 보여요.");
});
$("#debate-apply").addEventListener("click", () => {
  const pair = [$("#debate-a").value, $("#debate-b").value].filter(Boolean);
  if (pair.length !== 2 || pair[0] === pair[1]) { toast("서로 다른 학생 둘을 골라 주세요."); return; }
  sock.send({ t: "layout", mode: "debate", pair });
  toast("학생 화면에 두 학생이 나란히 크게 보여요.");
});
$("#cam-all").addEventListener("click", () => { sock.send({ t: "cmd", cmd: "cam_on", target: "all" }); toast("모든 학생의 카메라를 켰어요."); });
$("#lower-all").addEventListener("click", () => sock.send({ t: "lower_hand", target: "all" }));

/* ───── 퀴즈·설문 ───── */

let actKind = "ox";
let actSig = "";

function renderActForm() {
  for (const b of $("#kind-picker").children) b.classList.toggle("on", b.dataset.kind === actKind);
  const box = $("#act-options");
  box.replaceChildren();
  if (actKind === "text") { box.append(h("p", { class: "muted", style: "margin:0" }, "학생이 짧은 글로 답해요.")); return; }
  if (actKind === "ox") {
    box.append(h("div", { class: "row" }, "정답:",
      ...["없음", "O", "X"].map((label, i) => h("label", { class: "switch" },
        h("input", { type: "radio", name: "ox-correct", value: i - 1, checked: i === 0 }), label))));
    return;
  }
  const rows = h("div", { class: "options", id: "opt-rows" });
  const addRow = (val = "") => {
    const row = h("div", { class: "option-row" },
      actKind === "choice" ? h("input", { type: "radio", name: "correct", title: "정답으로 표시" }) : h("span", {}, "•"),
      h("input", { class: "opt", maxlength: 100, placeholder: `보기 ${rows.children.length + 1}`, value: val }),
      h("button", { type: "button", class: "small", onclick: () => { if (rows.children.length > 2) row.remove(); } }, "✕"));
    rows.append(row);
  };
  for (let i = 0; i < 4; i++) addRow();
  box.append(rows, h("div", { class: "row" },
    h("button", { type: "button", class: "small", onclick: () => { if (rows.children.length < 8) addRow(); } }, "+ 보기 추가"),
    actKind === "choice" ? h("span", { class: "muted", style: "font-size:0.85rem" }, "동그라미를 눌러 정답 표시(선택)") : null));
  if (actKind === "poll") {
    box.append(h("div", { class: "row" }, "응답:",
      h("label", { class: "switch" }, h("input", { type: "radio", name: "poll-multi", value: "0", checked: true }), "1개만 고르기"),
      h("label", { class: "switch" }, h("input", { type: "radio", name: "poll-multi", value: "1" }), "여러 개 고르기")));
  }
}

$("#kind-picker").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kind]");
  if (!b) return;
  actKind = b.dataset.kind;
  renderActForm();
});

$("#act-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const prompt = $("#act-prompt").value.trim();
  if (!prompt) return;
  const msg = { t: "activity_start", kind: actKind, prompt };
  if (actKind === "ox") {
    const v = Number(document.querySelector("input[name=ox-correct]:checked")?.value ?? -1);
    msg.correct = v >= 0 ? v : null;
  } else if (actKind !== "text") {
    const rows = [...document.querySelectorAll("#opt-rows .option-row")];
    const filled = rows.filter((r) => r.querySelector(".opt").value.trim());
    if (filled.length < 2) { toast("보기를 2개 이상 적어 주세요."); return; }
    msg.options = filled.map((r) => r.querySelector(".opt").value.trim());
    const ci = filled.findIndex((r) => r.querySelector("input[type=radio]")?.checked);
    msg.correct = ci >= 0 ? ci : null;
    if (actKind === "poll") msg.multi = document.querySelector("input[name=poll-multi]:checked")?.value === "1";
  }
  if (S.activity?.open && !confirm("진행 중인 활동을 끝내고 새 활동을 보낼까요?")) return;
  if (sock.send(msg)) {
    $("#act-prompt").value = "";
    renderActForm();
    toast("학생들에게 보냈어요.");
  }
});

function renderActivity() {
  const a = S.activity;
  const online = S.students.filter((s) => s.online).length;
  const sig = JSON.stringify([a, online]);
  if (sig === actSig) return;
  actSig = sig;
  const box = $("#activity-current");
  const mini = $("#activity-mini");
  box.replaceChildren();
  mini.replaceChildren();
  $("#act-form").hidden = !!a; // 지금 활동을 '끝내기' 해야 새 활동을 보낼 수 있다
  if (!a) return;

  const answerText = (r) => (a.kind === "text" ? r.value
    : [].concat(r.value).map((v) => a.options[v] ?? "?").join(", ")); // 여러 개 고른 설문은 쉼표로
  const card = h("section", { class: "activity" },
    h("div", { class: "kind" }, `${kindName(a)} · ${a.open ? "진행 중" : "마감"}${a.reveal ? " · 결과 공개 중" : ""}`),
    h("h3", {}, a.prompt),
    h("div", { class: "muted" }, `응답 ${a.total}명 / 접속 ${online}명`),
    a.kind === "text"
      ? h("div", { class: "texts" }, a.responses.map((r) => h("div", {}, h("strong", {}, `${r.name}: `), r.value)))
      : resultBars(a),
    a.kind !== "text" && a.responses.length ? h("details", {}, h("summary", { class: "muted" }, "누가 무엇을 골랐는지 보기"),
      h("div", { class: "texts" }, a.responses.map((r) => h("div", {},
        `${r.name}: ${answerText(r)}${a.correct !== null ? (r.value === a.correct ? " ⭕" : " ❌") : ""}`)))) : null,
    h("div", { class: "row" },
      a.open
        ? h("button", { onclick: () => sock.send({ t: "activity_close" }) }, "⏹ 마감")
        : h("button", { onclick: () => sock.send({ t: "activity_reopen" }) }, "▶ 다시 열기"),
      h("button", { class: a.reveal ? "on" : "", onclick: () => sock.send({ t: "activity_reveal", on: !a.reveal }) },
        a.reveal ? "🙈 결과 숨기기" : "📊 학생에게 결과 공개"),
      h("button", { class: "danger", onclick: () => sock.send({ t: "activity_clear" }) }, "끝내기")));
  box.append(card);
  // 결과를 공개하면 학생 화면에 어떻게 보이는지 선생님도 함께 본다 (학생 이름은 보이지 않음)
  box.append(h("div", { class: "reveal-preview" },
    h("div", { class: "muted", style: "font-size:0.85rem;margin-bottom:6px" },
      a.reveal ? "📱 지금 학생 화면 (결과 공개 중)" : "📱 결과를 공개하면 학생 화면에 이렇게 보여요"),
    revealPreview(a)));
  // 메인 화면에도 짧게 표시
  mini.append(h("div", { class: "banner" }, h("strong", {}, `📝 ${KIND_NAMES[a.kind]}`),
    h("span", { class: "grow" }, a.prompt), h("span", { class: "muted" }, `응답 ${a.total}/${online}`),
    h("button", { class: "small", onclick: () => showTab("activity") }, "보기")));
}

/* ───── 채팅 ───── */

const dmTargets = new Map(); // 1:1로 보낼 수 있는 학생 (학생이 먼저 1:1을 보냈거나 선생님이 '답장'을 누름)

function renderScopes() {
  const sel = $("#chat-scope");
  const opts = [["main", "전체 교실"]];
  if (S.groups.length) {
    koSort(S.groups, (g) => g.name).forEach((g) => opts.push([g.id, g.name]));
    opts.push(["*", "📢 모든 방"]);
  }
  for (const [sid, name] of koSort(dmTargets, (x) => x[1])) opts.push([`dm:${sid}`, `🔒 ${name}에게 1:1`]);
  const sig = JSON.stringify(opts);
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  const cur = sel.value;
  sel.replaceChildren(...opts.map(([v, label]) => h("option", { value: v, selected: v === cur }, label)));
}

function addChat(m, live) {
  const log = $("#chatlog");
  const stick = nearBottom(log);
  const dm = m.scope?.startsWith("dm:");
  const scopeName = m.broadcast ? null : dm ? (m.role === "teacher" ? `🔒 ${m.to_name || "학생"}에게 1:1` : "🔒 선생님에게 1:1")
    : (m.scope === "main" ? (S?.groups.length ? "전체" : null) : groupName(m.scope));
  const bubble = chatBubble(m, { mine: m.role === "teacher", scopeName });
  if (dm) bubble.classList.add("private");
  if (dm && m.role === "student") {
    dmTargets.set(m.sid, m.name);
    bubble.append(h("button", { class: "small", onclick: () => {
      renderScopes();
      $("#chat-scope").value = `dm:${m.sid}`;
      $("#chatinput").focus();
    } }, "↩ 1:1 답장"));
  }
  log.append(bubble);
  if (stick || m.role === "teacher") log.scrollTop = log.scrollHeight;
  if (live && activeTab !== "chat" && m.role !== "teacher") { // 참여자 탭을 보는 동안 온 채팅 수
    unreadChat++;
    $("#chat-badge").textContent = unreadChat;
    $("#chat-badge").hidden = false;
  }
}

$("#chatform").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#chatinput");
  const text = input.value.trim();
  if (!text) return;
  const scope = $("#chat-scope").value;
  const ok = scope === "*" ? sock.send({ t: "broadcast", text }) : sock.send({ t: "chat", text, scope });
  if (ok) input.value = "";
});
submitOnEnter($("#chatinput"), $("#chatform"));

/* ───── 질문 ───── */

let qSig = "";
const qDrafts = new Map();

function renderQuestions() {
  if (!$("#questions")) return; // 질문 탭은 없앴다 (학생은 1:1 채팅으로 보낸다)
  const qs = S.questions;
  const open = qs.filter((q) => !q.done).length;
  $("#q-badge").textContent = open;
  $("#q-badge").hidden = !open;
  const sig = JSON.stringify(qs);
  if (sig === qSig) return;
  qSig = sig;
  const focusedId = document.activeElement?.dataset?.qid;
  const list = qs.slice().sort((a, b) => (a.done - b.done) || (b.ts - a.ts));
  $("#questions").replaceChildren(...list.map((q) => {
    const input = h("input", { class: "grow", maxlength: 500, placeholder: "답변 (이 학생에게만 보여요)", "data-qid": q.id,
      value: qDrafts.get(q.id) ?? "" });
    input.addEventListener("input", () => qDrafts.set(q.id, input.value));
    return h("div", { class: `q ${q.done ? "done" : ""}` },
      h("div", { class: "meta" }, `${q.name} · ${fmtTime(q.ts)}`),
      h("div", {}, q.text),
      q.reply ? h("div", { class: "reply" }, `답변: ${q.reply}`) : null,
      h("form", { class: "row", onsubmit: (e) => {
        e.preventDefault();
        if (!input.value.trim()) return;
        sock.send({ t: "question_update", id: q.id, reply: input.value.trim(), done: true });
        qDrafts.delete(q.id);
      } }, input, h("button", { type: "submit", class: "small" }, "답변")),
      h("div", { class: "row" },
        h("button", { class: "small", onclick: () => sock.send({ t: "question_update", id: q.id, done: !q.done }) },
          q.done ? "다시 열기" : "✓ 확인함"),
        h("button", { class: "small", onclick: () => {
          sock.send({ t: "announce", text: `${q.name}의 질문: ${q.text}` });
          toast("모든 학생 화면 위에 공지로 띄웠어요.");
        } }, "📢 모두에게 공유")));
  }));
  if (!qs.length) $("#questions").append(h("p", { class: "muted", style: "margin:0" }, "아직 질문이 없어요."));
  if (focusedId) document.querySelector(`[data-qid="${focusedId}"]`)?.focus();
}

/* ───── 모둠 편성 ───── */

let gSig = "";

function renderGroups() {
  const sig = JSON.stringify([S.groups, S.breakout, S.students.map((s) => [s.id, s.name, s.group, s.online])]);
  if (sig === gSig) return;
  gSig = sig;
  $("#bo-start").textContent = S.breakout ? "모둠활동 진행 중" : "▶ 모둠활동 시작";
  $("#bo-start").disabled = S.breakout;
  const box = $("#group-edit");
  box.replaceChildren();
  if (!S.groups.length) {
    box.append(h("p", { class: "muted", style: "font-size:0.9rem" }, "모둠 수를 정하고 '모둠 만들기'를 누르면 여기에 A모둠, B모둠… 칸이 생겨요."));
    return;
  }
  const groups = koSort(S.groups, (g) => g.name);
  const assign = (s, gid) => sock.send({ t: "breakout_assign", target: s.id, group: gid });
  const short = (g) => g.name.replace("모둠", "");
  const label = (s) => h("span", { class: "who" }, `${s.online ? "" : "💤 "}${s.name}`);
  // 미배정 학생: 모둠 글자 버튼을 눌러 바로 보낸다
  const none = koSort(S.students.filter((s) => !s.group || !S.groups.some((g) => g.id === s.group)), (s) => s.name);
  box.append(h("div", { class: "g unassigned" },
    h("strong", {}, `미배정 ${none.length}명`),
    none.length ? h("div", { class: "members" }, none.map((s) => h("div", { class: "pick" }, label(s),
      h("span", { class: "letters" }, groups.map((g) => h("button", { class: "small", title: `${g.name}으로`, onclick: () => assign(s, g.id) }, short(g)))))))
      : h("span", { class: "muted", style: "font-size:0.85rem" }, "모든 학생이 모둠에 들어갔어요.")));
  // 모둠별 칸: 이름 옆 ✕ 로 빼면 미배정으로 돌아간다
  const board = h("div", { class: "group-board" });
  for (const g of groups) {
    const members = koSort(S.students.filter((s) => s.group === g.id), (s) => s.name);
    board.append(h("div", { class: "g" },
      h("strong", {}, `${g.name} `, h("span", { class: "muted" }, `${members.length}명`)),
      h("div", { class: "members" }, members.length ? members.map((s) => h("div", { class: "pick" }, label(s),
        h("button", { class: "small", title: "모둠에서 빼기", onclick: () => assign(s, null) }, "✕")))
        : h("span", { class: "muted", style: "font-size:0.85rem" }, "비어 있어요"))));
  }
  box.append(board);
  if (none.length && !S.breakout) {
    box.append(h("p", { class: "muted", style: "font-size:0.85rem;margin:6px 0 0" }, "미배정 학생은 시작할 때 인원이 적은 모둠으로 들어가요."));
  }
}

/** 모둠 수 */
function groupPlan() {
  return { n: Math.min(12, Math.max(1, Number($("#bo-n").value) || 4)) };
}

$("#bo-setup").addEventListener("click", () => {
  if (S.breakout && !confirm("모둠 활동 중이에요. 모둠 수를 바꾸면 없어지는 모둠의 학생은 미배정이 돼요. 계속할까요?")) return;
  sock.send({ t: "breakout_setup", ...groupPlan() });
});
$("#bo-plan").addEventListener("click", () => {
  const assigned = S.students.some((s) => s.group);
  if ((S.breakout || assigned) && !confirm("지금 배정을 지우고 무작위로 다시 나눌까요?" + (S.breakout ? " 학생들이 바로 이동해요." : ""))) return;
  sock.send({ t: "breakout_plan", ...groupPlan() });
});
$("#bo-start").addEventListener("click", () => {
  if (!S.breakout) sock.send({ t: "breakout_start", ...groupPlan() });
  $("#group-dlg").hidden = true;
});

/* ───── 탭·기타 ───── */

/** 왼쪽 위 시계: 수업을 연 뒤 지난 시간 */
setInterval(() => {
  if (!S?.started_at) return;
  const sec = Math.max(0, Math.floor(clock.now() - S.started_at));
  const pad = (n) => String(n).padStart(2, "0");
  $("#class-clock").textContent = `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
}, 1000);

// 오른쪽 바는 [참여자]·[채팅] 탭, 설문/퀴즈·모둠은 왼쪽 버튼으로 여는 팝업이다
let activeTab = "people";
let unreadChat = 0;
function showTab(name) {
  const id = { activity: "quiz-dlg", groups: "group-dlg" }[name];
  if (id) {
    for (const d of document.querySelectorAll(".tool-dlg")) d.hidden = d.id !== id;
    return;
  }
  activeTab = name;
  for (const b of $("#tabs").children) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
  if (name === "chat") { unreadChat = 0; $("#chat-badge").hidden = true; $("#chatlog").scrollTop = $("#chatlog").scrollHeight; }
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
});
for (const d of document.querySelectorAll(".tool-dlg")) {
  d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.hidden = true; });
}
$("#group-btn").addEventListener("click", () => showTab("groups"));

$("#copy-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(studentLink);
    toast("참여 링크를 복사했어요. 학생들에게 보내 주세요.");
  } catch {
    prompt("이 링크를 복사해 학생들에게 보내 주세요.", studentLink);
  }
});

$("#end-class").addEventListener("click", () => {
  if (!confirm("수업을 종료할까요? 모든 학생이 나가요.\n출결과 퀴즈 결과는 '출결 기록'에서 계속 볼 수 있어요.")) return;
  stopRecording(); // 녹화 중이면 저장하고 끝낸다
  sock.send({ t: "end_class" });
});

renderActForm();
