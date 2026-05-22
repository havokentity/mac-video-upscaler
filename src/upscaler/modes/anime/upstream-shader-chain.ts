import restoreCnnM from './upstream/Anime4K_Restore_CNN_M.glsl?raw';
import restoreCnnS from './upstream/Anime4K_Restore_CNN_S.glsl?raw';
import upscaleCnnM from './upstream/Anime4K_Upscale_CNN_x2_M.glsl?raw';
import upscaleCnnS from './upstream/Anime4K_Upscale_CNN_x2_S.glsl?raw';

export interface Anime4KPassSource {
  readonly binds: readonly string[];
  readonly code: string;
  readonly description: string;
  readonly heightExpression: string;
  readonly saveName: string;
  readonly sourceFile: string;
  readonly widthExpression: string;
}

export interface Anime4KSourceFile {
  readonly fileName: string;
  readonly source: string;
}

export const ANIME4K_UPSTREAM_COMMIT = '7684e9586f8dcc738af08a1cdceb024cc184f426';

export const ANIME4K_SOURCE_FILES: readonly Anime4KSourceFile[] = [
  { fileName: 'Anime4K_Restore_CNN_M.glsl', source: restoreCnnM },
  { fileName: 'Anime4K_Restore_CNN_S.glsl', source: restoreCnnS },
  { fileName: 'Anime4K_Upscale_CNN_x2_M.glsl', source: upscaleCnnM },
  { fileName: 'Anime4K_Upscale_CNN_x2_S.glsl', source: upscaleCnnS },
];

const parseAnime4KPasses = (sourceFile: Anime4KSourceFile): Anime4KPassSource[] =>
  sourceFile.source
    .split(/(?=\/\/!DESC )/)
    .filter((block) => block.startsWith('//!DESC '))
    .map((block) => {
      const description = getDirective(block, 'DESC');
      const saveName = getDirective(block, 'SAVE');
      const widthExpression = getDirective(block, 'WIDTH');
      const heightExpression = getDirective(block, 'HEIGHT');
      const binds = [...block.matchAll(/^\/\/!BIND\s+(.+)$/gm)].map((match) => match[1]);
      const code = block
        .split('\n')
        .filter((line) => !line.startsWith('//!'))
        .join('\n')
        .trim();

      return {
        binds,
        code,
        description,
        heightExpression,
        saveName,
        sourceFile: sourceFile.fileName,
        widthExpression,
      };
    });

export const RESTORE_CNN_M_PASSES = parseAnime4KPasses(ANIME4K_SOURCE_FILES[0]);
export const RESTORE_CNN_S_PASSES = parseAnime4KPasses(ANIME4K_SOURCE_FILES[1]);
export const UPSCALE_CNN_M_PASSES = parseAnime4KPasses(ANIME4K_SOURCE_FILES[2]);
export const UPSCALE_CNN_S_PASSES = parseAnime4KPasses(ANIME4K_SOURCE_FILES[3]);

export const MODE_A_FAST_CHAIN: readonly Anime4KPassSource[] = [
  ...RESTORE_CNN_M_PASSES,
  ...UPSCALE_CNN_M_PASSES,
  ...UPSCALE_CNN_S_PASSES,
];

export const MODE_AA_FAST_CHAIN: readonly Anime4KPassSource[] = [
  ...RESTORE_CNN_M_PASSES,
  ...UPSCALE_CNN_M_PASSES,
  ...RESTORE_CNN_S_PASSES,
  ...UPSCALE_CNN_S_PASSES,
];

function getDirective(block: string, directive: string): string {
  const match = block.match(new RegExp(`^//!${directive}\\s+(.+)$`, 'm'));
  return match?.[1] ?? '';
}
