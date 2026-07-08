# 本地语音合成方案：ChatTTS 集成

> 日期：2026-07-08 | 状态：设计中

---

## 1. 背景与目标

当前项目 TTS（文字转语音）依赖外部云服务（MiniMax / OpenAI 兼容接口），需要 API Key 且按量付费。ChatTTS 是开源界中文效果最好的本地 TTS 模型，集成后可实现：

- 零成本本地语音合成
- 无需联网，隐私安全
- 中文语气自然（支持笑声、停顿等）
- 多种音色可选（通过随机种子切换）

### 目标硬件

| 项目 | 配置 |
|------|------|
| 芯片 | Apple M1 Pro（8 核：6 性能 + 2 能效） |
| 内存 | 16GB 统一内存 |
| 加速 | PyTorch MPS（Metal Performance Shaders） |
| Python | 3.9+ |

### 预期性能（M1 Pro + MPS）

| 文本长度 | 预计耗时 |
|----------|----------|
| ~20 字（一句对白） | 3-5 秒 |
| ~100 字（一段话） | 10-20 秒 |
| ~500 字（一集对白） | 30-60 秒 |

---

## 2. 架构设计

```
frontweb/ FilmCreate.vue
  │  POST /api/v1/audio/extract
  ▼
backend-node/ routes/audio.js
  │  provider === 'chattts'
  ▼
backend-node/ services/ttsService.js
  │  HTTP POST to 127.0.0.1:9876/tts
  ▼
backend-node/ services/chattts_server.py   (Flask 守护进程)
  │  ChatTTS 模型常驻内存
  │  WAV → ffmpeg → MP3
  ▼
backend-node/ data/storage/audio/*.mp3
```

### 设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| Python 运行方式 | Flask HTTP 守护进程 | 避免每次调用冷加载模型（~30s），常驻内存后推理 < 5s |
| 音色控制 | 随机种子（seed） | ChatTTS 无命名音色，不同 seed 产生稳定不同声线 |
| 音频格式 | WAV → ffmpeg → MP3 | ChatTTS 原生输出 WAV，项目统一存储 MP3 |
| Python 进程管理 | Node 端 spawn + 健康检查 | 后端统一管理生命周期，失败不阻塞主服务 |
| 端口 | 127.0.0.1:9876 | 仅本地回环，无安全风险 |

---

## 3. 改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `backend-node/src/services/chattts_server.py` | **新建** | Python Flask TTS 服务端 |
| `backend-node/src/services/chatttsManager.js` | **新建** | Node 端进程生命周期管理 |
| `backend-node/src/services/ttsService.js` | **修改** | 新增 `chattts` provider 分支 |
| `backend-node/src/services/aiConfigService.js` | **修改** | testConnection 支持本地 chattts |
| `backend-node/src/server.js` | **修改** | 启动/关闭时管理 Python 进程 |
| `frontweb/src/components/AIConfigContent.vue` | **修改** | 添加 chattts 供应商选项和音色选择 |

---

## 4. 详细实现

### 4.1 Python ChatTTS 服务 (`chattts_server.py`)

Flask HTTP 服务，监听 `127.0.0.1:9876`。

**端点：**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查，返回 `{"status":"ok"}` |
| POST | `/tts?seed=2` | 文字合成语音，返回 MP3 二进制流 |

**实现要点：**

```python
# 启动时一次性加载模型到内存
chat = Chat()
chat.load_models(compile=False)  # MPS 下建议关闭 compile

# /tts 端点
@app.route('/tts', methods=['POST'])
def tts():
    text = request.json.get('text', '')
    seed = int(request.args.get('seed', 2))
    
    # 设置音色种子
    params_infer_code = Chat.InferCodeParams(spk_emb=seed)
    
    # 推理生成 WAV
    wavs = chat.infer([text], params_infer_code=params_infer_code)
    
    # ffmpeg 转 MP3
    # ... 保存临时 WAV → ffmpeg → 返回 MP3
    
    return send_file(mp3_path, mimetype='audio/mpeg')
```

**启动方式：**
```bash
python3 chattts_server.py --port 9876
```

### 4.2 Node 进程管理 (`chatttsManager.js`)

```javascript
// 生命周期
start()     → spawn('python3', ['chattts_server.py', '--port', port])
            → 轮询 GET /health 等待就绪（最多 60s）
            → 失败自动重试（最多 3 次）

stop()      → SIGTERM → 等 5s → SIGKILL
isReady()   → 快速健康检查（1s 超时）
getPort()   → 返回当前端口号
```

关键逻辑：
- 使用 `child_process.spawn` 获取实时日志
- 进程崩溃自动重启（上限 3 次，避免死循环）
- 端口冲突自动选下一个可用端口
- 启动失败不阻塞后端主服务

