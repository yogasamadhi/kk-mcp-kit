# 7 个 Server 的 Tools、Resources 与权限

所有 Tool 都返回统一 envelope；表中的“计划”是只读操作，“执行”必须显式 capability。每个
Server 还提供 `get_capabilities`。

## workspace

完全只读。仓库输入均为 `{ rootId, relativePath }`。

```text
discover_repositories       inspect_repository
inspect_workspace           find_project_instructions
analyze_dependency_graph    search_workspace
```

识别 Git、Bun/npm/pnpm/yarn workspace、Cargo、Go、Python、Maven 和 Gradle。搜索优先 `rg`，
缺少时使用有深度、文件大小和结果数量上限的 Node 遍历。

Resources：`workspace://roots`、`workspace://repositories`。

## git-guardian

```text
inspect_git_state      compare_git_refs       inspect_submodules
inspect_vendor_lock    inspect_subtree        plan_vendor_sync
apply_vendor_sync      plan_commit            verify_commit_scope
```

`apply_vendor_sync` 需要 `gitGuardian.applyVendorSync`，只同步配置中的 submodule 和
`vendor-lock.json`。它拒绝 dirty/uninitialized submodule、过期 plan 和状态漂移，并在失败时
回滚。subtree 只检查；`plan_commit` 只给出范围和消息建议，不提交。

## runtime-observer

```text
list_dev_processes       find_process_by_port    inspect_process
list_services            inspect_service_health tail_service_log
plan_stop_process        apply_stop_process
```

服务必须在配置中声明 process match、PID、health URL、日志路径或 Compose service。
`apply_stop_process` 需要 `runtimeObserver.stopProcess`，并重新校验 PID、启动时间和 executable；
自身、父进程、低 PID 和已知 Windows 关键进程不可终止。

## project-memory

```text
search_project_memory       get_project_context
plan_record_decision        plan_record_incident
plan_record_verification    plan_link_memory
plan_import_memory          apply_memory_plan
```

使用 `node:sqlite`、WAL 和 FTS5。普通写入需要 `projectMemory.write`，导入需要
`projectMemory.import`。Markdown、JSON、JSONL 和可选 Codex rollout JSONL 只在明确调用时
解析；导入 plan 绑定源文件 SHA-256。

Resource：`project-memory://stats`。

## build-evidence

```text
list_verification_profiles  detect_test_frameworks  plan_verification
run_verification            get_verification_run    get_failed_tests
compare_verification_runs   list_build_artifacts    inspect_build_artifact
```

`run_verification` 需要 `buildEvidence.run`，且只能运行配置中的命名 profile。支持 generic
exit、JUnit XML、Go test JSON、Cargo/libtest 和 XCResult 结果；Vitest、Jest、pytest、Maven
和 Gradle 通过 JUnit 文件接入。无 reporter 时仍持久化退出码、截断日志和 artifact 摘要。

## desktop-lab

```text
list_desktop_capabilities  list_configured_apps   inspect_app_process
inspect_window_state       collect_app_logs       collect_crash_reports
capture_app_screenshot     plan_launch_app        apply_launch_app
plan_stop_app              apply_stop_app
```

只操作配置中的 app。launch、stop、capture 分别需要 `desktopLab` 下的同名 capability；启动和
停止使用进程集合 fingerprint plan。截图写入受限 artifact 并动态注册
`desktop-lab://artifacts/<id>` Resource。没有键鼠输入工具。

## network-forensics

```text
list_network_capabilities  inspect_proxy_environment  inspect_dns
inspect_tls                trace_http_request         trace_route
diagnose_endpoint          compare_network_paths
```

除 capability 和 proxy 环境外的主动操作都需要 `networkForensics.activeProbe`，目标必须匹配
`allowedHosts`。DNS 结果固定到真实 TLS/HTTP 连接，redirect 每一跳重新检查。HTTP 不接受任意
Header 或凭据，不返回 body；响应只保留有限诊断 Header。命名 proxy profile 在 v1 没有安全
transport 后端时返回结构化 `UNSUPPORTED_BACKEND`。
