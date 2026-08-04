#!/bin/sh
# Runs as root (container starts as root), then drops to the node user.
# Ensures config.json exists in the mounted directory and is writable by node.
set -e

CONFIG_DIR="/app/config"
CONFIG_FILE="$CONFIG_DIR/config.json"

# Create the directory (host mount) and make it writable by node
mkdir -p "$CONFIG_DIR"
chown node:node "$CONFIG_DIR"

# Bootstrap config.json from the example if it does not exist yet
if [ ! -f "$CONFIG_FILE" ]; then
  cp /app/config.example.json "$CONFIG_FILE"
  echo "Bootstrapped $CONFIG_FILE from config.example.json"
fi

chown node:node "$CONFIG_FILE"
chmod 664 "$CONFIG_FILE"

# Execute the command as the node user
exec su-exec node "$@"
