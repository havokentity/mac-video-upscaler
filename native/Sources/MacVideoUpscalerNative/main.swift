/*
 * Copyright (c) 2026 Rajesh Peter D'Monte
 * SPDX-License-Identifier: MIT
 */

import AVFoundation
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import Metal

enum NativeUpscaleMode: String {
  case crisp
  case rescue
  case smooth
  case sharpen
}

struct NativeUpscaleOptions {
  var inputURL: URL?
  var outputURL: URL?
  var mode: NativeUpscaleMode = .crisp
  var scale: Double = 2.0
  var sharpness: Double = 0.75
  var bitrate: Int?
  var openCompare = false
}

enum NativeUpscaleError: Error, CustomStringConvertible {
  case invalidArguments(String)
  case missingVideoTrack
  case readerCannotAddTrack
  case writerCannotAddInput
  case pixelBufferPoolUnavailable
  case pixelBufferAllocationFailed
  case sampleMissingImageBuffer
  case readerFailed(String)
  case writerFailed(String)
  case metalUnavailable
  case metalPipelineFailed(String)
  case metalTextureFailed(String)

  var description: String {
    switch self {
    case .invalidArguments(let message):
      return message
    case .missingVideoTrack:
      return "Input asset does not contain a video track."
    case .readerCannotAddTrack:
      return "AVAssetReader could not add the video track output."
    case .writerCannotAddInput:
      return "AVAssetWriter could not add the video input."
    case .pixelBufferPoolUnavailable:
      return "AVAssetWriter did not create a pixel buffer pool."
    case .pixelBufferAllocationFailed:
      return "Could not allocate an output pixel buffer."
    case .sampleMissingImageBuffer:
      return "Decoded sample did not contain a CVPixelBuffer."
    case .readerFailed(let message):
      return "Reader failed: \(message)"
    case .writerFailed(let message):
      return "Writer failed: \(message)"
    case .metalUnavailable:
      return "Metal is unavailable on this Mac."
    case .metalPipelineFailed(let message):
      return "Metal pipeline failed: \(message)"
    case .metalTextureFailed(let message):
      return "Metal texture failed: \(message)"
    }
  }
}

@main
struct MacVideoUpscalerNative {
  static func main() async {
    do {
      let options = try parseArguments(CommandLine.arguments)
      try await upscaleVideo(options: options)
    } catch {
      fputs("mac-video-upscaler-native: \(error)\n\n", stderr)
      fputs(Self.usage, stderr)
      exit(1)
    }
  }

  private static let usage = """
  Usage:
    swift run mac-video-upscaler-native --input input.mp4 --output output.mp4 [options]

  Options:
    --mode crisp|rescue|smooth|sharpen
                                   Upscale/enhance mode. Default: crisp.
    --scale 1.0...4.0             Output scale. Default: 2.0.
    --sharpness 0.0...2.0         Enhancement strength. Default: 0.75.
    --bitrate bits                Optional H.264 average bitrate.
    --open-compare                Open the generated side-by-side compare page.

  Notes:
    This native bench is video-only for now. It intentionally avoids browser,
    DOM, canvas, and YouTube compositor behavior so we can judge the algorithm.

  """
}

func parseArguments(_ arguments: [String]) throws -> NativeUpscaleOptions {
  var options = NativeUpscaleOptions()
  var index = 1

  func requireValue(after flag: String) throws -> String {
    guard index + 1 < arguments.count else {
      throw NativeUpscaleError.invalidArguments("Missing value after \(flag).")
    }
    index += 1
    return arguments[index]
  }

  while index < arguments.count {
    let argument = arguments[index]
    switch argument {
    case "--input", "-i":
      options.inputURL = URL(fileURLWithPath: try requireValue(after: argument))
    case "--output", "-o":
      options.outputURL = URL(fileURLWithPath: try requireValue(after: argument))
    case "--mode":
      let value = try requireValue(after: argument)
      guard let mode = NativeUpscaleMode(rawValue: value) else {
        throw NativeUpscaleError.invalidArguments("Unknown mode: \(value).")
      }
      options.mode = mode
    case "--scale":
      let value = try requireValue(after: argument)
      guard let scale = Double(value), scale.isFinite, scale >= 1.0, scale <= 4.0 else {
        throw NativeUpscaleError.invalidArguments("--scale must be between 1.0 and 4.0.")
      }
      options.scale = scale
    case "--sharpness":
      let value = try requireValue(after: argument)
      guard let sharpness = Double(value), sharpness.isFinite, sharpness >= 0.0, sharpness <= 2.0 else {
        throw NativeUpscaleError.invalidArguments("--sharpness must be between 0.0 and 2.0.")
      }
      options.sharpness = sharpness
    case "--bitrate":
      let value = try requireValue(after: argument)
      guard let bitrate = Int(value), bitrate > 0 else {
        throw NativeUpscaleError.invalidArguments("--bitrate must be a positive integer.")
      }
      options.bitrate = bitrate
    case "--open-compare":
      options.openCompare = true
    case "--help", "-h":
      throw NativeUpscaleError.invalidArguments("")
    default:
      throw NativeUpscaleError.invalidArguments("Unknown argument: \(argument).")
    }
    index += 1
  }

  guard options.inputURL != nil else {
    throw NativeUpscaleError.invalidArguments("--input is required.")
  }

  guard options.outputURL != nil else {
    throw NativeUpscaleError.invalidArguments("--output is required.")
  }

  return options
}

