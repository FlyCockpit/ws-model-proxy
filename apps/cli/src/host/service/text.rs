//! What the service files say: the systemd unit, the LaunchAgent plist and
//! its wrapper as `wsmp service install` renders them, and the quoting each
//! grammar needs, refusing any value a service file cannot hold.

use std::path::Path;

use anyhow::{Context, Result};

/// A character wsmp does not write into a service file: a control character
/// (C0 such as LF, CR, tab and NUL; DEL; C1), or U+FFFE / U+FFFF. One rule
/// for every renderer is wsmp's policy; what each grammar does with them:
/// - systemd (`systemd.syntax(7)`): a unit is read line by line, so LF and CR
///   end the setting inside quotes (`Unbalanced quoting`), and NUL ends it;
/// - launchd plists are XML 1.0: C0 other than tab, LF and CR, and U+FFFE /
///   U+FFFF, are not `Char`s (§2.2), and a parser turns CR and CRLF into LF
///   (§2.11). Tab, LF and C1 would come back as written; they are refused
///   by the policy, not by XML;
/// - the `/bin/sh` wrapper: a shell script holds no NUL (POSIX XCU 2.1, text
///   files), and a value's LF would put a second line into the file wsmp
///   reads back as its own.
///
/// So [`refuse_unwritable`] refuses them, before anything is written.
fn unwritable(ch: char) -> bool {
    ch.is_control() || matches!(ch, '\u{FFFE}' | '\u{FFFF}')
}

/// An error, before anything is written, when `value` (named by `what`)
/// holds a character [`unwritable`] in a service file.
pub(crate) fn refuse_unwritable(what: &str, value: &str) -> Result<()> {
    if let Some(ch) = value.chars().find(|&ch| unwritable(ch)) {
        anyhow::bail!(
            "{what} `{}` contains the control character U+{:04X}, which a service file cannot hold; nothing was written. Use a path without it, then run `wsmp service install`",
            value.escape_debug(),
            u32::from(ch)
        );
    }
    Ok(())
}

/// `path` exactly as text, or an error naming it (`what`), before anything
/// is written or run: `display()` writes U+FFFD for bytes that are not
/// UTF-8, which would name another file. Service files and the commands
/// that load them carry paths as UTF-8 text.
pub(crate) fn path_text<'a>(what: &str, path: &'a Path) -> Result<&'a str> {
    path.to_str().with_context(|| {
        format!(
            "{what} `{}` is not valid UTF-8; nothing was written",
            path.display()
        )
    })
}

/// Where a value goes in a systemd unit, which decides how
/// [`systemd_quote`] writes it (`systemd.service(5)`, "Command lines";
/// `systemd.exec(5)`, `Environment=`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SystemdField {
    /// The program of `ExecStart=`: systemd runs this path as written
    /// (variables are expanded only in the arguments), so `$` is itself.
    ExecPath,
    /// An argument of `ExecStart=`: `${NAME}` and `$NAME` are expanded from
    /// the service's environment, inside quotes too, and `$$` is one `$`; so
    /// each `$` is written `$$`.
    ExecArg,
    /// An `Environment=` assignment: "the `$` character has no special
    /// meaning", so it is itself.
    Environment,
}

/// `value` as one word of a unit line for `field`. Inside double quotes
/// systemd unescapes C escapes, so `\` and `"` are escaped; `%` starts a
/// specifier in every setting and is doubled (`systemd.unit(5)`,
/// "Specifiers"); `$` is doubled in an [`SystemdField::ExecArg`]. An empty
/// value is `""` (an empty argument; written bare it would be none). A value
/// with a character [`unwritable`] is an error.
fn systemd_quote(value: &str, field: SystemdField) -> Result<String> {
    refuse_unwritable("the value", value)?;
    let safe = !value.is_empty()
        && value.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(ch, '/' | '.' | '_' | '-' | ':' | '@' | '+' | '=')
        });
    if safe {
        return Ok(value.to_string());
    }
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            // systemd treats `%` as a specifier in unit files.
            '%' => out.push_str("%%"),
            '$' if field == SystemdField::ExecArg => out.push_str("$$"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    Ok(out)
}

/// One argument (after the program) of an `ExecStart=` line, kept exactly as
/// it is: quoted, with `$` written `$$` so systemd does not expand it
/// ([`SystemdField::ExecArg`]).
pub fn systemd_exec_arg(value: &str) -> Result<String> {
    systemd_quote(value, SystemdField::ExecArg)
}

