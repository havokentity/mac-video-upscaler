import type { UpscalerMode, UpscalerSettings } from '../common/modes';
import { classifyVideoFrame } from './auto/classifier';
import { createWebGL2CrispPipeline, WebGpuCrispPipeline } from './modes/crisp';
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

type ImplementedMode = Extract<UpscalerMode, 'crisp' | 'sharpen' | 'smooth'>;

const isImplementedMode = (mode: UpscalerMode): mode is ImplementedMode =>
  mode === 'crisp' || mode === 'sharpen' || mode === 'smooth';

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

  let webgpuFailure: string | undefined;
  const requestedMode = settings.mode;
  const autoClassification = requestedMode === 'auto' ? classifyVideoFrame(video) : undefined;
  const selectedMode = autoClassification?.mode ?? requestedMode;
  const mode = isImplementedMode(selectedMode) ? selectedMode : 'crisp';
  const autoPrefix =
    autoClassification === undefined
      ? ''
      : `Auto -> ${autoClassification.mode}${mode !== autoClassification.mode ? ` (using ${mode} until ${autoClassification.mode} lands)` : ''}; `;

  if (requestedMode !== 'auto' && !isImplementedMode(requestedMode)) {
    return new DisabledPipeline(`${requestedMode} mode is not implemented yet.`, requestedMode);
  }

  if (mode === 'crisp') {
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
        webgpuFailure = getErrorMessage(error, 'Unknown WebGPU Crisp initialization error.');
      }
    }

    try {
      const pipeline = createWebGL2CrispPipeline(canvas, video, {
        scale: settings.scale,
        sharpness: settings.fsrSharpness,
      });
      pipeline.status.mode = requestedMode === 'auto' ? `auto -> ${mode}` : mode;
      pipeline.status.reason = webgpuFailure
        ? `${autoPrefix}FSR 1.0-style WebGL2 fallback active; WebGPU Crisp unavailable: ${webgpuFailure}`
        : `${autoPrefix}FSR 1.0-style WebGL2 upscale active at ${settings.scale.toFixed(1)}x; sharpness ${settings.fsrSharpness.toFixed(2)}.`;
      return pipeline;
    } catch (error) {
      const reason = getErrorMessage(error, 'Unknown WebGL2 Crisp error.');
      return new DisabledPipeline(
        webgpuFailure ? `WebGPU Crisp failed: ${webgpuFailure}; WebGL2 Crisp failed: ${reason}` : reason,
      );
    }
  }

  if (mode === 'sharpen') {
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
        webgpuFailure = getErrorMessage(error, 'Unknown WebGPU Sharpen initialization error.');
      }
    }

    try {
      const pipeline = createWebGL2SharpenPipeline(canvas, video, {
        sharpness: settings.fsrSharpness,
      });
      pipeline.status.mode = requestedMode === 'auto' ? `auto -> ${mode}` : mode;
      pipeline.status.reason = webgpuFailure
        ? `${autoPrefix}CAS-style WebGL2 fallback active; WebGPU Sharpen unavailable: ${webgpuFailure}`
        : `${autoPrefix}CAS-style WebGL2 sharpen active at 1.0x; sharpness ${settings.fsrSharpness.toFixed(2)}.`;
      return pipeline;
    } catch (error) {
      const reason = getErrorMessage(error, 'Unknown WebGL2 Sharpen error.');
      return new DisabledPipeline(
        webgpuFailure
          ? `WebGPU Sharpen failed: ${webgpuFailure}; WebGL2 Sharpen failed: ${reason}`
          : reason,
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