func upscaleVideo(options: NativeUpscaleOptions) async throws {
  guard let inputURL = options.inputURL, let outputURL = options.outputURL else {
    throw NativeUpscaleError.invalidArguments("--input and --output are required.")
  }

  guard let metalDevice = MTLCreateSystemDefaultDevice() else {
    throw NativeUpscaleError.metalUnavailable
  }

  if FileManager.default.fileExists(atPath: outputURL.path) {
    try FileManager.default.removeItem(at: outputURL)
  }

  let asset = AVURLAsset(url: inputURL)
  let videoTracks = try await asset.loadTracks(withMediaType: .video)
  guard let videoTrack = videoTracks.first else {
    throw NativeUpscaleError.missingVideoTrack
  }

  let naturalSize = try await videoTrack.load(.naturalSize)
  let preferredTransform = try await videoTrack.load(.preferredTransform)
  let frameRate = try await videoTrack.load(.nominalFrameRate)
  let duration = try await asset.load(.duration)
  let displaySize = orientedDisplaySize(naturalSize: naturalSize, transform: preferredTransform)
  let outputSize = evenSize(width: displaySize.width * options.scale, height: displaySize.height * options.scale)
  let bitrate = options.bitrate ?? defaultBitrate(width: outputSize.width, height: outputSize.height, frameRate: frameRate)

  print("Input:  \(inputURL.path)")
  print("Output: \(outputURL.path)")
  print("Mode:   \(options.mode.rawValue), scale \(String(format: "%.2f", options.scale))x, sharpness \(String(format: "%.2f", options.sharpness))")
  print("Size:   \(Int(displaySize.width))x\(Int(displaySize.height)) -> \(Int(outputSize.width))x\(Int(outputSize.height))")

  let reader = try AVAssetReader(asset: asset)
  let readerOutput = AVAssetReaderTrackOutput(
    track: videoTrack,
    outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferMetalCompatibilityKey as String: true,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ]
  )
  readerOutput.alwaysCopiesSampleData = false

  guard reader.canAdd(readerOutput) else {
    throw NativeUpscaleError.readerCannotAddTrack
  }
  reader.add(readerOutput)

  let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
  let writerInput = AVAssetWriterInput(
    mediaType: .video,
    outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: Int(outputSize.width),
      AVVideoHeightKey: Int(outputSize.height),
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      ],
    ]
  )
  writerInput.expectsMediaDataInRealTime = false

  let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: writerInput,
    sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: Int(outputSize.width),
      kCVPixelBufferHeightKey as String: Int(outputSize.height),
      kCVPixelBufferMetalCompatibilityKey as String: true,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ]
  )

  guard writer.canAdd(writerInput) else {
    throw NativeUpscaleError.writerCannotAddInput
  }
  writer.add(writerInput)

  let context = CIContext(mtlDevice: metalDevice, options: [
    .workingColorSpace: CGColorSpaceCreateDeviceRGB(),
    .outputColorSpace: CGColorSpaceCreateDeviceRGB(),
  ])
  let fsrProcessor =
    options.mode == .crisp
    ? try NativeMetalFSRProcessor(device: metalDevice, outputSize: outputSize, sharpness: options.sharpness)
    : nil

  guard reader.startReading() else {
    throw NativeUpscaleError.readerFailed(reader.error?.localizedDescription ?? "unknown error")
  }

  guard writer.startWriting() else {
    throw NativeUpscaleError.writerFailed(writer.error?.localizedDescription ?? "unknown error")
  }
  writer.startSession(atSourceTime: .zero)

  guard let pixelBufferPool = adaptor.pixelBufferPool else {
    throw NativeUpscaleError.pixelBufferPoolUnavailable
  }

  var frameCount = 0
  var lastProgressTime = CFAbsoluteTimeGetCurrent()
  let durationSeconds = max(0.001, CMTimeGetSeconds(duration))
  let renderBounds = CGRect(origin: .zero, size: outputSize)
  let colorSpace = CGColorSpaceCreateDeviceRGB()

  while let sampleBuffer = readerOutput.copyNextSampleBuffer() {
    guard let sourcePixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      throw NativeUpscaleError.sampleMissingImageBuffer
    }

    let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let sourceImage = normalizedImage(
      from: sourcePixelBuffer,
      preferredTransform: preferredTransform
    )
    var outputPixelBuffer: CVPixelBuffer?
    let allocationStatus = CVPixelBufferPoolCreatePixelBuffer(nil, pixelBufferPool, &outputPixelBuffer)
    guard allocationStatus == kCVReturnSuccess, let outputPixelBuffer else {
      throw NativeUpscaleError.pixelBufferAllocationFailed
    }

    if let fsrProcessor {
      let normalizedSource = try makePixelBuffer(size: displaySize)
      context.render(
        sourceImage,
        to: normalizedSource,
        bounds: CGRect(origin: .zero, size: displaySize),
        colorSpace: colorSpace
      )
      try fsrProcessor.process(
        sourcePixelBuffer: normalizedSource,
        outputPixelBuffer: outputPixelBuffer,
        ciContext: context,
        colorSpace: colorSpace
      )
    } else {
      let outputImage = processFrame(
        sourceImage,
        mode: options.mode,
        outputSize: outputSize,
        scale: options.scale,
        sharpness: options.sharpness
      )
      context.render(outputImage, to: outputPixelBuffer, bounds: renderBounds, colorSpace: colorSpace)
    }

    while !writerInput.isReadyForMoreMediaData {
      try await Task.sleep(nanoseconds: 2_000_000)
    }

    if !adaptor.append(outputPixelBuffer, withPresentationTime: presentationTime) {
      throw NativeUpscaleError.writerFailed(writer.error?.localizedDescription ?? "append failed")
    }

    frameCount += 1
    let now = CFAbsoluteTimeGetCurrent()
    if now - lastProgressTime > 1.0 {
      let progress = min(100.0, max(0.0, CMTimeGetSeconds(presentationTime) / durationSeconds * 100.0))
      print("Progress: \(String(format: "%.1f", progress))% (\(frameCount) frames)")
      lastProgressTime = now
    }
  }

  if reader.status == .failed {
    throw NativeUpscaleError.readerFailed(reader.error?.localizedDescription ?? "unknown error")
  }

  writerInput.markAsFinished()

  try await finishWriting(writer)

  if writer.status != .completed {
    throw NativeUpscaleError.writerFailed(writer.error?.localizedDescription ?? "unknown error")
  }

  let lastCompareURL = try writeLastRunComparePage(inputURL: inputURL, outputURL: outputURL, options: options)
  if options.openCompare {
    try openInDefaultBrowser(lastCompareURL)
  }
  print("Done: \(frameCount) frames")
}

