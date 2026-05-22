// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "MacVideoUpscalerNative",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(name: "chrome-video-upscaler-native", targets: ["MacVideoUpscalerNative"]),
  ],
  targets: [
    .executableTarget(
      name: "MacVideoUpscalerNative",
      path: "Sources/MacVideoUpscalerNative"
    ),
  ]
)
