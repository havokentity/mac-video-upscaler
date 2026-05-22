import type { PipelineStatus } from '../upscaler/pipeline';

const DEFAULT_FPS_WINDOW_MS = 1000;

export interface HudFrameMetrics {
  readonly renderedFps?: number;
}

export interface HudRow {
  readonly label: string;
  readonly value: string;
}

export interface HudFpsSample {
  readonly timestamps: readonly number[];
  readonly fps?: number;
}

type StatusValue = string | number | boolean | undefined;
type RichPipelineStatus = PipelineStatus & Record<string, unknown>;

const getStringField = (status: RichPipelineStatus, field: string): string | undefined => {
  const value = status[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const getNumberField = (status: RichPipelineStatus, field: string): number | undefined => {
  const value = status[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const formatStatusValue = (value: StatusValue): string | undefined => {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }

  return value;
};

export const formatModeBackend = (status: PipelineStatus | undefined): string => {
  if (!status) {
    return 'initializing';
  }

  return status.mode ? `${status.backend} ${status.mode}` : status.backend;
};

export const formatResolution = (width: number | undefined, height: number | undefined): string =>
  width !== undefined && height !== undefined && width > 0 && height > 0
    ? `${String(width)}x${String(height)}`
    : 'unknown';

export const formatSourceOutputResolution = (status: PipelineStatus | undefined): string => {
  if (!status) {
    return 'unknown -> unknown';
  }

  const richStatus = status as RichPipelineStatus;
  const source = formatResolution(
    getNumberField(richStatus, 'sourceWidth'),
    getNumberField(richStatus, 'sourceHeight'),
  );
  const output = formatResolution(
    getNumberField(richStatus, 'canvasWidth'),
    getNumberField(richStatus, 'canvasHeight'),
  );

  return `${source} -> ${output}`;
};

export const formatRenderedFps = (fps: number | undefined): string => {
  if (fps === undefined || !Number.isFinite(fps) || fps <= 0) {
    return 'measuring';
  }

  return `${fps.toFixed(1)} fps`;
};

export const sampleRenderedFps = (
  previousTimestamps: readonly number[],
  now: number,
  windowMs = DEFAULT_FPS_WINDOW_MS,
): HudFpsSample => {
  const timestamps = [...previousTimestamps.filter((timestamp) => now - timestamp <= windowMs), now];

  if (timestamps.length < 2) {
    return { timestamps };
  }

  const elapsedMs = timestamps[timestamps.length - 1] - timestamps[0];
  const fps = elapsedMs > 0 ? ((timestamps.length - 1) * 1000) / elapsedMs : undefined;

  return { timestamps, fps };
};

export const buildHudRows = (
  status: PipelineStatus | undefined,
  metrics: HudFrameMetrics = {},
): readonly HudRow[] => {
  if (!status) {
    return [{ label: 'Mode', value: 'initializing' }];
  }

  const richStatus = status as RichPipelineStatus;
  const detailValues = [
    formatStatusValue(getStringField(richStatus, 'adapterName')),
    formatStatusValue(getStringField(richStatus, 'precision')),
    formatStatusValue(getNumberField(richStatus, 'scale')),
    formatStatusValue(getNumberField(richStatus, 'sharpness')),
    formatStatusValue(getStringField(richStatus, 'variant')),
    formatStatusValue(getStringField(richStatus, 'provider')),
    formatStatusValue(getStringField(richStatus, 'subMode')),
    formatStatusValue(getStringField(richStatus, 'frameGeneration')),
  ].filter((value): value is string => value !== undefined);

  const rows: HudRow[] = [
    { label: 'Mode', value: formatModeBackend(status) },
    { label: 'Resolution', value: formatSourceOutputResolution(status) },
    { label: 'Rendered', value: formatRenderedFps(metrics.renderedFps) },
  ];

  if (detailValues.length > 0) {
    rows.push({ label: 'Details', value: detailValues.join(' / ') });
  }

  if (status.reason && status.reason.length > 0) {
    rows.push({ label: 'Status', value: status.reason });
  }

  return rows;
};
