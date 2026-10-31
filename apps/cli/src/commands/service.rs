//! Per-user service for the relay daemon: a systemd user unit (Linux), a
//! launchd agent that runs a small 0700 wrapper (macOS), or a Task Scheduler
//! task that starts at logon (Windows, see `windows_task`).
//!
//! The service needs no environment of its own: the node credential is in
//! the state directory and node secrets are in `secrets.env`, both of which
//! the relay reads itself. The unit (or wrapper) pins only the config and
//! state paths and `PATH` of the installing shell, never a secret.

use std::fs;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::Command;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::Stdio;

use anyhow::{Context, Result};
use clap::Subcommand;

use crate::output;

#[cfg(target_os = "linux")]
const LINUX_UNIT: &str = "wsmp.service";
/// The relay LaunchAgent's label: a plist with it is wsmp's
/// ([`ServiceKind::LaunchdPlist`]).
#[cfg(unix)]
const MACOS_LABEL: &str = "com.flycockpit.wsmp";
#[cfg(target_os = "macos")]
const MACOS_WRAPPER_NAME: &str = "wsmp-service-run.sh";

#[derive(Debug, clap::Args)]
pub struct Args {
    #[command(subcommand)]
    command: CommandName,
}

#[derive(Debug, Subcommand)]
enum CommandName {
    /// Install, enable, and start the per-user relay service.
    Install,
    /// Stop, disable, and remove the per-user relay service.
    Uninstall,
    /// Print the per-user relay service status.
    Status,
    /// Restart the per-user relay service (after `wsmp login`, or to apply
    /// settings read only at start).
    Restart,
    /// Print the relay service's logs (journald on Linux, the launchd log
    /// files on macOS, the relay's own log file on Windows).
    Logs(LogsArgs),
}

#[derive(Debug, clap::Args)]
struct LogsArgs {
    /// Keep printing new lines as they come.
    #[arg(short, long)]
    follow: bool,
    /// How many of the latest lines to print first.
    #[arg(short = 'n', long, default_value_t = 100)]
    lines: u32,
}

pub fn run(args: &Args) -> Result<()> {
    match &args.command {
        CommandName::Install => {
            crate::trust::refuse_in_job("wsmp service install")?;
            install(false)
        }
        CommandName::Uninstall => {
            crate::trust::refuse_in_job("wsmp service uninstall")?;
            uninstall()
        }
        CommandName::Status => status(),
        CommandName::Restart => {
            crate::trust::refuse_in_job("wsmp service restart")?;
            restart()
        }
        // Read-only.
        CommandName::Logs(logs_args) => logs(logs_args),
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn service_file() -> Result<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
        .context("could not determine the user config directory")?;
    Ok(base.join("systemd/user").join(LINUX_UNIT))
}

#[cfg(target_os = "macos")]
pub(crate) fn service_file() -> Result<PathBuf> {
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    Ok(home
        .join("Library/LaunchAgents")
        .join(format!("{MACOS_LABEL}.plist")))
}

#[cfg(target_os = "macos")]
fn macos_wrapper_path() -> Result<PathBuf> {
    absolute_in(&crate::paths::state_dir()?, MACOS_WRAPPER_NAME)
}

/// `name` in `dir`, made absolute against this process's working directory
/// (as [`pinned_service_env`] pins the state directory): the plist names the
/// wrapper, and launchd reads a relative path against its own working
/// directory, not that of the shell that ran `wsmp service install` or
/// `wsmp update` (a relative `WSMP_STATE_DIR`). No link is followed.
#[cfg(any(target_os = "macos", all(test, unix)))]
fn absolute_in(dir: &Path, name: &str) -> Result<PathBuf> {
    let path = dir.join(name);
    std::path::absolute(&path).with_context(|| format!("resolving `{}`", path.display()))
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_log_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    Ok(home.join("Library/Logs/ws-model-proxy"))
}

/// The task definition `wsmp service install` registered, kept beside the
/// state it pins (the task itself lives in Task Scheduler).
#[cfg(windows)]
pub(crate) fn service_file() -> Result<PathBuf> {
    Ok(crate::paths::state_dir()?.join(windows_task::DEFINITION_FILE))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn service_file() -> Result<PathBuf> {
    anyhow::bail!("service installation is only supported on Linux, macOS and Windows")
}

/// The binary `wsmp service install` makes the service run: this one, except
/// that a Homebrew keg's versioned `Cellar/wsmp/<version>/bin/wsmp` becomes
/// the stable `<prefix>/opt/wsmp/bin/wsmp` link (`brew upgrade` and `brew
/// cleanup` remove old kegs). A Homebrew update passes its own stable path to
/// [`ensure_stable_executable`] instead.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
fn executable() -> Result<String> {
    let exe = std::env::current_exe().context("resolving the wsmp executable")?;
    let exe = std::fs::canonicalize(&exe)
        .ok()
        .and_then(|canonical| crate::update::homebrew::stable_path(&canonical))
        .filter(|stable| stable.exists())
        .unwrap_or(exe);
    exe.into_os_string()
        .into_string()
        .map_err(|_| anyhow::anyhow!("wsmp executable path is not valid UTF-8"))
}

/// Before a Homebrew upgrade, and before anything else changes: the installed
/// service must start `stable` (`<prefix>/opt/wsmp/bin/wsmp`), so the restart
/// runs the new keg. `stable` is the very path the update probes with
/// `--version` after `brew upgrade`: that probe, not a check here, is what
/// shows the restart target runs.
///
/// Every file `wsmp service install` wrote (the unit; the wrapper and the
/// LaunchAgent plist) is rendered again by the same renderer, with `stable`
/// and this process's pins ([`pinned_service_env`]), and written when its
/// bytes or mode differ: an older template, a `Cellar` path, an alias, a hand
/// edit or a file cut short after its opening are all replaced (one that does
/// not have wsmp's complete opening, an empty one too, is custom: see
/// [`ServiceKind::generated`]). A path or pin the service
/// file cannot hold as written (a control character such as a newline) is an
/// error before anything is written ([`refuse_unwritable`]). Any file not
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
        &[(&service_file()?, ServiceKind::SystemdUnit)],
        stable,
        || {
            Ok(vec![render_systemd_user_unit(
                executable()?,
                &pinned_service_env()?,
            )?])
        },
        &publish_file,
        || run_finite("systemctl", &["--user", "daemon-reload"]),
        // No plist here.
        &|_| None,
    )?;
    #[cfg(target_os = "macos")]
    {
        let wrapper = macos_wrapper_path()?;
        stable_service_files(
            &[
                (&wrapper, ServiceKind::LaunchdWrapper),
                (&service_file()?, ServiceKind::LaunchdPlist),
            ],
            stable,
            || {
                Ok(vec![
                    render_macos_service_wrapper(executable()?, &pinned_service_env()?)?,
                    macos_plist(&wrapper)?,
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
    /// is [`MACOS_LABEL`], whatever its layout ([`find`]).
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
/// it), bounded ([`crate::update::deadman::run_bounded_split`]). `file` is
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
    let (ok, stdout, _) =
        crate::update::deadman::run_bounded_split("/usr/bin/plutil", &args, &[], PLUTIL_TIMEOUT)
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
/// LaunchAgent plist, when `plist_label` reads [`MACOS_LABEL`] from it (a
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
                && plist_label(&found.target).as_deref() == Some(MACOS_LABEL) =>
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
///    pin with a character no service file can hold: [`refuse_unwritable`]);
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

/// How [`restart_quietly`] restarts the relay service.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Restart {
    /// What the service manager has loaded (the dead-man's rollback; a
    /// self-replace update).
    Loaded,
    /// After a Homebrew update: on macOS, launchd loads the LaunchAgent plist
    /// again first (`bootout`, `bootstrap`: [`restart_launch_agent`]), since
    /// it keeps the copy it loaded and [`ensure_stable_executable`] may have
    /// rewritten the file, in this update or an earlier try of it. Elsewhere
    /// the same as `Loaded` (systemd was reloaded before the upgrade).
    Reloaded,
}

/// Restart the relay service without printing (the update dead-man and
/// `wsmp update`), as `how` says. An error when it is not installed. Every
/// service-manager call is bounded ([`run_finite`]).
pub fn restart_quietly(how: Restart) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        let _ = how;
        require_installed()?;
        run_finite("systemctl", &["--user", "restart", LINUX_UNIT])
    }
    #[cfg(target_os = "macos")]
    {
        require_installed()?;
        let file = service_file()?;
        let file = path_text("the relay service", &file)?;
        let domain = launchd_domain()?;
        restart_launch_agent(
            &mut SystemLaunchctl,
            LaunchAgentCaller::Restart(how),
            &domain,
            &format!("{domain}/{MACOS_LABEL}"),
            file,
            std::time::Instant::now() + FINITE_COMMAND_TIMEOUT,
        )
    }
    #[cfg(windows)]
    {
        let _ = how;
        let file = service_file()?;
        anyhow::ensure!(file.exists(), "the relay service is not installed");
        let name = windows_task_name()?;
        end_windows_task(&name);
        schtasks(&["/Run", "/TN", &name]).map(|_| ())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = how;
        anyhow::bail!("service installation is only supported on Linux, macOS and Windows")
    }
}

/// The `launchctl` calls [`restart_launch_agent`] makes, and its clock:
/// [`SystemLaunchctl`] on macOS, a fake in tests.
#[cfg(any(target_os = "macos", test))]
trait Launchctl {
    /// `launchctl args`, stopped after `timeout`: how it ended (exit code and
    /// output) when it ran to its end, whatever its status. An error when it
    /// could not start, ran out of time or was stopped (too many commands,
    /// wsmp exiting): then nothing is known of what launchd would have said.
    fn run(
        &mut self,
        args: &[&str],
        timeout: std::time::Duration,
    ) -> Result<crate::update::deadman::Exited>;
    fn now(&self) -> std::time::Instant;
    fn sleep(&mut self, pause: std::time::Duration);
}

#[cfg(target_os = "macos")]
struct SystemLaunchctl;

#[cfg(target_os = "macos")]
impl Launchctl for SystemLaunchctl {
    fn run(
        &mut self,
        args: &[&str],
        timeout: std::time::Duration,
    ) -> Result<crate::update::deadman::Exited> {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
        crate::update::deadman::run_bounded_status("launchctl", &args, &[], timeout)
    }
    fn now(&self) -> std::time::Instant {
        std::time::Instant::now()
    }
    fn sleep(&mut self, pause: std::time::Duration) {
        std::thread::sleep(pause);
    }
}

/// The first wait between two looks at launchd (an unload to finish, a
/// bootstrap to try again, a look that failed); each next one doubles, up to
/// [`LAUNCHD_POLL_MAX`].
#[cfg(any(target_os = "macos", test))]
const LAUNCHD_POLL_FIRST: std::time::Duration = std::time::Duration::from_millis(100);
#[cfg(any(target_os = "macos", test))]
const LAUNCHD_POLL_MAX: std::time::Duration = std::time::Duration::from_secs(1);

/// `launchctl print <domain>/<label>`'s exit status for a service launchd
/// does not have ("Bad request. Could not find service … in domain"), as
/// seen on a Mac. Every other failure of `print` says nothing about it.
#[cfg(any(target_os = "macos", test))]
const LAUNCHCTL_NOT_LOADED: i32 = 113;

/// What a person runs when the relay's LaunchAgent is left unloaded by a
/// restart.
#[cfg(any(target_os = "macos", test))]
const LAUNCHD_RECOVERY: &str = "run `wsmp service install` to load the relay service again (`wsmp update` does not reload it when wsmp is already current)";

/// Who asks [`restart_launch_agent`], which decides the way back an error
/// names and whether `kickstart` must succeed.
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LaunchAgentCaller {
    /// [`restart_quietly`]: its errors point at `wsmp service install`.
    Restart(Restart),
    /// `wsmp service install` itself: load the plist it just wrote (a
    /// reload: `bootout` first when loaded). Its errors cannot point at
    /// itself as something new to run, so they say to run it again or load
    /// the plist by hand; `kickstart` stays best effort, as before (the
    /// plist has `RunAtLoad`).
    Install,
}

/// What `launchctl print` showed of the agent.
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Agent {
    /// Exit 0: launchd has it.
    Loaded,
    /// Exit [`LAUNCHCTL_NOT_LOADED`]: launchd does not have it.
    Absent,
}

/// `Ok` for a `launchctl` call that exited 0; its output otherwise.
#[cfg(any(target_os = "macos", test))]
fn launchctl_ok(args: &[&str], ran: crate::update::deadman::Exited) -> Result<()> {
    if ran.code == Some(0) {
        return Ok(());
    }
    Err(launchctl_failed(args, &ran))
}

/// The error for a `launchctl` call that exited `ran.code`, with its output.
#[cfg(any(target_os = "macos", test))]
fn launchctl_failed(args: &[&str], ran: &crate::update::deadman::Exited) -> anyhow::Error {
    let status = ran
        .code
        .map_or_else(|| "a signal".to_string(), |code| format!("exit {code}"));
    anyhow::anyhow!(
        "`launchctl {}` failed ({status}): {}{}",
        args.join(" "),
        ran.stdout.trim(),
        ran.stderr.trim()
    )
}

/// macOS [`restart_quietly`]: restart the LaunchAgent `agent`
/// (`<domain>/<label>`, loaded from `file`), every `launchctl` call within
/// one `deadline`.
///
/// Each look at launchd (`print`) is loaded (exit 0), not loaded (exit
/// [`LAUNCHCTL_NOT_LOADED`]), or no answer (any other end: it could not run,
/// ran out of time, another status). No answer is never taken as not
/// loaded: it is asked again until the deadline, then an error.
///
/// - `Restart::Reloaded`: when loaded, `bootout`, then wait until launchd
///   says it no longer has it: `bootout` returns before launchd has finished
///   unloading, and a `bootstrap` meanwhile fails (commonly "Bootstrap
///   failed: 5: Input/output error"). A `bootout` that fails while the agent
///   is still loaded is an error (the relay keeps running what launchd
///   loaded).
/// - Then (always for `Reloaded`, and for `Loaded` when the agent is not
///   loaded: `kickstart` fails on that, exit 113) `bootstrap`, tried again
///   until the deadline while it fails and the agent is not loaded. A
///   `bootstrap` that fails while launchd says the agent is loaded is
///   taken as loaded only after launchd said it was not loaded (so what it
///   has was loaded since, from the file as it is now), which every path
///   here establishes before it runs `bootstrap`.
/// - Then `kickstart -k`.
///
/// Every error names the way back ([`LAUNCHD_RECOVERY`]; for `Install`: run
/// it again, or `launchctl bootstrap` by hand), so the relay is never left
/// unloaded in silence. `Install` is `Reloaded`: its first install (nothing
/// loaded) is `bootstrap`, then `kickstart`, as before.
#[cfg(any(target_os = "macos", test))]
fn restart_launch_agent(
    launchctl: &mut dyn Launchctl,
    caller: LaunchAgentCaller,
    domain: &str,
    agent: &str,
    file: &str,
    deadline: std::time::Instant,
) -> Result<()> {
    let (how, recovery) = match caller {
        LaunchAgentCaller::Restart(how) => (how, LAUNCHD_RECOVERY.to_string()),
        LaunchAgentCaller::Install => (
            Restart::Reloaded,
            format!(
                "run `wsmp service install` again, or load it by hand: `launchctl bootstrap {domain} '{}'`",
                shell_single_quote(file)
            ),
        ),
    };
    let left = |launchctl: &dyn Launchctl| deadline.saturating_duration_since(launchctl.now());
    // Whether launchd has the agent, asked again (with the same backoff)
    // while `print` gives no answer; an error when none came by the deadline.
    let look = |launchctl: &mut dyn Launchctl| -> Result<Agent> {
        let mut pause = LAUNCHD_POLL_FIRST;
        loop {
            let time = left(launchctl);
            let error = if time.is_zero() {
                anyhow::anyhow!("no time was left to run `launchctl print {agent}`")
            } else {
                match launchctl.run(&["print", agent], time) {
                    Ok(ran) => match ran.code {
                        Some(0) => return Ok(Agent::Loaded),
                        Some(LAUNCHCTL_NOT_LOADED) => return Ok(Agent::Absent),
                        _ => launchctl_failed(&["print", agent], &ran),
                    },
                    Err(error) => error,
                }
            };
            if left(launchctl) <= pause {
                return Err(error.context(format!(
                    "launchd did not say whether it has the relay service `{agent}` loaded; {recovery}"
                )));
            }
            launchctl.sleep(pause);
            pause = (pause * 2).min(LAUNCHD_POLL_MAX);
        }
    };
    let was_loaded = look(launchctl)? == Agent::Loaded;
    // Set once launchd has said it does not have the agent: whatever it has
    // after that was loaded from the file as it is now.
    let mut seen_absent = !was_loaded;
    if how == Restart::Reloaded && was_loaded {
        // launchd runs the plist it loaded, never the file as it is now:
        // `bootout` and `bootstrap` make it read the file again.
        let bootout = launchctl
            .run(&["bootout", agent], left(launchctl))
            .and_then(|ran| launchctl_ok(&["bootout", agent], ran));
        if let Err(error) = bootout {
            // One that went away meanwhile is what was asked for.
            if look(launchctl)? == Agent::Loaded {
                return Err(error.context(format!(
                    "unloading the relay service `{agent}`: it still runs the definition launchd loaded; {recovery}"
                )));
            }
            seen_absent = true;
        }
        let mut pause = LAUNCHD_POLL_FIRST;
        while !seen_absent {
            if look(launchctl)? == Agent::Absent {
                seen_absent = true;
                break;
            }
            let time = left(launchctl);
            anyhow::ensure!(
                time > pause,
                "launchd was still unloading the relay service `{agent}` when the restart ran out of time; {recovery}"
            );
            launchctl.sleep(pause);
            pause = (pause * 2).min(LAUNCHD_POLL_MAX);
        }
    }
    // An installed agent that is not loaded (booted out) is loaded first:
    // `kickstart` fails on it (exit 113), where systemd and Task Scheduler
    // start a stopped service.
    if how == Restart::Reloaded || !was_loaded {
        anyhow::ensure!(
            seen_absent,
            "launchd was not seen to unload the relay service `{agent}`; {recovery}"
        );
        let mut pause = LAUNCHD_POLL_FIRST;
        loop {
            let time = left(launchctl);
            let error = if time.is_zero() {
                anyhow::anyhow!("no time was left to run `launchctl bootstrap`")
            } else {
                let args = ["bootstrap", domain, file];
                match launchctl
                    .run(&args, time)
                    .and_then(|ran| launchctl_ok(&args, ran))
                {
                    Ok(()) => break,
                    Err(error) => error,
                }
            };
            // Loaded after all (launchd can report an error for a load it
            // made, or another `bootstrap` won): since launchd said it did
            // not have the agent, this is the file as it is now. Restart it
            // below.
            if look(launchctl)? == Agent::Loaded {
                break;
            }
            if left(launchctl) <= pause {
                return Err(error.context(format!(
                    "launchd did not load the relay service `{file}`, so the relay is not running; {recovery}"
                )));
            }
            launchctl.sleep(pause);
            pause = (pause * 2).min(LAUNCHD_POLL_MAX);
        }
    }
    let time = left(launchctl);
    anyhow::ensure!(
        !time.is_zero(),
        "the relay service `{agent}` was loaded but no time was left to restart it; {recovery}"
    );
    let args = ["kickstart", "-k", agent];
    let kicked = launchctl
        .run(&args, time)
        .and_then(|ran| launchctl_ok(&args, ran))
        .with_context(|| format!("restarting the relay service `{agent}`; {recovery}"));
    if caller == LaunchAgentCaller::Install {
        // Loaded with `RunAtLoad`: it starts without the kick.
        return Ok(());
    }
    kicked
}

/// Whether `wsmp service install` installed the relay service here.
pub fn installed() -> bool {
    service_file().is_ok_and(|file| file.exists())
}

/// Windows: start the relay task (a no-op while it runs: `IgnoreNew`).
#[cfg(windows)]
pub fn kick_relay_task() -> Result<()> {
    schtasks(&["/Run", "/TN", &windows_task_name()?]).map(|_| ())
}

/// After `wsmp login`, a relay service that stopped on a rejected credential
/// (exit 4, which systemd does not restart) needs a manual restart.
pub fn restart_hint_after_login() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        if service_file().is_ok_and(|file| file.exists()) {
            return Some(
                "if the relay service stopped for lack of a credential, restart it: `wsmp service restart`"
                    .to_string(),
            );
        }
    }
    None
}

/// A character wsmp does not write into a service file: a control character
/// (C0 such as LF, CR, tab and NUL; DEL; C1), or U+FFFE / U+FFFF. One rule
/// for every renderer is wsmp's policy; what each grammar does with them:
/// - systemd (`systemd.syntax(7)`): a unit is read line by line, so LF and CR
///   end the setting inside quotes (`Unbalanced quoting`), and NUL ends it;
/// - launchd plists are XML 1.0: C0 other than tab, LF and CR, and U+FFFE /
///   U+FFFF, are not `Char`s (§2.2), and a parser turns CR and CRLF into LF
///   (§2.11). Tab, LF and C1 would come back as written; they are refused
///   by the policy, not by XML;
/// - the `/bin/sh` wrapper: a shell script holds no NUL (POSIX XCU 2.1, text
///   files), and a value's LF would put a second line into the file wsmp
///   reads back as its own.
///
/// So [`refuse_unwritable`] refuses them, before anything is written.
fn unwritable(ch: char) -> bool {
    ch.is_control() || matches!(ch, '\u{FFFE}' | '\u{FFFF}')
}

/// An error, before anything is written, when `value` (named by `what`)
/// holds a character [`unwritable`] in a service file.
pub(crate) fn refuse_unwritable(what: &str, value: &str) -> Result<()> {
    if let Some(ch) = value.chars().find(|&ch| unwritable(ch)) {
        anyhow::bail!(
            "{what} `{}` contains the control character U+{:04X}, which a service file cannot hold; nothing was written. Use a path without it, then run `wsmp service install`",
            value.escape_debug(),
            u32::from(ch)
        );
    }
    Ok(())
}

/// `path` exactly as text, or an error naming it (`what`), before anything
/// is written or run: `display()` writes U+FFFD for bytes that are not
/// UTF-8, which would name another file. Service files and the commands
/// that load them carry paths as UTF-8 text.
pub(crate) fn path_text<'a>(what: &str, path: &'a Path) -> Result<&'a str> {
    path.to_str().with_context(|| {
        format!(
            "{what} `{}` is not valid UTF-8; nothing was written",
            path.display()
        )
    })
}

