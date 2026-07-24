//! Optional CLI-side media expansion for offline / data-URL-only upstreams.
//!
//! Many local OpenAI-compatible servers (llama.cpp, LM Studio, some vLLM builds)
//! cannot fetch remote URLs, so a signed `{origin}/media/{id}` reference in a
//! chat request never resolves. When the selected endpoint opts in
//! (`expandMedia`), the relay buffers a chat-shaped JSON request body, fetches
//! each media URL that belongs to the connected WMP server, and inlines it as a
//! `data:` URL before forwarding upstream.
//!
//! This module holds the pure, network-free logic: trusted-origin matching, the
//! JSON content-part walker, base64 encoding, and the error taxonomy. The daemon
//! supplies the actual HTTP fetcher so this code stays unit-testable.

use serde_json::Value;
use url::{Origin, Url};

use crate::protocol::RelayFailure;

/// Hard ceiling on both the buffered request body and the transformed body after
/// base64 inflation (~4/3 growth). Bodies above this fail fast instead of
/// exhausting memory on the user's machine.
pub const MEDIA_EXPAND_MAX_BODY_BYTES: usize = 256 * 1024 * 1024;

/// Tighter per-asset ceiling enforced while reading each individual media fetch
/// response. Server-side uploads default to 25 MiB, so 64 MiB is generous
/// headroom for one asset without letting a single fetch consume the whole
/// 256 MiB body budget. Over-cap fetches fail with `AssetTooLarge`.
pub const MEDIA_EXPAND_MAX_ASSET_BYTES: usize = 64 * 1024 * 1024;

/// The URL-path prefix identifying a WMP signed media reference.
const MEDIA_PATH_PREFIX: &str = "/media/";

/// Bytes fetched for one media reference, plus the upstream content type used to
/// build the `data:` URL mime.
#[derive(Debug, Clone)]
pub struct FetchedMedia {
    pub content_type: Option<String>,
    pub bytes: Vec<u8>,
}

impl FetchedMedia {
    /// The mime to embed in the `data:` URL. Strips any `; charset=…` parameters
    /// and falls back to a generic binary type when the server omitted one.
    fn mime(&self) -> &str {
        self.content_type
            .as_deref()
            .map(|value| value.split(';').next().unwrap_or(value).trim())
            .filter(|value| !value.is_empty())
            .unwrap_or("application/octet-stream")
    }
}

/// A failure while expanding media. Carries only the URL *path* (never the `sig`
/// query parameter) so error frames relayed back never echo the signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaExpandError {
    /// Transport-level failure (connect, timeout, read) fetching an asset.
    Fetch { path: String, reason: String },
    /// The media endpoint answered with a non-200 status.
    Status { path: String, status: u16 },
    /// A single fetched asset exceeded the byte cap.
    AssetTooLarge { path: String },
    /// The buffered request body exceeded the cap before expansion.
    InputTooLarge,
    /// The transformed body exceeded the cap after base64 inflation.
    BodyTooLarge,
}

impl MediaExpandError {
    pub fn relay_failure(&self) -> RelayFailure {
        match self {
            Self::Fetch { .. } => RelayFailure::Transport,
            Self::Status { status, .. } if (500..600).contains(status) => RelayFailure::Upstream5xx,
            Self::Status { status, .. } if (400..500).contains(status) => RelayFailure::Upstream4xx,
            Self::Status { .. } => RelayFailure::Transport,
            Self::AssetTooLarge { .. } | Self::InputTooLarge | Self::BodyTooLarge => {
                RelayFailure::RequestTooLarge
            }
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Fetch { path, reason } => format!("failed to fetch media `{path}`: {reason}"),
            Self::Status { path, status } => {
                format!("failed to fetch media `{path}`: upstream returned status {status}")
            }
            Self::AssetTooLarge { path } => format!(
                "media asset `{path}` exceeds the {MEDIA_EXPAND_MAX_ASSET_BYTES} byte per-asset fetch cap"
            ),
            Self::InputTooLarge => format!(
                "request body exceeds the {MEDIA_EXPAND_MAX_BODY_BYTES} byte cap before media expansion"
            ),
            Self::BodyTooLarge => format!(
                "request body exceeds the {MEDIA_EXPAND_MAX_BODY_BYTES} byte cap after media expansion"
            ),
        }
    }
}

/// The set of origins whose `/media/{id}` URLs the relay may fetch. Always
/// includes the connected WMP server's origin; never fetches arbitrary URLs from
/// request bodies (SSRF guard against prompt injection).
#[derive(Debug, Clone, Default)]
pub struct TrustedOrigins {
    origins: Vec<Origin>,
}

