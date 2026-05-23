# v0.1.0 Release Notes Draft

These notes are for the first public release candidate. Do not describe this release as tagged, published, or accepted by the Chrome Web Store until that has happened.

## Highlights

- Renamed the project to **Chrome Video Upscaler** so the extension is positioned as a Chrome video upscaler across macOS, Windows, and Linux, while still keeping Apple Silicon and Metal-lowering performance in mind.
- Added a Manifest V3 extension with Vite, strict TypeScript, popup/options pages, a background service worker, content-script video detection, and persistent `chrome.storage` settings.
- Added a canvas overlay pipeline that tracks visible HTML5 video elements, keeps native page audio/controls/captions/seek behavior, and redraws frames while paused for easier still-frame comparison.
- Added global and per-site settings, allow/block behavior, HUD visibility controls, and a `Ctrl+Shift+U` HUD shortcut.
- Added local WebGL2/WebGPU shader paths for practical live-video testing, plus automated Playwright coverage for the extension overlay and routed modes.

## Included Modes

| Mode | Current Status |
| --- | --- |
| None | Passthrough option for leaving video unprocessed. |
| Auto | First-frame heuristic routes to a lightweight mode; Neural-Pro remains opt-in. |
| Crisp | FSR 1.0-inspired WebGL2/WebGPU path with stronger detail sharpening and low-resolution boost. |
| Sharpen | CAS-style 1.0x sharpening path. |
| Anime | WebGL2 path uses bundled Anime4K-derived Fast Mode A/A+A blocks; WebGPU remains a staging port. |
| Smooth | WebGPU Lanczos/Jinc-style upscaler; fuller EWA tuning remains future work. |
| Neural-Lite | Packaged ArtCNN C4F16 ONNX model through ONNX Runtime Web with WebGPU requested and WASM fallback available. This can be slow depending on Chrome/GPU support. |
| Neural-Pro | WebGL2 RAVU-Lite path plus lazy-loaded RAVU-Zoom path. WebGPU RAVU is not implemented yet. |
| Experimental Filters | Edge Detect, Night Vision, Predator, CRT, Inverted Colors, and Cartoon Rotoscope for diagnostics and fun visual modes. |

## Packaging

Build the unpacked extension:

```sh
corepack enable pnpm
pnpm install
pnpm build
```

Load `dist` from `chrome://extensions` with Developer Mode enabled.

Build the Chrome Web Store candidate zip:

```sh
pnpm package:store
```

The store package disables source maps and writes:

```text
chrome-video-upscaler-v0.1.0.zip
```

Normal local builds keep source maps for debugging. The public repository remains the source distribution for review and license compliance.

## Verification Commands

Recommended local gate:

```sh
pnpm verify
pnpm test:e2e
pnpm package:store
```

Optional benchmark smoke harness:

```sh
node scripts/collect-benchmark.mjs --mode auto,crisp,sharpen,anime,smooth --duration-ms 5000
node scripts/collect-benchmark.mjs --output markdown --output-path docs/benchmark-local.md
```

Optional macOS-native offline comparison bench:

```sh
pnpm native:build
pnpm native:sample
```

The benchmark smoke harness records callback and HUD evidence. It is not a substitute for real GPU timestamp-query measurements.

## Store And Platform Validation

Before tagging or publishing, collect:

- Chrome Stable manual load from `dist`.
- HUD screenshots for None, Auto, Crisp, Sharpen, Anime, Smooth, Neural-Lite, and Neural-Pro on at least one local or permitted non-DRM video.
- `chrome://version` and `chrome://gpu` captures.
- At least one platform notes file using `docs/platform-validation.md`.
- Store screenshots using `docs/screenshot-capture.md`.
- Store listing/privacy text reviewed from `docs/store-listing.md`.

The release package should also be checked for:

- `manifest.json` at the zip root.
- No `.map` files in the store zip.
- No remote JavaScript, remote WASM, CDN runtime code, telemetry endpoint, analytics SDK, or remote model download.
- NOTICE and LICENSES coverage for MIT, LGPL, Anime4K-derived, ArtCNN, ONNX Runtime, and RAVU-derived assets.

## Known Limits

- DRM/EME video cannot be upscaled because protected frames are not readable through browser canvas APIs.
- Cross-origin video without compatible CORS behavior can block GPU frame upload.
- HTML5 video does not expose motion vectors or depth, so this release does not match temporal ML scalers such as RTX Video Super Resolution.
- Frame generation is presentation pacing only. It re-renders available decoded frames to a target cadence and does not synthesize optical-flow intermediate frames.
- Neural-Lite uses ONNX Runtime Web and may fall back to WASM or run slowly on some systems.
- ArtCNN shader-native WebGPU runtime is not complete; generated C4F16 pass artifacts and CPU/reference checks exist, but runtime wiring remains disabled.
- Neural-Pro RAVU-Zoom is lazy-loaded for WebGL2, but WebGPU RAVU is still future work.
- Performance and visual quality vary by GPU, browser version, video resolution, site player behavior, and display scaling.

## Next Work

- Wire the shader-native ArtCNN pass chain into Neural-Lite and tune GPU performance against the ONNX Runtime path.
- Translate RAVU to WebGPU with LGPL headers and attribution preserved.
- Add real timestamp-query GPU timing where browser support permits.
- Capture real benchmark and screenshot evidence across macOS, Windows, and Linux.
- Tune Crisp/Smooth quality against the native side-by-side bench and add visual regression fixtures.
