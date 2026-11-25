//! Keyed content ETags (plan section 2.1).
//!
//! A strong etag is `"h:" + base64url(HMAC-SHA256(key, device, inode, bytes))[..22]`.
//! The key is random per daemon start, so an etag never lets a caller guess a
//! low-entropy secret offline from a known-shape file; binding it to the file
//! object stops the online version of the same guess (write a candidate file,
//! compare its etag with the masked file's). A restart invalidates every etag
//! (one extra `conflict`, which is safe), and so does replacing a file by a new
//! inode, which is a replacement anyway. Files over
//! [`STRONG_ETAG_MAX_BYTES`] get a weak `"w:"` etag over identity and
//! timestamps instead of a full read. The full reads themselves ([`load_all`],
//! cancellable in 1 MiB steps) live here too, since that limit caps them.

use std::fs::Metadata;
use std::io::Read;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng;
use sha2::{Digest, Sha256};

use super::meta::Stat;
use crate::services::file_ops::Cancel;
use crate::services::file_ops::error::{ErrorCode, FileError, FileResult};

/// Files at or below this size are hashed in full (also the cap for full-file
/// scans such as line counting and masking).
pub const STRONG_ETAG_MAX_BYTES: u64 = 64 * 1024 * 1024;

const ETAG_CHARS: usize = 22;
const BLOCK: usize = 64;

#[derive(Clone)]
pub struct EtagKey([u8; 32]);

impl std::fmt::Debug for EtagKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EtagKey(..)")
    }
}

impl EtagKey {
    /// A fresh random key; call once per daemon start.
    pub fn random() -> Self {
        let mut key = [0_u8; 32];
        rand::rng().fill_bytes(&mut key);
        Self(key)
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Strong etag of `bytes` held by the file object `stat` describes. The
    /// etag is bound to the object (device and inode): a second file with the
    /// same bytes, such as a guess an agent writes next to a masked value, gets a
    /// different etag, so an etag never confirms a guess of a masked value.
    pub fn strong(&self, stat: &Stat, bytes: &[u8]) -> String {
        // device, inode and modification time: a recycled inode number (delete, then
        // create a candidate) is a different file with a different mtime
        let identity = format!(
            "{}:{}:{}:{}:",
            stat.dev, stat.ino, stat.mtime_secs, stat.mtime_nanos
        );
        let mac = hmac_sha256(&self.0, &[b"strong:", identity.as_bytes(), bytes]);
        format!("h:{}", &URL_SAFE_NO_PAD.encode(mac)[..ETAG_CHARS])
    }

    /// Weak etag from file identity, size, and modification time.
    pub fn weak(&self, meta: &Metadata) -> String {
        self.weak_stat(&Stat::from_metadata(meta))
    }

    pub fn weak_stat(&self, stat: &Stat) -> String {
        let identity = format!(
            "{}:{}:{}:{}:{}",
            stat.dev, stat.ino, stat.size, stat.mtime_secs, stat.mtime_nanos
        );
        let mac = hmac_sha256(&self.0, &[b"weak:", identity.as_bytes()]);
        format!("w:{}", &URL_SAFE_NO_PAD.encode(mac)[..ETAG_CHARS])
    }

    /// The current etag of an open regular file: strong up to 64 MiB, weak above.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn current(
        &self,
        file: &mut std::fs::File,
        stat: &Stat,
        cancel: &Cancel,
    ) -> FileResult<String> {
        if stat.size > STRONG_ETAG_MAX_BYTES {
            return Ok(self.weak_stat(stat));
        }
        let bytes = load_all(file, stat, STRONG_ETAG_MAX_BYTES, cancel)?;
        Ok(self.strong(stat, &bytes))
    }
}

/// `Read::read_to_end` in 1 MiB steps, observing cancellation between them.
pub(crate) fn read_to_end_cancellable<R: Read>(
    mut reader: R,
    out: &mut Vec<u8>,
    cancel: &Cancel,
) -> FileResult<()> {
    loop {
        cancel.check()?;
        let n = reader.by_ref().take(1 << 20).read_to_end(out)?;
        if n == 0 {
            return Ok(());
        }
    }
}

/// Read the whole file (at most `max` bytes) from an open fd.
pub(crate) fn load_all(
    file: &mut std::fs::File,
    stat: &Stat,
    max: u64,
    cancel: &Cancel,
) -> FileResult<Vec<u8>> {
    if stat.size > max {
        return Err(FileError::new(
            ErrorCode::TooLarge,
            format!("file is larger than {max} bytes"),
        ));
    }
    let mut bytes = Vec::with_capacity(stat.size as usize);
    read_to_end_cancellable(file.take(max + 1), &mut bytes, cancel)?;
    if bytes.len() as u64 > max {
        return Err(FileError::new(
            ErrorCode::TooLarge,
            format!("file is larger than {max} bytes"),
        ));
    }
    Ok(bytes)
}

