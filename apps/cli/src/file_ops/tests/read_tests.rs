//! `file_read`: windows, caps, continuation, binary refusal, masking.

use std::io::Write;

use serde_json::json;

use super::super::read::{More, ReadOutcome};
use super::super::text::Eol;
use super::super::{Cancel, ErrorCode};
use super::{Fx, args, aws_style_id, code, pem};

fn numbered(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

#[test]
fn default_window_reports_shape_and_more() {
    let fx = Fx::new();
    fx.put("f.txt", numbered(500));
    let r = fx.read("f.txt");
    assert_eq!(r.total_lines, Some(500));
    assert_eq!((r.start_line, r.end_line), (Some(1), Some(400)));
    assert!(r.text.starts_with("1|line 1\n2|line 2"));
    assert!(
        r.text
            .ends_with("400|line 400\n…[truncated: call again with startLine=401]")
    );
    assert_eq!(
        r.more,
        Some(More {
            start_line: 401,
            byte_offset: None
        })
    );
    assert_eq!(r.eol, Eol::Lf);
    assert_eq!(r.mode.len(), 4);
    assert!(r.mtime.ends_with('Z'));
    assert!(r.etag.starts_with("h:"));
    let next = fx.read_with(json!({ "path": fx.p("f.txt"), "startLine": 401 }));
    assert_eq!(
        (next.start_line, next.end_line, next.more),
        (Some(401), Some(500), None)
    );
    assert!(next.text.ends_with("500|line 500"));
}

#[test]
fn window_parameter_table() {
    let fx = Fx::new();
    fx.put("f.txt", numbered(50));
    // (extra args, expected first/last line, expected more.startLine)
    let rows = [
        (
            json!({ "startLine": 10, "maxLines": 3 }),
            (10, 12),
            Some(13),
        ),
        (json!({ "startLine": -3 }), (48, 50), None),
        (json!({ "startLine": -500 }), (1, 50), None),
        (json!({ "maxLines": 5000 }), (1, 50), None),
        (json!({ "startLine": 50 }), (50, 50), None),
        (json!({ "startLine": 51 }), (51, 50), None),
        (json!({ "startLine": 1, "maxLines": 1 }), (1, 1), Some(2)),
    ];
    for (extra, (first, last), more) in rows {
        let mut a = json!({ "path": fx.p("f.txt") });
        a.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let r = fx.read_with(a.clone());
        assert_eq!((r.start_line, r.end_line), (Some(first), Some(last)), "{a}");
        assert_eq!(r.more.map(|m| m.start_line), more, "{a}");
    }
    assert_eq!(
        code(fx.ops.read(
            &args(json!({ "path": fx.p("f.txt"), "startLine": 0 })),
            &fx.cancel
        )),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        code(fx.ops.read(
            &args(json!({ "path": fx.p("f.txt"), "maxLines": 0 })),
            &fx.cancel
        )),
        ErrorCode::InvalidInput
    );
    let raw = fx.read_with(json!({ "path": fx.p("f.txt"), "maxLines": 2, "lineNumbers": false }));
    assert!(raw.text.starts_with("line 1\nline 2\n…[truncated"));
}

#[test]
fn byte_cap_stops_at_a_line_boundary_with_next_call_hint() {
    let fx = Fx::new();
    fx.put("f.txt", numbered(1000));
    let r = fx.read_with(json!({ "path": fx.p("f.txt"), "maxBytes": 100 }));
    let body = r.text.split("\n…[truncated").next().unwrap();
    assert!(body.len() <= 100, "{}", body.len());
    let end = r.end_line.unwrap();
    assert_eq!(
        r.more,
        Some(More {
            start_line: end + 1,
            byte_offset: None
        })
    );
}

#[test]
fn long_line_continuation_reassembles_exactly() {
    let fx = Fx::new();
    let long = "é".repeat(5000) + "tail";
    fx.put("f.txt", format!("first\n{long}\nlast\n"));
    let mut rebuilt = String::new();
    let mut a = json!({ "path": fx.p("f.txt"), "startLine": 2, "maxBytes": 1001, "maxLines": 1 });
    for _ in 0..40 {
        let r = fx.read_with(a.clone());
        let chunk = r.text.split("\n…[truncated").next().unwrap();
        rebuilt.push_str(chunk.strip_prefix("2|").unwrap());
        match r.more {
            Some(More {
                start_line: 2,
                byte_offset: Some(off),
            }) => {
                a["byteOffset"] = json!(off);
            }
            _ => break,
        }
    }
    assert_eq!(rebuilt, long);
    // an offset in the middle of a character is refused
    let bad = fx.ops.read(
        &args(json!({ "path": fx.p("f.txt"), "startLine": 2, "byteOffset": 1 })),
        &fx.cancel,
    );
    assert_eq!(code(bad), ErrorCode::InvalidInput);
}

#[test]
fn cap_never_splits_a_multibyte_character() {
    let fx = Fx::new();
    fx.put("f.txt", "€€€€€€€€€€\n");
    for cap in 1..=20 {
        let r = fx.read_with(json!({ "path": fx.p("f.txt"), "maxBytes": cap }));
        assert!(std::str::from_utf8(r.text.as_bytes()).is_ok());
        assert!(!r.text.contains('\u{FFFD}'));
    }
}

#[test]
fn binary_and_invalid_utf8_are_refused_not_decoded() {
    let fx = Fx::new();
    let rows: Vec<(&str, Vec<u8>, &str)> = vec![
        ("gguf", b"GGUF\x03\0\0\0weights".to_vec(), "gguf"),
        ("nul", b"abc\0def\n".to_vec(), "unknown"),
        ("utf16", vec![0xff, 0xfe, b'h', 0, b'i', 0], "utf16"),
        ("latin1", b"na\xc3\xafve cuv\xe9e\n".to_vec(), "unknown"),
        ("elf", b"\x7fELF\x02\x01\x01".to_vec(), "elf"),
    ];
    for (name, bytes, sniff) in rows {
        fx.put(name, &bytes);
        let err = fx
            .ops
            .read(&args(json!({ "path": fx.p(name) })), &fx.cancel)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::BinaryFile, "{name}");
        let detail = err.detail.unwrap();
        assert_eq!(detail["sniff"], sniff, "{name}");
        assert_eq!(detail["size"], bytes.len(), "{name}");
        assert!(detail["etag"].as_str().unwrap().starts_with("h:"));
    }
}

