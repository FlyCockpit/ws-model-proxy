//! Versioned crash map written into a recovery directory before the first
//! public capture. v3 hardlink anchors keep identities allocated across restart;
//! readers never use serialized inode snapshots alone to authorize mutations.
//! Raw path bytes sit next to a lossy display string.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::services::file_ops::meta::{Stat, kind_name};

/// Current on-disk INTENT schema. v2 is read only for non-destructive reporting.
pub const INTENT_VERSION: u32 = 3;

/// Largest INTENT we will parse (recover / startup).
pub const INTENT_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntentOp {
    Rename,
    Replace,
    Delete,
    /// Exclusive create or an unplanned capture (Move-verification fallback).
    Create,
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
    /// Capture or its directory barriers are pending. An unproven capture must
    /// not become restoration authority after restart. A capture after a
    /// durable `Committed` record keeps `Committed`.
    Capturing,
    /// Publication/deletion may have taken effect, but validated durable commit
    /// is not yet proven. Never infer rollback or disposal from this fence.
    Publishing,
    /// Rejected publication is being undone using the recorded origin map.
    /// Public publication identity must not re-upgrade this to committed.
    Compensating,
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
    /// Private hardlink holding the inode alive across process death. A stored
    /// dev/inode pair alone is never recovery ownership evidence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
}

impl IntentSlot {
    pub fn planned(origin: &Path) -> Self {
        Self {
            origin: IntentPath::from_path(origin),
            dev: None,
            ino: None,
            kind: None,
            size: None,
            anchor: None,
        }
    }

    pub fn with_stat(mut self, stat: &Stat) -> Self {
        self.dev = Some(stat.dev);
        self.ino = Some(stat.ino);
        self.kind = Some(kind_name(stat.kind()).to_string());
        self.size = Some(stat.size);
        self
    }

    /// Snapshot consistency only. This does NOT prove ownership after restart.
    pub fn matches(&self, stat: &Stat) -> bool {
        match (self.dev, self.ino) {
            (Some(dev), Some(ino)) => stat.dev == dev && stat.ino == ino,
            _ => false,
        }
    }

    /// Whether the record already names an object other than `stat`.
    pub fn names_other(&self, stat: &Stat) -> bool {
        self.dev.is_some() && !self.matches(stat)
    }

    /// The recorded origin as a path (`None` when its bytes do not decode).
    pub fn origin_path(&self) -> Option<PathBuf> {
        self.origin.to_path()
    }

    /// The name of the private hardlink pinning this object, if one was made.
    pub fn anchor(&self) -> Option<&str> {
        self.anchor.as_deref()
    }

    /// This record with `stat` as its object, pinned by the hardlink `anchor`
    /// (none: unpinned).
    pub fn pinned(self, stat: &Stat, anchor: Option<String>) -> Self {
        let mut slot = self.with_stat(stat);
        slot.anchor = anchor;
        slot
    }

    /// The object now belongs at `origin`.
    fn return_to(&mut self, origin: &Path) {
        self.origin = IntentPath::from_path(origin);
    }

    /// The moved object `stat` returns to `origin`. Whether this record was
    /// already pinned on that object.
    pub fn compensate(&mut self, origin: &Path, stat: &Stat) -> bool {
        self.return_to(origin);
        let anchored = self.matches(stat) && self.anchor.is_some();
        *self = self.clone().with_stat(stat);
        anchored
    }
}

/// Where an object an INTENT records sits before any public effect, so it can
/// be pinned: at a path, or (a replace's own temp) at `tmp` in the recovery
/// directory.
pub enum PinTarget {
    At(PathBuf),
    ReplaceTemp,
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
    /// Identity of the object to publish, recorded before public mutation.
    /// Recovery may advance an incomplete phase only when this identity is
    /// positively present at the operation's destination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published: Option<IntentSlot>,
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
            published: None,
            slots,
            pid: std::process::id(),
            host: crate::node::hostname::reported_hostname()
                .unwrap_or_else(|| "unknown".to_string()),
            created_at: crate::time::now_rfc3339(),
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

