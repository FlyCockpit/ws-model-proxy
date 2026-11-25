//! The order of a transaction's filesystem steps, pinned. Every scenario runs one
//! replace, exclusive create, rename or delete through the public file tools and
//! records one ordered log: the observable `Step`s, the primitive calls (`p`,
//! `Primitive` fault points, listed at the next step), and, as they happen, every
//! durable step (`d`): each fsync/fdatasync with the synced object, each INTENT
//! replacement with the phase it made durable, and each renameat(2), linkat,
//! unlinkat and mkdirat with its names. An LD_PRELOAD fixture
//! (`tests/fixtures/file_ops_trace_hook.c`) logs the `d` lines in a child run of
//! this executable, only during the operation itself. Then come the outcome and
//! the names left in the root. The
//! expected traces in `transaction_trace.golden` were recorded before the
//! transactions moved into `recovery`; a change to any step's order, or a step
//! added or dropped, fails here. Regenerate only for a deliberate change:
//! `WSMP_TRACE_BLESS=1 cargo test transaction_trace`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use nix::errno::Errno;
use serde_json::{Value, json};

use super::Fx;
use crate::services::file_ops::fs::exchange::{FaultScope, Primitive};
use crate::services::file_ops::{FileResult, Step};

const GOLDEN: &str = include_str!("transaction_trace.golden");

type Setup = fn(&Fx) -> Value;
type Race = fn(&Path);

struct Scenario {
    name: &'static str,
    /// Builds the files and returns the op's arguments (`op` names the tool).
    setup: Setup,
    before: &'static [(Primitive, usize, Errno)],
    after: &'static [(Primitive, usize, Errno)],
    /// Changes the world (or fails the step) when this step is reached.
    race: Option<(Step, Race, bool)>,
}

fn save(path: &Path, bytes: &str) {
    let incoming = path.with_file_name("racer-incoming");
    std::fs::write(&incoming, bytes).unwrap();
    std::fs::rename(incoming, path).unwrap();
}

fn edit(fx: &Fx) -> Value {
    fx.put("doc", "original\n");
    let etag = fx.etag("doc");
    json!({"op": "write", "args": {"path": fx.p("doc"), "expectedEtag": etag,
        "ifExists": "replace", "content": "edited\n"}})
}

fn create(fx: &Fx) -> Value {
    json!({"op": "write", "args": {"path": fx.p("doc"), "content": "created\n"}})
}

fn rename_plain(fx: &Fx) -> Value {
    fx.put("from", "source\n");
    json!({"op": "rename", "args": {"from": fx.p("from"), "to": fx.p("to")}})
}

fn rename_dir(fx: &Fx) -> Value {
    std::fs::create_dir(fx.root.join("from")).unwrap();
    json!({"op": "rename", "args": {"from": fx.p("from"), "to": fx.p("to")}})
}

fn rename_overwrite(fx: &Fx) -> Value {
    fx.put("from", "source\n");
    fx.put("to", "destination\n");
    let etag = fx.etag("to");
    json!({"op": "rename", "args": {"from": fx.p("from"), "to": fx.p("to"),
        "overwrite": true, "expectedEtag": etag}})
}

fn delete(fx: &Fx) -> Value {
    fx.put("doc", "doomed\n");
    json!({"op": "delete", "args": {"path": fx.p("doc")}})
}

fn race_doc(root: &Path) {
    save(&root.join("doc"), "racer\n");
}

fn race_to(root: &Path) {
    save(&root.join("to"), "racer\n");
}

fn noop(_: &Path) {}

const NO_EXCHANGE: (Primitive, usize, Errno) = (Primitive::Exchange, 1, Errno::EINVAL);
const NO_PROBE_EXCHANGE: (Primitive, usize, Errno) = (Primitive::ProbeExchange, 1, Errno::EINVAL);
const NO_NR: (Primitive, usize, Errno) = (Primitive::ProbeNoReplace, 1, Errno::EINVAL);
const NO_MOVE: (Primitive, usize, Errno) = (Primitive::Move, 1, Errno::EINVAL);
const NO_MOVE_UNSUPPORTED: (Primitive, usize, Errno) = (Primitive::Move, 1, Errno::ENOTSUP);

