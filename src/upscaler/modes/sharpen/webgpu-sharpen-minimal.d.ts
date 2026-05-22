interface GPUBuffer {
  destroy(): void;
}

interface GPUDevice {
  createBuffer(descriptor: object): GPUBuffer;
}

interface GPUQueue {
  writeBuffer(buffer: GPUBuffer, bufferOffset: number, data: BufferSource): void;
}

declare const GPUBufferUsage: {
  readonly COPY_DST: number;
  readonly UNIFORM: number;
};
