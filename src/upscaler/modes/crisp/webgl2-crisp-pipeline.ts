import type { FramePipeline, PipelineStatus } from '../../pipeline';

const MIN_SCALE = 1;
const MAX_SCALE = 2;
const DEFAULT_SCALE = 1.5;
const DEFAULT_SHARPNESS = 0.2;

const FULLSCREEN_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);

const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

/*
 * FidelityFX FSR 1 inspired WebGL2 port.
 *
 * Based on AMD FidelityFX Super Resolution 1.0 ffx_fsr1.h
 * Copyright (c) 2021 Advanced Micro Devices, Inc. MIT licensed.
 * Local port copyright (c) 2026 Rajesh Peter D'Monte, MIT licensed.
 */
const EASU_APPROX_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_video;
uniform vec2 u_source_texel;
uniform vec2 u_output_size;

in vec2 v_uv;
out vec4 out_color;

float luma(vec3 color) {
  return color.b * 0.5 + (color.r * 0.5 + color.g);
}

vec3 sampleSource(vec2 pixel) {
  vec2 sourceSize = 1.0 / u_source_texel;
  vec2 clampedPixel = clamp(pixel, vec2(0.0), sourceSize - vec2(1.0));
  return texture(u_video, (clampedPixel + vec2(0.5)) / sourceSize).rgb;
}

void easuSet(inout vec2 dir, inout float len, float weight, float lA, float lB, float lC, float lD, float lE) {
  float dc = lD - lC;
  float cb = lC - lB;
  float lenXBase = max(abs(dc), abs(cb));
  float dirX = lD - lB;
  float lenX = clamp(abs(dirX) / max(lenXBase, 0.0001), 0.0, 1.0);
  dir.x += dirX * weight;
  len += lenX * lenX * weight;

  float ec = lE - lC;
  float ca = lC - lA;
  float lenYBase = max(abs(ec), abs(ca));
  float dirY = lE - lA;
  float lenY = clamp(abs(dirY) / max(lenYBase, 0.0001), 0.0, 1.0);
  dir.y += dirY * weight;
  len += lenY * lenY * weight;
}

float easuTapWeight(vec2 off, vec2 dir, vec2 len2, float lob, float clp) {
  vec2 v = vec2(
    off.x * dir.x + off.y * dir.y,
    off.x * -dir.y + off.y * dir.x
  );
  v *= len2;
  float d2 = min(dot(v, v), clp);
  float wb = 0.4 * d2 - 1.0;
  float wa = lob * d2 - 1.0;
  wb *= wb;
  wa *= wa;
  wb = 1.5625 * wb - 0.5625;
  return wb * wa;
}