#[test]
fn if_none_match_and_etag_semantics() {
    let fx = Fx::new();
    fx.put("f.txt", "one\n");
    let first = fx.read("f.txt");
    let again = fx
        .ops
        .read(
            &args(json!({ "path": fx.p("f.txt"), "ifNoneMatch": first.etag })),
            &fx.cancel,
        )
        .unwrap();
    assert!(
        matches!(&again, ReadOutcome::Unchanged { unchanged: true, etag } if *etag == first.etag)
    );
    assert_eq!(
        serde_json::to_value(&again).unwrap(),
        json!({ "unchanged": true, "etag": first.etag })
    );
    fx.put("f.txt", "two\n");
    let changed = fx
        .ops
        .read(
            &args(json!({ "path": fx.p("f.txt"), "ifNoneMatch": first.etag })),
            &fx.cancel,
        )
        .unwrap();
    assert!(matches!(changed, ReadOutcome::Content(_)));
    assert_ne!(fx.etag("f.txt"), first.etag);
}

#[test]
fn eol_and_empty_file() {
    let fx = Fx::new();
    fx.put("crlf", "a\r\nb\r\n");
    fx.put("mixed", "a\r\nb\n");
    fx.put("none", "single");
    fx.put("empty", "");
    assert_eq!(fx.read("crlf").eol, Eol::Crlf);
    assert_eq!(fx.read("crlf").text, "1|a\n2|b");
    assert_eq!(fx.read("mixed").eol, Eol::Mixed);
    assert_eq!(fx.read("none").eol, Eol::None);
    let empty = fx.read("empty");
    assert_eq!(
        (empty.total_lines, empty.text.as_str(), empty.more.is_none()),
        (Some(0), "", true)
    );
}

#[test]
fn secret_files_return_a_masked_view() {
    let fx = Fx::new();
    fx.put(".env", "# keys\nHF_TOKEN=hf_supersecretvalue\nPORT=8080\n");
    let r = fx.read(".env");
    assert!(r.secret_file);
    assert_eq!(r.redactions, 2);
    assert!(
        !r.text.contains("supersecret") && !r.text.contains("8080"),
        "{}",
        r.text
    );
    assert!(
        r.text.contains("2|HF_TOKEN=\u{27E6}redacted:19\u{27E7}"),
        "{}",
        r.text
    );
    // Plain files mask token lines and the next line; a blank ends that scope.
    fx.put(
        "run.sh",
        format!(
            "export X_API_KEY=abcdef\n\nmax_tokens=4096\n{}\n",
            aws_style_id()
        ),
    );
    let r = fx.read("run.sh");
    assert!(!r.secret_file);
    assert_eq!(r.redactions, 1);
    assert!(r.text.contains("max_tokens=4096") && r.text.contains(&aws_style_id()));
    assert!(!r.text.contains("abcdef"));
}

