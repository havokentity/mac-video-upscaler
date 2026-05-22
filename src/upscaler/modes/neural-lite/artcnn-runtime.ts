export const ARTCNN_C4F16_MODEL_PATH = 'models/artcnn/ArtCNN_C4F16.onnx' as const;
export const ORT_ASYNCIFY_WASM_PATH = 'ort/ort-wasm-simd-threaded.asyncify.wasm' as const;
export const ORT_ASYNCIFY_MJS_PATH = 'ort/ort-wasm-simd-threaded.asyncify.mjs' as const;

export const getExtensionAssetUrl = (path: string): string => {
  if (typeof chrome !== 'undefined') {
    return chrome.runtime.getURL(path);
  }

  return `/${path}`;
};

export const getArtCnnModelUrl = (): string => getExtensionAssetUrl(ARTCNN_C4F16_MODEL_PATH);

export const getOrtWasmPaths = (): { wasm: string; mjs: string } => ({
  mjs: getExtensionAssetUrl(ORT_ASYNCIFY_MJS_PATH),
  wasm: getExtensionAssetUrl(ORT_ASYNCIFY_WASM_PATH),
});
