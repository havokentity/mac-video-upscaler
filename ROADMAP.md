# Roadmap

## v0.1.0

- [x] Scaffold MV3 extension with Vite, strict TypeScript, CRXJS, CI, and license structure.
- [x] Add overlay plumbing with 1:1 frame copy and local sample-video smoke tests.
- [x] Implement Crisp on WebGL2 and WebGPU.
- [x] Implement Sharpen on WebGL2 and WebGPU.
- [x] Add Smooth WebGPU path.
- [x] Add auto classifier and route to implemented modes.
- [x] Add Anime4K-inspired Mode A and A+A milestone path.
- [x] Verify Neural-Lite / ArtCNN license and add disabled skeleton.
- [x] Add opt-in Neural-Pro / RAVU attribution skeleton.
- [x] Import and run RAVU-Lite for the first Neural-Pro path.
- [x] Add DRM/CORS frame access probe helpers.
- [x] Add HUD formatting, rendered-FPS sampling, and routed-mode smoke coverage.
- [x] Add per-site allow/block/rule storage and content-script resolution.
- [x] Add local benchmark smoke harness with Markdown/JSON output.
- [x] Add experimental 60/120 fps overlay frame-pacing control.
- [x] Add real Neural-Lite / ArtCNN C4F16 ONNX Runtime path with WebGPU requested and WASM fallback available.
- [x] Add lazy-loaded WebGL2 RAVU-Zoom with LGPL headers and NOTICE entries.
- [x] Draft store listing and v0.1.0 release notes.
- [x] Generate ArtCNN C4F16 shader-native WGSL pass artifacts and CPU/reference checks.
- [ ] Wire ArtCNN C4F16 shader-native WebGPU runtime for lower package size.
- [ ] Port ArtCNN C4F32 shader-native WebGPU path.
- [ ] Port WebGPU Neural-Pro / RAVU with LGPL headers and NOTICE entries.
- [ ] Add timestamp-query GPU timing, screenshots, and measured cross-platform benchmarks.

## Explicit Non-Goals

- FSR 2/3, DLSS, XeSS, and RTX Video Super Resolution are not planned. They require temporal inputs such as motion vectors and depth that ordinary `<video>` elements do not expose.

## Longer-Term Ideas

- Temporal accumulation heuristics that work only from decoded color frames.
- Optical-flow or lightweight frame interpolation from decoded color frames only.
- Larger shader ML upscalers as WebGPU compute performance and browser tooling mature.
- Optional native helper for a true MetalFX bridge, if it can be done transparently and with a reviewable security model.
