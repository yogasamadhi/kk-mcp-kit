# project-memory 隐私与导入格式

## 数据位置和生命周期

数据库固定在 `stateDir/project-memory/memory.sqlite`，启用 SQLite WAL。记录正文、标题、标签、
来源、仓库引用、时间和 content hash 都保存在本机。仓库不提供同步、遥测或后台上传。

删除 `stateDir/project-memory/` 会删除 memory 数据；这是用户控制的本地状态，不属于 Git
工作树。操作前应自行备份需要保留的记录。

## 导入原则

导入只在显式调用 `plan_import_memory` 时发生：

1. 输入必须是绝对路径并位于配置的 `projectMemory.importRoots`；
2. 支持 Markdown、JSON、JSONL 和 `codex-jsonl`；
3. 解析后对常见 token、Bearer、GitHub token 和自定义模式脱敏；
4. 返回解析数量、content-hash 重复数量和风险；
5. apply 需要 `projectMemory.import=true`；
6. apply 前重新计算源文件 SHA-256，文件变化则返回 `STALE_PLAN`。

Server 不后台扫描 Codex，不读取 `auth.json`，也不打开 Codex 内部 SQLite 数据库。

## Codex rollout JSONL 声明

OpenAI Docs 没有承诺稳定的本地 Codex 任务导出契约，因此 `codex-jsonl` 是可选、版本敏感的
适配器，不是对 Codex 内部格式的兼容保证。当前只接受已知顶层 record type：

```text
session_meta  turn_context  response_item  event_msg  compacted
```

适配器只提取可识别的文本消息，跳过已知非文本元数据。未知顶层 type、损坏 JSONL 或没有任何
可识别文本时会安全失败为 `INVALID_ARGUMENT`，不会猜测字段含义。格式升级应通过新的 fixture、
脱敏测试和明确版本说明进入仓库。

## 建议

- 为导入单独设置最小 `importRoots`，不要指向整个 home 目录。
- 在 plan 输出中检查条目数和风险后再临时开启 import capability。
- 将额外的组织内 secret 形式加入 `audit.redactionPatterns`。
- 对敏感项目使用独立 `stateDir`，并依赖操作系统文件权限和磁盘加密。
