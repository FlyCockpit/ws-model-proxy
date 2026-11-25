use std::path::Path;

use super::recognize::merge;
use super::*;

fn masked(class: FileClass, text: &str) -> String {
    mask(class, text).text
}

/// Real configuration samples go through one format-agnostic token rule.
#[test]
fn real_world_samples_mask_values_without_format_grammars() {
    // Values are ordinary fixture text, not vendor credential patterns.
    let rows = [
        (
            "dotenv",
            FileClass::Dotenv,
            "# service\nAPI_KEY=value-one\nPORT=8080\n",
            "value-one",
        ),
        (
            "compose list",
            FileClass::Plain,
            "services:\n  app:\n    environment:\n      - api_key=value-one\n      - PORT=8080\n",
            "value-one",
        ),
        (
            "compose map",
            FileClass::Plain,
            "services:\n  app:\n    environment:\n      Db_Password: value-one\n      PORT: 8080\n",
            "value-one",
        ),
        (
            "Kubernetes",
            FileClass::Plain,
            "env:\n  - name: openai_api_key\n    value: value-one\n",
            "value-one",
        ),
        (
            "Kubernetes inline reversed",
            FileClass::Plain,
            "env:\n  - {value: value-one, name: API_KEY}\n",
            "value-one",
        ),
        (
            "Kubernetes reference",
            FileClass::Plain,
            "env:\n  - name: API_KEY\n    valueFrom: {secretKeyRef: {name: value-one, key: credential}}\n",
            "value-one",
        ),
        (
            "JSON",
            FileClass::Plain,
            "{\"apiKey\": \"value-one\", \"public\": true}\n",
            "value-one",
        ),
        (
            "JSON separate value",
            FileClass::Plain,
            "{\"api-key\":\n  \"value-one\"}\n",
            "value-one",
        ),
        (
            "Dockerfile ENV",
            FileClass::Plain,
            "FROM scratch\nENV api_key value-one\n",
            "value-one",
        ),
        (
            "Dockerfile ARG",
            FileClass::Plain,
            "FROM scratch\nARG db_password=value-one\n",
            "value-one",
        ),
        (
            "shell export",
            FileClass::Plain,
            "export Hf_Token='value-one'\n",
            "value-one",
        ),
        (
            "Python",
            FileClass::Plain,
            "os.environ[\"api_key\"] = \"value-one\"\n",
            "value-one",
        ),
        (
            "Node",
            FileClass::Plain,
            "const config = { apiKey: 'value-one' };\n",
            "value-one",
        ),
        (
            "Actions env",
            FileClass::Plain,
            "env:\n  API_KEY: value-one\n",
            "value-one",
        ),
        (
            "Actions with",
            FileClass::Plain,
            "with:\n  api-key: value-one\n",
            "value-one",
        ),
        (
            "Actions run",
            FileClass::Plain,
            "run: echo \"API_KEY=$X\" >> $GITHUB_ENV\n",
            "$X",
        ),
    ];
    for (sample, class, input, value) in rows {
        let view = mask(class, input);
        assert!(!view.text.contains(value), "{sample}: {:?}", view.text);
        assert!(!view.spans.is_empty(), "{sample}");
        if class == FileClass::Plain {
            assert!(
                view.text.contains("⟦redacted line⟧"),
                "{sample}: {:?}",
                view.text
            );
        }
        assert_eq!(
            view.text.matches('\n').count(),
            input.matches('\n').count(),
            "{sample}"
        );
    }
}

/// The line after a token line is the value's line; a multi-line value that it
/// opens keeps masking to a structural end (Kubernetes `value: |`, folded, quoted).
#[test]
fn a_token_line_followed_by_a_multi_line_value_masks_the_whole_value() {
    for (sample, input, secrets, visible) in [
        (
            "literal block",
            "env:\n  - name: API_KEY\n    value: |\n      value-one\n      value-two\n  - name: PORT\n    value: \"8080\"\n",
            &["value-one", "value-two"][..],
            "PORT",
        ),
        (
            "folded block",
            "env:\n  - name: DB_PASSWORD\n    value: >-\n      value-one\n      value-two\nnext: 1\n",
            &["value-one", "value-two"][..],
            "next: 1",
        ),
        (
            "quoted multi-line",
            "- name: X_TOKEN\n  value: \"value-one\n    value-two\"\n\nnext: 1\n",
            &["value-one", "value-two"][..],
            "next: 1",
        ),
        (
            "JSON separate lines",
            "{\"name\": \"HF_TOKEN\",\n \"value\": \"value-one\"}\n",
            &["value-one"][..],
            "",
        ),
    ] {
        let view = mask(FileClass::Plain, input).text;
        for secret in secrets {
            assert!(!view.contains(secret), "{sample}: {view:?}");
        }
        assert!(view.contains(visible), "{sample}: {view:?}");
    }
}

/// The structural rule masks code indented under the line after a token line
/// (accepted over-masking) and ends at the next line at the token line's
/// indentation; a name/value pair with a same-indent block value stays masked.
#[test]
fn value_runs_after_a_token_line_follow_indentation_and_quotes() {
    for (sample, input, hidden) in [
        (
            "python loop body",
            "headers = {\"A\": f\"Bearer {API_KEY}\"}\nfor attempt in range(3):\n    probe-body\nvisible()\n",
            "probe-body",
        ),
        (
            "same-indent block value",
            "name: API_KEY\nvalue: |\n  probe-b1\n  probe-b2\nvisible: 1\n",
            "probe-b2",
        ),
        (
            "list item with other first key",
            "parameters:\n  - description: db\n    name: DB_PASSWORD\n    value: |\n      probe-c1\n      probe-c2\nvisible: 1\n",
            "probe-c2",
        ),
        (
            "triple-quoted value line",
            "cfg = dict(\n    name=\"API_KEY\",\n    value=\"\"\"\nprobe-d1\nprobe-d2\n\"\"\",\n)\n\nvisible = 1\n",
            "probe-d2",
        ),
        (
            "open quote on the value line",
            "NAME=DB_PASSWORD\nVALUE=\"probe-f1\nprobe-f2\nprobe-f3\"\n\nvisible = 1\n",
            "probe-f3",
        ),
    ] {
        let view = mask(FileClass::Plain, input).text;
        assert!(!view.contains(hidden), "{sample}: {view:?}");
        assert!(view.contains("visible"), "{sample}: {view:?}");
    }
    // a secret flag whose value is a block-scalar list item keeps the value masked
    let view = mask(
        FileClass::Plain,
        "args:\n  - --api-key\n  - >-\n    flag-value-one\nnext: 1\n",
    )
    .text;
    assert!(
        !view.contains("flag-value-one") && view.contains("next: 1"),
        "{view:?}"
    );
}

