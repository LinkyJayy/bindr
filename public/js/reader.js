import { api } from './api.js';
import { openBook } from './docs.js';
import { CurlRenderer, curlFromCorner, constrainToSpine } from './curl.js';
import { Narrator } from './narrator.js';
import { FilterPanel, toGL, isIdentity, applyAppFilter } from './filters.js';
import { DARK_BG } from './darkpage.js';
import { Highlights, showDefinition } from './highlights.js';
import { esc, sheet, menu, toast } from './ui.js';

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Reader {
  constructor(root, book, { onClose, onProgress, onPageTheme, onRate, onChapters, onFilter }) {
    this.root = root;
    this.book = book;
    this.onClose = onClose;
    this.onProgress = onProgress;
    this.onPageTheme = onPageTheme;
    this.onRate = onRate;
    this.onChapters = onChapters;
    this.onFilter = onFilter;
    const pref = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
    this.turnMode = pref('bindr:turn', 'curl');                 // 'curl' | 'slide' | 'instant'
    this.fontSize = Number(pref('bindr:font-size', '19')) || 19; // ePUB text size (px)
    this.statusMode = pref('bindr:status-mode', 'chapter');      // 'chapter' | 'book'
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
      displayBtn: root.querySelector('[data-action="display"]'),
      display: root.querySelector('.display-panel'),
      status: root.querySelector('.reader-status'),
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
    // Dark pages are a per-book setting, saved with the book in your account.
    this.darkPages = this.book.pageTheme === 'dark';
    this._bindDisplay();
    this._syncDark();
    this.filterPanel = new FilterPanel(
      this.el.display.querySelector('.fp-embed'),
      this.el.displayBtn,
      (t) => this._applyFilter(t),
      { embedded: true },
    );
    this._applyFilter(this.filterPanel.transform);

    let data;
    try {
      const res = await fetch(api.fileUrl(this.book.id), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status === 404 ? 'This book could not be found.' : 'Could not download this book.');
      data = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      throw new Error(e.message === 'Failed to fetch' ? 'This book is not available offline yet.' : e.message);
    }
    if (this.destroyed) return;
    this.doc = await openBook(this.book.format, data);
    if (this.destroyed) return;
    this.root.classList.toggle('reflowable', !!this.doc.reflowable);
    this.aspect = this.doc.aspect;
    this._layout();
    if (this.doc.reflowable) {
      this.doc.layout(this.css.w, this.css.h, { fontSize: this.fontSize });
      this.numPages = this.doc.numPages;
      this.page = this.doc.pageForOffset(this.book.location || 0);
    } else {
      this.numPages = this.doc.numPages;
      this.page = Math.min(Math.max(1, startPage || 1), this.numPages);
    }
    this.el.scrubber.max = String(this.numPages);
    this.outline = await this.doc.outline();
    this._resolveChapters();
    this._syncDisplay();
    this._updateChrome();
    this.hl = new Highlights(this);
    this.hl.load();
    await this._render(this.page);
    if (this.destroyed) return;
    this.el.loading.hidden = true;
    this._draw();
    this._prefetch();
    if (Narrator.supported) this.narrator = new Narrator(this, this.root);
    this.chromeTimer = setTimeout(() => this.root.classList.add('chrome-hidden'), 2200);
    if (this.book.pageCount !== this.numPages) this.onProgress?.(this.page, this.numPages);
  }

  destroy() {
    this.destroyed = true;
    this.narrator?.destroy();
    this.hl?.hidePopup();
    cancelAnimationFrame(this.raf);
    clearTimeout(this.chromeTimer);
    clearTimeout(this.tapTimer);
    this.resizeObserver?.disconnect();
    window.removeEventListener('keydown', this._onKey);
    this.doc?.destroy();
    this.cache.clear();
    const lose = this.renderer?.gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
  }

  // ---------------------------------------------------------------- dark pages
  /** Dark mode for every book: recolors page background and text, never images. */
  setDarkPages(on) {
    if (on === this.darkPages) return;
    this.darkPages = on;
    this.book.pageTheme = on ? 'dark' : 'light';
    this.onPageTheme?.(this.book.pageTheme);
    this._syncDark();
    if (!this.doc) return;
    // Re-render; the current pages stay on screen until their replacements are ready.
    this.generation++;
    this.queued.clear();
    for (const n of this.visiblePages()) this._render(n).then(() => this._draw());
    this._prefetch();
  }

  _syncDark() {
    this.root.classList.toggle('book-dark', this.darkPages);
    this._syncDisplay();
    if (this.renderer && this.dev) this._layout(); // picks up the new background colors
    this._draw();
  }

  /** Cached render of page n in the current mode, if any. */
  _fresh(n) {
    const c = this.cache.get(n);
    return c && c.__dark === this.darkPages ? c : null;
  }

  // ---------------------------------------------------------------- color filter
  _applyFilter(t) {
    // The rest of the app is filtered by applyAppFilter(); pages are filtered here.
    applyAppFilter(this.filterPanel?.setting);
    if (this.renderer) {
      const g = toGL(t);
      this.renderer.setFilter(g.m, g.o);
      this._draw();
      return;
    }
    // No WebGL: the shared SVG color matrix on the flat page does the same job.
    this.el.fallback.style.filter = isIdentity(t) ? '' : 'url(#bindr-cm)';
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
    const reflow = !!this.doc?.reflowable;
    const statusH = 24; // room for the page status line at the bottom
    let aspect = this.aspect || 0.7;
    // Two-page spread on landscape tablets and wide screens (unless the reader chose otherwise).
    const canSpread = !!this.renderer && W >= 700 && (reflow || aspect < 1.2);
    const autoSpread = W >= 900 ? W > H * 1.05 : W > H * 1.25;
    this.spread = canSpread && (this.layoutPref === 'double' || (this.layoutPref !== 'single' && autoSpread));
    this.canSpread = canSpread;
    this._syncDisplay();
    let pw;
    let ph;
    if (reflow) {
      // ePUB pages fill the screen like an e-reader; the text reflows to fit.
      const m = W < 600 ? 0 : 16;
      const avail = H - statusH - m * 2;
      pw = this.spread ? Math.min((W - m * 2) / 2, 640) : Math.min(W - m * 2, Math.max(560, avail * 0.75));
      ph = avail;
      aspect = pw / ph;
    } else if (this.zoom) {
      // Zoomed in (double-tap): fill the width and scroll vertically.
      pw = this.spread ? W / 2 : W;
      ph = pw / aspect;
    } else if (this.spread) {
      // As large as possible while the whole spread stays on screen, with a slim margin.
      // (If a forced spread is ever taller than the screen, it scrolls vertically.)
      const m = 10;
      pw = (W - m * 2) / 2;
      ph = pw / aspect;
      if (ph > H - statusH - m * 2) { ph = H - statusH - m * 2; pw = ph * aspect; }
    } else {
      pw = W - mx * 2;
      ph = pw / aspect;
      if (ph > H - statusH - my * 2) { ph = H - statusH - my * 2; pw = ph * aspect; }
    }
    this.statusH = statusH;
    const max = this.renderer?.maxTex || 4096;
    let scale = dpr;
    if (pw * scale > max || ph * scale > max) scale = Math.min(max / pw, max / ph);
    // Keep each page texture to a sensible size (several are cached at once).
    scale = Math.min(scale, Math.max(1, Math.sqrt(4.5e6 / (pw * ph))));

    this.dpr = scale;
    this.stageH = H;
    this.overflow = Math.max(0, ph - H);
    this.scrollY = Math.min(this.scrollY || 0, this.overflow);
    // In a spread, x is the spine (the left edge of the right-hand page).
    this.css = { x: this.spread ? W / 2 : (W - pw) / 2, y: 0, w: pw, h: ph };
    this.dev = {
      x: Math.round(this.css.x * scale),
      y: 0,
      w: Math.round(pw * scale),
      h: Math.round(ph * scale),
    };
    this._applyScroll();
    if (this.renderer) {
      this.el.canvas.width = Math.round(W * scale);
      this.el.canvas.height = Math.round(H * scale);
      const bg = getComputedStyle(this.root).backgroundColor.match(/\d+(\.\d+)?/g)?.map(Number) || [239, 239, 239];
      const paper = this.darkPages ? DARK_BG.map((v) => v / 255) : [0.985, 0.98, 0.97];
      this.renderer.setColors(bg.slice(0, 3).map((v) => v / 255), paper);
    } else {
      Object.assign(this.el.fallback.style, { left: `${this.css.x}px`, width: `${pw}px`, height: `${ph}px` });
    }
  }

  /** Vertical position of the page(s): centred, or scrolled when taller than the screen. */
  _applyScroll() {
    this.css.y = this.overflow > 0 ? -this.scrollY : (this.stageH - (this.statusH || 0) - this.css.h) / 2;
    this.dev.y = Math.round(this.css.y * this.dpr);
    if (!this.renderer) this.el.fallback.style.top = `${this.css.y}px`;
  }

  /** Scroll by dy css px. Returns false when there's nothing to scroll. */
  scrollBy(dy) {
    if (!this.overflow) return false;
    const y = Math.min(this.overflow, Math.max(0, this.scrollY + dy));
    if (y !== this.scrollY) {
      this.scrollY = y;
      this._applyScroll();
      this._draw();
    }
    return true;
  }

  /** Scroll so that the css-px range [top, bottom] (relative to the page top) is on screen. */
  scrollIntoView(top, bottom) {
    if (!this.overflow || this.turn) return;
    const margin = 90;
    const viewTop = this.scrollY + margin;
    const viewBottom = this.scrollY + this.stageH - margin;
    if (top < viewTop) this.scrollBy(top - viewTop);
    else if (bottom > viewBottom) this.scrollBy(Math.min(bottom - viewBottom, top - viewTop));
  }

  _relayout() {
    if (!this.doc) return;
    if (this.turn || this.anim) { this.pendingLayout = true; return; }
    const prev = this.dev && `${this.dev.w}x${this.dev.h}`;
    const wasSpread = this.spread;
    const loc = this.doc.reflowable ? this.doc.pageStart(this.visiblePages()[0] || this.page) : 0;
    this._layout();
    const repaginated = this.doc.reflowable && this._paginate(loc);
    if (wasSpread !== this.spread || repaginated) this._updateChrome();
    if (repaginated || prev !== `${this.dev.w}x${this.dev.h}`) {
      this.generation++;
      this.cache.clear();
      this.queued.clear();
      this._render(this.page).then(() => this._draw());
    }
    this._prefetch();
    this._draw();
  }

  /** Re-paginate a reflowable book, keeping the reader at text offset `loc`. */
  _paginate(loc) {
    if (!this.doc.layout(this.css.w, this.css.h, { fontSize: this.fontSize })) return false;
    this.numPages = this.doc.numPages;
    this.el.scrubber.max = String(this.numPages);
    this.page = this.doc.pageForOffset(loc);
    this.narrator?.texts.clear();
    this.hl?.reset();
    this._resolveChapters();
    this.onProgress?.(this.page, this.numPages, this.doc.pageStart(this.page));
    return true;
  }

  /** Where page n's content sits on screen: page-unit origin (css px) and scale. */
  pageGeom(n, data) {
    const { css } = this;
    const left = this.spread && n % 2 === 0 ? css.x - css.w : css.x;
    const s = Math.min(css.w / data.w, css.h / data.h);
    return { ox: left + (css.w - data.w * s) / 2, oy: (css.h - data.h * s) / 2, s };
  }

  // ---------------------------------------------------------------- rendering
  _render(n) {
    if (n < 1 || n > this.numPages) return Promise.resolve(null);
    if (this._fresh(n)) return Promise.resolve(this._fresh(n));
    const gen = this.generation;
    const dark = this.darkPages;
    const job = async () => {
      if (this.destroyed || gen !== this.generation) return null;
      if (this._fresh(n)) return this._fresh(n);
      if (!this._inWindow(n)) { this.queued.delete(n); return null; }
      const { w, h } = this.dev;
      let canvas;
      try {
        canvas = await this.doc.renderPage(n, w, h, { dark });
      } catch (e) {
        // Closing the book (or re-laying it out) cancels renders that are in flight.
        this.queued.delete(n);
        if (!this.destroyed && e?.name !== 'RenderingCancelledException') console.warn('Could not render page', n, e);
        return null;
      }
      canvas.__dark = dark;
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

  /** Pages currently on screen, in reading order. */
  visiblePages() {
    if (!this.spread) return [this.page];
    const { L, R } = this._pages();
    return [L, R].filter((n) => this._exists(n));
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
      if (n >= 1 && n <= this.numPages && !this._fresh(n) && !this.queued.has(n)) {
        this._render(n).then(() => this._draw());
      }
    }
  }

  _evict() {
    for (const n of this.cache.keys()) if (!this._inWindow(n)) this.cache.delete(n);
  }

  _draw() {
    if (this.destroyed || !this.dev) return;
    this.narrator?.updateHighlight();
    this.hl?.update();
    if (!this.renderer) {
      const c = this.cache.get(this.page);
      if (c && this.el.fallback.firstChild !== c) this.el.fallback.replaceChildren(c);
      return;
    }
    const { w, h } = this.dev;
    const tex = (n) => (this._exists(n) && this.cache.get(n)) || null;
    if (this.turn?.mode === 'slide') return this._drawSlide(tex);
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

  _drawSlide(tex) {
    const { w } = this.dev;
    const { dir, p, period } = this.turn;
    let A;
    let B;
    if (this.spread) {
      const { L, R } = this._pages();
      A = [L, R];
      B = dir > 0 ? [R + 1, R + 2] : [L - 2, L - 1];
    } else {
      A = [null, this.page];
      B = [null, this.page + dir];
    }
    const has = [A[0], A[1], B[0], B[1]].map((n) => n !== null && this._exists(n));
    this.renderer.setTexture(3, has[0] ? tex(A[0]) : null);
    this.renderer.setTexture(1, has[1] ? tex(A[1]) : null);
    this.renderer.setTexture(0, has[2] ? tex(B[0]) : null);
    this.renderer.setTexture(2, has[3] ? tex(B[1]) : null);
    const ext = (l, r) => [l ? -w : 0, r ? w : 0];
    this.renderer.draw(this.dev, null, this.dpr, {
      spread: this.spread,
      mode: 'slide',
      shift: -dir * p,
      bpos: dir * period,
      has,
      shadowX: ext(has[0], has[1]),
      shadowXB: ext(has[2], has[3]),
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
    this.turn = { mode: 'curl', dir, C, turned, F: fromC ? [...C] : [...turned] };
    for (const n of this._turnPages(dir)) this._render(n).then(() => this._draw());
  }

  _beginSlide(dir) {
    const period = (this.spread ? this.dev.w * 2 : this.dev.w) + Math.round(28 * this.dpr);
    this.turn = { mode: 'slide', dir, p: 0, period };
    for (const n of this._turnPages(dir)) this._render(n).then(() => this._draw());
  }

  _animateSlide(target, duration, ease, commit) {
    const from = this.turn.p;
    const start = performance.now();
    return new Promise((resolve) => {
      this.anim = { resolve };
      const step = (now) => {
        if (this.destroyed) return resolve();
        const t = Math.min(1, (now - start) / duration);
        this.turn.p = from + (target - from) * ease(t);
        this._draw();
        if (t < 1) { this.raf = requestAnimationFrame(step); return; }
        this.anim = null;
        const dir = this.turn.dir;
        this.turn = null;
        if (commit) this._goto(this._afterTurn(dir), true);
        else this._draw();
        if (this.pendingLayout) { this.pendingLayout = false; this._relayout(); }
        resolve();
      };
      this.raf = requestAnimationFrame(step);
    });
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
    this.hl?.hidePopup();
    this.hl?.clearSelection();
    if (!this.renderer || this.turnMode === 'instant') return this._goto(this._afterTurn(dir));
    if (this.turnMode === 'slide') {
      this._beginSlide(dir);
      await Promise.all(this._turnPages(dir).map((n) => this._render(n)));
      await this._animateSlide(this.turn.period, 380, easeInOut, true);
      return;
    }
    this._beginTurn(dir, this.dev.h * 0.62);
    await Promise.all(this._turnPages(dir).map((n) => this._render(n)));
    const target = this.spread || dir > 0 ? this.turn.turned : this.turn.C;
    await this._animateTo(target, 620, easeInOut, true, dir > 0 ? 0.07 : -0.07);
  }

  _goto(n, fromTurn = false) {
    n = Math.min(Math.max(1, n), this.numPages);
    const changed = n !== this.page;
    this.page = n;
    if (changed && this.overflow) { this.scrollY = 0; this._applyScroll(); }
    if (changed) this.narrator?.pageChanged();
    this._updateChrome();
    this._evict();
    if (this._fresh(n)) this._draw();
    else this._render(n).then(() => this._draw());
    if (!fromTurn) this._draw();
    this._prefetch();
    this.onProgress?.(this.page, this.numPages, this.doc?.reflowable ? this.doc.pageStart(this.page) : null);
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
    this._updateStatus(shown, last);
  }

  // ---------------------------------------------------------------- status line & chapters
  /** Bottom-right: current page and pages left in the chapter (or book). Tap to switch. */
  _updateStatus(shown = String(this.page), last = this.page) {
    const el = this.el.status;
    if (!el || !this.numPages) return;
    const pl = (n) => `${n} page${n === 1 ? '' : 's'}`;
    const bookLeft = Math.max(0, this.numPages - last);
    const ch = this.chapterAt(last);
    let tail;
    if (this.statusMode === 'chapter' && ch) {
      const left = Math.max(0, ch.end - last);
      tail = left ? `${pl(left)} left in chapter` : 'Last page of chapter';
    } else {
      tail = bookLeft ? `${pl(bookLeft)} left in book` : 'Last page';
    }
    el.textContent = `Page ${shown} of ${this.numPages} · ${tail}`;
    el.title = ch ? `${ch.title} · tap to switch` : 'Add chapters from the ⋮ menu';
  }

  /** Built-in chapters (table of contents) plus the ones the reader added, with page ranges. */
  _resolveChapters() {
    const custom = (this.book.chapters || []).map((c) => ({
      title: c.title,
      page: this.doc?.reflowable && Number.isFinite(c.loc) ? this.doc.pageForOffset(c.loc) : c.page,
      loc: c.loc,
      custom: true,
    }));
    const builtIn = (this.outline || []).filter((c) => (c.depth || 0) === 0 || (this.outline.length < 60 && c.depth <= 1));
    const all = [...builtIn, ...custom].filter((c) => c.page >= 1 && c.page <= this.numPages).sort((a, b) => a.page - b.page);
    all.forEach((c, i) => {
      let next = this.numPages + 1;
      for (let k = i + 1; k < all.length; k++) if (all[k].page > c.page) { next = all[k].page; break; }
      c.end = next - 1;
    });
    this.chapters = all;
  }

  chapterAt(page) {
    let found = null;
    for (const c of this.chapters || []) if (c.page <= page) found = c;
    return found;
  }

  async _chaptersSheet() {
    const cur = this.chapterAt(this.visiblePages().slice(-1)[0] || this.page);
    const list = this.chapters || [];
    const res = await sheet(
      `<h3>Chapters</h3><p class="sub">${list.length ? 'Tap a chapter to go there.' : 'This book has no chapters yet. Add your own so Bindr can show how many pages are left in each one.'}</p>
       <div class="ch-list">${list.map((c, i) => `
         <div class="ch-item ${c === cur ? 'current' : ''}">
           <button class="ch-go" data-go="${c.page}"><span>${esc(c.title)}</span><small>${c.custom ? 'Yours · ' : ''}page ${c.page}</small></button>
           ${c.custom ? `<button class="icon-btn" data-del="${i}" aria-label="Remove chapter">
             <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg></button>` : ''}
         </div>`).join('')}</div>
       <form class="ch-add">
         <label class="field"><span>New chapter starting on page ${this.visiblePages()[0] || this.page}</span>
           <input name="title" maxlength="200" placeholder="Chapter title" required></label>
         <div class="actions"><button type="button" class="btn" data-close>Close</button><button class="btn primary">Add Chapter</button></div>
       </form>`,
      (el, close) => {
        el.querySelector('[data-close]').onclick = () => close();
        el.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => close({ go: +b.dataset.go })));
        el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => close({ del: list[+b.dataset.del] })));
        el.querySelector('form').onsubmit = (e) => { e.preventDefault(); close({ add: e.target.title.value.trim() }); };
      },
    );
    if (!res) return;
    if (res.go) { this._goto(res.go); return; }
    let custom = [...(this.book.chapters || [])];
    if (res.add) {
      const page = this.visiblePages()[0] || this.page;
      custom.push({ title: res.add, page, ...(this.doc.reflowable ? { loc: this.doc.pageStart(page) } : {}) });
    }
    if (res.del) custom = custom.filter((c) => !(c.title === res.del.title && (c.loc ?? c.page) === (res.del.loc ?? res.del.page)));
    this.book.chapters = custom;
    this._resolveChapters();
    this._updateChrome();
    this.onChapters?.(custom);
    if (res.add) this._chaptersSheet();
  }

  // ---------------------------------------------------------------- display panel ("Aa")
  _bindDisplay() {
    const panel = this.el.display;
    this.el.displayBtn.onclick = () => this._toggleDisplay();
    panel.querySelector('[data-close]').onclick = () => this._toggleDisplay(false);
    panel.querySelectorAll('[data-tab]').forEach((t) => (t.onclick = () => {
      panel.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === t));
      panel.querySelectorAll('[data-pane]').forEach((x) => { x.hidden = x.dataset.pane !== t.dataset.tab; });
    }));
    panel.querySelectorAll('[data-theme-opt]').forEach((b) => (b.onclick = () => this.setDarkPages(b.dataset.themeOpt === 'dark')));
    panel.querySelectorAll('[data-layout-opt]').forEach((b) => (b.onclick = () => {
      if (this.turn || this.anim || b.disabled) return;
      const v = b.dataset.layoutOpt;
      this.layoutPref = v === 'auto' ? null : v;
      try {
        if (this.layoutPref) localStorage.setItem('bindr:layout', this.layoutPref);
        else localStorage.removeItem('bindr:layout');
      } catch {}
      this._relayout();
      this._syncDisplay();
    }));
    panel.querySelectorAll('[data-turn-opt]').forEach((b) => (b.onclick = () => {
      this.turnMode = b.dataset.turnOpt;
      try { localStorage.setItem('bindr:turn', this.turnMode); } catch {}
      this._syncDisplay();
    }));
    const setFont = (v) => {
      this.fontSize = Math.min(34, Math.max(13, v));
      try { localStorage.setItem('bindr:font-size', String(this.fontSize)); } catch {}
      this._syncDisplay();
      clearTimeout(this.fontTimer);
      this.fontTimer = setTimeout(() => this._relayout(), 120);
    };
    panel.querySelector('[data-font="down"]').onclick = () => setFont(this.fontSize - 1);
    panel.querySelector('[data-font="up"]').onclick = () => setFont(this.fontSize + 1);
    panel.querySelector('.font-range').oninput = (e) => setFont(Number(e.target.value));
    panel.querySelectorAll('[data-zoom-opt]').forEach((b) => (b.onclick = () => {
      if ((b.dataset.zoomOpt === 'width') !== !!this.zoom) this.toggleZoom();
      this._syncDisplay();
    }));
  }

  _toggleDisplay(open = this.el.display.hidden) {
    if (open) clearTimeout(this.chromeTimer); // don't auto-hide the toolbars while it's open
    this.el.display.hidden = !open;
    this.el.displayBtn.setAttribute('aria-pressed', String(open));
    if (open) this._syncDisplay();
  }

  _syncDisplay() {
    const panel = this.el.display;
    if (!panel) return;
    const mark = (sel, on) => panel.querySelectorAll(sel).forEach((b) => {
      const active = on(b);
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    });
    mark('[data-theme-opt]', (b) => (b.dataset.themeOpt === 'dark') === !!this.darkPages);
    mark('[data-layout-opt]', (b) => b.dataset.layoutOpt === (this.layoutPref || 'auto'));
    mark('[data-zoom-opt]', (b) => (b.dataset.zoomOpt === 'width') === !!this.zoom);
    mark('[data-turn-opt]', (b) => b.dataset.turnOpt === this.turnMode);
    const reflow = !!this.doc?.reflowable;
    panel.querySelector('.font-controls').hidden = !reflow;
    panel.querySelector('.font-pdf-note').hidden = reflow;
    panel.querySelector('.zoom-section').hidden = reflow;
    panel.querySelector('.font-value').textContent = `${this.fontSize}px`;
    panel.querySelector('.font-range').value = String(this.fontSize);
    panel.querySelector('.font-sample').style.fontSize = `${this.fontSize}px`;
    const two = panel.querySelector('[data-layout-opt="double"]');
    two.disabled = !this.canSpread;
    panel.querySelector('.layout-note').hidden = !!this.canSpread;
  }

  async _readerMenu() {
    const choice = await menu(this.book.title, [
      { label: 'Chapters', value: 'chapters' },
      { label: `Notes & Highlights${this.hl?.list.length ? ` (${this.hl.list.length})` : ''}`, value: 'highlights' },
      { label: 'Go to Page…', value: 'goto' },
      { label: this.book.rating ? `Rate & Review (${this.book.rating.toFixed(1)} ★)` : 'Rate & Review', value: 'rate' },
      { label: this.darkPages ? 'Use Light Pages for This Book' : 'Use Dark Pages for This Book', value: 'theme' },
      { label: 'Close Book', value: 'close' },
    ]);
    if (choice === 'goto') this._askPage();
    if (choice === 'chapters') this._chaptersSheet();
    if (choice === 'highlights') this.hl?.showList();
    if (choice === 'rate') {
      const updated = await this.onRate?.(this.book);
      if (updated) Object.assign(this.book, updated);
    }
    if (choice === 'theme') this.setDarkPages(!this.darkPages);
    if (choice === 'close') this.onClose?.();
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
    this.root.querySelector('[data-action="menu"]').onclick = () => this._readerMenu();
    this.el.status.onclick = () => {
      this.statusMode = this.statusMode === 'chapter' ? 'book' : 'chapter';
      try { localStorage.setItem('bindr:status-mode', this.statusMode); } catch {}
      if (this.statusMode === 'chapter' && !this.chapters?.length) toast('No chapters yet. Add them from the ⋮ menu → Chapters.');
      this._updateChrome();
    };
    this.el.scrubber.addEventListener('input', () => {
      this.el.label.textContent = `Page ${this.el.scrubber.value} of ${this.numPages}`;
    });
    this.el.scrubber.addEventListener('change', () => {
      if (!this.turn) this._goto(parseInt(this.el.scrubber.value, 10));
    });

    this._onKey = (e) => {
      if (document.querySelector('.sheet-backdrop') || e.target.closest?.('input')) return;
      if (e.key === 'ArrowDown' && this.scrollBy(80)) e.preventDefault();
      else if (e.key === 'ArrowUp' && this.scrollBy(-80)) e.preventDefault();
      else if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); this.turnPage(1); }
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); this.turnPage(-1); }
      else if (e.key === 'Home') this._goto(1);
      else if (e.key === 'End') this._goto(this.numPages);
      else if (e.key === 'z' || e.key === 'Z') this.toggleZoom();
      else if (e.key === 'Escape') this.onClose?.();
    };
    window.addEventListener('keydown', this._onKey);

    let wheelLock = 0;
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const now = Date.now();
      const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      if (vertical && this.overflow && !this.turn) {
        this.scrollBy(e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY);
        return;
      }
      const delta = vertical ? e.deltaY : e.deltaX;
      if (now < wheelLock || Math.abs(delta) < 12) return;
      wheelLock = now + 450;
      this.turnPage(delta > 0 ? 1 : -1);
    }, { passive: false });

    // Long-press is for selecting text, not the browser's image menu.
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
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
    const d = { id: e.pointerId, start: p, last: p, t0: performance.now(), samples: [[performance.now(), p[0]]], active: false };
    this.drag = d;
    // Press and hold a word to start selecting text.
    d.pressTimer = setTimeout(async () => {
      if (this.drag !== d || d.active || d.scrolling || d.dead || !this.hl) return;
      d.selecting = 'pending';
      d.selecting = (await this.hl.beginSelect(e.clientX, e.clientY)) ? true : false;
      if (d.selecting && this.drag !== d) this.hl.endSelect(); // finger already lifted
    }, 450);
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
    if (d.selecting) {
      if (d.selecting === true) this.hl.extendSelect(e.clientX, e.clientY);
      return;
    }
    if (Math.hypot(dx, dy) >= 8 * this.dpr) clearTimeout(d.pressTimer);
    if (d.scrolling) {
      this.scrollBy(d.clientY - e.clientY);
      d.clientY = e.clientY;
      return;
    }
    if (!d.active) {
      if (Math.hypot(dx, dy) < 8 * this.dpr) return;
      if (this.overflow && Math.abs(dy) > Math.abs(dx)) {
        d.scrolling = true;
        d.clientY = e.clientY;
        this.scrollBy(-dy / this.dpr);
        return;
      }
      if (Math.abs(dx) < Math.abs(dy) * 0.8) return;
      const dir = dx < 0 ? 1 : -1;
      if (!this._canTurn(dir)) { d.dead = true; return; }
      if (d.dead) return;
      d.active = true;
      this.hl?.hidePopup();
      this.hl?.clearSelection();
      this._toggleChrome(true);
      if (!this.renderer || this.turnMode === 'instant') { d.instant = dir; return; }
      if (this.turnMode === 'slide') this._beginSlide(dir);
      else this._beginTurn(dir, Math.min(Math.max(d.start[1], 0), this.dev.h));
    }
    if (d.instant) return;
    if (this.turn.mode === 'slide') {
      this.turn.p = Math.min(this.turn.period, Math.max(0, -this.turn.dir * dx));
      this._draw();
      return;
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
    clearTimeout(d.pressTimer);
    if (d.selecting) {
      if (d.selecting === true) this.hl.endSelect();
      return;
    }
    if (!d.active) {
      if (cancelled || d.dead) return;
      const moved = Math.hypot(d.last[0] - d.start[0], d.last[1] - d.start[1]);
      if (moved < 10 * this.dpr && performance.now() - d.t0 < 450) this._tapOrDoubleTap(d.start, e.clientX, e.clientY);
      return;
    }
    if (d.instant) {
      if (!cancelled) this._goto(this._afterTurn(d.instant));
      return;
    }
    const s = d.samples;
    const dt = s[s.length - 1][0] - s[0][0];
    const stale = performance.now() - s[s.length - 1][0] > 90; // finger rested before lifting
    const vx = dt > 0 && !stale ? (s[s.length - 1][1] - s[0][1]) / dt / this.dpr : 0; // css px per ms
    if (this.turn.mode === 'slide') {
      const { dir, p, period } = this.turn;
      const v = -dir * vx; // css px/ms in the direction of travel
      const commit = !cancelled && (v > 0.25 || (v > -0.25 && p > period * 0.3));
      const target = commit ? period : 0;
      this._animateSlide(target, Math.min(380, Math.max(140, (Math.abs(target - p) / period) * 420)), easeOutCubic, commit);
      return;
    }
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

  /** Single taps wait briefly so a second tap can make it a double-tap (zoom). */
  /** Double-tap a word to look it up; double-tap anywhere else to zoom. */
  _tapOrDoubleTap(p, clientX, clientY) {
    const now = performance.now();
    const last = this.lastTap;
    if (last && now - last.t < 320 && Math.hypot(p[0] - last.p[0], p[1] - last.p[1]) < 48 * this.dpr) {
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      this.hl?.hidePopup();
      (this.hl ? this.hl.wordAt(clientX, clientY) : Promise.resolve(null)).then((word) => {
        if (word) showDefinition(word);
        else this.toggleZoom(clientY);
      });
      return;
    }
    this.lastTap = { t: now, p };
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => {
      this.lastTap = null;
      if (this.hl?.tapAt(clientX, clientY)) return; // tapped a highlight, or dismissed the pop-up
      this._tap(p);
    }, 260);
  }

  /** Toggle between fitting the whole page/spread on screen and fitting the width. */
  toggleZoom(clientY) {
    if (!this.doc || this.turn || this.anim) return;
    if (this.doc.reflowable) { toast('Use Aa → Font to make the text bigger.'); return; }
    const r = this.el.stage.getBoundingClientRect();
    const y = clientY == null ? r.height / 2 : clientY - r.top;
    const frac = Math.min(1, Math.max(0, (y - this.css.y) / this.css.h)); // keep this spot under the finger
    const before = this.css.w;
    this.zoom = !this.zoom;
    this._relayout();
    if (this.zoom && Math.abs(this.css.w - before) < 2) {
      this.zoom = false;
      this._relayout();
      toast('The page already fills the width of the screen.');
      return;
    }
    if (this.overflow) {
      this.scrollY = Math.min(this.overflow, Math.max(0, frac * this.css.h - y));
      this._applyScroll();
      this._draw();
    }
    this.root.classList.toggle('zoomed', this.zoom);
    this._syncDisplay();
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
