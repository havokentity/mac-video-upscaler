import type { FramePipeline, PipelineStatus } from '../../pipeline';

const DEFAULT_SHARPNESS = 0.35;
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

const CAS_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_video;
uniform vec2 u_source_texel;
uniform float u_sharpness;

in vec2 v_uv;
out vec4 out_color;

void main() {
  vec2 texel = u_source_texel;
  vec3 center = texture(u_video, v_uv).rgb;
  vec3 left = texture(u_video, v_uv - vec2(texel.x, 0.0)).rgb;
  vec3 right = texture(u_video, v_uv + vec2(texel.x, 0.0)).rgb;
  vec3 up = texture(u_video, v_uv - vec2(0.0, texel.y)).rgb;
  vec3 down = texture(u_video, v_uv + vec2(0.0, texel.y)).rgb;

  vec3 localMin = min(center, min(min(left, right), min(up, down)));
  vec3 localMax = max(center, max(max(left, right), max(up, down)));
  vec3 blur = (left + right + up + down) * 0.25;
  float contrast = max(localMax.r, max(localMax.g, localMax.b)) -
    min(localMin.r, min(localMin.g, localMin.b));
  float gain = u_sharpness * mix(0.85, 0.25, smoothstep(0.02, 0.35, contrast));
  vec3 sharpened = center + (center - blur) * gain;

  out_color = vec4(clamp(sharpened, localMin, localMax), 1.0);
}
`;

export interface WebGL2SharpenPipelineOptions {
  readonly alpha?: boolean;
  readonly desynchronized?: boolean;
  readonly sharpness?: number;
}

export interface SharpenOutputSize {
  readonly width: number;
  readonly height: number;
}

export interface ComputeSharpenOutputSizeInput {
  readonly requestedWidth: number;
  readonly requestedHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

export class WebGL2SharpenPipelineError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WebGL2SharpenPipelineError';
    this.cause = cause;
  }
}

export class WebGL2SharpenPipeline implements FramePipeline {
  readonly status: PipelineStatus = {
    backend: 'webgl2',
    mode: 'sharpen',
    reason: 'CAS-style WebGL2 sharpen active at 1.0x.',
  };

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly sourceTexture: WebGLTexture;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly sourceTexelLocation: WebGLUniformLocation;
  private readonly sharpnessLocation: WebGLUniformLocation;

  private requestedWidth = 1;
  private requestedHeight = 1;
  private sharpness: number;
  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement,
    options: WebGL2SharpenPipelineOptions = {},
  ) {
    this.canvas = canvas;
    this.video = video;
    this.sharpness = normalizeSharpenSharpness(options.sharpness);

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
      throw new WebGL2SharpenPipelineError('WebGL2 is unavailable for the Sharpen pipeline.');
    }

    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER_SOURCE, CAS_FRAGMENT_SHADER_SOURCE);
    this.sourceTexture = createTexture(gl);
    this.vertexArray = createVertexArray(gl);
    this.vertexBuffer = createVertexBuffer(gl);

    bindFullscreenTriangle(gl, this.program, this.vertexArray, this.vertexBuffer);
    bindSampler(gl, this.program, 'u_video', 0);

    this.sourceTexelLocation = getUniformLocation(gl, this.program, 'u_source_texel');
    this.sharpnessLocation = getUniformLocation(gl, this.program, 'u_sharpness');

    this.resize(canvas.width, canvas.height);
  }

  resize(width: number, height: number): void {
    assertAlive(this.destroyed);
    this.requestedWidth = Math.max(1, Math.floor(width));
    this.requestedHeight = Math.max(1, Math.floor(height));
    this.ensureOutputSize();
  }

  setSharpness(sharpness: number): void {
    assertAlive(this.destroyed);
    this.sharpness = normalizeSharpenSharpness(sharpness);
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
      throw new WebGL2SharpenPipelineError(
        'Unable to upload the current video frame to WebGL2. The video may be DRM-protected, cross-origin without CORS, or not ready for canvas upload.',
        error,
      );
    }

    assertNoGlError(gl, 'uploading the Sharpen source frame');

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, output.width, output.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.uniform2f(this.sourceTexelLocation, 1 / sourceWidth, 1 / sourceHeight);
    gl.uniform1f(this.sharpnessLocation, this.sharpness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    assertNoGlError(gl, 'running the Sharpen CAS-style pass');
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);

    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteVertexArray(this.vertexArray);
    gl.deleteTexture(this.sourceTexture);
    gl.deleteProgram(this.program);

    this.destroyed = true;
  }

  private ensureOutputSize(): SharpenOutputSize {
    const output = computeSharpenOutputSize({
      requestedHeight: this.requestedHeight,
      requestedWidth: this.requestedWidth,
      sourceHeight: this.video.videoHeight,
      sourceWidth: this.video.videoWidth,
    });

    if (this.canvas.width !== output.width) {
      this.canvas.width = output.width;
    }

    if (this.canvas.height !== output.height) {
      this.canvas.height = output.height;
    }

    return output;
  }
}

export const createWebGL2SharpenPipeline = (
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  options?: WebGL2SharpenPipelineOptions,
): WebGL2SharpenPipeline => new WebGL2SharpenPipeline(canvas, video, options);

export const normalizeSharpenSharpness = (sharpness: number | undefined): number => {
  if (sharpness === undefined || !Number.isFinite(sharpness)) {
    return DEFAULT_SHARPNESS;
  }

  return Math.min(1, Math.max(0, sharpness));
};

export const computeSharpenOutputSize = ({
  requestedHeight,
  requestedWidth,
  sourceHeight,
  sourceWidth,
}: ComputeSharpenOutputSizeInput): SharpenOutputSize => ({
  height: Math.max(1, Math.round(sourceHeight > 0 ? sourceHeight : requestedHeight)),
  width: Math.max(1, Math.round(sourceWidth > 0 ? sourceWidth : requestedWidth)),
});

const createShader = (
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
): WebGLShader => {
  const shader = gl.createShader(type);

  if (!shader) {
    throw new WebGL2SharpenPipelineError('WebGL2 failed to allocate a Sharpen shader object.');
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'No shader compiler log was returned.';
    gl.deleteShader(shader);
    throw new WebGL2SharpenPipelineError(`WebGL2 Sharpen shader compilation failed: ${log}`);
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
    throw new WebGL2SharpenPipelineError(`WebGL2 Sharpen shader program linking failed: ${log}`);
  }

  return program;
};

const createTexture = (gl: WebGL2RenderingContext): WebGLTexture => {
  const texture = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return texture;
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
    throw new WebGL2SharpenPipelineError('WebGL2 Sharpen program is missing a_position.');
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
    throw new WebGL2SharpenPipelineError(`WebGL2 Sharpen program is missing ${uniformName}.`);
  }

  return location;
};

const assertAlive = (destroyed: boolean): void => {
  if (destroyed) {
    throw new WebGL2SharpenPipelineError('WebGL2 Sharpen pipeline has already been destroyed.');
  }
};

const assertNoGlError = (gl: WebGL2RenderingContext, operation: string): void => {
  const error = gl.getError();

  if (error !== gl.NO_ERROR) {
    throw new WebGL2SharpenPipelineError(
      `WebGL2 error 0x${error.toString(16)} while ${operation}.`,
    );
  }
};
