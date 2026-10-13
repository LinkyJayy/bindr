// Color filters for the page renderer. Every filter is an affine color transform
// (3×3 matrix + offset), applied in the page shader. Presets, colorblind
// corrections and the custom controls all reduce to one matrix.

import { esc } from './ui.js';

const I = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const LUM = [0.2126, 0.7152, 0.0722];

// An affine transform: { m: 3×3 rows, o: [r, g, b] }.
const affine = (m, o = [0, 0, 0]) => ({ m, o });
const mulM = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const mulV = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
/** Apply a, then b. */
const then = (a, b) => affine(mulM(b.m, a.m), mulV(b.m, a.o).map((v, i) => v + b.o[i]));
const mix = (a, b, t) => a.map((row, i) => row.map((v, j) => v + (b[i][j] - v) * t));

const saturate = (s) => affine(I().map((row, i) => row.map((v, j) => (1 - s) * LUM[j] + s * v)));
const contrast = (c) => affine(mix(I(), [[0, 0, 0], [0, 0, 0], [0, 0, 0]], 1 - c), [0.5 * (1 - c), 0.5 * (1 - c), 0.5 * (1 - c)]);
const brightness = (b) => affine(I(), [b, b, b]);
const grayscale = () => affine([LUM, LUM, LUM]);
const invert = () => affine([[-1, 0, 0], [0, -1, 0], [0, 0, -1]], [1, 1, 1]);
const tint = (rgb, k) => affine([[1 + (rgb[0] - 1) * k, 0, 0], [0, 1 + (rgb[1] - 1) * k, 0], [0, 0, 1 + (rgb[2] - 1) * k]]);
const SEPIA = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];
const sepia = (a) => affine(mix(I(), SEPIA, a));
function hueRotate(deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return affine([
    [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
    [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
    [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
  ]);
}

// Colorblind correction ("daltonization"): simulate what the viewer can't tell
// apart, and shift that lost information into channels they can see.
const SIMULATE = {
  protanopia: [[0.567, 0.433, 0], [0.558, 0.442, 0], [0, 0.242, 0.758]],
  deuteranopia: [[0.625, 0.375, 0], [0.7, 0.3, 0], [0, 0.3, 0.7]],
  tritanopia: [[0.95, 0.05, 0], [0, 0.433, 0.567], [0, 0.475, 0.525]],
};
const SHIFT = [[0, 0, 0], [0.7, 1, 0], [0.7, 0, 1]];
function daltonize(type) {
  const S = SIMULATE[type];
  const lost = I().map((row, i) => row.map((v, j) => v - S[i][j])); // I - S
  const corr = mulM(SHIFT, lost);
  return affine(I().map((row, i) => row.map((v, j) => v + corr[i][j])));
}

// E-ink: grayscale on soft warm-gray "paper" with dark-gray "ink", like an e-reader panel.
export const EINK_PAPER = [0.914, 0.906, 0.878];
export const EINK_INK = [0.13, 0.13, 0.13];
const COOL_PAPER = [0.9, 0.905, 0.91];
const WARM_PAPER = [0.95, 0.885, 0.76];
export const DEFAULT_EINK_WARMTH = 35;
/** Paper and ink colors for an E-ink warmth of 0 (cool gray) … 100 (warm cream, like a frontlight set warm). */
export function einkColors(warmth = DEFAULT_EINK_WARMTH) {
  const w = Math.min(100, Math.max(0, warmth)) / 100;
  const paper = COOL_PAPER.map((c, i) => c + (WARM_PAPER[i] - c) * w);
  const ink = [0.13 + 0.03 * w, 0.13 + 0.005 * w, 0.13 - 0.02 * w];
  return { paper, ink };
}
export const EINK_LEVELS = 16; // e-ink panels show a limited number of gray shades
function einkTransform(warmth) {
  const { paper, ink } = einkColors(warmth);
  return affine(paper.map((p, i) => LUM.map((l) => l * (p - ink[i]))), [...ink]);
}
export const isEink = (setting) => setting?.preset === 'eink';

/** Apply a transform to an RGB color (0–1 components). */
export function applyRGB(t, rgb) {
  return [0, 1, 2].map((i) => Math.min(1, Math.max(0, t.m[i][0] * rgb[0] + t.m[i][1] * rgb[1] + t.m[i][2] * rgb[2] + t.o[i])));
}

export const PRESETS = [
  { id: 'none', label: 'Original' },
  { id: 'eink', label: 'E-ink' },
  { id: 'grayscale', label: 'Grayscale' },
  { id: 'vibrant', label: 'Vibrant' },
  { id: 'dull', label: 'Dull' },
  { id: 'colorblind', label: 'Colorblind' },
  { id: 'custom', label: 'Custom' },
];

export const COLORBLIND = [
  { id: 'protanopia', label: 'Protanopia', hint: 'Red-blind' },
  { id: 'deuteranopia', label: 'Deuteranopia', hint: 'Green-blind' },
  { id: 'tritanopia', label: 'Tritanopia', hint: 'Blue-blind' },
  { id: 'achromatopsia', label: 'Achromatopsia', hint: 'No color vision' },
];

export const DEFAULT_CUSTOM = {
  brightness: 0, contrast: 100, saturation: 100, hue: 0, warmth: 0, tint: '#ffd9a0', tintStrength: 0, invert: false,
};

const hexToRgb = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0xffffff;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

function customTransform(c) {
  let t = affine(I());
  t = then(t, saturate(c.saturation / 100));
  if (c.hue) t = then(t, hueRotate(c.hue));
  if (c.warmth) t = then(t, sepia(c.warmth / 100));
  t = then(t, contrast(c.contrast / 100));
  if (c.brightness) t = then(t, brightness(c.brightness / 100));
  if (c.tintStrength) t = then(t, tint(hexToRgb(c.tint), c.tintStrength / 100));
  if (c.invert) t = then(t, invert());
  return t;
}

/** The transform for a saved filter setting. */
export function transformFor(setting) {
  switch (setting?.preset) {
    case 'grayscale': return grayscale();
    case 'eink': return einkTransform(setting.einkWarmth ?? DEFAULT_EINK_WARMTH);
    case 'vibrant': return then(saturate(1.7), contrast(1.08));
    case 'dull': return then(then(saturate(0.45), contrast(0.88)), brightness(0.02));
    case 'colorblind':
      return setting.colorblind === 'achromatopsia'
        ? then(grayscale(), contrast(1.18))
        : daltonize(setting.colorblind || 'deuteranopia');
    case 'custom': return customTransform({ ...DEFAULT_CUSTOM, ...setting.custom });
    default: return affine(I());
  }
}

export const isIdentity = (t) => t.m.every((row, i) => row.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < 1e-6))
  && t.o.every((v) => Math.abs(v) < 1e-6);

/** Column-major Float32Array for gl.uniformMatrix3fv. */
export function toGL(t) {
  const { m } = t;
  return { m: new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]), o: t.o };
}

