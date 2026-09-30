<a href="https://github.com/FlyCockpit/ws-model-proxy">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://shieldcn.dev/header/dots.svg?title=WS+Model+Proxy+CLI&subtitle=Outbound+relay+client+for+local+LLM+endpoints&logo=rust&logoColor=brand&size=wide&theme=orange&mode=light&align=left">
    <img src="https://shieldcn.dev/header/dots.svg?title=WS+Model+Proxy+CLI&subtitle=Outbound+relay+client+for+local+LLM+endpoints&logo=rust&logoColor=brand&size=wide&theme=orange&mode=dark&align=left" alt="WS Model Proxy CLI">
  </picture>
</a>

<p align="center">
  <a href="https://github.com/FlyCockpit/ws-model-proxy/stargazers"><img alt="GitHub stars" src="https://shieldcn.dev/github/stars/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
  <a href="https://github.com/FlyCockpit/ws-model-proxy/forks"><img alt="GitHub forks" src="https://shieldcn.dev/github/forks/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
  <a href="Cargo.toml"><img alt="Rust 1.88+" src="https://shieldcn.dev/badge/rust-1.88+-ef7d00.svg?variant=secondary&mode=light&size=sm&logo=rust"></a>
  <a href="#license"><img alt="License" src="https://shieldcn.dev/github/license/FlyCockpit/ws-model-proxy.svg?variant=secondary&mode=light&size=sm"></a>
</p>

> Command-line relay client for WS Model Proxy.

The `wsmp` CLI authenticates with the web app, holds an outbound websocket connection to the server, and forwards local or network OpenAI-compatible model endpoints without router port forwarding.

## Start Here

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
cargo xtask sync-docs --check
```

## What You Get

- A clap-based CLI with config, auth, endpoint inventory, probing, and relay commands.
- Clean stdout/stderr boundaries, JSON output support, structured logging, and stable process exit codes.
- Cross-platform config/state paths and TOML config load/save helpers.
- Focused black-box CLI tests plus unit tests next to pure logic.
- CI for fmt, clippy, tests, docs drift, dependency policy, typos, MSRV, and lightweight repository policy checks.
- Cross-platform releases through `dist`, including shell, PowerShell, and Homebrew installer artifacts.

## CLI

```sh
wsmp login                         # device-code login; slug defaults to the configured slug, else the hostname
wsmp login --slug desk-01          # choose the CLI slug used in model ids
wsmp token login WSMP_TOKEN         # store the env var name for a CLI token
wsmp config path                    # where the config file lives
wsmp config --json show             # print config as JSON
wsmp config init                    # write a default config
wsmp config set-slug desk-01        # set this CLI connection's slug
wsmp endpoints add local http://127.0.0.1:11434
wsmp endpoints add local http://127.0.0.1:11434 --expand-media  # inline WMP media URLs
wsmp endpoints concurrency local 4          # register this limit for every model
wsmp endpoints engine local llama.cpp       # declare the engine; llama.cpp and vllm advertise top_k
                                            # (also: auto, generic, sglang, ollama, lm-studio)
