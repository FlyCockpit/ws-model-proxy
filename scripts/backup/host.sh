#!/usr/bin/env bash
# Database helper for a Docker Compose deployment (compose.yaml, with or without
# compose.backups.yaml). Needs only bash and docker. It ships inside the app
# image; copy it out once:
#
#   docker exec "$(docker ps -q -f label=com.docker.compose.service=app | head -n1)" \
#     cat /app/scripts/backup/host.sh > app-db.sh
#
# Then, on the server:
#   bash app-db.sh list                    list the backups, newest first
#   bash app-db.sh backup                  take a backup now
#   bash app-db.sh restore [<backup>]      guided restore (default: the newest backup)
#   bash app-db.sh drill [<backup>]        restore into a throwaway database and check it
#                                          (s3://… backups: add --etag <etag>)
#   bash app-db.sh hold-deletions [days|--clear]
#                                          pause scheduled deletions (after a restore the
#                                          app cannot detect, e.g. a Volume Backups copy)
# Add --project <name> when the server runs more than one copy of the app.
#
# It finds the app's containers, image, network and backups volume itself and
# passes the database settings straight from the running app to a one-off
# container of the same image, never through a file. `restore` shows a preview
# and asks before changing anything (docs/backup-and-restore.md).
#
# Linux only: it runs on the Docker host that runs the deployment (bash, GNU
# coreutils, docker).
# Its tests (scripts/backup/host.test.mjs) run in a Linux container where
# Docker exists, and on Linux CI.
set -euo pipefail

die() {
  echo "ERROR: $*" >&2
  exit 1
}
say() { echo "[app-db] $*"; }
ask() {
  local answer
  read -r -p "$1 [y/N] " answer </dev/tty || return 1
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

# The stop prompt. Declining exits 3, a cancellation before anything changed,
# like restore's own refusals, so automation never reads it as "restored"; so
# does Ctrl-C (INT), TERM or HUP while it waits. Nothing was stopped, so
# nothing is started; restore's EXIT trap is not installed yet. The signal
# traps cover the prompt only: the previous INT/TERM/HUP traps are back in
# place right after it, so later steps keep their own signal handling. A
# `| tee` reader that left while the prompt waited (Ctrl-C reaches `tee` too)
# must not turn the 3 into a SIGPIPE death (141) or a failed write (1), so
# every write here comes after PIPE is ignored and is best effort, stderr too
# (`2>&1 | tee`).
cancel_stop() {
  trap '' PIPE
  # After ^C the cursor is still on the prompt line (stderr, the terminal).
  [ "${1:-}" != signal ] || echo >&2 2>/dev/null || true
  say "Cancelled. Nothing was changed; the app was not stopped." 2>/dev/null || true
  exit 3
}
confirm_stop() {
  local previous declined=0
  previous="$(trap -p INT TERM HUP)"
  trap 'cancel_stop signal' INT TERM HUP
  ask "Stop the app and continue?" || declined=1
  trap - INT TERM HUP
  eval "$previous"
  [ "$declined" = 0 ] || cancel_stop
}

# The prompts read the terminal, and `docker run -it` needs stdin to be one.
# stdout may be a pipe (`restore | tee restore.log`).
stdin_is_terminal() { [ -t 0 ]; }
require_terminal() { stdin_is_terminal && [ -r /dev/tty ]; }
choose_project() { read -r -p "Which one? (number) " pick </dev/tty; }

parse_args() {
  action="${1:-}"
  [ -n "$action" ] || {
    # The help is this file's header. Piped into `bash -s` there is no file.
    if [ -f "${BASH_SOURCE[0]:-}" ]; then
      sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    else
      echo "Usage: bash <this script> list | backup | restore | drill | hold-deletions [<args>] [--project <name>]" >&2
      echo "(the full help is the header of scripts/backup/host.sh)" >&2
    fi
    exit 2
  }
  shift
  project=""
  args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --project)
        [ $# -ge 2 ] || die "--project needs a name."
        project="$2"
        shift 2
        ;;
      *)
        args+=("$1")
        shift
        ;;
    esac
  done


  case "$action" in
    list | backup | hold-deletions | restore | drill) ;;
    *) die "unknown command \"$action\" (use list, backup, restore, drill or hold-deletions)." ;;
  esac
}

