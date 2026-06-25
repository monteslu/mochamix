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
uniform sampler2D u_tex;      // peaks, length in u_texLen
uniform float u_texLen;       // number of peak buckets
uniform float u_framesPerBucket;
uniform float u_positionFrames;
uniform float u_framesPerPx;
uniform float u_firstBeat;    // grid phase (frames)
uniform float u_framesPerBeat;// 0 = no grid

vec3 ampColor(float a) {
  // low → teal/blue, high → warm (matches the Canvas2D palette)
  vec3 lo = mix(vec3(0.12,0.47,0.86), vec3(0.20,0.90,0.51), clamp(a/0.5,0.0,1.0));
  vec3 hi = mix(vec3(0.20,0.90,0.51), vec3(0.98,0.66,0.16), clamp((a-0.5)/0.5,0.0,1.0));
  return a < 0.5 ? lo : hi;
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
      float u = (b + 0.5) / u_texLen;
      float amp = texture2D(u_tex, vec2(u, 0.5)).r;        // 0..1
      float half = amp * mid * 0.92;
      if (abs(y - mid) <= half) {
        col = ampColor(amp);
        if (x < centerX) col *= 0.45;                       // played = dimmed
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
      gl = canvas.getContext('webgl', {
        antialias: false,
        depth: false,
        premultipliedAlpha: false,
      }) as WebGLRenderingContext | null;
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
        'u_res', 'u_tex', 'u_texLen', 'u_framesPerBucket',
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

  /** Upload peaks (one Uint8 per bucket) as a luminance texture. Once per track. */
  setPeaks(peaks: Uint8Array, framesPerBucket: number): void {
    if (!this.ok) return;
    const gl = this.gl;
    this.texLen = peaks.length;
    this.framesPerBucket = framesPerBucket;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.LUMINANCE, peaks.length, 1, 0,
      gl.LUMINANCE, gl.UNSIGNED_BYTE, peaks,
    );
  }

  private framesPerBucket = 1;

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
