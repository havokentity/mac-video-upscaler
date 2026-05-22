import type { FramePipeline, PipelineStatus } from '../../pipeline';
import shaderSource from './sharpen-present.wgsl?raw';
import {
  computeSharpenOutputSize,
  normalizeSharpenSharpness,
  type ComputeSharpenOutputSizeInput,
  type SharpenOutputSize,
} from './webgl2-sharpen-pipeline';

export interface WebGpuSharpenPipelineStatus extends PipelineStatus {
  backend: 'webgpu';
  adapterName: string;
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface WebGpuSharpenPipelineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly video: HTMLVideoElement;
  readonly presentationFormat?: GPUTextureFormat;
  readonly sharpness?: number;
}

const DEFAULT_PRESENTATION_FORMAT: GPUTextureFormat = 'rgba8unorm';
const SOURCE_TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';
const UNIFORM_BUFFER_BYTES = 16;

const describeAdapter = (adapter: GPUAdapter): string => {
  const info = adapter.info;
  const fields = [info.vendor, info.architecture, info.device, info.description].filter(
    (field) => field.length > 0,
  );

  return fields.length > 0 ? fields.join(' ') : 'Unknown WebGPU adapter';
};

export class WebGpuSharpenPipelineError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WebGpuSharpenPipelineError';
    this.cause = cause;
  }
}

export class WebGpuSharpenPipeline implements FramePipeline {
  readonly status: WebGpuSharpenPipelineStatus;

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly adapter: GPUAdapter;
  private readonly device: GPUDevice;
  private readonly queue: GPUQueue;
  private readonly context: GPUCanvasContext;
  private readonly presentationFormat: GPUTextureFormat;
  private readonly sampler: GPUSampler;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly renderPipeline: GPURenderPipeline;
  private readonly uniformBuffer: GPUBuffer;

  private sourceTexture: GPUTexture | undefined;
  private sourceTextureView: GPUTextureView | undefined;
  private bindGroup: GPUBindGroup | undefined;
  private requestedWidth = 1;
  private requestedHeight = 1;
  private sharpness: number;
  private destroyed = false;