    pub fn create(path: &Path) -> Self {
        let mut slots = BTreeMap::new();
        slots.insert("slot-1".to_string(), IntentSlot::planned(path));
        Self::new(IntentOp::Create, None, path, None, slots)
    }

    /// The object this operation publishes, recorded before any public
    /// mutation: its identity `stat`, published at `at`.
    pub fn publishing(mut self, at: &Path, stat: &Stat) -> Self {
        self.published = Some(IntentSlot::planned(at).with_stat(stat));
        self
    }

    /// This INTENT advanced to `phase`.
    pub fn at_phase(&self, phase: IntentPhase) -> Self {
        let mut next = self.clone();
        next.phase = phase;
        next
    }

    /// Hand each recorded pre-effect object to `pin`, with where it sits now:
    /// every slot at its origin, then the published object (a replace's temp
    /// in R, otherwise the source).
    pub fn pin_records<E>(
        &mut self,
        mut pin: impl FnMut(&mut IntentSlot, PinTarget) -> Result<(), E>,
    ) -> Result<(), E> {
        for record in self.slots.values_mut() {
            if let Some(path) = record.origin_path() {
                pin(record, PinTarget::At(path))?;
            }
        }
        if let Some(record) = self.published.as_mut() {
            if self.op == IntentOp::Replace {
                pin(record, PinTarget::ReplaceTemp)?;
            } else if let Some(path) = self.source.to_path() {
                pin(record, PinTarget::At(path))?;
            }
        }
        Ok(())
    }

    /// Record the object now in slot `key` of R as `stat`. `absent` tells
    /// whether a slot name no longer exists in R.
    pub fn record_slot(
        &mut self,
        key: String,
        stat: &Stat,
        origin: &Path,
        absent: impl Fn(&str) -> bool,
    ) {
        let recorded = self
            .slots
            .remove(&key)
            .or_else(|| {
                // Replace exchange moves the planned original into tmp, not
                // slot-1. Transfer its pre-effect map rather than duplicate it.
                (key == "tmp" && self.op == IntentOp::Replace)
                    .then(|| self.slots.remove("slot-1"))
                    .flatten()
            })
            .unwrap_or_else(|| IntentSlot::planned(origin));
        // Exchange and capture renumber slots. Only transfer a pre-effect pin
        // belonging to this object; a newly captured stranger gains no authority.
        // A donor slot record whose name is absent in R described this same
        // object before renumbering: MOVE it, so rollback never waits on a
        // stale, absent duplicate. The published record is only copied.
        let recorded = if recorded.matches(stat) {
            recorded.with_stat(stat)
        } else {
            let donor = self
                .slots
                .iter()
                .find(|(_, candidate)| candidate.matches(stat) && candidate.anchor().is_some())
                .map(|(name, candidate)| (name.clone(), candidate.anchor().map(str::to_string)));
            let anchor = match donor {
                Some((name, anchor)) => {
                    if absent(&name) {
                        self.slots.remove(&name);
                    }
                    anchor
                }
                None => self
                    .published
                    .iter()
                    .find(|candidate| candidate.matches(stat))
                    .and_then(|candidate| candidate.anchor().map(str::to_string)),
            };
            recorded.pinned(stat, anchor)
        };
        self.slots.insert(key, recorded);
    }

    /// Map the slot `key` before `from` is captured into it, and mark the
    /// capture in progress. `absent` tells whether a slot name no longer
    /// exists in R.
    pub fn plan_capture(&mut self, key: String, from: &Path, absent: impl Fn(&str) -> bool) {
        if !self.slots.contains_key(&key) {
            // Capture renumbering (replace's temp consumes a slot number):
            // move the pinned pre-effect record of this same origin whose
            // slot name is absent, so a crash leaves ONE pinned record.
            let donor = self
                .slots
                .iter()
                .find(|(name, record)| {
                    record.anchor().is_some()
                        && record.origin_path().as_deref() == Some(from)
                        && absent(name)
                })
                .map(|(name, _)| name.clone());
            let record = donor
                .and_then(|name| self.slots.remove(&name))
                .unwrap_or_else(|| IntentSlot::planned(from));
            self.slots.insert(key, record);
        }
        if self.phase != IntentPhase::Committed {
            self.phase = IntentPhase::Capturing;
        }
    }

