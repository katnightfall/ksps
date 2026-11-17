Deploying TSPS from this PC to its server
=========================================

This copy of TSPS is ours to change. `upstream` is the original project
(github.com/RSPSApp/tsps); our changes are commits on top of it.

Everyday use
------------
  1. Change things, then commit (a deploy sends the last commit, not the folder).
  2. npm run deploy

A deploy sends only the files that changed since the version on the server.
The server builds what needs building beside the live copy, keeps what it
replaces as a backup, swaps the new files in, and restarts only the half that
changed:

  what changed                               what the server does            players
  -----------------------------------------  ------------------------------  -----------------
  server/data, server/plugins (most edits)   restarts the game server        saved, reconnect
  server/src (the engine)                    builds it (seconds), restarts   saved, reconnect
  client/ (the web client)                   builds it (a few minutes)       stay online
  package.json / yarn.lock                   installs packages, builds       as above
  deploy/settings.env                        restarts the game server (and   saved, reconnect
                                             rebuilds the client if one of
                                             its lines changed)
  docs, tests                                nothing                         stay online

If the restarted half does not come back up, the backup is put back by itself.

Settings
--------
  deploy/settings.env     ours, in git, sent with a deploy: developer accounts, the server's
                          name on the login screen, anything from .env.example that isn't secret
  server/data/definitions/world.json    the world itself: name, spawn, XP rate, plugins on or off
  /opt/tsps/.env          on the server only: tokens and keys

Other commands
--------------
  npm run remote -- check             version, ports, saves, disk, memory
  npm run remote -- logs game 300     the game server's log (or: logs web)
  npm run remote -- status
  npm run remote -- logs update       what the last updates printed (if the connection dropped mid-deploy)
  npm run remote -- restart game      or: restart web, or just restart for both
  npm run remote -- rollback          undo the last update (again for the one before; 3 are kept)
  npm run remote -- rebuild           build both halves again from what is installed
  npm run deploy -- --full            send every file again

The site and its worlds
-----------------------
  https://rs.kat-net.us/            the landing page: the way in, the worlds, the hiscores
  https://rs.kat-net.us/play        the game (an old front-page link with a ?query still opens it)
  https://rs.kat-net.us/hiscores    the hiscores

  https://rs.kat-net.us/admin       the master's admin page: make and run worlds (below)

rs.kat-net.us is the master: it holds the list of worlds, and the others ask it for the list.
The worlds on the landing page and in the game's world picker are, and are only:

  deploy/worlds.json      the project's own list (edit, commit, deploy)
  the admin page's list   worlds made or added at /admin, kept on the server beside the player
                          saves (server/data/saves/master/; no deploy replaces it)

  { "id": "second", "name": "Kat-Net Classic", "world": "Kat-Net Classic",
    "address": "classic.kat-net.us", "secure": true, "description": "one line about it" }

"address" is where that world answers (its site, its game connection and its /api on one
address, as deploy/front.mjs or the Pterodactyl egg gives a world). "world" is the world's own
name, which is how a world finds itself on the list. Each world is asked /api/world-status for
who is on it, at most every twenty seconds; one that does not answer shows as offline. Both
lists are read again when they change, so no player is disconnected for a new world.

