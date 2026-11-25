//! Wall-clock timestamps for relay frames and stored records: UTC RFC 3339
//! with milliseconds.

use std::time::{SystemTime, UNIX_EPOCH};

/// UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn now_rfc3339() -> String {
    rfc3339(SystemTime::now())
}

/// `at` as UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn rfc3339(at: SystemTime) -> String {
    let elapsed = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    format_rfc3339(elapsed.as_secs(), elapsed.subsec_millis())
}

fn format_rfc3339(unix_secs: u64, millis: u32) -> String {
    let days = (unix_secs / 86_400) as i64;
    let seconds_of_day = unix_secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        seconds_of_day / 3_600,
        (seconds_of_day / 60) % 60,
        seconds_of_day % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_rfc3339_utc() {
        assert_eq!(format_rfc3339(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_rfc3339(1_790_000_000, 7), "2026-09-21T14:13:20.007Z");
        assert_eq!(format_rfc3339(951_782_400, 999), "2000-02-29T00:00:00.999Z");
    }
}
