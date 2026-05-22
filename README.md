# Mac Video Upscaler

Metal-tuned GPU video upscaling for Chrome on macOS. The project targets Manifest V3, WebGPU through Dawn/Tint/Metal, and a WebGL2 fallback for the fast modes.

This repository is being built in ordered milestones. The current build mounts a video overlay, performs a 1:1 frame copy through WebGPU or WebGL2, and includes the first WebGL2 Crisp mode at fixed 1.5x with popup-controlled sharpness.

## Install for Development

```sh
corepack enable pnpm
pnpm install
pnpm build
```

Then open `chrome://extensions`, enable Developer Mode, choose **Load unpacked**, and select `dist`.

For popup/options HMR:

```sh
pnpm dev
```

## Modes Planned for v1

| Mode | Backend | License | Notes |
| --- | --- | --- | --- |
| Auto | WebGPU/WebGL2 | MIT | Cheap first-frame classifier; Neural-Pro remains opt-in. |
| Crisp | WebGPU + WebGL2 | MIT | WebGL2 milestone has an FSR 1.0-shaped EASU/RCAS approximation; exact AMD constants/taps land in the quality pass. |
| Sharpen | WebGPU + WebGL2 | MIT | CAS at 1.0x. |
| Anime | WebGPU | MIT | Anime4K v4 Mode A and A+A. |
| Smooth | WebGPU | Public-domain math | EWA Lanczos / Jinc-windowed Jinc. |
| Neural-Lite | WebGPU | MIT, pending source verification | ArtCNN smallest practical variant first. |
| Neural-Pro | WebGPU | LGPL-3.0 | RAVU-Zoom and RAVU-Lite with attribution. |

## How It Works

The content script finds visible `<video>` elements, mounts a pointer-transparent canvas over the video box, and hands frames to a reusable upscaler pipeline. The original video is kept in the page for audio, controls, captions, fullscreen, and site event handling, then visually hidden while the overlay presents processed frames.

WebGPU is preferred on macOS Chrome 121+; WebGL2 is retained as a fallback for Crisp and Sharpen. The current WebGPU path uploads frames with `copyExternalImageToTexture` and presents them through a tiny WGSL render pass. Compute upscalers will use small coherent workgroups, half precision where it is visually safe, and texture/bind-group reuse to avoid per-frame allocation churn.

## Verification Status

- Generic HTML5 MP4 fixture: automated Playwright smoke test loads the unpacked extension from `dist`, mounts the overlay, and verifies nonzero canvas dimensions.
- WebGL2 Crisp: automated Playwright smoke test writes extension settings, activates Crisp, verifies HUD mode text, and checks 1.5x backing resolution.
- YouTube: automated Chromium smoke verified the overlay on `https://www.youtube.com/watch?v=jNQXAC9IVRw`.
- Chrome stable: manual `chrome://extensions` loading is the intended verification path. Playwright-launched Chrome stable profiles did not load the unpacked extension in this environment, while Playwright Chromium did.

MetalFX is native-only and is not reachable from WebGPU, so this extension ships shader upscalers instead of attempting to bridge private platform APIs.

## Known Limits

- DRM/EME video such as Netflix, Disney+, HBO Max, and Prime Video cannot be read from canvas and cannot be upscaled.
- Cross-origin video without CORS support taints canvas uploads and must be disabled cleanly.
- HTML5 video exposes no motion vectors or depth, so this cannot fully match temporal ML approaches like RTX Video Super Resolution.
- Neural-Pro is expected to be heavy on base M1 systems at 1080p to 4K, especially at 60 fps.

## Benchmarks

Benchmarks are not available yet. The first measured table will be added after the WebGPU Crisp and texture-pool milestone on an Apple Silicon Mac, with chip model clearly listed.

## Licensing

Original extension code is MIT-licensed. Third-party MIT shader ports remain MIT with upstream headers preserved. LGPL shader components, including RAVU-derived files, live under `src/upscaler/modes/*/` with original notices intact, full license text in `LICENSES/`, and per-file attribution in `NOTICE`.

Because this repository is public and ships source for the integrated shader components, users can inspect, modify, and rebuild the extension. The LGPL components are kept clearly separated and attributed.
