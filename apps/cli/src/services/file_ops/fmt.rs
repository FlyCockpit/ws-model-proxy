//! Small formatting helpers shared by the file tools: RFC 3339 UTC times,
//! octal modes, and human sizes.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// `2026-09-27T10:02:11Z` for `time` (UTC, whole seconds; pre-epoch clamps to
/// the epoch).
pub fn rfc3339(time: SystemTime) -> String {
    let secs = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs();
    rfc3339_secs(secs)
}

pub fn rfc3339_secs(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// `YYYY-MM-DD` for listings.
pub fn date_only(time: SystemTime) -> String {
    rfc3339(time)[..10].to_string()
}

// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Four-digit octal permission string such as `0755`.
pub fn mode_string(mode: u32) -> String {
    format!("{:04o}", mode & 0o7777)
}

/// Human size such as `812B`, `1.8K`, `16.5G`.
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["K", "M", "G", "T", "P"];
    if bytes < 1024 {
        return format!("{bytes}B");
    }
    let mut value = bytes as f64;
    let mut unit = "B";
    for next in UNITS {
        if value < 1024.0 {
            break;
        }
        value /= 1024.0;
        unit = next;
    }
    format!("{value:.1}{unit}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_known_instants() {
        assert_eq!(rfc3339_secs(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_secs(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_secs(1_790_503_331), "2026-09-27T10:02:11Z");
        assert_eq!(rfc3339_secs(4_102_444_799), "2099-12-31T23:59:59Z");
    }

    #[test]
    fn sizes_and_modes() {
        assert_eq!(human_size(812), "812B");
        assert_eq!(human_size(16_492_345_344), "15.4G");
        assert_eq!(human_size(1024), "1.0K");
        assert_eq!(mode_string(0o100755), "0755");
        assert_eq!(mode_string(0o4755), "4755");
    }
}