  private constructor(
    adapter: GPUAdapter,
    device: GPUDevice,
    options: Required<WebGpuSharpenPipelineOptions>,
  ) {
    this.canvas = options.canvas;
    this.video = options.video;
    this.adapter = adapter;
    this.device = device;
    this.queue = device.queue;
    this.presentationFormat = options.presentationFormat;
    this.sharpness = normalizeSharpenSharpness(options.sharpness);

    const context = this.canvas.getContext('webgpu');
    if (context === null) {
      throw new WebGpuSharpenPipelineError('WebGPU canvas context is unavailable.');
    }

    this.context = context;
    this.configureContext();

    this.sampler = this.device.createSampler({
      label: 'Sharpen sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'Sharpen bind group layout',
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
      label: 'Sharpen present shader',
      code: shaderSource,
    });

    this.renderPipeline = this.device.createRenderPipeline({
      label: 'Sharpen render pipeline',
      layout: this.device.createPipelineLayout({
        label: 'Sharpen pipeline layout',
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

    const bufferUsage = getGpuBufferUsage();
    this.uniformBuffer = this.device.createBuffer({
      label: 'Sharpen uniform buffer',
      size: UNIFORM_BUFFER_BYTES,
      usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST,
    });
    this.writeUniforms();

    this.status = {
      backend: 'webgpu',
      adapterName: describeAdapter(this.adapter),
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      mode: 'sharpen',
      reason: 'CAS-style WebGPU sharpen active at 1.0x.',
      sourceWidth: 0,
      sourceHeight: 0,
    };

    void this.device.lost.then((lostInfo) => {
      this.status.reason = `WebGPU device lost: ${lostInfo.reason}`;
    });

    this.resize(this.canvas.width, this.canvas.height);
  }

  static async create(options: WebGpuSharpenPipelineOptions): Promise<WebGpuSharpenPipeline> {
    const gpu = navigator.gpu;
    if (gpu === undefined) {
      throw new WebGpuSharpenPipelineError('WebGPU is not available in this browser.');
    }

    const adapter = await gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (adapter === null) {
      throw new WebGpuSharpenPipelineError('No WebGPU adapter is available.');
    }

    const device = await adapter.requestDevice();

    return new WebGpuSharpenPipeline(adapter, device, {
      canvas: options.canvas,
      presentationFormat: options.presentationFormat ?? DEFAULT_PRESENTATION_FORMAT,
      sharpness: options.sharpness ?? 0.35,
      video: options.video,
    });
  }

  resize(width: number, height: number): void {
    if (this.destroyed) {
      return;
    }

    this.requestedWidth = Math.max(1, Math.floor(width));
    this.requestedHeight = Math.max(1, Math.floor(height));
    const output = this.ensureOutputSize();
    this.status.canvasWidth = output.width;
    this.status.canvasHeight = output.height;
  }

  setSharpness(sharpness: number): void {
    if (this.destroyed) {
      return;
    }

    this.sharpness = normalizeSharpenSharpness(sharpness);
    this.writeUniforms();
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

    this.ensureOutputSize();
    this.ensureSourceTexture(sourceWidth, sourceHeight);
    if (this.sourceTexture === undefined || this.bindGroup === undefined) {
      this.status.reason = 'WebGPU Sharpen source texture is unavailable.';
      return;
    }

    this.device.queue.copyExternalImageToTexture(
      { source: this.video },
      { texture: this.sourceTexture },
      { width: sourceWidth, height: sourceHeight },
    );

    const commandEncoder = this.device.createCommandEncoder({
      label: 'Sharpen command encoder',
    });
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Sharpen present pass',
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
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

  private ensureOutputSize(): SharpenOutputSize {
    const output = computeSharpenOutputSize({
      requestedHeight: this.requestedHeight,
      requestedWidth: this.requestedWidth,
      sourceHeight: this.video.videoHeight,
      sourceWidth: this.video.videoWidth,
    });

    if (this.canvas.width !== output.width || this.canvas.height !== output.height) {
      this.canvas.width = output.width;
      this.canvas.height = output.height;
      this.configureContext();
    }

    return output;
  }

  private ensureSourceTexture(width: number, height: number): void {
    if (this.status.sourceWidth === width && this.status.sourceHeight === height) {
      return;
    }

    this.destroySourceTexture();

    this.sourceTexture = this.device.createTexture({
      label: 'Sharpen source texture',
      size: { width, height },
      format: SOURCE_TEXTURE_FORMAT,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.sourceTextureView = this.sourceTexture.createView();
    this.bindGroup = this.device.createBindGroup({
      label: 'Sharpen bind group',
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
    this.bindGroup = undefined;
    this.sourceTextureView = undefined;
    this.sourceTexture?.destroy();
    this.sourceTexture = undefined;
    this.status.sourceWidth = 0;
    this.status.sourceHeight = 0;
  }

  private writeUniforms(): void {
    this.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([this.sharpness, 0, 0, 0]));
  }
}

export const createWebGpuSharpenPipeline = (
  options: WebGpuSharpenPipelineOptions,
): Promise<WebGpuSharpenPipeline> => WebGpuSharpenPipeline.create(options);

export { computeSharpenOutputSize, normalizeSharpenSharpness };
export type { ComputeSharpenOutputSizeInput, SharpenOutputSize };

const getGpuBufferUsage = (): { COPY_DST: number; UNIFORM: number } => {
  const usage = (globalThis as unknown as {
    GPUBufferUsage?: { COPY_DST: number; UNIFORM: number };
  }).GPUBufferUsage;

  if (usage === undefined) {
    throw new WebGpuSharpenPipelineError('GPUBufferUsage is unavailable in this browser.');
  }

  return usage;
};
