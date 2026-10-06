//! Child process environment and working-directory checks for terminals and exec.
//!
//! The scrubber is the only place that copies environment values into a child.
//! Callers must not log the returned pairs.

use std::path::{Path, PathBuf};

const ALLOWED_EXACT: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "SHELL",
    "TZ",
    "TERM",
    // The user session bus and runtime dir, so `systemctl --user`, `podman`
    // and friends work from headless commands.
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
];
const VALUE_PREFIXES: &[&str] = &["wsmp_model_", "wsmp_cli_", "wsmp_device_", "wsmp_mcp_"];

pub struct ScrubOptions<'a> {
    pub case_insensitive_names: bool,
    pub denied_names: &'a [String],
}

/// Keep the allowlist, then apply the denylist on top.
///
/// Denied names are the CLI token env var, `required_service_env_names`, and
/// anything starting with `WSMP_`. Values that start with a `wsmp_*` credential
/// prefix are dropped even when the name is allowlisted.
pub fn scrub_env(entries: &[(&str, &str)], options: &ScrubOptions<'_>) -> Vec<(String, String)> {
    entries
        .iter()
        .filter(|(name, value)| keep_entry(name, value, options))
        .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
        .collect()
}

fn keep_entry(name: &str, value: &str, options: &ScrubOptions<'_>) -> bool {
    if !allowlisted(name, options.case_insensitive_names) {
        return false;
    }
    if denied_name(name, options) {
        return false;
    }
    !VALUE_PREFIXES
        .iter()
        .any(|prefix| value.starts_with(prefix))
}

fn allowlisted(name: &str, case_insensitive: bool) -> bool {
    if ALLOWED_EXACT
        .iter()
        .any(|allowed| names_equal(name, allowed, case_insensitive))
    {
        return true;
    }
    prefix_equal(name, "LC_", case_insensitive)
}

fn denied_name(name: &str, options: &ScrubOptions<'_>) -> bool {
    if prefix_equal(name, "WSMP_", options.case_insensitive_names) {
        return true;
    }
    options
        .denied_names
        .iter()
        .any(|denied| names_equal(name, denied, options.case_insensitive_names))
}

fn names_equal(left: &str, right: &str, case_insensitive: bool) -> bool {
    if case_insensitive {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

fn prefix_equal(name: &str, prefix: &str, case_insensitive: bool) -> bool {
    let Some(head) = name.get(..prefix.len()) else {
        return false;
    };
    if case_insensitive {
        head.eq_ignore_ascii_case(prefix)
    } else {
        name.starts_with(prefix)
    }
}

pub fn parent_env() -> Vec<(String, String)> {
    std::env::vars().collect()
}

pub fn scrub_parent_env(denied_names: &[String]) -> Vec<(String, String)> {
    let entries = parent_env();
    let borrowed = entries
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    let mut env = scrub_env(
        &borrowed,
        &ScrubOptions {
            case_insensitive_names: cfg!(windows),
            denied_names,
        },
    );
    complete_child_env(&mut env, &HostEnvFacts::current(), is_socket);
    env
}

/// Facts about this host that complete a child's environment. Read once per
/// spawn by [`HostEnvFacts::current`]; tests build their own.
#[derive(Debug, Default)]
pub struct HostEnvFacts {
    /// The directory holding the running wsmp binary.
    pub exe_dir: Option<PathBuf>,
    /// `/run/user/$UID`, when this is Linux and that directory exists.
    pub user_runtime_dir: Option<PathBuf>,
}

impl HostEnvFacts {
    pub fn current() -> Self {
        Self {
            exe_dir: std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf)),
            user_runtime_dir: user_runtime_dir(),
        }
    }
}

/// `PATH` for a child when the daemon has none: the usual system directories.
#[cfg(unix)]
const FALLBACK_PATH: &[&str] = &["/usr/local/bin", "/usr/bin", "/bin"];
#[cfg(not(unix))]
const FALLBACK_PATH: &[&str] = &[];

