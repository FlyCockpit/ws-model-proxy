use super::*;
use crate::host::service::text::{
    render_launch_agent_plist, render_macos_service_wrapper, render_systemd_user_unit,
};
use std::process::Stdio;

#[cfg(unix)]
pub(super) fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).expect("meta").permissions().mode() & 0o777
}

#[cfg(unix)]
pub(super) fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod");
}

/// Everything in `dir` but `keep`: no temporary file is left behind.
#[cfg(unix)]
fn others_in(dir: &Path, keep: &[&str]) -> Vec<String> {
    std::fs::read_dir(dir)
        .expect("dir")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| !keep.contains(&name.as_str()))
        .collect()
}

/// The bytes at `path` when it is a regular file (never opens a FIFO).
#[cfg(unix)]
pub(super) fn bytes_of(path: &Path) -> Option<Vec<u8>> {
    std::fs::metadata(path)
        .ok()
        .filter(std::fs::Metadata::is_file)
        .and_then(|_| std::fs::read(path).ok())
}

/// A keg script: `run` prints `DAEMON <version>`, `--version` prints
/// `wsmp <version>`, anything else exits 19.
#[cfg(unix)]
pub(super) fn keg_script(version: &str) -> String {
    format!(
        "#!/bin/sh\nif [ \"$1\" = run ]; then echo 'DAEMON {version}'; exit 0; fi\n\
         if [ \"$1\" = --version ]; then echo 'wsmp {version}'; exit 0; fi\nexit 19\n"
    )
}

