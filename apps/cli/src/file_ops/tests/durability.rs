//! Producer → actual durable intent → departed owner → recovery regressions.
//! Linux IO cases launch this test executable with an isolated C syscall hook.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::json;

use super::{Fx, args};
use crate::file_ops::exchange::{FaultScope, Primitive};
use crate::file_ops::intent::{Intent, IntentPhase, parse_intent};
use crate::file_ops::recover::{RecoverAction, recover_dir, scan_recovery_dirs};
use crate::file_ops::{ErrorCode, Step};
use nix::errno::Errno;

fn intent(dir: &Path) -> Intent {
    parse_intent(&fs::read(dir.join("INTENT")).unwrap()).unwrap()
}

fn depart(dir: &Path) {
    let mut value = intent(dir);
    value.pid = 0; // Liveness only: never change origin, phase or authority.
    fs::write(dir.join("INTENT"), serde_json::to_vec(&value).unwrap()).unwrap();
}

fn abandoned(fx: &Fx) -> PathBuf {
    scan_recovery_dirs(std::slice::from_ref(&fx.root))
        .pop()
        .unwrap()
}

#[test]
fn compensated_direct_move_keeps_source_mapping_across_recovery() {
    for occupied in [false, true] {
        let fx = Fx::new();
        fx.put("src", "admitted");
        let etag = fx.etag("src");
        let root = fx.root.clone();
        let fx = fx.with_hook(move |step| {
            if step == Step::EtagRechecked {
                fs::remove_file(root.join("src")).unwrap();
                fs::write(root.join("src"), b"rejected candidate").unwrap();
            }
            if occupied && step == Step::Moved {
                fs::write(root.join("src"), b"source successor").unwrap();
            }
            Ok(())
        });
        let error = fx
            .ops
            .rename(
                &args(json!({"from":fx.p("src"),"to":fx.p("dst"),"expectedEtag":etag})),
                &fx.cancel,
            )
            .unwrap_err();
        assert!(!fx.root.join("dst").exists());
        if occupied {
            assert_eq!(error.code, ErrorCode::UncertainOutcome);
            let dir = abandoned(&fx);
            assert_eq!(intent(&dir).phase, IntentPhase::Compensating);
            depart(&dir);
            for _ in 0..2 {
                let report = recover_dir(&dir, true, None);
                assert!(
                    !fx.root.join("dst").exists(),
                    "rejected candidate must never publish at destination"
                );
                assert_eq!(report.action, RecoverAction::Listed);
                assert_eq!(
                    intent(&dir).slots["slot-1"].origin.to_path(),
                    Some(fx.root.join("src"))
                );
                assert_eq!(fs::read(dir.join("slot-1")).unwrap(), b"rejected candidate");
                assert_eq!(fx.get("src"), "source successor");
            }
        } else {
            assert_eq!(error.code, ErrorCode::Conflict);
            assert_eq!(fx.get("src"), "rejected candidate");
            assert!(scan_recovery_dirs(std::slice::from_ref(&fx.root)).is_empty());
        }
    }
}

#[test]
fn compensated_exchange_never_disposes_rejected_original() {
    let fx = Fx::new();
    fx.put("target", "admitted");
    let etag = fx.etag("target");
    let root = fx.root.clone();
    let fx = fx.with_hook(move |step| {
        if step == Step::EtagRechecked {
            fs::remove_file(root.join("target")).unwrap();
            fs::write(root.join("target"), b"rejected original").unwrap();
        }
        if step == Step::Exchanged {
            fs::remove_file(root.join("target")).unwrap();
            fs::write(root.join("target"), b"public successor").unwrap();
        }
        Ok(())
    });
    let error = fx.ops.write(&args(json!({"path":fx.p("target"),"content":"proposed","ifExists":"replace","expectedEtag":etag})), &fx.cancel).unwrap_err();
    assert_eq!(error.code, ErrorCode::UncertainOutcome);
    let dir = abandoned(&fx);
    let phase = intent(&dir).phase;
    depart(&dir);
    for _ in 0..2 {
        let report = recover_dir(&dir, true, None);
        assert_eq!(
            fs::read(dir.join("tmp")).ok().as_deref(),
            Some(b"rejected original".as_slice()),
            "rejected original must survive recovery"
        );
        assert_eq!(phase, IntentPhase::Compensating);
        assert_eq!(report.action, RecoverAction::Listed);
        assert_eq!(fx.get("target"), "public successor");
    }
}

#[test]
fn exchange_rename_unvalidated_effect_has_no_disposal_authority() {
    let fx = Fx::new();
    fx.put("src", "source");
    fx.put("dst", "original destination");
    let etag = fx.etag("dst");
    let root = fx.root.clone();
    let fx = fx.with_hook(move |step| {
        if step == Step::Exchanged {
            fs::remove_file(root.join("dst")).unwrap();
            fs::write(root.join("dst"), b"public successor").unwrap();
        }
        Ok(())
    });
    let error = fx
        .ops
        .rename(
            &args(
                json!({"from":fx.p("src"),"to":fx.p("dst"),"overwrite":true,"expectedEtag":etag}),
            ),
            &fx.cancel,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::UncertainOutcome);
    let dir = abandoned(&fx);
    assert_eq!(intent(&dir).phase, IntentPhase::Publishing);
    depart(&dir);
    assert_eq!(recover_dir(&dir, true, None).action, RecoverAction::Listed);
    assert_eq!(fx.get("src"), "original destination");
    assert_eq!(fx.get("dst"), "public successor");
}

