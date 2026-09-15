#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Local Postgres lifecycle for Tessera.
#
# Runs a dedicated, user-owned cluster rather than the system PostgreSQL service,
# so no sudo is needed and nothing global is touched. The cluster lives outside
# the repo and is entirely disposable: `db.sh reset` throws it away and rebuilds.
#
# Usage: ./scripts/db.sh {up|down|status|psql|reset|logs}
# -----------------------------------------------------------------------------
set -euo pipefail

PGBIN="${PGBIN:-/Library/PostgreSQL/17/bin}"
TESSERA_HOME="${TESSERA_HOME:-$HOME/.tessera}"
PGDATA="$TESSERA_HOME/pgdata"
PGPORT="${PGPORT:-5434}"
PGUSER_SUPER="tessera"
PGDATABASE="tessera"
LOGFILE="$TESSERA_HOME/postgres.log"

if [ ! -x "$PGBIN/pg_ctl" ]; then
  echo "error: Postgres binaries not found at $PGBIN" >&2
  echo "       set PGBIN to your installation's bin directory" >&2
  exit 1
fi

is_running() { "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; }

cmd_up() {
  if [ ! -d "$PGDATA/base" ]; then
    echo "==> initialising cluster at $PGDATA"
    mkdir -p "$TESSERA_HOME"
    "$PGBIN/initdb" -D "$PGDATA" -U "$PGUSER_SUPER" --auth=trust --encoding=UTF8 --locale=C >/dev/null
  fi

  if is_running; then
    echo "==> already running on port $PGPORT"
  else
    echo "==> starting Postgres on 127.0.0.1:$PGPORT"
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOGFILE" \
      -o "-p $PGPORT -k $TESSERA_HOME -c listen_addresses=127.0.0.1" -w start >/dev/null
  fi

  if ! "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER_SUPER" -lqt \
       | cut -d '|' -f1 | grep -qw "$PGDATABASE"; then
    echo "==> creating database $PGDATABASE"
    "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER_SUPER" "$PGDATABASE"
  fi

  echo "==> ready: postgres://$PGUSER_SUPER@127.0.0.1:$PGPORT/$PGDATABASE"
}

cmd_down() {
  if is_running; then
    echo "==> stopping Postgres"
    "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null
  else
    echo "==> not running"
  fi
}

cmd_status() {
  if is_running; then
    "$PGBIN/pg_ctl" -D "$PGDATA" status
  else
    echo "not running (data dir: $PGDATA)"
  fi
}

cmd_psql() {
  exec "$PGBIN/psql" "postgres://$PGUSER_SUPER@127.0.0.1:$PGPORT/$PGDATABASE" "$@"
}

cmd_reset() {
  echo "==> destroying cluster at $PGDATA"
  is_running && "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate -w stop >/dev/null || true
  rm -rf "$PGDATA"
  cmd_up
}

cmd_logs() { tail -n "${1:-50}" "$LOGFILE"; }

case "${1:-}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  psql)   shift; cmd_psql "$@" ;;
  reset)  cmd_reset ;;
  logs)   shift; cmd_logs "$@" ;;
  *)      echo "usage: $0 {up|down|status|psql|reset|logs}" >&2; exit 1 ;;
esac