/// Runs `program` with `args`, again while another test thread's fork
/// still holds a just-written script open (ETXTBSY).
#[cfg(unix)]
pub(super) fn run_script(program: &Path, args: &[&str]) -> std::process::Output {
    for _ in 0..50 {
        match std::process::Command::new(program).args(args).output() {
            Ok(output) if !String::from_utf8_lossy(&output.stderr).contains("Text file busy") => {
                return output;
            }
            Err(error) if error.raw_os_error() != Some(26) => panic!("{error}"),
            _ => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
    panic!("`{}` stayed busy", program.display())
}

/// A Homebrew prefix on disk for the service checks: kegs
/// `Cellar/wsmp/0.4.2` and `0.4.3` (each a [`keg_script`]), and
/// `opt/wsmp` linked to 0.4.3 as `brew link` leaves it.
#[cfg(unix)]
struct Keg {
    dir: tempfile::TempDir,
    /// `opt/wsmp/bin/wsmp`.
    stable: PathBuf,
    /// The 0.4.2 keg's versioned path, as an older wsmp wrote it.
    old: String,
}

#[cfg(unix)]
impl Keg {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("dir");
        let keg = Self {
            stable: dir.path().join("opt/wsmp/bin/wsmp"),
            old: dir
                .path()
                .join("Cellar/wsmp/0.4.2/bin/wsmp")
                .display()
                .to_string(),
            dir,
        };
        keg.add("0.4.2");
        keg.add("0.4.3");
        std::fs::create_dir_all(keg.path("opt")).expect("opt");
        keg.switch("0.4.3");
        keg
    }

    /// A keg for `version`.
    fn add(&self, version: &str) {
        let bin = self.path(&format!("Cellar/wsmp/{version}/bin"));
        std::fs::create_dir_all(&bin).expect("keg");
        std::fs::write(bin.join("wsmp"), keg_script(version)).expect("wsmp");
        set_mode(&bin.join("wsmp"), 0o755);
    }

    /// `opt/wsmp` now links `version`'s keg, as `brew upgrade` leaves it.
    fn switch(&self, version: &str) {
        let _ = std::fs::remove_file(self.path("opt/wsmp"));
        std::os::unix::fs::symlink(
            self.path(&format!("Cellar/wsmp/{version}")),
            self.path("opt/wsmp"),
        )
        .expect("link");
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn stable(&self) -> &str {
        self.stable.to_str().expect("utf-8")
    }

    /// What `wsmp service install` writes for `kind` running `executable`
    /// with `pinned` (a plist runs the wrapper beside it).
    fn render_for(&self, kind: ServiceKind, executable: &str, pinned: &[(&str, String)]) -> String {
        match kind {
            ServiceKind::SystemdUnit => render_systemd_user_unit(executable, pinned),
            ServiceKind::LaunchdWrapper => render_macos_service_wrapper(executable, pinned),
            ServiceKind::LaunchdPlist => render_launch_agent_plist(
                "com.flycockpit.wsmp",
                &self.path("wsmp-service-run.sh").display().to_string(),
                "/Users/u",
                "/Users/u/Library/Logs/ws-model-proxy/relay.out.log",
                "/Users/u/Library/Logs/ws-model-proxy/relay.err.log",
            ),
        }
        .expect("render")
    }

    /// What the update renders for `kind` now: the stable path, [`pins`].
    fn render(&self, kind: ServiceKind) -> String {
        self.render_for(kind, self.stable(), &pins())
    }

    /// One update's service step on the single file `file` of `kind`.
    fn single(
        &self,
        file: &Path,
        kind: ServiceKind,
        publish: &Publish<'_>,
        reload: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        stable_service_files(
            &[(file, kind)],
            &self.stable,
            || Ok(vec![self.render(kind)]),
            publish,
            reload,
            &no_label,
        )
    }

    /// One update's service step on macOS's pair: the wrapper, then the
    /// plist (the loader).
    fn pair(&self, publish: &Publish<'_>) -> Result<()> {
        self.pair_reading(publish, &no_label)
    }

    /// [`Self::pair`], reading a plist's label with `label`.
    fn pair_reading(&self, publish: &Publish<'_>, label: &PlistLabel<'_>) -> Result<()> {
        stable_service_files(
            &[
                (
                    &self.path("wsmp-service-run.sh"),
                    ServiceKind::LaunchdWrapper,
                ),
                (
                    &self.path("com.flycockpit.wsmp.plist"),
                    ServiceKind::LaunchdPlist,
                ),
            ],
            &self.stable,
            || {
                Ok(vec![
                    self.render(ServiceKind::LaunchdWrapper),
                    self.render(ServiceKind::LaunchdPlist),
                ])
            },
            publish,
            no_reload,
            label,
        )
    }
}

/// A plist label reader that never finds one (`plutil` failed).
#[cfg(unix)]
fn no_label(_: &Path) -> Option<String> {
    None
}

/// The pins the update renders with in these tests.
#[cfg(unix)]
pub(super) fn pins() -> Vec<(&'static str, String)> {
    vec![
        ("WSMP_CONFIG", "/u/c.json".to_string()),
        ("PATH", "/usr/bin:/bin".to_string()),
    ]
}

#[cfg(unix)]
pub(super) fn no_reload() -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn never_publish(_: &Path, _: &[u8], _: u32) -> Result<()> {
    anyhow::bail!("nothing must be written")
}

/// wsmp's files are recognized by the complete opening every template had,
/// whatever follows (a file cut short after it too); a file by hand is not,
/// nor one with only part of the opening (empty, cut short inside it, or a
/// generic start such as `#!/bin/sh\n`).
#[cfg(unix)]
#[test]
fn every_template_wsmp_wrote_is_its_own_and_a_file_by_hand_is_not() {
    let keg = Keg::new();
    for kind in [
        ServiceKind::SystemdUnit,
        ServiceKind::LaunchdWrapper,
        ServiceKind::LaunchdPlist,
    ] {
        for path in [
            "/opt/homebrew/opt/wsmp/bin/wsmp",
            "/Users/a b/opt/wsmp/bin/wsmp",
            "/home/oneil/100%/$q é/bin/wsmp",
            "/home/o'neil/100%/\"q\"\\/bin/wsmp",
        ] {
            // systemd runs no program whose path has a quote or a
            // backslash: the unit refuses it (R5-A-1).
            if kind == ServiceKind::SystemdUnit && path.contains(['\'', '"', '\\']) {
                continue;
            }
            let text = keg.render_for(kind, path, &pins());
            assert!(text.starts_with(kind.opening()), "{kind:?}");
            // Cut short anywhere after the complete opening: still wsmp's. Inside it
            // (an empty file too): custom, as a file by hand that starts the same way
            // would be.
            let opening = kind.opening().len();
            for end in (0..=text.len()).filter(|end| text.is_char_boundary(*end)) {
                assert_eq!(
                    kind.generated(&text.as_bytes()[..end]),
                    end >= opening,
                    "{kind:?} cut at {end}"
                );
            }
        }
    }
    for (kind, by_hand) in [
        (
            ServiceKind::SystemdUnit,
            "[Service]\nExecStart=/usr/local/bin/wsmp run\n",
        ),
        (
            ServiceKind::SystemdUnit,
            "[Unit]\nDescription=my relay\n[Service]\nExecStart=/x run\n",
        ),
        (ServiceKind::LaunchdWrapper, "#!/bin/bash\nexec wsmp run\n"),
        (ServiceKind::LaunchdWrapper, "#!/bin/sh\nexec wsmp run\n"),
        // Only a generic start in common with wsmp's (no marker): not wsmp's.
        (ServiceKind::LaunchdWrapper, "#!/bin/sh\n"),
        (ServiceKind::LaunchdWrapper, ""),
        (ServiceKind::SystemdUnit, "[Unit]\n"),
        (ServiceKind::SystemdUnit, ""),
        (
            ServiceKind::LaunchdPlist,
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        ),
        (ServiceKind::LaunchdPlist, ""),
        // As `plutil` writes it: keys sorted, `KeepAlive` first.
        (
            ServiceKind::LaunchdPlist,
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n\t<key>KeepAlive</key>\n",
        ),
    ] {
        assert!(!kind.generated(by_hand.as_bytes()), "{kind:?}: {by_hand}");
    }
}

/// RC6: a file of wsmp's that is not what `wsmp service install` writes
/// now is written again as it would, whatever is wrong with it (the
/// states each review found, and more), then synced and reloaded; the
/// next update writes nothing.
#[cfg(unix)]
#[test]
fn a_generated_service_is_written_again_as_install_writes_it() {
    let keg = Keg::new();
    let alias = keg.path("pinned-wsmp");
    std::os::unix::fs::symlink(keg.path("Cellar/wsmp/0.4.3/bin/wsmp"), &alias).expect("alias");
    let alias = alias.display().to_string();
    for (kind, name) in [
        (ServiceKind::SystemdUnit, "wsmp.service"),
        (ServiceKind::LaunchdWrapper, "wsmp-service-run.sh"),
    ] {
        let file = keg.path(name);
        let want = keg.render(kind);
        let states: Vec<(&str, String, u32)> = vec![
            (
                "an older wsmp's Cellar path",
                keg.render_for(kind, &keg.old, &pins()),
                kind.mode(),
            ),
            (
                "other pins",
                keg.render_for(kind, keg.stable(), &[("PATH", "/else".into())]),
                kind.mode(),
            ),
            (
                "an alias of today's keg",
                keg.render_for(kind, &alias, &pins()),
                kind.mode(),
            ),
            (
                "`--version` for `run`",
                want.replace(" run\n", " --version\n"),
                kind.mode(),
            ),
            (
                "an early exit",
                match kind {
                    ServiceKind::SystemdUnit => {
                        want.replace("Type=simple\n", "Type=simple\nExecStartPre=/bin/false\n")
                    }
                    _ => want.replace("set -eu\n", "set -eu\nexit 37\n"),
                },
                kind.mode(),
            ),
            ("trailing text", format!("{want}# more\n"), kind.mode()),
            ("cut short", want[..want.len() / 2].to_string(), kind.mode()),
            ("mode 0666", want.clone(), 0o666),
            ("mode 0777", want.clone(), 0o777),
            ("mode 0600", want.clone(), 0o600),
            ("mode 0755", want.clone(), 0o755),
        ];
        for (state, text, mode) in states {
            std::fs::write(&file, &text).expect("write");
            set_mode(&file, mode);
            let reloads = std::cell::Cell::new(0);
            keg.single(&file, kind, &publish_file, || {
                reloads.set(reloads.get() + 1);
                Ok(())
            })
            .unwrap_or_else(|error| panic!("{kind:?} {state}: {error:#}"));
            assert_eq!(
                std::fs::read_to_string(&file).expect("read"),
                want,
                "{kind:?} {state}"
            );
            assert_eq!(mode_of(&file), kind.mode(), "{kind:?} {state}");
            assert_eq!(reloads.get(), 1, "{kind:?} {state}");
            keg.single(&file, kind, &never_publish, no_reload)
                .unwrap_or_else(|error| panic!("{kind:?} {state} again: {error:#}"));
        }
        // Round 13: a file without wsmp's complete opening (empty, or cut short inside it)
        // is not wsmp's: refused with `wsmp service install` advice, left byte for byte.
        let opening = kind.opening();
        for (state, text) in [
            ("empty", String::new()),
            (
                "cut inside the opening",
                opening[..opening.len() - 1].to_string(),
            ),
        ] {
            std::fs::write(&file, &text).expect("write");
            set_mode(&file, kind.mode());
            let error = keg
                .single(&file, kind, &never_publish, no_reload)
                .expect_err(state);
            assert!(
                format!("{error:#}").contains("Run `wsmp service install`"),
                "{kind:?} {state}: {error:#}"
            );
            assert_eq!(
                std::fs::read(&file).expect("read"),
                text.as_bytes(),
                "{kind:?} {state}"
            );
        }
        assert!(
            others_in(keg.dir.path(), &[name, "Cellar", "opt", "pinned-wsmp"]).is_empty(),
            "{kind:?}: a temporary file was left"
        );
        std::fs::remove_file(&file).expect("rm");
    }
}

/// F-FB-2 (the review's C9 probe `partial_custom_noop_wrapper_is_overwritten`, with the
/// fixed expectation): a wrapper written by hand that only shares wsmp's generic start
/// (`#!/bin/sh\n`: a valid script that does nothing), beside wsmp's plist, is custom: the
/// update is refused, the wrapper stays byte for byte, and nothing is written.
#[cfg(unix)]
#[test]
fn partial_custom_noop_wrapper_is_refused() {
    let dir = tempfile::tempdir().expect("dir");
    let wrapper = dir.path().join("run.sh");
    let loader = dir.path().join("agent.plist");
    let stable = dir.path().join("wsmp");
    fs::write(&stable, b"placeholder").expect("stable");
    fs::write(&wrapper, b"#!/bin/sh\n").expect("wrapper");
    fs::write(&loader, ServiceKind::LaunchdPlist.opening()).expect("plist");
    let before = (
        fs::read(&wrapper).expect("w"),
        fs::read(&loader).expect("p"),
    );
    let error = stable_service_files(
        &[
            (&wrapper, ServiceKind::LaunchdWrapper),
            (&loader, ServiceKind::LaunchdPlist),
        ],
        &stable,
        || {
            Ok(vec![
                render_macos_service_wrapper(stable.to_str().expect("utf-8"), &[])?,
                ServiceKind::LaunchdPlist.opening().into(),
            ])
        },
        &never_publish,
        || anyhow::bail!("nothing may be reloaded"),
        &|_| None,
    )
    .expect_err("refused");
    let text = format!("{error:#}");
    assert!(text.contains(&format!("`{}`", wrapper.display())), "{text}");
    assert!(text.contains("Run `wsmp service install`"), "{text}");
    assert_eq!(
        (
            fs::read(&wrapper).expect("w"),
            fs::read(&loader).expect("p")
        ),
        before
    );
}

/// A4-WRAPPER and B4-FILESYSTEM: the wrapper wsmp writes again runs the
/// relay (`run`) on the stable path, so it follows `opt` to the next keg.
#[cfg(unix)]
#[test]
fn a_rewritten_wrapper_runs_the_relay_on_the_stable_path() {
    let keg = Keg::new();
    let wrapper = keg.path("wsmp-service-run.sh");
    let kind = ServiceKind::LaunchdWrapper;
    let alias = keg.path("pinned-wsmp");
    std::os::unix::fs::symlink(keg.path("Cellar/wsmp/0.4.3/bin/wsmp"), &alias).expect("alias");
    let healthy = keg.render(kind);
    for edited in [
        healthy.replace(" run\n", " --version\n"),
        healthy.replacen("set -eu\n", "set -eu\nexit 37\n", 1),
        keg.render_for(kind, &alias.display().to_string(), &pins()),
    ] {
        std::fs::write(&wrapper, &edited).expect("write");
        set_mode(&wrapper, 0o700);
        keg.single(&wrapper, kind, &publish_file, no_reload)
            .expect("written again");
        let out = run_script(&wrapper, &[]);
        assert_eq!(String::from_utf8_lossy(&out.stdout), "DAEMON 0.4.3\n");
    }
    // `brew upgrade` moves `opt`; the service follows it.
    keg.add("0.4.4");
    keg.switch("0.4.4");
    let out = run_script(&wrapper, &[]);
    assert_eq!(String::from_utf8_lossy(&out.stdout), "DAEMON 0.4.4\n");
}

/// Owner, 2026-10-30: any file not written by `wsmp service install`
/// stops the update, untouched (bytes and mode) and unreloaded, whatever
/// it runs: a `Cellar` path, the stable path, another program, or one
/// spelled with systemd escapes (F-FA-2's `\x43ellar`). The refusal says
/// the file is not wsmp's, never what it names.
#[cfg(unix)]
#[test]
fn a_file_by_hand_stops_the_update_whatever_it_runs() {
    let keg = Keg::new();
    let file = keg.path("wsmp.service");
    let kind = ServiceKind::SystemdUnit;
    let escaped = keg.old.replace("/Cellar/", "/\\x43ellar/");
    assert!(!escaped.contains("Cellar"), "{escaped}");
    for by_hand in [
        "[Service]\nExecStart=/usr/local/bin/wsmp run --verbose\n".to_string(),
        format!("[Service]\nExecStart={} run\n", keg.old),
        format!("[Service]\nExecStart={} run\n", keg.stable()),
        format!("[Service]\nExecStart={escaped} run\n"),
    ] {
        std::fs::write(&file, &by_hand).expect("write");
        set_mode(&file, 0o600);
        let error = keg
            .single(&file, kind, &never_publish, || {
                anyhow::bail!("a file by hand is never reloaded")
            })
            .expect_err(&by_hand);
        let text = format!("{error:#}");
        assert!(
            text.contains("was not written by `wsmp service install`")
                && text.contains("Run `wsmp service install`")
                && text.contains("update by hand")
                && !text.contains("Cellar"),
            "{by_hand}: {text}"
        );
        assert_eq!(std::fs::read_to_string(&file).expect("read"), by_hand);
        assert_eq!(mode_of(&file), 0o600);
    }
}

/// A service that is there but broken is not "no service": each stops the
/// update, with nothing written and nothing reloaded.
#[cfg(unix)]
#[test]
fn a_broken_service_stops_the_update_and_is_left_as_it_is() {
    use std::os::unix::fs::symlink;
    let keg = Keg::new();
    let file = keg.path("wsmp.service");
    let kind = ServiceKind::SystemdUnit;
    let refused = |needle: &str| {
        let before = std::fs::symlink_metadata(&file).ok().map(|meta| meta.len());
        let error = keg
            .single(&file, kind, &never_publish, || {
                anyhow::bail!("a broken unit is never reloaded")
            })
            .expect_err(needle);
        assert!(format!("{error:#}").contains(needle), "{needle}: {error:#}");
        assert_eq!(
            std::fs::symlink_metadata(&file).ok().map(|meta| meta.len()),
            before,
            "{needle}: changed"
        );
    };
    // No service: fine, nothing reloaded.
    keg.single(&file, kind, &never_publish, || {
        anyhow::bail!("no unit, no reload")
    })
    .expect("absent");
    symlink(keg.path("gone.service"), &file).expect("link");
    refused("is a link to nothing");
    std::fs::remove_file(&file).expect("rm");
    symlink(&file, &file).expect("loop");
    refused("could not be resolved");
    std::fs::remove_file(&file).expect("rm");
    // A link through a directory the user cannot search (R4-B-2): the
    // target is there, so it is not called a link to nothing.
    let locked = keg.path("locked");
    std::fs::create_dir(&locked).expect("dir");
    std::fs::write(locked.join("wsmp.service"), keg.render(kind)).expect("write");
    symlink(locked.join("wsmp.service"), &file).expect("link");
    set_mode(&locked, 0o000);
    if std::fs::metadata(locked.join("wsmp.service")).is_err() {
        refused("could not be resolved");
    }
    set_mode(&locked, 0o755);
    std::fs::remove_file(&file).expect("rm");
    std::fs::create_dir(&file).expect("dir");
    refused("not a regular file");
    std::fs::remove_dir(&file).expect("rm");
    std::fs::write(&file, keg.render(kind)).expect("write");
    set_mode(&file, 0o200);
    if std::fs::File::open(&file).is_err() {
        refused("reading the relay service");
    }
    std::fs::remove_file(&file).expect("rm");
    // `brew unlink`: a file that must be written is not written onto a
    // missing stable link; one already on it is fine (the upgrade makes
    // the link again, and its probe runs it).
    std::fs::write(&file, keg.render_for(kind, &keg.old, &pins())).expect("write");
    std::fs::remove_file(keg.path("opt/wsmp")).expect("unlink");
    refused("`brew link wsmp`");
    std::fs::write(&file, keg.render(kind)).expect("write");
    set_mode(&file, kind.mode());
    keg.single(&file, kind, &never_publish, no_reload)
        .expect("already on the stable path");
}

/// macOS: the plist runs the wrapper, so the two are one service. No
/// plist is no service; a plist of wsmp's is written again with its
/// wrapper (the wrapper first: the plist never names a missing one).
#[cfg(unix)]
#[test]
fn the_launch_agent_and_its_wrapper_are_written_together() {
    let keg = Keg::new();
    let wrapper = keg.path("wsmp-service-run.sh");
    let plist = keg.path("com.flycockpit.wsmp.plist");
    let written = std::cell::RefCell::new(Vec::<String>::new());
    let recording = |path: &Path, bytes: &[u8], mode: u32| {
        written.borrow_mut().push(
            path.file_name()
                .expect("name")
                .to_string_lossy()
                .into_owned(),
        );
        publish_file(path, bytes, mode)
    };
    let reset = || {
        for path in [&wrapper, &plist] {
            let _ = std::fs::remove_file(path);
        }
        written.borrow_mut().clear();
    };
    let wrapper_kind = ServiceKind::LaunchdWrapper;
    let plist_kind = ServiceKind::LaunchdPlist;
    let canonical = || {
        assert_eq!(
            std::fs::read_to_string(&wrapper).expect("wrapper"),
            keg.render(wrapper_kind)
        );
        assert_eq!(mode_of(&wrapper), PRIVATE_SCRIPT_MODE);
        assert_eq!(
            std::fs::read_to_string(&plist).expect("plist"),
            keg.render(plist_kind)
        );
        assert_eq!(mode_of(&plist), SERVICE_FILE_MODE);
    };
    // No plist: no service, whatever the wrapper is (even a FIFO).
    nix::unistd::mkfifo(&wrapper, nix::sys::stat::Mode::S_IRWXU).expect("fifo");
    keg.pair(&never_publish).expect("no service");
    reset();
    std::fs::write(&wrapper, keg.render_for(wrapper_kind, &keg.old, &[])).expect("w");
    keg.pair(&never_publish).expect("no service");
    reset();
    // wsmp's plist, its wrapper missing: the wrapper is written.
    std::fs::write(&plist, keg.render(plist_kind)).expect("plist");
    set_mode(&plist, SERVICE_FILE_MODE);
    keg.pair(&recording).expect("wrapper written");
    assert_eq!(*written.borrow(), ["wsmp-service-run.sh"]);
    canonical();
    reset();
    // wsmp's plist with its program written another way (`&#47;` for
    // `/`, which launchd reads the same), the wrapper missing: both.
    std::fs::write(
        &plist,
        keg.render(plist_kind)
            .replace("/wsmp-service-run.sh<", "&#47;wsmp-service-run.sh<"),
    )
    .expect("plist");
    keg.pair(&recording).expect("both written");
    assert_eq!(
        *written.borrow(),
        ["wsmp-service-run.sh", "com.flycockpit.wsmp.plist"]
    );
    canonical();
    reset();
    // Done: the next update writes nothing.
    keg.pair(&never_publish).expect("done");
    reset();
    // Stops with nothing written: a plist by hand (beside a missing
    // wrapper, or an old one of wsmp's, which stays as it was), a
    // dangling plist beside a healthy wrapper, a FIFO or a wrapper by
    // hand beside wsmp's plist.
    let old_wrapper = keg.render_for(wrapper_kind, &keg.old, &[]);
    let refused = |needle: &str| {
        let before = bytes_of(&wrapper);
        let error = keg.pair(&never_publish).expect_err(needle);
        assert!(format!("{error:#}").contains(needle), "{needle}: {error:#}");
        assert_eq!(bytes_of(&wrapper), before, "{needle}");
    };
    let by_hand = "<plist><dict><key>Label</key><string>mine</string></dict></plist>\n";
    std::fs::write(&plist, by_hand).expect("plist");
    refused("not written by `wsmp service install`");
    assert!(std::fs::symlink_metadata(&wrapper).is_err());
    assert_eq!(std::fs::read_to_string(&plist).expect("plist"), by_hand);
    reset();
    std::fs::write(&wrapper, &old_wrapper).expect("w");
    std::fs::write(
        &plist,
        format!("<plist><string>{}</string></plist>\n", keg.old),
    )
    .expect("plist");
    refused("not written by `wsmp service install`");
    reset();
    std::fs::write(&wrapper, keg.render(wrapper_kind)).expect("w");
    std::os::unix::fs::symlink(keg.path("gone.plist"), &plist).expect("link");
    refused("is a link to nothing");
    reset();
    std::fs::write(&plist, keg.render(plist_kind)).expect("plist");
    nix::unistd::mkfifo(&wrapper, nix::sys::stat::Mode::S_IRWXU).expect("fifo");
    refused("not a regular file");
    std::fs::remove_file(&wrapper).expect("rm");
    for by_hand in [
        format!("#!/bin/sh\nexec '{}' run\n", keg.old),
        format!("#!/bin/sh\nexec '{}' run\n", keg.stable()),
    ] {
        std::fs::write(&wrapper, by_hand).expect("w");
        refused("not written by `wsmp service install`");
    }
    assert_eq!(
        std::fs::read_to_string(&plist).expect("plist"),
        keg.render(plist_kind)
    );
}

/// A FIFO (or anything but a regular file) at the service path is an
/// error at once, not a read that never returns.
#[cfg(unix)]
#[test]
fn a_fifo_at_the_service_path_is_an_error_at_once() {
    let keg = std::sync::Arc::new(Keg::new());
    let fifo = keg.path("wsmp.service");
    nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::S_IRWXU).expect("fifo");
    let (sent, got) = std::sync::mpsc::channel();
    let path = fifo.clone();
    let shared = std::sync::Arc::clone(&keg);
    std::thread::spawn(move || {
        let result = shared.single(&path, ServiceKind::SystemdUnit, &never_publish, no_reload);
        let _ = sent.send(result.map_err(|error| format!("{error:#}")));
    });
    let error = got
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("the check returned")
        .expect_err("a FIFO is an error");
    assert!(error.contains("not a regular file"), "{error}");
    // Through a link too.
    let link = keg.path("link.service");
    std::os::unix::fs::symlink(&fifo, &link).expect("link");
    let error = read_service_file(&link).err().expect("error");
    assert!(
        format!("{error:#}").contains("not a regular file"),
        "{error:#}"
    );
}

/// A unit written by a try whose `daemon-reload` failed is already right
/// on disk: the next try must still reload it, not take it for done.
#[cfg(unix)]
#[test]
fn a_unit_whose_reload_failed_is_reloaded_by_the_next_update() {
    let keg = Keg::new();
    let file = keg.path("wsmp.service");
    let unit = ServiceKind::SystemdUnit;
    std::fs::write(&file, keg.render_for(unit, &keg.old, &pins())).expect("write");
    let reloads = std::cell::Cell::new(0);
    let failing = || {
        reloads.set(reloads.get() + 1);
        Err(anyhow::anyhow!("Failed to connect to bus"))
    };
    let working = || {
        reloads.set(reloads.get() + 1);
        Ok(())
    };
    let error = keg
        .single(&file, unit, &publish_file, failing)
        .expect_err("the reload failed");
    assert!(format!("{error:#}").contains("daemon-reload"), "{error:#}");
    // The new unit is on disk, whole, with its mode.
    assert_eq!(
        std::fs::read_to_string(&file).expect("read"),
        keg.render(unit)
    );
    assert_eq!(mode_of(&file), SERVICE_FILE_MODE);
    // The next update: nothing to write, still not done while the reload
    // fails...
    assert!(keg.single(&file, unit, &never_publish, failing).is_err());
    assert_eq!(reloads.get(), 2);
    // ...and done once it succeeds.
    keg.single(&file, unit, &never_publish, working)
        .expect("done");
    assert_eq!(reloads.get(), 3);
}

/// A write that fails at any step (a short write, the mode, the sync, the
/// rename) leaves the old wrapper whole and runnable, and the next update
/// writes it.
#[cfg(unix)]
#[test]
fn a_failed_wrapper_write_keeps_the_old_wrapper_and_the_next_update_writes_it() {
    let keg = Keg::new();
    let file = keg.path("wsmp-service-run.sh");
    let wrapper = ServiceKind::LaunchdWrapper;
    let old = keg.render_for(wrapper, &keg.old, &pins());
    for step in [
        PublishStep::Write,
        PublishStep::Mode,
        PublishStep::Sync,
        PublishStep::Rename,
    ] {
        std::fs::write(&file, &old).expect("write");
        set_mode(&file, 0o700);
        let failing = |path: &Path, bytes: &[u8], mode: u32| {
            publish_file_with(path, bytes, mode, &|at| {
                if at == step {
                    Err(std::io::Error::from_raw_os_error(27)) // EFBIG: file too large
                } else {
                    Ok(())
                }
            })
        };
        let error = keg
            .single(&file, wrapper, &failing, no_reload)
            .expect_err("failed");
        assert!(
            format!("{error:#}").contains("too large"),
            "{step:?}: {error:#}"
        );
        assert_eq!(
            std::fs::read_to_string(&file).expect("read"),
            old,
            "{step:?}"
        );
        assert_eq!(mode_of(&file), 0o700, "{step:?}");
        assert_eq!(
            String::from_utf8_lossy(&run_script(&file, &[]).stdout),
            "DAEMON 0.4.2\n",
            "{step:?}: the old wrapper still runs"
        );
        assert!(
            others_in(keg.dir.path(), &["wsmp-service-run.sh", "Cellar", "opt"]).is_empty(),
            "{step:?}: a temporary file was left"
        );
        keg.single(&file, wrapper, &publish_file, no_reload)
            .expect("written");
        assert_eq!(
            std::fs::read_to_string(&file).expect("read"),
            keg.render(wrapper)
        );
        assert_eq!(mode_of(&file), PRIVATE_SCRIPT_MODE, "{step:?}");
    }
}

/// [`sync_dir`]'s test fault, set by a parent test in the environment of
/// a child run of [`through_the_update_child`]: the first directory sync
/// fails (EIO) when `WSMP_TEST_DIR_SYNC_FAIL_ONCE` names a file that does
/// not exist yet; each sync is logged to `WSMP_TEST_DIR_SYNC_LOG`.
#[cfg(unix)]
pub(super) fn dir_sync_fault(dir: &Path) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(mark) = std::env::var_os("WSMP_TEST_DIR_SYNC_FAIL_ONCE")
        && std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(mark)
            .is_ok()
    {
        return Err(std::io::Error::from_raw_os_error(5));
    }
    if let Some(log) = std::env::var_os("WSMP_TEST_DIR_SYNC_LOG") {
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)?;
        writeln!(log, "{}", dir.display())?;
    }
    Ok(())
}

