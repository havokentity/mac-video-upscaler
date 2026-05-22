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
  crt: 'CRT',
  invert: 'Inverted Colors',
  cartoon: 'Cartoon Rotoscope',
  'neural-lite': 'Neural-Lite Preview',
  'neural-pro': 'Neural-Pro (coming soon)',
};

export const MODE_DESCRIPTIONS: Record<UpscalerMode, string> = {
  none: 'Leaves the original video alone with no filter or upscaler.',
  auto: 'Automatically chooses among the implemented lightweight modes.',
  crisp: 'Fast FSR-style upscaling for general video.',
  sharpen: 'CAS-style native-resolution sharpening.',
  anime: 'Anime4K-inspired line restoration for animation and illustration.',
  smooth: 'WebGPU Lanczos/Jinc-style scaling for smoother live action.',
  edge: 'Experimental WebGL2 edge filter for outlines and artifact inspection.',
  'night-vision': 'Experimental green phosphor WebGL2 filter.',
  predator: 'Experimental thermal false-color WebGL2 filter.',
  crt: 'Experimental CRT scanline, vignette, and color-fringe WebGL2 filter.',
  invert: 'Experimental inverted color WebGL2 filter.',
  cartoon: 'Experimental toon-shader rotoscope WebGL2 filter.',
  'neural-lite': 'Small residual enhancement preview; ArtCNN weights remain the target port.',
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
  'crt',
  'invert',
  'cartoon',
  'neural-lite',
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
  const isNeuralLite = mode === 'neural-lite';
  const isFunFilter =
    mode === 'edge' ||
    mode === 'night-vision' ||
    mode === 'predator' ||
    mode === 'crt' ||
    mode === 'invert' ||
    mode === 'cartoon';

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
          ? 'Anime uses WebGL2 first and keeps the Anime4K sub-mode control.'
          : isNeuralLite
            ? 'Neural-Lite preview uses WebGL2 first; ArtCNN weight port is still pending.'
          : isSmooth
          ? 'Smooth is WebGPU-only.'
          : isFunFilter
            ? 'Experimental filter rendered with WebGL2.'
          : 'Crisp and Sharpen use WebGL2 first while WebGPU quality paths are revalidated.'
      : 'Visible for planning; disabled until its shader implementation lands.',
  };
};
