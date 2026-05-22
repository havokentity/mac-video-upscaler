import { VideoOverlay } from '../overlay/video-overlay';

const overlays = new WeakMap<HTMLVideoElement, VideoOverlay>();
const pendingVideos = new WeakSet<HTMLVideoElement>();

const attachVideo = (video: HTMLVideoElement): void => {
  if (overlays.has(video) || pendingVideos.has(video)) {
    return;
  }

  const overlay = new VideoOverlay(video);
  pendingVideos.add(video);
  void overlay.mount().then((mounted) => {
    pendingVideos.delete(video);

    if (mounted) {
      overlays.set(video, overlay);
    }
  });
};

const scanVideos = (root: ParentNode = document): void => {
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

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'mac-video-upscaler:toggle-hud'
  ) {
    document.querySelectorAll('video').forEach((video) => {
      overlays.get(video)?.toggleHud();
    });
  }
});

window.addEventListener('pagehide', () => {
  observer.disconnect();
  document.querySelectorAll('video').forEach((video) => {
    overlays.get(video)?.destroy();
    overlays.delete(video);
  });
});