func writeLastRunComparePage(
  inputURL: URL,
  outputURL: URL,
  options: NativeUpscaleOptions
) throws -> URL {
  let compareDirectory = findCompareDirectory()
  try FileManager.default.createDirectory(at: compareDirectory, withIntermediateDirectories: true)

  let lastRunURL = compareDirectory.appendingPathComponent("last-run.json")
  let lastCompareURL = compareDirectory.appendingPathComponent("last-compare.html")
  let createdAt = ISO8601DateFormatter().string(from: Date())
  let json = """
  {
    "createdAt": "\(escapeJSON(createdAt))",
    "input": "\(escapeJSON(inputURL.path))",
    "output": "\(escapeJSON(outputURL.path))",
    "mode": "\(escapeJSON(options.mode.rawValue))",
    "scale": \(String(format: "%.3f", options.scale)),
    "sharpness": \(String(format: "%.3f", options.sharpness))
  }
  """
  try json.write(to: lastRunURL, atomically: true, encoding: .utf8)

  let html = """
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Last Native Upscale Compare</title>
      <style>
        :root { color-scheme: dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #070b10; color: #f8fafc; }
        body { margin: 0; min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; background: #070b10; }
        header, footer { padding: 12px 16px; border-color: rgb(255 255 255 / 12%); }
        header { border-bottom: 1px solid rgb(255 255 255 / 12%); display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; }
        h1 { margin: 0; font-size: 16px; }
        main { min-height: 0; display: grid; grid-template-columns: 1fr 1fr; }
        section { min-width: 0; display: grid; grid-template-rows: auto 1fr; border-right: 1px solid rgb(255 255 255 / 12%); }
        section:last-child { border-right: 0; }
        .title { padding: 10px 12px; background: rgb(255 255 255 / 5%); color: #cbd5e1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        video { width: 100%; height: 100%; min-height: 0; object-fit: contain; background: #000; }
        footer { border-top: 1px solid rgb(255 255 255 / 12%); display: grid; grid-template-columns: auto auto auto 1fr auto; gap: 10px; align-items: center; }
        button, select { min-height: 34px; border: 1px solid rgb(255 255 255 / 14%); border-radius: 6px; background: #172033; color: #f8fafc; font: inherit; }
        button { min-width: 38px; cursor: pointer; }
        input[type="range"] { width: 100%; }
        .time { min-width: 112px; text-align: right; font-variant-numeric: tabular-nums; color: #cbd5e1; }
        @media (max-width: 820px) { main { grid-template-columns: 1fr; } section { min-height: 40vh; border-right: 0; border-bottom: 1px solid rgb(255 255 255 / 12%); } footer { grid-template-columns: 1fr; } .time { text-align: left; } }
      </style>
    </head>
    <body>
      <header>
        <h1>Last Native Upscale Compare</h1>
        <div>\(escapeHTML(options.mode.rawValue)) · \(String(format: "%.2f", options.scale))x · sharpness \(String(format: "%.2f", options.sharpness))</div>
      </header>
      <main>
        <section>
          <div class="title">Original: \(escapeHTML(inputURL.lastPathComponent))</div>
          <video id="left" src="\(escapeHTMLAttribute(inputURL.absoluteString))" playsinline muted></video>
        </section>
        <section>
          <div class="title">Upscaled: \(escapeHTML(outputURL.lastPathComponent))</div>
          <video id="right" src="\(escapeHTMLAttribute(outputURL.absoluteString))" playsinline muted></video>
        </section>
      </main>
      <footer>
        <button id="play" type="button">▶</button>
        <button id="back" type="button">‹</button>
        <button id="forward" type="button">›</button>
        <input id="scrub" type="range" min="0" max="1" step="0.001" value="0" />
        <div id="time" class="time">0.00 / 0.00</div>
      </footer>
      <script>
        const left = document.querySelector('#left');
        const right = document.querySelector('#right');
        const play = document.querySelector('#play');
        const back = document.querySelector('#back');
        const forward = document.querySelector('#forward');
        const scrub = document.querySelector('#scrub');
        const time = document.querySelector('#time');
        let syncing = false;
        const syncTime = (source, target) => {
          if (syncing || Math.abs(target.currentTime - source.currentTime) < 0.04) return;
          syncing = true;
          target.currentTime = source.currentTime;
          syncing = false;
        };
        const update = () => {
          const duration = Math.max(left.duration || 0, right.duration || 0);
          const current = Math.max(left.currentTime || 0, right.currentTime || 0);
          scrub.max = String(Math.max(0.001, duration));
          scrub.value = String(Math.min(duration, current));
          time.textContent = `${current.toFixed(2)} / ${duration.toFixed(2)}`;
          play.textContent = left.paused && right.paused ? '▶' : 'Ⅱ';
          requestAnimationFrame(update);
        };
        left.addEventListener('timeupdate', () => syncTime(left, right));
        right.addEventListener('timeupdate', () => syncTime(right, left));
        play.addEventListener('click', async () => {
          if (left.paused && right.paused) {
            const next = Math.max(left.currentTime, right.currentTime);
            left.currentTime = next;
            right.currentTime = next;
            await Promise.allSettled([left.play(), right.play()]);
          } else {
            left.pause();
            right.pause();
          }
        });
        back.addEventListener('click', () => {
          const next = Math.max(0, Math.max(left.currentTime, right.currentTime) - 1 / 30);
          left.currentTime = next;
          right.currentTime = next;
        });
        forward.addEventListener('click', () => {
          const next = Math.max(left.currentTime, right.currentTime) + 1 / 30;
          left.currentTime = next;
          right.currentTime = next;
        });
        scrub.addEventListener('input', () => {
          left.currentTime = Number(scrub.value);
          right.currentTime = Number(scrub.value);
        });
        update();
      </script>
    </body>
  </html>
  """
  try html.write(to: lastCompareURL, atomically: true, encoding: .utf8)

  print("Compare: \(lastCompareURL.path)")
  return lastCompareURL
}

