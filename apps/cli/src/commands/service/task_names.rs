//! Windows scheduled-task names (C-13), and the move off the 0.4.x names.
//!
//! Task Scheduler names are machine-wide. wsmp 0.4.x named the relay task
//! `wsmp-relay-<USERNAME>` and the update dead-man
//! `wsmp-update-deadman-<USERNAME>`, so two accounts with one user name
//! (`DOMAINA\jo` and `DOMAINB\jo`, or a local and a domain `jo`) shared one
//! name: the second account's install failed, or (as an administrator)
//! replaced the first account's task. From 1.0 both are named after the
//! account SID, which is unique: `wsmp-relay-S-1-5-21-…`.
//!
//! A task with the 0.4.x name is this account's when its principal is this
//! account's SID, or (a principal stored as an account name) that name's user
//! part is this `USERNAME` and its arguments carry this account's
//! `--state-dir`. Only such a task is replaced: at `wsmp service install`
//! and at `wsmp update` it is registered again under the SID name and then
//! deleted, and at `wsmp service uninstall` it is deleted with the new one.
//! Until then every command acts on it ([`active_name`]). A task of the old
//! name that is another account's, or whose owner cannot be read, is never
//! touched; install says so.
//!
//! The logic is behind [`Tasks`], so it is tested everywhere with a fake
//! scheduler; `service.rs` implements it with `schtasks` and PowerShell.

use anyhow::Result;

pub const RELAY_PREFIX: &str = "wsmp-relay-";
pub const DEADMAN_PREFIX: &str = "wsmp-update-deadman-";

/// `[A-Za-z0-9._-]` only, so a name is safe in `schtasks` arguments and in
/// a single-quoted PowerShell string.
fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

/// The 1.0 name: `prefix` and the account SID (`S-1-5-21-…`).
pub fn task_name(prefix: &str, sid: &str) -> String {
    format!("{prefix}{}", sanitize(sid))
}

/// The 0.4.x name: `prefix` and the sanitized `USERNAME`.
pub fn legacy_task_name(prefix: &str, user: &str) -> String {
    format!("{prefix}{}", sanitize(user))
}

/// The account a command runs as: what names and ownership derive from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    /// The SID in SDDL form (`S-1-5-21-…`).
    pub sid: String,
    /// `USERNAME`, when set: the 0.4.x name derives from it.
    pub user: Option<String>,
    /// This account's absolute state directory, as the task arguments carry it.
    pub state_dir: String,
}

/// One task's 1.0 name and, when there is one, its 0.4.x name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskNames {
    pub current: String,
    pub legacy: Option<String>,
}

impl TaskNames {
    pub fn new(prefix: &str, account: &Account) -> Self {
        let current = task_name(prefix, &account.sid);
        let legacy = account
            .user
            .as_deref()
            .filter(|user| !user.is_empty())
            .map(|user| legacy_task_name(prefix, user))
            .filter(|legacy| !legacy.eq_ignore_ascii_case(&current));
        Self { current, legacy }
    }
}

/// Whose a registered task is, from its definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owner {
    Ours,
    /// Another account's: the principal as the definition names it.
    Other(String),
    /// The definition does not say (no principal, or an account name whose
    /// arguments do not carry this account's state directory).
    Unknown,
}

/// The text of the first `<tag>…</tag>` inside `within` (XML entities
/// decoded), or None.
fn element<'a>(within: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = within.find(&open)? + open.len();
    let end = start + within[start..].find(&close)?;
    Some(within[start..end].trim())
}

/// The part of the definition between `<tag` and `</tag>` (attributes allowed).
fn section<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let start = xml.find(&format!("<{tag}"))?;
    let close = format!("</{tag}>");
    let end = start + xml[start..].find(&close)? + close.len();
    Some(&xml[start..end])
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// A SID in SDDL form: `S-1-` and dash-separated decimal numbers.
fn is_sid(value: &str) -> bool {
    let mut parts = value.split('-');
    parts.next().is_some_and(|s| s.eq_ignore_ascii_case("s")) && parts.next() == Some("1") && {
        let rest: Vec<&str> = parts.collect();
        !rest.is_empty()
            && rest
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    }
}

/// The user part of an account name (`DOMAIN\jo`, `jo@domain`, `jo`).
fn user_part(account: &str) -> &str {
    let after_domain = account.rsplit('\\').next().unwrap_or(account);
    after_domain.split('@').next().unwrap_or(after_domain)
}

