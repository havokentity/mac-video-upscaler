import type { FramePipeline, PipelineStatus } from '../../pipeline';
import smoothLanczosShader from './smooth-lanczos.wgsl?raw';

const MIN_SCALE = 1;
const MAX_SCALE = 2;
const DEFAULT_SCALE = 1.5;
const DEFAULT_PRESENTATION_FORMAT: GPUTextureFormat = 'rgba8unorm';
const SOURCE_TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export interface WebGpuSmoothPipelineStatus extends PipelineStatus {
  backend: 'webgpu';
  mode: 'smooth';
  adapterName: string;
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
}

export interface WebGpuSmoothPipelineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly video: HTMLVideoElement;
  readonly presentationFormat?: GPUTextureFormat;
  readonly scale?: number;
}

export interface SmoothOutputSize {
  readonly width: number;
  readonly height: number;
}

export interface ComputeSmoothOutputSizeInput {
  readonly requestedWidth: number;
  readonly requestedHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly scale: number;
}

export class WebGpuSmoothPipelineError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WebGpuSmoothPipelineError';
    this.cause = cause;
  }
}

/*
 * Smooth mode uses the public-domain Lanczos/Jinc resampling formula:
 * sinc(r) * sinc(r / a), radially weighted over nearby source samples.
 * This is a compact Jinc-windowed-Jinc approximation with no third-party code;
 * the API is ready for a fuller elliptical weighted average pass later.
 */
export class WebGpuSmoothPipeline implements FramePipeline {
  readonly status: WebGpuSmoothPipelineStatus;

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly adapter: GPUAdapter;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly presentationFormat: GPUTextureFormat;
  private readonly sampler: GPUSampler;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly renderPipeline: GPURenderPipeline;
  private sourceTexture: GPUTexture | undefined;
  private sourceTextureView: GPUTextureView | undefined;
  private bindGroup: GPUBindGroup | undefined;
  private requestedWidth = 1;
  private requestedHeight = 1;
  private scale: number;
  private destroyed = false;

