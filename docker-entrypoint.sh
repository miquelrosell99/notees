#!/bin/bash
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Create group if it doesn't exist
if ! getent group "$PGID" >/dev/null 2>&1; then
    groupadd -g "$PGID" appgroup
fi

# Create user if it doesn't exist
if ! id "$PUID" >/dev/null 2>&1; then
    useradd -u "$PUID" -g "$PGID" -m -s /bin/bash appuser
fi

# Ensure data directories are writable by the runtime user
mkdir -p /app/data /app/logs
chown -R "$PUID:$PGID" /app/data /app/logs

# Drop privileges and run the command
exec gosu "$PUID:$PGID" "$@"
