use super::*;
use crate::file_ops::tests::Fx;

#[test]
fn final_sidecar_cleanup_keeps_actual_replaced_inode() {
    let fx = Fx::new();
    let parent = nix::fcntl::open(
        &fx.root,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY,
        Mode::empty(),
    )
    .expect("parent");
    let recovery = RecoveryDir::new(&parent, &fx.root).expect("recovery");
    let lock_path = cleanup_lock_path(&recovery.path);
    let successor = fx.root.join("replacement-lock");
    std::fs::write(&successor, b"foreign successor").expect("successor");
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg("mv -- \"$1\" \"$2\"")
        .arg("wsmp-fixture")
        .arg(&successor)
        .arg(&lock_path)
        .status()
        .expect("actual competing process");
    assert!(status.success());
    let lock_name = lock_path.file_name().unwrap();
    unlink_cleanup_lock(&parent, lock_name, recovery.cleanup_lock.as_ref());
    assert_eq!(
        std::fs::read(&lock_path).expect("foreign successor retained"),
        b"foreign successor"
    );
    drop(recovery);
    assert_eq!(
        std::fs::read(&lock_path).expect("drop also retains successor"),
        b"foreign successor"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn recovery_cleanup_abrupt_child_helper() {
    let Some(root) = std::env::var_os("WSMP_RECOVERY_CRASH_FIXTURE") else {
        return;
    };
    let root = PathBuf::from(root);
    let _registry = super::super::registry::install_temp_registry();
    let parent = nix::fcntl::open(&root, OFlag::O_RDONLY | OFlag::O_DIRECTORY, Mode::empty())
        .expect("parent");
    let mut recovery = RecoveryDir::new(&parent, &root).expect("recovery");
    let dir = recovery.path.clone();
    crate::file_ops::fs::exchange::RMDIR_PROBE.with(|probe| {
        *probe.borrow_mut() = Some(Box::new(move || {
            std::fs::write(root.join("ready"), dir.as_os_str().as_encoded_bytes()).expect("ready");
            assert!(dir.is_dir(), "directory exists before actual rmdir");
            nix::sys::signal::kill(nix::unistd::getpid(), nix::sys::signal::Signal::SIGKILL)
                .expect("actual SIGKILL at syscall boundary");
        }));
    });
    let _ = recovery.finish();
    panic!("SIGKILL must not return");
}

#[cfg(target_os = "linux")]
#[test]
fn recovery_resumes_after_sigkill_at_final_rmdir_boundary() {
    use std::os::unix::ffi::OsStringExt;
    let fixture = tempfile::tempdir().expect("fixture");
    let mut child = std::process::Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--exact",
                "file_ops::journal::recovery::identity_boundary_tests::recovery_cleanup_abrupt_child_helper",
                "--nocapture",
            ])
            .env("WSMP_RECOVERY_CRASH_FIXTURE", fixture.path())
            .spawn()
            .expect("child");
    let ready = fixture.path().join("ready");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !ready.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    if !ready.exists() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("child did not reach cleanup boundary");
    }
    let killed = child.wait().expect("wait killed child");
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(killed.signal(), Some(nix::libc::SIGKILL));
    let dir = PathBuf::from(std::ffi::OsString::from_vec(
        std::fs::read(ready).expect("ready bytes"),
    ));
    assert!(
        dir.is_dir(),
        "residue {} after child {killed:?}; root {:?}",
        dir.display(),
        std::fs::read_dir(fixture.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>()
    );
    assert!(
        std::fs::read_dir(&dir)
            .expect("empty residue")
            .next()
            .is_none()
    );
    assert_eq!(
        super::super::recover::recover_dir(&dir, true, None).action,
        super::super::recover::RecoverAction::Cleaned
    );
    assert!(!dir.exists());
    assert!(!cleanup_lock_path(&dir).exists());
}
