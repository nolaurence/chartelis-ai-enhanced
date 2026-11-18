//! System Codex CLI integration, mirroring t3code: no bundled runtime.
//! We discover the user's installed `codex` binary, spawn `codex app-server`
//! and speak newline-delimited JSON-RPC over its stdio. Frames carry no
//! "jsonrpc" field: requests are {id, method, params}, notifications are
//! {method, params}, responses are {id, result|error}. The editor UI owns
//! the protocol semantics; this module is a transport with a request fence.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

const EVENT: &str = "codex-event";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct CodexState(Mutex<Option<Runtime>>);

/// Transport state shared with the reader thread. Commands clone the Arc and
/// release the state lock before waiting, so a slow request never blocks
/// stop/start or other requests.
struct Shared {
    child: Mutex<Child>,
    writer: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    next_id: AtomicU64,
    stderr_tail: Mutex<Vec<String>>,
}

struct Runtime {
    shared: Arc<Shared>,
    root: PathBuf,
    codex_home: PathBuf,
    #[cfg(windows)]
    job: isize,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let mut child = self.shared.child.lock().unwrap_or_else(|e| e.into_inner());
        let pid = child.id();
        #[cfg(windows)]
        terminate_tree(pid);
        #[cfg(not(windows))]
        { let _ = child.kill(); }
        let _ = child.wait();
        #[cfg(windows)]
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job as _); }
    }
}

fn exited(shared: &Shared) -> Result<bool, String> {
    Ok(shared.child.lock().unwrap_or_else(|e| e.into_inner()).try_wait().map_err(|e| e.to_string())?.is_some())
}

fn trusted(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() == "main" { Ok(()) } else { Err("Only the editor can control its assistant".into()) }
}

