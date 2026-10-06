//! `wsmp terminal` approval and identity commands.
//!
//! Approvals are re-read on each terminal open, so these commands do not need a
//! daemon restart. `fingerprint` prints the CLI identity key that browsers pin.

use anyhow::Result;
use serde::Serialize;

use crate::approvals::{self, ApprovalEntry};
use crate::output;
use crate::terminal_identity;

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Emit JSON instead of human-readable text.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Sub,
}

#[derive(Debug, clap::Subcommand)]
enum Sub {
    /// Approve a pending browser terminal identity.
    Approve { code: String },
    /// List or revoke approved browser terminal identities.
    Approvals {
        #[command(subcommand)]
        command: Approvals,
    },
    /// Print this CLI's terminal identity fingerprint, as browsers show it.
    ///
    /// Creates the identity key on first use.
    Fingerprint,
}

#[derive(Debug, clap::Subcommand)]
enum Approvals {
    /// Print approved browser identities.
    List,
    /// Remove an approved or pending browser identity.
    Revoke { code: String },
}

pub fn run(args: &Args) -> Result<()> {
    let state_dir = crate::paths::state_dir()?;
    match &args.command {
        Sub::Approve { code } => {
            let code = approvals::approve(&state_dir, code)?;
            if args.json {
                output::json(&CodeResult {
                    code: &code,
                    approved: true,
                })?;
            } else {
                output::line(format!("approved terminal `{code}`"))?;
            }
        }
        Sub::Approvals {
            command: Approvals::List,
        } => {
            let approvals = approvals::list(&state_dir)?;
            if args.json {
                output::json(&ApprovalList { approvals })?;
            } else if approvals.is_empty() {
                output::line("no approved terminal identities")?;
            } else {
                for entry in &approvals {
                    output::line(format!("`{}` `{}`", entry.code, entry.public_key))?;
                }
            }
        }
        Sub::Approvals {
            command: Approvals::Revoke { code },
        } => {
            let code = approvals::revoke(&state_dir, code)?;
            if args.json {
                output::json(&CodeResult {
                    code: &code,
                    approved: false,
                })?;
            } else {
                output::line(format!("revoked terminal approval `{code}`"))?;
            }
        }
        Sub::Fingerprint => {
            let identity = terminal_identity::load_or_create(&state_dir)?;
            let fingerprint = identity.fingerprint();
            if args.json {
                output::json(&FingerprintResult {
                    fingerprint: &fingerprint,
                    public_key: identity.public_b64url(),
                    path: terminal_identity::identity_path(&state_dir)
                        .display()
                        .to_string(),
                })?;
            } else {
                output::line(fingerprint)?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintResult<'a> {
    fingerprint: &'a str,
    public_key: String,
    path: String,
}

#[derive(Debug, Serialize)]
struct CodeResult<'a> {
    code: &'a str,
    approved: bool,
}

#[derive(Debug, Serialize)]
struct ApprovalList {
    approvals: Vec<ApprovalEntry>,
}
