// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "tauri-plugin-native-share",
    platforms: [.iOS(.v13)],
    products: [
        .library(name: "tauri-plugin-native-share", type: .static, targets: ["tauri-plugin-native-share"])
    ],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [
        .target(name: "tauri-plugin-native-share", dependencies: [.byName(name: "Tauri")], path: "Sources")
    ]
)