#[test]
fn publication_siblings_commit_and_cleanup_normally() {
    for link in [false, true] {
        for overwrite in [false, true] {
            let fx = Fx::new();
            fx.put("src", "source");
            let etag = if overwrite {
                fx.put("dst", "original");
                Some(fx.etag("dst"))
            } else {
                None
            };
            let mut faults = vec![(Primitive::ProbeExchange, 1, Errno::EINVAL)];
            if link {
                faults.push((Primitive::Move, 1, Errno::EINVAL));
                faults.push((Primitive::ProbeNoReplace, 1, Errno::EINVAL));
            }
            let _fault = FaultScope::new(&faults);
            fx.ops.rename(&args(json!({"from":fx.p("src"),"to":fx.p("dst"),"overwrite":overwrite,"expectedEtag":etag})), &fx.cancel).unwrap();
            assert!(!fx.root.join("src").exists());
            assert_eq!(fx.get("dst"), "source");
            assert!(scan_recovery_dirs(std::slice::from_ref(&fx.root)).is_empty());
        }
    }
}

#[test]
fn deleting_an_unreadable_file_needs_no_read_access() {
    use std::os::unix::fs::PermissionsExt;
    if nix::unistd::geteuid().is_root() {
        return; // root can read mode 000; the case cannot be exercised
    }
    let fx = Fx::new();
    fx.put("locked", "secret bytes");
    fs::set_permissions(fx.root.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    let result = fx
        .ops
        .delete(&args(json!({"path":fx.p("locked")})), &fx.cancel)
        .unwrap();
    assert!(result.deleted);
    assert!(result.recovered.is_empty());
    assert!(!fx.root.join("locked").exists());
    assert!(scan_recovery_dirs(std::slice::from_ref(&fx.root)).is_empty());
    assert!(fx.leftovers("").is_empty(), "{:?}", fx.leftovers(""));
}

fn hook(directory: &Path) -> PathBuf {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/file_ops_fsync_hook.c");
    let library = directory.join("hook.so");
    let output = Command::new("cc")
        .args(["-shared", "-fPIC"])
        .arg(source)
        .args(["-ldl", "-o"])
        .arg(&library)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "C fixture compile: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    library
}

#[test]
fn actual_fsync_failures_preserve_truthful_recovery_state() {
    let directory = tempfile::tempdir().unwrap();
    let library = hook(directory.path());
    let mut failed = Vec::new();
    for case in [
        "intent-prepared",
        "intent-captured",
        "intent-publishing",
        "intent-committed",
        "registry-write",
        "registry-dir",
        "capture-parent",
        "slot-data",
        "restore-parent",
        "dir-einval",
        "enospc-tmp",
        "enospc-new",
        "rmdir-parent",
    ] {
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "file_ops::tests::durability::actual_io_child",
                "--test-threads=1",
            ])
            .env("LD_PRELOAD", &library)
            .env("WSMP_DURABILITY_FAULT", case)
            .env(
                "WSMP_DURABILITY_DISARM",
                directory.path().join(format!("disarm-{case}")),
            )
            .status()
            .unwrap();
        if !status.success() {
            failed.push(case);
        }
    }
    assert!(failed.is_empty(), "actual syscall failure cases {failed:?}");
}

fn link_count(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(path).unwrap().nlink()
}

/// Stop injecting faults: later syscalls in this child behave normally.
fn disarm() {
    if let Some(marker) = std::env::var_os("WSMP_DURABILITY_DISARM") {
        fs::write(marker, b"").unwrap();
    }
}

/// A failure before any public effect is a clean refusal: the public file is
/// untouched and not pinned, no recovery directory, cleanup lock or registry
/// entry remains, and a follow-up edit succeeds.
fn assert_clean_refusal(fx: &Fx, case: &str) {
    assert_eq!(fx.get("src"), "original", "{case}: public file untouched");
    assert_eq!(
        link_count(&fx.root.join("src")),
        1,
        "{case}: no hidden hardlink pin may survive a refusal"
    );
    assert!(
        scan_recovery_dirs(std::slice::from_ref(&fx.root)).is_empty(),
        "{case}: no recovery directory"
    );
    assert!(
        fx.leftovers("").is_empty(),
        "{case}: no residue {:?}",
        fx.leftovers("")
    );
    assert!(
        crate::file_ops::registry::list_entries().is_empty(),
        "{case}: no registry entry"
    );
    disarm();
    let etag = fx.etag("src");
    fx.ops
        .write(
            &args(json!({"path":fx.p("src"),"content":"follow-up","ifExists":"replace","expectedEtag":etag})),
            &fx.cancel,
        )
        .unwrap_or_else(|error| panic!("{case}: follow-up edit must succeed: {error:?}"));
    assert_eq!(fx.get("src"), "follow-up");
    assert_eq!(link_count(&fx.root.join("src")), 1);
    assert!(fx.leftovers("").is_empty());
}

