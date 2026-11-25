//! Browser terminal handshakes: the checks before a terminal opens or a viewer joins, the
//! approval of a browser identity, and the rejections they answer with.

use std::path::Path;

use super::{
    OutboundFrame, REASON_APPROVAL_REQUIRED, REASON_BAD_HANDSHAKE, REASON_DISABLED, REASON_LIMIT,
    REASON_SPAWN_FAILED, REASON_UNSUPPORTED,
};
use crate::node::approvals::{approved_public_key, record_pending};
use crate::relay::startup::TerminalStartup;
use crate::wire::protocol::frames::TerminalIdentity;
use crate::wire::protocol::{NodeFrame, terminal_supported};
use crate::wire::terminal_crypto;

#[derive(Clone, Copy)]
pub(crate) struct TermHandshake<'a> {
    pub terminal_id: &'a str,
    /// Minted by the server in protocol 2.5. `None` on a 2.4 relay.
    pub viewer_id: Option<&'a str>,
    pub cols: u16,
    pub rows: u16,
    pub browser_public_key: &'a str,
    pub browser_nonce: &'a str,
    pub identity: Option<&'a TerminalIdentity>,
    /// A shell id from `features.terminals.shells`; `None` for the default.
    pub shell: Option<&'a str>,
}

/// Why a browser terminal cannot open: `open` live browser terminals against
/// this machine's `maxTerminals` (`max`).
fn terminal_block_reason(
    supported: bool,
    allowed: bool,
    open: usize,
    max: usize,
) -> Option<&'static str> {
    if !supported {
        return Some(REASON_UNSUPPORTED);
    }
    if !allowed {
        return Some(REASON_DISABLED);
    }
    if open >= max {
        return Some(REASON_LIMIT);
    }
    None
}

pub(super) fn identity_public(
    identity: Option<&TerminalIdentity>,
) -> Result<[u8; 65], &'static str> {
    let Some(identity) = identity else {
        return Err(REASON_APPROVAL_REQUIRED);
    };
    terminal_crypto::decode_public_key(&identity.public_key).map_err(|_| REASON_APPROVAL_REQUIRED)
}

/// `None` when the identity is already approved. Otherwise the approval code,
/// after the unknown key is written to the pending file.
pub(super) fn approval_code_for_identity(
    state_dir: Option<&Path>,
    identity_raw: &[u8; 65],
) -> Option<String> {
    let code = terminal_crypto::approval_code(identity_raw);
    if let Some(dir) = state_dir
        && let Ok(Some(stored)) = approved_public_key(dir, &code)
        && stored == *identity_raw
    {
        return None;
    }
    if let Some(dir) = state_dir
        && let Err(error) = record_pending(dir, identity_raw)
    {
        tracing::warn!(error = %error, "recording a pending terminal approval failed");
    }
    Some(code)
}

/// `false` only when the approvals file positively no longer maps this
/// identity's code to it. A read error keeps the viewer.
pub(super) fn identity_still_approved(state_dir: &Path, identity_raw: &[u8; 65]) -> bool {
    let code = terminal_crypto::approval_code(identity_raw);
    match approved_public_key(state_dir, &code) {
        Ok(Some(stored)) => stored == *identity_raw,
        Ok(None) => false,
        Err(error) => {
            tracing::warn!(error = %error, "re-checking a terminal approval failed");
            true
        }
    }
}

/// Approval signatures bind the viewer as well as the terminal and both nonces.
#[allow(clippy::too_many_arguments)]
pub(super) fn approval_signature_ok(
    identity_raw: &[u8; 65],
    signature: &str,
    terminal_id: &str,
    viewer_id: Option<&str>,
    browser_public: &[u8; 65],
    browser_nonce: &[u8; 16],
    cli_public: &[u8; 65],
    cli_nonce: &[u8; 16],
) -> bool {
    let Ok(signature) = terminal_crypto::decode_exact(signature, 64) else {
        return false;
    };
    let Some(viewer_id) = viewer_id else {
        return false;
    };
    terminal_crypto::verify_approval_signature_v2(
        identity_raw,
        &signature,
        terminal_id,
        viewer_id,
        browser_public,
        browser_nonce,
        cli_public,
        cli_nonce,
    )
}

pub(super) struct PreparedHandshake {
    pub(super) cols: u16,
    pub(super) rows: u16,
    pub(super) browser_public: [u8; 65],
    pub(super) browser_nonce: [u8; 16],
    pub(super) shell: Option<String>,
}

pub(super) fn handshake_rejected(
    handshake: &TermHandshake<'_>,
    reason: &str,
) -> Box<OutboundFrame> {
    Box::new(term_rejected(
        handshake.terminal_id,
        handshake.viewer_id,
        reason,
        None,
    ))
}

pub(super) fn fresh_nonce(handshake: &TermHandshake<'_>) -> Result<[u8; 16], Box<OutboundFrame>> {
    match terminal_crypto::random_nonce() {
        Ok(nonce) => Ok(nonce),
        Err(error) => {
            tracing::warn!(
                error = %error,
                terminal_id = handshake.terminal_id,
                "generating a terminal nonce failed"
            );
            Err(handshake_rejected(handshake, REASON_SPAWN_FAILED))
        }
    }
}