### 4.3 修改 `ttsService.js`

在 `synthesize` 函数的 provider 分支中新增：

```javascript
} else if (provider === 'chattts') {
  const manager = require('./chatttsManager');
  if (!manager.isReady()) {
    throw new Error('ChatTTS 本地服务未就绪，请检查 Python 环境和 ChatTTS 安装');
  }
  const seed = voiceId || ttsSettings.voice_seed || '2';
  const url = `http://127.0.0.1:${manager.getPort()}/tts?seed=${encodeURIComponent(seed)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`ChatTTS 服务错误 (${resp.status}): ${errText.slice(0, 200)}`);
  }
  audioBuffer = Buffer.from(await resp.arrayBuffer());
}
```

### 4.4 修改 `aiConfigService.js`

在 `testConnection` 中增加 chattts 分支（约第 302 行 `// --- TTS 语音合成 ---` 之前）：

```javascript
// --- ChatTTS 本地服务 ---
if (provider === 'chattts') {
  const manager = require('./chatttsManager');
  if (!manager.isReady()) {
    throw new Error('ChatTTS 本地服务未启动。请确认已安装 Python 依赖：pip3 install chattts flask');
  }
  const resp = await fetch(`http://127.0.0.1:${manager.getPort()}/health`);
  if (!resp.ok) throw new Error('ChatTTS 服务异常');
  return;
}
```

### 4.5 修改 `server.js`

```javascript
// 服务启动后（在 app.listen 回调中）
const chatttsManager = require('./services/chatttsManager');
chatttsManager.start().catch(e => {
  log.warn('ChatTTS 本地服务启动失败（不影响主服务）:', e.message);
});

// 优雅关闭
process.on('SIGTERM', async () => {
  await chatttsManager.stop();
  server.close(() => process.exit(0));
});
process.on('SIGINT', async () => {
  await chatttsManager.stop();
  server.close(() => process.exit(0));
});
```

### 4.6 前端配置 UI (`AIConfigContent.vue`)

- 供应商选择器新增 `chattts` 选项
- 当 `service_type === 'tts' && provider === 'chattts'` 时：
  - 隐藏 `api_key`、`base_url`、`group_id` 字段
  - 显示音色种子选择器：

```
预设种子：
  [2] 清晰女声（默认）
  [3] 沉稳男声
  [5] 温柔女声
  [7] 活泼少女
  [11] 磁性男声
  [自定义...] 输入数字
```

- 提示文案：「ChatTTS 本地运行，无需 API Key」

---

## 5. ChatTTS 音色种子参考

ChatTTS 没有命名音色系统，通过随机种子控制音色。同一种子生成的音色稳定一致。

| Seed | 声线风格 | 适用场景 |
|------|---------|---------|
| 2 | 清晰女声 | 旁白、女主角 |
| 3 | 沉稳男声 | 男主角、旁白 |
| 5 | 温柔女声 | 情感对白 |
| 7 | 活泼少女 | 年轻角色 |
| 11 | 磁性男声 | 低音炮角色 |
| 自定义 | 任意整数 | 探索新音色 |

---

## 6. 前置依赖与安装

```bash
# PyTorch（带 MPS 加速）
pip3 install torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# ChatTTS + Flask 服务
pip3 install chattts flask

# ffmpeg（项目已有，位于 backend-node/tools/ffmpeg/）
# 首次运行 ChatTTS 会自动下载模型（约 1.5GB）
```

---

## 7. 实施顺序

| 步骤 | 任务 | 验证方法 |
|------|------|---------|
| 1 | 安装 Python 依赖 | `python3 -c "import ChatTTS; print('OK')"` |
| 2 | 创建 `chattts_server.py` | `curl localhost:9876/health` 返回 ok |
| 3 | 创建 `chatttsManager.js` | Node 端调用 `isReady()` 返回 true |
| 4 | 修改 `ttsService.js` | AI 配置选 chattts → 生成分镜配音 |
| 5 | 修改 `aiConfigService.js` | 测试连接返回成功 |
| 6 | 修改 `server.js` | 启动后端自动拉起 Python 进程 |
| 7 | 修改前端 UI | AI 配置页可选 chattts 供应商 |

---

## 8. 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| Python 进程崩溃 | TTS 调用失败 | 自动重启（最多 3 次），失败时返回明确错误提示 |
| MPS 兼容性问题 | 推理报错 | 降级为 CPU 模式：`export PYTORCH_ENABLE_MPS_FALLBACK=1` |
| 首次模型下载慢 | 初次使用需等待 | 启动日志显示下载进度，健康检查等待就绪 |
| 内存不足 | 系统卡顿 | 16GB M1 Pro 实测无压力；若出现可限制模型精度 |
| 端口冲突 | 服务启动失败 | 自动选择下一个可用端口 |