  private constructor(
    adapter: GPUAdapter,
    device: GPUDevice,
    options: Required<WebGpuSmoothPipelineOptions>,
  ) {
    this.canvas = options.canvas;
    this.video = options.video;
    this.adapter = adapter;
    this.device = device;
    this.presentationFormat = options.presentationFormat;
    this.scale = normalizeSmoothScale(options.scale);

    const context = this.canvas.getContext('webgpu');
    if (context === null) {
      throw new WebGpuSmoothPipelineError('WebGPU canvas context is unavailable for Smooth mode.');
    }

    this.context = context;
    this.configureContext();

    this.sampler = this.device.createSampler({
      label: 'Smooth Lanczos sampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.uniformBuffer = this.device.createBuffer({
      label: 'Smooth Lanczos uniforms',
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'Smooth Lanczos bind group layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const shaderModule = this.device.createShaderModule({
      label: 'Smooth Lanczos shader',
      code: smoothLanczosShader,
    });

    this.renderPipeline = this.device.createRenderPipeline({
      label: 'Smooth Lanczos render pipeline',
      layout: this.device.createPipelineLayout({
        label: 'Smooth Lanczos pipeline layout',
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vertex_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragment_main',
        targets: [{ format: this.presentationFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.status = {
      backend: 'webgpu',
      mode: 'smooth',
      adapterName: describeAdapter(this.adapter),
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      sourceWidth: 0,
      sourceHeight: 0,
      scale: this.scale,
      reason: 'Smooth Lanczos/Jinc-style WebGPU upscale active.',
    };

    void this.device.lost.then((lostInfo) => {
      this.status.reason = `WebGPU device lost: ${lostInfo.reason}`;
    });
  }

  static async create(options: WebGpuSmoothPipelineOptions): Promise<WebGpuSmoothPipeline> {
    const gpu = navigator.gpu;
    if (gpu === undefined) {
      throw new WebGpuSmoothPipelineError('WebGPU is not available in this browser.');
    }

    const adapter = await gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (adapter === null) {
      throw new WebGpuSmoothPipelineError('No WebGPU adapter is available for Smooth mode.');
    }

    const device = await adapter.requestDevice();

    return new WebGpuSmoothPipeline(adapter, device, {
      canvas: options.canvas,
      video: options.video,
      presentationFormat: options.presentationFormat ?? DEFAULT_PRESENTATION_FORMAT,
      scale: normalizeSmoothScale(options.scale),
    });
  }

  resize(width: number, height: number): void {
    if (this.destroyed) {
      return;
    }

    this.requestedWidth = Math.max(1, Math.floor(width));
    this.requestedHeight = Math.max(1, Math.floor(height));
    this.ensureOutputSize();
  }

  setScale(scale: number): void {
    if (this.destroyed) {
      return;
    }

    this.scale = normalizeSmoothScale(scale);
    this.status.scale = this.scale;
    this.ensureOutputSize(true);
  }

  renderFrame(): void {
    if (this.destroyed) {
      return;
    }

    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;

    if (sourceWidth <= 0 || sourceHeight <= 0) {
      this.status.reason = 'Waiting for a decoded video frame.';
      return;
    }

    this.ensureSourceTexture(sourceWidth, sourceHeight);
    this.ensureOutputSize();

    if (this.sourceTexture === undefined || this.bindGroup === undefined) {
      this.status.reason = 'Smooth source texture is unavailable.';
      return;
    }

    try {
      this.device.queue.copyExternalImageToTexture(
        { source: this.video },
        { texture: this.sourceTexture },
        { width: sourceWidth, height: sourceHeight },
      );
    } catch (error) {
      throw new WebGpuSmoothPipelineError(
        'Unable to upload the current video frame to WebGPU. The video may be DRM-protected, cross-origin without CORS, or not ready for canvas upload.',
        error,
      );
    }

    this.device.queue.writeBuffer(
      this.uniformBuffer,
      0,
      new Float32Array([sourceWidth, sourceHeight, 0, 0]),
    );

    const targetTexture = this.context.getCurrentTexture();
    const commandEncoder = this.device.createCommandEncoder({
      label: 'Smooth Lanczos command encoder',
    });
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Smooth Lanczos present pass',
      colorAttachments: [
        {
          view: targetTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(3);
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);
    this.status.reason = undefined;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.destroySourceTexture();
    this.uniformBuffer.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }

  private configureContext(): void {
    this.context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: 'premultiplied',
    });
  }

  private ensureOutputSize(forceConfigure = false): SmoothOutputSize {
    const output = computeSmoothOutputSize({
      requestedHeight: this.requestedHeight,
      requestedWidth: this.requestedWidth,
      scale: this.scale,
      sourceHeight: this.video.videoHeight,
      sourceWidth: this.video.videoWidth,
    });

    if (this.canvas.width !== output.width) {
      this.canvas.width = output.width;
      forceConfigure = true;
    }

    if (this.canvas.height !== output.height) {
      this.canvas.height = output.height;
      forceConfigure = true;
    }

    if (forceConfigure) {
      this.configureContext();
    }

    this.status.canvasWidth = output.width;
    this.status.canvasHeight = output.height;
    return output;
  }

  private ensureSourceTexture(width: number, height: number): void {
    if (this.status.sourceWidth === width && this.status.sourceHeight === height) {
      return;
    }

    this.destroySourceTexture();

    this.sourceTexture = this.device.createTexture({
      label: 'Smooth source texture',
      size: { width, height },
      format: SOURCE_TEXTURE_FORMAT,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.sourceTextureView = this.sourceTexture.createView();
    this.bindGroup = this.device.createBindGroup({
      label: 'Smooth Lanczos bind group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.sourceTextureView },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
    this.status.sourceWidth = width;
    this.status.sourceHeight = height;
  }

  private destroySourceTexture(): void {
    this.sourceTexture?.destroy();
    this.sourceTexture = undefined;
    this.sourceTextureView = undefined;
    this.bindGroup = undefined;
    this.status.sourceWidth = 0;
    this.status.sourceHeight = 0;
  }
}

export const createWebGpuSmoothPipeline = async (
  options: WebGpuSmoothPipelineOptions,
): Promise<WebGpuSmoothPipeline> => WebGpuSmoothPipeline.create(options);

export const normalizeSmoothScale = (scale: number | undefined): number => {
  if (scale === undefined || !Number.isFinite(scale)) {
    return DEFAULT_SCALE;
  }

  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
};

export const computeSmoothOutputSize = ({
  requestedHeight,
  requestedWidth,
  scale,
  sourceHeight,
  sourceWidth,
}: ComputeSmoothOutputSizeInput): SmoothOutputSize => {
  const normalizedScale = normalizeSmoothScale(scale);
  const widthBasis = sourceWidth > 0 ? sourceWidth : requestedWidth;
  const heightBasis = sourceHeight > 0 ? sourceHeight : requestedHeight;

  return {
    height: Math.max(1, Math.round(heightBasis * normalizedScale)),
    width: Math.max(1, Math.round(widthBasis * normalizedScale)),
  };
};

const describeAdapter = (adapter: GPUAdapter): string => {
  const info = adapter.info;
  const fields = [info.vendor, info.architecture, info.device, info.description].filter(
    (field) => field.length > 0,
  );

  return fields.length > 0 ? fields.join(' ') : 'Unknown WebGPU adapter';
};