#[test]
fn actual_io_child() {
    let Ok(case) = std::env::var("WSMP_DURABILITY_FAULT") else {
        return;
    };
    let fx = Fx::new();
    fx.put("src", "original");
    if case == "restore-parent" {
        let _fault = FaultScope::new(&[(Primitive::Unlink, 1, Errno::EIO)]);
        fx.ops
            .delete(&args(json!({"path":fx.p("src")})), &fx.cancel)
            .unwrap();
        let dir = abandoned(&fx);
        let mut value = intent(&dir);
        value.phase = IntentPhase::Captured; // Explicit rollback fixture.
        value.pid = 0;
        fs::write(dir.join("INTENT"), serde_json::to_vec(&value).unwrap()).unwrap();
        drop(_fault);
        assert_eq!(
            recover_dir(&dir, true, None).action,
            RecoverAction::Listed,
            "real restored-parent EIO must be observed"
        );
        assert!(dir.join("INTENT").exists());
        assert_eq!(fx.get("src"), "original");
        assert!(fs::read_dir(&dir).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".wsmp-pin-")
        }));
        assert_eq!(recover_dir(&dir, true, None).action, RecoverAction::Cleaned);
        assert_eq!(fx.get("src"), "original");
        return;
    }
    match case.as_str() {
        "intent-prepared" | "registry-write" | "registry-dir" => {
            let error = fx
                .ops
                .delete(&args(json!({"path":fx.p("src")})), &fx.cancel)
                .unwrap_err();
            assert_eq!(
                error.code,
                ErrorCode::IoError,
                "{case}: nothing changed, so the outcome is certain: {error:?}"
            );
            assert_clean_refusal(&fx, &case);
            return;
        }
        "dir-einval" => {
            // Directory fsync is unsupported: refuse every journaled mutation
            // cleanly instead of pinning the user's file.
            let etag = fx.etag("src");
            let error = fx
                .ops
                .write(
                    &args(json!({"path":fx.p("src"),"content":"proposed","ifExists":"replace","expectedEtag":etag})),
                    &fx.cancel,
                )
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::UnsafeFilesystem, "{error:?}");
            let error = fx
                .ops
                .delete(&args(json!({"path":fx.p("src")})), &fx.cancel)
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::UnsafeFilesystem, "{error:?}");
            assert_clean_refusal(&fx, &case);
            return;
        }
        "enospc-tmp" => {
            let etag = fx.etag("src");
            let error = fx
                .ops
                .write(
                    &args(json!({"path":fx.p("src"),"content":"proposed replacement","ifExists":"replace","expectedEtag":etag})),
                    &fx.cancel,
                )
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::IoError, "{error:?}");
            assert!(error.message.contains("ENOSPC"), "{error:?}");
            assert_clean_refusal(&fx, &case);
            return;
        }
        "enospc-new" => {
            let error = fx
                .ops
                .write(
                    &args(json!({"path":fx.p("new"),"content":"new-file-content"})),
                    &fx.cancel,
                )
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::IoError, "{error:?}");
            assert!(error.message.contains("ENOSPC"), "{error:?}");
            assert!(
                !fx.root.join("new").exists(),
                "a torn new file must not stay at its public name"
            );
            assert_clean_refusal(&fx, &case);
            return;
        }
        "rmdir-parent" => {
            // The durable commit and R's removal precede this barrier: an empty
            // R reappearing after power loss is harmless, so the acknowledged
            // delete stays a success with no residue.
            let result = fx
                .ops
                .delete(&args(json!({"path":fx.p("src")})), &fx.cancel)
                .unwrap();
            assert!(result.deleted);
            assert!(!fx.root.join("src").exists());
            assert!(fx.leftovers("").is_empty(), "{:?}", fx.leftovers(""));
            assert!(crate::file_ops::registry::list_entries().is_empty());
            return;
        }
        "slot-data" => {
            // A captured user object's bytes are unchanged: deletion needs no
            // data barrier on it (and never reopens it for reading).
            fx.ops
                .delete(&args(json!({"path":fx.p("src")})), &fx.cancel)
                .unwrap();
            assert!(!fx.root.join("src").exists());
            assert!(scan_recovery_dirs(std::slice::from_ref(&fx.root)).is_empty());
            assert!(fx.leftovers("").is_empty());
            return;
        }
        _ => {}
    }
    let result = fx
        .ops
        .delete(&args(json!({"path":fx.p("src")})), &fx.cancel);
    assert_eq!(
        result.unwrap_err().code,
        ErrorCode::UncertainOutcome,
        "fsync failure must not acknowledge deletion"
    );
    let dir = abandoned(&fx);
    if case == "intent-committed" {
        assert!(!fx.root.join("src").exists());
        assert_eq!(
            intent(&dir).phase,
            IntentPhase::Publishing,
            "failed committed rewrite must preserve durable fence"
        );
        assert_eq!(fs::read(dir.join("slot-1")).unwrap(), b"original");
        depart(&dir);
        // A delete in `publishing` was never acknowledged (success needs the
        // durable `committed` record) and issued no public syscall after
        // capture, so recover undoes it through the pinned `mv -n` restore.
        // Rename/replace `publishing` stays manual (see
        // `exchange_rename_unvalidated_effect_has_no_disposal_authority`).
        assert!(matches!(
            recover_dir(&dir, true, None).action,
            RecoverAction::Cleaned | RecoverAction::RolledBack
        ));
        assert_eq!(fx.get("src"), "original");
        assert_eq!(link_count(&fx.root.join("src")), 1);
        assert!(!dir.exists());
    } else if case == "capture-parent" {
        assert_eq!(intent(&dir).phase, IntentPhase::Capturing);
        assert_eq!(fs::read(dir.join("slot-1")).unwrap(), b"original");
        assert!(!fx.root.join("src").exists());
        depart(&dir);
        // An interrupted capture rolls back through the pinned restore.
        assert!(matches!(
            recover_dir(&dir, true, None).action,
            RecoverAction::Cleaned | RecoverAction::RolledBack
        ));
        assert_eq!(fx.get("src"), "original");
        assert!(!dir.exists());
    } else {
        assert_eq!(fs::read(dir.join("slot-1")).unwrap(), b"original");
        depart(&dir);
        assert_eq!(recover_dir(&dir, true, None).action, RecoverAction::Cleaned);
        assert_eq!(fx.get("src"), "original");
    }
}