/** "values" for an SVG feColorMatrix (used by the no-WebGL fallback). */
export function toSvgValues(t) {
  const { m, o } = t;
  return [0, 1, 2].map((i) => `${m[i][0]} ${m[i][1]} ${m[i][2]} 0 ${o[i]}`).join(' ') + ' 0 0 0 1 0';
}

export function loadSetting() {
  try {
    const s = JSON.parse(localStorage.getItem('bindr:filter') || 'null');
    if (s && typeof s === 'object') {
      return { preset: 'none', colorblind: 'deuteranopia', einkWarmth: DEFAULT_EINK_WARMTH, einkFlash: true, ...s, custom: { ...DEFAULT_CUSTOM, ...s.custom } };
    }
  } catch {}
  return { preset: 'none', colorblind: 'deuteranopia', einkWarmth: DEFAULT_EINK_WARMTH, einkFlash: true, custom: { ...DEFAULT_CUSTOM } };
}

export function saveSetting(s) {
  try { localStorage.setItem('bindr:filter', JSON.stringify(s)); } catch {}
}

const SLIDERS = [
  { key: 'brightness', label: 'Brightness', min: -50, max: 50, unit: '%' },
  { key: 'contrast', label: 'Contrast', min: 50, max: 150, unit: '%' },
  { key: 'saturation', label: 'Saturation', min: 0, max: 200, unit: '%' },
  { key: 'hue', label: 'Hue', min: -180, max: 180, unit: '°' },
  { key: 'warmth', label: 'Warmth', min: 0, max: 100, unit: '%' },
  { key: 'tintStrength', label: 'Tint', min: 0, max: 100, unit: '%' },
];

