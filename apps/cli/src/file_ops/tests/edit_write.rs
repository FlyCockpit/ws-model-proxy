//! `file_edit`, `file_write` and the atomic replace sequence.

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier};

use serde_json::{Value, json};

use super::super::edit::EditResult;
use super::super::policy::Policy;
use super::super::{ErrorCode, FileResult, Step};
use super::{Fx, args, code, real_uid};

fn edit(fx: &Fx, path: &str, etag: Option<&str>, edits: Value) -> FileResult<EditResult> {
    let mut a = json!({ "path": fx.p(path), "edits": edits });
    if let Some(etag) = etag {
        a["expectedEtag"] = json!(etag);
    }
    fx.ops.edit(&args(a), &fx.cancel)
}

fn edit_err(fx: &Fx, path: &str, edits: Value) -> super::super::FileError {
    edit(fx, path, None, edits).unwrap_err()
}

const CONFIG: &str = "a: 1\nctx: --ctx-size 32768 \\\n  --port 1\nb: 2\nc: 3\n";

#[test]
fn exact_edit_returns_etag_and_compact_diff() {
    let fx = Fx::new();
    fx.put("c.yaml", CONFIG);
    let etag = fx.etag("c.yaml");
    let r = edit(
        &fx,
        "c.yaml",
        Some(&etag),
        json!([{ "oldText": "--ctx-size 32768", "newText": "--ctx-size 65536" }]),
    )
    .unwrap();
    assert!(r.applied);
    assert_eq!(r.previous_etag, etag);
    assert_ne!(r.etag, etag);
    assert_eq!(
        r.etag,
        fx.etag("c.yaml"),
        "returned etag is the new file's etag"
    );
    assert_eq!((r.added, r.removed), (1, 1));
    assert_eq!(
        r.diff.as_deref(),
        Some(
            "@@ -1,3 +1,3 @@\n a: 1\n-ctx: --ctx-size 32768 \\\n+ctx: --ctx-size 65536 \\\n   --port 1\n"
        )
    );
    assert_eq!(fx.get("c.yaml"), CONFIG.replace("32768", "65536"));
}

