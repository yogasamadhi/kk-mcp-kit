# 三平台 capability 表

三平台暴露完全相同的 Tool schema。调用前可以使用每个 Server 的 `get_capabilities`，桌面和
网络 Server 还提供更详细的动态探测 Tool。缺少系统命令、桌面会话或权限时返回
`UNSUPPORTED_BACKEND`、`UNSUPPORTED_PLATFORM` 或 `PERMISSION_DENIED`，不会静默降级为
危险操作。

| 能力 | macOS | Linux | Windows |
| --- | --- | --- | --- |
| 进程列表/身份 | `ps` | `ps`，端口用 `ss` | PowerShell CIM |
| 端口监听者 | `lsof` | `ss` | `Get-NetTCPConnection` |
| Compose | Docker CLI 动态探测 | Docker CLI 动态探测 | Docker CLI 动态探测 |
| 应用启动 | `open` | 配置 executable；desktop/URL 用 `xdg-open` | PowerShell `Start-Process` |
| 窗口元数据 | `osascript`/Accessibility | `swaymsg`、`hyprctl` 或 `wmctrl` | PowerShell process window metadata |
| 系统应用日志 | Unified Log | `journalctl --user` | Windows Event Log |
| 崩溃报告 | DiagnosticReports | 配置目录或 `coredumpctl` | WER/Event Log |
| 截图 | `screencapture` | `gnome-screenshot`、`grim` 或 `scrot` | PowerShell/.NET |
| DNS/TLS/HTTP | Node 标准模块 | Node 标准模块 | Node 标准模块 |
| 路由追踪 | `traceroute` 或 `tracepath` | `traceroute` 或 `tracepath` | `tracert.exe` |
| SQLite/FTS | `node:sqlite` | `node:sqlite` | `node:sqlite` |
| XCResult | 可解析配置结果 | `UNSUPPORTED_PLATFORM` | `UNSUPPORTED_PLATFORM` |

Linux 截图还依赖有效 `DISPLAY` 或 `WAYLAND_DISPLAY` 与相应后端权限。macOS 窗口读取可能需要
Accessibility，截图可能需要 Screen Recording；Windows Event Log 和 WER 只使用当前用户可读
范围。项目不会申请管理员权限。

CI 在 macOS、Ubuntu、Windows 上覆盖 Node 22/24 和 Bun 1.4。无桌面会话的 CI 只要求
capability 探测准确；存在后端时才适合额外执行截图 smoke。