/** The floating Color Filter panel in the reader. */
export class FilterPanel {
  /** embedded: rendered inside another panel (no own header/close button). */
  constructor(panel, button, onChange, { embedded = false } = {}) {
    this.embedded = embedded;
    this.panel = panel;
    this.button = button;
    this.onChange = onChange;
    this.setting = loadSetting();
    if (!embedded) button.onclick = () => this.toggle();
    this._build();
    this._sync();
  }

  get transform() { return transformFor(this.setting); }

  toggle(open = this.panel.hidden) {
    this.panel.hidden = !open;
    this.button.setAttribute('aria-pressed', String(open));
  }

  _build() {
    const c = this.setting.custom;
    this.panel.innerHTML = `${this.embedded ? '' : `
      <div class="fp-head"><b>Color Filter</b>
        <button class="icon-btn" data-close aria-label="Close color filter">
          <svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
        </button></div>`}
      <div class="chips" role="radiogroup" aria-label="Filter">
        ${PRESETS.map((p) => `<button class="chip" data-preset="${p.id}" role="radio"><span class="swatch sw-${p.id}"></span>${esc(p.label)}</button>`).join('')}
      </div>
      <div class="fp-sub" data-section="colorblind">
        <div class="fp-label">Type of color blindness</div>
        <div class="chips">${COLORBLIND.map((t) => `<button class="chip" data-cb="${t.id}" role="radio" title="${esc(t.hint)}">${esc(t.label)}<small>${esc(t.hint)}</small></button>`).join('')}</div>
      </div>
      <div class="fp-sub" data-section="eink">
        <label class="slider"><span>Warmth</span>
          <input type="range" data-eink="warmth" min="0" max="100" step="1" aria-label="E-ink warmth">
          <output data-out="eink-warmth"></output></label>
        <div class="eink-scale"><span>Cool</span><span>Warm</span></div>
        <label class="check"><input type="checkbox" data-eink="noflash"> <span>Disable flash <small>(the black-and-white refresh every 6 pages)</small></span></label>
      </div>
      <div class="fp-sub" data-section="custom">
        ${SLIDERS.map((s) => `
          <label class="slider"><span>${s.label}</span>
            <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="1" value="${c[s.key]}">
            <output data-out="${s.key}"></output></label>`).join('')}
        <div class="fp-row">
          <label class="color-pick"><span>Tint color</span><input type="color" data-key="tint" value="${esc(c.tint)}"></label>
          <label class="check"><input type="checkbox" data-key="invert" ${c.invert ? 'checked' : ''}> <span>Invert (night)</span></label>
          <button class="btn ghost" data-reset>Reset</button>
        </div>
      </div>`;
    const closeBtn = this.panel.querySelector('[data-close]');
    if (closeBtn) closeBtn.onclick = () => this.toggle(false);
    this.panel.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => this._set({ preset: b.dataset.preset })));
    this.panel.querySelectorAll('[data-cb]').forEach((b) => (b.onclick = () => this._set({ preset: 'colorblind', colorblind: b.dataset.cb })));
    this.panel.querySelector('[data-eink="warmth"]').addEventListener('input', (e) => {
      this._set({ preset: 'eink', einkWarmth: Number(e.target.value) });
    });
    this.panel.querySelector('[data-eink="noflash"]').addEventListener('change', (e) => {
      this._set({ preset: 'eink', einkFlash: !e.target.checked });
    });
    this.panel.querySelectorAll('[data-key]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.key;
        const value = input.type === 'checkbox' ? input.checked : input.type === 'color' ? input.value : Number(input.value);
        // Picking a tint color with no strength yet should visibly do something.
        const extra = key === 'tint' && !this.setting.custom.tintStrength ? { tintStrength: 35 } : {};
        this._set({ preset: 'custom', custom: { ...this.setting.custom, [key]: value, ...extra } });
      });
    });
    this.panel.querySelector('[data-reset]').onclick = () => {
      this._set({ preset: 'custom', custom: { ...DEFAULT_CUSTOM } });
      this._build();
      this._sync();
    };
  }

  _set(patch) {
    this.setting = { ...this.setting, ...patch };
    saveSetting(this.setting);
    this._sync();
    this.onChange(this.transform);
  }

  _sync() {
    const s = this.setting;
    this.panel.querySelectorAll('[data-preset]').forEach((b) => {
      const on = b.dataset.preset === s.preset;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    this.panel.querySelectorAll('[data-cb]').forEach((b) => {
      const on = b.dataset.cb === s.colorblind;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    this.panel.querySelector('[data-section="colorblind"]').hidden = s.preset !== 'colorblind';
    this.panel.querySelector('[data-section="custom"]').hidden = s.preset !== 'custom';
    this.panel.querySelector('[data-section="eink"]').hidden = s.preset !== 'eink';
    const warmth = s.einkWarmth ?? DEFAULT_EINK_WARMTH;
    this.panel.querySelector('[data-eink="warmth"]').value = String(warmth);
    this.panel.querySelector('[data-out="eink-warmth"]').textContent = `${warmth}%`;
    this.panel.querySelector('[data-eink="noflash"]').checked = s.einkFlash === false;
    for (const sl of SLIDERS) {
      const input = this.panel.querySelector(`[data-key="${sl.key}"]`);
      if (Number(input.value) !== s.custom[sl.key]) input.value = s.custom[sl.key];
      const v = s.custom[sl.key];
      this.panel.querySelector(`[data-out="${sl.key}"]`).textContent = `${sl.key === 'brightness' && v > 0 ? '+' : ''}${v}${sl.unit}`;
    }
    this.panel.querySelector('[data-key="tint"]').value = s.custom.tint;
    this.panel.querySelector('[data-key="invert"]').checked = !!s.custom.invert;
    this.button.classList.toggle('has-filter', !isIdentity(this.transform));
  }
}

/**
 * Apply the color filter to the whole app (it's one setting for every screen and book).
 * Pages get it in the page shader; the rest of the interface gets an SVG filter. Highlights
 * keep their real colors under Grayscale and Achromatopsia so they stay distinguishable.
 */
export function applyAppFilter(setting = loadSetting()) {
  const t = transformFor(setting);
  const eink = isEink(setting);
  let svg = document.getElementById('bindr-cm-svg');
  if (!svg) {
    document.body.insertAdjacentHTML('beforeend', '<svg id="bindr-cm-svg" width="0" height="0" style="position:absolute;width:0;height:0" aria-hidden="true">'
      + '<filter id="bindr-cm" color-interpolation-filters="sRGB"></filter></svg>');
    svg = document.getElementById('bindr-cm-svg');
  }
  // E-ink also limits the screen to a few gray steps.
  const steps = Array.from({ length: EINK_LEVELS }, (_, i) => (i / (EINK_LEVELS - 1)).toFixed(4)).join(' ');
  // (Gray first, then a few gray steps, then the paper/ink tint, so every shade stays neutral.)
  svg.querySelector('filter').innerHTML = eink
    ? `<feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="discrete" tableValues="${steps}"/>`
      + `<feFuncG type="discrete" tableValues="${steps}"/><feFuncB type="discrete" tableValues="${steps}"/></feComponentTransfer>`
      + `<feColorMatrix type="matrix" values="${toSvgValues(t)}"/>`
    : `<feColorMatrix type="matrix" values="${toSvgValues(t)}"/>`;
  const on = !isIdentity(t);
  const root = document.documentElement;
  const grayscale = eink || setting.preset === 'grayscale' || (setting.preset === 'colorblind' && setting.colorblind === 'achromatopsia');
  root.classList.toggle('cm', on);
  root.classList.toggle('cm-hl', on && !grayscale);
  root.classList.toggle('eink', eink);
  // The page background behind the interface gets the same treatment.
  if (on) {
    const hex = getComputedStyle(root).getPropertyValue('--bg').trim().replace('#', '');
    const rgb = hex.length === 6 ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) : [1, 1, 1];
    const f = applyRGB(t, rgb).map((v) => Math.round(v * 255));
    root.style.setProperty('--filtered-bg', `rgb(${f.join(',')})`);
  } else {
    root.style.removeProperty('--filtered-bg');
  }
  if (eink) root.style.setProperty('--eink-paper', `rgb(${einkColors(setting.einkWarmth).paper.map((v) => Math.round(v * 255)).join(',')})`);
  if (eink && !document.getElementById('eink-grain')) {
    document.body.insertAdjacentHTML('beforeend', '<div id="eink-grain" aria-hidden="true"></div>');
  }
  return t;
}