pub(super) fn decode_browser_handshake(
    handshake: &TermHandshake<'_>,
) -> Result<PreparedHandshake, Box<OutboundFrame>> {
    let (cols, rows) = if handshake.cols == 0 && handshake.rows == 0 {
        // Attach does not carry a size. The live pty keeps the size it has.
        (80, 24)
    } else if terminal_crypto::validate_size(handshake.cols, handshake.rows).is_err() {
        return Err(handshake_rejected(handshake, REASON_BAD_HANDSHAKE));
    } else {
        (handshake.cols, handshake.rows)
    };
    let Ok(browser_public) = terminal_crypto::decode_public_key(handshake.browser_public_key)
    else {
        return Err(handshake_rejected(handshake, REASON_BAD_HANDSHAKE));
    };
    let Ok(browser_nonce) = terminal_crypto::decode_nonce(handshake.browser_nonce) else {
        return Err(handshake_rejected(handshake, REASON_BAD_HANDSHAKE));
    };
    Ok(PreparedHandshake {
        cols,
        rows,
        browser_public,
        browser_nonce,
        shell: handshake.shell.map(str::to_string),
    })
}

pub(super) fn prepare_handshake(
    startup: &TerminalStartup,
    open_count: usize,
    handshake: &TermHandshake<'_>,
) -> Result<PreparedHandshake, Box<OutboundFrame>> {
    // A pending approval does not consume a live terminal slot.
    let counted = if startup.require_terminal_approval() {
        0
    } else {
        open_count
    };
    if let Some(reason) = terminal_block_reason(
        terminal_supported(),
        // Browser terminals need the local switch and Full control.
        startup.allow_human_terminal() && startup.full_control(),
        counted,
        startup.max_terminals(),
    ) {
        return Err(handshake_rejected(handshake, reason));
    }
    // Only a shell this node advertised; a node that advertised none (Unix)
    // takes none.
    if handshake.shell.is_some() && startup.shell(handshake.shell).is_none() {
        return Err(handshake_rejected(handshake, REASON_BAD_HANDSHAKE));
    }
    decode_browser_handshake(handshake)
}

pub(super) fn term_rejected(
    terminal_id: &str,
    viewer_id: Option<&str>,
    reason: &str,
    approval_code: Option<String>,
) -> OutboundFrame {
    OutboundFrame::Control(NodeFrame::TermRejected {
        terminal_id: terminal_id.to_string(),
        viewer_id: viewer_id.map(str::to_string),
        reason: reason.to_string(),
        approval_code,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::terminal_crypto::CliTerminalKey;

    #[test]
    fn unsupported_disabled_or_over_limit_terminals_are_rejected() {
        assert_eq!(
            terminal_block_reason(false, true, 0, 4),
            Some(REASON_UNSUPPORTED)
        );
        assert_eq!(
            terminal_block_reason(true, false, 0, 4),
            Some(REASON_DISABLED)
        );
        assert_eq!(terminal_block_reason(true, true, 4, 4), Some(REASON_LIMIT));
        assert_eq!(terminal_block_reason(true, true, 3, 4), None);
        assert_eq!(terminal_block_reason(true, true, 1, 1), Some(REASON_LIMIT));
        assert_eq!(terminal_block_reason(true, true, 31, 32), None);
        assert!(terminal_supported());
    }

    #[test]
    fn approval_signature_includes_the_cli_nonce() {
        let dir = tempfile::tempdir().expect("tempdir");
        let browser = CliTerminalKey::generate().expect("browser");
        use p256::elliptic_curve::Generate;
        let identity = p256::ecdsa::SigningKey::try_generate().expect("identity");
        let identity_raw = {
            let encoded = identity.verifying_key().to_sec1_point(false);
            let mut raw = [0_u8; 65];
            raw.copy_from_slice(encoded.as_bytes());
            raw
        };
        let identity_message = TerminalIdentity {
            public_key: terminal_crypto::encode_b64url(&identity_raw),
            signature: None,
        };
        assert!(identity_public(None).is_err());
        assert_eq!(
            identity_public(Some(&identity_message)).expect("raw"),
            identity_raw
        );
        let code = approval_code_for_identity(Some(dir.path()), &identity_raw).expect("code");
        assert_eq!(code, terminal_crypto::approval_code(&identity_raw));
        let cli = CliTerminalKey::generate().expect("cli");
        let browser_nonce = [4_u8; 16];
        let cli_nonce = [5_u8; 16];
        let signature = terminal_crypto::sign_approval_v2(
            &identity,
            "term-a",
            "AQIDBAUGBwgJCgsMDQ4PEA",
            browser.public_raw(),
            &browser_nonce,
            cli.public_raw(),
            &cli_nonce,
        )
        .expect("sign");
        let encoded = terminal_crypto::encode_b64url(&signature);
        assert!(!approval_signature_ok(
            &identity_raw,
            &encoded,
            "term-a",
            Some("AQIDBAUGBwgJCgsMDQ4PEA"),
            browser.public_raw(),
            &browser_nonce,
            cli.public_raw(),
            &[6_u8; 16],
        ));
        crate::node::approvals::approve(dir.path(), &code).expect("approve");
        assert!(approval_code_for_identity(Some(dir.path()), &identity_raw).is_none());
        assert!(approval_signature_ok(
            &identity_raw,
            &encoded,
            "term-a",
            Some("AQIDBAUGBwgJCgsMDQ4PEA"),
            browser.public_raw(),
            &browser_nonce,
            cli.public_raw(),
            &cli_nonce,
        ));
    }
}
