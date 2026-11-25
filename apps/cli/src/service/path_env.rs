//! What the service pins: the config and state paths, and the installing
//! shell's `PATH` without the directories of its own session, with what
//! `wsmp service install` reports about them.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

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
    // The installing shell's PATH, frozen at install time, without the
    // directories that end with its shell or login session; re-run install
    // to refresh it. Skipped when unset, not UTF-8, or nothing usable is left.
    if let Some(path) = std::env::var("PATH").ok().and_then(|path| {
        service_path(&path, inspect_service_path_dir, &SessionDirs::current()).path
    }) {
        pinned.push(("PATH", path));
    }
    Ok(pinned)
}

/// Why a directory on the installing shell's `PATH` lets another account
/// plant a program the service runs. Reported by `wsmp service install`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathDirRisk {
    /// Writable by every account (`mode & 0o002`): dropped from the pinned PATH.
    WorldWritable { mode: u32 },
    /// Writable by the members of a group other than the installer's own
    /// private group: kept, with a warning.
    GroupWritable {
        mode: u32,
        gid: u32,
        group: Option<String>,
    },
    /// Owned by an account other than root and the installer: kept, with a
    /// warning (its owner can write it whatever the mode says).
    OtherOwner { uid: u32, owner: Option<String> },
}

impl PathDirRisk {
    /// Kept on the pinned PATH despite the risk (see [`review_service_path`]).
    fn kept(&self) -> bool {
        !matches!(self, Self::WorldWritable { .. })
    }
}

/// The installing shell's `PATH` reduced to what a service should search,
/// and the directories on it that other accounts can write.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ServicePath {
    /// Absolute existing directories, each once, in order, without the
    /// world-writable ones. None when nothing is left.
    pub path: Option<String>,
    /// Each directory with a [`PathDirRisk`], in `PATH` order; world-writable
    /// ones were dropped, the others are in `path`.
    pub risky: Vec<(PathBuf, Vec<PathDirRisk>)>,
    /// Directories left off because they belong to the installing login
    /// session or shell ([`service_path`]), in `PATH` order.
    pub session: Vec<SessionEntry>,
}

/// Why a `PATH` directory of the installing shell is gone once that shell
/// or login session ends, so a unit must not pin it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionScope {
    /// One shell's own directory (fnm's `fnm_multishells/<id>`).
    Shell,
    /// The login session's runtime directory (`/run/user/<uid>`,
    /// `$XDG_RUNTIME_DIR`): a tmpfs removed when the last session ends.
    Login,
    /// A temporary directory (`/tmp`, `/var/tmp`, `$TMPDIR`), cleared at boot
    /// or by age.
    Temporary,
}

/// A session directory [`service_path`] left off, and the stable directory
/// it put in its place, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEntry {
    pub dir: PathBuf,
    pub scope: SessionScope,
    pub replacement: Option<PathBuf>,
}

/// Where this system keeps per-session directories, read once from the
/// environment ([`SessionDirs::current`]) or given by a test.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionDirs {
    /// `$XDG_RUNTIME_DIR` when it is under `/run` or `/var/run` (where logind
    /// puts it); `/run/user/<uid>` counts whatever it says.
    pub runtime_dir: Option<PathBuf>,
    /// `$TMPDIR` when it is macOS's per-user temporary directory
    /// (`/var/folders/...`). Elsewhere a `$TMPDIR` can be a long-lived
    /// scratch area holding real installs (an HPC `/scratch`), so it is not
    /// taken to mean "temporary".
    pub temp_dir: Option<PathBuf>,
    /// Candidates for fnm's stable default-version directory
    /// (`<fnm dir>/aliases/default/bin`), in preference order.
    pub fnm_default_bins: Vec<PathBuf>,
}

/// Temporary directories on every Unix (`/private/...` is macOS's real path).
const TEMPORARY_ROOTS: &[&str] = &["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"];

impl SessionDirs {
    pub fn current() -> Self {
        Self::from_vars(|name| std::env::var_os(name), dirs::home_dir())
    }

