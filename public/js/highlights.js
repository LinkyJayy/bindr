// Highlights, notes and the dictionary, Kindle-style.
//
// Press and hold a word to select it, drag to extend the selection, then pick a
// highlight color in the pop-up. Tap a highlight to change its color, add a
// note, copy it or delete it. Double-tap a word to look it up.

import { api } from './api.js';
import { esc, sheet, confirmSheet, toast } from './ui.js';

export const HIGHLIGHT_COLORS = [
  { id: 'yellow', label: 'Yellow', css: 'rgba(255, 213, 0, .42)', dark: 'rgba(255, 213, 0, .34)' },
  { id: 'blue', label: 'Blue', css: 'rgba(80, 170, 255, .38)', dark: 'rgba(80, 170, 255, .36)' },
  { id: 'pink', label: 'Pink', css: 'rgba(255, 92, 170, .34)', dark: 'rgba(255, 92, 170, .34)' },
  { id: 'orange', label: 'Orange', css: 'rgba(255, 140, 30, .40)', dark: 'rgba(255, 140, 30, .36)' },
];
const colorOf = (id) => HIGHLIGHT_COLORS.find((c) => c.id === id) || HIGHLIGHT_COLORS[0];

const WORD = /[\p{L}\p{M}\p{N}'’-]/u;
let measureCtx;
const measure = (s) => {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = '100px Georgia, serif';
  return measureCtx.measureText(s).width;
};

/** Fractional x position of character `k` within a text item (PDF runs are whole lines). */
function charFrac(itemText, k) {
  if (k <= 0) return 0;
  if (k >= itemText.length) return 1;
  const total = measure(itemText);
  return total ? measure(itemText.slice(0, k)) / total : k / itemText.length;
}

/** Rectangles (page units) covering text range [a, b) of a page. */
export function rangeRects(data, a, b) {
  const rects = [];
  for (const it of data.items) {
    if (it.end <= a || it.start >= b) continue;
    const t = data.text.slice(it.start, it.end);
    const fa = charFrac(t, Math.max(a, it.start) - it.start);
    const fb = charFrac(t, Math.min(b, it.end) - it.start);
    rects.push({ x: it.x + it.w * fa, y: it.y, w: it.w * (fb - fa), h: it.h });
  }
  // Join neighbouring boxes on the same line into one band (ePUB lines are one box per word).
  const merged = [];
  for (const r of rects) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.y - r.y) < 0.5 && Math.abs(last.h - r.h) < 0.5 && r.x >= last.x
      && r.x - (last.x + last.w) < r.h * 0.9) {
      last.w = r.x + r.w - last.x;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

export class Highlights {
  constructor(reader) {
    this.reader = reader;
    this.book = reader.book;
    this.list = [];
    this.data = new Map(); // page → resolved page text data
    this.layer = reader.root.querySelector('.hl-layer');
    this.selLayer = reader.root.querySelector('.sel-layer');
    this.popup = reader.root.querySelector('.hl-popup');
    this.sel = null;
    this.popup.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  async load() {
    try {
      this.list = (await api.highlights(this.book.id)).highlights;
    } catch {
      this.list = [];
    }
    this.update();
  }

  reset() {
    this.data.clear();
    this.key = null;
    this.hidePopup();
    this.update();
  }

  // ------------------------------------------------------------ geometry
  _pageData(n) {
    if (!this.data.has(n)) {
      const p = this.reader.doc.pageText(n).then((d) => { this.data.set(n, d); return d; });
      this.data.set(n, p);
      p.then(() => this.update());
    }
    const v = this.data.get(n);
    return v instanceof Promise ? null : v;
  }

  async _pageDataAsync(n) {
    this._pageData(n);
    return this.data.get(n);
  }

  /** Highlights on page n, as [{h, a, b}] in page-local character offsets. */
  _onPage(n, data) {
    const out = [];
    const reflow = this.reader.doc.reflowable;
    for (const h of this.list) {
      if (reflow) {
        if (h.page !== null) continue;
        const a = h.start - data.base;
        const b = h.end - data.base;
        if (b > 0 && a < data.text.length) out.push({ h, a: Math.max(0, a), b: Math.min(data.text.length, b) });
      } else if (h.page === n) {
        out.push({ h, a: h.start, b: h.end });
      }
    }
    return out;
  }

  /** Stage point → { page, data, u, v } in page units, for whichever visible page is under it. */
  async _hit(clientX, clientY) {
    const r = this.reader;
    const box = r.el.stage.getBoundingClientRect();
    const cx = clientX - box.left;
    const cy = clientY - box.top;
    for (const n of r.visiblePages()) {
      const data = await this._pageDataAsync(n);
      if (!data) continue;
      const { ox, oy, s } = r.pageGeom(n, data);
      const u = (cx - ox) / s;
      const v = (cy - r.css.y - oy) / s;
      if (u >= -4 && v >= -4 && u <= data.w + 4 && v <= data.h + 4) return { page: n, data, u, v };
    }
    return null;
  }

  /** Character index under a point (page units), or -1. Snaps to the nearest text on the line. */
  _charAt(data, u, v, snap = false) {
    let best = null;
    let bestD = Infinity;
    for (const it of data.items) {
      const dy = v < it.y ? it.y - v : v > it.y + it.h ? v - (it.y + it.h) : 0;
      const dx = u < it.x ? it.x - u : u > it.x + it.w ? u - (it.x + it.w) : 0;
      const d = dy * 4 + dx;
      if (d < bestD) { bestD = d; best = it; }
    }
    if (!best || (!snap && bestD > 6)) return -1;
    const t = data.text.slice(best.start, best.end);
    const f = Math.min(1, Math.max(0, (u - best.x) / (best.w || 1)));
    // Find the character whose span contains f.
    let k = 0;
    while (k < t.length - 1 && charFrac(t, k + 1) <= f) k++;
    return best.start + k;
  }

  _wordAt(data, i) {
    const t = data.text;
    if (i < 0 || !WORD.test(t[i] || '')) return null;
    let a = i;
    let b = i + 1;
    while (a > 0 && WORD.test(t[a - 1])) a--;
    while (b < t.length && WORD.test(t[b])) b++;
    // Trim leading/trailing punctuation-like characters.
    while (a < b && /['’-]/.test(t[a])) a++;
    while (b > a && /['’-]/.test(t[b - 1])) b--;
    return b > a ? { a, b } : null;
  }

  // ------------------------------------------------------------ drawing
  /** Redraw highlight overlays for the visible pages (called on every reader frame). */
  update() {
    const r = this.reader;
    if (!r.css || !r.doc) return;
    const hide = !!r.turn;
    const pages = hide ? [] : r.visiblePages();
    const parts = [];
    let key = `${r.css.x}|${r.css.y}|${r.css.w}|${r.page}|${r.darkPages}|${this.list.length}|${this.list.map((h) => h.color).join('')}|${pages}`;
    for (const n of pages) {
      const data = this._pageData(n);
      if (!data) { key += '|wait'; continue; }
      const { ox, oy, s } = r.pageGeom(n, data);
      for (const { h, a, b } of this._onPage(n, data)) {
        const c = colorOf(h.color);
        for (const q of rangeRects(data, a, b)) {
          parts.push(`<div class="hl" data-h="${h.id}" style="left:${ox + q.x * s}px;top:${r.css.y + oy + q.y * s}px;width:${q.w * s}px;height:${q.h * s}px;background:${r.darkPages ? c.dark : c.css}"></div>`);
        }
        if (h.note) {
          const q = rangeRects(data, a, b).pop();
          if (q) parts.push(`<div class="hl-note-mark" style="left:${ox + (q.x + q.w) * s}px;top:${r.css.y + oy + q.y * s - 4}px"></div>`);
        }
      }
    }
    if (key === this.key && !this.dirty) return;
    this.key = key;
    this.dirty = false;
    if (this.eraser) this._syncBar();
    this.layer.innerHTML = parts.join('');
    this._drawSelection();
  }

  _drawSelection() {
    const r = this.reader;
    const sel = this.sel;
    if (!sel || r.turn) { this.selLayer.innerHTML = ''; return; }
    const { ox, oy, s } = r.pageGeom(sel.page, sel.data);
    const [a, b] = sel.a <= sel.b ? [sel.a, sel.b] : [sel.b, sel.a];
    const rects = rangeRects(sel.data, a, b);
    this.selLayer.innerHTML = rects.map((q) =>
      `<div class="sel" style="left:${ox + q.x * s}px;top:${r.css.y + oy + q.y * s}px;width:${q.w * s}px;height:${q.h * s}px"></div>`).join('');
    sel.box = rects.length ? {
      left: ox + Math.min(...rects.map((q) => q.x)) * s,
      right: ox + Math.max(...rects.map((q) => q.x + q.w)) * s,
      top: r.css.y + oy + Math.min(...rects.map((q) => q.y)) * s,
      bottom: r.css.y + oy + Math.max(...rects.map((q) => q.y + q.h)) * s,
    } : null;
  }

  // ------------------------------------------------------------ selecting
  /** Long-press: select the word under the finger. Returns true if a selection started. */
  async beginSelect(clientX, clientY) {
    if (this.eraser) return false;
    this.hidePopup();
    const hit = await this._hit(clientX, clientY);
    if (!hit) return false;
    const i = this._charAt(hit.data, hit.u, hit.v);
    const w = this._wordAt(hit.data, i);
    if (!w) return false;
    navigator.vibrate?.(10);
    this.sel = { page: hit.page, data: hit.data, anchorA: w.a, anchorB: w.b, a: w.a, b: w.b };
    this._drawSelection();
    return true;
  }

  async extendSelect(clientX, clientY) {
    const sel = this.sel;
    if (!sel) return;
    const hit = await this._hit(clientX, clientY);
    if (!hit || hit.page !== sel.page) return;
    const i = this._charAt(hit.data, hit.u, hit.v, true);
    if (i < 0) return;
    const w = this._wordAt(hit.data, i) || { a: i, b: i + 1 };
    if (w.a >= sel.anchorA) { sel.a = sel.anchorA; sel.b = w.b; } else { sel.a = w.a; sel.b = sel.anchorB; }
    this._drawSelection();
  }

  endSelect() {
    if (!this.sel) return;
    this._drawSelection();
    this.showPopup({ selection: true });
  }

  clearSelection() {
    this.sel = null;
    this.selLayer.innerHTML = '';
  }

  /** The highlight drawn under a screen point, if any. */
  _highlightAt(clientX, clientY) {
    // The overlay doesn't take pointer events (so pages still turn), so hit-test its boxes directly.
    const el = [...this.layer.querySelectorAll('.hl')].find((x) => {
      const b = x.getBoundingClientRect();
      return clientX >= b.left - 2 && clientX <= b.right + 2 && clientY >= b.top - 2 && clientY <= b.bottom + 2;
    });
    return el ? this.list.find((x) => x.id === el.dataset.h) || null : null;
  }

  /** Tap: if it lands on a highlight, open its pop-up (or erase it in eraser mode). Returns true if handled. */
  tapAt(clientX, clientY) {
    if (this.eraser) {
      const h = this._highlightAt(clientX, clientY);
      if (h) this.erase(h);
      return true; // taps don't turn pages while erasing (swipes still do)
    }
    if (!this.popup.hidden) { this.hidePopup(); this.clearSelection(); return true; }
    const h = this._highlightAt(clientX, clientY);
    if (!h) return false;
    const el = this.layer.querySelector(`.hl[data-h="${h.id}"]`);
    this.showPopup({ highlight: h, anchor: el.getBoundingClientRect() });
    return true;
  }

  // ------------------------------------------------------------ eraser
  /** Eraser mode: tap highlighted text to remove that highlight. */
  setEraser(on) {
    this.eraser = on;
    this.hidePopup();
    this.clearSelection();
    this.reader.root.classList.toggle('erasing', on);
    this.bar ||= this.reader.root.querySelector('.eraser-bar');
    this.bar.hidden = !on;
    this.lastErased = null;
    this._syncBar();
    this.dirty = true;
    this.update();
  }

  _syncBar() {
    if (!this.bar) return;
    const n = this.reader.visiblePages().reduce((sum, p) => {
      const d = this._pageData(p);
      return sum + (d ? this._onPage(p, d).length : 0);
    }, 0);
    this.bar.querySelector('.eraser-msg').textContent = this.lastErased
      ? 'Highlight removed.'
      : n ? 'Tap a highlight to remove it.' : 'No highlights on this page.';
    this.bar.querySelector('[data-eraser="undo"]').hidden = !this.lastErased;
  }

  async erase(h) {
    // Remove it straight away; the server catches up (and Undo can bring it back).
    this.list = this.list.filter((x) => x !== h);
    this.lastErased = h;
    this.dirty = true;
    this.update();
    this._syncBar();
    navigator.vibrate?.(8);
    try {
      await api.deleteHighlight(h.id);
    } catch (e) {
      this.list.push(h);
      this.lastErased = null;
      this.dirty = true;
      this.update();
      this._syncBar();
      toast(e.message);
    }
  }

  async undoErase() {
    const h = this.lastErased;
    if (!h) return;
    this.lastErased = null;
    try {
      const { highlight } = await api.addHighlight(this.book.id, {
        page: h.page, start: h.start, end: h.end, text: h.text, color: h.color, note: h.note,
      });
      this.list.push(highlight);
      this.dirty = true;
      this.update();
    } catch (e) {
      toast(e.message);
    }
    this._syncBar();
  }

  /** Double-tap: the word under the point, or null. */
  async wordAt(clientX, clientY) {
    const hit = await this._hit(clientX, clientY);
    if (!hit) return null;
    const w = this._wordAt(hit.data, this._charAt(hit.data, hit.u, hit.v));
    return w ? hit.data.text.slice(w.a, w.b).replace(/\u200b/g, '') : null;
  }

  // ------------------------------------------------------------ pop-up
  showPopup({ selection = false, highlight = null, anchor = null }) {
    const r = this.reader;
    const stageBox = r.el.stage.getBoundingClientRect();
    let box;
    if (selection && this.sel?.box) box = this.sel.box;
    else if (anchor) box = { left: anchor.left - stageBox.left, right: anchor.right - stageBox.left, top: anchor.top - stageBox.top, bottom: anchor.bottom - stageBox.top };
    else return;
    this.current = { selection, highlight };
    const text = selection ? this._selText() : highlight.text;
    const oneWord = selection && !/\s/.test(text.trim());
    this.popup.innerHTML = `
      <div class="hl-colors" role="group" aria-label="Highlight color">
        ${HIGHLIGHT_COLORS.map((c) => `<button class="hl-swatch sw-${c.id} ${highlight?.color === c.id ? 'active' : ''}" data-color="${c.id}" aria-label="${c.label} highlight"></button>`).join('')}
      </div>
      <div class="hl-actions">
        <button data-act="note">${highlight?.note ? 'Edit Note' : 'Note'}</button>
        ${oneWord || (highlight && !/\s/.test(highlight.text.trim())) ? '<button data-act="define">Define</button>' : ''}
        <button data-act="copy">Copy</button>
        ${highlight ? '<button data-act="delete">Delete</button>' : ''}
      </div>`;
    this.popup.hidden = false;
    // Place above the selection if there is room, else below.
    const pw = this.popup.offsetWidth;
    const ph = this.popup.offsetHeight;
    const W = stageBox.width;
    let x = (box.left + box.right) / 2 - pw / 2;
    x = Math.max(8, Math.min(W - pw - 8, x));
    let y = box.top - ph - 12;
    if (y < 60) y = box.bottom + 12;
    this.popup.style.left = `${x}px`;
    this.popup.style.top = `${Math.min(y, stageBox.height - ph - 8)}px`;
    this.popup.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => this._applyColor(b.dataset.color)));
    this.popup.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => this._action(b.dataset.act)));
  }

  hidePopup() {
    if (this.popup) this.popup.hidden = true;
    this.current = null;
  }

  _selText() {
    const sel = this.sel;
    if (!sel) return '';
    const [a, b] = sel.a <= sel.b ? [sel.a, sel.b] : [sel.b, sel.a];
    return sel.data.text.slice(a, b).replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
  }

  async _createFromSelection(color, note = '') {
    const sel = this.sel;
    const [a, b] = sel.a <= sel.b ? [sel.a, sel.b] : [sel.b, sel.a];
    const reflow = this.reader.doc.reflowable;
    const body = {
      page: reflow ? null : sel.page,
      start: reflow ? sel.data.base + a : a,
      end: reflow ? sel.data.base + b : b,
      text: this._selText(),
      color,
      note,
    };
    const { highlight } = await api.addHighlight(this.book.id, body);
    this.list.push(highlight);
    this.clearSelection();
    this.dirty = true;
    this.update();
    return highlight;
  }

  async _applyColor(color) {
    const { selection, highlight } = this.current || {};
    this.hidePopup();
    try {
      if (selection && this.sel) await this._createFromSelection(color);
      else if (highlight) {
        const { highlight: h } = await api.updateHighlight(highlight.id, { color });
        Object.assign(highlight, h);
        this.dirty = true;
        this.update();
      }
    } catch (e) {
      toast(e.message);
    }
  }

  async _action(act) {
    const { selection, highlight } = this.current || {};
    const text = selection ? this._selText() : highlight?.text || '';
    this.hidePopup();
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Copying isn’t allowed here.'); }
      this.clearSelection();
    }
    if (act === 'define') {
      this.clearSelection();
      showDefinition(text);
    }
    if (act === 'delete' && highlight) {
      try {
        await api.deleteHighlight(highlight.id);
        this.list = this.list.filter((h) => h !== highlight);
        this.dirty = true;
        this.update();
      } catch (e) { toast(e.message); }
    }
    if (act === 'note') {
      const note = await noteSheet(text, highlight?.note || '');
      if (note === undefined) { this.clearSelection(); return; }
      try {
        if (highlight) {
          const { highlight: h } = await api.updateHighlight(highlight.id, { note });
          Object.assign(highlight, h);
        } else if (this.sel) {
          await this._createFromSelection('yellow', note);
        }
        this.dirty = true;
        this.update();
      } catch (e) { toast(e.message); }
    }
  }

  // ------------------------------------------------------------ list
  async showList() {
    const r = this.reader;
    const list = await Promise.all(this.list.map(async (h) => ({
      h,
      page: h.page ?? r.doc.pageForOffset?.(h.start) ?? 1,
    })));
    list.sort((x, y) => x.page - y.page || x.h.start - y.h.start);
    const choice = await sheet(
      `<h3>Notes & Highlights</h3><p class="sub">${list.length} in ${esc(this.book.title)}</p>
       ${list.length ? `<div class="hl-list">${list.map(({ h, page }) => `
         <div class="hl-item">
           <button class="hl-item-main" data-go="${page}">
             <span class="hl-bar sw-${h.color}"></span>
             <span class="hl-item-text"><small>Page ${page} · ${colorOf(h.color).label} highlight</small>
               <q>${esc(h.text)}</q>${h.note ? `<span class="hl-item-note">Note: ${esc(h.note)}</span>` : ''}</span>
           </button>
           <button class="icon-btn" data-del="${h.id}" aria-label="Delete highlight">
             <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
           </button>
         </div>`).join('')}</div>`
         : '<p class="sub">Press and hold a word on a page to start highlighting.</p>'}
       <div class="actions"><button class="btn" data-close>Close</button></div>`,
      (el, close) => {
        el.querySelector('[data-close]').onclick = () => close();
        el.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => close({ go: +b.dataset.go })));
        el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
          if (!(await confirmSheet('Delete this highlight?', 'Its note will be deleted too.', 'Delete'))) return;
          try {
            await api.deleteHighlight(b.dataset.del);
            this.list = this.list.filter((h) => h.id !== b.dataset.del);
            b.closest('.hl-item').remove();
            this.dirty = true;
            this.update();
          } catch (e) { toast(e.message); }
        }));
      },
    );
    if (choice?.go) r._goto(choice.go);
  }
}

