enable f16;

struct CrispParams {
  source_size: vec2f,
  output_size: vec2f,
  sharpness_and_scale: vec2f,
};

@group(0) @binding(0) var video_sampler: sampler;
@group(0) @binding(1) var input_texture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: CrispParams;
@group(0) @binding(3) var output_texture: texture_storage_2d<rgba8unorm, write>;

fn luma(color: vec3<f16>) -> f16 {
  return dot(color, vec3<f16>(0.2126h, 0.7153h, 0.0722h));
}

@compute @workgroup_size(8, 8, 1)
fn easu_main(@builtin(global_invocation_id) invocation_id: vec3u) {
  let pixel = invocation_id.xy;
  let output_size = vec2u(params.output_size);

  if (pixel.x >= output_size.x || pixel.y >= output_size.y) {
    return;
  }

  let uv = (vec2f(pixel) + vec2f(0.5)) / params.output_size;
  let texel = 1.0 / params.source_size;
  let center = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv, 0.0).rgb);
  let left = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv - vec2f(texel.x, 0.0), 0.0).rgb);
  let right = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv + vec2f(texel.x, 0.0), 0.0).rgb);
  let up = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv - vec2f(0.0, texel.y), 0.0).rgb);
  let down = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv + vec2f(0.0, texel.y), 0.0).rgb);
  let diag_a = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv + vec2f(texel.x, texel.y), 0.0).rgb);
  let diag_b = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv + vec2f(-texel.x, texel.y), 0.0).rgb);
  let diag_c = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv + vec2f(texel.x, -texel.y), 0.0).rgb);
  let diag_d = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv - vec2f(texel.x, texel.y), 0.0).rgb);

  let horizontal_edge = abs(luma(left) - luma(right));
  let vertical_edge = abs(luma(up) - luma(down));
  let edge_weight = clamp(abs(horizontal_edge - vertical_edge) * 5.0h, 0.0h, 1.0h);
  let horizontal_blend = (left + center * 2.0h + right) * 0.25h;
  let vertical_blend = (up + center * 2.0h + down) * 0.25h;
  let diagonal_blend = (diag_a + diag_b + diag_c + diag_d + center * 4.0h) * 0.125h;
  let directional = select(horizontal_blend, vertical_blend, horizontal_edge > vertical_edge);
  let smoothed = mix(diagonal_blend, directional, edge_weight);

  textureStore(output_texture, pixel, vec4f(vec3f(mix(center, smoothed, 0.55h)), 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn rcas_main(@builtin(global_invocation_id) invocation_id: vec3u) {
  let pixel = invocation_id.xy;
  let output_size = vec2u(params.output_size);

  if (pixel.x >= output_size.x || pixel.y >= output_size.y) {
    return;
  }

  let uv = (vec2f(pixel) + vec2f(0.5)) / params.output_size;
  let texel = 1.0 / params.output_size;
  let center = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv, 0.0).rgb);
  let left = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv - vec2f(texel.x, 0.0), 0.0).rgb);
  let right = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv + vec2f(texel.x, 0.0), 0.0).rgb);
  let up = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv - vec2f(0.0, texel.y), 0.0).rgb);
  let down = vec3<f16>(textureSampleLevel(input_texture, video_sampler, uv + vec2f(0.0, texel.y), 0.0).rgb);
  let local_min = min(center, min(min(left, right), min(up, down)));
  let local_max = max(center, max(max(left, right), max(up, down)));
  let blur = (left + right + up + down) * 0.25h;
  let contrast = max(local_max.r, max(local_max.g, local_max.b)) -
    min(local_min.r, min(local_min.g, local_min.b));
  let sharpness = f16(params.sharpness_and_scale.x);
  let adaptive_gain = sharpness * mix(0.85h, 0.25h, smoothstep(0.02h, 0.35h, contrast));
  let sharpened = center + (center - blur) * adaptive_gain;

  textureStore(output_texture, pixel, vec4f(vec3f(clamp(sharpened, local_min, local_max)), 1.0));
}