/// Whose a task is, from its exported definition (`Export-ScheduledTask`).
/// Only the `<Principals>` section's `<UserId>` counts: the logon trigger
/// has one too.
pub fn task_owner(xml: &str, account: &Account) -> Owner {
    let Some(principal) = section(xml, "Principals")
        .and_then(|principals| element(principals, "UserId"))
        .map(unescape)
        .filter(|id| !id.is_empty())
    else {
        return Owner::Unknown;
    };
    if is_sid(&principal) {
        return if principal.eq_ignore_ascii_case(&account.sid) {
            Owner::Ours
        } else {
            Owner::Other(principal)
        };
    }
    let same_user = account
        .user
        .as_deref()
        .is_some_and(|user| user_part(&principal).eq_ignore_ascii_case(user));
    if !same_user {
        return Owner::Other(principal);
    }
    // The same user name may be another domain's account: its task carries
    // its own profile's state directory, never this one's.
    let wanted = format!(
        "--state-dir {}",
        super::windows_task::quote_arg(&account.state_dir)
    )
    .to_lowercase();
    let carries_our_state_dir = section(xml, "Exec")
        .and_then(|exec| element(exec, "Arguments"))
        .map(|arguments| unescape(arguments).to_lowercase())
        .is_some_and(|arguments| {
            arguments.match_indices(&wanted).any(|(at, _)| {
                at + wanted.len() == arguments.len()
                    || arguments[at + wanted.len()..].starts_with(' ')
            })
        });
    if carries_our_state_dir {
        Owner::Ours
    } else {
        Owner::Unknown
    }
}

/// What the task migration needs from Task Scheduler. Every call is bounded
/// by the implementation.
pub trait Tasks {
    /// Whether a root-folder task of this name is registered. An error when
    /// Task Scheduler cannot say: a failed query must never read as "no task"
    /// (uninstall would report success with the task left behind).
    fn exists(&self, name: &str) -> Result<Presence>;
    /// Its exported XML definition; None when it cannot be read.
    fn definition(&self, name: &str) -> Option<String>;
    /// Register (or replace) `name` from the XML file `xml_file`.
    fn create(&self, name: &str, xml_file: &str) -> Result<()>;
    /// Stop what the task runs now; best effort, bounded.
    fn end(&self, name: &str);
    fn delete(&self, name: &str) -> Result<()>;
}

/// What Task Scheduler says about one task name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Absent,
    Present,
    /// Registered, but this account may not read it: another account's.
    Unreadable,
}

/// Whether this account's own task `name` (a SID name, which no other
/// account registers) is there. Unreadable is an error: it cannot be ours.
fn own_task_exists(tasks: &dyn Tasks, name: &str) -> Result<bool> {
    match tasks.exists(name)? {
        Presence::Absent => Ok(false),
        Presence::Present => Ok(true),
        Presence::Unreadable => {
            anyhow::bail!("the scheduled task `{name}` exists but this account may not read it")
        }
    }
}

/// Whether `schtasks /Query /FO CSV /NH` output lists the root-folder task
/// `name` (names compare without case, as Task Scheduler's do). Each row
/// starts with the quoted task path, `"\<name>",`.
pub fn csv_lists_task(output: &str, name: &str) -> bool {
    let wanted = format!("\"\\{}\",", name.to_lowercase());
    output
        .lines()
        .any(|line| line.trim_start().to_lowercase().starts_with(&wanted))
}

/// The 0.4.x task, as the migration finds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Legacy {
    /// No 0.4.x name, or no task of it visible.
    Absent,
    /// This account's: replaced and deleted by install, update and uninstall.
    Ours(String),
    /// Another account's, or one whose owner cannot be read: never touched.
    NotOurs { name: String, owner: Option<String> },
}

pub fn legacy(tasks: &dyn Tasks, names: &TaskNames, account: &Account) -> Result<Legacy> {
    let Some(name) = names.legacy.as_deref() else {
        return Ok(Legacy::Absent);
    };
    match tasks.exists(name)? {
        Presence::Absent => return Ok(Legacy::Absent),
        // Another account's task of the shared 0.4.x name, as a rule.
        Presence::Unreadable => {
            return Ok(Legacy::NotOurs {
                name: name.to_string(),
                owner: None,
            });
        }
        Presence::Present => {}
    }
    Ok(
        match tasks
            .definition(name)
            .map(|xml| task_owner(&xml, account))
            .unwrap_or(Owner::Unknown)
        {
            Owner::Ours => Legacy::Ours(name.to_string()),
            Owner::Other(owner) => Legacy::NotOurs {
                name: name.to_string(),
                owner: Some(owner),
            },
            Owner::Unknown => Legacy::NotOurs {
                name: name.to_string(),
                owner: None,
            },
        },
    )
}

/// The name a command acts on: the 1.0 task when it is registered, else this
/// account's 0.4.x task (a node updated from 0.4.x that has not run install
/// since), else the 1.0 name (whose absence the command then reports).
pub fn active_name(tasks: &dyn Tasks, names: &TaskNames, account: &Account) -> Result<String> {
    if own_task_exists(tasks, &names.current)? {
        return Ok(names.current.clone());
    }
    Ok(match legacy(tasks, names, account)? {
        Legacy::Ours(name) => name,
        _ => names.current.clone(),
    })
}

