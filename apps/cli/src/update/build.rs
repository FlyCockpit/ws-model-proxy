//! Which build this is and how it was installed: the hello `node.build` and
//! `node.environment`, and what the updater may replace.

use std::path::{Component, Path, PathBuf};

use crate::protocol::frames::{InstallMethod, NodeBuild, NodeEnvironment, is_commit};

use super::receipt::InstallReceipt;

/// The variable a release build sets at compile time to the commit it was built
/// from (40 lowercase hex): `WSMP_BUILD_COMMIT=$GITHUB_SHA cargo build ...`.
pub const BUILD_COMMIT_ENV: &str = "WSMP_BUILD_COMMIT";

/// The commit baked in at compile time, when it has the right shape.
pub fn compiled_commit() -> Option<&'static str> {
    option_env!("WSMP_BUILD_COMMIT").filter(|commit| is_commit(commit))
}

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The Rust target triple this binary was built for, as the release archives
/// name it (`wsmp-<target>.tar.xz`).
pub fn target() -> String {
    let arch = std::env::consts::ARCH;
    let rest = if cfg!(target_os = "linux") {
        if cfg!(target_env = "musl") {
            "unknown-linux-musl".to_string()
        } else {
            "unknown-linux-gnu".to_string()
        }
    } else if cfg!(target_os = "macos") {
        "apple-darwin".to_string()
    } else if cfg!(windows) {
        if cfg!(target_env = "gnu") {
            "pc-windows-gnu".to_string()
        } else {
            "pc-windows-msvc".to_string()
        }
    } else {
        format!("unknown-{}", std::env::consts::OS)
    };
    format!("{arch}-{rest}")
}

/// `/proc/sys/kernel/osrelease` of a WSL kernel names Microsoft
/// (`5.15.153.1-microsoft-standard-WSL2`).
pub fn osrelease_is_wsl(text: &str) -> bool {
    text.to_ascii_lowercase().contains("microsoft")
}

pub fn is_wsl() -> bool {
    cfg!(target_os = "linux")
        && std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|text| osrelease_is_wsl(&text))
}

/// The hello `node.environment`: sent only when there is something to say.
pub fn node_environment() -> Option<NodeEnvironment> {
    is_wsl().then_some(NodeEnvironment { wsl: true })
}

/// The live binary, with symlinks resolved (the file an update replaces).
pub fn live_binary() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| std::fs::canonicalize(exe).ok())
}

/// `$CARGO_HOME`, else `~/.cargo`.
fn cargo_home() -> Option<PathBuf> {
    std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".cargo")))
}

/// What [`detect`] looks at, gathered so the rules stay pure and testable.
#[derive(Debug, Default)]
pub struct Evidence<'a> {
    /// The canonical live binary.
    pub exe: Option<&'a Path>,
    pub receipt: Option<&'a InstallReceipt>,
    /// `$CARGO_HOME/bin`, canonical.
    pub cargo_bin: Option<&'a Path>,
    /// `$CARGO_HOME/.crates2.json`.
    pub crates2: Option<&'a str>,
    /// [`compiled_commit`]: set only on release builds.
    pub compiled_commit: Option<&'a str>,
}

