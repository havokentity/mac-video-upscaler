/*
 * FidelityFX FSR 1 inspired WebGPU port.
 *
 * Based on AMD FidelityFX Super Resolution 1.0 ffx_fsr1.h
 * Copyright (c) 2021 Advanced Micro Devices, Inc. MIT licensed.
 * Local port copyright (c) 2026 Rajesh Peter D'Monte, MIT licensed.
 *
 * This keeps the upstream EASU 12-tap directional Lanczos-like structure and
 * RCAS limiter/noise-aware lobe, adapted from gather callbacks to ordinary
 * textureSampleLevel calls for WebGPU video textures.
 */

struct CrispParams {
  source_size: vec2f,
  output_size: vec2f,
  sharpness_and_scale: vec2f,
};

struct EasuAccum {
  dir: vec2f,
  len: f32,
};

@group(0) @binding(0) var video_sampler: sampler;
@group(0) @binding(1) var input_texture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: CrispParams;
@group(0) @binding(3) var output_texture: texture_storage_2d<rgba8unorm, write>;

fn luma(color: vec3f) -> f32 {
  return color.b * 0.5 + (color.r * 0.5 + color.g);
}

fn sample_source(pixel: vec2f) -> vec3f {
  let clamped = clamp(pixel, vec2f(0.0), params.source_size - vec2f(1.0));
  let uv = (clamped + vec2f(0.5)) / params.source_size;
  return textureSampleLevel(input_texture, video_sampler, uv, 0.0).rgb;
}

fn sample_output(pixel: vec2f) -> vec3f {
  let clamped = clamp(pixel, vec2f(0.0), params.output_size - vec2f(1.0));
  let uv = (clamped + vec2f(0.5)) / params.output_size;
  return textureSampleLevel(input_texture, video_sampler, uv, 0.0).rgb;
}

fn easu_set(accum: EasuAccum, weight: f32, l_a: f32, l_b: f32, l_c: f32, l_d: f32, l_e: f32) -> EasuAccum {
  var next = accum;
  let dc = l_d - l_c;
  let cb = l_c - l_b;
  let len_x_base = max(abs(dc), abs(cb));
  let dir_x = l_d - l_b;
  var len_x = clamp(abs(dir_x) / max(len_x_base, 0.0001), 0.0, 1.0);
  len_x *= len_x;
  next.dir.x += dir_x * weight;
  next.len += len_x * weight;

  let ec = l_e - l_c;
  let ca = l_c - l_a;
  let len_y_base = max(abs(ec), abs(ca));
  let dir_y = l_e - l_a;
  var len_y = clamp(abs(dir_y) / max(len_y_base, 0.0001), 0.0, 1.0);
  len_y *= len_y;
  next.dir.y += dir_y * weight;
  next.len += len_y * weight;
  return next;
}

fn easu_tap_weight(off: vec2f, dir: vec2f, len2: vec2f, lob: f32, clp: f32) -> f32 {
  var v = vec2f(
    off.x * dir.x + off.y * dir.y,
    off.x * -dir.y + off.y * dir.x,
  );
  v *= len2;
  let d2 = min(dot(v, v), clp);
  var wb = 0.4 * d2 - 1.0;
  var wa = lob * d2 - 1.0;
  wb *= wb;
  wa *= wa;
  wb = 1.5625 * wb - 0.5625;
  return wb * wa;
}

