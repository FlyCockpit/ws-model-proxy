//! `wsmp terminal supervised-run`: the confirm screen of an agent-requested
//! command.
//!
//! The relay daemon runs this inside the command's own PTY, so the screen
//! travels end-to-end encrypted like any terminal output. It shows the exact
//! command it will run (every control or invisible character made visible,
//! see [`crate::display_escape`]), then waits for a key: Enter asks the
//! daemon to run it, Ctrl-C, Ctrl-D or `q` declines. Input typed before the
//! screen was drawn is flushed, and the daemon forwards no input before this
//! process prints its `ready` marker.
//!
//! The screen always fits the PTY: the request (header, command, output
//! notice) scrolls in a viewport above a pinned footer. When part of it does
//! not fit, the footer says so next to the Enter prompt, with the command's
//! size and how to see the rest. The layout follows PTY resizes: the key
//! loop re-reads the size while it waits for a key.
//!
//! Enter does not `exec` on its own: this process prints its `accepted`
//! marker and waits for the daemon's `go` token on stdin. The daemon writes
//! it only if the request is still waiting when it reads `accepted`, so the
//! daemon's decision (run, or a server expiry that came first) is the one
//! that holds, and "did the command start" has a single answer.

use crate::display_escape::escape_for_display;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::run;

const PROMPT: &str = "Enter to run · Ctrl-C, Ctrl-D or q to decline";
/// Continuation indent for multi-row fields and the command.
const INDENT: &str = "    ";
/// Marks a line break inside agent-supplied text.
const LINE_BREAK: char = '↵';

/// What the confirm screen shows.
#[derive(Debug, Clone, Copy)]
pub struct Request<'a> {
    pub requester: &'a str,
    pub reason: &'a str,
    pub directory: &'a str,
    pub command: &'a str,
    pub share_output: bool,
}

/// Columns a character may take. Printable ASCII takes one; everything else
/// is counted as two, which is never less than a terminal draws, so a row
/// laid out here never wraps on its own.
fn cell_width(ch: char) -> usize {
    if (' '..='~').contains(&ch) { 1 } else { 2 }
}

fn text_width(text: &str) -> usize {
    text.chars().map(cell_width).sum()
}

/// Hard-wraps `text` (no line breaks) to rows of at most `width` columns.
/// Every character stays in order, so the rows joined are the text; the
/// first row starts with `first`, the rest with `rest`.
fn wrap_exact(rows: &mut Vec<String>, first: &str, rest: &str, text: &str, width: usize) {
    let mut row = first.to_string();
    let mut used = text_width(first);
    let mut has_content = false;
    for ch in text.chars() {
        let w = cell_width(ch);
        if has_content && used + w > width {
            rows.push(std::mem::replace(&mut row, rest.to_string()));
            used = text_width(rest);
        }
        row.push(ch);
        used += w;
        has_content = true;
    }
    rows.push(row);
}

/// Word-wraps the screen's own prose to rows of at most `width` columns.
fn wrap_words(rows: &mut Vec<String>, text: &str, width: usize) {
    let mut row = String::new();
    let mut used = 0;
    for word in text.split(' ') {
        let w = text_width(word);
        if used > 0 && used + 1 + w > width {
            rows.push(std::mem::take(&mut row));
            used = 0;
        }
        if used > 0 {
            row.push(' ');
            used += 1;
        }
        if w > width {
            // A word longer than a row: hard-wrap it.
            let mut pieces = Vec::new();
            wrap_exact(&mut pieces, "", "", word, width);
            let last = pieces.pop().unwrap_or_default();
            for piece in pieces {
                row.push_str(&piece);
                rows.push(std::mem::take(&mut row));
            }
            used = text_width(&last);
            row = last;
        } else {
            row.push_str(word);
            used += w;
        }
    }
    rows.push(row);
}

