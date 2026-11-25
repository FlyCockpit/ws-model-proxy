//! The `fileRoots` grant: its shape and aggregate bound, and the checks a
//! root passes before the node serves files under it.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

pub const MAX_FILE_ROOTS: usize = 32;

/// Aggregate JSON-serialized size of the whole roots set (control characters
/// and quotes count as their escapes). A larger set is refused where it is
/// accepted (fail closed).
pub const MAX_FILE_ROOTS_SERIALIZED_BYTES: usize = 64 * 1024;

pub(super) fn deserialize_file_roots<'de, D>(deserializer: D) -> Result<Vec<PathBuf>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let roots = Vec::<PathBuf>::deserialize(deserializer)?;
    validate_file_root_shape(&roots).map_err(serde::de::Error::custom)?;
    Ok(roots)
}

/// Validate disk shape without requiring existence: disappeared roots must
/// still reach the confined, unusable startup policy rather than disappear.
pub(super) fn validate_file_root_shape(roots: &[PathBuf]) -> Result<()> {
    anyhow::ensure!(
        roots.len() <= MAX_FILE_ROOTS,
        "at most {MAX_FILE_ROOTS} file roots are allowed"
    );
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        let text = root.to_str().context("file root is not UTF-8")?;
        anyhow::ensure!(
            text.len() <= 4096 && root.is_absolute() && root.parent().is_some(),
            "file root must be an absolute directory other than `/`"
        );
        anyhow::ensure!(
            !root
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir)),
            "file root must not contain `..`"
        );
        anyhow::ensure!(seen.insert(root), "duplicate file root");
    }
    // After the per-root checks, so a non-UTF-8 root reports its own error.
    let serialized: usize = roots
        .iter()
        .map(|root| serde_json::to_string(root).map_or(usize::MAX, |json| json.len() + 1))
        .fold(0, usize::saturating_add);
    anyhow::ensure!(
        serialized <= MAX_FILE_ROOTS_SERIALIZED_BYTES,
        "the file roots are too long in total (at most {MAX_FILE_ROOTS_SERIALIZED_BYTES} bytes once serialized, control characters counting as escapes)"
    );
    Ok(())
}

/// Set-file-roots validation, with an explicit home input for isolated tests.
/// Suggested roots are help text only; nothing is implicitly added.
pub fn validate_file_roots(paths: &[PathBuf], home: Option<&Path>) -> Result<Vec<PathBuf>> {
    anyhow::ensure!(
        !paths.is_empty(),
        "at least one file root is required; use clear-file-roots to clear them"
    );
    anyhow::ensure!(
        paths.len() <= MAX_FILE_ROOTS,
        "at most {MAX_FILE_ROOTS} file roots are allowed"
    );
    let mut expanded_roots = Vec::with_capacity(paths.len());
    for path in paths {
        let text = path.to_str().context("file root is not UTF-8")?;
        let expanded = if text == "~" {
            home.context("home directory is unavailable")?.to_path_buf()
        } else if let Some(rest) = text.strip_prefix("~/") {
            home.context("home directory is unavailable")?.join(rest)
        } else {
            anyhow::ensure!(
                !text.starts_with('~'),
                "only `~` and `~/` expansion are supported"
            );
            path.clone()
        };
        validate_file_root_shape(std::slice::from_ref(&expanded))?;
        expanded_roots.push(expanded);
    }
    // The bound applies to the list as accepted (before symlinks shrink it) and,
    // below, to the resolved list that is saved, loaded and sent to the child.
    validate_file_root_shape(&expanded_roots)?;
    let mut roots = Vec::with_capacity(expanded_roots.len());
    for expanded in &expanded_roots {
        let physical = std::fs::canonicalize(expanded).context("file root must exist")?;
        anyhow::ensure!(physical.is_dir(), "file root must be a directory");
        roots.push(physical);
    }
    validate_file_root_shape(&roots)?;
    Ok(roots)
}

