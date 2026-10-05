# File operation recovery

`wsmp recover` lists abandoned work without applying it. `--apply` reconciles
supported journals; `--scan` additionally searches configured file roots when
the state-directory registry is unavailable. Startup reports registry entries
without walking potentially blocked remote file roots.

Recovery keeps private hardlink pins in INTENT v3. Serialized inode numbers
alone never authorize restoring or deleting an object. Legacy journals, missing
pins, directory objects and unsupported aliases require manual resolution.
Never remove retained pins or INTENT before identifying all affected objects.

New producers durably record a map and registry entry before moving public
names. `capturing` fences a capture and its directory barriers; `publishing`
fences publication/deletion until validation and durable commit. After an
interruption, `recover --apply` rolls back an interrupted `capturing` journal
and an interrupted delete in `publishing` (never acknowledged: success is
returned only once `committed` is durable). Rollback uses only the restore
rules: a slot must match its kept hardlink pin, and `mv -n` never overwrites a
newer public file. A rename or replace in `publishing` may already have
published a new object, so it stays manual and the listing names the
procedure: compare each slot with its INTENT `origin` and the current public
file, restore the wanted copy with `mv -n`, then delete the directory including
its `.wsmp-pin-*` hardlinks (a remaining pin makes the public file look
hard-linked) and the sibling `.wsmp-lock-.wsmp-recover-*` file. A capture
after a durable `committed` record keeps `committed`. Rolling back a replace
never publishes the CLI's own temp: it is identified only by its `published`
pin, captured off the public name if needed, and disposed, so the object that
was there before (or another process's newer file) returns to the public name.
`compensating` restores only the recorded original location, without inferring
commit from publication identity. An occupied original location retains the
candidate and never overwrites the newer public object. A valid `committed`
journal remains authoritative: recovery disposes leftovers and does not
resurrect acknowledged deletes or rename source aliases.

A write/fsync failure of a CLI-generated file (replace temp, exclusive-create
file, ENOSPC included) disposes it by its held identity and returns `io_error`:
its bytes were never acknowledged, and the CLI never retries fsync on that
failed file to certify them. Captured user files get no data barrier: their
bytes are unchanged (and may be unreadable, such as mode 000). Journal
rewrites use fresh files.

A rename, link or exclusive create that the filesystem refuses atomically
(EEXIST, EINVAL/ENOSYS/ENOTSUP, EXDEV and similar) is not a public change. An
ambiguous reply (EIO, timeouts, ENOENT/ESTALE after an NFS retransmit, EINTR)
is decided from the names: if the source still holds the object nothing moved,
if the destination holds it the move committed, otherwise the result is
`uncertain_outcome`. Any journal, registry, pin or directory-sync failure
before the first public name change is a clean refusal: the CLI removes its
pins, journal, registry entry and recovery directory and returns `io_error`,
or `unsafe_filesystem` when directory fsync is unsupported (EINVAL/ENOTSUP),
including on the CLI state directory that holds the registry (the message
names it). After a public change, such failures cannot authorize further
destructive cleanup or durable-success
acknowledgement: the operation returns `uncertain_outcome` and retains
available evidence. Once the `committed` record is durable, a later cleanup
barrier failure (including the parent sync after the recovery directory is
removed) only leaves reported residue on a successful result, and only paths
that still exist are reported. Unjournaled create, mkdir, rmdir, created
parents and case-only rename probe the directory barrier first, so unsupported
directory sync refuses with `unsafe_filesystem` before any change.

Restoration syncs the public parent and recovery directory before dropping the
last private pin. Cleanup syncs slot and pin removals before removing INTENT,
then syncs the recovery directory and its parent around rmdir. Re-entry with
an absent slot and surviving pin first proves the restored public identity;
absence alone cannot erase evidence. The stable sibling cleanup lock excludes
other recovery processes while the internal lock closes and metadata is removed.

Cancellation is cooperative before public commit. A blocked kernel I/O call
keeps its worker and file/namespace ownership until it actually settles. The
pool has two workers and at most four operations in flight. These rules do not
provide a hard deadline for uninterruptible I/O or certify whole relay shutdown.

Linux syscall ordering, real injected I/O failures and SIGKILL tests qualify the
tested transitions. SIGKILL is process-death evidence, not a power-loss test.
Native macOS/Windows, NFS and storage power-loss behavior require separate
platform qualification; no universal filesystem durability guarantee is made.