/// R5-A-1, through the update's service step: a rendering that fails
/// (here, a pin no unit can hold) stops the step before anything is
/// written or reloaded, and leaves wsmp's old unit as it was. A unit by
/// hand is refused before anything is rendered.
#[cfg(unix)]
#[test]
fn a_rendering_that_fails_writes_nothing() {
    let keg = Keg::new();
    let unit = keg.path("wsmp.service");
    let old = keg.render_for(ServiceKind::SystemdUnit, "/old/wsmp", &pins());
    std::fs::write(&unit, &old).expect("write");
    let bad_pin = vec![("WSMP_CONFIG", "/u/a\nb".to_string())];
    let render =
        || -> Result<Vec<String>> { Ok(vec![render_systemd_user_unit(keg.stable(), &bad_pin)?]) };
    let reloaded = std::cell::Cell::new(false);
    let error = stable_service_files(
        &[(&unit, ServiceKind::SystemdUnit)],
        &keg.stable,
        render,
        &never_publish,
        || {
            reloaded.set(true);
            Ok(())
        },
        &no_label,
    )
    .expect_err("refused");
    assert!(format!("{error:#}").contains("U+000A"), "{error:#}");
    assert_eq!(std::fs::read_to_string(&unit).expect("read"), old);
    assert!(!reloaded.get());

    let by_hand = format!("[Service]\nExecStart={} run\n", keg.stable());
    std::fs::write(&unit, &by_hand).expect("write");
    stable_service_files(
        &[(&unit, ServiceKind::SystemdUnit)],
        &keg.stable,
        || -> Result<Vec<String>> { panic!("a unit by hand is not rendered") },
        &never_publish,
        no_reload,
        &no_label,
    )
    .expect_err("by hand");
    assert_eq!(std::fs::read_to_string(&unit).expect("read"), by_hand);
}

