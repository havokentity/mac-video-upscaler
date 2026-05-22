import { expect, test, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_SETTINGS, type UpscalerSettings } from '../../src/common/modes';
import type { SiteRulesState } from '../../src/common/site-rules';
import type { UpscalerMode } from '../../src/common/modes';

interface StaticServer {
  readonly origin: string;
  close(): Promise<void>;
}

const repoRoot = path.resolve(import.meta.dirname, '../..');
const extensionPath = path.join(repoRoot, 'dist');
const fixturesPath = path.join(repoRoot, 'tests/fixtures');

const contentTypes = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.mp4', 'video/mp4'],
]);

const startStaticServer = async (root: string): Promise<StaticServer> => {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = requestUrl.pathname === '/' ? '/sample-video-page.html' : requestUrl.pathname;
    const requestedPath = path.resolve(root, `.${decodeURIComponent(pathname)}`);

    if (!requestedPath.startsWith(`${root}${path.sep}`) || !existsSync(requestedPath)) {
      response.writeHead(404).end('Not found');
      return;
    }

    if (!statSync(requestedPath).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }

    response.writeHead(200, {
      'content-type': contentTypes.get(path.extname(requestedPath)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(requestedPath).pipe(response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Unable to bind local fixture server.');
  }

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
};

const closeContext = async (context: BrowserContext | undefined): Promise<void> => {
  if (context) {
    await context.close();
  }
};

const createExtensionContext = async (workerIndex: number): Promise<BrowserContext> => {
  const profileDir = await mkdtemp(
    path.join(tmpdir(), `mac-video-upscaler-e2e-${String(workerIndex)}-`),
  );

  return chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-sync',
    ],
  });
};

const writeExtensionSettings = async (
  context: BrowserContext,
  settings: UpscalerSettings,
  siteRules?: SiteRulesState,
): Promise<void> => {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 10_000 }));

  await worker.evaluate(({ nextSettings, nextSiteRules }) => {
    return new Promise<void>((resolve, reject) => {
      chrome.storage.sync.clear(() => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        const items: Record<string, unknown> =
          nextSiteRules === undefined
            ? { settings: nextSettings }
            : { settings: nextSettings, siteRules: nextSiteRules };
        chrome.storage.sync.set(items, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          resolve();
        });
      });
    });
  }, { nextSettings: settings, nextSiteRules: siteRules });

  await expect
    .poll(
      () =>
        worker.evaluate(({ expectsSiteRules, nextSettings, nextSiteRules }) => {
          return new Promise<string | undefined>((resolve, reject) => {
            const items: Record<string, unknown> =
              nextSiteRules === undefined
                ? { settings: nextSettings }
                : { settings: nextSettings, siteRules: nextSiteRules };
            chrome.storage.sync.set(items, () => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }

              chrome.storage.sync.get(['settings', 'siteRules'], (result) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                  return;
                }

                resolve(
                  !expectsSiteRules || (result.siteRules && typeof result.siteRules === 'object')
                    ? (result.settings as Partial<UpscalerSettings> | undefined)?.mode
                    : undefined,
                );
              });
            });
          });
        }, { expectsSiteRules: siteRules !== undefined, nextSettings: settings, nextSiteRules: siteRules }),
      { timeout: 10_000 },
    )
    .toBe(settings.mode);
};

test('built extension mounts an overlay canvas on a local MP4 video', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Chrome extensions can only be loaded in Chromium.');

  expect(
    existsSync(path.join(extensionPath, 'manifest.json')),
    'Run `pnpm build` before `pnpm test:e2e`; this test loads the unpacked extension from dist.',
  ).toBe(true);

  const server = await startStaticServer(fixturesPath);
  let context: BrowserContext | undefined;

  try {
    context = await createExtensionContext(testInfo.workerIndex);

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(server.origin, { waitUntil: 'domcontentloaded' });

    const video = page.locator('#sample-video');
    await expect(video).toBeVisible();
    await expect(video).toHaveJSProperty('readyState', 4, { timeout: 10_000 });

    const overlay = page.locator('.mac-video-upscaler-overlay');
    await expect(overlay).toHaveCount(1, { timeout: 10_000 });

    const dimensions = await overlay.evaluate((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return {
        cssWidth: rect.width,
        cssHeight: rect.height,
        canvasWidth: (canvas as HTMLCanvasElement).width,
        canvasHeight: (canvas as HTMLCanvasElement).height,
      };
    });

    expect(dimensions.cssWidth).toBeGreaterThan(0);
    expect(dimensions.cssHeight).toBeGreaterThan(0);
    expect(dimensions.canvasWidth).toBeGreaterThan(0);
    expect(dimensions.canvasHeight).toBeGreaterThan(0);

    await page.keyboard.press('Control+Shift+U');
    const hud = page.locator('.mac-video-upscaler-hud');
    await expect(hud).toHaveCount(1);
  } finally {
    await closeContext(context);
    await server.close();
  }
});

