//! The relay's Task Scheduler task as `wsmp service install` registers it:
//! its command line and its XML definition.

use super::text::xml_escape;

/// Kept in the state dir; marks the service as installed.
pub const DEFINITION_FILE: &str = "wsmp-relay-task.xml";
pub const LOG_FILE: &str = "relay.log";

/// One argument for a Windows command line, as `CommandLineToArgvW` (and
/// Rust's own argument parser) reads it back.
pub fn quote_arg(value: &str) -> String {
    if !value.is_empty() && !value.contains([' ', '\t', '"']) {
        return value.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for ch in value.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(ch);
                backslashes = 0;
            }
        }
    }
    // Backslashes before the closing quote are doubled, so `C:\dir\`
    // does not swallow it.
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

/// The `conhost.exe` arguments: headless, then `wsmp run` with the
/// pinned paths.
pub fn arguments(executable: &str, config: &str, state_dir: &str, log_file: &str) -> String {
    [
        "--headless",
        executable,
        "run",
        "--service",
        "--config",
        config,
        "--state-dir",
        state_dir,
        "--log-file",
        log_file,
    ]
    .iter()
    .map(|arg| quote_arg(arg))
    .collect::<Vec<_>>()
    .join(" ")
}

/// The task definition `schtasks /Create /XML` reads. `user_sid` names
/// both the logon trigger and the principal.
pub fn render_xml(user_sid: &str, arguments: &str, working_directory: &str) -> String {
    let sid = xml_escape(user_sid);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
         <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
         \x20 <RegistrationInfo>\n\
         \x20   <Description>WS Model Proxy relay (`wsmp run`), installed by `wsmp service install`.</Description>\n\
         \x20 </RegistrationInfo>\n\
         \x20 <Triggers>\n\
         \x20   <LogonTrigger>\n\
         \x20     <Enabled>true</Enabled>\n\
         \x20     <UserId>{sid}</UserId>\n\
         \x20   </LogonTrigger>\n\
         \x20   <TimeTrigger>\n\
         \x20     <Repetition>\n\
         \x20       <Interval>PT5M</Interval>\n\
         \x20       <StopAtDurationEnd>false</StopAtDurationEnd>\n\
         \x20     </Repetition>\n\
         \x20     <StartBoundary>2026-01-01T00:00:00</StartBoundary>\n\
         \x20     <Enabled>true</Enabled>\n\
         \x20   </TimeTrigger>\n\
         \x20 </Triggers>\n\
         \x20 <Principals>\n\
         \x20   <Principal id=\"Author\">\n\
         \x20     <UserId>{sid}</UserId>\n\
         \x20     <LogonType>InteractiveToken</LogonType>\n\
         \x20     <RunLevel>LeastPrivilege</RunLevel>\n\
         \x20   </Principal>\n\
         \x20 </Principals>\n\
         \x20 <Settings>\n\
         \x20   <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n\
         \x20   <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n\
         \x20   <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n\
         \x20   <AllowHardTerminate>true</AllowHardTerminate>\n\
         \x20   <StartWhenAvailable>false</StartWhenAvailable>\n\
         \x20   <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n\
         \x20   <IdleSettings>\n\
         \x20     <StopOnIdleEnd>false</StopOnIdleEnd>\n\
         \x20     <RestartOnIdle>false</RestartOnIdle>\n\
         \x20   </IdleSettings>\n\
         \x20   <AllowStartOnDemand>true</AllowStartOnDemand>\n\
         \x20   <Enabled>true</Enabled>\n\
         \x20   <Hidden>false</Hidden>\n\
         \x20   <RunOnlyIfIdle>false</RunOnlyIfIdle>\n\
         \x20   <WakeToRun>false</WakeToRun>\n\
         \x20   <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n\
         \x20   <Priority>5</Priority>\n\
         \x20   <RestartOnFailure>\n\
         \x20     <Interval>PT1M</Interval>\n\
         \x20     <Count>999</Count>\n\
         \x20   </RestartOnFailure>\n\
         \x20 </Settings>\n\
         \x20 <Actions Context=\"Author\">\n\
         \x20   <Exec>\n\
         \x20     <Command>%SystemRoot%\\System32\\conhost.exe</Command>\n\
         \x20     <Arguments>{arguments}</Arguments>\n\
         \x20     <WorkingDirectory>{working_directory}</WorkingDirectory>\n\
         \x20   </Exec>\n\
         \x20 </Actions>\n\
         </Task>\n",
        arguments = xml_escape(arguments),
        working_directory = xml_escape(working_directory),
    )
}

