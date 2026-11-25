//! Task Scheduler through `schtasks` and PowerShell, every call bounded: the
//! relay task's names for this account, starting and ending it, and moving
//! it off the 0.4.x names.

#[cfg(windows)]
use std::path::PathBuf;

#[cfg(windows)]
use anyhow::Context;
use anyhow::Result;

#[cfg(windows)]
use super::task_names;

/// Windows: start the relay task (a no-op while it runs: `IgnoreNew`).
#[cfg(windows)]
pub fn kick_relay_task() -> Result<()> {
    schtasks(&["/Run", "/TN", &windows_task_name()?]).map(|_| ())
}

/// This account, for the scheduled-task names ([`task_names`]): its SID,
/// `USERNAME` (the 0.4.x names) and its absolute state directory.
#[cfg(windows)]
pub(crate) fn windows_account() -> Result<task_names::Account> {
    let state_dir = std::path::absolute(crate::paths::state_dir()?)
        .context("resolving the state directory")?
        .into_os_string()
        .into_string()
        .map_err(|_| anyhow::anyhow!("the state directory is not valid UTF-8"))?;
    Ok(task_names::Account {
        sid: wsmp_windows::current_user_sid().context("reading this user's SID")?,
        user: std::env::var("USERNAME").ok(),
        state_dir,
    })
}

/// Task Scheduler through `schtasks` and PowerShell, every call bounded.
#[cfg(windows)]
pub(crate) struct SystemTasks;

#[cfg(windows)]
impl task_names::Tasks for SystemTasks {
    fn exists(&self, name: &str) -> Result<task_names::Presence> {
        use task_names::Presence;
        if schtasks(&["/Query", "/TN", name]).is_ok() {
            return Ok(Presence::Present);
        }
        // `/Query /TN` fails the same way (exit 1, localized text) for a
        // missing task, one this account may not read, and a broken service.
        // Task Scheduler's COM API tells them apart by HRESULT: 0x80070002
        // (not found) and 0x80070005 (access denied). Names are
        // `[A-Za-z0-9._-]` (task_names::sanitize): single quotes suffice.
        let script = format!(
            "$s = New-Object -ComObject Schedule.Service; $s.Connect(); \
             try {{ $null = $s.GetFolder('\\').GetTask('{name}'); 'present' }} \
             catch {{ $e = $_.Exception; while ($e.InnerException) {{ $e = $e.InnerException }}; \
             switch ($e.HResult) {{ -2147024894 {{ 'absent' }} -2147024891 {{ 'unreadable' }} default {{ throw }} }} }}"
        );
        let argv = ["-NoProfile", "-NonInteractive", "-Command", &script].map(str::to_string);
        if let Ok((true, stdout, _)) = crate::bounded_run::management::run_bounded_split(
            "powershell",
            &argv,
            &[],
            super::FINITE_COMMAND_TIMEOUT,
        ) {
            match stdout.trim() {
                "present" => return Ok(Presence::Present),
                "absent" => return Ok(Presence::Absent),
                "unreadable" => return Ok(Presence::Unreadable),
                _ => {}
            }
        }
        // No PowerShell (blocked by policy): the full listing, which fails
        // as a whole on any broken task and is kept only up to 1 MiB
        // (`run_bounded_split`), so a long one is an error, never "absent".
        let listing =
            schtasks(&["/Query", "/FO", "CSV", "/NH"]).context("listing the scheduled tasks")?;
        anyhow::ensure!(
            listing.len() < (1 << 20) - 4096,
            "the scheduled-task listing is too long to read whole"
        );
        Ok(if task_names::csv_lists_task(&listing, name) {
            Presence::Present
        } else {
            Presence::Absent
        })
    }
    fn definition(&self, name: &str) -> Option<String> {
        // Names are `[A-Za-z0-9._-]` (task_names::sanitize): single quotes
        // suffice. UTF-8 output so a non-ASCII path reads back as written.
        let script = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
             Export-ScheduledTask -TaskName '{name}' -TaskPath '\\' -ErrorAction Stop"
        );
        let argv = ["-NoProfile", "-NonInteractive", "-Command", &script].map(str::to_string);
        match crate::bounded_run::management::run_bounded_split(
            "powershell",
            &argv,
            &[],
            super::FINITE_COMMAND_TIMEOUT,
        ) {
            Ok((true, stdout, _)) if stdout.contains("<Task") => Some(stdout),
            _ => None,
        }
    }
    fn create(&self, name: &str, xml_file: &str) -> Result<()> {
        schtasks(&["/Create", "/TN", name, "/XML", xml_file, "/F"]).map(|_| ())
    }
    fn end(&self, name: &str) {
        end_windows_task(name);
    }
    fn delete(&self, name: &str) -> Result<()> {
        schtasks(&["/Delete", "/TN", name, "/F"]).map(|_| ())
    }
}

