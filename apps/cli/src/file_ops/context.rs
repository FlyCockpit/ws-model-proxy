//! What the file tools share while they run, one layer below the [`FileOps`]
//! facade: the policy, the per-daemon etag key, the budgets, the step hook and
//! the path and namespace locks. The facade owns one [`OpContext`] and hands it
//! to every tool; the tools, the atomic replace and the recovery journal take
//! it instead of the facade, so none of them knows [`FileOps`].
//!
//! [`FileOps`]: super::FileOps

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use super::error::{ErrorCode, FileError, FileResult};
use super::fs::etag::EtagKey;
use super::fs::policy::Policy;
#[cfg(windows)]
use super::fs::resolve;
#[cfg(not(windows))]
use super::redact;
use super::{Cancel, Limits, Step, StepHook};

/// The state every tool works with: plain parts, each with its own interface.
pub struct OpContext {
    pub(crate) policy: Policy,
    pub(crate) key: EtagKey,
    pub(crate) limits: Limits,
    pub(crate) hook: Hook,
    pub(crate) locks: Locks,
}

impl OpContext {
    pub(crate) fn new(policy: Policy, key: EtagKey, limits: Limits, hook: Hook) -> Self {
        Self {
            locks: Locks::new(limits.lock_wait),
            policy,
            key,
            limits,
            hook,
        }
    }
}

/// The optional observer of a mutation's [`Step`]s (test fault injection and
/// race tests); without one every step passes.
#[derive(Default)]
pub(crate) struct Hook(Option<StepHook>);

impl Hook {
    pub(crate) fn new(hook: StepHook) -> Self {
        Self(Some(hook))
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn step(&self, step: Step) -> FileResult<()> {
        match &self.0 {
            Some(hook) => hook(step),
            None => Ok(()),
        }
    }
}

/// The path locks and the namespace guard, waiting at most `wait` for either.
#[derive(Debug)]
pub(crate) struct Locks {
    paths: PathLocks,
    namespace: Namespace,
    wait: Duration,
}

impl Locks {
    pub(crate) fn new(wait: Duration) -> Self {
        Self {
            paths: PathLocks::default(),
            namespace: Namespace::default(),
            wait,
        }
    }

    /// Shared namespace guard for a file mutation (see [`Namespace`]).
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn namespace_shared(&self, cancel: &Cancel) -> FileResult<NamespaceGuard<'_>> {
        self.namespace.acquire(false, cancel, self.wait)
    }

    /// Exclusive namespace guard for a rename or delete.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn namespace_exclusive(&self, cancel: &Cancel) -> FileResult<NamespaceGuard<'_>> {
        self.namespace.acquire(true, cancel, self.wait)
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn lock_path(&self, path: PathBuf, cancel: &Cancel) -> FileResult<PathGuard<'_>> {
        self.paths.lock(lock_key(path), cancel, self.wait)
    }

    /// Lock both names of a rename: in key order, so two renames cannot
    /// deadlock each other, and once when they share a key (a case-only rename
    /// names one file, and taking its lock twice would wait on itself).
    pub(crate) fn lock_pair(
        &self,
        a: PathBuf,
        b: PathBuf,
        cancel: &Cancel,
    ) -> FileResult<(PathGuard<'_>, Option<PathGuard<'_>>)> {
        let (a, b) = (lock_key(a), lock_key(b));
        let (first, second) = if a <= b { (a, b) } else { (b, a) };
        let wait = self.wait;
        let held = self.paths.lock(first.clone(), cancel, wait)?;
        let other = if second == first {
            None
        } else {
            Some(self.paths.lock(second, cancel, wait)?)
        };
        Ok((held, other))
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
/// At most one mutating operation per physical path at a time.
#[derive(Debug, Default)]
struct PathLocks {
    held: Mutex<HashSet<PathBuf>>,
    released: Condvar,
}

/// Namespace guard: file mutations (edit, write, mkdir) share it; rename and
/// delete hold it exclusively, so a directory cannot be moved or removed while a
/// change below it is in flight (its path lock and its held parent fd would
/// otherwise name different directories). Reads do not take it.
#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Debug, Default)]
struct Namespace {
    state: Mutex<NsState>,
    changed: Condvar,
}

#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Debug, Default)]
struct NsState {
    shared: usize,
    exclusive: bool,
    /// Exclusive requests waiting: new shared holders queue behind them, so a
    /// steady stream of edits cannot starve a rename or delete.
    waiting_exclusive: usize,
}

#[cfg_attr(not(unix), allow(dead_code))]
pub struct NamespaceGuard<'a> {
    ns: &'a Namespace,
    exclusive: bool,
}