function noteSheet(quote, value) {
  return sheet(
    `<h3>Note</h3><p class="sub hl-quote">“${esc(quote.length > 220 ? `${quote.slice(0, 220)}…` : quote)}”</p>
     <form><label class="field"><span>Your note</span><textarea name="note" maxlength="2000" rows="4" autofocus>${esc(value)}</textarea></label>
     <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div></form>`,
    (el, close) => {
      el.querySelector('[data-cancel]').onclick = () => close();
      el.querySelector('form').onsubmit = (e) => { e.preventDefault(); close(e.target.note.value.trim()); };
    },
  );
}

/** Kindle-style dictionary card. */
export async function showDefinition(word) {
  const clean = word.replace(/[^\p{L}\p{M}'’-]/gu, '');
  if (!clean) return;
  let resolveData;
  const loading = new Promise((r) => { resolveData = r; });
  sheet(
    `<div class="dict"><div class="dict-label">Dictionary</div><h3 class="dict-word">${esc(clean)}</h3>
     <div class="dict-body"><div class="spinner"></div></div>
     <div class="actions"><button class="btn" data-close>Close</button></div></div>`,
    (el, close) => {
      el.querySelector('[data-close]').onclick = () => close();
      loading.then(({ entry, error }) => {
        const body = el.querySelector('.dict-body');
        if (!body) return;
        if (error) { body.innerHTML = `<p class="sub">${esc(error)}</p>`; return; }
        el.querySelector('.dict-word').innerHTML = `${esc(entry.word)}${entry.phonetic ? ` <span class="dict-phon">${esc(entry.phonetic)}</span>` : ''}`;
        body.innerHTML = entry.meanings.map((m) => `
          <div class="dict-pos">${esc(m.partOfSpeech)}</div>
          <ol>${m.definitions.map((d) => `<li>${esc(d.definition)}${d.example ? `<div class="dict-ex">“${esc(d.example)}”</div>` : ''}</li>`).join('')}</ol>`).join('');
      });
    },
  );
  try {
    resolveData(await api.define(clean));
  } catch (e) {
    resolveData({ error: e.offline ? 'The dictionary needs an internet connection.' : e.message });
  }
}