/// A comment on the value header that itself holds a secret-name word must not
/// suppress the header's block, and a value that is itself a secret-name word is
/// never copied into the marker.
#[test]
fn token_words_in_headers_and_values_do_not_break_masking_or_echo_the_value() {
    for (input, hidden) in [
        (
            "- name: API_KEY\n  value: | # API_KEY is injected by deployment\n    line-one\n    line-two\nnext: 1\n",
            &["line-one", "line-two"][..],
        ),
        (
            "- name: DB_PASSWORD\n  value: >- # loaded from DATABASE_PASSWORD\n    line-one\n    line-two\nnext: 1\n",
            &["line-one", "line-two"][..],
        ),
        (
            "run --password admin_password --verbose\n",
            &["admin_password"][..],
        ),
        (
            "run --password\nadmin_password\nnext\n",
            &["admin_password"][..],
        ),
        (
            "- name: DB_PASSWORD\n  value: admin_password\nnext: 1\n",
            &["admin_password"][..],
        ),
    ] {
        let view = mask(FileClass::Plain, input).text;
        for value in hidden {
            assert!(!view.contains(value), "{input:?} -> {view:?}");
        }
        assert!(
            view.contains("next") || input.contains("admin_password"),
            "{view:?}"
        );
    }
    let dotenv = mask(
        FileClass::Dotenv,
        "A=\"first\n# admin_password\nlast\"\nB=x\n",
    )
    .text;
    assert!(!dotenv.contains("admin_password"), "{dotenv:?}");
}

/// Every recognizer that fires on a line contributes its opener (none replaces
/// another): a value header whose comment holds an apostrophe AND a token word,
/// and a flag's block-scalar item with a token comment.
#[test]
fn openers_from_several_recognizers_on_one_line_are_all_kept() {
    for (sample, input, hidden) in [
        (
            "apostrophe comment with a token word, blank line inside the block",
            "env:\n  - name: API_KEY\n    value: | # the API_KEY's value\n      line-one\n\n      probe-line-two\nnext: 1\n",
            "probe-line-two",
        ),
        (
            "password flag, literal block item with a token comment",
            "args:\n  - --password\n  - | # DB_PASSWORD comes from deployment\n    line-one\n    probe-line-two\nnext: 1\n",
            "probe-line-two",
        ),
        (
            "block header whose token is only in its trailing comment",
            "stringData:\n  pgpass: | # holds the DB_PASSWORD\n    line-one\n    probe-line-two\nnext: 1\n",
            "probe-line-two",
        ),
        (
            "actions env header with a token comment",
            "env:\n  NPMRC: | # auth for NPM_TOKEN\n    line-one\n    probe-line-two\n\n    probe-after-blank\nnext: 1\n",
            "probe-after-blank",
        ),
        (
            "flag block item with a token comment",
            "args:\n  - --api-key\n  - >- # API_KEY from vault\n    line-one\n    probe-line-two\nnext: 1\n",
            "probe-line-two",
        ),
    ] {
        let view = mask(FileClass::Plain, input).text;
        assert!(!view.contains(hidden), "{sample}: {view:?}");
        assert!(view.contains("next: 1"), "{sample}: {view:?}");
    }
}

/// A token line also masks every following line indented deeper than itself
/// (blank lines inside included) and ends at the first line at or below its
/// indentation, whatever the line looks like: no header syntax is inspected.
#[test]
fn token_line_masks_deeper_indented_lines_structurally() {
    for (sample, input, hidden) in [
        (
            "dotted key block",
            "data:\n  db_password.txt: |\n    a\n    probe-b\n\n    probe-c\nnext: 1\n",
            "probe-c",
        ),
        (
            "bare item with comment",
            "args:\n  - | # needs the API_KEY\n    a\n    probe-b\nnext: 1\n",
            "probe-b",
        ),
        (
            "slash key",
            "annotations:\n  example.com/pgpass: | # holds the DB_PASSWORD\n    a\n    probe-b\nnext: 1\n",
            "probe-b",
        ),
        (
            "spaced key",
            "db pass file: | # DB_PASSWORD\n  a\n  probe-b\nnext: 1\n",
            "probe-b",
        ),
        (
            "nested map under a secret key",
            "api_key:\n  id: one\n  nested:\n    probe-deep: two\nnext: 1\n",
            "probe-deep",
        ),
        (
            "folded with keep",
            "signing_key: >+2\n  a\n  probe-b\nnext: 1\n",
            "probe-b",
        ),
        (
            "gnu style mixed indent ends at column 0",
            "\t    x_key: 1\n\t      probe-b\nnext: 1\n",
            "probe-b",
        ),
        (
            "nested mixed-kind token lines of equal width",
            "    a_key:\n        probe-q0\n\t\t\t\tb_key: x\n\t\tprobe-q1\nnext: 1\n",
            "probe-q1",
        ),
        ("tabs", "x_key:\n\ta\n\tprobe-b\nnext: 1\n", "probe-b"),
        (
            "mixed tab and space stays open",
            "    x_key:\n        a\n\tprobe-b\nnext: 1\n",
            "probe-b",
        ),
    ] {
        let view = mask(FileClass::Plain, input).text;
        assert!(!view.contains(hidden), "{sample}: {view:?}");
        assert!(view.contains("next: 1"), "{sample}: {view:?}");
    }
    // the run ends at the first non-blank line at or below the token line's indent
    let view = mask(
        FileClass::Plain,
        "  x_key: |\n    a\n    b\n  public: 1\n    c\n",
    )
    .text;
    assert!(view.contains("public: 1"), "{view:?}");
    assert!(view.contains("    c"), "{view:?}");
}