func openInDefaultBrowser(_ url: URL) throws {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  process.arguments = [url.path]
  try process.run()
}

func findCompareDirectory() -> URL {
  let current = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
  let nativeFromRoot = current.appendingPathComponent("native/compare.html")
  if FileManager.default.fileExists(atPath: nativeFromRoot.path) {
    return current.appendingPathComponent("native")
  }

  let compareInCurrent = current.appendingPathComponent("compare.html")
  if FileManager.default.fileExists(atPath: compareInCurrent.path) {
    return current
  }

  return current
}

func escapeJSON(_ value: String) -> String {
  value
    .replacingOccurrences(of: "\\", with: "\\\\")
    .replacingOccurrences(of: "\"", with: "\\\"")
    .replacingOccurrences(of: "\n", with: "\\n")
}

func escapeHTML(_ value: String) -> String {
  value
    .replacingOccurrences(of: "&", with: "&amp;")
    .replacingOccurrences(of: "<", with: "&lt;")
    .replacingOccurrences(of: ">", with: "&gt;")
}

func escapeHTMLAttribute(_ value: String) -> String {
  escapeHTML(value)
    .replacingOccurrences(of: "\"", with: "&quot;")
}

func finishWriting(_ writer: AVAssetWriter) async throws {
  await withCheckedContinuation { continuation in
    writer.finishWriting {
      continuation.resume()
    }
  }
}

final class NativeMetalFSRProcessor {
  private let device: MTLDevice
  private let commandQueue: MTLCommandQueue
  private let easuPipeline: MTLComputePipelineState
  private let rcasPipeline: MTLComputePipelineState
  private let intermediateTexture: MTLTexture
  private let outputTexture: MTLTexture
  private var textureCache: CVMetalTextureCache?
  private var params = FSRParams(
    sourceSize: SIMD2<Float>(1, 1),
    outputSize: SIMD2<Float>(1, 1),
    sharpness: 0.75,
    scale: 2.0
  )

  init(device: MTLDevice, outputSize: CGSize, sharpness: Double) throws {
    self.device = device

    guard let commandQueue = device.makeCommandQueue() else {
      throw NativeUpscaleError.metalPipelineFailed("could not create command queue")
    }
    self.commandQueue = commandQueue

    let library: MTLLibrary
    do {
      library = try device.makeLibrary(source: metalFSR1Source, options: nil)
    } catch {
      throw NativeUpscaleError.metalPipelineFailed(error.localizedDescription)
    }

    guard let easuFunction = library.makeFunction(name: "fsr1_easu"),
          let rcasFunction = library.makeFunction(name: "fsr1_rcas") else {
      throw NativeUpscaleError.metalPipelineFailed("missing FSR kernels")
    }

    do {
      easuPipeline = try device.makeComputePipelineState(function: easuFunction)
      rcasPipeline = try device.makeComputePipelineState(function: rcasFunction)
    } catch {
      throw NativeUpscaleError.metalPipelineFailed(error.localizedDescription)
    }

    let width = max(1, Int(outputSize.width))
    let height = max(1, Int(outputSize.height))
    intermediateTexture = Self.makeTexture(device: device, width: width, height: height, label: "FSR EASU texture")
    outputTexture = Self.makeTexture(device: device, width: width, height: height, label: "FSR RCAS texture")
    params.outputSize = SIMD2<Float>(Float(width), Float(height))
    params.sharpness = Float(max(0.0, min(2.0, sharpness)))
    params.scale = Float(max(1.0, min(4.0, outputSize.width)))

    let cacheStatus = CVMetalTextureCacheCreate(nil, nil, device, nil, &textureCache)
    guard cacheStatus == kCVReturnSuccess else {
      throw NativeUpscaleError.metalTextureFailed("could not create CVMetalTextureCache")
    }
  }

