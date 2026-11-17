# 交接：Chartelis AI 助手改用系统 Codex CLI

日期：2026-11-17 · 分支：`main` · 状态：**开发暂停，核心链路已通，剩 UI 实机复验与收尾**

## 1. 任务与架构决策

用户要求：把 Chartelis 的 AI 助手从「自带 bundle 的 dsh + Node 运行时」改为像 t3code（`F:\projects\t3code-chinese`）一样**直接使用系统安装的 Codex CLI**，不再 bundle 任何运行时。

- 旧架构（已删除）：`scripts/prepare-harness.mjs` 下载 Node 24 + npm ci dsh 0.2.1-rc.2 到 `.tools/dsh`，Rust 起 dsh web 服务，子 WebView 嵌 dsh 界面，CSS overlay 裁剪。
- 新架构（已实现）：Rust 发现系统 `codex` 二进制 → spawn `codex app-server` → **换行分隔 JSON（JSONL）JSON-RPC over stdio** → Tauri 命令/事件转发 → React 自建对话 UI。与 t3code 的 `effect-codex-app-server` 协议一致。
- 凭据/历史沿用用户自己的 `~/.codex`（本机已登录，apiKey 方式），Chartelis 不碰密钥。

## 2. 已完成

### Rust（`src-tauri/src/codex.rs`，取代 `harness.rs`）
- 二进制发现：`CODEX_BIN` 覆盖 → PATH（Windows 优先 `codex.exe`，其次 `.cmd/.bat` shim）→ 常见安装目录（`~/.codex/bin`、`%APPDATA%\npm`、Volta、pnpm、scoop、homebrew 等）。版本门槛 `>= 0.156.0`（对齐 t3code）。
- **Windows .cmd shim 必须用 `raw_arg` 拼整条命令行** `""<path>" app-server"` 交给 `cmd.exe /d /s /c`；标准参数转义会把内层引号变成 `\"` 导致 cmd 报「不是内部或外部命令」（已踩坑并修复，Node 冒烟脚本同理用 `windowsVerbatimArguments`）。
- `Shared`（child/writer/pending/next_id/stderr_tail）+ `Runtime`（shared/root/codex_home/Windows Job Object）。命令等待响应时**不持有状态锁**（克隆 Arc 后释放）。
- 命令：`codex_status` / `codex_start` / `codex_stop` / `codex_request`（通用 JSON-RPC 透传）/ `codex_respond`（审批应答）/ `codex_reject`（未知服务器请求回 -32601，避免 agent 干等）/ `codex_read_rollout`（历史回退读取，**围栏：仅允许 codex home sessions 目录下的 .jsonl**，只放行展示相关条目，过滤 developer/system 消息与工具定义）。
- 事件：`codex-event` → `{type:"notification"|"request"|"exit", ...}`；进程退出时 fail 所有 pending 请求并广播 exit。
- Windows Job Object 保证退出时连子进程一起杀；`CREATE_NO_WINDOW`。
- `lib.rs` 已注册全部命令；`sha2` 依赖已移除；`cargo test --lib` 6 项通过。

### 前端
- `src/codex-client.ts`：协议封装、线程/回合/模型/账号 API、双模式历史加载（legacy `thread/read` / paginated `thread/turns/list`，**"not supported" 时回退 rollout**）、按文件夹的偏好持久化（localStorage `chartelis.codex:<dir>`）。
- `src/codex-items.ts`：实时 ThreadItem 与 rollout response_item 统一规范化为 DisplayItem（user/agent/reasoning/command/fileChange/tool/webSearch/error/info）。
- `src/AIAssistant.tsx`：完整重写。状态机 idle→checking→install/unsupported/starting/auth→ready/error；流式渲染（agentMessage delta、reasoning summary delta、command outputDelta、fileChange patchUpdated）、审批卡片（新式 accept/acceptForSession/decline/cancel + 旧式 approved/approved_for_session/{denied}/abort）、requestUserInput 问答、线程切换/新建（自动继续最近线程）、设置弹层（模型/审批策略/沙箱，逐 turn 覆盖）、token 用量、计划、安装/登录引导（含复制按钮）、Enter 发送（含 IME isComposing 保护）。
- `src/ai.css` 全新聊天样式；`src/locales/en.json` 新增约 70 条翻译；`App.tsx` 移除 `obscured` prop（DOM UI 自然层叠，不再需要隐藏子 WebView）。
- 复用 `ai-markdown.ts` 的安全 Markdown 渲染（去 HTML/远程图片/危险链接）。

