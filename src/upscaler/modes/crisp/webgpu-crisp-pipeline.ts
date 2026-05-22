import type { FramePipeline, PipelineStatus } from '../../pipeline';
import copyPresentShader from '../../webgpu/copy-present.wgsl?raw';
import crispComputeF16Shader from './crisp-compute-f16.wgsl?raw';
import crispComputeF32Shader from './crisp-compute-f32.wgsl?raw';
import {
  computeCrispOutputSize,
  normalizeCrispScale,
  normalizeCrispSharpness,
  type CrispOutputSize,
} from './webgl2-crisp-pipeline';

const DEFAULT_PRESENTATION_FORMAT: GPUTextureFormat = 'rgba8unorm';
const SOURCE_TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';
const WORKGROUP_SIZE = 8;
const UNIFORM_FLOAT_COUNT = 6;
const UNIFORM_BUFFER_SIZE = UNIFORM_FLOAT_COUNT * Float32Array.BYTES_PER_ELEMENT;

export interface WebGpuCrispPipelineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly video: HTMLVideoElement;
  readonly forceF32?: boolean;
  readonly presentationFormat?: GPUTextureFormat;
  readonly scale?: number;
  readonly sharpness?: number;
}

export interface WebGpuCrispPipelineStatus extends PipelineStatus {
  backend: 'webgpu';
  adapterName: string;
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  precision: 'f16' | 'f32';
}

export class WebGpuCrispPipelineError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WebGpuCrispPipelineError';
    this.cause = cause;
  }
}

const describeAdapter = (adapter: GPUAdapter): string => {
  const info = adapter.info;
  const fields = [info.vendor, info.architecture, info.device, info.description].filter(
    (field) => field.length > 0,
  );

  return fields.length > 0 ? fields.join(' ') : 'Unknown WebGPU adapter';
};

const canUseF16 = (adapter: GPUAdapter, forceF32: boolean): boolean =>
  !forceF32 && adapter.features.has('shader-f16');

export class WebGpuCrispPipeline implements FramePipeline {
  readonly status: WebGpuCrispPipelineStatus;

  private readonly adapter: GPUAdapter;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly device: GPUDevice;
  private readonly presentationFormat: GPUTextureFormat;
  private readonly sampler: GPUSampler;
  private readonly computeBindGroupLayout: GPUBindGroupLayout;
  private readonly presentBindGroupLayout: GPUBindGroupLayout;
  private readonly easuPipeline: GPUComputePipeline;
  private readonly rcasPipeline: GPUComputePipeline;
  private readonly presentPipeline: GPURenderPipeline;
  private readonly paramsBuffer: GPUBuffer;
  private readonly precision: 'f16' | 'f32';
  private readonly uniformData = new Float32Array(UNIFORM_FLOAT_COUNT);
  private readonly video: HTMLVideoElement;

  private sourceTexture: GPUTexture | undefined;
  private sourceTextureView: GPUTextureView | undefined;
  private easuTexture: GPUTexture | undefined;
  private easuTextureView: GPUTextureView | undefined;
  private outputTexture: GPUTexture | undefined;
  private outputTextureView: GPUTextureView | undefined;
  private easuBindGroup: GPUBindGroup | undefined;
  private rcasBindGroup: GPUBindGroup | undefined;
  private presentBindGroup: GPUBindGroup | undefined;
  private requestedWidth = 1;
  private requestedHeight = 1;
  private outputWidth = 0;
  private outputHeight = 0;
  private scale: number;
  private sharpness: number;
  private destroyed = false;

