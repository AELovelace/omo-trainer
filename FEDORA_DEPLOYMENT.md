# Fedora deployment and GitHub updates

These scripts target the **Fedora Node/service server with systemd**, using your GitHub repository **https://github.com/AELovelace/omo-trainer.git**, branch **main**. The reverse proxy stays on your other server. Push the complete new deployment files to GitHub before running the installer: it deploys fetched commits, not uncommitted files from the bootstrap checkout.

## First deployment

On the service server:

```bash
sudo dnf install -y git
git clone https://github.com/AELovelace/omo-trainer.git
cd omo-trainer
sudo bash deploy/fedora-deploy.sh
```

Defaults match the existing project configuration: service address **10.1.1.23**, tracker **https://lidoll.dev/tracker/**, auth **https://auth.sadgirlsclub.wtf**, and ports **4173/4180**. The installer uses Fedora's [nodejs24](https://packages.fedoraproject.org/pkgs/nodejs24/nodejs24/) and [nodejs24-npm](https://packages.fedoraproject.org/pkgs/nodejs24/nodejs24-npm/) packages. It invokes the versioned Node 24 binary directly, without changing your preferred global Node alternative. It does not perform a general OS upgrade.

For another service address or to add source-restricted firewalld access, supply options on the **first** invocation:

```bash
# Replace 10.1.1.10 with your reverse proxy's actual private IP.
sudo bash deploy/fedora-deploy.sh \
  --bind-address 10.1.1.23 \
  --proxy-ip 10.1.1.10 \
  --firewall-zone public
```

The firewall option requires firewalld to be installed and already running. It adds runtime and permanent rules allowing only the selected source to the service ports. It does not start/enable firewalld, reload unrelated rules, or open ports to all sources. Without --proxy-ip, your current firewall policy is left unchanged; ensure it already allows the reverse proxy. Existing broad firewall rules are not removed by this script.

Other first-run options are --repo, --branch, --public-origin, and --auth-origin. Use --help for all options. GitHub HTTPS and GitHub SSH URLs are supported; never embed a personal access token in the repository URL. This is for conventional Fedora Server/Workstation installations with dnf and systemd, not rpm-ostree/bootc hosts or containers without systemd.

## What the installer creates

| Location | Purpose |
| --- | --- |
| /opt/lidoll/current | Atomic symlink to the running code release |
| /opt/lidoll/releases/ | Retained, tested, root-owned release directories |
| /opt/lidoll/staging/ | New checkouts under preparation; failures retained for inspection |
| /etc/lidoll/deploy.json | Saved GitHub repository, branch, and install options |
| /etc/lidoll/tracker.env | Preserved production tracker environment |
| /etc/lidoll/auth.env | Preserved production auth environment |
| /var/lib/lidoll/tracker/ | Central tracker database, owned by lidoll-tracker |
| /var/lib/lidoll/auth/ | Identity database, signing keys, clients, owned by lidoll-auth |
| /var/lib/lidoll-deploy/ | Git mirror, npm cache, optional read-only GitHub deploy key |
| /var/backups/lidoll/ | Private backups taken immediately before activation |

Systemd services are **lidoll-tracker.service** and **lidoll-auth.service**. They start at boot, restart on failure, run as distinct Unix users, and can write only their own data directory. npm and staged tests run as a third unprivileged build user. Production credentials and database directories are not available to that user. Existing env files, database contents, auth keys, and client registrations are never replaced with defaults. Existing systemd files that differ from the generated units cause setup to stop for review; the update command does not rewrite units.

Run the installer with no replacement flags to retry an incomplete setup. After configuration exists, edit /etc/lidoll/deploy.json or the environment files explicitly. Both environment files must retain the documented persistent data paths. If adopting an existing installation elsewhere, stop its old processes and migrate its actual databases, WAL/SHM files, auth signing keys, and clients into these directories before installing. Verify the production callback in clients.json; the script refuses to overwrite a mismatched registration. It does not migrate an unrelated running process automatically.

## Connect the other server

If `auth.sadgirlsclub.wtf` has no server block yet, follow [AUTH_PROXY_SETUP.md](AUTH_PROXY_SETUP.md). It provides a complete HTTP/HTTPS configuration and first-certificate setup on the reverse proxy.

Use the existing [tracker proxy snippet](deploy/nginx-proxy.conf) inside lidoll.dev's HTTPS server block, and the [auth proxy snippet](deploy/nginx-auth.conf) inside auth.sadgirlsclub.wtf's HTTPS block. Update their upstream address if you changed --bind-address. Configure DNS and the actual TLS certificate on that web server.

If the **reverse-proxy server is also Fedora**, Nginx may need SELinux permission for upstream network connections. Keep SELinux enforcing; grant the relevant network permission rather than disabling SELinux:

```bash
sudo setsebool -P httpd_can_network_connect on
sudo nginx -t
sudo systemctl reload nginx
```

