// Read-aloud ("audiobook") mode using the browser's built-in speech synthesis.
//
// Text comes from the PDF's text layer. It's split into sentences, which are
// spoken one at a time (long utterances get cut off in some browsers). The
// sentence being read is captioned in the player and highlighted on the page,
// and pages turn by themselves, with the curl, as the reading moves on.

import { toast } from './ui.js';

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const MAX_CHUNK = 220;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// Affine transform product, as pdf.js' Util.transform.
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

function splitSentences(text) {
  const out = [];
  const push = (start, end) => {
    // Trim, keeping offsets into the page text so the sentence can be highlighted.
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (!/[\p{L}\p{N}]/u.test(text.slice(start, end))) return;
    // Very long "sentences" (tables, run-on text) are split at a comma or space.
    while (end - start > MAX_CHUNK) {
      const slice = text.slice(start, start + MAX_CHUNK);
      let cut = Math.max(slice.lastIndexOf(', '), slice.lastIndexOf('; '));
      if (cut < MAX_CHUNK / 3) cut = slice.lastIndexOf(' ');
      if (cut < MAX_CHUNK / 3) cut = MAX_CHUNK - 1;
      out.push({ start, end: start + cut + 1 });
      start += cut + 1;
      while (start < end && /\s/.test(text[start])) start++;
    }
    if (end > start) out.push({ start, end });
  };
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    for (const s of seg.segment(text)) push(s.index, s.index + s.segment.length);
  } else {
    const re = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue; }
      push(m.index, m.index + m[0].length);
    }
  }
  return out;
}

export class Narrator {
  static get supported() {
    return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  }

  constructor(reader, root) {
    this.reader = reader;
    this.synth = window.speechSynthesis;
    this.texts = new Map(); // page -> Promise<{text, items, sentences, w, h}>
    this.active = false;
    this.playing = false;
    this.page = 0;
    this.index = 0;
    this.token = 0;
    this.rate = parseFloat(store.get('bindr:tts-rate')) || 1;
    this.voiceURI = store.get('bindr:tts-voice') || '';

    this.el = {
      root,
      player: root.querySelector('.tts-player'),
      caption: root.querySelector('.tts-caption'),
      where: root.querySelector('.tts-where'),
      toggle: root.querySelector('[data-tts="toggle"]'),
      rate: root.querySelector('[data-tts="rate"]'),
      voice: root.querySelector('.tts-voice'),
      highlight: root.querySelector('.tts-highlight'),
      mic: root.querySelector('[data-action="listen"]'),
    };
    this.el.mic.hidden = false;
    this.el.mic.onclick = () => (this.active ? this.close() : this.open());
    root.querySelector('[data-tts="prev"]').onclick = () => this.skip(-1);
    root.querySelector('[data-tts="next"]').onclick = () => this.skip(1);
    root.querySelector('[data-tts="close"]').onclick = () => this.close();
    this.el.toggle.onclick = () => (this.playing ? this.pause() : this.play());
    this.el.rate.onclick = () => {
      this.rate = RATES[(RATES.indexOf(this.rate) + 1) % RATES.length] || 1;
      store.set('bindr:tts-rate', String(this.rate));
      this._renderControls();
      if (this.playing) this._speak(); // apply now
    };
    this.el.voice.onchange = () => {
      this.voiceURI = this.el.voice.value;
      store.set('bindr:tts-voice', this.voiceURI);
      if (this.playing) this._speak();
    };
    this._onVoices = () => this._fillVoices();
    this.synth.addEventListener?.('voiceschanged', this._onVoices);
    this._fillVoices();
    this._renderControls();
  }

  destroy() {
    this.token++;
    this.synth.cancel();
    this.synth.removeEventListener?.('voiceschanged', this._onVoices);
  }

  // ------------------------------------------------------------ voices
  _voices() {
    return this.synth.getVoices().filter((v) => v.lang);
  }

