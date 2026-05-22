#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultExtensionPath = path.join(repoRoot, 'dist');
const defaultFixturesPath = path.join(repoRoot, 'tests/fixtures');

export const BENCHMARK_MODES = ['auto', 'crisp', 'sharpen', 'anime', 'smooth'];
export const DEFAULT_BENCHMARK_OPTIONS = {
  durationMs: 2_000,
  extensionPath: defaultExtensionPath,
  fixturesPath: defaultFixturesPath,
  headless: true,
  modes: ['auto', 'crisp', 'sharpen', 'anime', 'smooth'],
  output: 'json',
  outputPath: undefined,
  scale: 1.5,
  sharpness: 0.2,
  strict: false,
};

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.mp4', 'video/mp4'],
]);

const defaultSettings = {
  enabled: true,
  mode: 'auto',
  scale: 1.5,
  fsrSharpness: 0.2,
  animeSubMode: 'mode-aa',
  ravuVariant: 'auto',
  frameGenerationEnabled: false,
  frameGenerationTargetFps: 60,
  hudEnabled: false,
  forceWebGL2: false,
  forceF32: false,
  workgroupSize: '8x8',
};

export const parseBenchmarkArgs = (argv = []) => {
  const options = { ...DEFAULT_BENCHMARK_OPTIONS, modes: [...DEFAULT_BENCHMARK_OPTIONS.modes] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${name} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (arg === '--duration-ms') {
      options.durationMs = Number(readValue(arg));
    } else if (arg === '--extension') {
      options.extensionPath = path.resolve(readValue(arg));
    } else if (arg === '--fixtures') {
      options.fixturesPath = path.resolve(readValue(arg));
    } else if (arg === '--headed') {
      options.headless = false;
    } else if (arg === '--mode') {
      options.modes = readValue(arg)
        .split(',')
        .map((mode) => mode.trim())
        .filter(Boolean);
    } else if (arg === '--output') {
      options.output = readValue(arg);
    } else if (arg === '--output-path') {
      options.outputPath = path.resolve(readValue(arg));
    } else if (arg === '--scale') {
      options.scale = Number(readValue(arg));
    } else if (arg === '--sharpness') {
      options.sharpness = Number(readValue(arg));
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  validateBenchmarkOptions(options);
  return options;
};

export const getBenchmarkUsage = () => `Usage:
  node scripts/collect-benchmark.mjs [options]

Options:
  --mode auto,crisp       Comma-separated modes to sample. Default: ${DEFAULT_BENCHMARK_OPTIONS.modes.join(',')}
  --duration-ms 3000      Frame sampling window per mode. Default: ${DEFAULT_BENCHMARK_OPTIONS.durationMs}
  --output json|markdown  Output format. Default: json
  --output-path <file>    Write output to a file instead of stdout
  --extension <dir>       Built extension directory. Default: dist
  --fixtures <dir>        Fixture directory. Default: tests/fixtures
  --scale 1.5             Extension scale setting. Default: 1.5
  --sharpness 0.2         FSR/CAS sharpness setting. Default: 0.2
  --headed                Launch Chromium with a visible window
  --strict                Exit nonzero instead of skipping when the browser/build is unavailable
  --help                  Show this message

Examples:
  pnpm build
  node scripts/collect-benchmark.mjs --mode crisp,smooth --duration-ms 5000
  node scripts/collect-benchmark.mjs --output markdown --output-path docs/benchmark-local.md
`;

export const createManualBenchmarkRows = () => [
  {
    chip: 'Apple Silicon chip used for manual run',
    browser: 'Chrome or Chromium version',
    source: '1080p -> 4K target',
    crispMs: 'TBD',
    sharpenMs: 'TBD',
    animeMs: 'TBD',
    smoothMs: 'TBD',
    neuralLiteMs: 'TBD',
    neuralProMs: 'TBD',
    notes: 'Replace with measured per-frame GPU time once HUD timestamp-query metrics land.',
  },
];

export const formatBenchmarkMarkdown = (result) => {
  const lines = [
    '# Benchmark Smoke Results',
    '',
    `Generated: ${result.generatedAt}`,
    `Status: ${result.skipped ? `skipped - ${result.reason}` : 'completed'}`,
    '',
    'This smoke helper measures extension load/render health on the local MP4 fixture. It is not a substitute for manual Apple Silicon GPU timing.',
    '',
    '## Smoke Samples',
    '',
    '| Mode | Backend/HUD | Source | Canvas | CSS Box | Video callbacks | Approx callback FPS |',
    '|---|---|---:|---:|---:|---:|---:|',
  ];

  for (const run of result.runs ?? []) {
    lines.push(
      [
        run.mode,
        run.hudText || 'n/a',
        `${run.sourceWidth}x${run.sourceHeight}`,
        `${run.canvasWidth}x${run.canvasHeight}`,
        `${run.cssWidth}x${run.cssHeight}`,
        String(run.videoFrameCallbacks),
        run.approxVideoCallbackFps.toFixed(1),
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'),
    );
  }

  lines.push(
    '',
    '## Manual Apple Silicon Benchmark Rows',
    '',
    '| Chip | Browser | Source | Crisp | Sharpen | Anime | Smooth | Neural-Lite | Neural-Pro | Notes |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---|',
  );

  for (const row of result.manualRows ?? createManualBenchmarkRows()) {
    lines.push(
      `| ${row.chip} | ${row.browser} | ${row.source} | ${row.crispMs} | ${row.sharpenMs} | ${row.animeMs} | ${row.smoothMs} | ${row.neuralLiteMs} | ${row.neuralProMs} | ${row.notes} |`,
    );
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
};

export const createSkippedBenchmarkResult = (reason, options = DEFAULT_BENCHMARK_OPTIONS) => ({
  generatedAt: new Date().toISOString(),
  manualRows: createManualBenchmarkRows(),
  options: publicOptions(options),
  reason,
  runs: [],
  skipped: true,
});

export const runBenchmarkSmoke = async (options = DEFAULT_BENCHMARK_OPTIONS) => {
  const manifestPath = path.join(options.extensionPath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return createSkippedBenchmarkResult(
      `Built extension not found at ${manifestPath}. Run pnpm build first.`,
      options,
    );
  }

  const fixturePage = path.join(options.fixturesPath, 'sample-video-page.html');
  const fixtureVideo = path.join(options.fixturesPath, 'sample-video.mp4');
  if (!existsSync(fixturePage) || !existsSync(fixtureVideo)) {
    return createSkippedBenchmarkResult(
      `Fixture page/video missing under ${options.fixturesPath}.`,
      options,
    );
  }

  let server;
  let context;
  try {
    server = await startStaticServer(options.fixturesPath);
    context = await createExtensionContext(options);
    const page = context.pages()[0] ?? (await context.newPage());
    const runs = [];

    for (const mode of options.modes) {
      await writeExtensionSettings(context, {
        ...defaultSettings,
        mode,
        scale: options.scale,
        fsrSharpness: options.sharpness,
      });
      runs.push(await collectModeSample(page, server.origin, mode, options.durationMs));
    }

    return {
      generatedAt: new Date().toISOString(),
      manualRows: createManualBenchmarkRows(),
      options: publicOptions(options),
      runs,
      skipped: false,
    };
  } catch (error) {
    return createSkippedBenchmarkResult(
      error instanceof Error ? error.message : 'Unknown benchmark smoke failure.',
      options,
    );
  } finally {
    if (context) {
      await context.close();
    }
    if (server) {
      await server.close();
    }
  }
};

const validateBenchmarkOptions = (options) => {
  if (!Number.isFinite(options.durationMs) || options.durationMs < 250) {
    throw new Error('--duration-ms must be a number >= 250.');
  }

  if (!Number.isFinite(options.scale) || options.scale < 1 || options.scale > 2) {
    throw new Error('--scale must be between 1 and 2.');
  }

  if (!Number.isFinite(options.sharpness) || options.sharpness < 0 || options.sharpness > 1) {
    throw new Error('--sharpness must be between 0 and 1.');
  }

  if (!['json', 'markdown'].includes(options.output)) {
    throw new Error('--output must be json or markdown.');
  }

  const invalidMode = options.modes.find((mode) => !BENCHMARK_MODES.includes(mode));
  if (invalidMode) {
    throw new Error(`Unsupported benchmark mode: ${invalidMode}.`);
  }
};

const publicOptions = (options) => ({
  durationMs: options.durationMs,
  extensionPath: options.extensionPath,
  fixturesPath: options.fixturesPath,
  headless: options.headless,
  modes: options.modes,
  output: options.output,
  scale: options.scale,
  sharpness: options.sharpness,
});

const startStaticServer = async (root) => {
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
      'cache-control': 'no-store',
      'content-type': contentTypes.get(path.extname(requestedPath)) ?? 'application/octet-stream',
    });
    createReadStream(requestedPath).pipe(response);
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Unable to bind local fixture server.');
  }

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    origin: `http://127.0.0.1:${address.port}`,
  };
};

