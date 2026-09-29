//! stat, dir_list, file_search, rename, dir_create, file_delete.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

use super::super::{Cancel, ErrorCode, Limits};
use super::{Fx, args, code};

// ---- stat -----------------------------------------------------------------

#[test]
fn stat_reports_types_targets_and_per_path_errors() {
    let fx = Fx::new();
    fx.put("dir/file.txt", "hello");
    fx.link("dir/file.txt", "link");
    fx.link("nowhere", "dangling");
    let r = fx
        .ops
        .stat(
            &args(json!({ "paths": [fx.p("dir/file.txt"), fx.p("dir"), fx.p("link"), fx.p("dangling"), fx.p("missing"), "relative"], "hash": true })),
            &fx.cancel,
        )
        .unwrap();
    let e = &r.entries;
    assert_eq!((e[0].kind, e[0].size), (Some("file"), Some(5)));
    assert_eq!(
        e[0].etag,
        Some(fx.etag("dir/file.txt")),
        "hash:true is the strong etag"
    );
    assert!(e[0].owner.is_some() && e[0].mode.as_deref().is_some_and(|m| m.len() == 4));
    assert_eq!(e[1].kind, Some("dir"));
    assert_eq!(e[2].kind, Some("symlink"));
    assert_eq!(e[2].target.as_deref(), Some("dir/file.txt"));
    assert_eq!(e[2].target_type, Some("file"));
    assert_eq!(e[3].target_type, Some("missing"));
    assert_eq!(
        (e[4].error, e[5].error),
        (Some("not_found"), Some("invalid_input"))
    );
    let json = serde_json::to_value(&r).unwrap();
    assert!(json["entries"][4].get("type").is_none());
    // without hash the etag is weak
    let weak = fx
        .ops
        .stat(
            &args(json!({ "paths": [fx.p("dir/file.txt")] })),
            &fx.cancel,
        )
        .unwrap();
    assert!(weak.entries[0].etag.as_deref().unwrap().starts_with("w:"));
}

#[test]
fn stat_path_count_is_capped() {
    let fx = Fx::new();
    let many: Vec<String> = (0..51).map(|i| fx.p(&format!("f{i}"))).collect();
    assert_eq!(
        code(fx.ops.stat(&args(json!({ "paths": many })), &fx.cancel)),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        code(fx.ops.stat(&args(json!({ "paths": [] })), &fx.cancel)),
        ErrorCode::InvalidInput
    );
    let ok: Vec<String> = (0..50).map(|i| fx.p(&format!("f{i}"))).collect();
    assert_eq!(
        fx.ops
            .stat(&args(json!({ "paths": ok })), &fx.cancel)
            .unwrap()
            .entries
            .len(),
        50
    );
}

// ---- list -----------------------------------------------------------------

fn list(fx: &Fx, value: Value) -> super::super::list::ListResult {
    fx.ops.dir_list(&args(value), &fx.cancel).unwrap()
}

#[test]
fn list_format_depth_hidden_glob_and_symlinks() {
    let fx = Fx::new();
    fx.put("models/qwen/q4.gguf", vec![b'a'; 2048]);
    fx.put("models/qwen/notes.txt", "n");
    fx.put("models/.hidden/x", "h");
    fx.put("models/top.gguf", "t");
    fx.link("qwen/q4.gguf", "models/cur");
    fx.link("qwen", "models/dirlink");
    let root = fx.p("models");
    let shallow = list(&fx, json!({ "path": root }));
    let lines: Vec<&str> = shallow.entries.lines().collect();
    assert_eq!(lines.len(), shallow.count);
    assert_eq!(lines[0], format!("l {root}/cur -> qwen/q4.gguf"));
    assert_eq!(lines[1], format!("l {root}/dirlink -> qwen"));
    assert_eq!(lines[2], format!("d {root}/qwen/"));
    assert!(
        lines[3].starts_with("f 1B ") && lines[3].ends_with(&format!(" {root}/top.gguf")),
        "{}",
        lines[3]
    );
    assert_eq!(lines.len(), 4, "{lines:?}");
    assert!(!shallow.entries.contains(".hidden"));
    let deep = list(&fx, json!({ "path": root, "depth": 2, "glob": "*.gguf" }));
    assert!(
        deep.entries.contains(&format!("{root}/qwen/q4.gguf")) && deep.entries.contains("f 2.0K "),
        "{}",
        deep.entries
    );
    assert!(!deep.entries.contains("notes.txt"));
    // a symlinked directory is listed, never descended
    assert!(!deep.entries.contains("dirlink/"));
    let hidden = list(
        &fx,
        json!({ "path": root, "depth": 2, "includeHidden": true }),
    );
    assert!(hidden.entries.contains(".hidden/x"));
    // depth is clamped to 1..4
    fx.put("a/b/c/d/e/f.txt", "x");
    let deepest = list(&fx, json!({ "path": fx.p("a"), "depth": 99 }));
    assert!(
        deepest.entries.contains("d/") && !deepest.entries.contains("f.txt"),
        "{}",
        deepest.entries
    );
}

