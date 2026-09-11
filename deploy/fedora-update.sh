#!/usr/bin/env bash
set -euo pipefail

# Help remains available before the runtime is installed.
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo 'Usage: sudo bash /opt/lidoll/current/deploy/fedora-update.sh [--check]'
  echo 'Fetches the GitHub branch saved in /etc/lidoll/deploy.json. --check does not deploy or restart services.'
  exit 0
fi

# Reads the saved repository/branch and deploys its newest commit without upgrading unrelated OS packages.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node_binary=/usr/bin/node-24
if [[ ! -x "$node_binary" ]]; then
  echo 'Install first with sudo bash deploy/fedora-deploy.sh.' >&2
  exit 1
fi
exec "$node_binary" "$script_dir/fedora.mjs" update "$@"
