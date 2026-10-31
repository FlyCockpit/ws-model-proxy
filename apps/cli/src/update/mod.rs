//! Self-update: `wsmp update` and the server's `agent.update` (see
//! `self-update-plan.md` at the repository root).
//!
//! The self-replace sequence: download the release archive beside the live
//! binary (same filesystem, never `/tmp`), verify its SHA-256 (and, later, a
//! signature), unpack it with the system `tar`, require `wsmp.new --version`
//! to print exactly the requested version, keep a rollback copy
//! (`wsmp.prev`) and the dead-man's own copy of it (`.wsmp-recovery-<id>`,
//! which nothing moves), write `<state>/update/state.json`, arm a dead-man job
//! that runs that copy of the *previous* binary at the deadline, swap the
//! files, and exit with
//! [`crate::exit::ExitCode::RestartForUpdate`]. The new binary confirms after
//! `hello.ok`, the definition sync and 30 s alive; it then disarms the
//! dead-man. A new build that never confirms is rolled back by the dead-man
//! (`wsmp update rollback --if-unconfirmed <id>`), and the old binary reports
//! `rolled_back` when it reconnects.
//!
//! Homebrew installs are upgraded by `brew` instead, with no rollback (D10).

pub mod agent;
pub mod build;
pub mod deadman;
pub mod flow;
pub mod homebrew;
pub mod install;
pub mod receipt;
pub mod state;

use std::path::PathBuf;

use anyhow::Result;

/// `<state>/update`: the update state and the dead-man's own files.
pub fn update_dir() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join("update"))
}

/// Seconds since the Unix epoch.
pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// A fresh 16-byte id in the `updateId` shape (22 base64url characters).
pub fn new_update_id() -> String {
    use base64::Engine as _;
    let bytes: [u8; 16] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The last characters of `text` that fit the progress `detail` cap.
pub fn clip_detail(text: &str) -> String {
    let max = crate::protocol::frames::UPDATE_DETAIL_MAX_CHARS;
    let trimmed = text.trim();
    if trimmed.encode_utf16().count() <= max {
        return trimmed.to_string();
    }
    let mut kept: Vec<char> = Vec::new();
    let mut units = 0;
    for ch in trimmed.chars().rev() {
        units += ch.len_utf16();
        // One unit is kept for the leading ellipsis.
        if units > max - 1 {
            break;
        }
        kept.push(ch);
    }
    kept.reverse();
    format!("…{}", kept.into_iter().collect::<String>())
}

/// The command a person runs on the node to build this version from source (D8).
pub fn source_command(version: &str) -> String {
    format!(
        "cargo install --git https://github.com/FlyCockpit/ws-model-proxy --tag v{version} --locked --force wsmp"
    )
}

/// Why an install without a receipt is not updated: nothing says the install
/// script put it there (a distro package or a copied binary must not be
/// overwritten).
pub const UNKNOWN_METHOD: &str = "wsmp cannot tell how it was installed (it has no install receipt); reinstall it once with the server's install script (`install.sh` or `install.ps1`) to allow updates";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_ids_have_the_wire_shape() {
        let id = new_update_id();
        assert!(crate::protocol::frames::is_op_id_shaped(&id), "{id}");
        assert_ne!(id, new_update_id());
    }

    #[test]
    fn details_keep_the_tail_within_the_cap() {
        assert_eq!(clip_detail("  short \n"), "short");
        let long = format!("{}END", "x".repeat(5000));
        let clipped = clip_detail(&long);
        assert!(clipped.encode_utf16().count() <= 4000);
        assert!(clipped.starts_with('…') && clipped.ends_with("END"));
    }
}
