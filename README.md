# dsh-memory

> DeepSeek Harness 高级共享记忆插件：可自选储存区（复用 DSH storage 域）· 跨会话/多智能体共享 · 评分/衰减/置信度记忆机制 · 设置页可视化面板。

## Overview

`dsh-memory` 给 dsh 增加长期记忆，解决「每个会话失忆」的问题：

- **共享**：一个宿主级 MemoryService 单例，所有会话/子代理/工作流共享同一份记忆（多 dsh 会话共享开箱即用）；
- **储存区自选**：数据走 DSH 原生 storage 域（`memory` 域），后端由 `dsh-storage-domain` 的路由配置决定（默认 json 于 `~/.dsh/storages`，可切 sqlite）；
- **记忆机制**：五类记忆（事实/事件/方法/偏好/洞察）+ 重要性×置信度×遗忘曲线评分 + 写时去重 + 软删除；
- **可视化**：设置 → 插件 →「记忆」页签：统计、时间线、增删、JSON 导出。

**当前版本**：v0.1.0（P0）——手动记忆 + 工具 + 动态上下文自动召回 + 面板。自动抽取（LLM）、语义检索、图谱、反思等见路线图。

## Compatibility

| 项 | 支持范围 |
| --- | --- |
| dsh 生态 | `0.1.0-rc.6`（storage 域 + systemPrompt.context + session/event + tools 注册） |
| 存储 | DSH `dsh-storage-domain`（json 默认；sqlite 改路由配置） |
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
4. 会话 A 用 `memory_remember` 写的记忆，会话 B 立即可召回（同一 dsh 进程内共享）。

## Configuration

```yaml
# profile cordis.patch.yml 可覆盖默认值
- id: memory-hub
  config: { recallTopK: 5, recallBudget: 1500 }
- id: memory-agent
  config: { recallTopK: 5, recallBudget: 1200 }
```

- `storage` 路由：改 `dsh-storage-domain` 行的 `routes: { memory: sqlite }` 可换后端；
- 无环境变量、无敏感项。

## Permissions & data

- 宿主半边只写 `memory` 存储域（默认 `~/.dsh/storages`），注册 `/memory/api/*` 本地路由；
- 浏览器半边面板走本地 API；无遥测、无网络出站。

## Troubleshooting

| 现象 | 处理 |
| --- | --- |
| 面板接口不可用 | 重启 dsh web（新行需要重启加载）；确认 bundles 里有 `dsh-memory` |
| 记忆不召回 | 确认 `dsh --profile web --dump-config` 树里有 memory-hub/memory-agent 两行 |
| 想清空 | 面板逐条删除（软删除），或导出后删除 storage 目录里的 memory 域 |

## Development

```bash
npm install
npm run build   # 构建 lib/client.js（wire 格式）
npm run smoke   # node 半边加载冒烟
```

## Roadmap

- P1：LLM 自动抽取（turn/end）+ 重要性学习 + sqlite 后端 + 外部 agent 目录格式文档
- P2：sqlite-vec 语义检索 + 轻量图谱 + consolidate/reflect/archive + 图谱可视化
- P3：HTTP/MCP 服务模式（跨机/外部智能体）+ preset 集成

## License & security

[MIT](./LICENSE) © 2026 zhang66633 · 安全问题请通过 GitHub security advisory 私下报告。