/// Where a value goes in a systemd unit, which decides how
/// [`systemd_quote`] writes it (`systemd.service(5)`, "Command lines";
/// `systemd.exec(5)`, `Environment=`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SystemdField {
    /// The program of `ExecStart=`: systemd runs this path as written
    /// (variables are expanded only in the arguments), so `$` is itself.
    ExecPath,
    /// An argument of `ExecStart=`: `${NAME}` and `$NAME` are expanded from
    /// the service's environment, inside quotes too, and `$$` is one `$`; so
    /// each `$` is written `$$`.
    ExecArg,
    /// An `Environment=` assignment: "the `$` character has no special
    /// meaning", so it is itself.
    Environment,
}

/// `value` as one word of a unit line for `field`. Inside double quotes
/// systemd unescapes C escapes, so `\` and `"` are escaped; `%` starts a
/// specifier in every setting and is doubled (`systemd.unit(5)`,
/// "Specifiers"); `$` is doubled in an [`SystemdField::ExecArg`]. An empty
/// value is `""` (an empty argument; written bare it would be none). A value
/// with a character [`unwritable`] is an error.
fn systemd_quote(value: &str, field: SystemdField) -> Result<String> {
    refuse_unwritable("the value", value)?;
    let safe = !value.is_empty()
        && value.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(ch, '/' | '.' | '_' | '-' | ':' | '@' | '+' | '=')
        });
    if safe {
        return Ok(value.to_string());
    }
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            // systemd treats `%` as a specifier in unit files.
            '%' => out.push_str("%%"),
            '$' if field == SystemdField::ExecArg => out.push_str("$$"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    Ok(out)
}

/// One argument (after the program) of an `ExecStart=` line, kept exactly as
/// it is: quoted, with `$` written `$$` so systemd does not expand it
/// ([`SystemdField::ExecArg`]).
pub fn systemd_exec_arg(value: &str) -> Result<String> {
    systemd_quote(value, SystemdField::ExecArg)
}

/// An `Environment=` setting's value for `name=value`, kept exactly as it is
/// ([`SystemdField::Environment`]: `$` is itself there).
pub fn systemd_environment(name: &str, value: &str) -> Result<String> {
    refuse_unwritable(&format!("the pinned `{name}`"), value)?;
    systemd_quote(&format!("{name}={value}"), SystemdField::Environment)
}

/// The program of an `ExecStart=` line: an absolute path (a leading `-`, `@`,
/// `+`, `!` or `:` is a prefix to systemd, a bare name is looked up), with no
/// character systemd's `string_is_safe()` refuses in an executable name
/// (`"`, `'`, `\` and control characters: "Executable name contains special
/// characters", `systemd.service(5)`, "Command lines"), then quoted
/// ([`SystemdField::ExecPath`]).
pub fn systemd_exec_path(path: &str) -> Result<String> {
    refuse_unwritable("the wsmp executable path", path)?;
    anyhow::ensure!(
        path.starts_with('/'),
        "the wsmp executable path `{path}` is not absolute; nothing was written"
    );
    anyhow::ensure!(
        !path.contains(['"', '\'', '\\']),
        "the wsmp executable path `{path}` contains a quote or a backslash, which systemd refuses in the program it runs; nothing was written. Install wsmp on a path without them, then run `wsmp service install`"
    );
    systemd_quote(path, SystemdField::ExecPath)
}

/// Variables `wsmp service install` pins into the service so it resolves the
/// same config file and state directory (and so the same device credential)
/// as the shell that installed it, whatever `XDG_*` the service manager sets,
/// and so commands it starts find the same programs (`PATH`). Paths only: no
/// secret ever goes into the unit or wrapper.
pub fn pinned_service_env() -> Result<Vec<(&'static str, String)>> {
    let pin = |name: &'static str, path: PathBuf| -> Result<(&'static str, String)> {
        let path = std::path::absolute(&path)
            .with_context(|| format!("resolving `{}`", path.display()))?;
        let value = path
            .into_os_string()
            .into_string()
            .map_err(|_| anyhow::anyhow!("`{name}` path is not valid UTF-8"))?;
        Ok((name, value))
    };
    let mut pinned = vec![
        pin("WSMP_CONFIG", crate::paths::config_file()?)?,
        pin("WSMP_STATE_DIR", crate::paths::state_dir()?)?,
    ];
    // The installing shell's PATH, frozen at install time; re-run install to
    // refresh it. Skipped when unset, not UTF-8, or nothing usable is left.
    if let Some(path) = std::env::var("PATH")
        .ok()
        .and_then(|path| service_path(&path, usable_service_path_dir))
    {
        pinned.push(("PATH", path));
    }
    Ok(pinned)
}

/// The installing shell's `PATH` reduced to what a service should search:
/// absolute directories `keep` accepts, each once, in order. Empty and
/// relative entries (which would resolve against the service's working
/// directory) are dropped. None when nothing is left.
pub fn service_path(path: &str, keep: impl Fn(&Path) -> bool) -> Option<String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in std::env::split_paths(path) {
        if dir.as_os_str().is_empty() || !dir.is_absolute() || dirs.contains(&dir) || !keep(&dir) {
            continue;
        }
        dirs.push(dir);
    }
    if dirs.is_empty() {
        return None;
    }
    std::env::join_paths(dirs).ok()?.into_string().ok()
}

/// An existing directory that other users cannot write to (a world-writable
/// directory on the service's PATH would let them plant programs it runs).
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
fn usable_service_path_dir(dir: &Path) -> bool {
    let Ok(metadata) = fs::metadata(dir) else {
        return false;
    };
    if !metadata.is_dir() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o002 == 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Render a systemd user unit for the relay. `pinned` holds non-secret
/// `Environment=` entries (see [`pinned_service_env`]). An error, with
/// nothing rendered, for a value systemd would read differently
/// ([`systemd_exec_path`], [`systemd_quote_arg`]).
pub fn render_systemd_user_unit(executable: &str, pinned: &[(&str, String)]) -> Result<String> {
    let exec = systemd_exec_path(executable)?;
    let pinned: String = pinned
        .iter()
        .map(|(name, value)| {
            Ok(format!(
                "Environment={}\n",
                systemd_environment(name, value)?
            ))
        })
        .collect::<Result<_>>()?;
    Ok(format!(
        "[Unit]\n\
         Description=WS Model Proxy relay\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exec} run\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         # Exit 4: the credential is missing or was rejected (HTTP 401, including a\n\
         # temporary ban); restarting cannot fix it. Run `wsmp login`, then\n\
         # `wsmp service restart`.\n\
         # Exit 5: the server refused this wsmp's relay protocol. Re-run the\n\
         # server's install.sh (or upgrade the server), then `wsmp service restart`.\n\
         RestartPreventExitStatus=4 5\n\
         Environment=WSMP_STOP_ON_PROTOCOL_MISMATCH=1\n\
         # Tells the relay it may exit 4 here instead of retrying in-process.\n\
         Environment=WSMP_STOP_ON_REJECTED_CREDENTIAL=1\n\
         # The config and state paths `wsmp service install` resolved, so the service\n\
         # reads the same device credential as the installing shell.\n\
         {pinned}\
         WorkingDirectory=%h\n\
         StandardOutput=journal\n\
         StandardError=journal\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    ))
}

/// Render a macOS LaunchAgent plist. `program` is the wrapper script path so the
/// plist never embeds secret environment values. Each value is XML text
/// ([`plist_text`]); an error, with nothing rendered, for one XML cannot
/// carry.
pub fn render_launch_agent_plist(
    label: &str,
    program: &str,
    working_directory: &str,
    stdout_path: &str,
    stderr_path: &str,
) -> Result<String> {
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key>\n\
         \t<string>{label}</string>\n\
         \t<key>ProgramArguments</key>\n\
         \t<array>\n\
         \t\t<string>{program}</string>\n\
         \t</array>\n\
         \t<key>RunAtLoad</key>\n\
         \t<true/>\n\
         \t<key>KeepAlive</key>\n\
         \t<true/>\n\
         \t<key>ThrottleInterval</key>\n\
         \t<integer>5</integer>\n\
         \t<key>ProcessType</key>\n\
         \t<string>Background</string>\n\
         \t<key>WorkingDirectory</key>\n\
         \t<string>{working_directory}</string>\n\
         \t<key>StandardOutPath</key>\n\
         \t<string>{stdout_path}</string>\n\
         \t<key>StandardErrorPath</key>\n\
         \t<string>{stderr_path}</string>\n\
         </dict>\n\
         </plist>\n",
        label = plist_text("the LaunchAgent label", label)?,
        program = plist_text("the wrapper path", program)?,
        working_directory = plist_text("the home directory", working_directory)?,
        stdout_path = plist_text("the log path", stdout_path)?,
        stderr_path = plist_text("the log path", stderr_path)?,
    ))
}

/// Render the 0700 wrapper that pins the service's paths then execs wsmp.
/// Values are single-quoted: inside single quotes `sh` takes every character
/// as itself except `'` (POSIX XCU 2.2.2), which [`shell_single_quote`]
/// writes as `'"'"'`. An error, with nothing rendered, for a relative
/// `executable` (`exec` would search `PATH`) or a value with a character
/// [`unwritable`].
pub fn render_macos_service_wrapper(executable: &str, pinned: &[(&str, String)]) -> Result<String> {
    refuse_unwritable("the wsmp executable path", executable)?;
    anyhow::ensure!(
        executable.starts_with('/'),
        "the wsmp executable path `{executable}` is not absolute; nothing was written"
    );
    let pinned: String = pinned
        .iter()
        .map(|(name, value)| {
            refuse_unwritable(&format!("the pinned `{name}`"), value)?;
            Ok(format!("export {name}='{}'\n", shell_single_quote(value)))
        })
        .collect::<Result<_>>()?;
    Ok(format!(
        "#!/bin/sh\n\
         # Generated by `wsmp service install`: the config and state paths and\n\
         # PATH of the installing shell (no secrets), then the relay.\n\
         set -eu\n\
         {pinned}\
         exec '{executable}' run\n",
        executable = shell_single_quote(executable),
    ))
}

fn shell_single_quote(value: &str) -> String {
    // Paths from current_exe / config_dir should not contain `'`; defend anyway.
    value.replace('\'', "'\"'\"'")
}

/// `value` as plist (XML 1.0) character data: markup characters escaped
/// ([`xml_escape`]), and an error, with nothing rendered, for a character
/// [`unwritable`] (not an XML `Char`, or one a parser would not give back as
/// written).
pub(crate) fn plist_text(what: &str, value: &str) -> Result<String> {
    refuse_unwritable(what, value)?;
    Ok(xml_escape(value))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// A line of install output: stdout, or stderr when the caller's stdout
/// carries JSON (`wsmp login --json`).
#[cfg_attr(
    not(any(target_os = "linux", target_os = "macos", windows)),
    allow(dead_code)
)]
fn say(to_stderr: bool, text: impl std::fmt::Display) -> Result<()> {
    if to_stderr {
        output::diagnostic(text)
    } else {
        output::line(text)
    }
}