/// HMAC-SHA256 over the concatenation of `parts` (RFC 2104).
fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut block = [0_u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    for part in parts {
        inner.update(part);
    }
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc4231_case_2() {
        let mac = hmac_sha256(b"Jefe", &[b"what do ya want ", b"for nothing?"]);
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn hmac_long_key_is_hashed_first() {
        // RFC 4231 case 6: key of 131 bytes.
        let key = [0xaa_u8; 131];
        let mac = hmac_sha256(
            &key,
            &[b"Test Using Larger Than Block-Size Key - Hash Key First"],
        );
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn etag_is_keyed_stable_shaped_and_bound_to_the_file_object() {
        let dir = tempfile::tempdir().unwrap();
        let (p1, p2) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&p1, b"x").unwrap();
        std::fs::write(&p2, b"x").unwrap();
        // With identity: on Windows plain metadata has none, and the two files would differ only
        // when their modification times do.
        let s1 = crate::services::file_ops::fs::meta::Stat::of_path(&p1).unwrap();
        let s2 = crate::services::file_ops::fs::meta::Stat::of_path(&p2).unwrap();
        let a = EtagKey::from_bytes([1; 32]);
        let b = EtagKey::from_bytes([2; 32]);
        let one = a.strong(&s1, b"HF_TOKEN=hunter2\n");
        assert_eq!(one, a.strong(&s1, b"HF_TOKEN=hunter2\n"));
        assert_ne!(
            one,
            b.strong(&s1, b"HF_TOKEN=hunter2\n"),
            "key must change the etag"
        );
        assert_ne!(one, a.strong(&s1, b"HF_TOKEN=hunter3\n"));
        assert_ne!(
            one,
            a.strong(&s2, b"HF_TOKEN=hunter2\n"),
            "the same bytes in another file must not share an etag (no guess oracle)"
        );
        // the same device, inode and bytes with another modification time (a recycled inode
        // number is a different file) is a different etag
        let mut later = s1;
        later.mtime_secs += 1;
        assert_ne!(one, a.strong(&later, b"HF_TOKEN=hunter2\n"));
        assert!(one.starts_with("h:"));
        assert_eq!(one.len(), 2 + ETAG_CHARS);
        assert_ne!(one, EtagKey::random().strong(&s1, b"HF_TOKEN=hunter2\n"));
    }

    #[test]
    fn weak_etag_tracks_identity_and_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big");
        std::fs::write(&path, b"abc").unwrap();
        let key = EtagKey::from_bytes([3; 32]);
        let first = key.weak(&std::fs::metadata(&path).unwrap());
        assert!(first.starts_with("w:"));
        assert_eq!(first, key.weak(&std::fs::metadata(&path).unwrap()));
        std::fs::write(&path, b"abcd").unwrap();
        assert_ne!(first, key.weak(&std::fs::metadata(&path).unwrap()));
    }
}

#[cfg(test)]
mod cancel_tests {
    use super::*;

    /// A reader that cancels after handing out its first chunk.
    struct CancelAfterFirst<'a> {
        cancel: &'a Cancel,
        served: bool,
    }

    impl Read for CancelAfterFirst<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.served {
                return Ok(0);
            }
            self.served = true;
            self.cancel.cancel();
            let n = buf.len().min(1 << 20);
            buf[..n].fill(b'a');
            Ok(n)
        }
    }

    #[test]
    fn the_chunked_reader_observes_a_cancel_between_chunks() {
        let cancel = Cancel::new();
        let mut out = Vec::new();
        let r = read_to_end_cancellable(
            CancelAfterFirst {
                cancel: &cancel,
                served: false,
            },
            &mut out,
            &cancel,
        );
        assert_eq!(r.expect_err("cancelled").code, ErrorCode::Cancelled);
        assert!(
            !out.is_empty() && out.len() < 1 << 20,
            "only the first chunk was read"
        );
        // an uncancelled reader reads to the end
        let cancel = Cancel::new();
        let mut out = Vec::new();
        read_to_end_cancellable(&[7_u8; 3 << 20][..], &mut out, &cancel).unwrap();
        assert_eq!(out.len(), 3 << 20);
    }
}
