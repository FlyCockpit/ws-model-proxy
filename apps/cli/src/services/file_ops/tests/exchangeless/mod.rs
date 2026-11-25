//! Exchange-less filesystem safety at real filesystem boundaries. Syscall
//! faults select the filesystem capabilities; step hooks perform actual saves.
//! No sleeps, synthetic stat replacements, or scheduler races are involved.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use nix::errno::Errno;
use serde_json::{Value, json};

use super::{Fx, args};
use crate::services::file_ops::journal::exchange::{FaultScope, Primitive};
use crate::services::file_ops::{Cancel, ErrorCode, FileError, FileOps, FileResult, Step};

const ORIGINAL: &str = "original contents\n";
const EDITED: &str = "edited contents\n";
const RACER: &str = "concurrent save\n";

#[derive(Clone, Copy, Debug)]
enum ReplaceOp {
    Edit,
    Write,
}

const REPLACE_OPS: [ReplaceOp; 2] = [ReplaceOp::Edit, ReplaceOp::Write];

impl ReplaceOp {
    fn run(self, fx: &Fx, etag: &str) -> FileResult<Value> {
        match self {
            Self::Edit => fx.ops.execute(
                "edit",
                json!({"path": fx.p("doc"), "expectedEtag": etag,
                    "edits": [{"oldText": ORIGINAL, "newText": EDITED}]}),
                &fx.cancel,
            ),
            Self::Write => fx.ops.execute(
                "write",
                json!({"path": fx.p("doc"), "expectedEtag": etag,
                    "ifExists": "replace", "content": EDITED}),
                &fx.cancel,
            ),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum PublishMethod {
    NoReplace,
    Link,
}

const METHODS: [PublishMethod; 2] = [PublishMethod::NoReplace, PublishMethod::Link];

impl PublishMethod {
    fn faults(self) -> Vec<(Primitive, usize, Errno)> {
        let mut faults = Vec::new();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        faults.push((Primitive::Exchange, 1, Errno::EINVAL));
        if matches!(self, Self::Link) {
            faults.push((Primitive::ProbeNoReplace, 1, Errno::EINVAL));
        }
        faults
    }

    fn primitive(self) -> Primitive {
        match self {
            Self::NoReplace => Primitive::Publish,
            Self::Link => Primitive::PublishLink,
        }
    }

    fn clean_unlinks(self) -> usize {
        match self {
            Self::NoReplace => 1,
            Self::Link => 3, // probe alias, published alias, captured original
        }
    }
}

fn prepare(fx: &Fx) -> String {
    fx.put("doc", ORIGINAL);
    fx.put("untouched", "unrelated bytes\n");
    fx.etag("doc")
}

/// Replace with a new inode, exactly as an editor's atomic save does.
fn save(path: &Path, bytes: &str) {
    let incoming = path.with_file_name("racer-incoming");
    std::fs::write(&incoming, bytes).unwrap();
    std::fs::rename(incoming, path).unwrap();
}

fn recovery_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".wsmp-recover-")
        })
        .collect();
    dirs.sort();
    dirs
}

#[derive(Debug, PartialEq, Eq)]
enum Entry {
    Directory,
    File(Vec<u8>, u64, u64, u64),
    Symlink(PathBuf, u64, u64),
}

/// Include every name, inode and byte, including private recovery contents.
/// A refusal cannot pass by moving the original away or leaving a temp behind.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Entry> {
    use std::os::unix::fs::MetadataExt;
    fn visit(root: &Path, dir: &Path, entries: &mut BTreeMap<PathBuf, Entry>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            let relative = path.strip_prefix(root).unwrap().to_path_buf();
            let value = if metadata.file_type().is_symlink() {
                Entry::Symlink(
                    std::fs::read_link(&path).unwrap(),
                    metadata.dev(),
                    metadata.ino(),
                )
            } else if metadata.is_dir() {
                visit(root, &path, entries);
                Entry::Directory
            } else {
                Entry::File(
                    std::fs::read(&path).unwrap(),
                    metadata.dev(),
                    metadata.ino(),
                    metadata.nlink(),
                )
            };
            entries.insert(relative, value);
        }
    }
    let mut entries = BTreeMap::new();
    visit(root, root, &mut entries);
    entries
}

fn clean(fx: &Fx) {
    assert!(
        recovery_dirs(&fx.root).is_empty(),
        "recovery was left behind"
    );
    assert!(
        fx.leftovers("").is_empty(),
        "a public staging name was left behind"
    );
}

fn count(calls: &[Primitive], primitive: Primitive) -> usize {
    calls.iter().filter(|call| **call == primitive).count()
}