  _fillVoices() {
    const voices = this._voices();
    const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    const mine = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
    const list = mine.length ? mine : voices;
    this.el.voice.replaceChildren(...list.map((v) => {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = `${v.name.replace(/^(Microsoft|Google)\s+/, '')}${mine.length ? '' : ` (${v.lang})`}`;
      return o;
    }));
    const preferred = list.find((v) => v.voiceURI === this.voiceURI) || list.find((v) => v.default) || list[0];
    if (preferred) this.el.voice.value = preferred.voiceURI;
    this.el.voice.hidden = list.length < 2;
  }

  _voice() {
    const uri = this.el.voice.value || this.voiceURI;
    return this._voices().find((v) => v.voiceURI === uri) || null;
  }

  // ------------------------------------------------------------ text
  pageText(n) {
    if (!this.texts.has(n)) {
      this.texts.set(n, this.reader.doc.pageText(n)
        .then((d) => ({ ...d, sentences: splitSentences(d.text) }))
        .catch(() => ({ text: '', items: [], sentences: [], w: 1, h: 1 })));
    }
    return this.texts.get(n);
  }

  // ------------------------------------------------------------ playback
  open() {
    this.active = true;
    this.el.player.hidden = false;
    this.el.mic.setAttribute('aria-pressed', 'true');
    this.reader.root.classList.add('listening');
    // iOS only allows speech that starts inside a user gesture: unlock it now.
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      this.synth.speak(u);
    } catch {}
    this.startAt(this.reader.visiblePages()[0], 0, true);
  }

  close() {
    this.active = false;
    this.playing = false;
    this.token++;
    this.synth.cancel();
    this.el.player.hidden = true;
    this.el.mic.setAttribute('aria-pressed', 'false');
    this.reader.root.classList.remove('listening');
    this.current = null;
    this.updateHighlight();
  }

  play() {
    if (!this.active) return this.open();
    this.playing = true;
    this._speak();
  }

  pause() {
    // pause()/resume() are unreliable across browsers; cancel and re-speak the sentence instead.
    this.playing = false;
    this.token++;
    this.synth.cancel();
    this._renderControls();
  }

  async startAt(page, index, play = this.playing) {
    const token = ++this.token;
    this.synth.cancel();
    this.page = page;
    this.index = index;
    this.playing = play;
    this._renderControls();
    let data = await this.pageText(page);
    if (token !== this.token) return;
    // Skip pages without text; give up after a long stretch (probably a scanned book).
    let skipped = 0;
    while (!data.sentences.length) {
      const next = await this._advancePage();
      if (token !== this.token) return;
      if (!next || ++skipped > 25) {
        this.el.caption.textContent = skipped > 25 || (!next && !this.heardAny)
          ? 'No readable text found. This PDF may be scanned images.'
          : 'The End';
        this.playing = false;
        this.current = null;
        this.updateHighlight();
        this._renderControls();
        return;
      }
      this.page = next;
      this.index = 0;
      data = await this.pageText(next);
      if (token !== this.token) return;
    }
    if (index < 0) this.index = data.sentences.length - 1;
    this.index = Math.min(this.index, data.sentences.length - 1);
    this._show(data);
    if (this.playing) this._speak();
  }

  _show(data) {
    const s = data.sentences[this.index];
    this.current = { data, page: this.page, start: s.start, end: s.end };
    this.el.caption.textContent = data.text.slice(s.start, s.end).replace(/\u200b/g, '').replace(/\s+/g, ' ');
    this.el.where.textContent = `Page ${this.page}`;
    this.updateHighlight(true);
    this._renderControls();
  }

  async _speak() {
    const token = ++this.token;
    this.synth.cancel();
    const data = await this.pageText(this.page);
    if (token !== this.token || !this.playing) return;
    const s = data.sentences[this.index];
    if (!s) return this._nextSentence(token);
    this._show(data);
    const u = new SpeechSynthesisUtterance(data.text.slice(s.start, s.end).replace(/\u200b/g, '').replace(/\s+/g, ' '));
    u.rate = this.rate;
    const voice = this._voice();
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.onend = () => { if (token === this.token && this.playing) this._nextSentence(token); };
    u.onerror = (e) => {
      if (token !== this.token || e.error === 'interrupted' || e.error === 'canceled') return;
      this.playing = false;
      this._renderControls();
      toast('Read-aloud stopped: speech is unavailable right now.');
    };
    this.synth.speak(u);
    this.heardAny = true;
    this._renderControls();
  }

  async _nextSentence(token) {
    const data = await this.pageText(this.page);
    if (token !== this.token) return;
    if (this.index + 1 < data.sentences.length) {
      this.index++;
      return this._speak();
    }
    const next = await this._advancePage();
    if (token !== this.token) return;
    if (!next) {
      this.playing = false;
      this.current = null;
      this.el.caption.textContent = 'The End';
      this.updateHighlight();
      this._renderControls();
      return;
    }
    this.startAt(next, 0, true);
  }

  /** Move reading to the page after this.page, turning the page when needed. Returns it or null. */
  async _advancePage() {
    const r = this.reader;
    const next = this.page + 1;
    if (next > r.numPages) return null;
    if (!r.visiblePages().includes(next)) {
      this.turning = true;
      try {
        if (!document.hidden) await r.turnPage(1);
        if (!r.visiblePages().includes(next)) r._goto(next); // turn was blocked or the tab is hidden
      } finally {
        this.turning = false;
      }
    }
    return next;
  }

  async skip(dir) {
    if (!this.active) return;
    const data = await this.pageText(this.page);
    const i = this.index + dir;
    if (i >= 0 && i < data.sentences.length) {
      this.index = i;
      if (this.playing) this._speak(); else this._show(data);
      return;
    }
    const target = this.page + dir;
    if (target < 1 || target > this.reader.numPages) return;
    if (!this.reader.visiblePages().includes(target)) {
      this.turning = true;
      try {
        if (!document.hidden) await this.reader.turnPage(dir);
        if (!this.reader.visiblePages().includes(target)) this.reader._goto(target);
      } finally {
        this.turning = false;
      }
    }
    this.startAt(target, dir > 0 ? 0 : -1);
  }

  /** The reader moved to another page by itself (swipe, scrubber…): follow along. */
  pageChanged() {
    if (!this.active || this.turning) return;
    const pages = this.reader.visiblePages();
    if (!pages.includes(this.page)) this.startAt(pages[0], 0);
  }

  _renderControls() {
    const playing = this.playing;
    this.el.toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.el.toggle.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" width="26" height="26"><rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>';
    this.el.rate.textContent = `${this.rate}×`;
  }

  // ------------------------------------------------------------ highlight
  /** Draw the highlight over the sentence being read (called on every reader frame). */
  updateHighlight(follow = false) {
    const r = this.reader;
    const box = this.el.highlight;
    const c = this.current;
    const pages = r.visiblePages ? r.visiblePages() : [];
    if (!c || r.turn || !r.css || !pages.includes(c.page)) {
      if (box.childElementCount) box.replaceChildren();
      return;
    }
    const { css } = r;
    const { ox, oy, s } = r.pageGeom(c.page, c.data);
    const key = `${c.page}:${c.start}:${ox}:${css.y}:${s}`;
    if (key === this.hlKey && box.childElementCount) return;
    this.hlKey = key;
    const rects = [];
    for (const it of c.data.items) {
      if (it.end <= c.start || it.start >= c.end) continue;
      const len = Math.max(1, it.end - it.start);
      const a = (Math.max(c.start, it.start) - it.start) / len;
      const b = (Math.min(c.end, it.end) - it.start) / len;
      rects.push({ x: it.x + it.w * a, y: it.y, w: it.w * (b - a), h: it.h });
    }
    box.replaceChildren(...rects.map((q) => {
      const d = document.createElement('div');
      d.style.cssText = `left:${ox + q.x * s - 2}px;top:${css.y + oy + q.y * s - 1}px;width:${q.w * s + 4}px;height:${q.h * s + 2}px`;
      return d;
    }));
    if (follow && rects.length) {
      const top = oy + Math.min(...rects.map((q) => q.y)) * s;
      const bottom = oy + Math.max(...rects.map((q) => q.y + q.h)) * s;
      r.scrollIntoView(top, bottom);
    }
  }
}
