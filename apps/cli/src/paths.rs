//! Filesystem locations for config and durable state.

use std::path::PathBuf;

use anyhow::{Context, Result};

const APP: &str = "ws-model-proxy";
const CONFIG_FILE_ENV: &str = "WSMP_CONFIG";
const STATE_DIR_ENV: &str = "WSMP_STATE_DIR";

/// Paths `wsmp run --config/--state-dir` pinned for this process, ahead of
/// the environment: a Windows scheduled task cannot set `WSMP_CONFIG` or
/// `WSMP_STATE_DIR` the way a systemd unit or the launchd wrapper does.
#[derive(Debug, Default)]
struct Pinned {
    config_file: Option<PathBuf>,
    state_dir: Option<PathBuf>,
}

static PINNED: std::sync::OnceLock<Pinned> = std::sync::OnceLock::new();

/// Pin the config file and state dir for the rest of this process. Call
/// before anything reads a path; only `wsmp run` does.
pub fn pin(config_file: Option<PathBuf>, state_dir: Option<PathBuf>) -> Result<()> {
    PINNED
        .set(Pinned {
            config_file,
            state_dir,
        })
        .map_err(|_| anyhow::anyhow!("the config and state paths are already pinned"))
}

fn pinned() -> Option<&'static Pinned> {
    PINNED.get()
}

pub fn config_dir() -> Result<PathBuf> {
    if let Some(config) = pinned().and_then(|pinned| pinned.config_file.as_ref()) {
        return config
            .parent()
            .map(std::path::Path::to_path_buf)
            .context("pinned config path has no parent directory");
    }
    if let Some(path) = std::env::var_os(CONFIG_FILE_ENV) {
        let config = PathBuf::from(path);
        return config
            .parent()
            .map(std::path::Path::to_path_buf)
            .context("explicit config path has no parent directory");
    }
    if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(dir).join(APP));
    }
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    Ok(home.join(".config").join(APP))
}

pub fn config_file() -> Result<PathBuf> {
    if let Some(config) = pinned().and_then(|pinned| pinned.config_file.as_ref()) {
        return Ok(config.clone());
    }
    if let Some(path) = std::env::var_os(CONFIG_FILE_ENV) {
        return Ok(PathBuf::from(path));
    }
    Ok(config_dir()?.join("config.json"))
}

/// The node's state: `WSMP_STATE_DIR`, else `$XDG_STATE_HOME/ws-model-proxy`,
/// else the platform's place for it: `~/.local/state/ws-model-proxy` on
/// Linux and macOS, `%LOCALAPPDATA%\ws-model-proxy` on Windows (local, not
/// roaming: the node credential belongs to this machine).
pub fn state_dir() -> Result<PathBuf> {
    if let Some(dir) = pinned().and_then(|pinned| pinned.state_dir.as_ref()) {
        return Ok(dir.clone());
    }
    if let Some(dir) = std::env::var_os(STATE_DIR_ENV) {
        return Ok(PathBuf::from(dir));
    }
    if let Some(dir) = std::env::var_os("XDG_STATE_HOME") {
        return Ok(PathBuf::from(dir).join(APP));
    }
    #[cfg(windows)]
    {
        let local = dirs::data_local_dir().context("could not determine `%LOCALAPPDATA%`")?;
        Ok(local.join(APP))
    }
    #[cfg(not(windows))]
    {
        let home = dirs::home_dir().context("could not determine the user home directory")?;
        Ok(home.join(".local").join("state").join(APP))
    }
}

/// Where the relay service writes its log (`wsmp run --log-file`), for the
/// platforms whose service manager keeps none (Windows).
pub fn log_dir() -> Result<PathBuf> {
    Ok(state_dir()?.join("logs"))
}

pub fn node_credential_file() -> Result<PathBuf> {
    Ok(state_dir()?.join("node-credential.json"))
}
