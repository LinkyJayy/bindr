// Realistic page-curl renderer (WebGL).
//
// The page being turned is modelled as a sheet of paper rolling over a
// cylinder of radius R whose axis lies on the page. For every pixel we work
// out which part of the sheet (if any) is visible on top: the flat part that
// has already rolled over (back side), the cylinder (back side on the upper
// half, front side on the lower half), the untouched flat part, or the page
// underneath. Shading and shadows are derived from the same geometry.

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform sampler2D uFront;   // sheet being turned (front side)
uniform sampler2D uUnder;   // page revealed underneath the sheet
uniform sampler2D uBack;    // reverse side of the sheet (two-page spread only)
uniform sampler2D uLeft;    // page on the opposite side of the spine (spread only)
uniform vec2  uRes;         // canvas size (device px)
uniform vec4  uPage;        // rect of the page the sheet lies on: x, y, w, h (device px, top-left origin)
uniform vec2  uP;           // point on curl axis (page space)
uniform vec2  uD;           // unit vector pointing toward the lifted edge
uniform float uR;           // cylinder radius
uniform float uActive;      // 0 = flat, 1 = curling
uniform float uSpread;      // 1 = two-page spread with the spine at x = 0
uniform float uFlip;        // 1 = mirror everything about the spine (turning backwards in a spread)
uniform float uHasUnder;
uniform float uHasLeft;
uniform vec2  uShadowX;     // horizontal extent of the visible pages, for the drop shadow
uniform vec3  uBg;
uniform vec3  uPaperBack;   // tint of the reverse side of the paper (single page)
uniform float uDpr;
uniform float uMode;        // 0 = curl, 1 = slide
uniform float uShift;       // slide: horizontal shift of the current view (device px)
uniform float uBPos;        // slide: where the incoming view sits relative to the current one
uniform vec4  uHas;         // slide: current left, current right, incoming left, incoming right
uniform vec2  uShadowXB;    // slide: horizontal extent of the incoming view
uniform mat3  uCM;          // color filter: matrix…
uniform vec3  uCO;          // …and offset, applied to the page content only
uniform float uLevels;      // E-ink: number of gray steps (0 = off)
uniform float uChroma;      // Colorsoft: color steps per channel (0 = black and white)

const float PI = 3.14159265;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

bool inPage(vec2 p) {
  return p.x >= 0.0 && p.y >= 0.0 && p.x <= uPage.z && p.y <= uPage.w;
}
bool inLeft(vec2 p) {
  return uSpread > 0.5 && p.x < 0.0 && p.x >= -uPage.z && p.y >= 0.0 && p.y <= uPage.w;
}
vec2 uvOf(vec2 p) {
  vec2 uv = p / uPage.zw;
  if (uFlip > 0.5) uv.x = 1.0 - uv.x;
  return uv;
}
// 4×4 ordered-dither threshold in [0, 1).
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
vec3 filt(vec3 c) {
  if (uLevels > 1.5) {
    // E-ink: quantize the gray level first, then tint, so every shade stays neutral.
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Black and white: hard gray steps. Colorsoft: an ordered dither between steps, like the
    // fine grain of a color e-ink panel. Thresholds stay inside 0.1–0.9 so near-grays stay gray.
    float t = uChroma > 0.5 ? 0.1 + 0.8 * bayer4(floor(gl_FragCoord.xy / max(uDpr, 1.0))) : 0.5;
    float q = floor(l * (uLevels - 1.0) + t) / (uLevels - 1.0);
    if (uChroma > 0.5) {
      // Colorsoft: keep the color too, in a few steps around the gray level.
      vec3 ch = floor((c - l) * uChroma + t) / uChroma;
      c = clamp(vec3(q) + ch, 0.0, 1.0);
    } else {
      c = vec3(q);
    }
  }
  return clamp(uCM * c + uCO, 0.0, 1.0);
}
vec3 front(vec2 p) { return filt(texture2D(uFront, uvOf(p)).rgb); }
vec3 under(vec2 p) { return filt(texture2D(uUnder, uvOf(p)).rgb); }
vec3 leftPage(vec2 p) { return filt(texture2D(uLeft, uvOf(p + vec2(uPage.z, 0.0))).rgb); }
// Reverse side of the sheet. In a spread it's the next page; on a single page
// the print shows through faintly, mirrored (sampling at the original position
// does the mirroring for us).
vec3 backSide(vec2 p) {
  if (uSpread > 0.5) return filt(texture2D(uBack, uvOf(vec2(uPage.z - p.x, p.y))).rgb);
  return mix(front(p), filt(uPaperBack), 0.86);
}
// Shading where the pages dip into the binding.
float gutter(float sx) {
  if (uSpread < 0.5) return 1.0;
  float a = abs(sx) / uPage.z;
  return 1.0 - 0.16 * exp(-a / 0.03) - 0.05 * exp(-a / 0.2);
}

