import { ARTCNN_UPSTREAM } from './artcnn-attribution';

export type ArtCnnPortStageKind =
  | 'conv2d-upsample'
  | 'conv2d-relu'
  | 'conv2d-linear'
  | 'conv2d-residual'
  | 'depth-to-space';

export interface ArtCnnPortStage {
  readonly id: string;
  readonly upstreamDescription: string;
  readonly kind: ArtCnnPortStageKind;
  readonly inputChannels: number;
  readonly outputChannels: number;
  readonly workgroupSize: readonly [number, number, number];
  readonly outputScale: number;
  readonly weightStatus: 'pending-port';
}

export interface ArtCnnPortPlan {
  readonly sourceName: typeof ARTCNN_UPSTREAM.smallestRealtimeVariant.name;
  readonly sourcePath: typeof ARTCNN_UPSTREAM.smallestRealtimeVariant.upstreamPath;
  readonly sourceCommit: typeof ARTCNN_UPSTREAM.verifiedCommit;
  readonly license: typeof ARTCNN_UPSTREAM.license;
  readonly generatedMetadata: string;
  readonly localPreviewShader: string;
  readonly nativePassOneShader: string;
  readonly nativePassTwoShader: string;
  readonly nativeSkeletonShader: string;
  readonly enabled: false;
  readonly reason: string;
  readonly stages: readonly ArtCnnPortStage[];
}

const ARTCNN_C4F16_WORKGROUP = [12, 16, 1] as const;

export const ARTCNN_C4F16_PORT_PLAN: ArtCnnPortPlan = {
  enabled: false,
  generatedMetadata: 'src/upscaler/modes/neural-lite/artcnn-c4f16-native-metadata.json',
  license: ARTCNN_UPSTREAM.license,
  localPreviewShader: 'src/upscaler/modes/neural-lite/artcnn-c4f16-preview.wgsl',
  nativePassOneShader: 'src/upscaler/modes/neural-lite/artcnn-c4f16-native-pass1.wgsl',
  nativePassTwoShader: 'src/upscaler/modes/neural-lite/artcnn-c4f16-native-pass2.wgsl',
  nativeSkeletonShader: 'src/upscaler/modes/neural-lite/artcnn-c4f16-native-skeleton.wgsl',
  reason:
    'ArtCNN_C4F16 needs a faithful multi-stage WGSL port of the upstream fused mpv Conv2D hooks and weights before it can be enabled.',
  sourceCommit: ARTCNN_UPSTREAM.verifiedCommit,
  sourceName: ARTCNN_UPSTREAM.smallestRealtimeVariant.name,
  sourcePath: ARTCNN_UPSTREAM.smallestRealtimeVariant.upstreamPath,
  stages: [
    {
      id: 'conv2d',
      inputChannels: 1,
      kind: 'conv2d-upsample',
      outputChannels: 16,
      outputScale: 2,
      upstreamDescription: 'ArtCNN C4F16 (Conv2D)',
      weightStatus: 'pending-port',
      workgroupSize: ARTCNN_C4F16_WORKGROUP,
    },
    {
      id: 'conv2d-1-relu',
      inputChannels: 16,
      kind: 'conv2d-relu',
      outputChannels: 16,
      outputScale: 2,
      upstreamDescription: 'ArtCNN C4F16 (Conv2D-1-ReLU)',
      weightStatus: 'pending-port',
      workgroupSize: ARTCNN_C4F16_WORKGROUP,
    },
    {
      id: 'conv2d-2-relu',
      inputChannels: 16,
      kind: 'conv2d-relu',
      outputChannels: 16,
      outputScale: 2,
      upstreamDescription: 'ArtCNN C4F16 (Conv2D-2-ReLU)',
      weightStatus: 'pending-port',
      workgroupSize: ARTCNN_C4F16_WORKGROUP,
    },
    {
      id: 'conv2d-3-relu',
      inputChannels: 16,
      kind: 'conv2d-relu',
      outputChannels: 16,
      outputScale: 2,
      upstreamDescription: 'ArtCNN C4F16 (Conv2D-3-ReLU)',
      weightStatus: 'pending-port',
      workgroupSize: ARTCNN_C4F16_WORKGROUP,
    },
    {
      id: 'conv2d-4-relu',
      inputChannels: 16,
      kind: 'conv2d-relu',
      outputChannels: 16,
      outputScale: 2,
      upstreamDescription: 'ArtCNN C4F16 (Conv2D-4-ReLU)',
      weightStatus: 'pending-port',
      workgroupSize: ARTCNN_C4F16_WORKGROUP,
    },
    {
      id: 'conv2d-5',
      inputChannels: 16,
      kind: 'conv2d-linear',
      outputChannels: 16,
      outputScale: 2,
      upstreamDescription: 'ArtCNN C4F16 (Conv2D-5)',
      weightStatus: 'pending-port',
      workgroupSize: ARTCNN_C4F16_WORKGROUP,
    },
    {
      id: 'conv2d-6',
      inputChannels: 32,
      kind: 'conv2d-residual',
      outputChannels: 4,
      outputScale: 1,
      upstreamDescription: 'ArtCNN C4F16 (Conv2D-6)',
      weightStatus: 'pending-port',
      workgroupSize: ARTCNN_C4F16_WORKGROUP,
    },
    {
      id: 'depth-to-space',
      inputChannels: 4,
      kind: 'depth-to-space',
      outputChannels: 1,
      outputScale: 2,
      upstreamDescription: 'ArtCNN C4F16 (Depth-To-Space)',
      weightStatus: 'pending-port',
      workgroupSize: ARTCNN_C4F16_WORKGROUP,
    },
  ],
};

export const getArtCnnPortStage = (id: string): ArtCnnPortStage | undefined =>
  ARTCNN_C4F16_PORT_PLAN.stages.find((stage) => stage.id === id);

export const getArtCnnPortSummary = (): string =>
  `${ARTCNN_C4F16_PORT_PLAN.sourceName} staged port: ${String(ARTCNN_C4F16_PORT_PLAN.stages.length)} upstream shader pass(es), weights pending, mode disabled.`;
