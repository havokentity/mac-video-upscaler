import { detectSite, selectLargestVisibleVideo } from '../common/site';
import { loadSettings, patchSettings } from '../common/storage';
import { VideoOverlay } from '../overlay/video-overlay';

const CONTENT_INSTANCE_KEY = '__macVideoUpscalerContentInstance__';

declare global {
  interface Window {
    [CONTENT_INSTANCE_KEY]?: {
      cleanup(): void;
    };
  }
}

const removeInjectedNodes = (): void => {
  document.querySelectorAll('.chrome-video-upscaler-overlay, .chrome-video-upscaler-hud').forEach((node) => {
    node.remove();
  });
};

try {
  window[CONTENT_INSTANCE_KEY]?.cleanup();
} catch {
  // A previous content script can survive after an extension reload with an
  // invalidated chrome runtime. Still continue so this fresh script can attach.
}
window[CONTENT_INSTANCE_KEY] = undefined;
removeInjectedNodes();

const overlays = new WeakMap<HTMLVideoElement, VideoOverlay>();
let pendingVideos = new WeakSet<HTMLVideoElement>();
const managedVideos = new Set<HTMLVideoElement>();
let youtubeRescanHandle: number | undefined;
let overlayGeneration = 0;

const attachVideo = (video: HTMLVideoElement): void => {
  if (overlays.has(video) || pendingVideos.has(video)) {
    return;
  }

  const overlay = new VideoOverlay(video);
  const generation = overlayGeneration;
  pendingVideos.add(video);
  void overlay.mount().then((mounted) => {
    pendingVideos.delete(video);

    if (generation !== overlayGeneration) {
      overlay.destroy();
      return;
    }

    if (mounted) {
      if (
        detectSite() === 'youtube' &&
        selectLargestVisibleVideo(collectVideos(document)) !== video
      ) {
        overlay.destroy();
        return;
      }

      overlays.set(video, overlay);
      managedVideos.add(video);
    }
  });
};

const collectVideos = (root: ParentNode = document): HTMLVideoElement[] =>
  Array.from(root.querySelectorAll('video'));

const syncYouTubeVideos = (): void => {
  const videos = collectVideos(document);
  const selectedVideo = selectLargestVisibleVideo(videos);

  if (!selectedVideo && videos.length > 0 && youtubeRescanHandle === undefined) {
    youtubeRescanHandle = window.setTimeout(() => {
      youtubeRescanHandle = undefined;
      syncYouTubeVideos();
    }, 250);
  }

  videos.forEach((video) => {
    if (video === selectedVideo) {
      attachVideo(video);
      return;
    }

    overlays.get(video)?.destroy();
    overlays.delete(video);
    managedVideos.delete(video);
    pendingVideos.delete(video);
  });
};

const scanVideos = (root: ParentNode = document): void => {
  if (detectSite() === 'youtube') {
    syncYouTubeVideos();
    return;
  }

  root.querySelectorAll('video').forEach((video) => {
    attachVideo(video);
  });
};

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'attributes' && mutation.target instanceof Element) {
      scanVideos(mutation.target);
      continue;
    }

    mutation.addedNodes.forEach((node) => {
      if (!(node instanceof Element)) {
        return;
      }

      if (node instanceof HTMLVideoElement) {
        attachVideo(node);
        return;
      }

      scanVideos(node);
    });

    mutation.removedNodes.forEach((node) => {
      if (!(node instanceof Element)) {
        return;
      }

      const videos =
        node instanceof HTMLVideoElement ? [node] : Array.from(node.querySelectorAll('video'));

      videos.forEach((video) => {
        overlays.get(video)?.destroy();
        overlays.delete(video);
        managedVideos.delete(video);
      });
    });
  }
});

scanVideos();
observer.observe(document.documentElement, {
  attributeFilter: ['class'],
  attributes: true,
  childList: true,
  subtree: true,
});

const rebuildOverlays = (): void => {
  overlayGeneration += 1;
  pendingVideos = new WeakSet<HTMLVideoElement>();
  managedVideos.forEach((video) => {
    overlays.get(video)?.destroy();
    overlays.delete(video);
  });
  managedVideos.clear();
  scanVideos();
};

const handleRuntimeMessage = (message: unknown): void => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'chrome-video-upscaler:toggle-hud'
  ) {
    void loadSettings().then((settings) => {
      void patchSettings({ hudEnabled: !settings.hudEnabled });
    });
  }
};

const handleStorageChange = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void => {
  if (areaName !== 'sync' || (!('settings' in changes) && !('siteRules' in changes))) {
    return;
  }

  rebuildOverlays();
};

const cleanup = (): void => {
  observer.disconnect();
  try {
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    chrome.storage.onChanged.removeListener(handleStorageChange);
  } catch {
    // Ignore extension-context invalidation during reload/unload.
  }

  if (youtubeRescanHandle !== undefined) {
    window.clearTimeout(youtubeRescanHandle);
    youtubeRescanHandle = undefined;
  }

  overlayGeneration += 1;
  pendingVideos = new WeakSet<HTMLVideoElement>();
  managedVideos.forEach((video) => {
    overlays.get(video)?.destroy();
    overlays.delete(video);
  });
  managedVideos.clear();
  removeInjectedNodes();
};

chrome.runtime.onMessage.addListener(handleRuntimeMessage);
chrome.storage.onChanged.addListener(handleStorageChange);
window[CONTENT_INSTANCE_KEY] = { cleanup };

window.addEventListener('pagehide', cleanup, { once: true });