#[test]
fn real_io_stall_keeps_pool_ownership_until_settlement() {
    let directory = tempfile::tempdir().unwrap();
    let library = hook(directory.path());
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "file_ops::tests::durability::stall_child",
            "--test-threads=1",
        ])
        .env("LD_PRELOAD", library)
        .env("WSMP_DURABILITY_STALL", directory.path().join("stalled"))
        .env("WSMP_DURABILITY_RELEASE", directory.path().join("release"))
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn stall_child() {
    use crate::file_ops::{
        Cancel,
        pool::{FilePool, MAX_IN_FLIGHT},
    };
    use std::sync::{Arc, mpsc};
    let Some(marker) = std::env::var_os("WSMP_DURABILITY_STALL") else {
        return;
    };
    let fx = Fx::new();
    fx.put("target", "original");
    let etag = fx.etag("target");
    let root = fx.root.clone();
    let path = fx.p("target");
    let ops = Arc::new(fx.ops);
    let cancel = Cancel::new();
    let worker_cancel = cancel.clone();
    let worker_ops = Arc::clone(&ops);
    let pool = FilePool::new();
    let result = pool.submit(move || worker_ops.write(&args(json!({"path":path,"content":"proposed","ifExists":"replace","expectedEtag":etag})), &worker_cancel), MAX_IN_FLIGHT).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !Path::new(&marker).exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(
        Path::new(&marker).exists(),
        "owning fsync must actually stall"
    );
    cancel.cancel();
    assert!(
        result.try_recv().is_err(),
        "cancel cannot settle an outstanding kernel call"
    );
    let (done_tx, done_rx) = mpsc::channel();
    let owner = std::thread::spawn(move || {
        drop(pool);
        done_tx.send(()).unwrap();
    });
    assert!(
        done_rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "pool teardown must retain actual worker ownership"
    );
    fs::write(std::env::var_os("WSMP_DURABILITY_RELEASE").unwrap(), b"").unwrap();
    assert_eq!(
        result
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    owner.join().unwrap();
    assert_eq!(fs::read(root.join("target")).unwrap(), b"original");
    assert!(scan_recovery_dirs(&[root]).is_empty());
}

#[test]
fn departing_exclusive_waiter_admits_queued_shared_successor() {
    use crate::file_ops::{Cancel, Namespace};
    use std::sync::{Arc, mpsc};
    for timeout in [false, true] {
        let namespace = Arc::new(Namespace::default());
        let first_cancel = Cancel::new();
        let first = namespace
            .acquire(false, &first_cancel, Duration::from_secs(2))
            .unwrap();
        let cancel = Cancel::new();
        let waiter_cancel = cancel.clone();
        let waiter_ns = Arc::clone(&namespace);
        let (wait_tx, wait_rx) = mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let wait = if timeout {
                Duration::from_millis(150)
            } else {
                Duration::from_secs(2)
            };
            wait_tx
                .send(waiter_ns.acquire(true, &waiter_cancel, wait).map(drop))
                .unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while namespace.state.lock().unwrap().waiting_exclusive == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(namespace.state.lock().unwrap().waiting_exclusive, 1);
        let next_ns = Arc::clone(&namespace);
        let (next_tx, next_rx) = mpsc::channel();
        let next = std::thread::spawn(move || {
            next_tx
                .send(
                    next_ns
                        .acquire(false, &Cancel::new(), Duration::from_secs(2))
                        .map(drop),
                )
                .unwrap();
        });
        assert!(next_rx.recv_timeout(Duration::from_millis(20)).is_err());
        if !timeout {
            cancel.cancel();
        }
        assert_eq!(
            wait_rx
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap_err()
                .code,
            if timeout {
                ErrorCode::Timeout
            } else {
                ErrorCode::Cancelled
            }
        );
        next_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert_eq!(namespace.state.lock().unwrap().waiting_exclusive, 0);
        drop(first);
        waiter.join().unwrap();
        next.join().unwrap();
    }
}

#[test]
fn rejected_nr_and_link_publication_retains_originals_after_restart() {
    for rename in [false, true] {
        for link in [false, true] {
            let fx = Fx::new();
            fx.put("src", "source");
            fx.put("dst", "original destination");
            let etag = fx.etag("dst");
            let root = fx.root.clone();
            let fx = fx.with_hook(move |step| {
                if step == Step::Publishing {
                    fs::write(root.join("dst"), b"public successor").unwrap();
                }
                Ok(())
            });
            let mut faults = if rename {
                vec![(Primitive::ProbeExchange, 1, Errno::EINVAL)]
            } else {
                vec![(Primitive::Exchange, 1, Errno::EINVAL)]
            };
            if link {
                faults.push((Primitive::ProbeNoReplace, 1, Errno::EINVAL));
            }
            let result = {
                let _fault = FaultScope::new(&faults);
                if rename {
                    fx.ops.execute("rename", json!({"from":fx.p("src"),"to":fx.p("dst"),"overwrite":true,"expectedEtag":etag}), &fx.cancel)
                } else {
                    fx.ops.execute("write", json!({"path":fx.p("dst"),"content":"proposed","ifExists":"replace","expectedEtag":etag}), &fx.cancel)
                }
            };
            assert_eq!(result.unwrap_err().code, ErrorCode::UncertainOutcome);
            let dir = abandoned(&fx);
            assert_eq!(intent(&dir).phase, IntentPhase::Compensating);
            depart(&dir);
            for _ in 0..2 {
                assert_eq!(recover_dir(&dir, true, None).action, RecoverAction::Listed);
                assert_eq!(fx.get("dst"), "public successor");
                assert_eq!(fx.get("src"), "source");
                assert!(fs::read_dir(&dir).unwrap().any(|entry| {
                    fs::read(entry.unwrap().path())
                        .is_ok_and(|bytes| bytes == b"original destination")
                }));
            }
        }
    }
}

fn run_scenario(library: &Path, directory: &Path, scenario: &str, envs: &[(&str, &str)]) -> bool {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "file_ops::tests::durability::scenario_child",
            "--test-threads=1",
        ])
        .env("LD_PRELOAD", library)
        .env("WSMP_SCENARIO", scenario)
        .env(
            "WSMP_DURABILITY_DISARM",
            directory.join(format!("disarm-{scenario}")),
        );
    for (key, value) in envs {
        command.env(key, value);
    }
    command.status().unwrap().success()
}