void main() {
  vec2 sourceSize = 1.0 / u_source_texel;
  vec2 pp = gl_FragCoord.xy * (sourceSize / u_output_size) +
    (0.5 * sourceSize / u_output_size - vec2(0.5));
  vec2 fp = floor(pp);
  pp -= fp;

  vec3 b = sampleSource(fp + vec2(0.0, -1.0));
  vec3 c = sampleSource(fp + vec2(1.0, -1.0));
  vec3 e = sampleSource(fp + vec2(-1.0, 0.0));
  vec3 f = sampleSource(fp + vec2(0.0, 0.0));
  vec3 g = sampleSource(fp + vec2(1.0, 0.0));
  vec3 h = sampleSource(fp + vec2(2.0, 0.0));
  vec3 i = sampleSource(fp + vec2(-1.0, 1.0));
  vec3 j = sampleSource(fp + vec2(0.0, 1.0));
  vec3 k = sampleSource(fp + vec2(1.0, 1.0));
  vec3 l = sampleSource(fp + vec2(2.0, 1.0));
  vec3 n = sampleSource(fp + vec2(0.0, 2.0));
  vec3 o = sampleSource(fp + vec2(1.0, 2.0));

  float bL = luma(b);
  float cL = luma(c);
  float eL = luma(e);
  float fL = luma(f);
  float gL = luma(g);
  float hL = luma(h);
  float iL = luma(i);
  float jL = luma(j);
  float kL = luma(k);
  float lL = luma(l);
  float nL = luma(n);
  float oL = luma(o);

  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  easuSet(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  easuSet(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  easuSet(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);

  float dir2 = dot(dir, dir);
  if (dir2 < 1.0 / 32768.0) {
    dir = vec2(1.0, 0.0);
  } else {
    dir *= inversesqrt(dir2);
  }

  len *= 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(max(abs(dir.x), abs(dir.y)), 0.0001);
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((0.25 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;

  vec3 min4 = min(min(f, g), min(j, k));
  vec3 max4 = max(max(f, g), max(j, k));
  vec3 color = vec3(0.0);
  float weight = 0.0;

  float wb = easuTapWeight(vec2(0.0, -1.0) - pp, dir, len2, lob, clp);
  color += b * wb; weight += wb;
  float wc = easuTapWeight(vec2(1.0, -1.0) - pp, dir, len2, lob, clp);
  color += c * wc; weight += wc;
  float wi = easuTapWeight(vec2(-1.0, 1.0) - pp, dir, len2, lob, clp);
  color += i * wi; weight += wi;
  float wj = easuTapWeight(vec2(0.0, 1.0) - pp, dir, len2, lob, clp);
  color += j * wj; weight += wj;
  float wf = easuTapWeight(vec2(0.0, 0.0) - pp, dir, len2, lob, clp);
  color += f * wf; weight += wf;
  float we = easuTapWeight(vec2(-1.0, 0.0) - pp, dir, len2, lob, clp);
  color += e * we; weight += we;
  float wk = easuTapWeight(vec2(1.0, 1.0) - pp, dir, len2, lob, clp);
  color += k * wk; weight += wk;
  float wl = easuTapWeight(vec2(2.0, 1.0) - pp, dir, len2, lob, clp);
  color += l * wl; weight += wl;
  float wh = easuTapWeight(vec2(2.0, 0.0) - pp, dir, len2, lob, clp);
  color += h * wh; weight += wh;
  float wg = easuTapWeight(vec2(1.0, 0.0) - pp, dir, len2, lob, clp);
  color += g * wg; weight += wg;
  float wo = easuTapWeight(vec2(1.0, 2.0) - pp, dir, len2, lob, clp);
  color += o * wo; weight += wo;
  float wn = easuTapWeight(vec2(0.0, 2.0) - pp, dir, len2, lob, clp);
  color += n * wn; weight += wn;

  out_color = vec4(clamp(color / max(weight, 0.0001), min4, max4), 1.0);
}
`;

const RCAS_APPROX_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_upscaled;
uniform vec2 u_output_texel;
uniform float u_sharpness;

in vec2 v_uv;
out vec4 out_color;

float luma(vec3 color) {
  return color.b * 0.5 + (color.r * 0.5 + color.g);
}

void main() {
  vec2 texel = u_output_texel;
  vec3 b = texture(u_upscaled, v_uv - vec2(0.0, texel.y)).rgb;
  vec3 d = texture(u_upscaled, v_uv - vec2(texel.x, 0.0)).rgb;
  vec3 e = texture(u_upscaled, v_uv).rgb;
  vec3 f = texture(u_upscaled, v_uv + vec2(texel.x, 0.0)).rgb;
  vec3 h = texture(u_upscaled, v_uv + vec2(0.0, texel.y)).rgb;

  float bL = luma(b);
  float dL = luma(d);
  float eL = luma(e);
  float fL = luma(f);
  float hL = luma(h);
  float rangeMax = max(max(max(bL, dL), max(eL, fL)), hL);
  float rangeMin = min(min(min(bL, dL), min(eL, fL)), hL);
  float noise = abs(0.25 * (bL + dL + fL + hL) - eL) / max(rangeMax - rangeMin, 0.0001);
  noise = 1.0 - 0.5 * clamp(noise, 0.0, 1.0);

  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));
  vec3 hitMin = min(mn4, e) / max(4.0 * mx4, vec3(0.0001));
  vec3 hitMax = (vec3(1.0) - max(mx4, e)) / min(4.0 * mn4 - vec3(4.0), vec3(-0.0001));
  vec3 lobeRgb = max(-hitMin, hitMax);
  float sharpness = mix(0.15, 1.0, clamp(u_sharpness, 0.0, 1.0));
  float lobe = max(-0.1875, min(max(lobeRgb.r, max(lobeRgb.g, lobeRgb.b)), 0.0)) * sharpness * noise;
  float rcpL = 1.0 / (4.0 * lobe + 1.0);
  vec3 color = clamp((lobe * (b + d + h + f) + e) * rcpL, vec3(0.0), vec3(1.0));

  out_color = vec4(color, 1.0);
}
`;

export interface WebGL2CrispPipelineOptions {
  readonly alpha?: boolean;
  readonly desynchronized?: boolean;
  readonly scale?: number;
  readonly sharpness?: number;
}

export interface CrispOutputSize {
  readonly width: number;
  readonly height: number;
}

export class WebGL2CrispPipelineError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WebGL2CrispPipelineError';
    this.cause = cause;
  }
}

export class WebGL2CrispPipeline implements FramePipeline {
  readonly status: PipelineStatus = {
    backend: 'webgl2',
    mode: 'crisp',
    reason: 'FSR 1.0-style WebGL2 upscale active.',
  };

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly easuProgram: WebGLProgram;
  private readonly rcasProgram: WebGLProgram;
  private readonly sourceTexture: WebGLTexture;
  private readonly upscaledTexture: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly easuSourceTexelLocation: WebGLUniformLocation;
  private readonly easuOutputSizeLocation: WebGLUniformLocation;
  private readonly rcasOutputTexelLocation: WebGLUniformLocation;
  private readonly rcasSharpnessLocation: WebGLUniformLocation;

  private requestedWidth = 1;
  private requestedHeight = 1;
  private outputWidth = 0;
  private outputHeight = 0;
  private scale: number;
  private sharpness: number;
  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement,
    options: WebGL2CrispPipelineOptions = {},
  ) {
    this.canvas = canvas;
    this.video = video;
    this.scale = normalizeCrispScale(options.scale);
    this.sharpness = normalizeCrispSharpness(options.sharpness);

    const gl = canvas.getContext('webgl2', {
      alpha: options.alpha ?? true,
      antialias: false,
      depth: false,
      desynchronized: options.desynchronized ?? true,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      stencil: false,
    });

    if (!gl) {
      throw new WebGL2CrispPipelineError('WebGL2 is unavailable for the Crisp pipeline.');
    }

    this.gl = gl;
    this.easuProgram = createProgram(gl, VERTEX_SHADER_SOURCE, EASU_APPROX_FRAGMENT_SHADER_SOURCE);
    this.rcasProgram = createProgram(gl, VERTEX_SHADER_SOURCE, RCAS_APPROX_FRAGMENT_SHADER_SOURCE);
    this.sourceTexture = createTexture(gl, gl.LINEAR);
    this.upscaledTexture = createTexture(gl, gl.LINEAR);
    this.framebuffer = createFramebuffer(gl);
    this.vertexArray = createVertexArray(gl);
    this.vertexBuffer = createVertexBuffer(gl);

    bindFullscreenTriangle(gl, this.easuProgram, this.vertexArray, this.vertexBuffer);
    bindSampler(gl, this.easuProgram, 'u_video', 0);
    bindSampler(gl, this.rcasProgram, 'u_upscaled', 0);

    this.easuSourceTexelLocation = getUniformLocation(gl, this.easuProgram, 'u_source_texel');
    this.easuOutputSizeLocation = getUniformLocation(gl, this.easuProgram, 'u_output_size');
    this.rcasOutputTexelLocation = getUniformLocation(gl, this.rcasProgram, 'u_output_texel');
    this.rcasSharpnessLocation = getUniformLocation(gl, this.rcasProgram, 'u_sharpness');

    this.resize(canvas.width, canvas.height);
  }

  resize(width: number, height: number): void {
    assertAlive(this.destroyed);
    this.requestedWidth = Math.max(1, Math.floor(width));
    this.requestedHeight = Math.max(1, Math.floor(height));
    this.ensureOutputSize();
  }

  setScale(scale: number): void {
    assertAlive(this.destroyed);
    this.scale = normalizeCrispScale(scale);
    this.ensureOutputSize(true);
  }

  setSharpness(sharpness: number): void {
    assertAlive(this.destroyed);
    this.sharpness = normalizeCrispSharpness(sharpness);
  }

  renderFrame(): void {
    assertAlive(this.destroyed);

    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }

    const gl = this.gl;
    const output = this.ensureOutputSize();
    const sourceWidth = Math.max(1, this.video.videoWidth);
    const sourceHeight = Math.max(1, this.video.videoHeight);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);

    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    } catch (error) {
      throw new WebGL2CrispPipelineError(
        'Unable to upload the current video frame to WebGL2. The video may be DRM-protected, cross-origin without CORS, or not ready for canvas upload.',
        error,
      );
    }

    assertNoGlError(gl, 'uploading the Crisp source frame');

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.upscaledTexture,
      0,
    );
    assertFramebufferComplete(gl);
    gl.viewport(0, 0, output.width, output.height);
    gl.useProgram(this.easuProgram);
    gl.bindVertexArray(this.vertexArray);
    gl.uniform2f(this.easuSourceTexelLocation, 1 / sourceWidth, 1 / sourceHeight);
    gl.uniform2f(this.easuOutputSizeLocation, output.width, output.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    assertNoGlError(gl, 'running the Crisp EASU-style pass');

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, output.width, output.height);
    gl.bindTexture(gl.TEXTURE_2D, this.upscaledTexture);
    gl.useProgram(this.rcasProgram);
    gl.uniform2f(this.rcasOutputTexelLocation, 1 / output.width, 1 / output.height);
    gl.uniform1f(this.rcasSharpnessLocation, this.sharpness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    assertNoGlError(gl, 'running the Crisp RCAS-style pass');
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);

    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteVertexArray(this.vertexArray);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.upscaledTexture);
    gl.deleteTexture(this.sourceTexture);
    gl.deleteProgram(this.rcasProgram);
    gl.deleteProgram(this.easuProgram);

    this.destroyed = true;
  }

  private ensureOutputSize(forceTextureResize = false): CrispOutputSize {
    const output = computeCrispOutputSize({
      requestedHeight: this.requestedHeight,
      requestedWidth: this.requestedWidth,
      scale: this.scale,
      sourceHeight: this.video.videoHeight,
      sourceWidth: this.video.videoWidth,
    });

    if (this.canvas.width !== output.width) {
      this.canvas.width = output.width;
    }

    if (this.canvas.height !== output.height) {
      this.canvas.height = output.height;
    }

    if (forceTextureResize || output.width !== this.outputWidth || output.height !== this.outputHeight) {
      this.outputWidth = output.width;
      this.outputHeight = output.height;
      allocateTextureStorage(this.gl, this.upscaledTexture, output.width, output.height);
    }

    return output;
  }
}