#[cfg(target_os = "linux")]
pub fn install(to_stderr: bool) -> Result<()> {
    let file = service_file()?;
    let executable = executable()?;
    let pinned = pinned_service_env()?;
    let unit = render_systemd_user_unit(&executable, &pinned)?;
    write_service_file(&file, &unit)?;
    run_command("systemctl", &["--user", "daemon-reload"])?;
    // enable --now is idempotent enough for reinstall/upgrade: unit path is
    // rewritten above, then reloaded and (re)started.
    run_command("systemctl", &["--user", "enable", "--now", LINUX_UNIT])?;
    // Restart so an already-running unit picks up a replaced binary/unit.
    let _ = Command::new("systemctl")
        .args(["--user", "restart", LINUX_UNIT])
        .status();
    print_install_notes(&pinned, to_stderr)?;
    say(
        to_stderr,
        format!("installed and started `{}`", file.display()),
    )
}

#[cfg(target_os = "macos")]
pub fn install(to_stderr: bool) -> Result<()> {
    let file = service_file()?;
    // Checked before anything is written: `launchctl bootstrap` is given it.
    let file_text = path_text("the relay service", &file)?;
    let executable = executable()?;

    let wrapper = macos_wrapper_path()?;
    let pinned = pinned_service_env()?;
    // Both rendered before anything is written: a value neither file can
    // hold is an error with the old files as they were.
    let wrapper_body = render_macos_service_wrapper(&executable, &pinned)?;
    let plist = macos_plist(&wrapper)?;
    if let Some(parent) = wrapper.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating `{}`", parent.display()))?;
        set_private_dir(parent)?;
    }
    write_private_script(&wrapper, wrapper_body.as_bytes())?;

    let log_dir = macos_log_dir()?;
    fs::create_dir_all(&log_dir).with_context(|| format!("creating `{}`", log_dir.display()))?;
    write_service_file(&file, &plist)?;

    let domain = launchd_domain()?;
    // Reinstall: boot out the loaded agent, wait until launchd has unloaded
    // it, then bootstrap (tried again while it fails) and kickstart; a first
    // install only bootstraps and kickstarts. All bounded, in one deadline.
    restart_launch_agent(
        &mut SystemLaunchctl,
        LaunchAgentCaller::Install,
        &domain,
        &format!("{domain}/{MACOS_LABEL}"),
        file_text,
        std::time::Instant::now() + FINITE_COMMAND_TIMEOUT,
    )?;

    print_install_notes(&pinned, to_stderr)?;
    say(
        to_stderr,
        format!("installed and started `{}`", file.display()),
    )
}

