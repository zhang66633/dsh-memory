# dsh-memory

> DeepSeek Harness 高级共享记忆插件：可自选储存区（复用 DSH storage 域）· 跨会话/多智能体共享 · 评分/衰减/置信度记忆机制 · LLM 自动抽取 · 设置页可视化面板。

## Overview

`dsh-memory` 给 dsh 增加长期记忆，解决「每个会话失忆」的问题：

- **共享**：一个宿主级 MemoryService 单例，所有会话/子代理/工作流共享同一份记忆（多 dsh 会话共享开箱即用）；
- **储存区自选**：数据走 DSH 原生 storage 域（`memory` 域），后端由 `dsh-storage-domain` 的路由配置决定（默认 json 于 `~/.dsh/storages`，可切 sqlite，见下文）；
- **记忆机制**：五类记忆（事实/事件/方法/偏好/洞察）+ 重要性×置信度×遗忘曲线评分 + 写时去重 + 软删除；
- **自动抽取（P1）**：每 N 回合结束后，用本机已配置的模型把回合浓缩成记忆候选——低于置信度门槛的丢弃，低于验证门槛的打「待验证」标记（检索分数折半）；被召回的条目 importance 缓慢抬升（用进废退）；
- **可视化**：顶部环「记忆」页签（与「对话」「插件商店」并列，主面板）+ 设置 → 插件 →「记忆」页签（发现路径）——统计、带标签的写入表单（类型/范围/重要性）、时间线（含引用次数与写入来源）、增删、JSON 导出，待验证条目虚线标识。

**当前版本**：v0.2.1（P0 + P1 完成）——手动记忆 + 工具 + 动态上下文自动召回 + 面板 + LLM 自动抽取 + 重要性学习 + 外部 agent CLI 与格式文档。语义检索、图谱、反思等见路线图。

## Compatibility

| 项 | 支持范围 |
| --- | --- |
| dsh 生态 | `0.1.0-rc.6`（storage 域 + systemPrompt.context + session/event + tools 注册） |
| 存储 | DSH `dsh-storage-domain`（json 默认；sqlite 需另装后端包，见下文） |
| 抽取模型 | 复用会话当前 provider/model（`request/header` 路由），或 memory-agent 行显式指定 |
| 验证日期 | 2026-08-15 |

## Install / Uninstall

本地 link 安装：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": { "dsh-memory": "link:<仓库路径>" },
  "dsh": { "profile": { "bundles": ["dsh-memory"] } }
}
```

```bash
cd ~/.dsh/profiles/web && pnpm install   # 重启 dsh web
```

卸载：移除依赖与 bundles 条目，`pnpm install`；记忆数据在 `~/.dsh/storages` 的 memory 域，卸载不删数据（导出后用面板删除）。

## Quick start

1. 安装并重启 `dsh web`；
2. 设置 → 插件 → **记忆** 页签，手动写一条记忆；
3. 开新会话问「你还记得什么？」——模型可调 `memory_recall`；每轮回合结束，最近的高分记忆会自动进入「Current runtime context」动态快照；
4. 会话 A 用 `memory_remember` 写的记忆，会话 B 立即可召回（同一 dsh 进程内共享）；
5. 自动抽取默认开启：正常完成一个回合后，模型会异步浓缩本回合并写入候选（失败只记警告，不阻塞回合）。

## Configuration

```yaml
# profile cordis.patch.yml 可覆盖默认值
- id: memory-hub
  config: { recallTopK: 5, recallBudget: 1500, importanceLearningRate: 0.01 }
