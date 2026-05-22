import type { UpscalerMode } from '../common/modes';

export const MODE_LABELS: Record<UpscalerMode, string> = {
  none: 'None',
  auto: 'Auto',
  crisp: 'Crisp (FSR)',
  sharpen: 'Sharpen (CAS)',
  anime: 'Anime (Anime4K)',
  smooth: 'Smooth (Lanczos)',
  edge: 'Edge Detect',
  'night-vision': 'Night Vision',
  predator: 'Predator',
  'neural-lite': 'Neural-Lite (coming soon)',
  'neural-pro': 'Neural-Pro (coming soon)',
};

export const MODE_DESCRIPTIONS: Record<UpscalerMode, string> = {
  none: 'Leaves the original video alone with no filter or upscaler.',
  auto: 'Automatically chooses among the implemented lightweight modes.',
  crisp: 'Fast FSR-style upscaling for general video.',
  sharpen: 'CAS-style native-resolution sharpening.',
  anime: 'Anime4K-inspired WebGPU shader chain for animation and illustration.',
  smooth: 'WebGPU Lanczos/Jinc-style scaling for smoother live action.',
  edge: 'Experimental WebGL2 edge filter for outlines and artifact inspection.',
  'night-vision': 'Experimental green phosphor WebGL2 filter.',
  predator: 'Experimental thermal false-color WebGL2 filter.',
  'neural-lite': 'ArtCNN is reserved for the neural-lite milestone.',
  'neural-pro': 'RAVU is reserved for the LGPL neural-pro milestone.',
};

const IMPLEMENTED_MODES = new Set<UpscalerMode>([
  'none',
  'auto',
  'crisp',
  'sharpen',
  'anime',
  'smooth',
  'edge',
  'night-vision',
  'predator',
]);

export interface ModeControlState {
  animeVisible: boolean;
  frameGenerationVisible: boolean;
  implemented: boolean;
  ravuVisible: boolean;
  scaleVisible: boolean;
  sharpnessLabel: string;
  sharpnessVisible: boolean;
  supportNote: string;
}

export const isImplementedMode = (mode: UpscalerMode): boolean => IMPLEMENTED_MODES.has(mode);

export const getModeControlState = (mode: UpscalerMode): ModeControlState => {
  const implemented = isImplementedMode(mode);
  const isNone = mode === 'none';
  const isSharpen = mode === 'sharpen';
  const isSmooth = mode === 'smooth';
  const isAnime = mode === 'anime';
  const isFunFilter = mode === 'edge' || mode === 'night-vision' || mode === 'predator';

  return {
    animeVisible: mode === 'anime',
    frameGenerationVisible: !isNone,
    implemented,
    ravuVisible: mode === 'neural-pro',
    scaleVisible: !isNone && !isSharpen,
    sharpnessLabel: isSharpen ? 'CAS sharpness' : 'FSR sharpness',
    sharpnessVisible: !isNone && !isSmooth && !isAnime && !isFunFilter,
    supportNote: implemented
      ? isNone
        ? 'Native video passthrough; no overlay rendering is applied.'
        : isSharpen
        ? 'Sharpen renders at 1.0x and ignores scale.'
        : isAnime
          ? 'Anime is WebGPU-only and uses the Anime4K sub-mode control.'
        : isSmooth
          ? 'Smooth is WebGPU-only.'
          : isFunFilter
            ? 'Experimental filter rendered with WebGL2.'
            : 'Uses WebGPU first and falls back where supported.'
      : 'Visible for planning; disabled until its shader implementation lands.',
  };
};
