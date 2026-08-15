# dsh-memory · 外部智能体目录格式（json 后端）

> 适用版本：dsh-memory ≥ 0.2.0 · 依据 DSH `@deepseek-ai/dsh-storage-json` 真实落盘格式。
> 用途：让 dsh 之外的智能体（Claude Code、自研脚本等）直接读写共享记忆。

## 1. 文件位置

json 后端（默认）把 `memory` 域写成**单个文件**：

```
~/.dsh/storages/memory.json        # Windows: %USERPROFILE%\.dsh\storages\memory.json
```

存储根目录由部署的 `storage-json` 行配置决定（web bundle 默认 `dshHomePath('storages')`），文件名固定为 `<域名>.json`。

## 2. 文件结构

```jsonc
{
  "unit": { "name": "memory", "version": 1 },   // 头部：域身份；版本不符会拒绝加载
  "global": null,                                 // 域级单值；null = 从未写入
  "tables": {
    "entries": {                                  // 唯一的表：记忆条目，按 id 键控
      "mem_1786782254375_a06660a1": { /* 记录，见 §3 */ }
    }
  }
}
```

- 文件始终是当前净状态（pretty-printed JSON，尾部一个换行）；
- `global` 由插件维护（抽取水位线：`{ "last_extracted": { "<会话id>": <该会话最后抽取的事件seq> } }`，最多保留 64 个会话），外部工具不需要读它，但**保留原值**。

## 3. 记录字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `mem_<创建毫秒>_<8位hex>`，全表唯一键 |
| `type` | string | `semantic`（事实）/ `episodic`（事件）/ `procedural`（方法）/ `preference`（偏好）/ `insight`（洞察） |
| `content` | string | 记忆正文，一句自包含的话 |
| `scope` | string | `user`（全局共享）或 `workspace:<绝对路径>`（按工作目录共享） |
| `importance` | number | 0..1；被召回会缓慢抬升（用进废退） |
| `confidence` | number | 0..1；LLM 抽取的自评置信度 |
| `unverified` | boolean | true = 低置信度抽取产物，检索分数折半，面板虚线显示「待验证」 |
| `half_life_days` | number | 遗忘半衰期（天），当前固定 30 |
| `created_at` | number | 创建时间（Unix 毫秒） |
| `last_accessed_at` | number | 最近被召回时间（Unix 毫秒） |
| `access_count` | number | 被召回次数 |
| `tombstone` | boolean | true = 软删除（不参与召回，面板可恢复） |
| `source` | object | 写入来源：`{ agent: "tool"\|"panel"\|"extraction", session?, turn?, at }` |

检索得分（插件内部公式，外部实现可按需复刻）：

```
score = importance × confidence × 2^(−(now − last_accessed_at) / (half_life_days×86400000)) × (unverified ? 0.5 : 1)
```

## 4. 语义约定（写时去重 / 合并）

- **同 `content` + 同 `scope` 的新写入不新建记录**：改为合并——`importance` 取较大者、刷新 `last_accessed_at`、`access_count +1`；
- 删除 = 置 `tombstone: true`，**不要物理删除键**（面板依赖可恢复性）；
- `content` 为空字符串的条目非法。

## 5. 外部读写规则（重要）

1. **dsh 运行时内存态是权威**：每次写入都重写整个文件，外部工具在 dsh 运行期间改文件会**在下一次 dsh 写入时被覆盖丢失**。
   - 安全用法 A（只读）：任意时刻读取、解析、检索，无副作用；
   - 安全用法 B（写）：停止 dsh 后编辑，再启动 dsh（启动时全量载入校验）；
   - 安全用法 C（实时写）：走插件 API（面板 / `memory_remember` 工具 / 未来 P3 的 HTTP/MCP 服务），不要直接改文件。
2. **原子写**：先写同目录临时文件再 rename 覆盖，避免读者看到半截 JSON（插件后端即如此实现）。
3. **schema 校验**：dsh 启动载入时会校验每条的 `id/type/content/scope/importance/confidence/tombstone` 基本形状；写坏会让 `memory` 域拒绝打开（报 `invalid-record`），此时修复文件或删除该域文件即可（数据丢失风险自负）。
4. **版本**：`unit.version` 必须保持 `1`；插件升级若变更格式会随之提升，外部工具应读取该字段做兼容判断。

## 6. 最小示例（新增一条偏好）

```json
{
  "unit": { "name": "memory", "version": 1 },
  "global": { "last_extracted": {} },
  "tables": {
    "entries": {
      "mem_1700000000000_ab12cd34": {
        "id": "mem_1700000000000_ab12cd34",
        "type": "preference",
        "content": "回复要用中文口语化表达",
        "scope": "user",
        "importance": 0.7,
        "confidence": 1,
        "unverified": false,
        "half_life_days": 30,
        "created_at": 1700000000000,
        "last_accessed_at": 1700000000000,
        "access_count": 0,
        "tombstone": false,
        "source": { "agent": "external", "at": 1700000000000 }
      }
    }
  }
}
```
