# Remotion 离线运行时

打包脚本会把当前平台已经下载的 Chrome Headless Shell 复制到本目录，并由
electron-builder 作为 `resources/remotion-runtime` 一起发布。没有预下载浏览器时，
构建仍可完成，但桌面端 doctor 会明确报告 `offline_ready: false`；请在构建机执行：

```bash
npm run prepare-remotion-runtime
```

也可以通过 `REMOTION_BROWSER_EXECUTABLE` 指定一个已存在的 Chrome/Chromium，或用
`REMOTION_BROWSER_SOURCE` 指定浏览器目录。运行时不依赖联网下载浏览器。

macOS 会同时构建 arm64 与 x64 安装包；交叉架构浏览器可分别通过
`REMOTION_BROWSER_SOURCE_DARWIN_ARM64` 和 `REMOTION_BROWSER_SOURCE_DARWIN_X64`
指定。缺少某一架构时仅该架构的 `doctor.offline_ready` 为 `false`。

发布正式离线包时可设置 `REMOTION_REQUIRE_OFFLINE_RUNTIME=1`，缺少目标架构浏览器
会让打包前置步骤直接失败，避免产出不可离线渲染的安装包。
