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
  }

  get key() { return this.view?.key || null; }

  /** 서버 상태가 바뀔 때마다 부른다 */
  async setView(view) {
    const prev = this.view;
    this.view = view;
    if (!view) { this.pageSize = null; return; }
    if (prev && prev.key === view.key && prev.pages === view.pages) return;
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
    w = Math.floor(w); hh = Math.floor(hh);
    this.sheet.style.width = `${w}px`;
    this.sheet.style.height = `${hh}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [this.pageCanvas, this.inkCanvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
    }
    this.dpr = dpr;
    this.drawPage();
    this.redrawInk();
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
    if (!st) { st = { id: msg.id, color: msg.color, size: msg.size, hl: msg.hl, pts: [] }; list.push(st); }
    const from = Math.max(0, st.pts.length - 1);
    st.pts.push(...msg.pts);
    if (msg.key !== this.key) return;
    // 형광펜은 반투명이라 나눠 그리면 이음새가 진해진다 → 판서 전체를 다시 그린다
    if (st.hl) this.redrawInk();
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

  drawStroke(ctx, st, from) {
    const c = this.inkCanvas;
    if (!st.pts.length) return;
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
      const hit = list.filter((s) => s.pts.some((q) => Math.hypot(q[0] - p[0], (q[1] - p[1]) * (c.height / c.width)) < r + (s.size / 2000)));
      if (!hit.length) return;
      const ids = hit.map((s) => s.id);
      this.removeStrokes(this.key, ids);
      this.opt.send({ t: "stroke_del", key: this.key, ids });
    };
    c.addEventListener("pointerdown", (e) => {
      if (!this.key || e.button > 0) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      if (this.tool.kind === "eraser") { cur = { eraser: true }; erase(pos(e)); return; }
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
      if (cur.eraser) { erase(pos(e)); return; }
      const pts = (e.getCoalescedEvents?.() || [e]).map(pos);
      this.addPoints({ key: cur.key, id: cur.id, color: cur.color, size: cur.size, hl: cur.hl, pts });
      pending.push(...pts);
      if (!timer) timer = setTimeout(flushPts, 40); // 0.04초마다 모아서 보낸다
    });
    const end = () => { if (cur && !cur.eraser) { clearTimeout(timer); flushPts(); } cur = null; };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
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
