import type { FramePipeline, PipelineStatus } from '../../pipeline';
import {
  computeAnimeOutputSize,
  formatAnimeSubMode,
  normalizeAnimeScale,
  normalizeAnimeSubMode,
  type AnimeOutputSize,
  type AnimeSubMode,
} from './webgpu-anime-pipeline';
import {
  ANIME4K_UPSTREAM_COMMIT,
  MODE_A_FAST_CHAIN,
  MODE_AA_FAST_CHAIN,
  type Anime4KPassSource,
} from './upstream-shader-chain';

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

interface Anime4KTextureRecord {
  readonly framebuffer: WebGLFramebuffer | null;
  readonly height: number;
  readonly texture: WebGLTexture;
  readonly width: number;
}

interface Anime4KCompiledPass {
  readonly bindings: readonly string[];
  readonly description: string;
  readonly heightExpression: string;
  readonly outputSizeLocation: WebGLUniformLocation;
  readonly program: WebGLProgram;
  readonly samplerLocations: ReadonlyMap<string, WebGLUniformLocation>;
  readonly saveName: string;
  readonly sizeLocations: ReadonlyMap<string, WebGLUniformLocation>;
  readonly sourceFile: string;
  readonly widthExpression: string;
}

const PRESENT_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_texture;

in vec2 v_uv;
out vec4 out_color;