### 构建/打包清理
- 删除：`harness/` 全目录、`scripts/prepare-harness.mjs`、`scripts/smoke-harness.mjs`、`.tools/`（含 dsh bundle 与测试残留）、`src-tauri/src/harness.rs`。
- `scripts/desktop.mjs` 不再 prepare-harness；`tauri.windows.conf.json` 移除 `bundle.resources`；`package.json` 脚本改为 `test:codex:runtime`；CI（`.github/workflows/build.yml`）移除 `pnpm test:harness`；`vite.config.ts` 移除 `.tools` watch ignore。
- 新增 `scripts/smoke-codex.mjs`：真实 codex 冒烟（隔离 CODEX_HOME，不调模型）。

### 文档
- `README.md` AI 章节重写为 Codex 版；开发/验证/结构章节同步。
- `e2e/verify-ai.mjs` 重写为浏览器预览检查（旧 API 面板测试已失效）。

## 3. 关键协议发现（本机 codex-cli 0.167.2 实测，必读）

1. **帧不带 `"jsonrpc":"2.0"` 字段**：请求 `{id,method,params}`、通知 `{method,params}`、响应 `{id,result|error}`。握手 `initialize`（clientInfo + capabilities.experimentalApi）→ `{userAgent,codexHome,platformFamily,platformOs}` → 通知 `initialized`。
2. **空线程不持久化**：`thread/start` 只建内存线程，首个 turn 才写 rollout；空线程 `thread/resume` 报 "no rollout found"，`thread/list` 也不含它。UI 因此「首条消息时才 thread/start」。
3. **0.167.2 的分页历史 API 是 stub**：`thread/turns/list`、`thread/items/list`、`thread/read{includeTurns:true}`、不带 excludeTurns 的 resume 全部报 `list_turns is not supported yet (-32601)`。t3code 同样会失败（它没有回退）。**Chartelis 已实现 rollout 文件回退**（`thread.path` → `codex_read_rollout` → rolloutToItems）。`thread/resume{excludeTurns:true}` 与 `thread/read{includeTurns:false}` 可用。
4. `thread/list` 支持 cwd 过滤，返回 name/preview/updatedAt/path/historyMode；`model/list` 正常（本机默认 gpt-6.1-sol）。`account/read` → `{account:{type:"apiKey"},requiresOpenaiAuth:true}`；未登录判定 `account==null && requiresOpenaiAuth`。
5. 审批走新式 `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`（decision: accept/acceptForSession/decline/cancel），旧式 execCommandApproval/applyPatchApproval 双协议兼容；`serverRequest/resolved` 通知要撤卡片。
6. 流式通知：`item/started`、`item/completed`（权威终态）、`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/commandExecution/outputDelta`、`item/fileChange/patchUpdated`、`turn/started`、`turn/completed`、`turn/plan/updated`、`thread/tokenUsage/updated`、`error{willRetry}`。**没有 `item/updated`**。
7. `turn/start` 的 sandboxPolicy 是**对象**（{type:"workspaceWrite"}…），`thread/start` 的 sandbox 是**字符串枚举**，别混用。approvalPolicy 此版本无 "on-failure"。
8. t3code 参考报告详见本会话研究子代理输出；关键文件：`packages/effect-codex-app-server/src/{protocol.ts,client.ts,_generated/meta.gen.ts}`、`apps/server/src/provider/{CodexInstallation.ts,CodexProvider.ts,Layers/CodexSessionRuntime.ts}`、`packages/shared/src/shell.ts`（resolveSpawnCommand）。

