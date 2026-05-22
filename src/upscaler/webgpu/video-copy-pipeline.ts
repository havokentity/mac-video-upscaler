import type { FramePipeline, PipelineStatus } from '../pipeline';
import copyPresentShader from './copy-present.wgsl?raw';

export interface WebGpuVideoCopyPipelineStatus extends PipelineStatus {
  backend: 'webgpu';
  adapterName: string;
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface WebGpuVideoCopyPipelineOptions {
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;
  presentationFormat?: GPUTextureFormat;
}

const DEFAULT_PRESENTATION_FORMAT: GPUTextureFormat = 'rgba8unorm';
const SOURCE_TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

const describeAdapter = (adapter: GPUAdapter): string => {
  const info = adapter.info;
  const fields = [info.vendor, info.architecture, info.device, info.description].filter(
    (field) => field.length > 0,
  );

  return fields.length > 0 ? fields.join(' ') : 'Unknown WebGPU adapter';
};

export class WebGpuVideoCopyPipeline implements FramePipeline {
  readonly status: WebGpuVideoCopyPipelineStatus;

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly adapter: GPUAdapter;
  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly presentationFormat: GPUTextureFormat;
  private readonly sampler: GPUSampler;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly renderPipeline: GPURenderPipeline;
  private sourceTexture: GPUTexture | undefined;
  private sourceTextureView: GPUTextureView | undefined;
  private bindGroup: GPUBindGroup | undefined;
  private destroyed = false;

  private constructor(
    adapter: GPUAdapter,
    device: GPUDevice,
    options: Required<WebGpuVideoCopyPipelineOptions>,
  ) {
    this.canvas = options.canvas;
    this.video = options.video;
    this.adapter = adapter;
    this.device = device;
    this.presentationFormat = options.presentationFormat;

    const context = this.canvas.getContext('webgpu');
    if (context === null) {
      throw new Error('WebGPU canvas context is unavailable.');
    }

    this.context = context;
    this.configureContext();

    this.sampler = this.device.createSampler({
      label: 'Video copy sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'Video copy bind group layout',
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
      ],
    });

    const shaderModule = this.device.createShaderModule({
      label: 'Video copy present shader',
      code: copyPresentShader,
    });

    this.renderPipeline = this.device.createRenderPipeline({
      label: 'Video copy present pipeline',
      layout: this.device.createPipelineLayout({
        label: 'Video copy pipeline layout',
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
      adapterName: describeAdapter(this.adapter),
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      sourceWidth: 0,
      sourceHeight: 0,
    };

    void this.device.lost.then((lostInfo) => {
      this.status.reason = `WebGPU device lost: ${lostInfo.reason}`;
    });
  }

  static async create(options: WebGpuVideoCopyPipelineOptions): Promise<WebGpuVideoCopyPipeline> {
    const gpu = navigator.gpu;
    if (gpu === undefined) {
      throw new Error('WebGPU is not available in this browser.');
    }

    const adapter = await gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (adapter === null) {
      throw new Error('No WebGPU adapter is available.');
    }

    const device = await adapter.requestDevice();

    return new WebGpuVideoCopyPipeline(adapter, device, {
      canvas: options.canvas,
      video: options.video,
      presentationFormat: options.presentationFormat ?? DEFAULT_PRESENTATION_FORMAT,
    });
  }

  resize(width: number, height: number): void {
    if (this.destroyed) {
      return;
    }

    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));

    if (this.canvas.width !== safeWidth || this.canvas.height !== safeHeight) {
      this.canvas.width = safeWidth;
      this.canvas.height = safeHeight;
      this.configureContext();
    }

    this.status.canvasWidth = safeWidth;
    this.status.canvasHeight = safeHeight;
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
    if (this.sourceTexture === undefined || this.bindGroup === undefined) {
      this.status.reason = 'WebGPU source texture is unavailable.';
      return;
    }

    this.device.queue.copyExternalImageToTexture(
      { source: this.video },
      { texture: this.sourceTexture },
      { width: sourceWidth, height: sourceHeight },
    );

    const targetTexture = this.context.getCurrentTexture();
    const commandEncoder = this.device.createCommandEncoder({
      label: 'Video copy command encoder',
    });
    const renderPass = commandEncoder.beginRenderPass({
      label: 'Video copy present pass',
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

  private ensureSourceTexture(width: number, height: number): void {
    if (this.status.sourceWidth === width && this.status.sourceHeight === height) {
      return;
    }

    this.destroySourceTexture();

    this.sourceTexture = this.device.createTexture({
      label: 'Video copy source texture',
      size: { width, height },
      format: SOURCE_TEXTURE_FORMAT,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.sourceTextureView = this.sourceTexture.createView();
    this.bindGroup = this.device.createBindGroup({
      label: 'Video copy bind group',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.sourceTextureView },
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
