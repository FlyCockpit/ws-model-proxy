//! Windows units: what systemd's transient units are on Linux.
//!
//! A launch (prepare, start, after-join) runs in a runtime host, `wsmp
//! __runtime-host`, started detached with a hidden console of its own. The
//! host joins a kill-on-close job ([`wsmp_windows::HostJob`]) before it starts
//! the command, so everything the command starts stays a member, and it lives
//! until nothing of the job runs any more. It is not the daemon's child in any
//! job that kills it: it outlives a daemon restart, and it stays in the relay
//! job, so whatever it runs still counts as started by wsmp
//! (`trust::started_by_wsmp`).
//!
//! Per unit, in `<instances>/hosts/`:
//! - `<unit>.unit`: the record (owner, slice, invocation id, state), written by
//!   the daemon before the host starts and updated by the host;
//! - `<unit>.lock`: held open, unshared, by the host for its whole life, so a
//!   failed open with a sharing violation means the host still runs;
//! - `<unit>.stop`: a stop request naming the invocation it is for.
//!
//! As with `systemd-run --collect --property=RemainAfterExit=yes`, a command
//! that exits 0 leaves its unit `exited` until a stop; one that fails takes its
//! unit, and whatever it left, with it. A stop sends Ctrl+Break to the
//! command's console process group, then ends the whole job after the grace
//! period.
//!
//! Commands that are not launches (status, stop, health) run through
//! [`crate::bounded_run`], in a kill-on-close job of their own: nothing they
//! start outlives them.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::Deadline;
use crate::protocol::runtime_spec::CommandShell;

/// The subcommand a runtime host runs as.
pub const SUBCOMMAND: &str = "__runtime-host";

/// The unit records' directory, inside the instances directory.
const HOSTS_DIR: &str = "hosts";

/// A unit recorded as starting counts as there (a queued systemd job) this
/// long before its host takes the lock.
const STARTING_GRACE_SECS: u64 = 15;

/// How long a host keeps trying to take its lock (a probe holds it briefly).
const LOCK_WAIT: Duration = Duration::from_secs(5);

/// How often a host looks at its command, its job and its stop request.
const HOST_POLL: Duration = Duration::from_millis(200);

/// A stop repeats Ctrl+Break this often while the command is younger than [`BREAK_YOUNG`].
const BREAK_REPEAT: Duration = Duration::from_secs(1);
const BREAK_YOUNG: Duration = Duration::from_secs(10);

/// How much of a status or stop command's output is read (and dropped).
const OUTPUT_LIMIT: usize = 256 * 1024;

const RECORD_LIMIT: u64 = 4096;

/// `CREATE_NO_WINDOW`: a console of its own, without a window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// `CREATE_NEW_PROCESS_GROUP`: the command's group, for Ctrl+Break.
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
/// `ERROR_SHARING_VIOLATION`.
const SHARING_VIOLATION: i32 = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitState {
    Starting,
    Running,
    Exited,
}

/// One unit's record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnitRecord {
    pub version: u8,
    /// The executor's owner id (systemd's `Description` check).
    pub owner: String,
    pub unit: String,
    /// The rank's slice name, for the rank-wide stop proof.
    pub slice: String,
    /// 32 hex digits, new for every launch.
    pub invocation: String,
    pub state: UnitState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Unix seconds the daemon wrote it.
    pub created: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopRequest {
    invocation: String,
    grace_ms: u64,
}

/// The `wsmp` executable a runtime host runs as: this one. The library's own tests run as a test
/// binary, so they use the `wsmp` Cargo built beside it.
pub fn host_exe() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("finding the wsmp executable")?;
    #[cfg(test)]
    if let Some(built) = exe
        .parent()
        .and_then(Path::parent)
        .map(|dir| dir.join("wsmp.exe"))
        .filter(|built| built.is_file())
    {
        return Ok(built);
    }
    Ok(exe)
}

/// Where the unit records live.
pub fn hosts_dir() -> Result<PathBuf> {
    Ok(super::instances_dir()?.join(HOSTS_DIR))
}

/// A unit or slice name used as a file name: plain characters only.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn valid_invocation(invocation: &str) -> bool {
    invocation.len() == 32 && invocation.bytes().all(|b| b.is_ascii_hexdigit())
}

