//! `wsmp terminal supervised-file`: authoritative local-disk file preview.

use anyhow::Result;

#[cfg(unix)]
mod unix;

#[cfg(unix)]
pub fn run() -> Result<()> {
    unix::run()
}

#[cfg(not(unix))]
pub fn run() -> Result<()> {
    anyhow::bail!("supervised file requests need a Unix terminal")
}