#[test]
fn list_paging_with_cursor_visits_every_entry_once_in_order() {
    let fx = Fx::new();
    for d in ["a", "b", "c"] {
        for f in ["1", "2", "3"] {
            fx.put(&format!("t/{d}/{f}"), "x");
        }
    }
    fx.put("t/a-b", "x");
    fx.put("t/z", "x");
    let all = list(&fx, json!({ "path": fx.p("t"), "depth": 2 })).entries;
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..40 {
        let mut a = json!({ "path": fx.p("t"), "depth": 2, "maxEntries": 4 });
        if let Some(c) = &cursor {
            a["cursor"] = json!(c);
        }
        let page = list(&fx, a);
        seen.extend(page.entries.lines().map(str::to_string));
        match page.more {
            Some(m) => cursor = Some(m.cursor),
            None => break,
        }
    }
    assert_eq!(seen.join("\n"), all);
    assert_eq!(seen.len(), 3 + 9 + 2);
    assert_eq!(
        code(fx.ops.dir_list(
            &args(json!({ "path": fx.p("t"), "cursor": "!!" })),
            &fx.cancel
        )),
        ErrorCode::InvalidInput
    );
}

#[test]
fn list_refuses_files_and_special_trees() {
    let fx = Fx::new();
    fx.put("f", "x");
    assert_eq!(
        code(
            fx.ops
                .dir_list(&args(json!({ "path": fx.p("f") })), &fx.cancel)
        ),
        ErrorCode::NotADir
    );
    assert_eq!(
        code(
            fx.ops
                .dir_list(&args(json!({ "path": SPECIAL_TREE })), &fx.cancel)
        ),
        ErrorCode::SpecialFile
    );
    let root = fx
        .ops
        .dir_list(&args(json!({ "path": "/", "depth": 1 })), &fx.cancel)
        .unwrap();
    assert!(root.entries.contains(&format!("{SPECIAL_TREE}/")));
}

/// A special tree that exists on every Unix the module builds on.
#[cfg(target_os = "linux")]
const SPECIAL_TREE: &str = "/proc";
#[cfg(not(target_os = "linux"))]
const SPECIAL_TREE: &str = "/dev";

// ---- search ---------------------------------------------------------------

fn search(fx: &Fx, value: Value) -> super::super::search::SearchResult {
    fx.ops.search(&args(value), &fx.cancel).unwrap()
}

