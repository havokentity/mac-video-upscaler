# Neural Runtime Implementation Notes

## Goal

Document the first packaged neural runtime path for Neural-Lite: ONNX Runtime Web with WebGPU requested, ORT's WASM fallback available, and an extension-owned ArtCNN C4F16 model. This note captures the bundling shape, MV3 constraints, and follow-up work needed before larger models are worth shipping.

## Candidate Runtime

Use `onnxruntime-web` only from the lazy Neural-Lite ArtCNN module so the existing shader paths do not pay startup or bundle cost until Neural-Lite requests it. ONNX Runtime's WebGPU path is enabled by importing the WebGPU entry point and creating a session with the WebGPU execution provider:

```ts
import * as ort from 'onnxruntime-web/webgpu';

const session = await ort.InferenceSession.create(modelUrl, {
  executionProviders: ['webgpu'],
});
```

The implementation keeps WASM fallback available because Chrome/headless environments may reject the WebGPU execution provider even when the extension can still run the packaged model.

Relevant upstream notes:

- ONNX Runtime documents the WebGPU entry point as `onnxruntime-web/webgpu` and requires `executionProviders: ['webgpu']`: [Using the WebGPU Execution Provider](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html).
- ONNX Runtime's WebGPU bundle currently initializes through the asyncify sidecar in the installed `onnxruntime-web` package, so the extension pins that exact same-version `.mjs` and `.wasm` pair: [Deploying ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/deploy.html).

## MV3 Bundling Shape

Current extension layout:

```text
dist/
  assets/
    ort.webgpu.min-*.js
  ort/
    ort-wasm-simd-threaded.asyncify.mjs
    ort-wasm-simd-threaded.asyncify.wasm
  models/
    artcnn/
      ArtCNN_C4F16.onnx
```

Runtime setup:

1. Bundle ORT JavaScript through Vite/CRXJS from a normal npm dependency. Do not load ORT JavaScript from a CDN.
2. Copy the exact ORT asyncify `.mjs` and `.wasm` sidecars from the installed package into extension-owned public assets.
3. Set `ort.env.wasm.wasmPaths` before the first session is created, resolved through `chrome.runtime.getURL('ort/...')`.
4. Load the ArtCNN C4F16 model with `chrome.runtime.getURL('models/artcnn/ArtCNN_C4F16.onnx')`.
5. Keep larger model selection, model compression, and zero-copy video tensor plumbing behind separate decisions.

The `wasmPaths` override matters because ONNX Runtime otherwise tries to resolve WASM relative to the JavaScript bundle. ONNX Runtime also warns that the JavaScript bundle and WASM files must come from the same build/version: [env.wasm.wasmPaths](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html#envwasmwasmpaths).

## CSP And Asset Constraints

Manifest V3 has a tight extension-page CSP. Chrome's minimum extension policy allows local scripts plus `'wasm-unsafe-eval'`, but does not allow relaxing to arbitrary script sources or `'unsafe-eval'`: [Chrome extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy). Practical constraints:

- ORT JavaScript and ORT WASM must be extension-packaged. Chrome Web Store policy treats remotely loaded JavaScript and WASM as remotely hosted code, so CDN runtime code is not viable for a store build: [remote hosted code guidance](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).
- Avoid ORT's proxy worker mode for now. ONNX Runtime notes that the proxy worker cannot work in CSP-restricted environments, and the extension already has enough moving pieces with content scripts and a service worker.
- If ORT emits worker or `.mjs` sidecars for the selected package version, they must be bundled as local files and resolved through ORT's path configuration or a Vite asset rule. Do not assume the single `.wasm` file is sufficient until tested against the exact package version.
- Content scripts can fetch extension files with `chrome.runtime.getURL()`, but any resource fetched by a content script must be declared as a web-accessible resource. Chrome notes that this exposes those files to scripts running on matching sites, so model and runtime asset globs should be as narrow as possible: [content script resource access](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) and [web_accessible_resources](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources).
- Remote model files are data rather than executable code, but Neural-Lite currently uses a packaged small model to avoid review ambiguity, offline failures, cache variance, and privacy questions. A later model-download design can cover integrity checks, version pinning, storage quotas, and user consent.
- Large model files may materially increase the extension package. Any real candidate model should have a size budget, license check, and cold-load measurement before being added to the default bundle.

## Model File Constraints

The bundled ArtCNN C4F16 model is a good first default because it is:

- MIT-licensed and already distributed upstream as ONNX
- small enough to package directly
- free of external tensor data files
- based on common ops: Conv, Relu, Add, DepthToSpace, and Clip
- practical for real-time anime/illustration enhancement

For real candidates, prefer ONNX files that:

- avoid custom operators
- support static shapes or a small bounded shape set
- can be quantized or converted to fp16 without a major quality loss
- have clear license and attribution requirements
- can run without network access after installation

## Minimal Test Plan

1. Build/package smoke: build the extension and inspect `dist` to confirm ORT JS, the exact ORT WASM/sidecar files, and `ArtCNN_C4F16.onnx` are present.
2. MV3 load smoke: load `dist` in Chrome, open the service worker/content script console, and verify there are no CSP, web-accessible-resource, or remote-code fetch errors.
3. Runtime smoke: initialize ORT from a content-script-owned lazy path, set `wasmPaths`, create a session with `['webgpu', 'wasm']`, run one inference, and confirm the HUD reaches Neural-Lite.
4. Fallback smoke: force `executionProviders: ['wasm']` for the same model to distinguish packaging failures from WebGPU device failures.
5. Page fixture smoke: run the existing local video fixture with neural-runtime disabled and enabled-but-idle to confirm current shader modes still mount and render.
6. Performance guardrail: measure cold import time, first session creation time, first inference time, and steady-state inference time on Apple Silicon Chrome; record package size delta before any real model is proposed.

## Open Questions

- Does a future `onnxruntime-web` version switch the WebGPU entry point back to a JSEP sidecar or another sidecar name?
- Can the runtime run reliably from the current content script context on both `https://` pages and local/http test fixtures, or should inference move into an extension page or offscreen document later?
- What is the acceptable extension package size increase before models need optional download/caching instead of bundling?
- How much tensor upload/download overhead remains if video frames must round-trip through CPU buffers rather than staying in WebGPU buffers?
