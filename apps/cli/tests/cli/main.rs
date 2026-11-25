//! Black-box tests of the built `wsmp` binary, one module per command area, and the
//! helpers they share.

use assert_cmd::Command;
use serde_json::{Value, json};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc;
use std::thread;

mod commands;
mod config;
mod login;
mod run;
mod runtime;
/// A real `wsmp` relay against a minimal in-test websocket relay: a shutdown
/// signal must kill running exec commands, tell the server, and remove the
/// runtime files before the process dies from that signal.
#[cfg(unix)]
mod signal_shutdown;
mod terminal;
mod trust;
mod update;

fn cli(config: &Path, state: &Path) -> Command {
    let mut cmd = Command::cargo_bin("wsmp").expect("binary builds");
    cmd.env("WSMP_CONFIG", config);
    cmd.env("WSMP_STATE_DIR", state);
    cmd.env_remove("WSMP_LOG");
    cmd.env_remove("RUST_LOG");
    cmd
}

fn json_stdout(mut cmd: Command) -> Value {
    let stdout = cmd.assert().success().get_output().stdout.clone();
    serde_json::from_slice(&stdout).expect("stdout is valid JSON")
}

fn write_config(path: &Path, value: Value) {
    let parent = path.parent().expect("parent");
    fs::create_dir_all(parent).expect("create config dir");
    fs::write(path, serde_json::to_vec_pretty(&value).expect("json")).expect("write config");
}

struct TestServer {
    base_url: String,
    requests: mpsc::Receiver<String>,
    handle: thread::JoinHandle<()>,
}

impl TestServer {
    fn start(routes: Vec<(&'static str, u16, Value)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = listener.local_addr().expect("local addr");
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            for (path, status, body) in routes {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let request = read_request(&mut stream);
                let _ = tx.send(request.clone());
                let response_body = if request.starts_with(&format!("GET {path} "))
                    || request.starts_with(&format!("POST {path} "))
                {
                    body.to_string()
                } else {
                    json!({ "error": "not found" }).to_string()
                };
                write_response(&mut stream, status, response_body.as_bytes());
            }
        });
        Self {
            base_url: format!("http://{addr}"),
            requests: rx,
            handle,
        }
    }

    fn join(self) {
        self.handle.join().expect("server thread joins");
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        let n = stream.read(&mut buffer).expect("read request");
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..n]);
        if request_is_complete(&bytes) {
            break;
        }
    }
    String::from_utf8_lossy(&bytes).to_string()
}

fn request_is_complete(bytes: &[u8]) -> bool {
    let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length").then_some(value)
        })
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    bytes.len() >= header_end + 4 + content_length
}

fn write_response(stream: &mut TcpStream, status: u16, body: &[u8]) {
    let status_text = if status == 200 { "OK" } else { "ERROR" };
    // A rate limit always says when to come back, as the server does.
    let retry_after = if status == 429 {
        "Retry-After: 1\r\n"
    } else {
        ""
    };
    let response = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\n{retry_after}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .expect("write response");
    stream.write_all(body).expect("write body");
}
