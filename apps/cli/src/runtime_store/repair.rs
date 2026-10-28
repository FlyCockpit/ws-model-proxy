//! A `runtime.define` this build cannot read whole: one definition (or the
//! node part) with a field it does not know, or a shape it cannot read.
//!
//! The frame itself stays strict (`deny_unknown_fields`); what changes is what
//! a failure costs. Each `put` entry and the node part are read on their own.
//! Those that fail are taken out of the frame and answered `rejected` /
//! `invalid` with the JSON path that failed; the rest of the frame is handled
//! as usual, and the session stays up. A node part that fails is refused and
//! the node keeps the one it held (the operation then carries no node part).

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::protocol::frames::{
    DefineEntryResult, DefineNodeResult, DefineRejectReason, DefineStatus, DefinitionEnvelope,
    NodeDefinition, NodeFrame, ServerFrame,
};

/// What a repaired frame refused before it was handled.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DefineRefusals {
    pub entries: Vec<DefineEntryResult>,
    /// The node part could not be read.
    pub node: bool,
}

impl DefineRefusals {
    /// Add the refusals to the answer the handler built for the rest.
    pub fn merge_into(&self, answer: &mut NodeFrame) {
        if let NodeFrame::RuntimeDefineResult { results, node, .. } = answer {
            results.extend(self.entries.iter().cloned());
            if self.node {
                *node = Some(DefineNodeResult {
                    status: DefineStatus::Rejected,
                    reason: Some(DefineRejectReason::Invalid),
                });
            }
        }
    }
}

/// The frame as handled after a repair: its text, the parsed frame, and what
/// was refused out of it.
pub struct RepairedDefine {
    pub text: String,
    pub frame: ServerFrame,
    pub refusals: DefineRefusals,
}

/// One part taken out, for the log: which part, the JSON path that failed in
/// it, and serde's message (field names, never values).
pub struct Unreadable {
    pub part: String,
    pub path: String,
    pub error: String,
}

/// Take the definitions (and the node part) this build cannot read out of a
/// `runtime.define`, and parse the rest with `parse`. `None` when the text is
/// not such a frame, when no part had to be taken out, or when the rest still
/// does not parse: the caller then treats the frame as malformed. `log` hears
/// each part taken out.
pub fn repair_runtime_define(
    text: &str,
    parse: impl Fn(&str) -> anyhow::Result<ServerFrame>,
    mut log: impl FnMut(&Unreadable),
) -> Option<RepairedDefine> {
    let mut value: Value = serde_json::from_str(text).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("runtime.define") {
        return None;
    }
    let mut refusals = DefineRefusals::default();
    let mut taken_out = false;
    if let Some(puts) = value.get_mut("put").and_then(Value::as_array_mut) {
        let mut kept = Vec::with_capacity(puts.len());
        for (index, put) in std::mem::take(puts).into_iter().enumerate() {
            let Some((path, error)) = first_error::<DefinitionEnvelope>(&put) else {
                kept.push(put);
                continue;
            };
            taken_out = true;
            log(&Unreadable {
                part: format!("put[{index}]"),
                path: path.clone(),
                error,
            });
            // Refused by id. One with no usable id cannot be named: it is
            // dropped, and the server sees it neither held nor applied.
            if let (Some(runtime_id), Some(version_id)) =
                (row_id(&put, "runtimeId"), row_id(&put, "versionId"))
            {
                refusals.entries.push(DefineEntryResult {
                    runtime_id,
                    version_id,
                    status: DefineStatus::Rejected,
                    reason: Some(DefineRejectReason::Invalid),
                    detail: Some(path),
                });
            }
        }
        *puts = kept;
    }
    if let Some((path, error)) = value.get("node").and_then(first_error::<NodeDefinition>) {
        taken_out = true;
        log(&Unreadable {
            part: "node".to_string(),
            path,
            error,
        });
        if let Some(object) = value.as_object_mut() {
            object.remove("node");
        }
        refusals.node = true;
    }
    if !taken_out {
        return None;
    }
    let text = serde_json::to_string(&value).ok()?;
    let frame = parse(&text).ok()?;
    Some(RepairedDefine {
        text,
        frame,
        refusals,
    })
}

