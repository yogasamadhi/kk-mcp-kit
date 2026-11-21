# kk-mcp-kit

## 自研 MCP Server

我们编写和维护的 7 个本地优先的 TypeScript MCP Server，覆盖工作区搜索、Git、进程与服务、项目记忆、构建验证、桌面应用和网络诊断。每个 Server 可独立运行，默认关闭写操作。

[浏览自研 Server 与使用指南](servers/README.md)

## 运行包发行

从已审阅的发布候选运行以下命令。打包机需要 Git、`zip`、`unzip`、Node.js 22.13+ 和 Bun 1.4+。将示例版本替换为本次候选版本，并指定一个尚未创建的输出目录。

```bash
bun install --frozen-lockfile
bun run check
bun run release:pack v0.2.0-rc.1 /path/to/new-candidate
```

命令打包构建后的 Server、配置示例、文档和许可证。从新目录解压，同一套 STDIO 用例会在 Node 和 Bun 上逐个验证 Server，通过后生成 `SHA256SUMS.txt`。可用 `NODE_BINARY` 或 `BUN_BINARY` 指定要验证的解释器。

GitHub 发布后，将同一版本的 ZIP 和校验清单下载到新目录，在下载目录运行 `shasum -a 256 -c SHA256SUMS.txt`。从维护者检出目录运行 `bun run test:e2e /path/to/extracted-release`，对下载解包后的 CLI 复验并记录发行版、提交、摘要和结果。

## 第三方 MCP 精选目录

按使用场景整理网上收集的 MCP 项目。每项都注明维护方、适用场景和官方来源，方便按需接入。

[浏览第三方精选目录](curated/README.md)
