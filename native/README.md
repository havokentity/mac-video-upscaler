# Native Upscale Bench

This folder contains a macOS-native offline benchmark for the upscaler work. It is intentionally separate from the Chrome extension so we can judge the algorithm without YouTube, DOM overlays, browser canvas presentation, or compositor scaling in the way.

The first tool is a Swift command-line app using AVFoundation decode/encode and a Metal compute implementation of the FSR-style `crisp` path. The previous Core Image enhancement path remains available as `rescue` for comparison.

## Build

```sh
cd native
swift build -c release
```

## Upscale A Video

```sh
swift run -c release chrome-video-upscaler-native \
  --input /path/to/original.mp4 \
  --output /path/to/upscaled.mp4 \
  --mode crisp \
  --scale 2 \
  --sharpness 1 \
  --open-compare
```

Modes:

- `crisp`: Metal compute EASU-style reconstruction plus RCAS/detail pass.
- `rescue`: Lanczos scale plus aggressive local sharpening/detail rescue.
- `smooth`: Lanczos scale only.
- `sharpen`: Resize to the requested output and apply luminance/unsharp sharpening.

The native bench is video-only for now. Audio passthrough can come later once the visual algorithm is worth keeping.

## Side-By-Side Compare

After each run the CLI writes:

- `native/last-run.json`
- `native/last-compare.html`

Use `--open-compare` to open `last-compare.html` automatically.

You can also open `native/compare.html` in a browser and choose files manually, or pass file URLs as query params:

```text
native/compare.html?left=file:///path/to/original.mp4&right=file:///path/to/upscaled.mp4
```

You can also drop two video files onto the page: first file becomes Original, second file becomes Native Upscaled.