/// An `Environment=` setting's value for `name=value`, kept exactly as it is
/// ([`SystemdField::Environment`]: `$` is itself there).
pub fn systemd_environment(name: &str, value: &str) -> Result<String> {
    refuse_unwritable(&format!("the pinned `{name}`"), value)?;
    systemd_quote(&format!("{name}={value}"), SystemdField::Environment)
}

/// The program of an `ExecStart=` line: an absolute path (a leading `-`, `@`,
/// `+`, `!` or `:` is a prefix to systemd, a bare name is looked up), with no
/// character systemd's `string_is_safe()` refuses in an executable name
/// (`"`, `'`, `\` and control characters: "Executable name contains special
/// characters", `systemd.service(5)`, "Command lines"), then quoted
/// ([`SystemdField::ExecPath`]).
pub fn systemd_exec_path(path: &str) -> Result<String> {
    refuse_unwritable("the wsmp executable path", path)?;
    anyhow::ensure!(
        path.starts_with('/'),
        "the wsmp executable path `{path}` is not absolute; nothing was written"
    );
    anyhow::ensure!(
        !path.contains(['"', '\'', '\\']),
        "the wsmp executable path `{path}` contains a quote or a backslash, which systemd refuses in the program it runs; nothing was written. Install wsmp on a path without them, then run `wsmp service install`"
    );
    systemd_quote(path, SystemdField::ExecPath)
}

/// Render a systemd user unit for the relay. `pinned` holds non-secret
/// `Environment=` entries (see [`pinned_service_env`](super::path_env::pinned_service_env)). An error, with
/// nothing rendered, for a value systemd would read differently
/// ([`systemd_exec_path`], [`systemd_quote_arg`]).
pub fn render_systemd_user_unit(executable: &str, pinned: &[(&str, String)]) -> Result<String> {
    let exec = systemd_exec_path(executable)?;
    let pinned: String = pinned
        .iter()
        .map(|(name, value)| {
            Ok(format!(
                "Environment={}\n",
                systemd_environment(name, value)?
            ))
        })
        .collect::<Result<_>>()?;
    Ok(format!(
        "[Unit]\n\
         Description=WS Model Proxy relay\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exec} run\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         # Exit 4: the credential is missing or was rejected (HTTP 401, including a\n\
         # temporary ban); restarting cannot fix it. Run `wsmp login`, then\n\
         # `wsmp service restart`.\n\
         # Exit 5: the server refused this wsmp's relay protocol. Re-run the\n\
         # server's install.sh (or upgrade the server), then `wsmp service restart`.\n\
         RestartPreventExitStatus=4 5\n\
         Environment=WSMP_STOP_ON_PROTOCOL_MISMATCH=1\n\
         # Tells the relay it may exit 4 here instead of retrying in-process.\n\
         Environment=WSMP_STOP_ON_REJECTED_CREDENTIAL=1\n\
         # The config and state paths `wsmp service install` resolved, so the service\n\
         # reads the same device credential as the installing shell.\n\
         {pinned}\
         WorkingDirectory=%h\n\
         StandardOutput=journal\n\
         StandardError=journal\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    ))
}

/// Render a macOS LaunchAgent plist. `program` is the wrapper script path so the
/// plist never embeds secret environment values. Each value is XML text
/// ([`plist_text`]); an error, with nothing rendered, for one XML cannot
/// carry.
///
/// `ProcessType` is `Standard`, set explicitly: the relay, and every command,
/// terminal and runtime it starts (which inherit its QoS), run at normal
/// priority. `Background` would coalesce its timers (a 2 ms sleep took about
/// 80 ms) and keep its children on the efficiency cores with throttled I/O.
/// Only the update dead-man runs at `Background`
/// ([`crate::relay::update::deadman::render_macos_plist`]).
pub fn render_launch_agent_plist(
    label: &str,
    program: &str,
    working_directory: &str,
    stdout_path: &str,
    stderr_path: &str,
) -> Result<String> {
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key>\n\
         \t<string>{label}</string>\n\
         \t<key>ProgramArguments</key>\n\
         \t<array>\n\
         \t\t<string>{program}</string>\n\
         \t</array>\n\
         \t<key>RunAtLoad</key>\n\
         \t<true/>\n\
         \t<key>KeepAlive</key>\n\
         \t<true/>\n\
         \t<key>ThrottleInterval</key>\n\
         \t<integer>5</integer>\n\
         \t<key>ProcessType</key>\n\
         \t<string>Standard</string>\n\
         \t<key>WorkingDirectory</key>\n\
         \t<string>{working_directory}</string>\n\
         \t<key>StandardOutPath</key>\n\
         \t<string>{stdout_path}</string>\n\
         \t<key>StandardErrorPath</key>\n\
         \t<string>{stderr_path}</string>\n\
         </dict>\n\
         </plist>\n",
        label = plist_text("the LaunchAgent label", label)?,
        program = plist_text("the wrapper path", program)?,
        working_directory = plist_text("the home directory", working_directory)?,
        stdout_path = plist_text("the log path", stdout_path)?,
        stderr_path = plist_text("the log path", stderr_path)?,
    ))
}

