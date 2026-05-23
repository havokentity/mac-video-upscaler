# Chrome Web Store Listing Draft

This is draft copy for a future Chrome Web Store submission. Do not mark the extension as published until the release package has been uploaded and accepted.

## Store Metadata

Name:

```text
Chrome Video Upscaler
```

Short description:

```text
GPU upscaling and sharpening for HTML5 video in Chrome, with local WebGPU/WebGL2 processing and no telemetry.
```

Category:

```text
Productivity
```

Suggested tags:

```text
video, upscaling, WebGPU, WebGL2, shader, HTML5 video
```

## Long Description

```text
Chrome Video Upscaler adds local GPU video upscaling and sharpening controls to ordinary HTML5 video in Chrome.

It watches for video elements on supported pages, places a transparent overlay canvas over the player, and renders processed frames locally on your GPU. The original page video remains in place for audio, controls, captions, seeking, and fullscreen behavior.

Current modes include:

- Auto: picks a lightweight mode from the first frame.
- None: leave the video untouched.
- Crisp: FSR 1.0-inspired spatial reconstruction plus detail sharpening.
- Sharpen: CAS-style sharpening without scale-up.
- Anime: Anime4K-derived WebGL2 path for illustrated content.
- Smooth: WebGPU Lanczos/Jinc-style path for softer live-action upscaling.
- Neural-Lite: ArtCNN through packaged ONNX Runtime Web, with WebGPU requested and WASM fallback available.
- Neural-Pro: RAVU-Lite and lazy-loaded RAVU-Zoom WebGL2 shader paths for heavier opt-in upscaling.
- Experimental looks: Edge Detect, Night Vision, Predator, CRT, Inverted Colors, and Cartoon Rotoscope.

The popup provides a master toggle, mode selection, scale, sharpness, frame pacing, HUD visibility, per-site controls, and developer toggles. The HUD can show mode, backend, source and output resolution, rendered FPS, frame-generation target, and status details.

Privacy is simple: video frames are processed locally in the browser and are not uploaded to a server. The extension has no telemetry, analytics SDK, tracking endpoint, or remote model download in the release package. Settings are stored with Chrome extension storage so global and per-site preferences persist.

Important limits:

- DRM/EME video such as Netflix, Disney+, HBO Max, and Prime Video cannot be upscaled because protected frames cannot be read by browser canvas APIs.
- Cross-origin video without compatible CORS behavior can block frame access.
- HTML5 video does not expose motion vectors or depth, so this is not the same as RTX Video Super Resolution, DLSS, FSR 2/3, or optical-flow frame interpolation.
- Frame generation currently re-renders available decoded frames to a target presentation cadence. It is not true generated intermediate motion.
- Neural modes can be slow on some GPUs. Neural-Lite may fall back to WASM, and WebGPU RAVU is not implemented yet.

Chrome Video Upscaler is open source and MIT-licensed for original extension code. Bundled third-party shader/model components are attributed in NOTICE with their licenses preserved, including LGPL RAVU-derived shader assets.
```

## Privacy Practices Draft

Single-purpose statement:

```text
The extension locally upscales and filters HTML5 video frames in Chrome using WebGPU or WebGL2.
```

Data use:

```text
Chrome Video Upscaler does not collect, sell, transmit, or share personal data. Video frames are processed locally in the browser/GPU. No video frames, page contents, URLs, browsing history, settings, or diagnostics are sent to the developer or to a third-party service.
```

Storage:

```text
The extension uses chrome.storage to save user preferences such as the master enabled toggle, selected mode, scale, sharpness, HUD visibility, developer toggles, and per-site allow/block settings.
```

Remote code:

```text
The release package does not load remote JavaScript, remote WebAssembly, CDN runtime code, telemetry code, or remote model files. ONNX Runtime sidecar files and the ArtCNN model are packaged with the extension.
```

## Permissions Explanation

`storage`:

```text
Used to save global settings, per-site rules, HUD visibility, selected mode, scale, sharpness, and developer options.
```

`activeTab`:

```text
Used for user-initiated interaction with the current tab from extension UI controls.
```

`http://*/*` and `https://*/*` host permissions:

```text
Needed so the content script can detect HTML5 video elements and place a local overlay on video pages across sites chosen by the user. The extension must run on the page to read accessible video frames into browser GPU APIs and to keep the overlay aligned with the player. Sites can be disabled with per-site controls.
```

`all_frames` content script behavior:

```text
Needed because many video players are embedded in iframes. The extension only acts when it finds eligible video elements and user settings allow processing for that site.
```

`wasm-unsafe-eval` CSP:

```text
Required by packaged ONNX Runtime WebAssembly assets used by Neural-Lite fallback paths. The WASM files are bundled with the extension rather than loaded remotely.
```

## Screenshot Plan

- Popup/options with the product name and controls visible.
- Non-DRM HTML5 video with HUD visible on the local fixture or a permitted public-domain video.
- Before/after comparison using the same paused frame.
- Site controls or known-limit message showing graceful disable behavior.
- Optional platform evidence captures from `chrome://version` and `chrome://gpu` for release notes, not store marketing screenshots.

Avoid screenshots from DRM streaming services or pages where the source video license is unclear.

## Review Caveats

- Do not claim support for Netflix, Disney+, HBO Max, Prime Video, or other DRM/EME playback.
- Do not claim RTX VSR parity, optical-flow interpolation, driver-level processing, or native OS-wide video enhancement.
- Do not claim Neural-Lite is always GPU-fast; the current ONNX Runtime path can fall back and may be slow.
- Do not claim ArtCNN shader-native runtime is complete; generated pass artifacts and CPU/reference checks exist, but runtime wiring remains disabled.
- Do not claim WebGPU RAVU is complete; current RAVU-Lite/RAVU-Zoom runtime path is WebGL2.
