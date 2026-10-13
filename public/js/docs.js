// Book documents. The reader works with any object of this shape:
//
//   numPages, reflowable, aspect
//   renderPage(n, devW, devH, { dark }) → Promise<canvas>
//   pageText(n) → Promise<{ text, items: [{start, end, x, y, w, h}], w, h }>
//        (items are in "page units"; w × h is the page size in those units)
//   outline() → Promise<[{ title, page, depth }]>
//   destroy()
//
// Reflowable documents (ePUB) also have layout(cssW, cssH, opts), pageStart(n)
// and pageForOffset(offset). See epub.js.

import { openPdf } from './pdf.js';
import { imageRects, darken } from './darkpage.js';

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

export class PdfDoc {
  static async open(data) {
    const doc = new PdfDoc(await openPdf(data));
    const first = await doc.pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    doc.aspect = vp.width / vp.height;
    return doc;
  }

  constructor(pdf) {
    this.pdf = pdf;
    this.kind = 'pdf';
    this.reflowable = false;
    this.texts = new Map();
  }

  get numPages() { return this.pdf.numPages; }

  async renderPage(n, w, h, { dark = false } = {}) {
    const page = await this.pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(w / base.width, h / base.height);
    const viewport = page.getViewport({ scale });
    let canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const offset = [1, 0, 0, 1, (w - viewport.width) / 2, (h - viewport.height) / 2];
    await page.render({ canvasContext: ctx, viewport, transform: offset }).promise;
    if (dark) {
      let rects = [];
      try {
        const v = viewport.transform;
        rects = await imageRects(page, [v[0], v[1], v[2], v[3], v[4] + offset[4], v[5] + offset[5]]);
      } catch (e) {
        console.warn('Could not locate images on page', n, e);
      }
      canvas = darken(canvas, rects);
    }
    page.cleanup();
    return canvas;
  }

  /** The page's text, with the position of every text run (in PDF points, top-left origin). */
  pageText(n) {
    if (!this.texts.has(n)) {
      this.texts.set(n, (async () => {
        const page = await this.pdf.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        let text = '';
        const items = [];
        for (const it of content.items) {
          if (typeof it.str !== 'string') continue;
          if (it.str) {
            const t = mul(vp.transform, it.transform);
            const fh = Math.hypot(t[2], t[3]) || 10;
            items.push({ start: text.length, end: text.length + it.str.length, x: t[4], y: t[5] - fh * 0.85, w: it.width * (vp.scale || 1), h: fh * 1.15 });
            text += it.str;
          }
          if (it.hasEOL) {
            // Re-join words hyphenated across lines.
            if (/[\p{L}]-$/u.test(text)) text = text.slice(0, -1) + '\u200b';
            else text += ' ';
          } else if (it.str && !/\s$/.test(text)) {
            text += ' ';
          }
        }
        return { text, items, w: vp.width, h: vp.height };
      })().catch(() => ({ text: '', items: [], w: 1, h: 1 })));
    }
    return this.texts.get(n);
  }

  /** The PDF's own table of contents (bookmarks), flattened. */
  async outline() {
    if (this._outline) return this._outline;
    const out = [];
    try {
      const walk = async (items, depth) => {
        for (const it of items || []) {
          let page = null;
          try {
            const dest = typeof it.dest === 'string' ? await this.pdf.getDestination(it.dest) : it.dest;
            if (Array.isArray(dest) && dest[0]) {
              page = typeof dest[0] === 'number' ? dest[0] + 1 : (await this.pdf.getPageIndex(dest[0])) + 1;
            }
          } catch {}
          if (page && it.title) out.push({ title: it.title.trim(), page, depth });
          if (depth < 2) await walk(it.items, depth + 1);
        }
      };
      await walk(await this.pdf.getOutline(), 0);
    } catch {}
    this._outline = out;
    return out;
  }

  destroy() {
    this.pdf.destroy();
  }
}

/** Open a book file of either format. */
export async function openBook(format, data) {
  if (format === 'epub') {
    const { EpubDoc } = await import('./epub.js');
    return EpubDoc.open(data);
  }
  return PdfDoc.open(data);
}