  func process(
    sourcePixelBuffer: CVPixelBuffer,
    outputPixelBuffer: CVPixelBuffer,
    ciContext: CIContext,
    colorSpace: CGColorSpace
  ) throws {
    let sourceWidth = CVPixelBufferGetWidth(sourcePixelBuffer)
    let sourceHeight = CVPixelBufferGetHeight(sourcePixelBuffer)
    params.sourceSize = SIMD2<Float>(Float(sourceWidth), Float(sourceHeight))
    params.scale = min(
      params.outputSize.x / max(1, params.sourceSize.x),
      params.outputSize.y / max(1, params.sourceSize.y)
    )

    let sourceTexture = try makeTexture(
      from: sourcePixelBuffer,
      pixelFormat: .bgra8Unorm,
      width: sourceWidth,
      height: sourceHeight
    )

    guard let commandBuffer = commandQueue.makeCommandBuffer() else {
      throw NativeUpscaleError.metalPipelineFailed("could not create command buffer")
    }

    encode(
      commandBuffer: commandBuffer,
      pipeline: easuPipeline,
      input: sourceTexture,
      output: intermediateTexture
    )
    encode(
      commandBuffer: commandBuffer,
      pipeline: rcasPipeline,
      input: intermediateTexture,
      output: outputTexture
    )

    commandBuffer.commit()
    commandBuffer.waitUntilCompleted()

    if let error = commandBuffer.error {
      throw NativeUpscaleError.metalPipelineFailed(error.localizedDescription)
    }

    guard let image = CIImage(mtlTexture: outputTexture, options: [.colorSpace: colorSpace]) else {
      throw NativeUpscaleError.metalTextureFailed("could not create CIImage from Metal output")
    }

    let bounds = CGRect(x: 0, y: 0, width: outputTexture.width, height: outputTexture.height)
    ciContext.render(image, to: outputPixelBuffer, bounds: bounds, colorSpace: colorSpace)
  }

  private static func makeTexture(
    device: MTLDevice,
    width: Int,
    height: Int,
    label: String
  ) -> MTLTexture {
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .rgba8Unorm,
      width: width,
      height: height,
      mipmapped: false
    )
    descriptor.usage = [.shaderRead, .shaderWrite]
    descriptor.storageMode = .private
    let texture = device.makeTexture(descriptor: descriptor)!
    texture.label = label
    return texture
  }

  private func makeTexture(
    from pixelBuffer: CVPixelBuffer,
    pixelFormat: MTLPixelFormat,
    width: Int,
    height: Int
  ) throws -> MTLTexture {
    guard let textureCache else {
      throw NativeUpscaleError.metalTextureFailed("texture cache is unavailable")
    }

    var cvTexture: CVMetalTexture?
    let status = CVMetalTextureCacheCreateTextureFromImage(
      nil,
      textureCache,
      pixelBuffer,
      nil,
      pixelFormat,
      width,
      height,
      0,
      &cvTexture
    )
    guard status == kCVReturnSuccess,
          let cvTexture,
          let texture = CVMetalTextureGetTexture(cvTexture) else {
      throw NativeUpscaleError.metalTextureFailed("could not create Metal texture from pixel buffer")
    }

    return texture
  }

  private func encode(
    commandBuffer: MTLCommandBuffer,
    pipeline: MTLComputePipelineState,
    input: MTLTexture,
    output: MTLTexture
  ) {
    guard let encoder = commandBuffer.makeComputeCommandEncoder() else {
      return
    }

    var localParams = params
    encoder.setComputePipelineState(pipeline)
    encoder.setTexture(input, index: 0)
    encoder.setTexture(output, index: 1)
    encoder.setBytes(&localParams, length: MemoryLayout<FSRParams>.stride, index: 0)

    let threadsPerThreadgroup = MTLSize(width: 8, height: 8, depth: 1)
    let threadgroups = MTLSize(
      width: (output.width + threadsPerThreadgroup.width - 1) / threadsPerThreadgroup.width,
      height: (output.height + threadsPerThreadgroup.height - 1) / threadsPerThreadgroup.height,
      depth: 1
    )
    encoder.dispatchThreadgroups(threadgroups, threadsPerThreadgroup: threadsPerThreadgroup)
    encoder.endEncoding()
  }
}

struct FSRParams {
  var sourceSize: SIMD2<Float>
  var outputSize: SIMD2<Float>
  var sharpness: Float
  var scale: Float
}

func makePixelBuffer(size: CGSize) throws -> CVPixelBuffer {
  var pixelBuffer: CVPixelBuffer?
  let status = CVPixelBufferCreate(
    nil,
    max(1, Int(size.width)),
    max(1, Int(size.height)),
    kCVPixelFormatType_32BGRA,
    [
      kCVPixelBufferMetalCompatibilityKey as String: true,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:],
    ] as CFDictionary,
    &pixelBuffer
  )

  guard status == kCVReturnSuccess, let pixelBuffer else {
    throw NativeUpscaleError.pixelBufferAllocationFailed
  }

  return pixelBuffer
}

