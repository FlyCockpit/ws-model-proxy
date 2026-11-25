//! The rules serde cannot express: the error a broken cross-field rule
//! reads as, the chunk byte budgets, and the shapes of the ids, names,
//! versions and URLs the frames carry.

use serde::Serialize;

use crate::wire::protocol::canonical::canonical_json;

/// Byte budget of one chunked frame (define, its answer, inventory, node.metrics).
pub const CHUNK_BUDGET_BYTES: usize = 60 * 1024;

/// Versions one define chunk names (put + keep + remove).
pub const DEFINE_CHUNK_MAX_VERSIONS: usize = 64;

/// A node secret name: `WSMP_SECRET_` and 1 to 64 of `A-Z0-9_`.
pub fn is_secret_name(name: &str) -> bool {
    name.strip_prefix("WSMP_SECRET_").is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= 64
            && rest
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    })
}

/// A node's address on a fabric, exactly as the server and the database
/// accept it (`packages/api/src/lib/ip-literal.ts`, shared vectors in
/// `tests/fixtures/relay-4.0/rules/fabric-ip.json`): the canonical text of one
/// address (dotted quad without leading zeros, RFC 5952 IPv6 without an
/// embedded IPv4 part), never 0.0.0.0/8, loopback, `::/96` or IPv4-mapped.
pub fn is_fabric_ip(value: &str) -> bool {
    match value.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            let first = ip.octets()[0];
            ip.to_string() == value && first != 0 && first != 127
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            let segments = ip.segments();
            let first_80_zero = segments[..5].iter().all(|segment| *segment == 0);
            !value.contains('.')
                && ip.to_string() == value
                && !(first_80_zero && (segments[5] == 0 || segments[5] == 0xffff))
        }
        Err(_) => false,
    }
}

/// A node-derived interface or RDMA device name (`{{fabric_iface}}`,
/// `{{fabric_rdma_device}}`) is substituted into commands only when it is
/// plain: letters, digits, `_`, `.`, `:`, `-`, not starting with `-`, at most
/// 64 bytes. Anything else refuses the start instead of reaching a shell.
pub fn is_fabric_device_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// A cross-field rule a frame broke (the zod schemas refuse the same frames;
/// shared vectors: `relay-4.0/invalid/*/semantic-*.json`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameRuleError(pub &'static str);

impl std::fmt::Display for FrameRuleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for FrameRuleError {}

pub(super) fn rule(ok: bool, message: &'static str) -> Result<(), FrameRuleError> {
    if ok {
        Ok(())
    } else {
        Err(FrameRuleError(message))
    }
}

pub(super) fn canonical_len<T: Serialize>(value: &T) -> Option<usize> {
    let value = serde_json::to_value(value).ok()?;
    canonical_json(&value).ok().map(|text| text.len())
}

pub(super) fn encoded_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

/// A comma list of GPU indices (0–255), unique, at most 64: a rank's
/// `placeholders.gpu_ids` and a reservation's `gpuIds`.
pub fn is_gpu_ids(value: &str) -> bool {
    let parts: Vec<&str> = value.split(',').collect();
    let mut seen = std::collections::BTreeSet::new();
    !value.is_empty()
        && parts.len() <= 64
        && parts.iter().all(|part| {
            (part == &"0" || (!part.starts_with('0') && !part.is_empty()))
                && part.len() <= 3
                && part.bytes().all(|b| b.is_ascii_digit())
                && part.parse::<u16>().is_ok_and(|n| n <= 255)
                && seen.insert(*part)
        })
}

/// `^[A-Za-z0-9_-]{1,64}$` (the server's `rowIdSchema`).
pub fn is_row_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$` (the server's node slug).
pub fn is_node_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    let plain = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    (3..=63).contains(&bytes.len())
        && bytes.first().is_some_and(plain)
        && bytes.last().is_some_and(plain)
        && bytes.iter().all(|byte| plain(byte) || *byte == b'-')
        && !value.contains("--")
}

/// 22 base64url characters: a 16-byte id (`updateId`).
pub fn is_op_id_shaped(id: &str) -> bool {
    id.len() == 22
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// A git commit id: 40 lowercase hex characters.
pub fn is_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 64 lowercase hex characters.
pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A Rust target triple as `hello.node.build.target` carries it: 1-80 of `[A-Za-z0-9_.-]`.
pub fn is_target_triple(value: &str) -> bool {
    (1..=80).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// `MAJOR.MINOR.PATCH` with an optional `-pre` / `+build` of `[0-9A-Za-z.-]`, at most 64
/// characters (what `wsmp --version` prints after `wsmp `).
pub fn is_release_version(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let core_end = value.find(['-', '+']).unwrap_or(value.len());
    let (core, rest) = value.split_at(core_end);
    let numbers: Vec<&str> = core.split('.').collect();
    numbers.len() == 3
        && numbers.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
        })
        && rest
            .bytes()
            .skip(1)
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
        && (rest.is_empty() || rest.len() > 1)
}

/// `https://…`, or `http://` to `localhost`, `127.0.0.1` or `[::1]` (tests, development). At
/// most 2048 characters, no credentials.
pub fn is_update_artifact_url(value: &str) -> bool {
    if value.len() > 2048 {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => url.host().is_some(),
        "http" => match url.host() {
            Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
            Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
            None => false,
        },
        _ => false,
    }
}

/// `http://(127.0.0.1|[::1]|localhost):<1-5 digits>` with an optional `/v1`
/// (the TS `runtime.detected` `baseUrl` pattern).
pub(super) fn is_detected_base_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let Some(rest) = ["127.0.0.1:", "[::1]:", "localhost:"]
        .iter()
        .find_map(|host| rest.strip_prefix(host))
    else {
        return false;
    };
    let port = rest.strip_suffix("/v1").unwrap_or(rest);
    (1..=5).contains(&port.len()) && port.bytes().all(|byte| byte.is_ascii_digit())
}
