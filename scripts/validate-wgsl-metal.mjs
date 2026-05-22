import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = join(root, 'src');

const collectWgsl = async (directory) => {
  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectWgsl(path);
      }

      return entry.isFile() && entry.name.endsWith('.wgsl') ? [path] : [];
    }),
  );

  return nested.flat();
};

const wgslFiles = await collectWgsl(sourceRoot);

if (wgslFiles.length === 0) {
  console.log('No WGSL files found yet; skipping Tint MSL validation.');
  process.exit(0);
}

const tintProbe = spawnSync('tint', ['--help'], { stdio: 'ignore' });
if (tintProbe.error?.code === 'ENOENT') {
  console.error('Tint CLI is required once WGSL shaders are present.');
  process.exit(1);
}

for (const file of wgslFiles) {
  execFileSync('tint', ['--format=msl', '--output-name=-', file], { stdio: 'ignore' });
}

console.log(`Tint validated ${wgslFiles.length} WGSL shader(s) to MSL.`);
