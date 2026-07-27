# Kokoro-FastAPI 本地服务

LocalMiniDrama 将 Kokoro-FastAPI 作为独立的本地 OpenAI 兼容 TTS 服务运行，运行时文件位于仓库根目录的 `.runtime/kokoro-fastapi`，不会提交到 Git。

```bash
cd backend-node
npm run kokoro:install
npm run kokoro:start
```

默认从 Hugging Face 国内镜像续传并校验官方 Kokoro 权重。如需切换下载源，可设置 `KOKORO_MODEL_URL`。

服务启动后使用以下 AI 配置：

- 服务类型：`tts`
- 厂商：`kokoro`
- Base URL：`http://127.0.0.1:8880/v1`
- 模型：`kokoro`
- 声音 ID：`zf_xiaobei`（女声）或 `zm_yunxi`（男声）
- API Key：留空

健康检查和 Web 界面：

- API 文档：`http://127.0.0.1:8880/docs`
- Web 界面：`http://127.0.0.1:8880/web`
- 音色列表：`http://127.0.0.1:8880/v1/audio/voices`
