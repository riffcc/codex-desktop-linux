use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;

fn main() {
    if let Err(error) = run() {
        eprintln!("codex-desktop-linux runtime error: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let script_dir = env::current_exe()
        .map_err(|err| format!("failed to locate launcher executable: {err}"))?
        .parent()
        .ok_or_else(|| "launcher has no parent directory".to_string())?
        .to_path_buf();

    let webview_dir = script_dir.join("content").join("webview");
    let codex_cli_path = resolve_codex_cli()?;
    let _server = if has_webview_content(&webview_dir) {
        Some(WebviewServer::start(webview_dir)?)
    } else {
        None
    };
    let log_path = script_dir.join("codex-desktop-linux.log");
    let stdout_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| format!("failed to open launcher log {}: {err}", log_path.display()))?;
    let stderr_log = stdout_log
        .try_clone()
        .map_err(|err| format!("failed to clone launcher log handle: {err}"))?;

    let mut electron = Command::new(script_dir.join("electron"));
    electron.current_dir(&script_dir);
    electron.args(env::args().skip(1));
    electron.env("CODEX_CLI_PATH", codex_cli_path);
    let status = electron
        .stdin(Stdio::inherit())
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log))
        .status()
        .map_err(|err| format!("failed to start Electron: {err}"))?;

    if !status.success() {
        return Err(format!("Electron exited with status {status}"));
    }

    Ok(())
}

fn resolve_codex_cli() -> Result<String, String> {
    if let Ok(path) = env::var("CODEX_CLI_PATH") {
        if !path.trim().is_empty() {
            return Ok(path);
        }
    }

    let path_env = env::var_os("PATH").ok_or_else(|| {
        "Codex CLI not found and PATH is unavailable. Install @openai/codex or set CODEX_CLI_PATH."
            .to_string()
    })?;

    for binary_name in ["riff-codex", "codex"] {
        for dir in env::split_paths(&path_env) {
            let candidate = dir.join(binary_name);
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }

    Err(
        "Codex CLI not found. Install the Riff fork to ~/.local/bin/riff-codex or set CODEX_CLI_PATH."
            .to_string(),
    )
}

fn has_webview_content(dir: &Path) -> bool {
    fs::read_dir(dir)
        .ok()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

struct WebviewServer {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl WebviewServer {
    fn start(root: PathBuf) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 5175))
            .map_err(|err| format!("failed to bind webview server: {err}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| format!("failed to set nonblocking webview socket: {err}"))?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);

        let thread = thread::spawn(move || {
            while !stop_thread.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = handle_connection(stream, &root);
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for WebviewServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect("127.0.0.1:5175");
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn handle_connection(mut stream: TcpStream, root: &Path) -> Result<(), String> {
    let mut buffer = [0_u8; 8192];
    let bytes = stream
        .read(&mut buffer)
        .map_err(|err| format!("failed to read request: {err}"))?;
    if bytes == 0 {
        return Ok(());
    }

    let request = String::from_utf8_lossy(&buffer[..bytes]);
    let request_line = request.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let raw_path = parts.next().unwrap_or("/");

    if method != "GET" && method != "HEAD" {
        return respond(
            &mut stream,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            b"Method Not Allowed",
            method == "HEAD",
        );
    }

    let path = sanitize_path(raw_path);
    let candidate = if path.as_os_str().is_empty() {
        root.join("index.html")
    } else {
        root.join(path)
    };

    let final_path = if candidate.is_dir() {
        candidate.join("index.html")
    } else {
        candidate
    };

    if !final_path.starts_with(root) {
        return respond(
            &mut stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            b"Forbidden",
            method == "HEAD",
        );
    }

    match fs::read(&final_path) {
        Ok(bytes) => {
            let mime = mime_type(&final_path);
            respond(&mut stream, "200 OK", mime, &bytes, method == "HEAD")
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => respond(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not Found",
            method == "HEAD",
        ),
        Err(err) => Err(format!("failed to serve {}: {err}", final_path.display())),
    }
}

fn sanitize_path(raw_path: &str) -> PathBuf {
    let stripped = raw_path.split('?').next().unwrap_or("/");
    let mut out = PathBuf::new();
    for component in Path::new(stripped).components() {
        if let Component::Normal(part) = component {
            out.push(part);
        }
    }
    out
}

fn mime_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

fn respond(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) -> Result<(), String> {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(header.as_bytes())
        .map_err(|err| format!("failed to write response header: {err}"))?;
    if !head_only {
        stream
            .write_all(body)
            .map_err(|err| format!("failed to write response body: {err}"))?;
    }
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
    Ok(())
}
