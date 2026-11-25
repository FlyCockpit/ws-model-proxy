//! The Homebrew strategy, run by the update worker and by `wsmp update`.

use crate::relay::update::flow::{self, Ended, Machine, Progress, Request};
use crate::wire::protocol::frames::{UpdatePhase, UpdateReason};

/// The Homebrew strategy (D10), in this order:
///
/// 1. refuse a pinned or foreign install;
/// 2. refresh the tap (`brew update`) and refuse, with nothing installed,
///    when it does not have exactly the version asked for: before any wait
///    for idle, so the refusal (and the version the tap has) comes at once;
/// 3. the last idle check and the work hold (`before_swap`);
/// 4. make the service start the stable `opt` path (an update that cannot
///    stops here);
/// 5. take Homebrew's update lock ([`crate::relay::update::homebrew::TapLock`]), check the
///    tap's version again under it, and `brew upgrade` still under it: an
///    ordinary `brew update` meanwhile fails at once on the held lock (and has
///    to be run again). One that was already starting when a `brew cleanup`
///    replaced the lock file can still move the tap (a gap in Homebrew's own
///    locking): step 6 reports that as a version mismatch. So can one in the
///    window after wsmp dies mid-upgrade, but then no step 6 runs: the
///    server's deadline and the version the next start reports show it;
/// 6. require the installed version, and record it.
///
/// Full control and the operator's setting are asked again right before each
/// step that changes something: the tap refresh, the service, the upgrade.
pub fn homebrew(machine: &Machine<'_>, request: &Request, progress: &mut dyn Progress) -> Ended {
    let fail = |progress: &mut dyn Progress, phase, reason, detail: String| {
        progress.report(
            phase,
            Some(reason),
            Some(crate::relay::update::clip_detail(&detail)),
        );
        Ended::Stopped
    };
    let proceed = |progress: &mut dyn Progress| match machine.proceed.map(|proceed| proceed()) {
        Some(Err((reason, detail))) => Err(fail(progress, UpdatePhase::Refused, reason, detail)),
        _ => Ok(()),
    };
    let Some(keg) = crate::relay::update::homebrew::keg_of(&machine.live) else {
        return fail(
            progress,
            UpdatePhase::Refused,
            UpdateReason::UnsupportedMethod,
            format!(
                "wsmp is not in a Homebrew keg; run: {}",
                crate::relay::update::homebrew::MANUAL_COMMAND
            ),
        );
    };
    match crate::relay::update::homebrew::refusal(&keg) {
        Ok(None) => {}
        Ok(Some(why)) => {
            return fail(
                progress,
                UpdatePhase::Refused,
                UpdateReason::UnsupportedMethod,
                why,
            );
        }
        Err(error) => {
            return fail(
                progress,
                UpdatePhase::Failed,
                UpdateReason::Internal,
                format!("{error:#}"),
            );
        }
    }
    // The tap's version before anything is installed: `brew upgrade` takes
    // whatever the tap has, and the keg it switches to cannot be rolled back.
    // `downloading` from here: the refresh fetches the taps.
    if let Err(ended) = proceed(progress) {
        return ended;
    }
    progress.report(UpdatePhase::Downloading, None, None);
    if let Err(error) = crate::relay::update::homebrew::refresh(&keg) {
        return fail(
            progress,
            UpdatePhase::Failed,
            UpdateReason::DownloadFailed,
            format!("{error:#}"),
        );
    }
    if let Some(ended) = refuse_other_tap_version(&keg, machine, request, progress) {
        return ended;
    }
    // brew installs and switches the keg in one step, so the last idle check
    // and the work hold come before it, as before a self-replace swap.
    if let Some(before_swap) = machine.before_swap
        && let Err(why) = before_swap(progress)
    {
        // A wait the update may no longer go on ended: that reason, not busy.
        if let Err(ended) = proceed(progress) {
            return ended;
        }
        return fail(progress, UpdatePhase::Refused, UpdateReason::Busy, why);
    }
    if let Err(ended) = proceed(progress) {
        return ended;
    }
    // Idle (after a wait of up to 30 minutes, reported `waiting_idle`): from
    // here the server's download window covers the service, `brew --prefix`
    // and the lock wait, not what is left of the idle one.
    progress.report(UpdatePhase::Downloading, None, None);
    // The path the service is made to start, and the one probed after the
    // upgrade: one value, so the probe runs exactly what the restart runs.
    let stable = keg.prefix.join("opt").join("wsmp").join("bin").join("wsmp");
    // A service that would restart into the old keg's path (still the old
    // build after the upgrade, which keeps it: a later `brew cleanup` may
    // remove it) makes the update useless: stop before the keg changes.
    if let Err(error) = (machine.stable_service)(&stable) {
        return fail(
            progress,
            UpdatePhase::Refused,
            UpdateReason::UnsupportedMethod,
            format!("{error:#}"),
        );
    }
    let lock = match crate::relay::update::homebrew::prefix(&keg).and_then(|prefix| {
        crate::relay::update::homebrew::TapLock::acquire(
            &prefix,
            crate::relay::update::homebrew::TAP_LOCK_WAIT,
            &|| machine.proceed.is_none_or(|proceed| proceed().is_ok()),
        )
    }) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            if let Err(ended) = proceed(progress) {
                return ended;
            }
            return fail(
                progress,
                UpdatePhase::Failed,
                UpdateReason::Internal,
                format!(
                    "another `brew update` kept Homebrew's update lock for {} minutes; wsmp was not upgraded",
                    crate::relay::update::homebrew::TAP_LOCK_WAIT.as_secs() / 60
                ),
            );
        }
        Err(error) => {
            return fail(
                progress,
                UpdatePhase::Failed,
                UpdateReason::Internal,
                format!("{error:#}"),
            );
        }
    };
    // Again: a fresh download window for the check and the upgrade.
    progress.report(UpdatePhase::Downloading, None, None);
    // Again, under the lock: someone may have run `brew update` while the node
    // waited for idle. From now until the upgrade has run, an ordinary one
    // fails on the held lock (see step 5 for the ones the lock does not stop).
    if let Some(ended) = refuse_other_tap_version(&keg, machine, request, progress) {
        return ended;
    }
    if let Err(ended) = proceed(progress) {
        return ended;
    }
    // The lock is let go as soon as brew is done.
    let upgraded = crate::relay::update::homebrew::upgrade(&keg, lock);
    if let Err(error) = upgraded {
        return fail(
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            format!("{error:#}"),
        );
    }
    match crate::relay::update::install::probe_version(&stable) {
        Ok(version) if version == request.version => {}
        Ok(version) => {
            return fail(
                progress,
                UpdatePhase::Failed,
                UpdateReason::VersionMismatch,
                format!(
                    "Homebrew installed wsmp {version}, not {}; the tap changed during the upgrade",
                    request.version
                ),
            );
        }
        // brew has run, so something may have changed on disk; which version is
        // there now is not known.
        Err(error) => {
            return fail(
                progress,
                UpdatePhase::Failed,
                UpdateReason::VersionMismatch,
                format!(
                    "Homebrew ran the upgrade, but the installed wsmp's version could not be checked ({error:#}); check `{}` --version before restarting the node",
                    stable.display()
                ),
            );
        }
    }
    if let Err(error) = flow::record_homebrew(machine, request, &stable) {
        return fail(
            progress,
            UpdatePhase::Failed,
            UpdateReason::Internal,
            format!("{error:#}"),
        );
    }
    Ended::Swapped
}

/// The tap's version check: `Some` (reported) when the update must stop here,
/// before `brew upgrade`: the tap cannot be read, or it has another version.
fn refuse_other_tap_version(
    keg: &crate::relay::update::homebrew::Keg,
    machine: &Machine<'_>,
    request: &Request,
    progress: &mut dyn Progress,
) -> Option<Ended> {
    match crate::relay::update::homebrew::tap_version(keg) {
        Ok(available) => {
            let why = crate::relay::update::homebrew::version_refusal(
                &available,
                &request.version,
                &machine.current_version,
            )?;
            progress.refuse_version(available, crate::relay::update::clip_detail(&why));
            Some(Ended::Stopped)
        }
        Err(error) => {
            progress.report(
                UpdatePhase::Failed,
                Some(UpdateReason::Internal),
                Some(crate::relay::update::clip_detail(&format!("{error:#}"))),
            );
            Some(Ended::Stopped)
        }
    }
}