A world that is not on the list (somebody else's, from the Pterodactyl egg) shows itself alone.

The admin page (/admin)
-----------------------
Makes worlds on our Pterodactyl panel from the project's egg, starts, restarts and stops them,
edits how they are listed, and deletes them (the server and every save on it; it asks for the
world's name first). A world that already runs elsewhere can be added by its address.

One-time, as root on the server: let the website's service write the page's worlds (it may
write nowhere else). Until then the page says so and makes nothing.
  sudo cp /opt/tsps/deploy/tsps-web.service /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl restart tsps-web

It is off until these are in the server's own settings (sudo nano /opt/tsps/.env), followed by
"npm run remote -- restart web". They are secrets: never in the project, which is public.

  MASTER_ADMIN_PASSWORD=...   12 characters or more: what you sign in with
  PTERO_URL=https://panel.kat-net.us   the panel's address (one this server can reach)
  PTERO_APP_KEY=ptla_...      Admin > Application API. It needs, and the page names what is
                              missing: Servers read & write; Users, Nodes, Allocations, Nests,
                              Eggs and Locations read
  PTERO_CLIENT_KEY=ptlc_...   Account > API Credentials, of a root admin account. If the key
                              lists allowed IPs, this server's must be among them
  PTERO_PORT_RANGE=5000-5099  optional: only these ports are given to worlds
  PTERO_EGG_ID=, PTERO_NEST_ID=   optional: the egg is found by its name, "Kat-Net TSPS"
  PTERO_OWNER_ID=             optional: the panel user that owns the worlds

The panel must have the current egg (deploy/pterodactyl/egg-kat-net-tsps.json: import it again
after it changes), and each node needs free allocations. A new world is told the master's
address (MASTER_PUBLIC_URL in deploy/settings.env) and so shows the whole list.

Worlds played on the master's site
----------------------------------
A world made on the admin page is headless: it builds and serves no website (a much smaller
and quicker install), and runs at its node's bare address and port. It is played on the
master's site, at https://rs.kat-net.us/play?world=<id>, which the landing page and the game's
world picker link to. The master's front door carries that world's game connection and its
/api at /w/<id>, so the one https address serves every world.

The same goes for any listed world without https of its own (New York, until it has a name
behind https): the master carries it too. A world with https of its own is reached directly.

The admin page's "Location" is the panel's location (or the node, where the panel names none):
the world goes on that location's node with the most free ports.

https at the node's own name
----------------------------
A world made on the admin page is listed at its node's own name and port (game-nyc...:5000),
and is told where that node keeps the certificate for its name (the egg's "Certificate file"
and "Certificate key file": /etc/letsencrypt/live/<the node's name>/fullchain.pem and
privkey.pem). When the world can read them it answers on https there, the master notices
within a minute or two, and from then on the world picker connects players to it directly,
not through Dallas. When it cannot, it answers on plain http and is played through the master,
exactly as before: nothing breaks either way.

For the world to read them, once per node (as root on the node), since a panel server sees
nothing of the node's own files and the key is root's alone:
  1. Keep a copy the servers may read, refreshed at each renewal:
       mkdir -p /etc/tsps-certs
       cp -L /etc/letsencrypt/live/<name>/{fullchain,privkey}.pem /etc/tsps-certs/
       chown -R pterodactyl: /etc/tsps-certs && chmod 640 /etc/tsps-certs/*
     and the same three lines in /etc/letsencrypt/renewal-hooks/deploy/tsps-certs.sh.
  2. In the panel: Admin > Mounts > new mount, source /etc/tsps-certs, target
     /etc/letsencrypt/live/<name>, read only; add the node and the egg to it. Wings must allow
     the source (allowed_mounts in /etc/pterodactyl/config.yml), then restart Wings.
  3. On each world's server: Mounts tab > mount it, and restart the world.
This shows the node's private key to the worlds mounted on it: only for worlds that are ours.

What to know:
  * Every player of a world played through the master connects through this server: their
    traffic passes Dallas, which adds the distance to their latency. https at the node's own
    name (above) is what takes a far-away world off that path.
  * The master tells each such world who is really connecting, signed with a key both hold
    (the egg's "Master proxy key"; worlds made on the admin page are given it). A world set
    up by hand needs it set too ("Show the proxy key" on the admin page), or it sees every
    player arriving from the master's address: an IP ban there would then ban them all.
  * Accounts and saves are each world's own.

Keeping up with the original project
------------------------------------
  npm run sync                        fetch what is new in github.com/RSPSApp/tsps, merge it into
                                      ours, check it, then commit, push to the fork and deploy
  npm run sync -- --check             only say how many commits behind we are
  npm run sync -- --no-deploy         stop after the push
  npm run sync -- --verify            only run the checks on the folder as it is
  npm run sync -- --schedule 05:00    do it every day at that time on this PC (a Windows scheduled
                                      task, "Kat-Net TSPS upstream sync"; it runs while you are
                                      signed in, or as soon as the PC is on after that time)
  npm run sync -- --unschedule        stop the daily run

Before anything leaves this PC the merged folder must: build, pass our own tests (the ones the
original project does not have), type-check the web client, and start as a server for a minute
on a scratch save file without printing an error. If any of that fails, or both sides changed
the same lines of a file, the folder is put back exactly as it was, nothing is pushed or
deployed, and the reason is printed. A daily run writes what it did to deploy/sync.log and puts
a message on the screen when it needs a hand.

It only starts from the main branch with nothing uncommitted, so it never touches work in
progress. Two kinds of file are settled without asking: docs/world-configuration.md (made again
from the code) and our own icons (ours are kept). A deploy of a merge restarts the game when
game files changed: players are saved and disconnected, as with any deploy.

One-time setup (yours to run: it asks for the server's password)
----------------------------------------------------------------
  deploy.local.json in the project folder says where the server is:
    { "host": "root@203.0.113.10", "key": "~/.ssh/tsps_deploy" }
  npm run deploy:setup
  npm run deploy          the first one takes 15 to 30 minutes

The setup installs Node.js 22 if needed, makes the tsps user, the folders and
the two services, opens the two ports in ufw/firewalld if one is running, and
allows the deploy key. The key cannot open a shell: it can only run the
updater's commands above.

On the server
-------------
  /opt/tsps                 the project (owned by the tsps user)
  /opt/tsps/.env            this server's settings and secrets; never sent or replaced
  /opt/tsps/server/data/saves                      player saves, accounts, bans; never replaced
  /opt/tsps/server/data/definitions/world.local.json   this server's world settings; never replaced
  /opt/tsps/server/caches   the game cache (downloaded by the server itself)
  /opt/tsps-deploy          backups of the last 3 updates, the build folder, package caches
  /etc/tsps-deploy.conf     the two ports
  tsps-game.service         the game server, port 43594
  tsps-web.service          the front door, port 3000 (deploy/front.mjs): the website, and the game
                            connection and the game's /api addresses passed on to the game server,
                            so one address is enough. https://rs.kat-net.us reaches it through
                            Cloudflare; http://<server>:3000 works too.

Things only someone logged in to the server can do
--------------------------------------------------
  - Edit /opt/tsps/.env (tokens, such as the one that lists the world on rsps.app).
  - Open the world config page (settings, players and their ranks, plugins). It only listens on
    the server itself, so tunnel to it:   ssh -L 49600:127.0.0.1:49600 <your login>@<server>
    then open the link the game log prints at start; the token is in
    /opt/tsps/server/data/definitions/world-admin.token.
  - Apply a newer updater or service file when a deploy says there is one.

Taking in upstream's changes
----------------------------
  git fetch upstream
  git merge upstream/main
  npm run deploy
Don't run the "git config merge.ours.driver true" that .gitattributes mentions: it is for
upstream's own merges and would silently keep our side of every conflict under server/.

Running it on a Pterodactyl panel
---------------------------------
A different way to host a world, unrelated to "npm run deploy": deploy/pterodactyl holds an egg
(egg-kat-net-tsps.json) that installs, builds and runs the game and its website as one panel
server on one port. See deploy/pterodactyl/README.txt.
