import { api } from './api.js';
import { openPdf } from './pdf.js';
import { CurlRenderer, curlFromCorner, constrainToSpine } from './curl.js';
import { esc, sheet, toast } from './ui.js';

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Reader {
  constructor(root, book, { onClose, onProgress }) {
    this.root = root;
    this.book = book;
    this.onClose = onClose;
    this.onProgress = onProgress;
    this.page = 1;
    this.cache = new Map(); // page number -> rendered canvas
    this.renderChain = Promise.resolve();
    this.queued = new Set();
    this.generation = 0;
    this.turn = null;
    this.anim = null;
    this.destroyed = false;

    this.el = {
      stage: root.querySelector('.stage'),
      canvas: root.querySelector('.curl-canvas'),
      fallback: root.querySelector('.fallback-page'),
      loading: root.querySelector('.reader-loading'),
      title: root.querySelector('.reader-title'),
      scrubber: root.querySelector('.scrubber'),
      label: root.querySelector('.page-label'),
      layoutBtn: root.querySelector('[data-action="layout"]'),
    };
    this.spread = false;
    try { this.layoutPref = localStorage.getItem('bindr:layout'); } catch { this.layoutPref = null; }
    this.el.title.textContent = book.title;
  }

  async open(startPage) {
    try {
      this.renderer = new CurlRenderer(this.el.canvas);
    } catch (e) {
      console.warn('Falling back to flat page view:', e);
      this.renderer = null;
      this.el.canvas.hidden = true;
      this.el.fallback.hidden = false;
    }
    this._bind();

    let data;
    try {
      const res = await fetch(api.fileUrl(this.book.id), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status === 404 ? 'This book could not be found.' : 'Could not download this book.');
      data = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw new Error(e.message === 'Failed to fetch' ? 'This book is not available offline yet.' : e.message);
    }
    if (this.destroyed) return;
    this.doc = await openPdf(data);
    if (this.destroyed) return;
    this.numPages = this.doc.numPages;
    const first = await this.doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.aspect = vp.width / vp.height;

    this.page = Math.min(Math.max(1, startPage || 1), this.numPages);
    this.el.scrubber.max = String(this.numPages);
    this._layout();
    this._updateChrome();
    await this._render(this.page);
    if (this.destroyed) return;
    this.el.loading.hidden = true;
    this._draw();
    this._prefetch();
    this.chromeTimer = setTimeout(() => this.root.classList.add('chrome-hidden'), 2200);
    if (this.book.pageCount !== this.numPages) this.onProgress?.(this.page, this.numPages);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.chromeTimer);
    this.resizeObserver?.disconnect();
    window.removeEventListener('keydown', this._onKey);
    this.doc?.destroy();
    this.cache.clear();
    const lose = this.renderer?.gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
  }

  // ---------------------------------------------------------------- layout
  _layout() {
    const rect = this.el.stage.getBoundingClientRect();
    const W = Math.max(1, rect.width);
    const H = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const small = W < 600;
    const mx = small ? 8 : 40;
    const my = small ? 12 : 28;
    const aspect = this.aspect || 0.7;
    // Two-page spread on landscape tablets and wide screens (unless the reader chose otherwise).
    const canSpread = !!this.renderer && W >= 700 && aspect < 1.2;
    const autoSpread = W >= 900 ? W > H * 1.05 : W > H * 1.25;
    this.spread = canSpread && (this.layoutPref === 'double' || (this.layoutPref !== 'single' && autoSpread));
    if (this.el.layoutBtn) {
      this.el.layoutBtn.hidden = !canSpread;
      this.el.layoutBtn.setAttribute('aria-pressed', String(this.spread));
      this.el.layoutBtn.title = this.spread ? 'Show one page' : 'Show two pages';
    }
    const cols = this.spread ? 2 : 1;
    let pw = (W - mx * 2) / cols;
    let ph = pw / aspect;
    if (ph > H - my * 2) { ph = H - my * 2; pw = ph * aspect; }
    const max = this.renderer?.maxTex || 4096;
    let scale = dpr;
    if (pw * scale > max || ph * scale > max) scale = Math.min(max / pw, max / ph);

    this.dpr = scale;
    // In a spread, x is the spine (the left edge of the right-hand page).
    this.css = { x: this.spread ? W / 2 : (W - pw) / 2, y: (H - ph) / 2, w: pw, h: ph };
    this.dev = {
      x: Math.round(this.css.x * scale),
      y: Math.round(this.css.y * scale),
      w: Math.round(pw * scale),
      h: Math.round(ph * scale),
    };
    if (this.renderer) {
      this.el.canvas.width = Math.round(W * scale);
      this.el.canvas.height = Math.round(H * scale);
      const bg = getComputedStyle(this.root).backgroundColor.match(/\d+(\.\d+)?/g)?.map(Number) || [239, 239, 239];
      this.renderer.setColors(bg.slice(0, 3).map((v) => v / 255), [0.985, 0.98, 0.97]);
    } else {
      Object.assign(this.el.fallback.style, {
        left: `${this.css.x}px`, top: `${this.css.y}px`, width: `${pw}px`, height: `${ph}px`,
      });
    }
  }

  _relayout() {
    if (!this.doc) return;
    if (this.turn || this.anim) { this.pendingLayout = true; return; }
    const prev = this.dev && `${this.dev.w}x${this.dev.h}`;
    const wasSpread = this.spread;
    this._layout();
    if (wasSpread !== this.spread) this._updateChrome();
    if (prev !== `${this.dev.w}x${this.dev.h}`) {
      this.generation++;
      this.cache.clear();
      this.queued.clear();
      this._render(this.page).then(() => this._draw());
    }
    this._prefetch();
    this._draw();
  }

  // ---------------------------------------------------------------- rendering
  _render(n) {
    if (n < 1 || n > this.numPages) return Promise.resolve(null);
    if (this.cache.has(n)) return Promise.resolve(this.cache.get(n));
    const gen = this.generation;
    const job = async () => {
      if (this.destroyed || gen !== this.generation) return null;
      if (this.cache.has(n)) return this.cache.get(n);
      if (!this._inWindow(n)) { this.queued.delete(n); return null; }
      const { w, h } = this.dev;
      const page = await this.doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(w / base.width, h / base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      await page.render({
        canvasContext: ctx,
        viewport,
        transform: [1, 0, 0, 1, (w - viewport.width) / 2, (h - viewport.height) / 2],
      }).promise;
      page.cleanup();
      this.queued.delete(n);
      if (this.destroyed || gen !== this.generation) return null;
      this.cache.set(n, canvas);
      this._evict();
      return canvas;
    };
    const p = this.renderChain.then(job, job);
    this.renderChain = p.catch(() => null);
    this.queued.add(n);
    return p;
  }

  /** Left/right pages of the spread containing page p. The cover sits alone on the right (L = 0). */
  _pages(p = this.page) {
    const L = p - (p % 2);
    return { L, R: L + 1 };
  }

  _exists(n) {
    return n >= 1 && n <= this.numPages;
  }

  _inWindow(n) {
    if (!this.spread) return n >= this.page - 2 && n <= this.page + 3;
    const { L, R } = this._pages();
    return n >= L - 2 && n <= R + 2;
  }

  _prefetch() {
    const { L, R } = this._pages();
    const order = this.spread ? [L, R, R + 1, R + 2, L - 1, L - 2] : [this.page, this.page + 1, this.page - 1, this.page + 2];
    for (const n of order) {
      if (n >= 1 && n <= this.numPages && !this.cache.has(n) && !this.queued.has(n)) {
        this._render(n).then(() => this._draw());
      }
    }
  }

  _evict() {
    for (const n of this.cache.keys()) if (!this._inWindow(n)) this.cache.delete(n);
  }

  _draw() {
    if (this.destroyed || !this.dev) return;
    if (!this.renderer) {
      const c = this.cache.get(this.page);
      if (c && this.el.fallback.firstChild !== c) this.el.fallback.replaceChildren(c);
      return;
    }
    const { w, h } = this.dev;
    const tex = (n) => (this._exists(n) && this.cache.get(n)) || null;
    const curl = this.turn ? curlFromCorner(this.turn.C, this.turn.F, w, h) : null;
    if (!this.spread) {
      if (this.turn) {
        const { dir } = this.turn;
        this.renderer.setTexture(0, tex(dir > 0 ? this.page : this.page - 1));
        this.renderer.setTexture(1, tex(dir > 0 ? this.page + 1 : this.page));
      } else {
        this.renderer.setTexture(1, tex(this.page));
      }
      this.renderer.draw(this.dev, curl, this.dpr);
      return;
    }
    // Two-page spread. A sheet carries an odd page on its front (right side) and the
    // following even page on its back. Turning backwards is drawn mirrored about the spine.
    const { L, R } = this._pages();
    const flip = !!this.turn && this.turn.dir < 0;
    let front = null, under = R, back = null, opposite = L;
    if (this.turn) {
      if (flip) { front = L; back = L - 1; under = L - 2; opposite = R; }
      else { front = R; back = R + 1; under = R + 2; opposite = L; }
    }
    this.renderer.setTexture(0, tex(front));
    this.renderer.setTexture(1, tex(under));
    this.renderer.setTexture(2, tex(back));
    this.renderer.setTexture(3, tex(opposite));
    this.renderer.draw(this.dev, curl, this.dpr, {
      spread: true,
      flip,
      hasUnder: this._exists(under),
      hasLeft: this._exists(opposite),
      shadowX: [this._exists(L) ? -w : 0, this._exists(R) ? w : 0],
    });
  }

  // ---------------------------------------------------------------- navigation
  _canTurn(dir) {
    if (!this.doc) return false;
    if (this.spread) {
      const { L, R } = this._pages();
      return dir > 0 ? R + 1 <= this.numPages : L >= 2;
    }
    return dir > 0 ? this.page < this.numPages : this.page > 1;
  }

  /** The page shown after turning in direction dir. */
  _afterTurn(dir) {
    if (!this.spread) return this.page + dir;
    const { L } = this._pages();
    return Math.max(1, L + 2 * dir);
  }

  /** Pages that need to be ready before a turn in direction dir can be drawn. */
  _turnPages(dir) {
    if (!this.spread) return [dir > 0 ? this.page + 1 : this.page - 1];
    const { L, R } = this._pages();
    return dir > 0 ? [R + 1, R + 2] : [L - 1, L - 2];
  }

  _beginTurn(dir, startY) {
    const { w, h } = this.dev;
    // Grab a corner when near the top/bottom, otherwise the right edge.
    let cy = startY;
    if (startY < h * 0.2) cy = 0;
    else if (startY > h * 0.8) cy = h;
    const C = [w, cy];
    const turned = [-w, cy];
    // In a spread both directions lift the outer edge of a page (backwards is mirrored);
    // on a single page, turning back pulls the previous page in from the left.
    const fromC = this.spread || dir > 0;
    this.turn = { dir, C, turned, F: fromC ? [...C] : [...turned] };
    for (const n of this._turnPages(dir)) this._render(n).then(() => this._draw());
  }

  _setF(F) {
    const { w, h } = this.dev;
    this.turn.F = constrainToSpine(this.turn.C, F, w, h);
    this._draw();
  }

  _animateTo(target, duration, ease, commit, lift = 0) {
    const from = [...this.turn.F];
    const start = performance.now();
    const h = this.dev.h;
    return new Promise((resolve) => {
      this.anim = { resolve };
      const step = (now) => {
        if (this.destroyed) return resolve();
        const t = Math.min(1, (now - start) / duration);
        const e = ease(t);
        const F = [from[0] + (target[0] - from[0]) * e, from[1] + (target[1] - from[1]) * e - Math.sin(Math.PI * e) * lift * h];
        this._setF(F);
        if (t < 1) {
          this.raf = requestAnimationFrame(step);
        } else {
          this.anim = null;
          const dir = this.turn.dir;
          this.turn = null;
          if (commit) this._goto(this._afterTurn(dir), true);
          else this._draw();
          if (this.pendingLayout) { this.pendingLayout = false; this._relayout(); }
          resolve();
        }
      };
      this.raf = requestAnimationFrame(step);
    });
  }

  /** Animated page turn (tap, key, wheel). */
  async turnPage(dir) {
    if (this.anim || this.turn || this.drag || !this._canTurn(dir)) return;
    if (!this.renderer) return this._goto(this.page + dir);
    this._beginTurn(dir, this.dev.h * 0.62);
    await Promise.all(this._turnPages(dir).map((n) => this._render(n)));
    const target = this.spread || dir > 0 ? this.turn.turned : this.turn.C;
    await this._animateTo(target, 620, easeInOut, true, dir > 0 ? 0.07 : -0.07);
  }

  _goto(n, fromTurn = false) {
    n = Math.min(Math.max(1, n), this.numPages);
    this.page = n;
    this._updateChrome();
    this._evict();
    if (this.cache.has(n)) this._draw();
    else this._render(n).then(() => this._draw());
    if (!fromTurn) this._draw();
    this._prefetch();
    this.onProgress?.(this.page, this.numPages);
  }

  _updateChrome() {
    this.el.scrubber.value = String(this.page);
    let shown = String(this.page);
    let last = this.page;
    if (this.spread) {
      const { L, R } = this._pages();
      const a = Math.max(L, 1);
      last = Math.min(R, this.numPages);
      shown = a === last ? String(a) : `${a}–${last}`;
    }
    const left = this.numPages - last;
    this.el.label.textContent = `${shown} of ${this.numPages}` + (left > 0 ? ` · ${left} page${left === 1 ? '' : 's'} left` : '');
  }

  _toggleLayout() {
    if (this.turn || this.anim) return;
    this.layoutPref = this.spread ? 'single' : 'double';
    try { localStorage.setItem('bindr:layout', this.layoutPref); } catch {}
    this._relayout();
  }

  _toggleChrome(force) {
    clearTimeout(this.chromeTimer);
    this.root.classList.toggle('chrome-hidden', force);
  }

  // ---------------------------------------------------------------- input
  _bind() {
    const stage = this.el.stage;
    this.resizeObserver = new ResizeObserver(() => this._relayout());
    this.resizeObserver.observe(stage);

    this.root.querySelector('[data-action="close"]').onclick = () => this.onClose?.();
    this.root.querySelector('[data-action="goto"]').onclick = () => this._askPage();
    if (this.el.layoutBtn) this.el.layoutBtn.onclick = () => this._toggleLayout();
    this.el.scrubber.addEventListener('input', () => {
      this.el.label.textContent = `Page ${this.el.scrubber.value} of ${this.numPages}`;
    });
    this.el.scrubber.addEventListener('change', () => {
      if (!this.turn) this._goto(parseInt(this.el.scrubber.value, 10));
    });

    this._onKey = (e) => {
      if (document.querySelector('.sheet-backdrop') || e.target.closest?.('input')) return;
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); this.turnPage(1); }
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); this.turnPage(-1); }
      else if (e.key === 'Home') this._goto(1);
      else if (e.key === 'End') this._goto(this.numPages);
      else if (e.key === 'Escape') this.onClose?.();
    };
    window.addEventListener('keydown', this._onKey);

    let wheelLock = 0;
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const now = Date.now();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (now < wheelLock || Math.abs(delta) < 12) return;
      wheelLock = now + 450;
      this.turnPage(delta > 0 ? 1 : -1);
    }, { passive: false });

    stage.addEventListener('pointerdown', (e) => this._down(e));
    stage.addEventListener('pointermove', (e) => this._move(e));
    stage.addEventListener('pointerup', (e) => this._up(e));
    stage.addEventListener('pointercancel', (e) => this._up(e, true));
  }

  _local(e) {
    const r = this.el.stage.getBoundingClientRect();
    return [(e.clientX - r.left - this.css.x) * this.dpr, (e.clientY - r.top - this.css.y) * this.dpr];
  }

  _down(e) {
    if (!this.doc || this.drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (this.anim) return; // let the running turn finish
    this.el.stage.setPointerCapture(e.pointerId);
    const p = this._local(e);
    this.drag = { id: e.pointerId, start: p, last: p, t0: performance.now(), samples: [[performance.now(), p[0]]], active: false };
  }

  _move(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const p = this._local(e);
    d.last = p;
    const now = performance.now();
    d.samples.push([now, p[0]]);
    while (d.samples.length > 2 && now - d.samples[0][0] > 100) d.samples.shift();
    const dx = p[0] - d.start[0];
    const dy = p[1] - d.start[1];
    if (!d.active) {
      if (Math.hypot(dx, dy) < 8 * this.dpr || Math.abs(dx) < Math.abs(dy) * 0.8) return;
      const dir = dx < 0 ? 1 : -1;
      if (!this._canTurn(dir) || !this.renderer) { d.dead = true; return; }
      if (d.dead) return;
      d.active = true;
      this._beginTurn(dir, Math.min(Math.max(d.start[1], 0), this.dev.h));
      this._toggleChrome(true);
    }
    const { C, turned, dir } = this.turn;
    if (this.spread) this._setF([C[0] + (dir > 0 ? dx : -dx), C[1] + dy]); // mirrored when turning back
    else if (dir > 0) this._setF([C[0] + dx, C[1] + dy]);
    else this._setF([turned[0] + dx * 2, turned[1] + dy]);
  }

  _up(e, cancelled = false) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (!d.active) {
      if (cancelled || d.dead) return;
      const moved = Math.hypot(d.last[0] - d.start[0], d.last[1] - d.start[1]);
      if (moved < 10 * this.dpr && performance.now() - d.t0 < 500) this._tap(d.start);
      return;
    }
    const s = d.samples;
    const dt = s[s.length - 1][0] - s[0][0];
    const stale = performance.now() - s[s.length - 1][0] > 90; // finger rested before lifting
    const vx = dt > 0 && !stale ? (s[s.length - 1][1] - s[0][1]) / dt / this.dpr : 0; // css px per ms
    const { dir, F, C, turned } = this.turn;
    const { w } = this.dev;
    let commit;
    let target;
    if (this.spread) {
      const v = dir > 0 ? vx : -vx; // velocity in the sheet's own (possibly mirrored) frame
      commit = !cancelled && (v < -0.25 || (v < 0.25 && F[0] < w * 0.35));
      target = commit ? turned : C;
    } else {
      if (cancelled) commit = false;
      else if (dir > 0) commit = vx < -0.25 || (vx < 0.25 && F[0] < w * 0.55);
      else commit = vx > 0.25 || (vx > -0.25 && F[0] > -w * 0.15);
      target = (dir > 0) === commit ? turned : C;
    }
    const dist = Math.hypot(target[0] - F[0], target[1] - F[1]);
    const duration = Math.min(480, Math.max(160, (dist / (2 * w)) * 520));
    this._animateTo(target, duration, easeOutCubic, commit);
  }

  _tap([x]) {
    const { w } = this.dev;
    if (this.spread) {
      // x is measured from the spine: tap the outer half of either page to turn.
      if (x > w * 0.5) this.turnPage(1);
      else if (x < -w * 0.5) this.turnPage(-1);
      else this._toggleChrome();
      return;
    }
    if (x > w * 0.68) this.turnPage(1);
    else if (x < w * 0.32) this.turnPage(-1);
    else this._toggleChrome();
  }

  async _askPage() {
    const n = await sheet(
      `<h3>Go to Page</h3><p class="sub">${esc(this.book.title)} · ${this.numPages} pages</p>
       <form><label class="field"><span>Page number</span>
       <input name="page" type="number" inputmode="numeric" min="1" max="${this.numPages}" value="${this.page}" autofocus></label>
       <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Go</button></div></form>`,
      (el, close) => {
        el.querySelector('[data-cancel]').onclick = () => close();
        el.querySelector('form').onsubmit = (ev) => {
          ev.preventDefault();
          close(parseInt(el.querySelector('input').value, 10));
        };
      },
    );
    if (Number.isFinite(n)) {
      if (n < 1 || n > this.numPages) toast(`Choose a page between 1 and ${this.numPages}.`);
      else this._goto(n);
    }
  }
}