/// Tabs and spaces cannot be ordered against each other, so a run opened with
/// one kind stays open across lines indented with the other kind (fail closed)
/// and ends only at column 0. Every row hides its probe line only because an
/// OLDER block is preserved (or a mixed-kind line keeps the block open): a
/// block replaced by a later token line of the same width but another kind,
/// or a mixed comparison that ordered by byte width, would show it.
#[test]
fn mixed_tab_space_indentation_keeps_every_older_block_open() {
    for (sample, input, hidden) in [
        (
            // block B (2 tabs) shares its width with block A (2 spaces) but not its
            // kind: A must survive B, and only A keeps the tab-only probe masked
            "older space block survives an equal-width tab block",
            "  a_key:\n    a1\n\t\tb_key: 1\n\t\t\tb1\n\tprobe-c\nnext: 1\n",
            "probe-c",
        ),
        (
            // the mirror image: only the older tab block keeps a space-only probe open
            "older tab block survives an equal-width space block",
            "\t\ta_key:\n\t\t\ta1\n  b_key: 1\n    b1\n probe-c\nnext: 1\n",
            "probe-c",
        ),
        (
            // the probe is shallower than both blocks by byte width
            "shallower mixed probe stays open under both blocks",
            "    a_key:\n        a1\n\t\t\t\tb_key: 1\n\t\t\t\t\tb1\n\tprobe-c\nnext: 1\n",
            "probe-c",
        ),
        (
            // C15b-5: the probe's indentation is a strict PREFIX of the block's mixed
            // indentation, so it is really shallower; the ordering is not decided
            // from prefixes and the run over-masks (documented fail-closed limit)
            "strict-prefix probe of a mixed-indent block over-masks",
            "\t    x_key: 1\n\t      a\n\tprobe-b\nnext: 1\n",
            "probe-b",
        ),
        (
            "strict-prefix probe of a mixed-indent block, spaces first",
            "    \tx_key: 1\n    \t  a\n    probe-b\nnext: 1\n",
            "probe-b",
        ),
    ] {
        let view = mask(FileClass::Plain, input).text;
        assert!(!view.contains(hidden), "{sample}: {view:?}");
        assert!(view.contains("next: 1"), "{sample}: {view:?}");
    }
    // control: a same-kind probe at or below the block's indentation ends the run
    for (sample, input) in [
        ("tabs only", "\t\ta_key:\n\t\t\ta1\n\tpublic-c\nnext: 1\n"),
        (
            "spaces only",
            "    a_key:\n        a1\n  public-c\nnext: 1\n",
        ),
    ] {
        let view = mask(FileClass::Plain, input).text;
        assert!(view.contains("public-c"), "{sample}: {view:?}");
    }
}

#[test]
fn token_words_mask_whole_lines_and_exactly_one_following_nonblank_line() {
    for name in [
        "_TOKEN",
        "_KEY",
        "_SECRET",
        "_PASSWORD",
        "Password",
        "9_api_key",
        "openaiApiKey",
        "api-key",
        "hf-token",
        "Hf_Token",
        "aPi_kEy",
        "my-PASSWORD_KEY",
    ] {
        let text = format!("prefix {name} suffix\r\nnext value\r\nvisible\r\n");
        let view = mask(FileClass::Plain, &text);
        assert_eq!(
            view.text,
            "⟦redacted line⟧\r\n⟦redacted line⟧\r\nvisible\r\n".to_string()
        );
        assert_eq!(view.spans.len(), 2);
        assert_eq!(
            &text[view.spans[0].orig.clone()],
            format!("prefix {name} suffix")
        );
        assert_eq!(&text[view.spans[1].orig.clone()], "next value");
        assert!(view.overlaps_span(&view.spans[0].view));
        assert!(view.overlaps_span(&view.spans[1].view));
    }
    assert_eq!(
        masked(FileClass::Plain, "API_KEY anything\n\nvisible\n"),
        "⟦redacted line⟧\n\nvisible\n"
    );
    // a whitespace-only line inside the run has bytes: they are masked too
    assert_eq!(
        masked(
            FileClass::Plain,
            "API_KEY anything\n  \t\n  deeper\nvisible\n"
        ),
        "⟦redacted line⟧\n⟦redacted⟧\n⟦redacted⟧\nvisible\n"
    );
    assert_eq!(
        masked(FileClass::Plain, "x API_KEY\ny HF_TOKEN\nz\nvisible\n"),
        "⟦redacted line⟧\n⟦redacted line⟧\n⟦redacted line⟧\nvisible\n"
    );
    assert_eq!(
        masked(FileClass::Plain, "é API_KEY=é\n"),
        "⟦redacted line⟧\n"
    );
}

#[test]
fn nonsecret_words_and_public_content_stay_visible() {
    let public = pem("PUBLIC KEY", "PUBLICBODY\n");
    let cert = pem("CERTIFICATE", "CERTBODY\n");
    let aws = aws_style_id();
    for text in [
        "max_tokens=4096\n",
        "MAX_TOKENS=4096\n",
        "--max-tokens 4096\n",
        "TOKENS\n",
        "KEYBOARD\n",
        "TOKEN=example\n",
        "KEY=example\n",
        "MYPASSWORD=example\n",
        "PASSWORDPASSWORD\n",
        "A_TOKENB\n",
        "API_KEYS\n",
        "api-key-file\n",
        "hf-tokenizer\n",
        "plain prose about a token and a key\n",
        "--api-key-file path\n",
        "--tokenizer gpt2 --token-limit 5\n",
        public.as_str(),
        cert.as_str(),
        aws.as_str(),
    ] {
        assert_eq!(masked(FileClass::Plain, text), text, "{text:?}");
    }
}

#[test]
fn dotenv_and_secret_flags_keep_their_class_and_tail_rules() {
    let private_block = pem("PRIVATE KEY", "API_KEY\n");
    for (class, text, expected) in [
        (
            FileClass::Dotenv,
            "HF_TOKEN=value-one\nPORT=8080\n",
            "HF_TOKEN=⟦redacted:9⟧\nPORT=⟦redacted:4⟧\n",
        ),
        (
            FileClass::Dotenv,
            "# apiKey=value-one\n# next\n# shown\n",
            "⟦redacted line⟧\n⟦redacted line⟧\n# shown\n",
        ),
        (
            FileClass::Dotenv,
            "A=\nB=\"x\"\nunknown line\n",
            "A=\nB=⟦redacted:3⟧\n⟦redacted⟧\n",
        ),
        (FileClass::Dotenv, "# comment\n\n", "# comment\n\n"),
        (
            FileClass::Plain,
            "run --api-key value-one --ctx 4\nvisible\n",
            "run --api-key ⟦redacted:17⟧\nvisible\n",
        ),
        (
            FileClass::Plain,
            "--hf-token=value-one\n",
            "--hf-token=⟦redacted:9⟧\n",
        ),
        (
            FileClass::Plain,
            "run --token\n-value\nvisible\n",
            "run --token\n⟦redacted:6⟧\nvisible\n",
        ),
        (
            FileClass::Plain,
            "--api-key=$KEY\nvisible\n",
            "--api-key=$KEY\nvisible\n",
        ),
        (
            FileClass::Plain,
            "args:\n  - \"--hf-token\"\n  - value-one\n  - --x\n",
            "args:\n  - \"--hf-token\"\n  - ⟦redacted:9⟧\n  - --x\n",
        ),
        (
            FileClass::Plain,
            "--api-key \\\nvalue-one \\\nnext\n\nvisible\n",
            "--api-key \\\n⟦redacted:11⟧\n⟦redacted⟧\n\nvisible\n",
        ),
        (FileClass::HfToken, "value-one\n\n", "⟦redacted:9⟧\n\n"),
        (FileClass::HfToken, "apiKey\n", "⟦redacted:6⟧\n"),
        (FileClass::SshPrivateKey, "API_KEY\n", "⟦redacted⟧\n"),
        (
            FileClass::Plain,
            private_block.as_str(),
            "⟦redacted⟧\n⟦redacted⟧\n⟦redacted⟧\n",
        ),
    ] {
        assert_eq!(masked(class, text), expected, "{class:?}: {text:?}");
    }
}

