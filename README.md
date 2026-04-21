# Smart Context Engine

OpenClaw ContextEngine 插件，提供事件导向的上下文压缩、索引和检索。

## 架构

```
 ingest()          compact()            assemble()
 ─────────        ──────────          ──────────
 messages ──→ ContentProcessor ──→ Compactor ──→ 3-Layer Context
                (filter/outline)    (windowed       ├─ Layer 1: Focus Event
                                    compression)    │   + Entity Descriptions
                                                    ├─ Layer 2: Recent Events
                                                    └─ Layer 3: Raw Messages
                         │
                         ▼
                 EventIndexManager (SQLite)
                 ├─ Event Documents (events/*.md)
                 ├─ Entity Documents (subjects|types|scenarios/*.md)
                 └─ Compressed Summaries (summaries/YYYY-MM-DD-N.md)
```

### 核心流程

1. **ingest()** — 接收消息，通过 ContentProcessor 处理（过滤/大纲/媒体存储）
2. **compact()** — 当活跃消息超过 token 预算时，将最老的消息压缩为摘要文件，同时提取事件并索引
3. **assemble()** — 组装三层上下文返回给 LLM：焦点事件详情 → 最近事件列表 → 原始消息

### 事件系统

每个事件有三个属性维度：

| 维度 | 含义 | 示例 |
|------|------|------|
| **subject** | 事件主体 | XX项目、用户系统、认证模块 |
| **type** | 事件类型 | 软件开发、调研、故障排查、决策 |
| **scenario** | 场景上下文 | 生产环境、技术选型、客户端对接 |

维度复用：压缩时将已知维度值列表传给 extractor，优先复用已有名称，避免语义重复。事件匹配改为纯字符串比较。

### 磁盘存储结构

```
{storageDir}/{sessionId}/
├── summaries/              # 压缩摘要 (YYYY-MM-DD-N.md)
├── events/                 # 事件文档 (evt-{hash}.md)
├── subjects/               # 主体实体文档
├── types/                  # 类型实体文档
├── scenarios/              # 场景实体文档
├── text/                   # 大文本存储
├── media/                  # 媒体文件存储
└── index.db                # SQLite 事件索引 (FTS5)
```

## 配置

所有预算单位为 **tokens**（内部 ×4 转换为 chars）。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `maxHistoryTokens` | int | 16000 | 活跃消息 token 预算，超限触发压缩 |
| `compactCoreTokens` | int | 6000 | 每个压缩窗口的 token 大小 |
| `compactOverlapTokens` | int | 1000 | 压缩窗口间的重叠 token 大小 |
| `recentEventCount` | int | 10 | assemble 时包含的最近事件数 |
| `dedupReads` | bool | true | 去重相同路径的 read_file 结果 |
| `recentWindowSize` | int | 6 | 不参与去重的最近消息数 |
| `sessionFilter` | string/array | "main" | 会话过滤：main/all/正则数组 |
| `storageDir` | string | 系统临时目录 | 存储根目录 |
| `largeTextThreshold` | int | 2000 | 超过此字符数的文本生成大纲 |
| `summaryEnabled` | bool | false | 启用 LLM 压缩摘要 |
| `summaryMode` | string | "runtime" | runtime = 用 OpenClaw 模型，http = OpenAI 兼容 API |
| `summaryBaseUrl` | string | http://localhost:11434/v1 | http 模式的 API 地址 |
| `summaryModel` | string | "" | 模型名称，空=默认 |
| `summaryTargetTokens` | int | 600 | 摘要目标 token 数 |
| `contentFilters` | array | [] | 内容过滤规则 |

## 测试

### 运行单元测试

```bash
cd smart-context
npm test
```

### 运行 LCM 集成测试

需要 `data/lcm.db` 文件存在：

```bash
npx vitest run test/lcm-integration.test.ts
```

测试输出写入 `data/test-output/`，不会被自动清理，可以查看：
- `data/test-output/conv-1/summaries/` — 压缩摘要
- `data/test-output/conv-1/events/` — 事件文档
- `data/test-output/conv-1/subjects/` — 主体实体

### 构建

```bash
npm run build
```

### 文件清单

| 源文件 | 行数 | 职责 |
|--------|------|------|
| `src/engine.ts` | 629 | 主引擎，ingest/assemble/compact/focusEvent |
| `src/event-index.ts` | 339 | SQLite 事件索引，CRUD + 维度复用 |
| `src/event-extractor.ts` | 306 | LLM/结构化事件提取 + 维度匹配 |
| `src/event-storage.ts` | 323 | YAML 文档读写，Obsidian 兼容 |
| `src/compactor.ts` | 296 | 压缩窗口构建 + LLM/结构化摘要 |
| `src/content-processor.ts` | 233 | 内容过滤/大纲/媒体处理 |
| `src/summarizer.ts` | 169 | Runtime 和 HTTP 两种 LLM 调用模式 |
| `src/outline.ts` | 160 | 大文本大纲生成 |
| `src/config.ts` | 97 | 配置解析 + 默认值 |
| `src/content-filter.ts` | 106 | 消息/块/行级内容过滤 |
| `src/content-storage.ts` | 113 | 磁盘存储管理 |
| `src/types.ts` | 71 | 共享类型定义 |
| `src/event-types.ts` | 71 | 事件/实体类型定义 |
| `test/engine.test.ts` | 444 | 引擎完整生命周期测试 |
| `test/lcm-integration.test.ts` | 232 | 真实数据集成测试 |
| 其他测试 | 1475 | 各模块单元测试 |

## TODO

### 高优先级

- [ ] **LLM 接入测试** — 当前只有 structural fallback（维度质量低：都是"未知/对话/通用"），需要接入 Ollama 或 OpenAI API 验证完整流程
- [ ] **压缩提示词加入已知维度** — `COMPACT_USER_TEMPLATE` 中注入已知 subject/type/scenario 值列表，让 LLM 提取属性时优先复用
- [ ] **EventExtractor LLM 路径实现** — `parseEventOrientedOutput` 已有但 compact 流程中未调用 LLM 事件提取，只走了 structural fallback
- [ ] **assemble() 预算控制** — 当前 systemPromptAddition 没有预算限制，焦点事件叙事可能过长（测试中出现了 85K chars），需要截断

### 中优先级

- [ ] **事件状态管理** — events 只有 active，缺少 paused/completed/abandoned 的触发机制（如用户切换话题时自动 pause）
- [ ] **bootstrap() 实现** — 当前返回空，应该能从磁盘恢复会话状态（读取已有 summaries + events + SQLite）
- [ ] **实体描述生成** — 实体的 description 字段始终为空，应该在首次创建或 LLM 可用时生成描述
- [ ] **readSummaryPartials() 测试** — 新增的方法没有独立测试覆盖

### 低优先级

- [ ] **index.ts 导出 focusEvent/unfocusEvent** — 当前 focusEvent 是 engine 的公开方法，但 index.ts 入口未导出给 OpenClaw 调用
- [ ] **压缩比率自适应** — 根据历史压缩率动态调整 compactCoreTokens
- [ ] **并发安全** — SQLite WAL 模式下多进程写入可能冲突，需要加锁或使用队列
- [ ] **Obsidian 插件兼容** — 事件文档格式已接近 Obsidian，但缺少双向链接和标签支持