fn path(dir: &Path, unit: &str, extension: &str) -> PathBuf {
    dir.join(format!("{unit}.{extension}"))
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn read_json<T: serde::de::DeserializeOwned>(file: &Path) -> Result<Option<T>> {
    use std::io::Read;
    let opened = match std::fs::File::open(file) {
        Ok(opened) => opened,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("reading `{}`", file.display()));
        }
    };
    let mut bytes = Vec::new();
    opened
        .take(RECORD_LIMIT + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("reading `{}`", file.display()))?;
    anyhow::ensure!(
        bytes.len() as u64 <= RECORD_LIMIT,
        "`{}` is too large",
        file.display()
    );
    serde_json::from_slice(&bytes)
        .map(Some)
        .with_context(|| format!("reading `{}`", file.display()))
}

fn write_json<T: Serialize>(file: &Path, value: &T, what: &str) -> Result<()> {
    let bytes = serde_json::to_vec(value).with_context(|| format!("encoding the {what}"))?;
    crate::approvals::write_private_atomic(file, &bytes, what, false)?;
    Ok(())
}

fn remove(file: &Path) -> io::Result<()> {
    match std::fs::remove_file(file) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// The unit's record, checked against its name.
pub fn read_record(dir: &Path, unit: &str) -> Result<Option<UnitRecord>> {
    anyhow::ensure!(valid_name(unit), "bad unit name");
    let record: Option<UnitRecord> = read_json(&path(dir, unit, "unit"))?;
    if let Some(record) = &record {
        anyhow::ensure!(
            record.version == 1 && record.unit == unit && valid_invocation(&record.invocation),
            "the unit record is not valid"
        );
    }
    Ok(record)
}

/// Opens the lock file unshared: only one opener at a time.
fn open_lock(dir: &Path, unit: &str) -> io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(path(dir, unit, "lock"))
}

/// Whether the unit's host runs: it holds the lock.
pub fn host_alive(dir: &Path, unit: &str) -> Result<bool> {
    match open_lock(dir, unit) {
        Ok(_) => Ok(false),
        Err(error) if error.raw_os_error() == Some(SHARING_VIOLATION) => Ok(true),
        Err(error) => Err(error).context("probing the runtime host"),
    }
}

/// Whether anything of the unit may run: its host holds the lock, or it was
/// just written and its host has not started yet.
fn record_alive(dir: &Path, record: &UnitRecord) -> Result<bool> {
    if record.state == UnitState::Starting
        && unix_now().saturating_sub(record.created) < STARTING_GRACE_SECS
    {
        return Ok(true);
    }
    host_alive(dir, &record.unit)
}

/// The unit's invocation id while it is there: running, starting, or exited
/// 0 and not stopped yet. `None` when it is gone or its host died without
/// recording a clean exit.
pub fn identity(dir: &Path, unit: &str, owner: &str) -> Result<Option<String>> {
    let Some(record) = read_record(dir, unit)? else {
        return Ok(None);
    };
    anyhow::ensure!(record.owner == owner, "the unit belongs to someone else");
    if record.state == UnitState::Exited || record_alive(dir, &record)? {
        Ok(Some(record.invocation))
    } else {
        Ok(None)
    }
}

/// Whether the unit's host started its command and still runs (something of the job is alive).
pub fn running(dir: &Path, unit: &str) -> Result<bool> {
    match read_record(dir, unit)? {
        Some(record) if record.state != UnitState::Starting => host_alive(dir, unit),
        _ => Ok(false),
    }
}

/// Whether the unit's command exited 0 (the unit stays until a stop).
pub fn exited_cleanly(dir: &Path, unit: &str) -> Result<bool> {
    Ok(read_record(dir, unit)?
        .is_some_and(|record| record.state == UnitState::Exited && record.exit_code == Some(0)))
}

/// Every record whose slice is `slice`.
fn slice_records(dir: &Path, slice: &str) -> Result<Vec<UnitRecord>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("listing runtime units"),
    };
    let mut records = Vec::new();
    for entry in entries {
        let file = entry.context("listing runtime units")?.path();
        if file.extension().is_none_or(|ext| ext != "unit") {
            continue;
        }
        let Some(unit) = file.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if let Some(record) = read_record(dir, unit)?
            && record.slice == slice
        {
            records.push(record);
        }
    }
    Ok(records)
}

