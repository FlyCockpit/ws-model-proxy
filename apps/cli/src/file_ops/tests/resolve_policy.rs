//! Path resolution and policy: symlinks, `..`, roots, the protected set,
//! special files, and swap races.

use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::json;

use super::super::policy::Access;
use super::super::policy::{Deny, Protected};
use super::super::resolve::{MAX_SYMLINK_HOPS, ResolveOpts, resolve};
use super::super::{ErrorCode, Policy};
use super::{Fx, args, code};

#[test]
fn symlink_to_file_is_followed_and_resolved_path_is_echoed() {
    let fx = Fx::new();
    fx.put("real/data.txt", "hello\n");
    fx.link("real/data.txt", "link.txt");
    let result = fx.read("link.txt");
    assert_eq!(result.text, "1|hello");
    assert_eq!(result.resolved_path, Some(fx.p("real/data.txt")));
    assert_eq!(fx.read("real/data.txt").resolved_path, None);
}

#[test]
fn dotdot_is_resolved_against_the_physical_directory() {
    let fx = Fx::new();
    fx.put("real/sub/x", "x");
    fx.put("real/file", "physical parent");
    fx.put("file", "lexical parent");
    fx.link("real/sub", "link");
    // lexically root/link/../file is root/file; physically it is real/file
    assert_eq!(fx.read("link/../file").text, "1|physical parent");
}

#[test]
fn absolute_and_relative_links_and_dotdot_at_root() {
    let fx = Fx::new();
    fx.put("target/f", "abs");
    fx.link(fx.root.join("target"), "abs_link");
    fx.link("target", "rel_link");
    assert_eq!(fx.read("abs_link/f").text, "1|abs");
    assert_eq!(fx.read("rel_link/f").text, "1|abs");
    let path = format!("/../../..{}", fx.p("target/f"));
    assert_eq!(fx.read_with(json!({ "path": path })).text, "1|abs");
}

#[test]
fn symlink_hop_limit_is_forty() {
    let fx = Fx::new();
    fx.put("final", "end");
    let mut previous = "final".to_string();
    for i in 0..=MAX_SYMLINK_HOPS {
        let name = format!("l{i}");
        fx.link(&previous, &name);
        previous = name;
    }
    // l39 -> ... -> l0 -> final : 40 hops
    assert_eq!(fx.read(&format!("l{}", MAX_SYMLINK_HOPS - 1)).text, "1|end");
    // l40 needs 41
    let err = fx
        .ops
        .read(
            &args(json!({ "path": fx.p(&format!("l{MAX_SYMLINK_HOPS}")) })),
            &fx.cancel,
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::IoError);
    assert_eq!(err.message, "ELOOP");
}

#[test]
fn symlink_loop_and_dangling_link() {
    let fx = Fx::new();
    fx.link("b", "a");
    fx.link("a", "b");
    assert_eq!(
        code(fx.ops.read(&args(json!({ "path": fx.p("a") })), &fx.cancel)),
        ErrorCode::IoError
    );
    fx.link("nowhere", "dangling");
    assert_eq!(
        code(
            fx.ops
                .read(&args(json!({ "path": fx.p("dangling") })), &fx.cancel)
        ),
        ErrorCode::NotFound
    );
}

#[test]
fn path_shape_table() {
    let fx = Fx::new();
    let long = format!("/{}", "a".repeat(4100));
    let rows: Vec<(String, ErrorCode)> = vec![
        ("relative/path".into(), ErrorCode::InvalidInput),
        ("".into(), ErrorCode::InvalidInput),
        ("/tmp/a\0b".into(), ErrorCode::InvalidInput),
        ("~other/file".into(), ErrorCode::InvalidInput),
        (long, ErrorCode::InvalidInput),
        (fx.p("missing/dir/file"), ErrorCode::NotFound),
    ];
    for (path, expected) in rows {
        let got = code(fx.ops.read(&args(json!({ "path": path })), &fx.cancel));
        assert_eq!(got, expected, "{path:?}");
    }
    fx.put("file", "x");
    // a regular file used as a directory component
    assert_eq!(
        code(
            fx.ops
                .read(&args(json!({ "path": fx.p("file/inner") })), &fx.cancel)
        ),
        ErrorCode::NotADir
    );
    assert_eq!(
        code(fx.ops.read(
            &args(json!({ "path": fx.root.to_string_lossy() })),
            &fx.cancel
        )),
        ErrorCode::NotAFile
    );
}

#[test]
fn tilde_expands_to_home() {
    let fx = Fx::new();
    let home = dirs::home_dir().expect("home");
    let stat = fx
        .ops
        .stat(&args(json!({ "paths": ["~"] })), &fx.cancel)
        .expect("stat");
    assert_eq!(stat.entries[0].kind, Some("dir"), "{home:?}");
    assert_eq!(stat.entries[0].resolved_path.as_deref(), home.to_str());
}