#[test]
fn search_literal_regex_case_context_and_glob() {
    let fx = Fx::new();
    fx.put(
        "deploy/qwen.sh",
        "#!/bin/sh\nexec llama-server \\\n  --ctx-size 32768 \\\n  --port 8080\n",
    );
    fx.put("deploy/glm.yaml", "ctx_size: 65536\nname: GLM\n");
    fx.put("deploy/notes.md", "the --ctx-size flag\n");
    let root = fx.p("deploy");
    let lit = search(&fx, json!({ "root": root, "pattern": "--ctx-size" }));
    assert_eq!(
        lit.matches,
        format!("{root}/notes.md:1|the --ctx-size flag\n{root}/qwen.sh:3|  --ctx-size 32768 \\")
    );
    assert_eq!(
        (lit.files, lit.count, lit.scanned_files, lit.more),
        (2, 2, 3, None)
    );
    let globbed = search(
        &fx,
        json!({ "root": root, "pattern": "--ctx-size", "glob": "*.{sh,yaml}" }),
    );
    assert_eq!(globbed.count, 1);
    let re = search(
        &fx,
        json!({ "root": root, "pattern": r"ctx[-_]size\s*:?\s*\d+", "mode": "regex" }),
    );
    assert_eq!(re.count, 2, "{}", re.matches);
    let case = search(
        &fx,
        json!({ "root": root, "pattern": "glm", "caseInsensitive": true }),
    );
    assert!(case.matches.contains("glm.yaml:2|name: GLM"));
    assert_eq!(
        search(&fx, json!({ "root": root, "pattern": "glm" })).count,
        0
    );
    // literal mode does not interpret regex metacharacters
    assert_eq!(
        search(&fx, json!({ "root": root, "pattern": ".*" })).count,
        0
    );
    // context lines and group separators
    let ctx = search(
        &fx,
        json!({ "root": fx.p("deploy/qwen.sh"), "pattern": "port", "contextLines": 1 }),
    );
    assert_eq!(
        ctx.matches,
        format!("{root}/qwen.sh-3|  --ctx-size 32768 \\\n{root}/qwen.sh:4|  --port 8080")
    );
    fx.put("g.txt", "hit\nx\nx\nx\nhit\n");
    let groups = search(
        &fx,
        json!({ "root": fx.p("g.txt"), "pattern": "hit", "contextLines": 1 }),
    );
    assert_eq!(
        groups.matches.lines().filter(|l| *l == "--").count(),
        1,
        "{}",
        groups.matches
    );
}

