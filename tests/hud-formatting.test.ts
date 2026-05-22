import { describe, expect, it } from 'vitest';

import {
  buildHudRows,
  formatModeBackend,
  formatRenderedFps,
  formatResolution,
  formatSourceOutputResolution,
  sampleRenderedFps,
} from '../src/overlay/hud';
import type { PipelineStatus } from '../src/upscaler/pipeline';

describe('HUD formatting', () => {
  it('formats mode and backend compatibly with existing smoke tests', () => {
    expect(formatModeBackend({ backend: 'webgl2', mode: 'crisp' })).toBe('webgl2 crisp');
    expect(formatModeBackend({ backend: 'webgpu', mode: 'auto -> smooth' })).toBe(
      'webgpu auto -> smooth',
    );
    expect(formatModeBackend(undefined)).toBe('initializing');
  });

  it('formats source to output resolution when status dimensions are present', () => {
    const status = {
      backend: 'webgpu',
      canvasHeight: 2160,
      canvasWidth: 3840,
      sourceHeight: 1080,
      sourceWidth: 1920,
    } as PipelineStatus & Record<string, unknown>;

    expect(formatSourceOutputResolution(status)).toBe('1920x1080 -> 3840x2160');

    expect(formatResolution(undefined, 720)).toBe('unknown');
  });

  it('formats rendered FPS with a measuring fallback', () => {
    expect(formatRenderedFps(undefined)).toBe('measuring');
    expect(formatRenderedFps(59.944)).toBe('59.9 fps');
  });

  it('builds structured rows with optional adapter and precision details', () => {
    const status = {
      adapterName: 'Apple M3',
      backend: 'webgpu',
      canvasHeight: 2160,
      canvasWidth: 3840,
      mode: 'crisp',
      frameGeneration: 'target 60 fps',
      precision: 'f16',
      reason: 'FSR 1.0-style WebGPU f16 compute upscale active.',
      sourceHeight: 1080,
      sourceWidth: 1920,
    } as PipelineStatus & Record<string, unknown>;

    const rows = buildHudRows(status, { renderedFps: 60 });

    expect(rows).toContainEqual({ label: 'Mode', value: 'webgpu crisp' });
    expect(rows).toContainEqual({ label: 'Resolution', value: '1920x1080 -> 3840x2160' });
    expect(rows).toContainEqual({ label: 'Rendered', value: '60.0 fps' });
    expect(rows).toContainEqual({ label: 'Details', value: 'Apple M3 / f16 / target 60 fps' });
    expect(rows.at(-1)).toEqual({
      label: 'Status',
      value: 'FSR 1.0-style WebGPU f16 compute upscale active.',
    });
  });

  it('samples rendered FPS over a rolling time window', () => {
    const first = sampleRenderedFps([], 0);
    const second = sampleRenderedFps(first.timestamps, 16);
    const third = sampleRenderedFps([...second.timestamps, 900], 1200, 1000);

    expect(first.fps).toBeUndefined();
    expect(second.fps).toBeCloseTo(62.5);
    expect(third.timestamps).toEqual([900, 1200]);
    expect(third.fps).toBeCloseTo(3.333);
  });
});