/// The path has no cloud-specific class; its case-insensitive `_key` word
/// nevertheless goes through the same bounded token rule as every plain file.
#[test]
fn a_plain_credentials_file_uses_case_insensitive_token_masking() {
    let fx = Fx::new();
    fx.put(
        ".aws/credentials",
        "[default]\naws_access_key_id = EXAMPLEKEYIDVALUE\naws_secret_access_key = examplesecretvalue\n",
    );
    let r = fx.read(".aws/credentials");
    assert!(!r.secret_file);
    assert_eq!(r.redactions, 1);
    assert!(r.text.contains("[default]") && r.text.contains("EXAMPLEKEYIDVALUE"));
    assert!(!r.text.contains("examplesecretvalue"), "{}", r.text);
    assert!(r.text.contains("⟦redacted line: aws_secret_access_key⟧"));
    // Reads and the edit view agree on the protected source range.
    let view = super::super::redact::mask(
        super::super::redact::FileClass::Plain,
        &fx.get(".aws/credentials"),
    );
    assert_eq!(view.redactions(), 1);
    assert!(!view.text.contains("examplesecretvalue"));
}

#[test]
fn ssh_keys_pem_keys_and_hf_token_files_are_masked() {
    let fx = Fx::new();
    fx.put(
        ".ssh/id_ed25519",
        pem("OPENSSH PRIVATE KEY", "SECRETBODY\n"),
    );
    fx.put(".ssh/id_ed25519.pub", "ssh-ed25519 AAAAPUBLIC me@host\n");
    fx.put(
        "tls/server.pem",
        format!(
            "{}{}",
            pem("CERTIFICATE", "CERTBODY\n"),
            pem("PRIVATE KEY", "KEYBODY\n")
        ),
    );
    fx.put(".cache/huggingface/token", "hf_abcdefghijklmnop\n");
    assert!(!fx.read(".ssh/id_ed25519").text.contains("SECRETBODY"));
    assert!(fx.read(".ssh/id_ed25519.pub").text.contains("AAAAPUBLIC"));
    let pem = fx.read("tls/server.pem").text;
    assert!(
        pem.contains("CERTBODY") && !pem.contains("KEYBODY"),
        "{pem}"
    );
    let hf = fx.read(".cache/huggingface/token");
    assert!(!hf.text.contains("hf_abc") && hf.secret_file, "{}", hf.text);
    // a windowed read that starts inside a PEM private-key block still masks it
    let inside = fx.read_with(json!({ "path": fx.p("tls/server.pem"), "startLine": 5 }));
    assert!(!inside.text.contains("KEYBODY"), "{}", inside.text);
}

#[test]
fn a_window_deep_inside_a_pem_private_key_block_is_masked() {
    let fx = Fx::new();
    fx.put(
        "k.pem",
        format!(
            "{}after\n",
            pem("PRIVATE KEY", "BODYONE\nBODYTWO\nBODYTHREE\n")
        ),
    );
    for start in 2..=5 {
        let r = fx.read_with(json!({ "path": fx.p("k.pem"), "startLine": start }));
        assert!(!r.text.contains("BODY"), "start {start}: {}", r.text);
    }
    assert!(
        fx.read_with(json!({ "path": fx.p("k.pem"), "startLine": 6 }))
            .text
            .contains("after")
    );
}

#[test]
fn a_secret_at_the_byte_cap_is_masked_whole_never_half_shown() {
    let fx = Fx::new();
    let secret = "SUPERSECRET".repeat(20);
    fx.put("a.env", format!("PAD=1\nHF_TOKEN={secret}\nAFTER=2\n"));
    for cap in 1..=80 {
        let r = fx.read_with(json!({ "path": fx.p("a.env"), "maxBytes": cap }));
        assert!(
            !r.text.contains("SUPER") && !r.text.contains("SECRET"),
            "cap {cap}: {}",
            r.text
        );
    }
    fx.put(
        "plain.txt",
        format!("first\nrun --api-key {secret} --x\nlast\n"),
    );
    for cap in 1..=80 {
        let r = fx.read_with(json!({ "path": fx.p("plain.txt"), "maxBytes": cap, "startLine": 2 }));
        assert!(!r.text.contains("SUPER"), "cap {cap}: {}", r.text);
    }
    // a flag value on the line after the window start is masked using one line of context
    fx.put(
        "cont.txt",
        format!("cmd \\\n  --api-key \\\n  {secret}\nend\n"),
    );
    let r = fx.read_with(json!({ "path": fx.p("cont.txt"), "startLine": 3 }));
    assert!(!r.text.contains("SUPER"), "{}", r.text);
}