void main() {
  out_color = texture(u_texture, v_uv);
}
`;

export interface WebGL2AnimePipelineOptions {
  readonly scale?: number;
  readonly subMode?: AnimeSubMode;
}

export interface WebGL2AnimePipelineStatus extends PipelineStatus {
  backend: 'webgl2';
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  subMode: AnimeSubMode;
}

export class WebGL2AnimePipelineError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WebGL2AnimePipelineError';
    this.cause = cause;
  }
}

export class WebGL2AnimePipeline implements FramePipeline {
  readonly status: WebGL2AnimePipelineStatus;

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly compiledPasses: Anime4KCompiledPass[];
  private readonly presentProgram: WebGLProgram;
  private readonly presentSamplerLocation: WebGLUniformLocation;
  private readonly sourceTexture: Anime4KTextureRecord;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly renderTargets = new Map<string, Anime4KTextureRecord>();
  private requestedWidth = 1;
  private requestedHeight = 1;
  private scale: number;
  private subMode: AnimeSubMode;
  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement,
    options: WebGL2AnimePipelineOptions = {},
  ) {
    this.canvas = canvas;
    this.video = video;
    this.scale = normalizeAnimeScale(options.scale);
    this.subMode = normalizeAnimeSubMode(options.subMode);

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
      throw new WebGL2AnimePipelineError('WebGL2 is unavailable for the Anime pipeline.');
    }

    this.gl = gl;
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');

    this.sourceTexture = createSourceTexture(gl);
    this.vertexArray = createVertexArray(gl);
    this.vertexBuffer = createVertexBuffer(gl);
    this.compiledPasses = compileAnime4KPasses(
      gl,
      this.subMode === 'mode-aa' ? MODE_AA_FAST_CHAIN : MODE_A_FAST_CHAIN,
    );
    this.presentProgram = createProgram(gl, VERTEX_SHADER_SOURCE, PRESENT_FRAGMENT_SHADER_SOURCE);
    this.presentSamplerLocation = getUniformLocation(gl, this.presentProgram, 'u_texture');

    bindFullscreenTriangle(gl, this.presentProgram, this.vertexArray, this.vertexBuffer);
    bindSampler(gl, this.presentProgram, 'u_texture', 0);
    this.compiledPasses.forEach((pass) => {
      bindFullscreenTriangle(gl, pass.program, this.vertexArray, this.vertexBuffer);
      pass.samplerLocations.forEach((location, bindingName) => {
        gl.useProgram(pass.program);
        gl.uniform1i(location, pass.bindings.indexOf(bindingName));
      });
    });

    this.status = {
      backend: 'webgl2',
      canvasHeight: this.canvas.height,
      canvasWidth: this.canvas.width,
      mode: 'anime',
      reason: `Upstream Anime4K WebGL2 ${formatAnimeSubMode(this.subMode)} Fast CNN chain active.`,
      scale: this.scale,
      sourceHeight: 0,
      sourceWidth: 0,
      subMode: this.subMode,
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
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture.texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    } catch (error) {
      throw new WebGL2AnimePipelineError(
        'Unable to upload the current video frame to WebGL2 for Anime mode. The video may be DRM-protected, cross-origin without CORS, or not ready for canvas upload.',
        error,
      );
    }

    assertNoGlError(gl, 'uploading the Anime source frame');

    let namedTextures = new Map<string, Anime4KTextureRecord>([
      ['MAIN', { ...this.sourceTexture, height: sourceHeight, width: sourceWidth }],
    ]);
    for (let index = 0; index < this.compiledPasses.length; index += 1) {
      namedTextures = this.runPass(index, this.compiledPasses[index], namedTextures, output);
    }

    const finalTexture = namedTextures.get('MAIN') ?? this.sourceTexture;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, output.width, output.height);
    gl.useProgram(this.presentProgram);
    gl.bindVertexArray(this.vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, finalTexture.texture);
    gl.uniform1i(this.presentSamplerLocation, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    assertNoGlError(gl, 'presenting the upstream Anime4K WebGL2 chain');

    this.status.reason =
      `Upstream Anime4K WebGL2 ${formatAnimeSubMode(this.subMode)} Fast CNN chain active ` +
      `(${String(this.compiledPasses.length)} passes, ${ANIME4K_UPSTREAM_COMMIT.slice(0, 7)}).`;
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
    gl.deleteTexture(this.sourceTexture.texture);
    this.renderTargets.forEach((record) => {
      gl.deleteFramebuffer(record.framebuffer);
      gl.deleteTexture(record.texture);
    });
    this.compiledPasses.forEach((pass) => {
      gl.deleteProgram(pass.program);
    });
    gl.deleteProgram(this.presentProgram);
    this.destroyed = true;
  }

  private ensureOutputSize(): AnimeOutputSize {
    const output = computeAnimeOutputSize({
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

  private runPass(
    index: number,
    pass: Anime4KCompiledPass,
    namedTextures: ReadonlyMap<string, Anime4KTextureRecord>,
    requestedOutput: AnimeOutputSize,
  ): Map<string, Anime4KTextureRecord> {
    const gl = this.gl;
    const width = evaluateDimensionExpression(pass.widthExpression, namedTextures, requestedOutput);
    const height = evaluateDimensionExpression(pass.heightExpression, namedTextures, requestedOutput);
    const outputRecord = this.getRenderTarget(`${String(index)}:${pass.saveName}`, width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputRecord.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.useProgram(pass.program);
    gl.bindVertexArray(this.vertexArray);
    gl.uniform2f(pass.outputSizeLocation, width, height);

    pass.bindings.forEach((bindingName, textureUnit) => {
      const record = namedTextures.get(bindingName);
      if (!record) {
        throw new WebGL2AnimePipelineError(
          `Anime4K pass ${pass.description} requires missing texture ${bindingName}.`,
        );
      }

      gl.activeTexture(gl.TEXTURE0 + textureUnit);
      gl.bindTexture(gl.TEXTURE_2D, record.texture);
      const sizeLocation = pass.sizeLocations.get(bindingName);
      if (sizeLocation) {
        gl.uniform2f(sizeLocation, record.width, record.height);
      }
    });

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    assertNoGlError(gl, `running upstream ${pass.sourceFile} ${pass.description}`);

    const updated = new Map(namedTextures);
    updated.set(pass.saveName, outputRecord);
    return updated;
  }

  private getRenderTarget(key: string, width: number, height: number): Anime4KTextureRecord {
    const existing = this.renderTargets.get(key);
    if (existing && existing.width === width && existing.height === height) {
      return existing;
    }

    const gl = this.gl;
    if (existing) {
      gl.deleteFramebuffer(existing.framebuffer);
      gl.deleteTexture(existing.texture);
    }

    const created = createRenderTargetTexture(gl, width, height);
    this.renderTargets.set(key, created);
    return created;
  }
}

export const createWebGL2AnimePipeline = (
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  options?: WebGL2AnimePipelineOptions,
): WebGL2AnimePipeline => new WebGL2AnimePipeline(canvas, video, options);

const createShader = (
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new WebGL2AnimePipelineError('WebGL2 failed to allocate an Anime shader object.');
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'No shader compiler log was returned.';
    gl.deleteShader(shader);
    throw new WebGL2AnimePipelineError(`WebGL2 Anime shader compilation failed: ${log}`);
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
    throw new WebGL2AnimePipelineError(`WebGL2 Anime shader program linking failed: ${log}`);
  }

  return program;
};

const compileAnime4KPasses = (
  gl: WebGL2RenderingContext,
  passSources: readonly Anime4KPassSource[],
): Anime4KCompiledPass[] =>
  passSources.map((passSource) => {
    const fragmentSource = createAnime4KFragmentShaderSource(passSource);
    const program = createProgram(gl, VERTEX_SHADER_SOURCE, fragmentSource);
    const samplerLocations = new Map<string, WebGLUniformLocation>();
    const sizeLocations = new Map<string, WebGLUniformLocation>();
    passSource.binds.forEach((bindingName) => {
      const samplerLocation = gl.getUniformLocation(program, `u_${bindingName}_texture`);
      const sizeLocation = gl.getUniformLocation(program, `u_${bindingName}_size`);
      if (samplerLocation) {
        samplerLocations.set(bindingName, samplerLocation);
      }
      if (sizeLocation) {
        sizeLocations.set(bindingName, sizeLocation);
      }
    });

    return {
      bindings: passSource.binds,
      description: passSource.description,
      heightExpression: passSource.heightExpression,
      outputSizeLocation: getUniformLocation(gl, program, 'u_output_size'),
      program,
      samplerLocations,
      saveName: passSource.saveName,
      sizeLocations,
      sourceFile: passSource.sourceFile,
      widthExpression: passSource.widthExpression,
    };
  });

const createAnime4KFragmentShaderSource = (pass: Anime4KPassSource): string => {
  const bindings = pass.binds
    .map(
      (bindingName) => `