fn normalized_root(path: &str) -> Result<PathBuf, String> {
    let input = Path::new(path);
    if !input.is_absolute() || !input.is_dir() { return Err("请选择一个存在的工程文件夹 / Choose an existing project folder".into()); }
    let path = input.canonicalize().map_err(|e| e.to_string())?;
    let text = path.to_string_lossy();
    // Codex understands ordinary UNC paths, not Rust's verbatim prefix.
    Ok(PathBuf::from(if let Some(rest) = text.strip_prefix(r"\\?\UNC\") { format!(r"\\{}", rest) } else { text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned() }))
}

/// How the discovered binary must be launched.
#[derive(Clone, Debug, PartialEq)]
enum Launch {
    /// A native executable (or a Unix shebang script) we can spawn directly.
    Direct(PathBuf),
    /// A Windows .cmd/.bat shim; route it through cmd.exe.
    CmdShim(PathBuf),
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() { return false; }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    { true }
}

/// Resolve the system Codex CLI the way t3code does: an explicit override
/// first, then PATH, then well-known install locations. GUI launches on
/// macOS/Windows often inherit a minimal PATH, so the fallbacks matter.
fn discover() -> Option<Launch> {
    if let Some(explicit) = std::env::var_os("CODEX_BIN").filter(|v| !v.is_empty()) {
        let path = PathBuf::from(explicit);
        if is_executable_file(&path) {
            return Some(classify(path));
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.as_os_str().is_empty() { continue; }
            candidates.push(dir.join("codex"));
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        candidates.push(home.join(".codex/bin/codex"));
        candidates.push(home.join(".local/bin/codex"));
        candidates.push(home.join(".volta/bin/codex"));
        candidates.push(home.join(".bun/bin/codex"));
        candidates.push(home.join("scoop/shims/codex"));
    }
    // GUI launches may inherit a minimal PATH; cover the usual CLI install dirs.
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            candidates.push(PathBuf::from(appdata).join("npm/codex"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            candidates.push(local.join("Programs/nodejs/codex"));
            candidates.push(local.join("Volta/bin/codex"));
            candidates.push(local.join("pnpm/codex"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));
        candidates.push(PathBuf::from("/usr/local/bin/codex"));
    }
    // Prefer a native executable over a shell shim anywhere in the search order.
    let mut shim: Option<Launch> = None;
    for base in candidates {
        #[cfg(windows)]
        {
            let exe = base.with_extension("exe");
            if is_executable_file(&exe) { return Some(Launch::Direct(exe)); }
            for ext in ["cmd", "bat"] {
                let candidate = base.with_extension(ext);
                if is_executable_file(&candidate) {
                    shim.get_or_insert(Launch::CmdShim(candidate));
                    break;
                }
            }
            // npm also installs an extensionless POSIX shim; it is not spawnable here.
        }
        #[cfg(not(windows))]
        {
            if is_executable_file(&base) { return Some(Launch::Direct(base)); }
        }
    }
    shim
}

#[cfg(windows)]
fn classify(path: PathBuf) -> Launch {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("cmd") | Some("bat") => Launch::CmdShim(path),
        _ => Launch::Direct(path),
    }
}
#[cfg(not(windows))]
fn classify(path: PathBuf) -> Launch { Launch::Direct(path) }

fn command_for(launch: &Launch) -> Command {
    match launch {
        Launch::Direct(path) => Command::new(path),
        Launch::CmdShim(_) => {
            let mut command = Command::new(std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()));
            // /d skips AutoRun; /s makes cmd strip the outer quote pair.
            command.args(["/d", "/s", "/c"]);
            command
        }
    }
}

/// cmd.exe needs one verbatim command line: `""<shim>" <args…>"`.
/// Standard argument escaping would turn the inner quotes into `\"`, which
/// cmd.exe treats as part of a literal program name.
fn shim_command_line(path: &Path, args: &[&str]) -> String {
    format!("\"\"{}\" {}\"", path.display(), args.join(" "))
}

fn with_args(command: &mut Command, launch: &Launch, args: &[&str]) {
    match launch {
        Launch::Direct(_) => { command.args(args); }
        Launch::CmdShim(path) => {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.raw_arg(shim_command_line(path, args));
            }
            #[cfg(not(windows))]
            { let _ = (command, path, args); unreachable!("cmd shims are Windows-only"); }
        }
    }
}

fn launch_path(launch: &Launch) -> PathBuf {
    match launch { Launch::Direct(path) | Launch::CmdShim(path) => path.clone() }
}

#[cfg(windows)]
fn no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn no_window(_command: &mut Command) {}

#[cfg(windows)]
fn assign_job(child: &Child) -> Result<isize, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() { return Err(std::io::Error::last_os_error().to_string()); }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as _, std::mem::size_of_val(&info) as u32) == 0
            || AssignProcessToJobObject(job, child.as_raw_handle()) == 0 {
            let error = std::io::Error::last_os_error().to_string();
            CloseHandle(job);
            return Err(error);
        }
        Ok(job as isize)
    }
}

/// Terminate a process and every descendant, deepest first.
///
/// The Windows Job Object alone is not enough here: npm installs `codex` as a
/// `.cmd` shim whose node launcher spawns the real binary with
/// CREATE_BREAKAWAY_FROM_JOB, so grandchildren escape the job we assign to the
/// shim. Snapshot the process table and walk the parent chain instead.
#[cfg(windows)]
fn terminate_tree(root: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
        System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE},
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == -1isize as _ { return; }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut tree: Vec<(u32, u32)> = Vec::new();
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                tree.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32NextW(snapshot, &mut entry) == 0 { break; }
            }
        }
        CloseHandle(snapshot);
        // Insertion order is breadth-first, so reversing terminates children first.
        for pid in descendants(root, &tree).iter().rev() {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, *pid);
            if !handle.is_null() {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
}

/// Collect `root` and every descendant from a (pid, parent) snapshot.
/// Insertion order is breadth-first, so reversing terminates children first.
#[cfg(windows)]
fn descendants(root: u32, tree: &[(u32, u32)]) -> Vec<u32> {
    let mut targets = vec![root];
    loop {
        let mut grown = false;
        for (pid, parent) in tree {
            if targets.contains(parent) && !targets.contains(pid) { targets.push(*pid); grown = true; }
        }
        if !grown { break; }
    }
    targets
}

