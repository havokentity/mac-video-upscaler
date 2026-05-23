#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basename, resolve } from 'node:path';

const DEFAULT_SOURCE = '/tmp/ArtCNN/GLSL/ArtCNN_C4F16.glsl';

const usage = `Usage: node scripts/artcnn-shader-port-report.mjs [source.glsl] [--json] [--emit-json out.json] [--emit-wgsl out.wgsl] [--emit-pass1-wgsl out.wgsl]

Parses ArtCNN mpv GLSL hook metadata and emits a compact porting report.
Default source: ${DEFAULT_SOURCE}
`;

if (isMainModule()) {
  runCli(process.argv.slice(2));
}

export function runCli(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage);
    return;
  }

  const json = args.includes('--json');
  const sourceArg = args.find((arg, index) => !arg.startsWith('-') && !isOptionValue(args, index)) ?? DEFAULT_SOURCE;
  const sourcePath = resolve(sourceArg);
  const emitJsonPath = getOptionValue(args, '--emit-json');
  const emitWgslPath = getOptionValue(args, '--emit-wgsl');
  const emitPassOneWgslPath = getOptionValue(args, '--emit-pass1-wgsl');

  if (!existsSync(sourcePath)) {
    process.stderr.write(
      `ArtCNN GLSL source not found: ${sourcePath}\n` +
        `Fetch upstream ArtCNN first, for example: git clone https://github.com/Artoriuz/ArtCNN.git /tmp/ArtCNN\n`,
    );
    process.exitCode = 1;
    return;
  }

  const report = parseArtCnnShaderSourceFile(sourcePath);
  if (emitJsonPath) {
    writeFileSync(resolve(emitJsonPath), `${JSON.stringify(buildMetadataArtifact(report), null, 2)}\n`);
  }
  if (emitWgslPath) {
    writeFileSync(resolve(emitWgslPath), generateWgslSkeleton(report));
  }
  if (emitPassOneWgslPath) {
    writeFileSync(resolve(emitPassOneWgslPath), generateWgslPassOneExecutable(buildMetadataArtifact(report)));
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatMarkdown(report));
  }
}

export function parseArtCnnShaderSourceFile(sourcePath) {
  const resolvedPath = resolve(sourcePath);
  const source = readFileSync(resolvedPath, 'utf8');
  return buildReport(resolvedPath, source, parseStages(source));
}

