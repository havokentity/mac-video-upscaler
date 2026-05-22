# Mac Video Upscaler

Metal-tuned GPU video upscaling for Chrome on macOS. The project targets Manifest V3, WebGPU through Dawn/Tint/Metal, and a WebGL2 fallback for the fast modes.

This repository is being built in ordered milestones. The current build mounts a video overlay, routes Auto, Crisp, Sharpen, Anime, Neural-Lite ArtCNN, Neural-Pro RAVU-Lite, Smooth, and experimental WebGL2 filters through working shader paths, persists global and per-site settings, and exposes a HUD with backend, mode, resolution, FPS, frame-generation target, and status details. The HUD can be toggled from the popup or with `Ctrl+Shift+U`, and its visibility persists across settings changes. The overlay also redraws the current decoded frame while paused, which makes still-frame visual comparisons easier.

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
| None | Disabled | MIT | Passthrough option for native video with no filter or upscaling. |
| Auto | WebGPU/WebGL2 | MIT | Cheap first-frame classifier; Neural-Pro remains opt-in. |
| Crisp | WebGL2 + WebGPU | MIT | FSR 1.0-inspired EASU 12-tap reconstruction plus stronger RCAS/detail sharpening, with extra boost for tiny sources such as 144p. Crisp currently prefers the visually verified WebGL2 path and falls back to WebGPU if needed. The canvas renders at least to the video display backing size so Chrome does not blur the result with a second upscale. |
| Sharpen | WebGL2 + WebGPU | MIT | Stronger CAS-style 1.0x sharpen with WebGL2 preferred, WebGPU fallback, and output sized to the display backing so stretched low-res video is processed after the browser layout scale. |
| Anime | WebGL2 + WebGPU | MIT | WebGL2 runs bundled upstream Anime4K Fast Mode A/A+A CNN restore and x2 upscaling blocks from bloc97/Anime4K. The WebGPU path is still an Anime4K-inspired staging port while the exact chain is translated to WGSL. |
| Smooth | WebGPU | Public-domain math | Lanczos/Jinc-style WebGPU upscaler; fuller EWA pass remains planned. |
| Edge Detect | WebGL2 | MIT | Experimental outline filter for inspecting edges and compression artifacts. |
| Night Vision | WebGL2 | MIT | Experimental green phosphor filter with scanline/noise styling. |
| Predator | WebGL2 | MIT | Experimental thermal false-color filter for fun. |
| CRT | WebGL2 | MIT | Experimental scanline, vignette, and color-fringe filter. |
| Inverted Colors | WebGL2 | MIT | Experimental inverted color filter. |
| Cartoon Rotoscope | WebGL2 | MIT | Experimental toon-shader look with posterized colors and inked edges. |
| Neural-Lite | ONNX Runtime WebGPU + WASM fallback, WebGL2 diagnostic fallback | MIT | Runs the imported ArtCNN C4F16 ONNX model through ONNX Runtime with WebGPU requested and WASM available as ORT's safety fallback. Force WebGL2 keeps the older residual preview fallback for diagnostics. |
| Neural-Pro | WebGL2 + WebGPU staging | LGPL-3.0-or-later | WebGL2 runs imported upstream RAVU-Lite-AR r3. RAVU-Zoom remains pending because its LUT/shader payload is much larger and needs a separate performance pass. |

## How It Works

The content script finds visible `<video>` elements, mounts a pointer-transparent canvas over the video box, resolves global settings plus allow/block/site overrides for the current hostname, and hands frames to a reusable upscaler pipeline. The original video is kept in the page for audio, controls, captions, fullscreen, and site event handling, then visually hidden while the overlay presents processed frames. Blocked or allow-list-missed sites keep the original video visible and show the disable reason in the HUD.

Crisp, Sharpen, Anime, and Neural-Pro RAVU-Lite currently prefer the WebGL2 paths because those are the visually verified live-video implementations. Neural-Lite now uses ArtCNN C4F16 through ONNX Runtime with WebGPU requested and ORT's WASM fallback available, with the WebGL2 preview path kept for diagnostics. The current WebGPU shader paths upload frames with `copyExternalImageToTexture`, reuse GPU resources, validate WGSL through Tint to MSL, and use `8x8x1` compute workgroups where compute is active.

Experimental frame generation is a presentation pacing option: it asks the overlay to render at a 60 fps or 120 fps target instead of waiting only for decoded video frame callbacks. This is useful for responsiveness testing and display pacing, but it is not optical-flow motion interpolation yet.

