import { describe, expect, it } from 'vitest';

import {
  classifyFrameSample,
  classifyVideoFrame,
  computeDownsampleSize,
  computeFrameSignature,
  pickModeFromSignature,
  type FrameSample,
} from '../src/upscaler/auto/classifier';

const makeSample = (width: number, height: number, fillPixel: (x: number, y: number) => [number, number, number]): FrameSample => {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [red, green, blue] = fillPixel(x, y);
      data[offset] = red;
      data[offset + 1] = green;
      data[offset + 2] = blue;
      data[offset + 3] = 255;
    }
  }

  return { width, height, data };
};

describe('auto classifier pure helpers', () => {
  it('downsamples within the target box without upscaling small sources', () => {
    expect(computeDownsampleSize(1920, 1080)).toEqual({ width: 96, height: 54 });
    expect(computeDownsampleSize(640, 480, { sampleWidth: 96, sampleHeight: 54 })).toEqual({ width: 72, height: 54 });
    expect(computeDownsampleSize(32, 18)).toEqual({ width: 32, height: 18 });
  });

  it('detects flat low-variance frames', () => {
    const sample = makeSample(8, 8, () => [96, 96, 96]);
    const signature = computeFrameSignature(sample);

    expect(signature.colorVariance).toBeCloseTo(0, 5);
    expect(signature.edgeDensity).toBe(0);
    expect(signature.flatRegionRatio).toBe(1);
    expect(pickModeFromSignature(signature)).toBe('smooth');
  });

  it('detects flat color regions with hard edges as anime-like', () => {
    const sample = makeSample(16, 16, (x) => (x % 5 === 0 ? [12, 12, 12] : [242, 242, 242]));
    const signature = computeFrameSignature(sample);

    expect(signature.edgeDensity).toBeGreaterThan(0.28);
    expect(signature.flatRegionRatio).toBeGreaterThan(0.58);
    expect(classifyFrameSample(sample).mode).toBe('anime');
  });

  it('selects neural-lite for detailed high-variance edges and never neural-pro', () => {
    const sample = makeSample(12, 12, (x, y) => ((x + y) % 2 === 0 ? [0, 36, 255] : [255, 218, 0]));
    const classification = classifyFrameSample(sample);

    expect(classification.mode).toBe('neural-lite');
    expect(classification.mode).not.toBe('neural-pro');
  });

  it('clamps noisy caller-provided signatures before picking a mode', () => {
    expect(
      pickModeFromSignature({
        colorVariance: 9,
        edgeDensity: 9,
        flatRegionRatio: -4,
      }),
    ).toBe('neural-lite');
  });
});

describe('video frame classifier wrapper', () => {
  it('falls back to crisp when a video frame is not ready', () => {
    const video = {
      videoWidth: 0,
      videoHeight: 0,
      readyState: 0,
    } as HTMLVideoElement;

    expect(classifyVideoFrame(video)).toMatchObject({
      mode: 'crisp',
      signature: null,
      reason: 'video-not-ready',
    });
  });
});