const createExtensionContext = async (options) => {
  const profileDir = path.join(tmpdir(), `chrome-video-upscaler-benchmark-${Date.now().toString()}`);
  await mkdir(profileDir, { recursive: true });

  return chromium.launchPersistentContext(profileDir, {
    args: [
      `--disable-extensions-except=${options.extensionPath}`,
      `--load-extension=${options.extensionPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
    channel: 'chromium',
    headless: options.headless,
  });
};

const writeExtensionSettings = async (context, settings) => {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 10_000 }));

  await worker.evaluate((nextSettings) => {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.clear(() => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        chrome.storage.sync.set({ settings: nextSettings }, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });
    });
  }, settings);
};

const collectModeSample = async (page, origin, mode, durationMs) => {
  await page.goto(`${origin}?mode=${mode}&t=${Date.now().toString()}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('#sample-video').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(() => {
    const video = document.querySelector('#sample-video');
    return video instanceof HTMLVideoElement && video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA;
  });
  await page.locator('.chrome-video-upscaler-overlay').waitFor({ state: 'attached', timeout: 10_000 });
  await page.keyboard.press('Control+Shift+U');
  await page.locator('.chrome-video-upscaler-hud').waitFor({ state: 'attached', timeout: 5_000 });

  return page.evaluate(
    async ({ sampleDurationMs, sampleMode }) => {
      const video = document.querySelector('#sample-video');
      const overlay = document.querySelector('.chrome-video-upscaler-overlay');
      const hud = document.querySelector('.chrome-video-upscaler-hud');
      if (!(video instanceof HTMLVideoElement) || !(overlay instanceof HTMLCanvasElement)) {
        throw new Error('Benchmark fixture did not expose a video and overlay canvas.');
      }

      let videoFrameCallbacks = 0;
      let animationFrames = 0;
      const startedAt = performance.now();
      let animationFrameId = 0;
      let videoFrameCallbackId = 0;

      await new Promise((resolve) => {
        const stopAt = startedAt + sampleDurationMs;
        const tickAnimation = () => {
          animationFrames += 1;
          if (performance.now() < stopAt) {
            animationFrameId = requestAnimationFrame(tickAnimation);
          }
        };

        const tickVideo = () => {
          videoFrameCallbacks += 1;
          if (performance.now() < stopAt && 'requestVideoFrameCallback' in video) {
            videoFrameCallbackId = video.requestVideoFrameCallback(tickVideo);
          }
        };

        animationFrameId = requestAnimationFrame(tickAnimation);
        if ('requestVideoFrameCallback' in video) {
          videoFrameCallbackId = video.requestVideoFrameCallback(tickVideo);
        }
        window.setTimeout(resolve, sampleDurationMs);
      });

      cancelAnimationFrame(animationFrameId);
      if ('cancelVideoFrameCallback' in video && videoFrameCallbackId) {
        video.cancelVideoFrameCallback(videoFrameCallbackId);
      }

      const elapsedMs = performance.now() - startedAt;
      const rect = overlay.getBoundingClientRect();
      return {
        animationFrames,
        approxAnimationFps: (animationFrames / elapsedMs) * 1000,
        approxVideoCallbackFps: (videoFrameCallbacks / elapsedMs) * 1000,
        canvasHeight: overlay.height,
        canvasWidth: overlay.width,
        cssHeight: Math.round(rect.height),
        cssWidth: Math.round(rect.width),
        elapsedMs,
        hudText: hud?.textContent ?? '',
        mode: sampleMode,
        sourceHeight: video.videoHeight,
        sourceWidth: video.videoWidth,
        videoFrameCallbacks,
      };
    },
    { sampleDurationMs: durationMs, sampleMode: mode },
  );
};

const main = async () => {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(getBenchmarkUsage());
    return;
  }

  const result = await runBenchmarkSmoke(options);
  const output =
    options.output === 'markdown'
      ? formatBenchmarkMarkdown(result)
      : `${JSON.stringify(result, null, 2)}\n`;

  if (options.outputPath) {
    const { writeFile } = await import('node:fs/promises');
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, output);
  } else {
    process.stdout.write(output);
  }

  if (result.skipped && options.strict) {
    process.exitCode = 1;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
