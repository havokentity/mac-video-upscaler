import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../src/common/modes';
import {
  normalizeHostname,
  normalizeSiteRulesState,
  resolveSiteSettings,
  sitePatternMatches,
  type SiteRulesState,
} from '../src/common/site-rules';

describe('site rule matching', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc', 'youtube.com'],
    ['Player.Vimeo.com:443/video/1', 'player.vimeo.com'],
    ['example.test.', 'example.test'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeHostname(input)).toBe(expected);
  });

  it('matches apex domains and subdomains for plain domain patterns', () => {
    expect(sitePatternMatches('youtube.com', 'youtube.com')).toBe(true);
    expect(sitePatternMatches('youtube.com', 'music.youtube.com')).toBe(true);
    expect(sitePatternMatches('youtube.com', 'notyoutube.com')).toBe(false);
  });

  it('matches wildcard subdomain patterns without matching the apex domain', () => {
    expect(sitePatternMatches('*.reddit.com', 'old.reddit.com')).toBe(true);
    expect(sitePatternMatches('*.reddit.com', 'reddit.com')).toBe(false);
  });
});

describe('resolveSiteSettings', () => {
  it('returns global settings when no rule matches', () => {
    const resolved = resolveSiteSettings(
      { ...DEFAULT_SETTINGS, mode: 'crisp', scale: 1.7 },
      undefined,
      'example.test',
    );

    expect(resolved.reason).toBe('global');
    expect(resolved.allowed).toBe(true);
    expect(resolved.blocked).toBe(false);
    expect(resolved.settings.mode).toBe('crisp');
    expect(resolved.settings.scale).toBe(1.7);
  });

  it('uses the most specific matching site rule', () => {
    const siteRules: SiteRulesState = {
      allowList: [],
      blockList: [],
      rules: [
        {
          id: 'youtube-default',
          pattern: 'youtube.com',
          settings: { mode: 'crisp', scale: 1.5 },
        },
        {
          id: 'music-youtube',
          pattern: 'music.youtube.com',
          settings: { mode: 'smooth', scale: 2.0, forceF32: true },
        },
      ],
    };

    const resolved = resolveSiteSettings(DEFAULT_SETTINGS, siteRules, 'music.youtube.com');

    expect(resolved.reason).toBe('site-rule');
    expect(resolved.matchedRule?.id).toBe('music-youtube');
    expect(resolved.settings.mode).toBe('smooth');
    expect(resolved.settings.scale).toBe(2.0);
    expect(resolved.settings.forceF32).toBe(true);
  });

  it('lets later rules win when specificity ties', () => {
    const siteRules: SiteRulesState = {
      allowList: [],
      blockList: [],
      rules: [
        { id: 'first', pattern: 'vimeo.com', settings: { mode: 'crisp' } },
        { id: 'second', pattern: 'vimeo.com', settings: { mode: 'anime' } },
      ],
    };

    const resolved = resolveSiteSettings(DEFAULT_SETTINGS, siteRules, 'player.vimeo.com');

    expect(resolved.matchedRule?.id).toBe('second');
    expect(resolved.settings.mode).toBe('anime');
  });

  it('disables upscaling when the host is blocked', () => {
    const resolved = resolveSiteSettings(
      { ...DEFAULT_SETTINGS, enabled: true },
      { allowList: [], blockList: ['twitter.com'], rules: [] },
      'video.twitter.com',
    );

    expect(resolved.reason).toBe('block-list');
    expect(resolved.blocked).toBe(true);
    expect(resolved.settings.enabled).toBe(false);
    expect(resolved.matchedBlockPattern).toBe('twitter.com');
  });

  it('disables upscaling when an allow list exists and the host misses it', () => {
    const resolved = resolveSiteSettings(
      { ...DEFAULT_SETTINGS, enabled: true },
      { allowList: ['youtube.com'], blockList: [], rules: [] },
      'example.test',
    );

    expect(resolved.reason).toBe('allow-list-miss');
    expect(resolved.blocked).toBe(true);
    expect(resolved.settings.enabled).toBe(false);
  });

  it('lets the block list win over the allow list', () => {
    const resolved = resolveSiteSettings(
      { ...DEFAULT_SETTINGS, enabled: true },
      { allowList: ['youtube.com'], blockList: ['music.youtube.com'], rules: [] },
      'music.youtube.com',
    );

    expect(resolved.reason).toBe('block-list');
    expect(resolved.settings.enabled).toBe(false);
  });

  it('normalizes persisted rules and drops invalid override values', () => {
    const normalized = normalizeSiteRulesState({
      allowList: [' HTTPS://www.YouTube.com/watch '],
      blockList: [''],
      rules: [
        {
          id: 'yt',
          pattern: 'https://m.youtube.com/feed',
          settings: {
            mode: 'smooth',
            scale: 1.7,
            fsrSharpness: 2,
            frameGenerationEnabled: true,
            frameGenerationTargetFps: 120,
          },
        },
      ],
    });

    expect(normalized.allowList).toEqual(['youtube.com']);
    expect(normalized.blockList).toEqual([]);
    expect(normalized.rules[0]).toMatchObject({
      id: 'yt',
      pattern: 'm.youtube.com',
      settings: {
        mode: 'smooth',
        scale: 1.7,
        fsrSharpness: 1,
        frameGenerationEnabled: true,
        frameGenerationTargetFps: 120,
      },
    });
  });
});