wsmp endpoints probe local
wsmp connect                        # open the outbound websocket relay
wsmp daemon start --detach          # background relay (new session; owns a PID file)
wsmp daemon status                  # inspect the live relay (non-zero if absent)
wsmp status                         # top-level live relay status alias
wsmp reload                         # probe and publish the complete inventory; waits for server ack
wsmp reload --offline               # probe and save local state only; never publishes
wsmp daemon stop                    # stop a detached relay
wsmp service install                # install, enable, and start a Linux/macOS user service
wsmp service status                 # inspect the installed user service
wsmp service env-sync               # copy required env vars into the private service env file
wsmp terminal fingerprint           # print this CLI's terminal identity fingerprint
wsmp config set-mcp-commands supervised  # agents may request commands you confirm (off|supervised|unsupervised)
wsmp metrics list                   # custom metric sources and their state
wsmp metrics test gpu_fan           # run one source now and print what it reports
wsmp metrics approve gpu_fan --sha256 <hash>  # approve the exact command you reviewed (hash from `metrics list`)
wsmp config set-remote-metric-sources on  # accept remotely defined sources (each still needs approval)
wsmp completions zsh                # shell completions
```

Configuration is stored in a JSON file. `wsmp config path` prints the resolved path for the current platform. `WSMP_CONFIG` selects that file. `WSMP_STATE_DIR` selects the state directory used by the daemon (PID file and control socket) and by `wsmp terminal approve` (pending and approved browser identities). When it is unset, the CLI uses `$XDG_STATE_HOME/ws-model-proxy` or `~/.local/state/ws-model-proxy`. Logs go to stderr; pass `-v`/`-vv` for more, `--quiet` for less, or set `WSMP_LOG`.

### MCP commands

`wsmp config set-mcp-commands <off|supervised|unsupervised>` chooses what MCP agents may run on this machine (restart wsmp to apply; the dashboard grant for the device must allow it too). `unsupervised` allows headless commands (`sh -c`, no TTY, no stdin). `supervised` allows only supervised commands: the agent's request opens a terminal on the dashboard's Terminals page that shows who asked, the agent's reason, the working directory and the exact command, with every control or invisible character shown as `\u{..}`. The screen always fits the terminal: a request taller than it scrolls (arrow keys, PgUp/PgDn, Home/End) above a footer that stays next to the Enter prompt and says, when part is not shown, how many lines and bytes the command has. Read the command on this screen: it is drawn by wsmp inside the end-to-end encrypted terminal and is exactly what runs. The dashboard panel also shows the whole command, but that copy is relayed by the server, as a convenience. Below about 12 rows or 20 columns the status line may be cut, but the Enter prompt row is always kept; if the terminal size cannot be read, the screen is laid out for 40 columns by 16 rows, so it fits any terminal at least that big. Nothing runs until someone presses Enter on that screen; Ctrl-C, Ctrl-D or `q` declines, and keys typed before the screen was drawn are discarded. Enter hands the decision to the relay daemon, which starts the command only if the request is still waiting: when the server's 15-minute confirm deadline (or a Decline in the dashboard) reaches it first, the request is declined and the command never starts, and when the Enter came first the command runs to its end. A Decline never kills a command: if the Enter came first, the tab that declined says the command started, and only End session stops it. End session is an explicit kill at any point, including of a command that just started. The command then runs in that terminal (so `sudo` and other prompts work) and the terminal ends when it exits. `unsupervised` also allows supervised commands. Supervised commands need a Unix PTY but not `allowHumanTerminal`. Browser approval is optional, but recommended with `supervised`: without `wsmp config set-terminal-approval on`, this CLI admits any browser the WS Model Proxy server sends it, so "nothing runs without a person's keypress" and "the server never sees unreviewed output" hold only while the server is honest (a compromised server could attach its own viewer, press Enter, and read the output). With approval on, only browsers you approved on this machine can view or answer the request, and both guarantees hold even against a compromised server, provided the dashboard code your browser runs is genuine: that same server serves the code, and the approved browser key is used by it, so a compromised server that also serves you altered dashboard code could act as your approved browser. At most one request waits for confirmation and at most two supervised terminals run per CLI. When the agent asked to see the output, the terminal offers "Review output before sending": the output is then held on this machine and shown only to the reviewing browser, which decides what (if anything) the agent receives. A config written by an older wsmp with `allowMcpCommands: true` loads as `unsupervised`. This setting is switch 3 of 3; the token and the dashboard grant are the others, and the effective mode is the stricter of the grant and this setting (see `../../docs/cli-command-switches.md`). Supervised commands do not need the dashboard's terminal grant: each one needs a person to press Enter on the confirm screen.

Command output is masked on this machine before it enters the server/MCP copy: headless exec stdout/stderr and the shared/review capture of supervised output. The person's encrypted terminal viewer is unchanged. The same restartable scanner as the file tools masks private-key PEM blocks through the matching END label (a missing or mismatched END stays masked), whole lines containing secret-name tokens as `⟦redacted line⟧`, the following non-blank line, and deeper indentation continuation, including blanks inside the run. Tokens are case-insensitive words ending in `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD`, `apikey`, `api-key`, `api_key`, `hf-token` or `hf_token`, or equal to `PASSWORD`; dash-prefixed words use the secret-flag rule. Open quotes/backslashes on the token or following value line continue to a blank line. Secret flags such as `--api-key` / `--hf-token` mask their value tail and continuation. A command naming `.cache/huggingface/token` or `.huggingface/token` has every non-blank output line masked with the Hugging Face token-file class; nothing is read from disk by the masker. A printed dotenv-style token line is masked whole; `KEY=⟦redacted:N⟧` belongs only to the file tools' dotenv view.

Each normal line is scanned once and held until LF or EOF/completion, with at most 64 KiB held per stream. A longer line is scanned in bounded pieces at whitespace and masked whole, so no prefix or unbroken token tail can leak. An over-long line that starts while a multi-line secret run is live — an open private-key PEM block, an open quote or backslash continuation, an indentation run — leaves the rest of that stream opaque through EOF, for the same reason as the 1 MiB case: the state a fresh scanner would drop is what masks the lines that follow, so recovering there would print them raw. With no live opener, at its terminating LF the scanner resets and treats that line as a column-0 secret-name token line: the next non-blank line is masked whole, and subsequent lines indented deeper than column 0 stay masked until normal scanning resumes. Blank lines do not consume the next-line protection; PEM and other opener detection still run on protected lines. CR/LF bytes survive. Accepted residuals, both opaque through EOF with no recovery: more than 1 MiB of input contributing live masking state bounds PEM/indentation state; an over-long line inside a live run fails closed rather than dropping the opener. This is a byte latency bound, not a wall-clock timeout when a process stops writing. EOF flushes the partial last line; teardown flushes exec output or discards an unshared capture. Masking precedes the 8 KiB head / 40 KiB tail retention; `output_bytes` and stream totals count masked bytes. Invalid UTF-8 passes through unless the lossy scan finds a mask. Other secrets (vendor tokens, JWTs, cloud credentials) are not masked, and on an `unsupervised` node masking is not a security boundary. The server's WMP credential-substring scrubber still applies.

This release speaks relay protocol 2.8 only. An older server rejects it and wsmp stops with a message to upgrade the server; a newer server refuses an older wsmp with a message to upgrade wsmp.

### Node file tools (relay 2.8)

Relay 2.8 adds the `file.op` frames behind the MCP node file tools (read, stat, list, search, edit, write, rename, mkdir, delete). The hello now reports `capabilities.fileOps`, `features.mcpFileRead`, `features.fileRootsConfigured` (both false for now) and `features.allowFileToolsAsRoot`. The server and every wsmp upgrade together: a 2.7 wsmp is refused with an upgrade message.

- The file tools follow `mcpCommandMode`, and wsmp re-checks it on every op, whatever the server asks: `unsupervised` runs them headless; `supervised` and `off` refuse (`supervised_only`, `feature_disabled`) because the supervised confirm path and the read-only grant come later. A supervised file request (`term.spawn` with `kind: "file"`) is answered `unsupported` for now.
- Root: when wsmp runs as root (euid 0) every file op is refused as `unsupported`. `wsmp config set-file-tools-as-root on` (restart wsmp to apply) allows it; `wsmp config show` lists `allowFileToolsAsRoot` when it is on.
- Ops run on a small worker pool (two threads, at most four ops in flight) and never on the relay loop, so a slow hash or search cannot stall heartbeats. A write's content arrives as one binary `file.body` frame of at most 1 MiB, and a result text field above 48 KiB goes back as a binary `file.data` frame.
- wsmp logs every op at `info` on stderr: `file op op=edit target=/path outcome=ok reason=...`. `target` is the path (or `from -> to`, or the first of several stat paths, or the search root), `outcome` is `ok` or the error code, and `reason` is the agent's optional note, escaped and cut to 200 characters. File content and error messages are never logged.

### Engine facts and node telemetry (relay 2.7)

An endpoint's `engine` defaults to `auto`: at probe time (connect, reconnect, `wsmp reload`) wsmp asks the engine's server root (the base URL without `/v1`) for `GET /props` (llama.cpp: `total_slots`, per-slot `n_ctx`), `GET /get_server_info` (SGLang: `max_running_requests`, `max_total_num_tokens`), `GET /metrics` (vLLM: `vllm:cache_config_info` blocks × block size; SGLang by its `sglang:` prefix), `GET /api/version` (Ollama) and `GET /api/v0/models` (LM Studio), each with a 3-second timeout and the endpoint's configured headers. `wsmp endpoints engine <slug> <engine>` declares the engine instead and probes only its own route; `generic` turns detection and load sampling off (use it for remote providers). The detected engine, slot count, KV capacity, context limits and the endpoint's `concurrencyLimit` (sent as `slots`; when set it wins over the engine's reported slots, which only fill an unset value) go to the server as engine facts, each marked `probe` or `config`. The server stores them on the model's inference capacity and, while that capacity's hard limit is still automatic, keeps the limit equal to the reported slots; a limit you set in the dashboard is never changed.

After registration a sampling thread sends, never blocking the relay:

- `node.info` once per connection: OS, kernel, architecture, CPU model and count, total RAM, GPUs from `nvidia-smi` (name, UUID, driver, VRAM), whether memory is unified (for example GB10), per-interface addresses, link speed and MTU, and how wsmp runs (foreground, systemd, launchd, container);
- `node.metrics` every 20 seconds: CPU use and load averages, `MemAvailable` and swap from `/proc/meminfo`, free space on `/`, per-GPU VRAM, utilization, temperature, power and SM clock, and per-interface byte counters (lifetime totals since boot, reported at most as 9007199254740991, the largest integer JSON numbers carry without loss);
- `endpoint.load` every 2 seconds when it changes (and every 5 seconds regardless) for llama.cpp (`/slots`, and `/metrics` when started with `--metrics`), vLLM and SGLang (`/metrics`): running and waiting requests, KV use and prefix-cache deltas.

Each endpoint is scraped on its own schedule, 2 seconds after its previous scrape finished, with at most 16 scrapes in flight, so a slow endpoint never delays another endpoint's load or the node metrics. Linux reads `/proc` and `/sys`; other platforms send what they can. `nvidia-smi` runs with a 5-second timeout (the run is over within about a second of it even if `nvidia-smi` is hung in the driver) and its stderr is discarded, and any helper it leaves behind is killed with its process group; HTTP scrapes time out after 2 seconds, and a body over its size limit after decompression is refused. Every reading is held to the server's limits before it is sent (for example CPU use at most 100%, over-long GPU text cut); an out-of-range reading is left out rather than sent. From llama.cpp `/slots` wsmp keeps only each slot's id, `n_ctx` and `is_processing`: prompt text and generated text in that response are never kept or sent. Custom metric sources (below) add their own series to `node.metrics`.

### Custom metric sources

A metric source is a command that wsmp runs every `intervalSecs` seconds; its numbers go to the server in `node.metrics` (`custom`), where pool routing rules can use them. Local sources live in the config file:

```json
{
  "metrics": {
    "sources": {
      "gpu_fan": { "command": "nvidia-smi --query-gpu=fan.speed --format=csv,noheader,nounits | head -1", "intervalSecs": 10, "timeoutSecs": 5, "format": "number" },
      "queue": { "command": "curl -s http://127.0.0.1:9000/stats", "format": "json" },
      "exporter": { "command": "curl -s http://127.0.0.1:9100/metrics", "format": "prometheus" }
    }
  }
}
```

Formats: `number` (one number; the series is named after the source), `json` (an object of `name: number`) and `prometheus` (text exposition, `name{label="value"} 1.5`, comments and timestamps allowed). Only finite numbers are sent. Series names, label keys and label values must match `[A-Za-z0-9_.:-]{1,64}`, with at most 16 labels, and `__proto__` is not accepted as a label key; anything else is dropped, as are names starting with `node.` or `endpoint.` (reserved for built-in metrics). At most 50 series per device are sent. Defaults: `intervalSecs` 10 (5 to 86400), `timeoutSecs` 5 (1 to 300), `format` `number`; a source outside these bounds is reported `disabled` and never runs. Config changes apply within a few seconds without a restart.

Every run is bounded: the command runs with `sh -c` in its own process group, with stdin closed and a scrubbed environment; stdout is capped at 64 KiB (more is reported `output_too_large` and nothing is sent); after the timeout the whole process group is killed (on Windows the whole tree, via a job object) and so is the command itself even if it left the group, and the run is over within about a second of the timeout even if the command does not die (one stuck in the kernel is left to a background reaper; while 8 such processes are still stuck, or 64 runs are in flight or stuck, new runs are refused). On Unix, a helper that left the group and keeps the output pipe open cannot be killed with the group; it leaks nothing in wsmp (no thread, no descriptor) but keeps running until it exits. Windows children are assigned to a job before they start; detached grandchildren and descendants of an exited root stay in that job. Closing its last handle also kills the tree, including when the CLI exits abruptly. When wsmp exits, every run in flight is killed with its process group or Windows job. On Unix, `SIGKILL` of wsmp itself cannot be caught and can leave a command running until it exits by itself (nothing enforces its timeout once wsmp is gone). A panic in a release build kills the runs in flight first (panic hook). stderr is discarded: it is never read, logged or uploaded, and neither is the command's output. Only the parsed numbers, the source names, a state and an error code (`spawn`, `timeout`, `exit_status`, `output_too_large`, `parse`) leave the machine, plus the SHA-256 of each command. Commands run as the OS user that runs wsmp. `wsmp metrics list` shows every source and its state; `wsmp metrics test <name>` runs one now with the same limits and prints what it would report.

On Windows, a contended job lock does not count as process exit. If termination cannot acquire the lock within the cleanup grace, the background reaper retains the run's registration and budget permit and retries termination until it succeeds. Registry identities are unique per run, independent of reusable process IDs. After termination, reaper polling backs off from 5 ms to a 250 ms cap; pending kills keep retrying every 5 ms.

Remote sources are defined over MCP or the API (the dashboard lists them), only for a device whose MCP command mode is `unsupervised` on the server. This CLI still refuses them unless both hold:

1. the local opt-in: `wsmp config set-remote-metric-sources on` (off by default; only settable on this machine; restart wsmp to apply);
2. a local approval of the exact command: `wsmp metrics approve <name> --sha256 <hash>`, where `<hash>` is the SHA-256 `wsmp metrics list` shows for the command you read. The approval pins that hash in the config and is refused if the stored command is no longer the one you reviewed (the flag is required for that reason). When the server changes the command string, the source stops running and shows `pending_approval` until you approve the new one. `wsmp metrics revoke <name>` removes an approval.

Received definitions are stored in `remote-metric-sources.json` in the state directory so `wsmp metrics list` can show them. A local source with the same name wins; the remote one is `refused`.

### Browser terminal viewers

Several browser tabs can view one terminal at once (up to 8, counting tabs waiting for approval). The tab that typed most recently is the writer, and the terminal takes that tab's size; other tabs show the terminal at the writer's size until someone types in them. The CLI encrypts each output frame once under a shared output key, which it sends to each tab under that tab's own end-to-end key and replaces when a tab leaves. Input keys stay separate per tab. With `requireTerminalApproval`, every tab is approved on its own. Closing a tab only stops that tab viewing; "End session" on the terminals page ends the shell for everyone.

Typed or pasted input goes through a per-terminal queue of up to 256 KiB, so a program that stops reading its input never stalls the relay. When that queue is full, further input is dropped and the tab shows an "input dropped" notice.

Ending a terminal session (or the idle timeout, or stopping the daemon) kills every process in the shell's session, not only the shell's process group: background jobs, jobs in their own process groups, and `nohup` or disowned jobs all end with it. A process that calls `setsid()` itself (for example `setsid`, or a daemon that detaches) starts a new session and is not killed. Terminals are Unix-only.

### Terminal identity

Each CLI has a long-lived terminal identity key in `terminal-identity.json` in the state directory (mode 0600). The CLI creates it the first time the daemon starts or `wsmp terminal fingerprint` runs, and never replaces it; a damaged file is an error. The CLI signs its per-start terminal key and its CLI slug with this key. The browser checks that signature before any terminal handshake and pins the identity key for that CLI the first time it sees it.

The terminals page shows each CLI's fingerprint: base32 of the first 20 bytes of SHA-256 of the identity public key, in groups of 4. `wsmp terminal fingerprint` prints the same value (`--json` adds the public key and file path). If the page reports that a CLI's identity key changed, compare the new fingerprint with this command on that machine before you choose "Trust new key". Deleting `terminal-identity.json` creates a new key, and every browser that pinned the old one will ask again.

### Background daemon and user services

- `wsmp daemon start --detach` starts a session-detached relay that owns
  `$WSMP_STATE_DIR/relay.pid` (with a pid + ownership token). Only that detached
  process claims the PID file; foreground `wsmp connect` / `wsmp daemon start`
  and OS services do not. `wsmp status` communicates with the live relay control
  socket, so it also sees foreground and service-managed relays; it exits
  non-zero when no live acknowledged relay is available. `stop` refuses to signal a PID that no longer looks
  like this CLI's daemon (PID-reuse guard).
- The live control socket is Unix-only: it is private to the state directory
  and verifies the connecting process has the daemon's UID using OS peer
  credentials. Windows does not expose this control plane yet. On Windows,
  `wsmp reload --offline` is the explicit safe fallback: it probes and saves
  local state, then reports `published: false`; run the relay on Unix and use
  its live `wsmp reload` to publish. It requires an
  authenticated named-pipe equivalent before it can be supported safely.
- `wsmp service install` installs a **per-user** systemd unit (Linux) or
  LaunchAgent (macOS). Re-running install rewrites the unit/plist and restarts.
- **Device credentials** (`wsmp login`) live in the state directory and work
  under services without extra setup.
- **Logging in again.** `wsmp login` names its CLI slug in the approval
  request, and the browser approval page shows it. Approving a slug you
  already use replaces that device's login: the device keeps its name,
  grants, pools, endpoints, and model ids; its previous device credential is
  revoked and any relay still using it is disconnected (its reconnects are
  refused with 401). If two logins for one slug are approved at about the same
  time, the one approved last wins and the other CLI must log in again. If the
  login moved to another machine, browser terminals ask you to trust the new
  identity key.
- **Deleting a device** in the dashboard deletes its device credentials,
  revokes CLI tokens bound to it, and disconnects its relay. Run `wsmp login`
  on that machine to add it again (as a new device).
- **Device names.** The relay reports this machine's hostname. The dashboard
  shows the name you give the device there, else that hostname, else the CLI
  slug. The slug stays fixed because model ids use it.
- **CLI tokens and endpoint header secrets** are env-var *names* in config, not
  values. User services do not inherit your interactive shell, so export those
  variables and run `wsmp service env-sync` to write them into the private
  `service.env` file (mode `0600` under the config dir). Installers load that
  file via systemd `EnvironmentFile=` or a macOS wrapper script — secrets are
  never embedded in unit/plist files and never printed. `wsmp service env-path`
  prints the file path.
- Linux tip: `loginctl enable-linger "$USER"` keeps a user service running after
  logout.
- **Shutdown (Unix).** SIGTERM (`wsmp daemon stop`, `systemctl stop`), SIGINT
  (Ctrl-C), and SIGHUP stop the relay cleanly in foreground, detached, and
  service modes: it kills every running MCP exec command (its whole process
  group) and every terminal (every process in the shell's session), tells the
  server they ended, closes the websocket, and removes the control socket and
  PID file. It then exits from the same signal (status 143, 130, or 129). A
  signal the relay inherited as ignored, such as SIGHUP under `nohup`, stays
  ignored. Cleanup gets 5 seconds; after that, or on a second signal, the relay
  kills the tracked process groups and sessions directly, removes its files,
  and exits at once.
- **SIGKILL (`kill -9`) cannot be caught.** It is the one way to stop the relay
  that leaves exec commands and terminal processes running, untracked. Prefer
  SIGTERM; if a relay was killed with SIGKILL, find leftovers with
  `ps -o pid,pgid,sid,args` and end them yourself.
- **Shutdown (Windows).** Ctrl-C, Ctrl-Break, closing the console window, and
  a system shutdown start the same cleanup: running MCP exec commands are
  ended, the server hears they finished, and the websocket closes. Cleanup
  gets 5 seconds (Windows itself may end the process sooner after a console
  close); after that, or on a second Ctrl-C, the relay kills the tracked
  commands with their child processes and exits at once. The exit status is
  130 for Ctrl-C, 149 for Ctrl-Break, and 143 otherwise.

### Media expansion for local upstreams

The relay normally forwards request bodies untouched, so a signed
`{server}/media/{id}` URL in a chat request is fetched by the upstream model
server. Many local OpenAI-compatible servers (llama.cpp, LM Studio, some vLLM
builds) cannot fetch remote URLs and only accept base64 `data:` URLs.

Opt in per endpoint with `expandMedia` (config key) or `--expand-media` on
`endpoints add`. When enabled, the relay buffers chat-shaped JSON request bodies
(`Content-Type: application/json`), walks `image_url` / `video_url` /
`input_audio` content parts, fetches each media URL, and inlines it as a
`data:{mime};base64,…` URL before forwarding upstream. Still-image `image_url`
parts are normalized to JPEG/PNG when inlined (WebP/GIF and other non-safe
formats are re-encoded to JPEG) so local vision servers that reject WebP still
work. Video/audio keep their stored mime. Non-JSON bodies and body-less
requests always take the untouched streaming path.

Multipart `/v1/audio/transcriptions` and `/v1/audio/translations` requests are
also relayed to the selected OpenAI-compatible upstream. These dedicated ASR
operations are independent of chat `input_audio`; capability metadata should
describe each separately. Advanced transcription behavior (streaming,
timestamps, diarization, languages, formats, and accepted MIME types) belongs
to the upstream and is forwarded without transcript normalization.

Each upstream request has three backend-neutral timeout layers: a 10-second
connection timeout, a 30-second response-body idle timeout (reset after every
received chunk), and the operation timeout sent by the WMP server. Pool retries
share one server-side operation deadline; adding members does not multiply it.

### Reasoning capability metadata

Capability inventories at version 3 or 4 may declare `reasoningConfig` on a
surface when its native reasoning ladder and encoding are known. Omit it when
they are unknown; `reasoning: true` remains the routing gate. Upgrade the WMP
server before publishing this optional field, because older servers reject it
as an unknown capability property.

### Stream usage opt-out

A version 3 or 4 `openaiChatCompletions` surface may declare `streamUsage: false`
when the endpoint rejects `stream_options.include_usage`; adapted streaming
requests then omit it, and settlement keeps the conservative liability because
no stream usage is reported. Absent means `true`. The CLI rejects `streamUsage`
on any other surface. Upgrade the WMP server first: older servers reject the
field as an unknown capability property.

Only URLs whose origin matches the connected WMP server (derived from
`serverUrl`) and whose path is `/media/{id}` are fetched — arbitrary URLs from
request bodies are never followed (SSRF guard). Add extra trusted origins with
the `mediaTrustedOrigins` config array. The media fetcher follows no redirects,
so a trusted origin cannot 30x-redirect the relay to an arbitrary internal URL
after the origin check. Each individual asset fetch is capped at 64 MiB, and the
buffered body (with its base64-inflated result) is capped at 256 MiB overall;
over-cap or failed fetches return an OpenAI-shaped relay error naming the media
path (never the URL signature).

### Exit Codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | runtime error |
| 2 | usage error |
| 3 | not found |
| 128 + signal | the relay stopped on SIGHUP (129), SIGINT (130), or SIGTERM (143); on Unix it dies from that signal after cleanup |

## Install After Release

These commands work after the first public GitHub release.

**Shell:**

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/FlyCockpit/ws-model-proxy/releases/latest/download/wsmp-installer.sh | sh
```

