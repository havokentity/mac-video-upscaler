struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
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

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return textureSampleLevel(video_texture, video_sampler, input.uv, 0.0);
}