impl Drop for NamespaceGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.ns.state.lock() {
            if self.exclusive {
                state.exclusive = false;
            } else {
                state.shared -= 1;
            }
        }
        self.ns.changed.notify_all();
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
impl Namespace {
    fn acquire(
        &self,
        exclusive: bool,
        cancel: &Cancel,
        wait: Duration,
    ) -> FileResult<NamespaceGuard<'_>> {
        let deadline = std::time::Instant::now() + wait;
        let poisoned = || FileError::new(ErrorCode::IoError, "lock poisoned");
        let mut state = self.state.lock().map_err(|_| poisoned())?;
        if exclusive {
            state.waiting_exclusive += 1;
        }
        let blocked = |state: &NsState| {
            state.exclusive
                || (exclusive && state.shared > 0)
                || (!exclusive && state.waiting_exclusive > 0)
        };
        let result = loop {
            if !blocked(&state) {
                break Ok(());
            }
            if let Err(err) = cancel.check() {
                break Err(err);
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                break Err(FileError::new(
                    ErrorCode::Timeout,
                    "another change is still in progress; retry",
                ));
            }
            let slice = (deadline - now).min(Duration::from_millis(50));
            state = match self.changed.wait_timeout(state, slice) {
                Ok((state, _)) => state,
                Err(_) => return Err(poisoned()),
            };
        };
        if exclusive {
            state.waiting_exclusive -= 1;
        }
        if let Err(err) = result {
            drop(state);
            // a departing waiter may unblock shared requests queued behind it
            self.changed.notify_all();
            return Err(err);
        }
        if exclusive {
            state.exclusive = true;
        } else {
            state.shared += 1;
        }
        Ok(NamespaceGuard {
            ns: self,
            exclusive,
        })
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
pub struct PathGuard<'a> {
    locks: &'a PathLocks,
    path: PathBuf,
}

impl Drop for PathGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut held) = self.locks.held.lock() {
            held.remove(&self.path);
        }
        self.locks.released.notify_all();
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
impl PathLocks {
    fn lock(&self, path: PathBuf, cancel: &Cancel, wait: Duration) -> FileResult<PathGuard<'_>> {
        let deadline = std::time::Instant::now() + wait;
        let mut held = self
            .held
            .lock()
            .map_err(|_| FileError::new(ErrorCode::IoError, "lock poisoned"))?;
        while held.contains(&path) {
            cancel.check()?;
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err(FileError::new(
                    ErrorCode::Timeout,
                    "another change to this path is still in progress",
                ));
            }
            let slice = (deadline - now).min(Duration::from_millis(50));
            held = self
                .released
                .wait_timeout(held, slice)
                .map_err(|_| FileError::new(ErrorCode::IoError, "lock poisoned"))?
                .0;
        }
        held.insert(path.clone());
        Ok(PathGuard { locks: self, path })
    }
}

/// The key a path is locked under: on Windows its POSIX view lower-cased, as
/// NTFS compares names (`Notes.txt` and `notes.txt` are one file, and `\\?\C:\`
/// and `C:\` one drive); on Unix the path folded as the policy folds it, since
/// a macOS (APFS, HFS+) volume, a casefold ext4 directory or an SMB share also
/// resolves two spellings to one file. On a case-sensitive volume this only
/// makes `A` and `a` wait for each other.
fn lock_key(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(view) = resolve::posix_view(&path) {
            return PathBuf::from(view.to_lowercase());
        }
        path
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(redact::fold(&path.to_string_lossy()))
    }
}

#[cfg(test)]
#[cfg(windows)]
mod windows_lock_tests {
    use super::*;

    #[test]
    fn spellings_of_one_ntfs_name_share_a_lock() {
        let key = |path: &str| lock_key(PathBuf::from(path));
        assert_eq!(key(r"\\?\C:\Work\Notes.txt"), key(r"c:\work\notes.TXT"));
        assert_ne!(key(r"C:\Work\notes.txt"), key(r"C:\Work\notes2.txt"));
        let ops = Locks::new(Limits::default().lock_wait);
        let cancel = Cancel::new();
        let _held = ops
            .lock_path(PathBuf::from(r"C:\Work\Notes.txt"), &cancel)
            .expect("first");
        cancel.cancel();
        // The other spelling waits for the same lock (here: cancelled while it waits).
        assert!(
            ops.lock_path(PathBuf::from(r"c:\work\notes.txt"), &cancel)
                .is_err()
        );
    }
}

