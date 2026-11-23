# Mail portal for vidyanetwork.com

A small web app that sits on top of your existing Postfix + Dovecot server.

- **Administrator** (`/admin/login`): create mailboxes with a temporary password, reset passwords, delete mailboxes.
- **Mailbox users** (`/login`): read Inbox and Sent, write and reply to mail, change their password. A user with a temporary password must choose their own before they can do anything else.

It reads mail through Dovecot (IMAP on 127.0.0.1:143) and sends through Postfix (127.0.0.1:25), so mail sent from the portal is DKIM-signed by your existing opendkim setup and saved to the user's Sent folder.

## How it is secured

The administrator login is **not** the root password. The portal has its own administrator name and password, stored as a bcrypt hash in `/etc/mailportal/admin.json`.

- The app runs as an unprivileged `mailportal` account and listens only on 127.0.0.1:3000.
- It can do exactly one thing as root: run `/usr/local/sbin/mailportal-helper` (allowed in `/etc/sudoers.d/mailportal`).
- That helper only creates, changes or deletes accounts in the `mailusers` group, with uid 1000 or above, and not in `sudo`/`admin`. It refuses root, your own admin login, and system accounts, even if someone adds them to `mailusers`.
- New mailboxes get no shell (`/usr/sbin/nologin`), so a mailbox password can't open an SSH session.
- Mailbox sign-in is checked by Dovecot itself. Only `mailusers` members can sign in to the portal.
- Sign-in is rate-limited (10 tries per 15 minutes per IP). Every form has a CSRF token. Each mailbox may send at most 100 messages per hour, so one guessed password can't wreck your domain's reputation.
- HTML email is shown only on request, in a sandboxed frame with scripts and remote images blocked.

## 1. Requirements

Node.js 20 or newer, installed system-wide. Ubuntu 24.04's own `nodejs` package is version 18, which is too old. Check with `node -v`; if needed:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Your mail server must already deliver into Maildir and serve IMAP:

```bash
postconf -h home_mailbox          # must print: Maildir/
doveconf -h mail_location         # must print: maildir:~/Maildir
ss -ltn | grep ':143 '            # Dovecot listening for IMAP
```

The installer warns you if any of these are wrong.

## 2. Install

On the server, clone your repository and run the installer with `bash`, which works even if the executable bit was lost on the way through Windows or GitHub's web uploader:

```bash
cd /home/user
git clone https://github.com/YOUR-ACCOUNT/YOUR-REPO.git mailportal
cd mailportal
sudo bash install.sh
```

For a private repository, the server needs a deploy key or a personal access token to clone it.

It asks for the mail domain, the name shown in the portal, and the administrator name and password (at least 12 characters; pick a new one, not the root password). Running it again later updates the code and keeps your settings. Configuration and the administrator password live in `/etc/mailportal` on the server, outside the repository, so nothing secret ever gets committed.

## 3. Existing mailboxes

The installer offers to add existing users. To add one later:

```bash
sudo usermod -aG mailusers kunal
```

If they also shouldn't have SSH access: `sudo usermod -s /usr/sbin/nologin kunal`.

## 4. Put it behind HTTPS

The portal only listens on 127.0.0.1, so nothing is exposed until you add a web server in front of it.

1. In Cloudflare, add an **A** record: name `portal`, value `202.54.170.14`, proxy status **DNS only**.
2. Open HTTPS in the firewall: `sudo ufw allow 443/tcp`
3. Apache (already installed if you set up Roundcube; otherwise `sudo apt install -y apache2`):

```bash
sudo cp deploy/apache-mailportal.conf /etc/apache2/sites-available/mailportal.conf
sudo a2enmod proxy proxy_http headers
sudo a2ensite mailportal
sudo systemctl reload apache2
sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache --redirect -d portal.vidyanetwork.com
```

Then open `https://portal.vidyanetwork.com/admin/login`.

If nginx serves port 80 instead of Apache, use a server block with `proxy_pass http://127.0.0.1:3000;`, `proxy_set_header Host $host;`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and `proxy_set_header X-Forwarded-Proto $scheme;`, then `certbot --nginx -d portal.vidyanetwork.com`.

## 5. Daily use

- Create a mailbox at `/admin`. Leave the password empty to generate one. The page shows a slip with the address, temporary password and sign-in link once; pass it on to the person.
- The person signs in at `/login` with `name@vidyanetwork.com` (or just `name`) and is asked to choose a new password straight away.
- **Reset password** issues a new temporary password and signs the person out of open sessions on their next action.
- **Delete** removes the account, its home directory and all its mail. You type the username to confirm.

## Operations

| Task | Command |
|---|---|
| Logs | `journalctl -u mailportal -f` |
| Restart | `sudo systemctl restart mailportal` |
| Change administrator name or password | `sudo /opt/mailportal/set-admin-password.sh` (no restart needed) |
| Change settings | edit `/etc/mailportal/env`, then restart |
| Update the code | `cd /home/user/mailportal && git pull && sudo bash install.sh` |

## Current limits

- Shows the 50 most recent messages per folder. No search, no folders beyond Inbox and Sent.
- Attachments are listed but can't be downloaded or sent from the portal yet; use a mail app over POP3/IMAP for those.
- Sessions live in memory, so restarting the service signs everyone out.