let metalFSR1Source = """
#include <metal_stdlib>
using namespace metal;

/*
 * FidelityFX FSR 1 inspired Metal port.
 *
 * Based on AMD FidelityFX Super Resolution 1.0 ffx_fsr1.h
 * Copyright (c) 2021 Advanced Micro Devices, Inc. MIT licensed.
 * Local Metal port copyright (c) 2026 Rajesh Peter D'Monte, MIT licensed.
 */

struct FSRParams {
  float2 sourceSize;
  float2 outputSize;
  float sharpness;
  float scale;
};

constexpr sampler linearClampSampler(coord::normalized, address::clamp_to_edge, filter::linear);

float fsr_luma(float3 color) {
  return color.b * 0.5 + (color.r * 0.5 + color.g);
}

float3 fsr_sample_source(texture2d<float, access::sample> inputTexture, constant FSRParams& params, float2 pixel) {
  float2 clampedPixel = clamp(pixel, float2(0.0), params.sourceSize - float2(1.0));
  float2 uv = (clampedPixel + float2(0.5)) / params.sourceSize;
  return inputTexture.sample(linearClampSampler, uv).rgb;
}

float3 fsr_sample_output(texture2d<float, access::sample> inputTexture, constant FSRParams& params, float2 pixel) {
  float2 clampedPixel = clamp(pixel, float2(0.0), params.outputSize - float2(1.0));
  float2 uv = (clampedPixel + float2(0.5)) / params.outputSize;
  return inputTexture.sample(linearClampSampler, uv).rgb;
}

void fsr_easu_set(thread float2& direction, thread float& length, float weight, float lA, float lB, float lC, float lD, float lE) {
  float dc = lD - lC;
  float cb = lC - lB;
  float lenXBase = max(abs(dc), abs(cb));
  float dirX = lD - lB;
  float lenX = clamp(abs(dirX) / max(lenXBase, 0.0001), 0.0, 1.0);
  direction.x += dirX * weight;
  length += lenX * lenX * weight;

  float ec = lE - lC;
  float ca = lC - lA;
  float lenYBase = max(abs(ec), abs(ca));
  float dirY = lE - lA;
  float lenY = clamp(abs(dirY) / max(lenYBase, 0.0001), 0.0, 1.0);
  direction.y += dirY * weight;
  length += lenY * lenY * weight;
}

float fsr_easu_tap_weight(float2 offset, float2 direction, float2 len2, float lob, float clipValue) {
  float2 v = float2(
    offset.x * direction.x + offset.y * direction.y,
    offset.x * -direction.y + offset.y * direction.x
  );
  v *= len2;
  float d2 = min(dot(v, v), clipValue);
  float wb = 0.4 * d2 - 1.0;
  float wa = lob * d2 - 1.0;
  wb *= wb;
  wa *= wa;
  wb = 1.5625 * wb - 0.5625;
  return wb * wa;
}

kernel void fsr1_easu(
  texture2d<float, access::sample> inputTexture [[texture(0)]],
  texture2d<float, access::write> outputTexture [[texture(1)]],
  constant FSRParams& params [[buffer(0)]],
  uint2 pixel [[thread_position_in_grid]]
) {
  if (pixel.x >= uint(params.outputSize.x) || pixel.y >= uint(params.outputSize.y)) {
    return;
  }

  float2 pp = (float2(pixel) + float2(0.5)) * (params.sourceSize / params.outputSize) - float2(0.5);
  float2 fp = floor(pp);
  pp -= fp;

  float3 b = fsr_sample_source(inputTexture, params, fp + float2(0.0, -1.0));
  float3 c = fsr_sample_source(inputTexture, params, fp + float2(1.0, -1.0));
  float3 e = fsr_sample_source(inputTexture, params, fp + float2(-1.0, 0.0));
  float3 f = fsr_sample_source(inputTexture, params, fp + float2(0.0, 0.0));
  float3 g = fsr_sample_source(inputTexture, params, fp + float2(1.0, 0.0));
  float3 h = fsr_sample_source(inputTexture, params, fp + float2(2.0, 0.0));
  float3 i = fsr_sample_source(inputTexture, params, fp + float2(-1.0, 1.0));
  float3 j = fsr_sample_source(inputTexture, params, fp + float2(0.0, 1.0));
  float3 k = fsr_sample_source(inputTexture, params, fp + float2(1.0, 1.0));
  float3 l = fsr_sample_source(inputTexture, params, fp + float2(2.0, 1.0));
  float3 n = fsr_sample_source(inputTexture, params, fp + float2(0.0, 2.0));
  float3 o = fsr_sample_source(inputTexture, params, fp + float2(1.0, 2.0));

  float bL = fsr_luma(b);
  float cL = fsr_luma(c);
  float eL = fsr_luma(e);
  float fL = fsr_luma(f);
  float gL = fsr_luma(g);
  float hL = fsr_luma(h);
  float iL = fsr_luma(i);
  float jL = fsr_luma(j);
  float kL = fsr_luma(k);
  float lL = fsr_luma(l);
  float nL = fsr_luma(n);
  float oL = fsr_luma(o);

  float2 direction = float2(0.0);
  float length = 0.0;
  fsr_easu_set(direction, length, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  fsr_easu_set(direction, length, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  fsr_easu_set(direction, length, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  fsr_easu_set(direction, length, pp.x * pp.y, gL, jL, kL, lL, oL);

  float directionLength = dot(direction, direction);
  if (directionLength < 1.0 / 32768.0) {
    direction = float2(1.0, 0.0);
  } else {
    direction *= rsqrt(directionLength);
  }

  length *= 0.5;
  length *= length;
  float stretch = dot(direction, direction) / max(max(abs(direction.x), abs(direction.y)), 0.0001);
  float2 len2 = float2(1.0 + (stretch - 1.0) * length, 1.0 - 0.5 * length);
  float lob = 0.5 + ((0.25 - 0.04) - 0.5) * length;
  float clipValue = 1.0 / lob;

  float3 min4 = min(min(f, g), min(j, k));
  float3 max4 = max(max(f, g), max(j, k));
  float3 color = float3(0.0);
  float weight = 0.0;

  float wb = fsr_easu_tap_weight(float2(0.0, -1.0) - pp, direction, len2, lob, clipValue);
  color += b * wb; weight += wb;
  float wc = fsr_easu_tap_weight(float2(1.0, -1.0) - pp, direction, len2, lob, clipValue);
  color += c * wc; weight += wc;
  float wi = fsr_easu_tap_weight(float2(-1.0, 1.0) - pp, direction, len2, lob, clipValue);
  color += i * wi; weight += wi;
  float wj = fsr_easu_tap_weight(float2(0.0, 1.0) - pp, direction, len2, lob, clipValue);
  color += j * wj; weight += wj;
  float wf = fsr_easu_tap_weight(float2(0.0, 0.0) - pp, direction, len2, lob, clipValue);
  color += f * wf; weight += wf;
  float we = fsr_easu_tap_weight(float2(-1.0, 0.0) - pp, direction, len2, lob, clipValue);
  color += e * we; weight += we;
  float wk = fsr_easu_tap_weight(float2(1.0, 1.0) - pp, direction, len2, lob, clipValue);
  color += k * wk; weight += wk;
  float wl = fsr_easu_tap_weight(float2(2.0, 1.0) - pp, direction, len2, lob, clipValue);
  color += l * wl; weight += wl;
  float wh = fsr_easu_tap_weight(float2(2.0, 0.0) - pp, direction, len2, lob, clipValue);
  color += h * wh; weight += wh;
  float wg = fsr_easu_tap_weight(float2(1.0, 0.0) - pp, direction, len2, lob, clipValue);
  color += g * wg; weight += wg;
  float wo = fsr_easu_tap_weight(float2(1.0, 2.0) - pp, direction, len2, lob, clipValue);
  color += o * wo; weight += wo;
  float wn = fsr_easu_tap_weight(float2(0.0, 2.0) - pp, direction, len2, lob, clipValue);
  color += n * wn; weight += wn;

  float3 resolved = clamp(color / max(weight, 0.0001), min4, max4);
  outputTexture.write(float4(resolved, 1.0), pixel);
}

kernel void fsr1_rcas(
  texture2d<float, access::sample> inputTexture [[texture(0)]],
  texture2d<float, access::write> outputTexture [[texture(1)]],
  constant FSRParams& params [[buffer(0)]],
  uint2 pixel [[thread_position_in_grid]]
) {
  if (pixel.x >= uint(params.outputSize.x) || pixel.y >= uint(params.outputSize.y)) {
    return;
  }

  float2 ip = float2(pixel);
  float scaleRatio = min(params.outputSize.x / params.sourceSize.x, params.outputSize.y / params.sourceSize.y);
  float tinySourceBoost = smoothstep(3.0, 10.0, scaleRatio);
  float rescueBoost = smoothstep(2.0, 5.5, scaleRatio);
  float sampleRadius = mix(1.0, 2.15, tinySourceBoost);
  float3 a = fsr_sample_output(inputTexture, params, ip + float2(-sampleRadius, -sampleRadius));
  float3 b = fsr_sample_output(inputTexture, params, ip + float2(0.0, -sampleRadius));
  float3 c = fsr_sample_output(inputTexture, params, ip + float2(sampleRadius, -sampleRadius));
  float3 d = fsr_sample_output(inputTexture, params, ip + float2(-sampleRadius, 0.0));
  float3 e = fsr_sample_output(inputTexture, params, ip);
  float3 f = fsr_sample_output(inputTexture, params, ip + float2(sampleRadius, 0.0));
  float3 G = fsr_sample_output(inputTexture, params, ip + float2(-sampleRadius, sampleRadius));
  float3 h = fsr_sample_output(inputTexture, params, ip + float2(0.0, sampleRadius));
  float3 I = fsr_sample_output(inputTexture, params, ip + float2(sampleRadius, sampleRadius));

  float bL = fsr_luma(b);
  float dL = fsr_luma(d);
  float eL = fsr_luma(e);
  float fL = fsr_luma(f);
  float hL = fsr_luma(h);
  float aL = fsr_luma(a);
  float cL = fsr_luma(c);
  float gL = fsr_luma(G);
  float iL = fsr_luma(I);
  float rangeMax = max(max(max(max(bL, dL), max(eL, fL)), hL), max(max(aL, cL), max(gL, iL)));
  float rangeMin = min(min(min(min(bL, dL), min(eL, fL)), hL), min(min(aL, cL), min(gL, iL)));
  float noise = abs(0.25 * (bL + dL + fL + hL) - eL) / max(rangeMax - rangeMin, 0.0001);
  noise = 1.0 - 0.5 * clamp(noise, 0.0, 1.0);

  float3 mn4 = min(min(min(b, d), min(f, h)), min(min(a, c), min(G, I)));
  float3 mx4 = max(max(max(b, d), max(f, h)), max(max(a, c), max(G, I)));
  float3 hitMin = min(mn4, e) / max(4.0 * mx4, float3(0.0001));
  float3 hitMax = (float3(1.0) - max(mx4, e)) / min(4.0 * mn4 - float3(4.0), float3(-0.0001));
  float3 lobeRgb = max(-hitMin, hitMax);
  float userSharpness = clamp(params.sharpness, 0.0, 2.0);
  float sharpness = mix(0.55, 1.45, min(userSharpness, 1.0)) + rescueBoost * 0.22;
  float baseLobe = min(max(lobeRgb.r, max(lobeRgb.g, lobeRgb.b)), 0.0);
  float lobe = max(-0.1875, baseLobe * sharpness * noise);
  float rcpL = 1.0 / (4.0 * lobe + 1.0);
  float3 outColor = clamp((lobe * (b + d + h + f) + e) * rcpL, float3(0.0), float3(1.0));
  float3 crossMean = 0.25 * (b + d + f + h);
  float3 wideMean = 0.125 * (a + b + c + d + f + G + h + I);
  float3 highPass = e - crossMean;
  float3 microPass = e - wideMean;
  float edgeMask = smoothstep(0.008, 0.13, rangeMax - rangeMin);
  float lineMask = smoothstep(0.012, 0.22, max(abs(dL - fL), abs(bL - hL)));
  float detailStrength = (mix(0.18, 1.05, min(userSharpness, 1.0)) + rescueBoost * 0.62) * max(edgeMask, lineMask);
  float microStrength = rescueBoost * mix(0.08, 0.42, min(userSharpness, 1.0)) * noise;
  float contrastStrength = 0.045 * min(userSharpness, 1.0) + rescueBoost * 0.055;
  float3 flatSmoothing = mix(e, wideMean, rescueBoost * (1.0 - edgeMask) * 0.06);
  outColor = mix(outColor, flatSmoothing, rescueBoost * (1.0 - edgeMask) * 0.18);
  float3 guard = float3(mix(0.04, 0.16, max(min(userSharpness, 1.0), rescueBoost)));
  outColor = clamp(
    outColor + highPass * detailStrength + microPass * microStrength + (e - float3(0.5)) * contrastStrength * edgeMask,
    max(float3(0.0), min(mn4, e) - guard),
    min(float3(1.0), max(mx4, e) + guard)
  );

  outputTexture.write(float4(outColor, 1.0), pixel);
}
"""

