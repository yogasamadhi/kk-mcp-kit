# 自研 MCP Server

一组本地优先、默认拒绝写操作的 TypeScript MCP Server，为 Agent 提供结构化的
工作区、Git、运行时、项目记忆、构建证据、桌面应用和网络诊断能力。

## 已实现的 Server

| Server | 主要用途 | 默认状态 |
| --- | --- | --- |
| [workspace](workspace/) | 仓库发现、项目说明、依赖图和受限搜索 | 完全只读 |
| [git-guardian](git-guardian/) | Git 状态、submodule/vendor-lock 同步、提交范围 | apply 关闭 |
| [runtime-observer](runtime-observer/) | 进程、端口、服务、健康状态和日志 | stop 关闭 |
| [project-memory](project-memory/) | SQLite FTS 决策、事故、验证和按需导入 | write/import 关闭 |
| [build-evidence](build-evidence/) | 命名验证 profile、失败解析、历史和 artifacts | run 关闭 |
| [desktop-lab](desktop-lab/) | 配置应用的进程、窗口、日志、崩溃和截图 | launch/stop/capture 关闭 |
| [network-forensics](network-forensics/) | 代理环境、DNS、TLS、HTTP 和路由诊断 | activeProbe 关闭 |

## 开始使用

要求 Bun 1.4 和 Node.js 22.13 或更高版本。请在仓库根目录执行以下命令。

```bash
bun install
bun run check
cp examples/config/kk-mcp.config.example.json /absolute/path/to/kk-mcp.config.json
```

编辑配置中的所有绝对路径后，用同一份构建产物选择任一运行时：

```bash
node servers/workspace/dist/cli.mjs --config /absolute/path/to/kk-mcp.config.json
bun servers/workspace/dist/cli.mjs --config /absolute/path/to/kk-mcp.config.json
```

CLI 只接受显式绝对 `--config`。STDIO stdout 专用于 MCP 协议，日志写入 stderr。

## 文档

- [文档索引](../docs/README.md)
- [配置、安全模型与 plan/apply](../docs/configuration-and-security.md)
- [7 个 Server 的 Tools 与权限](../docs/servers.md)
- [三平台 capability 表](../docs/platform-capabilities.md)
- [project-memory 隐私与导入格式](../docs/project-memory-privacy.md)

Codex 的 7 个独立 STDIO 配置见
[`examples/codex/config.toml`](../examples/codex/config.toml)，Bun 运行时版本见
[`examples/codex/config.bun.toml`](../examples/codex/config.bun.toml)。