/// False if any configured root is unusable; never invent an unrestricted fallback.
pub fn file_roots_usable(roots: &[PathBuf]) -> bool {
    validate_file_roots(roots, None).is_ok()
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::*;

    /// The roots set is bounded in aggregate (serialized, control characters
    /// counting as escapes) wherever roots are accepted; realistic sets stay
    /// accepted.
    #[cfg(unix)]
    #[test]
    fn file_roots_have_an_aggregate_serialized_bound() {
        // Realistic: the maximum count of ordinary 200-byte roots fits.
        let ordinary: Vec<PathBuf> = (0..MAX_FILE_ROOTS)
            .map(|n| PathBuf::from(format!("/{}{n}", "r".repeat(200))))
            .collect();
        validate_file_root_shape(&ordinary).expect("ordinary roots");
        // Pathological: each control character serializes to six bytes, so a
        // handful of valid (under 4096-byte) names pass the per-root shape but
        // not the aggregate bound.
        let heavy: Vec<PathBuf> = (0..17)
            .map(|n| PathBuf::from(format!("/{n}{}", "\u{1}".repeat(1500))))
            .collect();
        for root in &heavy {
            validate_file_root_shape(std::slice::from_ref(root)).expect("one root");
        }
        let error = validate_file_root_shape(&heavy).expect_err("aggregate bound");
        assert!(error.to_string().contains("too long in total"), "{error}");
        // The same set fails closed when a config file carries it.
        #[derive(serde::Deserialize)]
        struct Probe {
            #[serde(deserialize_with = "deserialize_file_roots")]
            #[allow(dead_code)]
            roots: Vec<PathBuf>,
        }
        let raw = serde_json::json!({ "roots": heavy });
        assert!(
            serde_json::from_value::<Probe>(raw).is_err(),
            "config deserialization must refuse the set"
        );
    }

    /// The bound sits exactly where it is documented.
    #[cfg(unix)]
    #[test]
    fn file_roots_bound_is_exact() {
        assert_eq!(MAX_FILE_ROOTS_SERIALIZED_BYTES, 64 * 1024);
        // Exactly at the bound passes, one byte over fails. Each root counts its
        // JSON text plus one separator byte.
        let filler = |len: usize| PathBuf::from(format!("/{}", "a".repeat(len - 1)));
        let root_len = 3 * 1024; // JSON text: path plus two quotes
        let per_root = root_len + 1;
        let full = MAX_FILE_ROOTS_SERIALIZED_BYTES / per_root;
        let mut roots: Vec<PathBuf> = (0..full)
            .map(|n| {
                let mut path = filler(root_len - 2).into_os_string();
                path.push(format!("{n:04}"));
                PathBuf::from(path)
            })
            .collect();
        let used: usize = roots
            .iter()
            .map(|root| serde_json::to_string(root).unwrap().len() + 1)
            .sum();
        let slack = MAX_FILE_ROOTS_SERIALIZED_BYTES - used;
        roots.push(PathBuf::from(format!("/{}", "b".repeat(slack - 4))));
        let total: usize = roots
            .iter()
            .map(|root| serde_json::to_string(root).unwrap().len() + 1)
            .sum();
        assert_eq!(total, MAX_FILE_ROOTS_SERIALIZED_BYTES);
        validate_file_root_shape(&roots).expect("exactly at the bound");
        roots.last_mut().unwrap().push("c");
        assert!(validate_file_root_shape(&roots).is_err(), "one byte over");
    }

    /// The aggregate bound also covers the list as accepted (before symlinks
    /// shrink it), the resolved list (short aliases of long real paths), and puts
    /// a non-UTF-8 root's own error first. Every created path stays well under
    /// 600 bytes (macOS caps paths at 1024) and the totals are asserted to sit
    /// over the bound so the test cannot pass for the wrong reason.
    #[cfg(unix)]
    #[test]
    fn file_roots_bound_covers_the_expanded_list_and_error_order() {
        use std::os::unix::ffi::OsStrExt;
        let serialized = |roots: &[PathBuf]| -> usize {
            roots
                .iter()
                .map(|root| serde_json::to_string(root).unwrap().len() + 1)
                .sum()
        };
        let ctl = |len: usize| "\u{1}".repeat(len);
        let base = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(base.path()).unwrap();
        let target = base.join("short");
        std::fs::create_dir(&target).unwrap();
        // 32 aliases whose typed names are long (control characters) but resolve short.
        let mut long_dir = base.clone();
        for _ in 0..2 {
            long_dir.push(ctl(120));
        }
        std::fs::create_dir_all(&long_dir).unwrap();
        let aliases: Vec<PathBuf> = (0..MAX_FILE_ROOTS)
            .map(|n| {
                let link = long_dir.join(format!("{n:02}{}", ctl(120)));
                std::os::unix::fs::symlink(&target, &link).unwrap();
                link
            })
            .collect();
        assert!(serialized(&aliases) > MAX_FILE_ROOTS_SERIALIZED_BYTES);
        let error = validate_file_roots(&aliases, None).expect_err("expanded list over bound");
        assert!(error.to_string().contains("too long in total"), "{error}");
        // Short aliases that resolve to real paths over the bound are refused too.
        let real_parent = base.join("real");
        std::fs::create_dir(&real_parent).unwrap();
        let mut resolved_len = 0;
        let short_aliases: Vec<PathBuf> = (0..MAX_FILE_ROOTS)
            .map(|n| {
                let real = real_parent
                    .join(format!("{n:02}{}", ctl(175)))
                    .join(ctl(175));
                std::fs::create_dir_all(&real).unwrap();
                resolved_len += serde_json::to_string(&real).unwrap().len() + 1;
                let alias = base.join(format!("a{n:02}"));
                std::os::unix::fs::symlink(&real, &alias).unwrap();
                alias
            })
            .collect();
        assert!(serialized(&short_aliases) < MAX_FILE_ROOTS_SERIALIZED_BYTES);
        assert!(resolved_len > MAX_FILE_ROOTS_SERIALIZED_BYTES);
        let error =
            validate_file_roots(&short_aliases, None).expect_err("resolved list over bound");
        assert!(error.to_string().contains("too long in total"), "{error}");
        // Within both bounds: ordinary aliases resolve and are accepted.
        let ordinary = base.join("alias");
        std::os::unix::fs::symlink(&target, &ordinary).unwrap();
        assert_eq!(
            validate_file_roots(&[ordinary], None).unwrap(),
            vec![target]
        );
        // A non-UTF-8 root reports its own error, not the size error.
        let bad = PathBuf::from(std::ffi::OsStr::from_bytes(b"/tmp/non-utf8-\xff"));
        let error = validate_file_root_shape(&[bad]).expect_err("non-utf8");
        assert!(error.to_string().contains("not UTF-8"), "{error}");
    }
}