/// A PEM block with a run-time label: the committed source must not contain a
/// literal `-----BEGIN ... PRIVATE KEY-----` line (the CI secret scan and the
/// CLI policy checks grep for it).
fn pem(label: &str, body: &str) -> String {
    format!("-----BEGIN {label}-----\n{body}-----END {label}-----\n")
}

/// An AWS-style access-key-id placeholder, built at run time: the committed
/// source must not contain a 20-character id of that shape (the CLI policy
/// checks and the CI secret scan grep for it).
fn aws_style_id() -> String {
    format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE")
}

/// A PEM block whose `END` line is missing.
fn pem_open(label: &str, body: &str) -> String {
    format!("-----BEGIN {label}-----\n{body}")
}

/// Whole-file classes (`id_*`) and the by-label rule for `*.pem`/`*.key`
/// files, plus private-key blocks in ANY file (owner decision).
#[test]
fn key_blocks_are_masked_by_class_and_label() {
    let bare = "\u{27E6}redacted\u{27E7}\n";
    let ssh = pem("OPENSSH PRIVATE KEY", "AAAA\n");
    assert_eq!(masked(FileClass::SshPrivateKey, &ssh), bare.repeat(3));
    assert_eq!(
        masked(FileClass::SshPrivateKey, "anything\n\ngoes"),
        format!("{bare}\n{bare}").trim_end_matches('\n')
    );
    let cert = pem("CERTIFICATE", "MIIB\n");
    let rsa = pem("RSA PRIVATE KEY", "K1\nK2\n");
    assert_eq!(
        masked(FileClass::PemKey, &format!("{cert}{rsa}after\n")),
        format!("{cert}{bare}{bare}{bare}{bare}after\n")
    );
    let unterminated = pem_open("PRIVATE KEY", "unterminated\nrest\n");
    assert_eq!(masked(FileClass::PemKey, &unterminated), bare.repeat(3));
    let public = pem("PUBLIC KEY", "MIIB\n");
    assert_eq!(masked(FileClass::PemKey, &public), public);
    // a private key pasted into a plain file IS masked (owner decision: content-based)
    let pasted = pem("PRIVATE KEY", "K\n");
    assert_eq!(masked(FileClass::Plain, &pasted), bare.repeat(3));
}

/// Owner decision: whenever a `BEGIN ... PRIVATE KEY` line appears in any file,
/// everything through the matching `END` line is masked; no END masks to the end
/// of what is scanned; public keys and certificates stay visible.
#[test]
fn private_key_blocks_are_masked_in_any_file_by_content() {
    let kinds = [
        "PRIVATE KEY",
        "RSA PRIVATE KEY",
        "EC PRIVATE KEY",
        "DSA PRIVATE KEY",
        "OPENSSH PRIVATE KEY",
        "ENCRYPTED PRIVATE KEY",
    ];
    for kind in kinds {
        let (begin, end) = (
            format!("-----BEGIN {kind}-----"),
            format!("-----END {kind}-----"),
        );
        for class in [FileClass::Plain, FileClass::Dotenv, FileClass::PemKey] {
            let text = format!("before\n{begin}\nBODYLINEONE\nBODYLINETWO\n{end}\nafter\n");
            let view = masked(class, &text);
            assert!(!view.contains("BODYLINE"), "{kind} {class:?}: {view:?}");
            assert!(
                !view.contains("BEGIN") && !view.contains("END"),
                "{kind} {class:?}: {view:?}"
            );
            if class == FileClass::Plain {
                assert!(
                    view.starts_with("before\n") && view.ends_with("after\n"),
                    "{view:?}"
                );
            }
        }
        // embedded in YAML (indented block scalar), JSON (one line), and a doc
        let yaml = format!("key: |\n  {begin}\n  BODYLINEONE\n  {end}\nnext: 1\n");
        let view = masked(FileClass::Plain, &yaml);
        assert!(
            !view.contains("BODYLINE") && view.ends_with("next: 1\n"),
            "{view:?}"
        );
        let json = format!("{{\"k\": \"{begin}\\nBODYLINEONE\\n{end}\\n\", \"n\": 1}}\n");
        assert!(!masked(FileClass::Plain, &json).contains("BODYLINE"));
        // no END: masked to the end of what is scanned
        let open = format!("head\n{begin}\nBODYLINEONE\nBODYLINETWO\n");
        let view = masked(FileClass::Plain, &open);
        assert_eq!(view.matches("BODYLINE").count(), 0, "{view:?}");
        assert!(view.starts_with("head\n"));
    }
    // an END binds to its own label; a mismatched END closes nothing (fail closed);
    // nested and same-line transitions keep every open block masked
    let marker = |kind: &str, label: &str| format!("-----{kind} {label}-----");
    let (ec_open, rsa_open) = (
        marker("BEGIN", "EC PRIVATE KEY"),
        marker("BEGIN", "RSA PRIVATE KEY"),
    );
    let (ec_end, rsa_end) = (
        marker("END", "EC PRIVATE KEY"),
        marker("END", "RSA PRIVATE KEY"),
    );
    for (text, must_end_visible) in [
        (format!("{ec_open}\nBODYA\n{rsa_end}\nBODYB\n"), false),
        (
            format!("{rsa_open}\n{ec_open}\nBODYA\n{ec_end}\nBODYB\n{rsa_end}\ntail\n"),
            true,
        ),
        (
            format!("{ec_end}{rsa_open}\nBODYA\nBODYB\n{rsa_end}\ntail\n"),
            true,
        ),
        (
            format!("{rsa_end}{ec_open}\nBODYA\n{ec_end}{rsa_open}\nBODYB\n{rsa_end}\ntail\n"),
            true,
        ),
    ] {
        let view = masked(FileClass::Plain, &format!("head\n{text}"));
        assert!(!view.contains("BODY"), "{text:?} -> {view:?}");
        assert!(view.starts_with("head\n"), "{view:?}");
        assert!(!must_end_visible || view.ends_with("tail\n"), "{view:?}");
    }
    // no cap on open blocks: 20 BEGINs, closed one END at a time, keep the rest masked
    let begin = marker("BEGIN", "RSA PRIVATE KEY");
    let end = marker("END", "RSA PRIVATE KEY");
    let deep = format!(
        "{}BODYDEEP\n{}tail\n",
        format!("{begin}\n").repeat(20),
        format!("{end}\n").repeat(19)
    );
    let view = masked(FileClass::Plain, &deep);
    assert!(
        !view.contains("BODYDEEP") && !view.ends_with("tail\n"),
        "{view:?}"
    );
    // markers that share their hyphens: `END CERT-----BEGIN KEY`
    let shared = format!("head\n-----END CERTIFICATE{begin}\nSHAREDBODY\n{end}\ntail\n");
    let view = masked(FileClass::Plain, &shared);
    assert!(
        !view.contains("SHAREDBODY") && view.ends_with("tail\n"),
        "{view:?}"
    );
    // public keys and certificates stay visible
    for label in [
        "PUBLIC KEY",
        "CERTIFICATE",
        "RSA PUBLIC KEY",
        "CERTIFICATE REQUEST",
    ] {
        let text = pem(label, "PUBLICBODY\n");
        assert_eq!(masked(FileClass::Plain, &text), text, "{label}");
    }
    // a private key that follows a certificate in the same file
    let both = format!(
        "{}{}tail\n",
        pem("CERTIFICATE", "CERTBODY\n"),
        pem("PRIVATE KEY", "KEYBODY\n")
    );
    let view = masked(FileClass::Plain, &both);
    assert!(
        view.contains("CERTBODY") && !view.contains("KEYBODY") && view.ends_with("tail\n"),
        "{view:?}"
    );
}