/// UTF-16LE with a byte-order mark, as the declaration says.
pub fn utf16_bytes(text: &str) -> Vec<u8> {
    std::iter::once(0xFEFF_u16)
        .chain(text.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect()
}

/// The last `count` lines of `text`.
pub fn last_lines(text: &str, count: usize) -> Vec<&str> {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(count)..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_task_quotes_arguments_as_windows_reads_them() {
        assert_eq!(quote_arg(r"C:\Users\me\wsmp.exe"), r"C:\Users\me\wsmp.exe");
        assert_eq!(
            quote_arg(r"C:\Program Files\wsmp\wsmp.exe"),
            r#""C:\Program Files\wsmp\wsmp.exe""#
        );
        // A trailing backslash must not escape the closing quote.
        assert_eq!(quote_arg(r"C:\my state\"), r#""C:\my state\\""#);
        assert_eq!(quote_arg(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(quote_arg(""), r#""""#);
    }

    #[test]
    fn windows_task_runs_the_relay_headless_with_pinned_paths() {
        let arguments = arguments(
            r"C:\Users\Jo Doe\.cargo\bin\wsmp.exe",
            r"C:\Users\Jo Doe\.config\ws-model-proxy\config.json",
            r"C:\Users\Jo Doe\AppData\Local\ws-model-proxy",
            r"C:\Users\Jo Doe\AppData\Local\ws-model-proxy\logs\relay.log",
        );
        assert!(
            arguments
                .starts_with(r#"--headless "C:\Users\Jo Doe\.cargo\bin\wsmp.exe" run --service "#)
        );
        assert!(
            arguments.contains(r#"--state-dir "C:\Users\Jo Doe\AppData\Local\ws-model-proxy""#)
        );
        let xml = render_xml("S-1-5-21-1-2-3-1001", &arguments, r"C:\Users\Jo & Doe");
        assert!(xml.contains("<UserId>S-1-5-21-1-2-3-1001</UserId>"));
        assert_eq!(xml.matches("<UserId>").count(), 2, "trigger and principal");
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains(r"<Command>%SystemRoot%\System32\conhost.exe</Command>"));
        assert!(xml.contains("<Arguments>--headless &quot;C:\\Users\\Jo Doe"));
        assert!(xml.contains(r"<WorkingDirectory>C:\Users\Jo &amp; Doe</WorkingDirectory>"));
        // No secret or environment ever goes in.
        assert!(!xml.contains("WSMP_"));
        let bytes = utf16_bytes("<a/>");
        assert_eq!(&bytes[..4], &[0xFF, 0xFE, b'<', 0]);
    }

    #[test]
    fn windows_task_names_are_per_user_and_safe() {
        assert_eq!(
            crate::service::task_names::task_name(
                crate::service::task_names::RELAY_PREFIX,
                "S-1-5-21-1-2-3-1001"
            ),
            "wsmp-relay-S-1-5-21-1-2-3-1001"
        );
        assert_eq!(
            crate::service::task_names::legacy_task_name(
                crate::service::task_names::RELAY_PREFIX,
                r"Jo Doe\x"
            ),
            "wsmp-relay-Jo_Doe_x"
        );
        assert_eq!(last_lines("a\nb\nc\n", 2), ["b", "c"]);
        assert_eq!(last_lines("a\n", 5), ["a"]);
    }
}