/// The daemon's `PATH` plus the wsmp binary's directory when it is not
/// already listed (appended, so nothing the daemon resolves changes). A
/// service manager's default `PATH` rarely holds `~/.local/bin` or
/// `~/.cargo/bin`, where wsmp is usually installed, so `wsmp ...` from a
/// headless command would not be found otherwise.
fn with_exe_dir(path: Option<&str>, exe_dir: &Path) -> Option<String> {
    // Empty components (`::`, a leading or trailing `:`) mean the working
    // directory to a shell; never keep or create one.
    let mut dirs: Vec<PathBuf> = path
        .map(|path| {
            std::env::split_paths(path)
                .filter(|dir| !dir.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    if dirs.is_empty() {
        dirs = FALLBACK_PATH.iter().map(PathBuf::from).collect();
    }
    if dirs.iter().any(|dir| dir == exe_dir) {
        return None;
    }
    dirs.push(exe_dir.to_path_buf());
    std::env::join_paths(dirs).ok()?.into_string().ok()
}

#[cfg(target_os = "linux")]
fn user_runtime_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(format!(
        "/run/user/{}",
        nix::unistd::Uid::effective().as_raw()
    ));
    dir.is_dir().then_some(dir)
}

#[cfg(not(target_os = "linux"))]
fn user_runtime_dir() -> Option<PathBuf> {
    None
}

#[cfg(unix)]
fn is_socket(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket())
}

#[cfg(not(unix))]
fn is_socket(_path: &Path) -> bool {
    false
}

#[cfg(target_os = "linux")]
fn env_value<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter()
        .find(|(key, _)| names_equal(key, name, cfg!(windows)))
        .map(|(_, value)| value.as_str())
}

/// Fill in what a daemon started by a service manager may lack. `PATH` gains
/// the wsmp binary's directory (see [`with_exe_dir`]). On Linux, when the
/// daemon has no `XDG_RUNTIME_DIR` and `/run/user/$UID` exists, the child gets
/// that directory; when it has no `DBUS_SESSION_BUS_ADDRESS` and
/// `$XDG_RUNTIME_DIR/bus` is a socket, the child gets that bus. Values the
/// daemon already has are kept as they are.
pub fn complete_child_env(
    env: &mut Vec<(String, String)>,
    facts: &HostEnvFacts,
    is_socket: impl Fn(&Path) -> bool,
) {
    if let Some(exe_dir) = &facts.exe_dir {
        let index = env
            .iter()
            .position(|(name, _)| names_equal(name, "PATH", cfg!(windows)));
        let current = index
            .and_then(|index| env.get(index))
            .map(|(_, value)| value.as_str());
        if let Some(path) = with_exe_dir(current, exe_dir) {
            match index.and_then(|index| env.get_mut(index)) {
                Some(entry) => entry.1 = path,
                None => env.push(("PATH".to_string(), path)),
            }
        }
    }
    #[cfg(target_os = "linux")]
    complete_session_bus(env, facts, is_socket);
    #[cfg(not(target_os = "linux"))]
    let _ = is_socket;
}

/// Linux only: the user runtime dir and session bus (see
/// [`complete_child_env`]). Other platforms have no `/run/user/$UID`.
#[cfg(target_os = "linux")]
fn complete_session_bus(
    env: &mut Vec<(String, String)>,
    facts: &HostEnvFacts,
    is_socket: impl Fn(&Path) -> bool,
) {
    let Some(user_runtime_dir) = &facts.user_runtime_dir else {
        return;
    };
    if env_value(env, "XDG_RUNTIME_DIR").is_none()
        && let Some(dir) = user_runtime_dir.to_str()
    {
        env.push(("XDG_RUNTIME_DIR".to_string(), dir.to_string()));
    }
    if env_value(env, "DBUS_SESSION_BUS_ADDRESS").is_none()
        && let Some(runtime) = env_value(env, "XDG_RUNTIME_DIR")
    {
        let bus = Path::new(runtime).join("bus");
        if is_socket(&bus)
            && let Some(bus) = bus.to_str()
        {
            env.push((
                "DBUS_SESSION_BUS_ADDRESS".to_string(),
                format!("unix:path={bus}"),
            ));
        }
    }
}