test('Crisp mode uses the WebGL2 1.5x upscaler on a local MP4 video', async ({
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Chrome extensions can only be loaded in Chromium.');

  expect(
    existsSync(path.join(extensionPath, 'manifest.json')),
    'Run `pnpm build` before `pnpm test:e2e`; this test loads the unpacked extension from dist.',
  ).toBe(true);

  const server = await startStaticServer(fixturesPath);
  let context: BrowserContext | undefined;

  try {
    context = await createExtensionContext(testInfo.workerIndex + 100);
    await writeExtensionSettings(context, {
      ...DEFAULT_SETTINGS,
      mode: 'crisp',
      fsrSharpness: 0.65,
      forceWebGL2: true,
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(server.origin, { waitUntil: 'domcontentloaded' });

    const overlay = page.locator('.mac-video-upscaler-overlay');
    await expect(overlay).toHaveCount(1, { timeout: 10_000 });

    await page.keyboard.press('Control+Shift+U');
    await expect(page.locator('.mac-video-upscaler-hud')).toContainText('webgl2 crisp');
    await expect(page.locator('#sample-video')).toHaveCSS('opacity', '0', { timeout: 10_000 });

    const dimensions = await overlay.evaluate((canvas) => {
      const rect = canvas.getBoundingClientRect();
      const video = document.querySelector<HTMLVideoElement>('#sample-video');
      return {
        cssWidth: rect.width,
        cssHeight: rect.height,
        canvasWidth: (canvas as HTMLCanvasElement).width,
        canvasHeight: (canvas as HTMLCanvasElement).height,
        sourceWidth: video?.videoWidth ?? 0,
        sourceHeight: video?.videoHeight ?? 0,
      };
    });

    expect(dimensions.cssWidth).toBe(320);
    expect(dimensions.cssHeight).toBe(180);
    expect(dimensions.canvasWidth).toBe(
      Math.max(dimensions.cssWidth, Math.round(dimensions.sourceWidth * 1.5)),
    );
    expect(dimensions.canvasHeight).toBe(
      Math.max(dimensions.cssHeight, Math.round(dimensions.sourceHeight * 1.5)),
    );
  } finally {
    await closeContext(context);
    await server.close();
  }
});

test('Crisp sharpness changes the rendered WebGL2 output', async ({
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Chrome extensions can only be loaded in Chromium.');

  expect(
    existsSync(path.join(extensionPath, 'manifest.json')),
    'Run `pnpm build` before `pnpm test:e2e`; this test loads the unpacked extension from dist.',
  ).toBe(true);

  const server = await startStaticServer(fixturesPath);
  let context: BrowserContext | undefined;

  const sampleOverlay = async (page: Page) =>
    page.locator('.mac-video-upscaler-overlay').evaluate((canvas) => {
      const source = canvas as HTMLCanvasElement;
      const sampler = document.createElement('canvas');
      sampler.width = 24;
      sampler.height = 24;
      const context2d = sampler.getContext('2d', { willReadFrequently: true });
      if (!context2d) {
        throw new Error('2D sampler unavailable.');
      }

      context2d.drawImage(source, 0, 0, sampler.width, sampler.height);
      const data = context2d.getImageData(0, 0, sampler.width, sampler.height).data;
      const sample: number[] = [];
      for (let index = 0; index < data.length; index += 4) {
        sample.push(data[index], data[index + 1], data[index + 2]);
      }
      return sample;
    });
  const sampleDelta = (left: readonly number[], right: readonly number[]): number => {
    let delta = 0;
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      delta += Math.abs(left[index] - right[index]);
    }
    return delta / Math.max(1, Math.min(left.length, right.length));
  };
  const nudgeVideoFrame = async (page: Page): Promise<void> => {
    await page.locator('#sample-video').evaluate((element) => {
      const video = element as HTMLVideoElement;
      video.currentTime = 0.05;
      void video.play();
    });
  };

  try {
    context = await createExtensionContext(testInfo.workerIndex + 125);
    await writeExtensionSettings(context, {
      ...DEFAULT_SETTINGS,
      forceWebGL2: true,
      fsrSharpness: 0,
      hudEnabled: true,
      mode: 'crisp',
      scale: 2,
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.mac-video-upscaler-overlay')).toHaveCount(1, { timeout: 10_000 });
    await nudgeVideoFrame(page);
    await expect(page.locator('#sample-video')).toHaveCSS('opacity', '0', { timeout: 10_000 });
    await expect(page.locator('.mac-video-upscaler-hud')).toContainText('0');
    const softSample = await sampleOverlay(page);

    await writeExtensionSettings(context, {
      ...DEFAULT_SETTINGS,
      forceWebGL2: true,
      fsrSharpness: 1,
      hudEnabled: true,
      mode: 'crisp',
      scale: 2,
    });
    await expect(page.locator('.mac-video-upscaler-overlay')).toHaveCount(1, { timeout: 10_000 });
    await nudgeVideoFrame(page);
    await expect(page.locator('#sample-video')).toHaveCSS('opacity', '0', { timeout: 10_000 });
    await expect(page.locator('.mac-video-upscaler-hud')).toContainText('1.00', {
      timeout: 10_000,
    });
    await expect
      .poll(async () => sampleDelta(await sampleOverlay(page), softSample), { timeout: 10_000 })
      .toBeGreaterThan(0.5);
  } finally {
    await closeContext(context);
    await server.close();
  }
});

test('enabled setting rebuilds the active overlay without a page refresh', async ({
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Chrome extensions can only be loaded in Chromium.');

  expect(
    existsSync(path.join(extensionPath, 'manifest.json')),
    'Run `pnpm build` before `pnpm test:e2e`; this test loads the unpacked extension from dist.',
  ).toBe(true);

  const server = await startStaticServer(fixturesPath);
  let context: BrowserContext | undefined;

  try {
    context = await createExtensionContext(testInfo.workerIndex + 175);
    await writeExtensionSettings(context, {
      ...DEFAULT_SETTINGS,
      forceWebGL2: true,
      mode: 'crisp',
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.mac-video-upscaler-overlay')).toHaveCount(1, { timeout: 10_000 });
    await page.keyboard.press('Control+Shift+U');
    await expect(page.locator('.mac-video-upscaler-hud')).toContainText('webgl2 crisp');
    await expect(page.locator('#sample-video')).toHaveCSS('opacity', '0', { timeout: 10_000 });

    await writeExtensionSettings(context, {
      ...DEFAULT_SETTINGS,
      enabled: false,
      forceWebGL2: true,
      hudEnabled: true,
      mode: 'crisp',
    });

    const rebuiltHud = page.locator('.mac-video-upscaler-hud').last();
    await expect(rebuiltHud).toContainText('disabled', {
      timeout: 10_000,
    });
    await expect(rebuiltHud).toContainText('Extension disabled');
    await expect(page.locator('#sample-video')).toHaveCSS('opacity', '1', { timeout: 10_000 });
  } finally {
    await closeContext(context);
    await server.close();
  }
});

test('frame generation setting shows its target in the HUD', async ({
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Chrome extensions can only be loaded in Chromium.');

  expect(
    existsSync(path.join(extensionPath, 'manifest.json')),
    'Run `pnpm build` before `pnpm test:e2e`; this test loads the unpacked extension from dist.',
  ).toBe(true);

  const server = await startStaticServer(fixturesPath);
  let context: BrowserContext | undefined;

  try {
    context = await createExtensionContext(testInfo.workerIndex + 190);
    await writeExtensionSettings(context, {
      ...DEFAULT_SETTINGS,
      forceWebGL2: true,
      frameGenerationEnabled: true,
      frameGenerationTargetFps: 60,
      mode: 'crisp',
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(server.origin, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.mac-video-upscaler-overlay')).toHaveCount(1, { timeout: 10_000 });
    await page.keyboard.press('Control+Shift+U');
    await expect(page.locator('.mac-video-upscaler-hud')).toContainText('target 60 fps', {
      timeout: 10_000,
    });
  } finally {
    await closeContext(context);
    await server.close();
  }
});

test('site block list disables the overlay pipeline without hiding the video', async ({
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Chrome extensions can only be loaded in Chromium.');

  expect(
    existsSync(path.join(extensionPath, 'manifest.json')),
    'Run `pnpm build` before `pnpm test:e2e`; this test loads the unpacked extension from dist.',
  ).toBe(true);

  const server = await startStaticServer(fixturesPath);
  let context: BrowserContext | undefined;

  try {
    context = await createExtensionContext(testInfo.workerIndex + 150);
    await writeExtensionSettings(
      context,
      {
        ...DEFAULT_SETTINGS,
        mode: 'crisp',
      },
      {
        allowList: [],
        blockList: ['127.0.0.1'],
        rules: [],
      },
    );

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(server.origin, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.mac-video-upscaler-overlay')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('#sample-video')).toHaveCSS('opacity', '1');

    await page.keyboard.press('Control+Shift+U');
    await expect(page.locator('.mac-video-upscaler-hud')).toContainText('disabled');
    await expect(page.locator('.mac-video-upscaler-hud')).toContainText('Site blocked by 127.0.0.1');
  } finally {
    await closeContext(context);
    await server.close();
  }
});

const routedModeCases: Array<{
  readonly mode: UpscalerMode;
  readonly expectedHudText: string;
  readonly expectedVideoOpacity?: string;
  readonly settings?: Partial<UpscalerSettings>;
}> = [
  { mode: 'none', expectedHudText: 'disabled none', expectedVideoOpacity: '1' },
  { mode: 'sharpen', expectedHudText: 'sharpen' },
  { mode: 'anime', expectedHudText: 'anime', settings: { animeSubMode: 'mode-a' } },
  { mode: 'smooth', expectedHudText: 'smooth' },
  { mode: 'edge', expectedHudText: 'edge' },
  { mode: 'night-vision', expectedHudText: 'night-vision' },
  { mode: 'predator', expectedHudText: 'predator' },
  { mode: 'crt', expectedHudText: 'crt' },
  { mode: 'invert', expectedHudText: 'invert' },
  { mode: 'cartoon', expectedHudText: 'cartoon' },
  { mode: 'neural-lite', expectedHudText: 'neural-lite' },
  { mode: 'neural-pro', expectedHudText: 'neural-pro' },
];

for (const { mode, expectedHudText, expectedVideoOpacity, settings } of routedModeCases) {
  test(`${mode} mode reaches its routed pipeline status`, async ({ browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Chrome extensions can only be loaded in Chromium.');

    expect(
      existsSync(path.join(extensionPath, 'manifest.json')),
      'Run `pnpm build` before `pnpm test:e2e`; this test loads the unpacked extension from dist.',
    ).toBe(true);

    const server = await startStaticServer(fixturesPath);
    let context: BrowserContext | undefined;

    try {
      context = await createExtensionContext(testInfo.workerIndex + 200 + routedModeCases.findIndex((item) => item.mode === mode));
      await writeExtensionSettings(context, {
        ...DEFAULT_SETTINGS,
        ...settings,
        mode,
      });

      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(server.origin, { waitUntil: 'domcontentloaded' });

      await expect(page.locator('.mac-video-upscaler-overlay')).toHaveCount(1, { timeout: 10_000 });
      await page.keyboard.press('Control+Shift+U');
      await expect(page.locator('.mac-video-upscaler-hud')).toContainText(expectedHudText, {
        timeout: 10_000,
      });
      if (expectedVideoOpacity !== undefined) {
        await expect(page.locator('#sample-video')).toHaveCSS('opacity', expectedVideoOpacity);
      }
    } finally {
      await closeContext(context);
      await server.close();
    }
  });
}