func normalizedImage(from pixelBuffer: CVPixelBuffer, preferredTransform: CGAffineTransform) -> CIImage {
  let transformed = CIImage(cvPixelBuffer: pixelBuffer).transformed(by: preferredTransform)
  let extent = transformed.extent
  return transformed.transformed(
    by: CGAffineTransform(translationX: -extent.origin.x, y: -extent.origin.y)
  )
}

func processFrame(
  _ image: CIImage,
  mode: NativeUpscaleMode,
  outputSize: CGSize,
  scale: Double,
  sharpness: Double
) -> CIImage {
  let sourceExtent = image.extent
  let scaleX = outputSize.width / max(1.0, sourceExtent.width)
  let scaleY = outputSize.height / max(1.0, sourceExtent.height)
  let baseScale = min(scaleX, scaleY)

  let scaled: CIImage
  if mode == .sharpen {
    scaled = image.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
  } else {
    scaled = image.applyingFilter("CILanczosScaleTransform", parameters: [
      kCIInputScaleKey: baseScale,
      kCIInputAspectRatioKey: scaleX / max(0.0001, scaleY),
    ])
  }

  let cropped = scaled.cropped(to: CGRect(origin: .zero, size: outputSize))

  switch mode {
  case .crisp:
    return applyCrispRescue(cropped, sharpness: sharpness, rescue: 1.0)
  case .rescue:
    let rescue = min(1.0, max(0.0, (scale - 1.4) / 2.2))
    return applyCrispRescue(cropped, sharpness: sharpness, rescue: rescue)
  case .smooth:
    return cropped
  case .sharpen:
    return applySharpen(cropped, sharpness: sharpness, rescue: 0.0)
  }
}