#[test]
fn match_count_table() {
    let fx = Fx::new();
    fx.put("m.txt", "x\ny\nx\nz\nx\n");
    let ok_all = edit(
        &fx,
        "m.txt",
        None,
        json!([{ "oldText": "x", "newText": "X", "expectedMatches": "all" }]),
    )
    .unwrap();
    assert_eq!(ok_all.added, 3);
    assert_eq!(fx.get("m.txt"), "X\ny\nX\nz\nX\n");
    fx.put("m.txt", "x\ny\nx\nz\nx\n");
    let rows: [(Value, ErrorCode); 6] = [
        (
            json!({ "oldText": "x", "newText": "X" }),
            ErrorCode::MatchCount,
        ),
        (
            json!({ "oldText": "x", "newText": "X", "expectedMatches": 2 }),
            ErrorCode::MatchCount,
        ),
        (
            json!({ "oldText": "nope", "newText": "X" }),
            ErrorCode::NoMatch,
        ),
        (
            json!({ "oldText": "nope", "newText": "X", "expectedMatches": "all" }),
            ErrorCode::NoMatch,
        ),
        (
            json!({ "oldText": "x", "newText": "X", "expectedMatches": 0 }),
            ErrorCode::InvalidInput,
        ),
        (
            json!({ "oldText": "x", "newText": "X", "expectedMatches": "some" }),
            ErrorCode::InvalidInput,
        ),
    ];
    for (row, expected) in rows {
        assert_eq!(
            edit_err(&fx, "m.txt", json!([row.clone()])).code,
            expected,
            "{row}"
        );
    }
    assert_eq!(fx.get("m.txt"), "x\ny\nx\nz\nx\n");
    let err = edit_err(&fx, "m.txt", json!([{ "oldText": "x", "newText": "X" }]));
    assert_eq!(
        err.detail.unwrap(),
        json!({ "edit": 0, "expected": 1, "found": 3, "lines": [1, 3, 5] })
    );
    let none = edit_err(&fx, "m.txt", json!([{ "oldText": "zz", "newText": "X" }]));
    assert_eq!(none.detail.unwrap()["nearestLine"], 4);
    assert_eq!(
        edit_err(&fx, "m.txt", json!([{ "oldText": "", "newText": "X" }])).code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn lines_reported_by_match_count_are_capped_at_five() {
    let fx = Fx::new();
    fx.put("m.txt", "x\n".repeat(20));
    let err = edit_err(&fx, "m.txt", json!([{ "oldText": "x", "newText": "X" }]));
    assert_eq!(err.detail.unwrap()["lines"], json!([1, 2, 3, 4, 5]));
}

#[test]
fn edits_are_evaluated_against_the_original_and_all_or_nothing() {
    let fx = Fx::new();
    let body = "l1\nl2\nl3\nl4\nl5\nl6\n";
    fx.put("f.txt", body);
    let etag = fx.etag("f.txt");
    // line-range addresses ORIGINAL numbering even after an earlier edit grew the file
    let r = edit(
        &fx,
        "f.txt",
        Some(&etag),
        json!([
            { "oldText": "l1", "newText": "l1a\nl1b\nl1c" },
            { "startLine": 4, "endLine": 5, "newText": "MID\n" },
            { "oldText": "l6", "newText": "END" }
        ]),
    )
    .unwrap();
    assert!(r.applied);
    assert_eq!(fx.get("f.txt"), "l1a\nl1b\nl1c\nl2\nl3\nMID\nEND\n");
    // a failing third edit leaves the file untouched and no temp file behind
    fx.put("f.txt", body);
    let etag = fx.etag("f.txt");
    let err = edit(
        &fx,
        "f.txt",
        Some(&etag),
        json!([{ "oldText": "l1", "newText": "A" }, { "oldText": "l2", "newText": "B" }, { "oldText": "missing", "newText": "C" }]),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::NoMatch);
    assert_eq!(fx.get("f.txt"), body);
    assert!(fx.leftovers("").is_empty());
}

#[test]
fn overlapping_and_malformed_edits_are_refused() {
    let fx = Fx::new();
    fx.put("f.txt", "aaa\nbbb\nccc\n");
    let etag = fx.etag("f.txt");
    let rows: Vec<(Value, ErrorCode)> = vec![
        (
            json!([{ "oldText": "aaa\nbbb", "newText": "x" }, { "oldText": "bbb", "newText": "y" }]),
            ErrorCode::InvalidInput,
        ),
        (
            json!([{ "startLine": 1, "endLine": 2, "newText": "x\n" }, { "startLine": 2, "endLine": 3, "newText": "y\n" }]),
            ErrorCode::InvalidInput,
        ),
        (
            json!([{ "oldText": "aaa", "newText": "x" }, { "startLine": 1, "endLine": 1, "newText": "y\n" }]),
            ErrorCode::InvalidInput,
        ),
        (
            json!([{ "startLine": 2, "endLine": 1, "newText": "i\n" }, { "startLine": 2, "endLine": 1, "newText": "j\n" }]),
            ErrorCode::InvalidInput,
        ),
        (json!([{ "newText": "x" }]), ErrorCode::InvalidInput),
        (
            json!([{ "oldText": "a", "startLine": 1, "endLine": 1, "newText": "x" }]),
            ErrorCode::InvalidInput,
        ),
        (
            json!([{ "startLine": 1, "newText": "x" }]),
            ErrorCode::InvalidInput,
        ),
        (
            json!([{ "startLine": 0, "endLine": 1, "newText": "x" }]),
            ErrorCode::InvalidInput,
        ),
        (
            json!([{ "startLine": 1, "endLine": 4, "newText": "x" }]),
            ErrorCode::InvalidInput,
        ),
        (
            json!([{ "startLine": 5, "endLine": 5, "newText": "x" }]),
            ErrorCode::InvalidInput,
        ),
        (json!([]), ErrorCode::InvalidInput),
    ];
    for (row, expected) in rows {
        assert_eq!(
            edit(&fx, "f.txt", Some(&etag), row.clone())
                .unwrap_err()
                .code,
            expected,
            "{row}"
        );
    }
    let too_many: Vec<Value> = (0..21)
        .map(|_| json!({ "oldText": "a", "newText": "b" }))
        .collect();
    assert_eq!(
        edit(&fx, "f.txt", Some(&etag), json!(too_many))
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    assert_eq!(fx.get("f.txt"), "aaa\nbbb\nccc\n");
}

#[test]
fn line_range_insertion_and_append_position() {
    let fx = Fx::new();
    fx.put("f.txt", "a\nb\n");
    let etag = fx.etag("f.txt");
    edit(&fx, "f.txt", Some(&etag), json!([{ "startLine": 2, "endLine": 1, "newText": "new\n" }, { "startLine": 3, "endLine": 2, "newText": "tail\n" }])).unwrap();
    assert_eq!(fx.get("f.txt"), "a\nnew\nb\ntail\n");
}

#[test]
fn expected_etag_rules_and_conflict() {
    let fx = Fx::new();
    fx.put("f.txt", "a\nb\n");
    // line ranges require the etag
    assert_eq!(
        edit(
            &fx,
            "f.txt",
            None,
            json!([{ "startLine": 1, "endLine": 1, "newText": "x\n" }])
        )
        .unwrap_err()
        .code,
        ErrorCode::InvalidInput
    );
    // exact edits work without one
    assert!(
        edit(
            &fx,
            "f.txt",
            None,
            json!([{ "oldText": "a", "newText": "A" }])
        )
        .unwrap()
        .applied
    );
    // a stale etag is a conflict that carries the current one
    let err = edit(
        &fx,
        "f.txt",
        Some("h:stale"),
        json!([{ "oldText": "A", "newText": "B" }]),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.detail.unwrap()["currentEtag"], fx.etag("f.txt"));
    assert_eq!(fx.get("f.txt"), "A\nb\n");
}

#[test]
fn dry_run_and_return_diff_false() {
    let fx = Fx::new();
    fx.put("f.txt", "a\nb\nc\n");
    let etag = fx.etag("f.txt");
    let dry = fx.ops.edit(&args(json!({ "path": fx.p("f.txt"), "edits": [{ "oldText": "b", "newText": "B" }], "dryRun": true })), &fx.cancel).unwrap();
    assert!(!dry.applied);
    assert_eq!(dry.etag, etag);
    assert!(dry.diff.unwrap().contains("+B"));
    assert_eq!(fx.get("f.txt"), "a\nb\nc\n");
    let quiet = fx.ops.edit(&args(json!({ "path": fx.p("f.txt"), "edits": [{ "oldText": "b", "newText": "B" }], "returnDiff": false })), &fx.cancel).unwrap();
    assert_eq!((quiet.diff, quiet.hunks), (None, Some(vec![[1, 3]])));
    let noop = edit(
        &fx,
        "f.txt",
        None,
        json!([{ "oldText": "B", "newText": "B" }]),
    )
    .unwrap();
    assert!(!noop.applied && noop.added == 0);
}

#[test]
fn eol_handling_crlf_translation_and_mixed_files() {
    let fx = Fx::new();
    fx.put("crlf.txt", "one\r\ntwo\r\nthree\r\n");
    edit(
        &fx,
        "crlf.txt",
        None,
        json!([{ "oldText": "one\ntwo", "newText": "1\n2\n2b" }]),
    )
    .unwrap();
    assert_eq!(fx.get("crlf.txt"), "1\r\n2\r\n2b\r\nthree\r\n");
    fx.put("mixed.txt", "one\r\ntwo\nthree\n");
    // mixed files match bytes exactly: a bare-LF pattern spanning a CRLF does not match
    assert_eq!(
        edit_err(
            &fx,
            "mixed.txt",
            json!([{ "oldText": "one\ntwo", "newText": "x" }])
        )
        .code,
        ErrorCode::NoMatch
    );
    edit(
        &fx,
        "mixed.txt",
        None,
        json!([{ "oldText": "two\nthree", "newText": "x" }]),
    )
    .unwrap();
    assert_eq!(fx.get("mixed.txt"), "one\r\nx\n");
}

#[test]
fn binary_and_oversized_files_are_refused() {
    let fx = Fx::new();
    fx.put("b.bin", b"GGUF\x03\0\0\0");
    assert_eq!(
        edit_err(&fx, "b.bin", json!([{ "oldText": "GGUF", "newText": "x" }])).code,
        ErrorCode::BinaryFile
    );
    fx.put("latin1.txt", b"na\xc3\xafve cuv\xe9e\n");
    assert_eq!(
        edit_err(
            &fx,
            "latin1.txt",
            json!([{ "oldText": "cuv\u{e9}e", "newText": "x" }])
        )
        .code,
        ErrorCode::BinaryFile
    );
    assert_eq!(
        fx.ops
            .read(&args(json!({ "path": fx.p("latin1.txt") })), &fx.cancel)
            .unwrap_err()
            .code,
        ErrorCode::BinaryFile
    );
    fx.put("big.txt", "y".repeat(17 * 1024 * 1024));
    assert_eq!(
        edit_err(
            &fx,
            "big.txt",
            json!([{ "oldText": "y", "newText": "z", "expectedMatches": "all" }])
        )
        .code,
        ErrorCode::TooLarge
    );
    fx.put("grow.txt", "y".repeat(100_000));
    let grow = json!([{ "oldText": "y", "newText": "z".repeat(200), "expectedMatches": "all" }]);
    assert_eq!(edit_err(&fx, "grow.txt", grow).code, ErrorCode::TooLarge);
    // more matches than the per-edit cap is a match_count error, not a huge plan
    fx.put("many.txt", "y".repeat(100_001));
    let many = json!([{ "oldText": "y", "newText": "z", "expectedMatches": "all" }]);
    assert_eq!(edit_err(&fx, "many.txt", many).code, ErrorCode::MatchCount);
}

#[test]
fn masked_spans_cannot_be_targeted_and_cannot_be_probed() {
    // an ordinary file with a secret-named assignment (secret-class files are
    // read-only: see `secret_class_paths_are_read_only_for_every_mutating_tool`)
    let fx = Fx::new();
    fx.put(
        "run.conf",
        "PORT=8080\nHF_TOKEN=hunter2secret\nMODEL=qwen\n# note\n",
    );
    let etag = fx.etag("run.conf");
    // touching the secret value is refused ...
    let refused = edit_err(
        &fx,
        "run.conf",
        json!([{ "oldText": "⟦redacted line⟧", "newText": "x", "expectedMatches": "all" }]),
    )
    .code;
    assert!(matches!(refused, ErrorCode::RedactedSpan), "{refused:?}");
    // the marker does not echo the name: the token is not in the view at all
    assert_eq!(
        edit_err(
            &fx,
            "run.conf",
            json!([{ "oldText": "HF_TOKEN", "newText": "x" }])
        )
        .code,
        ErrorCode::NoMatch
    );
    // ... but the match is on the MASKED view, so guessing the secret finds nothing:
    // no oracle for the real value.
    for guess in ["hunter2", "HF_TOKEN=hunter2secret", "secret"] {
        assert_eq!(
            edit_err(
                &fx,
                "run.conf",
                json!([{ "oldText": guess, "newText": "x" }])
            )
            .code,
            ErrorCode::NoMatch,
            "{guess}"
        );
    }
    // Both the token line and its following line are protected, including dry runs.
    for line in [2, 3] {
        for dry in [true, false] {
            let over = fx.ops.edit(
                &args(json!({ "path": fx.p("run.conf"), "expectedEtag": etag,
                    "edits": [{ "startLine": line, "endLine": line, "newText": "replacement\n" }],
                    "dryRun": dry })),
                &fx.cancel,
            );
            assert_eq!(code(over), ErrorCode::RedactedSpan);
        }
    }
    let r = edit(
        &fx,
        "run.conf",
        Some(&etag),
        json!([{ "startLine": 4, "endLine": 4, "newText": "# note2\n" }]),
    )
    .unwrap();
    assert_eq!(
        fx.get("run.conf"),
        "PORT=8080\nHF_TOKEN=hunter2secret\nMODEL=qwen\n# note2\n"
    );
    // the diff of an edit never carries the secret (it is masked like a read)
    let diff = r.diff.unwrap();
    assert!(!diff.contains("hunter2"), "{diff}");
    // writing a mask token back is refused
    assert_eq!(
        edit_err(
            &fx,
            "run.conf",
            json!([{ "oldText": "note2", "newText": "\u{27E6}redacted:3\u{27E7}" }])
        )
        .code,
        ErrorCode::RedactedSpan
    );
    // plain files: exact edits before a masked span keep the secret bytes intact
    fx.put("run.sh", "A=1\nexport X_API_KEY=\"pw with space\"\nB=2\n");
    edit(
        &fx,
        "run.sh",
        None,
        json!([{ "oldText": "A=1", "newText": "A=10" }]),
    )
    .unwrap();
    assert_eq!(
        fx.get("run.sh"),
        "A=10\nexport X_API_KEY=\"pw with space\"\nB=2\n"
    );
}

#[test]
fn an_edit_that_changes_the_masking_context_cannot_unmask_a_value() {
    // Editing a marker is refused, as are insertions that would expose surviving
    // masked bytes. Both actual edits and dry runs enforce the same invariant.
    let fx = Fx::new();
    fx.put(
        "cfg.yaml",
        "API_KEY: plainsecret-value\nnext: masked\nother: 1\n",
    );
    fx.put("multi.txt", "X_TOKEN=\"line1\nline2-multisecret\"\ntail\n");
    let cases: [(&str, serde_json::Value); 2] = [
        (
            "cfg.yaml",
            json!([{ "oldText": "⟦redacted line⟧", "newText": "x", "expectedMatches": "all" }]),
        ),
        (
            "multi.txt",
            json!([{ "oldText": "⟦redacted line⟧", "newText": "x", "expectedMatches": "all" }]),
        ),
    ];
    for (file, edits) in cases {
        for dry in [true, false] {
            let r = fx.ops.edit(
                &args(json!({ "path": fx.p(file), "edits": edits, "dryRun": dry })),
                &fx.cancel,
            );
            assert_eq!(code(r), ErrorCode::RedactedSpan, "{file} {edits} dry={dry}");
        }
    }
    // a blank line inserted inside a multi-line value would end its masking: refused too
    let etag = fx.etag("multi.txt");
    let r = edit(
        &fx,
        "multi.txt",
        Some(&etag),
        json!([{ "startLine": 2, "endLine": 1, "newText": "\n" }]),
    );
    assert_eq!(code(r), ErrorCode::RedactedSpan);
    assert_eq!(
        fx.get("cfg.yaml"),
        "API_KEY: plainsecret-value\nnext: masked\nother: 1\n"
    );
    // an edit elsewhere in the file is fine
    edit(
        &fx,
        "cfg.yaml",
        None,
        json!([{ "oldText": "other: 1", "newText": "other: 2" }]),
    )
    .unwrap();
}

#[test]
fn secret_class_paths_are_read_only_for_every_mutating_tool() {
    let fx = Fx::new();
    let key = format!(
        "-----BEGIN {}-----\nAAAA\n-----END {}-----\n",
        "PRIVATE KEY", "PRIVATE KEY"
    );
    fx.put(".env", "A=1\n");
    fx.put("ID_RSA", key);
    fx.put(".ssh/known", "h\n");
    fx.put("notes.txt", "n\n");
    let paths = [".env", "ID_RSA", ".ssh/known", ".ssh/new"];
    for path in paths {
        for (op, value) in [
            (
                "write",
                json!({ "path": fx.p(path), "content": "x", "ifExists": "replace", "expectedEtag": "h:x" }),
            ),
            (
                "edit",
                json!({ "path": fx.p(path), "edits": [{ "oldText": "A", "newText": "B" }], "dryRun": true }),
            ),
            ("delete", json!({ "path": fx.p(path) })),
            (
                "mkdir",
                json!({ "path": fx.p(&format!("{path}.d")), "parents": true }),
            ),
        ] {
            if op == "mkdir" && !path.starts_with(".ssh") && path != ".env" && path != "ID_RSA" {
                continue;
            }
            let r = fx.ops.execute(op, value, &fx.cancel);
            let err = r.expect_err(&format!("{op} {path}"));
            // a refusal, never a lookup: the path is judged before it is opened
            assert_eq!(err.code, ErrorCode::SecretFile, "{op} {path}: {err:?}");
        }
        // moving a secret path away, or anything onto a secret path
        for (from, to) in [(path, "moved.txt"), ("notes.txt", path)] {
            let r = fx.ops.execute(
                "rename",
                json!({ "from": fx.p(from), "to": fx.p(to) }),
                &fx.cancel,
            );
            let err = r.expect_err(&format!("rename {from} -> {to}"));
            assert_eq!(
                err.code,
                ErrorCode::SecretFile,
                "rename {from} -> {to}: {err:?}"
            );
        }
    }
    // the directory that gives a token file its class cannot be moved either
    fx.put(".cache/huggingface/token", "hf_x\n");
    for (from, to) in [
        (".cache", "cache2"),
        (".ssh", "ssh2"),
        (".cache/huggingface", ".cache/hf"),
    ] {
        let r = fx.ops.execute(
            "rename",
            json!({ "from": fx.p(from), "to": fx.p(to) }),
            &fx.cancel,
        );
        assert_eq!(code(r), ErrorCode::SecretFile, "{from}");
    }
    // everything is untouched, and still readable through the masked view
    assert_eq!(fx.get(".env"), "A=1\n");
    assert!(fx.root.join(".cache/huggingface/token").exists());
    assert!(
        fx.read(".env")
            .text
            .contains("A=\u{27E6}redacted:1\u{27E7}")
    );
    // ordinary files are unaffected
    fx.ops
        .execute(
            "rename",
            json!({ "from": fx.p("notes.txt"), "to": fx.p("notes2.txt") }),
            &fx.cancel,
        )
        .unwrap();
}

#[test]
fn ssh_key_files_cannot_be_edited_at_all() {
    let fx = Fx::new();
    let begin = format!("-----BEGIN {}-----", ["PRIVATE", "KEY"].join(" "));
    let end = format!("-----END {}-----", ["PRIVATE", "KEY"].join(" "));
    fx.put("id_rsa", format!("{begin}\nAAAA\n{end}\n"));
    let code = edit_err(&fx, "id_rsa", json!([{ "oldText": begin, "newText": "x" }])).code;
    assert_eq!(code, ErrorCode::SecretFile);
    let etag = fx.etag("id_rsa");
    assert_eq!(
        edit(
            &fx,
            "id_rsa",
            Some(&etag),
            json!([{ "startLine": 2, "endLine": 2, "newText": "" }])
        )
        .unwrap_err()
        .code,
        ErrorCode::SecretFile
    );
}

// ---- atomic replace -------------------------------------------------------

#[cfg(any(target_os = "linux", target_os = "macos"))]
const ORDER: [Step; 11] = [
    Step::TempCreated,
    Step::TempWritten,
    Step::TempSynced,
    Step::Chowned,
    Step::Chmodded,
    Step::EtagRechecked,
    Step::Exchanged,
    Step::Captured,
    Step::Disposing,
    Step::Renamed,
    Step::DirSynced,
];

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
const ORDER: [Step; 8] = [
    Step::TempCreated,
    Step::TempWritten,
    Step::TempSynced,
    Step::Chowned,
    Step::Chmodded,
    Step::EtagRechecked,
    Step::Renamed,
    Step::DirSynced,
];

#[test]
fn replace_sequence_order_mode_owner_and_dir_fsync() {
    let fx = Fx::new();
    let path = fx.put("f.sh", "#!/bin/sh\necho old\n");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o750)).unwrap();
    let before = std::fs::metadata(&path).unwrap();
    edit(
        &fx,
        "f.sh",
        None,
        json!([{ "oldText": "old", "newText": "new" }]),
    )
    .unwrap();
    assert_eq!(
        *fx.steps.lock().unwrap(),
        ORDER,
        "fchown must precede fchmod; parent fsync last"
    );
    let after = std::fs::metadata(&path).unwrap();
    assert_eq!(after.permissions().mode() & 0o7777, 0o750);
    assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
    assert_ne!(
        after.ino(),
        before.ino(),
        "replaced by rename, not written in place"
    );
    assert!(fx.leftovers("").is_empty());
}

#[test]
fn every_failure_before_the_rename_leaves_the_original_and_no_temp() {
    for fail_at in [
        Step::TempCreated,
        Step::TempWritten,
        Step::TempSynced,
        Step::Chowned,
        Step::Chmodded,
        Step::EtagRechecked,
    ] {
        let fx = Fx::new().with_hook(move |step| {
            if step == fail_at {
                Err(super::super::FileError::new(
                    ErrorCode::IoError,
                    "EINJECTED",
                ))
            } else {
                Ok(())
            }
        });
        fx.put("f.txt", "original\n");
        let err = edit_err(
            &fx,
            "f.txt",
            json!([{ "oldText": "original", "newText": "changed" }]),
        );
        assert_eq!(err.message, "EINJECTED", "{fail_at:?}");
        assert_eq!(fx.get("f.txt"), "original\n", "{fail_at:?}");
        assert!(fx.leftovers("").is_empty(), "temp left after {fail_at:?}");
    }
}

#[test]
fn concurrent_in_place_write_between_read_and_commit_is_a_conflict() {
    let cell = Arc::new(std::sync::OnceLock::<std::path::PathBuf>::new());
    let c = Arc::clone(&cell);
    let fx = Fx::new().with_hook(move |step| {
        if step == Step::Chmodded {
            std::fs::write(c.get().unwrap(), "someone else wrote this\n").unwrap();
        }
        Ok(())
    });
    let path = fx.put("f.txt", "original\n");
    cell.set(path).unwrap();
    let err = edit_err(
        &fx,
        "f.txt",
        json!([{ "oldText": "original", "newText": "changed" }]),
    );
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(fx.get("f.txt"), "someone else wrote this\n");
    assert!(fx.leftovers("").is_empty());
}

#[test]
fn file_replaced_by_rename_before_commit_is_a_conflict() {
    let cell = Arc::new(std::sync::OnceLock::<std::path::PathBuf>::new());
    let c = Arc::clone(&cell);
    let fx = Fx::new().with_hook(move |step| {
        if step == Step::TempSynced {
            let root = c.get().unwrap();
            std::fs::write(root.join("intruder"), "intruder\n").unwrap();
            std::fs::rename(root.join("intruder"), root.join("f.txt")).unwrap();
        }
        Ok(())
    });
    cell.set(fx.root.clone()).unwrap();
    fx.put("f.txt", "original\n");
    let err = edit_err(
        &fx,
        "f.txt",
        json!([{ "oldText": "original", "newText": "changed" }]),
    );
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(fx.get("f.txt"), "intruder\n");
}

#[test]
fn cancel_is_honored_only_before_the_rename() {
    let flag = Arc::new(AtomicBool::new(false));
    let f = Arc::clone(&flag);
    let cancel_slot = Arc::new(std::sync::Mutex::new(None::<super::super::Cancel>));
    let slot = Arc::clone(&cancel_slot);
    let fx = Fx::new().with_hook(move |step| {
        if step == Step::EtagRechecked
            && f.load(Ordering::SeqCst)
            && let Some(cancel) = slot.lock().unwrap().as_ref()
        {
            cancel.cancel();
        }
        Ok(())
    });
    *cancel_slot.lock().unwrap() = Some(fx.cancel.clone());
    fx.put("f.txt", "original\n");
    flag.store(true, Ordering::SeqCst);
    let err = edit_err(
        &fx,
        "f.txt",
        json!([{ "oldText": "original", "newText": "changed" }]),
    );
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert_eq!(fx.get("f.txt"), "original\n");
    assert!(fx.leftovers("").is_empty());
    // after the rename a cancel changes nothing: the result reports committed
    let fx = Fx::new();
    fx.put("g.txt", "original\n");
    let ok = edit(
        &fx,
        "g.txt",
        None,
        json!([{ "oldText": "original", "newText": "changed" }]),
    )
    .unwrap();
    fx.cancel.cancel();
    assert!(ok.applied);
    assert_eq!(fx.get("g.txt"), "changed\n");
}

#[test]
fn owner_hardlink_and_setuid_refusals() {
    let fx = Fx::with_policy(|_| Policy::new(vec![], vec![], true).with_euid(real_uid() + 1));
    fx.put("f.txt", "x\n");
    assert_eq!(
        edit_err(&fx, "f.txt", json!([{ "oldText": "x", "newText": "y" }])).code,
        ErrorCode::OwnerMismatch
    );
    assert_eq!(fx.get("f.txt"), "x\n");

    let fx = Fx::new();
    fx.put("orig.txt", "x\n");
    std::fs::hard_link(fx.root.join("orig.txt"), fx.root.join("second.txt")).unwrap();
    assert_eq!(
        edit_err(&fx, "orig.txt", json!([{ "oldText": "x", "newText": "y" }])).code,
        ErrorCode::HardLinked
    );
    assert_eq!(fx.get("second.txt"), "x\n");
    assert!(fx.leftovers("").is_empty());

    for bits in [0o4755, 0o2755] {
        let path = fx.put("suid.sh", "x\n");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(bits)).unwrap();
        assert_eq!(
            edit_err(&fx, "suid.sh", json!([{ "oldText": "x", "newText": "y" }])).code,
            ErrorCode::Setuid,
            "{bits:o}"
        );
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn editing_through_a_symlink_edits_the_target_and_keeps_the_link() {
    let fx = Fx::new();
    fx.put("releases/v1/config.yaml", "a: 1\n");
    fx.link("releases/v1/config.yaml", "current.yaml");
    edit(
        &fx,
        "current.yaml",
        None,
        json!([{ "oldText": "a: 1", "newText": "a: 2" }]),
    )
    .unwrap();
    assert!(
        std::fs::symlink_metadata(fx.root.join("current.yaml"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fx.get("releases/v1/config.yaml"), "a: 2\n");
    assert!(fx.leftovers("releases/v1").is_empty() && fx.leftovers("").is_empty());
}

#[test]
fn the_temp_name_never_exceeds_name_max() {
    let fx = Fx::new();
    let name = "n".repeat(250);
    fx.put(&name, "x\n");
    edit(
        &fx,
        &name,
        None,
        json!([{ "oldText": "x", "newText": "y" }]),
    )
    .unwrap();
    assert_eq!(fx.get(&name), "y\n");
}

#[test]
fn per_path_lock_serializes_concurrent_edits() {
    let fx = Arc::new(Fx::new());
    fx.put("c.txt", "count: 0\n");
    let etag = fx.etag("c.txt");
    let barrier = Arc::new(Barrier::new(6));
    let handles: Vec<_> = (0..6)
        .map(|i| {
            let (fx, barrier, etag) = (Arc::clone(&fx), Arc::clone(&barrier), etag.clone());
            std::thread::spawn(move || {
                barrier.wait();
                edit(
                    &fx,
                    "c.txt",
                    Some(&etag),
                    json!([{ "oldText": "count: 0", "newText": format!("count: {}", i + 1) }]),
                )
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let winners = results.iter().filter(|r| r.is_ok()).count();
    assert_eq!(winners, 1, "exactly one writer wins the etag");
    for r in results.iter().filter_map(|r| r.as_ref().err()) {
        assert_eq!(r.code, ErrorCode::Conflict);
    }
    assert!(fx.leftovers("").is_empty());
}

// ---- file_write -----------------------------------------------------------

fn write(fx: &Fx, value: Value) -> FileResult<super::super::write::WriteResult> {
    fx.ops.write(&args(value), &fx.cancel)
}

#[test]
fn create_uses_exclusive_create_with_mode_and_default() {
    let fx = Fx::new();
    let r = write(&fx, json!({ "path": fx.p("deploy/run.sh"), "content": "#!/bin/sh\n", "mode": "0755", "makeParents": true })).unwrap();
    assert!(r.created);
    assert_eq!(r.size, 10);
    assert_eq!(
        std::fs::metadata(fx.root.join("deploy/run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755 & !current_umask()
    );
    assert_eq!(r.etag, fx.etag("deploy/run.sh"));
    // default mode 0644 (after umask)
    write(&fx, json!({ "path": fx.p("plain.txt"), "content": "x" })).unwrap();
    assert_eq!(
        std::fs::metadata(fx.root.join("plain.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644 & !current_umask()
    );
    // exists
    assert_eq!(
        code(write(
            &fx,
            json!({ "path": fx.p("plain.txt"), "content": "y" })
        )),
        ErrorCode::Exists
    );
    assert_eq!(fx.get("plain.txt"), "x");
    // parents are not created unless asked
    assert_eq!(
        code(write(
            &fx,
            json!({ "path": fx.p("no/parent/f"), "content": "y" })
        )),
        ErrorCode::NotFound
    );
    assert!(!fx.root.join("no").exists());
}

fn current_umask() -> u32 {
    let mask = nix::sys::stat::umask(nix::sys::stat::Mode::empty());
    nix::sys::stat::umask(mask);
    mask.bits() as u32
}

#[test]
fn create_through_a_dangling_symlink_creates_the_target_and_keeps_the_link() {
    let fx = Fx::new();
    fx.link("real/new.txt", "link.txt");
    std::fs::create_dir(fx.root.join("real")).unwrap();
    write(&fx, json!({ "path": fx.p("link.txt"), "content": "hi" })).unwrap();
    assert_eq!(fx.get("real/new.txt"), "hi");
    assert!(
        std::fs::symlink_metadata(fx.root.join("link.txt"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn write_validation_table() {
    let fx = Fx::new();
    fx.put("existing.txt", "old\n");
    let etag = fx.etag("existing.txt");
    let big = "x".repeat(1024 * 1024 + 1);
    let rows: Vec<(Value, ErrorCode)> = vec![
        (
            json!({ "path": fx.p("existing.txt"), "content": "n", "ifExists": "replace" }),
            ErrorCode::InvalidInput,
        ),
        (
            json!({ "path": fx.p("existing.txt"), "content": "n", "ifExists": "replace", "expectedEtag": "h:stale" }),
            ErrorCode::Conflict,
        ),
        (
            json!({ "path": fx.p("existing.txt"), "content": "n", "ifExists": "replace", "expectedEtag": etag, "mode": "0600" }),
            ErrorCode::InvalidInput,
        ),
        (
            json!({ "path": fx.p("new.txt"), "content": "n", "expectedEtag": etag }),
            ErrorCode::InvalidInput,
        ),
        (
            json!({ "path": fx.p("missing.txt"), "content": "n", "ifExists": "replace", "expectedEtag": etag }),
            ErrorCode::NotFound,
        ),
        (
            json!({ "path": fx.p("a.txt"), "content": big }),
            ErrorCode::TooLarge,
        ),
        (
            json!({ "path": fx.p("a.txt"), "content": "~~~", "encoding": "base64" }),
            ErrorCode::InvalidInput,
        ),
        (
            json!({ "path": fx.p("a.txt"), "content": "x", "mode": "4755" }),
            ErrorCode::InvalidInput,
        ),
        (
            json!({ "path": fx.p("a.txt"), "content": "x", "mode": "1777" }),
            ErrorCode::InvalidInput,
        ),
        (
            json!({ "path": fx.p("a.txt"), "content": "x", "mode": "rwx" }),
            ErrorCode::InvalidInput,
        ),
        (
            json!({ "path": fx.p("a.txt"), "content": "token \u{27E6}redacted:5\u{27E7}" }),
            ErrorCode::RedactedSpan,
        ),
        (
            json!({ "path": fx.p("a.txt"), "content": "4p+mcmVkYWN0ZWQ=", "encoding": "base64" }),
            ErrorCode::RedactedSpan,
        ),
        (
            json!({ "path": fx.root.to_string_lossy(), "content": "x", "ifExists": "replace", "expectedEtag": etag }),
            ErrorCode::NotAFile,
        ),
        (
            json!({ "path": fx.p("a.txt"), "content": "x", "reason": "r".repeat(501) }),
            ErrorCode::InvalidInput,
        ),
    ];
    for (row, expected) in rows {
        assert_eq!(code(write(&fx, row.clone())), expected, "{row}");
    }
    assert_eq!(fx.get("existing.txt"), "old\n");
    assert!(!fx.root.join("a.txt").exists());
}

#[test]
fn base64_creates_binary_content() {
    let fx = Fx::new();
    let r = write(
        &fx,
        json!({ "path": fx.p("blob.bin"), "content": "R0dVRgMAAAA=", "encoding": "base64" }),
    )
    .unwrap();
    assert_eq!(
        std::fs::read(fx.root.join("blob.bin")).unwrap(),
        b"GGUF\x03\0\0\0"
    );
    assert_eq!(r.size, 8);
}

#[test]
fn replace_with_etag_returns_diff_and_refuses_secret_files() {
    let fx = Fx::new();
    fx.put("c.txt", "a\nb\nc\n");
    let etag = fx.etag("c.txt");
    let r = write(&fx, json!({ "path": fx.p("c.txt"), "content": "a\nB\nc\n", "ifExists": "replace", "expectedEtag": etag, "returnDiff": true })).unwrap();
    assert!(!r.created);
    assert_eq!((r.added, r.removed), (Some(1), Some(1)));
    assert!(r.diff.unwrap().contains("+B"));
    assert_eq!(fx.get("c.txt"), "a\nB\nc\n");
    // no diff unless asked
    let etag = fx.etag("c.txt");
    let quiet = write(&fx, json!({ "path": fx.p("c.txt"), "content": "z\n", "ifExists": "replace", "expectedEtag": etag })).unwrap();
    assert_eq!(quiet.diff, None);
    // secret-class by name, and plain files that carry masked values
    fx.put("prod.env", "HF_TOKEN=abcdef\n");
    let etag = fx.etag("prod.env");
    assert_eq!(
        code(write(
            &fx,
            json!({ "path": fx.p("prod.env"), "content": "x=1\n", "ifExists": "replace", "expectedEtag": etag })
        )),
        ErrorCode::SecretFile
    );
    fx.put("launch.sh", "export API_KEY=abc\nrun\n");
    let etag = fx.etag("launch.sh");
    assert_eq!(
        code(write(
            &fx,
            json!({ "path": fx.p("launch.sh"), "content": "run\n", "ifExists": "replace", "expectedEtag": etag })
        )),
        ErrorCode::SecretFile
    );
    assert_eq!(fx.get("launch.sh"), "export API_KEY=abc\nrun\n");
}

#[test]
fn secret_class_files_without_masked_values_still_cannot_be_replaced() {
    let fx = Fx::new();
    // secret by NAME only: a certificate-only pem and a comment-only env file hold no masked span
    fx.put(
        "ca.pem",
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
    );
    fx.put("empty.env", "# nothing yet\n");
    for name in ["ca.pem", "empty.env"] {
        let etag = fx.etag(name);
        let r = write(
            &fx,
            json!({ "path": fx.p(name), "content": "x\n", "ifExists": "replace", "expectedEtag": etag }),
        );
        assert_eq!(code(r), ErrorCode::SecretFile, "{name}");
    }
}

#[test]
fn make_parents_is_rolled_back_when_the_write_fails() {
    let fx = Fx::new();
    let r = write(
        &fx,
        json!({ "path": fx.p("a/b/f.txt"), "content": "x", "ifExists": "replace", "expectedEtag": "h:x", "makeParents": true }),
    );
    assert_eq!(code(r), ErrorCode::NotFound);
    assert!(
        !fx.root.join("a").exists(),
        "directories created for a failed write must be removed"
    );
    // existing parents are never removed by a rollback
    std::fs::create_dir(fx.root.join("keep")).unwrap();
    let r = write(
        &fx,
        json!({ "path": fx.p("keep/x/f.txt"), "content": "x", "ifExists": "replace", "expectedEtag": "h:x", "makeParents": true }),
    );
    assert_eq!(code(r), ErrorCode::NotFound);
    assert!(fx.root.join("keep").is_dir() && !fx.root.join("keep/x").exists());
}

#[test]
fn write_replace_keeps_mode_and_uses_the_atomic_sequence() {
    let fx = Fx::new();
    let path = fx.put("s.sh", "old\n");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let etag = fx.etag("s.sh");
    write(&fx, json!({ "path": fx.p("s.sh"), "content": "new\n", "ifExists": "replace", "expectedEtag": etag })).unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
        0o700
    );
    assert_eq!(*fx.steps.lock().unwrap(), ORDER);
}