/// Render the 0700 wrapper that pins the service's paths then execs wsmp.
/// Values are single-quoted: inside single quotes `sh` takes every character
/// as itself except `'` (POSIX XCU 2.2.2), which [`shell_single_quote`]
/// writes as `'"'"'`. An error, with nothing rendered, for a relative
/// `executable` (`exec` would search `PATH`) or a value with a character
/// [`unwritable`].
pub fn render_macos_service_wrapper(executable: &str, pinned: &[(&str, String)]) -> Result<String> {
    refuse_unwritable("the wsmp executable path", executable)?;
    anyhow::ensure!(
        executable.starts_with('/'),
        "the wsmp executable path `{executable}` is not absolute; nothing was written"
    );
    let pinned: String = pinned
        .iter()
        .map(|(name, value)| {
            refuse_unwritable(&format!("the pinned `{name}`"), value)?;
            Ok(format!("export {name}='{}'\n", shell_single_quote(value)))
        })
        .collect::<Result<_>>()?;
    Ok(format!(
        "#!/bin/sh\n\
         # Generated by `wsmp service install`: the config and state paths and\n\
         # PATH of the installing shell (no secrets), then the relay.\n\
         set -eu\n\
         {pinned}\
         exec '{executable}' run\n",
        executable = shell_single_quote(executable),
    ))
}

pub(crate) fn shell_single_quote(value: &str) -> String {
    // Paths from current_exe / config_dir should not contain `'`; defend anyway.
    value.replace('\'', "'\"'\"'")
}

/// `value` as plist (XML 1.0) character data: markup characters escaped
/// ([`xml_escape`]), and an error, with nothing rendered, for a character
/// [`unwritable`] (not an XML `Char`, or one a parser would not give back as
/// written).
pub(crate) fn plist_text(what: &str, value: &str) -> Result<String> {
    refuse_unwritable(what, value)?;
    Ok(xml_escape(value))
}

