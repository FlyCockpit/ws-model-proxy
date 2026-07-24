//! Optional CLI-side media expansion for offline / data-URL-only upstreams.
//!
//! Many local OpenAI-compatible servers (llama.cpp, LM Studio, some vLLM builds)
//! cannot fetch remote URLs, so a signed `{origin}/media/{id}` reference in a
//! chat request never resolves. When the selected endpoint opts in
//! (`expandMedia`), the relay buffers a chat-shaped JSON request body, fetches
//! each media URL that belongs to the connected WMP server, and inlines it as a
//! `data:` URL before forwarding upstream.
//!
//! Still-image parts are normalized to model-inline-safe formats (JPEG/PNG)
//! when inlined — matching the shared product policy in
//! `@ws-model-proxy/config/media-policy`. WebP/GIF stored in the media store
//! therefore still work against local vision servers after expansion.
//!
//! This module holds the pure, network-free logic: trusted-origin matching, the
//! JSON content-part walker, base64 encoding, image normalization, and the
//! error taxonomy. The daemon supplies the actual HTTP fetcher so this code
//! stays unit-testable.

use std::io::Cursor;

use serde_json::Value;
use url::{Origin, Url};

use crate::protocol::RelayFailure;

/// JPEG quality used when re-encoding WebP/GIF (or other non-safe images) for
/// local upstreams. Matches the web composer's `DEFAULT_IMAGE_ENCODE_QUALITY`.
const INLINE_JPEG_QUALITY: u8 = 85;

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
    /// A fetched still image could not be normalized to JPEG/PNG for inline use.
    UnsupportedImage { path: String, reason: String },
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
            // Treat decode/convert failures like a bad request body from the
            // client's perspective (unsupported media for this relay path).
            Self::UnsupportedImage { .. } => RelayFailure::Upstream4xx,
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
            Self::UnsupportedImage { path, reason } => {
                format!("failed to normalize media image `{path}` for local upstream: {reason}")
            }
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
    // Clone the part kind so later mutable borrows of `part` do not conflict
    // with the temporary borrow from `get("type")`.
    let kind = part
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let Some(kind) = kind else {
        return Ok(());
    };
    // `input_audio` carries the reference under `data`; image/video under `url`.
    let (container, field) = match kind.as_str() {
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
    let path = media_path_for_errors(&url);
    // Still images are normalized to JPEG/PNG for local-server compatibility.
    // Video/audio keep their stored mime (no silent re-containerization here).
    let (mime, bytes) = if kind == "image_url" {
        prepare_image_for_inline(fetched, &path)?
    } else {
        (fetched.mime().to_string(), fetched.bytes)
    };
    let data_url = format!("data:{mime};base64,{}", base64_encode(&bytes));
    *field_value = Value::String(data_url);
    *changed = true;
    Ok(())
}

/// Path fragment used in error messages — never includes query (`sig`).
fn media_path_for_errors(url: &Url) -> String {
    url.path().to_string()
}

/// True when `mime` is safe to embed as a `data:` URL for local vision servers.
/// Keep aligned with `@ws-model-proxy/config/media-policy` `MODEL_INLINE_SAFE_IMAGE_MIMES`
/// (+ `image/jpg` alias, which TS normalizes to `image/jpeg`).
fn is_model_inline_safe_image_mime(mime: &str) -> bool {
    matches!(
        mime
            .split(';')
            .next()
            .unwrap_or(mime)
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "image/jpeg" | "image/jpg" | "image/png"
    )
}

/// Prepare fetched still-image bytes for a `data:` URL: passthrough JPEG/PNG,
/// re-encode WebP/GIF/other decodable images to JPEG.
fn prepare_image_for_inline(
    fetched: FetchedMedia,
    path: &str,
) -> Result<(String, Vec<u8>), MediaExpandError> {
    let mime = fetched.mime().to_string();
    if is_model_inline_safe_image_mime(&mime) {
        return Ok((normalize_safe_image_mime(&mime), fetched.bytes));
    }
    let jpeg = reencode_image_bytes_to_jpeg(&fetched.bytes).map_err(|reason| {
        MediaExpandError::UnsupportedImage {
            path: path.to_string(),
            reason,
        }
    })?;
    Ok(("image/jpeg".to_string(), jpeg))
}

fn normalize_safe_image_mime(mime: &str) -> String {
    let base = mime
        .split(';')
        .next()
        .unwrap_or(mime)
        .trim()
        .to_ascii_lowercase();
    if base == "image/jpg" {
        "image/jpeg".to_string()
    } else {
        base
    }
}