func applyCrispRescue(_ image: CIImage, sharpness: Double, rescue: Double) -> CIImage {
  var output = image
  let clampedSharpness = min(2.0, max(0.0, sharpness))

  output = output.applyingFilter("CIUnsharpMask", parameters: [
    kCIInputRadiusKey: 0.85 + rescue * 1.25,
    kCIInputIntensityKey: 0.45 + clampedSharpness * 0.85 + rescue * 0.65,
  ])

  output = output.applyingFilter("CISharpenLuminance", parameters: [
    kCIInputSharpnessKey: 0.18 + clampedSharpness * 0.55 + rescue * 0.38,
  ])

  output = output.applyingFilter("CIColorControls", parameters: [
    kCIInputContrastKey: 1.0 + clampedSharpness * 0.055 + rescue * 0.075,
    kCIInputSaturationKey: 1.0 + rescue * 0.025,
  ])

  return output
}

func applySharpen(_ image: CIImage, sharpness: Double, rescue: Double) -> CIImage {
  let clampedSharpness = min(2.0, max(0.0, sharpness))
  return image
    .applyingFilter("CISharpenLuminance", parameters: [
      kCIInputSharpnessKey: 0.25 + clampedSharpness * 0.65 + rescue * 0.2,
    ])
    .applyingFilter("CIUnsharpMask", parameters: [
      kCIInputRadiusKey: 0.75 + rescue * 0.5,
      kCIInputIntensityKey: 0.25 + clampedSharpness * 0.6,
    ])
}

func orientedDisplaySize(naturalSize: CGSize, transform: CGAffineTransform) -> CGSize {
  let transformed = CGRect(origin: .zero, size: naturalSize).applying(transform)
  return CGSize(width: abs(transformed.width), height: abs(transformed.height))
}

func evenSize(width: Double, height: Double) -> CGSize {
  let evenWidth = max(2, Int(width.rounded(.toNearestOrAwayFromZero)) / 2 * 2)
  let evenHeight = max(2, Int(height.rounded(.toNearestOrAwayFromZero)) / 2 * 2)
  return CGSize(width: evenWidth, height: evenHeight)
}

func defaultBitrate(width: Double, height: Double, frameRate: Float) -> Int {
  let fps = Double(frameRate.isFinite && frameRate > 0 ? frameRate : 30)
  let pixels = width * height
  return max(8_000_000, min(80_000_000, Int(pixels * fps * 0.16)))
}
