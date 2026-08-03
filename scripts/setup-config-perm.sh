#!/usr/bin/env bash
# Ensure config.json has correct permissions
set -e

CONFIG_PATH="/app/config.json"

if [ -e "$CONFIG_PATH" ]; then
  chmod 664 "$CONFIG_PATH"
fi

# Execute the command passed to the container
exec "$@"