/// A labelled field of untrusted text: escaped, each of its lines ending in
/// `↵` except the last, every row after the first indented.
fn field(rows: &mut Vec<String>, label: &str, text: &str, width: usize) {
    let escaped = escape_for_display(text);
    let lines = escaped.split('\n').collect::<Vec<_>>();
    // A label that leaves no room on its row gets rows of its own.
    let label = if text_width(label) + 2 > width {
        wrap_words(rows, label.trim_end(), width);
        INDENT
    } else {
        label
    };
    for (index, line) in lines.iter().enumerate() {
        let mut line = (*line).to_string();
        if index + 1 < lines.len() {
            line.push(LINE_BREAK);
        }
        let first = if index == 0 { label } else { INDENT };
        wrap_exact(rows, first, INDENT, &line, width);
    }
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// The command's size as the screen states it.
fn command_size(command: &str) -> String {
    let lines = command.split('\n').count();
    format!(
        "{}, {}",
        plural(lines, "line", "lines"),
        plural(command.len(), "byte", "bytes")
    )
}

/// The scrollable part of the screen, laid out for `width` columns.
fn body_rows(request: &Request<'_>, width: usize) -> Vec<String> {
    let mut rows = Vec::new();
    wrap_words(
        &mut rows,
        "WS Model Proxy: an agent asks to run a command",
        width,
    );
    rows.push(String::new());
    field(&mut rows, "Requested by: ", request.requester, width);
    if request.reason.is_empty() {
        field(
            &mut rows,
            "Reason (written by the agent): ",
            "(none)",
            width,
        );
    } else {
        field(
            &mut rows,
            "Reason (written by the agent): ",
            request.reason,
            width,
        );
    }
    field(&mut rows, "Directory: ", request.directory, width);
    rows.push(String::new());
    wrap_words(
        &mut rows,
        &format!("Command ({}):", command_size(request.command)),
        width,
    );
    field(&mut rows, INDENT, request.command, width);
    rows.push(String::new());
    wrap_words(
        &mut rows,
        if request.share_output {
            "Output will be shared with the requesting agent."
        } else {
            "Output stays in this terminal."
        },
        width,
    );
    rows
}

/// One frame of the confirm screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    /// Exactly what is drawn, top to bottom; never more rows than the PTY.
    pub rows: Vec<String>,
    /// The first body row shown.
    pub offset: usize,
    /// How far the body can scroll; zero when all of it is shown.
    pub max_offset: usize,
    /// Body rows shown at once.
    pub height: usize,
}

impl Screen {
    /// The frame as terminal output: clear, then each row at its place.
    pub fn paint(&self) -> String {
        format!("\x1b[H\x1b[2J{}", self.rows.join("\r\n"))
    }
}

fn footer_rows(
    request: &Request<'_>,
    offset: usize,
    height: usize,
    total: usize,
    width: usize,
) -> Vec<String> {
    let mut rows = Vec::new();
    let status = if height == 0 {
        format!(
            "Too small to show this request (command: {}); enlarge the terminal to read it here before pressing Enter.",
            command_size(request.command)
        )
    } else {
        format!(
            "Showing rows {}-{} of {}; the rest is not shown. Command: {}. Scroll with ↑↓ PgUp PgDn Home End to read all of it here before pressing Enter.",
            offset + 1,
            offset + height,
            total,
            command_size(request.command)
        )
    };
    wrap_words(&mut rows, &status, width);
    wrap_words(&mut rows, PROMPT, width);
    rows
}

