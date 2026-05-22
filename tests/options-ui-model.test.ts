import { describe, expect, it } from 'vitest';

import { getModeControlState, isImplementedMode, MODE_LABELS } from '../src/options/ui-model';

describe('options UI model', () => {
  it('labels currently routed modes with user-facing names', () => {
    expect(MODE_LABELS.none).toBe('None');
    expect(MODE_LABELS.auto).toBe('Auto');
    expect(MODE_LABELS.crisp).toContain('FSR');
    expect(MODE_LABELS.sharpen).toContain('CAS');
    expect(MODE_LABELS.anime).toContain('Anime4K');
    expect(MODE_LABELS.smooth).toContain('Lanczos');
    expect(MODE_LABELS.edge).toContain('Edge');
    expect(MODE_LABELS['night-vision']).toContain('Night');
    expect(MODE_LABELS.predator).toContain('Predator');
    expect(MODE_LABELS.crt).toContain('CRT');
    expect(MODE_LABELS.invert).toContain('Inverted');
    expect(MODE_LABELS.cartoon).toContain('Cartoon');
  });

  it('keeps future modes visible but disabled', () => {
    expect(isImplementedMode('none')).toBe(true);
    expect(isImplementedMode('anime')).toBe(true);
    expect(isImplementedMode('predator')).toBe(true);
    expect(isImplementedMode('crt')).toBe(true);
    expect(isImplementedMode('invert')).toBe(true);
    expect(isImplementedMode('cartoon')).toBe(true);
    expect(isImplementedMode('neural-lite')).toBe(true);
    expect(isImplementedMode('neural-pro')).toBe(false);
    expect(MODE_LABELS['neural-pro']).toContain('coming soon');
  });

  it('shows mode-specific controls for implemented modes', () => {
    expect(getModeControlState('none')).toMatchObject({
      frameGenerationVisible: false,
      implemented: true,
      scaleVisible: false,
      sharpnessVisible: false,
      supportNote: 'Native video passthrough; no overlay rendering is applied.',
    });
    expect(getModeControlState('crisp')).toMatchObject({
      frameGenerationVisible: true,
      scaleVisible: true,
      sharpnessLabel: 'FSR sharpness',
      sharpnessVisible: true,
    });
    expect(getModeControlState('sharpen')).toMatchObject({
      scaleVisible: false,
      sharpnessLabel: 'CAS sharpness',
      sharpnessVisible: true,
    });
    expect(getModeControlState('smooth')).toMatchObject({
      scaleVisible: true,
      sharpnessVisible: false,
    });
    expect(getModeControlState('anime')).toMatchObject({
      animeVisible: true,
      implemented: true,
      sharpnessVisible: false,
    });
    expect(getModeControlState('night-vision')).toMatchObject({
      implemented: true,
      scaleVisible: true,
      sharpnessVisible: false,
      supportNote: 'Experimental filter rendered with WebGL2.',
    });
    expect(getModeControlState('neural-lite')).toMatchObject({
      implemented: true,
      scaleVisible: true,
      supportNote: 'Neural-Lite preview uses WebGL2 first; ArtCNN weight port is still pending.',
    });
  });

  it('surfaces disabled future configuration groups', () => {
    expect(getModeControlState('neural-pro')).toMatchObject({
      implemented: false,
      ravuVisible: true,
    });
  });
});