@compute @workgroup_size(8, 8, 1)
fn easu_main(@builtin(global_invocation_id) invocation_id: vec3u) {
  let pixel = invocation_id.xy;
  let output_size = vec2u(params.output_size);

  if (pixel.x >= output_size.x || pixel.y >= output_size.y) {
    return;
  }

  let ip = vec2f(pixel);
  var pp = ip * (params.source_size / params.output_size) +
    (0.5 * params.source_size / params.output_size - vec2f(0.5));
  let fp = floor(pp);
  pp -= fp;

  let b = sample_source(fp + vec2f(0.0, -1.0));
  let c = sample_source(fp + vec2f(1.0, -1.0));
  let e = sample_source(fp + vec2f(-1.0, 0.0));
  let f = sample_source(fp + vec2f(0.0, 0.0));
  let g = sample_source(fp + vec2f(1.0, 0.0));
  let h = sample_source(fp + vec2f(2.0, 0.0));
  let i = sample_source(fp + vec2f(-1.0, 1.0));
  let j = sample_source(fp + vec2f(0.0, 1.0));
  let k = sample_source(fp + vec2f(1.0, 1.0));
  let l = sample_source(fp + vec2f(2.0, 1.0));
  let n = sample_source(fp + vec2f(0.0, 2.0));
  let o = sample_source(fp + vec2f(1.0, 2.0));

  let b_l = luma(b);
  let c_l = luma(c);
  let e_l = luma(e);
  let f_l = luma(f);
  let g_l = luma(g);
  let h_l = luma(h);
  let i_l = luma(i);
  let j_l = luma(j);
  let k_l = luma(k);
  let l_l = luma(l);
  let n_l = luma(n);
  let o_l = luma(o);

  var accum = EasuAccum(vec2f(0.0), 0.0);
  accum = easu_set(accum, (1.0 - pp.x) * (1.0 - pp.y), b_l, e_l, f_l, g_l, j_l);
  accum = easu_set(accum, pp.x * (1.0 - pp.y), c_l, f_l, g_l, h_l, k_l);
  accum = easu_set(accum, (1.0 - pp.x) * pp.y, f_l, i_l, j_l, k_l, n_l);
  accum = easu_set(accum, pp.x * pp.y, g_l, j_l, k_l, l_l, o_l);

  var dir = accum.dir;
  let dir2 = dot(dir, dir);
  if (dir2 < 1.0 / 32768.0) {
    dir = vec2f(1.0, 0.0);
  } else {
    dir *= inverseSqrt(dir2);
  }

  var len = accum.len * 0.5;
  len *= len;
  let stretch = dot(dir, dir) / max(max(abs(dir.x), abs(dir.y)), 0.0001);
  let len2 = vec2f(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  let lob = 0.5 + ((0.25 - 0.04) - 0.5) * len;
  let clp = 1.0 / lob;

  let min4 = min(min(f, g), min(j, k));
  let max4 = max(max(f, g), max(j, k));
  var color = vec3f(0.0);
  var weight = 0.0;

  let wb = easu_tap_weight(vec2f(0.0, -1.0) - pp, dir, len2, lob, clp);
  color += b * wb; weight += wb;
  let wc = easu_tap_weight(vec2f(1.0, -1.0) - pp, dir, len2, lob, clp);
  color += c * wc; weight += wc;
  let wi = easu_tap_weight(vec2f(-1.0, 1.0) - pp, dir, len2, lob, clp);
  color += i * wi; weight += wi;
  let wj = easu_tap_weight(vec2f(0.0, 1.0) - pp, dir, len2, lob, clp);
  color += j * wj; weight += wj;
  let wf = easu_tap_weight(vec2f(0.0, 0.0) - pp, dir, len2, lob, clp);
  color += f * wf; weight += wf;
  let we = easu_tap_weight(vec2f(-1.0, 0.0) - pp, dir, len2, lob, clp);
  color += e * we; weight += we;
  let wk = easu_tap_weight(vec2f(1.0, 1.0) - pp, dir, len2, lob, clp);
  color += k * wk; weight += wk;
  let wl = easu_tap_weight(vec2f(2.0, 1.0) - pp, dir, len2, lob, clp);
  color += l * wl; weight += wl;
  let wh = easu_tap_weight(vec2f(2.0, 0.0) - pp, dir, len2, lob, clp);
  color += h * wh; weight += wh;
  let wg = easu_tap_weight(vec2f(1.0, 0.0) - pp, dir, len2, lob, clp);
  color += g * wg; weight += wg;
  let wo = easu_tap_weight(vec2f(1.0, 2.0) - pp, dir, len2, lob, clp);
  color += o * wo; weight += wo;
  let wn = easu_tap_weight(vec2f(0.0, 2.0) - pp, dir, len2, lob, clp);
  color += n * wn; weight += wn;

  let resolved = clamp(color / max(weight, 0.0001), min4, max4);
  textureStore(output_texture, pixel, vec4f(resolved, 1.0));
}

@compute @workgroup_size(8, 8, 1)
fn rcas_main(@builtin(global_invocation_id) invocation_id: vec3u) {
  let pixel = invocation_id.xy;
  let output_size = vec2u(params.output_size);

  if (pixel.x >= output_size.x || pixel.y >= output_size.y) {
    return;
  }

  let ip = vec2f(pixel);
  let scale_ratio = min(params.output_size.x / params.source_size.x, params.output_size.y / params.source_size.y);
  let tiny_source_boost = smoothstep(3.0, 10.0, scale_ratio);
  let sample_radius = mix(1.0, 2.25, tiny_source_boost);
  let b = sample_output(ip + vec2f(0.0, -sample_radius));
  let d = sample_output(ip + vec2f(-sample_radius, 0.0));
  let e = sample_output(ip);
  let f = sample_output(ip + vec2f(sample_radius, 0.0));
  let h = sample_output(ip + vec2f(0.0, sample_radius));

  let b_l = luma(b);
  let d_l = luma(d);
  let e_l = luma(e);
  let f_l = luma(f);
  let h_l = luma(h);
  let range_max = max(max(max(b_l, d_l), max(e_l, f_l)), h_l);
  let range_min = min(min(min(b_l, d_l), min(e_l, f_l)), h_l);
  var noise = abs(0.25 * (b_l + d_l + f_l + h_l) - e_l) / max(range_max - range_min, 0.0001);
  noise = 1.0 - 0.5 * clamp(noise, 0.0, 1.0);

  let mn4 = min(min(b, d), min(f, h));
  let mx4 = max(max(b, d), max(f, h));
  let hit_min = min(mn4, e) / max(4.0 * mx4, vec3f(0.0001));
  let hit_max = (vec3f(1.0) - max(mx4, e)) / min(4.0 * mn4 - vec3f(4.0), vec3f(-0.0001));
  let lobe_rgb = max(-hit_min, hit_max);
  let user_sharpness = clamp(params.sharpness_and_scale.x, 0.0, 1.0);
  let sharpness = mix(0.45, 1.05, user_sharpness);
  let base_lobe = min(max(lobe_rgb.r, max(lobe_rgb.g, lobe_rgb.b)), 0.0);
  let lobe = max(-0.1875, base_lobe * sharpness * noise);
  let rcp_l = 1.0 / (4.0 * lobe + 1.0);
  var out_color = clamp((lobe * (b + d + h + f) + e) * rcp_l, vec3f(0.0), vec3f(1.0));
  let high_pass = e - 0.25 * (b + d + f + h);
  let edge_mask = smoothstep(0.012, 0.16, range_max - range_min);
  let detail_strength = (mix(0.12, 0.55, user_sharpness) + tiny_source_boost * 0.22) * edge_mask;
  let contrast_strength = 0.035 * user_sharpness;
  let guard = vec3f(mix(0.025, 0.075, max(user_sharpness, tiny_source_boost)));
  out_color = clamp(
    out_color + high_pass * detail_strength + (e - 0.5) * contrast_strength * edge_mask,
    max(vec3f(0.0), min(mn4, e) - guard),
    min(vec3f(1.0), max(mx4, e) + guard),
  );
  textureStore(output_texture, pixel, vec4f(out_color, 1.0));
}
