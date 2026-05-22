import {
  FRAME_GENERATION_TARGETS,
  SCALE_FACTORS,
  UPSCALER_MODES,
  type ScaleFactor,
  type UpscalerMode,
} from '../common/modes';
import { loadSettings, patchSettings } from '../common/storage';
import './style.css';

const MODE_LABELS: Record<UpscalerMode, string> = {
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

const MODE_NOTES: Record<UpscalerMode, string> = {
  none: 'No filter or upscaler. Shows the original video.',
  auto: 'Picks Crisp, Smooth, or Sharpen-friendly defaults from the video. Neural-Pro is never auto-selected.',
  crisp: 'Fast FSR-style upscaling for live action and general video.',
  sharpen: 'CAS-style edge enhancement at native size.',
  anime: 'Anime4K-inspired WebGPU shader chain for animation and illustration.',
  smooth: 'Cleaner Lanczos/Jinc-style spatial scaling for softer live action.',
  edge: 'Experimental cyan edge overlay for inspecting outlines and compression artifacts.',
  'night-vision': 'Experimental green phosphor look with scanline/noise texture.',
  predator: 'Experimental thermal false-color filter. For science. Mostly.',
  'neural-lite': 'ArtCNN integration is reserved for the next neural milestone.',
  'neural-pro': 'RAVU integration is reserved for the LGPL shader milestone.',
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

const getRequiredElement = (selector: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) {
    throw new Error(`Popup control ${selector} failed to initialize.`);
  }
  return element;
};

const enabled = document.querySelector<HTMLInputElement>('#enabled');
const mode = document.querySelector<HTMLSelectElement>('#mode');
const scale = document.querySelector<HTMLSelectElement>('#scale');
const fsrSharpness = document.querySelector<HTMLInputElement>('#fsrSharpness');
const modeNote = getRequiredElement('#modeNote') as HTMLParagraphElement;
const scaleField = getRequiredElement('#scaleField') as HTMLLabelElement;
const frameGenerationField = getRequiredElement('#frameGenerationField') as HTMLFieldSetElement;
const frameGenerationEnabled = getRequiredElement('#frameGenerationEnabled') as HTMLInputElement;
const frameGenerationTargetField = getRequiredElement(
  '#frameGenerationTargetField',
) as HTMLLabelElement;
const frameGenerationTarget = getRequiredElement('#frameGenerationTarget') as HTMLSelectElement;
const sharpnessField = getRequiredElement('#sharpnessField') as HTMLLabelElement;
const sharpnessLabel = getRequiredElement('#sharpnessLabel');
const sharpnessValue = getRequiredElement('#sharpnessValue') as HTMLOutputElement;
const animeField = getRequiredElement('#animeField') as HTMLFieldSetElement;
const animeSubMode = getRequiredElement('#animeSubMode') as HTMLSelectElement;
const ravuField = getRequiredElement('#ravuField') as HTMLFieldSetElement;
const ravuVariant = getRequiredElement('#ravuVariant') as HTMLSelectElement;
const supportNote = getRequiredElement('#supportNote') as HTMLParagraphElement;

if (!enabled || !mode || !scale || !fsrSharpness) {
  throw new Error('Popup controls failed to initialize.');
}

UPSCALER_MODES.forEach((value) => {
  const option = new Option(MODE_LABELS[value], value);
  option.disabled = !IMPLEMENTED_MODES.has(value);
  mode.add(option);
});
SCALE_FACTORS.forEach((value) => {
  scale.add(new Option(`${value.toFixed(1)}x`, String(value)));
});
FRAME_GENERATION_TARGETS.forEach((value) => {
  frameGenerationTarget.add(new Option(`${String(value)} fps`, String(value)));
});

const settings = await loadSettings();
enabled.checked = settings.enabled;
mode.value = settings.mode;
scale.value = String(settings.scale);
frameGenerationEnabled.checked = settings.frameGenerationEnabled;
frameGenerationTarget.value = String(settings.frameGenerationTargetFps);
fsrSharpness.value = String(settings.fsrSharpness);
animeSubMode.value = settings.animeSubMode;
ravuVariant.value = settings.ravuVariant;

const updateModeControls = (): void => {
  const selectedMode = mode.value as UpscalerMode;
  const sharpness = Number(fsrSharpness.value);
  const isSharpen = selectedMode === 'sharpen';
  const isCrispLike = selectedMode === 'auto' || selectedMode === 'crisp';
  const isSmooth = selectedMode === 'smooth';
  const isAnime = selectedMode === 'anime';
  const isNone = selectedMode === 'none';
  const isFunFilter =
    selectedMode === 'edge' || selectedMode === 'night-vision' || selectedMode === 'predator';

  modeNote.textContent = MODE_NOTES[selectedMode];
  scaleField.hidden = isNone || isSharpen;
  frameGenerationField.hidden = isNone;
  frameGenerationTargetField.hidden = !frameGenerationEnabled.checked;
  sharpnessField.hidden = isNone || isSmooth || isAnime || isFunFilter;
  sharpnessLabel.textContent = isSharpen ? 'CAS sharpness' : 'FSR sharpness';
  sharpnessValue.value = sharpness.toFixed(2);
  sharpnessValue.textContent = sharpness.toFixed(2);
  animeField.hidden = selectedMode !== 'anime';
  animeField.disabled = false;
  ravuField.hidden = selectedMode !== 'neural-pro';
  ravuField.disabled = true;
  supportNote.textContent = IMPLEMENTED_MODES.has(selectedMode)
    ? isSharpen
      ? 'Scale is fixed at 1.0x for Sharpen.'
      : isNone
        ? 'The extension stays enabled, but the native video is passed through unchanged.'
        : isCrispLike
          ? 'Crisp uses WebGPU first and falls back to WebGL2.'
        : isAnime
          ? 'Anime requires WebGPU and uses the selected Anime4K sub-mode.'
          : isFunFilter
            ? 'Experimental filter rendered with WebGL2.'
            : 'Smooth requires WebGPU.'
    : 'This mode is visible for roadmap clarity and will unlock when its shader port lands.';
};

updateModeControls();

enabled.addEventListener('change', () => {
  void patchSettings({ enabled: enabled.checked });
});

mode.addEventListener('change', () => {
  void patchSettings({ mode: mode.value as UpscalerMode });
  updateModeControls();
});

scale.addEventListener('change', () => {
  void patchSettings({ scale: Number(scale.value) as ScaleFactor });
});

frameGenerationEnabled.addEventListener('change', () => {
  void patchSettings({ frameGenerationEnabled: frameGenerationEnabled.checked });
  updateModeControls();
});

frameGenerationTarget.addEventListener('change', () => {
  const next = Number(frameGenerationTarget.value) === 120 ? 120 : 60;
  void patchSettings({ frameGenerationTargetFps: next });
});

fsrSharpness.addEventListener('input', () => {
  void patchSettings({ fsrSharpness: Number(fsrSharpness.value) });
  updateModeControls();
});

animeSubMode.addEventListener('change', () => {
  void patchSettings({ animeSubMode: animeSubMode.value === 'mode-a' ? 'mode-a' : 'mode-aa' });
});

ravuVariant.addEventListener('change', () => {
  const next = ravuVariant.value === 'zoom' || ravuVariant.value === 'lite' ? ravuVariant.value : 'auto';
  void patchSettings({ ravuVariant: next });
});
