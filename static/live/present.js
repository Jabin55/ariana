/* 발표(PDF)·화이트보드 화면. 선생님 화면과 학생 화면이 함께 쓴다.
 * - PDF는 pdf.js로 각자 기기에서 그린다(서버는 파일만 전달).
 * - 판서는 쪽마다 따로 저장되고, 좌표는 0~1 비율이라 화면 크기가 달라도 같은 자리에 보인다.
 * - 선 굵기는 '종이 폭 1000px일 때 픽셀' 단위로 저장해 화면이 작아지면 같이 얇아진다. */

const PDFJS_BASE = "/static/vendor/pdfjs-4.10.38/";
let pdfjsLib = null;
async function loadPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(`${PDFJS_BASE}pdf.min.js`);
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.js`;
  }
  return pdfjsLib;
}

const BOARD_RATIO = 16 / 9;
const PEN_COLORS = ["#222222", "#d92d20", "#1d5fd6", "#16803c"];
const TEXT_SIZE = 30; // 판서 글자 크기 (종이 폭 1000px일 때 px)
const STICKER_SIZE = 56; // 이모지 스티커 크기
const BOARD_STICKERS = ["👍", "⭐", "❤️", "✅", "❌", "❓", "💡", "🎉", "👏", "🔥", "📌", "😀"];

class Presenter {
  /**
   * @param {HTMLElement} box  그릴 자리
   * @param {object} opt  { code, canDraw, send(msg), fileUrl(fid)? — 지난 수업 자료처럼 다른 주소에서 받을 때 }
   */
  constructor(box, opt) {
    this.box = box;
    this.opt = opt;
    this.view = null; // 서버가 보낸 present 상태
    this.docs = new Map(); // 파일 id → Promise<PDFDocument>
    this.strokes = new Map(); // 쪽 key → [획]
    this.mine = new Map(); // 쪽 key → 내가 그린 획 id (되돌리기용)
    this.tool = { kind: "pen", color: PEN_COLORS[0] };
    this.renderSeq = 0;
    this.renderTask = null;
    this.pageSize = null; // 지금 쪽의 원래 크기 (가로세로 비율용)

    this.pageCanvas = h("canvas", { class: "page" });
    this.inkCanvas = h("canvas", { class: "ink" });
    this.sheet = h("div", { class: "sheet" }, this.pageCanvas, this.inkCanvas);
    this.loading = h("div", { class: "present-loading", hidden: true }, "자료를 불러오는 중…");
    this.area = h("div", { class: "present-area" }, this.sheet, this.loading);
    box.append(this.area);
    new ResizeObserver(() => this.layout()).observe(this.area);
    if (opt.canDraw) this.enableDrawing();
    if (opt.viewerZoom) this.enableViewerZoom();
  }

  get key() { return this.view?.key || null; }

  /** 서버 상태가 바뀔 때마다 부른다 */
  async setView(view) {
    const prev = this.view;
    this.view = view;
    if (!view) { this.pageSize = null; return; }
    if (prev && prev.key === view.key && prev.pages === view.pages) {
      // 같은 쪽: 확대 배율이 바뀌면 다시 그리고, 위치만 바뀌면 옮기기만 한다
      if ((prev.zoom?.z || 1) !== this.zoomZ()) this.layout();
      else this.place();
      return;
    }
    this.localZoom = null;
    this.ownZoom = null;
    this.zoomBadge?.();
    const seq = ++this.renderSeq;
    if (view.mode === "board") {
      this.pageSize = { w: 1600, h: 1600 / BOARD_RATIO };
      this.loading.hidden = true;
      this.layout();
      return;
    }
    this.loading.hidden = false;
    try {
      const doc = await this.doc(view.file);
      if (seq !== this.renderSeq) return;
      const page = await doc.getPage(Math.min(view.page, doc.numPages));
      if (seq !== this.renderSeq) return;
      const vp = page.getViewport({ scale: 1 });
      this.page = page;
      this.pageSize = { w: vp.width, h: vp.height };
      this.loading.hidden = true;
      this.layout();
    } catch (err) {
      console.error(err);
      if (seq === this.renderSeq) this.loading.textContent = "자료를 불러오지 못했어요. 새로고침해 보세요.";
    }
  }

  doc(fid) {
    if (!this.docs.has(fid)) {
      const p = loadPdfjs().then((lib) => lib.getDocument({
        url: this.opt.fileUrl ? this.opt.fileUrl(fid) : `/api/live/classes/${this.opt.code}/files/${fid}`,
        cMapUrl: `${PDFJS_BASE}cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
        isEvalSupported: false, withCredentials: true,
      }).promise);
      p.catch(() => this.docs.delete(fid)); // 실패하면 다음에 다시 시도
      this.docs.set(fid, p);
    }
    return this.docs.get(fid);
  }

  /** 쪽 수를 알아야 할 때(선생님이 발표를 시작할 때) */
  async pageCount(fid) { return (await this.doc(fid)).numPages; }

  /** 확대 배율 (PDF 발표만, 선생님이 정하면 학생 화면도 같이) */
  zoomZ() {
    if (this.ownZoom) return this.ownZoom.z; // 학생이 자기 화면만 확대한 경우
    return this.view?.mode === "slides" ? (this.localZoom?.z || this.view.zoom?.z || 1) : 1;
  }
  zoomXY() { const z = this.ownZoom || this.localZoom || this.view?.zoom || {}; return [z.x ?? 0.5, z.y ?? 0.5]; }

  /** 자리 크기에 맞춰 종이 크기를 정하고 다시 그린다 */
  layout() {
    if (!this.pageSize) return;
    const W = this.area.clientWidth;
    if (!W) return;
    const ratio = this.pageSize.w / this.pageSize.h;
    // 자리 높이를 자료 비율에 맞춘다(화면의 72%까지). 위아래 검은 띠가 생기지 않게.
    const H = Math.min(window.innerHeight * 0.72, W / ratio);
    this.area.style.height = `${Math.floor(H)}px`;
    let w = W;
    let hh = w / ratio;
    if (hh > H) { hh = H; w = hh * ratio; }
    const z = this.zoomZ();
    w = Math.floor(w * z); hh = Math.floor(hh * z);
    this.sheet.style.width = `${w}px`;
    this.sheet.style.height = `${hh}px`;
    this.place();
    // 크게 확대해도 너무 큰 그림을 만들지 않게(기기 메모리) 해상도를 제한한다
    const dpr = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(w, hh));
    for (const c of [this.pageCanvas, this.inkCanvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
    }
    this.dpr = dpr;
    this.drawPage();
    this.redrawInk();
  }

  /** 확대했을 때 보이는 부분: 선생님이 고른 지점이 가운데 오게 (가장자리 밖은 보이지 않게) */
  place() {
    const z = this.zoomZ();
    this.area.classList.toggle("zoomed", z > 1);
    if (z <= 1) { this.sheet.style.left = ""; this.sheet.style.top = ""; return; }
    const W = this.area.clientWidth, H = this.area.clientHeight;
    const sw = this.sheet.offsetWidth, sh = this.sheet.offsetHeight;
    const [x, y] = this.zoomXY();
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const left = sw <= W ? (W - sw) / 2 : clamp(W / 2 - x * sw, W - sw, 0);
    const top = sh <= H ? (H - sh) / 2 : clamp(H / 2 - y * sh, H - sh, 0);
    this.sheet.style.left = `${Math.round(left)}px`;
    this.sheet.style.top = `${Math.round(top)}px`;
  }

  /** 선생님: 확대·이동 (학생 화면에도 같이 보낸다) */
  setZoom(z, x, y) {
    if (this.view?.mode !== "slides") return;
    const [cx, cy] = this.zoomXY();
    const nz = Math.min(4, Math.max(1, Math.round(z * 100) / 100));
    const nx = Math.min(1, Math.max(0, x ?? cx)), ny = Math.min(1, Math.max(0, y ?? cy));
    const sizeChanged = nz !== this.zoomZ();
    this.localZoom = { z: nz, x: nx, y: ny };
    if (sizeChanged) this.layout(); else this.place();
    clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => { this.opt.send({ t: "present_zoom", z: nz, x: nx, y: ny }); }, 60);
  }

  drawPage() {
    const c = this.pageCanvas;
    const ctx = c.getContext("2d");
    if (this.view?.mode !== "slides" || !this.page) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      return;
    }
    this.renderTask?.cancel();
    const vp = this.page.getViewport({ scale: c.width / this.pageSize.w });
    this.renderTask = this.page.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" });
    this.renderTask.promise.catch(() => { /* 다시 그리느라 취소됨 */ });
  }

  /* ───── 판서 ───── */

  setStrokes(key, list) { this.strokes.set(key, list.map((s) => ({ ...s, pts: [...s.pts] }))); if (key === this.key) this.redrawInk(); }

  addPoints(msg) {
    const list = this.strokes.get(msg.key) || [];
    this.strokes.set(msg.key, list);
    let st = list.find((s) => s.id === msg.id);
    if (!st) { st = { id: msg.id, color: msg.color, size: msg.size, hl: msg.hl, pts: [] }; if (msg.text) st.text = msg.text; list.push(st); }
    if (st.text && st.pts.length) return; // 글자는 한 점만
    const from = Math.max(0, st.pts.length - 1);
    st.pts.push(...msg.pts);
    if (msg.key !== this.key) return;
    // 형광펜은 반투명이라 나눠 그리면 이음새가 진해진다 → 판서 전체를 다시 그린다
    if (st.hl || st.text) this.redrawInk();
    else this.drawStroke(this.inkCanvas.getContext("2d"), st, from);
  }

  removeStrokes(key, ids) {
    const set = new Set(ids);
    this.strokes.set(key, (this.strokes.get(key) || []).filter((s) => !set.has(s.id)));
    if (key === this.key) this.redrawInk();
  }

  redrawInk() {
    const c = this.inkCanvas;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    for (const st of this.strokes.get(this.key) || []) this.drawStroke(ctx, st, 0);
  }

  /** 글자 판서의 글꼴과 줄들 (캔버스 픽셀 기준) */
  textLayout(ctx, st) {
    const c = this.inkCanvas;
    const px = Math.max(6, (st.size * c.width) / 1000);
    ctx.font = `600 ${px}px ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
    const lines = String(st.text).split("\n");
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
    return { px, lines, w, lh: px * 1.25 };
  }

  /** 글자 판서가 차지하는 칸 (0~1 비율) — 지우개 판정용 */
  textBox(st) {
    const c = this.inkCanvas;
    const ctx = c.getContext("2d");
    ctx.save();
    const { lines, w, lh } = this.textLayout(ctx, st);
    ctx.restore();
    const [x, y] = st.pts[0];
    return [x, y, x + w / c.width, y + (lh * lines.length) / c.height];
  }

  drawStroke(ctx, st, from) {
    const c = this.inkCanvas;
    if (!st.pts.length) return;
    if (st.text) {
      ctx.save();
      const { lines, lh } = this.textLayout(ctx, st);
      ctx.fillStyle = st.color;
      ctx.textBaseline = "top";
      const [x, y] = st.pts[0];
      lines.forEach((l, i) => ctx.fillText(l, x * c.width, y * c.height + i * lh));
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = st.color;
    ctx.globalAlpha = st.hl ? 0.35 : 1;
    ctx.lineWidth = Math.max(1, (st.size * c.width) / 1000);
    ctx.beginPath();
    const p0 = st.pts[from];
    ctx.moveTo(p0[0] * c.width, p0[1] * c.height);
    if (st.pts.length === 1) ctx.lineTo(p0[0] * c.width + 0.1, p0[1] * c.height);
    for (let i = from + 1; i < st.pts.length; i++) ctx.lineTo(st.pts[i][0] * c.width, st.pts[i][1] * c.height);
    ctx.stroke();
    ctx.restore();
  }

  enableDrawing() {
    const c = this.inkCanvas;
    c.classList.add("drawable");
    let cur = null; // 그리는 중인 획
    let pending = []; // 아직 서버에 보내지 않은 점
    let timer = null;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    };
    const flushPts = () => {
      timer = null;
      if (!cur || !pending.length) return;
      this.opt.send({ t: "stroke", key: cur.key, id: cur.id, color: cur.color, size: cur.size, hl: cur.hl, pts: pending });
      pending = [];
    };
    const erase = (p) => {
      const list = this.strokes.get(this.key) || [];
      const r = 12 / c.getBoundingClientRect().width; // 지우개 반경 (비율)
      const own = this.opt.eraseOwnOnly ? new Set(this.mine.get(this.key) || []) : null; // 학생은 자기 획만 지운다
      const hit = list.filter((s) => own ? own.has(s.id) : true).filter((s) => {
        if (s.text && s.pts.length) {
          const [x0, y0, x1, y1] = this.textBox(s);
          return p[0] >= x0 - r && p[0] <= x1 + r && p[1] >= y0 - r && p[1] <= y1 + r;
        }
        return s.pts.some((q) => Math.hypot(q[0] - p[0], (q[1] - p[1]) * (c.height / c.width)) < r + (s.size / 2000));
      });
      if (!hit.length) return;
      const ids = hit.map((s) => s.id);
      this.removeStrokes(this.key, ids);
      this.opt.send({ t: "stroke_del", key: this.key, ids });
    };
    c.addEventListener("pointerdown", (e) => {
      if (!this.key || e.button > 0) return;
      if (this.opt.mayDraw && !this.opt.mayDraw()) return; // 학생: 선생님이 화이트보드를 열었을 때만
      if (this.opt.viewerZoom && this.tool.kind === "pan") return; // 학생의 이동은 내 화면 확대 쪽에서
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      if (this.tool.kind === "pan") { // ✋ 이동: 확대한 자료를 끌어서 옮긴다
        const [x0, y0] = this.zoomXY();
        cur = { pan: true, sx: e.clientX, sy: e.clientY, x0, y0 };
        return;
      }
      if (this.tool.kind === "eraser") { cur = { eraser: true }; erase(pos(e)); return; }
      if (this.tool.kind === "text") { this.openTextInput(pos(e)); return; }
      if (this.tool.kind === "sticker") {
        const [x, y] = pos(e);
        const half = STICKER_SIZE / 2000; // 이모지 한 글자 ≈ 글자 크기만큼 넓다 → 누른 곳이 가운데 오게
        this.addText(this.tool.emoji || BOARD_STICKERS[0], [x - half, y - (half * c.width) / c.height], STICKER_SIZE, "#222222");
        return;
      }
      const hl = this.tool.kind === "hl";
      cur = { key: this.key, id: Math.random().toString(36).slice(2, 12), color: this.tool.color, size: hl ? 18 : 3, hl };
      const mine = this.mine.get(cur.key) || [];
      mine.push(cur.id);
      this.mine.set(cur.key, mine);
      const p = pos(e);
      this.addPoints({ key: cur.key, id: cur.id, color: cur.color, size: cur.size, hl, pts: [p] });
      pending = [p];
      flushPts();
    });
    c.addEventListener("pointermove", (e) => {
      if (!cur) return;
      if (cur.pan) {
        const sw = this.sheet.offsetWidth, sh = this.sheet.offsetHeight;
        this.setZoom(this.zoomZ(), cur.x0 - (e.clientX - cur.sx) / sw, cur.y0 - (e.clientY - cur.sy) / sh);
        return;
      }
      if (cur.eraser) { erase(pos(e)); return; }
      const pts = (e.getCoalescedEvents?.() || [e]).map(pos);
      this.addPoints({ key: cur.key, id: cur.id, color: cur.color, size: cur.size, hl: cur.hl, pts });
      pending.push(...pts);
      if (!timer) timer = setTimeout(flushPts, 40); // 0.04초마다 모아서 보낸다
    });
    const end = () => { if (cur && !cur.eraser && !cur.pan) { clearTimeout(timer); flushPts(); } cur = null; };
    // Ctrl + 마우스 휠로도 확대·축소 (마우스가 있는 곳을 중심으로)
    c.addEventListener("wheel", (e) => {
      if (this.opt.viewerZoom || !e.ctrlKey || this.view?.mode !== "slides") return;
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.setZoom(this.zoomZ() * (e.deltaY < 0 ? 1.2 : 1 / 1.2), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    }, { passive: false });
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }

  /** 글자·스티커 한 덩이를 올린다 (모두에게 보이고, 되돌리기·지우개로 지울 수 있다) */
  addText(text, p, size, color) {
    text = String(text).trim().slice(0, 200);
    if (!text || !this.key) return;
    const pt = [Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1]))];
    const id = Math.random().toString(36).slice(2, 12);
    const mine = this.mine.get(this.key) || [];
    mine.push(id);
    this.mine.set(this.key, mine);
    this.addPoints({ key: this.key, id, color, size, hl: false, text, pts: [pt] });
    this.opt.send({ t: "stroke", key: this.key, id, color, size, hl: false, text, pts: [pt] });
  }

  /** 글자 도구: 누른 자리에 입력칸을 띄운다. Enter = 올리기, Shift+Enter = 줄바꿈, Esc = 취소 */
  openTextInput(p) {
    this.textInput?.remove();
    const key = this.key;
    const color = this.tool.color;
    const px = (TEXT_SIZE * this.sheet.offsetWidth) / 1000;
    const box = h("textarea", { class: "board-text-input", rows: 1, maxlength: 200, placeholder: "글자 입력 후 Enter",
      style: `left:${p[0] * 100}%;top:${p[1] * 100}%;font-size:${px}px;color:${color}` });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const text = box.value;
      box.remove();
      if (this.textInput === box) this.textInput = null;
      if (ok && key === this.key) this.addText(text, p, TEXT_SIZE, color);
    };
    const grow = () => { box.style.height = "auto"; box.style.height = `${box.scrollHeight}px`; };
    box.addEventListener("input", grow);
    box.addEventListener("keydown", (e) => {
      e.stopPropagation(); // 화살표 키로 쪽이 넘어가지 않게
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish(true); }
      if (e.key === "Escape") finish(false);
    });
    box.addEventListener("blur", () => finish(true));
    this.sheet.append(box);
    this.textInput = box;
    setTimeout(() => { box.focus(); grow(); }, 0);
  }

  /** 학생: 내 화면만 확대·축소하고 끌어서 옮긴다 (선생님 화면에는 영향 없음) */
  enableViewerZoom() {
    const label = h("span", { class: "vz-label" });
    const out = h("button", { type: "button", title: "축소" }, "－");
    const fit = h("button", { type: "button", title: "쪽 전체 보기" }, "맞춤");
    const set = (z, x, y) => {
      if (!this.view) return;
      const [cx, cy] = this.zoomXY();
      const nz = Math.min(4, Math.max(1, Math.round(z * 100) / 100));
      this.ownZoom = nz <= 1 ? null : { z: nz, x: Math.min(1, Math.max(0, x ?? cx)), y: Math.min(1, Math.max(0, y ?? cy)) };
      this.layout();
      this.zoomBadge();
    };
    this.zoomBadge = () => {
      const z = this.zoomZ();
      label.textContent = `${Math.round(z * 100)}%`;
      out.disabled = !this.ownZoom;
      fit.hidden = !this.ownZoom;
      this.inkCanvas.classList.toggle("grab", !!this.ownZoom);
    };
    out.onclick = () => set(this.zoomZ() / 1.5);
    fit.onclick = () => set(1);
    this.area.append(h("div", { class: "viewer-zoom", title: "내 화면만 크게 보기 (선생님 화면에는 영향 없어요)" },
      h("button", { type: "button", title: "확대", onclick: () => set(this.zoomZ() * 1.5) }, "＋"), out, label, fit));
    this.zoomBadge();
    const c = this.inkCanvas;
    let drag = null;
    c.addEventListener("pointerdown", (e) => {
      if (!this.ownZoom) return;
      if (this.opt.mayDraw?.() && this.tool.kind !== "pan") return; // 쓰는 중이면 끌어서 옮기지 않는다
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const [x0, y0] = this.zoomXY();
      drag = { sx: e.clientX, sy: e.clientY, x0, y0 };
    });
    c.addEventListener("pointermove", (e) => {
      if (!drag || !this.ownZoom) return;
      this.ownZoom.x = Math.min(1, Math.max(0, drag.x0 - (e.clientX - drag.sx) / this.sheet.offsetWidth));
      this.ownZoom.y = Math.min(1, Math.max(0, drag.y0 - (e.clientY - drag.sy) / this.sheet.offsetHeight));
      this.place();
    });
    const end = () => { drag = null; };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = c.getBoundingClientRect();
      set(this.zoomZ() * (e.deltaY < 0 ? 1.2 : 1 / 1.2), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    }, { passive: false });
  }

  undo() {
    const key = this.key;
    const mine = this.mine.get(key) || [];
    const have = new Set((this.strokes.get(key) || []).map((s) => s.id));
    while (mine.length && !have.has(mine[mine.length - 1])) mine.pop(); // 지우개로 이미 지운 획은 건너뛴다
    const id = mine.pop();
    if (!id) return;
    this.removeStrokes(key, [id]);
    this.opt.send({ t: "stroke_del", key, ids: [id] });
  }

  clear() {
    if (!this.key) return;
    this.strokes.set(this.key, []);
    this.redrawInk();
    this.opt.send({ t: "board_clear", key: this.key });
  }

  /** 서버에서 온 판서 메시지 처리 */
  onMessage(msg) {
    if (msg.t === "strokes") this.setStrokes(msg.key, msg.strokes);
    else if (msg.t === "stroke") this.addPoints(msg);
    else if (msg.t === "stroke_del") this.removeStrokes(msg.key, msg.ids);
  }
}
