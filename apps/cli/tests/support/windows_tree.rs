//! Windows fixtures shared by the integration and session tests. Python is
//! available on windows-latest, as it is for the existing Unix tree tests.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub struct Tree {
    // Cleanup runs before the directory (and its PID markers) is removed.
    dir: tempfile::TempDir,
    pub marker: PathBuf,
    pub root: PathBuf,
}

impl Tree {
    pub fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("wsmp tree ")
            .tempdir()
            .expect("tree fixture");
        let marker = dir.path().join("grandchild.pid");
        let root = dir.path().join("root.pid");
        let script = dir.path().join("tree.py");
        std::fs::write(
            &script,
            r#"import os, pathlib, subprocess, sys, time
marker, root, mode = sys.argv[1:]
pathlib.Path(root).write_text(str(os.getpid()))
flags = 0
stdio = {}
if mode == 'detach':
    flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    stdio = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
elif mode in ('success', 'eof'):
    stdio = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
elif mode == 'breakaway':
    flags = subprocess.CREATE_BREAKAWAY_FROM_JOB
try:
    p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], creationflags=flags, **stdio)
except OSError as e:
    if mode != 'breakaway' or e.winerror != 5:
        raise
    pathlib.Path(marker).write_text('denied')
else:
    pathlib.Path(marker).write_text(str(p.pid))
if mode == 'eof':
    while not pathlib.Path(root).with_suffix('.eof').exists():
        time.sleep(0.005)
    os.close(1)
    while not pathlib.Path(root).with_suffix('.exit').exists():
        time.sleep(0.005)
elif mode not in ('success', 'root-exit'):
    time.sleep(60)
"#,
        )
        .expect("tree script");
        Self { dir, marker, root }
    }

    pub fn command(&self, mode: &str) -> [String; 6] {
        // Separate arguments let Rust quote paths containing spaces for cmd.
        // Embedded quotes in a single /C argument would be escaped again.
        [
            "/C".into(),
            "python".into(),
            self.cwd().join("tree.py").display().to_string(),
            self.marker.display().to_string(),
            self.root.display().to_string(),
            mode.into(),
        ]
    }

    pub fn cwd(&self) -> &Path {
        self.dir.path()
    }

    pub fn read_marker(&self) -> String {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(text) = std::fs::read_to_string(&self.marker)
                && !text.trim().is_empty()
            {
                return text.trim().to_string();
            }
            assert!(Instant::now() < until, "grandchild never recorded its PID");
            thread::sleep(Duration::from_millis(20));
        }
    }
}

/// Utilities have their own deadline and Drop guard, even if tasklist or
/// PowerShell stalls. They never spawn a workload or an unowned process tree.
struct Utility(Child);

impl Drop for Utility {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let until = Instant::now() + Duration::from_secs(1);
        while matches!(self.0.try_wait(), Ok(None)) && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
    }
}

fn utility(program: &str, args: &[String]) -> Option<Output> {
    // File-backed output cannot fill a pipe and pin a child before exit.
    let out = tempfile::tempfile().ok()?;
    let err = tempfile::tempfile().ok()?;
    let mut child = Utility(
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(out.try_clone().ok()?)
            .stderr(err.try_clone().ok()?)
            .spawn()
            .ok()?,
    );
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.0.try_wait().ok()? {
            use std::io::{Read, Seek};
            let read = |mut file: std::fs::File| {
                let mut bytes = Vec::new();
                file.rewind().ok()?;
                file.read_to_end(&mut bytes).ok()?;
                Some(bytes)
            };
            return Some(Output {
                status,
                stdout: read(out)?,
                stderr: read(err)?,
            });
        }
        if Instant::now() >= until {
            return None;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

pub fn process_exists(pid: u32) -> bool {
    let output = utility(
        "tasklist",
        &[
            "/FI".into(),
            format!("PID eq {pid}"),
            "/FO".into(),
            "CSV".into(),
            "/NH".into(),
        ],
    )
    .expect("bounded tasklist query");
    assert!(output.status.success(), "tasklist failed");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.split(',').nth(1) == Some(format!("\"{pid}\"").as_str()))
}

pub fn assert_dead(pid: u32) {
    let until = Instant::now() + Duration::from_secs(5);
    while process_exists(pid) {
        assert!(
            Instant::now() < until,
            "process {pid} survived tree cleanup"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        // A failing assertion must not leave either recorded process running.
        for marker in [&self.marker, &self.root] {
            if let Ok(text) = std::fs::read_to_string(marker)
                && let Ok(pid) = text.trim().parse::<u32>()
            {
                let _ = utility(
                    "powershell",
                    &[
                        "-NoProfile".into(),
                        "-Command".into(),
                        format!("Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue"),
                    ],
                );
            }
        }
    }
}