/// How this wsmp was installed. A receipt for this very binary wins. Without
/// one, only what is certain: a binary in a Homebrew `Cellar` is Homebrew's,
/// one in a cargo `target/` directory or that cargo lists as built from git
/// (or a local path) is a source build, one cargo lists from a registry is
/// `cargo install`; anything else is unknown. Only the install scripts write
/// a receipt, so a script install older than self-update reinstalls once. A release build (one with a compiled-in commit) is never taken for
/// cargo's even when a stale `.crates2.json` entry names it.
pub fn detect(evidence: &Evidence<'_>) -> InstallMethod {
    if let Some(receipt) = evidence.receipt {
        let same_binary = match (&receipt.binary, evidence.exe) {
            (Some(recorded), Some(exe)) => {
                std::fs::canonicalize(recorded).is_ok_and(|recorded| recorded == exe)
                    || recorded == exe
            }
            _ => true,
        };
        if same_binary {
            return receipt.method;
        }
    }
    if let Some(exe) = evidence.exe {
        if super::homebrew::keg_of(exe).is_some() {
            return InstallMethod::Homebrew;
        }
        if in_cargo_target_dir(exe) {
            return InstallMethod::Source;
        }
        let in_cargo_bin = evidence
            .cargo_bin
            .is_some_and(|bin| exe.parent() == Some(bin));
        if in_cargo_bin
            && evidence.compiled_commit.is_none()
            && let Some(source) = evidence.crates2.and_then(crates2_source)
        {
            if source.starts_with("git+") || source.starts_with("path+") {
                return InstallMethod::Source;
            }
            if source.starts_with("registry+") || source.starts_with("sparse+") {
                return InstallMethod::Cargo;
            }
        }
    }
    // Not the install script's for sure (a distro package, a copied binary):
    // never overwritten from the browser.
    InstallMethod::Unknown
}

/// `…/target/debug/wsmp` or `…/target/release/wsmp` (and cross builds'
/// `target/<triple>/release`).
fn in_cargo_target_dir(exe: &Path) -> bool {
    let names: Vec<&std::ffi::OsStr> = exe
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name),
            _ => None,
        })
        .collect();
    names.windows(2).any(|pair| {
        pair[0] == "target"
            && matches!(pair[1].to_str(), Some("debug" | "release"))
            && names.len() >= 3
    }) || names.windows(3).any(|triple| {
        triple[0] == "target" && matches!(triple[2].to_str(), Some("debug" | "release"))
    })
}

/// The source cargo recorded for the installed `wsmp` package
/// (`"wsmp 0.4.2 (git+https://…#<rev>)"` → `git+https://…#<rev>`).
pub fn crates2_source(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value.get("installs")?.as_object()?.keys().find_map(|key| {
        let rest = key.strip_prefix("wsmp ")?;
        let (_, source) = rest.split_once(" (")?;
        source.strip_suffix(')').map(str::to_string)
    })
}

/// Everything the updater needs to know about this build, read now.
#[derive(Debug, Clone)]
pub struct Identity {
    pub method: InstallMethod,
    pub commit: Option<String>,
    pub target: String,
    pub live: Option<PathBuf>,
    pub receipt: Option<InstallReceipt>,
}

pub fn identity() -> Identity {
    let receipt = crate::paths::state_dir()
        .ok()
        .and_then(|dir| super::receipt::read(&dir));
    let live = live_binary();
    let cargo_bin = cargo_home().and_then(|home| std::fs::canonicalize(home.join("bin")).ok());
    let crates2 =
        cargo_home().and_then(|home| std::fs::read_to_string(home.join(".crates2.json")).ok());
    let method = detect(&Evidence {
        exe: live.as_deref(),
        receipt: receipt.as_ref(),
        cargo_bin: cargo_bin.as_deref(),
        crates2: crates2.as_deref(),
        compiled_commit: compiled_commit(),
    });
    // The receipt's commit counts only for the version it describes.
    let commit = compiled_commit().map(str::to_string).or_else(|| {
        receipt
            .as_ref()
            .filter(|receipt| receipt.version == version())
            .and_then(|receipt| receipt.commit.clone())
            .filter(|commit| is_commit(commit))
    });
    Identity {
        method,
        commit,
        target: target(),
        live,
        receipt,
    }
}