/// A `runtimeId`/`versionId` the server accepts back (`rowIdSchema`).
fn row_id(put: &Value, key: &str) -> Option<String> {
    let id = put.get(key)?.as_str()?;
    let shaped = (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    shaped.then(|| id.to_string())
}

/// Why `value` does not read as a `T`: the JSON path that failed (`spec.launch.commands[0].start`)
/// and serde's message. `None` when it reads.
pub(crate) fn first_error<T: DeserializeOwned>(value: &Value) -> Option<(String, String)> {
    // Read from pretty text, so serde's line number names one key or value:
    // the path is rebuilt from the lines before it.
    let pretty = serde_json::to_string_pretty(value).ok()?;
    let error = serde_json::from_str::<T>(&pretty).err()?;
    Some((
        wire_path(&path_at_line(&pretty, error.line())),
        error.to_string(),
    ))
}

/// The JSON path of line `line` (1-based) of `serde_json::to_string_pretty`
/// output: the containers open above it, then the key on it.
fn path_at_line(pretty: &str, line: usize) -> String {
    enum Open {
        Object(Option<String>),
        Array(Option<String>, usize),
    }
    let label = |open: &Open| match open {
        Open::Object(label) | Open::Array(label, _) => label.clone(),
    };
    let mut stack: Vec<Open> = Vec::new();
    let mut at_line = None;
    for (number, raw) in pretty.lines().enumerate() {
        let text = raw.trim().trim_end_matches(',');
        if text.starts_with('}') || text.starts_with(']') {
            if number + 1 == line {
                // A missing field is reported where its object closes: name the object.
                break;
            }
            stack.pop();
            continue;
        }
        let (key, rest) = match split_key(text) {
            Some((key, rest)) => (Some(key), rest),
            None => (None, text),
        };
        // An element of the array it is in: the next index.
        let segment = match (&key, stack.last_mut()) {
            (Some(key), _) => Some(key.clone()),
            (None, Some(Open::Array(_, next))) => {
                let index = *next;
                *next += 1;
                Some(format!("[{index}]"))
            }
            _ => None,
        };
        if number + 1 == line {
            at_line = segment.clone();
            if rest != "{" && rest != "[" {
                break;
            }
        }
        match rest {
            "{" => stack.push(Open::Object(segment)),
            "[" => stack.push(Open::Array(segment, 0)),
            _ => {}
        }
        if number + 1 == line {
            // The error is on the container's opening line: name the container.
            stack.pop();
            break;
        }
    }
    let mut path = String::new();
    for segment in stack.iter().filter_map(label).chain(at_line) {
        if !segment.starts_with('[') && !path.is_empty() {
            path.push('.');
        }
        path.push_str(&segment);
    }
    path
}

/// `"key": rest` → the key (unescaped) and the rest.
fn split_key(text: &str) -> Option<(String, &str)> {
    if !text.starts_with('"') {
        return None;
    }
    let mut escaped = false;
    for (index, ch) in text.char_indices().skip(1) {
        match ch {
            '\\' if !escaped => escaped = true,
            '"' if !escaped => {
                let rest = text[index + 1..].strip_prefix(": ")?;
                let key: String = serde_json::from_str(&text[..=index]).ok()?;
                return Some((key, rest));
            }
            _ => escaped = false,
        }
    }
    None
}

/// The path as `runtime.define.result` carries it: `[A-Za-z0-9_.$[\]-]`, at most
/// 128 characters, never empty (other characters become `_`).
fn wire_path(path: &str) -> String {
    let cleaned: String = path
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || "_.$[]-".contains(ch) {
                ch
            } else {
                '_'
            }
        })
        .take(128)
        .collect();
    if cleaned.is_empty() {
        "$".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_failed_line_names_its_path() {
        let value = json!({
            "spec": { "launch": { "commands": [ { "name": "x" }, { "start": ["a"], "name": "y" } ] } },
            "slug": "s",
        });
        let pretty = serde_json::to_string_pretty(&value).expect("pretty");
        let line = pretty
            .lines()
            .position(|line| line.contains("\"start\""))
            .expect("start line")
            + 1;
        assert_eq!(path_at_line(&pretty, line), "spec.launch.commands[1].start");
        let slug = pretty
            .lines()
            .position(|line| line.contains("\"slug\""))
            .expect("slug line")
            + 1;
        assert_eq!(path_at_line(&pretty, slug), "slug");
        // Where the second command's object closes (a missing field).
        let close = pretty
            .lines()
            .enumerate()
            .filter(|(_, line)| line.trim().starts_with('}'))
            .map(|(index, _)| index + 1)
            .nth(1)
            .expect("second close");
        assert_eq!(path_at_line(&pretty, close), "spec.launch.commands[1]");
    }

    #[test]
    fn a_path_fits_the_wire() {
        assert_eq!(wire_path("spec.env.MY KEY"), "spec.env.MY_KEY");
        assert_eq!(wire_path(""), "$");
        assert_eq!(wire_path(&"a".repeat(300)).len(), 128);
    }

    #[test]
    fn keys_with_quotes_split() {
        assert_eq!(split_key(r#""a\"b": 1"#), Some(("a\"b".to_string(), "1")));
        assert_eq!(split_key("[1, 2]"), None);
    }
}