fn left_alone_note(name: &str, owner: Option<&str>) -> String {
    match owner {
        Some(owner) => format!(
            "left the scheduled task `{name}` alone: it runs as `{owner}`, another account with this user name"
        ),
        None => format!(
            "left the scheduled task `{name}` alone: it could not be confirmed as this account's. If it is yours (a wsmp 0.4 install), remove it with `schtasks /Delete /TN {name} /F`, or it keeps starting a relay at logon"
        ),
    }
}

/// What [`register`] did.
#[derive(Debug)]
pub struct Registered {
    /// The task registered, which the caller starts: the SID name, or the
    /// 0.4.x name while an update from 0.4.x is on trial.
    pub name: String,
    /// This account's 0.4.x task, deleted.
    pub retired: Option<String>,
    /// This account's 0.4.x task, which could not be deleted: the caller
    /// still starts the 1.0 task, then reports this as an error.
    pub retire_failed: Option<(String, anyhow::Error)>,
    /// A 0.4.x-named task left alone (another account's, or unknown).
    pub left_alone: Option<(String, Option<String>)>,
    /// The 0.4.x task was registered again under its own name: an update
    /// from 0.4.x has not confirmed yet, and its rollback restarts that name.
    pub kept_legacy_name: bool,
}

impl Registered {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            retired: None,
            retire_failed: None,
            left_alone: None,
            kept_legacy_name: false,
        }
    }

    /// Lines for the install output about the 0.4.x task.
    pub fn notes(&self) -> Vec<String> {
        let mut notes = Vec::new();
        if let Some(old) = &self.retired {
            notes.push(format!(
                "replaced the wsmp 0.4 scheduled task `{old}` (named after the user name) with one named after this account's SID"
            ));
        }
        if self.kept_legacy_name {
            notes.push(format!(
                "kept the wsmp 0.4 task name `{}` while an update is on trial (a rollback to 0.4 restarts that task); run `wsmp service install` again once `wsmp update status` shows it confirmed",
                self.name
            ));
        }
        if let Some((name, owner)) = &self.left_alone {
            notes.push(left_alone_note(name, owner.as_deref()));
        }
        notes
    }

    /// The deferred error when the 0.4.x task could not be deleted.
    pub fn into_result(self) -> Result<()> {
        match self.retire_failed {
            Some((old, error)) => Err(error.context(format!(
                "the relay now runs from the new scheduled task, but the wsmp 0.4 task `{old}` could not be deleted, so both start at logon; delete it with `schtasks /Delete /TN {old} /F`, or run this command again"
            ))),
            None => Ok(()),
        }
    }
}

/// End and delete this account's 0.4.x task `old` into `registered`.
fn retire(tasks: &dyn Tasks, old: String, registered: &mut Registered) {
    tasks.end(&old);
    match tasks.delete(&old) {
        Ok(()) => registered.retired = Some(old),
        Err(error) => registered.retire_failed = Some((old, error)),
    }
}

/// Register the relay task from `xml_file`, then retire this account's 0.4.x
/// task (end what it runs, delete it). The 1.0 task is registered first, so
/// a failure leaves the old task in place, never no task; a failed delete is
/// returned in [`Registered::retire_failed`] for the caller to report after
/// it started the 1.0 task. Running it again is safe: `/Create /F` replaces
/// the 1.0 task, and a 0.4.x task already gone is [`Legacy::Absent`].
///
/// `trial_pending`: an update has not confirmed yet. While this account's
/// 0.4.x task is the one registered, its rollback (a 0.4.x build) restarts
/// that name, so the task is registered again under it and nothing moves.
pub fn register(
    tasks: &dyn Tasks,
    names: &TaskNames,
    account: &Account,
    xml_file: &str,
    trial_pending: bool,
) -> Result<Registered> {
    let old = legacy(tasks, names, account)?;
    if trial_pending
        && let Legacy::Ours(old) = &old
        && !own_task_exists(tasks, &names.current)?
    {
        tasks.create(old, xml_file)?;
        let mut registered = Registered::new(old);
        registered.kept_legacy_name = true;
        return Ok(registered);
    }
    tasks.create(&names.current, xml_file)?;
    let mut registered = Registered::new(&names.current);
    match old {
        Legacy::Absent => {}
        Legacy::Ours(old) => retire(tasks, old, &mut registered),
        Legacy::NotOurs { name, owner } => registered.left_alone = Some((name, owner)),
    }
    Ok(registered)
}