fn scenarios() -> Vec<Scenario> {
    let plain = |name, setup| Scenario {
        name,
        setup,
        before: &[],
        after: &[],
        race: None,
    };
    vec![
        plain("replace/exchange", edit),
        Scenario {
            before: &[NO_EXCHANGE],
            ..plain("replace/no-replace", edit)
        },
        Scenario {
            before: &[NO_EXCHANGE, NO_NR],
            ..plain("replace/link", edit)
        },
        Scenario {
            race: Some((Step::TempWritten, noop, true)),
            ..plain("replace/fails-before-commit", edit)
        },
        Scenario {
            race: Some((Step::EtagRechecked, race_doc, false)),
            ..plain("replace/racer-after-recheck", edit)
        },
        Scenario {
            before: &[NO_EXCHANGE],
            race: Some((Step::EtagRechecked, race_doc, false)),
            ..plain("replace/no-replace-racer", edit)
        },
        Scenario {
            after: &[(Primitive::Exchange, 1, Errno::EIO)],
            ..plain("replace/exchange-ambiguous", edit)
        },
        plain("create/new", create),
        Scenario {
            race: Some((Step::Created, noop, true)),
            ..plain("create/fails-after-create", create)
        },
        plain("rename/direct", rename_plain),
        Scenario {
            before: &[NO_MOVE_UNSUPPORTED],
            ..plain("rename/fallback-no-replace", rename_plain)
        },
        Scenario {
            before: &[NO_MOVE_UNSUPPORTED, NO_NR],
            ..plain("rename/fallback-link", rename_plain)
        },
        Scenario {
            before: &[NO_MOVE],
            ..plain("rename/directory-einval", rename_dir)
        },
        Scenario {
            after: &[(Primitive::Move, 1, Errno::EIO)],
            ..plain("rename/direct-ambiguous", rename_plain)
        },
        plain("rename/overwrite-exchange", rename_overwrite),
        Scenario {
            before: &[NO_EXCHANGE],
            ..plain("rename/overwrite-exchange-refused", rename_overwrite)
        },
        Scenario {
            before: &[NO_PROBE_EXCHANGE],
            ..plain("rename/overwrite-no-replace", rename_overwrite)
        },
        Scenario {
            before: &[NO_PROBE_EXCHANGE, NO_NR],
            ..plain("rename/overwrite-link", rename_overwrite)
        },
        Scenario {
            before: &[NO_PROBE_EXCHANGE],
            race: Some((Step::EtagRechecked, race_to, false)),
            ..plain("rename/overwrite-no-replace-racer", rename_overwrite)
        },
        Scenario {
            race: Some((Step::EtagRechecked, race_to, false)),
            ..plain("rename/overwrite-racer", rename_overwrite)
        },
        plain("delete/file", delete),
        Scenario {
            race: Some((Step::Vacating, race_doc, false)),
            ..plain("delete/racer", delete)
        },
    ]
}

/// The names under `root`, recovery directories by role, with file contents.
fn names(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        entries.sort();
        for path in entries {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let name = if name.starts_with(".wsmp-recover-") {
                ".wsmp-recover-R".to_owned()
            } else if name.starts_with(".wsmp-lock-.wsmp-recover-") {
                ".wsmp-lock-R".to_owned()
            } else if name.starts_with(".wsmp-pin-") {
                ".wsmp-pin-P".to_owned()
            } else {
                name
            };
            let shown = format!("{prefix}{name}");
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                out.push(format!("{shown}/"));
                walk(&path, &format!("{shown}/"), out);
            } else if meta.is_file() && name != "INTENT" {
                let bytes = std::fs::read(&path).unwrap();
                out.push(format!("{shown}={:?}", String::from_utf8_lossy(&bytes)));
            } else {
                out.push(shown);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", &mut out);
    // Pin names are random: compare them as a sorted multiset.
    out.sort();
    out
}

/// Append one line to the shared trace log (the hook appends there too).
fn emit(log: &Path, line: &str) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().append(true).open(log).unwrap();
    file.write_all(format!("{line}\n").as_bytes()).unwrap();
}

fn run(log: &Path, scenario: &Scenario) {
    let seen = Arc::new(Mutex::new(0usize));
    let drain = {
        let (log, seen) = (log.to_path_buf(), Arc::clone(&seen));
        move || {
            let calls = FaultScope::calls();
            let mut seen = seen.lock().unwrap();
            for call in &calls[*seen..] {
                emit(&log, &format!("  p {call:?}"));
            }
            *seen = calls.len();
        }
    };
    emit(log, &format!("== {}", scenario.name));
    let fx = Fx::new();
    emit(log, &format!("  root {}", fx.root.display()));
    let request = (scenario.setup)(&fx);
    let root = fx.root.clone();
    let race = scenario.race;
    let hook_log = log.to_path_buf();
    let hook_drain = drain.clone();
    let fired = Arc::new(Mutex::new(false));
    let fx = fx.with_hook(move |step| -> FileResult<()> {
        hook_drain();
        emit(&hook_log, &format!("  s {step:?}"));
        if let Some((at, action, fail)) = race
            && at == step
            && !std::mem::replace(&mut *fired.lock().unwrap(), true)
        {
            action(&root);
            if fail {
                return Err(crate::services::file_ops::FileError::invalid("trace fault"));
            }
        }
        Ok(())
    });
    let outcome = {
        let _faults = FaultScope::with_after_effects(scenario.before, scenario.after);
        let on = log.with_extension("log.on");
        std::fs::write(&on, "").unwrap();
        let result = fx.ops.execute(
            request["op"].as_str().unwrap(),
            request["args"].clone(),
            &fx.cancel,
        );
        std::fs::remove_file(&on).unwrap();
        drain();
        match result {
            Ok(value) => format!(
                "ok recovered={}",
                value
                    .get("recovered")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len)
            ),
            Err(error) => format!("err {:?}", error.code),
        }
    };
    emit(log, &format!("  => {outcome}"));
    for name in names(&fx.root) {
        emit(log, &format!("  | {name}"));
    }
}

