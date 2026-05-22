import type { FramePipeline, PipelineStatus } from '../../pipeline';
import { computeNeuralLiteOutputSize, normalizeNeuralLiteScale } from './webgpu-neural-lite-pipeline';

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

const NEURAL_LITE_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_video;
uniform vec2 u_source_size;
uniform vec2 u_output_size;

in vec2 v_uv;
out vec4 out_color;

float luma(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

vec3 samplePixel(vec2 pixel) {
  vec2 clampedPixel = clamp(pixel, vec2(0.0), u_source_size - vec2(1.0));
  return texture(u_video, (clampedPixel + vec2(0.5)) / u_source_size).rgb;
}

void main() {
  vec2 sourcePixel = gl_FragCoord.xy * (u_source_size / u_output_size) - vec2(0.5);
  vec2 base = floor(sourcePixel);
  vec2 frac = sourcePixel - base;

  vec3 c00 = samplePixel(base + vec2(0.0, 0.0));
  vec3 c10 = samplePixel(base + vec2(1.0, 0.0));
  vec3 c01 = samplePixel(base + vec2(0.0, 1.0));
  vec3 c11 = samplePixel(base + vec2(1.0, 1.0));
  vec3 bilinear = mix(mix(c00, c10, frac.x), mix(c01, c11, frac.x), frac.y);

  vec3 left = samplePixel(sourcePixel + vec2(-1.0, 0.0));
  vec3 right = samplePixel(sourcePixel + vec2(1.0, 0.0));
  vec3 up = samplePixel(sourcePixel + vec2(0.0, -1.0));
  vec3 down = samplePixel(sourcePixel + vec2(0.0, 1.0));
  vec3 nw = samplePixel(sourcePixel + vec2(-1.0, -1.0));
  vec3 ne = samplePixel(sourcePixel + vec2(1.0, -1.0));
  vec3 sw = samplePixel(sourcePixel + vec2(-1.0, 1.0));
  vec3 se = samplePixel(sourcePixel + vec2(1.0, 1.0));

  vec3 crossMean = (left + right + up + down) * 0.25;
  vec3 boxMean = (left + right + up + down + nw + ne + sw + se) * 0.125;
  vec3 residual = bilinear - crossMean;

  float edge = abs(luma(left) - luma(right)) + abs(luma(up) - luma(down));
  float diagonal = abs(luma(nw) - luma(se)) + abs(luma(ne) - luma(sw));
  float edgeMask = smoothstep(0.025, 0.18, max(edge, diagonal * 0.7));
  float flatMask = 1.0 - smoothstep(0.015, 0.075, edge + diagonal);
  float ringingMask = smoothstep(0.10, 0.38, abs(luma(residual)));

  vec3 localMin = min(bilinear, min(min(left, right), min(up, down)));
  vec3 localMax = max(bilinear, max(max(left, right), max(up, down)));
  vec3 denoised = mix(bilinear, boxMean, flatMask * 0.28);
  vec3 repaired = denoised + residual * (0.34 + 0.38 * edgeMask);
  repaired = mix(repaired, crossMean, ringingMask * flatMask * 0.24);

  vec3 guard = vec3(0.055 + edgeMask * 0.035);
  out_color = vec4(clamp(repaired, max(vec3(0.0), localMin - guard), min(vec3(1.0), localMax + guard)), 1.0);
}
`;

export interface WebGL2NeuralLitePipelineOptions {
  readonly scale?: number;
}

export interface WebGL2NeuralLitePipelineStatus extends PipelineStatus {
  backend: 'webgl2';
  mode: 'neural-lite';
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  variant: 'residual-preview';
}

export class WebGL2NeuralLitePipelineError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WebGL2NeuralLitePipelineError';
    this.cause = cause;
  }
}

export class WebGL2NeuralLitePipeline implements FramePipeline {
  readonly status: WebGL2NeuralLitePipelineStatus;

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly sourceTexture: WebGLTexture;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly sourceSizeLocation: WebGLUniformLocation;
  private readonly outputSizeLocation: WebGLUniformLocation;
  private requestedWidth = 1;
  private requestedHeight = 1;
  private scale: number;
  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement,
    options: WebGL2NeuralLitePipelineOptions = {},
  ) {
    this.canvas = canvas;
    this.video = video;
    this.scale = normalizeNeuralLiteScale(options.scale);

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      desynchronized: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      stencil: false,
    });
    if (!gl) {
      throw new WebGL2NeuralLitePipelineError('WebGL2 is unavailable for Neural-Lite preview.');
    }

    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER_SOURCE, NEURAL_LITE_FRAGMENT_SHADER_SOURCE);
    this.sourceTexture = createTexture(gl);
    this.vertexArray = createVertexArray(gl);
    this.vertexBuffer = createVertexBuffer(gl);
    this.sourceSizeLocation = getUniformLocation(gl, this.program, 'u_source_size');
    this.outputSizeLocation = getUniformLocation(gl, this.program, 'u_output_size');

    bindFullscreenTriangle(gl, this.program, this.vertexArray, this.vertexBuffer);
    bindSampler(gl, this.program, 'u_video', 0);

    this.status = {
      backend: 'webgl2',
      canvasHeight: this.canvas.height,
      canvasWidth: this.canvas.width,
      mode: 'neural-lite',
      reason: 'Neural-Lite residual WebGL2 preview active; ArtCNN weights are still pending port.',
      scale: this.scale,
      sourceHeight: 0,
      sourceWidth: 0,
      variant: 'residual-preview',
    };

    this.resize(canvas.width, canvas.height);
  }

  resize(width: number, height: number): void {
    assertAlive(this.destroyed);
    this.requestedWidth = Math.max(1, Math.floor(width));
    this.requestedHeight = Math.max(1, Math.floor(height));
    this.ensureOutputSize();
  }

  renderFrame(): void {
    assertAlive(this.destroyed);

    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }

    const output = this.ensureOutputSize();
    const sourceWidth = Math.max(1, this.video.videoWidth);
    const sourceHeight = Math.max(1, this.video.videoHeight);
    const gl = this.gl;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    } catch (error) {
      throw new WebGL2NeuralLitePipelineError(
        'Unable to upload the current video frame to WebGL2 for Neural-Lite. The video may be DRM-protected, cross-origin without CORS, or not ready for canvas upload.',
        error,
      );
    }

    assertNoGlError(gl, 'uploading the Neural-Lite source frame');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, output.width, output.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.uniform2f(this.sourceSizeLocation, sourceWidth, sourceHeight);
    gl.uniform2f(this.outputSizeLocation, output.width, output.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    assertNoGlError(gl, 'running the Neural-Lite residual preview pass');

    this.status.sourceWidth = sourceWidth;
    this.status.sourceHeight = sourceHeight;
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

  private ensureOutputSize() {
    const output = computeNeuralLiteOutputSize({
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

    this.status.canvasWidth = output.width;
    this.status.canvasHeight = output.height;
    this.status.scale = this.scale;
    return output;
  }
}

export const createWebGL2NeuralLitePipeline = (
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  options?: WebGL2NeuralLitePipelineOptions,
): WebGL2NeuralLitePipeline => new WebGL2NeuralLitePipeline(canvas, video, options);

const createShader = (
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
): WebGLShader => {
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new WebGL2NeuralLitePipelineError('WebGL2 failed to allocate a Neural-Lite shader.');
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'No shader compiler log was returned.';
    gl.deleteShader(shader);
    throw new WebGL2NeuralLitePipelineError(`WebGL2 Neural-Lite shader compilation failed: ${log}`);
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
    throw new WebGL2NeuralLitePipelineError(`WebGL2 Neural-Lite program linking failed: ${log}`);
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

const createVertexArray = (gl: WebGL2RenderingContext): WebGLVertexArrayObject => gl.createVertexArray();

const createVertexBuffer = (gl: WebGL2RenderingContext): WebGLBuffer => gl.createBuffer();

const bindFullscreenTriangle = (
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  vertexArray: WebGLVertexArrayObject,
  vertexBuffer: WebGLBuffer,
): void => {
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  if (positionLocation < 0) {
    throw new WebGL2NeuralLitePipelineError('WebGL2 Neural-Lite program is missing a_position.');
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
    throw new WebGL2NeuralLitePipelineError(`WebGL2 Neural-Lite program is missing ${uniformName}.`);
  }
  return location;
};

const assertAlive = (destroyed: boolean): void => {
  if (destroyed) {
    throw new WebGL2NeuralLitePipelineError('WebGL2 Neural-Lite pipeline has already been destroyed.');
  }
};

const assertNoGlError = (gl: WebGL2RenderingContext, operation: string): void => {
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    throw new WebGL2NeuralLitePipelineError(
      `WebGL2 error 0x${error.toString(16)} while ${operation}.`,
    );
  }
};