## Native Upscale Bench

The repo also includes a macOS-native offline test tool in `native/`. This is for algorithm truth testing outside Chrome and YouTube:

```sh
cd native
swift run -c release mac-video-upscaler-native \
  --input /path/to/original.mp4 \
  --output /path/to/upscaled.mp4 \
  --mode crisp \
  --scale 2 \
  --sharpness 1 \
  --open-compare
```

The CLI writes `native/last-run.json` plus `native/last-compare.html`, and `--open-compare` opens the side-by-side page automatically. You can also open `native/compare.html` manually and choose files, or pass `left`/`right` file URLs as query params.

The native bench currently uses AVFoundation plus Metal compute for the `crisp` path, with the earlier Core Image enhancement path available as `rescue`. It is video-only for now, by design, so visual quality can be judged without audio muxing or browser presentation noise.

## Verification Status

- Generic HTML5 MP4 fixture: automated Playwright smoke test loads the unpacked extension from `dist`, mounts the overlay, and verifies nonzero canvas dimensions.
- WebGL2 Crisp: automated Playwright smoke test writes extension settings, activates Crisp, verifies HUD mode text, checks backing resolution, and pixel-diffs sharpness changes on a paused frame.
- WebGL2 Sharpen: automated Playwright smoke test pixel-diffs CAS sharpness changes on a paused frame.
- WebGL2 Anime and Neural-Pro RAVU-Lite: automated Playwright smoke tests pixel-diff Anime against the native paused frame and route Neural-Pro through its HUD status so the paths cannot silently no-op.
- Neural-Lite ArtCNN: ONNX Runtime path is packaged with a small ArtCNN C4F16 model and ORT WebGPU sidecar. Browser smoke coverage verifies the path initializes; headless Chromium may let ORT fall back to WASM even when the WebGPU provider is requested.
- Routed modes: automated Playwright smoke verifies Sharpen, Anime, Smooth, Neural-Lite, and Neural-Pro reach their expected HUD status.
- Per-site controls: automated Playwright smoke verifies a blocked hostname disables the overlay pipeline without hiding the original video.
- WebGPU shaders: CI validates WGSL to MSL with Dawn Tint.
- DRM/CORS probe helpers classify frame access failures for clear disable messaging.
- YouTube: automated Chromium smoke verified the overlay on `https://www.youtube.com/watch?v=jNQXAC9IVRw`.
- Chrome stable: manual `chrome://extensions` loading is the intended verification path. Playwright-launched Chrome stable profiles did not load the unpacked extension in this environment, while Playwright Chromium did.
- Native bench: `swift build` succeeds and a fixture MP4 can be upscaled to a valid MP4 with the native CLI.

MetalFX is native-only and is not reachable from WebGPU, so this extension ships shader upscalers instead of attempting to bridge private platform APIs.

## Known Limits

- DRM/EME video such as Netflix, Disney+, HBO Max, and Prime Video cannot be read from canvas and cannot be upscaled.
- Cross-origin video without CORS support taints canvas uploads and must be disabled cleanly.
- HTML5 video exposes no motion vectors or depth, so this cannot fully match temporal ML approaches like RTX Video Super Resolution.
- Frame generation currently targets presentation FPS by re-rendering available decoded frames; true optical-flow interpolation is future work.
- Neural-Pro RAVU-Lite is expected to be heavy on base M1 systems at 1080p to 4K, especially at 60 fps. RAVU-Zoom is not enabled yet.

## Benchmarks

The benchmark smoke harness loads the built extension against the local MP4 fixture and records overlay dimensions, HUD text, callback counts, and approximate callback FPS:

```sh
pnpm build
node scripts/collect-benchmark.mjs --mode crisp,smooth --duration-ms 5000
node scripts/collect-benchmark.mjs --output markdown --output-path docs/benchmark-local.md
```

Manual Apple Silicon GPU timing numbers are still pending. The first measured table will list the exact Mac chip, Chrome version, source resolution, output target, and per-mode GPU time.

## Licensing

Original extension code is MIT-licensed: Copyright (c) 2026 Rajesh Peter D'Monte. Third-party MIT shader ports remain MIT with upstream headers preserved. LGPL shader components, including RAVU-derived files, live under `src/upscaler/modes/*/` with original notices intact, full license text in `LICENSES/`, and per-file attribution in `NOTICE`.

Because this repository is public and ships source for the integrated shader components, users can inspect, modify, and rebuild the extension. The LGPL components are kept clearly separated and attributed.
