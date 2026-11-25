//! The service files on disk: found, told apart from one written by hand,
//! written whole (never a part) and, on a Homebrew update, moved onto the
//! stable path ([`ensure_stable_executable`]).

#[cfg(unix)]
use std::fs;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

#[cfg(unix)]
use anyhow::Context;
use anyhow::Result;

/// Before a Homebrew upgrade, and before anything else changes: the installed
/// service must start `stable` (`<prefix>/opt/wsmp/bin/wsmp`), so the restart
/// runs the new keg. `stable` is the very path the update probes with
/// `--version` after `brew upgrade`: that probe, not a check here, is what
/// shows the restart target runs.
///
/// Every file `wsmp service install` wrote (the unit; the wrapper and the
/// LaunchAgent plist) is rendered again by the same renderer, with `stable`
/// and this process's pins ([`super::path_env::pinned_service_env`]), and written when its
/// bytes or mode differ: an older template, a `Cellar` path, an alias, a hand
/// edit or a file cut short after its opening are all replaced (one that does
/// not have wsmp's complete opening, an empty one too, is custom: see
/// [`ServiceKind::generated`]). A path or pin the service
/// file cannot hold as written (a control character such as a newline) is an
/// error before anything is written ([`super::text::refuse_unwritable`]). Any file not
/// written by `wsmp service install` (by hand, or by another tool) is an
/// error before anything is written, whatever it says: wsmp cannot tell what
/// it starts. No service is fine; a broken one (a dangling link, not a
/// regular file) is an error. See [`stable_service_files`].
pub fn ensure_stable_executable(stable: &Path) -> Result<()> {
    // Asked only when a service is there to render.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let executable = || {
        stable
            .to_str()
            .context("the stable Homebrew path is not valid UTF-8")
    };
    #[cfg(target_os = "linux")]
    stable_service_files(
        &[(&super::service_file()?, ServiceKind::SystemdUnit)],
        stable,
        || {
            Ok(vec![super::text::render_systemd_user_unit(
                executable()?,
                &super::path_env::pinned_service_env()?,
            )?])
        },
        &publish_file,
        || super::run_finite("systemctl", &["--user", "daemon-reload"]),
        // No plist here.
        &|_| None,
    )?;
    #[cfg(target_os = "macos")]
    {
        let wrapper = super::macos_wrapper_path()?;
        stable_service_files(
            &[
                (&wrapper, ServiceKind::LaunchdWrapper),
                (&super::service_file()?, ServiceKind::LaunchdPlist),
            ],
            stable,
            || {
                Ok(vec![
                    super::text::render_macos_service_wrapper(
                        executable()?,
                        &super::path_env::pinned_service_env()?,
                    )?,
                    super::text::macos_plist(&wrapper)?,
                ])
            },
            &publish_file,
            // Nothing to reload here: launchd keeps the plist it loaded until
            // `bootout` and `bootstrap`. `wsmp update` does that when it
            // restarts the relay (`Restart::Reloaded`). An update from the
            // dashboard only exits the relay, and KeepAlive starts what
            // launchd loaded (accepted by the owner, 2026-10-30): a plist
            // edited by hand and loaded keeps running what it names, so the
            // update may not confirm, or the relay may go offline. The way
            // back is `wsmp service install` (`wsmp update` does nothing when
            // wsmp is already current). The wrapper is read at every start.
            || Ok(()),
            &macos_plist_label,
        )?;
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = stable;
    Ok(())
}

/// A file `wsmp service install` writes for the relay service.
#[cfg(unix)]
// Each platform builds its own kinds outside tests (which build all).
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ServiceKind {
    /// Linux: the systemd user unit. systemd reads it only on `daemon-reload`.
    SystemdUnit,
    /// macOS: the wrapper script the LaunchAgent runs, read at every start.
    LaunchdWrapper,
    /// macOS: the LaunchAgent plist, which runs the wrapper. launchd reads it
    /// when it loads the agent (`bootstrap`).
    LaunchdPlist,
}

