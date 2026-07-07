//! Shared forwarder slug policy.

use anyhow::Result;
use rand::distributions::{Alphanumeric, DistString};

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

pub fn slugify_seed(seed: &str, fallback_prefix: &str) -> String {
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
    if validate_slug(&output).is_ok() {
        output
    } else {
        generated_slug(fallback_prefix)
    }
}

pub fn generated_slug(prefix: &str) -> String {
    let clean_prefix = slug_prefix(prefix);
    let mut rng = rand::thread_rng();
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
    fn generated_slug_is_valid() {
        let slug = generated_slug("cli");
        validate_slug(&slug).expect("generated slug is valid");
    }
}