export const createWebGL2CrispPipeline = (
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  options?: WebGL2CrispPipelineOptions,
): WebGL2CrispPipeline => new WebGL2CrispPipeline(canvas, video, options);

export const normalizeCrispScale = (scale: number | undefined): number => {
  if (scale === undefined || !Number.isFinite(scale)) {
    return DEFAULT_SCALE;
  }

  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
};

export const normalizeCrispSharpness = (sharpness: number | undefined): number => {
  if (sharpness === undefined || !Number.isFinite(sharpness)) {
    return DEFAULT_SHARPNESS;
  }

  return Math.min(1, Math.max(0, sharpness));
};

export interface ComputeCrispOutputSizeInput {
  readonly requestedWidth: number;
  readonly requestedHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly scale: number;
}

export const computeCrispOutputSize = ({
  requestedHeight,
  requestedWidth,
  scale,
  sourceHeight,
  sourceWidth,
}: ComputeCrispOutputSizeInput): CrispOutputSize => {
  const normalizedScale = normalizeCrispScale(scale);
  const widthBasis = sourceWidth > 0 ? sourceWidth : requestedWidth;
  const heightBasis = sourceHeight > 0 ? sourceHeight : requestedHeight;

  return {
    height: Math.max(1, Math.round(heightBasis * normalizedScale)),
    width: Math.max(1, Math.round(widthBasis * normalizedScale)),
  };
};