    /// [`Self::current`] from given variables and home directory.
    pub fn from_vars(
        var: impl Fn(&str) -> Option<std::ffi::OsString>,
        home: Option<PathBuf>,
    ) -> Self {
        let absolute = |name: &str| {
            var(name)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        };
        let strictly_under = |dir: &Path, roots: &[&str]| {
            roots
                .iter()
                .any(|root| dir.starts_with(root) && dir != Path::new(root))
        };
        let runtime_dir =
            absolute("XDG_RUNTIME_DIR").filter(|dir| strictly_under(dir, &["/run", "/var/run"]));
        let temp_dir = absolute("TMPDIR")
            .filter(|dir| strictly_under(dir, &["/var/folders", "/private/var/folders"]));
        let mut fnm_dirs: Vec<PathBuf> = Vec::new();
        fnm_dirs.extend(absolute("FNM_DIR"));
        if let Some(data) = absolute("XDG_DATA_HOME") {
            fnm_dirs.push(data.join("fnm"));
        }
        if let Some(home) = &home {
            fnm_dirs.push(home.join(".local/share/fnm"));
            fnm_dirs.push(home.join(".fnm"));
            fnm_dirs.push(home.join("Library/Application Support/fnm"));
        }
        SessionDirs {
            runtime_dir,
            temp_dir,
            fnm_default_bins: fnm_dirs
                .into_iter()
                .map(|dir| dir.join("aliases/default/bin"))
                .collect(),
        }
    }

    /// Whether `dir` lives only as long as the installing shell or session.
    pub fn scope_of(&self, dir: &Path) -> Option<SessionScope> {
        if dir
            .components()
            .any(|part| part.as_os_str() == "fnm_multishells")
        {
            return Some(SessionScope::Shell);
        }
        if dir.starts_with("/run/user")
            || self
                .runtime_dir
                .as_deref()
                .is_some_and(|runtime| dir.starts_with(runtime))
        {
            return Some(SessionScope::Login);
        }
        if TEMPORARY_ROOTS.iter().any(|root| dir.starts_with(root))
            || self
                .temp_dir
                .as_deref()
                .is_some_and(|temp| dir.starts_with(temp))
        {
            return Some(SessionScope::Temporary);
        }
        None
    }

    /// fnm's default-version directory to search instead of a per-shell one:
    /// the first candidate that outlives the session and is `installed`.
    fn fnm_default_bin(&self, installed: impl Fn(&Path) -> bool) -> Option<PathBuf> {
        self.fnm_default_bins
            .iter()
            .find(|candidate| self.scope_of(candidate).is_none() && installed(candidate))
            .cloned()
    }
}

/// The service's `PATH` from the installing shell's: [`review_service_path`]
/// after leaving off every directory that ends with the shell or login
/// session ([`SessionDirs::scope_of`]); a unit started at boot would
/// otherwise search directories that no longer exist (or that someone else's
/// later session reuses). fnm's per-shell directory is replaced by fnm's
/// default-version directory when it exists, so the service still finds
/// Node; `fnm default <version>` changes which one.
pub fn service_path(
    path: &str,
    inspect: impl Fn(&Path) -> Option<Vec<PathDirRisk>>,
    session: &SessionDirs,
) -> ServicePath {
    let mut kept: Vec<PathBuf> = Vec::new();
    let mut dropped = Vec::new();
    for dir in std::env::split_paths(path) {
        match dir.is_absolute().then(|| session.scope_of(&dir)).flatten() {
            None => kept.push(dir),
            Some(scope) => {
                if dropped.iter().any(|entry: &SessionEntry| entry.dir == dir) {
                    continue;
                }
                let replacement = (scope == SessionScope::Shell)
                    .then(|| session.fnm_default_bin(|candidate| inspect(candidate).is_some()))
                    .flatten();
                if let Some(stable) = &replacement {
                    kept.push(stable.clone());
                }
                dropped.push(SessionEntry {
                    dir,
                    scope,
                    replacement,
                });
            }
        }
    }
    let joined = std::env::join_paths(&kept)
        .ok()
        .and_then(|joined| joined.into_string().ok())
        .unwrap_or_default();
    let mut review = review_service_path(&joined, inspect);
    review.session = dropped;
    review
}