  private constructor(
    adapter: GPUAdapter,
    device: GPUDevice,
    options: Required<WebGpuCrispPipelineOptions>,
    precision: 'f16' | 'f32',
  ) {
    this.adapter = adapter;
    this.canvas = options.canvas;
    this.device = device;
    this.presentationFormat = options.presentationFormat;
    this.precision = precision;
    this.scale = normalizeCrispScale(options.scale);
    this.sharpness = normalizeCrispSharpness(options.sharpness);
    this.video = options.video;

    const context = this.canvas.getContext('webgpu');
    if (context === null) {
      throw new WebGpuCrispPipelineError('WebGPU canvas context is unavailable.');
    }

    this.context = context;
    this.configureContext();

    this.sampler = this.device.createSampler({
      label: 'Crisp sampler',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.paramsBuffer = this.device.createBuffer({
      label: 'Crisp params',
      size: UNIFORM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.computeBindGroupLayout = this.createComputeBindGroupLayout();
    this.presentBindGroupLayout = this.createPresentBindGroupLayout();

    const computeModule = this.device.createShaderModule({
      label: `Crisp ${precision} compute shader`,
      code: precision === 'f16' ? crispComputeF16Shader : crispComputeF32Shader,
    });
    this.easuPipeline = this.device.createComputePipeline({
      label: `Crisp ${precision} EASU-style pipeline`,
      layout: this.device.createPipelineLayout({
        label: 'Crisp EASU pipeline layout',
        bindGroupLayouts: [this.computeBindGroupLayout],
      }),
      compute: {
        module: computeModule,
        entryPoint: 'easu_main',
      },
    });
    this.rcasPipeline = this.device.createComputePipeline({
      label: `Crisp ${precision} RCAS-style pipeline`,
      layout: this.device.createPipelineLayout({
        label: 'Crisp RCAS pipeline layout',
        bindGroupLayouts: [this.computeBindGroupLayout],
      }),
      compute: {
        module: computeModule,
        entryPoint: 'rcas_main',
      },
    });

    const presentModule = this.device.createShaderModule({
      label: 'Crisp present shader',
      code: copyPresentShader,
    });
    this.presentPipeline = this.device.createRenderPipeline({
      label: 'Crisp present pipeline',
      layout: this.device.createPipelineLayout({
        label: 'Crisp present pipeline layout',
        bindGroupLayouts: [this.presentBindGroupLayout],
      }),
      vertex: {
        module: presentModule,
        entryPoint: 'vertex_main',
      },
      fragment: {
        module: presentModule,
        entryPoint: 'fragment_main',
        targets: [{ format: this.presentationFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.status = {
      adapterName: describeAdapter(this.adapter),
      backend: 'webgpu',
      canvasHeight: this.canvas.height,
      canvasWidth: this.canvas.width,
      mode: 'crisp',
      precision,
      reason: `FSR 1.0-style WebGPU ${precision} compute upscale active.`,
      sourceHeight: 0,
      sourceWidth: 0,
    };

    void this.device.lost.then((lostInfo) => {
      this.status.reason = `WebGPU device lost: ${lostInfo.reason}`;
    });

    this.resize(this.canvas.width, this.canvas.height);
  }

  static async create(options: WebGpuCrispPipelineOptions): Promise<WebGpuCrispPipeline> {
    const gpu = navigator.gpu;
    if (gpu === undefined) {
      throw new WebGpuCrispPipelineError('WebGPU is not available in this browser.');
    }

    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter === null) {
      throw new WebGpuCrispPipelineError('No WebGPU adapter is available.');
    }

    const precision = canUseF16(adapter, options.forceF32 ?? false) ? 'f16' : 'f32';
    const device = await adapter.requestDevice({
      requiredFeatures: precision === 'f16' ? ['shader-f16'] : [],
    });

    return new WebGpuCrispPipeline(
      adapter,
      device,
      {
        canvas: options.canvas,
        forceF32: options.forceF32 ?? false,
        presentationFormat: options.presentationFormat ?? DEFAULT_PRESENTATION_FORMAT,
        scale: options.scale ?? 1.5,
        sharpness: options.sharpness ?? 0.2,
        video: options.video,
      },
      precision,
    );
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

    this.scale = normalizeCrispScale(scale);
    this.ensureOutputSize(true);
  }

  setSharpness(sharpness: number): void {
    if (this.destroyed) {
      return;
    }

    this.sharpness = normalizeCrispSharpness(sharpness);
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

    const output = this.ensureOutputSize();
    this.ensureTextures(sourceWidth, sourceHeight, output);

    if (
      this.sourceTexture === undefined ||
      this.easuBindGroup === undefined ||
      this.rcasBindGroup === undefined ||
      this.presentBindGroup === undefined
    ) {
      this.status.reason = 'WebGPU Crisp textures are unavailable.';
      return;
    }

    try {
      this.device.queue.copyExternalImageToTexture(
        { source: this.video },
        { texture: this.sourceTexture },
        { width: sourceWidth, height: sourceHeight },
      );
    } catch (error) {
      throw new WebGpuCrispPipelineError(
        'Unable to upload the current video frame to WebGPU. The video may be DRM-protected, cross-origin without CORS, or not ready for canvas upload.',
        error,
      );
    }

    this.writeParams(sourceWidth, sourceHeight, output);

    const commandEncoder = this.device.createCommandEncoder({
      label: 'Crisp command encoder',
    });
    const computePass = commandEncoder.beginComputePass({ label: 'Crisp compute pass' });
    const xGroups = Math.ceil(output.width / WORKGROUP_SIZE);
    const yGroups = Math.ceil(output.height / WORKGROUP_SIZE);

    computePass.setPipeline(this.easuPipeline);
    computePass.setBindGroup(0, this.easuBindGroup);
    computePass.dispatchWorkgroups(xGroups, yGroups, 1);
    computePass.setPipeline(this.rcasPipeline);
    computePass.setBindGroup(0, this.rcasBindGroup);
    computePass.dispatchWorkgroups(xGroups, yGroups, 1);
    computePass.end();

    const renderPass = commandEncoder.beginRenderPass({
      label: 'Crisp present pass',
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    renderPass.setPipeline(this.presentPipeline);
    renderPass.setBindGroup(0, this.presentBindGroup);
    renderPass.draw(3);
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);
    this.status.reason = `FSR 1.0-style WebGPU ${this.precision} compute upscale active.`;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.destroyTextures();
    this.context.unconfigure();
    this.device.destroy();
  }

  private configureContext(): void {
    this.context.configure({
      alphaMode: 'premultiplied',
      device: this.device,
      format: this.presentationFormat,
    });
  }

  private createComputeBindGroupLayout(): GPUBindGroupLayout {
    return this.device.createBindGroupLayout({
      label: 'Crisp compute bind group layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: SOURCE_TEXTURE_FORMAT,
            viewDimension: '2d',
          },
        },
      ],
    });
  }

  private createPresentBindGroupLayout(): GPUBindGroupLayout {
    return this.device.createBindGroupLayout({
      label: 'Crisp present bind group layout',
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
  }

  private ensureOutputSize(forceTextureResize = false): CrispOutputSize {
    const output = computeCrispOutputSize({
      requestedHeight: this.requestedHeight,
      requestedWidth: this.requestedWidth,
      scale: this.scale,
      sourceHeight: this.video.videoHeight,
      sourceWidth: this.video.videoWidth,
    });

    if (this.canvas.width !== output.width || this.canvas.height !== output.height) {
      this.canvas.width = output.width;
      this.canvas.height = output.height;
      this.configureContext();
    }

    this.status.canvasWidth = output.width;
    this.status.canvasHeight = output.height;

    if (forceTextureResize && this.outputTexture !== undefined) {
      this.outputWidth = 0;
      this.outputHeight = 0;
    }

    return output;
  }

  private ensureTextures(sourceWidth: number, sourceHeight: number, output: CrispOutputSize): void {
    const sourceChanged =
      this.status.sourceWidth !== sourceWidth || this.status.sourceHeight !== sourceHeight;
    const outputChanged = this.outputWidth !== output.width || this.outputHeight !== output.height;

    if (!sourceChanged && !outputChanged) {
      return;
    }

    this.destroyTextures();
    this.sourceTexture = this.createTexture('Crisp source texture', sourceWidth, sourceHeight, [
      GPUTextureUsage.COPY_DST,
      GPUTextureUsage.TEXTURE_BINDING,
    ]);
    this.sourceTextureView = this.sourceTexture.createView();
    this.easuTexture = this.createTexture('Crisp EASU texture', output.width, output.height, [
      GPUTextureUsage.TEXTURE_BINDING,
      GPUTextureUsage.STORAGE_BINDING,
    ]);
    this.easuTextureView = this.easuTexture.createView();
    this.outputTexture = this.createTexture('Crisp output texture', output.width, output.height, [
      GPUTextureUsage.TEXTURE_BINDING,
      GPUTextureUsage.STORAGE_BINDING,
    ]);
    this.outputTextureView = this.outputTexture.createView();
    this.easuBindGroup = this.device.createBindGroup({
      label: 'Crisp EASU bind group',
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.sourceTextureView },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
        { binding: 3, resource: this.easuTextureView },
      ],
    });
    this.rcasBindGroup = this.device.createBindGroup({
      label: 'Crisp RCAS bind group',
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.easuTextureView },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
        { binding: 3, resource: this.outputTextureView },
      ],
    });
    this.presentBindGroup = this.device.createBindGroup({
      label: 'Crisp present bind group',
      layout: this.presentBindGroupLayout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.outputTextureView },
      ],
    });
    this.status.sourceWidth = sourceWidth;
    this.status.sourceHeight = sourceHeight;
    this.outputWidth = output.width;
    this.outputHeight = output.height;
  }

  private createTexture(
    label: string,
    width: number,
    height: number,
    usages: number[],
  ): GPUTexture {
    return this.device.createTexture({
      format: SOURCE_TEXTURE_FORMAT,
      label,
      size: { width, height },
      usage: usages.reduce((mask, usage) => mask | usage, 0),
    });
  }

  private writeParams(sourceWidth: number, sourceHeight: number, output: CrispOutputSize): void {
    this.uniformData.set([
      sourceWidth,
      sourceHeight,
      output.width,
      output.height,
      this.sharpness,
      this.scale,
    ]);
    this.device.queue.writeBuffer(this.paramsBuffer, 0, this.uniformData);
  }

  private destroyTextures(): void {
    this.sourceTexture?.destroy();
    this.easuTexture?.destroy();
    this.outputTexture?.destroy();
    this.sourceTexture = undefined;
    this.sourceTextureView = undefined;
    this.easuTexture = undefined;
    this.easuTextureView = undefined;
    this.outputTexture = undefined;
    this.outputTextureView = undefined;
    this.easuBindGroup = undefined;
    this.rcasBindGroup = undefined;
    this.presentBindGroup = undefined;
    this.status.sourceWidth = 0;
    this.status.sourceHeight = 0;
    this.outputWidth = 0;
    this.outputHeight = 0;
  }
}