/// Runs every scenario when the parent test starts this executable with the
/// hook preloaded; does nothing on its own.
#[test]
fn transaction_trace_child() {
    let Some(log) = std::env::var_os("WSMP_TRACE_LOG") else {
        return;
    };
    for scenario in scenarios() {
        run(Path::new(&log), &scenario);
    }
}

/// The temp dir as `/proc/self/fd` reports paths under it: canonical, so a
/// trailing slash or a symlinked `TMPDIR` still matches.
fn canonical_temp(temp: &Path) -> PathBuf {
    std::fs::canonicalize(temp).unwrap_or_else(|_| temp.to_path_buf())
}

/// The child's log with each scenario's root, the state directory (a
/// `tempfile` directory right under `temp`, canonical) and every random name
/// replaced by a fixed one. Each root is replaced first.
fn normalized(log: &str, temp: &Path) -> String {
    let state = format!(
        r"{}/\.tmp[A-Za-z0-9]{{6}}",
        regex::escape(&temp.to_string_lossy())
    );
    let random = regex::Regex::new(&format!(
        r"\.wsmp-recover-[A-Za-z0-9]{{10}}|\.wsmp-pin-[A-Za-z0-9]+|[0-9a-f]{{64}}|{state}"
    ))
    .unwrap();
    let mut root = String::new();
    let mut out = String::new();
    for line in log.lines() {
        if let Some(path) = line.strip_prefix("  root ") {
            root = path.to_owned();
            continue;
        }
        let line = if root.is_empty() {
            line.to_owned()
        } else {
            line.replace(&root, "<root>")
        };
        let line = random.replace_all(&line, |found: &regex::Captures<'_>| {
            let found = &found[0];
            if found.starts_with(".wsmp-recover-") {
                ".wsmp-recover-R"
            } else if found.starts_with(".wsmp-pin-") {
                ".wsmp-pin-P"
            } else if found.contains("/.tmp") {
                "/<state>"
            } else {
                "H"
            }
            .to_owned()
        });
        out.push_str(&line);
        out.push('\n');
    }
    out
}

fn hook(directory: &Path) -> PathBuf {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/file_ops_trace_hook.c");
    let library = directory.join("trace-hook.so");
    let output = std::process::Command::new("cc")
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
#[cfg_attr(
    target_env = "musl",
    ignore = "logs syscalls with LD_PRELOAD, which a static musl test binary never loads"
)]
fn transaction_trace_matches_the_recorded_order() {
    let directory = tempfile::tempdir().unwrap();
    let library = hook(directory.path());
    let log = directory.path().join("trace.log");
    std::fs::write(&log, "").unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "services::file_ops::tests::transaction_trace::transaction_trace_child",
            "--test-threads=1",
        ])
        .env("LD_PRELOAD", &library)
        .env("WSMP_TRACE_LOG", &log)
        .status()
        .unwrap();
    assert!(status.success(), "trace child failed");
    let actual = normalized(
        &std::fs::read_to_string(&log).unwrap(),
        &canonical_temp(&std::env::temp_dir()),
    );
    assert!(
        actual.contains("  d fsync ") && actual.contains("  d intent committed"),
        "the hook logged no durable steps: is LD_PRELOAD honored?"
    );
    if std::env::var_os("WSMP_TRACE_BLESS").is_some() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/services/file_ops/tests/transaction_trace.golden");
        std::fs::write(path, &actual).unwrap();
        return;
    }
    if actual != GOLDEN {
        let first = actual
            .lines()
            .zip(GOLDEN.lines())
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| actual.lines().count().min(GOLDEN.lines().count()));
        panic!(
            "transaction trace changed at line {}:\n--- actual\n{}\n--- expected\n{}",
            first + 1,
            actual
                .lines()
                .skip(first.saturating_sub(3))
                .take(12)
                .collect::<Vec<_>>()
                .join("\n"),
            GOLDEN
                .lines()
                .skip(first.saturating_sub(3))
                .take(12)
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
}

#[test]
fn state_paths_normalize_under_a_symlinked_or_slash_ended_temp_dir() {
    let real = tempfile::tempdir().unwrap();
    let real_path = std::fs::canonicalize(real.path()).unwrap();
    let link = real_path.join("link");
    std::os::unix::fs::symlink(&real_path, &link).unwrap();
    for temp in [
        link.clone(),
        PathBuf::from(format!("{}/", link.display())),
        PathBuf::from(format!("{}/", real_path.display())),
    ] {
        let line = format!("  d fsync {}/.tmpAbC123/registry", real_path.display());
        assert_eq!(
            normalized(&line, &canonical_temp(&temp)),
            "  d fsync /<state>/registry\n",
            "{}",
            temp.display()
        );
    }
}
