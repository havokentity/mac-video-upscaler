# Release Readiness Checklist

This checklist is for the public Chrome Video Upscaler release lane after the project rename from `mac-video-upscaler`. It focuses on platform validation, Chrome Web Store review risk, screenshot/benchmark capture, and the known limitations testers should confirm are documented before tagging a release.

## Release Identity

- Confirm the package and store-facing name is `Chrome Video Upscaler`.
- Confirm no user-facing release copy still presents the product as macOS-only.
- Confirm repository links point to `https://github.com/havokentity/chrome-video-upscaler`.
- Confirm the extension description stays accurate: GPU video upscaling for HTML5 video in Chrome.
- Record any remaining legacy references to `mac-video-upscaler` with file path, line, and whether they are historical/internal or user-facing.

## Local Build Gate

Run these commands from the repository root before platform testing:

```sh
corepack enable pnpm
pnpm install
pnpm verify
pnpm test:e2e
pnpm build
```

`pnpm verify` currently expands to:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm validate:wgsl && pnpm build
```

Tester record:

- OS name/version and CPU/GPU.
- Chrome channel and version from `chrome://version`.
- Node, pnpm, and package-manager versions.
- Commit SHA and whether the tree was clean.
- Command results, including skipped tests or environment-only failures.
- `dist/manifest.json` version, name, description, permissions, host permissions, and `web_accessible_resources` summary.
- Final `dist/` size and zip size for the upload candidate.

## Platform Validation Matrix

Use Chrome Stable first. Chrome Beta/Canary are useful for WebGPU regressions, but they should not replace Stable for release sign-off.

| Platform | Required Chrome Checks | Commands | Tester Should Record |
| --- | --- | --- | --- |
| macOS Apple Silicon | Load unpacked `dist`, test Auto/Crisp/Sharpen/Anime/Smooth/Neural-Lite/Neural-Pro on the local fixture and at least one real HTML5 site. Confirm WebGPU path behavior and WebGL2 fallback. Run native bench if Xcode/Swift is available. | `pnpm verify`; `pnpm test:e2e`; `pnpm native:build`; `pnpm native:sample` | macOS version, chip, GPU, Chrome version, WebGPU status, per-mode HUD text, screenshots, benchmark output, native sample output path or failure reason. |
| macOS Intel | Load unpacked `dist`, test non-neural shader modes and Neural-Lite fallback. Confirm performance degradation is clear and the UI remains responsive. | `pnpm verify`; `pnpm test:e2e` | Mac model/GPU, Chrome version, WebGPU availability, fallback status, modes that are too slow for real use. |
| Windows 11 | Load unpacked `dist`, test on Intel/AMD/Nvidia where available. Compare behavior against Chrome's built-in or driver-level video enhancement if enabled. Confirm no macOS-only wording in UI/store copy. | `pnpm verify`; `pnpm test:e2e` | Windows build, GPU and driver version, Chrome version, WebGPU adapter from `chrome://gpu`, mode/HUD screenshots, performance notes, RTX VSR or driver feature state if relevant. |
| Linux | Load unpacked `dist`, test Chrome Stable on X11 or Wayland. Confirm WebGPU availability and WebGL2 fallback when WebGPU is unavailable or blocked by driver settings. | `pnpm verify`; `pnpm test:e2e` | Distribution/version, display server, GPU/driver stack, Chrome version, `chrome://gpu` WebGPU/WebGL status, fallback behavior, any sandbox/codec issues. |

Manual Chrome install flow:

1. Run `pnpm build`.
2. Open `chrome://extensions`.
3. Enable Developer Mode.
4. Choose **Load unpacked** and select `dist`.
5. Open a test video page and toggle the HUD with `Ctrl+Shift+U`.
6. Cycle through modes from the popup/options UI.
7. Reload the page and confirm settings persist.
8. Disable the current site through site controls and confirm the original video remains visible.

