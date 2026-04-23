# Story Context

OpenClaw ContextEngine 插件，提供 story 导向的上下文压缩、索引和检索。

## 架构

```
 ingest()          compact()            assemble()
 ─────────        ──────────          ──────────
 messages ──→ ContentProcessor ──→ Compactor ──→ 3-Layer Context
              (filter/outline)    (windowed       ├─ Layer 1: Focus Story
                                  compression)    │   + Entity Descriptions
                                                  ├─ Layer 2: Recent Stories
                                                  └─ Layer 3: Raw Messages
                       │
                       ▼
               StoryIndexManager (SQLite)
               ├─ Story Documents (stories/*.md)
               ├─ Entity Documents (subjects|types|scenarios/*.md)
               └─ Compressed Summaries (summaries/YYYY-MM-DD-N.md)
```

### 核心流程

1. **ingest()** — 接收消息，通过 ContentProcessor 处理（过滤/大纲/媒体存储）
2. **compact()** — 当活跃消息超过 token 预算时，将最老的消息压缩为摘要文件，同时提取 story 并索引
3. **assemble()** — 组装三层上下文返回给 LLM：焦点 story 详情 → 最近 story 列表 → 原始消息

### Story 三维框架

从 agent 视角出发，每个 story 有三个正交维度：

| 维度 | 含义 | 预定义集合 |
|------|------|-----------|
| **type** | Agent 做什么动作 | development, testing, execution, exploration, assistance, debugging, analysis, decision, configuration |
| **subject** | 操作什么对象 | 自由填写（项目名/系统名/话题名） |
| **scenario** | 在什么领域 | software-engineering, data-engineering, system-ops, security, content-creation, knowledge-mgmt, user-interaction, general |

维度匹配采用归一化比较（取逗号分隔第一个值 + 大小写无关），同一 subject+type+scenario 的 story 自动合并。

### Summary 输出格式

压缩后生成结构化 MD 摘要文件（非原始 JSON）：

```markdown
## 1. opinion-analysis — development · software-engineering

Built a multi-platform crawler pipeline with webhook integration.

---

## 2. data-jike — configuration · system-ops

Configured the crawler service with updated API tokens.
```

### 磁盘存储结构

```
{storageDir}/{sessionId}/
├── summaries/              # 压缩摘要 (YYYY-MM-DD-N.md)
├── stories/                # Story 文档 (story-{hash}.md)
├── subjects/               # 主体实体文档
├── types/                  # 类型实体文档
├── scenarios/              # 场景实体文档
├── text/                   # 大文本存储
├── media/                  # 媒体文件存储
└── session.db              # SQLite 索引 (FTS5)
```

## 配置

所有预算单位为 **tokens**（内部 ×4 转换为 chars）。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `maxHistoryTokens` | int | 16000 | 活跃消息 token 预算，超限触发压缩 |
| `compactCoreTokens` | int | 6000 | 每个压缩窗口的 token 大小 |
| `compactOverlapTokens` | int | 1000 | 压缩窗口间的重叠 token 大小 |
| `recentStoryCount` | int | 10 | assemble 时包含的最近 story 数 |
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

```bash
cd story-context
npm test
```

### 构建

```bash
npm run build
```

## 源文件

| 文件 | 职责 |
|------|------|
| `src/engine.ts` | 主引擎，ingest/assemble/compact/story focus |
| `src/story-index.ts` | SQLite story 索引，CRUD + 维度匹配 |
| `src/story-extractor.ts` | LLM/结构化 story 提取 + 维度归一化 |
| `src/story-storage.ts` | YAML 文档读写，Obsidian 兼容 |
| `src/compactor.ts` | 压缩窗口构建 + LLM/结构化摘要 |
| `src/content-processor.ts` | 内容过滤/大纲/媒体处理 |
| `src/summarizer.ts` | Runtime 和 HTTP 两种 LLM 调用模式 |
| `src/message-store.ts` | SQLite 消息持久化 + 会话状态 |
| `src/content-storage.ts` | 磁盘存储管理 |
