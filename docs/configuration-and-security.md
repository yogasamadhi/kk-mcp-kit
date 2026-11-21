# 配置、安全模型与 plan/apply

## 配置契约

每个 CLI 强制要求绝对路径：

```bash
node servers/git-guardian/dist/cli.mjs --config /absolute/path/to/kk-mcp.config.json
```

不会搜索 home 目录、当前目录或环境变量中的隐式配置。Zod 是运行时真值，checked-in JSON
Schema 位于 `packages/core/config.schema.json`，完整示例位于
`examples/config/kk-mcp.config.example.json`。

必填字段只有 `version`、`stateDir` 和至少一个 `roots[]`；其余字段使用安全默认值。所有 root
ID、Server 配置 ID 和仓库引用在启动时校验。配置中的相对文件必须不能包含 `..`，桌面日志、
崩溃目录和 memory import roots 必须为绝对路径。

## 默认拒绝

以下能力缺省均为 `false`：

```text
gitGuardian.applyVendorSync
runtimeObserver.stopProcess
projectMemory.write
projectMemory.import
buildEvidence.run
desktopLab.launch
desktopLab.stop
desktopLab.capture
networkForensics.activeProbe
```

计划工具仍可调用，让使用者在授权前看到目标、影响、风险和过期时间。只读 capability 探测也
始终可用。配置未列出 app、service、profile、vendor 或 allowed host 时，Client 不能临时传入
替代对象扩大权限。

## 路径安全

Client 面向仓库的输入使用 `{ rootId, relativePath }`，不接受任意绝对路径。core 会执行：

1. 拒绝绝对 `relativePath` 和词法 `..` 逃逸；
2. canonicalize 配置 root；
3. 找到最近存在的父级并解析符号链接；
4. 再次确认真实路径仍在 allowlist root 内；
5. 对尚未创建的尾部路径保持同一边界。

project-memory 的导入是少数需要绝对输入路径的场景，但只能落在显式 `importRoots` 内，并使用
相同的真实路径检查。

## 安全子进程

Server 不公开任意 Shell。公共执行器直接 `spawn(executable, args, { shell: false })`，拒绝 NUL，
只继承最小基础环境和 profile 指定的环境白名单，并实施超时与 stdout/stderr 字节上限。
build-evidence 的 command、argv、cwd 和环境来自命名配置；Client 只能选择 profile。

## plan/apply 协议

```text
只读检查 → plan_* → opaque planId + fingerprint + expiresAt + risks
                         │
                         └→ apply_*(planId)
                              ├─ capability 是否启用
                              ├─ plan 是否存在/未过期/类型匹配
                              ├─ 当前状态指纹是否相同
                              ├─ 执行受限动作
                              └─ consume plan + JSONL audit
```

plan 默认 5 分钟过期且只可使用一次。Server 重启会使所有 plan 失效。Git 同步、进程终止、
应用启动/停止、memory 写入和 build 执行不能由调用者绕过 plan。Git vendor 同步失败会恢复原
submodule commit 和原 lock 内容。

## 输出、artifact、日志与审计

- 普通操作默认 30 秒，输出 256 KiB，列表 500 项；build profile 最长 30 分钟。
- artifact 写入 `stateDir/artifacts/<server>/`，使用随机 ID、SHA-256 和文件大小上限。
- runtime 日志只写 stderr；stdout 是纯 MCP JSONL 协议通道。
- 变更计划和执行写入 `stateDir/audit/YYYY-MM-DD.jsonl`。
- 常见 token、Bearer、GitHub token、敏感字段和用户正则会被脱敏。

## 明确不提供

任意 Shell、任意文件系统、自动 commit、subtree pull、键鼠自动化、管理员提权、原始网络抓包、
任意 HTTP Header/凭据和响应正文均不在接口内。