/// Lays the screen out for a `cols` x `rows` terminal with the body scrolled
/// to `offset` (clamped). The prompt row is always the last row drawn.
pub fn layout(request: &Request<'_>, cols: usize, rows: usize, offset: usize) -> Screen {
    // One spare column, so a full row never leaves the cursor in the wrap state.
    let width = cols.saturating_sub(1).max(2);
    let rows = rows.max(1);
    let body = body_rows(request, width);
    let mut fitting_footer = vec![String::new()];
    wrap_words(&mut fitting_footer, PROMPT, width);
    if body.len() + fitting_footer.len() <= rows {
        let mut all = body;
        let height = all.len();
        all.extend(fitting_footer);
        return Screen {
            rows: all,
            offset: 0,
            max_offset: 0,
            height,
        };
    }
    let total = body.len();
    // The footer's size depends on the numbers it shows; the body shrinks
    // until both fit. `height` only decreases, so this ends.
    let mut height = rows.saturating_sub(footer_rows(request, 0, total, total, width).len());
    let (offset, footer) = loop {
        let height_now = height.min(total);
        let offset = offset.min(total - height_now);
        let footer = footer_rows(request, offset, height_now, total, width);
        if height_now + footer.len() <= rows || height_now == 0 {
            height = height_now;
            break (offset, footer);
        }
        height = rows.saturating_sub(footer.len());
    };
    let mut drawn = body[offset..offset + height].to_vec();
    drawn.extend(footer);
    if drawn.len() > rows {
        // Only on a tiny terminal: keep the rows next to the prompt.
        drawn.drain(..drawn.len() - rows);
    }
    Screen {
        rows: drawn,
        offset,
        max_offset: total - height,
        height,
    }
}