/// The `wsmp service install` notes for [`ServicePath::session`].
pub fn session_path_notes(session: &[SessionEntry]) -> Vec<String> {
    let mut lines = Vec::new();
    for entry in session {
        let why = match entry.scope {
            SessionScope::Shell => "it belongs to this one shell (fnm's per-shell directory)",
            SessionScope::Login => {
                "it is in this login session's runtime directory, which is removed at logout"
            }
            SessionScope::Temporary => "it is a temporary directory",
        };
        lines.push(format!(
            "left `{}` off the service's PATH: {why}",
            entry.dir.display()
        ));
        match (&entry.replacement, entry.scope) {
            (Some(stable), _) => lines.push(format!(
                "  the service uses fnm's default Node instead: `{}` (`fnm default <version>` changes it)",
                stable.display()
            )),
            (None, SessionScope::Shell) => lines.push(
                "  fnm has no default version, so the service will not find Node: run \
                 `fnm default <version>`, then `wsmp service install` again"
                    .to_owned(),
            ),
            (None, _) => {}
        }
    }
    lines
}

/// Reduce `path` for the service. `inspect` returns None for a directory to
/// skip silently (missing, not a directory) and otherwise its risks. Empty
/// and relative entries (which would resolve against the service's working
/// directory) are dropped, and so is a world-writable directory; a directory
/// with only group-write or foreign-owner risks is kept (the service must
/// still find the same engines as the installing shell) and reported.
pub fn review_service_path(
    path: &str,
    inspect: impl Fn(&Path) -> Option<Vec<PathDirRisk>>,
) -> ServicePath {
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut risky = Vec::new();
    for dir in std::env::split_paths(path) {
        if dir.as_os_str().is_empty() || !dir.is_absolute() || seen.contains(&dir) {
            continue;
        }
        seen.push(dir.clone());
        let Some(risks) = inspect(&dir) else {
            continue;
        };
        let keep = risks.iter().all(PathDirRisk::kept);
        if !risks.is_empty() {
            risky.push((dir.clone(), risks));
        }
        if keep {
            dirs.push(dir);
        }
    }
    let path = if dirs.is_empty() {
        None
    } else {
        std::env::join_paths(dirs)
            .ok()
            .and_then(|joined| joined.into_string().ok())
    };
    ServicePath {
        path,
        risky,
        session: Vec::new(),
    }
}

/// The facts [`path_dir_risks`] judges, read from one directory.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(not(unix), allow(dead_code))]
struct DirFacts {
    mode: u32,
    uid: u32,
    gid: u32,
}

/// The installing account: who may own PATH directories, and which group is
/// its own private one (only it is a member).
#[derive(Debug, Clone, Copy)]
#[cfg_attr(not(unix), allow(dead_code))]
struct Installer {
    uid: u32,
    /// The primary gid when it is a user private group (named like the user,
    /// no other members); None otherwise.
    private_gid: Option<u32>,
}

/// The risks of one existing directory. Root and the installer may own it;
/// group write is fine only for root's group (gid 0) on a root-owned
/// directory, or for the installer's private group.
#[cfg_attr(not(unix), allow(dead_code))]
fn path_dir_risks(
    facts: DirFacts,
    installer: Installer,
    group_name: impl Fn(u32) -> Option<String>,
    user_name: impl Fn(u32) -> Option<String>,
) -> Vec<PathDirRisk> {
    let mut risks = Vec::new();
    if facts.mode & 0o002 != 0 {
        risks.push(PathDirRisk::WorldWritable {
            mode: facts.mode & 0o7777,
        });
    }
    let trusted_group =
        (facts.gid == 0 && facts.uid == 0) || installer.private_gid == Some(facts.gid);
    if facts.mode & 0o020 != 0 && !trusted_group {
        risks.push(PathDirRisk::GroupWritable {
            mode: facts.mode & 0o7777,
            gid: facts.gid,
            group: group_name(facts.gid),
        });
    }
    if facts.uid != 0 && facts.uid != installer.uid {
        risks.push(PathDirRisk::OtherOwner {
            uid: facts.uid,
            owner: user_name(facts.uid),
        });
    }
    risks
}

