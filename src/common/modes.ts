export const UPSCALER_MODES = [
  'none',
  'auto',
  'crisp',
  'sharpen',
  'anime',
  'smooth',
  'edge',
  'night-vision',
  'predator',
  'crt',
  'invert',
  'cartoon',
  'neural-lite',
  'neural-pro',
] as const;

export type UpscalerMode = (typeof UPSCALER_MODES)[number];

export const SCALE_FACTORS = [1.3, 1.5, 1.7, 2.0] as const;

export type ScaleFactor = (typeof SCALE_FACTORS)[number];

export const FRAME_GENERATION_TARGETS = [60, 120] as const;

export type FrameGenerationTargetFps = (typeof FRAME_GENERATION_TARGETS)[number];

export interface UpscalerSettings {
  enabled: boolean;
  mode: UpscalerMode;
  scale: ScaleFactor;
  fsrSharpness: number;
  animeSubMode: 'mode-a' | 'mode-aa';
  ravuVariant: 'auto' | 'zoom' | 'lite';
  frameGenerationEnabled: boolean;
  frameGenerationTargetFps: FrameGenerationTargetFps;
  hudEnabled: boolean;
  forceWebGL2: boolean;
  forceF32: boolean;
  workgroupSize: '8x8' | '16x16';
}

export const DEFAULT_SETTINGS: UpscalerSettings = {
  enabled: true,
  mode: 'auto',
  scale: 1.5,
  fsrSharpness: 0.35,
  animeSubMode: 'mode-aa',
  ravuVariant: 'auto',
  frameGenerationEnabled: false,
  frameGenerationTargetFps: 60,
  hudEnabled: false,
  forceWebGL2: false,
  forceF32: false,
  workgroupSize: '8x8',
};

export const isUpscalerMode = (value: string): value is UpscalerMode =>
  UPSCALER_MODES.includes(value as UpscalerMode);