/// Whether anything of a unit, or of any unit of a slice (`….slice`), runs.
pub fn tasks_alive(dir: &Path, name: &str) -> Result<bool> {
    anyhow::ensure!(valid_name(name), "bad unit name");
    if name.ends_with(".slice") {
        for record in slice_records(dir, name)? {
            if record_alive(dir, &record)? {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    match read_record(dir, name)? {
        Some(record) => record_alive(dir, &record),
        None => Ok(false),
    }
}

/// How a runtime host is started.
pub struct HostLaunch<'a> {
    /// The `wsmp` executable.
    pub exe: &'a Path,
    pub owner: &'a str,
    pub unit: &'a str,
    pub slice: &'a str,
    pub shell: CommandShell,
    pub script: &'a str,
    /// The arguments `script` was rendered from, when it was an argv ([`invocation`]).
    pub argv: Option<&'a [String]>,
    /// On top of the scrubbed parent environment (node secrets): never logged.
    pub env: &'a [(String, String)],
}

/// Records the unit and starts its host, detached. The host runs the script
/// once it holds the unit's lock.
pub fn start(dir: &Path, launch: &HostLaunch<'_>) -> Result<String> {
    use std::os::windows::process::CommandExt;
    anyhow::ensure!(
        valid_name(launch.unit) && valid_name(launch.slice),
        "bad unit name"
    );
    std::fs::create_dir_all(dir).context("creating the runtime units directory")?;
    anyhow::ensure!(
        !host_alive(dir, launch.unit)?,
        "the unit `{}` is already running",
        launch.unit
    );
    let invocation = format!("{:032x}", rand::random::<u128>());
    remove(&path(dir, launch.unit, "stop")).context("clearing an old stop request")?;
    let record = UnitRecord {
        version: 1,
        owner: launch.owner.to_string(),
        unit: launch.unit.to_string(),
        slice: launch.slice.to_string(),
        invocation: invocation.clone(),
        state: UnitState::Starting,
        exit_code: None,
        created: unix_now(),
    };
    write_json(&path(dir, launch.unit, "unit"), &record, "unit record")?;
    let mut host = std::process::Command::new(launch.exe);
    host.arg(SUBCOMMAND);
    if let Some(argv) = launch.argv {
        host.arg("--argv-json")
            .arg(serde_json::to_string(argv).context("encoding the command's arguments")?);
    }
    let spawned = host
        .arg("--dir")
        .arg(dir)
        .args([
            "--unit",
            launch.unit,
            "--invocation",
            &invocation,
            "--shell",
            shell_name(launch.shell),
            "--script",
            launch.script,
        ])
        .env_clear()
        .envs(crate::child_env::scrub_parent_env(&[]))
        .envs(
            launch
                .env
                .iter()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        )
        .env("WSMP_JOB", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    if let Err(error) = spawned {
        let _ = remove(&path(dir, launch.unit, "unit"));
        return Err(error).context("starting the runtime host");
    }
    Ok(invocation)
}

/// Asks the unit's host to stop (Ctrl+Break, then the whole job after
/// `grace`), waits within `deadline` until it is gone, then forgets the unit.
/// A unit already gone is only forgotten.
pub fn stop(
    dir: &Path,
    unit: &str,
    invocation: &str,
    grace: Duration,
    deadline: Deadline,
) -> Result<()> {
    anyhow::ensure!(valid_name(unit) && valid_invocation(invocation), "bad unit");
    request_stop(dir, unit, invocation, grace)?;
    wait_gone(dir, unit, deadline)?;
    remove(&path(dir, unit, "unit")).context("forgetting the unit")?;
    let _ = remove(&path(dir, unit, "lock"));
    Ok(())
}

fn request_stop(dir: &Path, unit: &str, invocation: &str, grace: Duration) -> Result<()> {
    write_json(
        &path(dir, unit, "stop"),
        &StopRequest {
            invocation: invocation.to_string(),
            grace_ms: u64::try_from(grace.as_millis()).unwrap_or(u64::MAX),
        },
        "stop request",
    )
}

/// Waits until the unit's host is gone. A host that has not taken its lock yet finds the stop
/// request (or no record) once it has, and leaves without running anything.
fn wait_gone(dir: &Path, unit: &str, deadline: Deadline) -> Result<()> {
    while host_alive(dir, unit)? {
        anyhow::ensure!(deadline.remaining().is_ok(), "the unit is still alive");
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

/// Stops every unit of the slice that still runs, each with `grace`, and
/// proves them gone within `deadline`.
pub fn stop_slice(dir: &Path, slice: &str, grace: Duration, deadline: Deadline) -> Result<()> {
    anyhow::ensure!(valid_name(slice), "bad slice name");
    let records = slice_records(dir, slice)?;
    for record in &records {
        if record_alive(dir, record)? {
            request_stop(dir, &record.unit, &record.invocation, grace)?;
        }
    }
    for record in &records {
        wait_gone(dir, &record.unit, deadline)
            .context("a process of the rank's units survived the stop")?;
    }
    Ok(())
}

fn shell_name(shell: CommandShell) -> &'static str {
    match shell {
        CommandShell::Sh => "sh",
        CommandShell::Pwsh => "pwsh",
        CommandShell::Powershell => "powershell",
        CommandShell::Cmd => "cmd",
    }
}

fn parse_shell(name: &str) -> Option<CommandShell> {
    match name {
        "pwsh" => Some(CommandShell::Pwsh),
        "powershell" => Some(CommandShell::Powershell),
        "cmd" => Some(CommandShell::Cmd),
        _ => None,
    }
}

/// The shell a node command or metric command runs in when none is named: PowerShell 7, else
/// Windows PowerShell (every Windows 11 has it). Never `sh` or `cmd`, so what is on `PATH` (Git
/// Bash) cannot change how commands run.
pub fn default_shell() -> Result<CommandShell> {
    crate::shells::command_shells()
        .iter()
        .find_map(|found| match found.id.as_str() {
            "pwsh" => Some(CommandShell::Pwsh),
            "powershell" => Some(CommandShell::Powershell),
            _ => None,
        })
        .context("neither `pwsh` nor `powershell` is installed")
}

/// The program of a Windows shell this node found.
pub fn shell_program(shell: CommandShell) -> Result<PathBuf> {
    let id = shell_name(shell);
    crate::shells::command_shells()
        .into_iter()
        .find(|found| found.id == id)
        .map(|found| found.program)
        .with_context(|| format!("`{id}` is not installed on this node"))
}

/// A PowerShell script that writes UTF-8 and exits as `sh` would: with the status of its last
/// command, a native program's exit code included (PowerShell itself would exit 1). An `exit` in
/// the script still ends it at once.
///
/// UTF-8: a service's console has the OEM code page (437 on a US Windows), in which PowerShell
/// writes `é` as one byte wsmp cannot read. The console's code page is switched for the script
/// (programs it starts write UTF-8 too, and PowerShell reads their output as such); without a
/// console there is nothing to switch.
pub fn powershell_script(script: &str) -> String {
    format!(
        "try {{ [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) }} catch {{}}\n\
         $OutputEncoding = [Text.UTF8Encoding]::new($false)\n\
         {script}\nif (-not $?) {{ if ($LASTEXITCODE) {{ exit $LASTEXITCODE }}; exit 1 }}"
    )
}

/// `-EncodedCommand`'s argument: the script as base64 of its UTF-16LE text, so
/// no quoting stands between the script and PowerShell.
fn encoded(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// How a shell runs a script: an argument list, or `cmd.exe`'s raw command
/// line (`/s /c "…"` runs what is between the outer quotes as written).
pub enum ShellLine {
    List(Vec<String>),
    Raw(String),
}

pub fn shell_line(shell: CommandShell, script: &str) -> Result<ShellLine> {
    line_for(shell, script, false)
}

/// [`shell_line`] for a person at a terminal (an operator step: a prompt to answer, a sign-in to
/// finish): PowerShell may ask for input.
pub fn interactive_shell_line(shell: CommandShell, script: &str) -> Result<ShellLine> {
    line_for(shell, script, true)
}

fn line_for(shell: CommandShell, script: &str, interactive: bool) -> Result<ShellLine> {
    match shell {
        CommandShell::Pwsh | CommandShell::Powershell => {
            let mut args = vec!["-NoLogo".to_string(), "-NoProfile".to_string()];
            if !interactive {
                args.push("-NonInteractive".into());
            }
            args.push("-EncodedCommand".into());
            args.push(encoded(&powershell_script(script)));
            Ok(ShellLine::List(args))
        }
        CommandShell::Cmd => Ok(ShellLine::Raw(format!("/d /s /c \"{script}\""))),
        CommandShell::Sh => anyhow::bail!("`sh` commands do not run on Windows"),
    }
}

/// An argument Windows PowerShell 5.1 hands a program intact: it rebuilds the command line
/// itself and loses an empty argument, a quote inside one, and a trailing backslash before the
/// quote it adds around one with a space.
fn powershell51_passes(arg: &str) -> bool {
    !arg.is_empty() && !arg.contains('"') && !(arg.ends_with('\\') && arg.contains([' ', '\t']))
}

/// How a command starts: its program, and the arguments it is given.
pub struct Invocation {
    pub program: PathBuf,
    pub line: ShellLine,
}

/// How one of a job's commands starts. An argv (`argv`, the arguments `script` was rendered
/// from) whose program is an `.exe` or `.com` on the command's `PATH` starts directly, its
/// arguments quoted as the C runtime reads them: it gets each one exactly, and the command's
/// status is its own. Anything else runs as `script` in `shell`: a text command, and an argv
/// naming a `.cmd` or `.bat` shim (which cannot be handed arguments safely), a PowerShell command,
/// or a program not found (the shell's status check exits 1). `env` is the command's whole
/// environment.
pub fn invocation(
    shell: CommandShell,
    script: &str,
    argv: Option<&[String]>,
    env: &[(String, String)],
    interactive: bool,
) -> Result<Invocation> {
    if let Some(argv) = argv {
        if let Some((program, args)) = argv.split_first()
            && let Some(exe) = find_exe(program, env)
        {
            return Ok(Invocation {
                program: exe,
                line: ShellLine::List(args.to_vec()),
            });
        }
        anyhow::ensure!(
            shell != CommandShell::Powershell || argv.iter().all(|arg| powershell51_passes(arg)),
            "the program is not an `.exe`, and Windows PowerShell 5.1 would change one of its \
             arguments (an empty one, a `\"` in one, or a trailing `\\` in one with a space)"
        );
    }
    Ok(Invocation {
        program: shell_program(shell)?,
        line: line_for(shell, script, interactive)?,
    })
}

/// `name` as PowerShell would find it, when that is an `.exe` or `.com`: see [`find_program`].
pub fn find_exe(name: &str, env: &[(String, String)]) -> Option<PathBuf> {
    let found = find_program(name, env)?;
    let extension = found.extension()?.to_str()?.to_ascii_lowercase();
    matches!(extension.as_str(), "exe" | "com").then_some(found)
}

/// `name` as PowerShell would find it: an absolute path as it is, a bare name in each absolute
/// `PATH` directory in turn; either with each `PATHEXT` extension unless it already ends in one.
/// A relative path is left to the shell.
pub fn find_program(name: &str, env: &[(String, String)]) -> Option<PathBuf> {
    let var = |key: &str| {
        env.iter()
            .rev()
            .find(|(found, _)| found.eq_ignore_ascii_case(key))
            .map(|(_, value)| value.as_str())
    };
    let extensions: Vec<String> = var("PATHEXT")
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .filter(|ext| ext.len() > 1 && ext.starts_with('.'))
        .map(str::to_ascii_lowercase)
        .collect();
    let path = Path::new(name);
    let has_extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| extensions.contains(&format!(".{}", ext.to_ascii_lowercase())));
    let candidates = |base: &Path| -> Vec<PathBuf> {
        if has_extension {
            return vec![base.to_path_buf()];
        }
        extensions
            .iter()
            .map(|ext| {
                let mut with = base.as_os_str().to_owned();
                with.push(ext);
                PathBuf::from(with)
            })
            .collect()
    };
    if name.contains(['\\', '/', ':']) {
        if !path.is_absolute() {
            return None;
        }
        candidates(path)
            .into_iter()
            .find(|candidate| candidate.is_file())
    } else {
        std::env::split_paths(var("PATH")?)
            .filter(|dir| dir.is_absolute())
            .flat_map(|dir| candidates(&dir.join(name)))
            .find(|candidate| candidate.is_file())
    }
}

/// Runs one of a job's commands to completion (bounded, in a job of its own): its output is
/// read and dropped, never logged. `argv`: see [`invocation`].
pub fn run_script(
    shell: CommandShell,
    script: &str,
    argv: Option<&[String]>,
    deadline: Deadline,
    cancel: Option<&AtomicBool>,
    env: &[(String, String)],
) -> Result<(), crate::bounded_run::RunError> {
    let mut whole = crate::child_env::scrub_parent_env(&[]);
    whole.extend_from_slice(env);
    let Invocation { program, line } = invocation(shell, script, argv, &whole, false)
        .map_err(|_| crate::bounded_run::RunError::Spawn)?;
    // The program's path as it is (never as text: a path that is not valid UTF-16 would name
    // another file).
    match line {
        ShellLine::List(args) => crate::bounded_run::run_until_env(
            &program,
            &args,
            deadline.instant(),
            OUTPUT_LIMIT,
            cancel,
            env,
        ),
        ShellLine::Raw(raw) => crate::bounded_run::run_raw_until_env(
            &program,
            &raw,
            deadline.instant(),
            OUTPUT_LIMIT,
            cancel,
            env,
        ),
    }
    .map(|_| ())
}

/// What `wsmp __runtime-host` was given.
pub struct HostArgs<'a> {
    pub dir: &'a Path,
    pub unit: &'a str,
    pub invocation: &'a str,
    pub shell: &'a str,
    pub script: &'a str,
    /// The arguments `script` was rendered from (JSON), when it was an argv.
    pub argv_json: Option<&'a str>,
}

/// The runtime host: holds the unit's lock and job, runs the script, records
/// how it ended, and stays until nothing of its job runs or a stop asks it to
/// end everything.
pub fn host(args: &HostArgs<'_>) -> Result<()> {
    use std::os::windows::process::CommandExt;
    anyhow::ensure!(
        valid_name(args.unit) && valid_invocation(args.invocation),
        "bad unit"
    );
    let shell = parse_shell(args.shell).context("unknown shell")?;
    let argv: Option<Vec<String>> = args
        .argv_json
        .map(serde_json::from_str)
        .transpose()
        .context("reading the command's arguments")?;
    let until = Instant::now() + LOCK_WAIT;
    let _lock = loop {
        match open_lock(args.dir, args.unit) {
            Ok(lock) => break lock,
            Err(error)
                if error.raw_os_error() == Some(SHARING_VIOLATION) && Instant::now() < until =>
            {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(error).context("taking the unit lock"),
        }
    };
    let job = wsmp_windows::HostJob::create_and_join().context("creating the runtime job")?;
    let record_path = path(args.dir, args.unit, "unit");
    let mut record = read_record(args.dir, args.unit)?.context("the unit is not recorded")?;
    anyhow::ensure!(
        record.invocation == args.invocation && record.state == UnitState::Starting,
        "the unit was relaunched"
    );
    if stop_grace(args.dir, args.unit, args.invocation).is_some() {
        return Ok(());
    }
    // This host's environment is the command's.
    let env: Vec<(String, String)> = std::env::vars().collect();
    let Invocation { program, line } =
        match invocation(shell, args.script, argv.as_deref(), &env, false) {
            Ok(found) => found,
            Err(error) => {
                // Nothing started: the unit goes, and the launch fails.
                let _ = remove(&record_path);
                return Err(error);
            }
        };
    let mut command = std::process::Command::new(program);
    match line {
        ShellLine::List(list) => {
            command.args(list);
        }
        ShellLine::Raw(raw) => {
            command.raw_arg(raw);
        }
    }
    let spawned = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NEW_PROCESS_GROUP)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let _ = remove(&record_path);
            return Err(error).context("starting the command");
        }
    };
    let group = child.id();
    let spawned = Instant::now();
    // A running record promises the command was spawned, not that its shell or interrupt
    // handler finished initializing. Keep it starting until spawn succeeds. If recording this
    // fails, dropping the host's job still ends the command and everything it started.
    record.state = UnitState::Running;
    write_json(&record_path, &record, "unit record")?;
    let mut exited = false;
    loop {
        if let Some(grace) = stop_grace(args.dir, args.unit, args.invocation) {
            let until = Instant::now() + grace;
            let mut last_break: Option<Instant> = None;
            while job.active_processes().unwrap_or(2) > 1 && Instant::now() < until {
                // A break that reaches a program still starting up can be lost, so a young
                // command gets it again every second; one that ran a while gets it once (some
                // programs take a second interrupt as "quit at once").
                let due = last_break.is_none_or(|at| {
                    at.elapsed() >= BREAK_REPEAT && at.duration_since(spawned) < BREAK_YOUNG
                });
                if due {
                    let _ = wsmp_windows::send_ctrl_break(group);
                    last_break = Some(Instant::now());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            // Ends what ignored the break, and this host with it.
            let _ = job.terminate(1);
            return Ok(());
        }
        if !exited && let Some(status) = child.try_wait().context("watching the command")? {
            exited = true;
            if status.success() {
                record.state = UnitState::Exited;
                record.exit_code = Some(0);
                write_json(&record_path, &record, "unit record")?;
            } else {
                // A failed unit goes, and takes what it left behind.
                let _ = remove(&record_path);
                let _ = job.terminate(1);
                return Ok(());
            }
        }
        if exited && job.active_processes().context("counting the runtime job")? <= 1 {
            return Ok(());
        }
        std::thread::sleep(HOST_POLL);
    }
}

/// The grace period of a stop request for this invocation.
fn stop_grace(dir: &Path, unit: &str, invocation: &str) -> Option<Duration> {
    read_json::<StopRequest>(&path(dir, unit, "stop"))
        .ok()
        .flatten()
        .filter(|request| request.invocation == invocation)
        .map(|request| Duration::from_millis(request.grace_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_names_are_plain_file_names() {
        assert!(valid_name("wsmp-abc-r0-prepare"));
        assert!(valid_name("wsmp_abc_r0.slice"));
        for bad in ["", ".hidden", "a/b", "a\\b", "a:b", "a b", &"a".repeat(201)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn powershell_runs_the_script_and_exits_with_its_last_status() {
        let Ok(program) = shell_program(CommandShell::Powershell) else {
            return;
        };
        let code = |script: &str| {
            let ShellLine::List(args) = shell_line(CommandShell::Powershell, script).expect("line")
            else {
                panic!("a list");
            };
            std::process::Command::new(&program)
                .args(args)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .expect("powershell runs")
                .code()
        };
        assert_eq!(code("cmd /c exit 3"), Some(3));
        assert_eq!(code("exit 4"), Some(4));
        assert_eq!(code("Write-Output 'it''s \"quoted\"'"), Some(0));
        assert_eq!(code("Get-Item C:\\wsmp-no-such-path"), Some(1));
        assert_eq!(code("cmd /c exit 5; Write-Output ok"), Some(0));
    }

    #[test]
    fn an_argv_exits_with_its_program_status_or_1_when_it_cannot_start() {
        use crate::bounded_run::RunError;
        let deadline = || Deadline::new(Duration::from_secs(60));
        for shell in [CommandShell::Powershell, CommandShell::Pwsh] {
            if shell_program(shell).is_err() {
                continue;
            }
            let run = |argv: &[&str], direct: bool| {
                let argv: Vec<String> = argv.iter().map(|arg| (*arg).to_string()).collect();
                let script = crate::runtimes::render::argv_script(shell, &argv).expect("script");
                let argv = direct.then_some(argv.as_slice());
                match run_script(shell, &script, argv, deadline(), None, &[]) {
                    Ok(()) => Some(0),
                    Err(RunError::ExitStatus(code)) => code,
                    Err(other) => panic!("{other:?}"),
                }
            };
            for direct in [false, true] {
                assert_eq!(run(&["cmd", "/d", "/c", "exit 7"], direct), Some(7));
                assert_eq!(run(&["cmd", "/d", "/c", "exit 0"], direct), Some(0));
                // Not found: PowerShell runs it, and it fails.
                assert_eq!(run(&[MISSING_PROGRAM, "x"], direct), Some(1));
            }
            // A script whose last command is a program that is not there fails too.
            assert_eq!(
                run_script(
                    shell,
                    &format!("& '{MISSING_PROGRAM}'"),
                    None,
                    deadline(),
                    None,
                    &[]
                )
                .map_err(|error| matches!(error, RunError::ExitStatus(Some(1)))),
                Err(true)
            );
        }
    }

    /// A program that is not there, by a full path: PowerShell reports a bare name it cannot find
    /// only after searching every installed module for it (seconds per call, past the deadline
    /// on a CI runner with many modules), and a path skips that search.
    const MISSING_PROGRAM: &str = r"C:\wsmp-no-such-dir\wsmp-no-such-program.exe";

    #[test]
    fn an_exe_is_found_and_anything_else_is_left_to_the_shell() {
        let dir = tempfile::tempdir().expect("dir");
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).expect("bin");
        std::fs::write(bin.join("tool.cmd"), "@exit /b 0").expect("shim");
        std::fs::write(bin.join("both.cmd"), "@exit /b 0").expect("shim");
        std::fs::write(bin.join("both.exe"), "").expect("exe");
        let env = vec![
            ("Path".to_string(), bin.to_string_lossy().into_owned()),
            ("PATHEXT".to_string(), ".COM;.EXE;.BAT;.CMD".to_string()),
        ];
        // The first `PATHEXT` extension wins in a directory.
        assert_eq!(find_exe("both", &env), Some(bin.join("both.exe")));
        assert_eq!(find_exe("BOTH.EXE", &env), Some(bin.join("BOTH.EXE")));
        // A shim runs in the shell.
        assert_eq!(find_exe("tool", &env), None);
        assert_eq!(find_exe("both.cmd", &env), None);
        assert_eq!(find_exe("missing", &env), None);
        // A path is taken as it is; a relative one is the shell's.
        let exe = bin.join("both.exe");
        assert_eq!(find_exe(&exe.to_string_lossy(), &[]), Some(exe));
        assert_eq!(find_exe(r".\bin\both.exe", &env), None);
        // Without `PATH`, nothing is found.
        assert_eq!(find_exe("both", &[]), None);
    }

    #[test]
    fn a_5_1_argument_is_refused_only_without_an_exe() {
        let env = crate::child_env::scrub_parent_env(&[]);
        let argv = |program: &str| vec![program.to_string(), String::new()];
        let shim = invocation(
            CommandShell::Powershell,
            "",
            Some(&argv("wsmp-no-such-program")),
            &env,
            false,
        );
        assert!(shim.is_err());
        let direct = invocation(
            CommandShell::Powershell,
            "",
            Some(&argv("cmd")),
            &env,
            false,
        )
        .expect("cmd.exe starts directly");
        assert!(
            direct
                .program
                .to_string_lossy()
                .to_lowercase()
                .ends_with("cmd.exe")
        );
        assert!(matches!(direct.line, ShellLine::List(args) if args == [String::new()]));
        // PowerShell 7 hands any argument on.
        if shell_program(CommandShell::Pwsh).is_ok() {
            assert!(
                invocation(
                    CommandShell::Pwsh,
                    "",
                    Some(&argv("wsmp-no-such-program")),
                    &env,
                    false
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn cmd_runs_the_script_as_written() {
        let program = shell_program(CommandShell::Cmd).expect("cmd");
        let ShellLine::Raw(raw) = shell_line(
            CommandShell::Cmd,
            r#"if "a b"=="a b" (exit 3) else (exit 4)"#,
        )
        .expect("line") else {
            panic!("raw");
        };
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new(program)
            .raw_arg(raw)
            .status()
            .expect("cmd runs");
        assert_eq!(status.code(), Some(3));
    }

    #[test]
    fn a_record_names_its_unit_and_a_starting_one_counts_as_there() {
        let dir = tempfile::tempdir().expect("dir");
        let mut record = UnitRecord {
            version: 1,
            owner: "o".repeat(24),
            unit: "wsmp-a-r0".into(),
            slice: "wsmp_a_r0.slice".into(),
            invocation: "0".repeat(32),
            state: UnitState::Starting,
            exit_code: None,
            created: unix_now(),
        };
        write_json(
            &path(dir.path(), "wsmp-a-r0", "unit"),
            &record,
            "unit record",
        )
        .expect("write");
        let owner = "o".repeat(24);
        assert_eq!(
            identity(dir.path(), "wsmp-a-r0", &owner).expect("identity"),
            Some("0".repeat(32))
        );
        assert!(identity(dir.path(), "wsmp-a-r0", &"x".repeat(24)).is_err());
        assert!(tasks_alive(dir.path(), "wsmp_a_r0.slice").expect("slice"));
        assert!(!tasks_alive(dir.path(), "wsmp_b_r0.slice").expect("other slice"));
        // Its host never came: past the grace it is gone.
        record.created = unix_now() - STARTING_GRACE_SECS - 1;
        write_json(
            &path(dir.path(), "wsmp-a-r0", "unit"),
            &record,
            "unit record",
        )
        .expect("write");
        assert_eq!(
            identity(dir.path(), "wsmp-a-r0", &owner).expect("identity"),
            None
        );
        assert!(!tasks_alive(dir.path(), "wsmp-a-r0").expect("unit"));
        // Exited 0: there until a stop, with nothing running.
        record.state = UnitState::Exited;
        record.exit_code = Some(0);
        write_json(
            &path(dir.path(), "wsmp-a-r0", "unit"),
            &record,
            "unit record",
        )
        .expect("write");
        assert!(
            identity(dir.path(), "wsmp-a-r0", &owner)
                .expect("identity")
                .is_some()
        );
        assert!(exited_cleanly(dir.path(), "wsmp-a-r0").expect("exited"));
        assert!(!tasks_alive(dir.path(), "wsmp-a-r0").expect("unit"));
        // A held lock is a running host.
        let lock = open_lock(dir.path(), "wsmp-a-r0").expect("lock");
        assert!(host_alive(dir.path(), "wsmp-a-r0").expect("probe"));
        drop(lock);
        assert!(!host_alive(dir.path(), "wsmp-a-r0").expect("probe"));
        // A record for another unit name is refused.
        std::fs::copy(
            path(dir.path(), "wsmp-a-r0", "unit"),
            path(dir.path(), "wsmp-b-r0", "unit"),
        )
        .expect("copy");
        assert!(read_record(dir.path(), "wsmp-b-r0").is_err());
    }
}
