#!/usr/bin/env bash
set -euo pipefail

# Installs Fedora's versioned Node packages before handing setup to the deployment program.
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'HELP'
Usage: sudo bash deploy/fedora-deploy.sh [options]
  --repo URL                 GitHub repository (default: https://github.com/AELovelace/omo-trainer.git)
  --branch NAME              Branch to deploy (default: main)
  --bind-address IP          Service server address (default: 10.1.1.23)
  --proxy-ip IP              Allow this proxy through an already-running firewalld
  --firewall-zone NAME       Zone for those rules (default: public)
  --public-origin URL        Tracker origin (default: https://lidoll.dev)
  --auth-origin URL          Shared auth origin (default: https://auth.sadgirlsclub.wtf)

Run on the Fedora Node/service server. Existing env files and databases are preserved.
The web server's existing Nginx/TLS configuration is managed separately.
HELP
  exit 0
fi

[[ $EUID -eq 0 ]] || { echo 'Run this script with sudo.' >&2; exit 1; }
[[ -r /etc/fedora-release ]] || { echo 'This installer requires Fedora.' >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo 'This installer requires a running systemd system.' >&2; exit 1; }
dnf install -y git nodejs24 nodejs24-npm ca-certificates util-linux shadow-utils policycoreutils
[[ -x /usr/bin/node-24 ]] || { echo 'Fedora did not provide /usr/bin/node-24. Check your enabled repositories.' >&2; exit 1; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/node-24 "$script_dir/fedora.mjs" install "$@"