export function parseStages(text) {
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
    const constantsByResult = parseConstantsByResult(block);
    const resultInitializers = constantsByResult.filter((result) => result.bias.length > 0).length;
    const matrixProducts = sum(constantsByResult.map((result) => result.terms.filter((term) => term.operator === 'M4').length));
    const vectorProducts = sum(constantsByResult.map((result) => result.terms.filter((term) => term.operator === 'V4').length));
    const imageStores = countMatches(block, /\bimageStore\s*\(/g);
    const texelFetches = countMatches(block, /\btexelFetch\s*\(/g);
    const activation = /\bmax\s*\(\s*result\d+\s*,\s*V4\(0\.0\)\s*\)/.test(block)
      ? 'relu'
      : /\bclamp\s*\(/.test(block)
        ? 'clamp'
        : 'linear';

    return {
      index: index + 1,
      id: makeStageId(save, metadata.DESC ?? match[1]),
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
      activation,
      hasRelu: activation === 'relu',
      hasClamp: activation === 'clamp',
      hasResidualAdd: toArray(metadata.BIND).length > 1,
      constantsByResult,
      estimatedScalarWeights: sum(constantsByResult.map((result) => result.scalarCount)),
    };
  });
}

export function parseMetadata(block) {
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

export function parseCompute(value) {
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

export function parseScale(value) {
  const match = value?.match(/\b([0-9]+(?:\.[0-9]+)?)\s+\*/);
  return match ? Number(match[1]) : null;
}

export function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

export function toArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function buildReport(sourcePath, source, stages) {
  const totals = stages.reduce(
    (accumulator, stage) => ({
      estimatedScalarWeights: accumulator.estimatedScalarWeights + stage.estimatedScalarWeights,
      imageStores: accumulator.imageStores + stage.imageStores,
      matrixProducts: accumulator.matrixProducts + stage.matrixProducts,
      texelFetches: accumulator.texelFetches + stage.texelFetches,
      vectorProducts: accumulator.vectorProducts + stage.vectorProducts,
      resultInitializers: accumulator.resultInitializers + stage.resultInitializers,
    }),
    {
      estimatedScalarWeights: 0,
      imageStores: 0,
      matrixProducts: 0,
      resultInitializers: 0,
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
    sourceHash: createHash('sha256').update(source).digest('hex'),
    sourceName: basename(sourcePath),
    stageCount: stages.length,
    stages,
    intermediateTextures,
    totals,
  };
}

export function buildMetadataArtifact(report) {
  return {
    schemaVersion: 1,
    generator: 'scripts/artcnn-shader-port-report.mjs',
    source: {
      name: report.sourceName,
      sha256: report.sourceHash,
      upstreamPath: DEFAULT_SOURCE,
      variant: 'ArtCNN_C4F16',
    },
    passCount: report.stageCount,
    textures: {
      input: ['LUMA'],
      intermediate: report.intermediateTextures.map((texture) => texture.name),
      output: 'final image',
    },
    totals: report.totals,
    passes: report.stages.map((stage) => ({
      index: stage.index,
      id: stage.id,
      description: stage.desc,
      hook: stage.hook,
      binds: stage.binds,
      outputTexture: stage.save,
      widthScale: stage.widthScale,
      heightScale: stage.heightScale,
      components: stage.components,
      compute: stage.compute,
      localSize: stage.compute.localSize,
      inputStep: stage.inputStep,
      outputStep: stage.outputStep,
      shared: {
        planes: stage.sharedPlanes,
        valueType: stage.sharedValueType,
      },
      activation: stage.activation,
      hasResidualAdd: stage.hasResidualAdd,
      counts: {
        biasVectors: stage.resultInitializers,
        imageStores: stage.imageStores,
        matrixProducts: stage.matrixProducts,
        scalarConstants: stage.estimatedScalarWeights,
        texelFetches: stage.texelFetches,
        vectorProducts: stage.vectorProducts,
      },
      constantsByResult: stage.constantsByResult,
    })),
  };
}

export function generateWgslSkeleton(report) {
  const artifact = buildMetadataArtifact(report);
  const lines = [
    '/*',
    ' * Generated ArtCNN C4F16 shader-native scaffold.',
    ' * Source: ArtCNN_C4F16.glsl from Artoriuz/ArtCNN, MIT licensed.',
    ` * Source SHA-256: ${artifact.source.sha256}`,
    ' *',
    ' * This is a non-runtime skeleton. It preserves pass boundaries, bindings,',
    ' * workgroup sizes, output steps, and extracted constant counts so the real',
    ' * WGSL kernels can be filled in without drifting from upstream metadata.',
    ' */',
    '',
    'struct ArtCnnNativeParams {',
    '  source_size: vec2u,',
    '  output_size: vec2u,',
    '};',
    '',
  ];

  for (const pass of artifact.passes) {
    const [x, y, z] = pass.localSize ?? [1, 1, 1];
    lines.push(
      `// Pass ${pass.index}: ${pass.description}`,
      `// binds=${pass.binds.join(', ') || '-'} output=${pass.outputTexture} output_step=${pass.outputStep.join('x')}`,
      `// constants: bias=${pass.counts.biasVectors} M4=${pass.counts.matrixProducts} V4=${pass.counts.vectorProducts} scalars=${pass.counts.scalarConstants}`,
      `@compute @workgroup_size(${x}, ${y}, ${z})`,
      `fn artcnn_c4f16_pass_${String(pass.index).padStart(2, '0')}(@builtin(global_invocation_id) global_id: vec3u) {`,
      '  _ = global_id;',
      '  // TODO: generated kernel body will consume constantsByResult from artcnn-c4f16-native-metadata.json.',
      '}',
      '',
    );
  }

  return `${lines.join('\n')}\n`;
}

export function generateWgslPassOneExecutable(artifactOrReport) {
  const artifact = isMetadataArtifact(artifactOrReport) ? artifactOrReport : buildMetadataArtifact(artifactOrReport);
  const pass = artifact.passes[0];

  if (!pass) {
    throw new Error('ArtCNN pass 1 metadata is missing.');
  }
  if (pass.index !== 1 || pass.outputStep.join('x') !== '2x2') {
    throw new Error('ArtCNN pass 1 generator expects the Conv2D 2x2 output pass.');
  }
  if (pass.constantsByResult.length !== 4) {
    throw new Error('ArtCNN pass 1 generator expects four result vectors.');
  }
  for (const result of pass.constantsByResult) {
    if (result.bias.length !== 4 || result.terms.length !== 9) {
      throw new Error(`ArtCNN pass 1 ${result.result} has an unexpected 3x3 scalar convolution shape.`);
    }
    for (const term of result.terms) {
      if (term.operator !== 'V4' || term.plane !== 0 || term.values.length !== 4) {
        throw new Error(`ArtCNN pass 1 ${result.result} includes an unsupported term shape.`);
      }
    }
  }

  const [workgroupX, workgroupY, workgroupZ] = pass.localSize ?? [12, 16, 1];
  const lines = [
    'enable f16;',
    '',
    '/*',
    ' * Generated executable ArtCNN C4F16 pass 1 slice.',
    ' * Source: ArtCNN_C4F16.glsl from Artoriuz/ArtCNN, MIT licensed.',
    ` * Source SHA-256: ${artifact.source.sha256}`,
    ' *',
    ' * This file is not runtime-wired yet. It is the first faithful WGSL',
    ' * compute pass generated from constantsByResult so the shader-native',
    ' * port can advance with stable, reviewable artifacts.',
    ' */',
    '',
    'struct ArtCnnNativeParams {',
    '  source_size: vec2u,',
    '  output_size: vec2u,',
    '};',
    '',
    '@group(0) @binding(0) var artcnn_luma: texture_2d<f32>;',
    '@group(0) @binding(1) var artcnn_out: texture_storage_2d<rgba16float, write>;',
    '@group(0) @binding(2) var<uniform> artcnn_params: ArtCnnNativeParams;',
    '',
    'fn artcnn_load_luma(base: vec2u, tile: vec2i) -> f16 {',
    '  let max_coord = vec2i(artcnn_params.source_size) - vec2i(1, 1);',
    '  let coord = clamp(vec2i(base) + tile - vec2i(1, 1), vec2i(0, 0), max_coord);',
    '  return f16(textureLoad(artcnn_luma, coord, 0).r);',
    '}',
    '',
    'fn artcnn_store_pass1(pixel: vec2u, value: vec4<f16>) {',
    '  if (pixel.x < artcnn_params.output_size.x && pixel.y < artcnn_params.output_size.y) {',
    '    textureStore(artcnn_out, pixel, vec4f(value));',
    '  }',
    '}',
    '',
    `@compute @workgroup_size(${workgroupX}, ${workgroupY}, ${workgroupZ})`,
    'fn artcnn_c4f16_pass_01(@builtin(global_invocation_id) global_id: vec3u) {',
    '  let base = global_id.xy;',
    '  let output_base = global_id.xy * vec2u(2, 2);',
    '',
  ];

  const termsByInput = new Map();
  for (const result of pass.constantsByResult) {
    for (const term of result.terms) {
      termsByInput.set(term.input, term);
    }
  }
  for (const term of [...termsByInput.values()].sort(compareTerms)) {
    lines.push(
      `  let ${term.input} = artcnn_load_luma(base, vec2i(${term.tile[0]}, ${term.tile[1]}));`,
    );
  }
  lines.push('');

  for (const result of pass.constantsByResult) {
    lines.push(`  var ${result.result} = ${formatWgslF16Vec4(result.bias)};`);
    for (const term of result.terms) {
      lines.push(`  ${result.result} += ${formatWgslF16Vec4(term.values)} * ${term.input};`);
    }
    lines.push('');
  }

  lines.push(
    '  artcnn_store_pass1(output_base + vec2u(0, 0), result0);',
    '  artcnn_store_pass1(output_base + vec2u(1, 0), result1);',
    '  artcnn_store_pass1(output_base + vec2u(0, 1), result2);',
    '  artcnn_store_pass1(output_base + vec2u(1, 1), result3);',
    '}',
  );

  return `${lines.join('\n')}\n`;
}

export function formatMarkdown(report) {
  const lines = [
    `# ${report.sourceName} Port Report`,
    '',
    `Source: \`${report.source}\``,
    `SHA-256: \`${report.sourceHash}\``,
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

function parseConstantsByResult(block) {
  const resultMap = new Map();

  for (const match of block.matchAll(/\bV4\s+result(\d+)\s*=\s*V4\(([^)]*)\)/g)) {
    const resultIndex = Number(match[1]);
    resultMap.set(resultIndex, {
      result: `result${resultIndex}`,
      bias: parseNumberList(match[2]),
      terms: [],
      scalarCount: 4,
    });
  }

  for (const match of block.matchAll(/\bresult(\d+)\s*\+=\s*(M4|V4)\(([^)]*)\)\s*\*\s*(inp_(\d+)_(\d+)_(\d+))/g)) {
    const resultIndex = Number(match[1]);
    const operator = match[2];
    const values = parseNumberList(match[3]);
    const result = resultMap.get(resultIndex) ?? {
      result: `result${resultIndex}`,
      bias: [],
      terms: [],
      scalarCount: 0,
    };

    result.terms.push({
      input: match[4],
      operator,
      plane: Number(match[5]),
      tile: [Number(match[6]), Number(match[7])],
      values,
    });
    result.scalarCount += values.length;
    resultMap.set(resultIndex, result);
  }

  return [...resultMap.values()]
    .sort((left, right) => Number(left.result.replace('result', '')) - Number(right.result.replace('result', '')))
    .map((result) => ({
      ...result,
      terms: result.terms.sort(
        (left, right) =>
          left.plane - right.plane ||
          left.tile[1] - right.tile[1] ||
          left.tile[0] - right.tile[0] ||
          left.operator.localeCompare(right.operator),
      ),
    }));
}

function parseNumberList(text) {
  return text.split(',').map((value) => Number(value.trim()));
}

function formatWgslF16Vec4(values) {
  if (values.length !== 4) {
    throw new Error(`Expected four f16 values, got ${values.length}.`);
  }

  return `vec4<f16>(${values.map((value) => `f16(${formatNumber(value)})`).join(', ')})`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot emit non-finite WGSL number: ${value}`);
  }

  return Object.is(value, -0) ? '0' : String(value);
}

function compareTerms(left, right) {
  return (
    left.plane - right.plane ||
    left.tile[1] - right.tile[1] ||
    left.tile[0] - right.tile[0] ||
    left.input.localeCompare(right.input)
  );
}

function isMetadataArtifact(value) {
  return Boolean(value && typeof value === 'object' && value.schemaVersion === 1 && Array.isArray(value.passes));
}

function makeStageId(save, desc) {
  if (save !== '(final image)') {
    return save.replaceAll('-', '_');
  }

  return desc
    .toLowerCase()
    .replace(/^artcnn c4f16 \(|\)$/g, '')
    .replaceAll('-', '_')
    .replaceAll(/\W+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function getOptionValue(args, optionName) {
  const index = args.indexOf(optionName);
  return index >= 0 ? args[index + 1] : undefined;
}

function isOptionValue(args, index) {
  const previous = args[index - 1];
  return previous === '--emit-json' || previous === '--emit-wgsl' || previous === '--emit-pass1-wgsl';
}

function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