#[cfg(test)]
#[cfg(not(windows))]
mod unix_lock_tests {
    use super::*;

    fn ops() -> Locks {
        Locks::new(Limits::default().lock_wait)
    }

    #[test]
    fn spellings_a_casefold_volume_merges_share_a_lock() {
        let key = |path: &str| lock_key(PathBuf::from(path));
        // APFS's default, a casefold ext4 directory, an SMB share: one file.
        assert_eq!(key("/Users/ada/Notes.txt"), key("/users/ada/notes.TXT"));
        assert_eq!(key("/srv/Straße.env"), key("/srv/STRASSE.env"));
        assert_ne!(key("/srv/notes.txt"), key("/srv/notes2.txt"));
        let ops = ops();
        let cancel = Cancel::new();
        let _held = ops
            .lock_path(PathBuf::from("/Users/ada/Notes.txt"), &cancel)
            .expect("first");
        cancel.cancel();
        // The other spelling waits for the same lock (here: cancelled while it waits).
        assert!(
            ops.lock_path(PathBuf::from("/Users/ada/notes.txt"), &cancel)
                .is_err()
        );
    }

    #[test]
    fn a_rename_takes_one_lock_per_file() {
        let ops = ops();
        let cancel = Cancel::new();
        // A case-only rename: one file, one lock, never a wait on itself.
        let (_one, other) = ops
            .lock_pair(
                PathBuf::from("/srv/Foo.txt"),
                PathBuf::from("/srv/foo.txt"),
                &cancel,
            )
            .expect("case-only pair");
        assert!(other.is_none());
        let (_a, b) = ops
            .lock_pair(
                PathBuf::from("/srv/b.txt"),
                PathBuf::from("/srv/a.txt"),
                &cancel,
            )
            .expect("two files");
        assert!(b.is_some());
    }
}

#[cfg(test)]
#[cfg(target_os = "linux")]
mod namespace_tests {
    use std::time::Instant;

    use super::*;

    #[test]
    fn departing_exclusive_waiter_admits_queued_shared_successor() {
        use std::sync::{Arc, mpsc};
        for timeout in [false, true] {
            let namespace = Arc::new(Namespace::default());
            let first_cancel = Cancel::new();
            let first = namespace
                .acquire(false, &first_cancel, Duration::from_secs(2))
                .unwrap();
            let cancel = Cancel::new();
            let waiter_cancel = cancel.clone();
            let waiter_ns = Arc::clone(&namespace);
            let (wait_tx, wait_rx) = mpsc::channel();
            let waiter = std::thread::spawn(move || {
                let wait = if timeout {
                    Duration::from_millis(150)
                } else {
                    Duration::from_secs(2)
                };
                wait_tx
                    .send(waiter_ns.acquire(true, &waiter_cancel, wait).map(drop))
                    .unwrap();
            });
            let deadline = Instant::now() + Duration::from_secs(1);
            while namespace.state.lock().unwrap().waiting_exclusive == 0
                && Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(namespace.state.lock().unwrap().waiting_exclusive, 1);
            let next_ns = Arc::clone(&namespace);
            let (next_tx, next_rx) = mpsc::channel();
            let next = std::thread::spawn(move || {
                next_tx
                    .send(
                        next_ns
                            .acquire(false, &Cancel::new(), Duration::from_secs(2))
                            .map(drop),
                    )
                    .unwrap();
            });
            assert!(next_rx.recv_timeout(Duration::from_millis(20)).is_err());
            if !timeout {
                cancel.cancel();
            }
            assert_eq!(
                wait_rx
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap()
                    .unwrap_err()
                    .code,
                if timeout {
                    ErrorCode::Timeout
                } else {
                    ErrorCode::Cancelled
                }
            );
            next_rx
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap();
            assert_eq!(namespace.state.lock().unwrap().waiting_exclusive, 0);
            drop(first);
            waiter.join().unwrap();
            next.join().unwrap();
        }
    }
}
