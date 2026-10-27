# Images in browser terminals

On macOS, Linux and Windows, paste or drop a PNG, JPEG, or WebP image into a
human browser terminal. The browser sends the bytes to the CLI over the terminal's
existing encrypted connection. The CLI writes a temporary file, acknowledges
the completed upload, and the browser pastes its absolute path using xterm's
paste API. This respects the application's bracketed-paste mode, changes no
system clipboard, and sends no Enter key.

Rich-text clipboard copies that include non-empty plain text plus HTML or
RTF paste their plain text, even when the clipboard also contains a rendered
image (for example, copied spreadsheet cells). HTML containing only one image
and plain text containing a URL is treated as an image copy, unless RTF is also
present. Otherwise image uploads take
precedence. If uploads are unsupported or unavailable and no image path has
been inserted yet, the browser falls back to any available plain text. File
drops have no text fallback.

The coding agent must support reading or attaching images from a path. Pasting
a path is not an acknowledgement that the agent has read the image: many
agents wait until the user submits the prompt. Consequently completed images
are retained after the path enters the PTY input queue until the terminal **session ends**, not until the paste returns
or a browser tab detaches. A normal terminal close, shell exit, or daemon
shutdown removes the files and their directory. A process crash or forced
kill can leave temporary files behind for the OS's temporary-file cleanup.

Files are created with mode `0600` in a session-specific temporary directory
created with mode `0700` (on Windows, in your temporary folder, which only you
can read). The CLI chooses the operating system's temporary
location using `tempfile`; no `/tmp` path is hardcoded. The file must be
accessible from the agent's environment: entering SSH or a container from
the terminal does not transfer the file into that environment.

Limits: 8 MiB per image, 32 MiB and 32 images per terminal including reserved
in-progress uploads, one in-progress upload per viewer, and 64 KiB per chunk.
Incomplete uploads expire after 30 seconds without a chunk. Viewer detach
cancels them on the worker's next cleanup pass. A new upload replaces that
viewer's incomplete upload. Completed files survive viewer detach and
reattach. Uploads are disabled for operator terminals, including their
confirmation screens.

An additional node-wide quota caps all sessions at 128 MiB and 128 files,
including bytes reserved by incomplete uploads. One daemon-lifetime image
worker owns the files and quota across relay reconnects. File creation,
writes, expiry, and deletion all run on that worker. A slow temporary
directory delays image uploads and cleanup without stalling the relay loop.
Quota is reclaimed only on the worker as it removes the corresponding files.

The worker blocks on its request channel when it owns no files or outstanding
offers. While cleanup-sensitive resources exist, it checks cancellation every
100 ms. Its session ID counter lasts for the daemon lifetime, alongside the
worker shared by every relay registry through `NodeLink`.

The worker accepts at most 16 queued chunks plus its current chunk. Each viewer
has at most one outstanding request. Queue saturation returns `overloaded`
without blocking the relay. File operations expire after 10 seconds, leaving
margin below the browser's 15-second acknowledgement timer. Queued requests
are cancelled when their terminal, viewer, or reply receiver goes away. A
cancelled write cannot return a path, and its new file is removed on the
worker. Forwarding an acknowledgement to the browser only offers its file;
it does not make retention permanent. The next chunk confirms a partial
upload's reply. A final `image paste` frame carries the upload ID and xterm's
actual plain or bracketed-paste bytes. The CLI checks that they match the
offered path, queues them into the PTY, and atomically commits retention only
if queueing succeeds. An expired or cancelled offer never types a dangling
path. A rejected image paste sends the existing `term.input_dropped` notice
and logs an image-offer rejection without changing queue-overflow notification
state. Offers expire 30 seconds after the operation deadline; browser timeout
also sends an encrypted cancellation for that viewer's unclaimed upload.
If an upload completes but its pane is disposed, input forwarding declines
the paste, or encryption or socket sending fails, the browser cancels that
specific offer. It waits for the encrypted paste's send result before treating
the path as forwarded. Cancellation never targets a replacement session.
Atomic request states protect file lifetime while PTY queueing races expiry.
Graceful daemon shutdown stops and joins the worker after terminal
teardown; the existing shutdown deadline still bounds a stuck filesystem.

