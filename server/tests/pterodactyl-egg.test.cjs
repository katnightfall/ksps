// node --test tests/pterodactyl-egg.test.cjs
// Ours: the Pterodactyl egg (deploy/pterodactyl). The launcher's settings, and that the egg file
// is the one make-egg.mjs writes.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const dir = path.resolve(__dirname, '../../deploy/pterodactyl');
const load = (file) => import(pathToFileURL(path.join(dir, file)).href);

const SITES = {
  newcomers: { enabled: true, progression: true, startOver: 1, x: 3222, y: 3219, radius: 12, switchMinutes: [20, 40],
    bots: { woodcutting: 340, mining: 245, fishing: 180, combat_training: 560, agility: 150 } },
  pen: { enabled: true, x: 3100, y: 3520, bots: { pvp: { fighters: 25 } } },
};
const WORLD = { name: 'Kat-Net', experienceMultiplier: 10, pluginConfig: { 'PlayerBots:sites': SITES, 'Woodcutting:regularTreeTicks': 45 } };
const total = (sites) => Object.values(sites.newcomers.bots).reduce((sum, count) => sum + count, 0);

test('the bot crowd is scaled to the number asked for, every mode keeping its share', async () => {
  const { scaleBotSites } = await load('launch.mjs');
  for (const wanted of [1475, 1000, 100, 37, 5, 1]) {
    const scaled = scaleBotSites(SITES, wanted);
    assert.equal(total(scaled), wanted, `${wanted} bots`);
    assert.equal(scaled.newcomers.enabled, true);
  }
  assert.deepEqual(scaleBotSites(SITES, 100).newcomers.bots, { woodcutting: 23, mining: 17, fishing: 12, combat_training: 38, agility: 10 });
  assert.deepEqual(scaleBotSites(SITES, 1475).newcomers.bots, SITES.newcomers.bots, 'the number it already is: unchanged');
  const none = scaleBotSites(SITES, 0);
  assert.equal(total(none), 0);
  assert.equal(none.newcomers.enabled, false, 'a crowd of nobody is turned off');
  assert.deepEqual(none.pen, SITES.pen, 'a site that is not a crowd is left alone');
  assert.equal(SITES.newcomers.bots.woodcutting, 340, 'world.json itself is not touched');
  assert.equal(scaleBotSites(undefined, 50), undefined);
});

test('the egg variables become world.local.json; the owner\'s own keys are kept', async () => {
  const { worldSettings } = await load('launch.mjs');
  const mine = { plugins: { TutorialIsland: true }, pluginConfig: { 'WelcomeScreen:messageOfTheWeek': 'Hello' } };
  const first = worldSettings({ WORLD_NAME: ' Ember Isles ', WORLD_DESCRIPTION: 'Slow and steady', XP_RATE: '3', BOT_COUNT: '50' }, WORLD, mine, []);
  assert.equal(first.local.name, 'Ember Isles');
  assert.equal(first.local.description, 'Slow and steady');
  assert.equal(first.local.experienceMultiplier, 3);
  assert.equal(total(first.local.pluginConfig['PlayerBots:sites']), 50);
  assert.deepEqual(first.local.plugins, { TutorialIsland: true });
  assert.equal(first.local.pluginConfig['WelcomeScreen:messageOfTheWeek'], 'Hello');
  assert.deepEqual(first.managed, ['name', 'description', 'experienceMultiplier', 'pluginConfig.PlayerBots:sites']);
  assert.equal(first.local.pluginConfig['Woodcutting:regularTreeTicks'], undefined, 'world.json\'s other settings are not copied in');

  // Variables emptied later: their keys go back to world.json, the owner's stay.
  const later = worldSettings({ WORLD_NAME: 'Ember Isles', XP_RATE: '', BOT_COUNT: '' }, WORLD, first.local, first.managed);
  assert.deepEqual(later.local, { ...mine, name: 'Ember Isles' });
  assert.deepEqual(later.managed, ['name']);

  // Nothing set and nothing of the owner's: no file is needed.
  assert.deepEqual(worldSettings({}, WORLD, {}, []).local, {});
  // A key the owner wrote is not taken for one of ours.
  const owners = worldSettings({}, WORLD, { name: 'Their Name' }, []);
  assert.equal(owners.local.name, 'Their Name');
  // Bad numbers are ignored.
  const bad = worldSettings({ XP_RATE: 'fast', BOT_COUNT: '-4' }, WORLD, {}, []);
  assert.deepEqual(bad.local, {});
});