/// FR-1 (refused syscalls are not effects), FR-3 (committed cleanup is
/// residue), FR-4 (unjournaled ops refuse on unsupported directory sync) and
/// FR-5 (reported residue exists).
#[test]
fn refused_effects_and_committed_cleanup_are_truthful() {
    let directory = tempfile::tempdir().unwrap();
    let library = hook(directory.path());
    let mut failed = Vec::new();
    for (scenario, envs) in [
        (
            "exchangeless-replace",
            vec![
                ("WSMP_DURABILITY_FAULT", "intent-nth"),
                ("WSMP_DURABILITY_PHASE", "prepared"),
                ("WSMP_DURABILITY_NTH", "2"),
            ],
        ),
        (
            "nr-overwrite-rename",
            vec![
                ("WSMP_DURABILITY_FAULT", "intent-nth"),
                ("WSMP_DURABILITY_PHASE", "prepared"),
                ("WSMP_DURABILITY_NTH", "2"),
            ],
        ),
        (
            "move-unsupported-rename-5",
            vec![
                ("WSMP_DURABILITY_FAULT", "rdir-nth"),
                ("WSMP_DURABILITY_NTH", "5"),
            ],
        ),
        (
            "move-unsupported-rename-6",
            vec![
                ("WSMP_DURABILITY_FAULT", "rdir-nth"),
                ("WSMP_DURABILITY_NTH", "6"),
            ],
        ),
        (
            "link-first-committed",
            vec![
                ("WSMP_DURABILITY_FAULT", "intent-nth"),
                ("WSMP_DURABILITY_PHASE", "committed"),
                ("WSMP_DURABILITY_NTH", "2"),
            ],
        ),
        (
            "exchange-rename-committed",
            vec![
                ("WSMP_DURABILITY_FAULT", "intent-nth"),
                ("WSMP_DURABILITY_PHASE", "committed"),
                ("WSMP_DURABILITY_NTH", "2"),
            ],
        ),
        (
            "unsupported-dir-sync-unjournaled",
            vec![("WSMP_DURABILITY_FAULT", "dir-einval")],
        ),
        (
            "delete-dispose-barrier",
            vec![("WSMP_DURABILITY_FAULT", "rdir-after-slot-unlink")],
        ),
    ] {
        if !run_scenario(&library, directory.path(), scenario, &envs) {
            failed.push(scenario);
        }
    }
    assert!(failed.is_empty(), "scenarios {failed:?}");
}

fn assert_no_residue(fx: &Fx, scenario: &str) {
    assert!(
        fx.leftovers("").is_empty(),
        "{scenario}: residue {:?}",
        fx.leftovers("")
    );
    assert!(
        crate::file_ops::registry::list_entries().is_empty(),
        "{scenario}: registry entry"
    );
}