#[test]
fn masked_view_never_changes_line_count() {
    let pem_text = pem("PRIVATE KEY", "A\nB\n");
    for (class, text) in [
        (FileClass::PemKey, pem_text.as_str()),
        (FileClass::Plain, "run \\\n --api-key \\\n s\\\n x\n"),
        (FileClass::Dotenv, "A=1\r\nB=2\r\n\r\n"),
        (FileClass::SshPrivateKey, "a\nb\n\nc"),
    ] {
        let view = mask(class, text);
        assert_eq!(
            view.text.matches('\n').count(),
            text.matches('\n').count(),
            "{text:?}"
        );
    }
}

#[test]
fn secret_values_never_survive_in_view() {
    let ec_key = pem_open("EC PRIVATE KEY", "TOPSECRET\n");
    for (class, text, secret) in [
        (FileClass::Dotenv, "A=zzTOPSECRETzz # tail\n", "TOPSECRET"),
        (
            FileClass::Plain,
            "X_TOKEN=\"a\\\"TOPSECRET\"\n",
            "TOPSECRET",
        ),
        (FileClass::Plain, "--api-key\n  TOPSECRET\n", "TOPSECRET"),
        (FileClass::PemKey, ec_key.as_str(), "TOPSECRET"),
    ] {
        assert!(!mask(class, text).text.contains(secret), "{text:?}");
    }
}

#[test]
fn classification_by_physical_path() {
    use FileClass::{Dotenv, HfToken, PemKey, Plain, SshPrivateKey};
    for (path, expected) in [
        ("/h/.ssh/id_ed25519", SshPrivateKey),
        ("/h/.ssh/id_rsa.pub", Plain),
        ("/h/.ssh/id_x.bak", SshPrivateKey),
        ("/h/.cache/huggingface/token", HfToken),
        ("/h/.huggingface/token", HfToken),
        ("/h/other/token", Plain),
        ("/x/server.pem", PemKey),
        ("/x/server.key", PemKey),
        ("/x/.env", Dotenv),
        ("/x/.env.local", Dotenv),
        ("/x/prod.env", Dotenv),
        ("/x/.envrc", Dotenv),
        ("/c/service.env", Dotenv),
        ("/x/environment", Plain),
        ("/x/config.yaml", Plain),
    ] {
        assert_eq!(classify(Path::new(path)), expected, "{path}");
    }
}

#[test]
fn span_mapping_round_trips_positions() {
    let text = "a=1\nB_TOKEN=hunter22\nz=9\n\nend\n";
    let view = mask(FileClass::Plain, text);
    assert_eq!(view.text, "a=1\n⟦redacted line⟧\n⟦redacted line⟧\n\nend\n");
    assert_eq!(view.redactions(), 2);
    let z_view = view.text.find("end").unwrap();
    let z_orig = text.find("end").unwrap();
    assert_eq!(view.to_orig(z_view), z_orig);
    let span = &view.spans[0];
    assert!(view.overlaps_span(&(span.view.start - 1..span.view.start + 1)));
    assert!(!view.overlaps_span(&(0..span.view.start)));
    assert!(!view.overlaps_span(&(span.view.end..span.view.end + 1)));
    assert!(view.overlaps_span(&(span.view.start + 2..span.view.start + 2)));
    assert!(!view.overlaps_span(&(span.view.start..span.view.start)));
}

// ---- streaming API and speed (owner requirement: masking must not slow the CLI) ----

#[test]
fn line_masker_matches_whole_text_masking() {
    let corpus = mixed_corpus(200);
    for class in [
        FileClass::Plain,
        FileClass::Dotenv,
        FileClass::PemKey,
        FileClass::HfToken,
        FileClass::SshPrivateKey,
    ] {
        let whole = mask(class, &corpus).text;
        let mut masker = LineMasker::new(class);
        let streamed: String = corpus
            .split_inclusive('\n')
            .map(|raw| {
                let body = raw.trim_end_matches(['\n', '\r']);
                format!("{}{}", masker.mask_line(body), &raw[body.len()..])
            })
            .collect();
        assert_eq!(streamed, whole, "{class:?}");
    }
}

/// About 1 MiB of mixed text: config lines, prose, env assignments, flags,
/// and a few secret names, exercising tokenization and flag recognition.
fn mixed_corpus(repeat: usize) -> String {
    let block = "# deployment notes for the model node\n\
            exec llama-server --ctx-size 32768 --port 8080 --threads 16 \\\n\
            model: /models/qwen3/qwen3-27b-q4_k_m.gguf\n\
            MAX_TOKENS=4096\n\
            the quick brown fox jumps over the lazy dog, again and again and again\n\
            export HF_TOKEN=fake-value-one-two-three\n\
            run --api-key fake-value-four --verbose\n\
            [Service]\nEnvironment=\"DB_PASSWORD=correct horse\"\nLimitNOFILE=65535\n\
            timeout: 30s\nretries: 3\nlog_level: debug\nlisten: 0.0.0.0:8000\n\
            just a plain line of documentation text without anything special in it at all\n";
    let mut out = String::new();
    while out.len() < 1024 * repeat * 5 {
        out.push_str(block);
    }
    out
}

