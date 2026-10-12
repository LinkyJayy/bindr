// Dark mode for book pages. The page's background and text are recolored
// (white paper → dark grey, black text → light grey, colors keep their hue),
// while embedded images are left exactly as they are.
//
// To leave images alone we walk the page's PDF operator list, tracking the
// transformation matrix, and record where every image is painted. After
// darkening the rendered page, those areas are copied back from the original.

import { pdfjs } from './pdf.js';

export const DARK_BG = [27, 27, 30];     // page background in dark mode
export const DARK_FG = [228, 228, 226];  // text

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];

export function loadDarkSetting() {
  try { return localStorage.getItem('bindr:dark-pages') === '1'; } catch { return false; }
}

export function saveDarkSetting(on) {
  try { localStorage.setItem('bindr:dark-pages', on ? '1' : '0'); } catch {}
}

/**
 * Device-pixel rectangles where images are painted on a page.
 * base: the full transform used to render (offset × viewport.transform).
 */
export async function imageRects(page, base) {
  const { OPS } = await pdfjs();
  const IMAGE_OPS = new Set([
    OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat,
    OPS.paintInlineImageXObjectGroup, OPS.paintJpegXObject,
  ].filter((v) => v !== undefined));
  const ops = await page.getOperatorList();
  const rects = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const unitSquare = (m) => {
    const t = mul(base, m);
    const xs = [t[4], t[0] + t[4], t[2] + t[4], t[0] + t[2] + t[4]];
    const ys = [t[5], t[1] + t[5], t[3] + t[5], t[1] + t[3] + t[5]];
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = mul(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (IMAGE_OPS.has(fn)) {
      if (fn === OPS.paintImageXObjectRepeat) {
        // args: [objId, scaleX, scaleY, positions]
        const [, sx, sy, pos] = args;
        for (let k = 0; k + 1 < (pos?.length || 0); k += 2) unitSquare(mul(ctm, [sx, 0, 0, sy, pos[k], pos[k + 1]]));
      } else if (fn === OPS.paintInlineImageXObjectGroup) {
        // args: [imgData, map of {transform, x, y, w, h}]
        for (const entry of args?.[1] || []) if (entry.transform) unitSquare(mul(ctm, entry.transform));
      } else {
        unitSquare(ctm);
      }
    }
  }
  return rects;
}

// Hue rotation by 180° (keeps colors' hue after inverting their lightness).
const H = [
  [-0.574, 1.43, 0.144],
  [0.426, 0.43, 0.144],
  [0.426, 1.43, -0.856],
];

/** Return a dark version of `src`, keeping the pixels inside `rects` untouched. */
export function darken(src, rects) {
  const w = src.width;
  const h = src.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const [br, bg, bb] = DARK_BG;
  const dr = DARK_FG[0] - br;
  const dg = DARK_FG[1] - bg;
  const db = DARK_FG[2] - bb;
  // Grey pixels (most of a page) go through a lookup table.
  const grey = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    const t = 1 - v / 255;
    grey[v * 3] = br + dr * t;
    grey[v * 3 + 1] = bg + dg * t;
    grey[v * 3 + 2] = bb + db * t;
  }
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    if (r === g && g === b) {
      const k = r * 3;
      px[i] = grey[k];
      px[i + 1] = grey[k + 1];
      px[i + 2] = grey[k + 2];
    } else {
      const ir = 1 - r / 255;
      const ig = 1 - g / 255;
      const ib = 1 - b / 255;
      const nr = Math.min(1, Math.max(0, H[0][0] * ir + H[0][1] * ig + H[0][2] * ib));
      const ng = Math.min(1, Math.max(0, H[1][0] * ir + H[1][1] * ig + H[1][2] * ib));
      const nb = Math.min(1, Math.max(0, H[2][0] * ir + H[2][1] * ig + H[2][2] * ib));
      px[i] = br + dr * nr;
      px[i + 1] = bg + dg * ng;
      px[i + 2] = bb + db * nb;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Put the images back exactly as they were.
  for (const [x0, y0, x1, y1] of rects) {
    // Round (not floor/ceil) so a sliver of the white page around the image isn't copied back.
    const x = Math.max(0, Math.round(x0));
    const y = Math.max(0, Math.round(y0));
    const rw = Math.min(w, Math.round(x1)) - x;
    const rh = Math.min(h, Math.round(y1)) - y;
    if (rw > 0 && rh > 0) ctx.drawImage(src, x, y, rw, rh, x, y, rw, rh);
  }
  return out;
}
