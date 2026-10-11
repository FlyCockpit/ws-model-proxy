//! Canonical JSON and the relay 3.0 `launchHash`.
//!
//! Mirrors `packages/api/src/lib/canonical-json.ts`; the shared vectors are
//! `tests/fixtures/relay-3.0/canonical/vectors.json`. Rules: object keys sorted by
//! Unicode code point (UTF-8 byte order), no whitespace, strings escaped like
//! `JSON.stringify`, integers within ±(2^53 − 1) as integers (`2.0` → `2`,
//! `-0` → `0`), other numbers finite with 1e-6 ≤ |x| < 1e15 in their shortest
//! round-trip decimal form without an exponent. Anything else is refused.
//!
//! The node hashes the `spec` JSON exactly as received, never a re-serialized
//! struct, so an unknown or reordered field can never yield a matching hash.

use std::fmt::Write as _;

use anyhow::{Result, bail};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// The canonical text of `value`.
pub fn canonical_json(value: &Value) -> Result<String> {
    let mut out = String::new();
    write_value(value, "$", &mut out)?;
    Ok(out)
}

/// Lower-case hex SHA-256 of the canonical text.
pub fn canonical_sha256(value: &Value) -> Result<String> {
    let text = canonical_json(value)?;
    let digest = Sha256::digest(text.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

/// `launchHash = sha256(canonical(spec))`, the only definition identity a node
/// sees (define envelopes, held/frozen records, every `runtime.job`).
pub fn launch_hash(spec: &Value) -> Result<String> {
    canonical_sha256(spec)
}

fn write_value(value: &Value, path: &str, out: &mut String) -> Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => write_number(number, path, out)?,
        Value::String(text) => out.push_str(&serde_json::to_string(text)?),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, &format!("{path}[{index}]"), out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // Sort explicitly: serde_json may preserve insertion order when a
            // dependency enables `preserve_order`. `str` order is UTF-8 byte
            // order, which equals code point order.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key)?);
                out.push(':');
                if let Some(member) = map.get(key) {
                    write_value(member, &format!("{path}.{key}"), out)?;
                }
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_number(number: &serde_json::Number, path: &str, out: &mut String) -> Result<()> {
    if let Some(unsigned) = number.as_u64() {
        if unsigned > MAX_SAFE_INTEGER {
            bail!("unsafe integer at {path}");
        }
        let _ = write!(out, "{unsigned}");
        return Ok(());
    }
    if let Some(signed) = number.as_i64() {
        if signed.unsigned_abs() > MAX_SAFE_INTEGER {
            bail!("unsafe integer at {path}");
        }
        let _ = write!(out, "{signed}");
        return Ok(());
    }
    let Some(float) = number.as_f64() else {
        bail!("unsupported number at {path}");
    };
    if !float.is_finite() {
        bail!("non-finite number at {path}");
    }
    if float.fract() == 0.0 {
        if float.abs() > MAX_SAFE_INTEGER as f64 {
            bail!("unsafe integer at {path}");
        }
        if float == 0.0 {
            out.push('0');
        } else {
            // Integral and within ±2^53, so the conversion is exact.
            let _ = write!(out, "{}", float as i64);
        }
        return Ok(());
    }
    let magnitude = float.abs();
    if !(1e-6..1e15).contains(&magnitude) {
        bail!("number outside the canonical range at {path}");
    }
    // `Display` for f64 is the shortest round-trip form and never uses an
    // exponent, which matches JavaScript `String(x)` inside this range.
    let _ = write!(out, "{float}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/relay-3.0")
    }

    #[test]
    fn matches_the_shared_vectors() {
        let text = std::fs::read_to_string(fixtures().join("canonical/vectors.json"))
            .expect("vectors.json is readable");
        let vectors: Value = serde_json::from_str(&text).expect("vectors.json is JSON");
        let valid = vectors["valid"].as_array().expect("valid vectors");
        assert!(!valid.is_empty());
        for vector in valid {
            let name = vector["name"].as_str().unwrap_or_default();
            let input: Value = serde_json::from_str(vector["json"].as_str().unwrap_or_default())
                .expect("vector input parses");
            assert_eq!(
                canonical_json(&input).expect("canonical"),
                vector["canonical"].as_str().unwrap_or_default(),
                "{name}"
            );
            assert_eq!(
                canonical_sha256(&input).expect("hash"),
                vector["sha256"].as_str().unwrap_or_default(),
                "{name}"
            );
        }
        for vector in vectors["invalid"].as_array().expect("invalid vectors") {
            let name = vector["name"].as_str().unwrap_or_default();
            let refused =
                match serde_json::from_str::<Value>(vector["json"].as_str().unwrap_or_default()) {
                    // serde_json already refuses lone surrogates while parsing.
                    Err(_) => true,
                    Ok(input) => canonical_json(&input).is_err(),
                };
            assert!(refused, "{name} must be refused");
        }
    }
}