/// The hello `node.build`.
pub fn node_build() -> NodeBuild {
    let identity = identity();
    NodeBuild {
        commit: identity.commit,
        install_method: identity.method,
        target: identity.target,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(method: InstallMethod, binary: Option<&str>) -> InstallReceipt {
        InstallReceipt {
            method,
            version: "0.4.2".into(),
            commit: None,
            target: None,
            binary: binary.map(PathBuf::from),
            installed_at: None,
        }
    }

    const GIT: &str = r#"{"installs":{"wsmp 0.4.2 (git+https://github.com/FlyCockpit/ws-model-proxy?rev=abc#abcdef)":{"bins":["wsmp"]}}}"#;
    const REGISTRY: &str = r#"{"installs":{"wsmp 0.4.2 (registry+https://github.com/rust-lang/crates.io-index)":{"bins":["wsmp"]}}}"#;

    #[test]
    fn the_target_names_this_build() {
        let target = target();
        assert!(
            crate::protocol::frames::is_target_triple(&target),
            "{target}"
        );
        assert!(target.starts_with(std::env::consts::ARCH));
        #[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
        assert_eq!(target, "x86_64-unknown-linux-gnu");
    }

    #[test]
    fn wsl_kernels_name_microsoft() {
        assert!(osrelease_is_wsl("5.15.153.1-microsoft-standard-WSL2\n"));
        assert!(osrelease_is_wsl("4.4.0-19041-Microsoft"));
        assert!(!osrelease_is_wsl("6.8.0-147-generic"));
    }

    #[test]
    fn a_receipt_for_this_binary_wins() {
        let exe = Path::new("/home/u/.cargo/bin/wsmp");
        let receipt = receipt(InstallMethod::Binstall, Some("/home/u/.cargo/bin/wsmp"));
        let method = detect(&Evidence {
            exe: Some(exe),
            receipt: Some(&receipt),
            cargo_bin: Some(Path::new("/home/u/.cargo/bin")),
            crates2: Some(GIT),
            ..Evidence::default()
        });
        assert_eq!(method, InstallMethod::Binstall);
    }

    #[test]
    fn a_receipt_for_another_binary_is_ignored() {
        let exe = Path::new("/opt/homebrew/Cellar/wsmp/0.4.2/bin/wsmp");
        let receipt = receipt(InstallMethod::Script, Some("/Users/u/.cargo/bin/wsmp"));
        let method = detect(&Evidence {
            exe: Some(exe),
            receipt: Some(&receipt),
            ..Evidence::default()
        });
        assert_eq!(method, InstallMethod::Homebrew);
    }

    #[test]
    fn guesses_for_installs_without_a_receipt() {
        let bin = Path::new("/home/u/.cargo/bin");
        let exe = Path::new("/home/u/.cargo/bin/wsmp");
        let guess = |crates2: Option<&str>, commit: Option<&str>| {
            detect(&Evidence {
                exe: Some(exe),
                cargo_bin: Some(bin),
                crates2,
                compiled_commit: commit,
                ..Evidence::default()
            })
        };
        assert_eq!(guess(Some(GIT), None), InstallMethod::Source);
        assert_eq!(guess(Some(REGISTRY), None), InstallMethod::Cargo);
        assert_eq!(guess(None, None), InstallMethod::Unknown);
        // A release binary put over an old `cargo install`: not cargo's.
        assert_eq!(
            guess(Some(GIT), Some(&"a".repeat(40))),
            InstallMethod::Unknown
        );
        let homebrew = detect(&Evidence {
            exe: Some(Path::new(
                "/home/linuxbrew/.linuxbrew/Cellar/wsmp/0.4.1/bin/wsmp",
            )),
            ..Evidence::default()
        });
        assert_eq!(homebrew, InstallMethod::Homebrew);
        let dev = detect(&Evidence {
            exe: Some(Path::new("/src/ws-model-proxy/apps/cli/target/debug/wsmp")),
            ..Evidence::default()
        });
        assert_eq!(dev, InstallMethod::Source);
        let copied = detect(&Evidence {
            exe: Some(Path::new("/usr/bin/wsmp")),
            ..Evidence::default()
        });
        assert_eq!(copied, InstallMethod::Unknown);
    }

    #[test]
    fn crates2_names_the_wsmp_source() {
        assert_eq!(
            crates2_source(REGISTRY).as_deref(),
            Some("registry+https://github.com/rust-lang/crates.io-index")
        );
        assert_eq!(crates2_source(r#"{"installs":{}}"#), None);
        assert_eq!(crates2_source("not json"), None);
    }
}