fn version_of(launch: &Launch) -> Option<String> {
    let mut command = command_for(launch);
    with_args(&mut command, launch, &["--version"]);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    no_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() { return None; }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

/// t3code supports codex >= 0.156.0; older app-server protocols lack the
/// item/turn methods this editor renders.
fn version_supported(version: &str) -> bool {
    let Some(rest) = version.strip_prefix("codex-cli ") else { return false };
    let numbers: Vec<Option<u64>> = rest.split('.').map(|part| part.parse::<u64>().ok()).collect();
    match numbers.as_slice() {
        [Some(major), Some(minor), Some(_), ..] => *major > 0 || *minor >= 156,
        _ => false,
    }
}

pub fn stop(app: &tauri::AppHandle) {
    let state = app.state::<CodexState>();
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    slot.take();
}

fn write_frame(writer: &Mutex<ChildStdin>, frame: &Value) -> Result<(), String> {
    let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
    let mut line = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
    line.push(b'\n');
    writer.write_all(&line).and_then(|_| writer.flush()).map_err(|e| format!("无法写入 Codex 进程 / Could not write to Codex: {e}"))
}

fn request(shared: &Shared, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    if exited(shared)? {
        return Err("助手已停止，请重新连接 / The assistant stopped; reconnect".into());
    }
    let id = shared.next_id.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel();
    shared.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), sender);
    // app-server frames deliberately omit the "jsonrpc" field.
    let frame = json!({"id": id, "method": method, "params": params});
    if let Err(error) = write_frame(&shared.writer, &frame) {
        shared.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id.to_string());
        return Err(error);
    }
    match receiver.recv_timeout(timeout) {
        Ok(response) => {
            if let Some(error) = response.get("error") {
                let message = error.get("message").and_then(Value::as_str).unwrap_or("unknown error");
                Err(format!("Codex: {message}"))
            } else {
                Ok(response.get("result").cloned().unwrap_or(Value::Null))
            }
        }
        Err(_) => {
            shared.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id.to_string());
            Err(format!("Codex 请求超时 / Codex request timed out: {method}"))
        }
    }
}

fn pump(app: tauri::AppHandle, shared: Arc<Shared>, runtime_child_stdout: std::process::ChildStdout, stderr: std::process::ChildStderr) {
    // stderr is kept only as a short diagnostic tail for exit reports; chat
    // content never crosses this channel and nothing is persisted.
    {
        let shared = shared.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut tail = shared.stderr_tail.lock().unwrap_or_else(|e| e.into_inner());
                tail.push(line);
                if tail.len() > 40 { tail.remove(0); }
            }
        });
    }
    for line in BufReader::new(runtime_child_stdout).lines().map_while(Result::ok) {
        let Ok(frame) = serde_json::from_str::<Value>(&line) else { continue };
        let has_id = frame.get("id").map(|id| !id.is_null()).unwrap_or(false);
        let method = frame.get("method").and_then(Value::as_str);
        match (has_id, method) {
            (true, None) => {
                // Response to one of our requests; ids may arrive as number or string.
                let key = match frame.get("id") {
                    Some(Value::Number(number)) => Some(number.to_string()),
                    Some(Value::String(text)) => Some(text.clone()),
                    _ => None,
                };
                if let Some(key) = key {
                    if let Some(sender) = shared.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&key) {
                        let _ = sender.send(frame);
                    }
                }
            }
            (true, Some(method)) => {
                // Server-to-client request (tool approvals, elicitations, …).
                let _ = app.emit(EVENT, json!({"type": "request", "id": frame["id"], "method": method, "params": frame.get("params").cloned().unwrap_or(Value::Null)}));
            }
            (false, Some(method)) => {
                let _ = app.emit(EVENT, json!({"type": "notification", "method": method, "params": frame.get("params").cloned().unwrap_or(Value::Null)}));
            }
            _ => {}
        }
    }
    // stdout closed: fail every pending request, wait for the process to
    // settle, then report the exit once.
    let tail = shared.stderr_tail.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
    for (_, sender) in shared.pending.lock().unwrap_or_else(|e| e.into_inner()).drain() {
        let _ = sender.send(json!({"error": {"code": -32000, "message": format!("Codex app-server exited\n{tail}")}}));
    }
    let status = loop {
        match shared.child.lock().unwrap_or_else(|e| e.into_inner()).try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break None,
        }
    };
    let _ = app.emit(EVENT, json!({"type": "exit", "code": status.and_then(|s| s.code()), "stderr": tail}));
}