/// A window that starts many lines inside a quoted dotenv value masks every
/// returned line: the masker must be fed the whole prefix, not only the line
/// before the window.
#[test]
fn a_window_deep_inside_a_quoted_value_is_masked() {
    let fx = Fx::new();
    fx.put("q.env", "A=\"first\nsecond\nthird\"\nB=x\n");
    for start in 1..=4 {
        let r = fx.read_with(json!({ "path": fx.p("q.env"), "startLine": start }));
        assert!(
            !r.text.contains("first") && !r.text.contains("second") && !r.text.contains("third"),
            "startLine {start}: {}",
            r.text
        );
    }
    // an unterminated quote masks to the end of the file from a deep window
    fx.put("u.env", "A=\"one\ntwo\nthree\n");
    let r = fx.read_with(json!({ "path": fx.p("u.env"), "startLine": 3 }));
    assert!(!r.text.contains("three"), "{}", r.text);
    // a `.pem` window deep inside a private-key block stays masked (multi-line class)
    fx.put(
        "deep.pem",
        format!(
            "{}after\n",
            super::super::tests::pem("PRIVATE KEY", "BODYONE\nBODYTWO\nBODYTHREE\n")
        ),
    );
    let r = fx.read_with(json!({ "path": fx.p("deep.pem"), "startLine": 3 }));
    assert!(!r.text.contains("BODYTHREE"), "{}", r.text);
}

#[test]
fn window_lines_beyond_the_window_are_not_masked_or_touched() {
    // Only returned lines are scanned: a 50k-line file returns 400 lines and
    // reports redactions for those only.
    let fx = Fx::new();
    let mut content = String::new();
    for i in 0..50_000 {
        content.push_str(&format!("line {i} X_TOKEN=secret{i}\n"));
    }
    fx.put("big.txt", content);
    let r = fx.read("big.txt");
    assert_eq!(r.redactions, 400);
    assert_eq!(r.total_lines, Some(50_000));
}

#[test]
fn files_over_64_mib_use_weak_etags_and_streamed_windows() {
    let fx = Fx::new();
    let path = fx.root.join("huge.log");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
    for i in 0..5_600_000_u32 {
        writeln!(file, "log line {i:08}").unwrap();
    }
    file.flush().unwrap();
    drop(file);
    let size = std::fs::metadata(&path).unwrap().len();
    assert!(size > 64 * 1024 * 1024, "{size}");

    let head = fx.read_with(json!({ "path": fx.p("huge.log"), "startLine": 3, "maxLines": 2 }));
    assert!(head.etag.starts_with("w:"));
    assert_eq!(head.total_lines, None);
    assert_eq!(head.text.split('\n').next().unwrap(), "3|log line 00000002");
    assert_eq!(head.more.map(|m| m.start_line), Some(5));

    let tail = fx.read_with(json!({ "path": fx.p("huge.log"), "startLine": -3 }));
    assert_eq!(
        tail.text,
        "log line 05599997\nlog line 05599998\nlog line 05599999"
    );
    assert_eq!(
        (tail.start_line, tail.end_line, tail.more),
        (None, None, None)
    );

    // masking still applies to a huge non-secret-class file's returned lines
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    writeln!(file, "HF_TOKEN=leaked_value").unwrap();
    drop(file);
    let tail = fx.read_with(json!({ "path": fx.p("huge.log"), "startLine": -1 }));
    assert!(!tail.text.contains("leaked_value"), "{}", tail.text);
    assert_eq!(tail.redactions, 1);

    // name-classified secret files over the cap are refused, not half-masked
    std::fs::rename(&path, fx.root.join("huge.env")).unwrap();
    let err = fx
        .ops
        .read(&args(json!({ "path": fx.p("huge.env") })), &Cancel::new())
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::TooLarge);
}

#[test]
fn cancellation_is_honored_while_reading() {
    let fx = Fx::new();
    fx.put("f.txt", "x\n");
    fx.cancel.cancel();
    assert_eq!(
        code(
            fx.ops
                .read(&args(json!({ "path": fx.p("f.txt") })), &fx.cancel)
        ),
        ErrorCode::Cancelled
    );
}