**PowerShell:**

```powershell
irm https://github.com/FlyCockpit/ws-model-proxy/releases/latest/download/wsmp-installer.ps1 | iex
```

**Homebrew:**

```sh
brew install flycockpit/tap/wsmp
```

**From source:**

```sh
git clone https://github.com/FlyCockpit/ws-model-proxy
cd ws-model-proxy
cargo install --path apps/cli --bin wsmp
```

## Development

```sh
cargo build
cargo test --workspace --all-targets --locked
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo fmt
cargo run -- config path
```

Before considering a change done, run the full local gate:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
cargo xtask sync-docs --check
```

See [AGENTS.md](AGENTS.md) for repository conventions and [CONTRIBUTING.md](CONTRIBUTING.md) for the PR checklist.

## Guides

- [Error handling](docs/error-handling.md)
- [Releasing](docs/releasing.md)

## Project Layout

```text
src/
  lib.rs         shared implementation modules
  main.rs        entry: parse -> log -> dispatch -> exit code
  cli.rs         clap argument definitions
  commands/      one file per subcommand
  config.rs      TOML config load/save
  state.rs       local auth and relay state
  daemon.rs      websocket relay session
  probe.rs       endpoint/model probing
  paths.rs       cross-platform config/data dirs
  logging.rs     tracing setup; logs go to stderr
  exit.rs        stable exit codes
tests/cli.rs     black-box CLI tests
xtask/           project automation: sync-docs
docs/            error handling and release notes
tap/             notes for publishing a Homebrew tap
```

## Agent Docs

`AGENTS.md` is the source of truth for CLI contributor and agent instructions. `CLAUDE.md` and `.cursorrules` are generated mirrors. Edit `AGENTS.md`, then run:

```sh
cargo xtask sync-docs
```

Do not hand-edit generated mirrors. Release orchestration lives in the root `.github/workflows/release.yml`.

## License

MIT. See [LICENSE-MIT](LICENSE-MIT).