#[test]
fn scenario_child() {
    let Ok(scenario) = std::env::var("WSMP_SCENARIO") else {
        return;
    };
    let fx = Fx::new();
    fx.put("src", "original");
    match scenario.as_str() {
        "exchangeless-replace" => {
            // Exchange refused (EINVAL) moved nothing; the later journal
            // failure is still a pre-effect, clean refusal.
            let etag = fx.etag("src");
            let error = {
                let _fault = FaultScope::new(&[(Primitive::Exchange, 1, Errno::EINVAL)]);
                fx.ops
                    .write(
                        &args(json!({"path":fx.p("src"),"content":"proposed","ifExists":"replace","expectedEtag":etag})),
                        &fx.cancel,
                    )
                    .unwrap_err()
            };
            assert_eq!(error.code, ErrorCode::IoError, "{error:?}");
            assert_clean_refusal(&fx, &scenario);
        }
        "nr-overwrite-rename" => {
            // NOREPLACE Move refused with EEXIST moved nothing.
            fx.put("dst", "destination");
            let etag = fx.etag("dst");
            let error = {
                let _fault = FaultScope::new(&[(Primitive::ProbeExchange, 1, Errno::EINVAL)]);
                fx.ops
                    .execute(
                        "rename",
                        json!({"from":fx.p("src"),"to":fx.p("dst"),"overwrite":true,"expectedEtag":etag}),
                        &fx.cancel,
                    )
                    .unwrap_err()
            };
            assert_eq!(error.code, ErrorCode::IoError, "{error:?}");
            assert_eq!(fx.get("dst"), "destination");
            assert_eq!(link_count(&fx.root.join("dst")), 1);
            assert_clean_refusal(&fx, &scenario);
        }
        "move-unsupported-rename-5" | "move-unsupported-rename-6" => {
            // Direct NR refused (ENOSYS): its journaled R must not leave a
            // pinned `publishing` journal behind, whatever barrier fails.
            let result = {
                let _fault = FaultScope::new(&[(Primitive::Move, 1, Errno::ENOSYS)]);
                fx.ops.rename(
                    &args(json!({"from":fx.p("src"),"to":fx.p("dst")})),
                    &fx.cancel,
                )
            };
            match result {
                Ok(_) => {
                    assert!(!fx.root.join("src").exists());
                    assert_eq!(fx.get("dst"), "original");
                    assert_eq!(link_count(&fx.root.join("dst")), 1);
                    assert_no_residue(&fx, &scenario);
                }
                Err(error) => {
                    assert_eq!(error.code, ErrorCode::IoError, "{error:?}");
                    assert!(!fx.root.join("dst").exists());
                    assert_clean_refusal(&fx, &scenario);
                }
            }
        }
        "link-first-committed" | "exchange-rename-committed" => {
            // The rename's `committed` record is durable; a later journal
            // write failure leaves residue, not an uncertain outcome.
            fx.put("dst", "destination");
            let etag = fx.etag("dst");
            let faults: &[(Primitive, usize, Errno)] = if scenario == "link-first-committed" {
                &[
                    (Primitive::ProbeExchange, 1, Errno::EINVAL),
                    (Primitive::ProbeNoReplace, 1, Errno::EINVAL),
                ]
            } else {
                &[]
            };
            let result = {
                let _fault = FaultScope::new(faults);
                fx.ops.rename(
                    &args(json!({"from":fx.p("src"),"to":fx.p("dst"),"overwrite":true,"expectedEtag":etag})),
                    &fx.cancel,
                )
            };
            let result = result.unwrap_or_else(|error| panic!("{scenario}: {error:?}"));
            assert_eq!(fx.get("dst"), "original");
            assert!(!result.recovered.is_empty(), "{scenario}: residue reported");
            disarm();
            for dir in scan_recovery_dirs(std::slice::from_ref(&fx.root)) {
                assert_eq!(intent(&dir).phase, IntentPhase::Committed);
                depart(&dir);
                assert!(matches!(
                    recover_dir(&dir, true, None).action,
                    RecoverAction::Cleaned | RecoverAction::RolledForward
                ));
            }
            assert_eq!(fx.get("dst"), "original");
        }
        "unsupported-dir-sync-unjournaled" => {
            let error = fx
                .ops
                .write(
                    &args(json!({"path":fx.p("new"),"content":"hello"})),
                    &fx.cancel,
                )
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::UnsafeFilesystem, "create {error:?}");
            assert!(!fx.root.join("new").exists());
            let error = fx
                .ops
                .execute("mkdir", json!({"path":fx.p("newdir")}), &fx.cancel)
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::UnsafeFilesystem, "mkdir {error:?}");
            assert!(!fx.root.join("newdir").exists());
            let error = fx
                .ops
                .write(
                    &args(json!({"path":fx.p("deep/a/b.txt"),"content":"x","makeParents":true})),
                    &fx.cancel,
                )
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::UnsafeFilesystem, "parents {error:?}");
            assert!(!fx.root.join("deep").exists());
            assert_no_residue(&fx, &scenario);
            assert_eq!(fx.get("src"), "original");
        }
        "delete-dispose-barrier" => {
            // Committed delete; the barrier after the slot unlink fails.
            let result = fx
                .ops
                .delete(&args(json!({"path":fx.p("src")})), &fx.cancel)
                .unwrap();
            assert!(result.deleted);
            assert!(!fx.root.join("src").exists());
            assert!(!result.recovered.is_empty());
            for path in &result.recovered {
                assert!(
                    Path::new(path).exists(),
                    "reported residue {path} must exist"
                );
            }
            disarm();
            for dir in scan_recovery_dirs(std::slice::from_ref(&fx.root)) {
                depart(&dir);
                recover_dir(&dir, true, None);
            }
            assert!(!fx.root.join("src").exists(), "acknowledged delete stays");
        }
        other => panic!("unknown scenario {other}"),
    }
}