## Mode Smoke Checklist

For each tested platform, capture at least one screenshot with the HUD visible for these modes:

- None: original video remains visible, no processing claim is shown.
- Auto: HUD reaches Auto and selects a usable backend.
- Crisp: sharpening/upscale is visible on the low-resolution fixture.
- Sharpen: paused-frame pixel/detail change is visible.
- Anime: WebGL2 path initializes and output differs from native frame.
- Smooth: WebGPU path initializes where available.
- Neural-Lite: ArtCNN/ONNX Runtime path initializes, or a clear WebGPU/WASM fallback/error is shown.
- Neural-Pro: RAVU-Lite path initializes, or performance limitations are clear.

Tester record:

- Page URL or fixture name.
- Source resolution and displayed CSS size.
- Mode, scale, sharpness, frame-generation setting, and force WebGL2/F32 settings.
- HUD backend/status text.
- Whether the overlay hides/restores the native video correctly.
- Any console errors from the page, content script, service worker, or extension pages.

## Screenshots And Store Assets

Capture screenshots on Chrome Stable with the release candidate loaded from `dist`.

| Asset | Required Content | Notes |
| --- | --- | --- |
| Store screenshot 1 | Popup/options showing core controls and `Chrome Video Upscaler` branding. | Avoid implying support for DRM services. |
| Store screenshot 2 | HTML5 video with HUD visible on a non-DRM page. | HUD should show mode, backend, resolution, and FPS/status. |
| Store screenshot 3 | Before/after or side-by-side quality comparison from the local fixture or a permitted public-domain video. | Record source license/URL if not using bundled fixtures. |
| Store screenshot 4 | Site allow/block behavior or known-limit messaging. | Helps justify broad host permissions. |
| Optional benchmark image | Markdown/table capture from `docs/benchmark-local.md` or release notes. | Do not present smoke callback FPS as GPU timing. |

Screenshot record:

- Platform, Chrome version, display scale, and screenshot dimensions.
- Exact mode/settings used.
- Source video license and URL/path.
- Whether the image was edited or cropped.

## Benchmark Matrix

Automated smoke benchmark:

```sh
pnpm build
node scripts/collect-benchmark.mjs --mode auto,crisp,sharpen,anime,smooth --duration-ms 5000
node scripts/collect-benchmark.mjs --output markdown --output-path docs/benchmark-local.md
```

Optional visible run for troubleshooting:

```sh
node scripts/collect-benchmark.mjs --headed --mode crisp,smooth --duration-ms 5000
```

Native macOS comparison, when available:

```sh
pnpm native:build
pnpm native:sample
```

Benchmark record:

- Platform, GPU, driver, Chrome version, and display refresh rate.
- Extension commit SHA and `dist` build timestamp.
- Source video, source resolution, displayed size, and target scale.
- Mode/settings and backend/HUD text.
- Callback FPS from the smoke harness.
- Manual visual notes: ringing, aliasing, over-sharpening, color shift, dropped frames, thermal throttling, fan noise, and responsiveness.
- Any skipped mode and the exact reason.

Use this table in release notes or a follow-up benchmark doc:

| Platform | GPU | Chrome | Source -> Display | Mode | Backend/HUD | Callback FPS | Visual Result | Notes |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- |
| macOS | TBD | TBD | 320x180 -> 640x360 | Crisp | TBD | TBD | TBD | TBD |
| Windows | TBD | TBD | 320x180 -> 640x360 | Crisp | TBD | TBD | TBD | TBD |
| Linux | TBD | TBD | 320x180 -> 640x360 | Crisp | TBD | TBD | TBD | TBD |

## Chrome Web Store Review Checklist

Manifest/package surface to review before upload:

- `manifest_version`: 3.
- `name`: `Chrome Video Upscaler`.
- `minimum_chrome_version`: 121.
- Permissions: `storage`, `activeTab`.
- Host permissions: `http://*/*`, `https://*/*`.
- Content scripts: all HTTP/HTTPS frames, `document_idle`, `all_frames: true`.
- CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
- Web-accessible resources: ArtCNN ONNX model and ONNX Runtime WASM/MJS sidecars, plus bundled content-script chunks in the built manifest.

Store privacy/package concerns:

- Explain broad host permissions as necessary to discover and overlay HTML5 video on arbitrary user-selected sites.
- State that video frames are processed locally in the browser/GPU and are not sent to a remote service.
- State that settings are stored with Chrome extension storage for global and per-site preferences.
- Confirm no remote JavaScript, remote WASM, CDN runtime, telemetry endpoint, analytics SDK, or remote model download exists in the release candidate.
- Confirm packaged ONNX/WASM assets are loaded from extension URLs and not network URLs.
- Confirm source maps are either intentionally included for review/debuggability or intentionally excluded from the final upload package.
- Confirm third-party notices and licenses cover ONNX Runtime Web, ArtCNN, Anime4K-derived code, RAVU-derived code, and any other bundled shader/model assets.
- Confirm LGPL components remain attributed and source-available in the public repository.
- Confirm store copy does not claim compatibility with DRM/EME streaming services.
- Confirm store copy does not claim RTX VSR parity, optical-flow frame interpolation, or driver-level enhancement.

Package inspection commands:

```sh
pnpm build
du -sh dist
find dist -maxdepth 3 -type f | sort
```

Optional upload zip command:

```sh
cd dist
zip -r ../chrome-video-upscaler-store.zip .
cd ..
du -sh chrome-video-upscaler-store.zip
```

Tester record:

- Zip file name, size, SHA256, and commit SHA.
- Manual check that the zip root contains `manifest.json`.
- Any source map decision and rationale.
- Any Chrome Web Store warning text encountered during upload.

## Known Limitations To Validate After Rename

These limitations should remain visible in README, store copy, release notes, or issue tracker before public release:

- The project is renamed to Chrome Video Upscaler, but it is still a Chrome extension, not a general OS-level video enhancer.
- DRM/EME video cannot be read into canvas and cannot be upscaled.
- Cross-origin video without compatible CORS behavior can taint frame access and must disable cleanly.
- HTML5 video does not expose motion vectors or depth, so this cannot fully match temporal ML scalers or driver-level RTX Video Super Resolution.
- Frame generation currently re-renders available decoded frames to a target presentation cadence; it is not optical-flow interpolation.
- Neural-Pro RAVU-Lite can be heavy at high resolutions and high refresh rates, especially on lower-power GPUs.
- RAVU-Zoom is not enabled yet.
- Neural-Lite depends on packaged ONNX Runtime Web assets and may fall back from WebGPU to WASM depending on Chrome/GPU support.
- The native Metal bench is macOS-only and is for offline algorithm comparison, not an extension feature.
- Chrome Stable manual loading is the release validation target; Playwright Chromium smoke coverage is useful but does not replace manual Chrome checks.

## Release Sign-Off Template

```text
Release candidate:
Commit SHA:
Tester:
Date:

Build gate:
- pnpm verify:
- pnpm test:e2e:
- pnpm build:
- dist size:
- zip size/SHA256:

Platform:
- OS/version:
- Chrome version:
- CPU/GPU/driver:
- chrome://gpu WebGPU/WebGL status:

Mode results:
- None:
- Auto:
- Crisp:
- Sharpen:
- Anime:
- Smooth:
- Neural-Lite:
- Neural-Pro:

Screenshots captured:
- Popup/options:
- HUD on video:
- Before/after:
- Site controls/limit messaging:

Benchmark:
- Command:
- Output path:
- Callback FPS summary:
- Visual/performance notes:

Store review:
- Permission rationale checked:
- Remote-code check:
- License/notice check:
- Known limits reflected in copy:

Blockers:
- 

Follow-ups:
-
```
