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
  npm run remote -- restart game      or: restart web, or just restart for both
  npm run remote -- rollback          undo the last update (again for the one before; 3 are kept)
  npm run remote -- rebuild           build both halves again from what is installed
  npm run deploy -- --full            send every file again

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
  tsps-game.service         the game server, port 43594 (players' browsers connect to it directly)
  tsps-web.service          the web client, port 3000

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
