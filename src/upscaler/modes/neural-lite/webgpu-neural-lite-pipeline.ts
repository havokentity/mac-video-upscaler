import type { FramePipeline, PipelineStatus } from '../../pipeline';
import { ARTCNN_UPSTREAM } from './artcnn-attribution';
import { ARTCNN_C4F16_PORT_PLAN, getArtCnnPortSummary } from './artcnn-port';

const MIN_SCALE = 1;
const MAX_SCALE = 2;
const DEFAULT_SCALE = 1.5;
const DEFAULT_VARIANT = 'ArtCNN_C4F16';

export type NeuralLiteVariant = typeof DEFAULT_VARIANT;

export interface WebGpuNeuralLitePipelineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly video: HTMLVideoElement;
  readonly scale?: number;
  readonly variant?: NeuralLiteVariant;
}

export interface WebGpuNeuralLitePipelineStatus extends PipelineStatus {
  backend: 'disabled';
  mode: 'neural-lite';
  adapterName: string;
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  variant: NeuralLiteVariant;
  upstreamCommit: string;
  portStageCount: number;
  previewShader: string;
}

export interface NeuralLiteOutputSize {
  readonly width: number;
  readonly height: number;
}

export interface ComputeNeuralLiteOutputSizeInput {
  readonly requestedWidth: number;
  readonly requestedHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly scale: number;
}

export class WebGpuNeuralLitePipelineError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WebGpuNeuralLitePipelineError';
    this.cause = cause;
  }
}

/*
 * Neural-Lite is reserved for an ArtCNN C4F16 WGSL port. The upstream GLSL is
 * MIT-licensed and verified, but the actual CNN weights/passes are not copied
 * here until the port can preserve attribution and be visually validated.
 */
export class WebGpuNeuralLitePipeline implements FramePipeline {
  readonly status: WebGpuNeuralLitePipelineStatus;

  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly variant: NeuralLiteVariant;
  private scale: number;
  private requestedWidth = 1;
  private requestedHeight = 1;
  private destroyed = false;

  constructor(options: WebGpuNeuralLitePipelineOptions) {
    this.canvas = options.canvas;
    this.video = options.video;
    this.scale = normalizeNeuralLiteScale(options.scale);
    this.variant = options.variant ?? DEFAULT_VARIANT;

    this.status = {
      adapterName: 'WebGPU ArtCNN port pending',
      backend: 'disabled',
      canvasHeight: this.canvas.height,
      canvasWidth: this.canvas.width,
      mode: 'neural-lite',
      reason: getNeuralLiteDisabledReason(),
      scale: this.scale,
      sourceHeight: this.video.videoHeight,
      sourceWidth: this.video.videoWidth,
      portStageCount: ARTCNN_C4F16_PORT_PLAN.stages.length,
      previewShader: ARTCNN_C4F16_PORT_PLAN.localPreviewShader,
      upstreamCommit: ARTCNN_UPSTREAM.verifiedCommit,
      variant: this.variant,
    };
  }

  static create(options: WebGpuNeuralLitePipelineOptions): Promise<WebGpuNeuralLitePipeline> {
    return Promise.resolve(new WebGpuNeuralLitePipeline(options));
  }

  resize(width: number, height: number): void {
    if (this.destroyed) {
      return;
    }

    this.requestedWidth = Math.max(1, Math.floor(width));
    this.requestedHeight = Math.max(1, Math.floor(height));
    this.updateStatusSize();
  }

  setScale(scale: number): void {
    if (this.destroyed) {
      return;
    }

    this.scale = normalizeNeuralLiteScale(scale);
    this.status.scale = this.scale;
    this.updateStatusSize();
  }

  renderFrame(): void {
    if (this.destroyed) {
      return;
    }

    this.updateStatusSize();
    this.status.reason = getNeuralLiteDisabledReason();
  }

  destroy(): void {
    this.destroyed = true;
  }

  private updateStatusSize(): void {
    const output = computeNeuralLiteOutputSize({
      requestedHeight: this.requestedHeight,
      requestedWidth: this.requestedWidth,
      scale: this.scale,
      sourceHeight: this.video.videoHeight,
      sourceWidth: this.video.videoWidth,
    });

    this.status.canvasWidth = output.width;
    this.status.canvasHeight = output.height;
    this.status.sourceWidth = this.video.videoWidth;
    this.status.sourceHeight = this.video.videoHeight;
  }
}

export const createWebGpuNeuralLitePipeline = (
  options: WebGpuNeuralLitePipelineOptions,
): Promise<WebGpuNeuralLitePipeline> => WebGpuNeuralLitePipeline.create(options);

export const normalizeNeuralLiteScale = (scale: number | undefined): number => {
  if (scale === undefined || !Number.isFinite(scale)) {
    return DEFAULT_SCALE;
  }

  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
};

export const computeNeuralLiteOutputSize = ({
  requestedHeight,
  requestedWidth,
  scale,
  sourceHeight,
  sourceWidth,
}: ComputeNeuralLiteOutputSizeInput): NeuralLiteOutputSize => {
  const normalizedScale = normalizeNeuralLiteScale(scale);
  const widthBasis = sourceWidth > 0 ? sourceWidth : requestedWidth;
  const heightBasis = sourceHeight > 0 ? sourceHeight : requestedHeight;

  return {
    height: Math.max(1, requestedHeight, Math.round(heightBasis * normalizedScale)),
    width: Math.max(1, requestedWidth, Math.round(widthBasis * normalizedScale)),
  };
};

export const getNeuralLiteDisabledReason = (): string =>
  `${getArtCnnPortSummary()} Source: ${ARTCNN_UPSTREAM.repository} at ${ARTCNN_UPSTREAM.verifiedCommit}; upstream license MIT.`;
