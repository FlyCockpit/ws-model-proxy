//! Filesystem tests for the file tools: real temp directories, real symlinks,
//! real races. Helpers live here; the cases are grouped by area.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::policy::{Deny, Protected};
use super::read::{ReadOutcome, ReadResult};
use super::{Cancel, ErrorCode, EtagKey, FileOps, FileResult, Policy, Step};

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod compensation;
#[cfg(target_os = "linux")]
mod durability;
mod edit_write;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod exchangeless;
mod hardening;
mod misc;
mod read_grant;
mod read_tests;
mod resolve_policy;
mod supervised;
mod tools;

pub struct Fx {
    pub _dir: tempfile::TempDir,
    pub root: PathBuf,
    pub ops: FileOps,
    pub cancel: Cancel,
    pub steps: Arc<Mutex<Vec<Step>>>,
    _registry: crate::file_ops::registry::RegistryGuard,
}

pub fn args<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("test args")
}

pub fn code<T: std::fmt::Debug>(result: FileResult<T>) -> ErrorCode {
    result.expect_err("expected an error").code
}

pub fn real_uid() -> u32 {
    nix::unistd::geteuid().as_raw()
}

/// A PEM block built at run time: the committed source must not contain a
/// literal `-----BEGIN ... PRIVATE KEY-----` line (the CI secret scan and the
/// CLI policy checks grep for it).
/// An AWS-style access-key-id placeholder, built at run time: the committed
/// source must not contain a 20-character id of that shape (the CLI policy
/// checks and the CI secret scan grep for it).
pub fn aws_style_id() -> String {
    format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE")
}

pub fn pem(label: &str, body: &str) -> String {
    format!("-----BEGIN {label}-----\n{body}-----END {label}-----\n")
}

impl Fx {
    pub fn new() -> Self {
        Self::with_policy(|_| Policy::new(vec![], vec![], true))
    }

    pub fn with_policy(build: impl FnOnce(&Path) -> Policy) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        let policy = build(&root);
        let steps = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&steps);
        let ops = FileOps::new(policy, EtagKey::from_bytes([7; 32])).with_step_hook(Arc::new(
            move |step| {
                log.lock().expect("log").push(step);
                Ok(())
            },
        ));
        Self {
            _dir: dir,
            root,
            ops,
            cancel: Cancel::new(),
            steps,
            _registry: crate::file_ops::registry::install_temp_registry(),
        }
    }

    /// Replace the step hook (fault injection / races).
    pub fn with_hook(
        mut self,
        hook: impl Fn(Step) -> FileResult<()> + Send + Sync + 'static,
    ) -> Self {
        let log = Arc::clone(&self.steps);
        self.ops.hook = Some(Arc::new(move |step| {
            log.lock().expect("log").push(step);
            hook(step)
        }));
        self
    }

    pub fn protecting<'a>(files: &'a [(&'a str, Deny)]) -> impl FnOnce(&Path) -> Policy + 'a {
        move |root| {
            let protected = files
                .iter()
                .map(|(rel, deny)| Protected {
                    path: root.join(rel),
                    subtree: false,
                    deny: *deny,
                })
                .collect();
            Policy::new(vec![], protected, true)
        }
    }

    pub fn p(&self, rel: &str) -> String {
        self.root.join(rel).to_string_lossy().to_string()
    }

    pub fn put(&self, rel: &str, content: impl AsRef<[u8]>) -> PathBuf {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(&path, content).expect("write");
        path
    }

    pub fn get(&self, rel: &str) -> String {
        std::fs::read_to_string(self.root.join(rel)).expect("read back")
    }

    pub fn link(&self, target: impl AsRef<Path>, rel: &str) {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::os::unix::fs::symlink(target, path).expect("symlink");
    }

    pub fn read(&self, rel: &str) -> ReadResult {
        self.read_with(json!({ "path": self.p(rel) }))
    }

    pub fn read_with(&self, value: Value) -> ReadResult {
        match self.ops.read(&args(value), &self.cancel).expect("read") {
            ReadOutcome::Content(result) => *result,
            ReadOutcome::Unchanged { .. } => panic!("unexpected unchanged"),
        }
    }

    pub fn etag(&self, rel: &str) -> String {
        self.read(rel).etag
    }

    pub fn leftovers(&self, rel_dir: &str) -> Vec<String> {
        std::fs::read_dir(self.root.join(rel_dir))
            .expect("read_dir")
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".wsmp-"))
            .collect()
    }
}