fn plain_corpus() -> String {
    let block = "the quick brown fox jumps over the lazy dog, again and again and again\n\
            timeout: 30s\nretries: 3\nlog_level: debug\nlisten: 0.0.0.0:8000\n\
            exec llama-server --ctx-size 32768 --port 8080 --threads 16\n\
            just a plain line of documentation text without anything special in it at all\n";
    let mut out = String::new();
    while out.len() < 1024 * 1024 {
        out.push_str(block);
    }
    out
}

/// Token lines open the retained multi-line constructs without format parsers.
#[test]
fn token_line_constructs_mask_through_structural_ends() {
    let rows = [
        "api_key: |\n  first-value\n\n  second-value\nvisible: yes\n",
        "api-key: >-\n  first-value\n  second-value\nvisible: yes\n",
        "'Hf_Token': !tag |+2 # note\n  first-value\n  second-value\nvisible: yes\n",
        "apiKey = \"\"\"\nfirst-value\n\"\"\"second-value\n\nvisible\n",
        "Password='first-value'\"open\nsecond-value\"\nthird-value\n\nvisible\n",
        "foo_secret=first-value\\\nsecond-value\nthird-value\n\nvisible\n",
    ];
    for text in rows {
        let view = masked(FileClass::Plain, text);
        for value in ["first-value", "second-value", "third-value"] {
            assert!(!view.contains(value), "{text:?}: {view:?}");
        }
        assert!(view.contains("visible"), "{text:?}: {view:?}");
    }
}

#[test]
fn a_yaml_block_scalar_ends_at_the_first_dedent_and_blank_lines_do_not_end_it() {
    let text = "a:\n  TLS_KEY: |\n    line1\n\n    line2\n  other: shown\nb: shown\n";
    assert_eq!(
        masked(FileClass::Plain, text),
        "a:\n⟦redacted line⟧\n⟦redacted line⟧\n\n\u{27E6}redacted\u{27E7}\n  other: shown\nb: shown\n"
    );
}

#[test]
fn whole_line_quote_parity_does_not_open_a_spurious_continuation() {
    assert_eq!(
        masked(
            FileClass::Plain,
            "run: echo \"HF_TOKEN=$X\" >> $GITHUB_ENV\nnext: 1\nvisible: yes\n"
        ),
        "⟦redacted line⟧\n⟦redacted line⟧\nvisible: yes\n"
    );
    // A name/value reference occupies only the one line covered by the rule.
    assert_eq!(
        masked(
            FileClass::Plain,
            "  name: API_KEY\n  valueFrom: {secretKeyRef: {name: service, key: credential}}\nvisible: yes\n"
        ),
        "⟦redacted line⟧\n⟦redacted line⟧\nvisible: yes\n"
    );
}

#[test]
fn structural_ends_show_public_text_again_and_only_there() {
    use FileClass::Plain;
    // a YAML block scalar ends at the first non-blank line at or below the KEY LINE's
    // indentation (the line's own, so a quoted key or a `- ` item does not shift it;
    // a deeper sibling of a list item is over-masked, never leaked)
    assert_eq!(
        masked(Plain, "\"K_TOKEN\": |\n one\n\n two\nvisible: 1\n"),
        "⟦redacted line⟧\n⟦redacted line⟧\n\n\u{27E6}redacted\u{27E7}\nvisible: 1\n"
    );
    assert_eq!(
        masked(Plain, "- K_KEY: >-\n    body\n  sibling: 1\ntop: 1\n"),
        "⟦redacted line⟧\n⟦redacted line⟧\n\u{27E6}redacted\u{27E7}\ntop: 1\n"
    );
    // every other multi-line form ends at the first blank line, not at a quote
    assert_eq!(
        masked(Plain, "K_TOKEN=\"a\nb\" tail\nc\n\nvisible\n"),
        "⟦redacted line⟧\n⟦redacted line⟧\n\u{27E6}redacted\u{27E7}\n\nvisible\n"
    );
    // a region that never reaches a blank line is masked to its end
    assert_eq!(
        masked(Plain, "K_TOKEN=\"a\nb\nc\n"),
        "⟦redacted line⟧\n⟦redacted line⟧\n\u{27E6}redacted\u{27E7}\n"
    );
}

#[test]
fn classification_ignores_case_and_secret_scopes_cover_their_directories() {
    use std::path::Path;
    for (path, class) in [
        ("/h/.ssh/ID_ED25519", FileClass::SshPrivateKey),
        ("/h/.ssh/ID_ED25519.PUB", FileClass::Plain),
        ("/p/.ENV", FileClass::Dotenv),
        ("/p/Prod.Env", FileClass::Dotenv),
        ("/p/.Env.Local", FileClass::Dotenv),
        ("/h/.Cache/HuggingFace/Token", FileClass::HfToken),
        ("/p/Server.PEM", FileClass::PemKey),
        // Unicode folds a case-insensitive / normalization-insensitive volume applies
        ("/p/server.\u{212A}ey", FileClass::PemKey),
        ("/h/.cache/huggingface/to\u{212A}en", FileClass::HfToken),
        ("/h/.ssh/\u{212A}id_x", FileClass::SshPrivateKey),
        ("/h/.ssh/github_ed25519", FileClass::SshPrivateKey),
        ("/h/.ssh/keys/deploy_key", FileClass::SshPrivateKey),
        ("/h/.ssh/id_rsa.pub", FileClass::Plain),
        ("/h/.ssh/github_ed25519.pub", FileClass::Plain),
        ("/h/.ssh/config", FileClass::Plain),
        ("/h/.ssh/known_hosts", FileClass::Plain),
        ("/h/.ssh/authorized_keys", FileClass::Plain),
        ("/h/ssh/github_ed25519", FileClass::Plain),
        ("/h/.cache/huggingface/stored_tokens", FileClass::HfToken),
        ("/h/.huggingface/stored_tokens", FileClass::HfToken),
        ("/mnt/usb/prod.env.", FileClass::Dotenv),
        ("/mnt/usb/prod.env. ", FileClass::Dotenv),
        ("/h/.cache/huggingface/token.", FileClass::HfToken),
        ("/mnt/usb/server.pem.", FileClass::PemKey),
        (
            "/h/.cache/huggingface/\u{FB05}ored_tokens",
            FileClass::HfToken,
        ),
        (
            "/h/.cache/huggingface/\u{FB06}ored_tokens",
            FileClass::HfToken,
        ),
        ("/h/.cache/huggingface/\u{FB01}le", FileClass::Plain),
        ("/h/.ssh/id_\u{212A}", FileClass::SshPrivateKey),
    ] {
        assert_eq!(classify(Path::new(path)), class, "{path}");
    }
    for path in [
        "/h/.ssh",
        "/h/.SSH/config",
        "/h/.ssh/keys/new",
        "/h/.huggingface",
        "/h/.cache/huggingface",
        "/h/.cache/HuggingFace/hub/x",
        "/h/.cache",
        "/p/.env",
        "/h/.\u{DF}h",
        "/h/.\u{17F}sh/config",
        "/h/.\u{1E9E}h",
    ] {
        assert!(is_secret_scope(Path::new(path)), "{path}");
    }
    for path in [
        "/h/.cache/pip/x",
        "/h/notes.txt",
        "/h/ssh/config",
        "/h/.sshd/x",
    ] {
        assert!(!is_secret_scope(Path::new(path)), "{path}");
    }
}