# --- Find the app ------------------------------------------------------------
label() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1"; }
discover_app() {
  # The app is the compose service named `app` (compose.yaml).
  mapfile -t projects < <(docker ps -a -f label=com.docker.compose.service=app \
    --format '{{.Label "com.docker.compose.project"}}' | sed '/^$/d; /^<no value>$/d' | sort -u)
  [ ${#projects[@]} -gt 0 ] || die "no app found (no container of a compose service named \"app\")."
  if [ -z "$project" ]; then
    if [ ${#projects[@]} -eq 1 ]; then
      project="${projects[0]}"
    else
      say "This server runs more than one app:"
      for i in "${!projects[@]}"; do echo "  $((i + 1))) ${projects[$i]}"; done
      choose_project
      [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le ${#projects[@]} ] ||
        die "no such choice."
      project="${projects[$((pick - 1))]}"
    fi
  fi
  in_project() { docker ps -a -q -f "label=com.docker.compose.project=$project" "$@"; }
  # Exactly one app container and one postgres container (running or
  # stopped): with more, which one holds the deployment's image, volume and
  # settings (or its data) is a guess, so refuse before touching anything.
  listed() {
    local id
    for id in "$@"; do
      printf '\n    %s' "$(docker inspect -f '{{.Name}} ({{.State.Status}})' "$id" 2>/dev/null | sed 's#^/##' || echo "$id")"
    done
  }
  mapfile -t apps < <(in_project -f label=com.docker.compose.service=app)
  [ ${#apps[@]} -gt 0 ] || die "no app container in \"$project\"."
  if [ ${#apps[@]} -gt 1 ]; then
    die "\"$project\" has ${#apps[@]} app containers; this helper needs exactly one and changed nothing:$(listed "${apps[@]}")
  Remove the ones that are not the deployment's app (docker rm -f <name>; e.g. a leftover
  \`docker compose run\` or a scaled-up replica), or redeploy with one app, then re-run."
  fi
  mapfile -t databases < <(in_project -f label=com.docker.compose.service=postgres)
  [ ${#databases[@]} -gt 0 ] ||
    die "no postgres container in \"$project\" (the compose service \"postgres\"); this helper needs exactly one and changed nothing. Redeploy the compose, then re-run."
  if [ ${#databases[@]} -gt 1 ]; then
    die "\"$project\" has ${#databases[@]} postgres containers; this helper needs exactly one and changed nothing:$(listed "${databases[@]}")
  Remove the ones that are not the deployment's database (docker rm -f <name>; e.g. a
  leftover \`docker compose run\`), never its data volume, or redeploy, then re-run."
  fi
  server="${apps[0]}"
  postgres="${databases[0]}"
  # The app container's own image ID, never its tag: the one-off container
  # must run exactly the code the app runs.
  image="$(docker inspect -f '{{.Image}}' "$server")"
  # A redeploy that rebuilt an identical image can retag the name to a new ID
  # and drop the old one (Docker 29's containerd image store) while the
  # running app still points at it. Falling back to the tag could run other
  # code than the app's, so stop and say how to line the two up again.
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    local dir files file_args="" env_args="" file env_note="--env-file and --profile flags"
    local -a config_files=() env_files=()
    dir="$(label "$server" com.docker.compose.project.working_dir 2>/dev/null || true)"
    case "$dir" in
      "" | "<no value>") dir="<the compose's directory>" ;;
      *) dir="$(printf '%q' "$dir")" ;;
    esac
    # Every compose file the deploy used (compose.backups.yaml included):
    # without the overlay the recreated app would lose its /backups mount and
    # BACKUP_ENABLED.
    files="$(label "$server" com.docker.compose.project.config_files 2>/dev/null || true)"
    case "$files" in
      "" | "<no value>") file_args=" -f <each compose file the deploy uses>" ;;
      *)
        IFS=, read -r -a config_files <<<"$files"
        for file in "${config_files[@]}"; do file_args+=" -f $(printf '%q' "$file")"; done
        ;;
    esac
    # The --env-file the deploy used (compose.yaml requires its settings).
    files="$(label "$server" com.docker.compose.project.environment_file 2>/dev/null || true)"
    case "$files" in
      "" | "<no value>") ;;
      *)
        IFS=, read -r -a env_files <<<"$files"
        for file in "${env_files[@]}"; do env_args+=" --env-file $(printf '%q' "$file")"; done
        file_args="$env_args$file_args"
        env_note="--profile flags"
        ;;
    esac
    die "the app container's image (${image:0:19}) is no longer on this machine: a redeploy
  replaced it without recreating the app. Recreate the app from the current image
  (it restarts the app), then re-run this command:
    cd $dir && docker compose -p $(printf '%q' "$project")$file_args up -d --no-build --force-recreate app
  (add the same $env_note the deploy uses, if any)"
  fi
  volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/backups"}}{{.Name}}{{end}}{{end}}' "$server")"
  network=""
  for net in $(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$server"); do
    [ "$net" = dokploy-network ] || {
      network="$net"
      break
    }
  done
  [ -n "$network" ] || network="${project}_default"
  docker network inspect "$network" >/dev/null 2>&1 || die "the app's network \"$network\" does not exist."

  # Only what the one-off container needs: the database and the backup bucket.
  app_env() {
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$server" |
      grep -E '^(DATABASE_URL|BACKUP_S3_[A-Z_]+|S3_ACCESS_KEY_ID)=' || true
  }
  volume_args=()
  [ -n "$volume" ] && volume_args=(-v "$volume:/backups")
  return 0
}

# One-off container of the app image on the app's network. A terminal on
# stdin is enough for -it (docker allocates the container's own terminal), so
# `bash app-db.sh restore | tee restore.log` still prompts.
run_image() {
  local tty=()
  if stdin_is_terminal; then tty=(-it); fi
  docker run --rm "${tty[@]}" --network "$network" "${volume_args[@]}" \
    --env-file <(app_env) "$image" "$@"
}

main() {
  parse_args "$@"
  command -v docker >/dev/null || die "docker is not installed on this machine."
  docker info >/dev/null 2>&1 || die "cannot talk to Docker. Run this on the server that runs the Compose deployment, as a user who can run docker (or with sudo)."

  discover_app

  say "app \"$project\": app container ${server:0:12}, network $network, backups volume ${volume:-none}"

  case "$action" in
    list)
      run_image restore --list
      ;;
    backup)
      run_image backup
      ;;
    hold-deletions)
      run_image hold-deletions "${args[@]}"
      ;;
    restore)
      require_terminal || die "restore asks before it changes anything; run it in a terminal."
      source="${args[0]:-latest}"
      [ ${#args[@]} -le 1 ] || die "restore takes one backup name (see: bash $0 list)."
      case "$source" in
        latest | s3://* | /*) ;;
        *) source="/backups/$source" ;;
      esac
      [ -n "$postgres" ] && [ "$(docker inspect -f '{{.State.Running}}' "$postgres")" = true ] ||
        die "the database container is not running; start the deployment's postgres service first."
      mapfile -t writers < <(
        for id in $(in_project); do
          svc="$(label "$id" com.docker.compose.service)"
          state="$(docker inspect -f '{{.State.Running}}' "$id")"
          [ "$svc" != postgres ] && [ "$svc" != redis ] && [ "$state" = true ] && echo "$id $svc"
        done
      )
      echo
      say "Restoring stops the app (${#writers[@]} running container(s): $(printf '%s ' "${writers[@]#* }"))"
      say "until it finishes, then starts it again: after a restore that completed, one that was"
      say "cancelled or refused before anything changed, or one that failed and rolled back (the"
      say "database unchanged). If its outcome is uncertain (the restore output says what happened),"
      say "the app stays stopped until you have checked the database."
      say "If something redeploys the app automatically (e.g. Dokploy's Auto Deploy), do not"
      say "trigger it meanwhile. You will see a preview and be asked once more before anything changes."
      confirm_stop
      # restore.mjs exit status: 0 restored; 3 (REFUSED_EXIT) refused or
      # cancelled before anything changed; 4 (ROLLED_BACK_EXIT) started, failed
      # and provably rolled back, so the database is unchanged; anything else
      # failed with an uncertain outcome (or committed and then failed).
      # Starting the app then would migrate and serve a database nobody has
      # checked, so it stays stopped.
      #
      # Start first, talk second: after Ctrl-C under `restore | tee log` the
      # pipe's reader is gone, and a write to it would kill this shell (SIGPIPE)
      # before the writers are started again. So the trap ignores
      # INT/TERM/HUP/PIPE, starts every writer when that is safe, then reports
      # on stderr (never the pipe), ignoring write errors.
      # shellcheck disable=SC2329 # Called by the EXIT trap, including failures.
      note() { echo "[app-db] $*" >&2 2>/dev/null || true; }
      # shellcheck disable=SC2329 # Called by the EXIT trap, including failures.
      restore_exit() {
        local exit_status=$?
        trap '' INT TERM HUP PIPE
        if [ "$restore_invoked" = 0 ] || [ "$exit_status" -eq 0 ] || [ "$exit_status" -eq 3 ] ||
          [ "$exit_status" -eq 4 ]; then
          # `docker stop` first: an interrupted stop (Ctrl-C kills the client,
          # the daemon keeps stopping) would make a bare `docker start` a no-op
          # on a container that then exits. Stopping waits for that; it is a
          # no-op for a container already stopped.
          for writer in "${writers[@]}"; do
            docker stop -t 30 "${writer%% *}" >/dev/null 2>&1 || true
            docker start "${writer%% *}" >/dev/null 2>&1 || true
          done
          if [ "$restore_invoked" = 0 ]; then
            note "Restore was not invoked; nothing was changed."
          elif [ "$exit_status" -eq 3 ]; then
            note "Cancelled or refused; nothing was changed."
          elif [ "$exit_status" -eq 4 ]; then
            note "Restore failed and was rolled back; the database is unchanged (the restore output above says why)."
          else
            note "Restore done. The app applies any pending migrations as it starts."
            note "Check it from your computer: pnpm deploy:check https://<your-app> --commit <deployed commit>"
          fi
          [ ${#writers[@]} -eq 0 ] || note "Started the app again."
        else
          if [ "$exit_status" -ge 125 ] && [ "$exit_status" -le 127 ]; then
            # docker run's own failures; the restore may never have started,
            # but a wait failure can also follow a started one.
            note "docker run failed (exit $exit_status): the restore container may not have started."
          fi
          note "Restore failed and its outcome is uncertain, or it committed and a later step failed (exit $exit_status): the restore output above says which. The app stays stopped."
          note "Inspect the database (bash $0 list; the restore output above), then start the app again"
          note "with: docker start $(printf '%s ' "${writers[@]%% *}")"
        fi
        return "$exit_status"
      }
      restore_invoked=0
      trap restore_exit EXIT
      trap 'exit 143' TERM
      trap 'exit 130' INT
      trap 'exit 129' HUP
      # From here on a dead stdout reader (`| tee` killed by Ctrl-C) must not
      # kill this shell outright: a failed write ends it through set -e, and
      # the EXIT trap still runs.
      trap '' PIPE
      for writer in "${writers[@]}"; do
        say "Stopping ${writer#* } ..."
        docker stop -t 30 "${writer%% *}" >/dev/null
      done
      status=0
      restore_invoked=1
      run_image restore "$source" --guided || status=$?
      exit "$status"
      ;;
    drill)
      source="latest"
      pins=()
      if [ ${#args[@]} -gt 0 ] && [[ "${args[0]}" != -* ]]; then
        source="${args[0]}"
        args=("${args[@]:1}")
      fi
      # Only the options that pin an s3:// object; never one that widens the restore.
      while [ ${#args[@]} -gt 0 ]; do
        case "${args[0]}" in
          --etag | --version-id)
            [ ${#args[@]} -ge 2 ] || die "${args[0]} needs a value."
            pins+=("${args[0]}" "${args[1]}")
            args=("${args[@]:2}")
            ;;
          *) die "drill does not accept \"${args[0]}\" (only <backup> and, for s3://, --etag / --version-id)." ;;
        esac
      done
      case "$source" in
        latest | s3://* | /*) ;;
        *) source="/backups/$source" ;;
      esac
      [ ${#pins[@]} -eq 0 ] || [[ "$source" == s3://* ]] ||
        die "--etag and --version-id apply only to s3:// backups."
      [[ "$source" != s3://* ]] || [[ " ${pins[*]} " == *" --etag "* ]] ||
        die "an s3:// backup needs --etag <etag> (it is printed when the backup is uploaded)."
      pg_image="postgres:18"
      [ -n "$postgres" ] && pg_image="$(docker inspect -f '{{.Config.Image}}' "$postgres")"
      suffix="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
      drill_net="wmp-drill-$suffix"
      drill_db="wmp-drill-pg-$suffix"
      password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
      # shellcheck disable=SC2329 # Called by the EXIT trap.
      cleanup() {
        docker rm -f -v "$drill_db" >/dev/null 2>&1 || true
        docker network rm "$drill_net" >/dev/null 2>&1 || true
      }
      trap cleanup EXIT
      say "Starting a throwaway database ($pg_image) ..."
      docker network create "$drill_net" >/dev/null
      docker run -d --name "$drill_db" --network "$drill_net" --network-alias drill-db \
        -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=restore_drill "$pg_image" >/dev/null
      # Over TCP, twice in a row: the image's first-start init server listens on the
      # unix socket only and then restarts, so a socket check can pass too early.
      ready=0
      for _ in $(seq 1 90); do
        if docker exec "$drill_db" pg_isready -q -h 127.0.0.1 -U postgres -d restore_drill 2>/dev/null; then
          ready=$((ready + 1))
          [ "$ready" -ge 2 ] && break
        else
          ready=0
        fi
        sleep 1
      done
      [ "$ready" -ge 2 ] || die "the throwaway database did not start."
      # The app's backup-bucket settings, but the throwaway database's URL.
      drill_env() {
        app_env | grep -v '^DATABASE_URL=' || true
        printf 'DATABASE_URL=%s\n' "postgresql://postgres:${password}@drill-db:5432/restore_drill"
      }
      status=0
      docker run --rm --network "$drill_net" "${volume_args[@]}" --env-file <(drill_env) \
        "$image" restore-drill "$source" "${pins[@]}" || status=$?
      say "Removed the throwaway database."
      exit "$status"
      ;;
  esac

}

# `${BASH_SOURCE[0]:-$0}`: piped into `bash -s` there is no source file (set -u).
if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  main "$@"
fi
