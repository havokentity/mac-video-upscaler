type GPUTextureFormat = string;

interface GPUAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

interface GPUAdapter {
  readonly features: {
    has(feature: string): boolean;
  };
  readonly info: GPUAdapterInfo;
  requestDevice(descriptor?: object): Promise<GPUDevice>;
}

interface GPU {
  requestAdapter(options?: object): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat(): GPUTextureFormat;
}

interface GPUDeviceLostInfo {
  readonly reason: string;
}

interface GPUDevice {
  readonly lost: Promise<GPUDeviceLostInfo>;
  readonly queue: GPUQueue;
  createBuffer(descriptor: object): GPUBuffer;
  createSampler(descriptor?: object): GPUSampler;
  createBindGroupLayout(descriptor: object): GPUBindGroupLayout;
  createShaderModule(descriptor: object): GPUShaderModule;
  createPipelineLayout(descriptor: object): GPUPipelineLayout;
  createComputePipeline(descriptor: object): GPUComputePipeline;
  createRenderPipeline(descriptor: object): GPURenderPipeline;
  createCommandEncoder(descriptor?: object): GPUCommandEncoder;
  createTexture(descriptor: object): GPUTexture;
  createBindGroup(descriptor: object): GPUBindGroup;
  destroy(): void;
}

interface GPUQueue {
  copyExternalImageToTexture(source: object, destination: object, copySize: object): void;
  submit(commandBuffers: GPUCommandBuffer[]): void;
  writeBuffer(buffer: GPUBuffer, bufferOffset: number, data: BufferSource): void;
}

interface GPUCanvasContext {
  configure(configuration: object): void;
  unconfigure(): void;
  getCurrentTexture(): GPUTexture;
}

type GPUSampler = object;
type GPUBuffer = object;
type GPUBindGroupLayout = object;
type GPUShaderModule = object;
type GPUPipelineLayout = object;
type GPUComputePipeline = object;
type GPURenderPipeline = object;
type GPUTextureView = object;
type GPUBindGroup = object;
type GPUCommandBuffer = object;

interface GPUTexture {
  createView(descriptor?: object): GPUTextureView;
  destroy(): void;
}

interface GPUCommandEncoder {
  beginComputePass(descriptor?: object): GPUComputePassEncoder;
  beginRenderPass(descriptor: object): GPURenderPassEncoder;
  finish(): GPUCommandBuffer;
}

interface GPUComputePassEncoder {
  setPipeline(pipeline: GPUComputePipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  dispatchWorkgroups(workgroupCountX: number, workgroupCountY?: number, workgroupCountZ?: number): void;
  end(): void;
}

interface GPURenderPassEncoder {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  draw(vertexCount: number): void;
  end(): void;
}

declare const GPUShaderStage: {
  readonly COMPUTE: number;
  readonly FRAGMENT: number;
};

declare const GPUTextureUsage: {
  readonly COPY_DST: number;
  readonly STORAGE_BINDING: number;
  readonly TEXTURE_BINDING: number;
};

declare const GPUBufferUsage: {
  readonly COPY_DST: number;
  readonly UNIFORM: number;
};

interface Navigator {
  readonly gpu?: GPU;
}

interface HTMLCanvasElement {
  getContext(contextId: 'webgpu'): GPUCanvasContext | null;
}