#[test]
fn search_input_errors_and_limits() {
    let fx = Fx::new();
    fx.put("d/a.txt", "x\n".repeat(50));
    let bad = fx.ops.search(
        &args(json!({ "root": fx.p("d"), "pattern": "(", "mode": "regex" })),
        &fx.cancel,
    );
    assert_eq!(code(bad), ErrorCode::InvalidInput);
    assert_eq!(
        code(fx.ops.search(
            &args(json!({ "root": fx.p("d"), "pattern": "" })),
            &fx.cancel
        )),
        ErrorCode::InvalidInput
    );
    let too_long = "a".repeat(1025);
    assert_eq!(
        code(fx.ops.search(
            &args(json!({ "root": fx.p("d"), "pattern": too_long })),
            &fx.cancel
        )),
        ErrorCode::InvalidInput
    );
    // catastrophic patterns are linear-time in this engine
    fx.put("d/evil.txt", "a".repeat(200_000));
    let started = std::time::Instant::now();
    search(
        &fx,
        json!({ "root": fx.p("d"), "pattern": "(a+)+$", "mode": "regex" }),
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    let capped = search(
        &fx,
        json!({ "root": fx.p("d"), "pattern": "x", "maxMatches": 10 }),
    );
    assert_eq!(capped.count, 10);
    assert!(capped.more.unwrap().note.contains("more matches"));
    // maxFiles stops the scan and says so
    for i in 0..5 {
        fx.put(&format!("many/{i}.txt"), "needle\n");
    }
    let files = search(
        &fx,
        json!({ "root": fx.p("many"), "pattern": "needle", "maxFiles": 2 }),
    );
    assert_eq!((files.scanned_files, files.count), (2, 2));
    assert!(files.more.unwrap().note.contains("file limit"));
}

#[test]
fn search_skips_binary_large_and_unreadable_and_never_follows_links() {
    let fx = Fx::new();
    fx.put("s/text.txt", "needle\n");
    fx.put("s/bin.dat", b"needle\0binary");
    fx.put("s/latin1.txt", b"needle cuv\xe9e\n");
    fx.put(
        "s/huge.txt",
        format!("needle\n{}", "x".repeat(9 * 1024 * 1024)),
    );
    fx.put("outside/o.txt", "needle in outside\n");
    fx.link(fx.root.join("outside"), "s/dirlink");
    fx.link(fx.root.join("outside/o.txt"), "s/filelink");
    let r = search(&fx, json!({ "root": fx.p("s"), "pattern": "needle" }));
    assert_eq!(r.count, 1, "{}", r.matches);
    assert!(r.matches.contains("text.txt"));
}

#[test]
fn search_skips_secret_class_files_and_masks_other_files() {
    let fx = Fx::new();
    fx.put("c/.env", "HF_TOKEN=hunter2secret\nPORT=9\n");
    fx.put("c/server.pem", "note\n");
    fx.put(".ssh/id_ed25519", "key body\n");
    fx.put("c/run.sh", "run --api-key sk-abc123 --x\n");
    // secret-class files are not searched at all: no match, and no oracle for a
    // value, a name, or the length of a masked one
    for pattern in [
        "HF_TOKEN", "hunter2", "PORT", "SERVER", "PRIVATE", "key body",
    ] {
        let r = search(&fx, json!({ "root": fx.p("c"), "pattern": pattern }));
        assert_eq!(r.count, 0, "pattern {pattern}: {}", r.matches);
        assert_eq!(r.files, 0, "pattern {pattern}");
    }
    // a plain file is still searched, with its own secrets masked in the hits
    let flag = search(&fx, json!({ "root": fx.p("c"), "pattern": "api-key" }));
    assert!(
        flag.matches
            .contains("--api-key \u{27E6}redacted:13\u{27E7}"),
        "{}",
        flag.matches
    );
    assert_eq!(
        search(&fx, json!({ "root": fx.p("c"), "pattern": "sk-abc" })).count,
        0
    );
    // `id_*` under the root is skipped as well
    assert_eq!(
        search(&fx, json!({ "root": fx.p(""), "pattern": "key body" })).count,
        0
    );
    assert!(
        search(&fx, json!({ "root": fx.p(""), "pattern": "api-key" })).count > 0,
        "the plain file is still reached from the root"
    );
}

#[test]
fn search_deadline_and_cancel_stop_the_walk() {
    let fx = Fx::new();
    for i in 0..20 {
        fx.put(&format!("w/{i:02}.txt"), "needle\n");
    }
    let slow = Fx::new().ops.with_limits(Limits {
        search_deadline: Duration::ZERO,
        ..Limits::default()
    });
    slow.policy();
    let r = slow
        .search(
            &args(json!({ "root": fx.p("w"), "pattern": "needle" })),
            &Cancel::new(),
        )
        .unwrap();
    assert!(r.more.unwrap().note.contains("time budget"));
    assert!(r.scanned_files < 20);
    fx.cancel.cancel();
    assert_eq!(
        code(fx.ops.search(
            &args(json!({ "root": fx.p("w"), "pattern": "needle" })),
            &fx.cancel
        )),
        ErrorCode::Cancelled
    );
}

// ---- rename / mkdir / delete ---------------------------------------------

#[test]
fn rename_moves_files_and_dirs_and_refuses_overwrite_by_default() {
    let fx = Fx::new();
    fx.put("dl/model.part", "weights");
    let r = fx.ops.rename(
        &args(json!({ "from": fx.p("dl/model.part"), "to": fx.p("models/model.gguf") })),
        &fx.cancel,
    );
    assert_eq!(
        code(r),
        ErrorCode::NotFound,
        "destination parent must exist"
    );
    std::fs::create_dir(fx.root.join("models")).unwrap();
    let r = fx
        .ops
        .rename(
            &args(json!({ "from": fx.p("dl/model.part"), "to": fx.p("models/model.gguf") })),
            &fx.cancel,
        )
        .unwrap();
    assert!(r.etag.unwrap().starts_with("h:"));
    assert_eq!(fx.get("models/model.gguf"), "weights");
    assert!(!fx.root.join("dl/model.part").exists());
    fx.put("a/x", "x");
    fx.ops
        .rename(
            &args(json!({ "from": fx.p("a"), "to": fx.p("b") })),
            &fx.cancel,
        )
        .unwrap();
    assert!(fx.root.join("b/x").exists());
    // existing destination
    fx.put("one", "1");
    fx.put("two", "2");
    assert_eq!(
        code(fx.ops.rename(
            &args(json!({ "from": fx.p("one"), "to": fx.p("two") })),
            &fx.cancel
        )),
        ErrorCode::Exists
    );
    assert_eq!((fx.get("one"), fx.get("two")), ("1".into(), "2".into()));
    // same path, missing source, dot references
    assert_eq!(
        code(fx.ops.rename(
            &args(json!({ "from": fx.p("one"), "to": fx.p("one") })),
            &fx.cancel
        )),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        code(fx.ops.rename(
            &args(json!({ "from": fx.p("nope"), "to": fx.p("x") })),
            &fx.cancel
        )),
        ErrorCode::NotFound
    );
    assert_eq!(
        code(
            fx.ops
                .rename(&args(json!({ "from": "/", "to": fx.p("x") })), &fx.cancel)
        ),
        ErrorCode::InvalidInput
    );
}

#[test]
fn rename_overwrite_needs_the_destination_etag_and_swaps_symlinks() {
    let fx = Fx::new();
    fx.put("new.yaml", "new\n");
    fx.put("old.yaml", "old\n");
    let over = |etag: Option<&str>| {
        let mut a = json!({ "from": fx.p("new.yaml"), "to": fx.p("old.yaml"), "overwrite": true });
        if let Some(etag) = etag {
            a["expectedEtag"] = json!(etag);
        }
        fx.ops.rename(&args(a), &fx.cancel)
    };
    assert_eq!(code(over(None)), ErrorCode::InvalidInput);
    assert_eq!(code(over(Some("h:stale"))), ErrorCode::Conflict);
    assert_eq!(fx.get("old.yaml"), "old\n");
    over(Some(&fx.etag("old.yaml"))).unwrap();
    assert_eq!(fx.get("old.yaml"), "new\n");
    // swapping a `current` symlink: the LINK is replaced, its old target survives
    fx.put("v1/cfg", "v1");
    fx.put("v2/cfg", "v2");
    fx.link("v1", "current");
    fx.link("v2", "next");
    let link_etag = fx
        .ops
        .stat(&args(json!({ "paths": [fx.p("current")] })), &fx.cancel)
        .unwrap()
        .entries[0]
        .etag
        .clone()
        .unwrap();
    fx.ops
        .rename(&args(json!({ "from": fx.p("next"), "to": fx.p("current"), "overwrite": true, "expectedEtag": link_etag })), &fx.cancel)
        .unwrap();
    assert_eq!(fx.get("current/cfg"), "v2");
    assert_eq!(fx.get("v1/cfg"), "v1");
    // a directory destination is never overwritten
    fx.put("dst/x", "x");
    fx.put("src", "s");
    let r = fx.ops.rename(&args(json!({ "from": fx.p("src"), "to": fx.p("dst"), "overwrite": true, "expectedEtag": "h:x" })), &fx.cancel);
    assert_eq!(code(r), ErrorCode::Exists);
}

#[test]
fn rename_source_etag_is_checked_when_given() {
    let fx = Fx::new();
    fx.put("a", "1");
    let err = fx.ops.rename(
        &args(json!({ "from": fx.p("a"), "to": fx.p("b"), "expectedEtag": "h:stale" })),
        &fx.cancel,
    );
    assert_eq!(code(err), ErrorCode::Conflict);
    fx.ops
        .rename(
            &args(json!({ "from": fx.p("a"), "to": fx.p("b"), "expectedEtag": fx.etag("a") })),
            &fx.cancel,
        )
        .unwrap();
}

#[test]
fn rename_across_filesystems_is_exdev_with_no_copy_fallback() {
    use std::os::unix::fs::MetadataExt;
    let fx = Fx::new();
    // A second filesystem outside the special trees: the user runtime dir (tmpfs).
    let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from) else {
        return;
    };
    let same_fs = std::fs::metadata(&runtime).map(|m| m.dev()).ok()
        == std::fs::metadata(&fx.root).map(|m| m.dev()).ok();
    if same_fs || std::fs::metadata(&runtime).is_err() {
        return;
    }
    let dest = runtime.join(format!("wsmp-exdev-{}", std::process::id()));
    fx.put("f", "x");
    let r = fx.ops.rename(
        &args(json!({ "from": fx.p("f"), "to": dest.to_string_lossy() })),
        &fx.cancel,
    );
    let _ = std::fs::remove_file(&dest);
    let err = r.unwrap_err();
    assert_eq!(
        (err.code, err.message.as_str()),
        (ErrorCode::IoError, "EXDEV")
    );
    assert!(
        fx.root.join("f").exists(),
        "no copy fallback: the source stays"
    );
}

