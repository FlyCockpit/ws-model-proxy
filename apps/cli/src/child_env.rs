//! Child process environment and working-directory checks for terminals and exec.
//!
//! The scrubber is the only place that copies environment values into a child.
//! Callers must not log the returned pairs.

use std::path::{Path, PathBuf};

const ALLOWED_EXACT: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "SHELL", "TZ", "TERM",
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
    scrub_env(
        &borrowed,
        &ScrubOptions {
            case_insensitive_names: cfg!(windows),
            denied_names,
        },
    )
}

/// `sh -c` when `sh` exists. Windows falls back to `cmd /C` and cannot kill a
/// process group, so grandchildren of an exec may survive cancellation.
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
}