const createShader = (
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
): WebGLShader => {
  const shader = gl.createShader(type);

  if (!shader) {
    throw new WebGL2CrispPipelineError('WebGL2 failed to allocate a Crisp shader object.');
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'No shader compiler log was returned.';
    gl.deleteShader(shader);
    throw new WebGL2CrispPipelineError(`WebGL2 Crisp shader compilation failed: ${log}`);
  }

  return shader;
};

const createProgram = (
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram => {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'No shader linker log was returned.';
    gl.deleteProgram(program);
    throw new WebGL2CrispPipelineError(`WebGL2 Crisp shader program linking failed: ${log}`);
  }

  return program;
};

const createTexture = (
  gl: WebGL2RenderingContext,
  filter: GLenum,
): WebGLTexture => {
  const texture = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return texture;
};

const allocateTextureStorage = (
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number,
): void => {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  assertNoGlError(gl, 'allocating the Crisp upscale texture');
};

const createFramebuffer = (gl: WebGL2RenderingContext): WebGLFramebuffer => {
  const framebuffer = gl.createFramebuffer();

  return framebuffer;
};

const createVertexArray = (gl: WebGL2RenderingContext): WebGLVertexArrayObject => {
  const vertexArray = gl.createVertexArray();

  return vertexArray;
};

