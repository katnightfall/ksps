// One-time setup, run by you in a terminal (it asks for the server's password, twice; a login that
// isn't root is also asked for its sudo password):
//   npm run deploy:setup
//   npm run deploy:setup -- --web-port 3100       if something else on the server already uses 3000
//   npm run deploy:setup -- --game-port 43600     likewise for the game's own port, 43594
// It sends only the deploy folder (a few small scripts), runs deploy/setup.sh there, and allows the
// deploy key from deploy.local.json, so `npm run deploy` works from then on without passwords.
// The game itself is not sent by this; the first `npm run deploy` does that.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT, readSettings, tool } from './remote.mjs';

const settings = readSettings();
const options = process.argv.slice(2);
for (let i = 0; i < options.length; i += 2) {
  if (!['--web-port', '--game-port'].includes(options[i]) || !/^\d{2,5}$/.test(options[i + 1] ?? '')) {
    console.error('Options: --web-port <number> and --game-port <number>');
    process.exit(1);
  }
}

const pubFile = `${settings.key}.pub`;
if (!fs.existsSync(pubFile)) {
  console.error(`No public key at ${pubFile}. Make one with: ssh-keygen -t ed25519 -f ${settings.key} -N "" -C tsps-deploy`);
  process.exit(1);
}
const pub = fs.readFileSync(pubFile, 'utf8').trim();
if (!/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+( [\w.@-]+)?$/.test(pub)) {
  console.error(`${pubFile} doesn't look like a public key.`);
  process.exit(1);
}

const user = settings.host.split('@')[0];
const sudo = user === 'root' ? '' : 'sudo ';
// A relative archive name from the temp folder, so no tool mistakes the Windows drive letter for a host.
const archiveName = `tsps-deploy-setup-${Date.now()}.tgz`;
const archive = path.join(os.tmpdir(), archiveName);
const tar = spawnSync(tool('tar'), ['-czf', archiveName, '-C', PROJECT, 'deploy'], { cwd: os.tmpdir(), stdio: 'inherit' });
if (tar.status !== 0) {
  console.error('Packing the deploy folder failed.');
  process.exit(1);
}
try {
  console.log(`\nStep 1 of 2: sending the deploy scripts to ${settings.host} (asks for ${user}'s password)...`);
  const scp = spawnSync(tool('scp'), ['-o', 'StrictHostKeyChecking=accept-new', archiveName, `${settings.host}:tsps-deploy-setup.tgz`],
    { cwd: os.tmpdir(), stdio: 'inherit' });
  if (scp.status !== 0) process.exit(scp.status ?? 1);

  console.log(`\nStep 2 of 2: setting up (asks for the password again${sudo ? ", then sudo's" : ''})...`);
  const remote = [
    'set -e',
    'rm -rf ~/tsps-deploy-setup',
    'mkdir ~/tsps-deploy-setup',
    'tar -xzf ~/tsps-deploy-setup.tgz -C ~/tsps-deploy-setup --strip-components=1',
    'rm -f ~/tsps-deploy-setup.tgz',
    // Scripts that passed through Windows may carry its line endings.
    "sed -i 's/\\r$//' ~/tsps-deploy-setup/*.sh ~/tsps-deploy-setup/*.service",
    `${sudo}bash ~/tsps-deploy-setup/setup.sh '${pub}' ${user} ${options.join(' ')}`.trim(),
  ].join(' && ');
  const ssh = spawnSync(tool('ssh'), ['-t', '-o', 'StrictHostKeyChecking=accept-new', settings.host, remote], { stdio: 'inherit' });
  process.exitCode = ssh.status ?? 1;
} finally {
  fs.rmSync(archive, { force: true });
}