#[test]
fn mkdir_created_flag_parents_and_mode() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fx::new();
    let r = fx
        .ops
        .dir_create(&args(json!({ "path": fx.p("a/b/c") })), &fx.cancel)
        .unwrap();
    assert!(r.created && fx.root.join("a/b/c").is_dir());
    assert!(
        !fx.ops
            .dir_create(&args(json!({ "path": fx.p("a/b/c") })), &fx.cancel)
            .unwrap()
            .created
    );
    assert_eq!(
        code(fx.ops.dir_create(
            &args(json!({ "path": fx.p("x/y"), "parents": false })),
            &fx.cancel
        )),
        ErrorCode::NotFound
    );
    assert!(!fx.root.join("x").exists());
    fx.ops
        .dir_create(
            &args(json!({ "path": fx.p("private"), "mode": "0700" })),
            &fx.cancel,
        )
        .unwrap();
    let mask = nix::sys::stat::umask(nix::sys::stat::Mode::empty());
    nix::sys::stat::umask(mask);
    assert_eq!(
        std::fs::metadata(fx.root.join("private"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700 & !(mask.bits() as u32)
    );
    fx.put("file", "x");
    assert_eq!(
        code(
            fx.ops
                .dir_create(&args(json!({ "path": fx.p("file") })), &fx.cancel)
        ),
        ErrorCode::Exists
    );
    assert_eq!(
        code(fx.ops.dir_create(
            &args(json!({ "path": fx.p("m"), "mode": "4755" })),
            &fx.cancel
        )),
        ErrorCode::InvalidInput
    );
    // a failed nested create rolls back what it made
    assert_eq!(
        code(fx.ops.dir_create(
            &args(json!({ "path": fx.p("file/inner/deeper") })),
            &fx.cancel
        )),
        ErrorCode::NotADir
    );
}

#[test]
fn delete_files_symlinks_and_empty_dirs_only() {
    let fx = Fx::new();
    fx.put("f", "x");
    fx.put("target", "keep");
    fx.link("target", "link");
    std::fs::create_dir(fx.root.join("empty")).unwrap();
    fx.put("full/x", "x");
    let del = |p: &str, etag: Option<&str>| {
        let mut a = json!({ "path": fx.p(p) });
        if let Some(e) = etag {
            a["expectedEtag"] = json!(e);
        }
        fx.ops.delete(&args(a), &fx.cancel)
    };
    assert_eq!(del("f", None).unwrap().kind, "file");
    assert_eq!(del("link", None).unwrap().kind, "symlink");
    assert_eq!(fx.get("target"), "keep", "the link target is never deleted");
    assert_eq!(del("empty", None).unwrap().kind, "dir");
    assert_eq!(
        code(del("full", None)),
        ErrorCode::IoError,
        "no recursive delete"
    );
    assert!(fx.root.join("full/x").exists());
    assert_eq!(code(del("missing", None)), ErrorCode::NotFound);
    assert_eq!(
        code(fx.ops.delete(&args(json!({ "path": "/" })), &fx.cancel)),
        ErrorCode::InvalidInput
    );
    // etag guard
    assert_eq!(code(del("target", Some("h:stale"))), ErrorCode::Conflict);
    assert!(fx.root.join("target").exists());
    del("target", Some(&fx.etag("target"))).unwrap();
    assert!(!fx.root.join("target").exists());
}

/// Delete re-checks the name against the inspected inode after its etag check:
/// a file swapped for another one in that window must be a conflict, not the
/// silently deleted successor.
#[test]
fn delete_refuses_when_the_name_was_swapped_after_the_inspection() {
    let root_cell = Arc::new(std::sync::OnceLock::<std::path::PathBuf>::new());
    let cell = Arc::clone(&root_cell);
    let swapped = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&swapped);
    let fx = Fx::new().with_hook(move |step| {
        if step == super::super::Step::EtagRechecked && !flag.swap(true, Ordering::SeqCst) {
            let root = cell.get().unwrap();
            std::fs::write(root.join("intruder"), "intruder\n").unwrap();
            std::fs::rename(root.join("intruder"), root.join("f.txt")).unwrap();
        }
        Ok(())
    });
    root_cell.set(fx.root.clone()).unwrap();
    fx.put("f.txt", "original\n");
    let etag = fx.etag("f.txt");
    let result = fx.ops.delete(
        &args(json!({ "path": fx.p("f.txt"), "expectedEtag": etag })),
        &fx.cancel,
    );
    assert_eq!(code(result), ErrorCode::Conflict);
    assert_eq!(fx.get("f.txt"), "intruder\n", "the successor survives");
    assert!(swapped.load(Ordering::SeqCst), "the hook did not fire");
}

