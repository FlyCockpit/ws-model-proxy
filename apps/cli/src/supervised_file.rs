//! `wsmp terminal supervised-file`: authoritative local-disk file preview.

use anyhow::Result;

#[cfg(unix)]
mod unix;

#[cfg(all(test, unix))]
pub(crate) use unix::screen_from_registry_env;

#[cfg(unix)]
pub fn run() -> Result<()> {
    unix::run()
}

#[cfg(not(unix))]
pub fn run() -> Result<()> {
    anyhow::bail!("supervised file requests need a Unix terminal")
}