/// `plist` saved again as `plutil -convert`, `defaults` or Xcode save
/// it: keys sorted (`KeepAlive` first, so it no longer starts as wsmp's
/// renderings do), XML or binary (`format`: `FMT_XML`, `FMT_BINARY`).
/// Python's `plistlib`; `None` when there is no `python3`.
#[cfg(unix)]
pub(super) fn resaved_plist(plist: &[u8], format: &str) -> Option<Vec<u8>> {
    use std::io::Write;
    let mut child = std::process::Command::new("python3")
        .args([
            "-I",
            "-c",
            "import plistlib,sys; d=plistlib.loads(sys.stdin.buffer.read()); \
             sys.stdout.buffer.write(plistlib.dumps(d, fmt=getattr(plistlib, sys.argv[1]), sort_keys=True))",
            format,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(plist).ok()?;
    let out = child.wait_with_output().ok()?;
    out.status.success().then_some(out.stdout)
}

/// The plist label reader: on macOS the real one (`plutil`); elsewhere
/// `plistlib` stands in for it (XML or binary; `None` without a string
/// `Label`, or for a file that is not a plist).
#[cfg(unix)]
pub(super) fn label_reader(path: &Path) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        macos_plist_label(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let out = std::process::Command::new("python3")
            .args([
                "-I",
                "-c",
                "import plistlib,sys; v=plistlib.load(open(sys.argv[1],'rb')).get('Label'); \
                 assert isinstance(v,str); sys.stdout.write(v + '\\n')",
            ])
            .arg(path)
            .stderr(Stdio::null())
            .output()
            .ok()?;
        out.status.success().then(|| {
            let text = String::from_utf8_lossy(&out.stdout);
            text.strip_suffix('\n').unwrap_or(&text).to_string()
        })
    }
}

/// MAC-D (owner, 2026-10-30): a LaunchAgent plist whose `Label` is
/// `com.flycockpit.wsmp` is wsmp's, even after `plutil`, `defaults` or
/// Xcode saved it again with its keys sorted (XML or binary), so the
/// update writes it again with the renderer, as any file of wsmp's; one
/// that named a `Cellar` path is moved, not refused. A plist with
/// another label, none, or one the reader cannot read is custom: refused,
/// untouched, whatever it runs.
#[cfg(unix)]
#[test]
fn a_plist_with_wsmps_label_is_wsmps_whatever_its_layout() {
    let keg = Keg::new();
    let wrapper = keg.path("wsmp-service-run.sh");
    let plist = keg.path("com.flycockpit.wsmp.plist");
    let ours = keg.render(ServiceKind::LaunchdPlist);
    let Some(probe) = resaved_plist(ours.as_bytes(), "FMT_XML") else {
        // Said, so a skipped check is visible in the test log.
        #[allow(clippy::print_stderr)]
        {
            eprintln!("skipped: no python3 to save a plist again");
        }
        return;
    };
    assert!(!ServiceKind::LaunchdPlist.generated(&probe), "re-sorted");
    let on_cellar = ours.replace(
        &keg.path("wsmp-service-run.sh").display().to_string(),
        &format!("{}/../run.sh", keg.old),
    );
    let theirs = ours.replace("com.flycockpit.wsmp", "com.example.relay");
    let theirs_on_cellar = on_cellar.replace("com.flycockpit.wsmp", "com.example.relay");
    let write_both = |bytes: &[u8]| {
        std::fs::write(&wrapper, keg.render(ServiceKind::LaunchdWrapper)).expect("wrapper");
        set_mode(&wrapper, PRIVATE_SCRIPT_MODE);
        std::fs::write(&plist, bytes).expect("plist");
        set_mode(&plist, SERVICE_FILE_MODE);
    };
    for format in ["FMT_XML", "FMT_BINARY"] {
        for source in [&ours, &on_cellar] {
            let saved = resaved_plist(source.as_bytes(), format).expect("save");
            write_both(&saved);
            keg.pair_reading(&publish_file, &label_reader)
                .unwrap_or_else(|error| panic!("{format}: {error:#}"));
            assert_eq!(
                std::fs::read_to_string(&plist).expect("plist"),
                ours,
                "{format}: written again as install writes it"
            );
            // The label reader failing: custom, refused, untouched.
            write_both(&saved);
            let error = keg
                .pair_reading(&never_publish, &no_label)
                .expect_err("custom");
            assert!(
                format!("{error:#}").contains("not written by `wsmp service install`"),
                "{error:#}"
            );
            assert_eq!(std::fs::read(&plist).expect("plist"), saved);
        }
        // Another label: custom, whatever it runs.
        for source in [&theirs, &theirs_on_cellar] {
            let saved = resaved_plist(source.as_bytes(), format).expect("save");
            write_both(&saved);
            let error = keg
                .pair_reading(&never_publish, &label_reader)
                .expect_err("another label");
            assert!(
                format!("{error:#}").contains("not written by `wsmp service install`"),
                "{error:#}"
            );
            assert_eq!(std::fs::read(&plist).expect("plist"), saved);
        }
    }
    // Not a plist, or no label: custom.
    for bytes in [
        &b"not a plist"[..],
        b"<?xml version=\"1.0\"?><plist><dict/></plist>",
    ] {
        write_both(bytes);
        assert_eq!(label_reader(&plist), None);
        keg.pair_reading(&never_publish, &label_reader)
            .expect_err("custom");
        assert_eq!(std::fs::read(&plist).expect("plist"), bytes);
    }
}

#[cfg(unix)]
#[test]
fn publishing_through_a_symlink_replaces_its_target_and_keeps_the_link() {
    let dir = tempfile::tempdir().expect("dir");
    let real = dir.path().join("real.service");
    let link = dir.path().join("wsmp.service");
    std::fs::write(&real, "old").expect("write");
    std::os::unix::fs::symlink(&real, &link).expect("symlink");
    publish_file(&link, b"new", SERVICE_FILE_MODE).expect("publish");
    assert!(
        std::fs::symlink_metadata(&link)
            .expect("meta")
            .file_type()
            .is_symlink()
    );
    assert_eq!(std::fs::read_to_string(&real).expect("read"), "new");
    assert_eq!(mode_of(&real), SERVICE_FILE_MODE);
}