#[test]
fn roots_confine_symlink_and_dotdot_escapes() {
    let fx = Fx::with_policy(|root| {
        std::fs::create_dir(root.join("jail")).expect("root exists before startup");
        Policy::new(vec![root.join("jail")], vec![], true)
    });
    fx.put("jail/in.txt", "inside");
    fx.put("outside/secret.txt", "outside");
    fx.link(fx.root.join("outside"), "jail/escape");
    fx.link("../outside/secret.txt", "jail/filelink");
    assert_eq!(fx.read("jail/in.txt").text, "1|inside");
    for path in [
        "jail/escape/secret.txt",
        "jail/filelink",
        "jail/../outside/secret.txt",
        "outside/secret.txt",
    ] {
        assert_eq!(
            code(
                fx.ops
                    .read(&args(json!({ "path": fx.p(path) })), &fx.cancel)
            ),
            ErrorCode::PathDenied,
            "{path}"
        );
    }
    // writes obey the same roots
    assert_eq!(
        code(fx.ops.write(
            &args(json!({ "path": fx.p("jail/escape/new.txt"), "content": "x" })),
            &fx.cancel
        )),
        ErrorCode::PathDenied
    );
    assert!(!fx.root.join("outside/new.txt").exists());
}

#[test]
fn make_parents_never_creates_directories_outside_roots() {
    let fx = Fx::with_policy(|root| {
        std::fs::create_dir(root.join("jail")).expect("root exists before startup");
        Policy::new(vec![root.join("jail")], vec![], true)
    });
    let err = fx.ops.write(
        &args(json!({ "path": fx.p("other/deep/f.txt"), "content": "x", "makeParents": true })),
        &fx.cancel,
    );
    assert_eq!(code(err), ErrorCode::PathDenied);
    assert!(!fx.root.join("other").exists());
    fx.ops
        .write(
            &args(json!({ "path": fx.p("jail/a/b/f.txt"), "content": "x", "makeParents": true })),
            &fx.cancel,
        )
        .unwrap();
    assert_eq!(fx.get("jail/a/b/f.txt"), "x");
}

#[test]
fn protected_files_are_denied_through_every_alias() {
    let fx = Fx::with_policy(Fx::protecting(&[
        ("state/device-auth.json", Deny::ReadWrite),
        ("cfg/config.json", Deny::WriteOnly),
    ]));
    fx.put("state/device-auth.json", "{\"token\":\"abc\"}");
    fx.put("cfg/config.json", "{}");
    fx.link(fx.root.join("state"), "state_link");
    std::fs::hard_link(
        fx.root.join("state/device-auth.json"),
        fx.root.join("alias.json"),
    )
    .unwrap();
    for path in [
        "state/device-auth.json",
        "state_link/device-auth.json",
        "alias.json",
        "state/../state/device-auth.json",
    ] {
        assert_eq!(
            code(
                fx.ops
                    .read(&args(json!({ "path": fx.p(path) })), &fx.cancel)
            ),
            ErrorCode::PathDenied,
            "read {path}"
        );
    }
    assert_eq!(
        code(fx.ops.write(&args(json!({ "path": fx.p("alias.json"), "content": "x", "ifExists": "replace", "expectedEtag": "h:x" })), &fx.cancel)),
        ErrorCode::PathDenied
    );
    // config.json is readable but not writable, not deletable, not movable
    assert!(
        fx.ops
            .read(
                &args(json!({ "path": fx.p("cfg/config.json") })),
                &fx.cancel
            )
            .is_ok()
    );
    let etag = fx.etag("cfg/config.json");
    let edit = fx.ops.edit(
        &args(json!({ "path": fx.p("cfg/config.json"), "expectedEtag": etag, "edits": [{ "oldText": "{}", "newText": "{\"a\":1}" }] })),
        &fx.cancel,
    );
    assert_eq!(code(edit), ErrorCode::PathDenied);
    assert_eq!(fx.get("cfg/config.json"), "{}");
    assert_eq!(
        code(fx.ops.delete(
            &args(json!({ "path": fx.p("cfg/config.json") })),
            &fx.cancel
        )),
        ErrorCode::PathDenied
    );
    assert_eq!(
        code(fx.ops.rename(
            &args(json!({ "from": fx.p("cfg/config.json"), "to": fx.p("cfg/x.json") })),
            &fx.cancel
        )),
        ErrorCode::PathDenied
    );
    // moving the directory that holds protected files is also refused
    assert_eq!(
        code(fx.ops.rename(
            &args(json!({ "from": fx.p("state"), "to": fx.p("moved") })),
            &fx.cancel
        )),
        ErrorCode::PathDenied
    );
    assert!(fx.root.join("state/device-auth.json").exists());
}