/// The LaunchAgent plist `wsmp service install` writes: it runs `wrapper`,
/// and logs to [`macos_log_dir`]. A Homebrew update renders it again
/// ([`ensure_stable_executable`]).
#[cfg(target_os = "macos")]
fn macos_plist(wrapper: &Path) -> Result<String> {
    let log_dir = macos_log_dir()?;
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    // Each path as it is ([`path_text`]): the plist is UTF-8 XML.
    render_launch_agent_plist(
        MACOS_LABEL,
        path_text("the wrapper path", wrapper)?,
        path_text("the home directory", &home)?,
        path_text("the log path", &log_dir.join("relay.out.log"))?,
        path_text("the log path", &log_dir.join("relay.err.log"))?,
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn install(_to_stderr: bool) -> Result<()> {
    let _ = service_file()?;
    unreachable!()
}

#[cfg(target_os = "linux")]
fn uninstall() -> Result<()> {
    let file = service_file()?;
    let _ = Command::new("systemctl")
        .args(["--user", "disable", "--now", LINUX_UNIT])
        .status();
    if file.exists() {
        fs::remove_file(&file).with_context(|| format!("removing `{}`", file.display()))?;
    }
    let _ = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status();
    output::line("uninstalled relay service")
}

#[cfg(target_os = "macos")]
fn uninstall() -> Result<()> {
    let file = service_file()?;
    let domain = launchd_domain()?;
    bootout_if_loaded(&domain, &file);
    if file.exists() {
        fs::remove_file(&file).with_context(|| format!("removing `{}`", file.display()))?;
    }
    if let Ok(wrapper) = macos_wrapper_path()
        && wrapper.exists()
    {
        let _ = fs::remove_file(&wrapper);
    }
    output::line("uninstalled relay service")
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn uninstall() -> Result<()> {
    let _ = service_file()?;
    unreachable!()
}

#[cfg(target_os = "linux")]
fn status() -> Result<()> {
    run_command("systemctl", &["--user", "status", LINUX_UNIT])
}

#[cfg(target_os = "macos")]
fn status() -> Result<()> {
    let domain = launchd_domain()?;
    run_command("launchctl", &["print", &format!("{domain}/{MACOS_LABEL}")])
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn status() -> Result<()> {
    let _ = service_file()?;
    unreachable!()
}

#[cfg(target_os = "linux")]
fn restart() -> Result<()> {
    require_installed()?;
    run_command("systemctl", &["--user", "restart", LINUX_UNIT])?;
    output::line(format!("restarted `{LINUX_UNIT}`"))
}

#[cfg(target_os = "macos")]
fn restart() -> Result<()> {
    require_installed()?;
    let domain = launchd_domain()?;
    run_command(
        "launchctl",
        &["kickstart", "-k", &format!("{domain}/{MACOS_LABEL}")],
    )?;
    output::line(format!("restarted `{MACOS_LABEL}`"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn restart() -> Result<()> {
    let _ = service_file()?;
    unreachable!()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn require_installed() -> Result<()> {
    let file = service_file()?;
    anyhow::ensure!(
        file.exists(),
        "the relay service is not installed (`{}` is missing); run `wsmp service install`",
        file.display()
    );
    Ok(())
}

/// `journalctl` arguments for the relay unit's logs.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn journalctl_args(args: &LogsArgs) -> Vec<String> {
    let mut out = vec![
        "--user".to_string(),
        "--unit".to_string(),
        "wsmp.service".to_string(),
        "--lines".to_string(),
        args.lines.to_string(),
        "--no-pager".to_string(),
    ];
    if args.follow {
        out.push("--follow".to_string());
    }
    out
}

#[cfg(target_os = "linux")]
fn logs(args: &LogsArgs) -> Result<()> {
    let argv = journalctl_args(args);
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    run_command("journalctl", &argv)
}

/// The launchd agent writes stdout and stderr to files; `tail` them.
#[cfg(target_os = "macos")]
fn logs(args: &LogsArgs) -> Result<()> {
    let dir = macos_log_dir()?;
    // The paths go to `tail` as they are (never as text).
    let files: Vec<PathBuf> = ["relay.err.log", "relay.out.log"]
        .iter()
        .map(|name| dir.join(name))
        .filter(|path| path.exists())
        .collect();
    anyhow::ensure!(
        !files.is_empty(),
        "no relay service logs in `{}` yet",
        dir.display()
    );
    let lines = args.lines.to_string();
    let mut argv = vec![std::ffi::OsStr::new("-n"), lines.as_ref()];
    if args.follow {
        argv.push("-F".as_ref());
    }
    argv.extend(files.iter().map(|file| file.as_os_str()));
    run_command("tail", &argv)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn logs(_args: &LogsArgs) -> Result<()> {
    let _ = service_file()?;
    unreachable!()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn print_install_notes(pinned: &[(&str, String)], to_stderr: bool) -> Result<()> {
    for (name, value) in pinned {
        say(to_stderr, format!("service pins `{name}` to `{value}`"))?;
    }
    say(
        to_stderr,
        "node secrets are read from `secrets.env` (`wsmp secret`); the service needs no environment file",
    )?;
    #[cfg(target_os = "linux")]
    match linger_on() {
        Some(true) => {}
        Some(false) => say(
            to_stderr,
            "warning: lingering is off, so this node cannot start runtimes and the service \
             stops when you log out; enable it once with `loginctl enable-linger \"$USER\"`",
        )?,
        None => say(
            to_stderr,
            "tip: for a user service that survives logout and can start runtimes, run \
             `loginctl enable-linger \"$USER\"`",
        )?,
    }
    Ok(())
}

/// Whether logind keeps this user's manager running without a session;
/// `None` when `loginctl` cannot say.
#[cfg(target_os = "linux")]
fn linger_on() -> Option<bool> {
    let uid = nix::unistd::Uid::effective().as_raw().to_string();
    let output = Command::new("loginctl")
        .args(["show-user", &uid, "-p", "Linger"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Some(crate::runtimes::executor::native::linger_enabled(&text))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn write_service_file(file: &Path, contents: &str) -> Result<()> {
    publish_file(file, contents.as_bytes(), SERVICE_FILE_MODE)
}

#[cfg(target_os = "macos")]
fn write_private_script(path: &Path, bytes: &[u8]) -> Result<()> {
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
fn set_private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata =
        fs::metadata(path).with_context(|| format!("reading metadata for `{}`", path.display()))?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(path, permissions)
        .with_context(|| format!("setting private permissions on `{}`", path.display()))
}

/// How long a finite service-manager command (`daemon-reload`, `restart`,
/// `bootstrap`, `kickstart`, `print`, `id -u`, `schtasks`) may take when an
/// update or the dead-man runs it.
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
const FINITE_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3 * 60);

/// A finite service-manager command run by an update (or by what it runs on):
/// supervised and bounded like every update-management command
/// ([`crate::update::deadman::run_bounded`]: its own process group, both pipes
/// drained, killed at the deadline and on shutdown). Its output on failure.
/// Commands a person watches (`status`, `logs --follow`) keep [`run_command`].
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn run_finite(program: &str, args: &[&str]) -> Result<()> {
    run_finite_within(program, args, FINITE_COMMAND_TIMEOUT)
}

/// [`run_finite`], stopped after `timeout`.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn run_finite_within(program: &str, args: &[&str], timeout: std::time::Duration) -> Result<()> {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let (ok, output) = crate::update::deadman::run_bounded(program, &args, &[], timeout)?;
    anyhow::ensure!(ok, "`{program}` failed: {}", output.trim());
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn run_command(program: &str, args: &[impl AsRef<std::ffi::OsStr>]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("running `{program}`"))?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("`{program}` failed with {status}")
    }
}

/// Boot out the agent when launchd has it loaded. Best effort and quiet:
/// launchctl prints alarming errors (`Boot-out failed: 5`) for an agent
/// that is not loaded, which is every first install.
#[cfg(target_os = "macos")]
fn bootout_if_loaded(domain: &str, file: &Path) {
    if agent_loaded(domain) {
        let _ = Command::new("launchctl")
            .args(["bootout", domain])
            .arg(file)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Whether launchd has the relay agent loaded in `domain`.
#[cfg(target_os = "macos")]
fn agent_loaded(domain: &str) -> bool {
    run_finite("launchctl", &["print", &format!("{domain}/{MACOS_LABEL}")]).is_ok()
}

#[cfg(target_os = "macos")]
fn launchd_domain() -> Result<String> {
    let (ok, uid, errors) = crate::update::deadman::run_bounded_split(
        "id",
        &["-u".to_string()],
        &[],
        FINITE_COMMAND_TIMEOUT,
    )
    .context("determining the current user ID")?;
    anyhow::ensure!(ok, "`id -u` failed: {}", errors.trim());
    // LaunchAgents for the logged-in GUI session use the `gui/<uid>` domain.
    Ok(format!("gui/{}", uid.trim()))
}

/// Windows: a Task Scheduler task of this user's, started at logon.
///
/// - It runs as the user, only while they are logged on (`InteractiveToken`,
///   least privilege), so it needs no password and stops at logoff, like a
///   Linux user service without linger. A Windows service would run in
///   session 0 or need the user's password, and could not host terminals in
///   the user's session.
/// - `conhost.exe --headless` starts the relay with no console window.
/// - A task cannot set environment variables, so the config and state paths
///   are pinned as hidden `wsmp run` options instead, with `--log-file`, since
///   Task Scheduler keeps no output.
/// - Restarts: the relay already retries in-process (no `WSMP_STOP_ON_*`
///   here). A relay that exits anyway is started again by a trigger that
///   fires every 5 minutes while the user is logged on; a running relay
///   makes it a no-op (`IgnoreNew`).
/// - `schtasks /End` kills the relay without its graceful shutdown; its
///   kill-on-close jobs still end every command and terminal it started.
///
/// Built everywhere so its rendering tests run on every CI platform.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) mod windows_task {
    /// Kept in the state dir; marks the service as installed.
    pub const DEFINITION_FILE: &str = "wsmp-relay-task.xml";
    pub const LOG_FILE: &str = "relay.log";

    /// One task per Windows user: Task Scheduler names are machine-wide.
    pub fn task_name(user: &str) -> String {
        let user: String = user
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        format!("wsmp-relay-{user}")
    }

    /// One argument for a Windows command line, as `CommandLineToArgvW` (and
    /// Rust's own argument parser) reads it back.
    pub fn quote_arg(value: &str) -> String {
        if !value.is_empty() && !value.contains([' ', '\t', '"']) {
            return value.to_string();
        }
        let mut out = String::from("\"");
        let mut backslashes = 0;
        for ch in value.chars() {
            match ch {
                '\\' => backslashes += 1,
                '"' => {
                    out.push_str(&"\\".repeat(backslashes * 2 + 1));
                    out.push('"');
                    backslashes = 0;
                }
                _ => {
                    out.push_str(&"\\".repeat(backslashes));
                    out.push(ch);
                    backslashes = 0;
                }
            }
        }
        // Backslashes before the closing quote are doubled, so `C:\dir\`
        // does not swallow it.
        out.push_str(&"\\".repeat(backslashes * 2));
        out.push('"');
        out
    }

    /// The `conhost.exe` arguments: headless, then `wsmp run` with the
    /// pinned paths.
    pub fn arguments(executable: &str, config: &str, state_dir: &str, log_file: &str) -> String {
        [
            "--headless",
            executable,
            "run",
            "--service",
            "--config",
            config,
            "--state-dir",
            state_dir,
            "--log-file",
            log_file,
        ]
        .iter()
        .map(|arg| quote_arg(arg))
        .collect::<Vec<_>>()
        .join(" ")
    }

    /// The task definition `schtasks /Create /XML` reads. `user_sid` names
    /// both the logon trigger and the principal.
    pub fn render_xml(user_sid: &str, arguments: &str, working_directory: &str) -> String {
        let sid = super::xml_escape(user_sid);
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
             <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
             \x20 <RegistrationInfo>\n\
             \x20   <Description>WS Model Proxy relay (`wsmp run`), installed by `wsmp service install`.</Description>\n\
             \x20 </RegistrationInfo>\n\
             \x20 <Triggers>\n\
             \x20   <LogonTrigger>\n\
             \x20     <Enabled>true</Enabled>\n\
             \x20     <UserId>{sid}</UserId>\n\
             \x20   </LogonTrigger>\n\
             \x20   <TimeTrigger>\n\
             \x20     <Repetition>\n\
             \x20       <Interval>PT5M</Interval>\n\
             \x20       <StopAtDurationEnd>false</StopAtDurationEnd>\n\
             \x20     </Repetition>\n\
             \x20     <StartBoundary>2026-01-01T00:00:00</StartBoundary>\n\
             \x20     <Enabled>true</Enabled>\n\
             \x20   </TimeTrigger>\n\
             \x20 </Triggers>\n\
             \x20 <Principals>\n\
             \x20   <Principal id=\"Author\">\n\
             \x20     <UserId>{sid}</UserId>\n\
             \x20     <LogonType>InteractiveToken</LogonType>\n\
             \x20     <RunLevel>LeastPrivilege</RunLevel>\n\
             \x20   </Principal>\n\
             \x20 </Principals>\n\
             \x20 <Settings>\n\
             \x20   <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n\
             \x20   <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n\
             \x20   <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n\
             \x20   <AllowHardTerminate>true</AllowHardTerminate>\n\
             \x20   <StartWhenAvailable>false</StartWhenAvailable>\n\
             \x20   <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n\
             \x20   <IdleSettings>\n\
             \x20     <StopOnIdleEnd>false</StopOnIdleEnd>\n\
             \x20     <RestartOnIdle>false</RestartOnIdle>\n\
             \x20   </IdleSettings>\n\
             \x20   <AllowStartOnDemand>true</AllowStartOnDemand>\n\
             \x20   <Enabled>true</Enabled>\n\
             \x20   <Hidden>false</Hidden>\n\
             \x20   <RunOnlyIfIdle>false</RunOnlyIfIdle>\n\
             \x20   <WakeToRun>false</WakeToRun>\n\
             \x20   <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n\
             \x20   <Priority>5</Priority>\n\
             \x20   <RestartOnFailure>\n\
             \x20     <Interval>PT1M</Interval>\n\
             \x20     <Count>999</Count>\n\
             \x20   </RestartOnFailure>\n\
             \x20 </Settings>\n\
             \x20 <Actions Context=\"Author\">\n\
             \x20   <Exec>\n\
             \x20     <Command>%SystemRoot%\\System32\\conhost.exe</Command>\n\
             \x20     <Arguments>{arguments}</Arguments>\n\
             \x20     <WorkingDirectory>{working_directory}</WorkingDirectory>\n\
             \x20   </Exec>\n\
             \x20 </Actions>\n\
             </Task>\n",
            arguments = super::xml_escape(arguments),
            working_directory = super::xml_escape(working_directory),
        )
    }

    /// UTF-16LE with a byte-order mark, as the declaration says.
    pub fn utf16_bytes(text: &str) -> Vec<u8> {
        std::iter::once(0xFEFF_u16)
            .chain(text.encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect()
    }

    /// The last `count` lines of `text`.
    pub fn last_lines(text: &str, count: usize) -> Vec<&str> {
        let lines: Vec<&str> = text.lines().collect();
        lines[lines.len().saturating_sub(count)..].to_vec()
    }
}

#[cfg(windows)]
fn windows_user() -> Result<String> {
    std::env::var("USERNAME").context("`USERNAME` is not set")
}

#[cfg(windows)]
fn windows_task_name() -> Result<String> {
    Ok(windows_task::task_name(&windows_user()?))
}

#[cfg(windows)]
fn windows_log_file() -> Result<PathBuf> {
    Ok(crate::paths::log_dir()?.join(windows_task::LOG_FILE))
}

/// Runs `schtasks`, capturing its output: what it prints goes to the
/// caller's stream only by choice (stdout may carry `--json`).
/// Supervised and bounded like every update-management command (an update's
/// restart runs it): see [`run_finite`].
#[cfg(windows)]
fn schtasks(args: &[&str]) -> Result<String> {
    let argv: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let (ok, stdout, stderr) =
        crate::update::deadman::run_bounded_split("schtasks", &argv, &[], FINITE_COMMAND_TIMEOUT)
            .context("running `schtasks`")?;
    let stdout = stdout.trim().to_string();
    if ok {
        return Ok(stdout);
    }
    let stderr = stderr.trim().to_string();
    anyhow::bail!(
        "`schtasks {}` failed: {}",
        args.first().copied().unwrap_or_default(),
        if stderr.is_empty() { stdout } else { stderr }
    )
}

/// Whether Task Scheduler runs the task now. `Get-ScheduledTask` reports an
/// enum (`Running`, `Ready`, …) that reads the same in every Windows
/// language; `schtasks /Query` prints a localized status.
#[cfg(windows)]
fn windows_task_running(name: &str) -> bool {
    // `task_name` keeps names to `[A-Za-z0-9._-]`, so single quotes suffice.
    let script = format!("(Get-ScheduledTask -TaskName '{name}' -ErrorAction Stop).State");
    let argv = ["-NoProfile", "-NonInteractive", "-Command", &script].map(str::to_string);
    crate::update::deadman::run_bounded_split("powershell", &argv, &[], FINITE_COMMAND_TIMEOUT)
        .is_ok_and(|(_, stdout, _)| stdout.trim() == "Running")
}

/// Stops the task's relay: gracefully through its control pipe (it ends its
/// commands and terminals and tells the server), then `schtasks /End` for the
/// console host, which `/End` kills without its child. Waits (bounded) until
/// Task Scheduler no longer counts the task as running and the pipe is gone;
/// otherwise a `/Run` right after is dropped (`IgnoreNew`), or the new relay
/// finds the pipe still taken.
#[cfg(windows)]
fn end_windows_task(name: &str) {
    use crate::control::{ControlCommand, request_if_running};
    if matches!(request_if_running(ControlCommand::Stop), Ok(Some(_))) {
        let deadline = std::time::Instant::now() + crate::shutdown::SHUTDOWN_DEADLINE * 2;
        while std::time::Instant::now() < deadline
            && !matches!(request_if_running(ControlCommand::Status), Ok(None))
        {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
    let _ = schtasks(&["/End", "/TN", name]);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        let pipe_gone = matches!(
            crate::control::request_if_running(crate::control::ControlCommand::Status),
            Ok(None)
        );
        if pipe_gone && !windows_task_running(name) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

#[cfg(windows)]
pub fn install(to_stderr: bool) -> Result<()> {
    let absolute = |path: PathBuf| -> Result<String> {
        std::path::absolute(&path)
            .with_context(|| format!("resolving `{}`", path.display()))?
            .into_os_string()
            .into_string()
            .map_err(|_| anyhow::anyhow!("`{}` is not valid UTF-8", path.display()))
    };
    let executable = executable()?;
    let config = absolute(crate::paths::config_file()?)?;
    let state_dir = absolute(crate::paths::state_dir()?)?;
    let log_file = absolute(windows_log_file()?)?;
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    let sid = wsmp_windows::current_user_sid().context("reading this user's SID")?;
    let arguments = windows_task::arguments(&executable, &config, &state_dir, &log_file);
    let xml = windows_task::render_xml(&sid, &arguments, path_text("the home directory", &home)?);
    let file = service_file()?;
    // Checked before the file is written: `schtasks` is given it.
    let file_arg = path_text("the task definition", &file)?.to_string();
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating `{}`", parent.display()))?;
    }
    fs::write(&file, windows_task::utf16_bytes(&xml))
        .with_context(|| format!("writing `{}`", file.display()))?;
    let name = windows_task_name()?;
    schtasks(&["/Create", "/TN", &name, "/XML", &file_arg, "/F"])?;
    // Reinstall or upgrade: a running relay is replaced by the new binary.
    end_windows_task(&name);
    schtasks(&["/Run", "/TN", &name])?;
    for (option, value) in [
        ("--config", &config),
        ("--state-dir", &state_dir),
        ("--log-file", &log_file),
    ] {
        say(to_stderr, format!("service pins `{option}` to `{value}`"))?;
    }
    say(
        to_stderr,
        "node secrets are read from `secrets.env` (`wsmp secret`); the service needs no environment",
    )?;
    say(
        to_stderr,
        "the relay runs while you are logged on to Windows and stops when you log off",
    )?;
    say(
        to_stderr,
        format!("installed and started the scheduled task `{name}`"),
    )
}

#[cfg(windows)]
fn uninstall() -> Result<()> {
    let name = windows_task_name()?;
    end_windows_task(&name);
    // Already gone is fine.
    let _ = schtasks(&["/Delete", "/TN", &name, "/F"]);
    let file = service_file()?;
    if file.exists() {
        fs::remove_file(&file).with_context(|| format!("removing `{}`", file.display()))?;
    }
    output::line("uninstalled relay service")
}

#[cfg(windows)]
fn status() -> Result<()> {
    let name = windows_task_name()?;
    output::line(schtasks(&["/Query", "/TN", &name, "/V", "/FO", "LIST"])?)
}

#[cfg(windows)]
fn restart() -> Result<()> {
    let file = service_file()?;
    anyhow::ensure!(
        file.exists(),
        "the relay service is not installed (`{}` is missing); run `wsmp service install`",
        file.display()
    );
    let name = windows_task_name()?;
    end_windows_task(&name);
    schtasks(&["/Run", "/TN", &name])?;
    output::line(format!("restarted the scheduled task `{name}`"))
}

/// The relay's own log file: the last lines, then (with `--follow`) new ones
/// as they come, across roll-overs.
#[cfg(windows)]
fn logs(args: &LogsArgs) -> Result<()> {
    use std::io::{Read, Seek, SeekFrom};

    let path = windows_log_file()?;
    let text = fs::read(&path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .with_context(|| format!("no relay service log at `{}` yet", path.display()))?;
    for line in windows_task::last_lines(&text, args.lines as usize) {
        output::line(line)?;
    }
    if !args.follow {
        return Ok(());
    }
    let mut position = text.len() as u64;
    let mut pending = String::new();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let Ok(mut file) = fs::File::open(&path) else {
            continue;
        };
        let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        if len < position {
            // Rolled over: the new file starts from the top.
            position = 0;
            pending.clear();
        }
        if len == position {
            continue;
        }
        file.seek(SeekFrom::Start(position))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        position += bytes.len() as u64;
        pending.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(end) = pending.find('\n') {
            let line: String = pending.drain(..=end).collect();
            output::line(line.trim_end_matches(['\r', '\n']))?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).expect("meta").permissions().mode() & 0o777
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
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
    fn bytes_of(path: &Path) -> Option<Vec<u8>> {
        std::fs::metadata(path)
            .ok()
            .filter(std::fs::Metadata::is_file)
            .and_then(|_| std::fs::read(path).ok())
    }

    /// A keg script: `run` prints `DAEMON <version>`, `--version` prints
    /// `wsmp <version>`, anything else exits 19.
    #[cfg(unix)]
    fn keg_script(version: &str) -> String {
        format!(
            "#!/bin/sh\nif [ \"$1\" = run ]; then echo 'DAEMON {version}'; exit 0; fi\n\
             if [ \"$1\" = --version ]; then echo 'wsmp {version}'; exit 0; fi\nexit 19\n"
        )
    }

    /// Runs `program` with `args`, again while another test thread's fork
    /// still holds a just-written script open (ETXTBSY).
    #[cfg(unix)]
    fn run_script(program: &Path, args: &[&str]) -> std::process::Output {
        for _ in 0..50 {
            match std::process::Command::new(program).args(args).output() {
                Ok(output)
                    if !String::from_utf8_lossy(&output.stderr).contains("Text file busy") =>
                {
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
        fn render_for(
            &self,
            kind: ServiceKind,
            executable: &str,
            pinned: &[(&str, String)],
        ) -> String {
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
    fn pins() -> Vec<(&'static str, String)> {
        vec![
            ("WSMP_CONFIG", "/u/c.json".to_string()),
            ("PATH", "/usr/bin:/bin".to_string()),
        ]
    }

    #[cfg(unix)]
    fn no_reload() -> Result<()> {
        Ok(())
    }

    #[cfg(unix)]
    fn never_publish(_: &Path, _: &[u8], _: u32) -> Result<()> {
        anyhow::bail!("nothing must be written")
    }

    /// The unit and wrapper of wsmp before 0.4.0 (`0c336eea`), which ran
    /// `daemon start --foreground` and read an `EnvironmentFile`.
    #[cfg(unix)]
    fn pre_0_4_template(kind: ServiceKind, executable: &str) -> String {
        match kind {
            ServiceKind::SystemdUnit => format!(
                "[Unit]\nDescription=WS Model Proxy relay\nAfter=network-online.target\n\
                 Wants=network-online.target\n\n[Service]\nType=simple\n\
                 ExecStart={executable} daemon start --foreground\nRestart=on-failure\n\
                 RestartSec=5\n# Optional: CLI-token / endpoint-header env vars (see `wsmp service env-sync`).\n\
                 # The leading `-` means a missing file is not fatal (device credentials still work).\n\
                 EnvironmentFile=-/u/.config/ws-model-proxy/service.env\nWorkingDirectory=%h\n\
                 StandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n"
            ),
            _ => format!(
                "#!/bin/sh\n# Generated by `wsmp service install`. Sources the private env file\n\
                 # (CLI-token / endpoint-header vars) without storing secrets in the plist.\n\
                 set -eu\nENV_FILE='/u/service.env'\nif [ -f \"$ENV_FILE\" ]; then\n\tset -a\n\
                 \t# shellcheck disable=SC1090\n\t. \"$ENV_FILE\"\n\tset +a\nfi\n\
                 exec '{executable}' daemon start --foreground\n"
            ),
        }
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
        for kind in [ServiceKind::SystemdUnit, ServiceKind::LaunchdWrapper] {
            assert!(
                kind.generated(pre_0_4_template(kind, &keg.old).as_bytes()),
                "{kind:?}"
            );
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
                    "the pre-0.4.0 template",
                    pre_0_4_template(kind, &keg.old),
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
        // An older wsmp's wrapper and a plist cut short: both.
        std::fs::write(&wrapper, pre_0_4_template(wrapper_kind, &keg.old)).expect("w");
        let plist_text = keg.render(plist_kind);
        std::fs::write(&plist, &plist_text[..plist_text.len() / 3]).expect("plist");
        keg.pair(&recording).expect("both written");
        canonical();
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

    /// The production path, on Linux, run by a parent test as a child of this
    /// test binary (so the environment is its own): with `WSMP_TEST_THROUGH`
    /// `ensure`, [`ensure_stable_executable`] for the Homebrew prefix
    /// `WSMP_TEST_PREFIX`; with `update`, the whole Homebrew update
    /// ([`crate::update::agent::homebrew`], its service step that same
    /// function) against that prefix's fake `brew`. Writes what happened to
    /// `WSMP_TEST_THROUGH_OUT`; a no-op in an ordinary test run.
    #[cfg(target_os = "linux")]
    #[test]
    fn through_the_update_child() {
        use crate::protocol::frames::{UpdatePhase, UpdateReason};
        use crate::update::flow::{Machine, Progress, Request};

        struct Log(String);
        impl Progress for Log {
            fn report(
                &mut self,
                phase: UpdatePhase,
                reason: Option<UpdateReason>,
                detail: Option<String>,
            ) {
                self.0.push_str(&format!(
                    "{phase:?} {reason:?} {}\n",
                    detail.unwrap_or_default().replace('\n', " ")
                ));
            }
        }

        let Some(out) = std::env::var_os("WSMP_TEST_THROUGH_OUT") else {
            return;
        };
        let prefix = PathBuf::from(std::env::var_os("WSMP_TEST_PREFIX").expect("prefix"));
        let live = prefix.join("Cellar/wsmp/0.4.2/bin/wsmp");
        let stable = crate::update::homebrew::stable_path(&live).expect("a keg");
        let result = match std::env::var("WSMP_TEST_THROUGH").as_deref() {
            Ok("update") => {
                let machine = Machine {
                    state_dir: PathBuf::from(std::env::var_os("WSMP_STATE_DIR").expect("state")),
                    live,
                    target: "test-target".into(),
                    scheduler: None,
                    tar: crate::update::install::system_tar(),
                    current_version: "0.4.2".into(),
                    before_swap: None,
                    proceed: None,
                    stable_service: ensure_stable_executable,
                };
                let request = Request {
                    update_id: "u-1".into(),
                    version: "0.4.3".into(),
                    artifact_url: String::new(),
                    sha256: String::new(),
                    signature: None,
                    rollback_after_secs: 90,
                    origin: crate::update::state::Origin::Cli,
                };
                let mut log = Log(String::new());
                let ended = crate::update::agent::homebrew(&machine, &request, &mut log);
                format!("{ended:?}\n{}", log.0)
            }
            _ => match ensure_stable_executable(&stable) {
                Ok(()) => "ok".to_string(),
                Err(error) => format!("error: {error:#}").replace('\n', " "),
            },
        };
        std::fs::write(out, result).expect("write the result");
    }

    /// A Homebrew prefix for [`through_the_update_child`]: kegs 0.4.2 (the
    /// running one, from `flycockpit/tap`) as `opt/wsmp`; a fake `brew` whose
    /// tap has 0.4.3 and whose `upgrade` pours that keg (its binary's mode
    /// from `upgrade-mode`) and moves `opt/wsmp` to it; a fake `systemctl`
    /// that logs what it is asked; `XDG_CONFIG_HOME` here.
    #[cfg(target_os = "linux")]
    struct Through {
        dir: tempfile::TempDir,
        unit: PathBuf,
        /// `opt/wsmp/bin/wsmp`.
        stable: String,
    }

    #[cfg(target_os = "linux")]
    impl Through {
        fn new() -> Self {
            Self::named(".tmp")
        }

        /// [`Through::new`] in a directory whose name starts with `name`.
        fn named(name: &str) -> Self {
            let dir = tempfile::Builder::new()
                .prefix(name)
                .tempdir()
                .expect("dir");
            let root = dir.path().display().to_string();
            let keg = dir.path().join("Cellar/wsmp/0.4.2");
            std::fs::create_dir_all(keg.join("bin")).expect("keg");
            std::fs::write(keg.join("bin/wsmp"), keg_script("0.4.2")).expect("wsmp");
            set_mode(&keg.join("bin/wsmp"), 0o755);
            std::fs::write(
                keg.join("INSTALL_RECEIPT.json"),
                r#"{"source":{"tap":"flycockpit/tap"}}"#,
            )
            .expect("receipt");
            std::fs::create_dir_all(dir.path().join("opt")).expect("opt");
            std::os::unix::fs::symlink(&keg, dir.path().join("opt/wsmp")).expect("link");
            std::fs::create_dir_all(dir.path().join("bin")).expect("bin");
            let script = keg_script("0.4.3")
                .replace('\\', "\\\\")
                .replace('\'', "'\\''")
                .replace('%', "%%")
                .replace('\n', "\\n");
            std::fs::write(
                dir.path().join("bin/brew"),
                format!(
                    "#!/bin/sh\nr='{root}'\necho \"$1\" >> \"$r/brew.log\"\ncase \"$1\" in\n\
                     --prefix) printf '%s\\n' \"$r\";;\n\
                     info) printf '{{\"formulae\":[{{\"name\":\"wsmp\",\"versions\":{{\"stable\":\"0.4.3\"}}}}]}}';;\n\
                     upgrade)\n  mkdir -p \"$r/Cellar/wsmp/0.4.3/bin\"\n\
                       printf '{script}' > \"$r/Cellar/wsmp/0.4.3/bin/wsmp\"\n\
                       chmod \"$(cat \"$r/upgrade-mode\" 2>/dev/null || echo 755)\" \"$r/Cellar/wsmp/0.4.3/bin/wsmp\"\n\
                       ln -sfn \"$r/Cellar/wsmp/0.4.3\" \"$r/opt/wsmp\";;\n\
                     esac\nexit 0\n"
                ),
            )
            .expect("brew");
            set_mode(&dir.path().join("bin/brew"), 0o755);
            let fake = dir.path().join("fakebin");
            std::fs::create_dir_all(&fake).expect("fakebin");
            std::fs::write(
                fake.join("systemctl"),
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$WSMP_TEST_SYSTEMCTL_LOG\"\nexit 0\n",
            )
            .expect("systemctl");
            set_mode(&fake.join("systemctl"), 0o755);
            let units = dir.path().join("config/systemd/user");
            std::fs::create_dir_all(&units).expect("units");
            std::fs::create_dir_all(dir.path().join("state")).expect("state");
            Self {
                unit: units.join("wsmp.service"),
                stable: dir.path().join("opt/wsmp/bin/wsmp").display().to_string(),
                dir,
            }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.dir.path().join(name)
        }

        /// The child's `PATH`: the fake `systemctl` first.
        fn path_env(&self) -> String {
            format!("{}:/usr/bin:/bin", self.path("fakebin").display())
        }

        /// The unit `wsmp service install` writes from the child's shell for
        /// `executable`.
        fn unit_for(&self, executable: &str) -> String {
            render_systemd_user_unit(
                executable,
                &[
                    (
                        "WSMP_CONFIG",
                        self.path("config.json").display().to_string(),
                    ),
                    ("WSMP_STATE_DIR", self.path("state").display().to_string()),
                    ("PATH", self.path_env()),
                ],
            )
            .expect("render")
        }

        fn stable_unit(&self) -> String {
            self.unit_for(&self.stable)
        }

        fn child(&self, through: &str, fail_dir_sync_once: bool) -> String {
            self.child_with(through, fail_dir_sync_once, &self.path("config.json"))
        }

        /// [`Through::child`] with `config` as its `WSMP_CONFIG` (a pin).
        fn child_with(&self, through: &str, fail_dir_sync_once: bool, config: &Path) -> String {
            let mut command =
                std::process::Command::new(std::env::current_exe().expect("test binary"));
            command
                .args([
                    "--exact",
                    "commands::service::tests::through_the_update_child",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("WSMP_TEST_THROUGH", through)
                .env("WSMP_TEST_THROUGH_OUT", self.path("through.result"))
                .env("WSMP_TEST_PREFIX", self.dir.path())
                .env("XDG_CONFIG_HOME", self.path("config"))
                .env("WSMP_CONFIG", config)
                .env("WSMP_STATE_DIR", self.path("state"))
                .env("PATH", self.path_env())
                .env("WSMP_TEST_SYSTEMCTL_LOG", self.path("systemctl.log"))
                .env("WSMP_TEST_DIR_SYNC_LOG", self.path("dirsync.log"));
            if fail_dir_sync_once {
                command.env("WSMP_TEST_DIR_SYNC_FAIL_ONCE", self.path("dirsync.failed"));
            }
            let _ = std::fs::remove_file(self.path("through.result"));
            let output = command.output().expect("run the child");
            std::fs::read_to_string(self.path("through.result")).unwrap_or_else(|_| {
                panic!(
                    "no result from the child: {} {}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                )
            })
        }

        /// One update's service step: `ok` or `error: …`.
        fn ensure(&self, fail_dir_sync_once: bool) -> String {
            self.child("ensure", fail_dir_sync_once)
        }

        /// A whole Homebrew update to 0.4.3: `Swapped` or `Stopped`, then the
        /// progress it reported.
        fn update(&self) -> String {
            self.child("update", false)
        }

        /// What was logged to `name` since the last call, and clears it.
        fn take(&self, name: &str) -> String {
            let path = self.path(name);
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let _ = std::fs::remove_file(&path);
            text
        }

        /// The program the unit's `ExecStart=` runs, and what it prints for
        /// `--version`: what the restart would start.
        fn unit_runs(&self) -> (String, String) {
            let text = std::fs::read_to_string(&self.unit).expect("unit");
            let program = text
                .lines()
                .find_map(|line| line.strip_prefix("ExecStart="))
                .and_then(|exec| exec.strip_suffix(" run"))
                .expect("ExecStart")
                .to_string();
            let out = run_script(Path::new(&program), &["--version"]);
            (
                program,
                String::from_utf8_lossy(&out.stdout).trim().to_string(),
            )
        }
    }

    /// `systemd-analyze verify --man=no` on `unit`: whether it passed, and
    /// what it printed. None when the tool is missing or cannot verify even
    /// a one-line unit here (then the parser checks are skipped).
    #[cfg(target_os = "linux")]
    fn systemd_verify(unit: &Path) -> Option<(bool, String)> {
        let verify = |unit: &Path| {
            let output = std::process::Command::new("systemd-analyze")
                .args(["verify", "--man=no"])
                .arg(unit)
                .output()
                .ok()?;
            Some((
                output.status.success(),
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ))
        };
        let dir = tempfile::tempdir().expect("dir");
        let plain = dir.path().join("wsmp.service");
        std::fs::write(&plain, "[Service]\nExecStart=/bin/true\n").expect("write");
        match verify(&plain) {
            Some((true, _)) => verify(unit),
            other => {
                // Said, so a skipped parser check is visible in the test log.
                #[allow(clippy::print_stderr)]
                {
                    eprintln!("systemd-analyze cannot verify here, skipped: {other:?}");
                }
                None
            }
        }
    }

    /// R5-A-1: no renderer writes a value its reader would read differently.
    /// A control character (LF, CR, NUL, tab, DEL, C1) or U+FFFE in the
    /// executable or any pin is an error for the unit, the wrapper and the
    /// plist; so is an executable systemd refuses (a quote, a backslash) or a
    /// relative one. Inverses: spaces, quotes, `%`, `$` and non-ASCII in pins
    /// still render.
    #[test]
    fn a_value_no_service_file_can_hold_is_refused_by_every_renderer() {
        let pin = |value: &str| vec![("WSMP_CONFIG", value.to_string())];
        let ok = pin("/u/c.json");
        for bad in ["\n", "\r", "\0", "\t", "\u{7f}", "\u{85}", "\u{fffe}"] {
            let value = format!("/u/a{bad}b");
            let unit_exec = render_systemd_user_unit(&value, &ok).expect_err("unit exec");
            assert!(
                format!("{unit_exec:#}").contains("nothing was written"),
                "{unit_exec:#}"
            );
            assert!(render_systemd_user_unit("/u/wsmp", &pin(&value)).is_err());
            assert!(render_macos_service_wrapper(&value, &ok).is_err());
            assert!(render_macos_service_wrapper("/u/wsmp", &pin(&value)).is_err());
            assert!(render_launch_agent_plist("l", &value, "/u", "/u/o", "/u/e").is_err());
            assert!(render_launch_agent_plist("l", "/u/w", &value, "/u/o", "/u/e").is_err());
            assert!(render_launch_agent_plist("l", "/u/w", "/u", "/u/o", &value).is_err());
            assert!(systemd_exec_arg(&value).is_err());
            assert!(systemd_environment("WSMP_CONFIG", &value).is_err());
        }
        for bad in ["/u/a\"b", "/u/a'b", "/u/a\\b", "wsmp", "-/u/wsmp"] {
            assert!(render_systemd_user_unit(bad, &ok).is_err(), "{bad}");
        }
        assert!(render_macos_service_wrapper("wsmp", &ok).is_err());
        let odd = "/u/it's a \"b\\c\" 100% $HOME é";
        let unit = render_systemd_user_unit("/u/a b%$é/wsmp", &pin(odd)).expect("unit");
        assert!(
            unit.contains("ExecStart=\"/u/a b%%$é/wsmp\" run\n"),
            "{unit}"
        );
        assert!(render_macos_service_wrapper("/u/a b'c/wsmp", &pin(odd)).is_ok());
        assert!(render_launch_agent_plist("l", odd, odd, odd, odd).is_ok());
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
        let render = || -> Result<Vec<String>> {
            Ok(vec![render_systemd_user_unit(keg.stable(), &bad_pin)?])
        };
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

    /// R5-A-1, whole update (A5-FINAL-SECURITY, A5-PIN): a Homebrew prefix
    /// with a newline in it, or a newline in a pin, is refused before brew
    /// changes the keg, with wsmp's old unit as it was and nothing recorded.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_newline_in_the_prefix_or_a_pin_stops_the_update_before_the_keg_changes() {
        let check = |through: &Through, result: &str, old: &str| {
            assert!(
                result.starts_with("Stopped\n")
                    && result.contains("Refused Some(UnsupportedMethod)")
                    && result.contains("U+000A"),
                "{result}"
            );
            assert!(
                !through.take("brew.log").contains("upgrade"),
                "keg untouched"
            );
            assert_eq!(std::fs::read_to_string(&through.unit).expect("read"), old);
            assert_eq!(through.take("systemctl.log"), "", "no reload");
            assert!(
                crate::update::state::load(&through.path("state/update"))
                    .expect("load")
                    .is_none(),
                "nothing recorded"
            );
        };
        let through = Through::named("r6\nprefix");
        let old = render_systemd_user_unit("/bin/true", &[]).expect("render");
        std::fs::write(&through.unit, &old).expect("write");
        let result = through.update();
        check(&through, &result, &old);

        let through = Through::new();
        let old = through.stable_unit();
        std::fs::write(&through.unit, &old).expect("write");
        let config = through.path("config\nnode.json");
        std::fs::write(&config, "{}").expect("config");
        let result = through.child_with("update", false, &config);
        check(&through, &result, &old);
    }

    /// R5-A-1, the real parser: the unit an update writes passes
    /// `systemd-analyze verify` (which also checks that `ExecStart=`'s program
    /// runs), with no setting ignored; so does one with spaces, `%`, `$`,
    /// quotes, backslashes and non-ASCII in its values. Inverse: the newline
    /// the old serializer wrote inside quotes fails the same check.
    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_reads_the_unit_wsmp_writes() {
        let through = Through::new();
        std::fs::write(&through.unit, through.unit_for("/bin/true")).expect("write");
        assert!(through.update().starts_with("Swapped\n"));
        let Some((ok, text)) = systemd_verify(&through.unit) else {
            return;
        };
        assert!(ok && !text.contains("ignoring"), "{text}");

        let odd = through.path("a b%$é");
        std::fs::create_dir_all(&odd).expect("dir");
        std::fs::copy("/bin/true", odd.join("wsmp")).expect("copy");
        let unit = through.path("odd/wsmp.service");
        std::fs::create_dir_all(unit.parent().expect("parent")).expect("dir");
        let rendered = render_systemd_user_unit(
            odd.join("wsmp").to_str().expect("utf-8"),
            &[
                ("WSMP_CONFIG", "/u/it's a \"b\\c\" 100% $HOME é".to_string()),
                ("PATH", "/usr/bin:/bin".to_string()),
            ],
        )
        .expect("render");
        std::fs::write(&unit, rendered).expect("write");
        let (ok, text) = systemd_verify(&unit).expect("verify");
        assert!(ok && !text.contains("ignoring"), "{text}");

        // What the old serializer wrote for a newline: rejected.
        std::fs::write(
            &unit,
            format!(
                "[Service]\nExecStart=\"{}\nb\" run\nEnvironment=\"WSMP_CONFIG=/u/a\nb\"\n",
                odd.join("wsmp").display()
            ),
        )
        .expect("write");
        let (ok, text) = systemd_verify(&unit).expect("verify");
        assert!(!ok && text.contains("Unbalanced quoting"), "{text}");
    }

    /// A scripted launchd for [`restart_launch_agent`]: its own clock (each
    /// call takes 10 ms; `sleep` moves it), an agent that `bootout` unloads
    /// only after `unload_after` more looks (`print`), a `bootstrap` that
    /// fails while the agent is loaded (as launchd does, "5: Input/output
    /// error") and `bootstrap_failures` more times, and a log of every call:
    /// `ok` for exit 0, `err` for another exit (`print`: 113, not loaded),
    /// `fail` for a call that gave no answer (it could not run, or ran out of
    /// time). `print_fails` scripts that: the looks (counted from 1) that
    /// give no answer (every one with `print_fails_all`), an error or, with
    /// `print_exit`, another exit status.
    struct FakeLaunchd {
        start: std::time::Instant,
        at: std::time::Duration,
        loaded: bool,
        unloading: Option<u32>,
        unload_after: u32,
        bootout_fails: bool,
        bootstrap_failures: u32,
        kickstart_fails: bool,
        prints: u32,
        print_fails: Vec<u32>,
        print_fails_all: bool,
        print_exit: Option<i32>,
        log: Vec<String>,
    }

    impl FakeLaunchd {
        fn new(loaded: bool) -> Self {
            Self {
                start: std::time::Instant::now(),
                at: std::time::Duration::ZERO,
                loaded,
                unloading: None,
                unload_after: 0,
                bootout_fails: false,
                bootstrap_failures: 0,
                kickstart_fails: false,
                prints: 0,
                print_fails: Vec::new(),
                print_fails_all: false,
                print_exit: None,
                log: Vec::new(),
            }
        }

        fn deadline(&self) -> std::time::Instant {
            self.start + FINITE_COMMAND_TIMEOUT
        }

        fn call(&mut self, caller: LaunchAgentCaller) -> Result<()> {
            let deadline = self.deadline();
            restart_launch_agent(self, caller, "gui/501", "gui/501/l", "/u/l.plist", deadline)
        }

        fn restart(&mut self, how: Restart) -> Result<()> {
            self.call(LaunchAgentCaller::Restart(how))
        }

        fn calls(&self) -> Vec<&str> {
            self.log.iter().map(String::as_str).collect()
        }
    }

    impl Launchctl for FakeLaunchd {
        fn run(
            &mut self,
            args: &[&str],
            timeout: std::time::Duration,
        ) -> Result<crate::update::deadman::Exited> {
            assert!(!timeout.is_zero(), "a call with no time left: {args:?}");
            assert!(
                self.now() + timeout <= self.deadline(),
                "past the deadline: {args:?}"
            );
            self.at += std::time::Duration::from_millis(10);
            let exit = |code: i32, text: &str| {
                Ok(crate::update::deadman::Exited {
                    code: Some(code),
                    stdout: String::new(),
                    stderr: text.to_string(),
                })
            };
            let result = match args[0] {
                "print" => {
                    if let Some(left) = self.unloading {
                        if left == 0 {
                            self.loaded = false;
                            self.unloading = None;
                        } else {
                            self.unloading = Some(left - 1);
                        }
                    }
                    self.prints += 1;
                    if self.print_fails_all || self.print_fails.contains(&self.prints) {
                        match self.print_exit {
                            Some(code) => exit(code, "Unexpected error"),
                            None => Err(anyhow::anyhow!(
                                "running `launchctl`: too many commands are running or stuck; try again later"
                            )),
                        }
                    } else if self.loaded {
                        exit(0, "")
                    } else {
                        exit(113, "Bad request.\nCould not find service")
                    }
                }
                "bootout" if self.bootout_fails => exit(1, "Boot-out failed: 1"),
                "bootout" => {
                    self.unloading = Some(self.unload_after);
                    exit(0, "")
                }
                "bootstrap" if self.loaded => exit(5, "Bootstrap failed: 5: Input/output error"),
                "bootstrap" if self.bootstrap_failures > 0 => {
                    self.bootstrap_failures -= 1;
                    exit(5, "Bootstrap failed: 5: Input/output error")
                }
                "bootstrap" => {
                    self.loaded = true;
                    exit(0, "")
                }
                "kickstart" if self.kickstart_fails => exit(1, "kickstart failed"),
                "kickstart" if self.loaded => exit(0, ""),
                "kickstart" => exit(113, "Could not find service"),
                other => panic!("unexpected launchctl {other}"),
            };
            self.log.push(format!(
                "{} {}",
                args[0],
                match &result {
                    Ok(ran) if ran.code == Some(0) => "ok",
                    Ok(_) => "err",
                    Err(_) => "fail",
                }
            ));
            result
        }
        fn now(&self) -> std::time::Instant {
            self.start + self.at
        }
        fn sleep(&mut self, pause: std::time::Duration) {
            self.log.push(format!("sleep {}", pause.as_millis()));
            self.at += pause;
        }
    }

    /// R5-B-2 hardening: `bootout` is asynchronous, so the reload waits until
    /// launchd no longer has the agent before `bootstrap`, which is never
    /// tried while it is loaded; a `bootstrap` that fails is tried again.
    #[test]
    fn a_reload_waits_for_the_unload_and_tries_bootstrap_again() {
        let mut launchd = FakeLaunchd::new(true);
        launchd.unload_after = 3;
        launchd.restart(Restart::Reloaded).expect("restart");
        assert_eq!(
            launchd.calls(),
            [
                "print ok",
                "bootout ok",
                "print ok",
                "sleep 100",
                "print ok",
                "sleep 200",
                "print ok",
                "sleep 400",
                "print err",
                "bootstrap ok",
                "kickstart ok"
            ]
        );

        let mut launchd = FakeLaunchd::new(true);
        launchd.bootstrap_failures = 2;
        launchd.restart(Restart::Reloaded).expect("restart");
        assert_eq!(
            launchd.calls(),
            [
                "print ok",
                "bootout ok",
                "print err",
                "bootstrap err",
                "print err",
                "sleep 100",
                "bootstrap err",
                "print err",
                "sleep 200",
                "bootstrap ok",
                "kickstart ok"
            ]
        );

        // `Loaded`: no reload when loaded; loaded first when not.
        let mut launchd = FakeLaunchd::new(true);
        launchd.restart(Restart::Loaded).expect("restart");
        assert_eq!(launchd.calls(), ["print ok", "kickstart ok"]);
        let mut launchd = FakeLaunchd::new(false);
        launchd.restart(Restart::Loaded).expect("restart");
        assert_eq!(
            launchd.calls(),
            ["print err", "bootstrap ok", "kickstart ok"]
        );
    }

    /// R5-B-2 hardening: when launchd will not load the agent again within
    /// the deadline, or never finishes unloading it, or `bootout` fails with
    /// it still loaded, the restart is an error that names
    /// `wsmp service install`, every call inside the one deadline.
    #[test]
    fn a_reload_that_cannot_finish_says_how_to_load_the_relay_again() {
        let mut launchd = FakeLaunchd::new(true);
        launchd.bootstrap_failures = u32::MAX;
        let error = launchd.restart(Restart::Reloaded).expect_err("never loads");
        let text = format!("{error:#}");
        assert!(
            text.contains("is not running") && text.contains("wsmp service install"),
            "{text}"
        );
        assert!(text.contains("Bootstrap failed: 5"), "{text}");
        assert!(launchd.now() <= launchd.deadline());
        assert!(!launchd.calls().contains(&"kickstart ok"));
        assert!(
            launchd
                .calls()
                .iter()
                .filter(|call| **call == "bootstrap err")
                .count()
                > 10
        );

        let mut launchd = FakeLaunchd::new(true);
        launchd.unload_after = u32::MAX;
        let error = launchd
            .restart(Restart::Reloaded)
            .expect_err("never unloads");
        assert!(
            format!("{error:#}").contains("wsmp service install"),
            "{error:#}"
        );
        assert!(launchd.now() <= launchd.deadline());
        assert!(!launchd.log.iter().any(|call| call.starts_with("bootstrap")));

        let mut launchd = FakeLaunchd::new(true);
        launchd.bootout_fails = true;
        let error = launchd
            .restart(Restart::Reloaded)
            .expect_err("bootout fails");
        assert!(
            format!("{error:#}").contains("wsmp service install"),
            "{error:#}"
        );
        assert_eq!(launchd.calls(), ["print ok", "bootout err", "print ok"]);
    }

    /// `wsmp service install` loads the plist through the same hardened
    /// sequence: a first install (nothing loaded) bootstraps and kickstarts as
    /// before; a reinstall over a loaded agent boots it out, waits until it is
    /// unloaded, then bootstraps (tried again) and kickstarts. Its errors say
    /// to run install again or bootstrap by hand, never to run install as if
    /// it were something else; a failed kickstart stays best effort.
    #[test]
    fn install_loads_the_agent_through_the_same_wait_and_retry() {
        let mut launchd = FakeLaunchd::new(false);
        launchd
            .call(LaunchAgentCaller::Install)
            .expect("first install");
        assert_eq!(
            launchd.calls(),
            ["print err", "bootstrap ok", "kickstart ok"]
        );

        let mut launchd = FakeLaunchd::new(true);
        launchd.unload_after = 1;
        launchd.bootstrap_failures = 1;
        launchd.call(LaunchAgentCaller::Install).expect("reinstall");
        assert_eq!(
            launchd.calls(),
            [
                "print ok",
                "bootout ok",
                "print ok",
                "sleep 100",
                "print err",
                "bootstrap err",
                "print err",
                "sleep 100",
                "bootstrap ok",
                "kickstart ok"
            ]
        );

        let mut launchd = FakeLaunchd::new(true);
        launchd.bootstrap_failures = u32::MAX;
        let error = launchd
            .call(LaunchAgentCaller::Install)
            .expect_err("never loads");
        let text = format!("{error:#}");
        assert!(
            text.contains("run `wsmp service install` again")
                && text.contains("load it by hand: `launchctl bootstrap gui/501 '/u/l.plist'`")
                && !text.contains("to load the relay service again"),
            "{text}"
        );
        assert!(launchd.now() <= launchd.deadline());

        let mut launchd = FakeLaunchd::new(false);
        launchd.kickstart_fails = true;
        launchd
            .call(LaunchAgentCaller::Install)
            .expect("kickstart is best effort");
        assert!(
            launchd.restart(Restart::Loaded).is_err(),
            "but not for a restart"
        );
    }

    /// Both callers that reload ([`restart_launch_agent`]).
    const RELOADERS: [LaunchAgentCaller; 2] = [
        LaunchAgentCaller::Restart(Restart::Reloaded),
        LaunchAgentCaller::Install,
    ];

    /// R6-B-1 / R6-A-3 (ported from `r6_b_query_failure_must_not_bypass_reload`
    /// and `r6a_initial_query_error_must_not_skip_reload`): the first look
    /// gives no answer while the old agent is loaded. That is not "not
    /// loaded": it is asked again, and the reload boots the old agent out,
    /// waits for launchd to say it is gone, and only then bootstraps. Both
    /// callers.
    #[test]
    fn a_first_look_without_an_answer_is_asked_again_never_taken_as_unloaded() {
        for caller in RELOADERS {
            for exit in [None, Some(5)] {
                let mut launchd = FakeLaunchd::new(true);
                launchd.print_fails = vec![1];
                launchd.print_exit = exit;
                launchd.call(caller).expect("reload");
                let first = if exit.is_some() {
                    "print err"
                } else {
                    "print fail"
                };
                assert_eq!(
                    launchd.calls(),
                    [
                        first,
                        "sleep 100",
                        "print ok",
                        "bootout ok",
                        "print err",
                        "bootstrap ok",
                        "kickstart ok"
                    ],
                    "{caller:?} {exit:?}"
                );
            }

            // No answer until the deadline: an error that names the way
            // back, and nothing was booted out or bootstrapped.
            let mut launchd = FakeLaunchd::new(true);
            launchd.print_fails_all = true;
            let error = launchd.call(caller).expect_err("no answer");
            let text = format!("{error:#}");
            assert!(
                text.contains("launchd did not say whether it has the relay service")
                    && text.contains("wsmp service install")
                    && text.contains("too many commands"),
                "{caller:?}: {text}"
            );
            assert!(launchd.now() <= launchd.deadline());
            assert!(
                launchd
                    .calls()
                    .iter()
                    .all(|call| call.starts_with("print") || call.starts_with("sleep")),
                "{caller:?}: {:?}",
                launchd.calls()
            );
            assert!(launchd.loaded, "the old agent stays loaded");
        }
    }

    /// R6-A-3 (ported from `r6a_bootout_query_error_must_not_report_success`):
    /// after `bootout`, a look that gives no answer while launchd is still
    /// unloading the old agent does not end the wait: a reload whose old
    /// agent never unloads is an error, not a success that kickstarts the
    /// old definition. When it does unload, `bootstrap` runs only after
    /// launchd said so. Both callers.
    #[test]
    fn a_look_without_an_answer_while_unloading_does_not_end_the_wait() {
        for caller in RELOADERS {
            let mut launchd = FakeLaunchd::new(true);
            launchd.unload_after = u32::MAX;
            launchd.print_fails = vec![2];
            let deadline = launchd.start + std::time::Duration::from_secs(2);
            let error = restart_launch_agent(
                &mut launchd,
                caller,
                "gui/501",
                "gui/501/l",
                "/u/l.plist",
                deadline,
            )
            .expect_err("never unloads");
            let text = format!("{error:#}");
            assert!(
                text.contains("still unloading") && text.contains("wsmp service install"),
                "{caller:?}: {text}"
            );
            assert!(
                !launchd
                    .log
                    .iter()
                    .any(|call| call.starts_with("bootstrap") || call.starts_with("kickstart")),
                "{caller:?}: {:?}",
                launchd.calls()
            );

            let mut launchd = FakeLaunchd::new(true);
            launchd.unload_after = 1;
            launchd.print_fails = vec![2];
            launchd.call(caller).expect("reload");
            assert_eq!(
                launchd.calls(),
                [
                    "print ok",
                    "bootout ok",
                    "print fail",
                    "sleep 100",
                    "print err",
                    "bootstrap ok",
                    "kickstart ok"
                ],
                "{caller:?}"
            );
            assert!(launchd.loaded);

            // A failed bootout followed by a look with no answer: asked
            // again; the old agent is still there, so it is an error.
            let mut launchd = FakeLaunchd::new(true);
            launchd.bootout_fails = true;
            launchd.print_fails = vec![2];
            let error = launchd.call(caller).expect_err("bootout failed");
            assert!(
                format!("{error:#}").contains("still runs the definition launchd loaded"),
                "{error:#}"
            );
            assert_eq!(
                launchd.calls(),
                [
                    "print ok",
                    "bootout err",
                    "print fail",
                    "sleep 100",
                    "print ok"
                ]
            );
        }
    }

    /// R6-B-3 / R6-A-4: the `launchctl bootstrap` install prints for loading
    /// the plist by hand gives the shell the plist's path as one argument,
    /// whatever a home directory may hold (a space, `'`, `$`, a backtick).
    #[cfg(unix)]
    #[test]
    fn the_bootstrap_by_hand_names_the_plist_as_one_argument() {
        for file in [
            "/Users/Jane Doe/Library/LaunchAgents/com.flycockpit.wsmp.plist",
            "/Users/o'neil/$HOME/`id`/a b'c$(x).plist",
            "/u/''/$$/\\/l.plist",
        ] {
            let mut launchd = FakeLaunchd::new(false);
            launchd.bootstrap_failures = u32::MAX;
            let deadline = launchd.deadline();
            let error = restart_launch_agent(
                &mut launchd,
                LaunchAgentCaller::Install,
                "gui/501",
                "gui/501/l",
                file,
                deadline,
            )
            .expect_err("never loads");
            // The outermost message, which ends with the hint.
            let text = format!("{error}");
            let start = text.find("load it by hand: `").expect("hint") + "load it by hand: `".len();
            let command = text[start..]
                .strip_suffix('`')
                .unwrap_or_else(|| panic!("the hint ends the message: {text}"));
            let out = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(format!(
                    "launchctl() {{ printf '%s\\0' \"$@\"; }}; {command}"
                ))
                .output()
                .expect("sh");
            assert!(out.status.success(), "{command}");
            assert_eq!(
                out.stdout,
                format!("bootstrap\0gui/501\0{file}\0").into_bytes(),
                "{command}"
            );
        }
    }

    /// `plist` saved again as `plutil -convert`, `defaults` or Xcode save
    /// it: keys sorted (`KeepAlive` first, so it no longer starts as wsmp's
    /// renderings do), XML or binary (`format`: `FMT_XML`, `FMT_BINARY`).
    /// Python's `plistlib`; `None` when there is no `python3`.
    #[cfg(unix)]
    fn resaved_plist(plist: &[u8], format: &str) -> Option<Vec<u8>> {
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
    fn label_reader(path: &Path) -> Option<String> {
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

    /// A3-DIRSYNC: a directory sync that fails after the rename leaves a
    /// whole new unit and an error; the next update syncs the directory and
    /// reloads before it reports success.
    #[cfg(target_os = "linux")]
    #[test]
    fn ensure_stable_executable_finishes_a_move_whose_directory_sync_failed() {
        let through = Through::new();
        std::fs::write(
            &through.unit,
            through.unit_for(
                &through
                    .path("Cellar/wsmp/0.4.2/bin/wsmp")
                    .display()
                    .to_string(),
            ),
        )
        .expect("write");
        let first = through.ensure(true);
        assert!(
            first.starts_with("error:") && first.contains("syncing"),
            "{first}"
        );
        assert!(through.path("dirsync.failed").exists(), "the fault fired");
        assert_eq!(
            std::fs::read_to_string(&through.unit).expect("read"),
            through.stable_unit()
        );
        assert_eq!(
            through.take("systemctl.log"),
            "",
            "not reloaded after a failed sync"
        );
        through.take("dirsync.log");
        let second = through.ensure(true);
        assert_eq!(second, "ok");
        let units = through.unit.parent().expect("dir").display().to_string();
        assert!(
            through
                .take("dirsync.log")
                .lines()
                .any(|line| line == units),
            "the retry synced the unit's directory"
        );
        assert_eq!(through.take("systemctl.log"), "--user daemon-reload\n");
    }

    /// Through the production function, every unit a review found accepted
    /// or refused (A4-ADV; A3 short write, FIFO, dangling link): wsmp's unit
    /// in any shape is written again as install writes it; what is broken
    /// or written by hand stops the update untouched and unreloaded; no unit
    /// and a healthy unit pass as they are.
    #[cfg(target_os = "linux")]
    #[test]
    fn ensure_stable_executable_writes_wsmps_unit_again_and_refuses_a_broken_one() {
        use std::os::unix::fs::{MetadataExt, symlink};
        let through = Through::new();
        let healthy = through.stable_unit();
        assert_eq!(through.ensure(false), "ok", "no unit");
        assert_eq!(through.take("systemctl.log"), "", "no unit, no reload");
        assert!(std::fs::symlink_metadata(&through.unit).is_err());
        // Healthy, and hard-linked: nothing written (same inode), reloaded.
        std::fs::write(&through.unit, &healthy).expect("write");
        set_mode(&through.unit, SERVICE_FILE_MODE);
        let other = through.path("hardlink.service");
        std::fs::hard_link(&through.unit, &other).expect("hard link");
        assert_eq!(through.ensure(false), "ok", "healthy");
        assert_eq!(through.take("systemctl.log"), "--user daemon-reload\n");
        assert_eq!(
            std::fs::metadata(&through.unit).expect("meta").ino(),
            std::fs::metadata(&other).expect("meta").ino()
        );
        std::fs::remove_file(&other).expect("rm");
        // wsmp's unit, not as install writes it now: written again.
        let alias = through.path("pinned-wsmp");
        symlink(through.path("Cellar/wsmp/0.4.2/bin/wsmp"), &alias).expect("alias");
        for (state, text, mode) in [
            (
                "--version",
                healthy.replace(" run\n", " --version\n"),
                0o644,
            ),
            (
                "an alias",
                through.unit_for(&alias.display().to_string()),
                0o644,
            ),
            ("trailing text", format!("{healthy}garbage\n"), 0o644),
            (
                "cut short",
                healthy[..healthy.len() - 10].to_string(),
                0o644,
            ),
            ("mode 0666", healthy.clone(), 0o666),
        ] {
            std::fs::write(&through.unit, &text).expect("write");
            set_mode(&through.unit, mode);
            assert_eq!(through.ensure(false), "ok", "{state}");
            assert_eq!(
                std::fs::read_to_string(&through.unit).expect("read"),
                healthy,
                "{state}"
            );
            assert_eq!(mode_of(&through.unit), SERVICE_FILE_MODE, "{state}");
            assert_eq!(
                through.take("systemctl.log"),
                "--user daemon-reload\n",
                "{state}"
            );
        }
        // Through a link to a file elsewhere: its target is written, the link
        // stays.
        std::fs::remove_file(&through.unit).expect("rm");
        let elsewhere = through.path("elsewhere.service");
        std::fs::write(&elsewhere, healthy.replace(" run\n", " --version\n")).expect("w");
        symlink(&elsewhere, &through.unit).expect("link");
        assert_eq!(through.ensure(false), "ok", "a link");
        assert!(
            std::fs::symlink_metadata(&through.unit)
                .expect("meta")
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read_to_string(&elsewhere).expect("read"), healthy);
        through.take("systemctl.log");
        std::fs::remove_file(&through.unit).expect("rm");
        let refused = |needle: &str| {
            let bytes = bytes_of(&through.unit);
            let started = std::time::Instant::now();
            let result = through.ensure(false);
            assert!(
                started.elapsed() < std::time::Duration::from_secs(60),
                "{needle}"
            );
            assert!(
                result.starts_with("error:") && result.contains(needle),
                "{needle}: {result}"
            );
            assert_eq!(through.take("systemctl.log"), "", "{needle}: reloaded");
            assert_eq!(bytes_of(&through.unit), bytes, "{needle}: changed");
        };
        std::fs::write(
            &through.unit,
            format!(
                "[Service]\nExecStart={} run\n",
                through.path("Cellar/wsmp/0.4.2/bin/wsmp").display()
            ),
        )
        .expect("write");
        refused("not written by `wsmp service install`");
        std::fs::write(
            &through.unit,
            "[Service]\nExecStart=/usr/local/bin/wsmp run\n",
        )
        .expect("write");
        refused("not written by `wsmp service install`");
        std::fs::remove_file(&through.unit).expect("rm");
        symlink(through.path("gone.service"), &through.unit).expect("link");
        refused("is a link to nothing");
        std::fs::remove_file(&through.unit).expect("rm");
        symlink(&through.unit, &through.unit).expect("loop");
        refused("could not be resolved");
        std::fs::remove_file(&through.unit).expect("rm");
        std::fs::create_dir(&through.unit).expect("dir");
        refused("not a regular file");
        std::fs::remove_dir(&through.unit).expect("rm");
        nix::unistd::mkfifo(&through.unit, nix::sys::stat::Mode::S_IRWXU).expect("fifo");
        refused("not a regular file");
        std::fs::remove_file(&through.unit).expect("rm");
        std::fs::write(
            &through.unit,
            through.unit_for(
                &through
                    .path("Cellar/wsmp/0.4.2/bin/wsmp")
                    .display()
                    .to_string(),
            ),
        )
        .expect("write");
        std::fs::remove_file(through.path("opt/wsmp")).expect("unlink");
        refused("`brew link wsmp`");
    }

    /// The whole Homebrew update through its production code (B4-FILESYSTEM,
    /// A4-ADV, B4-RUNNABILITY): the service is written onto the stable path
    /// before the keg changes, the upgrade moves `opt`, and the probe of that
    /// same path is what lets the update record the new build. An alias of
    /// the old keg does not survive, and a target that cannot run stops the
    /// update before anything is recorded.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_homebrew_update_moves_the_service_onto_the_path_it_probes() {
        // An alias that resolves today to the running keg, and that keg made
        // unrunnable (mode 0001): neither matters, the service is written
        // onto `opt`, which after the upgrade runs 0.4.3.
        let through = Through::new();
        let alias = through.path("pinned-wsmp");
        std::os::unix::fs::symlink(through.path("Cellar/wsmp/0.4.2/bin/wsmp"), &alias)
            .expect("alias");
        std::fs::write(
            &through.unit,
            through.unit_for(&alias.display().to_string()),
        )
        .expect("write");
        set_mode(&through.path("Cellar/wsmp/0.4.2/bin/wsmp"), 0o001);
        let result = through.update();
        assert!(result.starts_with("Swapped\n"), "{result}");
        assert_eq!(
            std::fs::read_to_string(&through.unit).expect("read"),
            through.stable_unit()
        );
        assert_eq!(through.take("systemctl.log"), "--user daemon-reload\n");
        assert_eq!(
            through.unit_runs(),
            (through.stable.clone(), "wsmp 0.4.3".to_string())
        );
        assert!(through.take("brew.log").contains("upgrade\n"));

        // A unit edited to `--version`: written back to `run` before brew.
        let through = Through::new();
        std::fs::write(
            &through.unit,
            through.stable_unit().replace(" run\n", " --version\n"),
        )
        .expect("write");
        assert!(through.update().starts_with("Swapped\n"));
        assert_eq!(
            std::fs::read_to_string(&through.unit).expect("read"),
            through.stable_unit()
        );

        // The new keg's binary cannot run (mode 0001): the probe of the
        // service's own path fails, nothing is recorded, no restart.
        let through = Through::new();
        std::fs::write(&through.unit, through.stable_unit()).expect("write");
        std::fs::write(through.path("upgrade-mode"), "0001").expect("mode");
        let result = through.update();
        assert!(result.starts_with("Stopped\n"), "{result}");
        assert!(
            result.contains("Failed Some(VersionMismatch)") && result.contains(&through.stable),
            "{result}"
        );
        assert!(
            crate::update::state::load(&through.path("state/update"))
                .expect("load")
                .is_none(),
            "nothing recorded"
        );

        // A unit by hand on a Cellar path: refused before brew changes anything.
        let through = Through::new();
        let by_hand = format!(
            "[Service]\nExecStart={} run\n",
            through.path("Cellar/wsmp/0.4.2/bin/wsmp").display()
        );
        std::fs::write(&through.unit, &by_hand).expect("write");
        let result = through.update();
        assert!(
            result.starts_with("Stopped\n") && result.contains("Refused Some(UnsupportedMethod)"),
            "{result}"
        );
        assert!(
            !through.take("brew.log").contains("upgrade"),
            "the keg is untouched"
        );
        assert_eq!(
            std::fs::read_to_string(&through.unit).expect("read"),
            by_hand
        );

        // Inverses: a healthy unit is not written (same inode), no unit is
        // not created; both update.
        use std::os::unix::fs::MetadataExt;
        let through = Through::new();
        std::fs::write(&through.unit, through.stable_unit()).expect("write");
        set_mode(&through.unit, SERVICE_FILE_MODE);
        let inode = std::fs::metadata(&through.unit).expect("meta").ino();
        assert!(through.update().starts_with("Swapped\n"));
        assert_eq!(std::fs::metadata(&through.unit).expect("meta").ino(), inode);
        let through = Through::new();
        assert!(through.update().starts_with("Swapped\n"));
        assert!(std::fs::symlink_metadata(&through.unit).is_err());
        assert_eq!(through.take("systemctl.log"), "");
    }

    /// macOS's pair of service files, for an in-process Homebrew update on
    /// a [`Through`] prefix ([`homebrew_update_with_pair`]): the wrapper and
    /// the plist in the prefix (`stable` is `<prefix>/opt/wsmp/bin/wsmp`),
    /// rendered as `wsmp service install` writes them, a plist's label read
    /// by [`label_reader`]. The same service step `ensure_stable_executable`
    /// takes on macOS, with these paths.
    #[cfg(target_os = "linux")]
    fn pair_in_prefix(stable: &Path) -> Result<()> {
        let prefix = stable.ancestors().nth(4).context("no prefix")?;
        let wrapper = prefix.join("wsmp-service-run.sh");
        let plist = prefix.join("com.flycockpit.wsmp.plist");
        stable_service_files(
            &[
                (&wrapper, ServiceKind::LaunchdWrapper),
                (&plist, ServiceKind::LaunchdPlist),
            ],
            stable,
            || Ok(vec![pair_wrapper(stable)?, pair_plist(prefix)?]),
            &publish_file,
            no_reload,
            &label_reader,
        )
    }

    /// The wrapper [`pair_in_prefix`] writes.
    #[cfg(target_os = "linux")]
    fn pair_wrapper(executable: &Path) -> Result<String> {
        render_macos_service_wrapper(path_text("the executable", executable)?, &pins())
    }

    /// The plist [`pair_in_prefix`] writes.
    #[cfg(target_os = "linux")]
    fn pair_plist(prefix: &Path) -> Result<String> {
        render_launch_agent_plist(
            MACOS_LABEL,
            path_text("the wrapper", &prefix.join("wsmp-service-run.sh"))?,
            "/Users/u",
            "/Users/u/Library/Logs/ws-model-proxy/relay.out.log",
            "/Users/u/Library/Logs/ws-model-proxy/relay.err.log",
        )
    }

    /// The whole Homebrew update ([`crate::update::agent::homebrew`]) on
    /// `through`'s prefix, in this process, its service step
    /// [`pair_in_prefix`]: `Swapped` or `Stopped`, then the progress.
    #[cfg(target_os = "linux")]
    fn homebrew_update_with_pair(through: &Through) -> String {
        use crate::protocol::frames::{UpdatePhase, UpdateReason};
        use crate::update::flow::{Machine, Progress, Request};
        struct Log(String);
        impl Progress for Log {
            fn report(
                &mut self,
                phase: UpdatePhase,
                reason: Option<UpdateReason>,
                detail: Option<String>,
            ) {
                self.0.push_str(&format!(
                    "{phase:?} {reason:?} {}\n",
                    detail.unwrap_or_default().replace('\n', " ")
                ));
            }
        }
        let machine = Machine {
            state_dir: through.path("state"),
            live: through.path("Cellar/wsmp/0.4.2/bin/wsmp"),
            target: "test-target".into(),
            scheduler: None,
            tar: crate::update::install::system_tar(),
            current_version: "0.4.2".into(),
            before_swap: None,
            proceed: None,
            stable_service: pair_in_prefix,
        };
        let request = Request {
            update_id: "u-1".into(),
            version: "0.4.3".into(),
            artifact_url: String::new(),
            sha256: String::new(),
            signature: None,
            rollback_after_secs: 90,
            origin: crate::update::state::Origin::Cli,
        };
        let mut log = Log(String::new());
        let ended = crate::update::agent::homebrew(&machine, &request, &mut log);
        format!("{ended:?}\n{}", log.0)
    }

    /// Owner, 2026-10-30, through the Homebrew update itself: any service
    /// file not written by `wsmp service install` stops the update before
    /// the keg changes (no `brew upgrade`), every file byte for byte as it
    /// was, nothing reloaded or recorded, for the one reason that it is not
    /// wsmp's: a systemd unit (the real `ensure_stable_executable`, in a
    /// child), a wrapper or a plist (XML or binary, another label or none),
    /// each on a `Cellar` path, on the stable path, or spelled so no text
    /// search finds the `Cellar` path (systemd's `\x43ellar`: F-FA-2;
    /// CDATA and a binary string with a literal `&#108;`: B8-CDATA-INVERSE).
    /// Inverses: wsmp's files (even a plist saved again in binary, on an
    /// old `Cellar` path) are written again and the update installs; no
    /// service installs too.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_homebrew_update_refuses_any_service_file_by_hand() {
        let refused =
            |through: &Through, result: &str, files: &[(&Path, Option<Vec<u8>>)], case: &str| {
                assert!(
                    result.starts_with("Stopped\n")
                        && result.contains("Refused Some(UnsupportedMethod)")
                        && result.contains("was not written by `wsmp service install`")
                        && result.contains("Run `wsmp service install`")
                        && result.contains("update by hand"),
                    "{case}: {result}"
                );
                assert!(
                    !through.take("brew.log").contains("upgrade"),
                    "{case}: the keg is untouched"
                );
                for (path, before) in files {
                    assert_eq!(
                        &bytes_of(path),
                        before,
                        "{case}: `{}` changed",
                        path.display()
                    );
                }
                assert_eq!(through.take("systemctl.log"), "", "{case}: reloaded");
                assert!(
                    crate::update::state::load(&through.path("state/update"))
                        .expect("load")
                        .is_none(),
                    "{case}: recorded"
                );
            };

        // Units, through the production service step.
        let old = |through: &Through| {
            through
                .path("Cellar/wsmp/0.4.2/bin/wsmp")
                .display()
                .to_string()
        };
        type Unit = fn(&Through) -> String;
        let units: [(&str, Unit); 4] = [
            ("unit, another program", |_| {
                "[Service]\nExecStart=/usr/local/bin/wsmp run\n".to_string()
            }),
            ("unit, Cellar", |t| {
                format!(
                    "[Service]\nExecStart={} run\n",
                    t.path("Cellar/wsmp/0.4.2/bin/wsmp").display()
                )
            }),
            ("unit, stable", |t| {
                format!("[Service]\nExecStart={} run\n", t.stable)
            }),
            ("unit, \\x43ellar", |t| {
                format!(
                    "[Service]\nExecStart={} run\n",
                    t.path("Cellar/wsmp/0.4.2/bin/wsmp")
                        .display()
                        .to_string()
                        .replace("/Cellar/", "/\\x43ellar/")
                )
            }),
        ];
        for (case, text) in units {
            let through = Through::new();
            let text = text(&through);
            assert_eq!(text.contains("Cellar"), case == "unit, Cellar", "{case}");
            std::fs::write(&through.unit, &text).expect("write");
            let result = through.update();
            refused(
                &through,
                &result,
                &[(&through.unit, Some(text.into_bytes()))],
                case,
            );
        }

        // macOS's pair, through the same update in this process.
        let pair = |through: &Through| {
            (
                through.path("wsmp-service-run.sh"),
                through.path("com.flycockpit.wsmp.plist"),
            )
        };
        let check_pair = |case: &str, wrapper_bytes: Option<&[u8]>, plist_bytes: &[u8]| {
            let through = Through::new();
            let (wrapper, plist) = pair(&through);
            if let Some(bytes) = wrapper_bytes {
                std::fs::write(&wrapper, bytes).expect("wrapper");
                set_mode(&wrapper, PRIVATE_SCRIPT_MODE);
            }
            std::fs::write(&plist, plist_bytes).expect("plist");
            let before = [
                (wrapper.as_path(), bytes_of(&wrapper)),
                (plist.as_path(), bytes_of(&plist)),
            ];
            let result = homebrew_update_with_pair(&through);
            refused(&through, &result, &before, case);
        };
        let probe = Through::new();
        let stable = PathBuf::from(&probe.stable);
        let prefix = probe.dir.path();
        let ours = pair_plist(prefix).expect("plist");
        let healthy_wrapper = pair_wrapper(&stable).expect("wrapper");
        let wrapper_name = prefix.join("wsmp-service-run.sh").display().to_string();
        let cellar = old(&probe);
        let theirs = ours.replace(MACOS_LABEL, "com.example.relay");
        let runs = |program: &str| theirs.replace(&wrapper_name, program);
        // Wrappers by hand beside wsmp's plist.
        for (case, program) in [
            ("wrapper, Cellar", &cellar),
            ("wrapper, stable", &probe.stable),
        ] {
            let wrapper = format!("#!/bin/sh\nexec '{program}' run\n");
            check_pair(case, Some(wrapper.as_bytes()), ours.as_bytes());
        }
        // Plists by hand beside wsmp's wrapper, and beside none.
        let mut plists: Vec<(String, Vec<u8>)> = vec![
            ("XML, Cellar".into(), runs(&cellar).into_bytes()),
            ("XML, stable".into(), runs(&probe.stable).into_bytes()),
            (
                "XML, CDATA with a literal reference".into(),
                runs("<![CDATA[/opt/x/Cel&#108;ar/wsmp/0.4.2/bin/wsmp]]>").into_bytes(),
            ),
            (
                "XML, no label".into(),
                b"<?xml version=\"1.0\"?><plist><dict/></plist>".to_vec(),
            ),
        ];
        match resaved_plist(theirs.as_bytes(), "FMT_BINARY") {
            Some(_) => {
                for (case, program) in [
                    ("binary, Cellar", cellar.clone()),
                    ("binary, stable", probe.stable.clone()),
                    (
                        "binary, a literal reference",
                        "/opt/x/Cel&#108;ar/wsmp/0.4.2/bin/wsmp".into(),
                    ),
                    (
                        "binary, UTF-16 Cellar",
                        cellar.replace("/Cellar/", "/\u{e9}/../Cellar/"),
                    ),
                ] {
                    let bytes =
                        resaved_plist(runs(&program).as_bytes(), "FMT_BINARY").expect("save");
                    plists.push((case.into(), bytes));
                }
            }
            None => {
                #[allow(clippy::print_stderr)]
                {
                    eprintln!("skipped: no python3 to save a binary plist");
                }
            }
        }
        for (case, bytes) in &plists {
            check_pair(
                &format!("{case}, wsmp's wrapper"),
                Some(healthy_wrapper.as_bytes()),
                bytes,
            );
            check_pair(&format!("{case}, no wrapper"), None, bytes);
        }

        // Inverses. wsmp's pair on an old Cellar path (its plist saved again
        // in binary when python3 is there): written again, then installed.
        let through = Through::new();
        let (wrapper, plist) = pair(&through);
        let old_wrapper = pair_wrapper(Path::new(&old(&through))).expect("wrapper");
        std::fs::write(&wrapper, &old_wrapper).expect("wrapper");
        let wsmps_plist = pair_plist(through.dir.path()).expect("plist");
        let saved = resaved_plist(wsmps_plist.as_bytes(), "FMT_BINARY")
            .unwrap_or_else(|| wsmps_plist.clone().into_bytes());
        std::fs::write(&plist, &saved).expect("plist");
        let result = homebrew_update_with_pair(&through);
        assert!(result.starts_with("Swapped\n"), "{result}");
        assert!(through.take("brew.log").contains("upgrade\n"));
        assert_eq!(
            std::fs::read_to_string(&wrapper).expect("wrapper"),
            pair_wrapper(Path::new(&through.stable)).expect("wrapper")
        );
        assert_eq!(std::fs::read_to_string(&plist).expect("plist"), wsmps_plist);
        // No service: installed, nothing written.
        let through = Through::new();
        let (wrapper, plist) = pair(&through);
        let result = homebrew_update_with_pair(&through);
        assert!(result.starts_with("Swapped\n"), "{result}");
        assert!(bytes_of(&wrapper).is_none() && bytes_of(&plist).is_none());
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

    #[test]
    fn windows_task_quotes_arguments_as_windows_reads_them() {
        use windows_task::quote_arg;
        assert_eq!(quote_arg(r"C:\Users\me\wsmp.exe"), r"C:\Users\me\wsmp.exe");
        assert_eq!(
            quote_arg(r"C:\Program Files\wsmp\wsmp.exe"),
            r#""C:\Program Files\wsmp\wsmp.exe""#
        );
        // A trailing backslash must not escape the closing quote.
        assert_eq!(quote_arg(r"C:\my state\"), r#""C:\my state\\""#);
        assert_eq!(quote_arg(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(quote_arg(""), r#""""#);
    }

    #[test]
    fn windows_task_runs_the_relay_headless_with_pinned_paths() {
        let arguments = windows_task::arguments(
            r"C:\Users\Jo Doe\.cargo\bin\wsmp.exe",
            r"C:\Users\Jo Doe\.config\ws-model-proxy\config.json",
            r"C:\Users\Jo Doe\AppData\Local\ws-model-proxy",
            r"C:\Users\Jo Doe\AppData\Local\ws-model-proxy\logs\relay.log",
        );
        assert!(
            arguments
                .starts_with(r#"--headless "C:\Users\Jo Doe\.cargo\bin\wsmp.exe" run --service "#)
        );
        assert!(
            arguments.contains(r#"--state-dir "C:\Users\Jo Doe\AppData\Local\ws-model-proxy""#)
        );
        let xml = windows_task::render_xml("S-1-5-21-1-2-3-1001", &arguments, r"C:\Users\Jo & Doe");
        assert!(xml.contains("<UserId>S-1-5-21-1-2-3-1001</UserId>"));
        assert_eq!(xml.matches("<UserId>").count(), 2, "trigger and principal");
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains(r"<Command>%SystemRoot%\System32\conhost.exe</Command>"));
        assert!(xml.contains("<Arguments>--headless &quot;C:\\Users\\Jo Doe"));
        assert!(xml.contains(r"<WorkingDirectory>C:\Users\Jo &amp; Doe</WorkingDirectory>"));
        // No secret or environment ever goes in.
        assert!(!xml.contains("WSMP_"));
        let bytes = windows_task::utf16_bytes("<a/>");
        assert_eq!(&bytes[..4], &[0xFF, 0xFE, b'<', 0]);
    }

    #[test]
    fn windows_task_names_are_per_user_and_safe() {
        assert_eq!(windows_task::task_name("jo"), "wsmp-relay-jo");
        assert_eq!(windows_task::task_name(r"Jo Doe\x"), "wsmp-relay-Jo_Doe_x");
        assert_eq!(windows_task::last_lines("a\nb\nc\n", 2), ["b", "c"]);
        assert_eq!(windows_task::last_lines("a\n", 5), ["a"]);
    }

    #[test]
    fn systemd_unit_quotes_special_paths_and_pins_no_secret() {
        let unit = render_systemd_user_unit(
            "/opt/ws model/wsmp",
            &[
                (
                    "WSMP_CONFIG",
                    "/home/user/.config/ws-model-proxy/config.json".to_string(),
                ),
                ("WSMP_STATE_DIR", "/srv/wsmp state/100%".to_string()),
                ("PATH", "/home/user/.local/bin:/usr/bin".to_string()),
            ],
        )
        .expect("render");
        assert!(unit.contains("ExecStart=\"/opt/ws model/wsmp\" run"));
        assert!(!unit.contains("EnvironmentFile"));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains(&format!(
            "RestartPreventExitStatus={} {}\n",
            crate::exit::ExitCode::CredentialRejected as i32,
            crate::exit::ExitCode::RelayProtocolMismatch as i32
        )));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(
            unit.contains(
                "Environment=WSMP_CONFIG=/home/user/.config/ws-model-proxy/config.json\n"
            )
        );
        assert!(unit.contains("Environment=\"WSMP_STATE_DIR=/srv/wsmp state/100%%\"\n"));
        assert!(unit.contains("Environment=PATH=/home/user/.local/bin:/usr/bin\n"));
        assert!(unit.contains(&format!(
            "Environment={}=1\n",
            crate::daemon::STOP_ON_REJECTED_CREDENTIAL_ENV
        )));
        assert!(unit.contains(&format!(
            "Environment={}=1\n",
            crate::daemon::STOP_ON_PROTOCOL_MISMATCH_ENV
        )));
        // Only the pinned paths and the stop markers: no token or header variables.
        assert_eq!(unit.matches("Environment=").count(), 5);
    }

    #[cfg(unix)]
    #[test]
    fn service_path_keeps_only_absolute_usable_directories_once() {
        let keep = |dir: &Path| dir != Path::new("/tmp/open");
        assert_eq!(
            service_path(
                "/usr/bin::relative/bin:./bin:/tmp/open:/usr/bin:/home/me/.local/bin:",
                keep
            )
            .as_deref(),
            Some("/usr/bin:/home/me/.local/bin")
        );
        assert_eq!(service_path("", keep), None);
        assert_eq!(service_path(":relative", keep), None);
    }

    #[cfg(unix)]
    #[test]
    fn service_path_directories_must_exist_and_not_be_world_writable() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().expect("tempdir");
        let private = root.path().join("private");
        let open = root.path().join("open");
        fs::create_dir(&private).expect("private");
        fs::create_dir(&open).expect("open");
        fs::set_permissions(&private, fs::Permissions::from_mode(0o755)).expect("chmod");
        fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).expect("chmod");
        assert!(usable_service_path_dir(&private));
        assert!(!usable_service_path_dir(&open));
        assert!(!usable_service_path_dir(&root.path().join("missing")));
    }

    /// R6-B-2 / R6-A-1: each place in a unit has its own rule for `$`:
    /// doubled in an `ExecStart=` argument (systemd expands `${NAME}` and
    /// `$NAME` there, inside quotes too, and `$$` is one `$`), itself in the
    /// program path and in an `Environment=` value. `%` is doubled in all
    /// three; an empty argument stays an argument.
    #[test]
    fn systemd_quotes_each_place_by_its_own_rule() {
        assert_eq!(
            systemd_exec_arg("/usr/bin/wsmp").expect("quote"),
            "/usr/bin/wsmp"
        );
        assert_eq!(
            systemd_exec_arg("/tmp/a\"b%c").expect("quote"),
            "\"/tmp/a\\\"b%%c\""
        );
        assert_eq!(
            systemd_exec_arg("/tmp/${HOME}/$$/a b%").expect("quote"),
            "\"/tmp/$${HOME}/$$$$/a b%%\""
        );
        assert_eq!(systemd_exec_arg("").expect("quote"), "\"\"");
        assert_eq!(
            systemd_exec_path("/tmp/$HOME/a b%/wsmp").expect("quote"),
            "\"/tmp/$HOME/a b%%/wsmp\""
        );
        assert_eq!(
            systemd_environment("WSMP_STATE_DIR", "/tmp/${HOME}/$$ %").expect("quote"),
            "\"WSMP_STATE_DIR=/tmp/${HOME}/$$ %%\""
        );
    }

    /// F-FB-3: the wrapper path the LaunchAgent plist names
    /// ([`macos_wrapper_path`], for `wsmp service install` and a Homebrew
    /// update alike) is absolute even from a relative `WSMP_STATE_DIR`:
    /// resolved against this process's working directory, where that state
    /// directory is, not launchd's. An absolute one is kept as it is.
    #[cfg(unix)]
    #[test]
    fn the_wrapper_the_plist_names_is_absolute_from_a_relative_state_dir() {
        let cwd = std::env::current_dir().expect("cwd");
        let wrapper = absolute_in(Path::new("rel-state"), "wsmp-service-run.sh").expect("path");
        assert!(wrapper.is_absolute(), "{}", wrapper.display());
        assert_eq!(wrapper, cwd.join("rel-state").join("wsmp-service-run.sh"));
        let fixed = cwd.join("abs-state");
        assert_eq!(
            absolute_in(&fixed, "wsmp-service-run.sh").expect("path"),
            fixed.join("wsmp-service-run.sh")
        );
        let plist = render_launch_agent_plist(
            MACOS_LABEL,
            path_text("the wrapper path", &wrapper).expect("text"),
            "/Users/u",
            "/Users/u/Library/Logs/ws-model-proxy/relay.out.log",
            "/Users/u/Library/Logs/ws-model-proxy/relay.err.log",
        )
        .expect("render");
        assert!(
            plist.contains(&format!(
                "<string>{}</string>",
                xml_escape(path_text("w", &wrapper).expect("text"))
            )),
            "{plist}"
        );
    }

    #[test]
    fn launch_agent_plist_uses_wrapper_and_escapes_xml() {
        let label = "com.flycockpit.wsmp";
        let plist = render_launch_agent_plist(
            label,
            "/tmp/wsmp-service-run.sh",
            "/Users/test",
            "/Users/test/Library/Logs/ws-model-proxy/relay.out.log",
            "/Users/test/Library/Logs/ws-model-proxy/relay.err.log",
        )
        .expect("render");
        assert!(plist.contains(&format!("<string>{label}</string>")));
        assert!(plist.contains("<string>/tmp/wsmp-service-run.sh</string>"));
        assert!(plist.contains("<key>KeepAlive</key>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<true/>"));
        assert!(!plist.contains("EnvironmentVariables"));
        let escaped = render_launch_agent_plist(
            "label",
            "/tmp/a&b<c>.sh",
            "/Users/test",
            "/tmp/out",
            "/tmp/err",
        )
        .expect("render");
        assert!(escaped.contains("/tmp/a&amp;b&lt;c&gt;.sh"));
    }

    #[test]
    fn macos_wrapper_pins_paths_and_execs_foreground_daemon() {
        let script = render_macos_service_wrapper(
            "/usr/local/bin/wsmp",
            &[
                ("WSMP_STATE_DIR", "/Users/x/it's state".to_string()),
                ("PATH", "/Users/x/.cargo/bin:/usr/bin".to_string()),
            ],
        )
        .expect("render");
        assert!(script.contains("export PATH='/Users/x/.cargo/bin:/usr/bin'\n"));
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("export WSMP_STATE_DIR='/Users/x/it'\"'\"'s state'\n"));
        assert!(!script.contains("ENV_FILE"));
        assert!(script.contains("exec '/usr/local/bin/wsmp' run"));
    }

    #[test]
    fn logs_ask_journald_for_the_relay_unit() {
        let args = LogsArgs {
            follow: true,
            lines: 50,
        };
        assert_eq!(
            journalctl_args(&args),
            [
                "--user",
                "--unit",
                "wsmp.service",
                "--lines",
                "50",
                "--no-pager",
                "--follow"
            ]
        );
    }
}