test('the game is started with the egg\'s settings, and never with our own server\'s', async () => {
  const { gameEnv, heapMb, clientBuildEnv } = await load('launch.mjs');
  const game = gameEnv({ DEV_USERNAME: 'owner', PUBLIC_WS_URL: ' wss://play.example.com ', BOT_COUNT: '0', PATH: '/bin' });
  assert.equal(game.DEV_USERNAME, 'owner');
  assert.equal(game.WORLD_WEBSOCKET_URL, 'wss://play.example.com');
  assert.equal(game.DISABLE_PLAYER_BOTS, '1', 'no bots at all at 0');
  assert.equal(game.WEBSOCKET_PORT, '43594');
  assert.equal(game.TSPS_SUPERVISED, '1');
  assert.equal(game.PATH, '/bin');
  const plain = gameEnv({ DEV_USERNAME: '', BOT_COUNT: '100' });
  assert.equal('DEV_USERNAME' in plain, false, 'an empty variable leaves the .env file or the default to decide');
  assert.equal('DISABLE_PLAYER_BOTS' in plain, false);
  assert.equal('WORLD_WEBSOCKET_URL' in plain, false);

  assert.equal(heapMb({ SERVER_MEMORY: '8192' }), 5734);
  assert.equal(heapMb({ SERVER_MEMORY: '1024' }), 1024, 'never under 1 GB');
  assert.equal(heapMb({ SERVER_MEMORY: '0' }), 8192, 'an unlimited server: the project\'s own default');
  assert.equal(heapMb({ SERVER_MEMORY: '8192', GAME_HEAP_MB: '3000' }), 3000);

  assert.deepEqual(clientBuildEnv({ WORLD_NAME: 'Ember Isles' }),
    { PUBLIC_URL: '/', REACT_APP_SAME_ORIGIN_GAME: 'true', REACT_APP_DEFAULT_SERVER_NAME: 'Ember Isles' });
  // The launcher does not read deploy/settings.env, which names our own developers and address.
  const source = fs.readFileSync(path.join(dir, 'launch.mjs'), 'utf8');
  assert.equal(/env-file[^\n]*settings\.env/.test(source), false);
});

