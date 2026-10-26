//! The shells a browser terminal can start on this machine.
//!
//! Unix terminals run the login shell and offer no choice, so [`discover`]
//! finds nothing there. Windows offers PowerShell 7 (`pwsh`), Windows
//! PowerShell (`powershell`), Command Prompt (`cmd`) and each WSL
//! distribution (`wsl:<name>`), found once when the relay starts. The hello
//! advertises their ids, the node's default first; a `term.open` may name one
//! of them. The server never sends a path: an id only selects a program found
//! here.

use std::path::PathBuf;

/// Shells advertised at most (the protocol's bound).
pub const MAX_SHELLS: usize = 16;

/// A shell a terminal can start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shell {
    /// `pwsh`, `powershell`, `cmd` or `wsl:<distribution>`.
    pub id: String,
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// A shell id this CLI can offer: `pwsh`, `powershell`, `cmd`, or `wsl:`
/// followed by 1 to 64 letters, digits, `.`, `_` or `-` (what WSL allows in
/// a distribution name).
pub fn valid_id(id: &str) -> bool {
    matches!(id, "pwsh" | "powershell" | "cmd")
        || id.strip_prefix("wsl:").is_some_and(|name| {
            (1..=64).contains(&name.len())
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        })
}

/// The shells found here, `preferred` (the `terminalShell` setting) first
/// when it is one of them, then pwsh, powershell, cmd and the WSL
/// distributions.
pub fn discover(preferred: Option<&str>) -> Vec<Shell> {
    let mut shells = found();
    if let Some(index) = preferred.and_then(|id| shells.iter().position(|shell| shell.id == id)) {
        let shell = shells.remove(index);
        shells.insert(0, shell);
    }
    shells.truncate(MAX_SHELLS);
    shells
}

#[cfg(not(windows))]
fn found() -> Vec<Shell> {
    Vec::new()
}

#[cfg(windows)]
fn found() -> Vec<Shell> {
    let mut shells = Vec::new();
    let system32 = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32"))
        .filter(|dir| dir.is_dir());
    let pwsh = on_path("pwsh.exe").or_else(|| {
        std::env::var_os("ProgramFiles")
            .map(|dir| PathBuf::from(dir).join(r"PowerShell\7\pwsh.exe"))
            .filter(|path| path.is_file())
    });
    if let Some(program) = pwsh {
        shells.push(Shell {
            id: "pwsh".to_string(),
            program,
            args: vec!["-NoLogo".to_string()],
        });
    }
    if let Some(program) = system32
        .as_ref()
        .map(|dir| dir.join(r"WindowsPowerShell\v1.0\powershell.exe"))
        .filter(|path| path.is_file())
    {
        shells.push(Shell {
            id: "powershell".to_string(),
            program,
            args: vec!["-NoLogo".to_string()],
        });
    }
    let comspec = std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file());
    if let Some(program) = comspec.or_else(|| {
        system32
            .as_ref()
            .map(|dir| dir.join("cmd.exe"))
            .filter(|path| path.is_file())
    }) {
        shells.push(Shell {
            id: "cmd".to_string(),
            program,
            args: Vec::new(),
        });
    }
    if let Some(wsl) = system32
        .as_ref()
        .map(|dir| dir.join("wsl.exe"))
        .filter(|path| path.is_file())
    {
        for name in wsl_distributions(&wsl) {
            shells.push(Shell {
                id: format!("wsl:{name}"),
                program: wsl.clone(),
                args: vec![
                    "--distribution".to_string(),
                    name,
                    "--cd".to_string(),
                    "~".to_string(),
                ],
            });
        }
    }
    shells
}

#[cfg(windows)]
fn on_path(file: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(file))
        .find(|candidate| candidate.is_file())
}

/// `wsl.exe --list --quiet`, bounded to a few seconds: the distribution
/// names, or none when WSL is missing, stuck or fails.
#[cfg(windows)]
fn wsl_distributions(wsl: &std::path::Path) -> Vec<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const LIST_WAIT: Duration = Duration::from_secs(5);
    let mut command = Command::new(wsl);
    command
        .args(["--list", "--quiet"])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (name, value) in crate::child_env::scrub_parent_env(&[]) {
        command.env(name, value);
    }
    let Ok(mut child) = command.spawn() else {
        return Vec::new();
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Vec::new();
    };
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.by_ref().take(64 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let until = Instant::now() + LIST_WAIT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let bytes = reader.join().unwrap_or_default();
    if !status.is_some_and(|status| status.success()) {
        return Vec::new();
    }
    distribution_names(&bytes)
}

/// The names in `wsl --list --quiet` output: UTF-16LE (UTF-8 when
/// `WSL_UTF8` is set), one per line. Names this CLI would not offer are
/// skipped.
#[cfg_attr(not(windows), allow(dead_code))]
fn distribution_names(bytes: &[u8]) -> Vec<String> {
    let text = if bytes.len().is_multiple_of(2)
        && bytes.iter().skip(1).step_by(2).any(|byte| *byte == 0)
    {
        let units = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    let mut names = Vec::new();
    for line in text.lines() {
        let name = line.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}');
        if !name.is_empty()
            && valid_id(&format!("wsl:{name}"))
            && !names.iter().any(|seen| seen == name)
        {
            names.push(name.to_string());
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_the_fixed_shells_or_a_plain_wsl_name() {
        for id in [
            "pwsh",
            "powershell",
            "cmd",
            "wsl:Ubuntu-24.04",
            "wsl:my_distro",
        ] {
            assert!(valid_id(id), "{id}");
        }
        for id in [
            "",
            "bash",
            "wsl:",
            "wsl:a b",
            "wsl:a;calc",
            "wsl:../x",
            "wsl:a\\b",
            &format!("wsl:{}", "a".repeat(65)),
        ] {
            assert!(!valid_id(id), "{id}");
        }
    }

    #[test]
    fn wsl_output_is_read_as_utf16_or_utf8_and_odd_names_are_skipped() {
        let utf16 = "Ubuntu\r\ndocker-desktop\r\nbad name\r\n\r\nUbuntu\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        assert_eq!(distribution_names(&utf16), ["Ubuntu", "docker-desktop"]);
        assert_eq!(
            distribution_names(b"Debian\nkali-linux\n"),
            ["Debian", "kali-linux"]
        );
        assert!(distribution_names(b"").is_empty());
    }

    #[test]
    fn the_preferred_shell_comes_first() {
        let shells = discover(None);
        if cfg!(windows) {
            assert!(shells.iter().any(|shell| shell.id == "cmd"));
            let last = shells.last().map(|shell| shell.id.clone());
            let moved = discover(last.as_deref());
            assert_eq!(moved.first().map(|shell| shell.id.clone()), last);
            assert_eq!(moved.len(), shells.len());
        } else {
            assert!(shells.is_empty());
        }
        assert!(shells.iter().all(|shell| valid_id(&shell.id)));
        assert_eq!(discover(Some("nonexistent")), shells);
    }
}