/// One crafted line of many overlapping candidates must not cost more than
/// a linear scan (each candidate's value used to be rescanned to the end).
#[test]
fn adversarial_lines_are_masked_in_linear_time() {
    use std::time::{Duration, Instant};
    let corpora = [
        "X_KEY=,".repeat(60_000),
        ",--token=".repeat(50_000),
        "A_KEY=\"".repeat(40_000),
        "--password ".repeat(40_000),
        "X_KEY:".repeat(60_000),
        // suffix-heavy names: every suffix end is followed by a name byte
        "_KEY".repeat(200_000),
        "PASSWORD".repeat(100_000),
        "A_TOKENB".repeat(100_000),
        "_KEY_TOKEN_SECRET".repeat(50_000),
        "_key".repeat(200_000),
        "password".repeat(100_000),
        "a_tokenb".repeat(100_000),
        // thousands of distinct private-key labels on one line, then many short lines
        {
            let markers: String = (0..18_000)
                .map(|i| format!("-----BEGIN {i}PRIVATE KEY-----"))
                .collect();
            format!("{markers}\n{}", "x\n".repeat(250_000))
        },
    ];
    for text in &corpora {
        for class in [FileClass::Plain, FileClass::Dotenv] {
            let started = Instant::now();
            let view = mask(class, text);
            std::hint::black_box(&view);
            let took = started.elapsed();
            if class == FileClass::Plain {
                let has_name = !text.starts_with("PASSWORD")
                    && !text.starts_with("password")
                    && !text.starts_with("A_TOKENB")
                    && !text.starts_with("a_tokenb");
                if text.starts_with('_') {
                    assert!(view.text.starts_with("⟦redacted line⟧"));
                } else if !has_name {
                    assert_eq!(view.text, *text);
                }
            }
            // superlinear behaviour measured minutes here; a linear scan is
            // milliseconds (seconds is generous for a loaded debug build)
            assert!(
                took < Duration::from_secs(8),
                "{class:?} {:?}: {took:?}",
                &text[..12]
            );
        }
    }
}

#[test]
fn merged_masks_are_counted_once_over_the_merged_range() {
    let line = "abcdef";
    let merged = merge(
        vec![
            (0..3, token(3)),
            (2..5, token(3)),
            (4..6, token(2)),
            (9..9, token(0)),
        ],
        "abcdef",
    );
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0], (0..6, token(line.chars().count())));
}

#[test]
fn a_line_masker_masks_a_multi_line_value_until_a_blank_line_for_every_class() {
    for class in [FileClass::Plain, FileClass::PemKey] {
        let mut masker = LineMasker::new(class);
        assert_eq!(masker.mask_line("K_TOKEN=\"one"), "⟦redacted line⟧");
        assert!(masker.in_continuation());
        assert_eq!(masker.mask_line("two"), "⟦redacted line⟧");
        // a closing quote does not end masking; only the blank line does
        assert_eq!(masker.mask_line("three\" ok"), "\u{27E6}redacted\u{27E7}");
        assert_eq!(masker.mask_line("still masked"), "\u{27E6}redacted\u{27E7}");
        assert_eq!(masker.mask_line(""), "");
        assert!(!masker.in_continuation());
        assert_eq!(masker.mask_line("visible"), "visible");
    }
}

