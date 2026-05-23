enable f16;

/*
 * Generated executable ArtCNN C4F16 pass 8 depth-to-space slice.
 * Source: ArtCNN_C4F16.glsl from Artoriuz/ArtCNN, MIT licensed.
 * Source SHA-256: 03d0b3d31cb82c898a94a46663021a3e8f02c5a21d69c5cfdf0208de4bfd453e
 * Runtime wiring remains disabled until full CPU/reference validation lands.
 */

struct ArtCnnNativeParams {
  source_size: vec2u,
  output_size: vec2u,
};

@group(0) @binding(0) var artcnn_in: texture_2d<f32>;
@group(0) @binding(1) var artcnn_out: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> artcnn_params: ArtCnnNativeParams;

@compute @workgroup_size(12, 16, 1)
fn artcnn_c4f16_pass_08(@builtin(global_invocation_id) global_id: vec3u) {
  if (global_id.x >= artcnn_params.output_size.x || global_id.y >= artcnn_params.output_size.y) {
    return;
  }
  let source_coord = global_id.xy / vec2u(2, 2);
  let subpixel = global_id.xy % vec2u(2, 2);
  let channel = subpixel.y * 2u + subpixel.x;
  let source_sample = textureLoad(artcnn_in, source_coord, 0);
  let luma = clamp(source_sample[channel], 0.0, 1.0);
  textureStore(artcnn_out, global_id.xy, vec4f(luma, 0.0, 0.0, 1.0));
}
