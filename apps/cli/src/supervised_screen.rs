//! Shared terminal mechanics for supervised confirmation screens.
//!
//! Both command and file confirmation use this one raw-mode, key parsing,
//! resize, type-ahead flushing, marker, and daemon-go implementation.  The
//! caller owns the text layout and the action performed after `go`.

/// One already-laid-out frame. Rows contain no terminal controls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    pub rows: Vec<String>,
    pub offset: usize,
    pub max_offset: usize,
    pub height: usize,
}

impl Screen {
    pub fn paint(&self) -> String {
        format!("\x1b[H\x1b[2J{}", self.rows.join("\r\n"))
    }
}

#[cfg(unix)]
mod unix;

#[cfg(unix)]
pub(crate) use unix::{ConfirmAction, ConfirmOutcome, interact};
#[cfg(all(unix, test))]
pub(crate) use unix::{
    Key, KeyReader, RawMode, TokenMatcher, UNKNOWN_SIZE, Wake, confirm_raw_mode,
    restore_terminal_on_panic, scrolled, wait_for_input_or_resize,
};
