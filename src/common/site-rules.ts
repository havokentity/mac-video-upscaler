import {
  DEFAULT_SETTINGS,
  SCALE_FACTORS,
  FRAME_GENERATION_TARGETS,
  UPSCALER_MODES,
  type UpscalerSettings,
} from './modes';

export type SiteRulePattern = string;

export type SiteSettingsOverride = Partial<UpscalerSettings>;

export interface SiteRule {
  id: string;
  pattern: SiteRulePattern;
  settings: SiteSettingsOverride;
  label?: string;
}

export interface SiteRulesState {
  allowList: SiteRulePattern[];
  blockList: SiteRulePattern[];
  rules: SiteRule[];
}

export type SiteSettingsResolutionReason =
  | 'global'
  | 'allow-list-miss'
  | 'block-list'
  | 'site-rule';

export interface SiteSettingsResolution {
  hostname: string;
  settings: UpscalerSettings;
  reason: SiteSettingsResolutionReason;
  allowed: boolean;
  blocked: boolean;
  matchedAllowPattern?: SiteRulePattern;
  matchedBlockPattern?: SiteRulePattern;
  matchedRule?: SiteRule;
}

export const DEFAULT_SITE_RULES: SiteRulesState = {
  allowList: [],
  blockList: [],
  rules: [],
};

const VALID_SCALES = new Set<number>(SCALE_FACTORS);
const VALID_FRAME_GENERATION_TARGETS = new Set<number>(FRAME_GENERATION_TARGETS);
const VALID_MODES = new Set<string>(UPSCALER_MODES);

export const normalizeHostname = (input: string): string => {
  const trimmed = input.trim().toLowerCase();

  if (!trimmed) {
    return '';
  }

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//u.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    return new URL(withScheme).hostname.replace(/^www\./u, '').replace(/\.$/u, '');
  } catch {
    return trimmed
      .split('/')[0]
      .split(':')[0]
      .replace(/^www\./u, '')
      .replace(/\.$/u, '');
  }
};

export const normalizeSiteRulePattern = (pattern: SiteRulePattern): SiteRulePattern =>
  pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/^www\./u, '')
    .replace(/\.$/u, '');