/// The relay task's names for this account.
#[cfg(windows)]
pub(crate) fn relay_task_names() -> Result<(task_names::TaskNames, task_names::Account)> {
    let account = windows_account()?;
    Ok((
        task_names::TaskNames::new(task_names::RELAY_PREFIX, &account),
        account,
    ))
}

/// The relay task commands act on: the SID-named one, or this account's
/// 0.4.x task on a node updated from 0.4.x ([`task_names::active_name`]).
#[cfg(windows)]
pub(crate) fn windows_task_name() -> Result<String> {
    let (names, account) = relay_task_names()?;
    task_names::active_name(&SystemTasks, &names, &account)
}

/// `wsmp update` to a build older than 1.0 on Windows, while a relay
/// service is installed (its definition file, or a SID-named task left
/// without one): refused. That build only knows the 0.4.x task names, so it
/// would neither restart a SID-named relay task nor remove the SID-named
/// dead-man this update arms.
#[cfg(windows)]
pub fn refuse_pre_sid_downgrade(version: &str) -> Result<()> {
    if task_names::uses_sid_names(version) {
        return Ok(());
    }
    let (names, _) = relay_task_names()?;
    let task = task_names::Tasks::exists(&SystemTasks, &names.current)?;
    anyhow::ensure!(
        !super::installed() && task == task_names::Presence::Absent,
        "wsmp {version} predates 1.0 and only knows the 0.4 scheduled-task names; run `wsmp service uninstall` first, then install {version} with its installer and run its `wsmp service install`"
    );
    Ok(())
}

/// Elsewhere there is no scheduled task to keep.
#[cfg(not(windows))]
pub fn refuse_pre_sid_downgrade(_version: &str) -> Result<()> {
    Ok(())
}

/// `wsmp update` to `version`: move a node installed by 0.4.x onto the
/// SID-named relay task, from the definition file its install wrote, before
/// the restart. Only for a 1.0+ target (an older build looks for the old
/// name) and only when the definition file is there. Never on a restart or a
/// rollback: a rollback to 0.4.x must find the task 0.4.x knows.
#[cfg(windows)]
pub fn migrate_relay_task_for(version: &str) -> Result<()> {
    if !task_names::uses_sid_names(version) {
        return Ok(());
    }
    let file = super::service_file()?;
    if !file.exists() {
        return Ok(());
    }
    let file_arg = super::text::path_text("the task definition", &file)?.to_string();
    let (names, account) = relay_task_names()?;
    match task_names::migrate(&SystemTasks, &names, &account, &file_arg)? {
        Some(moved) => {
            for note in moved.notes() {
                tracing::info!("{note}");
            }
            moved.into_result()
        }
        None => Ok(()),
    }
}

/// Elsewhere there is no scheduled task to move.
#[cfg(not(windows))]
pub fn migrate_relay_task_for(_version: &str) -> Result<()> {
    Ok(())
}

#[cfg(windows)]
pub(crate) fn windows_log_file() -> Result<PathBuf> {
    Ok(crate::paths::log_dir()?.join(super::windows_task::LOG_FILE))
}

/// Runs `schtasks`, capturing its output: what it prints goes to the
/// caller's stream only by choice (stdout may carry `--json`).
/// Supervised and bounded like every update-management command (an update's
/// restart runs it): see [`run_finite`].
#[cfg(windows)]
pub(crate) fn schtasks(args: &[&str]) -> Result<String> {
    let argv: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let (ok, stdout, stderr) = crate::bounded_run::management::run_bounded_split(
        "schtasks",
        &argv,
        &[],
        super::FINITE_COMMAND_TIMEOUT,
    )
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
    crate::bounded_run::management::run_bounded_split(
        "powershell",
        &argv,
        &[],
        super::FINITE_COMMAND_TIMEOUT,
    )
    .is_ok_and(|(_, stdout, _)| stdout.trim() == "Running")
}

/// Stops the task's relay: gracefully through its control pipe (it ends its
/// commands and terminals and tells the server), then `schtasks /End` for the
/// console host, which `/End` kills without its child. Waits (bounded) until
/// Task Scheduler no longer counts the task as running and the pipe is gone;
/// otherwise a `/Run` right after is dropped (`IgnoreNew`), or the new relay
/// finds the pipe still taken.
#[cfg(windows)]
pub(crate) fn end_windows_task(name: &str) {
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