Fedora documents this [SELinux network-connect boolean](https://fedoraproject.org/wiki/Infrastructure/Mirroring/ProxyMirror). Apply it only on the reverse-proxy machine when needed. The service-server installer restores normal SELinux file labels with restorecon and leaves policy enforcement enabled.

Local deployment health checks verify both systemd processes run from the selected release, the tracker API responds correctly, and auth discovery advertises the expected issuer. They do not validate public DNS, TLS certificates, or external proxy reachability; verify a real sign-in through your public domain after setup.

The scripts assume the complete app is served through the Node proxy. If you use the optional static frontend hosting configuration, publishing frontend assets to the separate web server remains an additional step; this updater does not copy files to an unconfigured remote host.

## Create accounts and export data

Participants can create their own account through **Settings & data → Create account** or the shared sign-in page. The commands below remain available for administrator provisioning, password management, and exports. Registration uses the existing auth listener and SQLite database; deploy both services and the frontend to enable it. See [AUTH_GUIDE.md](AUTH_GUIDE.md) for account rules and throttling.

Use each service's Unix user for its administrative tools so SQLite sidecar files retain the correct ownership:

```bash
sudo -u lidoll-auth /usr/bin/node-24 --env-file=/etc/lidoll/auth.env \
  /opt/lidoll/current/scripts/auth-admin.mjs create alice

sudo -u lidoll-tracker /usr/bin/node-24 --env-file=/etc/lidoll/tracker.env \
  /opt/lidoll/current/scripts/admin.mjs export-csv \
  /var/lib/lidoll/tracker/exports/check-ins.csv
```

The create command displays the generated password once. Use a new filename for each export. [AUTH_GUIDE.md](AUTH_GUIDE.md) explains shared account administration and registering more apps.

## Update from GitHub

```bash
# Fetch and report the latest commit without deploying or restarting:
sudo bash /opt/lidoll/current/deploy/fedora-update.sh --check

# Fetch, test, back up, activate, and verify the latest configured branch:
sudo bash /opt/lidoll/current/deploy/fedora-update.sh
```

If that commit is already installed, the updater exits without restarting anything. The configured branch is fetched into an isolated Git mirror and checked out at its immutable commit ID. The live checkout is never reset or pulled over.

While the old release continues running, the updater installs the exact package-lock dependencies with npm ci (lifecycle scripts disabled), runs the automated .test.mjs suite, and checks main script syntax. Native dependencies that require install scripts need an explicit deployment-policy change; the updater will not silently enable arbitrary install hooks. Browser tests and public sign-in checks are separate from the server-side update gate.

The deployment then stops **both** services briefly, copies their stopped data directories plus env files into a private backup, atomically switches the current symlink, starts the services, and checks their process locations and HTTP responses. Shared auth is briefly unavailable to other apps during this switch. The service-worker cache is stamped with the Git commit so installed PWAs discover frontend updates; old tabs still close before the new worker takes over.

The updater reuses preserved env files. It never rotates signing keys, resets user passwords, deletes entries, or automatically prunes backups/releases. Keep enough disk space for the next checkout and a full copy of both databases; archive older backups off-server according to your retention policy. This script does not install an unattended update timer.

## Failures and recovery

If an older installer reports `fatal: failed to stat '/home/.../omo-trainer': Permission denied`, its build user inherited your private checkout as its working directory. The corrected command runner starts in `/` before switching users and uses explicit staging directories for builds. Keep your home permissions unchanged. After publishing this fix, run `git pull --ff-only` in your bootstrap checkout and retry `sudo bash deploy/fedora-deploy.sh` without replacement flags; existing setup settings are preserved.

To retry the older installer immediately without changing files, start it from an accessible directory (replace the path if your checkout lives elsewhere):

```bash
cd /
sudo bash /home/aedith/omo-trainer/deploy/fedora-deploy.sh
```

- Fetch, package-install, or test failure leaves the currently running services and release alone.
- Backup failure prevents activation and restarts the previous services.
- Failed new-release health checks switch code back to the previous release and check it again.
- If the old code cannot run against the current database state, services are stopped and the failure is reported. **Database contents are never automatically reverted**, because the new release may already have accepted newer writes. Inspect the current state and the pre-update backup before choosing a recovery path.
- First-deployment failure stops the new services and removes the active symlink, retaining any generated data and keys for inspection/retry.

```bash
sudo systemctl status lidoll-tracker lidoll-auth
sudo journalctl -u lidoll-tracker -u lidoll-auth -n 100 --no-pager
sudo cat /opt/lidoll/current/.release.json
```

An exclusive /etc/lidoll/deployment.lock prevents concurrent deployments. After a killed process or power failure, inspect the PID in that file and confirm no deployment is running before removing a stale lock. Verify the current symlink and services before retrying. Normal failures release the lock automatically.

For a private GitHub repository, use --repo git@github.com:AELovelace/omo-trainer.git and provision a read-only deploy key/verified GitHub known_hosts for the **lidoll-deploy** Unix user. The initial attempt creates that user before fetching, so a permission failure can be resolved and setup retried. The updater never copies your personal root/SSH credentials or disables SSH host verification.

## Validation

The repository tests cover activation order, failed backups, first-install failure, code rollback, rollback failure, configuration validation, source-specific firewall rules, and service isolation. Bash syntax and help paths are checked separately. These tests do not substitute for running dnf, systemd, firewalld, and SELinux on the actual Fedora server; the development workspace is Windows.


## MommyBot Games

Deploy the matching MommyBot version first, then update this tracker. The Games page defaults to `https://bot.lidoll.dev`; an alternative bot origin can be configured with `LIDOLLBOT_PUBLIC_ORIGIN` in `/etc/lidoll/tracker.env`. Keep `/tracker/games/` routed to the tracker Node service. See [GAMES_GUIDE.md](GAMES_GUIDE.md) for bot proxy routes, the unchanged callback registration and the post-deployment check.
