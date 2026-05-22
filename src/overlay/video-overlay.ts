import { resolveSiteSettings } from '../common/site-rules';
import { loadSettings, loadSiteRules } from '../common/storage';
import { detectSite, shouldBypassVideo } from '../common/site';
import { classifyFrameAccessError } from '../content/frame-access-probe';
import { createPipeline, type FramePipeline } from '../upscaler/pipeline';
import { buildHudRows, sampleRenderedFps } from './hud';

const OVERLAY_CLASS = 'chrome-video-upscaler-overlay';
const HUD_CLASS = 'chrome-video-upscaler-hud';
const PRESENTATION_PROBE_SIZE = 24;
const PRESENTATION_PROBE_FRAME_DELAY = 3;
const PRESENTATION_PROBE_MAX_ATTEMPTS = 8;

export class VideoOverlay {
  readonly canvas: HTMLCanvasElement;

  private readonly hud: HTMLDivElement;
  private pipeline: FramePipeline | undefined;
  private frameCallbackHandle: number | undefined;
  private animationFrameHandle: number | undefined;
  private disposed = false;
  private hudVisible = false;
  private mounted = false;
  private overlayHost: HTMLElement | undefined;
  private previousHostPosition: string | undefined;
  private readonly previousVideoOpacity: string;
  private readonly previousVideoZIndex: string;
  private renderedFps: number | undefined;
  private renderedFrameTimestamps: readonly number[] = [];
  private renderedFrameCount = 0;
  private presentationReady = false;
  private presentationProbePending = false;
  private presentationProbeAttempts = 0;
  private shouldHideNativeVideo = false;
  private frameGenerationEnabled = false;
  private frameGenerationTargetFps = 60;
  private nextGeneratedFrameAt = 0;

  constructor(private readonly video: HTMLVideoElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = OVERLAY_CLASS;
    this.canvas.style.opacity = '0';
    this.hud = document.createElement('div');
    this.hud.className = HUD_CLASS;
    this.hud.hidden = true;
    this.previousVideoOpacity = video.style.opacity;
    this.previousVideoZIndex = video.style.zIndex;
  }