/// Move a node updated from 0.4.x onto the 1.0 name, from the definition
/// file its 0.4.x install wrote (the same task, renamed): only when this
/// account's 0.4.x task is registered. With the 1.0 task already there, a
/// 0.4.x task of ours left by a failed delete goes now. None when there was
/// nothing to do. The caller runs it only where the previous build is 1.0 or
/// later (`wsmp update` run by 1.0), never during a trial from 0.4.x.
pub fn migrate(
    tasks: &dyn Tasks,
    names: &TaskNames,
    account: &Account,
    xml_file: &str,
) -> Result<Option<Registered>> {
    let Legacy::Ours(old) = legacy(tasks, names, account)? else {
        return Ok(None);
    };
    if own_task_exists(tasks, &names.current)? {
        let mut registered = Registered::new(&names.current);
        retire(tasks, old, &mut registered);
        return Ok(Some(registered));
    }
    register(tasks, names, account, xml_file, false).map(Some)
}

/// What [`unregister`] did.
#[derive(Debug, Default)]
pub struct Unregistered {
    pub removed: Vec<String>,
    /// A 0.4.x-named task left alone (another account's, or unknown).
    pub left_alone: Option<(String, Option<String>)>,
}

impl Unregistered {
    pub fn notes(&self) -> Vec<String> {
        self.left_alone
            .iter()
            .map(|(name, owner)| left_alone_note(name, owner.as_deref()))
            .collect()
    }
}

/// Uninstall: end and delete the 1.0 task and this account's 0.4.x task.
/// A task already gone is fine; another account's is never touched, and one
/// whose owner cannot be read is reported. An error, before the caller
/// removes anything else, when Task Scheduler cannot be asked or a delete
/// fails.
pub fn unregister(tasks: &dyn Tasks, names: &TaskNames, account: &Account) -> Result<Unregistered> {
    let mut done = Unregistered::default();
    let mut failed = Vec::new();
    let mut targets = Vec::new();
    if own_task_exists(tasks, &names.current)? {
        targets.push(names.current.clone());
    }
    match legacy(tasks, names, account)? {
        Legacy::Absent => {}
        Legacy::Ours(old) => targets.push(old),
        Legacy::NotOurs { name, owner } => done.left_alone = Some((name, owner)),
    }
    for name in targets {
        tasks.end(&name);
        match tasks.delete(&name) {
            Ok(()) => done.removed.push(name),
            Err(error) => failed.push(format!("`{name}`: {error:#}")),
        }
    }
    anyhow::ensure!(
        failed.is_empty(),
        "could not delete the scheduled task {}; delete it with `schtasks /Delete /TN <name> /F`",
        failed.join(", ")
    );
    Ok(done)
}

