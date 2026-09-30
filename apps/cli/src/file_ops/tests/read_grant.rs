use super::*;

/// Run the filesystem table in a child with a temporary HOME; changing the
/// process environment in this parallel Rust test process would need unsafe.
#[test]
fn roots_and_masking_with_isolated_home() {
    if std::env::var_os("WSMP_READ_GRANT_TEST_HOME").is_none() {
        let home = tempfile::tempdir().expect("home");
        let status = std::process::Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "file_ops::tests::read_grant::roots_and_masking_with_isolated_home",
                "--nocapture",
            ])
            .env("HOME", home.path())
            .env("WSMP_READ_GRANT_TEST_HOME", "1")
            .status()
            .expect("isolated child");
        assert!(status.success(), "isolated filesystem table failed");
        return;
    }
    let home = dirs::home_dir().expect("temporary home");
    let models = home.join("models");
    let outside = home.join("outside");
    std::fs::create_dir(&models).expect("models");
    std::fs::create_dir(&outside).expect("outside");
    std::fs::create_dir(home.join(".ssh")).expect("ssh");
    std::fs::write(models.join("plain"), "visible text\n").expect("plain");
    std::fs::write(outside.join("plain"), "outside text\n").expect("outside file");
    let env = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/masking/read-grant.env"
    ));
    let key = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/masking/read-grant-id_ed25519"
    ));
    std::fs::write(models.join(".env"), env).expect("env");
    std::fs::write(models.join("id_ed25519"), key).expect("key");
    std::fs::write(home.join(".ssh/id_ed25519"), key).expect("ssh key");
    std::os::unix::fs::symlink(&outside, models.join("escape")).expect("symlink");
    let roots = crate::config::validate_file_roots(&[PathBuf::from("~/models")], Some(&home))
        .expect("roots");
    let policy = Policy::from_environment(roots, true);
    assert!(policy.roots_configured());
    let ops = FileOps::new(policy, EtagKey::random());
    let cancel = Cancel::new();
    for path in [
        "~/.ssh/id_ed25519",
        "~/models/escape/plain",
        "~/models/../outside/plain",
    ] {
        assert_eq!(
            code(ops.execute("read", json!({"path":path}), &cancel)),
            ErrorCode::PathDenied,
            "{path}"
        );
    }
    for (op, args) in [
        ("list", json!({"path":"~/outside"})),
        ("search", json!({"root":"~/outside","pattern":"text"})),
        (
            "rename",
            json!({"from":"~/models/plain","to":"~/outside/renamed"}),
        ),
    ] {
        assert_eq!(
            code(ops.execute(op, args, &cancel)),
            ErrorCode::PathDenied,
            "{op}"
        );
    }
    assert!(models.join("plain").exists());
    assert!(!outside.join("renamed").exists());
    let plain = ops
        .execute("read", json!({"path":"~/models/plain"}), &cancel)
        .expect("legitimate read");
    assert!(
        plain["text"]
            .as_str()
            .expect("text")
            .contains("visible text")
    );
    ops.execute("mkdir", json!({"path":"~/models/created"}), &cancel)
        .expect("confined write");
    assert!(models.join("created").is_dir());
    for (path, secret) in [
        (
            "~/models/.env",
            env.lines()
                .next()
                .expect("env assignment")
                .split_once('=')
                .expect("assignment")
                .1,
        ),
        ("~/models/id_ed25519", key.lines().nth(1).expect("key body")),
    ] {
        let read = ops
            .execute("read", json!({"path":path}), &cancel)
            .expect("masked read");
        let text = read["text"].as_str().expect("text");
        assert!(text.contains("⟦redacted"), "{path}");
        assert!(!text.contains(secret), "{path}");
        assert_eq!(
            code(ops.execute("write", json!({"path":path,"content":"plain"}), &cancel)),
            ErrorCode::SecretFile
        );
    }
    let broken = Policy::from_environment(vec![models.join("missing-root")], true);
    assert!(!broken.roots_configured());
    let broken = FileOps::new(broken, EtagKey::random());
    assert_eq!(
        code(broken.execute("read", json!({"path":"~/models/plain"}), &cancel)),
        ErrorCode::PathDenied
    );
}