/// `sh -c` when `sh` exists; Windows otherwise falls back to `cmd /C`.
/// Windows execs use a job object to kill the whole tree on cancellation.
pub fn exec_shell() -> (&'static str, &'static str) {
    if cfg!(unix) || sh_on_path() {
        ("sh", "-c")
    } else {
        ("cmd", "/C")
    }
}

fn sh_on_path() -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join("sh").is_file() || dir.join("sh.exe").is_file())
}

pub fn validate_command(command: &str) -> Result<(), &'static str> {
    if command.len() > 4096 {
        return Err("command is longer than 4096 bytes");
    }
    if command.as_bytes().contains(&0) {
        return Err("command contains NUL");
    }
    Ok(())
}

pub fn resolve_cwd(cwd: Option<&str>, home: &Path) -> Result<PathBuf, &'static str> {
    let path = match cwd {
        None => home.to_path_buf(),
        Some(raw) => expand_cwd(raw, home)?,
    };
    if !path.is_absolute() {
        return Err("working directory must be absolute");
    }
    let metadata = std::fs::metadata(&path).map_err(|_| "working directory does not exist")?;
    if !metadata.is_dir() {
        return Err("working directory is not a directory");
    }
    Ok(path)
}

/// Why a working directory cannot be shown on the supervised confirm screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmCwdError {
    /// The physical path could not be resolved (gone, or unreadable).
    Unresolvable,
    /// The physical path is not valid UTF-8, so no text can show it exactly.
    NotUtf8,
}

/// The working directory exactly as the supervised confirm screen shows it.
///
/// The confirm child `chdir`s into `path` and draws `getcwd()`, which is the
/// physical path (symlinks resolved). This returns that same physical path,
/// which the caller must also spawn in, as text. A path that is not valid
/// UTF-8 is refused: a lossy rendering (U+FFFD) would let two different
/// directories look the same, so the person could approve one and run in
/// another. This covers the `$HOME` default, `~/` expansion and symlinks.
pub fn confirm_screen_cwd(path: &Path) -> Result<(PathBuf, String), ConfirmCwdError> {
    let physical = std::fs::canonicalize(path).map_err(|_| ConfirmCwdError::Unresolvable)?;
    if !std::fs::metadata(&physical).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(ConfirmCwdError::Unresolvable);
    }
    let text = physical
        .to_str()
        .ok_or(ConfirmCwdError::NotUtf8)?
        .to_string();
    Ok((physical, text))
}

fn expand_cwd(raw: &str, home: &Path) -> Result<PathBuf, &'static str> {
    if raw.as_bytes().contains(&0) {
        return Err("working directory contains NUL");
    }
    if raw == "~" {
        return Ok(home.to_path_buf());
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if rest.is_empty() {
            return Ok(home.to_path_buf());
        }
        return Ok(home.join(rest));
    }
    if raw.starts_with('~') {
        return Err("working directory must be absolute or start with `~`");
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err("working directory must be absolute or start with `~`")
    }
}