/// Whether wsmp `version` names its tasks after the SID (1.0 and later), so
/// an update to it may move the task. An older build (or a version that does
/// not parse) would look for the 0.4.x name.
pub fn uses_sid_names(version: &str) -> bool {
    version
        .trim_start_matches('v')
        .split(['.', '-', '+'])
        .next()
        .and_then(|major| major.parse::<u64>().ok())
        .is_some_and(|major| major >= 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    const SID: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";
    const OTHER_SID: &str = "S-1-5-21-2004336348-2177238915-782003330-1001";
    const STATE: &str = r"C:\Users\jo\AppData\Local\ws-model-proxy";

    fn account() -> Account {
        Account {
            sid: SID.into(),
            user: Some("jo".into()),
            state_dir: STATE.into(),
        }
    }

    /// The definition 0.4.3 and 1.0 register: the principal and arguments.
    fn definition(principal: &str, state_dir: &str) -> String {
        let arguments = super::super::windows_task::arguments(
            r"C:\Users\jo\.cargo\bin\wsmp.exe",
            r"C:\Users\jo\AppData\Roaming\ws-model-proxy\config.toml",
            state_dir,
            r"C:\Users\jo\AppData\Local\ws-model-proxy\logs\relay.log",
        );
        let xml = super::super::windows_task::render_xml(principal, &arguments, r"C:\Users\jo");
        // Export-ScheduledTask writes the logon trigger's user as an account name.
        xml.replacen(
            &format!("<UserId>{principal}</UserId>"),
            "<UserId>WORKSTATION\\jo</UserId>",
            1,
        )
    }

    /// A Task Scheduler in memory: registered tasks and their definitions,
    /// every call recorded.
    #[derive(Default)]
    struct FakeTasks {
        tasks: RefCell<BTreeMap<String, Option<String>>>,
        calls: RefCell<Vec<String>>,
        fail_delete: RefCell<Vec<String>>,
        fail_create: bool,
        fail_query: bool,
        unreadable: RefCell<Vec<String>>,
    }

    impl FakeTasks {
        fn with(tasks: &[(&str, Option<String>)]) -> Self {
            let fake = Self::default();
            for (name, xml) in tasks {
                fake.tasks.borrow_mut().insert((*name).into(), xml.clone());
            }
            fake
        }
        fn names(&self) -> Vec<String> {
            self.tasks.borrow().keys().cloned().collect()
        }
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl Tasks for FakeTasks {
        fn exists(&self, name: &str) -> Result<Presence> {
            anyhow::ensure!(
                !self.fail_query,
                "the Task Scheduler service is not available"
            );
            if self.unreadable.borrow().iter().any(|n| n == name) {
                return Ok(Presence::Unreadable);
            }
            Ok(if self.tasks.borrow().contains_key(name) {
                Presence::Present
            } else {
                Presence::Absent
            })
        }
        fn definition(&self, name: &str) -> Option<String> {
            self.tasks.borrow().get(name).cloned().flatten()
        }
        fn create(&self, name: &str, xml_file: &str) -> Result<()> {
            self.calls
                .borrow_mut()
                .push(format!("create {name} {xml_file}"));
            anyhow::ensure!(!self.fail_create, "access denied");
            self.tasks
                .borrow_mut()
                .insert(name.into(), Some(definition(SID, STATE)));
            Ok(())
        }
        fn end(&self, name: &str) {
            self.calls.borrow_mut().push(format!("end {name}"));
        }
        fn delete(&self, name: &str) -> Result<()> {
            self.calls.borrow_mut().push(format!("delete {name}"));
            anyhow::ensure!(
                !self.fail_delete.borrow().iter().any(|n| n == name),
                "access denied"
            );
            anyhow::ensure!(self.tasks.borrow_mut().remove(name).is_some(), "not found");
            Ok(())
        }
    }

    fn relay_names() -> TaskNames {
        TaskNames::new(RELAY_PREFIX, &account())
    }

    #[test]
    fn names_derive_from_the_sid_and_the_old_ones_from_the_user_name() {
        let names = relay_names();
        assert_eq!(names.current, format!("wsmp-relay-{SID}"));
        assert_eq!(names.legacy.as_deref(), Some("wsmp-relay-jo"));
        let deadman = TaskNames::new(DEADMAN_PREFIX, &account());
        assert_eq!(deadman.current, format!("wsmp-update-deadman-{SID}"));
        assert_eq!(deadman.legacy.as_deref(), Some("wsmp-update-deadman-jo"));
        // Two accounts with one user name: one 0.4.x name, two 1.0 names.
        let other = Account {
            sid: OTHER_SID.into(),
            ..account()
        };
        let theirs = TaskNames::new(RELAY_PREFIX, &other);
        assert_eq!(theirs.legacy, names.legacy);
        assert_ne!(theirs.current, names.current);
        // 0.4.x sanitized the user name the same way.
        assert_eq!(
            legacy_task_name(RELAY_PREFIX, r"Jo Doe\x"),
            "wsmp-relay-Jo_Doe_x"
        );
        assert_eq!(task_name(RELAY_PREFIX, "S-1-5-18"), "wsmp-relay-S-1-5-18");
        let no_user = Account {
            user: None,
            ..account()
        };
        assert_eq!(TaskNames::new(RELAY_PREFIX, &no_user).legacy, None);
        let empty_user = Account {
            user: Some(String::new()),
            ..account()
        };
        assert_eq!(TaskNames::new(RELAY_PREFIX, &empty_user).legacy, None);
    }

    #[test]
    fn ownership_reads_the_principal_not_the_logon_trigger() {
        assert_eq!(task_owner(&definition(SID, STATE), &account()), Owner::Ours);
        assert_eq!(
            task_owner(&definition(&SID.to_lowercase(), STATE), &account()),
            Owner::Ours
        );
        assert_eq!(
            task_owner(&definition(OTHER_SID, STATE), &account()),
            Owner::Other(OTHER_SID.into())
        );
        // A principal stored as an account name: the user part must match and
        // the arguments must carry this account's state directory.
        let named = |principal: &str, state: &str| {
            definition(SID, state).replacen(
                &format!("<UserId>{SID}</UserId>"),
                &format!("<UserId>{principal}</UserId>"),
                1,
            )
        };
        assert_eq!(
            task_owner(&named(r"DOMAINA\jo", STATE), &account()),
            Owner::Ours
        );
        assert_eq!(
            task_owner(&named("JO", &STATE.to_uppercase()), &account()),
            Owner::Ours
        );
        // DOMAINB\jo has its own profile, so its own state directory.
        assert_eq!(
            task_owner(
                &named(
                    r"DOMAINB\jo",
                    r"C:\Users\jo.DOMAINB\AppData\Local\ws-model-proxy"
                ),
                &account()
            ),
            Owner::Unknown
        );
        // A longer path that merely starts with ours is not ours.
        assert_eq!(
            task_owner(&named(r"DOMAINB\jo", &format!("{STATE}2")), &account()),
            Owner::Unknown
        );
        assert_eq!(
            task_owner(&named(r"DOMAINA\alice", STATE), &account()),
            Owner::Other(r"DOMAINA\alice".into())
        );
        assert_eq!(task_owner("<Task/>", &account()), Owner::Unknown);
        assert_eq!(task_owner("", &account()), Owner::Unknown);
        // A state directory with spaces is quoted in the arguments.
        let spaced = Account {
            state_dir: r"C:\Users\Jo Doe\AppData\Local\ws-model-proxy".into(),
            user: Some("Jo Doe".into()),
            ..account()
        };
        assert_eq!(
            task_owner(&named(r"PC\Jo Doe", &spaced.state_dir), &spaced),
            Owner::Ours
        );
    }

    #[test]
    fn sids_are_recognized() {
        assert!(is_sid(SID));
        assert!(is_sid("s-1-5-18"));
        assert!(!is_sid("S-1-"));
        assert!(!is_sid("S-1"));
        assert!(!is_sid("S-2-5-18"));
        assert!(!is_sid("jo"));
        assert!(!is_sid(r"DOMAIN\S-1-5-18"));
    }

    #[test]
    fn a_fresh_install_registers_only_the_sid_name() {
        let tasks = FakeTasks::default();
        let registered =
            register(&tasks, &relay_names(), &account(), "def.xml", false).expect("register");
        assert_eq!(tasks.names(), [relay_names().current]);
        assert!(registered.notes().is_empty());
        assert!(registered.into_result().is_ok());
        assert_eq!(
            tasks.calls(),
            [format!("create {} def.xml", relay_names().current)]
        );
    }

    #[test]
    fn install_over_0_4_3_replaces_our_old_task_without_a_duplicate() {
        let names = relay_names();
        let tasks = FakeTasks::with(&[("wsmp-relay-jo", Some(definition(SID, STATE)))]);
        assert_eq!(
            active_name(&tasks, &names, &account()).expect("active"),
            "wsmp-relay-jo"
        );
        let registered = register(&tasks, &names, &account(), "def.xml", false).expect("register");
        assert_eq!(registered.retired.as_deref(), Some("wsmp-relay-jo"));
        assert_eq!(tasks.names(), std::slice::from_ref(&names.current));
        // Registered first, then the old one ended and deleted.
        assert_eq!(
            tasks.calls(),
            [
                format!("create {} def.xml", names.current),
                "end wsmp-relay-jo".into(),
                "delete wsmp-relay-jo".into(),
            ]
        );
        assert_eq!(
            active_name(&tasks, &names, &account()).expect("active"),
            names.current
        );
        assert!(
            registered.notes()[0].contains("replaced the wsmp 0.4 scheduled task `wsmp-relay-jo`")
        );
        // Idempotent: a second install only replaces the new task.
        let again = register(&tasks, &names, &account(), "def.xml", false).expect("again");
        assert!(again.retired.is_none() && again.left_alone.is_none());
        assert_eq!(tasks.names(), [names.current]);
    }

    #[test]
    fn another_accounts_task_of_the_old_name_is_never_touched() {
        let names = relay_names();
        let theirs = definition(OTHER_SID, STATE);
        let tasks = FakeTasks::with(&[("wsmp-relay-jo", Some(theirs.clone()))]);
        // Not ours, so commands do not act on it.
        assert_eq!(
            active_name(&tasks, &names, &account()).expect("active"),
            names.current
        );
        let registered = register(&tasks, &names, &account(), "def.xml", false).expect("register");
        assert_eq!(
            registered.left_alone,
            Some(("wsmp-relay-jo".into(), Some(OTHER_SID.into())))
        );
        assert!(registered.notes()[0].contains("another account with this user name"));
        assert_eq!(
            tasks.names(),
            [names.current.clone(), "wsmp-relay-jo".into()]
        );
        assert_eq!(tasks.tasks.borrow()["wsmp-relay-jo"], Some(theirs));
        assert!(
            !tasks
                .calls()
                .iter()
                .any(|call| call.ends_with("wsmp-relay-jo"))
        );
        // Uninstall removes ours only.
        let removed = unregister(&tasks, &names, &account()).expect("uninstall");
        assert_eq!(removed.removed, [names.current]);
        assert!(removed.notes()[0].contains("another account with this user name"));
        assert_eq!(tasks.names(), ["wsmp-relay-jo"]);
    }

    #[test]
    fn an_old_task_whose_owner_cannot_be_read_is_left_with_a_note() {
        let names = relay_names();
        let tasks = FakeTasks::with(&[("wsmp-relay-jo", None)]);
        let registered = register(&tasks, &names, &account(), "def.xml", false).expect("register");
        assert_eq!(registered.left_alone, Some(("wsmp-relay-jo".into(), None)));
        let note = registered.notes().join("\n");
        assert!(
            note.contains("schtasks /Delete /TN wsmp-relay-jo /F"),
            "{note}"
        );
        assert!(tasks.names().contains(&"wsmp-relay-jo".to_string()));
    }

    #[test]
    fn a_failed_create_leaves_the_old_task_running() {
        let names = relay_names();
        let tasks = FakeTasks {
            fail_create: true,
            ..FakeTasks::with(&[("wsmp-relay-jo", Some(definition(SID, STATE)))])
        };
        assert!(register(&tasks, &names, &account(), "def.xml", false).is_err());
        assert_eq!(tasks.names(), ["wsmp-relay-jo"]);
        assert!(
            !tasks
                .calls()
                .iter()
                .any(|call| call.starts_with("end") || call.starts_with("delete"))
        );
    }

    #[test]
    fn a_failed_delete_is_reported_after_the_new_task_is_registered_and_retried_next_time() {
        let names = relay_names();
        let tasks = FakeTasks::with(&[("wsmp-relay-jo", Some(definition(SID, STATE)))]);
        tasks.fail_delete.borrow_mut().push("wsmp-relay-jo".into());
        let registered = register(&tasks, &names, &account(), "def.xml", false).expect("register");
        assert!(registered.retired.is_none());
        let error = format!("{:#}", registered.into_result().expect_err("reported"));
        assert!(
            error.contains("schtasks /Delete /TN wsmp-relay-jo /F"),
            "{error}"
        );
        assert!(error.contains("access denied"), "{error}");
        // Commands now act on the new task.
        assert_eq!(
            active_name(&tasks, &names, &account()).expect("active"),
            names.current
        );
        // The next update (or install) deletes it.
        tasks.fail_delete.borrow_mut().clear();
        let moved = migrate(&tasks, &names, &account(), "def.xml")
            .expect("migrate")
            .expect("retired");
        assert_eq!(moved.retired.as_deref(), Some("wsmp-relay-jo"));
        assert_eq!(tasks.names(), [names.current]);
    }

    #[test]
    fn update_moves_a_0_4_3_task_from_its_definition_file_once() {
        let names = relay_names();
        let tasks = FakeTasks::with(&[("wsmp-relay-jo", Some(definition(SID, STATE)))]);
        let moved = migrate(&tasks, &names, &account(), r"C:\state\wsmp-relay-task.xml")
            .expect("migrate")
            .expect("moved");
        assert_eq!(moved.retired.as_deref(), Some("wsmp-relay-jo"));
        assert_eq!(
            tasks.calls()[0],
            format!(r"create {} C:\state\wsmp-relay-task.xml", names.current)
        );
        assert_eq!(tasks.names(), std::slice::from_ref(&names.current));
        // Nothing left to move: no call at all.
        let calls = tasks.calls().len();
        assert!(
            migrate(&tasks, &names, &account(), "x")
                .expect("again")
                .is_none()
        );
        assert_eq!(tasks.calls().len(), calls);
        // A fresh 1.0 install, or another account's old task: nothing moves.
        let fresh = FakeTasks::default();
        assert!(
            migrate(&fresh, &names, &account(), "x")
                .expect("fresh")
                .is_none()
        );
        assert!(fresh.names().is_empty());
        let theirs = FakeTasks::with(&[("wsmp-relay-jo", Some(definition(OTHER_SID, STATE)))]);
        assert!(
            migrate(&theirs, &names, &account(), "x")
                .expect("theirs")
                .is_none()
        );
        assert_eq!(theirs.names(), ["wsmp-relay-jo"]);
    }

    #[test]
    fn uninstall_removes_the_new_and_our_old_task_and_is_idempotent() {
        let names = relay_names();
        let tasks = FakeTasks::with(&[
            ("wsmp-relay-jo", Some(definition(SID, STATE))),
            (names.current.as_str(), Some(definition(SID, STATE))),
        ]);
        let removed = unregister(&tasks, &names, &account()).expect("uninstall");
        assert_eq!(
            removed.removed,
            [names.current.clone(), "wsmp-relay-jo".into()]
        );
        assert!(tasks.names().is_empty());
        assert!(
            unregister(&tasks, &names, &account())
                .expect("again")
                .removed
                .is_empty()
        );
        // Only the old one (a node updated from 0.4.3 that never re-installed).
        let old_only = FakeTasks::with(&[("wsmp-relay-jo", Some(definition(SID, STATE)))]);
        assert_eq!(
            unregister(&old_only, &names, &account())
                .expect("old")
                .removed,
            ["wsmp-relay-jo"]
        );
        // A failed delete is an error naming the task.
        let stuck = FakeTasks::with(&[(names.current.as_str(), Some(definition(SID, STATE)))]);
        stuck.fail_delete.borrow_mut().push(names.current.clone());
        let error = format!(
            "{:#}",
            unregister(&stuck, &names, &account()).expect_err("stuck")
        );
        assert!(error.contains(&names.current), "{error}");
    }

    #[test]
    fn a_failed_query_is_an_error_never_no_task() {
        let names = relay_names();
        let tasks = FakeTasks {
            fail_query: true,
            ..FakeTasks::with(&[(names.current.as_str(), Some(definition(SID, STATE)))])
        };
        assert!(active_name(&tasks, &names, &account()).is_err());
        assert!(register(&tasks, &names, &account(), "def.xml", false).is_err());
        assert!(migrate(&tasks, &names, &account(), "def.xml").is_err());
        let error = format!(
            "{:#}",
            unregister(&tasks, &names, &account()).expect_err("query")
        );
        assert!(error.contains("not available"), "{error}");
        // Nothing was deleted or created.
        assert_eq!(tasks.names(), std::slice::from_ref(&names.current));
        assert!(tasks.calls().is_empty(), "{:?}", tasks.calls());
    }

    #[test]
    fn uninstall_reports_an_old_task_it_cannot_confirm_as_ours() {
        let names = relay_names();
        let tasks = FakeTasks::with(&[
            ("wsmp-relay-jo", None),
            (names.current.as_str(), Some(definition(SID, STATE))),
        ]);
        let done = unregister(&tasks, &names, &account()).expect("uninstall");
        assert_eq!(done.removed, std::slice::from_ref(&names.current));
        let notes = done.notes().join("\n");
        assert!(
            notes.contains("schtasks /Delete /TN wsmp-relay-jo /F"),
            "{notes}"
        );
        assert_eq!(tasks.names(), ["wsmp-relay-jo"]);
    }

    /// Codex review: `wsmp service install` while a 0.4.3 -> 1.0 update is on
    /// trial must keep the 0.4.x name, which a rollback to 0.4.3 restarts.
    #[test]
    fn install_during_a_trial_from_0_4_keeps_the_old_name_until_it_confirms() {
        let names = relay_names();
        let tasks = FakeTasks::with(&[("wsmp-relay-jo", Some(definition(SID, STATE)))]);
        let registered = register(&tasks, &names, &account(), "def.xml", true).expect("register");
        assert_eq!(registered.name, "wsmp-relay-jo");
        assert!(registered.kept_legacy_name && registered.retired.is_none());
        assert_eq!(tasks.names(), ["wsmp-relay-jo"]);
        assert_eq!(tasks.calls(), ["create wsmp-relay-jo def.xml"]);
        assert!(registered.notes()[0].contains("on trial"));
        // Confirmed: the next install moves it.
        let moved = register(&tasks, &names, &account(), "def.xml", false).expect("moved");
        assert_eq!(moved.name, names.current);
        assert_eq!(moved.retired.as_deref(), Some("wsmp-relay-jo"));
        // A trial on a node already on the SID name (an update from 1.0) changes nothing.
        let fresh = FakeTasks::default();
        let registered = register(&fresh, &names, &account(), "def.xml", true).expect("fresh");
        assert_eq!(registered.name, names.current);
        assert!(!registered.kept_legacy_name);
    }

    #[test]
    fn the_task_listing_is_read_by_exact_root_name() {
        let listing = "\r\nINFO: ignored\r\n\"\\Microsoft\\Windows\\wsmp-relay-jo\",\"N/A\",\"Ready\"\r\n\"\\wsmp-relay-jo2\",\"N/A\",\"Ready\"\r\n\"\\WSMP-Relay-S-1-5-18\",\"11/13/2026 9:00:00 AM\",\"Running\"\r\n";
        assert!(csv_lists_task(listing, "wsmp-relay-S-1-5-18"));
        assert!(
            !csv_lists_task(listing, "wsmp-relay-jo"),
            "a subfolder or a longer name is not it"
        );
        assert!(csv_lists_task(listing, "wsmp-relay-jo2"));
        assert!(!csv_lists_task("", "wsmp-relay-jo"));
    }

    /// Two accounts with one user name, without administrator rights: the
    /// other account's 0.4.x task cannot even be read.
    #[test]
    fn an_old_task_this_account_may_not_read_is_another_accounts() {
        let names = relay_names();
        let tasks = FakeTasks::with(&[("wsmp-relay-jo", Some(definition(OTHER_SID, STATE)))]);
        tasks.unreadable.borrow_mut().push("wsmp-relay-jo".into());
        let registered = register(&tasks, &names, &account(), "def.xml", false).expect("register");
        assert_eq!(registered.name, names.current);
        assert_eq!(registered.left_alone, Some(("wsmp-relay-jo".into(), None)));
        assert!(
            !tasks
                .calls()
                .iter()
                .any(|call| call.ends_with("wsmp-relay-jo"))
        );
        let done = unregister(&tasks, &names, &account()).expect("uninstall");
        assert_eq!(done.removed, std::slice::from_ref(&names.current));
        // Our own SID name unreadable cannot happen quietly.
        tasks.unreadable.borrow_mut().push(names.current.clone());
        assert!(active_name(&tasks, &names, &account()).is_err());
    }

    #[test]
    fn only_1_0_and_later_use_sid_names() {
        assert!(uses_sid_names("1.0.0"));
        assert!(uses_sid_names("v1.2.3-rc.1"));
        assert!(uses_sid_names("2.0.0"));
        assert!(!uses_sid_names("0.4.3"));
        assert!(!uses_sid_names("0.9.9"));
        assert!(!uses_sid_names(""));
        assert!(!uses_sid_names("main"));
    }
}