/// FR-2: a process killed right after the named phase became durable.
#[test]
fn interrupted_capture_and_delete_publication_roll_back_automatically() {
    let directory = tempfile::tempdir().unwrap();
    let library = hook(directory.path());
    let _registry = crate::file_ops::registry::install_temp_registry();
    for (op, phase, automatic) in [
        ("delete", "capturing", true),
        ("delete", "publishing", true),
        ("replace", "publishing", false),
    ] {
        let holder = tempfile::tempdir().unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "file_ops::tests::durability::killed_child",
                "--test-threads=1",
            ])
            .env("LD_PRELOAD", &library)
            .env("TMPDIR", holder.path())
            .env("WSMP_KILLED_OP", op)
            .env("WSMP_KILLED_HOLDER", holder.path())
            .env("WSMP_DURABILITY_FAULT", "kill-after-phase")
            .env("WSMP_DURABILITY_PHASE", phase)
            .status()
            .unwrap();
        assert!(!status.success(), "{op}/{phase}: child must be killed");
        let root = PathBuf::from(fs::read_to_string(holder.path().join("root")).unwrap());
        let dirs = scan_recovery_dirs(std::slice::from_ref(&root));
        assert_eq!(dirs.len(), 1, "{op}/{phase}");
        let dir = &dirs[0];
        assert_eq!(
            crate::file_ops::intent::intent_phase_name(intent(dir).phase),
            phase
        );
        depart(dir);
        let report = recover_dir(dir, true, None);
        if automatic {
            assert!(
                matches!(
                    report.action,
                    RecoverAction::Cleaned | RecoverAction::RolledBack
                ),
                "{op}/{phase}: {report:?}"
            );
            assert_eq!(fs::read(root.join("src")).unwrap(), b"original");
            assert_eq!(
                link_count(&root.join("src")),
                1,
                "{op}/{phase}: no pin left"
            );
            assert!(!dir.exists(), "{op}/{phase}");
        } else {
            assert_eq!(report.action, RecoverAction::Listed, "{op}/{phase}");
            assert!(report.message.contains("mv -n"), "{op}/{phase}: {report:?}");
            assert!(dir.exists());
        }
    }
}

#[test]
fn killed_child() {
    let Ok(op) = std::env::var("WSMP_KILLED_OP") else {
        return;
    };
    let holder = std::env::var_os("WSMP_KILLED_HOLDER").unwrap();
    let fx = Fx::new();
    fx.put("src", "original");
    fs::write(
        Path::new(&holder).join("root"),
        fx.root.as_os_str().as_encoded_bytes(),
    )
    .unwrap();
    let _ = if op == "delete" {
        fx.ops
            .delete(&args(json!({"path":fx.p("src")})), &fx.cancel)
            .map(drop)
    } else {
        let etag = fx.etag("src");
        fx.ops
            .write(
                &args(json!({"path":fx.p("src"),"content":"proposed","ifExists":"replace","expectedEtag":etag})),
                &fx.cancel,
            )
            .map(drop)
    };
    // Reaching here means the phase was never journaled: report it.
    std::process::exit(0);
}

/// F1/F2: a replace interrupted inside its capture/compensation windows. The
/// child dies (step-hook exit or SIGKILL right after a durable INTENT phase);
/// `recover --apply` must restore the right object and never publish the
/// CLI's own rejected temp.
#[test]
fn interrupted_replace_rolls_back_without_publishing_its_temp() {
    let directory = tempfile::tempdir().unwrap();
    let library = hook(directory.path());
    let _registry = crate::file_ops::registry::install_temp_registry();
    let mut failed = Vec::new();
    for (window, kill_phase, expected) in [
        // Exchange swapped in a third party's file; compensation captured T.
        ("compensation-captured", None, "THIRD PARTY"),
        // ...or died right after journaling that capture, T still public.
        ("compensation-capturing", Some("capturing"), "THIRD PARTY"),
        // No exchange (NFS class): the original was captured, T unpublished.
        ("exchangeless-captured", None, "original"),
        // ...or died right after journaling that capture.
        ("exchangeless-capturing", Some("capturing"), "original"),
    ] {
        let holder = tempfile::tempdir().unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "file_ops::tests::durability::interrupted_replace_child",
                "--test-threads=1",
            ])
            .env("TMPDIR", holder.path())
            .env("WSMP_REPLACE_WINDOW", window)
            .env("WSMP_KILLED_HOLDER", holder.path());
        if let Some(phase) = kill_phase {
            command
                .env("LD_PRELOAD", &library)
                .env("WSMP_DURABILITY_FAULT", "kill-after-phase")
                .env("WSMP_DURABILITY_PHASE", phase);
        }
        let _ = command.status().unwrap();
        if holder.path().join("finished").exists() {
            failed.push(format!("{window}: the window was never reached"));
            continue;
        }
        let root = PathBuf::from(fs::read_to_string(holder.path().join("root")).unwrap());
        let dirs = scan_recovery_dirs(std::slice::from_ref(&root));
        if dirs.len() != 1 {
            failed.push(format!("{window}: {} recovery dirs", dirs.len()));
            continue;
        }
        depart(&dirs[0]);
        let report = recover_dir(&dirs[0], true, None);
        let public = fs::read_to_string(root.join("target")).ok();
        let clean = !dirs[0].exists();
        let nlink = fs::symlink_metadata(root.join("target")).ok().map(|m| {
            use std::os::unix::fs::MetadataExt;
            m.nlink()
        });
        if public.as_deref() != Some(expected) || !clean || nlink != Some(1) {
            failed.push(format!(
                "{window}: public={public:?} clean={clean} nlink={nlink:?} report={report:?}"
            ));
        }
    }
    assert!(failed.is_empty(), "{failed:#?}");
}