impl TrustedOrigins {
    /// Build from the configured server URL plus any operator-listed extra
    /// origins. Unparsable or non-HTTP(S) entries are ignored.
    pub fn new(server_url: Option<&str>, extra: &[String]) -> Self {
        let mut origins = Vec::new();
        if let Some(server_url) = server_url {
            push_origin(&mut origins, server_url);
        }
        for entry in extra {
            push_origin(&mut origins, entry);
        }
        Self { origins }
    }

    /// True when `url` is an HTTP(S) `/media/{id}` reference on a trusted origin.
    pub fn is_media_url(&self, url: &Url) -> bool {
        matches!(url.scheme(), "http" | "https")
            && is_media_path(url.path())
            && self.origins.iter().any(|origin| *origin == url.origin())
    }
}

fn push_origin(origins: &mut Vec<Origin>, raw: &str) {
    if let Ok(url) = Url::parse(raw) {
        if matches!(url.scheme(), "http" | "https") {
            let origin = url.origin();
            if origin.is_tuple() && !origins.contains(&origin) {
                origins.push(origin);
            }
        }
    }
}

fn is_media_path(path: &str) -> bool {
    path.strip_prefix(MEDIA_PATH_PREFIX)
        .is_some_and(|rest| !rest.is_empty())
}

/// Expand trusted media URLs in a chat-shaped JSON body into `data:` URLs.
///
/// Returns the transformed bytes. If the body is not JSON, has no chat
/// `messages`, or references no trusted media URL, the original bytes are
/// returned unchanged (still sent sized upstream). `fetch` performs the actual
/// HTTP GET; it is injected so this function stays network-free for tests.
pub fn expand_media_in_body(
    body: &[u8],
    trusted: &TrustedOrigins,
    fetch: &dyn Fn(&Url) -> Result<FetchedMedia, MediaExpandError>,
    max_bytes: usize,
) -> Result<Vec<u8>, MediaExpandError> {
    if body.len() > max_bytes {
        return Err(MediaExpandError::InputTooLarge);
    }
    let mut value: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        // Non-JSON bodies pass through untouched on the sized path.
        Err(_) => return Ok(body.to_vec()),
    };

    let mut changed = false;
    walk_messages(&mut value, trusted, fetch, &mut changed)?;
    if !changed {
        return Ok(body.to_vec());
    }

    let transformed = serde_json::to_vec(&value).map_err(|error| MediaExpandError::Fetch {
        path: "<body>".to_string(),
        reason: format!("re-serializing expanded body failed: {error}"),
    })?;
    if transformed.len() > max_bytes {
        return Err(MediaExpandError::BodyTooLarge);
    }
    Ok(transformed)
}

fn walk_messages(
    value: &mut Value,
    trusted: &TrustedOrigins,
    fetch: &dyn Fn(&Url) -> Result<FetchedMedia, MediaExpandError>,
    changed: &mut bool,
) -> Result<(), MediaExpandError> {
    let Some(messages) = value.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for message in messages {
        let Some(parts) = message.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        for part in parts {
            expand_part(part, trusted, fetch, changed)?;
        }
    }
    Ok(())
}

fn expand_part(
    part: &mut Value,
    trusted: &TrustedOrigins,
    fetch: &dyn Fn(&Url) -> Result<FetchedMedia, MediaExpandError>,
    changed: &mut bool,
) -> Result<(), MediaExpandError> {
    let Some(kind) = part.get("type").and_then(Value::as_str) else {
        return Ok(());
    };
    // `input_audio` carries the reference under `data`; image/video under `url`.
    let (container, field) = match kind {
        "image_url" => ("image_url", "url"),
        "video_url" => ("video_url", "url"),
        "input_audio" => ("input_audio", "data"),
        _ => return Ok(()),
    };
    let Some(field_value) = part.get_mut(container).and_then(|obj| obj.get_mut(field)) else {
        return Ok(());
    };
    let Some(reference) = field_value.as_str() else {
        return Ok(());
    };
    // Raw base64 (no scheme) and `data:` URLs never parse into a trusted media
    // URL, so they fall through as passthrough.
    let Ok(url) = Url::parse(reference) else {
        return Ok(());
    };
    if !trusted.is_media_url(&url) {
        return Ok(());
    }

    let fetched = fetch(&url)?;
    let data_url = format!(
        "data:{};base64,{}",
        fetched.mime(),
        base64_encode(&fetched.bytes)
    );
    *field_value = Value::String(data_url);
    *changed = true;
    Ok(())
}