#[cfg(unix)]
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
impl ServiceKind {
    /// The mode `wsmp service install` gives the file.
    fn mode(self) -> u32 {
        match self {
            Self::SystemdUnit | Self::LaunchdPlist => SERVICE_FILE_MODE,
            Self::LaunchdWrapper => PRIVATE_SCRIPT_MODE,
        }
    }

    /// How every file of this kind wsmp's renderer ever wrote starts: the
    /// same in every template since the first (`0c336eea`; the pre-0.4.0
    /// unit and wrapper ran `daemon start --foreground` and read an
    /// `EnvironmentFile`; the plist never changed).
    fn opening(self) -> &'static str {
        match self {
            Self::SystemdUnit => "[Unit]\nDescription=WS Model Proxy relay\n",
            Self::LaunchdWrapper => "#!/bin/sh\n# Generated by `wsmp service install`",
            Self::LaunchdPlist => {
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
                 <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
                 <plist version=\"1.0\">\n\
                 <dict>\n\
                 \t<key>Label</key>\n\
                 \t<string>com.flycockpit.wsmp</string>\n"
            }
        }
    }

    /// Whether `bytes` are wsmp's rendering: they start with the complete
    /// [`Self::opening`] (any template, edited or cut short after it). Anything
    /// less is not wsmp's (the owner's rule, round 13): an empty file, one cut
    /// short inside the opening, or one that only shares a generic start with
    /// it (`#!/bin/sh\n`, an XML declaration) cannot be told apart from one by
    /// hand, so it is custom, and the Homebrew update refuses it with
    /// `wsmp service install` advice. A plist is also wsmp's when its `Label`
    /// is [`super::MACOS_LABEL`], whatever its layout ([`find`]).
    fn generated(self, bytes: &[u8]) -> bool {
        bytes.starts_with(self.opening().as_bytes())
    }
}

/// The `Label` of the plist at a path, `None` when it has none or it cannot
/// be read as a plist: [`macos_plist_label`] on macOS, a fake in tests.
#[cfg(unix)]
type PlistLabel<'a> = dyn Fn(&Path) -> Option<String> + 'a;

/// How long [`macos_plist_label`] waits for `plutil`.
#[cfg(target_os = "macos")]
const PLUTIL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The plist's `Label` as `/usr/bin/plutil -extract Label raw` gives it
/// (XML or binary, keys in any order, as `plutil`, `defaults` or Xcode save
/// it), bounded ([`crate::bounded_run::management::run_bounded_split`]). `file` is
/// one [`read_service_file`] found to be a regular file, passed as the OS
/// path it is. `None` when `plutil` fails (no `Label`, not a plist): the
/// plist is then taken as one by hand.
#[cfg(target_os = "macos")]
fn macos_plist_label(file: &Path) -> Option<String> {
    // The file's path as it is (never as text: it would name another file).
    let args = [
        std::ffi::OsStr::new("-extract"),
        "Label".as_ref(),
        "raw".as_ref(),
        "-o".as_ref(),
        "-".as_ref(),
        file.as_os_str(),
    ];
    let (ok, stdout, _) = crate::bounded_run::management::run_bounded_split(
        "/usr/bin/plutil",
        &args,
        &[],
        PLUTIL_TIMEOUT,
    )
    .ok()?;
    ok.then(|| stdout.strip_suffix('\n').unwrap_or(&stdout).to_string())
}

/// How [`stable_service_files`] writes a file: [`publish_file`] (tests vary it).
#[cfg(unix)]
type Publish<'a> = dyn Fn(&Path, &[u8], u32) -> Result<()> + 'a;

/// A service file as found on disk.
#[cfg(unix)]
struct ServiceText {
    /// The file itself (a link's target), open for reading.
    file: fs::File,
    /// Where it is: `path`, or what its links lead to.
    target: PathBuf,
    mode: u32,
    bytes: Vec<u8>,
}

/// The most of a service file [`read_service_file`] reads: a unit, plist or
/// wrapper is a few kilobytes.
#[cfg(unix)]
const SERVICE_FILE_LIMIT: u64 = 1024 * 1024;

