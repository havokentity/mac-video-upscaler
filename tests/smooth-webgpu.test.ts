import { describe, expect, it } from 'vitest';

import {
  computeSmoothOutputSize,
  normalizeSmoothScale,
} from '../src/upscaler/modes/smooth';

describe('WebGPU Smooth helpers', () => {
  it('normalizes scale to the supported live-upscale range', () => {
    expect(normalizeSmoothScale(undefined)).toBe(1.5);
    expect(normalizeSmoothScale(Number.NaN)).toBe(1.5);
    expect(normalizeSmoothScale(0.5)).toBe(1);
    expect(normalizeSmoothScale(1.7)).toBe(1.7);
    expect(normalizeSmoothScale(4)).toBe(2);
  });

  it('uses source video dimensions when metadata is available', () => {
    expect(
      computeSmoothOutputSize({
        requestedHeight: 720,
        requestedWidth: 1280,
        scale: 1.5,
        sourceHeight: 1080,
        sourceWidth: 1920,
      }),
    ).toEqual({ height: 1620, width: 2880 });
  });

  it('falls back to requested canvas dimensions before video metadata is available', () => {
    expect(
      computeSmoothOutputSize({
        requestedHeight: 360,
        requestedWidth: 640,
        scale: 2,
        sourceHeight: 0,
        sourceWidth: 0,
      }),
    ).toEqual({ height: 720, width: 1280 });
  });
});