## 4. 验证状态

| 项目 | 结果 |
| --- | --- |
| `pnpm test`（vitest） | ✅ 17 文件 89 项通过（含新 AIAssistant 5 项 + codex-items 4 项） |
| `pnpm build`（tsc + vite） | ✅ 通过（仅既有 dynamic-import 警告） |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | ✅ 6 项通过 |
| `pnpm test:codex:runtime`（真实 codex 冒烟） | ✅ 双工作区通过（握手/线程/历史降级/模型目录/项目目录零写入） |
| 真实桌面应用全链路（CDP 9223 + `.verify/verify-codex-app.mjs`） | ✅ IPC 全通：status/start/account/thread list/model list/rollout 围栏/并发请求/stop；❌ 最后一步 UI 断言失败（见下） |

### 已修复的重大 bug（勿回退）
- **pump 死锁**：`pump()` 的 stdout 读循环必须在**独立线程**运行（`std::thread::spawn`），早期版本在 `start()` 里同步调用，导致 initialize 永远发不出去、状态锁被永久持有（表现：status 秒回但 start/stop/request 全挂）。已在 `start()` 中用线程包裹修复。

### 未决：UI 实机断言
`.verify/verify-codex-app.mjs` 第 6 步点击「AI 助手」按钮后 `complementary` 面板 5s 内未出现。IPC 层全部正常，单元测试也覆盖了面板渲染。可能原因（待排查）：
- 开发窗口当时显示在用户桌面，**用户可能同时在手动操作**（快照里出现了 typora_notes 文件夹，而代码里文件夹并不持久化 → 疑似人工打开），点击可能被并发交互干扰；
- 开发版与安装版共用 WebView2 用户数据目录（同 identifier `com.chartelis.editor`），localStorage 工作区会恢复用户真实文稿；
- 顶栏按钮位于 drag region / Windows 窗口角控件附近，需确认点击命中。
建议下一步：重跑该脚本（先 `pnpm desktop` 并设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`），失败时用 CDP 截图 + 检查 `aria-expanded`；必要时人工打开助手面板走一遍真实对话（会消耗用户 API 额度，先征得同意）。

## 5. 剩余工作清单

1. 复验 UI 实机（上节），最好人工走一次完整对话 + 审批 + 历史切换。
2. macOS 路径未实机验证（发现逻辑含 brew/登录 shell 差异；GUI 最小 PATH 问题 t3code 用登录 shell 读 PATH 解决，我们目前只加了常见目录回退，必要时补 `$SHELL -ilc 'printenv PATH'`）。
3. `e2e/verify-ai.mjs` 需在 `pnpm dev` 下跑一次确认。
4. 可选打磨：reasoning 原始 content 展示、图片类 item、`item/permissions/requestApproval` 的专用 UI（目前按通用审批卡片处理）、elicitation 表单（目前 reject）。
5. 发布前：版本号/release notes（当前 0.1.10 未动）、NSIS 安装包体积会显著变小（不再带 Node+dsh，约 15MiB → 数 MiB）。
6. `.acl-recovery/` 是本机 Windows 权限修复的备份产物（DSH 沙箱曾无法删除工作区文件，技能脚本修复了 `src-tauri`/`src-tauri\src` 的用户权限）；`.verify/` 是验证脚本与临时工程。两者已随本次提交入库，后续可酌情清理或加 gitignore。

## 6. 快速上手

```sh
pnpm install --frozen-lockfile
pnpm test                      # 前端单元
pnpm build                     # 生产构建
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm test:codex:runtime        # 真实 codex 冒烟（无 codex 自动跳过）
pnpm desktop                   # 开发版（助手需系统 codex >= 0.156 且已 codex login）
```

文件地图：`src-tauri/src/codex.rs`（传输/发现/围栏）· `src/codex-client.ts`（协议）· `src/codex-items.ts`（规范化）· `src/AIAssistant.tsx`（UI）· `scripts/smoke-codex.mjs`（冒烟）· `.verify/verify-codex-app.mjs`（实机 CDP 验证）。
