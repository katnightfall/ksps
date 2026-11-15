// Talks to the TSPS server through the deploy key (deploy/README.txt).
//   npm run deploy                 send what changed since the version on the server; it builds what
//                                  needs building, swaps it in and restarts only the half that changed
//   npm run deploy -- --full       send every file again, whatever the server says it has
//   npm run remote -- check | status | version | logs [game|web] [lines] | restart [game|web] | rollback | rebuild
// Reads deploy.local.json: { "host": "root@203.0.113.10", "key": "~/.ssh/tsps_deploy" }
//
// What is sent is the last commit, not the folder: commit first, then deploy.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SETTINGS = path.join(PROJECT, 'deploy.local.json');

// On Windows, use Windows' own ssh and tar even when Git Bash's are earlier on the PATH.
export function tool(name) {
  const candidates = { tar: ['System32', 'tar.exe'], ssh: ['System32', 'OpenSSH', 'ssh.exe'], scp: ['System32', 'OpenSSH', 'scp.exe'] }[name];
  const full = process.platform === 'win32' && path.join(process.env.SystemRoot ?? 'C:\\Windows', ...candidates);
  return full && fs.existsSync(full) ? full : name;
}

export function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    if (!/^[\w.-]+@[\w.:-]+$/.test(s.host)) throw new Error('host');
    return { ...s, key: s.key.replace(/^~(?=$|[\\/])/, os.homedir()) };
  } catch {
    console.error(`Couldn't read ${SETTINGS}. It should look like: { "host": "root@203.0.113.10", "key": "~/.ssh/tsps_deploy" }`);
    process.exit(1);
  }
}

function git(args, { input, env } = {}) {
  const run = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', ...args],
    { cwd: PROJECT, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env, input: input === undefined ? undefined : Buffer.from(input) });
  if (run.status !== 0) {
    console.error(`git ${args[0]} failed:\n${run.stderr?.toString() ?? ''}`);
    process.exit(1);
  }
  return run.stdout;
}

/**
 * Packs the last commit for the server as a .tgz in the temp folder: the files that differ from
 * `base` (every file when base is null), plus .tsps-deploy/commit and .tsps-deploy/manifest, the
 * list of every file the commit has. Built from git's own copies, so Windows line endings and
 * anything uncommitted never go along. Returns { archive, count }.
 */
export function packCommit(head, base) {
  const entries = git(['ls-tree', '-r', '-z', 'HEAD']).toString('utf8').split('\0').filter(Boolean).map((line) => {
    const [info, file] = [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)];
    return { info, file };
  });
  const odd = entries.find((e) => /[^\x20-\x7e]|\\|^-|^\.tsps-deploy\//.test(e.file) || !/^100(644|755) blob /.test(e.info));
  if (odd) {
    console.error(`The server's updater won't take this entry: ${odd.file} (${odd.info}). Nothing was sent.`);
    process.exit(1);
  }
  let wanted = entries;
  if (base) {
    const changed = new Set(git(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=ACMT', base, 'HEAD']).toString('utf8').split('\0').filter(Boolean));
    wanted = entries.filter((e) => changed.has(e.file));
  }

  const blob = (text) => git(['hash-object', '-w', '--stdin'], { input: text }).toString().trim();
  const index = path.join(os.tmpdir(), `tsps-deploy-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const lines = [
      ...wanted.map((e) => `${e.info}\t${e.file}`),
      `100644 blob ${blob(`${head}\n`)}\t.tsps-deploy/commit`,
      `100644 blob ${blob(entries.map((e) => `${e.file}\n`).join(''))}\t.tsps-deploy/manifest`,
    ];
    git(['update-index', '-z', '--index-info'], { input: lines.map((l) => `${l}\0`).join(''), env });
    const tree = git(['write-tree'], { env }).toString().trim();
    const archive = path.join(os.tmpdir(), `tsps-deploy-${Date.now()}.tgz`);
    git(['archive', '--format=tar.gz', '-o', archive, tree]);
    return { archive, count: wanted.length };
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
  }
}

function main() {
  const settings = readSettings();
  const [command = 'update', ...options] = process.argv.slice(2);
  const ssh = (remoteCommand, stdio) => spawnSync(tool('ssh'), [
    '-i', settings.key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30', settings.host, remoteCommand,
  ], { stdio });

  if (command !== 'update') {
    process.exit(ssh([command, ...options].join(' '), 'inherit').status ?? 1);
  }

  const dirty = git(['status', '--porcelain', '--untracked-files=no']).toString().trim();
  if (dirty) {
    console.error(`These changes aren't committed, and a deploy sends the last commit:\n${dirty}\n\nCommit them, then deploy. Nothing was sent.`);
    process.exit(1);
  }
  const head = git(['rev-parse', 'HEAD']).toString().trim();

  const asked = ssh('version', ['ignore', 'pipe', 'inherit']);
  const has = asked.stdout?.toString().trim() ?? '';
  if (asked.status !== 0 || !/^(none|[0-9a-f]{40})$/.test(has)) {
    console.error(`\nThe server didn't answer the deploy key${has ? `: ${has}` : '.'}`);
    console.error('If it says "Permission denied", the one-time setup has not been run yet: npm run deploy:setup');
    process.exit(1);
  }
  const full = options.includes('--full');
  if (has === head && !full) {
    console.log(`The server already runs this version (${head.slice(0, 9)}). Nothing to send.`);
    return;
  }
  // The version on the server has to be one this copy knows, to tell what changed since.
  const known = has !== 'none' && spawnSync('git', ['cat-file', '-e', `${has}^{commit}`], { cwd: PROJECT }).status === 0;
  let base = known && !full ? has : null;

  for (;;) {
    const { archive, count } = packCommit(head, base);
    try {
      const size = fs.statSync(archive).size;
      console.log(`Sending ${base ? `the ${count} changed files` : `all ${count} files`} (${size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`}) to ${settings.host}: ${head.slice(0, 9)}${base ? ` on top of ${base.slice(0, 9)}` : ''}\n`);
      const input = fs.openSync(archive, 'r');
      const sent = ssh(`update ${base ?? 'full'}`, [input, 'inherit', 'inherit']);
      fs.closeSync(input);
      // 3: the server moved to another version meanwhile (a rollback, say). Send everything instead.
      if (sent.status === 3 && base) {
        console.log('\nSending every file instead...');
        base = null;
        continue;
      }
      process.exitCode = sent.status ?? 1;
      return;
    } finally {
      fs.rmSync(archive, { force: true });
    }
  }
}

// Run directly (not imported by setup-remote.mjs). Windows paths compare without case (A: vs a:).
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) main();
