//! The reconnect backoff: how long the relay waits before the next
//! connection attempt, and the wait floors an error can carry.

use std::time::{Duration, Instant};

const RELAY_RECONNECT_INITIAL_DELAY: Duration = Duration::from_secs(1);
pub(super) const RELAY_RECONNECT_MAX_DELAY: Duration = Duration::from_secs(300);
/// The first wait after a session failed fatally (see the relay loop).
const RELAY_FATAL_INITIAL_DELAY: Duration = Duration::from_secs(5);

/// How far one connection attempt got: what the reconnect backoff reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ConnectProgress {
    /// Opening the websocket (or no credential to open it with).
    Connecting,
    /// The upgrade was accepted.
    Upgraded,
    /// `hello.challenge` arrived.
    Challenged,
    /// The hello went out; `hello.ok` has not arrived.
    HelloSent,
    /// `hello.ok` arrived at `since`.
    Registered { since: Instant },
}

/// How long a registered session must have lasted for its end to start the
/// backoff over. A server that accepts the hello and then drops the node at
/// once keeps the backoff growing instead of being redialled every second.
const RELAY_STABLE_SESSION: Duration = Duration::from_secs(30);

impl ConnectProgress {
    /// The attempt ran a registered session for at least
    /// [`RELAY_STABLE_SESSION`] by `now`.
    fn stable_at(self, now: Instant) -> bool {
        matches!(self, Self::Registered { since } if now.saturating_duration_since(since) >= RELAY_STABLE_SESSION)
    }
}

/// How a connection attempt ended, for the backoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AttemptEnd {
    /// No credential to connect with, or the session ended without an error.
    Retry,
    /// A reconnectable error, waiting at least `floor` when it carries one.
    Reconnectable { floor: Option<Duration> },
    /// A failure fatal to the session that is not a stop: its own, slower
    /// backoff.
    Fatal,
}

/// The relay's reconnect backoff: one place decides every wait.
///
/// Reconnects wait 1 s, then twice as long each time, up to 5 minutes; a
/// session that keeps failing fatally waits 5 s, then twice as long, up to
/// 5 minutes. Both start over only after an attempt that ran a stable
/// registered session ([`ConnectProgress::stable_at`]): an error before
/// `hello.ok` (a refused challenge, a lost socket while registering) never
/// resets them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ReconnectBackoff {
    delay: Duration,
    fatal_delay: Duration,
}

impl ReconnectBackoff {
    pub(super) fn new() -> Self {
        Self {
            delay: RELAY_RECONNECT_INITIAL_DELAY,
            fatal_delay: RELAY_FATAL_INITIAL_DELAY,
        }
    }

    /// The wait before the next attempt, after one that got to `progress`
    /// and ended as `end` (judged at `now`); grows the backoff for the one
    /// after.
    pub(super) fn next_wait(
        &mut self,
        end: AttemptEnd,
        progress: ConnectProgress,
        now: Instant,
    ) -> Duration {
        if progress.stable_at(now) {
            *self = Self::new();
        }
        let wait = match end {
            AttemptEnd::Retry => reconnect_wait(self.delay, None),
            AttemptEnd::Reconnectable { floor } => {
                let wait = reconnect_wait(self.delay, floor);
                if let Some(floor) = floor {
                    // Grow the backoff from the server's floor, not below it.
                    self.delay = self.delay.max(floor).min(RELAY_RECONNECT_MAX_DELAY);
                }
                wait
            }
            AttemptEnd::Fatal => {
                let wait = reconnect_wait(self.fatal_delay, None);
                self.fatal_delay = next_reconnect_delay(self.fatal_delay);
                wait
            }
        };
        self.delay = next_reconnect_delay(self.delay);
        wait
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RetryFloorSource {
    /// The server's `Retry-After` header.
    Server,
    /// A refusal that retrying soon cannot fix.
    Refusal,
}

/// The least time the reconnect loop waits before the next attempt. Attached
/// to a reconnectable error as context, so it also shows in the logged chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RetryFloor {
    pub(super) delay: Duration,
    pub(super) source: RetryFloorSource,
}

impl std::fmt::Display for RetryFloor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.source {
            RetryFloorSource::Server => write!(
                f,
                "the server asked to wait {} s (Retry-After) before reconnecting",
                self.delay.as_secs()
            ),
            RetryFloorSource::Refusal => write!(
                f,
                "retrying in {} s; restarting wsmp unchanged cannot fix this",
                self.delay.as_secs()
            ),
        }
    }
}

impl std::error::Error for RetryFloor {}

/// The wait floor a reconnectable error carries, if any.
pub(super) fn retry_floor(error: &anyhow::Error) -> Option<Duration> {
    // A `.context(RetryFloor)` is found by anyhow's downcast; the chain walk
    // finds one nested inside another error.
    error
        .downcast_ref::<RetryFloor>()
        .or_else(|| {
            error
                .chain()
                .find_map(|cause| cause.downcast_ref::<RetryFloor>())
        })
        .map(|floor| floor.delay)
}

/// How long to wait before reconnecting: the backoff with up to 20% taken off
/// at random (so many nodes do not reconnect in step, and the cap holds), and
/// never less than `floor` (plus up to 10%, for the same reason).
fn reconnect_wait(backoff: Duration, floor: Option<Duration>) -> Duration {
    let jittered = backoff.mul_f64(rand::random_range(0.8..=1.0));
    match floor {
        Some(floor) => jittered.max(floor.mul_f64(rand::random_range(1.0..=1.1))),
        None => jittered,
    }
}

