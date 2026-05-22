import {
  FRAME_GENERATION_TARGETS,
  SCALE_FACTORS,
  UPSCALER_MODES,
  type ScaleFactor,
  type UpscalerMode,
} from '../common/modes';
import { loadSettings, patchSettings } from '../common/storage';
import { getModeControlState, isImplementedMode, MODE_DESCRIPTIONS, MODE_LABELS } from './ui-model';
import './style.css';

const getRequiredElement = (selector: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) {
    throw new Error(`Options control ${selector} failed to initialize.`);
  }
  return element;
};

const summary = getRequiredElement('#summary') as HTMLParagraphElement;
const defaultMode = getRequiredElement('#defaultMode') as HTMLSelectElement;
const modeDescription = getRequiredElement('#modeDescription') as HTMLParagraphElement;
const scaleField = getRequiredElement('#scaleField') as HTMLLabelElement;
const defaultScale = getRequiredElement('#defaultScale') as HTMLSelectElement;
const frameGenerationField = getRequiredElement('#frameGenerationField') as HTMLFieldSetElement;
const frameGenerationEnabled = getRequiredElement('#frameGenerationEnabled') as HTMLInputElement;
const frameGenerationTargetField = getRequiredElement(
  '#frameGenerationTargetField',
) as HTMLLabelElement;
const frameGenerationTarget = getRequiredElement('#frameGenerationTarget') as HTMLSelectElement;
const sharpnessField = getRequiredElement('#sharpnessField') as HTMLLabelElement;
const sharpnessLabel = getRequiredElement('#sharpnessLabel');
const fsrSharpness = getRequiredElement('#fsrSharpness') as HTMLInputElement;
const sharpnessValue = getRequiredElement('#sharpnessValue') as HTMLOutputElement;
const animeField = getRequiredElement('#animeField') as HTMLFieldSetElement;
const animeSubMode = getRequiredElement('#animeSubMode') as HTMLSelectElement;
const ravuField = getRequiredElement('#ravuField') as HTMLFieldSetElement;
const ravuVariant = getRequiredElement('#ravuVariant') as HTMLSelectElement;
const supportNote = getRequiredElement('#supportNote') as HTMLParagraphElement;
const forceWebGL2 = getRequiredElement('#forceWebGL2') as HTMLInputElement;
const forceF32 = getRequiredElement('#forceF32') as HTMLInputElement;
const workgroupSize = getRequiredElement('#workgroupSize') as HTMLSelectElement;

UPSCALER_MODES.forEach((value) => {
  const option = new Option(MODE_LABELS[value], value);
  option.disabled = !isImplementedMode(value);
  defaultMode.add(option);
});

SCALE_FACTORS.forEach((value) => {
  defaultScale.add(new Option(`${value.toFixed(1)}x`, String(value)));
});
FRAME_GENERATION_TARGETS.forEach((value) => {
  frameGenerationTarget.add(new Option(`${String(value)} fps`, String(value)));
});

const settings = await loadSettings();
defaultMode.value = settings.mode;
defaultScale.value = String(settings.scale);
frameGenerationEnabled.checked = settings.frameGenerationEnabled;
frameGenerationTarget.value = String(settings.frameGenerationTargetFps);
fsrSharpness.value = String(settings.fsrSharpness);
animeSubMode.value = settings.animeSubMode;
ravuVariant.value = settings.ravuVariant;
forceWebGL2.checked = settings.forceWebGL2;
forceF32.checked = settings.forceF32;
workgroupSize.value = settings.workgroupSize;

const updateModeControls = (): void => {
  const selectedMode = defaultMode.value as UpscalerMode;
  const controlState = getModeControlState(selectedMode);
  const sharpness = Number(fsrSharpness.value);

  summary.textContent = `${MODE_LABELS[selectedMode]} at ${
    controlState.scaleVisible ? `${Number(defaultScale.value).toFixed(1)}x` : '1.0x'
  }`;
  modeDescription.textContent = MODE_DESCRIPTIONS[selectedMode];
  scaleField.hidden = !controlState.scaleVisible;
  frameGenerationField.hidden = !controlState.frameGenerationVisible;
  frameGenerationTargetField.hidden = !frameGenerationEnabled.checked;
  sharpnessField.hidden = !controlState.sharpnessVisible;
  sharpnessLabel.textContent = controlState.sharpnessLabel;
  sharpnessValue.value = sharpness.toFixed(2);
  sharpnessValue.textContent = sharpness.toFixed(2);
  animeField.hidden = !controlState.animeVisible;
  animeField.disabled = true;
  ravuField.hidden = !controlState.ravuVisible;
  ravuField.disabled = true;
  supportNote.textContent = controlState.supportNote;
};

updateModeControls();

defaultMode.addEventListener('change', () => {
  void patchSettings({ mode: defaultMode.value as UpscalerMode });
  updateModeControls();
});

defaultScale.addEventListener('change', () => {
  void patchSettings({ scale: Number(defaultScale.value) as ScaleFactor });
  updateModeControls();
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

forceWebGL2.addEventListener('change', () => {
  void patchSettings({ forceWebGL2: forceWebGL2.checked });
});

forceF32.addEventListener('change', () => {
  void patchSettings({ forceF32: forceF32.checked });
});

workgroupSize.addEventListener('change', () => {
  void patchSettings({ workgroupSize: workgroupSize.value === '16x16' ? '16x16' : '8x8' });
});