- id: memory-agent
  config:
    recallTopK: 5
    recallBudget: 1200
    extraction:
      enabled: true          # 关闭自动抽取
      everyNTurns: 1         # 每 N 个完成回合抽一次（降频/攒批省 token）
      maxInputChars: 6000    # 转写文本预算（超出丢最早内容）
      minTranscriptChars: 40 # 低于此长度的琐碎回合直接跳过（不耗 LLM 调用）
      minConfidence: 0.3     # 低于此置信度的候选直接丢弃
      verifyConfidence: 0.6  # 低于此置信度打 unverified（检索折半）
      maxCandidates: 8       # 单次抽取最多写入的候选数
      timeoutMs: 60000       # 抽取调用超时
      maxTokens: 1024        # 抽取输出 token 上限
    # 抽取路由：缺省复用会话的 request/header 路由；也可显式成对指定：
    provider: deepseek
    model: deepseek-chat
```

- `importanceLearningRate`：被召回条目每次命中 importance 增加量（上限 1）；
- `storage` 路由：改 `dsh-storage-domain` 行的 `routes: { memory: sqlite }` 可换后端；
- 无环境变量、无敏感项。

### 切换到 sqlite 后端

json（默认）之外，sqlite 需要**额外安装后端包并加一行插件**（DSH web bundle 默认只注册 json 后端）：

```jsonc
// ~/.dsh/profiles/web/package.json 增加依赖
{ "dependencies": { "@deepseek-ai/dsh-storage-sqlite": "0.0.1-rc.1" } }
```

```yaml
# profile cordis.patch.yml：注册后端 + 把 memory 域路由过去
- insert:
    - id: storage-sqlite
      name: '@deepseek-ai/dsh-storage-sqlite'
      config: { root: !!js dshHomePath('storages') }
- id: storage-domain
  config: { backend: json, routes: { memory: sqlite } }
```

重启后记忆数据落在 sqlite 文件里；`routes` 只影响 `memory` 域，其余域仍走 json。回切同理：移除该行 + `routes` 去掉 `memory` 项。

## External agents（json 后端目录格式）

json 后端把整个 `memory` 域写成**单个文件** `~/.dsh/storages/memory.json`（`{unit, global, tables.entries}`）。外部智能体可只读检索、或停 dsh 后编辑。字段、语义约定（去重/合并/软删除）与读写安全规则见 [docs/external-format.md](docs/external-format.md)。

插件自带与插件同语义的零依赖 CLI（`npm run memory-cli -- <命令>`，或 `node scripts/memory-cli.mjs`）：`list` / `recall` / `remember` / `forget` / `restore` / `stats` / `export`，原子写入 + 并发冲突保护，是格式文档的参考实现。

## Permissions & data

- 宿主半边只写 `memory` 存储域（默认 `~/.dsh/storages`），注册 `/memory/api/*` 本地路由；
- 抽取调用复用会话已配置的模型路由（一次辅助 LLM 请求/回合组）；
- 浏览器半边面板走本地 API；无遥测、无网络出站。

## Troubleshooting

| 现象 | 处理 |
| --- | --- |
| 面板接口不可用 | 重启 dsh web（新行需要重启加载）；确认 bundles 里有 `dsh-memory` |
| 记忆不召回 | 确认 `dsh --profile web --dump-config` 树里有 memory-hub/memory-agent 两行 |
| 自动抽取不工作 | 日志找 `dsh-memory extraction failed`；缺路由时在 memory-agent 行配 `provider`+`model`；不想抽就 `extraction.enabled: false` |
| 想清空 | 面板逐条删除（软删除），或导出后删除 storage 目录里的 memory 域 |

## Development

```bash
npm install
npm run build        # 构建 lib/client.js（wire 格式）
npm test             # 抽取管线 + 记忆服务 + 外部格式语义测试
npm run memory-cli   # 外部 agent CLI（list/recall/remember/...）
npm run smoke        # node 半边加载冒烟
```

## Roadmap

- P2：sqlite-vec 语义检索 + 轻量图谱 + consolidate/reflect/archive + 图谱可视化
- P3：HTTP/MCP 服务模式（跨机/外部智能体）+ preset 集成

## License & security

[MIT](./LICENSE) © 2026 zhang66633 · 安全问题请通过 GitHub security advisory 私下报告。
