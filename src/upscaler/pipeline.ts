import type { UpscalerMode, UpscalerSettings } from '../common/modes';
import { classifyVideoFrame } from './auto/classifier';
import { createWebGL2AnimePipeline, WebGpuAnimePipeline } from './modes/anime';
import { createWebGL2CrispPipeline, WebGpuCrispPipeline } from './modes/crisp';
import { createWebGL2FunPipeline, type FunFilterMode } from './modes/fun';
import { createWebGpuNeuralLitePipeline } from './modes/neural-lite';
import { createWebGpuNeuralProPipeline } from './modes/neural-pro';
import { createWebGL2SharpenPipeline, WebGpuSharpenPipeline } from './modes/sharpen';
import { WebGpuSmoothPipeline } from './modes/smooth';

export type UpscalerBackend = 'webgpu' | 'webgl2' | 'disabled';

export interface PipelineStatus {
  backend: UpscalerBackend;
  mode?: string;
  reason?: string;
}

export interface FramePipeline {
  readonly status: PipelineStatus;
  renderFrame(): void;
  resize(width: number, height: number): void;
  destroy(): void;
}

export class DisabledPipeline implements FramePipeline {
  readonly status: PipelineStatus;

  constructor(reason: string, mode?: string) {
    this.status = { backend: 'disabled', mode, reason };
  }

  renderFrame(): void {
    // Intentionally empty until a backend is available.
  }

  resize(): void {
    // Nothing to resize.
  }

  destroy(): void {
    // Nothing to release.
  }
}

type ImplementedMode = Extract<
  UpscalerMode,
  'crisp' | 'sharpen' | 'anime' | 'smooth' | FunFilterMode
>;

const isImplementedMode = (mode: UpscalerMode): mode is ImplementedMode =>
  mode === 'crisp' ||
  mode === 'sharpen' ||
  mode === 'anime' ||
  mode === 'smooth' ||
  mode === 'edge' ||
  mode === 'night-vision' ||
  mode === 'predator' ||
  mode === 'crt' ||
  mode === 'invert' ||
  mode === 'cartoon';

const isFunFilterMode = (mode: UpscalerMode): mode is FunFilterMode =>
  mode === 'edge' ||
  mode === 'night-vision' ||
  mode === 'predator' ||
  mode === 'crt' ||
  mode === 'invert' ||
  mode === 'cartoon';

const getErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export const createPipeline = async (
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  settings: UpscalerSettings,
): Promise<FramePipeline> => {
  if (!settings.enabled) {
    return new DisabledPipeline('Extension disabled.');
  }

  const requestedMode = settings.mode;
  if (requestedMode === 'none') {
    return new DisabledPipeline('Native video passthrough active.', 'none');
  }

  const autoClassification = requestedMode === 'auto' ? classifyVideoFrame(video) : undefined;
  const selectedMode = autoClassification?.mode ?? requestedMode;
  const mode = isImplementedMode(selectedMode) ? selectedMode : 'crisp';
  const autoPrefix =
    autoClassification === undefined
      ? ''
      : `Auto -> ${autoClassification.mode}${mode !== autoClassification.mode ? ` (using ${mode} until ${autoClassification.mode} lands)` : ''}; `;

  if (requestedMode === 'neural-lite') {
    return createWebGpuNeuralLitePipeline({
      canvas,
      scale: settings.scale,
      video,
    });
  }

  if (requestedMode === 'neural-pro') {
    return createWebGpuNeuralProPipeline({
      canvas,
      scale: settings.scale,
      variant: settings.ravuVariant,
      video,
    });
  }

  if (isFunFilterMode(mode)) {
    try {
      return createWebGL2FunPipeline(canvas, video, {
        mode,
        scale: settings.scale,
      });
    } catch (error) {
      const reason = getErrorMessage(error, 'Unknown WebGL2 filter error.');
      return new DisabledPipeline(reason, mode);
    }
  }

  if (mode === 'crisp') {
    let webgl2Failure: string | undefined;

    try {
      const pipeline = createWebGL2CrispPipeline(canvas, video, {
        scale: settings.scale,
        sharpness: settings.fsrSharpness,
      });
      pipeline.status.mode = requestedMode === 'auto' ? `auto -> ${mode}` : mode;
      pipeline.status.reason = `${autoPrefix}FSR 1.0-style WebGL2 upscale active at ${settings.scale.toFixed(1)}x; sharpness ${settings.fsrSharpness.toFixed(2)}.`;
      return pipeline;
    } catch (error) {
      webgl2Failure = getErrorMessage(error, 'Unknown WebGL2 Crisp error.');
    }

    if ('gpu' in navigator && navigator.gpu && !settings.forceWebGL2) {
      try {
        const pipeline = await WebGpuCrispPipeline.create({
          canvas,
          forceF32: settings.forceF32,
          presentationFormat: navigator.gpu.getPreferredCanvasFormat(),
          scale: settings.scale,
          sharpness: settings.fsrSharpness,
          video,
        });
        pipeline.status.mode = requestedMode === 'auto' ? `auto -> ${mode}` : mode;
        pipeline.status.reason = `${autoPrefix}${pipeline.status.reason ?? ''}`.trim();
        return pipeline;
      } catch (error) {
        const reason = getErrorMessage(error, 'Unknown WebGPU Crisp initialization error.');
        return new DisabledPipeline(`WebGL2 Crisp failed: ${webgl2Failure}; WebGPU Crisp failed: ${reason}`);
      }
    }

    return new DisabledPipeline(`WebGL2 Crisp failed: ${webgl2Failure}`);
  }

  if (mode === 'sharpen') {
    let webgl2Failure: string | undefined;

    try {
      const pipeline = createWebGL2SharpenPipeline(canvas, video, {
        sharpness: settings.fsrSharpness,
      });
      pipeline.status.mode = requestedMode === 'auto' ? `auto -> ${mode}` : mode;
      pipeline.status.reason = `${autoPrefix}CAS-style WebGL2 sharpen active; sharpness ${settings.fsrSharpness.toFixed(2)}.`;
      return pipeline;
    } catch (error) {
      webgl2Failure = getErrorMessage(error, 'Unknown WebGL2 Sharpen error.');
    }

    if ('gpu' in navigator && navigator.gpu && !settings.forceWebGL2) {
      try {
        const pipeline = await WebGpuSharpenPipeline.create({
          canvas,
          presentationFormat: navigator.gpu.getPreferredCanvasFormat(),
          sharpness: settings.fsrSharpness,
          video,
        });
        pipeline.status.mode = requestedMode === 'auto' ? `auto -> ${mode}` : mode;
        pipeline.status.reason = `${autoPrefix}${pipeline.status.reason ?? ''}`.trim();
        return pipeline;
      } catch (error) {
        const reason = getErrorMessage(error, 'Unknown WebGPU Sharpen initialization error.');
        return new DisabledPipeline(`WebGL2 Sharpen failed: ${webgl2Failure}; WebGPU Sharpen failed: ${reason}`);
      }
    }

    return new DisabledPipeline(`WebGL2 Sharpen failed: ${webgl2Failure}`);
  }

  if (mode === 'anime') {
    let webgl2Failure: string | undefined;

    try {
      const pipeline = createWebGL2AnimePipeline(canvas, video, {
        scale: settings.scale,
        subMode: settings.animeSubMode,
      });
      pipeline.status.mode = requestedMode === 'auto' ? `auto -> ${mode}` : mode;
      pipeline.status.reason = `${autoPrefix}${pipeline.status.reason ?? ''}`.trim();
      return pipeline;
    } catch (error) {
      webgl2Failure = getErrorMessage(error, 'Unknown WebGL2 Anime error.');
    }

    if (!('gpu' in navigator) || !navigator.gpu || settings.forceWebGL2) {
      return new DisabledPipeline(`WebGL2 Anime failed: ${webgl2Failure}`, requestedMode === 'auto' ? `auto -> ${mode}` : mode);
    }

    try {
      const pipeline = await WebGpuAnimePipeline.create({
        canvas,
        presentationFormat: navigator.gpu.getPreferredCanvasFormat(),
        scale: settings.scale,
        subMode: settings.animeSubMode,
        video,
      });
      const status: PipelineStatus = pipeline.status;
      status.mode = requestedMode === 'auto' ? `auto -> ${mode}` : mode;
      status.reason = `${autoPrefix}${pipeline.status.reason ?? ''}`.trim();
      return pipeline;
    } catch (error) {
      const reason = getErrorMessage(error, 'Unknown WebGPU Anime error.');
      return new DisabledPipeline(
        `${autoPrefix}WebGL2 Anime failed: ${webgl2Failure}; WebGPU Anime failed: ${reason}`,
        requestedMode === 'auto' ? `auto -> ${mode}` : mode,
      );
    }
  }

  if (!('gpu' in navigator) || !navigator.gpu || settings.forceWebGL2) {
    return new DisabledPipeline(
      `${autoPrefix}Smooth mode requires WebGPU; WebGL2 fallback is not available.`,
      requestedMode === 'auto' ? `auto -> ${mode}` : mode,
    );
  }

  try {
    const pipeline = await WebGpuSmoothPipeline.create({
      canvas,
      presentationFormat: navigator.gpu.getPreferredCanvasFormat(),
      scale: settings.scale,
      video,
    });
    const status: PipelineStatus = pipeline.status;
    status.mode = requestedMode === 'auto' ? `auto -> ${mode}` : mode;
    status.reason = `${autoPrefix}${pipeline.status.reason ?? ''}`.trim();
    return pipeline;
  } catch (error) {
    const reason = getErrorMessage(error, 'Unknown WebGPU Smooth error.');
    return new DisabledPipeline(
      `${autoPrefix}${reason}`,
      requestedMode === 'auto' ? `auto -> ${mode}` : mode,
    );
  }
};
