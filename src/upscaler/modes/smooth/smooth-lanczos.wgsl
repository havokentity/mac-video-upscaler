struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

struct SmoothUniforms {
  source_size: vec2f,
};

@vertex
fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );

  var uvs = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0),
  );

  var output: VertexOutput;
  output.position = vec4f(positions[vertex_index], 0.0, 1.0);
  output.uv = uvs[vertex_index];
  return output;
}

@group(0) @binding(0) var video_sampler: sampler;
@group(0) @binding(1) var video_texture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: SmoothUniforms;

const PI: f32 = 3.141592653589793;
const LANCZOS_RADIUS: f32 = 3.0;

fn sinc(x: f32) -> f32 {
  let ax = abs(x);
  if (ax < 0.0001) {
    return 1.0;
  }

  let pix = PI * ax;
  return sin(pix) / pix;
}

fn lanczos_weight(distance: f32) -> f32 {
  let ad = abs(distance);
  if (ad >= LANCZOS_RADIUS) {
    return 0.0;
  }

  return sinc(ad) * sinc(ad / LANCZOS_RADIUS);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let source_pixel = input.uv * params.source_size - vec2f(0.5);
  let base_pixel = floor(source_pixel);
  let texel = 1.0 / params.source_size;

  var color = vec4f(0.0);
  var weight_sum = 0.0;

  for (var y = -2; y <= 3; y = y + 1) {
    for (var x = -2; x <= 3; x = x + 1) {
      let sample_pixel = base_pixel + vec2f(f32(x), f32(y));
      let delta = source_pixel - sample_pixel;
      let radius = length(delta);
      let weight = lanczos_weight(radius);
      let uv = (sample_pixel + vec2f(0.5)) * texel;

      color += textureSampleLevel(video_texture, video_sampler, uv, 0.0) * weight;
      weight_sum += weight;
    }
  }

  if (abs(weight_sum) < 0.0001) {
    return textureSampleLevel(video_texture, video_sampler, input.uv, 0.0);
  }

  let normalized = color / weight_sum;
  return vec4f(clamp(normalized.rgb, vec3f(0.0), vec3f(1.0)), normalized.a);
}