const domainMatches = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`);

export const sitePatternMatches = (pattern: SiteRulePattern, host: string): boolean => {
  const hostname = normalizeHostname(host);
  const normalizedPattern = normalizeSiteRulePattern(pattern);

  if (!hostname || !normalizedPattern) {
    return false;
  }

  if (normalizedPattern === '*') {
    return true;
  }

  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return hostname.endsWith(`.${suffix}`);
  }

  return domainMatches(hostname, normalizedPattern);
};

const patternSpecificity = (pattern: SiteRulePattern, hostname: string): number => {
  const normalizedPattern = normalizeSiteRulePattern(pattern);

  if (!sitePatternMatches(normalizedPattern, hostname)) {
    return -1;
  }

  if (normalizedPattern === '*') {
    return 0;
  }

  if (normalizedPattern.startsWith('*.')) {
    return 2_000 + normalizedPattern.length;
  }

  return normalizeHostname(hostname) === normalizedPattern
    ? 3_000 + normalizedPattern.length
    : 1_000 + normalizedPattern.length;
};

const findBestPatternMatch = (
  patterns: SiteRulePattern[],
  hostname: string,
): SiteRulePattern | undefined => {
  let bestPattern: SiteRulePattern | undefined;
  let bestScore = -1;

  patterns.forEach((pattern, index) => {
    const score = patternSpecificity(pattern, hostname);
    if (score < 0) {
      return;
    }

    const tieBreaker = index / 10_000;
    if (score + tieBreaker > bestScore) {
      bestPattern = pattern;
      bestScore = score + tieBreaker;
    }
  });

  return bestPattern;
};

const clampNumber = (value: unknown, minimum: number, maximum: number): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.min(maximum, Math.max(minimum, value));
};

export const sanitizeSiteSettingsOverride = (
  override: Partial<UpscalerSettings>,
): SiteSettingsOverride => {
  const sanitized: SiteSettingsOverride = {};

  if (typeof override.enabled === 'boolean') {
    sanitized.enabled = override.enabled;
  }

  if (typeof override.mode === 'string' && VALID_MODES.has(override.mode)) {
    sanitized.mode = override.mode;
  }

  if (typeof override.scale === 'number' && VALID_SCALES.has(override.scale)) {
    sanitized.scale = override.scale;
  }

  const sharpness = clampNumber(override.fsrSharpness, 0, 1);
  if (sharpness !== undefined) {
    sanitized.fsrSharpness = sharpness;
  }

  if (override.animeSubMode === 'mode-a' || override.animeSubMode === 'mode-aa') {
    sanitized.animeSubMode = override.animeSubMode;
  }

  if (
    override.ravuVariant === 'auto' ||
    override.ravuVariant === 'zoom' ||
    override.ravuVariant === 'lite'
  ) {
    sanitized.ravuVariant = override.ravuVariant;
  }

  if (typeof override.frameGenerationEnabled === 'boolean') {
    sanitized.frameGenerationEnabled = override.frameGenerationEnabled;
  }

  if (
    typeof override.frameGenerationTargetFps === 'number' &&
    VALID_FRAME_GENERATION_TARGETS.has(override.frameGenerationTargetFps)
  ) {
    sanitized.frameGenerationTargetFps = override.frameGenerationTargetFps;
  }

  if (typeof override.forceWebGL2 === 'boolean') {
    sanitized.forceWebGL2 = override.forceWebGL2;
  }

  if (typeof override.forceF32 === 'boolean') {
    sanitized.forceF32 = override.forceF32;
  }

  if (override.workgroupSize === '8x8' || override.workgroupSize === '16x16') {
    sanitized.workgroupSize = override.workgroupSize;
  }

  return sanitized;
};

export const normalizeSiteRulesState = (
  state: Partial<SiteRulesState> | undefined,
): SiteRulesState => {
  if (!state) {
    return DEFAULT_SITE_RULES;
  }

  return {
    allowList: Array.isArray(state.allowList)
      ? state.allowList.map(normalizeSiteRulePattern).filter(Boolean)
      : [],
    blockList: Array.isArray(state.blockList)
      ? state.blockList.map(normalizeSiteRulePattern).filter(Boolean)
      : [],
    rules: Array.isArray(state.rules)
      ? state.rules
          .map((rule): SiteRule | undefined => {
            const pattern = normalizeSiteRulePattern(rule.pattern);
            if (!rule.id || !pattern) {
              return undefined;
            }

            return {
              id: rule.id,
              pattern,
              settings: sanitizeSiteSettingsOverride(rule.settings),
              ...(rule.label ? { label: rule.label } : {}),
            };
          })
          .filter((rule): rule is SiteRule => rule !== undefined)
      : [],
  };
};

export const resolveSiteSettings = (
  globalSettings: Partial<UpscalerSettings>,
  siteRules: Partial<SiteRulesState> | undefined,
  host: string,
): SiteSettingsResolution => {
  const hostname = normalizeHostname(host);
  const baseSettings = {
    ...DEFAULT_SETTINGS,
    ...sanitizeSiteSettingsOverride(globalSettings),
  };
  const normalizedRules = normalizeSiteRulesState(siteRules);
  const matchedBlockPattern = findBestPatternMatch(normalizedRules.blockList, hostname);

  if (matchedBlockPattern) {
    return {
      hostname,
      settings: { ...baseSettings, enabled: false },
      reason: 'block-list',
      allowed: false,
      blocked: true,
      matchedBlockPattern,
    };
  }

  const matchedAllowPattern = findBestPatternMatch(normalizedRules.allowList, hostname);
  if (normalizedRules.allowList.length > 0 && !matchedAllowPattern) {
    return {
      hostname,
      settings: { ...baseSettings, enabled: false },
      reason: 'allow-list-miss',
      allowed: false,
      blocked: true,
    };
  }

  let matchedRule: SiteRule | undefined;
  let bestScore = -1;

  normalizedRules.rules.forEach((rule, index) => {
    const score = patternSpecificity(rule.pattern, hostname);
    if (score < 0) {
      return;
    }

    const tieBreaker = index / 10_000;
    if (score + tieBreaker > bestScore) {
      matchedRule = rule;
      bestScore = score + tieBreaker;
    }
  });

  if (matchedRule && bestScore >= 0) {
    return {
      hostname,
      settings: { ...baseSettings, ...matchedRule.settings },
      reason: 'site-rule',
      allowed: true,
      blocked: false,
      ...(matchedAllowPattern ? { matchedAllowPattern } : {}),
      matchedRule,
    };
  }

  return {
    hostname,
    settings: baseSettings,
    reason: 'global',
    allowed: true,
    blocked: false,
    ...(matchedAllowPattern ? { matchedAllowPattern } : {}),
  };
};
