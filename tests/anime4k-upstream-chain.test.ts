import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ANIME4K_SOURCE_FILES,
  ANIME4K_UPSTREAM_COMMIT,
  MODE_A_FAST_CHAIN,
  MODE_AA_FAST_CHAIN,
  RESTORE_CNN_M_PASSES,
  RESTORE_CNN_S_PASSES,
  UPSCALE_CNN_M_PASSES,
  UPSCALE_CNN_S_PASSES,
} from '../src/upscaler/modes/anime/upstream-shader-chain';

const upstreamDirectory = join(process.cwd(), 'src/upscaler/modes/anime/upstream');
const bundledUpstreamFiles = [
  'Anime4K_AutoDownscalePre_x2.glsl',
  'Anime4K_AutoDownscalePre_x4.glsl',
  'Anime4K_Clamp_Highlights.glsl',
  'Anime4K_Restore_CNN_M.glsl',
  'Anime4K_Restore_CNN_S.glsl',
  'Anime4K_Upscale_CNN_x2_M.glsl',
  'Anime4K_Upscale_CNN_x2_S.glsl',
] as const;

describe('Anime4K upstream shader chain', () => {
  it('pins the imported Anime4K upstream commit', () => {
    expect(ANIME4K_UPSTREAM_COMMIT).toBe('7684e9586f8dcc738af08a1cdceb024cc184f426');
  });

  it('preserves MIT headers on every bundled upstream shader source', () => {
    ANIME4K_SOURCE_FILES.forEach(({ source }) => {
      expect(source).toContain('MIT License');
      expect(source).toContain('Copyright (c) 2019-2021 bloc97');
    });
  });

  it('keeps attribution headers on every copied upstream Anime4K file', () => {
    bundledUpstreamFiles.forEach((fileName) => {
      const source = readFileSync(join(upstreamDirectory, fileName), 'utf8');
      expect(source).toMatch(/MIT License|public domain/);
    });
  });

  it('parses the expected upstream CNN pass counts', () => {
    expect(RESTORE_CNN_M_PASSES).toHaveLength(8);
    expect(RESTORE_CNN_S_PASSES).toHaveLength(4);
    expect(UPSCALE_CNN_M_PASSES).toHaveLength(9);
    expect(UPSCALE_CNN_S_PASSES).toHaveLength(5);
  });

  it('builds the Fast Mode A and A+A chains from upstream restore/upscale blocks', () => {
    expect(MODE_A_FAST_CHAIN).toHaveLength(22);
    expect(MODE_AA_FAST_CHAIN).toHaveLength(26);
    expect(MODE_A_FAST_CHAIN[0].description).toContain('Restore-CNN-(M)');
    expect(MODE_A_FAST_CHAIN.at(-1)?.description).toContain('Depth-to-Space');
    expect(MODE_AA_FAST_CHAIN[17].description).toContain('Restore-CNN-(S)');
  });
});
