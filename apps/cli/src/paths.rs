//! Filesystem locations for config and durable state.

use std::path::PathBuf;

use anyhow::{Context, Result};

const APP: &str = "ws-model-proxy";
const CONFIG_FILE_ENV: &str = "WSMP_CONFIG";
const STATE_DIR_ENV: &str = "WSMP_STATE_DIR";

pub fn config_dir() -> Result<PathBuf> {
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
    if let Some(path) = std::env::var_os(CONFIG_FILE_ENV) {
        return Ok(PathBuf::from(path));
    }
    Ok(config_dir()?.join("config.json"))
}

pub fn state_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os(STATE_DIR_ENV) {
        return Ok(PathBuf::from(dir));
    }
    if let Some(dir) = std::env::var_os("XDG_STATE_HOME") {
        return Ok(PathBuf::from(dir).join(APP));
    }
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    Ok(home.join(".local").join("state").join(APP))
}

pub fn device_credential_file() -> Result<PathBuf> {
    Ok(state_dir()?.join("device-auth.json"))
}

/// CLI-generated login machine id, beside the device credential. Not the
/// user-edited config. Unused when `/etc/machine-id` is a real machine id.
pub fn machine_id_file() -> Result<PathBuf> {
    Ok(state_dir()?.join("machine-id"))
}
