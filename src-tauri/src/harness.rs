use std::{collections::BTreeMap, io::{BufRead, BufReader}, net::TcpListener, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{mpsc, Mutex}, time::{Duration, Instant}};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{Manager, LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl};

const VIEW: &str = "dsh-assistant";
#[derive(Default)]
pub struct HarnessState(Mutex<Option<Runtime>>);
struct Runtime {
    child: Child,
    root: PathBuf,
    url: tauri::Url,
    #[cfg(windows)]
    job: isize,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job as _); }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn trusted(webview: &tauri::Webview) -> Result<(), String> {
    if webview.label() == "main" { Ok(()) } else { Err("Only the editor can control its assistant".into()) }
}

fn normalized_root(path: &str) -> Result<PathBuf, String> {
    let input = Path::new(path);
    if !input.is_absolute() || !input.is_dir() { return Err("请选择一个存在的工程文件夹 / Choose an existing project folder".into()); }
    let path = input.canonicalize().map_err(|e| e.to_string())?;
    let text = path.to_string_lossy();
    // Node understands ordinary UNC paths, not Rust's verbatim prefix.
    Ok(PathBuf::from(if let Some(rest) = text.strip_prefix(r"\\?\UNC\") { format!(r"\\{}", rest) } else { text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned() }))
}

fn history_key(root: &Path) -> String {
    let text = root.to_string_lossy();
    #[cfg(windows)]
    let text = text.to_lowercase();
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

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

pub fn stop(app: &tauri::AppHandle) {
    let state = app.state::<HarnessState>();
    let mut runtime = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(view) = app.get_webview(VIEW) { let _ = view.close(); }
    runtime.take();
}

fn start(app: tauri::AppHandle, directory: String, language: String) -> Result<(), String> {
    if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Err("当前内置助手支持 Windows x64 / The bundled assistant currently supports Windows x64".into());
    }
    let root = normalized_root(&directory)?;
    let state = app.state::<HarnessState>();
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(current) = slot.as_mut() {
        if current.root == root && current.child.try_wait().map_err(|e| e.to_string())?.is_none() { return Ok(()); }
    }
    if let Some(view) = app.get_webview(VIEW) { let _ = view.close(); }
    slot.take();
    let runtime = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.tools/dsh")
    } else { app.path().resource_dir().map_err(|e| e.to_string())?.join("dsh") };
    let node = runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
    if !node.is_file() { return Err("缺少内置助手运行包，请重新安装 / Bundled assistant is missing; reinstall Chartelis".into()); }
    let home = app.path().app_data_dir().map_err(|e| e.to_string())?.join("harness/workspaces").join(history_key(&root));
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let port = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?.local_addr().map_err(|e| e.to_string())?.port();
    let mut command = Command::new(node);
    let mut paths = vec![runtime.clone()];
    if let Some(path) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&path)); }
    command.env("PATH", std::env::join_paths(paths).map_err(|e| e.to_string())?);
    command.arg(runtime.join("node_modules/@deepseek-ai/dsh/lib/bin.js"))
        .args(["--profile", "web", "--patch"]).arg(runtime.join("cordis.patch.yml"))
        .args(["--no-open", "--host", "127.0.0.1", "--port", &port.to_string()])
        .current_dir(&root).env("DSH_HOME", home).env("CHARTELIS_WORKSPACE", &root)
        .env("CHARTELIS_LANGUAGE", if language == "en" { "en" } else { "zh-CN" })
        .env("DSH_TELEMETRY_DISABLED", "1")
        .env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|e| format!("无法启动助手 / Could not start assistant: {e}"))?;
    #[cfg(windows)]
    let job = match assign_job(&child) { Ok(job) => job, Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error); } };
    let (sender, receiver) = mpsc::channel();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    for stream in [Box::new(stdout) as Box<dyn std::io::Read + Send>, Box::new(stderr)] {
        let sender = sender.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                // Only the launch URL crosses this channel. Never persist tokens or chat logs.
                if let Some((_, url)) = line.split_once("dsh web: http://") {
                    let _ = sender.send(format!("http://{}", url.trim()));
                }
            }
        });
    }
    drop(sender);
    let mut running = Runtime { child, root, url: format!("http://127.0.0.1:{port}").parse().unwrap(), #[cfg(windows)] job };
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if let Ok(url) = receiver.recv_timeout(Duration::from_millis(200)) {
            let parsed: tauri::Url = url.parse().map_err(|_| "Invalid assistant launch URL")?;
            if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") || parsed.port() != Some(port) { return Err("Unexpected assistant address".into()); }
            running.url = parsed;
            *slot = Some(running);
            return Ok(());
        }
        if let Some(status) = running.child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("助手启动失败 ({status})，请重试或重新安装 / Assistant failed to start; retry or reinstall"));
        }
    }
    Err("助手启动超时，请重试 / Assistant startup timed out; retry".into())
}

