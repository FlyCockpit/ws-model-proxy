//! This machine's hostname: reported in every relay hello and used to suggest
//! the CLI slug at `wsmp login`.
//!
//! The server stores the reported value as `CliDevice.reportedHostname`. It is
//! a fact about the machine, not a name the user chose; the dashboard owns the
//! device's display name.

use crate::slug::slugify;

/// Longest hostname sent, in characters (a DNS name is at most 253).
pub const MAX_CHARS: usize = 253;

/// This machine's hostname, trimmed, without control or format characters, and
/// bounded. `None` when unavailable or blank.
pub fn reported_hostname() -> Option<String> {
    normalize(raw_hostname())
}

/// A slug derived from this machine's hostname, or `None` when the hostname is
/// unavailable or yields no valid slug.
pub fn hostname_slug() -> Option<String> {
    reported_hostname().as_deref().and_then(slugify)
}

fn normalize(raw: Option<String>) -> Option<String> {
    let cleaned: String = raw?
        .chars()
        .filter(|ch| !ch.is_control() && !is_format_char(*ch))
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_CHARS)
        .collect();
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

/// Unicode general category `Cf` (format characters: bidi overrides,
/// zero-width characters, and similar), as of Unicode 15. The server strips
/// the same set (`\p{Cf}` in `normalizeReportedHostname`,
/// packages/config/src/cli-device-name.ts); std has no category lookup, so the
/// table is spelled out here. A character added to `Cf` later is still
/// stripped by the server.
fn is_format_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{00AD}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08E2}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{110BD}'
            | '\u{110CD}'
            | '\u{13430}'..='\u{1343F}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
    )
}

#[cfg(unix)]
fn raw_hostname() -> Option<String> {
    nix::unistd::gethostname()
        .ok()
        .and_then(|name| name.into_string().ok())
}

#[cfg(windows)]
fn raw_hostname() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(not(any(unix, windows)))]
fn raw_hostname() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_and_strips_control_characters() {
        assert_eq!(
            normalize(Some("  desk\u{0}-01\n".into())).as_deref(),
            Some("desk-01")
        );
    }

    #[test]
    fn strips_format_characters() {
        // U+202E right-to-left override, U+200B zero-width space, U+FEFF BOM.
        assert_eq!(
            normalize(Some("\u{202E}desk\u{200B}-01\u{FEFF}".into())).as_deref(),
            Some("desk-01")
        );
        assert_eq!(normalize(Some("\u{200B}\u{2066}".into())), None);
        assert!(!is_format_char('a') && !is_format_char('-') && !is_format_char('é'));
    }

    #[test]
    fn is_none_without_a_usable_hostname() {
        assert_eq!(normalize(None), None);
        assert_eq!(normalize(Some("   ".into())), None);
        assert_eq!(normalize(Some("\t\u{7}\n".into())), None);
    }

    #[test]
    fn bounds_long_hostnames() {
        let long = "a".repeat(300);
        assert_eq!(normalize(Some(long)).unwrap().chars().count(), MAX_CHARS);
    }
}
