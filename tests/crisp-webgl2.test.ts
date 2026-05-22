import { describe, expect, it } from 'vitest';

import {
  computeCrispOutputSize,
  normalizeCrispScale,
  normalizeCrispSharpness,
} from '../src/upscaler/modes/crisp';

describe('WebGL2 Crisp helpers', () => {
  it('normalizes scale to the supported milestone range', () => {
    expect(normalizeCrispScale(undefined)).toBe(1.5);
    expect(normalizeCrispScale(Number.NaN)).toBe(1.5);
    expect(normalizeCrispScale(0.5)).toBe(1);
    expect(normalizeCrispScale(1.7)).toBe(1.7);
    expect(normalizeCrispScale(4)).toBe(2);
  });

  it('normalizes sharpness to the RCAS-style slider range', () => {
    expect(normalizeCrispSharpness(undefined)).toBe(0.2);
    expect(normalizeCrispSharpness(Number.POSITIVE_INFINITY)).toBe(0.2);
    expect(normalizeCrispSharpness(-0.25)).toBe(0);
    expect(normalizeCrispSharpness(0.65)).toBe(0.65);
    expect(normalizeCrispSharpness(1.5)).toBe(1);
  });

  it('uses the source video dimensions when they are available', () => {
    expect(
      computeCrispOutputSize({
        requestedHeight: 720,
        requestedWidth: 1280,
        scale: 1.5,
        sourceHeight: 1080,
        sourceWidth: 1920,
      }),
    ).toEqual({ height: 1620, width: 2880 });
  });

  it('falls back to requested canvas dimensions before metadata is available', () => {
    expect(
      computeCrispOutputSize({
        requestedHeight: 480,
        requestedWidth: 640,
        scale: 1.5,
        sourceHeight: 0,
        sourceWidth: 0,
      }),
    ).toEqual({ height: 720, width: 960 });
  });
});
