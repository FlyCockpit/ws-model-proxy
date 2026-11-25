//! The server URL and public origin: normalizing an origin, the plain-HTTP
//! warning, and the `wsmp config set-server` command suggested to fix a
//! mismatch.

use anyhow::{Context, Result};

/// Checks a public origin and returns its canonical form
/// (`scheme://host[:port]`, default port omitted).
///
/// It must be http or https with no credentials, path, query or fragment, and
/// its host an IP literal or a DNS name of ASCII letter, digit and hyphen
/// labels (after punycode). The URL parser alone accepts hosts such as
/// `a$(touch,x).com`; refusing them keeps every origin safe to show inside a
/// suggested shell command. Plain http is accepted: a LAN deployment's
/// `BETTER_AUTH_URL` can be http, and the pin is only the origin name the
/// hello signature binds; no traffic goes to it.
pub fn normalize_public_origin(value: &str) -> Result<String> {
    let url = url::Url::parse(value).context("the public origin is not a valid URL")?;
    match url.scheme() {
        "https" | "http" => {}
        other => anyhow::bail!("the public origin uses the unsupported scheme `{other}`"),
    }
    if !url.username().is_empty() || url.password().is_some() {
        anyhow::bail!("the public origin must not carry credentials");
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        anyhow::bail!("the public origin must be only `scheme://host[:port]`, with no path");
    }
    match url.host() {
        Some(url::Host::Ipv4(_) | url::Host::Ipv6(_)) => {}
        Some(url::Host::Domain(domain)) if is_plain_dns_name(domain) => {}
        _ => anyhow::bail!(
            "the public origin's host must be a DNS name of letters, digits and hyphens, or an IP address"
        ),
    }
    Ok(url.origin().ascii_serialization())
}

