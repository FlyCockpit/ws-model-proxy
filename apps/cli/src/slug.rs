//! Shared forwarder slug policy.

use anyhow::Result;
use rand::distr::{Alphanumeric, SampleString};

const MIN: usize = 3;
const MAX: usize = 63;
const RESERVED: &[&str] = &[
    "api",
    "v1",
    "admin",
    "auth",
    "login",
    "logout",
    "signup",
    "settings",
    "dashboard",
    "health",
    "models",
    "model",
    "cli",
    "clis",
    "endpoint",
    "endpoints",
    "pool",
    "pools",
    "token",
    "tokens",
];

pub fn validate_slug(value: &str) -> Result<()> {
    if value.len() < MIN || value.len() > MAX {
        anyhow::bail!("slug must be between {MIN} and {MAX} characters");
    }
    if RESERVED.contains(&value) {
        anyhow::bail!("slug `{value}` is reserved");
    }
    let bytes = value.as_bytes();
    if bytes.first().is_some_and(|byte| *byte == b'-')
        || bytes.last().is_some_and(|byte| *byte == b'-')
    {
        anyhow::bail!("slug `{value}` cannot start or end with `-`");
    }
    let mut previous_hyphen = false;
    for ch in value.chars() {
        let valid = ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-';
        if !valid {
            anyhow::bail!("slug `{value}` may only contain lowercase letters, numbers, and `-`");
        }
        if ch == '-' && previous_hyphen {
            anyhow::bail!("slug `{value}` cannot contain repeated hyphens");
        }
        previous_hyphen = ch == '-';
    }
    Ok(())
}

/// `seed` as a slug, or a generated `{fallback_prefix}-…` slug when it has too
/// little usable text.
pub fn slugify_seed(seed: &str, fallback_prefix: &str) -> String {
    slugify(seed).unwrap_or_else(|| generated_slug(fallback_prefix))
}

/// `seed` lowercased with runs of other characters folded to one hyphen, or
/// `None` when the result is not a valid slug. Deterministic.
pub fn slugify(seed: &str) -> Option<String> {
    let mut output = String::new();
    let mut previous_hyphen = false;
    for ch in seed.trim().to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            output.push(ch);
            previous_hyphen = false;
        } else if !previous_hyphen && !output.is_empty() {
            output.push('-');
            previous_hyphen = true;
        }
        if output.len() >= MAX {
            break;
        }
    }
    while output.ends_with('-') {
        output.pop();
    }
    validate_slug(&output).ok().map(|()| output)
}

pub fn generated_slug(prefix: &str) -> String {
    let clean_prefix = slug_prefix(prefix);
    let mut rng = rand::rng();
    loop {
        let suffix = Alphanumeric.sample_string(&mut rng, 10).to_lowercase();
        let slug = format!("{clean_prefix}-{suffix}");
        if validate_slug(&slug).is_ok() {
            return slug;
        }
    }
}

fn slug_prefix(prefix: &str) -> String {
    let candidate = prefix
        .chars()
        .filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || *ch == '-')
        .collect::<String>();
    if candidate.len() >= MIN
        && !candidate.ends_with('-')
        && !RESERVED.contains(&candidate.as_str())
    {
        candidate
    } else {
        "cli".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_shared_policy() {
        validate_slug("abc").expect("valid");
        assert!(validate_slug("ab").is_err());
        assert!(validate_slug("Admin").is_err());
        assert!(validate_slug("admin").is_err());
        assert!(validate_slug("a--b").is_err());
        assert!(validate_slug("-abc").is_err());
    }

    #[test]
    fn slugify_folds_a_hostname() {
        assert_eq!(slugify("Desk-01.local").as_deref(), Some("desk-01-local"));
        assert_eq!(slugify("  My Laptop  ").as_deref(), Some("my-laptop"));
        assert_eq!(slugify("PC"), None);
        assert_eq!(slugify("API"), None);
    }

    #[test]
    fn generated_slug_is_valid() {
        let slug = generated_slug("cli");
        validate_slug(&slug).expect("generated slug is valid");
    }
}
