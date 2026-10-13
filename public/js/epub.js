// ePUB support: a small reflowable layout engine.
//
// The book's XHTML is turned into a flat list of blocks (paragraphs, headings,
// list items, images, rules, chapter breaks). Every character gets a fixed
// offset in the book's text, so reading positions, highlights and chapters stay
// put when the font size or screen size changes. layout() breaks the blocks
// into pages for a given page size and font size; renderPage() draws a page to
// a canvas, which the page-turn renderer then uses like any PDF page.

import { unzipSync, strFromU8 } from '/vendor/fflate/browser.js';
import { DARK_BG, DARK_FG } from './darkpage.js';

export const SERIF = 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif';
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main', 'blockquote',
  'pre', 'ul', 'ol', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'address', 'center', 'body', 'caption']);
const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'math']);
const HEADING_SCALE = { h1: 1.55, h2: 1.35, h3: 1.18, h4: 1.08, h5: 1, h6: 1 };

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

/** Resolve an href relative to the file it appears in. Returns [path, fragment]. */
function resolveHref(from, href) {
  const [rawPath, frag = ''] = String(href || '').split('#');
  let path = rawPath ? dirOf(from) + rawPath : from;
  try { path = decodeURIComponent(path); } catch {}
  const parts = [];
  for (const p of path.split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return [parts.join('/'), frag];
}

export class EpubDoc {
  static async open(data) {
    const doc = new EpubDoc(unzipSync(data));
    doc._parseMeta();
    await doc._buildBlocks();
    return doc;
  }

  /** Title, author and cover (JPEG blob) for the upload sheet. */
  static async inspect(data) {
    const doc = new EpubDoc(unzipSync(data));
    doc._parseMeta();
    let cover = null;
    if (doc.coverPath) {
      try {
        const bmp = await doc._bitmap(doc.coverPath);
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = Math.round((480 * bmp.height) / bmp.width);
        canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
        cover = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
      } catch {}
    }
    return { title: doc.title, author: doc.author, pageCount: 0, cover };
  }

  constructor(files) {
    this.files = files;
    this.lower = new Map(Object.keys(files).map((k) => [k.toLowerCase(), k]));
    this.kind = 'epub';
    this.reflowable = true;
    this.aspect = 0.66;
    this.blocks = [];
    this.text = '';
    this.anchors = new Map(); // "path" or "path#id" → text offset
    this.images = new Map();  // path → ImageBitmap
    this.pages = [];
    this.toc = [];
    this.measureCache = new Map();
  }

  get numPages() { return Math.max(1, this.pages.length); }

  // ------------------------------------------------------------ parsing
  _bytes(path) {
    return this.files[path] || this.files[this.lower.get(path.toLowerCase())] || null;
  }

  _xml(path) {
    const bytes = this._bytes(path);
    if (!bytes) return null;
    const src = strFromU8(bytes);
    let doc = new DOMParser().parseFromString(src, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(src, 'text/html');
    return doc;
  }

  _parseMeta() {
    this._checkDrm();
    const container = this._xml('META-INF/container.xml');
    const rootfile = container?.getElementsByTagName('rootfile')[0];
    const opfPath = rootfile?.getAttribute('full-path');
    if (!opfPath) throw new Error('This ePUB is missing its package file.');
    const opf = this._xml(opfPath);
    if (!opf) throw new Error('This ePUB could not be read.');
    const byTag = (name) => [...opf.getElementsByTagNameNS('*', name)];
    this.title = byTag('title')[0]?.textContent.trim() || '';
    this.author = byTag('creator').map((c) => c.textContent.trim()).filter(Boolean).join(', ');
    this.manifest = new Map();
    for (const it of byTag('item')) {
      const [href] = resolveHref(opfPath, it.getAttribute('href'));
      this.manifest.set(it.getAttribute('id'), { href, type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' });
    }
    const spineEl = byTag('spine')[0];
    this.spine = byTag('itemref').map((r) => this.manifest.get(r.getAttribute('idref'))).filter(Boolean)
      .filter((it) => /x?html/.test(it.type) || /\.x?html?$/i.test(it.href));
    // Cover image: EPUB 3 "cover-image" property, or EPUB 2 <meta name="cover">.
    const coverItem = [...this.manifest.values()].find((m) => m.props.split(/\s+/).includes('cover-image'))
      || this.manifest.get(byTag('meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content'));
    this.coverPath = coverItem && /^image\//.test(coverItem.type) ? coverItem.href : null;
    // Table of contents: EPUB 3 nav document, else EPUB 2 NCX.
    const nav = [...this.manifest.values()].find((m) => m.props.split(/\s+/).includes('nav'));
    const ncx = this.manifest.get(spineEl?.getAttribute('toc'));
    this.toc = [];
    if (nav) this._parseNav(nav.href);
    if (!this.toc.length && ncx) this._parseNcx(ncx.href);
  }

  /** DRM-protected ePUBs (most store-bought ones) list encrypted content in encryption.xml. */
  _checkDrm() {
    const enc = this._xml('META-INF/encryption.xml');
    if (this._bytes('META-INF/rights.xml') && !enc) return; // rights without encryption: readable
    if (!enc) return;
    // Font obfuscation (IDPF/Adobe) is harmless; anything else encrypted means DRM.
    const datas = [...enc.getElementsByTagNameNS('*', 'EncryptedData')];
    const drm = datas.some((d) => {
      const alg = d.getElementsByTagNameNS('*', 'EncryptionMethod')[0]?.getAttribute('Algorithm') || '';
      const uri = d.getElementsByTagNameNS('*', 'CipherReference')[0]?.getAttribute('URI') || '';
      const fontObfuscation = /idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/.test(alg);
      return !fontObfuscation && !/\.(otf|ttf|woff2?)$/i.test(uri);
    });
    if (drm) {
      throw new Error('This ePUB is protected by DRM (copy protection), so it can only be opened in the store’s own app. DRM-free ePUBs work in Bindr.');
    }
  }

  _parseNav(path) {
    const doc = this._xml(path);
    if (!doc) return;
    const navs = [...doc.getElementsByTagName('nav')];
    const toc = navs.find((n) => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || navs[0];
    const walk = (ol, depth) => {
      for (const li of [...(ol?.children || [])].filter((c) => c.localName === 'li')) {
        const a = [...li.children].find((c) => c.localName === 'a' || c.localName === 'span');
        if (a?.getAttribute('href')) {
          const [p, frag] = resolveHref(path, a.getAttribute('href'));
          this.toc.push({ title: a.textContent.replace(/\s+/g, ' ').trim(), target: frag ? `${p}#${frag}` : p, depth });
        }
        const sub = [...li.children].find((c) => c.localName === 'ol');
        if (sub && depth < 2) walk(sub, depth + 1);
      }
    };
    walk([...(toc?.children || [])].find((c) => c.localName === 'ol'), 0);
  }

  _parseNcx(path) {
    const doc = this._xml(path);
    if (!doc) return;
    const walk = (parent, depth) => {
      for (const np of [...parent.children].filter((c) => c.localName === 'navPoint')) {
        const label = np.getElementsByTagNameNS('*', 'text')[0]?.textContent.trim();
        const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src');
        if (label && src) {
          const [p, frag] = resolveHref(path, src);
          this.toc.push({ title: label, target: frag ? `${p}#${frag}` : p, depth });
        }
        if (depth < 2) walk(np, depth + 1);
      }
    };
    const map = doc.getElementsByTagNameNS('*', 'navMap')[0];
    if (map) walk(map, 0);
  }

  async _bitmap(path) {
    if (this.images.has(path)) return this.images.get(path);
    const bytes = this._bytes(path);
    if (!bytes) throw new Error('missing image');
    const ext = path.split('.').pop().toLowerCase();
    const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'image/png';
    const blob = new Blob([bytes], { type });
    let bmp;
    if (type === 'image/svg+xml') {
      // createImageBitmap can't take SVG blobs everywhere; go through an <img>.
      const url = URL.createObjectURL(blob);
      bmp = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });
    } else {
      bmp = await createImageBitmap(blob);
    }
    this.images.set(path, bmp);
    return bmp;
  }

  async _buildBlocks() {
    for (const item of this.spine) {
      const doc = this._xml(item.href);
      if (!doc) continue;
      this.blocks.push({ kind: 'break' });
      this.anchors.set(item.href, this.text.length);
      this._walk(doc, item.href);
    }
    // Decode images now so layout knows their sizes.
    const imgs = this.blocks.filter((b) => b.kind === 'img');
    await Promise.all(imgs.map(async (b) => {
      try {
        const bmp = await this._bitmap(b.path);
        b.w = bmp.width || bmp.naturalWidth || 1;
        b.h = bmp.height || bmp.naturalHeight || 1;
      } catch {
        b.kind = 'skip';
      }
    }));
    if (!this.text.trim() && !imgs.length) throw new Error('This ePUB has no readable content.');
  }

  _walk(doc, path) {
    const body = doc.getElementsByTagName('body')[0] || doc.documentElement;
    let cur = null;
    const flush = () => {
      if (cur && cur.text.replace(/^[•\d.]+\s*/, '').trim()) this._pushText(cur);
      cur = null;
    };
    const ensure = (ctx) => {
      if (!cur) cur = { kind: 'text', tag: ctx.tag, runs: [], text: '', indent: ctx.indent, align: ctx.align, pre: ctx.pre };
      return cur;
    };
    const addRun = (t, ctx) => {
      const b = ensure(ctx);
      b.runs.push({ start: b.text.length, end: b.text.length + t.length, bold: ctx.bold, italic: ctx.italic });
      b.text += t;
      b.liPending = false;
    };
    const visit = (node, ctx) => {
      if (node.nodeType === 3) {
        let t = node.nodeValue;
        if (!ctx.pre) {
          t = t.replace(/\s+/g, ' ');
          if (!cur || cur.text === '' || /[ \n]$/.test(cur.text)) t = t.replace(/^ /, '');
        }
        if (t) addRun(t, ctx);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = (node.localName || '').toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      const id = node.getAttribute('id');
      if (id) this.anchors.set(`${path}#${id}`, this.text.length + (cur ? cur.text.length : 0));
      if (tag === 'br') { if (cur && !cur.liPending) addRun('\n', ctx); return; }
      if (tag === 'img' || tag === 'image') {
        const src = node.getAttribute('src') || node.getAttribute('href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (src && !/^data:/.test(src)) {
          flush();
          this.blocks.push({ kind: 'img', path: resolveHref(path, src)[0] });
        }
        return;
      }
      if (tag === 'svg') { for (const im of node.getElementsByTagNameNS('*', 'image')) visit(im, ctx); return; }
      if (tag === 'hr') { flush(); this.blocks.push({ kind: 'hr' }); return; }
      const style = (node.getAttribute('style') || '').toLowerCase();
      const next = { ...ctx };
      if (['b', 'strong', 'th'].includes(tag) || /font-weight:\s*(bold|[6-9]00)/.test(style)) next.bold = true;
      if (['i', 'em', 'cite', 'var', 'dfn'].includes(tag) || /font-style:\s*italic/.test(style)) next.italic = true;
      if (/^h[1-6]$/.test(tag)) { next.tag = tag; next.bold = true; }
      if (tag === 'pre') { next.pre = true; next.tag = 'pre'; }
      if (tag === 'blockquote') next.indent = (ctx.indent || 0) + 1;
      if (tag === 'center' || /text-align:\s*center/.test(style)) next.align = 'center';
      if (tag === 'ul' || tag === 'ol') next.list = { ordered: tag === 'ol', n: 0, depth: (ctx.list?.depth ?? -1) + 1 };
      const isBlock = BLOCK_TAGS.has(tag);
      if (tag === 'li') {
        flush();
        const list = ctx.list || { ordered: false, n: 0, depth: 0 };
        list.n++;
        next.tag = 'li';
        next.indent = (ctx.indent || 0) + list.depth + 1;
        addRun(list.ordered ? `${list.n}. ` : '• ', next);
        cur.liPending = true;
      } else if (isBlock && !(cur && cur.liPending)) {
        flush();
      }
      for (const c of node.childNodes) visit(c, next);
      if (isBlock || tag === 'li') {
        if (!(cur && cur.liPending)) flush();
      }
    };
    visit(body, { tag: 'p', bold: false, italic: false, pre: false, indent: 0, align: null, list: null });
    flush();
  }

  _pushText(b) {
    // Trim trailing whitespace (keeping run offsets valid).
    const trimmed = b.pre ? b.text.replace(/\s+$/, '') : b.text.replace(/[ \n]+$/, '');
    b.text = trimmed;
    b.runs = b.runs.filter((r) => r.start < trimmed.length).map((r) => ({ ...r, end: Math.min(r.end, trimmed.length) }));
    b.start = this.text.length;
    this.text += `${b.text}\n`;
    this.blocks.push(b);
  }

  // ------------------------------------------------------------ layout
  _font(size, bold, italic) {
    return `${italic ? 'italic ' : ''}${bold ? '700 ' : ''}${size}px ${SERIF}`;
  }

  _measure(ctx, font, text) {
    const key = `${font}|${text}`;
    let w = this.measureCache.get(key);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width;
      if (this.measureCache.size > 60000) this.measureCache.clear();
      this.measureCache.set(key, w);
    }
    return w;
  }

  /** Paginate for a page of cssW × cssH at the given font size. Returns true if pages changed. */
  layout(cssW, cssH, { fontSize = 19 } = {}) {
    const key = `${Math.round(cssW)}x${Math.round(cssH)}@${fontSize}`;
    if (key === this.layoutKey) return false;
    this.layoutKey = key;
    this.cssW = cssW;
    this.cssH = cssH;
    const ctx = (this._mctx ||= document.createElement('canvas').getContext('2d'));
    const f = fontSize;
    const mx = Math.round(Math.max(18, Math.min(70, cssW * 0.08)));
    const top = Math.round(Math.max(26, cssH * 0.05));
    const bottom = Math.round(Math.max(34, cssH * 0.065));
    const cw = cssW - mx * 2;
    const ch = cssH - top - bottom;
    const pages = [];
    let page;
    let y = 0;
    const newPage = () => { page = { ops: [], items: [], startOff: null, endOff: null }; pages.push(page); y = 0; };
    newPage();

    for (const b of this.blocks) {
      if (b.kind === 'break') { if (page.ops.length) newPage(); continue; }
      if (b.kind === 'skip') continue;
      if (b.kind === 'hr') {
        y += f * 0.6;
        if (y > ch) newPage();
        page.ops.push({ t: 'hr', x: mx + cw * 0.3, y: top + y, w: cw * 0.4 });
        y += f * 0.9;
        continue;
      }
      if (b.kind === 'img') {
        // Show images at their natural size, scaled down to fit the page.
        let w = b.w;
        let h = b.h;
        const s = Math.min(1, cw / w, (ch * 0.96) / h);
        w *= s; h *= s;
        if (w < 48 && h < 48) { w *= 1.5; h *= 1.5; } // tiny decorative images
        if (y + h > ch && page.ops.length) newPage();
        page.ops.push({ t: 'img', path: b.path, x: mx + (cw - w) / 2, y: top + y, w, h });
        y += h + f * 0.6;
        continue;
      }
      // Text block.
      const heading = HEADING_SCALE[b.tag];
      const size = Math.round(f * (heading || (b.tag === 'pre' ? 0.85 : 1)) * 10) / 10;
      const lh = size * (heading ? 1.3 : 1.5);
      const align = b.tag === 'pre' ? 'left' : b.align || (heading ? 'left' : b.tag === 'li' ? 'left' : 'justify');
      const indent = (b.indent || 0) * f * 1.4;
      const avail = cw - indent;
      if (heading && y > 0) y += size * 0.9;

      // Tokenize into words (split further where the style changes).
      const tokens = [];
      const re = /\n|[^\S\n]+|[^\s]+/g;
      let m;
      let space = false;
      while ((m = re.exec(b.text))) {
        if (m[0] === '\n') { tokens.push({ br: true }); space = false; continue; }
        if (/^\s+$/.test(m[0])) { space = true; continue; }
        let s0 = m.index;
        const end = m.index + m[0].length;
        let first = true;
        while (s0 < end) {
          const run = b.runs.find((r) => s0 >= r.start && s0 < r.end) || { end, bold: false, italic: false };
          const e0 = Math.min(end, run.end > s0 ? run.end : end);
          tokens.push({
            text: b.text.slice(s0, e0), start: s0, end: e0, space: first && space,
            font: this._font(size, heading ? true : run.bold, run.italic),
          });
          first = false;
          s0 = e0;
        }
        space = false;
      }

      // Break into lines.
      const lines = [];
      let line = { toks: [], width: 0 };
      const pushLine = (hard) => { line.hard = hard; lines.push(line); line = { toks: [], width: 0 }; };
      for (const tok of tokens) {
        if (tok.br) { pushLine(true); continue; }
        let w = this._measure(ctx, tok.font, tok.text);
        let sp = tok.space && line.toks.length ? this._measure(ctx, tok.font, ' ') : 0;
        if (line.width + sp + w > avail && line.toks.length) { pushLine(false); sp = 0; }
        if (w > avail) {
          // A single word wider than the page (e.g. a URL): break it by characters.
          let s0 = 0;
          while (s0 < tok.text.length) {
            let e0 = s0 + 1;
            while (e0 < tok.text.length && this._measure(ctx, tok.font, tok.text.slice(s0, e0 + 1)) <= avail) e0++;
            const part = { ...tok, text: tok.text.slice(s0, e0), start: tok.start + s0, end: tok.start + e0, space: false };
            const pw = this._measure(ctx, tok.font, part.text);
            if (line.toks.length) pushLine(false);
            line.toks.push({ ...part, x: 0, w: pw });
            line.width = pw;
            s0 = e0;
          }
          continue;
        }
        line.toks.push({ ...tok, x: line.width + sp, w });
        line.width += sp + w;
      }
      if (line.toks.length) pushLine(true);

      // Keep headings with what follows them.
      if (heading && y + lh * (lines.length + 2) > ch && page.ops.length) newPage();

      lines.forEach((ln, i) => {
        if (y + lh > ch && page.ops.length) newPage();
        const last = i === lines.length - 1 || ln.hard;
        let shift = 0;
        let gapExtra = 0;
        if (align === 'center') shift = (avail - ln.width) / 2;
        else if (align === 'justify' && !last) {
          const gaps = ln.toks.filter((t, k) => k > 0 && t.space).length;
          if (gaps) gapExtra = (avail - ln.width) / gaps;
        }
        const baseline = top + y + lh / 2 + size * 0.35;
        let extra = 0;
        ln.toks.forEach((t, k) => {
          if (k > 0 && t.space) extra += gapExtra;
          const x = mx + indent + shift + t.x + extra;
          page.ops.push({ t: 'text', x, y: baseline, text: t.text, font: t.font });
          const gs = b.start + t.start;
          const ge = b.start + t.end;
          page.items.push({ start: gs, end: ge, x, y: top + y, w: t.w, h: lh });
          if (page.startOff === null || gs < page.startOff) page.startOff = gs;
          if (page.endOff === null || ge > page.endOff) page.endOff = ge;
        });
        y += lh;
      });
      y += heading ? size * 0.45 : f * 0.5;
    }
    // Pages without text (full-page images) inherit the position of the text before them.
    let lastOff = 0;
    for (const p of pages) {
      if (p.startOff === null) { p.startOff = lastOff; p.endOff = lastOff; }
      lastOff = p.endOff;
    }
    if (pages.length > 1 && !pages[pages.length - 1].ops.length) pages.pop();
    this.pages = pages;
    return true;
  }

  pageStart(n) {
    return this.pages[n - 1]?.startOff ?? 0;
  }

  /** The page containing book offset `off`. */
  pageForOffset(off) {
    let lo = 0;
    let hi = this.pages.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.pages[mid].startOff <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    // Skip back over text-less pages that share the same start (keep the first).
    while (ans > 0 && this.pages[ans - 1].startOff === this.pages[ans].startOff && this.pages[ans].items.length === 0) ans--;
    return ans + 1;
  }

  // ------------------------------------------------------------ rendering
  async renderPage(n, w, h, { dark = false } = {}) {
    const page = this.pages[n - 1];
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = dark ? `rgb(${DARK_BG.join(',')})` : '#ffffff';
    ctx.fillRect(0, 0, w, h);
    if (!page) return canvas;
    ctx.scale(w / this.cssW, h / this.cssH);
    ctx.textBaseline = 'alphabetic';
    const ink = dark ? `rgb(${DARK_FG.join(',')})` : '#161616';
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    for (const op of page.ops) {
      if (op.t === 'text') {
        ctx.font = op.font;
        ctx.fillText(op.text, op.x, op.y);
      } else if (op.t === 'img') {
        const bmp = this.images.get(op.path);
        if (bmp) ctx.drawImage(bmp, op.x, op.y, op.w, op.h); // pictures are never recolored
      } else if (op.t === 'hr') {
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(op.x, op.y);
        ctx.lineTo(op.x + op.w, op.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    return canvas;
  }

  async pageText(n) {
    const page = this.pages[n - 1];
    if (!page || !page.items.length) return { text: '', items: [], w: this.cssW || 1, h: this.cssH || 1, base: page?.startOff ?? 0 };
    const base = page.startOff;
    return {
      text: this.text.slice(base, page.endOff),
      items: page.items.map((it) => ({ ...it, start: it.start - base, end: it.end - base })),
      w: this.cssW,
      h: this.cssH,
      base, // book offset of text[0]
    };
  }

  async outline() {
    return this.toc
      .map((t) => {
        const off = this.anchors.get(t.target) ?? this.anchors.get(t.target.split('#')[0]);
        return off === undefined ? null : { title: t.title, page: this.pageForOffset(off), depth: t.depth, loc: off };
      })
      .filter(Boolean);
  }

  destroy() {
    for (const b of this.images.values()) b.close?.();
    this.images.clear();
    this.files = null;
  }
}