/// Reads the service file at `path`, `None` when nothing is there. Never
/// blocks: a link must lead to a file (a dangling one is a broken service,
/// not a missing one); what it leads to is opened without following a
/// further link and without waiting (a FIFO), and must be a regular file
/// before a byte is read.
#[cfg(unix)]
fn read_service_file(path: &Path) -> Result<Option<ServiceText>> {
    use std::io::Read;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let context = || format!("reading the relay service `{}`", path.display());
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(anyhow::Error::from(error).context(context())),
    }
    let target = fs::canonicalize(path).map_err(|error| {
        let what = if error.kind() == std::io::ErrorKind::NotFound {
            "is a link to nothing"
        } else {
            "could not be resolved"
        };
        anyhow::Error::from(error).context(format!(
            "the relay service `{}` {what}; run `wsmp service install`",
            path.display()
        ))
    })?;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK | nix::libc::O_NOFOLLOW)
        .open(&target)
        .with_context(context)?;
    let metadata = file.metadata().with_context(context)?;
    anyhow::ensure!(
        metadata.is_file(),
        "the relay service `{}` is not a regular file; run `wsmp service install`",
        path.display()
    );
    // Bytes, not text: `defaults` saves a plist in the binary format.
    let mut bytes = Vec::new();
    (&file)
        .take(SERVICE_FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .with_context(context)?;
    anyhow::ensure!(
        bytes.len() as u64 <= SERVICE_FILE_LIMIT,
        "the relay service `{}` is larger than {} bytes",
        path.display(),
        SERVICE_FILE_LIMIT
    );
    Ok(Some(ServiceText {
        file,
        target,
        mode: metadata.permissions().mode() & 0o7777,
        bytes,
    }))
}

/// A service file as [`stable_service_files`] classifies it.
#[cfg(unix)]
enum Found {
    Absent,
    /// wsmp's rendering ([`ServiceKind::generated`]): rendered again.
    Generated(ServiceText),
    /// Not wsmp's rendering (by hand, or by another tool): the update stops.
    /// Its text is never inspected: what a service file starts depends on
    /// syntax wsmp does not parse (escapes, references, quoting, includes).
    Custom,
}

/// The file at `path` ([`read_service_file`]), classified: wsmp's when it
/// starts as wsmp's renderings do ([`ServiceKind::generated`]), or, for the
/// LaunchAgent plist, when `plist_label` reads [`super::MACOS_LABEL`] from it (a
/// plist wsmp wrote, saved again by `plutil`, `defaults` or Xcode with its
/// keys in another order: the owner's rule, 2026-10-30). Custom otherwise,
/// and when the label cannot be read.
#[cfg(unix)]
fn find(path: &Path, kind: ServiceKind, plist_label: &PlistLabel<'_>) -> Result<Found> {
    Ok(match read_service_file(path)? {
        None => Found::Absent,
        Some(found) if kind.generated(&found.bytes) => Found::Generated(found),
        Some(found)
            if kind == ServiceKind::LaunchdPlist
                && plist_label(&found.target).as_deref() == Some(super::MACOS_LABEL) =>
        {
            Found::Generated(found)
        }
        Some(_) => Found::Custom,
    })
}

