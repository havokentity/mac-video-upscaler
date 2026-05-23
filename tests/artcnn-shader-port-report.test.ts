import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ArtCnnPassMetadata {
  readonly activation: string;
  readonly index: number;
  readonly localSize: readonly [number, number, number];
  readonly outputStep: readonly [number, number];
  readonly counts: {
    readonly scalarConstants: number;
  };
  readonly constantsByResult: readonly {
    readonly result: string;
    readonly bias: readonly number[];
    readonly terms: readonly ArtCnnTermMetadata[];
  }[];
}

interface ArtCnnTermMetadata {
  readonly input: string;
  readonly operator: 'M4' | 'V4';
  readonly plane: number;
  readonly tile: readonly [number, number];
  readonly values: readonly number[];
}

interface ArtCnnMetadataArtifact {
  readonly passCount: number;
  readonly textures: {
    readonly input: readonly string[];
    readonly intermediate: readonly string[];
    readonly output: string;
  };
  readonly totals: {
    readonly estimatedScalarWeights: number;
    readonly matrixProducts: number;
    readonly resultInitializers: number;
    readonly vectorProducts: number;
  };
  readonly passes: readonly ArtCnnPassMetadata[];
}

interface ArtCnnReportModule {
  readonly buildMetadataArtifact: (report: unknown) => ArtCnnMetadataArtifact;
  readonly evaluateArtCnnConvolutionPassCpu: (
    pass: ArtCnnPassMetadata,
    inputValues: Record<string, readonly number[]>,
  ) => number[][];
  readonly evaluateArtCnnDepthToSpaceCpu: (
    sourceSample: readonly number[],
    subpixel: readonly [number, number],
  ) => number[];
  readonly generateWgslPassExecutable: (artifactOrReport: unknown, passIndex: number) => string;
  readonly generateWgslPassOneExecutable: (artifactOrReport: unknown) => string;
  readonly generateWgslPassTwoExecutable: (artifactOrReport: unknown) => string;
  readonly generateWgslSkeleton: (report: unknown) => string;
  readonly parseArtCnnShaderSourceFile: (sourcePath: string) => unknown;
}

const loadReportModule = async (): Promise<ArtCnnReportModule> => {
  // @ts-expect-error The parser is a Node CLI module that stays outside TS compilation.
  const moduleImport: unknown = await import('../scripts/artcnn-shader-port-report.mjs');
  return moduleImport as ArtCnnReportModule;
};

const upstreamSource = '/tmp/ArtCNN/GLSL/ArtCNN_C4F16.glsl';
const metadataPath = join(
  process.cwd(),
  'src/upscaler/modes/neural-lite/artcnn-c4f16-native-metadata.json',
);
const skeletonPath = join(
  process.cwd(),
  'src/upscaler/modes/neural-lite/artcnn-c4f16-native-skeleton.wgsl',
);
const passOnePath = join(
  process.cwd(),
  'src/upscaler/modes/neural-lite/artcnn-c4f16-native-pass1.wgsl',
);
const passTwoPath = join(
  process.cwd(),
  'src/upscaler/modes/neural-lite/artcnn-c4f16-native-pass2.wgsl',
);
const passPaths = Array.from({ length: 8 }, (_, index) =>
  join(process.cwd(), `src/upscaler/modes/neural-lite/artcnn-c4f16-native-pass${String(index + 1)}.wgsl`),
);
const upstreamIt = existsSync(upstreamSource) ? it : it.skip;