fn start(app: tauri::AppHandle, directory: String) -> Result<(), String> {
    let root = normalized_root(&directory)?;
    let launch = discover().ok_or("未找到 Codex CLI。请先安装：npm install -g @openai/codex / Codex CLI not found. Install it first: npm install -g @openai/codex")?;
    let state = app.state::<CodexState>();
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(current) = slot.as_mut() {
        if current.root == root && !exited(&current.shared)? { return Ok(()); }
    }
    slot.take();
    let mut command = command_for(&launch);
    with_args(&mut command, &launch, &["app-server"]);
    command.current_dir(&root)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut command);
    let mut child = command.spawn().map_err(|e| format!("无法启动 Codex / Could not start Codex: {e}"))?;
    #[cfg(windows)]
    let job = match assign_job(&child) { Ok(job) => job, Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error); } };
    let stdin = child.stdin.take().ok_or("Codex stdin is unavailable")?;
    let stdout = child.stdout.take().ok_or("Codex stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("Codex stderr is unavailable")?;
    let shared = Arc::new(Shared {
        child: Mutex::new(child), writer: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()), next_id: AtomicU64::new(1), stderr_tail: Mutex::new(Vec::new()),
    });
    let mut runtime = Runtime { shared: shared.clone(), root, codex_home: PathBuf::new(), #[cfg(windows)] job };
    // The stdout loop runs until EOF; it must own a thread, not the caller.
    {
        let app = app.clone();
        let shared = shared.clone();
        std::thread::spawn(move || pump(app, shared, stdout, stderr));
    }
    let initialize = json!({
        "clientInfo": {"name": "chartelis", "title": "Chartelis", "version": env!("CARGO_PKG_VERSION")},
        "capabilities": {"experimentalApi": true, "optOutNotificationMethods": ["turn/diff/updated"]},
    });
    match request(&runtime.shared, "initialize", initialize, STARTUP_TIMEOUT) {
        Ok(result) => {
            runtime.codex_home = result.get("codexHome").and_then(Value::as_str).map(PathBuf::from).unwrap_or_default();
            let _ = write_frame(&runtime.shared.writer, &json!({"method": "initialized"}));
            *slot = Some(runtime);
            Ok(())
        }
        Err(error) => {
            let tail = runtime.shared.stderr_tail.lock().unwrap_or_else(|e| e.into_inner()).join("\n");
            Err(if tail.is_empty() { error } else { format!("{error}\n{tail}") })
        }
    }
}

#[derive(serde::Serialize)]
pub struct CodexStatus {
    installed: bool,
    supported: bool,
    path: Option<String>,
    version: Option<String>,
}