#[tauri::command]
pub async fn harness_start(app: tauri::AppHandle, webview: tauri::Webview, directory: String, language: String) -> Result<(), String> {
    trusted(&webview)?;
    tauri::async_runtime::spawn_blocking(move || start(app, directory, language)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn harness_stop(app: tauri::AppHandle, webview: tauri::Webview) -> Result<(), String> {
    trusted(&webview)?;
    tauri::async_runtime::spawn_blocking(move || stop(&app)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn harness_alive(app: tauri::AppHandle, webview: tauri::Webview) -> Result<bool, String> {
    trusted(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<HarnessState>();
        let mut slot = state.0.lock().map_err(|e| e.to_string())?;
        Ok(match slot.as_mut() { Some(runtime) => runtime.child.try_wait().map_err(|e| e.to_string())?.is_none(), None => false })
    }).await.map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
pub struct ViewState {
    visible: bool, x: f64, y: f64, width: f64, height: f64,
    dark: bool, colors: BTreeMap<String, String>,
}

fn theme_script(state: &ViewState) -> String {
    let colors = serde_json::to_string(&state.colors).unwrap();
    format!(r#"(() => {{
      const colors = {colors}; const dark = {};
      const apply = () => {{
        for (const [key, value] of Object.entries(colors)) document.documentElement.style.setProperty('--chartelis-' + key, value);
        document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
        document.body?.toggleAttribute('data-ds-dark-theme', dark);
      }};
      window.__chartelisThemeObserver?.disconnect();
      apply();
      const observe = () => {{ apply(); window.__chartelisThemeObserver = new MutationObserver(apply); window.__chartelisThemeObserver.observe(document.body, {{attributes: true, attributeFilter: ['data-ds-dark-theme']}}); }};
      if (document.body) observe(); else document.addEventListener('DOMContentLoaded', observe, {{once:true}});
    }})()"#, state.dark)
}

#[tauri::command]
pub async fn harness_action(app: tauri::AppHandle, webview: tauri::Webview, action: String) -> Result<(), String> {
    trusted(&webview)?;
    let child = app.get_webview(VIEW).ok_or("Assistant is not running")?;
    let script = match action.as_str() {
        "new" => "document.querySelector('button[aria-label=\"New session\"], button[aria-label=\"新建会话\"]')?.click()",
        "settings" => "document.body.dispatchEvent(new KeyboardEvent('keydown', {key:',', code:'Comma', ctrlKey:true, altKey:true, bubbles:true, cancelable:true}))",
        _ => return Err("Unknown assistant action".into()),
    };
    child.eval(script).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn harness_view(app: tauri::AppHandle, webview: tauri::Webview, view: ViewState) -> Result<(), String> {
    trusted(&webview)?;
    if !view.visible {
        if let Some(child) = app.get_webview(VIEW) { child.hide().map_err(|e| e.to_string())?; }
        return Ok(());
    }
    if ![view.x, view.y, view.width, view.height].iter().all(|n| n.is_finite()) || view.width < 1.0 || view.height < 1.0 { return Err("Invalid assistant bounds".into()); }
    let script = theme_script(&view);
    let position = LogicalPosition::new(view.x, view.y);
    let size = LogicalSize::new(view.width, view.height);
    if let Some(child) = app.get_webview(VIEW) {
        child.set_bounds(tauri::Rect { position: position.into(), size: size.into() }).map_err(|e| e.to_string())?;
        child.eval(script).map_err(|e| e.to_string())?;
        return child.show().map_err(|e| e.to_string());
    }
    let url = {
        let state = app.state::<HarnessState>();
        let slot = state.0.lock().map_err(|e| e.to_string())?;
        slot.as_ref().ok_or("Assistant is not running")?.url.clone()
    };
    let origin = url.origin();
    let builder = WebviewBuilder::new(VIEW, WebviewUrl::External(url))
        .initialization_script(script)
        .on_navigation(move |url| url.origin() == origin);
    app.get_window("main").ok_or("Editor window is missing")?
        .add_child(builder, position, size).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_identity_is_stable_and_does_not_contain_the_path() {
        let path = std::env::current_dir().unwrap();
        assert_eq!(history_key(&path).len(), 64);
        assert_eq!(history_key(&path), history_key(&path));
        assert_ne!(history_key(&path), history_key(&path.join("another")));
        assert!(normalized_root("relative").is_err());
        assert!(normalized_root(path.join("missing-project").to_str().unwrap()).is_err());
    }
}
