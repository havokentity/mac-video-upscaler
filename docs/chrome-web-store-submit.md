# Chrome Web Store Submission Checklist

This checklist is for publishing **Chrome Video Upscaler** `0.1.0` to the Chrome Web Store. Final submission requires access to Rajesh's Chrome Web Store Developer Dashboard account; Codex can prepare the package and copy, but cannot complete account verification, payment, identity, or final publish clicks without that dashboard access.

Official references:

- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish/)
- [Prepare your extension](https://developer.chrome.com/docs/webstore/prepare/)
- [Complete your listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Set up distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)

## 1. Preflight

Run from the repository root:

```sh
corepack enable pnpm
pnpm install
pnpm verify
pnpm test:e2e
pnpm package:store
```

Expected upload file:

```text
chrome-video-upscaler-v0.1.0.zip
```

Record before upload:

- Commit SHA:
- Local tree clean:
- Chrome Stable version used for manual testing:
- Zip SHA256 from `pnpm package:store`:
- Zip root contains `manifest.json`:
- Zip contains no `.map` files:
- Store listing draft reviewed from `docs/store-listing.md`:
- Release notes draft reviewed from `docs/release-notes-v0.1.0.md`:

Useful inspection commands:

```sh
unzip -l chrome-video-upscaler-v0.1.0.zip | sed -n '1,80p'
unzip -l chrome-video-upscaler-v0.1.0.zip | rg '\.map$' || true
unzip -p chrome-video-upscaler-v0.1.0.zip manifest.json
```

## 2. Developer Account

1. Open the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Sign in as the Google account that should own the extension.
3. Complete the developer account setup, including any required registration fee, contact details, identity, and email verification.
4. Confirm the account profile and support email are correct before submission.
5. Keep dashboard access limited to trusted humans. Do not add automation accounts or AI tooling as collaborators.

## 3. Create Item

1. Click **Add new item**.
2. Upload `chrome-video-upscaler-v0.1.0.zip`.
3. Confirm the dashboard accepts the package and reads:
   - Name: `Chrome Video Upscaler`
   - Version: `0.1.0`
   - Manifest version: `3`
   - Minimum Chrome version: `121`
4. If the dashboard reports manifest metadata problems, fix `manifest.json`, bump the version if needed, rebuild with `pnpm package:store`, and upload again.

Chrome does not let every manifest metadata field be edited in the dashboard after upload, so treat `manifest.json` as the source of truth.

## 4. Store Listing

Use `docs/store-listing.md` as the copy source.

Suggested fields:

- Name: `Chrome Video Upscaler`
- Short description: `GPU upscaling and sharpening for HTML5 video in Chrome, with local WebGPU/WebGL2 processing and no telemetry.`
- Category: `Productivity`
- Language: English
- Website/support URL: `https://github.com/havokentity/chrome-video-upscaler`
- Support/issues URL: `https://github.com/havokentity/chrome-video-upscaler/issues`

Upload screenshots from `docs/screenshot-capture.md`:

- Popup/options controls with product branding.
- HTML5 video with HUD visible on a non-DRM page.
- Before/after or side-by-side quality comparison on a permitted video.
- Site allow/block or known-limit behavior.

Avoid screenshots or claims involving Netflix, Disney+, HBO Max, Prime Video, or other DRM/EME services.

## 5. Privacy Practices

Single purpose:

```text
The extension locally upscales and filters HTML5 video frames in Chrome using WebGPU or WebGL2.
```

Data collection:

```text
Chrome Video Upscaler does not collect, sell, transmit, or share personal data. Video frames are processed locally in the browser/GPU. No video frames, page contents, URLs, browsing history, settings, or diagnostics are sent to the developer or to a third-party service.
```

Storage disclosure:

```text
The extension uses chrome.storage to save user preferences such as the master enabled toggle, selected mode, scale, sharpness, HUD visibility, developer toggles, and per-site allow/block settings.
```

Remote code:

```text
No remote JavaScript, remote WebAssembly, CDN runtime code, telemetry code, or remote model files are loaded by the release package. ONNX Runtime sidecar files and the ArtCNN model are packaged with the extension and loaded from extension URLs.
```

If the dashboard asks for a privacy policy URL, use a public repository page that states the same privacy/data-use language. The dashboard disclosures and privacy policy must agree.

## 6. Permissions Justification

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

Review risk to watch: broad host permissions are justified by generic HTML5 video support, but they can still draw review scrutiny. Keep the listing, privacy text, and screenshots focused on the single purpose.

## 7. Distribution

For the first public submission:

1. Select target regions.
2. Choose visibility:
   - **Public** for a real launch.
   - **Unlisted** if Rajesh wants a quieter first review/install link.
3. Do not mark it as a beta/test item unless the package name and description are clearly labeled according to Chrome's beta/testing guidance.
4. Confirm there are no in-app purchases.

## 8. Submit For Review

Before pressing submit:

- Confirm `pnpm verify`, `pnpm test:e2e`, and `pnpm package:store` passed on the submitted commit.
- Confirm manual Chrome Stable testing covered at least one local fixture and one real non-DRM HTML5 video page.
- Confirm screenshots do not overclaim quality, DRM support, RTX VSR parity, optical-flow frame generation, or OS-wide/native driver integration.
- Confirm `NOTICE`, `LICENSE`, and `LICENSES/` are current for MIT/LGPL/upstream components.
- Confirm the public source repository is available.

After submitting:

- Record the submission date/time.
- Save any dashboard warning text.
- Watch review status in the dashboard.
- If Chrome rejects or asks for clarification, update the relevant doc/copy/manifest, bump version if a new package is required, rebuild, and resubmit.

## 9. Rollout

Suggested first release rollout:

1. Start with a public GitHub release and an unpacked-extension install path for testers.
2. Submit Chrome Web Store item as public or unlisted.
3. After approval, share the store link with a small test group first.
4. Monitor GitHub issues for site-specific regressions, permissions confusion, performance problems, and neural-mode slowdowns.
5. Only broaden announcement once install/update behavior looks stable.

## 10. Updates

For every update:

1. Make code/docs changes.
2. Bump `package.json` and `manifest.json` to a version greater than the currently published store version.
3. Run:

```sh
pnpm verify
pnpm test:e2e
pnpm package:store
```

4. Update release notes.
5. Upload the new `chrome-video-upscaler-v<version>.zip` to the existing dashboard item.
6. Re-review changed permissions, host permissions, CSP, web-accessible resources, privacy disclosures, screenshots, and known limits.
7. Submit the update for review.

If a submitted update has a mistake before approval, use the dashboard's cancel-review flow if available, then upload the corrected package and submit again.

## 11. GitHub Release Pairing

The Chrome Web Store submission should pair with a GitHub release so reviewers and users can inspect source and licenses.

Suggested GitHub flow after final local verification:

```sh
git status --short
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 \
  chrome-video-upscaler-v0.1.0.zip \
  --repo havokentity/chrome-video-upscaler \
  --title "Chrome Video Upscaler v0.1.0" \
  --notes-file docs/release-notes-v0.1.0.md \
  --draft
```

Keep the GitHub release as a draft until Rajesh confirms the uploaded zip, release notes, screenshots, and store submission state.
