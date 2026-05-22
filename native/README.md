# Native Upscale Bench

This folder contains a macOS-native offline benchmark for the upscaler work. It is intentionally separate from the Chrome extension so we can judge the algorithm without YouTube, DOM overlays, browser canvas presentation, or compositor scaling in the way.

The first tool is a Swift command-line app using AVFoundation decode/encode and a Metal-backed Core Image context.

## Build

```sh
cd native
swift build -c release
```

## Upscale A Video

```sh
swift run -c release mac-video-upscaler-native \
  --input /path/to/original.mp4 \
  --output /path/to/upscaled.mp4 \
  --mode crisp \
  --scale 2 \
  --sharpness 1
```

Modes:

- `crisp`: Lanczos scale plus aggressive local sharpening/detail rescue.
- `smooth`: Lanczos scale only.
- `sharpen`: Resize to the requested output and apply luminance/unsharp sharpening.

The native bench is video-only for now. Audio passthrough can come later once the visual algorithm is worth keeping.

## Side-By-Side Compare

Open `native/compare.html` in a browser, choose the original file on the left and the native output on the right, then play/scrub them together.

You can also drop two video files onto the page: first file becomes Original, second file becomes Native Upscaled.