  async mount(): Promise<boolean> {
    if (this.disposed || this.mounted || shouldBypassVideo(this.video)) {
      return false;
    }

    this.mounted = true;
    this.attachOverlayHost();
    document.documentElement.append(this.hud);
    this.pruneDuplicateYouTubeOverlays();
    this.syncBounds();

    const [globalSettings, siteRules] = await Promise.all([loadSettings(), loadSiteRules()]);
    if (this.isDisposed()) {
      return false;
    }

    const siteResolution = resolveSiteSettings(globalSettings, siteRules, location.hostname);
    const settings = siteResolution.settings;
    this.pipeline = await createPipeline(this.canvas, this.video, settings);
    this.shouldHideNativeVideo = settings.enabled && this.pipeline.status.backend !== 'disabled';
    this.frameGenerationEnabled =
      settings.frameGenerationEnabled && this.pipeline.status.backend !== 'disabled';
    this.frameGenerationTargetFps = settings.frameGenerationTargetFps;
    this.hudVisible = settings.hudEnabled;
    this.hud.hidden = !this.hudVisible;
    if (this.frameGenerationEnabled) {
      Object.assign(this.pipeline.status, {
        frameGeneration: `target ${String(this.frameGenerationTargetFps)} fps`,
      });
    }
    if (siteResolution.reason === 'block-list' || siteResolution.reason === 'allow-list-miss') {
      this.pipeline.status.reason =
        siteResolution.reason === 'block-list'
          ? `Site blocked by ${siteResolution.matchedBlockPattern ?? 'site rule'}.`
          : 'Site not included in allow list.';
    }
    if (!settings.enabled) {
      this.canvas.style.opacity = '0';
      this.video.style.opacity = this.previousVideoOpacity;
    }
    this.renderHud();
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.renderFrame();
    } else {
      this.scheduleFrame();
    }
    return true;
  }

  toggleHud(): void {
    this.hudVisible = !this.hudVisible;
    this.hud.hidden = !this.hudVisible;
    if (this.hudVisible) {
      this.renderHud();
    }
  }

  destroy(): void {
    this.disposed = true;

    if (this.frameCallbackHandle !== undefined) {
      this.video.cancelVideoFrameCallback(this.frameCallbackHandle);
    }

    if (this.animationFrameHandle !== undefined) {
      cancelAnimationFrame(this.animationFrameHandle);
    }

    this.pipeline?.destroy();
    this.video.style.opacity = this.previousVideoOpacity;
    this.video.style.zIndex = this.previousVideoZIndex;
    if (this.overlayHost && this.previousHostPosition !== undefined) {
      this.overlayHost.style.position = this.previousHostPosition;
    }
    this.canvas.remove();
    this.hud.remove();
  }

  private scheduleFrame(): void {
    if (this.disposed) {
      return;
    }

    if (this.frameGenerationEnabled || this.video.paused || this.video.ended) {
      this.animationFrameHandle = requestAnimationFrame((now) => {
        this.renderFrame(now);
      });
      return;
    }

    if ('requestVideoFrameCallback' in this.video) {
      this.frameCallbackHandle = this.video.requestVideoFrameCallback(() => {
        this.renderFrame();
      });
      return;
    }

    this.animationFrameHandle = requestAnimationFrame(() => {
      this.renderFrame();
    });
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  private attachOverlayHost(): void {
    const host = this.video.parentElement ?? document.documentElement;
    this.overlayHost = host;
    const hostPosition = getComputedStyle(host).position;
    this.previousHostPosition = host.style.position;
    if (hostPosition === 'static') {
      host.style.position = 'relative';
    }
    host.append(this.canvas);
  }

  private renderFrame(now = performance.now()): void {
    if (this.disposed) {
      return;
    }

    this.pruneDuplicateYouTubeOverlays();

    if (this.frameGenerationEnabled) {
      const minimumFrameIntervalMs = 1000 / this.frameGenerationTargetFps;
      if (now + 0.5 < this.nextGeneratedFrameAt) {
        this.scheduleFrame();
        return;
      }
      this.nextGeneratedFrameAt = now + minimumFrameIntervalMs;
    }

    if (!this.video.isConnected || this.video.readyState === HTMLMediaElement.HAVE_NOTHING) {
      this.scheduleFrame();
      return;
    }

    try {
      this.syncBounds();
      this.pipeline?.renderFrame();
      this.recordRenderedFrame();
      this.schedulePresentationProbe();
      if (this.presentationReady && this.shouldHideNativeVideo) {
        this.showCanvasPresentation();
      }
      if (this.hudVisible) {
        this.renderHud();
      }
      this.scheduleFrame();
    } catch (error) {
      const frameAccess = classifyFrameAccessError(error);
      this.hud.hidden = false;
      if (frameAccess.status === 'drm-or-cross-origin-blocked') {
        this.hud.textContent = 'Chrome Video Upscaler: disabled - DRM-protected or cross-origin video cannot be upscaled';
      } else {
        this.hud.textContent =
          error instanceof Error
            ? `Chrome Video Upscaler: disabled - ${error.message}`
            : 'Chrome Video Upscaler: disabled - unknown frame copy error';
      }
      this.video.style.opacity = this.previousVideoOpacity;
    }
  }

  private syncBounds(): void {
    const rect = this.video.getBoundingClientRect();
    const hostRect = this.overlayHost?.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * devicePixelRatio));
    const height = Math.max(1, Math.round(rect.height * devicePixelRatio));

    if (this.pipeline) {
      this.pipeline.resize(width, height);
    } else if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    Object.assign(this.canvas.style, {
      left: `${String(hostRect ? rect.left - hostRect.left : rect.left + scrollX)}px`,
      top: `${String(hostRect ? rect.top - hostRect.top : rect.top + scrollY)}px`,
      width: `${String(rect.width)}px`,
      height: `${String(rect.height)}px`,
    });

    Object.assign(this.hud.style, {
      left: `${String(rect.left + 12)}px`,
      top: `${String(rect.top + 12)}px`,
    });
  }

  private renderHud(): void {
    this.pruneDuplicateYouTubeOverlays();

    const title = document.createElement('div');
    title.textContent = 'Chrome Video Upscaler';

    const rows = buildHudRows(this.pipeline?.status, {
      renderedFps: this.renderedFps,
    }).map((row) => {
      const element = document.createElement('div');
      element.textContent = `${row.label}: ${row.value}`;
      return element;
    });

    this.hud.replaceChildren(title, ...rows);
  }

  private recordRenderedFrame(): void {
    this.renderedFrameCount += 1;
    const sample = sampleRenderedFps(this.renderedFrameTimestamps, performance.now());
    this.renderedFrameTimestamps = sample.timestamps;
    this.renderedFps = sample.fps;
  }

  private schedulePresentationProbe(): void {
    if (
      this.presentationReady ||
      this.presentationProbePending ||
      !this.shouldHideNativeVideo ||
      this.renderedFrameCount < PRESENTATION_PROBE_FRAME_DELAY ||
      this.presentationProbeAttempts >= PRESENTATION_PROBE_MAX_ATTEMPTS
    ) {
      return;
    }

    this.presentationProbePending = true;
    this.probeCanvasPresentation();
  }

  private probeCanvasPresentation(): void {
    try {
      const presentationLooksUsable = canvasHasPresentedPixels(this.canvas);
      this.presentationProbeAttempts += 1;

      if (this.disposed) {
        return;
      }

      if (presentationLooksUsable) {
        this.showCanvasPresentation();
        if (this.hudVisible) {
          this.renderHud();
        }
        return;
      }

      this.canvas.style.opacity = '0';
      this.video.style.opacity = this.previousVideoOpacity;
      if (this.pipeline?.status) {
        this.pipeline.status.reason =
          this.presentationProbeAttempts >= PRESENTATION_PROBE_MAX_ATTEMPTS
            ? 'Canvas output stayed blank; showing native video.'
            : 'Checking canvas output before hiding native video.';
      }
      if (this.hudVisible) {
        this.renderHud();
      }
    } finally {
      this.presentationProbePending = false;
    }
  }

  private showCanvasPresentation(): void {
    this.presentationReady = true;
    this.canvas.style.opacity = '1';
    this.video.style.opacity = '0';
    this.video.style.zIndex = '0';
  }

  private pruneDuplicateYouTubeOverlays(): void {
    if (detectSite() !== 'youtube') {
      return;
    }

    document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((node) => {
      if (node !== this.canvas) {
        node.remove();
      }
    });
    document.querySelectorAll(`.${HUD_CLASS}`).forEach((node) => {
      if (node !== this.hud) {
        node.remove();
      }
    });
  }
}

export const canvasHasPresentedPixels = (canvas: HTMLCanvasElement): boolean => {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return false;
  }

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = PRESENTATION_PROBE_SIZE;
  sampleCanvas.height = PRESENTATION_PROBE_SIZE;
  const context = sampleCanvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return true;
  }

  let pixels: Uint8ClampedArray;
  try {
    context.drawImage(canvas, 0, 0, PRESENTATION_PROBE_SIZE, PRESENTATION_PROBE_SIZE);
    pixels = context.getImageData(0, 0, PRESENTATION_PROBE_SIZE, PRESENTATION_PROBE_SIZE).data;
  } catch {
    return false;
  }
  let alphaPixels = 0;
  const minimumAlphaPixels = Math.max(1, Math.floor((PRESENTATION_PROBE_SIZE * PRESENTATION_PROBE_SIZE) * 0.05));

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha <= 4) {
      continue;
    }

    alphaPixels += 1;
    if (alphaPixels >= minimumAlphaPixels) {
      return true;
    }
  }

  return false;
};