fn next_reconnect_delay(current: Duration) -> Duration {
    current
        .checked_mul(2)
        .unwrap_or(RELAY_RECONNECT_MAX_DELAY)
        .min(RELAY_RECONNECT_MAX_DELAY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_wait_keeps_jitter_the_cap_and_the_floor() {
        for _ in 0..200 {
            let wait = reconnect_wait(RELAY_RECONNECT_MAX_DELAY, None);
            assert!(wait <= RELAY_RECONNECT_MAX_DELAY);
            assert!(wait >= RELAY_RECONNECT_MAX_DELAY.mul_f64(0.8));
            let floored = reconnect_wait(Duration::from_secs(2), Some(Duration::from_secs(60)));
            assert!(floored >= Duration::from_secs(60), "{floored:?}");
            assert!(floored <= Duration::from_secs(66), "{floored:?}");
            // The backoff still wins when it is longer than the floor.
            let longer = reconnect_wait(Duration::from_secs(256), Some(Duration::from_secs(1)));
            assert!(longer >= Duration::from_secs(204), "{longer:?}");
        }
    }

    #[test]
    fn reconnect_backoff_grows_exponentially() {
        assert_eq!(
            next_reconnect_delay(RELAY_RECONNECT_INITIAL_DELAY),
            Duration::from_secs(2)
        );
        assert_eq!(
            next_reconnect_delay(Duration::from_secs(2)),
            Duration::from_secs(4)
        );
    }

    #[test]
    fn reconnect_backoff_caps_at_five_minutes() {
        assert_eq!(
            next_reconnect_delay(Duration::from_secs(256)),
            RELAY_RECONNECT_MAX_DELAY
        );
        assert_eq!(RELAY_RECONNECT_MAX_DELAY, Duration::from_secs(300));
    }

    #[test]
    fn reconnect_backoff_stays_capped_without_overflow() {
        let mut delay = RELAY_RECONNECT_MAX_DELAY;
        for _ in 0..100 {
            delay = next_reconnect_delay(delay);
            assert_eq!(delay, RELAY_RECONNECT_MAX_DELAY);
        }
    }

    /// Backoff after attempts that never registered keeps growing, whatever
    /// failed (a lost socket while registering used to reset it, which
    /// redialled a refusing server every second).
    #[test]
    fn the_backoff_grows_through_errors_before_hello_ok() {
        let now = Instant::now();
        let mut backoff = ReconnectBackoff::new();
        for progress in [
            ConnectProgress::Connecting,
            ConnectProgress::Upgraded,
            ConnectProgress::Challenged,
            ConnectProgress::HelloSent,
            ConnectProgress::Registered { since: now },
        ] {
            let before = backoff.delay;
            let wait = backoff.next_wait(AttemptEnd::Reconnectable { floor: None }, progress, now);
            assert!(
                wait <= before && wait >= before.mul_f64(0.8),
                "{progress:?}"
            );
            assert_eq!(backoff.delay, next_reconnect_delay(before), "{progress:?}");
        }
        assert_eq!(backoff.delay, Duration::from_secs(32));
        assert_eq!(backoff.fatal_delay, RELAY_FATAL_INITIAL_DELAY);
    }

    #[test]
    fn a_stable_registered_session_starts_the_backoff_over() {
        let since = Instant::now();
        let mut backoff = ReconnectBackoff {
            delay: RELAY_RECONNECT_MAX_DELAY,
            fatal_delay: RELAY_RECONNECT_MAX_DELAY,
        };
        // Registered, but dropped before it was stable: no reset.
        let short = since + RELAY_STABLE_SESSION - Duration::from_secs(1);
        let progress = ConnectProgress::Registered { since };
        assert!(!progress.stable_at(short));
        backoff.next_wait(AttemptEnd::Retry, progress, short);
        assert_eq!(backoff.delay, RELAY_RECONNECT_MAX_DELAY);
        // Stable: both backoffs start over, then grow for the next attempt.
        let stable = since + RELAY_STABLE_SESSION;
        let wait = backoff.next_wait(AttemptEnd::Reconnectable { floor: None }, progress, stable);
        assert!(wait <= RELAY_RECONNECT_INITIAL_DELAY);
        assert_eq!(backoff.delay, RELAY_RECONNECT_INITIAL_DELAY * 2);
        assert_eq!(backoff.fatal_delay, RELAY_FATAL_INITIAL_DELAY);
    }

    #[test]
    fn the_backoff_honours_floors_and_keeps_its_fatal_track() {
        let now = Instant::now();
        let mut backoff = ReconnectBackoff::new();
        let floor = Duration::from_secs(120);
        let wait = backoff.next_wait(
            AttemptEnd::Reconnectable { floor: Some(floor) },
            ConnectProgress::Connecting,
            now,
        );
        assert!(wait >= floor && wait <= floor.mul_f64(1.1));
        // Grown from the floor.
        assert_eq!(backoff.delay, floor * 2);
        let mut backoff = ReconnectBackoff::new();
        let wait = backoff.next_wait(AttemptEnd::Fatal, ConnectProgress::HelloSent, now);
        assert!(wait <= RELAY_FATAL_INITIAL_DELAY);
        assert_eq!(backoff.fatal_delay, RELAY_FATAL_INITIAL_DELAY * 2);
        assert_eq!(backoff.delay, RELAY_RECONNECT_INITIAL_DELAY * 2);
    }
}