pub fn login_shell() -> (String, Vec<String>) {
    let program = std::env::var("SHELL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string());
    (program, vec!["-l".to_string()])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scrub(
        entries: &[(&str, &str)],
        denied: &[&str],
        case_insensitive: bool,
    ) -> Vec<(String, String)> {
        let denied_names = denied
            .iter()
            .map(|name| (*name).to_string())
            .collect::<Vec<_>>();
        scrub_env(
            entries,
            &ScrubOptions {
                case_insensitive_names: case_insensitive,
                denied_names: &denied_names,
            },
        )
    }

    fn names(entries: &[(String, String)]) -> Vec<&str> {
        entries.iter().map(|(name, _)| name.as_str()).collect()
    }

    #[test]
    fn keeps_the_allowlist_and_drops_other_names() {
        let kept = scrub(
            &[
                ("PATH", "/usr/bin"),
                ("HOME", "/home/example"),
                ("USER", "example"),
                ("LOGNAME", "example"),
                ("LANG", "C"),
                ("LC_ALL", "C"),
                ("SHELL", "/bin/sh"),
                ("TZ", "UTC"),
                ("TERM", "xterm"),
                ("UNRELATED", "example"),
            ],
            &[],
            false,
        );
        assert_eq!(
            names(&kept),
            vec![
                "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SHELL", "TZ", "TERM"
            ]
        );
    }

    #[test]
    fn keeps_the_user_session_bus_and_runtime_dir() {
        let kept = scrub(
            &[
                ("XDG_RUNTIME_DIR", "/run/user/1000"),
                ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ],
            &[],
            false,
        );
        assert_eq!(
            names(&kept),
            vec!["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]
        );
    }

    #[cfg(unix)]
    fn owned(entries: &[(&str, &str)]) -> Vec<(String, String)> {
        entries
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect()
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fills_the_runtime_dir_and_bus_when_the_daemon_lacks_them() {
        let facts = HostEnvFacts {
            user_runtime_dir: Some(PathBuf::from("/run/user/1000")),
            ..HostEnvFacts::default()
        };
        let mut env = owned(&[("PATH", "/usr/bin")]);
        complete_child_env(&mut env, &facts, |path| {
            path == Path::new("/run/user/1000/bus")
        });
        assert_eq!(
            env,
            owned(&[
                ("PATH", "/usr/bin"),
                ("XDG_RUNTIME_DIR", "/run/user/1000"),
                ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ])
        );

        // No bus socket: only the runtime dir.
        let mut env = owned(&[("PATH", "/usr/bin")]);
        complete_child_env(&mut env, &facts, |_| false);
        assert_eq!(
            env,
            owned(&[("PATH", "/usr/bin"), ("XDG_RUNTIME_DIR", "/run/user/1000")])
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn keeps_what_the_daemon_has_and_fills_nothing_without_a_user_runtime_dir() {
        let facts = HostEnvFacts {
            user_runtime_dir: Some(PathBuf::from("/run/user/1000")),
            ..HostEnvFacts::default()
        };
        let daemon = owned(&[
            ("XDG_RUNTIME_DIR", "/custom/runtime"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/custom/bus"),
        ]);
        let mut env = daemon.clone();
        complete_child_env(&mut env, &facts, |_| true);
        assert_eq!(env, daemon);

        // The daemon's own runtime dir locates the bus.
        let mut env = owned(&[("XDG_RUNTIME_DIR", "/custom/runtime")]);
        complete_child_env(&mut env, &facts, |path| {
            path == Path::new("/custom/runtime/bus")
        });
        assert_eq!(
            env,
            owned(&[
                ("XDG_RUNTIME_DIR", "/custom/runtime"),
                ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/custom/runtime/bus"),
            ])
        );

        // Not Linux, or no /run/user/$UID: nothing is invented.
        let mut env = owned(&[("PATH", "/usr/bin")]);
        complete_child_env(&mut env, &HostEnvFacts::default(), |_| true);
        assert_eq!(env, owned(&[("PATH", "/usr/bin")]));
    }

    #[cfg(unix)]
    #[test]
    fn path_gains_the_wsmp_directory_once() {
        let facts = HostEnvFacts {
            exe_dir: Some(PathBuf::from("/home/me/.local/bin")),
            ..HostEnvFacts::default()
        };
        let mut env = owned(&[("PATH", "/usr/bin:/bin"), ("HOME", "/home/me")]);
        complete_child_env(&mut env, &facts, |_| false);
        assert_eq!(
            env,
            owned(&[
                ("PATH", "/usr/bin:/bin:/home/me/.local/bin"),
                ("HOME", "/home/me")
            ])
        );
        // Already listed: unchanged, in its original position.
        let mut env = owned(&[("PATH", "/home/me/.local/bin:/usr/bin")]);
        complete_child_env(&mut env, &facts, |_| false);
        assert_eq!(env, owned(&[("PATH", "/home/me/.local/bin:/usr/bin")]));
        // No daemon PATH: the system directories plus wsmp's.
        let mut env = owned(&[("HOME", "/home/me")]);
        complete_child_env(&mut env, &facts, |_| false);
        assert_eq!(
            env,
            owned(&[
                ("HOME", "/home/me"),
                ("PATH", "/usr/local/bin:/usr/bin:/bin:/home/me/.local/bin")
            ])
        );
        // An empty PATH (or empty components) never becomes `:<exe_dir>`.
        let mut env = owned(&[("PATH", "")]);
        complete_child_env(&mut env, &facts, |_| false);
        assert_eq!(
            env,
            owned(&[("PATH", "/usr/local/bin:/usr/bin:/bin:/home/me/.local/bin")])
        );
        let mut env = owned(&[("PATH", ":/usr/bin::")]);
        complete_child_env(&mut env, &facts, |_| false);
        assert_eq!(env, owned(&[("PATH", "/usr/bin:/home/me/.local/bin")]));
        // A directory that cannot be listed in PATH is left out.
        let odd = HostEnvFacts {
            exe_dir: Some(PathBuf::from("/opt/a:b")),
            ..HostEnvFacts::default()
        };
        let mut env = owned(&[("PATH", "/usr/bin")]);
        complete_child_env(&mut env, &odd, |_| false);
        assert_eq!(env, owned(&[("PATH", "/usr/bin")]));
    }

    #[test]
    fn scrubbed_parent_env_reaches_the_running_binary() {
        let exe = std::env::current_exe().expect("current exe");
        let dir = exe.parent().expect("exe dir");
        let env = scrub_parent_env(&[]);
        let path = env
            .iter()
            .find(|(name, _)| names_equal(name, "PATH", cfg!(windows)))
            .map(|(_, value)| value.clone())
            .expect("child PATH");
        assert!(std::env::split_paths(&path).any(|entry| entry == dir));
    }

    #[cfg(unix)]
    #[test]
    fn is_socket_tells_a_socket_from_a_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("bus");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind");
        let file = dir.path().join("file");
        std::fs::write(&file, b"x").expect("write");
        assert!(is_socket(&socket));
        assert!(!is_socket(&file));
        assert!(!is_socket(&dir.path().join("missing")));
    }

    #[test]
    fn drops_the_cli_token_env_name() {
        let kept = scrub(
            &[("PATH", "/usr/bin"), ("APP_TOKEN", "example")],
            &["APP_TOKEN"],
            false,
        );
        assert_eq!(names(&kept), vec!["PATH"]);
    }

    #[test]
    fn drops_service_env_names() {
        let kept = scrub(
            &[("PATH", "/usr/bin"), ("LOCAL_API_KEY", "example")],
            &["LOCAL_API_KEY"],
            false,
        );
        assert_eq!(names(&kept), vec!["PATH"]);
    }

    #[test]
    fn drops_wsmp_prefixed_names() {
        let kept = scrub(
            &[
                ("PATH", "/usr/bin"),
                ("WSMP_CONFIG", "example"),
                ("WSMP_TOKEN", "example"),
            ],
            &[],
            false,
        );
        assert_eq!(names(&kept), vec!["PATH"]);
    }

    #[test]
    fn drops_wsmp_model_prefixed_values() {
        let kept = scrub(&[("HOME", "wsmp_model_example")], &[], false);
        assert!(kept.is_empty());
    }

    #[test]
    fn drops_wsmp_cli_prefixed_values() {
        let kept = scrub(&[("HOME", "wsmp_cli_example")], &[], false);
        assert!(kept.is_empty());
    }

    #[test]
    fn drops_wsmp_device_prefixed_values() {
        let kept = scrub(&[("HOME", "wsmp_device_example")], &[], false);
        assert!(kept.is_empty());
    }

    #[test]
    fn drops_wsmp_mcp_prefixed_values() {
        let kept = scrub(&[("HOME", "wsmp_mcp_example")], &[], false);
        assert!(kept.is_empty());
    }

    #[test]
    fn windows_shaped_name_compare_is_case_insensitive() {
        let kept = scrub(
            &[
                ("Path", "/usr/bin"),
                ("wsmp_state", "example"),
                ("App_Token", "example"),
                ("Lc_All", "C"),
            ],
            &["APP_TOKEN"],
            true,
        );
        assert_eq!(names(&kept), vec!["Path", "Lc_All"]);
    }

    #[test]
    fn rejects_commands_that_are_too_long_or_contain_nul() {
        assert!(validate_command("echo ok").is_ok());
        assert!(validate_command(&"a".repeat(4096)).is_ok());
        assert!(validate_command(&"a".repeat(4097)).is_err());
        assert!(validate_command("has\0nul").is_err());
    }

    #[test]
    fn resolves_only_existing_absolute_or_tilde_directories() {
        let root = tempfile::tempdir().expect("tempdir");
        let home = root.path().join("home");
        let nested = home.join("work");
        std::fs::create_dir_all(&nested).expect("dirs");
        let file = home.join("file");
        std::fs::write(&file, b"x").expect("file");

        assert_eq!(resolve_cwd(None, &home).expect("home"), home);
        assert_eq!(resolve_cwd(Some("~"), &home).expect("tilde"), home);
        assert_eq!(resolve_cwd(Some("~/work"), &home).expect("nested"), nested);
        assert_eq!(
            resolve_cwd(Some(nested.to_str().expect("utf8")), &home).expect("absolute"),
            nested
        );
        assert!(resolve_cwd(Some("relative"), &home).is_err());
        assert!(resolve_cwd(Some("~other/work"), &home).is_err());
        assert!(resolve_cwd(Some("~/missing"), &home).is_err());
        assert!(resolve_cwd(Some(file.to_str().expect("utf8")), &home).is_err());
        assert!(resolve_cwd(Some("~/has\0nul"), &home).is_err());
    }

    #[test]
    fn confirm_screen_cwd_is_the_exact_physical_path() {
        let root = tempfile::tempdir().expect("tempdir");
        let physical_root = std::fs::canonicalize(root.path()).expect("canonical root");
        let dir = physical_root.join("work dir é");
        std::fs::create_dir(&dir).expect("dir");
        let (path, text) = confirm_screen_cwd(&dir).expect("utf8 dir");
        assert_eq!(path, dir);
        assert_eq!(text, dir.to_str().expect("utf8"));
        assert_eq!(
            confirm_screen_cwd(&physical_root.join("missing")),
            Err(ConfirmCwdError::Unresolvable)
        );
        let file = physical_root.join("file");
        std::fs::write(&file, b"x").expect("file");
        assert_eq!(
            confirm_screen_cwd(&file),
            Err(ConfirmCwdError::Unresolvable)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn confirm_screen_cwd_refuses_non_utf8_directories_and_symlinks_to_them() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let root = tempfile::tempdir().expect("tempdir");
        let bad = root.path().join(OsStr::from_bytes(b"a\xff"));
        std::fs::create_dir(&bad).expect("non-utf8 dir");
        assert_eq!(confirm_screen_cwd(&bad), Err(ConfirmCwdError::NotUtf8));
        // A UTF-8 path whose physical target is not UTF-8 (what getcwd shows).
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&bad, &link).expect("symlink");
        assert!(link.to_str().is_some());
        assert_eq!(confirm_screen_cwd(&link), Err(ConfirmCwdError::NotUtf8));
        // A valid directory literally named with U+FFFD is shown exactly.
        let replacement = root.path().join("a\u{FFFD}");
        std::fs::create_dir(&replacement).expect("fffd dir");
        let (_, text) = confirm_screen_cwd(&replacement).expect("fffd is valid utf8");
        assert!(text.ends_with("a\u{FFFD}"));
    }
}