/// Decode arbitrary still-image bytes and re-encode as JPEG (quality
/// [`INLINE_JPEG_QUALITY`]). Used when the media store held WebP/GIF/etc.
///
/// Alpha is composited onto **white** before encode, matching the web chat-test
/// path (`image-attachments.ts` fills `#ffffff` before `drawImage`). A bare
/// `to_rgb8()` would matte transparent pixels to black and diverge from the
/// browser for screenshots, icons, and diagrams.
fn reencode_image_bytes_to_jpeg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes).map_err(|err| format!("decode failed: {err}"))?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    // White matte, then alpha-blend source over it (same as canvas white fill).
    let mut canvas = image::RgbaImage::from_pixel(width, height, image::Rgba([255, 255, 255, 255]));
    image::imageops::overlay(&mut canvas, &rgba, 0, 0);
    let rgb = image::DynamicImage::ImageRgba8(canvas).to_rgb8();
    let mut out = Vec::new();
    {
        let mut cursor = Cursor::new(&mut out);
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, INLINE_JPEG_QUALITY);
        encoder
            .encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|err| format!("jpeg encode failed: {err}"))?;
    }
    if out.is_empty() {
        return Err("jpeg encode produced empty output".to_string());
    }
    if out.get(0..3) != Some(&[0xff, 0xd8, 0xff]) {
        return Err("jpeg encode produced non-jpeg magic".to_string());
    }
    Ok(out)
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

    /// 1×1 PNG (valid magic). Used when the declared mime is WebP so expansion
    /// must re-encode rather than trust the Content-Type alone.
    fn tiny_png_bytes() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ]
    }

    #[test]
    fn prepare_image_passthroughs_png() {
        let png = tiny_png_bytes();
        let (mime, bytes) = prepare_image_for_inline(
            FetchedMedia {
                content_type: Some("image/png".to_string()),
                bytes: png.clone(),
            },
            "/media/x",
        )
        .expect("png");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, png);
    }

    #[test]
    fn prepare_image_passthroughs_jpeg_and_aliases_jpg() {
        // Minimal 1×1 JPEG (valid magic + short payload is enough for passthrough —
        // we do not re-decode safe mimes).
        let jpeg = vec![0xff, 0xd8, 0xff, 0xd9];
        let (mime, bytes) = prepare_image_for_inline(
            FetchedMedia {
                content_type: Some("image/jpeg".to_string()),
                bytes: jpeg.clone(),
            },
            "/media/j",
        )
        .expect("jpeg");
        assert_eq!(mime, "image/jpeg");
        assert_eq!(bytes, jpeg);

        let (mime_jpg, _) = prepare_image_for_inline(
            FetchedMedia {
                content_type: Some("image/jpg".to_string()),
                bytes: jpeg,
            },
            "/media/jpg",
        )
        .expect("jpg alias");
        assert_eq!(mime_jpg, "image/jpeg");
    }

    #[test]
    fn reencode_composites_transparent_pixels_on_white() {
        // Fully transparent RGBA → after white matte + JPEG, every sample must
        // be near-white. (Black matte from bare to_rgb8() would be near 0.)
        // Use a uniform transparent field so JPEG chroma from neighbors cannot
        // muddy the assertion.
        let img = image::RgbaImage::from_pixel(8, 8, image::Rgba([0, 0, 0, 0]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode png fixture");
        let jpeg = reencode_image_bytes_to_jpeg(&png).expect("to jpeg");
        let decoded = image::load_from_memory(&jpeg)
            .expect("decode jpeg")
            .to_rgb8();
        for pixel in decoded.pixels() {
            let [r, g, b] = pixel.0;
            assert!(
                r > 240 && g > 240 && b > 240,
                "expected white matte for transparent image, got {:?}",
                pixel.0
            );
        }
    }

    #[test]
    fn prepare_image_reencodes_webp_declared_bytes_to_jpeg() {
        // Bytes are a valid PNG; declared mime is WebP so we must normalize.
        let (mime, bytes) = prepare_image_for_inline(
            FetchedMedia {
                content_type: Some("image/webp".to_string()),
                bytes: tiny_png_bytes(),
            },
            "/media/webp",
        )
        .expect("normalize");
        assert_eq!(mime, "image/jpeg");
        assert_eq!(&bytes[0..3], &[0xff, 0xd8, 0xff]);
    }

    #[test]
    fn expand_normalizes_image_url_webp_to_jpeg_data_url() {
        let body = serde_json::json!({
            "messages": [{
                "content": [
                    { "type": "image_url", "image_url": { "url": "https://relay.example.test/media/w?sig=s" } }
                ]
            }]
        });
        let bytes = serde_json::to_vec(&body).unwrap();
        let out = expand_media_in_body(
            &bytes,
            &trusted(),
            &|_url| {
                Ok(FetchedMedia {
                    content_type: Some("image/webp".to_string()),
                    bytes: tiny_png_bytes(),
                })
            },
            MEDIA_EXPAND_MAX_BODY_BYTES,
        )
        .expect("expand");
        let parsed: Value = serde_json::from_slice(&out).unwrap();
        let url = parsed["messages"][0]["content"][0]["image_url"]["url"]
            .as_str()
            .expect("url");
        assert!(
            url.starts_with("data:image/jpeg;base64,"),
            "expected jpeg data url, got {url}"
        );
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
