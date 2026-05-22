#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const DEFAULT_SOURCE = '/tmp/ArtCNN/GLSL/ArtCNN_C4F16.glsl';

const usage = `Usage: node scripts/artcnn-shader-port-report.mjs [source.glsl] [--json]

Parses ArtCNN mpv GLSL hook metadata and emits a compact porting report.
Default source: ${DEFAULT_SOURCE}
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(usage);
  process.exit(0);
}

const json = args.includes('--json');
const sourceArg = args.find((arg) => !arg.startsWith('-')) ?? DEFAULT_SOURCE;
const sourcePath = resolve(sourceArg);

if (!existsSync(sourcePath)) {
  process.stderr.write(
    `ArtCNN GLSL source not found: ${sourcePath}\n` +
      `Fetch upstream ArtCNN first, for example: git clone https://github.com/Artoriuz/ArtCNN.git /tmp/ArtCNN\n`,
  );
  process.exit(1);
}

const source = readFileSync(sourcePath, 'utf8');
const stages = parseStages(source);
const report = buildReport(sourcePath, stages);

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(formatMarkdown(report));
}

function parseStages(text) {
  const descMatches = [...text.matchAll(/^\/\/!DESC\s+(.+)$/gm)];
  return descMatches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < descMatches.length ? descMatches[index + 1].index ?? text.length : text.length;
    const block = text.slice(start, end);
    const metadata = parseMetadata(block);
    const compute = parseCompute(metadata.COMPUTE);
    const save = metadata.SAVE ?? '(final image)';
    const widthScale = parseScale(metadata.WIDTH);
    const heightScale = parseScale(metadata.HEIGHT);
    const sharedMatch = block.match(/shared\s+(\w+)\s+inp\[(\d+)\]\[isize\.y\]\[isize\.x\]/);
    const outputStepMatch = block.match(/output_base\s*=\s*ivec2\(gl_GlobalInvocationID\)\s*\*\s*ivec2\((\d+),\s*(\d+)\)/);
    const inputStepMatch = block.match(/input_base\s*=\s*\(base\s*\+\s*ivec2\(x,y\)\s*-\s*offset\)\s*\*\s*ivec2\((\d+),\s*(\d+)\)/);
    const resultInitializers = countMatches(block, /\bV4\s+result\d+\s*=\s*V4\(/g);
    const matrixProducts = countMatches(block, /\bresult\d+\s*\+=\s*M4\(/g);
    const vectorProducts = countMatches(block, /\bresult\d+\s*\+=\s*V4\(/g);
    const imageStores = countMatches(block, /\bimageStore\s*\(/g);
    const texelFetches = countMatches(block, /\btexelFetch\s*\(/g);

    return {
      index: index + 1,
      desc: metadata.DESC ?? match[1],
      hook: metadata.HOOK,
      binds: toArray(metadata.BIND),
      save,
      width: metadata.WIDTH,
      height: metadata.HEIGHT,
      widthScale,
      heightScale,
      components: Number(metadata.COMPONENTS ?? 4),
      when: metadata.WHEN,
      compute,
      sharedValueType: sharedMatch?.[1] ?? null,
      sharedPlanes: sharedMatch ? Number(sharedMatch[2]) : 0,
      inputStep: inputStepMatch ? [Number(inputStepMatch[1]), Number(inputStepMatch[2])] : null,
      outputStep: outputStepMatch ? [Number(outputStepMatch[1]), Number(outputStepMatch[2])] : [1, 1],
      resultInitializers,
      matrixProducts,
      vectorProducts,
      imageStores,
      texelFetches,
      hasRelu: /\bmax\s*\(\s*result\d+\s*,\s*V4\(0\.0\)\s*\)/.test(block),
      hasClamp: /\bclamp\s*\(/.test(block),
      hasResidualAdd: toArray(metadata.BIND).length > 1,
      estimatedScalarWeights: resultInitializers * 4 + matrixProducts * 16 + vectorProducts * 4,
    };
  });
}

function parseMetadata(block) {
  const values = {};
  for (const match of block.matchAll(/^\/\/!(\w+)\s+(.+)$/gm)) {
    const [, key, value] = match;
    if (key === 'BIND') {
      values.BIND = [...toArray(values.BIND), value.trim()];
    } else {
      values[key] = value.trim();
    }
  }
  return values;
}

function parseCompute(value) {
  const numbers = (value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  return {
    raw: value ?? '',
    outputBlock: numbers.length >= 2 ? [numbers[0], numbers[1]] : null,
    localSize: numbers.length >= 4 ? [numbers[2], numbers[3], 1] : null,
  };
}

function parseScale(value) {
  const match = value?.match(/\b([0-9]+(?:\.[0-9]+)?)\s+\*/);
  return match ? Number(match[1]) : null;
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function toArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function buildReport(sourcePath, stages) {
  const totals = stages.reduce(
    (accumulator, stage) => ({
      estimatedScalarWeights: accumulator.estimatedScalarWeights + stage.estimatedScalarWeights,
      imageStores: accumulator.imageStores + stage.imageStores,
      matrixProducts: accumulator.matrixProducts + stage.matrixProducts,
      texelFetches: accumulator.texelFetches + stage.texelFetches,
      vectorProducts: accumulator.vectorProducts + stage.vectorProducts,
    }),
    {
      estimatedScalarWeights: 0,
      imageStores: 0,
      matrixProducts: 0,
      texelFetches: 0,
      vectorProducts: 0,
    },
  );

  const intermediateTextures = stages
    .filter((stage) => stage.save !== '(final image)')
    .map((stage) => ({
      name: stage.save,
      components: stage.components,
      scale: `${stage.widthScale ?? '?'}x${stage.heightScale ?? '?'}`,
    }));

  return {
    source: sourcePath,
    sourceName: basename(sourcePath),
    stageCount: stages.length,
    stages,
    intermediateTextures,
    totals,
  };
}

function formatMarkdown(report) {
  const lines = [
    `# ${report.sourceName} Port Report`,
    '',
    `Source: \`${report.source}\``,
    '',
    `Stages: ${report.stageCount}`,
    `Estimated scalar constants: ${report.totals.estimatedScalarWeights}`,
    `Matrix products: ${report.totals.matrixProducts}`,
    `Vector products: ${report.totals.vectorProducts}`,
    `Image stores: ${report.totals.imageStores}`,
    '',
    '| # | pass | binds | save | scale | compute block | local size | shared | output step | activation | constants |',
    '| - | ---- | ----- | ---- | ----- | ------------- | ---------- | ------ | ----------- | ---------- | --------- |',
  ];

  for (const stage of report.stages) {
    const activation = stage.hasRelu ? 'ReLU' : stage.hasClamp ? 'clamp' : 'linear';
    const cells = [
        stage.index,
        stage.desc,
        stage.binds.join('+') || '-',
        stage.save,
        `${stage.widthScale ?? '?'}x${stage.heightScale ?? '?'}`,
        stage.compute.outputBlock?.join('x') ?? '-',
        stage.compute.localSize?.join('x') ?? '-',
        stage.sharedPlanes ? `${stage.sharedPlanes} ${stage.sharedValueType}` : '-',
        stage.outputStep.join('x'),
        activation,
        stage.estimatedScalarWeights,
      ].map((value) => String(value).replaceAll('|', '\\|'));
    lines.push(`| ${cells.join(' | ')} |`);
  }

  lines.push('', 'Intermediate textures:');
  for (const texture of report.intermediateTextures) {
    lines.push(`- \`${texture.name}\`: ${texture.scale}, ${texture.components} component(s)`);
  }

  return `${lines.join('\n')}\n`;
}
