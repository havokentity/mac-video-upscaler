type GPUTextureFormat = string;

interface GPUAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

interface GPUAdapter {
  readonly info: GPUAdapterInfo;
  requestDevice(): Promise<GPUDevice>;
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
  createSampler(descriptor?: object): GPUSampler;
  createBindGroupLayout(descriptor: object): GPUBindGroupLayout;
  createShaderModule(descriptor: object): GPUShaderModule;
  createPipelineLayout(descriptor: object): GPUPipelineLayout;
  createRenderPipeline(descriptor: object): GPURenderPipeline;
  createCommandEncoder(descriptor?: object): GPUCommandEncoder;
  createTexture(descriptor: object): GPUTexture;
  createBindGroup(descriptor: object): GPUBindGroup;
  destroy(): void;
}

interface GPUQueue {
  copyExternalImageToTexture(source: object, destination: object, copySize: object): void;
  submit(commandBuffers: GPUCommandBuffer[]): void;
}

interface GPUCanvasContext {
  configure(configuration: object): void;
  unconfigure(): void;
  getCurrentTexture(): GPUTexture;
}

type GPUSampler = object;
type GPUBindGroupLayout = object;
type GPUShaderModule = object;
type GPUPipelineLayout = object;
type GPURenderPipeline = object;
type GPUTextureView = object;
type GPUBindGroup = object;
type GPUCommandBuffer = object;

interface GPUTexture {
  createView(descriptor?: object): GPUTextureView;
  destroy(): void;
}

interface GPUCommandEncoder {
  beginRenderPass(descriptor: object): GPURenderPassEncoder;
  finish(): GPUCommandBuffer;
}

interface GPURenderPassEncoder {
  setPipeline(pipeline: GPURenderPipeline): void;
  setBindGroup(index: number, bindGroup: GPUBindGroup): void;
  draw(vertexCount: number): void;
  end(): void;
}

declare const GPUShaderStage: {
  readonly FRAGMENT: number;
};

declare const GPUTextureUsage: {
  readonly COPY_DST: number;
  readonly TEXTURE_BINDING: number;
};

interface Navigator {
  readonly gpu?: GPU;
}

interface HTMLCanvasElement {
  getContext(contextId: 'webgpu'): GPUCanvasContext | null;
}