/// The reader/full-view contract behind the lookback: a read that starts its
/// masker at the lookback line must mask at least what the whole-file view
/// masks, for every window start, whenever the file has no masked run longer
/// than the lookback (`long_construct`, the case edits refuse to create).
/// Random documents from a small hostile line pool, tiny lookback.
#[cfg(unix)] // The windowed reader is Unix-only; command masking also builds elsewhere.
#[test]
fn a_windowed_read_masks_at_least_what_the_full_view_masks() {
    use crate::file_ops::ops::read::lookback_start_with;
    let pool = [
        "K_TOKEN=\"open",
        "close\"",
        "K_KEY: |",
        "- | # API_KEY",
        "\tdb_password.txt:",
        "  body-secret",
        "    deeper",
        "x: 1",
        "",
        "",
        "plain text",
        "run --token",
        "-flag-secret",
        "A_KEY='a",
        "b'\"c",
        "M_SECRET=v \\",
        "cont-secret",
        "\"K_SECRET\": >-",
        " folded",
        "- Z_KEY: |",
        "  - item",
        "P_PASSWORD:ab",
        "//",
        "K_TOKEN=\"\"\"",
        "triple-body",
        "\"\"\"",
        "it's fine",
    ];
    let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut checked = 0;
    // hand-written shapes first (a reader that starts INSIDE a run whose body holds
    // an opener), then random documents from the pool
    let fixed: [&[&str]; 6] = [
        // interleaved private-key blocks of three labels: an END closes only its own
        // block, so a reader that starts after `BEGIN X` still masks the RSA body
        &[
            concat!("-----BEGIN ", "X PRIVATE KEY-----"),
            "P1",
            concat!("-----BEGIN ", "A PRIVATE KEY-----"),
            "ppppp",
            "ppppp",
            "ppppp",
            concat!("-----END ", "X PRIVATE KEY-----"),
            concat!("-----BEGIN ", "RSA PRIVATE KEY-----"),
            concat!("-----END ", "A PRIVATE KEY-----"),
            "BODY-secret-line",
            concat!("-----END ", "RSA PRIVATE KEY-----"),
            "outro",
        ],
        &[
            concat!("-----BEGIN ", "RSA PRIVATE KEY-----"),
            concat!("-----BEGIN ", "EC PRIVATE KEY-----"),
            "BODY-secret-line",
            concat!("-----END ", "EC PRIVATE KEY-----"),
            "more-secret-body",
            concat!("-----END ", "RSA PRIVATE KEY-----"),
            "after",
        ],
        &[
            "E_KEY: |",
            "  eeeeeeee",
            "  eeeeeeee",
            "  eeeeeeee",
            "  Y_TOKEN=\"open",
            "  more",
            "end-of-e",
            "gapgapgapgap",
            "gapgapgapgap",
            "DEPLOY_KEY: |",
            "  line-one",
            "",
            "  hunter2-block-secret",
            "done: yes",
        ],
        &[
            "echo start",
            "E_TOKEN=\"open",
            "    Y_KEY: |",
            "      deeper-one",
            "      deeper-two",
            "",
            "      gap",
            "      gap",
            "      API_TOKEN=\"first",
            "second-line-secret\"",
            "",
            "echo end",
        ],
        &[
            "-flag-secret",
            "close\"",
            "x: 1",
            "triple-body",
            "M_SECRET=v \\",
            "cont",
            "",
            "after",
        ],
        &[
            "  - name: N_TOKEN",
            "    value: pair-secret",
            "  - name: M_KEY",
            "    ",
            "    value: two-secret",
            "next: 1",
        ],
    ];
    let mut docs: Vec<Vec<&str>> = fixed.iter().map(|d| d.to_vec()).collect();
    // sweep the alignment: a reader that starts inside a block whose body holds an
    // opener, at every distance from the window
    let pads: Vec<String> = (0..40).map(|n| "p".repeat(n)).collect();
    let y_lines: Vec<String> = (0..40)
        .map(|n| format!("  Y_TOKEN=\"open{}", "x".repeat(n)))
        .collect();
    for (pad, y_line) in pads.iter().zip(&y_lines) {
        docs.push(vec![
            "E_KEY: |",
            "  ee",
            y_line,
            "  more",
            "DEPLOY_KEY: |",
            "",
            "  hunter2-block-secret",
            "done: yes",
        ]);
        docs.push(vec![
            "E_KEY: |",
            "  ee",
            y_line,
            "  more",
            "end-of-e",
            pad,
            "DEPLOY_KEY: |",
            "",
            "  hunter2-block-secret",
            "done: yes",
        ]);
        docs.push(vec![
            "E_TOKEN=\"open",
            "    Y_KEY: |",
            "      deeper",
            "",
            pad,
            "      API_TOKEN=\"first",
            "second-line-secret\"",
            "",
            "echo end",
        ]);
    }
    for _ in 0..2500 {
        let len = 3 + (next() % 38) as usize;
        docs.push(
            (0..len)
                .map(|_| pool[(next() % pool.len() as u64) as usize])
                .collect(),
        );
    }
    for lines in docs {
        let text = lines.join("\n") + "\n";
        for (class, lookback) in [FileClass::Plain, FileClass::Dotenv]
            .into_iter()
            .flat_map(|class| [30_usize, 130].map(|lookback| (class, lookback)))
        {
            let full = mask_with_lookback(class, &text, lookback);
            if full.long_construct {
                continue;
            }
            // per-line masked byte sets of the whole-file scan
            let mut whole = LineMasker::new(class);
            let full_masks: Vec<Vec<std::ops::Range<usize>>> = lines
                .iter()
                .map(|l| whole.scan(l).into_iter().map(|(r, _)| r).collect())
                .collect();
            let offsets: Vec<usize> = lines
                .iter()
                .scan(0, |at, l| {
                    let start = *at;
                    *at += l.len() + 1;
                    Some(start)
                })
                .collect();
            for w in 0..lines.len() {
                let start = lookback_start_with(text.as_bytes(), offsets[w], lookback);
                let first = offsets.iter().position(|o| *o == start).unwrap_or(0);
                let mut reader = LineMasker::new(class);
                for l in &lines[first..w] {
                    let _ = reader.scan(l);
                }
                // the window itself: every line from w on
                for (i, l) in lines.iter().enumerate().skip(w) {
                    let got: Vec<std::ops::Range<usize>> =
                        reader.scan(l).into_iter().map(|(r, _)| r).collect();
                    let covered = |ranges: &[std::ops::Range<usize>], b: usize| {
                        ranges.iter().any(|r| r.start <= b && b < r.end)
                    };
                    for b in 0..l.len() {
                        assert!(
                            !covered(&full_masks[i], b) || covered(&got, b),
                            "{class:?} window {w} line {i} byte {b}: masked in the full view but visible to the reader\n{text:?}"
                        );
                    }
                    checked += 1;
                }
            }
        }
    }
    assert!(checked > 10_000, "{checked}");
}

#[test]
fn masking_one_mebibyte_is_fast_and_a_clean_file_is_nearly_free() {
    use std::time::Instant;
    let mixed = {
        let mut s = mixed_corpus(200);
        s.truncate(s.len().min(1024 * 1024));
        s
    };
    let plain = plain_corpus();
    // warm the lazily compiled regex set once (built once per process, not per call)
    let _ = mask(FileClass::Plain, "X_TOKEN=warm\n");
    let best = |text: &str, class| {
        (0..5)
            .map(|_| {
                let started = Instant::now();
                let view = mask(class, text);
                std::hint::black_box(&view);
                started.elapsed()
            })
            .min()
            .expect("samples")
    };
    let mixed_time = best(&mixed, FileClass::Plain);
    let dotenv_time = best(&mixed, FileClass::Dotenv);
    let clean_time = best(&plain, FileClass::Plain);
    let baseline = {
        let started = Instant::now();
        let copy = plain.clone();
        std::hint::black_box(&copy);
        started.elapsed()
    };
    #[allow(clippy::print_stderr)]
    {
        eprintln!(
            "masking 1 MiB (debug_assertions={}): mixed {:?}, dotenv {:?}, clean {:?} (a plain copy: {:?})",
            cfg!(debug_assertions),
            mixed_time,
            dotenv_time,
            clean_time,
            baseline
        );
    }
    // Generous bounds so a loaded machine does not flake: release measures
    // low single-digit milliseconds, debug an order of magnitude more.
    let (mixed_bound, clean_bound) = if cfg!(debug_assertions) {
        (
            std::time::Duration::from_millis(2500),
            std::time::Duration::from_millis(800),
        )
    } else {
        (
            std::time::Duration::from_millis(50),
            std::time::Duration::from_millis(20),
        )
    };
    assert!(mixed_time < mixed_bound, "mixed {mixed_time:?}");
    assert!(dotenv_time < mixed_bound, "dotenv {dotenv_time:?}");
    assert!(clean_time < clean_bound, "clean {clean_time:?}");
    assert!(mask(FileClass::Plain, &plain).spans.is_empty());
}
