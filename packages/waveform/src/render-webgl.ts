/**
 * WebGL scrolling-waveform renderer. Per the project requirement, waveforms are
 * drawn on the GPU (not Canvas2D / per-pixel JS). The peak data is uploaded ONCE
 * per track as a texture; each frame we only update a few uniforms (play position,
 * zoom, beat grid) and issue a single draw call. The fragment shader does the
 * per-pixel work (amplitude → color, played dimming, beat grid, playhead) on the
 * GPU, so scrolling stays smooth regardless of width.
 *
 * One full-screen quad; the fragment shader maps gl_FragCoord → source frame →
 * peak texel → bar.
 */

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

// Fragment shader: u_tex holds the peaks (R channel, 0..1) along x. We compute
// the source frame for this pixel from the play position + zoom, sample the peak,
// and shade.
const FRAG = `
precision highp float;
uniform vec2  u_res;          // canvas size (px)
uniform sampler2D u_tex;      // RGB = low/mid/high band peaks; A = overall amp
uniform float u_texLen;       // number of peak buckets
uniform vec2  u_texSize;      // texture dimensions (buckets packed as a 2D grid)
uniform float u_framesPerBucket;
uniform float u_positionFrames;
uniform float u_framesPerPx;
uniform float u_firstBeat;    // grid phase (frames)
uniform float u_framesPerBeat;// 0 = no grid

// frequency-band color: low=red/warm, mid=green, high=blue (rekordbox/Serato/
// Mixxx convention). Blend the three band energies into one RGB color.
vec3 bandColor(vec3 lmh) {
  vec3 lowC  = vec3(1.00, 0.27, 0.20);  // bass → red
  vec3 midC  = vec3(0.25, 0.90, 0.40);  // mids → green
  vec3 highC = vec3(0.30, 0.62, 1.00);  // highs → blue
  vec3 c = lowC * lmh.r + midC * lmh.g + highC * lmh.b;
  float m = max(lmh.r, max(lmh.g, lmh.b));
  // normalize toward the dominant band so quiet sums don't go grey/dark
  return m > 0.001 ? c / m : c;
}

void main() {
  float x = gl_FragCoord.x;
  float y = gl_FragCoord.y;
  float centerX = u_res.x * 0.5;
  float mid = u_res.y * 0.5;

  // source frame under this pixel
  float frame = u_positionFrames + (x - centerX) * u_framesPerPx;

  // background gradient
  float vign = abs(y - mid) / mid;
  vec3 col = mix(vec3(0.024,0.035,0.055), vec3(0.047,0.063,0.086), vign);

  if (frame >= 0.0) {
    float b = floor(frame / u_framesPerBucket);
    if (b >= 0.0 && b < u_texLen) {
      // buckets are packed row-major into a 2D texture (1D would exceed
      // MAX_TEXTURE_SIZE for long tracks). Recover the (col,row) for bucket b.
      float tw = u_texSize.x;
      float col = mod(b, tw);
      float row = floor(b / tw);
      vec2 uv = vec2((col + 0.5) / tw, (row + 0.5) / u_texSize.y);
      vec4 t = texture2D(u_tex, uv);                     // rgb=bands, a=amp
      float amp = t.a;
      float half = amp * mid * 0.92;
      if (abs(y - mid) <= half) {
        col = bandColor(t.rgb);
        if (x < centerX) col *= 0.5;                       // played = dimmed
      }
    }
  }

  // beat grid
  if (u_framesPerBeat > 0.0) {
    float beat = (frame - u_firstBeat) / u_framesPerBeat;
    float nearest = floor(beat + 0.5);
    float beatFrame = u_firstBeat + nearest * u_framesPerBeat;
    float beatX = centerX + (beatFrame - u_positionFrames) / u_framesPerPx;
    float d = abs(x - beatX);
    float isDown = mod(nearest, 4.0);
    if (isDown < 0.5) {
      if (d < 1.0) col = mix(col, vec3(1.0,0.24,0.24), 0.85); // red measure marker
    } else {
      if (d < 0.5) col = mix(col, vec3(1.0), 0.4);            // white beat tick
    }
  }

  // center playhead
  float dp = abs(x - centerX);
  if (dp < 0.75) col = vec3(1.0,0.35,0.35);
  else if (dp < 2.0) col = mix(col, vec3(1.0,0.35,0.35), 0.18);

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('waveform shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export interface ScrollGLParams {
  positionFrames: number;
  framesPerPx: number;
  firstBeatFrame?: number;
  framesPerBeat?: number;
}

/**
 * A GPU waveform renderer bound to one canvas. Call setPeaks() on track load and
 * draw() each frame. Falls back gracefully (isOk=false) if WebGL is unavailable.
 */
export class WaveformGL {
  private readonly gl: WebGLRenderingContext;
  private readonly prog: WebGLProgram;
  private readonly tex: WebGLTexture;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private texLen = 0;
  readonly ok: boolean;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    // NEVER throw from here: any WebGL failure (no context, shader compile, link)
    // must degrade to ok=false so the caller falls back to Canvas2D. A throw would
    // crash the React tree that constructs this.
    let gl: WebGLRenderingContext | null = null;
    try {
      // Match the context attrs that butterchurn (WebGL, proven working on this
      // same AMD+Wayland machine) uses. The key one is alpha:FALSE — an
      // alpha:true canvas forces Chromium to import an alpha-format dmabuf for
      // compositing, which is the eglCreateImage EGL_BAD_MATCH (0x3009) that
      // crash-loops the GPU process on this driver. An OPAQUE canvas imports
      // fine. Prefer webgl2 (like butterchurn), fall back to webgl1.
      const attrs: WebGLContextAttributes = {
        antialias: false,
        depth: false,
        stencil: false,
        alpha: false,
        premultipliedAlpha: false,
      };
      gl = (canvas.getContext('webgl2', attrs) ??
        canvas.getContext('webgl', attrs)) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) {
      this.ok = false;
      this.gl = null as unknown as WebGLRenderingContext;
      this.prog = null as unknown as WebGLProgram;
      this.tex = null as unknown as WebGLTexture;
      return;
    }

    try {
      const prog = gl.createProgram()!;
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('waveform program: ' + gl.getProgramInfoLog(prog));
      }
      gl.useProgram(prog);

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      for (const name of [
        'u_res', 'u_tex', 'u_texLen', 'u_texSize', 'u_framesPerBucket',
        'u_positionFrames', 'u_framesPerPx', 'u_firstBeat', 'u_framesPerBeat',
      ]) {
        this.u[name] = gl.getUniformLocation(prog, name);
      }

      this.gl = gl;
      this.prog = prog;
      this.tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.ok = true;
    } catch {
      this.ok = false;
      this.gl = null as unknown as WebGLRenderingContext;
      this.prog = null as unknown as WebGLProgram;
      this.tex = null as unknown as WebGLTexture;
    }
  }

  /**
   * Upload band peaks as an RGBA texture (R=low, G=mid, B=high, A=overall amp),
   * one texel per bucket. Once per track. If the band arrays are absent we fall
   * back to amplitude in all channels (monochrome-ish).
   */
  setPeaks(
    peaks: Uint8Array,
    framesPerBucket: number,
    low?: Uint8Array,
    mid?: Uint8Array,
    high?: Uint8Array,
  ): void {
    if (!this.ok) return;
    const gl = this.gl;
    const n = peaks.length;
    this.texLen = n;
    this.framesPerBucket = framesPerBucket;
    // Pack buckets into a 2D texture (a 1D strip of width n overflows
    // MAX_TEXTURE_SIZE — ~16k — for tracks longer than ~37s, which silently
    // failed and left the waveform BLANK). Width 2048, height = ceil(n/2048).
    const tw = 2048;
    const th = Math.max(1, Math.ceil(n / tw));
    this.texW = tw;
    this.texH = th;
    const rgba = new Uint8Array(tw * th * 4);
    for (let i = 0; i < n; i++) {
      rgba[i * 4 + 0] = low ? low[i]! : peaks[i]!;
      rgba[i * 4 + 1] = mid ? mid[i]! : peaks[i]!;
      rgba[i * 4 + 2] = high ? high[i]! : peaks[i]!;
      rgba[i * 4 + 3] = peaks[i]!;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  private texW = 1;
  private texH = 1;

  private framesPerBucket = 1;

  /** Clear to the panel grey (no track loaded) so the band never shows white. */
  clear(): void {
    if (!this.ok) return;
    const gl = this.gl;
    const w = (gl.canvas as HTMLCanvasElement).width;
    const h = (gl.canvas as HTMLCanvasElement).height;
    gl.viewport(0, 0, w, h);
    // #0a0d13 (matches the CSS panel bg)
    gl.clearColor(0x0a / 255, 0x0d / 255, 0x13 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  draw(p: ScrollGLParams): void {
    if (!this.ok || this.texLen === 0) return;
    const gl = this.gl;
    const w = (gl.canvas as HTMLCanvasElement).width;
    const h = (gl.canvas as HTMLCanvasElement).height;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.u_tex!, 0);
    gl.uniform2f(this.u.u_res!, w, h);
    gl.uniform1f(this.u.u_texLen!, this.texLen);
    gl.uniform2f(this.u.u_texSize!, this.texW, this.texH);
    gl.uniform1f(this.u.u_framesPerBucket!, this.framesPerBucket);
    gl.uniform1f(this.u.u_positionFrames!, p.positionFrames);
    gl.uniform1f(this.u.u_framesPerPx!, p.framesPerPx);
    gl.uniform1f(this.u.u_firstBeat!, p.firstBeatFrame ?? 0);
    gl.uniform1f(this.u.u_framesPerBeat!, p.framesPerBeat ?? 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    if (!this.ok) return;
    const gl = this.gl;
    gl.deleteTexture(this.tex);
    gl.deleteProgram(this.prog);
  }
}
