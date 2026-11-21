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

使用发行包时，下载对应版本的 ZIP 与校验清单，核对 ZIP 的 SHA-256 后解压。每个 Server 可用 Node.js 22.13+ 或 Bun 1.4+ 启动。开发者从源码运行时先在源码根目录执行 `bun install` 和 `bun run check`，生成相同的 `servers/<name>/dist/` 目录布局。

首次连接可使用下面的最小配置。将两个路径替换为本机绝对路径，工作区目录应已存在。需要启用某个 Server 的可选功能时，再从 `examples/config/kk-mcp.config.example.json` 查找对应配置。

```json
{
  "version": 1,
  "stateDir": "/absolute/path/to/state",
  "roots": [{ "id": "projects", "path": "/absolute/path/to/workspace" }]
}
```

从解包目录或构建后的源码根目录选择任一运行时启动。

```bash
node servers/workspace/dist/cli.mjs --config /absolute/path/to/kk-mcp.config.json
bun servers/workspace/dist/cli.mjs --config /absolute/path/to/kk-mcp.config.json
```

CLI 只接受显式绝对 `--config`。STDIO stdout 专用于 MCP 协议，日志写入 stderr。

首次配置时可在终端给同一命令加上 `--check-config`，检查配置结构和工作区目录。检查会直接退出，成功时退出码为 0，无需启动 MCP Server 或创建状态目录。配置到客户端时去掉该参数，连接后调用 `get_capabilities` 确认 Server 已就绪。

## 文档

- [文档索引](../docs/README.md)
- [配置、安全模型与 plan/apply](../docs/configuration-and-security.md)
- [7 个 Server 的 Tools 与权限](../docs/servers.md)
- [三平台 capability 表](../docs/platform-capabilities.md)
- [project-memory 隐私与导入格式](../docs/project-memory-privacy.md)

Codex 的 7 个独立 STDIO 配置见
[`examples/codex/config.toml`](../examples/codex/config.toml)，Bun 运行时版本见
[`examples/codex/config.bun.toml`](../examples/codex/config.bun.toml)。
