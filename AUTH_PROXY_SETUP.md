# Set up auth.sadgirlsclub.wtf on the Nginx server

Run these steps on the **reverse-proxy/web server**, from a checkout containing these files. The Node service stays on **10.1.1.23:4180**. Publish the new repository files before pulling them onto that server. Select the configuration directory your proxy actually includes; its layout may differ from the Fedora service server.

Point `auth.sadgirlsclub.wtf` DNS at the reverse proxy's public address. Any AAAA record must also reach this server over IPv6. Allow public HTTP/HTTPS traffic on ports 80/443 and allow the proxy to reach the private auth service. The service must use `AUTH_ISSUER=https://auth.sadgirlsclub.wtf` and `AUTH_TRUST_PROXY=1` (the deployment defaults).

Use [nginx-auth-server.conf](deploy/nginx-auth-server.conf) for the **complete server configuration**. The older [nginx-auth.conf](deploy/nginx-auth.conf) remains a location-only snippet for sites that already have their own HTTPS server block. Install one approach only; do not load duplicate auth server blocks. Both new files declare IPv4 and IPv6 listeners; remove the `[::]` listeners if IPv6 is disabled on the proxy host.

## Check which configuration directory Nginx loads

Nginx loads files through its [include directives](https://nginx.org/en/docs/ngx_core_module.html#include). A file in `conf.d` is not automatically active. Check the effective configuration:

```bash
sudo nginx -T 2>&1 | grep -E 'include.*(conf.d|sites-enabled)|server_name.*auth[.]sadgirlsclub[.]wtf'
```

The commands below use `/etc/nginx/conf.d/auth.sadgirlsclub.wtf.conf`. If your proxy includes `sites-enabled/*` but not `conf.d/*.conf`, replace that destination in **both** installation commands with `/etc/nginx/sites-available/auth.sadgirlsclub.wtf.conf`. After installing the bootstrap (or final configuration if you already have its certificate), enable it once:

```bash
sudo ln -s /etc/nginx/sites-available/auth.sadgirlsclub.wtf.conf /etc/nginx/sites-enabled/auth.sadgirlsclub.wtf.conf
sudo nginx -t && sudo systemctl reload nginx
```

If the link already exists, inspect it instead of replacing it blindly. Use only one active copy of the auth server configuration if both directories are included. Install the complete server/bootstrap file, not the older location-only snippet. `nginx -T` should then contain `server_name auth.sadgirlsclub.wtf;`.

If Certbot's interactive domain list omits auth, first check that line appears in the loaded Nginx configuration. You can explicitly request the hostname using the `certonly --webroot ... -d auth.sadgirlsclub.wtf` command below; it does not need selection from a domain list. The HTTP challenge still needs to reach the correct webroot.

## If you already have a certificate covering auth.sadgirlsclub.wtf

Set `ssl_certificate` and `ssl_certificate_key` in `deploy/nginx-auth-server.conf` to the actual full-chain and private-key paths on the proxy. A certificate for only `lidoll.dev` does not cover `auth.sadgirlsclub.wtf`; an appropriate wildcard or explicitly included hostname does. Nginx's [HTTPS documentation](https://nginx.org/en/docs/http/configuring_https_servers.html) describes these settings.

Then run the final installation commands below. Keep using your existing certificate renewal process.

## If you need the first certificate

Use your installed Certbot, or install it using your proxy operating system's package manager (`sudo dnf install certbot` on Fedora). First install the HTTP-only bootstrap configuration. It serves certificate challenges without requiring a certificate that does not exist yet.

```bash
sudo install -d -m 0755 /var/www/letsencrypt
sudo install -m 0644 deploy/nginx-auth-bootstrap.conf /etc/nginx/conf.d/auth.sadgirlsclub.wtf.conf
sudo nginx -t && sudo systemctl reload nginx
```

If `nginx -t` fails, resolve the reported error before continuing. On a Fedora proxy with SELinux enforcing, restore the normal labels with `sudo restorecon -R /var/www/letsencrypt /etc/nginx/conf.d`.

Once public DNS and port 80 reach this configuration, request the certificate:

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  --cert-name auth.sadgirlsclub.wtf -d auth.sadgirlsclub.wtf
```

Follow Certbot's prompts for your email address and terms. The [Certbot webroot method](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot) keeps Nginx running during issuance and renewal. Check the resulting certificate paths match the HTTPS template before installing it.

## Install the final configuration

This replaces the temporary HTTP-only file at the same destination. Run only after the certificate exists:

```bash
sudo install -m 0644 deploy/nginx-auth-server.conf /etc/nginx/conf.d/auth.sadgirlsclub.wtf.conf
sudo nginx -t && sudo systemctl reload nginx
curl --fail --show-error https://auth.sadgirlsclub.wtf/.well-known/openid-configuration
```

The discovery JSON should report `"issuer":"https://auth.sadgirlsclub.wtf"`. A 502 response means Nginx could not obtain a valid upstream response; check `lidoll-auth` on the service server, routing/firewall access to port 4180, and the proxy's error log. On a Fedora proxy, enable upstream connections with `sudo setsebool -P httpd_can_network_connect on` if needed, as described in [FEDORA_DEPLOYMENT.md](FEDORA_DEPLOYMENT.md).

For the Certbot webroot setup, retain the HTTP challenge location and arrange a successful-renewal hook to reload Nginx. If your existing certificate setup has no such hook, create one:

```bash
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/lidoll-nginx-reload.sh >/dev/null <<'EOF'
#!/bin/sh
set -eu
nginx -t
systemctl reload nginx
EOF
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/lidoll-nginx-reload.sh
sudo certbot renew --dry-run
```

Confirm your Certbot installation has a scheduled renewal timer or cron job enabled; the dry run does not schedule renewals. Review `systemctl list-timers --all` and your package's renewal configuration. A dry run does not run deploy hooks by default; the final installation above checks the same Nginx validation/reload commands.

The configuration has been reviewed locally, but this Windows workspace has no Nginx binary or access to your proxy. The `nginx -t`, certificate issuance, and public discovery checks above must run on your server.
