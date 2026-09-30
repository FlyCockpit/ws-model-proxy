//! Path policy: the protected set, optional `fileRoots`, special-file trees,
//! and the root-user refusal (plan sections 3.2, 3.3 and 11).
//!
//! Every path decision goes through [`Policy::check_path`] on the **physical**
//! path of the held parent directory fd (see `resolve`), never on the string the
//! caller supplied. Protected files are additionally matched by inode
//! ([`Policy::check_identity`]), so a hard link or a moved directory cannot be
//! used to reach them.
//!
//! This is defense in depth, not a boundary against an `unsupervised` shell.

use std::path::{Path, PathBuf};

use super::error::{ErrorCode, FileError, FileResult};
use super::resolve::Stat;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    /// Create, replace, edit, or move onto a path.
    Write,
    /// Delete or move away a path: like `Write`, and additionally refused for
    /// any directory that contains a protected path (removing or renaming it
    /// would relocate the protected files).
    Remove,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deny {
    /// The agent may neither read nor write it.
    ReadWrite,
    /// The agent may read it, but not change it.
    WriteOnly,
}

#[derive(Debug, Clone)]
pub struct Protected {
    pub path: PathBuf,
    /// The entry covers everything below `path` too.
    pub subtree: bool,
    pub deny: Deny,
}

#[derive(Debug, Clone)]
pub struct Policy {
    roots: Vec<PathBuf>,
    roots_required: bool,
    roots_usable: bool,
    protected: Vec<Protected>,
    euid: u32,
    allow_root: bool,
}

/// Trees that are not regular-file storage.
const SPECIAL_TREES: [&str; 3] = ["/proc", "/sys", "/dev"];

impl Policy {
    /// Crate-private on purpose: a policy built outside
    /// [`Self::from_environment`] could omit the protected set.
    pub(crate) fn new(roots: Vec<PathBuf>, protected: Vec<Protected>, allow_root: bool) -> Self {
        let roots_required = !roots.is_empty();
        // Resolve the complete allowlist once. A single invalid root disables
        // the whole list; retain intent so an empty result still denies all.
        let roots = crate::config::validate_file_roots(&roots, None).unwrap_or_default();
        let roots_usable = !roots.is_empty();
        Self {
            roots,
            roots_required,
            roots_usable,
            protected: with_physical_aliases(protected),
            euid: nix::unistd::geteuid().as_raw(),
            allow_root,
        }
    }

    /// The built-in protected set for this installation: wsmp state files and
    /// `service.env` are neither readable nor writable, `config.json` is
    /// readable but not writable (a write could raise the CLI's own mode).
    pub fn from_environment(roots: Vec<PathBuf>, allow_root: bool) -> Self {
        Self::new(roots, default_protected(), allow_root)
    }

    /// Test seam: pretend the daemon runs as `euid`.
    #[cfg(test)]
    pub(crate) fn with_euid(mut self, euid: u32) -> Self {
        self.euid = euid;
        self
    }

    pub fn allow_root(&self) -> bool {
        self.allow_root
    }

    pub fn euid(&self) -> u32 {
        self.euid
    }

    pub fn roots_configured(&self) -> bool {
        self.roots_usable
    }

    /// File tools refuse to run as root unless `allowFileToolsAsRoot`.
    pub fn check_process(&self) -> FileResult<()> {
        if self.euid == 0 && !self.allow_root {
            return Err(FileError::new(
                ErrorCode::Unsupported,
                "file tools are disabled while the daemon runs as root; set allowFileToolsAsRoot to enable them",
            ));
        }
        Ok(())
    }

    /// Decide on the physical path `full`.
    pub fn check_path(&self, access: Access, full: &Path) -> FileResult<()> {
        if full.to_str().is_none() {
            return Err(FileError::invalid("path is not valid UTF-8"));
        }
        if SPECIAL_TREES.iter().any(|tree| full.starts_with(tree)) {
            return Err(FileError::new(
                ErrorCode::SpecialFile,
                "this tree holds special files and is not accessible",
            ));
        }
        if access != Access::Read && super::redact::is_secret_scope(full) {
            return Err(FileError::new(
                ErrorCode::SecretFile,
                "secret files and their directories are read-only through the file tools",
            ));
        }
        if self.roots_required && !self.roots.iter().any(|root| full.starts_with(root)) {
            return Err(FileError::denied(
                "path is outside the configured file roots",
            ));
        }
        self.check_beneath(full)?;
        for entry in &self.protected {
            let inside = full == entry.path || (entry.subtree && full.starts_with(&entry.path));
            let blocked = match entry.deny {
                Deny::ReadWrite => true,
                Deny::WriteOnly => access != Access::Read,
            };
            if inside && blocked {
                return Err(FileError::denied("path is protected by wsmp"));
            }
            if access == Access::Remove && entry.path.starts_with(full) {
                return Err(FileError::denied(
                    "path contains protected wsmp files and cannot be removed or moved",
                ));
            }
        }
        Ok(())
    }

