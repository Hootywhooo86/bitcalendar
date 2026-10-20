#!/usr/bin/env bash
# Runs family-feed.sql + bitcalendar.sql on a throwaway local Postgres and checks accounts stay apart.
#   bash supabase/test/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)
DIR=$(mktemp -d)
trap '"$BIN/pg_ctl" -D "$DIR/db" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
chmod 777 "$DIR"
run "'$BIN/initdb' -D '$DIR/db' -A trust -U postgres >/dev/null"
run "'$BIN/pg_ctl' -D '$DIR/db' -o '-k $DIR -p 54330 -c listen_addresses=' -l '$DIR/log' start >/dev/null"
PSQL=(env PGOPTIONS='-c client_min_messages=warning' psql -h "$DIR" -p 54330 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -f supabase/test/supabase-stub.sql
"${PSQL[@]}" -c "set client_min_messages = error; create publication supabase_realtime;"
for i in 1 2; do "${PSQL[@]}" -f supabase/family-feed.sql; "${PSQL[@]}" -f supabase/bitcalendar.sql; done   # safe to run twice
"${PSQL[@]}" -o /dev/null -f supabase/test/bitcal.sql
echo "bitcalendar SQL: all checks passed"
