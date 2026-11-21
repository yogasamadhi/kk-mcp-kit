# kk-mcp-kit 文档

- [配置、安全模型与 plan/apply](configuration-and-security.md)
- [7 个 Server 的 Tools、Resources 与权限](servers.md)
- [三平台 capability 表](platform-capabilities.md)
- [project-memory 隐私与导入格式](project-memory-privacy.md)

各 Server 通过独立的 STDIO 进程运行。公共配置、权限校验和审计逻辑位于 `packages/core/`。
所有运行入口使用显式绝对配置，系统写入、外部主动探测和敏感采集默认关闭。
工程 Agent 可将这些能力用于工作流，例如配合 [kk-skills](https://github.com/yogasamadhi/kk-skills)。
