import type { FramePipeline, PipelineStatus } from '../../pipeline';
import type { Tensor as OrtTensor } from 'onnxruntime-web/webgpu';
import { computeNeuralLiteOutputSize, normalizeNeuralLiteScale } from './webgpu-neural-lite-pipeline';
import { ARTCNN_UPSTREAM } from './artcnn-attribution';
import { getArtCnnModelUrl, getOrtWasmPaths } from './artcnn-runtime';

const INPUT_NAME = 'input';
const OUTPUT_NAME = 'output';
const MIN_RENDER_INTERVAL_MS = 33;

type OrtModule = typeof import('onnxruntime-web/webgpu');
type OrtSession = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;

export interface WebGpuArtCnnPipelineOptions {
  readonly scale?: number;
}

export interface WebGpuArtCnnPipelineStatus extends PipelineStatus {
  backend: 'webgpu';
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  variant: 'ArtCNN_C4F16';
  provider: 'ort-webgpu+wasm' | 'loading';
  upstreamCommit: string;
}

export class WebGpuArtCnnPipelineError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WebGpuArtCnnPipelineError';
    this.cause = cause;
  }
}

export class WebGpuArtCnnPipeline implements FramePipeline {
  readonly status: WebGpuArtCnnPipelineStatus;

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly sourceCanvas = document.createElement('canvas');
  private readonly sourceContext: CanvasRenderingContext2D;
  private initPromise: Promise<void> | undefined;
  private session: OrtSession | undefined;
  private ort: OrtModule | undefined;
  private requestedWidth = 1;
  private requestedHeight = 1;
  private scale: number;
  private inferenceInFlight = false;
  private lastInferenceAt = 0;
  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement,
    options: WebGpuArtCnnPipelineOptions = {},
  ) {
    this.canvas = canvas;
    this.video = video;
    this.scale = normalizeNeuralLiteScale(options.scale);

    const context = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
      willReadFrequently: false,
    });
    const sourceContext = this.sourceCanvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });
    if (!context || !sourceContext) {
      throw new WebGpuArtCnnPipelineError('Canvas 2D is unavailable for ArtCNN presentation.');
    }

    this.context = context;
    this.sourceContext = sourceContext;
    this.status = {
      backend: 'webgpu',
      canvasHeight: this.canvas.height,
      canvasWidth: this.canvas.width,
      mode: 'neural-lite',
      provider: 'loading',
      reason: 'Loading ArtCNN C4F16 ONNX Runtime WebGPU session.',
      scale: this.scale,
      sourceHeight: 0,
      sourceWidth: 0,
      upstreamCommit: ARTCNN_UPSTREAM.verifiedCommit,
      variant: 'ArtCNN_C4F16',
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
    this.status.sourceWidth = Math.max(1, this.video.videoWidth);
    this.status.sourceHeight = Math.max(1, this.video.videoHeight);

    if (!this.session) {
      this.initPromise ??= this.initialize();
      this.paintFallbackFrame(output.width, output.height);
      return;
    }

    const now = performance.now();
    if (this.inferenceInFlight || now - this.lastInferenceAt < MIN_RENDER_INTERVAL_MS) {
      return;
    }

    this.lastInferenceAt = now;
    this.inferenceInFlight = true;
    void this.runInference(output.width, output.height).finally(() => {
      this.inferenceInFlight = false;
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.session = undefined;
  }

  private async initialize(): Promise<void> {
    try {
      const ort = await import('onnxruntime-web/webgpu');
      ort.env.wasm.wasmPaths = getOrtWasmPaths();
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;

      const sessionOptions: Parameters<typeof ort.InferenceSession.create>[1] = {
        executionProviders: ['webgpu', 'wasm'],
        graphOptimizationLevel: 'all',
      };

      this.session = await ort.InferenceSession.create(getArtCnnModelUrl(), sessionOptions);
      this.ort = ort;
      this.status.provider = 'ort-webgpu+wasm';
      this.status.reason =
        `ArtCNN C4F16 ONNX Runtime active; WebGPU requested with WASM fallback ` +
        `(${ARTCNN_UPSTREAM.verifiedCommit.slice(0, 7)}).`;
    } catch (error) {
      this.status.reason =
        error instanceof Error
          ? `ArtCNN ONNX Runtime initialization failed: ${error.message}`
          : 'ArtCNN ONNX Runtime initialization failed.';
    }
  }

  private async runInference(outputWidth: number, outputHeight: number): Promise<void> {
    if (!this.session || !this.ort || this.destroyed) {
      return;
    }

    const sourceWidth = Math.max(1, this.video.videoWidth);
    const sourceHeight = Math.max(1, this.video.videoHeight);
    this.resizeSourceCanvas(sourceWidth, sourceHeight);
    this.sourceContext.drawImage(this.video, 0, 0, sourceWidth, sourceHeight);

    const sourcePixels = this.sourceContext.getImageData(0, 0, sourceWidth, sourceHeight);
    const input = new Float32Array(sourceWidth * sourceHeight);
    for (let index = 0, pixel = 0; index < input.length; index += 1, pixel += 4) {
      const red = sourcePixels.data[pixel] / 255;
      const green = sourcePixels.data[pixel + 1] / 255;
      const blue = sourcePixels.data[pixel + 2] / 255;
      input[index] = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    }

    let tensor: OrtTensor | undefined;
    let output: OrtTensor | undefined;
    try {
      tensor = new this.ort.Tensor('float32', input, [1, 1, sourceHeight, sourceWidth]);
      const outputs = await this.session.run({ [INPUT_NAME]: tensor });
      output = outputs[OUTPUT_NAME];
      if (!(output.data instanceof Float32Array)) {
        throw new WebGpuArtCnnPipelineError('ArtCNN returned an unexpected output tensor.');
      }

      this.presentLumaOutput(sourcePixels, output.data, sourceWidth, sourceHeight, outputWidth, outputHeight);
      this.status.provider = 'ort-webgpu+wasm';
      this.status.reason =
        `ArtCNN C4F16 ONNX Runtime active at ${this.scale.toFixed(1)}x; ` +
        `WebGPU requested with WASM fallback ` +
        `(${ARTCNN_UPSTREAM.verifiedCommit.slice(0, 7)}).`;
    } catch (error) {
      this.status.reason =
        error instanceof Error ? `ArtCNN inference failed: ${error.message}` : 'ArtCNN inference failed.';
    } finally {
      output?.dispose();
      tensor?.dispose();
    }
  }

  private presentLumaOutput(
    sourcePixels: ImageData,
    lumaOutput: Float32Array,
    sourceWidth: number,
    sourceHeight: number,
    outputWidth: number,
    outputHeight: number,
  ): void {
    const modelWidth = sourceWidth * 2;
    const modelHeight = sourceHeight * 2;
    const outputPixels = this.context.createImageData(outputWidth, outputHeight);

    for (let y = 0; y < outputHeight; y += 1) {
      const sourceY = Math.min(sourceHeight - 1, Math.floor((y / outputHeight) * sourceHeight));
      const modelY = Math.min(modelHeight - 1, Math.floor((y / outputHeight) * modelHeight));
      for (let x = 0; x < outputWidth; x += 1) {
        const sourceX = Math.min(sourceWidth - 1, Math.floor((x / outputWidth) * sourceWidth));
        const modelX = Math.min(modelWidth - 1, Math.floor((x / outputWidth) * modelWidth));
        const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
        const outputOffset = (y * outputWidth + x) * 4;
        const red = sourcePixels.data[sourceOffset] / 255;
        const green = sourcePixels.data[sourceOffset + 1] / 255;
        const blue = sourcePixels.data[sourceOffset + 2] / 255;
        const baseLuma = Math.max(0.001, red * 0.2126 + green * 0.7152 + blue * 0.0722);
        const neuralLuma = Math.max(0, Math.min(1, lumaOutput[modelY * modelWidth + modelX]));
        const ratio = Math.max(0.25, Math.min(4, neuralLuma / baseLuma));

        outputPixels.data[outputOffset] = Math.max(0, Math.min(255, Math.round(red * ratio * 255)));
        outputPixels.data[outputOffset + 1] = Math.max(0, Math.min(255, Math.round(green * ratio * 255)));
        outputPixels.data[outputOffset + 2] = Math.max(0, Math.min(255, Math.round(blue * ratio * 255)));
        outputPixels.data[outputOffset + 3] = 255;
      }
    }

    this.context.putImageData(outputPixels, 0, 0);
  }

  private paintFallbackFrame(width: number, height: number): void {
    this.context.drawImage(this.video, 0, 0, width, height);
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

  private resizeSourceCanvas(width: number, height: number): void {
    if (this.sourceCanvas.width !== width) {
      this.sourceCanvas.width = width;
    }
    if (this.sourceCanvas.height !== height) {
      this.sourceCanvas.height = height;
    }
  }
}

export const createWebGpuArtCnnPipeline = (
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  options?: WebGpuArtCnnPipelineOptions,
): WebGpuArtCnnPipeline => new WebGpuArtCnnPipeline(canvas, video, options);

const assertAlive = (destroyed: boolean): void => {
  if (destroyed) {
    throw new WebGpuArtCnnPipelineError('ArtCNN pipeline has already been destroyed.');
  }
};