test('an update keeps the owner\'s edits, and never leaves a file half-merged', async () => {
  const { updateProject } = await load('launch.mjs');
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'egg-update-'));
  const git = (cwd, ...args) => {
    const done = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
    assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
    return done.stdout.trim();
  };
  const write = (root, file, body) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), body); };
  const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
  const INDEX = 'server/plugins/bots/data/object-index.json';

  // The project as published, and a server's copy of it (installed as the egg does: a shallow fetch).
  const origin = path.join(base, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  // Line endings as they are, whatever this machine's git would make of them.
  git(origin, 'config', 'core.autocrlf', 'false');
  write(origin, 'server/plugins/shop.js', 'price = 1;\nstock = 5;\n');
  write(origin, 'server/plugins/other.js', 'other = 1;\n');
  write(origin, INDEX, '{"made":"by the project"}\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'first');
  const install = (name) => {
    const copy = path.join(base, name);
    fs.mkdirSync(copy);
    git(copy, 'init', '-q');
    git(copy, 'config', 'core.autocrlf', 'false');
    git(copy, 'remote', 'add', 'origin', origin);
    git(copy, 'fetch', '-q', '--depth', '1', 'origin', 'main');
    git(copy, 'checkout', '-q', '-f', '-B', 'main', 'FETCH_HEAD');
    git(copy, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    return copy;
  };
  const said = [];
  const update = (copy) => updateProject(copy, (line) => said.push(line));
  const publish = (file, body, message) => { write(origin, file, body); git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', message); };

  const server = install('server');
  assert.equal(update(server), 'current');

  // A plain update.
  publish('server/plugins/other.js', 'other = 2;\n', 'second');
  assert.equal(update(server), 'updated');
  assert.equal(read(server, 'server/plugins/other.js'), 'other = 2;\n');
  assert.equal(git(server, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'));

  // The owner edited one file, the project changed another: both are there afterwards. A file
  // the owner made is untouched, and the file the game rewrites is the project's again.
  write(server, 'server/plugins/shop.js', 'price = 99;\nstock = 5;\n');
  write(server, 'server/data/saves/players.sqlite', 'saves');
  write(server, INDEX, '{"made":"by the game as it ran"}\n');
  publish('server/plugins/other.js', 'other = 3;\n', 'third');
  assert.equal(update(server), 'updated');
  assert.equal(read(server, 'server/plugins/shop.js'), 'price = 99;\nstock = 5;\n', 'the owner\'s edit is kept');
  assert.equal(read(server, 'server/plugins/other.js'), 'other = 3;\n');
  assert.equal(read(server, 'server/data/saves/players.sqlite'), 'saves');
  assert.equal(read(server, INDEX), '{"made":"by the project"}\n');
  assert.equal(git(server, 'stash', 'list'), '', 'nothing left aside');

  // The same line changed on both sides: the new version's file, whole; the edit kept aside.
  publish('server/plugins/shop.js', 'price = 2;\nstock = 5;\n', 'fourth');
  assert.equal(update(server), 'updated-edits-stashed');
  assert.equal(read(server, 'server/plugins/shop.js'), 'price = 2;\nstock = 5;\n', 'no conflict markers in a file the game reads');
  assert.match(git(server, 'stash', 'list'), /edits put aside/);
  assert.match(git(server, 'stash', 'show', '-p'), /price = 99/);
  assert.ok(said.some((line) => /kept aside/.test(line)));
  assert.equal(git(server, 'status', '--porcelain', '--untracked-files=no'), '', 'a clean copy of the new version');

  // History rewritten upstream: left alone, with a line saying how to get it.
  const other = install('other');
  git(origin, 'commit', '-q', '--amend', '-m', 'fourth, again');
  assert.equal(update(other), 'diverged');
  // Not a git copy at all.
  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  assert.equal(update(plain), 'none');
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* left for the system to clear */ }
});

test('temporary files go on the disk of the server, not the small /tmp of its container', async () => {
  const { useDiskForTemporaryFiles } = await load('launch.mjs');
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egg-tmp-'));
  fs.mkdirSync(path.join(root, '.egg-tmp'));
  fs.writeFileSync(path.join(root, '.egg-tmp', 'left-over'), 'from the last start');
  const env = { TMPDIR: '/tmp', PATH: '/bin' };
  const folder = useDiskForTemporaryFiles(env, root);
  assert.equal(folder, path.join(root, '.egg-tmp'));
  assert.deepEqual(env, { TMPDIR: folder, TMP: folder, TEMP: folder, PATH: '/bin' });
  assert.deepEqual(fs.readdirSync(folder), [], 'emptied at every start');
  // Everything the launcher starts takes its environment from process.env, where this is set.
  const source = fs.readFileSync(path.join(dir, 'launch.mjs'), 'utf8');
  assert.ok(source.includes('const env = process.env;') && source.includes('useDiskForTemporaryFiles(env);'));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* left for the system to clear */ }
});

test('the website is built to fit a container: one process, no type-check pass', async () => {
  const { FRUGAL_BUILD } = await load('launch.mjs');
  assert.deepEqual(FRUGAL_BUILD, { TSPS_BUILD_SKIP_TYPECHECK: '1', TSPS_BUILD_WORKERS: '0', DISABLE_ESLINT_PLUGIN: 'true' });
  const launcher = fs.readFileSync(path.join(dir, 'launch.mjs'), 'utf8');
  assert.ok(launcher.includes('...FRUGAL_BUILD,'), 'the build is started with them');
  // The build's own configuration is what acts on the two that are ours.
  const craco = fs.readFileSync(path.resolve(__dirname, '../../client/craco.config.js'), 'utf8');
  for (const name of ['TSPS_BUILD_SKIP_TYPECHECK', 'TSPS_BUILD_WORKERS']) assert.ok(craco.includes(`process.env.${name}`), name);
});

test('the egg file is the one make-egg.mjs writes, and fits what the launcher reads', async () => {
  const { makeEgg, EGG_FILE } = await load('make-egg.mjs');
  const { READY_LINE } = await load('launch.mjs');
  const egg = JSON.parse(fs.readFileSync(EGG_FILE, 'utf8'));
  assert.deepEqual(egg, JSON.parse(JSON.stringify(makeEgg())), 'out of date: node deploy/pterodactyl/make-egg.mjs');
  assert.equal(egg.meta.version, 'PTDL_v2');
  assert.equal(JSON.parse(egg.config.startup).done, READY_LINE);
  assert.equal(egg.config.stop, 'stop');
  assert.equal(egg.startup, 'node deploy/pterodactyl/launch.mjs');
  assert.ok(egg.scripts.installation.script.includes('launch.mjs --prepare'));
  assert.equal(egg.scripts.installation.script.includes('\r'), false);
  // Every variable is one the launcher or the install script reads, and each is well formed.
  const read = fs.readFileSync(path.join(dir, 'launch.mjs'), 'utf8') + fs.readFileSync(path.join(dir, 'install.sh'), 'utf8');
  const names = new Set();
  for (const variable of egg.variables) {
    assert.match(variable.env_variable, /^[A-Z_]+$/);
    assert.ok(read.includes(variable.env_variable), `${variable.env_variable} is read`);
    assert.equal(names.has(variable.env_variable), false);
    names.add(variable.env_variable);
    assert.equal(typeof variable.default_value, 'string');
    assert.ok(variable.rules.startsWith('required') || variable.rules.startsWith('nullable'));
    if (variable.rules.startsWith('required')) assert.notEqual(variable.default_value, '', `${variable.env_variable} needs a default`);
  }
  // Nobody is a developer on a new world unless its owner says so.
  assert.equal(egg.variables.find((variable) => variable.env_variable === 'DEV_USERNAME').default_value, '');
});

test('a host that takes the connection and says nothing does not keep the world from starting', async () => {
  const { updateProject } = await load('launch.mjs');
  const { spawnSync } = require('node:child_process');
  const net = require('node:net');
  const os = require('node:os');
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'egg-silent-'));
  const git = (...args) => {
    const done = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], { cwd: copy, encoding: 'utf8' });
    assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
  };
  // Where the project is fetched from: it answers the knock, and then nothing more.
  const held = new Set();
  const silent = net.createServer((socket) => { held.add(socket); socket.on('error', () => {}); });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  try {
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'the version installed');
    git('remote', 'add', 'origin', `http://127.0.0.1:${silent.address().port}/project.git`);
    git('config', 'branch.main.remote', 'origin');
    git('config', 'branch.main.merge', 'refs/heads/main');
    const said = [];
    const started = Date.now();
    // The launcher waits five minutes; three seconds here. Without a limit this never returns.
    const result = updateProject(copy, (line) => said.push(line), { fetchLimitMs: 3_000 });
    assert.equal(result, 'failed');
    assert.ok(Date.now() - started < 20_000, 'given up on in time');
    assert.match(said.join('\n'), /could not be fetched \(it had not finished after 3 seconds\); starting the version already here/);
  } finally {
    for (const socket of held) socket.destroy();
    silent.close();
    // What git had started for the connection ends once the connection has, a moment after this.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    try { fs.rmSync(copy, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {}
  }
});

