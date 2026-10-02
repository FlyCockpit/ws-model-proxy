//! Versioned crash map written into a recovery directory before the first
//! public capture. A reader uses `phase` and per-slot identity to roll forward
//! or back; raw path bytes sit next to a lossy display string.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::resolve::{Kind, Stat};
use super::stat::kind_name;

/// Current on-disk INTENT schema. Version 1 was an untyped slot-to-path map.
pub const INTENT_VERSION: u32 = 2;

/// Largest INTENT we will parse (recover / startup).
pub const INTENT_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntentOp {
    Rename,
    Replace,
    Delete,
}

/// Which side of the commit point a crash landed on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntentPhase {
    /// INTENT is durable; no public name has moved yet.
    Prepared,
    /// At least one public object is in R; the rename/replace/delete has not
    /// committed.
    Captured,
    /// The public commit has taken effect. Remaining slots are leftovers to
    /// dispose, not restore.
    Committed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[allow(clippy::enum_variant_names)]
pub enum IntentOrder {
    LinkFirst,
    VacateFirst,
    ExchangeFirst,
}

/// Absolute path as a lossy display string plus hex-encoded raw bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntentPath {
    pub display: String,
    pub bytes: String,
}

impl IntentPath {
    pub fn from_path(path: &Path) -> Self {
        Self {
            display: path.to_string_lossy().into_owned(),
            bytes: encode_hex(path.as_os_str().as_bytes()),
        }
    }

    pub fn to_path(&self) -> Option<PathBuf> {
        decode_hex(&self.bytes).map(|raw| PathBuf::from(OsString::from_vec(raw)))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntentSlot {
    pub origin: IntentPath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dev: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ino: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

impl IntentSlot {
    pub fn planned(origin: &Path) -> Self {
        Self {
            origin: IntentPath::from_path(origin),
            dev: None,
            ino: None,
            kind: None,
            size: None,
        }
    }

    pub fn with_stat(mut self, stat: &Stat) -> Self {
        self.dev = Some(stat.dev);
        self.ino = Some(stat.ino);
        self.kind = Some(kind_name(stat.kind()).to_string());
        self.size = Some(stat.size);
        self
    }

    pub fn matches(&self, stat: &Stat) -> bool {
        match (self.dev, self.ino) {
            (Some(dev), Some(ino)) => stat.dev == dev && stat.ino == ino,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub version: u32,
    pub op: IntentOp,
    pub phase: IntentPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<IntentOrder>,
    pub source: IntentPath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<IntentPath>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub slots: BTreeMap<String, IntentSlot>,
    pub pid: u32,
    pub host: String,
    pub created_at: String,
    pub cli_version: String,
}

impl Intent {
    pub fn new(
        op: IntentOp,
        order: Option<IntentOrder>,
        source: &Path,
        destination: Option<&Path>,
        slots: BTreeMap<String, IntentSlot>,
    ) -> Self {
        Self {
            version: INTENT_VERSION,
            op,
            phase: IntentPhase::Prepared,
            order,
            source: IntentPath::from_path(source),
            destination: destination.map(IntentPath::from_path),
            slots,
            pid: std::process::id(),
            host: crate::hostname::reported_hostname().unwrap_or_else(|| "unknown".to_string()),
            created_at: crate::telemetry::now_rfc3339(),
            cli_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    pub fn rename(order: IntentOrder, from: &Path, to: &Path, overwrite: bool) -> Self {
        let slots = planned_rename_slots(order, from, to, overwrite);
        Self::new(IntentOp::Rename, Some(order), from, Some(to), slots)
    }

    pub fn replace(path: &Path) -> Self {
        let mut slots = BTreeMap::new();
        slots.insert("slot-1".to_string(), IntentSlot::planned(path));
        Self::new(IntentOp::Replace, None, path, None, slots)
    }

    pub fn delete(path: &Path) -> Self {
        let mut slots = BTreeMap::new();
        slots.insert("slot-1".to_string(), IntentSlot::planned(path));
        Self::new(IntentOp::Delete, None, path, None, slots)
    }

    pub fn summary(&self) -> IntentSummary {
        IntentSummary {
            op: intent_op_name(self.op).to_string(),
            phase: intent_phase_name(self.phase).to_string(),
            order: self.order.map(intent_order_name).map(str::to_string),
            source: self.source.display.clone(),
            destination: self.destination.as_ref().map(|path| path.display.clone()),
            pid: self.pid,
            host: self.host.clone(),
            created_at: self.created_at.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentSummary {
    pub op: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<String>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    pub pid: u32,
    pub host: String,
    pub created_at: String,
}

pub fn planned_rename_slots(
    order: IntentOrder,
    from: &Path,
    to: &Path,
    overwrite: bool,
) -> BTreeMap<String, IntentSlot> {
    let mut slots = BTreeMap::new();
    match order {
        IntentOrder::LinkFirst if overwrite => {
            slots.insert("slot-1".to_string(), IntentSlot::planned(to));
            slots.insert("slot-2".to_string(), IntentSlot::planned(from));
        }
        IntentOrder::ExchangeFirst if overwrite => {
            slots.insert("slot-1".to_string(), IntentSlot::planned(to));
        }
        _ => {
            slots.insert("slot-1".to_string(), IntentSlot::planned(from));
            if overwrite {
                slots.insert("slot-2".to_string(), IntentSlot::planned(to));
            }
        }
    }
    slots
}

pub fn parse_intent(bytes: &[u8]) -> Result<Intent, String> {
    if bytes.len() > INTENT_MAX_BYTES {
        return Err("INTENT is larger than 64 KiB".to_string());
    }
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|err| format!("INTENT is not JSON: {err}"))?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if version != u64::from(INTENT_VERSION) {
        return Err(format!("INTENT version {version} is not supported"));
    }
    serde_json::from_value(value).map_err(|err| format!("INTENT is malformed: {err}"))
}

pub fn intent_op_name(op: IntentOp) -> &'static str {
    match op {
        IntentOp::Rename => "rename",
        IntentOp::Replace => "replace",
        IntentOp::Delete => "delete",
    }
}

pub fn intent_phase_name(phase: IntentPhase) -> &'static str {
    match phase {
        IntentPhase::Prepared => "prepared",
        IntentPhase::Captured => "captured",
        IntentPhase::Committed => "committed",
    }
}

pub fn intent_order_name(order: IntentOrder) -> &'static str {
    match order {
        IntentOrder::LinkFirst => "link-first",
        IntentOrder::VacateFirst => "vacate-first",
        IntentOrder::ExchangeFirst => "exchange-first",
    }
}

pub fn kind_from_name(name: &str) -> Option<Kind> {
    match name {
        "file" => Some(Kind::File),
        "dir" => Some(Kind::Dir),
        "symlink" => Some(Kind::Symlink),
        "other" => Some(Kind::Other),
        _ => None,
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    for chunk in bytes.chunks(2) {
        let hi = from_hex(chunk[0])?;
        let lo = from_hex(chunk[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_non_utf8_path_bytes() {
        let raw = OsString::from_vec(b"dir/\xffile".to_vec());
        let path = PathBuf::from(raw);
        let encoded = IntentPath::from_path(&path);
        assert!(encoded.display.contains('\u{FFFD}') || encoded.display.contains("ile"));
        assert_eq!(encoded.to_path().as_ref(), Some(&path));
    }

    #[test]
    fn parse_rejects_oversize_and_v1() {
        assert!(parse_intent(&[b'x'; INTENT_MAX_BYTES + 1]).is_err());
        assert!(parse_intent(br#"{"version":1,"order":"link-first"}"#).is_err());
    }
}
