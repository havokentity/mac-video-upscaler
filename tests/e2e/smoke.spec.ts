import { expect, test, chromium, type BrowserContext } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

test('built extension mounts an overlay canvas on a local MP4 video', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Chrome extensions can only be loaded in Chromium.');

  expect(
    existsSync(path.join(extensionPath, 'manifest.json')),
    'Run `pnpm build` before `pnpm test:e2e`; this test loads the unpacked extension from dist.',
  ).toBe(true);

  const server = await startStaticServer(fixturesPath);
  let context: BrowserContext | undefined;

  try {
    const profileDir = path.join(tmpdir(), `mac-video-upscaler-e2e-${String(testInfo.workerIndex)}`);
    await mkdir(profileDir, { recursive: true });

    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

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
