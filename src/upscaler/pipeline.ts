import type { UpscalerSettings } from '../common/modes';
import { createWebGL2CrispPipeline } from './modes/crisp';
import { createWebGL2CopyPipeline } from './webgl2';
import { WebGpuVideoCopyPipeline } from './webgpu';

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

  constructor(reason: string) {
    this.status = { backend: 'disabled', reason };
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

export const createPipeline = async (
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  settings: UpscalerSettings,
): Promise<FramePipeline> => {
  if (!settings.enabled) {
    return new DisabledPipeline('Extension disabled.');
  }

  let webgpuFailure: string | undefined;

  if (settings.mode === 'crisp') {
    try {
      const pipeline = createWebGL2CrispPipeline(canvas, video, {
        scale: 1.5,
        sharpness: settings.fsrSharpness,
      });
      pipeline.status.reason = `FSR 1.0-style WebGL2 upscale active at 1.5x; sharpness ${settings.fsrSharpness.toFixed(2)}.`;
      return pipeline;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown WebGL2 Crisp error.';
      return new DisabledPipeline(reason);
    }
  }

  if ('gpu' in navigator && navigator.gpu && !settings.forceWebGL2) {
    try {
      const pipeline = await WebGpuVideoCopyPipeline.create({
        canvas,
        video,
        presentationFormat: navigator.gpu.getPreferredCanvasFormat(),
      });
      pipeline.status.mode = 'copy';
      pipeline.status.reason = '1:1 copy active.';
      return pipeline;
    } catch (error) {
      webgpuFailure = error instanceof Error ? error.message : 'Unknown WebGPU initialization error.';
    }
  }

  try {
    const pipeline = createWebGL2CopyPipeline(canvas, video);
    pipeline.status.mode = 'copy';
    pipeline.status.reason = webgpuFailure
      ? `1:1 copy fallback active; WebGPU unavailable: ${webgpuFailure}`
      : '1:1 copy fallback active.';
    return pipeline;
  } catch (error) {
    const webglFailure =
      error instanceof Error ? error.message : 'Unknown WebGL2 initialization error.';
    const reason = webgpuFailure
      ? `WebGPU failed: ${webgpuFailure}; WebGL2 failed: ${webglFailure}`
      : webglFailure;

    return new DisabledPipeline(reason);
  }
};
