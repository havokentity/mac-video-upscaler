import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ARTCNN_C4F16_MODEL_PATH,
  ARTCNN_UPSTREAM,
  ORT_JSEP_MJS_PATH,
  ORT_JSEP_WASM_PATH,
  computeNeuralLiteOutputSize,
  createWebGpuNeuralLitePipeline,
  getArtCnnModelUrl,
  getNeuralLiteDisabledReason,
  getOrtWasmPaths,
  normalizeNeuralLiteScale,
} from '../src/upscaler/modes/neural-lite';

describe('Neural-Lite ArtCNN', () => {
  it('records verified upstream ArtCNN attribution', () => {
    expect(ARTCNN_UPSTREAM.repository).toBe('https://github.com/Artoriuz/ArtCNN');
    expect(ARTCNN_UPSTREAM.license).toBe('MIT');
    expect(ARTCNN_UPSTREAM.verifiedCommit).toBe(
      'b2fb535f3446060f9cb1782937f46385ea6cacc5',
    );
    expect(ARTCNN_UPSTREAM.latestRelease).toBe('v1.6.2');
    expect(ARTCNN_UPSTREAM.smallestRealtimeVariant.name).toBe('ArtCNN_C4F16');
    expect(ARTCNN_UPSTREAM.smallestRealtimeVariant.blobSha).toBe(
      '4086dce92db6c1d9d81d3e396aa94d35a1e389a8',
    );
  });

  it('normalizes scale to the live-upscale range', () => {
    expect(normalizeNeuralLiteScale(undefined)).toBe(1.5);
    expect(normalizeNeuralLiteScale(Number.NaN)).toBe(1.5);
    expect(normalizeNeuralLiteScale(0.25)).toBe(1);
    expect(normalizeNeuralLiteScale(1.7)).toBe(1.7);
    expect(normalizeNeuralLiteScale(3)).toBe(2);
  });

  it('computes output size from video dimensions when available', () => {
    expect(
      computeNeuralLiteOutputSize({
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
      computeNeuralLiteOutputSize({
        requestedHeight: 360,
        requestedWidth: 640,
        scale: 2,
        sourceHeight: 0,
        sourceWidth: 0,
      }),
    ).toEqual({ height: 720, width: 1280 });
  });

  it('keeps display backing size when the page stretches tiny video', () => {
    expect(
      computeNeuralLiteOutputSize({
        requestedHeight: 2160,
        requestedWidth: 3840,
        scale: 1.5,
        sourceHeight: 144,
        sourceWidth: 256,
      }),
    ).toEqual({ height: 2160, width: 3840 });
  });

  it('resolves packaged ArtCNN ONNX and ORT assets', () => {
    expect(ARTCNN_C4F16_MODEL_PATH).toBe('models/artcnn/ArtCNN_C4F16.onnx');
    expect(ORT_JSEP_MJS_PATH).toBe('ort/ort-wasm-simd-threaded.jsep.mjs');
    expect(ORT_JSEP_WASM_PATH).toBe('ort/ort-wasm-simd-threaded.jsep.wasm');
    expect(getArtCnnModelUrl()).toBe('/models/artcnn/ArtCNN_C4F16.onnx');
    expect(getOrtWasmPaths()).toEqual({
      mjs: '/ort/ort-wasm-simd-threaded.jsep.mjs',
      wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm',
    });
    expect(existsSync(join(process.cwd(), 'public', ARTCNN_C4F16_MODEL_PATH))).toBe(true);
    expect(existsSync(join(process.cwd(), 'public', ORT_JSEP_MJS_PATH))).toBe(true);
    expect(existsSync(join(process.cwd(), 'public', ORT_JSEP_WASM_PATH))).toBe(true);
  });

  it('keeps the shader-native WebGPU ArtCNN port placeholder disabled until weights land', async () => {
    const canvas = {
      height: 360,
      width: 640,
    } as HTMLCanvasElement;
    const video = {
      videoHeight: 480,
      videoWidth: 854,
    } as HTMLVideoElement;

    const pipeline = await createWebGpuNeuralLitePipeline({ canvas, scale: 1.5, video });

    expect(pipeline.status.backend).toBe('disabled');
    expect(pipeline.status.mode).toBe('neural-lite');
    expect(pipeline.status.variant).toBe('ArtCNN_C4F16');
    expect(pipeline.status.upstreamCommit).toBe(ARTCNN_UPSTREAM.verifiedCommit);
    expect(pipeline.status.reason).toBe(getNeuralLiteDisabledReason());

    pipeline.resize(640, 360);
    pipeline.renderFrame();

    expect(pipeline.status.canvasWidth).toBe(1281);
    expect(pipeline.status.canvasHeight).toBe(720);
    expect(pipeline.status.sourceWidth).toBe(854);
    expect(pipeline.status.sourceHeight).toBe(480);
  });
});