/// Whether a `/etc/passwd` text names an account other than `user` whose
/// primary group is `gid` (it can write that group's directories too).
#[cfg_attr(not(unix), allow(dead_code))]
fn primary_group_of_another(passwd: &str, gid: u32, user: &str) -> bool {
    passwd.lines().any(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        fields.len() >= 4
            && !line.starts_with('#')
            && fields[0] != user
            && fields[3].parse::<u32>() == Ok(gid)
    })
}

/// [`review_service_path`]'s inspector for this system: None for a missing
/// entry or a non-directory (the target of a symlink counts), else its risks.
#[cfg_attr(not(any(target_os = "linux", target_os = "macos")), allow(dead_code))]
pub(crate) fn inspect_service_path_dir(dir: &Path) -> Option<Vec<PathDirRisk>> {
    let metadata = fs::metadata(dir).ok()?;
    if !metadata.is_dir() {
        return None;
    }
    #[cfg(unix)]
    {
        use nix::unistd::{Gid, Group, Uid, User};
        use std::os::unix::fs::MetadataExt;
        let uid = Uid::effective();
        let user = User::from_uid(uid).ok().flatten();
        let gid = Gid::effective();
        // A user private group: named like the user, no other listed member,
        // and no other local account with it as its primary group (members
        // by primary gid are not listed in `group.mem`).
        // Unreadable: not provably private, so warn (fail closed).
        let passwd = fs::read_to_string("/etc/passwd").ok();
        let private_gid = match (user, Group::from_gid(gid).ok().flatten(), passwd) {
            (Some(user), Some(group), Some(passwd))
                if group.name == user.name
                    && group.mem.iter().all(|m| *m == user.name)
                    && !primary_group_of_another(&passwd, gid.as_raw(), &user.name) =>
            {
                Some(gid.as_raw())
            }
            _ => None,
        };
        Some(path_dir_risks(
            DirFacts {
                mode: metadata.mode(),
                uid: metadata.uid(),
                gid: metadata.gid(),
            },
            Installer {
                uid: uid.as_raw(),
                private_gid,
            },
            |gid| {
                Group::from_gid(Gid::from_raw(gid))
                    .ok()
                    .flatten()
                    .map(|group| group.name)
            },
            |uid| {
                User::from_uid(Uid::from_raw(uid))
                    .ok()
                    .flatten()
                    .map(|user| user.name)
            },
        ))
    }
    #[cfg(not(unix))]
    {
        Some(Vec::new())
    }
}

