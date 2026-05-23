# WebGPU RAVU Port Plan

## Current Runtime Baseline

Neural-Pro currently has a working WebGL2 runtime path and a disabled WebGPU
placeholder.

- `RAVU-Lite-AR r3` is imported from `ravu-lite-ar-r3.hook` and statically
  parsed by `ravu-lite-source.ts`.
- `RAVU-Zoom-AR r3` is imported from `ravu-zoom-ar-r3.hook` and lazy-loaded by
  `ravu-zoom-source.ts` only when explicit Zoom or Auto near 2x selects it.
- Both hook files preserve their upstream LGPL headers and are listed in
  `NOTICE`.
- The WebGL2 path uploads the video frame as an RGBA source texture, runs RAVU
  on luma, then presents by applying the RAVU luma ratio back onto the original
  source RGB. That keeps chroma from the browser video frame and avoids trying
  to neural-upscale color channels.

The first WebGPU port should match the current WebGL2 behavior pixel-for-pixel
closely enough to make A/B debugging boring before any quality experiments.

## Imported Hook Shape

### RAVU-Lite

- Source file: `src/upscaler/modes/neural-pro/ravu-lite-ar-r3.hook`
- Shader passes: two
  - `RAVU-Lite-AR (step1, r3)`
  - `RAVU-Lite-AR (step2, r3)`
- LUT:
  - Name: `ravu_lite_lut3`
  - Size: `13 x 288`
  - Channels: RGBA
  - Format in hook: `rgba16f`
  - WebGL2 filtering: `NEAREST`
- Runtime target structure:
  - Step 1 output: source width x source height, `rgba16f`
  - Step 2 output: source width * 2 x source height * 2, `rgba16f`
  - Present: requested canvas size, source chroma preserved

### RAVU-Zoom

- Source file: `src/upscaler/modes/neural-pro/ravu-zoom-ar-r3.hook`
- Shader passes: one
  - `RAVU-Zoom-AR (luma, r3)`
- LUTs:
  - `ravu_zoom_lut3`: `45 x 2592`, RGBA, `rgba16f`, linear filtering
  - `ravu_zoom_lut3_ar`: `18 x 2592`, RGBA, `rgba16f`, linear filtering
- Runtime target structure:
  - Zoom output: requested canvas size, `rgba16f`
  - Present: requested canvas size, source chroma preserved
- Loading rule:
  - Keep Zoom lazy-loaded. Do not statically import the 5.2 MB hook payload into
    the main content-script bundle.

## WebGPU Resource Model

### Texture Formats

Use a format ladder rather than a single hard requirement:

| Resource | Preferred format | Fallback | Notes |
|---|---|---|---|
| Uploaded video frame | `rgba8unorm` | none | Use `copyExternalImageToTexture`; keep the existing browser/video color path. |
| Luma intermediate targets | `rgba16float` | `rgba32float` behind dev flag only | RAVU outputs can exceed 8-bit normalized precision; do not use `rgba8unorm` for intermediate luma. |
| LUT textures | `rgba16float` | `rgba32float` only if browser rejects float16 upload | Hook payloads decode to fp32 today, but the source format is `rgba16f`; pack to half before upload when stable. |
| Final canvas presentation | `rgba8unorm` | browser preferred canvas format if required | Match existing WebGPU modes and the overlay canvas. |

The MVP can upload LUT arrays as `rgba32float` first if that gets the shader
working faster, but the production target should be `rgba16float` because the
upstream hook format is half float and Apple GPUs are fast at `f16`.

### Bind Groups

Create one reusable bind group layout per pass family:

RAVU-Lite step 1:

- binding 0: source video texture, sampled
- binding 1: source sampler, linear clamp
- binding 2: `ravu_lite_lut3` sampled texture
- binding 3: LUT sampler, nearest clamp
- binding 4: uniform buffer with source size, output size, inverse sizes
- binding 5: step 1 storage output, `texture_storage_2d<rgba16float, write>`

RAVU-Lite step 2:

- binding 0: step 1 texture, sampled
- binding 1: step 1 sampler, linear or nearest after visual comparison
- binding 2: uniform buffer with source size, intermediate size, output size
- binding 3: step 2 storage output, `texture_storage_2d<rgba16float, write>`

RAVU-Zoom:

- binding 0: source video texture, sampled
- binding 1: source sampler, linear clamp
- binding 2: `ravu_zoom_lut3` sampled texture
- binding 3: `ravu_zoom_lut3_ar` sampled texture
- binding 4: LUT sampler, linear clamp
- binding 5: uniform buffer with source size, output size, inverse sizes
- binding 6: zoom storage output, `texture_storage_2d<rgba16float, write>`

Present:

- binding 0: source video texture, sampled
- binding 1: RAVU luma texture, sampled
- binding 2: linear sampler
- binding 3: uniform buffer with output size and source size
- binding 4: final storage output or canvas render target

Prefer compute passes for the RAVU work and a small final compute present pass
into the overlay texture. Keep fragment presentation only if it meaningfully
reduces plumbing.

## Shader Translation Strategy

Do not hand-port the hook files line-by-line directly into checked-in WGSL.
Generate a small, auditable WGSL wrapper around the parsed mpv hook bodies.

Required wrapper substitutions:

- `vec2`, `vec3`, `vec4` -> WGSL vector aliases or generated WGSL types
- `mat4` -> `mat4x4<f32>` or `mat4x4<f16>` after validation
- `texture(...)` against LUTs -> `textureSampleLevel(..., 0.0)`
- `HOOKED_tex(pos)` -> source luma sample
- `HOOKED_texOff(offset)` -> source luma sample at `HOOKED_pos + offset * HOOKED_pt`
- `ravu_lite_int_tex(...)` and `ravu_lite_int_texOff(...)` -> sampled step 1 texture
- `HOOKED_pos` -> `(vec2<f32>(global_id.xy) + vec2<f32>(0.5)) / output_size`
- `HOOKED_size`, `HOOKED_pt`, intermediate sizes -> uniform fields

Because RAVU is luma-oriented, preserve the current WebGL2 approach:

1. Convert the source sample to luma with Rec. 709 weights.
2. Run RAVU on luma only.
3. Present by sampling original source RGB, computing `ravuLuma / sourceLuma`,
   clamping the ratio, and applying it to RGB.

This gives the WebGPU port the same visual contract as WebGL2 and keeps color
artifacts constrained while the neural shader translation is being validated.

## Pipeline Structure

### RAVU-Lite WebGPU

1. Upload current video frame into a pooled `rgba8unorm` source texture.
2. Dispatch step 1 at source width x source height.
   - Workgroup size: start with `(8, 8, 1)`.
   - Output: pooled `rgba16float` step 1 texture.
3. Dispatch step 2 at source width * 2 x source height * 2.
   - Input: step 1 texture.
   - Output: pooled `rgba16float` luma texture.
4. Dispatch present at requested output size.
   - Input: source texture and RAVU luma texture.
   - Output: overlay canvas texture.

### RAVU-Zoom WebGPU

1. Lazy-load and parse the Zoom hook exactly as WebGL2 does today.
2. Upload `ravu_zoom_lut3` and `ravu_zoom_lut3_ar` into pooled GPU textures.
3. Dispatch the single Zoom pass at requested output size.
   - Workgroup size: start with `(8, 8, 1)`.
   - Output: pooled `rgba16float` luma texture.
4. Dispatch the same present pass used by Lite.

## Validation Milestones

### Milestone 1: WebGPU Lite Skeleton

- Add WebGPU resource allocation for Lite LUT and two luma targets.
- Implement a temporary WGSL pass that samples source luma and writes it through
  the Lite pipeline targets without neural math.
- Confirm no black frames, correct pause-frame rendering, and correct teardown.
- Add an e2e paused-frame check that WebGPU Neural-Pro is not a no-op.

### Milestone 2: Generated Lite Step 1

- Translate only `RAVU-Lite-AR (step1, r3)` into WGSL.
- Compare WebGPU step 1 output against WebGL2 step 1 on the local fixture using
  a tiny debug readback path gated behind tests/dev code.
- Validate WGSL through `tint --format=msl`.

### Milestone 3: Generated Lite Step 2

- Translate step 2 and complete WebGPU RAVU-Lite.
- Compare final luma and presented RGB against WebGL2 on paused frames.
- Measure 720p->1440p and 1080p->4K frame time on Apple Silicon.

### Milestone 4: Zoom

- Reuse the lazy Zoom parser, but upload LUTs into WebGPU textures only when the
  selected variant resolves to Zoom.
- Translate the single Zoom pass.
- Keep Auto-at-2x behavior aligned with WebGL2 only after performance is known.

## Blockers And Risks

- WGSL translation must preserve mpv hook semantics closely enough for the LUT
  indexing math. Small coordinate or sampler differences can make RAVU look like
  a sharpen filter instead of an upscaler.
- WebGPU sampled `float32-filterable` is not guaranteed. Avoid depending on
  `rgba32float` filtering in production; target `rgba16float` LUTs with filterable
  support where available.
- `rgba16float` storage texture availability must be checked through WebGPU
  feature/device limits before enabling the path. If unavailable, fall back to
  the current WebGL2 Neural-Pro path.
- The current hook parser decodes LUT hex payloads into `Float32Array`. A
  production half-float upload needs a tested fp32-to-f16 packer or an offline
  generated half payload.
- WebGPU cannot import GLSL hook code dynamically at runtime. Any generated WGSL
  should be built from checked-in generated artifacts or generated at build time.
- Timestamp-query timing is useful but should stay optional; do not require it
  for WebGPU RAVU availability.

## Minimal First Implementation

The smallest useful patch is WebGPU RAVU-Lite step 1 in a disabled/dev-gated
pipeline:

1. Add `webgpu-ravu-lite-step1.wgsl` generated from the imported Lite hook.
2. Add a WebGPU Neural-Pro pipeline path that allocates:
   - source `rgba8unorm`
   - Lite LUT `rgba16float`
   - step 1 output `rgba16float`
3. Dispatch step 1 on paused frames and present its luma as grayscale only when
   the dev panel enables WebGPU Neural-Pro preview.
4. Validate:
   - `pnpm validate:wgsl`
   - `pnpm typecheck`
   - paused-frame e2e no-op check
   - visual comparison against the current WebGL2 Lite path

After that lands, step 2 and chroma-preserving presentation can be added without
changing the public Neural-Pro mode contract.