/// [`ensure_stable_executable`] on `files`: in the order they are written
/// (macOS: the wrapper, then the plist that runs it), the last one the loader,
/// without which no service is installed. `render` gives, in the same order,
/// what `wsmp service install` writes now for `stable`. Each call:
/// 1. finds each file ([`find`]; `plist_label` reads a plist's label): absent,
///    wsmp's ([`Found::Generated`]), or custom; a broken one is an error. No
///    loader: no service, done.
/// 2. refuses, with nothing written, any custom file (the owner's rule,
///    2026-10-30: wsmp cannot tell what it starts, so it cannot tell whether
///    the restart runs the new keg), and a rendering that fails (a path or
///    pin with a character no service file can hold: [`super::text::refuse_unwritable`]);
/// 3. `publish`es ([`publish_file`]: the old file stays whole when this
///    fails) each file whose bytes or mode differ from `render`'s, and a
///    missing runner (the loader, wsmp's, names it). Nothing is written while
///    `stable` does not exist (`brew unlink`);
/// 4. syncs every file found and its directory (a rename an earlier try could
///    not sync is synced now), then `reload`s (Linux: `daemon-reload`).
///
/// No step depends on an earlier call having finished, so one that failed
/// part-way is finished by the next.
#[cfg(unix)]
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
fn stable_service_files(
    files: &[(&Path, ServiceKind)],
    stable: &Path,
    render: impl FnOnce() -> Result<Vec<String>>,
    publish: &Publish<'_>,
    reload: impl FnOnce() -> Result<()>,
    plist_label: &PlistLabel<'_>,
) -> Result<()> {
    let Some(((loader, loader_kind), runners)) = files.split_last() else {
        return Ok(());
    };
    let loader_found = find(loader, *loader_kind, plist_label)?;
    if matches!(loader_found, Found::Absent) {
        return Ok(());
    }
    let mut found = runners
        .iter()
        .map(|(path, kind)| find(path, *kind, plist_label))
        .collect::<Result<Vec<_>>>()?;
    found.push(loader_found);
    if let Some((path, _)) = files
        .iter()
        .zip(&found)
        .find(|(_, file)| matches!(file, Found::Custom))
        .map(|(file, _)| *file)
    {
        anyhow::bail!(
            "the relay service `{}` was not written by `wsmp service install`, so a Homebrew update cannot tell what it starts; nothing was changed and wsmp was not upgraded. Run `wsmp service install` (it writes a service the update keeps on the stable path `{}`) and update again, or update by hand: `brew upgrade flycockpit/tap/wsmp`, then make your service start `{}` and restart it",
            path.display(),
            stable.display(),
            stable.display()
        );
    }
    // Every file found is wsmp's now (the loader is there, so it is): a value
    // that no service file can hold ([`refuse_unwritable`]) refuses the update
    // here, before anything is written.
    let rendered = render()?;
    anyhow::ensure!(
        rendered.len() == files.len(),
        "rendered {} service files for {}",
        rendered.len(),
        files.len()
    );
    let stale: Vec<(&Path, ServiceKind, &String)> = files
        .iter()
        .zip(&found)
        .zip(&rendered)
        .filter(|(((_, kind), file), bytes)| match file {
            Found::Generated(current) => {
                current.bytes != bytes.as_bytes() || current.mode != kind.mode()
            }
            // A runner the loader (wsmp's) names.
            Found::Absent => true,
            Found::Custom => false,
        })
        .map(|(((path, kind), _), bytes)| (*path, *kind, bytes))
        .collect();
    if !stale.is_empty() {
        anyhow::ensure!(
            stable.exists(),
            "the stable Homebrew link `{}` is missing, so the relay service `{}` cannot be moved onto it; run `brew link wsmp` and `wsmp service install`",
            stable.display(),
            loader.display()
        );
    }
    for (path, kind, bytes) in stale {
        publish(path, bytes.as_bytes(), kind.mode()).with_context(|| {
            format!(
                "writing the relay service `{}` for the stable Homebrew path; run `wsmp service install`",
                path.display()
            )
        })?;
    }
    // Finish what an earlier try may have left: each file (the one found, or
    // the one just published, already synced) and the rename in its directory.
    for file in &found {
        if let Found::Generated(current) = file {
            current
                .file
                .sync_all()
                .with_context(|| format!("syncing `{}`", current.target.display()))?;
            sync_dir(
                current
                    .target
                    .parent()
                    .context("service file has no parent directory")?,
            )?;
        }
    }
    reload().with_context(|| {
        format!(
            "reloading the relay service `{}` (`systemctl --user daemon-reload`)",
            loader.display()
        )
    })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn write_service_file(file: &Path, contents: &str) -> Result<()> {
    publish_file(file, contents.as_bytes(), SERVICE_FILE_MODE)
}

#[cfg(target_os = "macos")]
pub(crate) fn write_private_script(path: &Path, bytes: &[u8]) -> Result<()> {
    publish_file(path, bytes, PRIVATE_SCRIPT_MODE)
}

/// A systemd unit or LaunchAgent plist.
#[cfg(unix)]
const SERVICE_FILE_MODE: u32 = 0o644;
/// The macOS wrapper: it pins the service's paths, so only its owner reads it.
#[cfg(unix)]
const PRIVATE_SCRIPT_MODE: u32 = 0o700;

/// Writes `bytes` to `path` so that `path` is always either its old complete
/// file or the new complete one with `mode`, never a part or a file without
/// its mode: a temporary file in the same directory gets all of it, its mode
/// and an fsync, then is renamed over `path`, and the directory is synced. A
/// failure before the rename leaves the old file as it was (the temporary file
/// is removed). A symlink at `path` stays: the file it points to is replaced.
/// A process killed between creating and renaming the temporary file leaves
/// it behind (`.wsmp-*.tmp` beside `path`, a few kilobytes, no secret): it is
/// not cleaned up, since nothing shows whether another wsmp is still writing
/// it, and it is safe to delete.
#[cfg(unix)]
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
fn publish_file(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    publish_file_with(path, bytes, mode, &|_| Ok(()))
}

/// A step of [`publish_file`] a test can make fail.
#[cfg(unix)]
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PublishStep {
    /// Half of the bytes are written.
    Write,
    Mode,
    Sync,
    Rename,
}

/// [`publish_file`], asking `fault` before each [`PublishStep`].
#[cfg(unix)]
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
fn publish_file_with(
    path: &Path,
    bytes: &[u8],
    mode: u32,
    fault: &dyn Fn(PublishStep) -> std::io::Result<()>,
) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let target = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::canonicalize(path)
            .with_context(|| format!("resolving the symlink `{}`", path.display()))?,
        _ => path.to_path_buf(),
    };
    let dir = target
        .parent()
        .context("service file has no parent directory")?;
    fs::create_dir_all(dir).with_context(|| format!("creating `{}`", dir.display()))?;
    let mut temp = tempfile::Builder::new()
        .prefix(".wsmp-")
        .suffix(".tmp")
        .tempfile_in(dir)
        .with_context(|| format!("creating a temporary file in `{}`", dir.display()))?;
    let (first, rest) = bytes.split_at(bytes.len() / 2);
    temp.write_all(first)
        .and_then(|()| fault(PublishStep::Write))
        .and_then(|()| temp.write_all(rest))
        .with_context(|| format!("writing `{}`", target.display()))?;
    fault(PublishStep::Mode)
        .and_then(|()| {
            temp.as_file()
                .set_permissions(fs::Permissions::from_mode(mode))
        })
        .with_context(|| format!("setting the permissions of `{}`", target.display()))?;
    fault(PublishStep::Sync)
        .and_then(|()| temp.as_file().sync_all())
        .with_context(|| format!("syncing `{}`", target.display()))?;
    fault(PublishStep::Rename).with_context(|| format!("replacing `{}`", target.display()))?;
    temp.persist(&target)
        .map_err(|error| error.error)
        .with_context(|| format!("replacing `{}`", target.display()))?;
    sync_dir(dir)
}

/// Syncs `dir`, so a rename in it survives a crash. [`stable_service_files`]
/// does it again on every update: one that failed here after the rename is
/// finished by the next.
#[cfg(unix)]
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
fn sync_dir(dir: &Path) -> Result<()> {
    #[cfg(test)]
    let fault = tests::dir_sync_fault(dir);
    #[cfg(not(test))]
    let fault = Ok(());
    fault
        .and_then(|()| fs::File::open(dir))
        .and_then(|dir| dir.sync_all())
        .with_context(|| format!("syncing `{}`", dir.display()))
}

#[cfg(target_os = "macos")]
pub(crate) fn set_private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata =
        fs::metadata(path).with_context(|| format!("reading metadata for `{}`", path.display()))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(path, permissions)
        .with_context(|| format!("setting private permissions on `{}`", path.display()))
}

#[cfg(all(test, target_os = "linux"))]
mod homebrew_tests;
#[cfg(all(test, unix))]
mod tests;