const createVertexBuffer = (gl: WebGL2RenderingContext): WebGLBuffer => {
  const vertexBuffer = gl.createBuffer();

  return vertexBuffer;
};

const bindFullscreenTriangle = (
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  vertexArray: WebGLVertexArrayObject,
  vertexBuffer: WebGLBuffer,
): void => {
  const positionLocation = gl.getAttribLocation(program, 'a_position');

  if (positionLocation < 0) {
    throw new WebGL2CrispPipelineError('WebGL2 Crisp program is missing a_position.');
  }

  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
};

const bindSampler = (
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  uniformName: string,
  textureUnit: number,
): void => {
  gl.useProgram(program);
  gl.uniform1i(getUniformLocation(gl, program, uniformName), textureUnit);
};

const getUniformLocation = (
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  uniformName: string,
): WebGLUniformLocation => {
  const location = gl.getUniformLocation(program, uniformName);

  if (!location) {
    throw new WebGL2CrispPipelineError(`WebGL2 Crisp program is missing ${uniformName}.`);
  }

  return location;
};

const assertAlive = (destroyed: boolean): void => {
  if (destroyed) {
    throw new WebGL2CrispPipelineError('WebGL2 Crisp pipeline has already been destroyed.');
  }
};

const assertFramebufferComplete = (gl: WebGL2RenderingContext): void => {
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new WebGL2CrispPipelineError(
      `WebGL2 Crisp framebuffer is incomplete: 0x${status.toString(16)}.`,
    );
  }
};

const assertNoGlError = (gl: WebGL2RenderingContext, operation: string): void => {
  const error = gl.getError();

  if (error !== gl.NO_ERROR) {
    throw new WebGL2CrispPipelineError(
      `WebGL2 error 0x${error.toString(16)} while ${operation}.`,
    );
  }
};