/// Standard base64 (RFC 4648, `+/`, padded). Kept in-crate to avoid a new direct
/// dependency for a few lines of well-understood encoding.
pub fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let bits = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((bits >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((bits >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((bits >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(bits & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const SERVER: &str = "https://relay.example.test";

    /// Records fetched URLs and returns canned bytes so the walker stays offline.
    struct FakeFetcher {
        calls: RefCell<Vec<String>>,
    }

    impl FakeFetcher {
        fn new() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
            }
        }

        fn fetch(&self, url: &Url) -> Result<FetchedMedia, MediaExpandError> {
            self.calls.borrow_mut().push(url.as_str().to_string());
            Ok(FetchedMedia {
                content_type: Some("image/png".to_string()),
                bytes: b"PNGDATA".to_vec(),
            })
        }
    }

    fn trusted() -> TrustedOrigins {
        TrustedOrigins::new(Some(SERVER), &[])
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn origin_matching_accepts_server_and_extra_origins() {
        let trusted = TrustedOrigins::new(Some(SERVER), &["https://cdn.example.test".to_string()]);
        assert!(trusted.is_media_url(&Url::parse("https://relay.example.test/media/abc").unwrap()));
        assert!(trusted.is_media_url(&Url::parse("https://cdn.example.test/media/xyz").unwrap()));
        // Wrong origin, wrong path, and non-http schemes are all rejected.
        assert!(!trusted.is_media_url(&Url::parse("https://evil.example.test/media/abc").unwrap()));
        assert!(
            !trusted.is_media_url(&Url::parse("https://relay.example.test/other/abc").unwrap())
        );
        assert!(!trusted.is_media_url(&Url::parse("https://relay.example.test/media/").unwrap()));
        assert!(!trusted.is_media_url(&Url::parse("file:///media/abc").unwrap()));
    }

    #[test]
    fn origin_matching_is_port_and_scheme_sensitive() {
        let trusted = TrustedOrigins::new(Some("http://localhost:8080"), &[]);
        assert!(trusted.is_media_url(&Url::parse("http://localhost:8080/media/a").unwrap()));
        assert!(!trusted.is_media_url(&Url::parse("http://localhost:9090/media/a").unwrap()));
        assert!(!trusted.is_media_url(&Url::parse("https://localhost:8080/media/a").unwrap()));
    }

    #[test]
    fn expands_image_video_and_audio_url_parts() {
        let body = serde_json::json!({
            "model": "omni",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "hi" },
                        { "type": "image_url", "image_url": { "url": "https://relay.example.test/media/img?exp=1&sig=secret" } },
                        { "type": "video_url", "video_url": { "url": "https://relay.example.test/media/vid?sig=secret" }, "fps": 2 },
                        { "type": "input_audio", "input_audio": { "data": "https://relay.example.test/media/aud?sig=secret", "format": "wav" } }
                    ]
                }
            ]
        });
        let bytes = serde_json::to_vec(&body).unwrap();
        let fetcher = FakeFetcher::new();
        let out = expand_media_in_body(
            &bytes,
            &trusted(),
            &|url| fetcher.fetch(url),
            MEDIA_EXPAND_MAX_BODY_BYTES,
        )
        .expect("expand");
        let parsed: Value = serde_json::from_slice(&out).unwrap();
        let parts = &parsed["messages"][0]["content"];
        assert_eq!(parts[0]["text"], "hi");
        let expected = format!("data:image/png;base64,{}", base64_encode(b"PNGDATA"));
        assert_eq!(parts[1]["image_url"]["url"], expected);
        assert_eq!(parts[2]["video_url"]["url"], expected);
        assert_eq!(parts[3]["input_audio"]["data"], expected);
        // Sibling fields survive.
        assert_eq!(parts[2]["fps"], 2);
        assert_eq!(parts[3]["input_audio"]["format"], "wav");
        assert_eq!(fetcher.calls.borrow().len(), 3);
    }

    #[test]
    fn non_trusted_and_data_urls_pass_through_untouched() {
        let body = serde_json::json!({
            "messages": [
                {
                    "content": [
                        { "type": "image_url", "image_url": { "url": "https://evil.example.test/media/x" } },
                        { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
                        { "type": "input_audio", "input_audio": { "data": "cmF3YmFzZTY0" } }
                    ]
                }
            ]
        });
        let bytes = serde_json::to_vec(&body).unwrap();
        let fetcher = FakeFetcher::new();
        let out = expand_media_in_body(
            &bytes,
            &trusted(),
            &|url| fetcher.fetch(url),
            MEDIA_EXPAND_MAX_BODY_BYTES,
        )
        .expect("expand");
        assert_eq!(out, bytes);
        assert!(fetcher.calls.borrow().is_empty());
    }

    #[test]
    fn non_json_body_passes_through() {
        let raw = b"not json at all";
        let fetcher = FakeFetcher::new();
        let out = expand_media_in_body(
            raw,
            &trusted(),
            &|url| fetcher.fetch(url),
            MEDIA_EXPAND_MAX_BODY_BYTES,
        )
        .expect("expand");
        assert_eq!(out, raw);
    }

    #[test]
    fn fetch_failure_names_path_without_signature() {
        let body = serde_json::json!({
            "messages": [
                { "content": [
                    { "type": "image_url", "image_url": { "url": "https://relay.example.test/media/img?sig=TOPSECRET" } }
                ] }
            ]
        });
        let bytes = serde_json::to_vec(&body).unwrap();
        let err = expand_media_in_body(
            &bytes,
            &trusted(),
            &|_url| {
                Err(MediaExpandError::Status {
                    path: "/media/img".to_string(),
                    status: 404,
                })
            },
            MEDIA_EXPAND_MAX_BODY_BYTES,
        )
        .expect_err("should fail");
        assert_eq!(err.relay_failure(), RelayFailure::Upstream4xx);
        let message = err.message();
        assert!(message.contains("/media/img"));
        assert!(!message.contains("TOPSECRET"));
        assert!(!message.contains("sig"));
    }

    #[test]
    fn input_over_cap_is_rejected_before_parsing() {
        let fetcher = FakeFetcher::new();
        let err = expand_media_in_body(
            b"{\"messages\":[]}",
            &trusted(),
            &|url| fetcher.fetch(url),
            4,
        )
        .expect_err("cap");
        assert_eq!(err, MediaExpandError::InputTooLarge);
    }

    #[test]
    fn transformed_over_cap_is_rejected() {
        let body = serde_json::json!({
            "messages": [
                { "content": [
                    { "type": "image_url", "image_url": { "url": "https://relay.example.test/media/img" } }
                ] }
            ]
        });
        let bytes = serde_json::to_vec(&body).unwrap();
        // The input fits, but the fetched asset inflates the body past the cap.
        let err = expand_media_in_body(
            &bytes,
            &trusted(),
            &|_url| {
                Ok(FetchedMedia {
                    content_type: Some("image/png".to_string()),
                    bytes: vec![0_u8; 4096],
                })
            },
            bytes.len() + 16,
        )
        .expect_err("cap");
        assert_eq!(err, MediaExpandError::BodyTooLarge);
    }

    #[test]
    fn string_content_and_missing_messages_are_ignored() {
        let body = serde_json::json!({
            "messages": [
                { "role": "system", "content": "plain string content" }
            ]
        });
        let bytes = serde_json::to_vec(&body).unwrap();
        let fetcher = FakeFetcher::new();
        let out = expand_media_in_body(
            &bytes,
            &trusted(),
            &|url| fetcher.fetch(url),
            MEDIA_EXPAND_MAX_BODY_BYTES,
        )
        .expect("expand");
        assert_eq!(out, bytes);
        assert!(fetcher.calls.borrow().is_empty());
    }

    #[test]
    fn asset_cap_is_tighter_than_body_cap_and_named_in_error() {
        // The per-asset cap must sit below the whole-body ceiling so one fetch
        // cannot consume the entire budget, and the error must name that cap.
        const { assert!(MEDIA_EXPAND_MAX_ASSET_BYTES < MEDIA_EXPAND_MAX_BODY_BYTES) };
        assert_eq!(MEDIA_EXPAND_MAX_ASSET_BYTES, 64 * 1024 * 1024);
        let message = MediaExpandError::AssetTooLarge {
            path: "/media/big".to_string(),
        }
        .message();
        assert!(message.contains("/media/big"));
        assert!(message.contains(&MEDIA_EXPAND_MAX_ASSET_BYTES.to_string()));
    }

    #[test]
    fn mime_strips_charset_parameters() {
        let fetched = FetchedMedia {
            content_type: Some("image/jpeg; charset=binary".to_string()),
            bytes: Vec::new(),
        };
        assert_eq!(fetched.mime(), "image/jpeg");
        let missing = FetchedMedia {
            content_type: None,
            bytes: Vec::new(),
        };
        assert_eq!(missing.mime(), "application/octet-stream");
    }
}