fn kept(error: &FileError) -> Vec<PathBuf> {
    assert_eq!(error.code, ErrorCode::UncertainOutcome, "{error:?}");
    let detail = error.detail.as_ref().expect("recovery detail");
    let recovery = PathBuf::from(detail["recovery"].as_str().unwrap());
    assert!(recovery.is_absolute() && recovery.is_dir());
    let paths: Vec<_> = detail["kept"]
        .as_array()
        .unwrap()
        .iter()
        .map(|path| PathBuf::from(path.as_str().unwrap()))
        .collect();
    assert!(!paths.is_empty() && paths.len() <= 4, "{detail}");
    for path in &paths {
        assert!(
            path.is_absolute() && std::fs::symlink_metadata(path).is_ok(),
            "{detail}"
        );
    }
    paths
}

fn has_bytes(paths: &[PathBuf], bytes: &str) -> bool {
    paths.iter().any(|path| {
        if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
            let children: Vec<_> = std::fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            has_bytes(&children, bytes)
        } else {
            std::fs::read(path).is_ok_and(|actual| actual == bytes.as_bytes())
        }
    })
}

fn has_symlink(paths: &[PathBuf], target: &Path) -> bool {
    paths.iter().any(|path| {
        if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
            let children: Vec<_> = std::fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            has_symlink(&children, target)
        } else {
            std::fs::read_link(path).is_ok_and(|actual| actual == target)
        }
    })
}

fn result_paths(result: &Value) -> Vec<PathBuf> {
    result["recovered"]
        .as_array()
        .expect("nonempty recovered")
        .iter()
        .map(|path| PathBuf::from(path.as_str().unwrap()))
        .collect()
}

fn no_public_temp(fx: &Fx) {
    for entry in std::fs::read_dir(&fx.root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            assert_ne!(
                std::fs::read(path).unwrap(),
                EDITED.as_bytes(),
                "unpublished temp became public"
            );
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum DeleteKind {
    File,
    Symlink,
}
const DELETE_KINDS: [DeleteKind; 2] = [DeleteKind::File, DeleteKind::Symlink];

fn prepare_delete(fx: &Fx, kind: DeleteKind) {
    fx.put("untouched", "unrelated bytes\n");
    match kind {
        DeleteKind::File => {
            fx.put("doc", ORIGINAL);
        }
        DeleteKind::Symlink => {
            fx.put("original-target", ORIGINAL);
            fx.put("racer-target", RACER);
            fx.link("original-target", "doc");
        }
    }
}

fn delete(fx: &Fx) -> FileResult<Value> {
    fx.ops
        .execute("delete", json!({"path": fx.p("doc")}), &fx.cancel)
}

fn save_delete_successor(doc: &Path, kind: DeleteKind) {
    match kind {
        DeleteKind::File => save(doc, RACER),
        DeleteKind::Symlink => {
            let incoming = doc.with_file_name("racer-incoming");
            std::os::unix::fs::symlink("racer-target", &incoming).unwrap();
            std::fs::rename(incoming, doc).unwrap();
        }
    }
}

// Check the inode actually about to lose its private alias. Unrelated inspected
// inodes may remain held; this probe never asserts about those descriptors.
#[cfg(target_os = "linux")]
fn watch_private_unlinks(fx: &Fx, slots: &[&str]) -> Arc<Mutex<Vec<(u64, u64)>>> {
    use crate::services::file_ops::journal::exchange::UNLINK_PROBE;
    use std::os::unix::fs::MetadataExt;
    let root = fx.root.clone();
    let slots: Vec<_> = slots.iter().map(|slot| (*slot).to_owned()).collect();
    let checks = Arc::new(Mutex::new(Vec::new()));
    let checked = Arc::clone(&checks);
    UNLINK_PROBE.with(|probe| {
        *probe.borrow_mut() = Some(Box::new(move || {
            let dirs = recovery_dirs(&root);
            let nth = checked.lock().unwrap().len();
            let private = dirs[0].join(&slots[nth]);
            let Ok(metadata) = std::fs::symlink_metadata(&private) else {
                return;
            };
            let inode = (metadata.dev(), metadata.ino());
            for entry in std::fs::read_dir("/proc/self/fd").unwrap() {
                let path = entry.unwrap().path();
                if let Ok(metadata) = std::fs::metadata(&path) {
                    assert_ne!(
                        (metadata.dev(), metadata.ino()),
                        inode,
                        "descriptor still pins the disposed inode: {path:?}"
                    );
                }
            }
            checked.lock().unwrap().push(inode);
        }));
    });
    checks
}

mod delete;
#[cfg(target_os = "linux")]
mod descriptors;
mod real_fs;
mod rename_publish;
mod replace;
