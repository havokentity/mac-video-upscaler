import { describe, expect, it } from 'vitest';

import { computeSharpenOutputSize, normalizeSharpenSharpness } from '../src/upscaler/modes/sharpen';

describe('Sharpen helpers', () => {
  it('normalizes sharpness to the CAS-style slider range', () => {
    expect(normalizeSharpenSharpness(undefined)).toBe(0.35);
    expect(normalizeSharpenSharpness(Number.NaN)).toBe(0.35);
    expect(normalizeSharpenSharpness(-0.5)).toBe(0);
    expect(normalizeSharpenSharpness(0.5)).toBe(0.5);
    expect(normalizeSharpenSharpness(2)).toBe(1);
  });

  it('keeps Sharpen at native source resolution', () => {
    expect(
      computeSharpenOutputSize({
        requestedHeight: 720,
        requestedWidth: 1280,
        sourceHeight: 1080,
        sourceWidth: 1920,
      }),
    ).toEqual({ height: 1080, width: 1920 });
  });

  it('falls back to requested canvas dimensions before metadata is available', () => {
    expect(
      computeSharpenOutputSize({
        requestedHeight: 480,
        requestedWidth: 640,
        sourceHeight: 0,
        sourceWidth: 0,
      }),
    ).toEqual({ height: 480, width: 640 });
  });
});
