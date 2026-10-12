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
uniform sampler2D uFront;   // sheet being turned
uniform sampler2D uUnder;   // page revealed underneath
uniform vec2  uRes;         // canvas size (device px)
uniform vec4  uPage;        // page rect: x, y, w, h (device px, top-left origin)
uniform vec2  uP;           // point on curl axis (page space)
uniform vec2  uD;           // unit vector pointing toward the lifted edge
uniform float uR;           // cylinder radius
uniform float uActive;      // 0 = flat page, 1 = curling
uniform vec3  uBg;
uniform vec3  uPaperBack;   // tint of the reverse side of the paper
uniform float uDpr;

const float PI = 3.14159265;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

bool inPage(vec2 p) {
  return p.x >= 0.0 && p.y >= 0.0 && p.x <= uPage.z && p.y <= uPage.w;
}
vec3 front(vec2 p) { return texture2D(uFront, p / uPage.zw).rgb; }
vec3 under(vec2 p) { return texture2D(uUnder, p / uPage.zw).rgb; }
// Reverse side: the print shows through faintly, mirrored (sampling at the
// original position does the mirroring for us).
vec3 backSide(vec2 p) { return mix(front(p), uPaperBack, 0.86); }

// Distance from p to the page rectangle (0 inside).
float rectDist(vec2 p) {
  vec2 half_ = uPage.zw * 0.5;
  vec2 q = abs(p - half_) - half_;
  return length(max(q, 0.0));
}

void mainImage();
void main() {
  mainImage();
  gl_FragColor.rgb += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
}

void mainImage() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 x = frag - uPage.xy;

  // Soft drop shadow around the page on the background.
  float outside = rectDist(x);
  vec3 bg = uBg * (1.0 - 0.22 * exp(-outside / (7.0 * uDpr)));

  if (uActive < 0.5) {
    gl_FragColor = vec4(inPage(x) ? under(x) : bg, 1.0);
    return;
  }

  float d = dot(x - uP, uD);
  float R = uR;

  // 1) Sheet that has rolled all the way over: flat, back side up, on top.
  if (d < 0.0) {
    vec2 xo = x + (PI * R - 2.0 * d) * uD;
    if (inPage(xo)) {
      // Matches the top of the cylinder (shade 1.0) so there's no seam.
      gl_FragColor = vec4(backSide(xo), 1.0);
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

  // 3) Untouched flat part of the sheet.
  if (d < 0.0 && inPage(x)) {
    vec3 c = front(x);
    // Shadow cast by the folded-over flap onto the page below it.
    vec2 flap = x + (PI * R - 2.0 * d) * uD;
    float dist = rectDist(flap);
    c *= 1.0 - 0.28 * exp(-dist / (5.0 * uDpr));
    // Ambient occlusion right under the cylinder.
    c *= 1.0 - 0.18 * smoothstep(-R, 0.0, d);
    gl_FragColor = vec4(c, 1.0);
    return;
  }

  // 4) Page underneath, darkened by the shadow of the curl.
  if (inPage(x)) {
    vec3 c = under(x);
    float e = max(d - R, 0.0);
    float sh = exp(-e / (R * 0.9 + 6.0 * uDpr));
    c *= 1.0 - 0.4 * sh;
    gl_FragColor = vec4(c, 1.0);
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
    for (const n of ['uFront', 'uUnder', 'uRes', 'uPage', 'uP', 'uD', 'uR', 'uActive', 'uBg', 'uPaperBack', 'uDpr']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
    gl.uniform1i(this.u.uFront, 0);
    gl.uniform1i(this.u.uUnder, 1);

    this.textures = [this._tex(), this._tex()];
    this.sources = [null, null];
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

  /** slot 0 = sheet being turned, slot 1 = page underneath. */
  setTexture(slot, source) {
    if (this.sources[slot] === source) return;
    this.sources[slot] = source;
    const gl = this.gl;
    gl.activeTexture(slot ? gl.TEXTURE1 : gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[slot]);
    if (source) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    }
  }

  setColors(bg, paperBack) {
    this.bg = bg;
    this.paperBack = paperBack;
  }

  /**
   * Draw a frame.
   * page: {x, y, w, h} in device px. curl: null (flat, shows slot 1) or {P:[x,y], D:[x,y], R}.
   */
  draw(page, curl, dpr) {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.uniform2f(this.u.uRes, width, height);
    gl.uniform4f(this.u.uPage, page.x, page.y, page.w, page.h);
    gl.uniform3fv(this.u.uBg, this.bg);
    gl.uniform3fv(this.u.uPaperBack, this.paperBack);
    gl.uniform1f(this.u.uDpr, dpr);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
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