## Windows

A Windows node quotes the path for the terminal's shell itself and sends the
text to paste in its reply (`paste`, below). The browser pastes that text as
is, after the same printable-ASCII check; it quotes only POSIX paths itself.

- PowerShell (`pwsh`, Windows PowerShell): single quotes when the path needs
  them, a quote inside doubled. Nothing expands in single quotes.
- Command Prompt: double quotes when the path needs them. A path with `%` is
  refused (`path`), because cmd expands `%NAME%` even inside quotes.
- A WSL distribution: the Windows path under the distribution's drive mount
  (`C:\...` becomes `/mnt/c/...`), quoted for `sh`. The mount root comes from
  `[automount] root` in the distribution's `/etc/wsl.conf`, read through
  `\\wsl.localhost\<distro>` on the first upload, and is `/mnt/` when it sets
  none.

## Encrypted wire extension

This is an optional, compatible extension to relay protocol 3.0, which shipped
in wsmp 0.4.0. No version number or key derivation changes are needed: older
CLIs never advertise image support, and older browsers ignore the additional
unicast capability frame. The server forwards ordinary `term.sealed`
frames and cannot inspect image bytes or returned paths. Existing terminal
authentication, identity approval, and relay rate limits still apply.

The following tags are part of the authenticated plaintext inside the
pairwise browser/CLI channel. They never appear in broadcast output or PTY
output, and upload bytes never enter the PTY input queue.

| Tag | Direction | Payload after tag |
| --- | --- | --- |
| `0x10` | CLI → browser | Empty: image-upload capability, sent when a human viewer joins |
| `0x11` | Browser → CLI | 16-byte upload ID, total bytes (`u32be`), offset (`u32be`), format (`u8`), then 1–65536 image bytes |
| `0x12` | CLI → browser | UTF-8 JSON: `{id, received, path?, error?}` |
| `0x13` | Browser → CLI | 16-byte upload ID, then xterm's UTF-8 path paste (1–16384 bytes) |
| `0x14` | Browser → CLI | 16-byte upload ID: cancel only this viewer's unclaimed upload |

The reply's JSON is `{id, received, path?, paste?, error?}`. `paste` comes
only with `path`, and only from a Windows node: the exact text to paste
(printable ASCII ending in a space), quoted for the terminal's shell. A Windows
`path` (`C:\...`) is accepted only together with `paste`.

Formats: `0` = PNG, `1` = JPEG, `2` = WebP. IDs are rendered as 32 lowercase
hexadecimal characters in replies. `received` acknowledges the contiguous
byte offset after a chunk. Only the final successful reply contains `path`.
An error reply contains `error` and no path. Error codes are `invalid`,
`unsupported`, `limit`, `node_limit`, `busy`, `overloaded`, `timeout`, `io`,
`path`, and `unavailable`.

These replies cover well-formed chunks rejected by the upload handler, such
as an unexpected offset or an image header that does not match its format.
A malformed encrypted payload (for example, an invalid format byte or an
oversized chunk) fails the plaintext decoder and removes only its viewer,
consistent with other malformed terminal frames. It does not receive an
image error reply.

The browser waits for each chunk's acknowledgement, with a 15-second timeout,
and paces subsequent chunks to leave room for ordinary keystrokes. There is
no automatic retry of a file write. A lost acknowledgement fails the upload
without pasting a path. The user can retry with a fresh upload ID.

An older CLI never advertises the capability, so the browser falls back to
plain text when available, or shows an update message for an image-only
paste. An older browser advances its receive sequence before its decoder
rejects the unknown unicast capability frame; the receive chain catches that
error and ordinary terminal output continues.