#[tauri::command]
pub async fn codex_status(webview: tauri::Webview) -> Result<CodexStatus, String> {
    trusted(&webview)?;
    tauri::async_runtime::spawn_blocking(|| match discover() {
        Some(launch) => {
            let version = version_of(&launch);
            CodexStatus { installed: true, supported: version.as_deref().map(version_supported).unwrap_or(false), path: Some(launch_path(&launch).to_string_lossy().into_owned()), version }
        }
        None => CodexStatus { installed: false, supported: false, path: None, version: None },
    }).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn codex_start(app: tauri::AppHandle, webview: tauri::Webview, directory: String) -> Result<(), String> {
    trusted(&webview)?;
    tauri::async_runtime::spawn_blocking(move || start(app, directory)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn codex_stop(app: tauri::AppHandle, webview: tauri::Webview) -> Result<(), String> {
    trusted(&webview)?;
    tauri::async_runtime::spawn_blocking(move || stop(&app)).await.map_err(|e| e.to_string())
}

/// Generic JSON-RPC passthrough. Only the editor webview can reach it, and
/// the app-server itself enforces sandbox and approval policies.
#[tauri::command]
pub async fn codex_request(app: tauri::AppHandle, webview: tauri::Webview, method: String, params: Value) -> Result<Value, String> {
    trusted(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let shared = {
            let state = app.state::<CodexState>();
            let slot = state.0.lock().map_err(|e| e.to_string())?;
            slot.as_ref().ok_or("助手未运行 / The assistant is not running")?.shared.clone()
        };
        request(&shared, &method, params, REQUEST_TIMEOUT)
    }).await.map_err(|e| e.to_string())?
}

/// Answer a server-to-client request (for example a tool approval).
#[tauri::command]
pub async fn codex_respond(app: tauri::AppHandle, webview: tauri::Webview, id: Value, result: Value) -> Result<(), String> {
    trusted(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let shared = {
            let state = app.state::<CodexState>();
            let slot = state.0.lock().map_err(|e| e.to_string())?;
            slot.as_ref().ok_or("助手未运行 / The assistant is not running")?.shared.clone()
        };
        write_frame(&shared.writer, &json!({"id": id, "result": result}))
    }).await.map_err(|e| e.to_string())?
}

/// Reject a server-to-client request the editor does not implement, so the
/// agent is never left waiting on us.
#[tauri::command]
pub async fn codex_reject(app: tauri::AppHandle, webview: tauri::Webview, id: Value, message: String) -> Result<(), String> {
    trusted(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let shared = {
            let state = app.state::<CodexState>();
            let slot = state.0.lock().map_err(|e| e.to_string())?;
            slot.as_ref().ok_or("助手未运行 / The assistant is not running")?.shared.clone()
        };
        write_frame(&shared.writer, &json!({"id": id, "error": {"code": -32601, "message": message}}))
    }).await.map_err(|e| e.to_string())?
}