#[cfg(not(unix))]
pub fn run() -> anyhow::Result<()> {
    anyhow::bail!("supervised commands need a Unix terminal")
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn request<'a>(
        command: &'a str,
        reason: &'a str,
        share_output: bool,
    ) -> Request<'a> {
        Request {
            requester: "my agent",
            reason,
            directory: "/home/u",
            command,
            share_output,
        }
    }

    /// Every drawn row fits the terminal without wrapping.
    fn assert_fits(screen: &Screen, cols: usize, rows: usize) {
        assert!(
            screen.rows.len() <= rows,
            "{} rows on a {rows}-row terminal",
            screen.rows.len()
        );
        for row in &screen.rows {
            assert!(text_width(row) < cols.max(3), "row {row:?} is too wide");
            assert!(!row.contains('\n') && !row.contains('\r') && !row.contains('\x1b'));
        }
        assert!(screen.rows.join(" ").ends_with(PROMPT));
    }

    fn footer_text(screen: &Screen) -> String {
        screen.rows[screen.height..].join(" ")
    }

    #[test]
    fn the_screen_shows_every_field_and_the_share_notice() {
        let screen = layout(&request("sudo apt update", "needs sudo", true), 80, 24, 0);
        assert_fits(&screen, 80, 24);
        assert_eq!(screen.max_offset, 0);
        let text = screen.rows.join("\n");
        for part in [
            "Requested by: my agent",
            "Reason (written by the agent): needs sudo",
            "Directory: /home/u",
            "Command (1 line, 15 bytes):",
            "    sudo apt update",
            "Output will be shared with the requesting agent.",
            PROMPT,
        ] {
            assert!(text.contains(part), "missing {part:?} in {text}");
        }
        assert!(!text.contains("not shown"));
        let private = layout(&request("ls\x1b]0;x\x07", "", false), 80, 24, 0);
        let text = private.rows.join("\n");
        assert!(text.contains("Output stays in this terminal."));
        assert!(text.contains("Reason (written by the agent): (none)"));
        assert!(text.contains("ls\\u{1b}]0;x\\u{7}"));
        // The only escape sequences are the screen's own home and clear.
        assert_eq!(private.paint().matches('\x1b').count(), 2);
    }

    #[test]
    fn line_breaks_in_agent_text_stay_visible() {
        let screen = layout(&request("echo a\necho b", "one\ntwo", false), 80, 24, 0);
        let text = screen.rows.join("\n");
        assert!(text.contains("Reason (written by the agent): one↵\n    two"));
        assert!(text.contains("Command (2 lines, 13 bytes):\n    echo a↵\n    echo b"));
    }

    #[test]
    fn a_command_taller_than_the_terminal_says_so_next_to_the_prompt() {
        let command = (0..2000).map(|_| "x").collect::<Vec<_>>().join("\n");
        assert_eq!(command.len(), 3999);
        let screen = layout(&request(&command, "cleanup", false), 80, 24, 0);
        assert_fits(&screen, 80, 24);
        // The header and the first command lines come first.
        assert_eq!(screen.offset, 0);
        let shown = screen.rows.join("\n");
        assert!(shown.contains("Requested by: my agent"));
        assert!(shown.contains("Reason (written by the agent): cleanup"));
        assert!(shown.contains("Directory: /home/u"));
        assert!(shown.contains("Command (2000 lines, 3999 bytes):"));
        let footer = footer_text(&screen);
        assert!(footer.contains("the rest is not shown"), "{footer}");
        assert!(
            footer.contains("Command: 2000 lines, 3999 bytes."),
            "{footer}"
        );
        assert!(footer.contains("Scroll with"), "{footer}");
        // This screen is the authoritative view; it never points elsewhere.
        assert!(!footer.contains("web panel"), "{footer}");
        assert!(screen.max_offset > 1980);

        // Scrolling reaches the end, where the output notice is.
        let end = layout(&request(&command, "cleanup", false), 80, 24, usize::MAX);
        assert_fits(&end, 80, 24);
        assert_eq!(end.offset, end.max_offset);
        assert!(
            end.rows
                .join("\n")
                .contains("Output stays in this terminal.")
        );
        assert!(footer_text(&end).contains(&format!("of {};", end.max_offset + end.height)));
    }

    #[test]
    fn a_command_near_the_size_limit_fits_every_terminal_size() {
        let mut command = String::new();
        for ch in "echo \u{202e}日本 \n".chars().cycle() {
            if command.len() + ch.len_utf8() > 4096 {
                break;
            }
            command.push(ch);
        }
        assert!(command.len() > 4090);
        for (cols, rows) in [(80, 24), (40, 12), (20, 6), (200, 60), (3, 3), (1, 1)] {
            for offset in [0, 7, usize::MAX] {
                let screen = layout(&request(&command, "why", true), cols, rows, offset);
                assert!(screen.rows.len() <= rows.max(1));
                assert!(screen.rows.iter().all(|row| !row.contains('\x1b')));
                if cols >= 20 && rows >= 6 {
                    assert_fits(&screen, cols, rows);
                    // On a tiny terminal only the prompt is sure to fit.
                    if rows >= 12 {
                        let footer = footer_text(&screen);
                        assert!(footer.contains("not shown"), "{footer}");
                        assert!(footer.contains("bytes"), "{footer}");
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_unknown_size_still_shows_the_notice_and_prompt() {
        // The largest request the server accepts, with wide characters.
        let mut command = String::new();
        for ch in "echo \u{202e}日本 \n".chars().cycle() {
            if command.len() + ch.len_utf8() > 4096 {
                break;
            }
            command.push(ch);
        }
        let reason = "r".repeat(500);
        let requester = "q".repeat(100);
        let directory = format!("/{}", "d".repeat(300));
        let (cols, rows) = unix::UNKNOWN_SIZE;
        for offset in [0, 7, usize::MAX] {
            let screen = layout(
                &Request {
                    requester: &requester,
                    reason: &reason,
                    directory: &directory,
                    command: &command,
                    share_output: true,
                },
                cols,
                rows,
                offset,
            );
            // Fits (and so draws unchanged on) any terminal at least this big.
            assert_fits(&screen, cols, rows);
            let footer = footer_text(&screen);
            assert!(footer.contains("the rest is not shown"), "{footer}");
            assert!(footer.contains("bytes"), "{footer}");
        }
    }

    #[test]
    fn a_very_long_single_line_wraps_without_losing_characters() {
        let command = format!("echo {}", "a".repeat(1000));
        let screen = layout(&request(&command, "", false), 40, 200, 0);
        assert_fits(&screen, 40, 200);
        let start = screen
            .rows
            .iter()
            .position(|row| row.starts_with("Command ("))
            .expect("command header");
        let joined = screen.rows[start + 1..]
            .iter()
            .take_while(|row| !row.is_empty())
            .map(|row| row.strip_prefix(INDENT).expect("indented"))
            .collect::<String>();
        assert_eq!(joined, command);
        // Wide characters count double, so a row of them still fits.
        let wide = "日".repeat(100);
        let screen = layout(&request(&wide, "", false), 30, 200, 0);
        assert_fits(&screen, 30, 200);
    }
}
