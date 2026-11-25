//! Thread-local cap injection for public list/search tests on both platforms.

use std::cell::Cell;
use std::path::PathBuf;

use crate::services::file_ops::{EtagKey, FileOps, Policy};

thread_local! {
    static DIRECTORY_LIMIT: Cell<usize> = const { Cell::new(super::MAX_DIRECTORY_ENTRIES) };
}

pub(super) fn directory_limit() -> usize {
    DIRECTORY_LIMIT.get()
}

pub(crate) fn with_directory_limit<T>(limit: usize, run: impl FnOnce() -> T) -> T {
    struct Restore(usize);
    impl Drop for Restore {
        fn drop(&mut self) {
            DIRECTORY_LIMIT.set(self.0);
        }
    }
    let _restore = Restore(DIRECTORY_LIMIT.replace(limit));
    run()
}

pub(crate) fn truncated_tree() -> (tempfile::TempDir, FileOps, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = std::fs::canonicalize(dir.path()).expect("canonical path");
    std::fs::create_dir(root.join("a-large")).expect("nested directory");
    for name in ["one.bin", "two.bin", "three.bin"] {
        std::fs::write(root.join("a-large").join(name), b"").expect("nested file");
    }
    std::fs::write(root.join("z-sibling.txt"), b"needle\nneedle\n").expect("sibling file");
    let ops = FileOps::new(
        Policy::new(vec![], vec![], true),
        EtagKey::from_bytes([7; 32]),
    );
    (dir, ops, root)
}