test('world.local.json is written whole, and one that cannot be read is kept aside and said, not taken for empty', async () => {
  const { writeWorld } = await load('launch.mjs');
  const os = require('node:os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'egg-world-'));
  const files = { state: path.join(base, '.egg-state.json'), world: path.join(base, 'world.json'), local: path.join(base, 'world.local.json') };
  fs.writeFileSync(files.world, JSON.stringify(WORLD));
  const env = { WORLD_NAME: 'Kat-Net New York', XP_RATE: '5' };
  const said = [];
  try {
    // The owner's own setting beside the egg's keys, as the world's settings page writes it.
    fs.writeFileSync(files.local, JSON.stringify({ name: 'An older name', pluginConfig: { 'AreaLoot:radius': 20 } }));
    writeWorld(env, files, (line) => said.push(line));
    assert.deepEqual(JSON.parse(fs.readFileSync(files.local, 'utf8')), { name: 'Kat-Net New York', pluginConfig: { 'AreaLoot:radius': 20 }, experienceMultiplier: 5 });
    assert.deepEqual(JSON.parse(fs.readFileSync(files.state, 'utf8')).worldKeys, ['name', 'experienceMultiplier']);
    assert.deepEqual(fs.readdirSync(base).sort(), ['.egg-state.json', 'world.json', 'world.local.json'], 'nothing left beside them');
    assert.deepEqual(said, []);

    // Cut short (a full disk, a stop in the middle of a write by anything else).
    const half = fs.readFileSync(files.local, 'utf8').slice(0, 40);
    fs.writeFileSync(files.local, half);
    writeWorld(env, files, (line) => said.push(line));
    assert.deepEqual(JSON.parse(fs.readFileSync(files.local, 'utf8')), { name: 'Kat-Net New York', experienceMultiplier: 5 }, 'the world starts, with the egg\'s settings');
    assert.equal(fs.readFileSync(`${files.local}.unreadable`, 'utf8'), half, 'what was there is kept');
    assert.equal(said.length, 1);
    assert.match(said[0], /world\.local\.json could not be read as settings\. It is kept as world\.local\.json\.unreadable/);

    // Not settings at all: the game refuses to start on anything but an object there.
    fs.writeFileSync(files.local, '[]');
    writeWorld(env, files, (line) => said.push(line));
    assert.deepEqual(JSON.parse(fs.readFileSync(files.local, 'utf8')), { name: 'Kat-Net New York', experienceMultiplier: 5 });
    assert.equal(said.length, 2);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the launcher starts a fresh run after an update or a scheduled restart, and ends with any other exit', async () => {
  const { supervise, RELAUNCH_CODE } = await load('launch.mjs');
  const { EventEmitter } = require('node:events');
  const watch = () => {
    const runs = [], exits = [], said = [], signals = {};
    let clock = 0;
    const run = () => { const child = new EventEmitter(); child.killed = []; child.kill = (signal) => child.killed.push(signal); runs.push(child); return child; };
    supervise(run, { log: (line) => said.push(line), exit: (code) => exits.push(code), now: () => clock, onSignal: (signal, handler) => { signals[signal] = handler; } });
    return { runs, exits, said, signals, wait: (ms) => { clock += ms; } };
  };

  const world = watch();
  assert.equal(world.runs.length, 1);
  world.runs[0].emit('exit', RELAUNCH_CODE, null); // the update brought a new version
  assert.equal(world.runs.length, 2, 'the new version starts in a fresh run');
  world.wait(12 * 3600_000);
  world.runs[1].emit('exit', RELAUNCH_CODE, null); // the game stopped for its scheduled restart
  assert.equal(world.runs.length, 3, 'which updates and starts again');
  world.signals.SIGTERM();
  assert.deepEqual(world.runs[2].killed, ['SIGTERM'], 'the panel\'s stop reaches the run, which saves every player');
  world.runs[2].emit('exit', 0, null);
  assert.deepEqual(world.exits, [0]);
  assert.equal(world.runs.length, 3);

  const stopped = watch();
  stopped.signals.SIGINT();
  stopped.runs[0].emit('exit', RELAUNCH_CODE, null);
  assert.equal(stopped.runs.length, 1, 'a stop is not followed by a fresh run');
  assert.deepEqual(stopped.exits, [RELAUNCH_CODE]);

  const crashed = watch();
  crashed.runs[0].emit('exit', 1, null);
  assert.deepEqual(crashed.exits, [1], 'a failure ends the launcher with its code, for the panel to see');
  const killed = watch();
  killed.runs[0].emit('exit', null, 'SIGKILL');
  assert.deepEqual(killed.exits, [1]);

  const looping = watch();
  for (let i = 0; i < 5; i++) looping.runs[i].emit('exit', RELAUNCH_CODE, null);
  assert.equal(looping.runs.length, 5, 'a run asking for another every time is a loop');
  assert.deepEqual(looping.exits, [1]);
  assert.match(looping.said[0], /started afresh 6 times in 10 minutes/);
});
