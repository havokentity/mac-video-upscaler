import type { UpscalerMode } from '../../common/modes';

export type AutoSelectableMode = Exclude<UpscalerMode, 'auto' | 'neural-pro'>;

export interface FrameSignature {
  colorVariance: number;
  edgeDensity: number;
  flatRegionRatio: number;
}

export interface FrameSample {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface AutoClassifierOptions {
  readonly sampleWidth?: number;
  readonly sampleHeight?: number;
  readonly edgeThreshold?: number;
  readonly flatThreshold?: number;
}

export interface VideoFrameClassification {
  readonly mode: AutoSelectableMode;
  readonly signature: FrameSignature | null;
  readonly sampleWidth: number;
  readonly sampleHeight: number;
  readonly reason: 'classified' | 'video-not-ready' | 'sample-failed';
  readonly error?: string;
}

type SamplingCanvas = HTMLCanvasElement | OffscreenCanvas;
type SamplingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const DEFAULT_SAMPLE_WIDTH = 96;
const DEFAULT_SAMPLE_HEIGHT = 54;
const DEFAULT_EDGE_THRESHOLD = 0.12;
const DEFAULT_FLAT_THRESHOLD = 0.045;
const HAVE_CURRENT_DATA = 2;

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

const getLuma = (data: Uint8ClampedArray, pixelIndex: number): number => {
  const offset = pixelIndex * 4;
  return (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255;
};

const getMeanAbsoluteChannelDelta = (data: Uint8ClampedArray, firstPixel: number, secondPixel: number): number => {
  const first = firstPixel * 4;
  const second = secondPixel * 4;
  const redDelta = Math.abs(data[first] - data[second]);
  const greenDelta = Math.abs(data[first + 1] - data[second + 1]);
  const blueDelta = Math.abs(data[first + 2] - data[second + 2]);

  return (redDelta + greenDelta + blueDelta) / (255 * 3);
};

export const normalizeFrameSignature = (signature: FrameSignature): FrameSignature => ({
  colorVariance: clampUnit(signature.colorVariance),
  edgeDensity: clampUnit(signature.edgeDensity),
  flatRegionRatio: clampUnit(signature.flatRegionRatio),
});

export const pickModeFromSignature = (signature: FrameSignature): AutoSelectableMode => {
  const normalized = normalizeFrameSignature(signature);

  if (normalized.flatRegionRatio > 0.58 && normalized.edgeDensity > 0.28) {
    return 'anime';
  }

  if (normalized.colorVariance < 0.055 && normalized.edgeDensity < 0.16) {
    return 'smooth';
  }

  if (normalized.edgeDensity > 0.42 && normalized.colorVariance > 0.12) {
    return 'neural-lite';
  }

  return 'crisp';
};

export const computeFrameSignature = (sample: FrameSample, options: AutoClassifierOptions = {}): FrameSignature => {
  if (sample.width < 1 || sample.height < 1 || sample.data.length < sample.width * sample.height * 4) {
    throw new Error('Frame sample dimensions do not match RGBA data.');
  }

  const pixelCount = sample.width * sample.height;
  let lumaSum = 0;
  let lumaSquareSum = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const luma = getLuma(sample.data, pixelIndex);
    lumaSum += luma;
    lumaSquareSum += luma * luma;
  }

  const mean = lumaSum / pixelCount;
  const colorVariance = clampUnit((lumaSquareSum / pixelCount - mean * mean) * 4);

  if (sample.width < 2 || sample.height < 2) {
    return {
      colorVariance,
      edgeDensity: 0,
      flatRegionRatio: 1,
    };
  }

  const edgeThreshold = options.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD;
  const flatThreshold = options.flatThreshold ?? DEFAULT_FLAT_THRESHOLD;
  let edgeCount = 0;
  let flatCount = 0;
  let comparisonCount = 0;

  for (let y = 0; y < sample.height - 1; y += 1) {
    for (let x = 0; x < sample.width - 1; x += 1) {
      const pixelIndex = y * sample.width + x;
      const rightDelta = getMeanAbsoluteChannelDelta(sample.data, pixelIndex, pixelIndex + 1);
      const downDelta = getMeanAbsoluteChannelDelta(sample.data, pixelIndex, pixelIndex + sample.width);
      const edgeStrength = Math.max(rightDelta, downDelta);

      if (edgeStrength >= edgeThreshold) {
        edgeCount += 1;
      }

      if (edgeStrength <= flatThreshold) {
        flatCount += 1;
      }

      comparisonCount += 1;
    }
  }

  return {
    colorVariance,
    edgeDensity: comparisonCount === 0 ? 0 : edgeCount / comparisonCount,
    flatRegionRatio: comparisonCount === 0 ? 1 : flatCount / comparisonCount,
  };
};

export const computeDownsampleSize = (
  sourceWidth: number,
  sourceHeight: number,
  options: AutoClassifierOptions = {},
): { width: number; height: number } => {
  const targetWidth = Math.max(1, Math.floor(options.sampleWidth ?? DEFAULT_SAMPLE_WIDTH));
  const targetHeight = Math.max(1, Math.floor(options.sampleHeight ?? DEFAULT_SAMPLE_HEIGHT));

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { width: targetWidth, height: targetHeight };
  }

  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight, 1);

  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
};

export const classifyFrameSample = (sample: FrameSample, options: AutoClassifierOptions = {}): VideoFrameClassification => {
  const signature = computeFrameSignature(sample, options);

  return {
    mode: pickModeFromSignature(signature),
    signature,
    sampleWidth: sample.width,
    sampleHeight: sample.height,
    reason: 'classified',
  };
};

export const sampleVideoFrame = (video: HTMLVideoElement, options: AutoClassifierOptions = {}): FrameSample => {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;

  if (sourceWidth <= 0 || sourceHeight <= 0 || video.readyState < HAVE_CURRENT_DATA) {
    throw new Error('Video frame is not ready for auto classification.');
  }

  const { width, height } = computeDownsampleSize(sourceWidth, sourceHeight, options);
  const canvas = createSamplingCanvas(width, height);
  const context = getSamplingContext(canvas);

  context.clearRect(0, 0, width, height);
  context.drawImage(video, 0, 0, width, height);

  const imageData = context.getImageData(0, 0, width, height);

  return {
    width,
    height,
    data: imageData.data,
  };
};

export const classifyVideoFrame = (
  video: HTMLVideoElement,
  options: AutoClassifierOptions = {},
): VideoFrameClassification => {
  const { width, height } = computeDownsampleSize(video.videoWidth, video.videoHeight, options);

  if (video.videoWidth <= 0 || video.videoHeight <= 0 || video.readyState < HAVE_CURRENT_DATA) {
    return {
      mode: 'crisp',
      signature: null,
      sampleWidth: width,
      sampleHeight: height,
      reason: 'video-not-ready',
    };
  }

  try {
    return classifyFrameSample(sampleVideoFrame(video, options), options);
  } catch (error) {
    return {
      mode: 'crisp',
      signature: null,
      sampleWidth: width,
      sampleHeight: height,
      reason: 'sample-failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const createSamplingCanvas = (width: number, height: number): SamplingCanvas => {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }

  if (typeof document === 'undefined') {
    throw new Error('No canvas implementation is available for auto classification.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  return canvas;
};

const getSamplingContext = (canvas: SamplingCanvas): SamplingContext => {
  const context = canvas.getContext('2d', {
    alpha: false,
    desynchronized: true,
    willReadFrequently: true,
  });

  if (!context) {
    throw new Error('2D canvas context is unavailable for auto classification.');
  }

  return context;
};
