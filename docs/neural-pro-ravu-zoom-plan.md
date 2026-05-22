# Neural-Pro RAVU-Zoom Plan

## Decision

Do not import `ravu-zoom-ar-r3.hook` in this slice. The pinned upstream file is
usable, but the payload is too large for a bounded production patch inside the
current neural-pro ownership lane.

## Upstream Source

- Repository: `https://github.com/bjin/mpv-prescalers`
- Commit: `b3f0a59d68f33b7162051ea5970a5169558f0ea2`
- File: `ravu-zoom-ar-r3.hook`
- License: `LGPL-3.0-or-later`
- Local target: `src/upscaler/modes/neural-pro/ravu-zoom-ar-r3.hook`

The upstream file keeps the same LGPL header style as the imported
`ravu-lite-ar-r3.hook`, so import must preserve that header verbatim and update
NOTICE from "planned" to "imported" once the file lands.

## Measured Payload

Fetched from the pinned raw URL on 2026-05-23:

- Hook file size: `5,236,658` bytes
- Shader passes: one pass, `RAVU-Zoom-AR (luma, r3)`
- LUT textures:
  - `ravu_zoom_lut3`, `45 x 2592`, `rgba16f`, `LINEAR`
  - `ravu_zoom_lut3_ar`, `18 x 2592`, `rgba16f`, `LINEAR`
- Total fp32 values after unpacking the hex payloads:
  - `45 * 2592 * 4 = 466,560`
  - `18 * 2592 * 4 = 186,624`
  - combined `653,184`

For comparison, the current RAVU-Lite import is about `127,810` bytes and
contains one `13 x 288` LUT.

## Why This Is Not a Small Safe Import

The existing WebGL2 Neural-Pro factory is synchronous and statically imports the
Lite hook through Vite's `?raw` loader. A direct Zoom import would likely add the
full 5.2 MB hook string to the content-script bundle even when the user keeps
the default RAVU-Lite/Auto settings.

A safer opt-in implementation should lazy-load the Zoom hook only when
`ravuVariant === 'zoom'`. That requires making the WebGL2 Neural-Pro factory
async or adding an async preload path in the shared upscaler pipeline. That
change touches `src/upscaler/pipeline.ts`, which is outside this task's write
scope and is also currently modified by another agent in this worktree.

## Implementation Plan

1. Add the upstream hook exactly:
   `src/upscaler/modes/neural-pro/ravu-zoom-ar-r3.hook`.
2. Add `src/upscaler/modes/neural-pro/ravu-zoom-source.ts` with:
   - raw hook import,
   - `RAVU_ZOOM_LUT3_WIDTH = 45`,
   - `RAVU_ZOOM_LUT3_AR_WIDTH = 18`,
   - `RAVU_ZOOM_LUT_HEIGHT = 2592`,
   - parser support for two named `//!TEXTURE` blocks,
   - validation that both LUT payload lengths match their declared sizes.
3. Generalize the WebGL2 pipeline internals without changing Lite behavior:
   - keep the existing two-pass Lite path as-is,
   - add a one-pass Zoom path that renders to the requested output size,
   - bind `ravu_zoom_lut3` and `ravu_zoom_lut3_ar` with `LINEAR` filtering,
   - define `HOOKED_pos` from `gl_FragCoord.xy / u_output_size`,
   - define `HOOKED_size` and `HOOKED_pt` from the source video size.
4. Make Zoom lazy-loaded before production enablement:
   - prefer `await import('./ravu-zoom-source')` only for explicit Zoom,
   - update the shared pipeline factory to await the WebGL2 Neural-Pro factory,
   - keep Auto mapped to Lite until Zoom performance is measured.
5. Update attribution:
   - change Zoom import status to `imported-with-lgpl-header`,
   - update `RAVU_ATTRIBUTION_TODO`,
   - update NOTICE to list `src/upscaler/modes/neural-pro/ravu-zoom-ar-r3.hook`.
6. Add focused tests:
   - parser test for one Zoom pass and two LUT payloads,
   - status test that explicit `zoom` reports variant `zoom`,
   - regression test that `auto` and `lite` still report/use Lite.
7. Run:
   - `pnpm exec vitest run tests/neural-pro-attribution.test.ts`
   - `pnpm typecheck`
   - `pnpm build`
   - a manual Chrome/WebGL2 smoke pass with explicit RAVU-Zoom selected.

## Performance Gate

Before making Zoom selectable by Auto, collect frame timing on at least:

- 720p to 1440p at 2x
- 1080p to 4K at 2x
- paused-frame visual diff against native and Lite

If the 5.2 MB hook still bloats the main content bundle after lazy-loading,
split the hook payload into an extension web-accessible asset and fetch it only
for explicit Zoom.