uniform sampler2D u_${bindingName}_texture;
uniform vec2 u_${bindingName}_size;
#define ${bindingName}_size u_${bindingName}_size
#define ${bindingName}_pt (1.0 / u_${bindingName}_size)
#define ${bindingName}_pos (gl_FragCoord.xy / u_output_size)
vec4 ${bindingName}_tex(vec2 pos) {
  return texture(u_${bindingName}_texture, clamp(pos, vec2(0.0), vec2(1.0)));
}
vec4 ${bindingName}_texOff(vec2 offset) {
  return ${bindingName}_tex(${bindingName}_pos + offset * ${bindingName}_pt);
}
`,
    )
    .join('\n');

  return `#version 300 es
precision highp float;
precision highp int;

uniform vec2 u_output_size;

${bindings}

out vec4 out_color;

${pass.code}

void main() {
  out_color = hook();
}
`;
};

const createSourceTexture = (gl: WebGL2RenderingContext): Anime4KTextureRecord => {
  const texture = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { framebuffer: null, height: 1, texture, width: 1 };
};

const createRenderTargetTexture = (
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): Anime4KTextureRecord => {
  const texture = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);

  const framebuffer = gl.createFramebuffer();

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    throw new WebGL2AnimePipelineError(
      `WebGL2 Anime framebuffer is incomplete: 0x${status.toString(16)}.`,
    );
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { framebuffer, height, texture, width };
};

const evaluateDimensionExpression = (
  expression: string,
  namedTextures: ReadonlyMap<string, Anime4KTextureRecord>,
  requestedOutput: AnimeOutputSize,
): number => {
  const stack: number[] = [];
  const tokens = expression.trim().split(/\s+/).filter(Boolean);

  tokens.forEach((token) => {
    if (token === '*') {
      const right = stack.pop();
      const left = stack.pop();
      if (left === undefined || right === undefined) {
        throw new WebGL2AnimePipelineError(`Invalid Anime4K dimension expression: ${expression}`);
      }
      stack.push(left * right);
      return;
    }

    if (token === '/') {
      const right = stack.pop();
      const left = stack.pop();
      if (left === undefined || right === undefined || right === 0) {
        throw new WebGL2AnimePipelineError(`Invalid Anime4K dimension expression: ${expression}`);
      }
      stack.push(left / right);
      return;
    }

    const textureReference = token.match(/^([A-Za-z0-9_]+)\.(w|h)$/);
    if (textureReference) {
      const [, name, axis] = textureReference;
      if (name === 'OUTPUT') {
        stack.push(axis === 'w' ? requestedOutput.width : requestedOutput.height);
        return;
      }

      const record = namedTextures.get(name);
      if (!record) {
        throw new WebGL2AnimePipelineError(
          `Anime4K dimension expression ${expression} references missing texture ${name}.`,
        );
      }
      stack.push(axis === 'w' ? record.width : record.height);
      return;
    }

    const numericValue = Number(token);
    if (!Number.isFinite(numericValue)) {
      throw new WebGL2AnimePipelineError(
        `Unsupported Anime4K dimension token ${token} in ${expression}.`,
      );
    }
    stack.push(numericValue);
  });

  if (stack.length !== 1) {
    throw new WebGL2AnimePipelineError(`Invalid Anime4K dimension expression: ${expression}`);
  }

  return Math.max(1, Math.round(stack[0]));
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
    throw new WebGL2AnimePipelineError('WebGL2 Anime program is missing a_position.');
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
    throw new WebGL2AnimePipelineError(`WebGL2 Anime program is missing ${uniformName}.`);
  }
  return location;
};

const assertAlive = (destroyed: boolean): void => {
  if (destroyed) {
    throw new WebGL2AnimePipelineError('WebGL2 Anime pipeline has already been destroyed.');
  }
};

const assertNoGlError = (gl: WebGL2RenderingContext, operation: string): void => {
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    throw new WebGL2AnimePipelineError(
      `WebGL2 error 0x${error.toString(16)} while ${operation}.`,
    );
  }
};
