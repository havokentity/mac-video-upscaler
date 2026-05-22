# ArtCNN Shader-Native Port Plan

## Scope

This note covers a shader-native port of upstream `ArtCNN_C4F16.glsl` from mpv GLSL compute into the Chrome Video Upscaler extension GPU pipeline. It does not change runtime code. The companion parser is `scripts/artcnn-shader-port-report.mjs`.

Upstream source inspected:

- `/tmp/ArtCNN/GLSL/ArtCNN_C4F16.glsl`
- Variant: `ArtCNN C4F16`
- License in source: MIT

Run the metadata report with:

```sh
node scripts/artcnn-shader-port-report.mjs /tmp/ArtCNN/GLSL/ArtCNN_C4F16.glsl
```

## Parsed Pass Structure

The inspected shader is an 8-pass mpv compute chain, not a 4-pass chain. The `//!COMPUTE` metadata is best read as output block size followed by local invocation size. For the first six passes, `//!COMPUTE 24 32 12 16` means a 12x16 local workgroup where each invocation writes a 2x2 block, producing a 24x32 output block.

| # | upstream pass | binds | output | scale | local size | writes | activation |
| - | ------------- | ----- | ------ | ----- | ---------- | ------ | ---------- |
| 1 | `ArtCNN C4F16 (Conv2D)` | `LUMA` | `conv2d` | 2x2 | 12x16x1 | 4 RGBA texels/invocation | linear |
| 2 | `ArtCNN C4F16 (Conv2D-1-ReLU)` | `conv2d` | `conv2d_1` | 2x2 | 12x16x1 | 4 RGBA texels/invocation | ReLU |
| 3 | `ArtCNN C4F16 (Conv2D-2-ReLU)` | `conv2d_1` | `conv2d_2` | 2x2 | 12x16x1 | 4 RGBA texels/invocation | ReLU |
| 4 | `ArtCNN C4F16 (Conv2D-3-ReLU)` | `conv2d_2` | `conv2d_3` | 2x2 | 12x16x1 | 4 RGBA texels/invocation | ReLU |
| 5 | `ArtCNN C4F16 (Conv2D-4-ReLU)` | `conv2d_3` | `conv2d_4` | 2x2 | 12x16x1 | 4 RGBA texels/invocation | ReLU |
| 6 | `ArtCNN C4F16 (Conv2D-5)` | `conv2d_4` | `conv2d_5` | 2x2 | 12x16x1 | 4 RGBA texels/invocation | linear |
| 7 | `ArtCNN C4F16 (Conv2D-6)` | `conv2d`, `conv2d_5` | `conv2d_6` | 1x1 | 12x16x1 | 1 RGBA texel/invocation | residual linear |
| 8 | `ArtCNN C4F16 (Depth-To-Space)` | `conv2d_6` | final image | 2x2 | 12x16x1 | 1 RGBA texel/invocation | clamp |

The parser counted:

- 7 intermediate textures
- 12,340 estimated scalar constants, including biases
- 756 `M4(...) * V4` products
- 36 `V4(...) * F` products in the first pass
- 26 total image stores

## Required Textures

The mpv source operates on `LUMA`, not full RGB. The final pass writes the reconstructed luma into `result.x` and alpha into `result.a`; mpv is expected to recombine planes outside this hook chain. The extension must therefore explicitly decide how to present the luma result as RGB.

Intermediate storage:

| texture | dimensions | format target | producer | consumers |
| ------- | ---------- | ------------- | -------- | --------- |
| source luma | source width x source height | `r16float` or sampled RGBA-to-luma | video frame input | pass 1 |
| `conv2d` | source width * 2 x source height * 2 | `rgba16float` preferred | pass 1 | pass 2 and pass 7 residual |
| `conv2d_1` | source width * 2 x source height * 2 | `rgba16float` preferred | pass 2 | pass 3 |
| `conv2d_2` | source width * 2 x source height * 2 | `rgba16float` preferred | pass 3 | pass 4 |
| `conv2d_3` | source width * 2 x source height * 2 | `rgba16float` preferred | pass 4 | pass 5 |
| `conv2d_4` | source width * 2 x source height * 2 | `rgba16float` preferred | pass 5 | pass 6 |
| `conv2d_5` | source width * 2 x source height * 2 | `rgba16float` preferred | pass 6 | pass 7 residual |
| `conv2d_6` | source width x source height | `rgba16float` preferred | pass 7 | pass 8 depth-to-space |
| output | source width * 2 x source height * 2 | current canvas/presenter format | pass 8 or composite pass | presentation |

Format notes:

- Use `rgba16float` for the CNN feature maps when available. The upstream C4F16 path uses `float16_t`, and feature maps can go below 0 before ReLU and in the linear passes.
- Do not use `rgba8unorm` for intermediate CNN features. It would clamp and quantize negative values.
- The first pass can either read a precomputed `r16float` luma texture or sample the source video texture and compute BT.709 luma in WGSL. A prepass is cleaner for parity, while inline luma avoids one texture allocation.
- The final output needs RGB reconstruction. The first faithful target should write luma to an `r16float` output, then combine it with upscaled source chroma or a neutral grayscale debug path in a separate presentation pass.

## WebGPU Route

WebGPU is the viable shader-native target.

Implementation shape:

1. Generate one WGSL compute entry point per upstream pass, keeping one dispatch boundary per pass.
2. Use `@workgroup_size(12, 16, 1)` to match mpv local invocation behavior.
3. Preserve the upstream tile load pattern with `var<workgroup>` arrays:
   - pass 1: one scalar luma plane with `(12 + 2) x (16 + 2)` halo
   - passes 2 through 7: four `vec4` planes with the same halo
4. Keep four-result packing for passes 1 through 6. Each invocation computes `result0` through `result3` and writes a 2x2 texel block.
5. Implement pass 7 as the residual add of `conv2d_5 + conv2d` at 2x sampling coordinates, then write one 4-channel texel at source resolution.
6. Implement pass 8 as depth-to-space from `conv2d_6.rgba` to a 2x luma image.
7. Add an explicit final composite/presentation pass that converts ArtCNN luma back to the extension's RGBA output.

Recommended first implementation location, once runtime code is in scope:

- `src/upscaler/modes/neural-lite/artcnn-c4f16-native.wgsl`
- `src/upscaler/modes/neural-lite/webgpu-artcnn-native-pipeline.ts`
- a small generated metadata module produced by the parser, so pass dimensions and texture names cannot drift from upstream

## WebGL2 Route

WebGL2 should not be the first shader-native lane for this upstream file.

Reasons:

- The upstream shader is compute-oriented and depends on `shared` memory, `barrier()`, `gl_WorkGroupID`, and storage image writes.
- WebGL2 has neither compute shaders nor storage textures.
- A fragment-shader rewrite is possible but would be a separate algorithmic port: ping-pong FBOs, one fragment per output texel, repeated 3x3 texture reads, no shared tile cache, and significantly more texture bandwidth.
- WebGL2 float renderability and filtering constraints make `rgba16f` intermediate support less uniform than the WebGPU path.

If a WebGL2 fallback is still required later, port only after the WebGPU version is numerically checked. Treat it as a fragment fallback generated from the same parsed weights, not as a direct translation of mpv compute.

## Exact Next Implementation Steps

1. Extend `scripts/artcnn-shader-port-report.mjs` to emit a stable JSON artifact with pass metadata and extracted constants grouped by pass/result/input tile.
2. Write a generator that converts the extracted constants into WGSL arrays or literal expressions for a single pass.
3. Port pass 1 only and render its `conv2d` output into an `rgba16float` storage texture. Validate dimensions, dispatch counts, border clamping, and Metal/Tint acceptance.
4. Add a CPU reference for pass 1 using the same extracted constants and compare a tiny synthetic luma image against the WGSL output.
5. Port passes 2 through 6 using the same generator and shared-memory tile loader.
6. Port pass 7 and verify the residual path uses `conv2d` plus `conv2d_5`, not only the immediately preceding texture.
7. Port pass 8 into an `r16float` luma output and validate the depth-to-space swizzle against the GLSL expression `i0.y * 2 + i0.x`.
8. Add the RGB presentation policy:
   - grayscale debug first for simple shader validation
   - then YUV/chroma-preserving reconstruction or source-color detail injection for product use
9. Gate the native path behind WebGPU feature checks for storage texture support and `shader-f16`. If `shader-f16` is missing, either use f32 WGSL constants or keep the ONNX path as fallback.
10. Benchmark against the current ONNX Runtime ArtCNN path before enabling any mode selection.

## Highest-Risk Findings

- The current source-side ArtCNN port metadata is likely stale for this upstream shader: inspected `ArtCNN_C4F16.glsl` has 8 passes, while the existing staged source metadata describes a much smaller chain.
- The final upstream output is luma-only, not final RGB. A visually acceptable extension mode needs an explicit RGB/chroma reconstruction policy.
- `rgba8unorm` cannot hold intermediate ArtCNN feature maps. Native porting requires float feature textures.
- WebGL2 is a rewrite, not a mechanical port, because the upstream code is compute shader code with workgroup memory.
- The mpv compute metadata's first pair is output block size and the second pair is local size. Using 24x32 as WebGPU `workgroup_size` would produce the wrong tile shape and likely exceed intended resource use.