/// Without an `expectedEtag` the same swap is still caught by the final
/// same-object re-check.
#[test]
fn delete_without_an_etag_still_rechecks_the_object() {
    let root_cell = Arc::new(std::sync::OnceLock::<std::path::PathBuf>::new());
    let cell = Arc::clone(&root_cell);
    let swapped = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&swapped);
    let fx = Fx::new().with_hook(move |step| {
        if step == super::super::Step::EtagRechecked && !flag.swap(true, Ordering::SeqCst) {
            let root = cell.get().unwrap();
            std::fs::write(root.join("intruder"), "intruder\n").unwrap();
            std::fs::rename(root.join("intruder"), root.join("f.txt")).unwrap();
        }
        Ok(())
    });
    root_cell.set(fx.root.clone()).unwrap();
    fx.put("f.txt", "original\n");
    let result = fx
        .ops
        .delete(&args(json!({ "path": fx.p("f.txt") })), &fx.cancel);
    assert_eq!(code(result), ErrorCode::Conflict);
    assert_eq!(fx.get("f.txt"), "intruder\n");
}

/// A hostile file name cannot forge a second result line: control characters in
/// emitted names are shown as `\u{..}` escapes in both `search` and `dir_list`.
#[test]
fn hostile_names_cannot_forge_extra_output_lines() {
    let fx = Fx::new();
    let hostile = "note:1|injected\nsecond.txt";
    fx.put(&format!("d/{hostile}"), "needle\n");
    let found = search(&fx, json!({ "root": fx.p("d"), "pattern": "needle" }));
    assert_eq!(found.count, 1, "{:?}", found.matches);
    assert_eq!(found.matches.lines().count(), 1, "{:?}", found.matches);
    assert!(found.matches.contains("\\u{a}"), "{:?}", found.matches);
    let listed = list(&fx, json!({ "path": fx.p("d") }));
    assert_eq!(listed.count, 1);
    assert!(listed.entries.contains("\\u{a}"), "{:?}", listed.entries);
    assert!(!listed.entries.contains('\n'), "{:?}", listed.entries);
    // the file is still found through its real name (escaping is display-only)
    let exact = search(
        &fx,
        json!({ "root": fx.p("d"), "pattern": "needle", "glob": "*.txt" }),
    );
    assert_eq!(exact.count, 1);
}