#[test]
fn interrupted_replace_child() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let Ok(window) = std::env::var("WSMP_REPLACE_WINDOW") else {
        return;
    };
    let holder = PathBuf::from(std::env::var_os("WSMP_KILLED_HOLDER").unwrap());
    let fx = Fx::new();
    fx.put("target", "original");
    fs::write(holder.join("root"), fx.root.as_os_str().as_encoded_bytes()).unwrap();
    let etag = fx.etag("target");
    let root = fx.root.clone();
    let compensation = window.starts_with("compensation");
    let step_exit = window.ends_with("captured");
    let captured = AtomicUsize::new(0);
    let fx = fx.with_hook(move |step| {
        if compensation && step == Step::EtagRechecked {
            fs::remove_file(root.join("target")).unwrap();
            fs::write(root.join("target"), b"THIRD PARTY").unwrap();
        }
        if step_exit {
            if compensation
                && step == Step::Captured
                && captured.fetch_add(1, Ordering::SeqCst) == 1
            {
                std::process::exit(0); // T captured into R and journaled
            }
            if !compensation && step == Step::Vacated {
                std::process::exit(0); // original captured and journaled
            }
        }
        Ok(())
    });
    let faults: &[(Primitive, usize, Errno)] = if compensation {
        &[]
    } else {
        &[(Primitive::Exchange, 1, Errno::EINVAL)]
    };
    let _fault = FaultScope::new(faults);
    let _ = fx.ops.write(
        &args(json!({"path":fx.p("target"),"content":"CLI PROPOSED","ifExists":"replace","expectedEtag":etag})),
        &fx.cancel,
    );
    fs::write(holder.join("finished"), b"").unwrap();
    std::process::exit(0);
}

/// F4: a direct no-replace move's ENOENT is ambiguous (an NFS retransmit can
/// report it after the move took effect): the names decide, never the errno.
#[test]
fn direct_move_ambiguous_errno_is_decided_from_the_names() {
    // The move took effect, then ENOENT was reported: committed.
    let fx = Fx::new();
    fx.put("src", "original");
    let result = {
        let _fault = FaultScope::after_effect(&[(Primitive::Move, 1, Errno::ENOENT)]);
        fx.ops.rename(
            &args(json!({"from":fx.p("src"),"to":fx.p("dst")})),
            &fx.cancel,
        )
    };
    result.unwrap();
    assert!(!fx.root.join("src").exists());
    assert_eq!(fx.get("dst"), "original");
    assert!(fx.leftovers("").is_empty(), "{:?}", fx.leftovers(""));
    // Refused before effect with ENOENT: the source still holds it, certain.
    let fx = Fx::new();
    fx.put("src", "original");
    let error = {
        let _fault = FaultScope::new(&[(Primitive::Move, 1, Errno::ENOENT)]);
        fx.ops
            .rename(
                &args(json!({"from":fx.p("src"),"to":fx.p("dst")})),
                &fx.cancel,
            )
            .unwrap_err()
    };
    assert_ne!(error.code, ErrorCode::UncertainOutcome, "{error:?}");
    assert_eq!(fx.get("src"), "original");
    assert!(!fx.root.join("dst").exists());
    assert!(fx.leftovers("").is_empty(), "{:?}", fx.leftovers(""));
    assert_eq!(link_count(&fx.root.join("src")), 1);
}

/// F5: a capture that reports ENOENT after it moved the object is not
/// "nothing moved": the object stays journaled and recoverable.
#[test]
fn capture_enoent_after_effect_keeps_the_object_journaled() {
    let fx = Fx::new();
    fx.put("src", "original");
    let error = {
        let _fault = FaultScope::after_effect(&[(Primitive::Capture, 1, Errno::ENOENT)]);
        fx.ops
            .delete(&args(json!({"path":fx.p("src")})), &fx.cancel)
            .unwrap_err()
    };
    assert_eq!(error.code, ErrorCode::UncertainOutcome, "{error:?}");
    let dir = abandoned(&fx);
    assert_eq!(fs::read(dir.join("slot-1")).unwrap(), b"original");
    assert!(intent(&dir).slots["slot-1"].anchor.is_some(), "pin kept");
    depart(&dir);
    assert!(matches!(
        recover_dir(&dir, true, None).action,
        RecoverAction::Cleaned | RecoverAction::RolledBack
    ));
    assert_eq!(fx.get("src"), "original");
    assert_eq!(link_count(&fx.root.join("src")), 1);
}

/// F6: a CLI state directory without directory fsync is an unsafe
/// filesystem for journaling, named in the error, with nothing changed.
#[test]
fn unsupported_state_directory_sync_is_unsafe_filesystem() {
    let directory = tempfile::tempdir().unwrap();
    let library = hook(directory.path());
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "file_ops::tests::durability::state_directory_child",
            "--test-threads=1",
        ])
        .env("LD_PRELOAD", &library)
        .env("WSMP_DURABILITY_FAULT", "listed-dir-einval")
        .env("WSMP_DURABILITY_TARGET", directory.path().join("target"))
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn state_directory_child() {
    let Some(target) = std::env::var_os("WSMP_DURABILITY_TARGET") else {
        return;
    };
    let fx = Fx::new();
    fx.put("src", "original");
    let registry = crate::file_ops::registry::current_registry_dir();
    fs::write(&target, registry.as_os_str().as_encoded_bytes()).unwrap();
    let error = fx
        .ops
        .delete(&args(json!({"path":fx.p("src")})), &fx.cancel)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::UnsafeFilesystem, "{error:?}");
    assert!(
        error.message.contains(registry.to_string_lossy().as_ref()),
        "{error:?}"
    );
    assert_eq!(fx.get("src"), "original");
    assert_eq!(link_count(&fx.root.join("src")), 1);
    assert!(fx.leftovers("").is_empty(), "{:?}", fx.leftovers(""));
}
