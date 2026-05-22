import type { FramePipeline, PipelineStatus } from '../pipeline';

const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision mediump float;

uniform sampler2D u_video;
in vec2 v_uv;
out vec4 out_color;

void main() {
  out_color = texture(u_video, v_uv);
}
`;

const FULLSCREEN_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);

export class WebGL2CopyPipelineError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WebGL2CopyPipelineError';
    this.cause = cause;
  }
}

export interface WebGL2CopyPipelineOptions {
  readonly alpha?: boolean;
  readonly desynchronized?: boolean;
}

export class WebGL2CopyPipeline implements FramePipeline {
  readonly status: PipelineStatus = { backend: 'webgl2' };

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly vertexBuffer: WebGLBuffer;

  private width = 0;
  private height = 0;
  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement,
    options: WebGL2CopyPipelineOptions = {},
  ) {
    this.canvas = canvas;
    this.video = video;

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
      throw new WebGL2CopyPipelineError('WebGL2 is unavailable for the video overlay canvas.');
    }

    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE);
    this.texture = createTexture(gl);
    this.vertexArray = createVertexArray(gl);
    this.vertexBuffer = createVertexBuffer(gl);

    bindFullscreenTriangle(gl, this.program, this.vertexArray, this.vertexBuffer);
    this.resize(canvas.width, canvas.height);
  }

  resize(width: number, height: number): void {
    assertAlive(this.destroyed);

    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));

    if (this.canvas.width !== nextWidth) {
      this.canvas.width = nextWidth;
    }

    if (this.canvas.height !== nextHeight) {
      this.canvas.height = nextHeight;
    }

    if (this.width !== nextWidth || this.height !== nextHeight) {
      this.width = nextWidth;
      this.height = nextHeight;
      this.gl.viewport(0, 0, nextWidth, nextHeight);
    }
  }

  renderFrame(): void {
    assertAlive(this.destroyed);

    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }

    const gl = this.gl;

    this.resize(this.canvas.width, this.canvas.height);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    try {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.video,
      );
    } catch (error) {
      throw new WebGL2CopyPipelineError(
        'Unable to upload the current video frame to WebGL2. The video may be DRM-protected, cross-origin without CORS, or not ready for canvas upload.',
        error,
      );
    }

    assertNoGlError(gl, 'uploading the video frame');

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    assertNoGlError(gl, 'drawing the WebGL2 video copy frame');
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
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);

    this.destroyed = true;
  }
}

export const createWebGL2CopyPipeline = (
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  options?: WebGL2CopyPipelineOptions,
): WebGL2CopyPipeline => new WebGL2CopyPipeline(canvas, video, options);

const createShader = (
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
): WebGLShader => {
  const shader: WebGLShader | null = gl.createShader(type);

  if (!shader) {
    throw new WebGL2CopyPipelineError('WebGL2 failed to allocate a shader object.');
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'No shader compiler log was returned.';
    gl.deleteShader(shader);
    throw new WebGL2CopyPipelineError(`WebGL2 shader compilation failed: ${log}`);
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
    throw new WebGL2CopyPipelineError(`WebGL2 shader program linking failed: ${log}`);
  }

  gl.useProgram(program);
  const samplerLocation = gl.getUniformLocation(program, 'u_video');

  if (!samplerLocation) {
    gl.deleteProgram(program);
    throw new WebGL2CopyPipelineError('WebGL2 shader program is missing the u_video sampler uniform.');
  }

  gl.uniform1i(samplerLocation, 0);

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
    throw new WebGL2CopyPipelineError('WebGL2 shader program is missing the a_position attribute.');
  }

  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
};

const assertAlive = (destroyed: boolean): void => {
  if (destroyed) {
    throw new WebGL2CopyPipelineError('WebGL2 copy pipeline has already been destroyed.');
  }
};

const assertNoGlError = (gl: WebGL2RenderingContext, operation: string): void => {
  const error = gl.getError();

  if (error !== gl.NO_ERROR) {
    throw new WebGL2CopyPipelineError(
      `WebGL2 error 0x${error.toString(16)} while ${operation}.`,
    );
  }
};