#[test]
fn protected_files_are_hidden_from_search_and_stat() {
    let fx = Fx::with_policy(Fx::protecting(&[(
        "state/device-auth.json",
        Deny::ReadWrite,
    )]));
    fx.put("state/device-auth.json", "NEEDLE-in-auth");
    fx.put("state/other.txt", "NEEDLE-in-other");
    let found = fx
        .ops
        .search(
            &args(json!({ "root": fx.p("state"), "pattern": "NEEDLE" })),
            &fx.cancel,
        )
        .unwrap();
    assert!(found.matches.contains("other.txt"));
    assert!(!found.matches.contains("device-auth"), "{}", found.matches);
    let stat = fx
        .ops
        .stat(
            &args(json!({ "paths": [fx.p("state/device-auth.json")] })),
            &fx.cancel,
        )
        .unwrap();
    assert_eq!(stat.entries[0].error, Some("path_denied"));
}

#[test]
fn special_files_and_trees_are_refused() {
    let fx = Fx::new();
    // /proc and /sys exist only on Linux; /dev is everywhere.
    let mut special = vec!["/dev/null"];
    if cfg!(target_os = "linux") {
        special.extend([
            "/proc/self/environ",
            "/proc/self/cmdline",
            "/sys/kernel/hostname",
        ]);
    }
    for path in special {
        assert_eq!(
            code(fx.ops.read(&args(json!({ "path": path })), &fx.cancel)),
            ErrorCode::SpecialFile,
            "{path}"
        );
    }
    // a FIFO must be refused without blocking on open
    let fifo = fx.root.join("pipe");
    nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
    let started = Instant::now();
    assert_eq!(
        code(
            fx.ops
                .read(&args(json!({ "path": fifo.to_string_lossy() })), &fx.cancel)
        ),
        ErrorCode::SpecialFile
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    // a symlink to /dev/null resolves physically to the special tree
    fx.link("/dev/null", "devnull");
    assert_eq!(
        code(
            fx.ops
                .read(&args(json!({ "path": fx.p("devnull") })), &fx.cancel)
        ),
        ErrorCode::SpecialFile
    );
    // writes, renames and deletes never touch a fifo either
    assert_eq!(
        code(
            fx.ops
                .delete(&args(json!({ "path": fifo.to_string_lossy() })), &fx.cancel)
        ),
        ErrorCode::SpecialFile
    );
    assert!(fifo.exists());
    assert_eq!(
        code(fx.ops.rename(
            &args(json!({ "from": fifo.to_string_lossy(), "to": fx.p("pipe2") })),
            &fx.cancel
        )),
        ErrorCode::SpecialFile
    );
}

#[test]
fn non_utf8_symlink_target_is_invalid_input() {
    use std::os::unix::ffi::OsStrExt;
    let fx = Fx::new();
    let target = std::ffi::OsStr::from_bytes(b"file\xff");
    std::os::unix::fs::symlink(target, fx.root.join("bad")).unwrap();
    assert_eq!(
        code(
            fx.ops
                .read(&args(json!({ "path": fx.p("bad") })), &fx.cancel)
        ),
        ErrorCode::InvalidInput
    );
}

#[test]
fn resolve_rolls_back_created_parents() {
    let fx = Fx::new();
    let policy = Policy::new(vec![], vec![], true);
    let mut resolved = resolve(
        &fx.p("a/b/c/leaf"),
        &ResolveOpts {
            follow_last: true,
            make_parents: Some(0o755),
            policy: &policy,
            access: Access::Write,
        },
    )
    .unwrap();
    assert!(fx.root.join("a/b/c").is_dir());
    assert_eq!(resolved.created.len(), 3);
    resolved.rollback_created();
    assert!(!fx.root.join("a").exists());
}

/// Swap a directory component between a real directory and a symlink to a
/// directory outside the roots while reads race the swap. The read must either
/// see the inside file or fail; it must never return the outside content.
#[test]
fn symlink_swap_race_never_escapes_roots() {
    let fx = Fx::with_policy(|root| {
        std::fs::create_dir(root.join("jail")).expect("root exists before startup");
        Policy::new(vec![root.join("jail")], vec![], true)
    });
    fx.put("jail/dir/f", "inside");
    fx.put("outside/f", "SECRET-OUTSIDE");
    let stop = Arc::new(AtomicBool::new(false));
    let root = fx.root.clone();
    let flag = Arc::clone(&stop);
    let swapper = std::thread::spawn(move || {
        while !flag.load(Ordering::SeqCst) {
            // real dir -> parked, symlink in its place, then restore
            let _ = std::fs::rename(root.join("jail/dir"), root.join("jail/parked"));
            let _ = std::os::unix::fs::symlink(root.join("outside"), root.join("jail/dir"));
            let _ = std::fs::remove_file(root.join("jail/dir"));
            let _ = std::fs::rename(root.join("jail/parked"), root.join("jail/dir"));
        }
    });
    let deadline = Instant::now() + Duration::from_millis(1500);
    let (mut inside, mut failed) = (0, 0);
    while Instant::now() < deadline {
        match fx
            .ops
            .read(&args(json!({ "path": fx.p("jail/dir/f") })), &fx.cancel)
        {
            Ok(super::super::read::ReadOutcome::Content(result)) => {
                assert!(!result.text.contains("SECRET-OUTSIDE"), "escaped the roots");
                inside += 1;
            }
            Ok(_) => panic!("unexpected"),
            Err(_) => failed += 1,
        }
    }
    stop.store(true, Ordering::SeqCst);
    swapper.join().unwrap();
    assert!(inside + failed > 100, "race loop barely ran");
}

/// Deterministic TOCTOU: the leaf is swapped for a symlink to another file
/// after the temp file is written; the replace must not follow it.
#[test]
fn leaf_swapped_for_symlink_before_commit_is_a_conflict() {
    let root_cell = Arc::new(std::sync::OnceLock::<std::path::PathBuf>::new());
    let cell = Arc::clone(&root_cell);
    let fx = Fx::new().with_hook(move |step| {
        if step == super::super::Step::TempWritten {
            let root = cell.get().unwrap();
            std::fs::remove_file(root.join("target.txt")).unwrap();
            std::os::unix::fs::symlink(root.join("victim.txt"), root.join("target.txt")).unwrap();
        }
        Ok(())
    });
    root_cell.set(fx.root.clone()).unwrap();
    fx.put("target.txt", "original\n");
    fx.put("victim.txt", "victim\n");
    let etag = fx.etag("target.txt");
    let result = fx.ops.edit(
        &args(json!({ "path": fx.p("target.txt"), "expectedEtag": etag, "edits": [{ "oldText": "original", "newText": "changed" }] })),
        &fx.cancel,
    );
    assert_eq!(code(result), ErrorCode::Conflict);
    assert_eq!(fx.get("victim.txt"), "victim\n");
    assert!(fx.leftovers("").is_empty(), "temp file left behind");
    let _ = std::fs::metadata(fx.root.join("victim.txt")).map(|m| m.permissions().mode());
}

/// A protected inode is refused by `check_identity` even when the caller names a
/// hard link to it (a name-only check would let the alias through).
#[test]
fn a_protected_inode_cannot_be_deleted_through_a_hard_link_alias() {
    let fx = Fx::with_policy(Fx::protecting(&[(
        "state/device-auth.json",
        Deny::ReadWrite,
    )]));
    fx.put("state/device-auth.json", "{\"token\":\"abc\"}");
    std::fs::hard_link(
        fx.root.join("state/device-auth.json"),
        fx.root.join("alias.json"),
    )
    .unwrap();
    assert_eq!(
        code(
            fx.ops
                .delete(&args(json!({ "path": fx.p("alias.json") })), &fx.cancel)
        ),
        ErrorCode::PathDenied
    );
    assert!(fx.root.join("alias.json").exists());
    assert!(fx.root.join("state/device-auth.json").exists());
    // a directory holding the protected file is refused too
    assert_eq!(
        code(
            fx.ops
                .delete(&args(json!({ "path": fx.p("state") })), &fx.cancel)
        ),
        ErrorCode::PathDenied
    );
}

/// A protected directory subtree under the walk root is never descended into: the
/// directory itself is listed by name, but nothing below it is reachable through
/// `dir_list` or `search`.
#[test]
fn a_protected_subtree_is_never_descended_into() {
    let fx = Fx::with_policy(|root| {
        Policy::new(
            vec![],
            vec![Protected {
                path: root.join("vault"),
                subtree: true,
                deny: Deny::ReadWrite,
            }],
            true,
        )
    });
    fx.put("vault/deep/secret.txt", "NEEDLE-in-vault");
    fx.put("vault/leaf.txt", "NEEDLE-leaf");
    fx.put("open/visible.txt", "NEEDLE-visible");
    let listed = fx
        .ops
        .dir_list(&args(json!({ "path": fx.p(""), "depth": 4 })), &fx.cancel)
        .unwrap();
    assert!(listed.entries.contains("visible.txt"), "{}", listed.entries);
    assert!(
        !listed.entries.contains("deep") && !listed.entries.contains("leaf.txt"),
        "{}",
        listed.entries
    );
    let found = fx
        .ops
        .search(
            &args(json!({ "root": fx.p(""), "pattern": "NEEDLE" })),
            &fx.cancel,
        )
        .unwrap();
    assert!(found.matches.contains("visible.txt"));
    assert_eq!(found.count, 1, "{}", found.matches);
}
