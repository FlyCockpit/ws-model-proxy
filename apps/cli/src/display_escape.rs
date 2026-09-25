//! The one escaping policy for untrusted text shown for a human decision.
//!
//! Mirrors `packages/config/src/display-escape.ts`: the same code point list,
//! checked against the shared `display-escape-vectors.json` on both sides, so
//! the CLI confirm screen and the web request panel show the same characters
//! as `\u{..}`.

use std::fmt::Write as _;

/// Inclusive code point ranges shown as `\u{<hex>}`: controls (except the
/// line feed), bidi embeddings/overrides/isolates, zero-width and invisible
/// characters, space look-alikes, surrogates, variation selectors, tag
/// characters, and invisible format controls.
pub const ESCAPE_RANGES: &[(u32, u32)] = &[
    (0x0000, 0x0009),
    (0x000b, 0x001f),
    (0x007f, 0x00a0),
    (0x00ad, 0x00ad),
    (0x034f, 0x034f),
    (0x061c, 0x061c),
    (0x115f, 0x1160),
    (0x1680, 0x1680),
    (0x17b4, 0x17b5),
    (0x180b, 0x180f),
    (0x2000, 0x200f),
    (0x2028, 0x202f),
    (0x205f, 0x206f),
    (0x2800, 0x2800),
    (0x3000, 0x3000),
    (0x3164, 0x3164),
    (0xd800, 0xdfff),
    (0xfe00, 0xfe0f),
    (0xfeff, 0xfeff),
    (0xffa0, 0xffa0),
    (0xfff9, 0xfffb),
    (0x1bca0, 0x1bca3),
    (0x1d173, 0x1d17a),
    (0xe0000, 0xe007f),
    (0xe0100, 0xe01ef),
];

pub fn needs_escape(ch: char) -> bool {
    let code = u32::from(ch);
    ESCAPE_RANGES
        .iter()
        .any(|(start, end)| (*start..=*end).contains(&code))
}

/// `text` with every listed character shown as `\u{<lowercase hex>}`. Line
/// feeds stay; each surface lays out line breaks itself.
pub fn escape_for_display(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if needs_escape(ch) {
            let _ = write!(out, "\\u{{{:x}}}", u32::from(ch));
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Shared {
        ranges: Vec<(String, String)>,
        vectors: Vec<Vector>,
    }

    #[derive(serde::Deserialize)]
    struct Vector {
        input: String,
        output: String,
    }

    fn shared() -> Shared {
        serde_json::from_str(include_str!(
            "../../../packages/config/src/display-escape-vectors.json"
        ))
        .expect("shared display-escape vectors")
    }

    #[test]
    fn uses_exactly_the_shared_code_point_list() {
        let listed = shared()
            .ranges
            .iter()
            .map(|(start, end)| {
                (
                    u32::from_str_radix(start, 16).expect("hex"),
                    u32::from_str_radix(end, 16).expect("hex"),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(listed, ESCAPE_RANGES);
        assert!(ESCAPE_RANGES.windows(2).all(|pair| pair[0].1 < pair[1].0));
    }

    #[test]
    fn matches_every_shared_vector() {
        for vector in shared().vectors {
            assert_eq!(
                escape_for_display(&vector.input),
                vector.output,
                "input {:?}",
                vector.input
            );
        }
    }
}