/// `a-b.example.com`: non-empty labels of ASCII letters, digits and inner
/// hyphens, at most 253 bytes.
fn is_plain_dns_name(domain: &str) -> bool {
    domain.len() <= 253
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

/// A warning for a plain-http server URL off loopback. Every request the CLI
/// makes goes to this URL, so its credential and relay traffic would cross
/// the network unencrypted.
pub fn server_url_http_warning(server_url: &str) -> Option<String> {
    let url = url::Url::parse(server_url).ok()?;
    (url.scheme() == "http" && !is_loopback_host(&url)).then(|| {
        format!(
            "warning: the server URL `{server_url}` uses plain http, so this CLI's credential \
             and relay traffic (prompts and responses) cross the network unencrypted. Use it \
             only on a network you trust"
        )
    })
}

/// The `wsmp config set-server` command that pins `origin`, with both
/// arguments single-quoted for the shell this CLI runs under: POSIX shells on
/// Unix, PowerShell on Windows. `None` when `origin` is not a valid public
/// origin in canonical form, so nothing unvalidated is ever suggested.
pub fn set_server_command(server_url: &str, origin: &str) -> Option<String> {
    let shell = if cfg!(windows) {
        Shell::PowerShell
    } else {
        Shell::Posix
    };
    set_server_command_for(shell, server_url, origin)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shell {
    Posix,
    PowerShell,
}

fn set_server_command_for(shell: Shell, server_url: &str, origin: &str) -> Option<String> {
    let canonical = normalize_public_origin(origin).ok()?;
    if canonical != origin {
        return None;
    }
    let quote = |value: &str| match shell {
        // POSIX: nothing is special inside '...'; a ' closes, escapes, reopens.
        Shell::Posix => format!("'{}'", value.replace('\'', r"'\''")),
        // PowerShell: '...' is verbatim; a ' is doubled. Its typographic
        // single quotes also delimit, so they are doubled as well.
        Shell::PowerShell => {
            let mut quoted = String::from("'");
            for ch in value.chars() {
                if matches!(ch, '\'' | '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}') {
                    quoted.push(ch);
                }
                quoted.push(ch);
            }
            quoted.push('\'');
            quoted
        }
    };
    Some(format!(
        "wsmp config set-server {} --public-origin {}",
        quote(server_url),
        quote(&canonical)
    ))
}

/// `localhost`, 127.0.0.0/8 or `::1`.
pub fn is_loopback_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_origin_hosts_are_plain_dns_names_or_ip_literals() {
        for (value, canonical) in [
            ("https://WSMP.example.com:443/", "https://wsmp.example.com"),
            (
                "https://wsmp.example.com:8443",
                "https://wsmp.example.com:8443",
            ),
            ("http://wsmp.lan:3000", "http://wsmp.lan:3000"),
            ("http://10.0.0.5:3000", "http://10.0.0.5:3000"),
            ("https://[2001:db8::1]", "https://[2001:db8::1]"),
            (
                "https://xn--bcher-kva.example",
                "https://xn--bcher-kva.example",
            ),
            (
                "https://b\u{fc}cher.example",
                "https://xn--bcher-kva.example",
            ),
        ] {
            assert_eq!(
                normalize_public_origin(value).unwrap(),
                canonical,
                "{value}"
            );
        }
        // Each of these parses as a URL; none may become a pin.
        // Built at run time so the source holds no literal credential URL for secret scanners.
        let with_credentials = format!("https://{}:{}@wsmp.example.com", "user", "pw");
        for value in [
            "https://a$({touch,pwned}).com",
            "https://a$(id).com",
            "https://a`id`.com",
            "https://a;id.com",
            "https://a&calc.com",
            "https://a'b.com",
            "https://a\"b.com",
            "https://a!b.com",
            "https://a*.com",
            "https://-a.com",
            "https://a-.com",
            "https://a..com",
            "https://a_b.com",
            "https://wsmp.example.com/app",
            with_credentials.as_str(),
            "ftp://wsmp.example.com",
        ] {
            assert!(normalize_public_origin(value).is_err(), "{value}");
        }
    }

    #[test]
    fn plain_http_server_urls_warn_off_loopback() {
        assert!(server_url_http_warning("http://10.0.0.5:3000").is_some());
        assert!(server_url_http_warning("http://wsmp.lan:3000/base").is_some());
        assert!(server_url_http_warning("http://127.0.0.1:3000").is_none());
        assert!(server_url_http_warning("http://localhost:3000").is_none());
        assert!(server_url_http_warning("https://wsmp.example.com").is_none());
    }

    #[test]
    fn suggested_set_server_commands_quote_both_arguments() {
        assert_eq!(
            set_server_command_for(
                Shell::Posix,
                "http://10.0.0.5:3000",
                "https://wsmp.example.com"
            )
            .unwrap(),
            "wsmp config set-server 'http://10.0.0.5:3000' --public-origin 'https://wsmp.example.com'"
        );
        // The local server URL is quoted too, even with quotes inside it.
        assert_eq!(
            set_server_command_for(
                Shell::Posix,
                "http://h/it's $(x)",
                "https://wsmp.example.com"
            )
            .unwrap(),
            "wsmp config set-server 'http://h/it'\\''s $(x)' --public-origin 'https://wsmp.example.com'"
        );
        assert_eq!(
            set_server_command_for(
                Shell::PowerShell,
                "http://h/it's \u{2019}$(x)",
                "https://wsmp.example.com"
            )
            .unwrap(),
            "wsmp config set-server 'http://h/it''s \u{2019}\u{2019}$(x)' --public-origin 'https://wsmp.example.com'"
        );
        // Never for an invalid or non-canonical origin.
        for origin in [
            "https://a$({touch,pwned}).com",
            "https://a'.com",
            "https://WSMP.example.com",
            "https://wsmp.example.com/",
            "null",
        ] {
            for shell in [Shell::Posix, Shell::PowerShell] {
                assert!(
                    set_server_command_for(shell, "http://10.0.0.5:3000", origin).is_none(),
                    "{origin}"
                );
            }
        }
    }
}