describe('ArtCNN shader-native parser and generator', () => {
  upstreamIt('extracts the upstream pass layout and constants', async () => {
    const { buildMetadataArtifact, parseArtCnnShaderSourceFile } = await loadReportModule();
    const artifact = buildMetadataArtifact(parseArtCnnShaderSourceFile(upstreamSource));

    expect(artifact.passCount).toBe(8);
    expect(artifact.passes.map((pass) => pass.localSize)).toEqual(
      Array.from({ length: 8 }, () => [12, 16, 1]),
    );
    expect(artifact.passes.map((pass) => pass.outputStep)).toEqual([
      [2, 2],
      [2, 2],
      [2, 2],
      [2, 2],
      [2, 2],
      [2, 2],
      [1, 1],
      [1, 1],
    ]);
    expect(artifact.textures).toEqual({
      input: ['LUMA'],
      intermediate: [
        'conv2d',
        'conv2d_1',
        'conv2d_2',
        'conv2d_3',
        'conv2d_4',
        'conv2d_5',
        'conv2d_6',
      ],
      output: 'final image',
    });
    expect(artifact.totals).toMatchObject({
      estimatedScalarWeights: 12340,
      matrixProducts: 756,
      resultInitializers: 25,
      vectorProducts: 36,
    });
    expect(artifact.passes.map((pass) => pass.counts.scalarConstants)).toEqual([
      160,
      2320,
      2320,
      2320,
      2320,
      2320,
      580,
      0,
    ]);
    expect(artifact.passes[0]?.constantsByResult[0]).toMatchObject({
      bias: [-0.0027198044, -0.013629392, -0.015712878, -0.050803013],
      result: 'result0',
    });
    expect(artifact.passes[0]?.constantsByResult[0]?.terms).toHaveLength(9);
    expect(artifact.passes[1]?.constantsByResult[0]?.terms).toHaveLength(36);
  });

  upstreamIt('keeps the checked-in JSON artifact stable', async () => {
    const { buildMetadataArtifact, parseArtCnnShaderSourceFile } = await loadReportModule();
    const generated = buildMetadataArtifact(parseArtCnnShaderSourceFile(upstreamSource));
    const checkedIn = JSON.parse(readFileSync(metadataPath, 'utf8')) as ArtCnnMetadataArtifact;

    expect(checkedIn).toEqual(generated);
  });

  upstreamIt('keeps the generated WGSL skeleton aligned to the parser output', async () => {
    const { generateWgslSkeleton, parseArtCnnShaderSourceFile } = await loadReportModule();
    const report = parseArtCnnShaderSourceFile(upstreamSource);
    const skeleton = readFileSync(skeletonPath, 'utf8');

    expect(skeleton).toBe(generateWgslSkeleton(report));
    expect(skeleton.match(/@workgroup_size\(12, 16, 1\)/g)).toHaveLength(8);
    expect(skeleton).toContain('fn artcnn_c4f16_pass_08');
    expect(skeleton).toContain('output=conv2d_6 output_step=1x1');
  });

  upstreamIt('keeps the generated executable pass 1 slice aligned to upstream constants', async () => {
    const {
      buildMetadataArtifact,
      generateWgslPassOneExecutable,
      parseArtCnnShaderSourceFile,
    } = await loadReportModule();
    const artifact = buildMetadataArtifact(parseArtCnnShaderSourceFile(upstreamSource));
    const passOne = readFileSync(passOnePath, 'utf8');

    expect(passOne).toBe(generateWgslPassOneExecutable(artifact));
  });

  upstreamIt('keeps the generated executable pass 2 slice aligned to upstream constants', async () => {
    const {
      buildMetadataArtifact,
      generateWgslPassTwoExecutable,
      parseArtCnnShaderSourceFile,
    } = await loadReportModule();
    const artifact = buildMetadataArtifact(parseArtCnnShaderSourceFile(upstreamSource));
    const passTwo = readFileSync(passTwoPath, 'utf8');

    expect(passTwo).toBe(generateWgslPassTwoExecutable(artifact));
  });

  upstreamIt('keeps all generated executable pass slices aligned to upstream constants', async () => {
    const {
      buildMetadataArtifact,
      generateWgslPassExecutable,
      parseArtCnnShaderSourceFile,
    } = await loadReportModule();
    const artifact = buildMetadataArtifact(parseArtCnnShaderSourceFile(upstreamSource));

    for (const [index, passPath] of passPaths.entries()) {
      expect(readFileSync(passPath, 'utf8')).toBe(generateWgslPassExecutable(artifact, index + 1));
    }
  });

  it('ships stable parser artifacts even when upstream checkout is absent', () => {
    const checkedIn = JSON.parse(readFileSync(metadataPath, 'utf8')) as ArtCnnMetadataArtifact;
    const skeleton = readFileSync(skeletonPath, 'utf8');

    expect(checkedIn.passCount).toBe(8);
    expect(checkedIn.totals).toMatchObject({
      estimatedScalarWeights: 12340,
      matrixProducts: 756,
      resultInitializers: 25,
      vectorProducts: 36,
    });
    expect(checkedIn.passes.map((pass) => pass.localSize)).toEqual(
      Array.from({ length: 8 }, () => [12, 16, 1]),
    );
    expect(skeleton.match(/@workgroup_size\(12, 16, 1\)/g)).toHaveLength(8);
    expect(skeleton).toContain('fn artcnn_c4f16_pass_08');
  });

  it('generates a checked-in executable pass 1 WGSL slice from checked-in metadata', async () => {
    const { generateWgslPassOneExecutable } = await loadReportModule();
    const checkedIn = JSON.parse(readFileSync(metadataPath, 'utf8')) as ArtCnnMetadataArtifact;
    const passOne = readFileSync(passOnePath, 'utf8');

    expect(passOne).toBe(generateWgslPassOneExecutable(checkedIn));
    expect(passOne).toContain('enable f16;');
    expect(passOne).toContain('@group(0) @binding(0) var artcnn_luma: texture_2d<f32>;');
    expect(passOne).toContain('@group(0) @binding(1) var artcnn_out: texture_storage_2d<rgba16float, write>;');
    expect(passOne).toContain('@compute @workgroup_size(12, 16, 1)');
    expect(passOne).toContain('fn artcnn_c4f16_pass_01');
    expect(passOne).toContain('var result0 = vec4<f16>(f16(-0.0027198044)');
    expect(passOne).toContain('result3 += vec4<f16>');
    expect(passOne).toContain('artcnn_store_pass1(output_base + vec2u(1, 1), result3);');
    expect(passOne).not.toContain('TODO');
  });

  it('generates a checked-in executable pass 2 WGSL slice from checked-in metadata', async () => {
    const { generateWgslPassTwoExecutable } = await loadReportModule();
    const checkedIn = JSON.parse(readFileSync(metadataPath, 'utf8')) as ArtCnnMetadataArtifact;
    const passTwo = readFileSync(passTwoPath, 'utf8');

    expect(passTwo).toBe(generateWgslPassTwoExecutable(checkedIn));
    expect(passTwo).toContain('enable f16;');
    expect(passTwo).toContain('@group(0) @binding(0) var artcnn_in: texture_2d<f32>;');
    expect(passTwo).toContain('@group(0) @binding(1) var artcnn_out: texture_storage_2d<rgba16float, write>;');
    expect(passTwo).toContain('@compute @workgroup_size(12, 16, 1)');
    expect(passTwo).toContain('fn artcnn_c4f16_pass_02');
    expect(passTwo).toContain('let inp_3_2_2 = artcnn_load_pass2(base, 3u, vec2i(2, 2));');
    expect(passTwo).toContain('mat4x4<f16>');
    expect(passTwo).toContain('result3 = max(result3, vec4<f16>(f16(0)));');
    expect(passTwo).toContain('artcnn_store_pass2(output_base + vec2u(1, 1), result3);');
    expect(passTwo).not.toContain('TODO');
  });

  it('generates checked-in executable WGSL for every ArtCNN pass from checked-in metadata', async () => {
    const { generateWgslPassExecutable } = await loadReportModule();
    const checkedIn = JSON.parse(readFileSync(metadataPath, 'utf8')) as ArtCnnMetadataArtifact;

    for (const [index, passPath] of passPaths.entries()) {
      const passNumber = index + 1;
      const passSource = readFileSync(passPath, 'utf8');
      expect(passSource).toBe(generateWgslPassExecutable(checkedIn, passNumber));
      expect(passSource).toContain(`fn artcnn_c4f16_pass_${String(passNumber).padStart(2, '0')}`);
      expect(passSource).not.toContain('TODO');
    }
    expect(readFileSync(passPaths[6], 'utf8')).toContain('@group(0) @binding(0) var artcnn_residual: texture_2d<f32>;');
    expect(readFileSync(passPaths[7], 'utf8')).toContain('let channel = subpixel.y * 2u + subpixel.x;');
  });

  it('evaluates generated convolution passes with a deterministic CPU reference', async () => {
    const { evaluateArtCnnConvolutionPassCpu } = await loadReportModule();
    const checkedIn = JSON.parse(readFileSync(metadataPath, 'utf8')) as ArtCnnMetadataArtifact;

    for (const pass of checkedIn.passes.slice(0, 7)) {
      const inputValues = createDeterministicInputs(pass);
      const outputs = evaluateArtCnnConvolutionPassCpu(pass, inputValues);
      expect(outputs).toHaveLength(pass.constantsByResult.length);
      expect(outputs.every((output) => output.length === 4)).toBe(true);
      expect(outputs.flat().every(Number.isFinite)).toBe(true);
      if (pass.activation === 'relu') {
        expect(outputs.flat().every((value) => value >= 0)).toBe(true);
      }
    }
  });

  it('evaluates depth-to-space with a CPU reference', async () => {
    const { evaluateArtCnnDepthToSpaceCpu } = await loadReportModule();

    expect(evaluateArtCnnDepthToSpaceCpu([-0.4, 0.25, 0.75, 1.7], [0, 0])).toEqual([0, 0, 0, 1]);
    expect(evaluateArtCnnDepthToSpaceCpu([-0.4, 0.25, 0.75, 1.7], [1, 0])).toEqual([0.25, 0, 0, 1]);
    expect(evaluateArtCnnDepthToSpaceCpu([-0.4, 0.25, 0.75, 1.7], [0, 1])).toEqual([0.75, 0, 0, 1]);
    expect(evaluateArtCnnDepthToSpaceCpu([-0.4, 0.25, 0.75, 1.7], [1, 1])).toEqual([1, 0, 0, 1]);
  });
});

const createDeterministicInputs = (pass: ArtCnnPassMetadata): Record<string, readonly number[]> => {
  const inputs: Record<string, readonly number[]> = {};
  for (const result of pass.constantsByResult) {
    for (const term of result.terms) {
      const seed = term.plane * 13 + term.tile[0] * 5 + term.tile[1] * 7 + pass.index;
      inputs[term.input] =
        term.operator === 'V4'
          ? [seed / 31]
          : [seed / 31, (seed + 1) / 37, (seed + 2) / 41, (seed + 3) / 43];
    }
  }
  return inputs;
};