    /// A rejected direct move compensates: `slot-1` now records the source
    /// `origin` and the moved object's identity `stat`. Returns that record and
    /// whether it was already pinned on this object.
    pub fn compensate_move(
        &mut self,
        origin: &Path,
        stat: &Stat,
    ) -> Option<(&mut IntentSlot, bool)> {
        self.phase = IntentPhase::Compensating;
        let record = self.slots.get_mut("slot-1")?;
        let anchored = record.compensate(origin, stat);
        Some((record, anchored))
    }

    /// Slot `key` reclaims its pre-move `origin`; the INTENT compensates.
    #[cfg(test)]
    pub fn reclaim_origin(&mut self, key: &str, origin: &Path) {
        if let Some(record) = self.slots.get_mut(key) {
            record.return_to(origin);
        }
        self.phase = IntentPhase::Compensating;
    }

    pub fn source_path(&self) -> Option<PathBuf> {
        self.source.to_path()
    }

    pub fn destination_path(&self) -> Option<PathBuf> {
        self.destination.as_ref().and_then(|path| path.to_path())
    }

    /// The record of the object to publish, and the path it is published
    /// at (`None` when that does not decode).
    pub fn publication(&self) -> Option<(&IntentSlot, Option<PathBuf>)> {
        self.published
            .as_ref()
            .map(|published| (published, published.origin_path()))
    }

    /// A replace's own temp: its published record and pin.
    pub fn replace_temp(&self) -> Option<(&IntentSlot, &str)> {
        match &self.published {
            Some(published) if self.op == IntentOp::Replace => {
                published.anchor().map(|anchor| (published, anchor))
            }
            _ => None,
        }
    }

    pub fn slot(&self, name: &str) -> Option<&IntentSlot> {
        self.slots.get(name)
    }

    /// The slots, by name.
    pub fn slots(&self) -> impl Iterator<Item = (&str, &IntentSlot)> {
        self.slots.iter().map(|(name, slot)| (name.as_str(), slot))
    }

    /// Every record: the slots, then the published object.
    pub fn records(&self) -> impl Iterator<Item = &IntentSlot> {
        self.slots.values().chain(self.published.iter())
    }

    /// The public paths the operation touches: source, destination, and where
    /// the published object goes (`None` for one that does not decode).
    pub fn public_paths(&self) -> impl Iterator<Item = Option<PathBuf>> {
        std::iter::once(self.source.to_path())
            .chain(self.destination.iter().map(IntentPath::to_path))
            .chain(self.published.iter().map(IntentSlot::origin_path))
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
        IntentOp::Create => "create",
    }
}

pub fn intent_phase_name(phase: IntentPhase) -> &'static str {
    match phase {
        IntentPhase::Prepared => "prepared",
        IntentPhase::Captured => "captured",
        IntentPhase::Capturing => "capturing",
        IntentPhase::Publishing => "publishing",
        IntentPhase::Compensating => "compensating",
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
    fn only_the_current_journal_version_is_accepted() {
        let current = Intent::delete(Path::new("/test"));
        let mut value = serde_json::to_value(&current).expect("json");
        assert!(parse_intent(&serde_json::to_vec(&value).expect("json")).is_ok());
        for version in [0, 1, 2, 4] {
            value["version"] = version.into();
            assert!(
                parse_intent(&serde_json::to_vec(&value).expect("json"))
                    .expect_err("unsupported version")
                    .contains("not supported")
            );
        }
    }

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