float boxDist(vec2 p, vec2 mn, vec2 mx) {
  vec2 c = (mn + mx) * 0.5;
  vec2 q = abs(p - c) - (mx - mn) * 0.5;
  return length(max(q, 0.0));
}
// Distance from p to the sheet's rectangle (0 inside).
float rectDist(vec2 p) { return boxDist(p, vec2(0.0), uPage.zw); }

void mainImage();
void main() {
  mainImage();
  gl_FragColor.rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
}

// One view (single page, or the two pages of a spread) for the slide animation.
vec4 slideView(vec2 p, sampler2D L, sampler2D R, float hasL, float hasR) {
  if (p.y < 0.0 || p.y > uPage.w) return vec4(0.0);
  if (hasR > 0.5 && p.x >= 0.0 && p.x <= uPage.z) return vec4(filt(texture2D(R, p / uPage.zw).rgb) * gutter(p.x), 1.0);
  if (hasL > 0.5 && p.x < 0.0 && p.x >= -uPage.z) return vec4(filt(texture2D(L, (p + vec2(uPage.z, 0.0)) / uPage.zw).rgb) * gutter(p.x), 1.0);
  return vec4(0.0);
}

void mainImage() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 xw = frag - uPage.xy;

  if (uMode > 0.5) {
    vec2 pa = xw - vec2(uShift, 0.0);
    vec2 pb = pa - vec2(uBPos, 0.0);
    vec4 a = slideView(pa, uLeft, uUnder, uHas.x, uHas.y);
    if (a.a > 0.5) { gl_FragColor = vec4(a.rgb, 1.0); return; }
    vec4 b = slideView(pb, uFront, uBack, uHas.z, uHas.w);
    if (b.a > 0.5) { gl_FragColor = vec4(b.rgb, 1.0); return; }
    float d1 = boxDist(pa, vec2(uShadowX.x, 0.0), vec2(uShadowX.y, uPage.w));
    float d2 = boxDist(pb, vec2(uShadowXB.x, 0.0), vec2(uShadowXB.y, uPage.w));
    gl_FragColor = vec4(uBg * (1.0 - 0.22 * exp(-min(d1, d2) / (7.0 * uDpr))), 1.0);
    return;
  }
  vec2 x = uFlip > 0.5 ? vec2(-xw.x, xw.y) : xw;

  // Soft drop shadow around the book on the background.
  float outside = boxDist(xw, vec2(uShadowX.x, 0.0), vec2(uShadowX.y, uPage.w));
  vec3 bg = uBg * (1.0 - 0.22 * exp(-outside / (7.0 * uDpr)));
  vec3 underC = uHasUnder > 0.5 ? under(x) * gutter(x.x) : bg;

  if (uActive < 0.5) {
    if (inPage(x)) gl_FragColor = vec4(underC, 1.0);
    else if (inLeft(x) && uHasLeft > 0.5) gl_FragColor = vec4(leftPage(x) * gutter(x.x), 1.0);
    else gl_FragColor = vec4(bg, 1.0);
    return;
  }

  float d = dot(x - uP, uD);
  float R = uR;

  // 1) Sheet that has rolled all the way over: flat, back side up, on top.
  if (d < 0.0) {
    vec2 xo = x + (PI * R - 2.0 * d) * uD;
    if (inPage(xo)) {
      // Matches the top of the cylinder (shade 1.0) so there's no seam.
      gl_FragColor = vec4(backSide(xo) * gutter(xo.x), 1.0);
      return;
    }
  }

  // 2) The cylinder itself.
  if (d >= 0.0 && d < R) {
    float th1 = asin(d / R);
    float th2 = PI - th1;
    // Upper half (back side facing the viewer).
    vec2 xo2 = x + (R * th2 - d) * uD;
    if (inPage(xo2)) {
      float n = -cos(th2);                       // 0 at the side, 1 at the top
      float shade = 0.72 + 0.28 * n;
      float spec = pow(max(0.0, 1.0 - abs(th2 - 0.75 * PI) * 2.2), 2.0) * 0.12;
      gl_FragColor = vec4(backSide(xo2) * shade + spec, 1.0);
      return;
    }
    // Lower half (front side, curving away from the viewer).
    vec2 xo1 = x + (R * th1 - d) * uD;
    if (inPage(xo1)) {
      float t = th1 / (PI * 0.5);
      float shade = 1.0 - 0.42 * t * t;
      gl_FragColor = vec4(front(xo1) * shade, 1.0);
      return;
    }
  }

  // Shadow cast by the folded-over flap onto whatever lies below it.
  float flapShadow = 1.0;
  if (d < 0.0) {
    vec2 flap = x + (PI * R - 2.0 * d) * uD;
    flapShadow = 1.0 - 0.28 * exp(-rectDist(flap) / (5.0 * uDpr));
  }

  // 3) Untouched flat part of the sheet.
  if (d < 0.0 && inPage(x)) {
    vec3 c = front(x) * gutter(x.x) * flapShadow;
    // Ambient occlusion right under the cylinder.
    c *= 1.0 - 0.18 * smoothstep(-R, 0.0, d);
    gl_FragColor = vec4(c, 1.0);
    return;
  }

  float e = max(d - R, 0.0);
  float curlShadow = 1.0 - 0.4 * exp(-e / (R * 0.9 + 6.0 * uDpr));

  // 4) Page underneath, darkened by the shadow of the curl.
  if (inPage(x)) {
    gl_FragColor = vec4(underC * curlShadow, 1.0);
    return;
  }

  // 5) Opposite page of a spread, which the turned sheet lands on.
  if (inLeft(x)) {
    vec3 c = uHasLeft > 0.5 ? leftPage(x) * gutter(x.x) : bg;
    gl_FragColor = vec4(c * (d < 0.0 ? flapShadow : curlShadow), 1.0);
    return;
  }

  gl_FragColor = vec4(bg, 1.0);
}
`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class CurlRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.prog = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const n of ['uFront', 'uUnder', 'uBack', 'uLeft', 'uRes', 'uPage', 'uP', 'uD', 'uR', 'uActive',
      'uSpread', 'uFlip', 'uHasUnder', 'uHasLeft', 'uShadowX', 'uBg', 'uPaperBack', 'uDpr', 'uCM', 'uCO',
      'uMode', 'uShift', 'uBPos', 'uHas', 'uShadowXB', 'uLevels', 'uChroma']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
    // Texture units, in slot order.
    ['uFront', 'uUnder', 'uBack', 'uLeft'].forEach((n, i) => gl.uniform1i(this.u[n], i));

    this.textures = [this._tex(), this._tex(), this._tex(), this._tex()];
    this.sources = [null, null, null, null];
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.bg = [0.95, 0.95, 0.95];
    this.paperBack = [0.98, 0.975, 0.965];
  }

  _tex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    return t;
  }

  /** Slots: 0 = sheet being turned, 1 = page underneath, 2 = back of the sheet, 3 = opposite page. */
  setTexture(slot, source) {
    if (this.sources[slot] === source) return;
    this.sources[slot] = source;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[slot]);
    if (source) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    }
  }

  /** Color filter: m = column-major 3×3 (Float32Array), o = offset [r, g, b]. */
  setFilter(m, o, levels = 0, chroma = 0) {
    this.filter = { m, o, levels, chroma };
  }

  setColors(bg, paperBack) {
    this.bg = bg;
    this.paperBack = paperBack;
  }

  /**
   * Draw a frame.
   * page: {x, y, w, h} in device px — the page the sheet lies on (in a spread, the right-hand
   *   page, so the spine is at its left edge).
   * curl: null (flat) or {P:[x,y], D:[x,y], R}.
   * opts: {spread, flip, hasUnder, hasLeft, shadowX:[minX, maxX]}.
   */
  draw(page, curl, dpr, opts = {}) {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.uniform2f(this.u.uRes, width, height);
    gl.uniform4f(this.u.uPage, page.x, page.y, page.w, page.h);
    gl.uniform3fv(this.u.uBg, this.bg);
    gl.uniform3fv(this.u.uPaperBack, this.paperBack);
    gl.uniform1f(this.u.uDpr, dpr);
    const f = this.filter || { m: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), o: [0, 0, 0] };
    gl.uniformMatrix3fv(this.u.uCM, false, f.m);
    gl.uniform3fv(this.u.uCO, f.o);
    gl.uniform1f(this.u.uLevels, f.levels || 0);
    gl.uniform1f(this.u.uChroma, f.chroma || 0);
    gl.uniform1f(this.u.uSpread, opts.spread ? 1 : 0);
    gl.uniform1f(this.u.uFlip, opts.flip ? 1 : 0);
    gl.uniform1f(this.u.uHasUnder, opts.hasUnder === false ? 0 : 1);
    gl.uniform1f(this.u.uHasLeft, opts.hasLeft ? 1 : 0);
    const [sx0, sx1] = opts.shadowX || [0, page.w];
    gl.uniform2f(this.u.uShadowX, sx0, sx1);
    gl.uniform1f(this.u.uMode, opts.mode === 'slide' ? 1 : 0);
    if (opts.mode === 'slide') {
      gl.uniform1f(this.u.uShift, opts.shift);
      gl.uniform1f(this.u.uBPos, opts.bpos);
      gl.uniform4fv(this.u.uHas, opts.has.map((v) => (v ? 1 : 0)));
      gl.uniform2f(this.u.uShadowXB, opts.shadowXB[0], opts.shadowXB[1]);
    }
    this.textures.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
    });
    if (curl) {
      gl.uniform1f(this.u.uActive, 1);
      gl.uniform2f(this.u.uP, curl.P[0], curl.P[1]);
      gl.uniform2f(this.u.uD, curl.D[0], curl.D[1]);
      gl.uniform1f(this.u.uR, curl.R);
    } else {
      gl.uniform1f(this.u.uActive, 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

/**
 * Turn the position of the grabbed corner into curl geometry.
 * C: where the grabbed point sits on the flat page, F: where it is now.
 * Positions are in page space (device px). Returns null when there's no curl.
 */
export function curlFromCorner(C, F, w, h) {
  const dx = C[0] - F[0];
  const dy = C[1] - F[1];
  const L = Math.hypot(dx, dy);
  if (L < 0.5) return null;
  const D = [dx / L, dy / L];
  const Rmax = Math.max(18, Math.min(w, h) * 0.11);
  const R = Math.min(Rmax, L / Math.PI);
  // Place the axis so the grabbed corner lands under the finger.
  const t = (L - Math.PI * R) / 2;
  return { P: [F[0] + t * D[0], F[1] + t * D[1]], D, R };
}

/** Keep the sheet attached at the spine (left edge) so it can't tear off. */
export function constrainToSpine(C, F, w, h) {
  const anchors = [[0, 0], [0, h], [0, C[1]]];
  let p = [F[0], F[1]];
  for (let pass = 0; pass < 3; pass++) {
    for (const S of anchors) {
      const r = Math.hypot(C[0] - S[0], C[1] - S[1]);
      const vx = p[0] - S[0];
      const vy = p[1] - S[1];
      const len = Math.hypot(vx, vy);
      if (len > r && len > 0) p = [S[0] + (vx / len) * r, S[1] + (vy / len) * r];
    }
  }
  return p;
}