    /// Kernel second guard on Linux, using nix's safe openat2 wrapper.
    /// ENOSYS alone falls back to the existing physical-fd policy. Missing
    /// leaves are allowed here so creation can use the held, checked parent.
    fn check_beneath(&self, full: &Path) -> FileResult<()> {
        #[cfg(target_os = "linux")]
        if self.roots_required {
            use nix::fcntl::{OFlag, OpenHow, ResolveFlag, open, openat2};
            use nix::sys::stat::Mode;
            let root = self
                .roots
                .iter()
                .find(|root| full.starts_with(root))
                .ok_or_else(|| FileError::denied("path is outside the configured file roots"))?;
            let fd = open(
                root,
                OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| FileError::denied("configured file root is unavailable"))?;
            let relative = full
                .strip_prefix(root)
                .map_err(|_| FileError::denied("path is outside the configured file roots"))?;
            let relative = if relative.as_os_str().is_empty() {
                Path::new(".")
            } else {
                relative
            };
            match openat2(
                fd,
                relative,
                OpenHow::new()
                    .flags(OFlag::O_PATH | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW)
                    .resolve(ResolveFlag::RESOLVE_BENEATH | ResolveFlag::RESOLVE_NO_MAGICLINKS),
            ) {
                Ok(_) | Err(nix::errno::Errno::ENOSYS | nix::errno::Errno::ENOENT) => {}
                Err(_) => return Err(FileError::denied("path failed the kernel file-root guard")),
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = full;
        Ok(())
    }

    /// Match an opened object against protected files by inode.
    pub fn check_identity(&self, access: Access, stat: &Stat) -> FileResult<()> {
        for entry in self.protected.iter().filter(|e| !e.subtree) {
            let blocked = match entry.deny {
                Deny::ReadWrite => true,
                Deny::WriteOnly => access != Access::Read,
            };
            if !blocked {
                continue;
            }
            match std::fs::metadata(&entry.path) {
                Ok(meta) => {
                    let protected = Stat::from_metadata(&meta);
                    if protected.dev == stat.dev && protected.ino == stat.ino {
                        return Err(FileError::denied("path is protected by wsmp"));
                    }
                }
                // An absent protected file has no identity to match; any other
                // failure means the identity cannot be checked, so refuse.
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err(FileError::denied(
                        "path is protected by wsmp (identity check failed)",
                    ));
                }
            }
        }
        Ok(())
    }

    /// Whether a directory entry should be skipped by recursive walks: special
    /// trees and read-denied protected entries are never traversed.
    pub fn hidden_from_walk(&self, full: &Path) -> bool {
        self.check_path(Access::Read, full).is_err()
    }
}

/// `path` with its deepest existing ancestor resolved to the physical path
/// (`WSMP_STATE_DIR` may be reached through a symlink, and the leaf may not
/// exist yet). Resolution compares physical paths, so a protected entry must be
/// expressed as one too.
fn physical(path: &Path) -> PathBuf {
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    let mut base = path;
    loop {
        if let Ok(real) = std::fs::canonicalize(base) {
            let mut out = real;
            out.extend(rest.iter().rev());
            return out;
        }
        match (base.parent(), base.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name);
                base = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Every protected entry under both its configured and its physical name.
fn with_physical_aliases(protected: Vec<Protected>) -> Vec<Protected> {
    let mut out = Vec::with_capacity(protected.len() * 2);
    for entry in protected {
        let real = physical(&entry.path);
        if real != entry.path {
            out.push(Protected {
                path: real,
                subtree: entry.subtree,
                deny: entry.deny,
            });
        }
        out.push(entry);
    }
    out
}

fn default_protected() -> Vec<Protected> {
    let mut out = Vec::new();
    let file = |path: PathBuf, deny| Protected {
        path,
        subtree: false,
        deny,
    };
    if let Ok(state) = crate::paths::state_dir() {
        for name in [
            "device-auth.json",
            "terminal-identity.json",
            "terminal-approvals.json",
            "terminal-approval-pending.json",
            "instances.json",
            "relay-control.sock",
        ] {
            out.push(file(state.join(name), Deny::ReadWrite));
        }
    }
    if let Ok(config) = crate::paths::config_dir() {
        out.push(file(config.join("service.env"), Deny::ReadWrite));
    }
    if let Ok(config_file) = crate::paths::config_file() {
        let lock = config_file.with_extension("json.lock");
        out.push(file(lock, Deny::WriteOnly));
        out.push(file(config_file, Deny::WriteOnly));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(roots: &[&str], protected: Vec<Protected>) -> Policy {
        Policy::new(roots.iter().map(PathBuf::from).collect(), protected, false)
    }

    fn entry(path: &str, subtree: bool, deny: Deny) -> Protected {
        Protected {
            path: PathBuf::from(path),
            subtree,
            deny,
        }
    }

    #[test]
    fn protected_table() {
        let p = policy(
            &[],
            vec![
                entry("/state/device-auth.json", false, Deny::ReadWrite),
                entry("/cfg/config.json", false, Deny::WriteOnly),
                entry("/vault", true, Deny::ReadWrite),
            ],
        );
        let cases: &[(Access, &str, Option<ErrorCode>)] = &[
            (
                Access::Read,
                "/state/device-auth.json",
                Some(ErrorCode::PathDenied),
            ),
            (
                Access::Write,
                "/state/device-auth.json",
                Some(ErrorCode::PathDenied),
            ),
            (Access::Read, "/state/other.json", None),
            (Access::Read, "/cfg/config.json", None),
            (
                Access::Write,
                "/cfg/config.json",
                Some(ErrorCode::PathDenied),
            ),
            (
                Access::Remove,
                "/cfg/config.json",
                Some(ErrorCode::PathDenied),
            ),
            (
                Access::Read,
                "/vault/deep/file",
                Some(ErrorCode::PathDenied),
            ),
            (Access::Read, "/vaultx/file", None),
            // moving or deleting an ancestor would relocate protected files
            (Access::Remove, "/state", Some(ErrorCode::PathDenied)),
            (Access::Remove, "/", Some(ErrorCode::PathDenied)),
            (Access::Write, "/state", None),
            (Access::Read, "/state", None),
            (Access::Remove, "/statex", None),
            (
                Access::Read,
                "/proc/self/environ",
                Some(ErrorCode::SpecialFile),
            ),
            (Access::Write, "/dev/null", Some(ErrorCode::SpecialFile)),
            (Access::Read, "/sys/kernel", Some(ErrorCode::SpecialFile)),
            (Access::Read, "/procs/x", None),
        ];
        for (access, path, expected) in cases {
            let got = p.check_path(*access, Path::new(path)).err().map(|e| e.code);
            assert_eq!(&got, expected, "{access:?} {path}");
        }
    }

    #[test]
    fn roots_confine_by_component() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        std::fs::create_dir(&root).unwrap();
        let p = Policy::new(vec![root.clone()], vec![], false);
        let inside = std::fs::canonicalize(&root).unwrap().join("a/b");
        assert!(p.check_path(Access::Read, &inside).is_ok());
        assert!(
            p.check_path(Access::Read, &std::fs::canonicalize(&root).unwrap())
                .is_ok()
        );
        let sibling = std::fs::canonicalize(dir.path())
            .unwrap()
            .join("models-evil/a");
        assert_eq!(
            p.check_path(Access::Read, &sibling).unwrap_err().code,
            ErrorCode::PathDenied
        );
        assert_eq!(
            p.check_path(Access::Read, Path::new("/etc/passwd"))
                .unwrap_err()
                .code,
            ErrorCode::PathDenied
        );
        assert!(p.roots_configured());
    }

    #[test]
    fn broken_root_never_becomes_unconfined_even_if_recreated() {
        let dir = tempfile::tempdir().expect("dir");
        let gone = dir.path().join("gone");
        let policy = Policy::new(vec![gone.clone()], vec![], false);
        assert!(!policy.roots_configured());
        std::fs::create_dir(&gone).expect("recreate");
        for path in [gone.join("file"), dir.path().join("outside")] {
            assert_eq!(
                policy
                    .check_path(Access::Read, &path)
                    .expect_err("denied")
                    .code,
                ErrorCode::PathDenied
            );
            assert_eq!(
                policy
                    .check_path(Access::Write, &path)
                    .expect_err("denied")
                    .code,
                ErrorCode::PathDenied
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn kernel_beneath_guard_rejects_intermediate_escape() {
        let dir = tempfile::tempdir().expect("dir");
        let root = dir.path().join("models");
        std::fs::create_dir(&root).expect("root");
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).expect("outside");
        std::fs::write(outside.join("plain"), "plain").expect("file");
        std::os::unix::fs::symlink(&outside, root.join("escape")).expect("symlink");
        let policy = Policy::new(vec![root.clone()], vec![], false);
        assert_eq!(
            policy
                .check_path(Access::Read, &root.join("escape/plain"))
                .expect_err("kernel guard")
                .code,
            ErrorCode::PathDenied
        );
        std::fs::write(root.join("plain"), "plain").expect("file");
        assert!(policy.check_path(Access::Read, &root.join("plain")).is_ok());
    }

    #[test]
    fn root_user_refused_unless_allowed() {
        let denied = Policy::new(vec![], vec![], false).with_euid(0);
        assert_eq!(
            denied.check_process().unwrap_err().code,
            ErrorCode::Unsupported
        );
        let allowed = Policy::new(vec![], vec![], true).with_euid(0);
        assert!(allowed.check_process().is_ok());
        let user = Policy::new(vec![], vec![], false).with_euid(1000);
        assert!(user.check_process().is_ok());
    }

    #[test]
    fn non_utf8_path_is_invalid_input() {
        use std::os::unix::ffi::OsStrExt;
        let p = policy(&[], vec![]);
        let bad = PathBuf::from(std::ffi::OsStr::from_bytes(b"/tmp/\xff\xfe"));
        assert_eq!(
            p.check_path(Access::Read, &bad).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
}
