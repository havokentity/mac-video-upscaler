export const ARTCNN_C4F16_MODEL_PATH = 'models/artcnn/ArtCNN_C4F16.onnx' as const;
export const ORT_JSEP_WASM_PATH = 'ort/ort-wasm-simd-threaded.jsep.wasm' as const;
export const ORT_JSEP_MJS_PATH = 'ort/ort-wasm-simd-threaded.jsep.mjs' as const;

export const getExtensionAssetUrl = (path: string): string => {
  if (typeof chrome !== 'undefined') {
    return chrome.runtime.getURL(path);
  }

  return `/${path}`;
};

export const getArtCnnModelUrl = (): string => getExtensionAssetUrl(ARTCNN_C4F16_MODEL_PATH);

export const getOrtWasmPaths = (): { wasm: string; mjs: string } => ({
  mjs: getExtensionAssetUrl(ORT_JSEP_MJS_PATH),
  wasm: getExtensionAssetUrl(ORT_JSEP_WASM_PATH),
});