/// The `wsmp service install` warning for [`ServicePath::risky`]: each
/// directory, why, and how to tighten it. Empty when nothing is risky.
pub fn service_path_warnings(risky: &[(PathBuf, Vec<PathDirRisk>)]) -> Vec<String> {
    if risky.is_empty() {
        return Vec::new();
    }
    let kept = risky
        .iter()
        .filter(|(_, risks)| risks.iter().all(PathDirRisk::kept))
        .count();
    let mut lines = vec![format!(
        "warning: {} director{} on your PATH can be written by other accounts; a program planted there runs as this service (as you) when it starts an engine:",
        risky.len(),
        if risky.len() == 1 { "y" } else { "ies" }
    )];
    for (dir, risks) in risky {
        let shown = dir.display();
        let dropped = !risks.iter().all(PathDirRisk::kept);
        let mut why = Vec::new();
        let mut fix = Vec::new();
        for risk in risks {
            match risk {
                PathDirRisk::WorldWritable { mode } => {
                    why.push(format!("writable by every account (mode {mode:04o})"));
                    fix.push(format!("`chmod o-w {shown}`"));
                }
                PathDirRisk::GroupWritable { mode, gid, group } => {
                    let group = match group {
                        Some(name) => format!("`{name}` (gid {gid})"),
                        None => format!("gid {gid}"),
                    };
                    why.push(format!(
                        "writable by every member of group {group} (mode {mode:04o})"
                    ));
                    fix.push(format!("`chmod g-w {shown}` (as its owner, or with sudo)"));
                }
                PathDirRisk::OtherOwner { uid, owner } => {
                    let owner = match owner {
                        Some(name) => format!("`{name}` (uid {uid})"),
                        None => format!("uid {uid}"),
                    };
                    why.push(format!("owned by {owner}, who can always write it"));
                    fix.push(
                        "have root `chown` it to root or to you, or keep it off the service's PATH"
                            .to_owned(),
                    );
                }
            }
        }
        lines.push(format!(
            "  {shown}: {}; {}. To tighten: {}",
            why.join(", "),
            if dropped {
                "left OFF the service's PATH"
            } else {
                "kept on the service's PATH"
            },
            fix.join(", then ")
        ));
    }
    if kept > 0 {
        lines.push(
            "  to keep a directory off the service's PATH instead, re-run with it removed, e.g. \
             `PATH=/usr/local/bin:/usr/bin:/bin wsmp service install`; after tightening, re-run \
             `wsmp service install` to refresh this check"
                .to_owned(),
        );
    } else {
        lines.push("  after tightening, re-run `wsmp service install` to put it back on the service's PATH".to_owned());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn risks_for(dir: &Path) -> Option<Vec<PathDirRisk>> {
        match dir.to_str()? {
            "/missing" => None,
            "/tmp/open" => Some(vec![PathDirRisk::WorldWritable { mode: 0o1777 }]),
            "/usr/local/bin" => Some(vec![PathDirRisk::GroupWritable {
                mode: 0o2775,
                gid: 50,
                group: Some("staff".to_owned()),
            }]),
            "/opt/alice/bin" => Some(vec![PathDirRisk::OtherOwner {
                uid: 1001,
                owner: Some("alice".to_owned()),
            }]),
            _ => Some(Vec::new()),
        }
    }

    #[cfg(unix)]
    fn session_dirs() -> SessionDirs {
        SessionDirs {
            runtime_dir: Some(PathBuf::from("/run/user/1000")),
            temp_dir: Some(PathBuf::from("/var/folders/xy/T")),
            fnm_default_bins: vec![
                PathBuf::from("/opt/fnm-not-installed/aliases/default/bin"),
                PathBuf::from("/home/me/.local/share/fnm/aliases/default/bin"),
            ],
        }
    }

    #[cfg(unix)]
    fn installed_dirs(dir: &Path) -> Option<Vec<PathDirRisk>> {
        match dir.to_str()? {
            "/opt/fnm-not-installed/aliases/default/bin" | "/missing" => None,
            _ => Some(Vec::new()),
        }
    }

    /// The Ubuntu 26.04 field bug: the unit pinned
    /// `/run/user/1000/fnm_multishells/<id>/bin` from the installing shell.
    /// Every directory that ends with the shell or login session is left
    /// off, fnm's per-shell one is replaced by fnm's default (once), and the
    /// stable entries keep their order.
    #[cfg(unix)]
    #[test]
    fn service_path_leaves_off_session_directories_and_uses_fnms_default() {
        let review = service_path(
            "/run/user/1000/fnm_multishells/4123_1763040000000/bin:/home/me/.cargo/bin:\
             /run/user/1000/bin:/tmp/build/bin:/var/folders/xy/T/tool/bin:/usr/local/bin:\
             /usr/bin:/home/me/.cache/fnm_multishells/99/bin:/var/tmp/x:/bin",
            installed_dirs,
            &session_dirs(),
        );
        assert_eq!(
            review.path.as_deref(),
            Some(
                "/home/me/.local/share/fnm/aliases/default/bin:/home/me/.cargo/bin:\
                 /usr/local/bin:/usr/bin:/bin"
            )
        );
        let scopes: Vec<(&str, SessionScope, bool)> = review
            .session
            .iter()
            .map(|entry| {
                (
                    entry.dir.to_str().expect("utf-8"),
                    entry.scope,
                    entry.replacement.is_some(),
                )
            })
            .collect();
        assert_eq!(
            scopes,
            [
                (
                    "/run/user/1000/fnm_multishells/4123_1763040000000/bin",
                    SessionScope::Shell,
                    true
                ),
                ("/run/user/1000/bin", SessionScope::Login, false),
                ("/tmp/build/bin", SessionScope::Temporary, false),
                ("/var/folders/xy/T/tool/bin", SessionScope::Temporary, false),
                (
                    "/home/me/.cache/fnm_multishells/99/bin",
                    SessionScope::Shell,
                    true
                ),
                ("/var/tmp/x", SessionScope::Temporary, false),
            ]
        );
        let notes = session_path_notes(&review.session);
        assert!(
            notes[0].starts_with(
                "left `/run/user/1000/fnm_multishells/4123_1763040000000/bin` off the service's PATH"
            ) && notes[1].contains("/home/me/.local/share/fnm/aliases/default/bin"),
            "{notes:?}"
        );
        // The rendered unit carries no session directory at all.
        let unit = crate::service::text::render_systemd_user_unit(
            "/home/me/.cargo/bin/wsmp",
            &[("PATH", review.path.expect("a PATH"))],
        )
        .expect("unit");
        assert!(!unit.contains("/run/user") && !unit.contains("fnm_multishells"));
        assert!(!unit.contains("/tmp/"), "{unit}");
    }

    /// `/run/user/<uid>` is a login directory even when `XDG_RUNTIME_DIR`
    /// is unset (an `su` shell, a cron job); without fnm's default the
    /// install says how to give the service a Node.
    #[cfg(unix)]
    #[test]
    fn service_path_without_runtime_dir_or_fnm_default() {
        let session = SessionDirs::default();
        let review = service_path(
            "/run/user/1000/fnm_multishells/1_2/bin:/usr/bin:/run/user/1000/fnm_multishells/1_2/bin",
            installed_dirs,
            &session,
        );
        assert_eq!(review.path.as_deref(), Some("/usr/bin"));
        assert_eq!(review.session.len(), 1, "a repeated entry is noted once");
        let notes = session_path_notes(&review.session);
        assert!(notes[1].contains("`fnm default <version>`"), "{notes:?}");
        // Nothing but session directories: no PATH pinned at all.
        assert_eq!(
            service_path("/run/user/1000/bin:/tmp/x", installed_dirs, &session).path,
            None
        );
        // Lookalikes are not session directories.
        for stable in [
            "/run/users/bin",
            "/run/systemd/bin",
            "/tmpfoo/bin",
            "/opt/run/user/bin",
        ] {
            assert_eq!(session.scope_of(Path::new(stable)), None, "{stable}");
        }
    }

    /// Only where the system keeps per-session directories counts: a
    /// `$TMPDIR` scratch area (HPC `/scratch`) or a `$XDG_RUNTIME_DIR`
    /// pointing at home keeps the installs under it on the PATH.
    #[cfg(unix)]
    #[test]
    fn session_dirs_trust_only_system_session_roots() {
        fn vars(
            pairs: &'static [(&'static str, &'static str)],
        ) -> impl Fn(&str) -> Option<std::ffi::OsString> {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| std::ffi::OsString::from(value))
            }
        }
        let home = Some(PathBuf::from("/home/me"));
        let odd = SessionDirs::from_vars(
            vars(&[("TMPDIR", "/scratch"), ("XDG_RUNTIME_DIR", "/home/me")]),
            home.clone(),
        );
        assert_eq!((&odd.runtime_dir, &odd.temp_dir), (&None, &None));
        assert_eq!(
            service_path(
                "/scratch/me/miniconda/bin:/home/me/.cargo/bin:/run/user/1000/bin",
                installed_dirs,
                &odd
            )
            .path
            .as_deref(),
            Some("/scratch/me/miniconda/bin:/home/me/.cargo/bin")
        );
        let usual = SessionDirs::from_vars(
            vars(&[
                ("TMPDIR", "/var/folders/xy/abc/T/"),
                ("XDG_RUNTIME_DIR", "/run/user/1000"),
                ("FNM_DIR", "/opt/fnm"),
            ]),
            home,
        );
        assert_eq!(
            usual.runtime_dir.as_deref(),
            Some(Path::new("/run/user/1000"))
        );
        assert_eq!(
            usual.temp_dir.as_deref(),
            Some(Path::new("/var/folders/xy/abc/T/"))
        );
        assert_eq!(
            usual.fnm_default_bins[0],
            PathBuf::from("/opt/fnm/aliases/default/bin")
        );
        assert_eq!(
            usual.scope_of(Path::new("/var/folders/xy/abc/T/fnm/bin")),
            Some(SessionScope::Temporary)
        );
        // The roots themselves are never taken as the session directory.
        let roots = SessionDirs::from_vars(
            vars(&[("TMPDIR", "/var/folders"), ("XDG_RUNTIME_DIR", "/run")]),
            None,
        );
        assert_eq!((&roots.runtime_dir, &roots.temp_dir), (&None, &None));
    }

    #[cfg(unix)]
    #[test]
    fn service_path_keeps_only_absolute_usable_directories_once() {
        let review = review_service_path(
            "/usr/bin::relative/bin:./bin:/tmp/open:/missing:/usr/bin:/home/me/.local/bin:",
            risks_for,
        );
        assert_eq!(review.path.as_deref(), Some("/usr/bin:/home/me/.local/bin"));
        assert_eq!(
            review.risky,
            vec![(
                PathBuf::from("/tmp/open"),
                vec![PathDirRisk::WorldWritable { mode: 0o1777 }]
            )]
        );
        assert_eq!(review_service_path("", risks_for), ServicePath::default());
        assert_eq!(
            review_service_path(":relative:/missing", risks_for).path,
            None
        );
    }

    /// C-12: group-writable and foreign-owned directories stay on the pinned
    /// PATH (the service must find the same engines) and are reported once,
    /// in PATH order; a world-writable one is still dropped.
    #[cfg(unix)]
    #[test]
    fn service_path_keeps_group_writable_and_foreign_owned_directories_and_reports_them() {
        let review = review_service_path(
            "/usr/local/bin:/usr/bin:/opt/alice/bin:/tmp/open:/usr/local/bin",
            risks_for,
        );
        assert_eq!(
            review.path.as_deref(),
            Some("/usr/local/bin:/usr/bin:/opt/alice/bin")
        );
        let dirs: Vec<_> = review.risky.iter().map(|(dir, _)| dir.clone()).collect();
        assert_eq!(
            dirs,
            ["/usr/local/bin", "/opt/alice/bin", "/tmp/open"].map(PathBuf::from)
        );
        let warning = service_path_warnings(&review.risky).join("\n");
        assert!(
            warning.starts_with(
                "warning: 3 directories on your PATH can be written by other accounts"
            ),
            "{warning}"
        );
        assert!(warning.contains(
            "  /usr/local/bin: writable by every member of group `staff` (gid 50) (mode 2775); kept on the service's PATH. To tighten: `chmod g-w /usr/local/bin`"
        ), "{warning}");
        assert!(warning.contains(
            "  /opt/alice/bin: owned by `alice` (uid 1001), who can always write it; kept on the service's PATH. To tighten: have root `chown` it"
        ), "{warning}");
        assert!(warning.contains(
            "  /tmp/open: writable by every account (mode 1777); left OFF the service's PATH. To tighten: `chmod o-w /tmp/open`"
        ), "{warning}");
        assert!(
            warning.contains("wsmp service install`; after tightening"),
            "{warning}"
        );
        assert!(service_path_warnings(&[]).is_empty());
        let one = service_path_warnings(&review.risky[2..]);
        assert!(
            one[0].starts_with("warning: 1 directory on your PATH"),
            "{one:?}"
        );
        assert!(
            one.last().is_some_and(|line| line.contains("put it back")),
            "{one:?}"
        );
    }

    #[test]
    fn path_dir_risks_trust_root_the_installer_and_its_private_group_only() {
        let me = Installer {
            uid: 1000,
            private_gid: Some(1000),
        };
        let names = |id: u32| Some(format!("name{id}"));
        let risks = |mode, uid, gid, installer| {
            path_dir_risks(DirFacts { mode, uid, gid }, installer, names, names)
        };
        // Root's and the installer's own directories, 0755 or private-group 0775.
        assert!(risks(0o40755, 0, 0, me).is_empty());
        assert!(risks(0o40775, 0, 0, me).is_empty());
        assert!(risks(0o40755, 1000, 1000, me).is_empty());
        assert!(risks(0o40775, 1000, 1000, me).is_empty());
        assert!(risks(0o40755, 1000, 50, me).is_empty());
        // Debian's historical root:staff 2775 /usr/local/bin.
        assert_eq!(
            risks(0o42775, 0, 50, me),
            vec![PathDirRisk::GroupWritable {
                mode: 0o2775,
                gid: 50,
                group: Some("name50".to_owned())
            }]
        );
        // A root-owned directory whose group is someone's private group.
        assert_eq!(risks(0o40775, 0, 1000, me), Vec::new());
        assert_eq!(
            risks(0o40775, 0, 1001, me).len(),
            1,
            "another account's group can write it"
        );
        // A shared primary group (e.g. `users`) is not private.
        let shared = Installer {
            uid: 1000,
            private_gid: None,
        };
        assert_eq!(risks(0o40775, 1000, 100, shared).len(), 1);
        // Another account's directory, whatever its mode.
        assert_eq!(
            risks(0o40755, 1001, 1001, me),
            vec![PathDirRisk::OtherOwner {
                uid: 1001,
                owner: Some("name1001".to_owned())
            }]
        );
        // Everything at once; world-writable is what drops it.
        let all = risks(0o40777, 1001, 1001, me);
        assert_eq!(all.len(), 3, "{all:?}");
        assert!(matches!(all[0], PathDirRisk::WorldWritable { mode: 0o777 }));
        assert!(!all.iter().all(PathDirRisk::kept));
    }

    #[test]
    fn a_group_another_account_has_as_its_primary_group_is_not_private() {
        let passwd = "root:x:0:0:root:/root:/bin/bash\n\
                      jo:x:1000:1000:Jo:/home/jo:/bin/bash\n\
                      # comment:x:1:1000\n\
                      svc:x:1001:1000::/srv:/usr/sbin/nologin\n";
        assert!(primary_group_of_another(passwd, 1000, "jo"));
        assert!(
            primary_group_of_another(passwd, 1000, "svc"),
            "jo has it too"
        );
        assert!(!primary_group_of_another(passwd, 0, "root"));
        assert!(!primary_group_of_another(
            "jo:x:1000:1000::/home/jo:/bin/sh\n",
            1000,
            "jo"
        ));
        assert!(!primary_group_of_another("", 1000, "jo"));
    }

    #[cfg(unix)]
    #[test]
    fn inspect_service_path_dir_reads_real_directories() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().expect("tempdir");
        let private = root.path().join("private");
        let open = root.path().join("open");
        let group = root.path().join("group");
        let file = root.path().join("file");
        fs::create_dir(&private).expect("private");
        fs::create_dir(&open).expect("open");
        fs::create_dir(&group).expect("group");
        fs::write(&file, b"").expect("file");
        fs::set_permissions(&private, fs::Permissions::from_mode(0o755)).expect("chmod");
        fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).expect("chmod");
        fs::set_permissions(&group, fs::Permissions::from_mode(0o775)).expect("chmod");
        assert_eq!(inspect_service_path_dir(&private), Some(Vec::new()));
        let open_risks = inspect_service_path_dir(&open).expect("a directory");
        assert!(
            open_risks
                .iter()
                .any(|risk| matches!(risk, PathDirRisk::WorldWritable { .. })),
            "{open_risks:?}"
        );
        // Group write on our own directory is a risk unless the group is our
        // private one; either way the directory is kept.
        let group_risks = inspect_service_path_dir(&group).expect("a directory");
        assert!(group_risks.iter().all(PathDirRisk::kept), "{group_risks:?}");
        assert_eq!(inspect_service_path_dir(&file), None);
        assert_eq!(inspect_service_path_dir(&root.path().join("missing")), None);
        let path = format!(
            "{}:{}:{}",
            private.display(),
            open.display(),
            group.display()
        );
        let review = review_service_path(&path, inspect_service_path_dir);
        assert_eq!(
            review.path,
            Some(format!("{}:{}", private.display(), group.display()))
        );
    }
}