pub(crate) fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The LaunchAgent plist `wsmp service install` writes: it runs `wrapper`,
/// and logs to [`super::macos_log_dir`]. A Homebrew update renders it again
/// ([`ensure_stable_executable`](super::files::ensure_stable_executable)).
#[cfg(target_os = "macos")]
pub(crate) fn macos_plist(wrapper: &Path) -> Result<String> {
    let log_dir = super::macos_log_dir()?;
    let home = dirs::home_dir().context("could not determine the user home directory")?;
    // Each path as it is ([`path_text`]): the plist is UTF-8 XML.
    render_launch_agent_plist(
        super::MACOS_LABEL,
        path_text("the wrapper path", wrapper)?,
        path_text("the home directory", &home)?,
        path_text("the log path", &log_dir.join("relay.out.log"))?,
        path_text("the log path", &log_dir.join("relay.err.log"))?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R5-A-1: no renderer writes a value its reader would read differently.
    /// A control character (LF, CR, NUL, tab, DEL, C1) or U+FFFE in the
    /// executable or any pin is an error for the unit, the wrapper and the
    /// plist; so is an executable systemd refuses (a quote, a backslash) or a
    /// relative one. Inverses: spaces, quotes, `%`, `$` and non-ASCII in pins
    /// still render.
    #[test]
    fn a_value_no_service_file_can_hold_is_refused_by_every_renderer() {
        let pin = |value: &str| vec![("WSMP_CONFIG", value.to_string())];
        let ok = pin("/u/c.json");
        for bad in ["\n", "\r", "\0", "\t", "\u{7f}", "\u{85}", "\u{fffe}"] {
            let value = format!("/u/a{bad}b");
            let unit_exec = render_systemd_user_unit(&value, &ok).expect_err("unit exec");
            assert!(
                format!("{unit_exec:#}").contains("nothing was written"),
                "{unit_exec:#}"
            );
            assert!(render_systemd_user_unit("/u/wsmp", &pin(&value)).is_err());
            assert!(render_macos_service_wrapper(&value, &ok).is_err());
            assert!(render_macos_service_wrapper("/u/wsmp", &pin(&value)).is_err());
            assert!(render_launch_agent_plist("l", &value, "/u", "/u/o", "/u/e").is_err());
            assert!(render_launch_agent_plist("l", "/u/w", &value, "/u/o", "/u/e").is_err());
            assert!(render_launch_agent_plist("l", "/u/w", "/u", "/u/o", &value).is_err());
            assert!(systemd_exec_arg(&value).is_err());
            assert!(systemd_environment("WSMP_CONFIG", &value).is_err());
        }
        for bad in ["/u/a\"b", "/u/a'b", "/u/a\\b", "wsmp", "-/u/wsmp"] {
            assert!(render_systemd_user_unit(bad, &ok).is_err(), "{bad}");
        }
        assert!(render_macos_service_wrapper("wsmp", &ok).is_err());
        let odd = "/u/it's a \"b\\c\" 100% $HOME é";
        let unit = render_systemd_user_unit("/u/a b%$é/wsmp", &pin(odd)).expect("unit");
        assert!(
            unit.contains("ExecStart=\"/u/a b%%$é/wsmp\" run\n"),
            "{unit}"
        );
        assert!(render_macos_service_wrapper("/u/a b'c/wsmp", &pin(odd)).is_ok());
        assert!(render_launch_agent_plist("l", odd, odd, odd, odd).is_ok());
    }

    #[test]
    fn systemd_unit_quotes_special_paths_and_pins_no_secret() {
        let unit = render_systemd_user_unit(
            "/opt/ws model/wsmp",
            &[
                (
                    "WSMP_CONFIG",
                    "/home/user/.config/ws-model-proxy/config.json".to_string(),
                ),
                ("WSMP_STATE_DIR", "/srv/wsmp state/100%".to_string()),
                ("PATH", "/home/user/.local/bin:/usr/bin".to_string()),
            ],
        )
        .expect("render");
        assert!(unit.contains("ExecStart=\"/opt/ws model/wsmp\" run"));
        assert!(!unit.contains("EnvironmentFile"));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains(&format!(
            "RestartPreventExitStatus={} {}\n",
            crate::exit::ExitCode::CredentialRejected as i32,
            crate::exit::ExitCode::RelayProtocolMismatch as i32
        )));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(
            unit.contains(
                "Environment=WSMP_CONFIG=/home/user/.config/ws-model-proxy/config.json\n"
            )
        );
        assert!(unit.contains("Environment=\"WSMP_STATE_DIR=/srv/wsmp state/100%%\"\n"));
        assert!(unit.contains("Environment=PATH=/home/user/.local/bin:/usr/bin\n"));
        assert!(unit.contains(&format!(
            "Environment={}=1\n",
            crate::host::service::STOP_ON_REJECTED_CREDENTIAL_ENV
        )));
        assert!(unit.contains(&format!(
            "Environment={}=1\n",
            crate::host::service::STOP_ON_PROTOCOL_MISMATCH_ENV
        )));
        // Only the pinned paths and the stop markers: no token or header variables.
        assert_eq!(unit.matches("Environment=").count(), 5);
    }

    /// R6-B-2 / R6-A-1: each place in a unit has its own rule for `$`:
    /// doubled in an `ExecStart=` argument (systemd expands `${NAME}` and
    /// `$NAME` there, inside quotes too, and `$$` is one `$`), itself in the
    /// program path and in an `Environment=` value. `%` is doubled in all
    /// three; an empty argument stays an argument.
    #[test]
    fn systemd_quotes_each_place_by_its_own_rule() {
        assert_eq!(
            systemd_exec_arg("/usr/bin/wsmp").expect("quote"),
            "/usr/bin/wsmp"
        );
        assert_eq!(
            systemd_exec_arg("/tmp/a\"b%c").expect("quote"),
            "\"/tmp/a\\\"b%%c\""
        );
        assert_eq!(
            systemd_exec_arg("/tmp/${HOME}/$$/a b%").expect("quote"),
            "\"/tmp/$${HOME}/$$$$/a b%%\""
        );
        assert_eq!(systemd_exec_arg("").expect("quote"), "\"\"");
        assert_eq!(
            systemd_exec_path("/tmp/$HOME/a b%/wsmp").expect("quote"),
            "\"/tmp/$HOME/a b%%/wsmp\""
        );
        assert_eq!(
            systemd_environment("WSMP_STATE_DIR", "/tmp/${HOME}/$$ %").expect("quote"),
            "\"WSMP_STATE_DIR=/tmp/${HOME}/$$ %%\""
        );
    }

    /// F-FB-3: the wrapper path the LaunchAgent plist names
    /// ([`macos_wrapper_path`], for `wsmp service install` and a Homebrew
    /// update alike) is absolute even from a relative `WSMP_STATE_DIR`:
    /// resolved against this process's working directory, where that state
    /// directory is, not launchd's. An absolute one is kept as it is.
    #[cfg(unix)]
    #[test]
    fn the_wrapper_the_plist_names_is_absolute_from_a_relative_state_dir() {
        let cwd = std::env::current_dir().expect("cwd");
        let wrapper =
            crate::host::service::absolute_in(Path::new("rel-state"), "wsmp-service-run.sh")
                .expect("path");
        assert!(wrapper.is_absolute(), "{}", wrapper.display());
        assert_eq!(wrapper, cwd.join("rel-state").join("wsmp-service-run.sh"));
        let fixed = cwd.join("abs-state");
        assert_eq!(
            crate::host::service::absolute_in(&fixed, "wsmp-service-run.sh").expect("path"),
            fixed.join("wsmp-service-run.sh")
        );
        let plist = render_launch_agent_plist(
            crate::host::service::MACOS_LABEL,
            path_text("the wrapper path", &wrapper).expect("text"),
            "/Users/u",
            "/Users/u/Library/Logs/ws-model-proxy/relay.out.log",
            "/Users/u/Library/Logs/ws-model-proxy/relay.err.log",
        )
        .expect("render");
        assert!(
            plist.contains(&format!(
                "<string>{}</string>",
                xml_escape(path_text("w", &wrapper).expect("text"))
            )),
            "{plist}"
        );
    }

    #[test]
    fn launch_agent_plist_uses_wrapper_and_escapes_xml() {
        let label = "com.flycockpit.wsmp";
        let plist = render_launch_agent_plist(
            label,
            "/tmp/wsmp-service-run.sh",
            "/Users/test",
            "/Users/test/Library/Logs/ws-model-proxy/relay.out.log",
            "/Users/test/Library/Logs/ws-model-proxy/relay.err.log",
        )
        .expect("render");
        assert!(plist.contains(&format!("<string>{label}</string>")));
        assert!(plist.contains("<string>/tmp/wsmp-service-run.sh</string>"));
        assert!(plist.contains("<key>KeepAlive</key>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<true/>"));
        assert!(!plist.contains("EnvironmentVariables"));
        // The relay and what it starts run at normal priority, said explicitly.
        assert!(
            plist.contains("<key>ProcessType</key>\n\t<string>Standard</string>\n"),
            "{plist}"
        );
        assert_eq!(
            plist.matches("<key>ProcessType</key>").count(),
            1,
            "{plist}"
        );
        let escaped = render_launch_agent_plist(
            "label",
            "/tmp/a&b<c>.sh",
            "/Users/test",
            "/tmp/out",
            "/tmp/err",
        )
        .expect("render");
        assert!(escaped.contains("/tmp/a&amp;b&lt;c&gt;.sh"));
    }

    #[test]
    fn macos_wrapper_pins_paths_and_execs_foreground_daemon() {
        let script = render_macos_service_wrapper(
            "/usr/local/bin/wsmp",
            &[
                ("WSMP_STATE_DIR", "/Users/x/it's state".to_string()),
                ("PATH", "/Users/x/.cargo/bin:/usr/bin".to_string()),
            ],
        )
        .expect("render");
        assert!(script.contains("export PATH='/Users/x/.cargo/bin:/usr/bin'\n"));
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("export WSMP_STATE_DIR='/Users/x/it'\"'\"'s state'\n"));
        assert!(!script.contains("ENV_FILE"));
        assert!(script.contains("exec '/usr/local/bin/wsmp' run"));
    }
}