/// Read a persisted session rollout for history display. Some codex builds
/// stub the paginated history API ("list_turns is not supported yet"), so
/// the editor falls back to the rollout file the thread metadata points at.
/// Fenced to .jsonl files inside this runtime's codex home sessions dir;
/// only display-relevant entries cross IPC, never tool definitions or keys.
#[tauri::command]
pub async fn codex_read_rollout(app: tauri::AppHandle, webview: tauri::Webview, path: String) -> Result<Value, String> {
    trusted(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let codex_home = {
            let state = app.state::<CodexState>();
            let slot = state.0.lock().map_err(|e| e.to_string())?;
            slot.as_ref().ok_or("助手未运行 / The assistant is not running")?.codex_home.clone()
        };
        let sessions = codex_home.join("sessions").canonicalize().map_err(|_| "Codex 会话目录不存在 / Codex sessions directory is missing")?;
        let canonical = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&sessions) || canonical.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            return Err("只允许读取 Codex 会话记录 / Only Codex session rollouts can be read".into());
        }
        let file = std::fs::File::open(&canonical).map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        let mut truncated = false;
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if line.len() > 2_000_000 { continue; }
            let Ok(entry) = serde_json::from_str::<Value>(&line) else { continue };
            let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
            let payload = entry.get("payload");
            let payload_type = payload.and_then(|p| p.get("type")).and_then(Value::as_str).unwrap_or("");
            let keep = match kind {
                "response_item" => match payload_type {
                    "message" => !matches!(payload.and_then(|p| p.get("role")).and_then(Value::as_str), Some("developer") | Some("system")),
                    "function_call" | "function_call_output" | "local_shell_call" | "custom_tool_call" | "reasoning" => true,
                    _ => false,
                },
                "event_msg" => matches!(payload_type, "task_started" | "task_complete" | "turn_aborted"),
                _ => false,
            };
            if !keep { continue; }
            if entries.len() >= 20_000 { truncated = true; break; }
            entries.push(entry);
        }
        Ok(json!({"entries": entries, "truncated": truncated}))
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_root_must_be_an_existing_absolute_directory() {
        let path = std::env::current_dir().unwrap();
        assert!(normalized_root("relative").is_err());
        assert!(normalized_root(path.join("missing-project").to_str().unwrap()).is_err());
        let root = normalized_root(path.to_str().unwrap()).unwrap();
        assert!(root.is_absolute());
        assert!(!root.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn discovery_finds_a_launchable_binary_when_present() {
        // The development machine has codex installed; CI may not. Both are valid.
        if let Some(launch) = discover() {
            assert!(is_executable_file(&launch_path(&launch)));
        }
        let missing = PathBuf::from("definitely-missing-codex-binary");
        assert!(!is_executable_file(&missing));
        #[cfg(windows)]
        assert_eq!(classify(PathBuf::from(r"C:\tools\codex.cmd")), Launch::CmdShim(PathBuf::from(r"C:\tools\codex.cmd")));
        #[cfg(windows)]
        assert_eq!(classify(PathBuf::from(r"C:\tools\codex.exe")), Launch::Direct(PathBuf::from(r"C:\tools\codex.exe")));
    }

    #[test]
    fn cmd_shims_are_routed_through_cmd_exe() {
        let shim = Launch::CmdShim(PathBuf::from(r"C:\tools\codex.cmd"));
        let command = command_for(&shim);
        let program = command.get_program().to_string_lossy().to_lowercase();
        assert!(program.ends_with("cmd.exe"));
        let args: Vec<String> = command.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["/d", "/s", "/c"]);
        assert_eq!(launch_path(&shim), PathBuf::from(r"C:\tools\codex.cmd"));
        // The verbatim line keeps inner quotes intact for cmd.exe /s.
        assert_eq!(shim_command_line(Path::new(r"C:\Program Files\npm\codex.cmd"), &["app-server"]),
            "\"\"C:\\Program Files\\npm\\codex.cmd\" app-server\"");
    }

    #[test]
    fn jsonrpc_frames_are_classified_correctly() {
        // app-server frames carry no "jsonrpc" field.
        let response: Value = serde_json::from_str(r#"{"id":1,"result":{"ok":true}}"#).unwrap();
        assert!(response.get("id").is_some() && response.get("method").is_none());
        let request: Value = serde_json::from_str(r#"{"id":9,"method":"item/commandExecution/requestApproval","params":{}}"#).unwrap();
        assert!(request.get("id").is_some() && request.get("method").is_some());
        let notification: Value = serde_json::from_str(r#"{"method":"turn/completed","params":{}}"#).unwrap();
        assert!(notification.get("id").is_none() && notification.get("method").is_some());
    }

    #[test]
    fn version_gate_matches_t3code_compatibility() {
        assert!(version_supported("codex-cli 0.167.2"));
        assert!(version_supported("codex-cli 0.156.0"));
        assert!(version_supported("codex-cli 1.0.0"));
        assert!(!version_supported("codex-cli 0.155.9"));
        assert!(!version_supported("codex-cli 0.149.0"));
        assert!(!version_supported("unexpected output"));
    }

    // npm's shim chain is app -> cmd.exe -> node.exe -> codex.exe, and the
    // grandchildren break away from our job, so the tree must be walked.
    #[test]
    #[cfg(windows)]
    fn descendants_cover_the_npm_shim_chain() {
        let tree = [(100u32, 7u32), (200, 100), (300, 200), (400, 7), (500, 400)];
        assert_eq!(descendants(100, &tree), vec![100, 200, 300]);
        assert_eq!(descendants(7, &tree), vec![7, 100, 200, 300, 400, 500]);
        assert_eq!(descendants(999, &tree), vec![999]);
        // A cycle must not hang or repeat.
        let cycle = [(1u32, 2u32), (2, 1)];
        assert_eq!(descendants(1, &cycle), vec![1, 2]);
    }
}
