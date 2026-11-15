// node --test tests/hiscores.test.cjs
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const Ranking = require('../plugins/world/hiscores/Ranking.Hiscores');

const SKILLS = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing',
    'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Slayer', 'Farming', 'Runecrafting', 'Construction', 'Hunter', 'Sailing'];
const MINING = SKILLS.indexOf('Mining');

/** A save as PlayerSave writes it: every skill at 1 (Hitpoints 10) unless `levels` says otherwise. */
function save(displayName, levels = {}, attributes = {}, extra = {}) {
    const maxLevel = SKILLS.map((name) => levels[name]?.[0] ?? (name === 'Hitpoints' ? 10 : 1));
    const experience = SKILLS.map((name) => levels[name]?.[1] ?? (name === 'Hitpoints' ? 1154 : 0));
    return { displayName, rights: { id: 0 }, skills: { level: [...maxLevel], maxLevel, experience }, attributes, ...extra };
}
const entry = (key, ...rest) => Ranking.entryFromSave(key, save(...rest), SKILLS.length, new Set(['clever bot']));

test('an entry carries what the tables rank by', () => {
    const kat = entry('kat', 'Kat', { Mining: [50, 101_333], Attack: [60, 273_742], Strength: [60, 273_742] }, {
        'ironman:mode': 'ironman', 'pvp:player-kills': 3, 'quest.points': 12, 'treasure-trails:easy-completed': 2, 'treasure-trails:hard-completed': 1,
        'account-summary:play-time': 2.5 * 3_600_000,
        'combat-achievements:kills': { __type: 'Map', entries: [['Zulrah', 41], ['Goblin', 7], ['1234', 9], ['Nothing', 0]] },
    });
    assert.equal(kat.name, 'Kat');
    assert.equal(kat.mode, 'ironman');
    assert.equal(kat.levels[MINING], 50);
    assert.equal(kat.totalLevel, 20 + 10 + 50 + 60 + 60, 'twenty skills at 1, Hitpoints at 10, and the three trained');
    assert.equal(kat.totalXp, 1154 + 101_333 + 273_742 * 2);
    assert.equal(kat.combat, Ranking.combatLevel(kat.levels));
    assert.deepEqual(kat.activities, { 'pvp-kills': 3, 'quest-points': 12, 'clue-scrolls': 3, 'time-played': 2 });
    assert.deepEqual(kat.kills, { Zulrah: 41, Goblin: 7 }, 'a Map as saved; ids from old saves and zeroes are left out');
    assert.deepEqual(entry('old', 'Old', {}, { 'combat-achievements:kills': { Zulrah: 2 } }).kills, { Zulrah: 2 }, 'a plain object too');
});

test('the combat level is the game\'s', () => {
    const levels = SKILLS.map(() => 99);
    assert.equal(Ranking.combatLevel(levels), 126);
    assert.equal(Ranking.combatLevel(SKILLS.map((name) => (name === 'Hitpoints' ? 10 : 1))), 3);
});

test('bots, other worlds\' characters, stubs and broken saves are not ranked', () => {
    assert.equal(entry('league:kat', 'Kat'), null);
    assert.equal(entry('hardcore:kat', 'Kat'), null);
    assert.equal(entry('playerbot7', 'PlayerBot7'), null);
    assert.equal(entry('sitebot1204', 'SiteBot1204'), null, 'a levelling site bot');
    assert.equal(Ranking.isBotName('sitebot3'), true);
    assert.equal(Ranking.isBotName('kat'), false);
    assert.equal(entry('clever_bot', 'Clever Bot'), null, 'on the AI roster');
    assert.equal(Ranking.entryFromSave('gone', save('Gone', {}, {}, { unmade: true }), SKILLS.length), null);
    assert.equal(Ranking.entryFromSave('short', { displayName: 'Short', skills: { maxLevel: [1], experience: [0] } }, SKILLS.length), null);
    assert.equal(Ranking.entryFromSave('none', null, SKILLS.length), null);
    assert.equal(entry('kat', 'Kat', {}, { 'ironman:mode': 'nonsense' }).mode, 'regular');
});

const players = [
    entry('ann', 'Ann', { Mining: [70, 737_627] }, { 'quest.points': 5 }),
    entry('bob', 'Bob', { Mining: [70, 800_000], Attack: [40, 37_224] }, { 'ironman:mode': 'ironman', 'combat-achievements:kills': { Zulrah: 3 } }),
    entry('cat', 'Cat', { Mining: [99, 13_034_431] }, { 'ironman:mode': 'hardcore', 'ironman:hardcore-dead': 1700000000000, 'combat-achievements:kills': { Zulrah: 10, Goblin: 1 } }),
    entry('dan', 'Dan', {}, {}),
    ...Array.from({ length: 30 }, (_, i) => entry(`p${i}`, `P${String(i).padStart(2, '0')}`, { Mining: [10, 1200 + i] })),
];
const board = Ranking.buildBoard(players, SKILLS);

test('tables: overall by total level then total xp, a skill by xp, with names settling ties', () => {
    const overall = Ranking.page(board, 'skill:overall');
    assert.deepEqual(overall.rows.slice(0, 3).map((row) => [row.rank, row.name, row.level]), [[1, 'Bob', 141], [2, 'Cat', 131], [3, 'Ann', 102]]);
    const mining = Ranking.page(board, 'skill:mining');
    assert.deepEqual(mining.rows.slice(0, 3).map((row) => [row.rank, row.name, row.level, row.score]),
        [[1, 'Cat', 99, 13_034_431], [2, 'Bob', 70, 800_000], [3, 'Ann', 70, 737_627]]);
    assert.equal(mining.total, 33, 'Dan has no Mining xp, so no Mining rank');
    assert.equal(Ranking.page(board, 'skill:overall').total, 34);
    assert.equal(Ranking.page(board, 'skill:nonsense'), undefined);
});

test('pages hold 25 rows; find opens the page a player is on', () => {
    const first = Ranking.page(board, 'skill:mining');
    assert.equal(first.rows.length, Ranking.PAGE_SIZE);
    assert.equal(first.pages, 2);
    const second = Ranking.page(board, 'skill:mining', { page: 2 });
    assert.equal(second.rows[0].rank, 26);
    assert.equal(second.rows.length, 8);
    assert.equal(Ranking.page(board, 'skill:mining', { page: 99 }).page, 2, 'past the end is the last page');
    assert.equal(Ranking.page(board, 'skill:mining', { page: 'x' }).page, 1);
    const found = Ranking.page(board, 'skill:mining', { find: 'p00' });
    assert.equal(found.page, 2);
    assert.ok(found.rows.some((row) => row.name === 'P00'));
    assert.equal(Ranking.page(board, 'skill:mining', { find: 'nobody' }).page, 1);
});

test('a mode\'s table ranks that mode\'s players among themselves', () => {
    const ironmen = Ranking.page(board, 'skill:mining', { mode: 'ironman' });
    assert.deepEqual(ironmen.rows.map((row) => [row.rank, row.name]), [[1, 'Bob']]);
    const hardcore = Ranking.page(board, 'skill:mining', { mode: 'hardcore' });
    assert.deepEqual(hardcore.rows.map((row) => [row.rank, row.name, row.dead]), [[1, 'Cat', true]]);
    assert.equal(Ranking.page(board, 'skill:mining', { mode: 'regular' }).total, 31);
    assert.equal(Ranking.page(board, 'skill:mining', { mode: 'nonsense' }), undefined);
});

test('activities and monster kills are tables too', () => {
    assert.deepEqual(Ranking.page(board, 'activity:quest-points').rows.map((row) => [row.rank, row.name, row.level, row.score]), [[1, 'Ann', null, 5]]);
    assert.deepEqual(board.monsters, ['Zulrah', 'Goblin'], 'most killed first');
    assert.deepEqual(Ranking.page(board, 'kills:zulrah').rows.map((row) => [row.rank, row.name, row.score]), [[1, 'Cat', 10], [2, 'Bob', 3]]);
    assert.equal(Ranking.page(board, 'kills:dragon'), undefined);
});

test('a profile lists every skill with its rank', () => {
    const cat = Ranking.profile(board, 'CAT', new Set(['cat']));
    assert.equal(cat.name, 'Cat');
    assert.equal(cat.online, true);
    assert.deepEqual(cat.overall, { rank: 2, level: 131, score: 13_034_431 + 1154 });
    assert.deepEqual(cat.skills[MINING], { name: 'Mining', rank: 1, level: 99, score: 13_034_431 });
    assert.equal(cat.skills[0].rank, null, 'no Attack xp, no Attack rank');
    assert.deepEqual(cat.kills, [{ name: 'Zulrah', rank: 1, score: 10 }, { name: 'Goblin', rank: 1, score: 1 }]);
    assert.equal(Ranking.profile(board, 'nobody'), undefined);
});

test('the plugin reads the save database, serves the tables and shows ::hiscores', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hiscores-'));
    const database = path.join(directory, 'players.sqlite');
    const db = new DatabaseSync(database);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE player_saves (username TEXT PRIMARY KEY, save_json TEXT NOT NULL, updated_at TEXT NOT NULL)');
    const put = db.prepare('INSERT INTO player_saves VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET save_json = excluded.save_json, updated_at = excluded.updated_at');
    put.run('kat', JSON.stringify(save('Kat', { Mining: [50, 101_333] })), '2026-11-15T00:00:00.000Z');
    put.run('sam', JSON.stringify(save('Sam', { Mining: [60, 273_742] })), '2026-11-15T00:00:00.000Z');
    put.run('league:kat', JSON.stringify(save('Kat', { Mining: [99, 13_034_431] })), '2026-11-15T00:00:00.000Z');
    put.run('playerbot1', JSON.stringify(save('PlayerBot1', { Mining: [99, 13_034_431] })), '2026-11-15T00:00:00.000Z');
    put.run('broken', '{not json', '2026-11-15T00:00:00.000Z');
    const before = process.env.PLAYER_SAVE_DATABASE_PATH;
    process.env.PLAYER_SAVE_DATABASE_PATH = database;
    try {
        const plugin = require('../plugins/world/Hiscores.plugin');
        const online = [{ getUsername: () => 'Kat', isPlayerBot: () => false }, { getUsername: () => 'DevBot1', isPlayerBot: () => true }];
        const registered = { commands: [] };
        plugin.register({
            core: {
                Skill: { values: () => SKILLS.map((name) => ({ getName: () => name })) },
                World: { getPlayers: () => online, isPlayerSessionConnected: () => true },
                PlayerRights: { NONE: 0 },
                WorldDefinition: { getWorldDefinition: () => ({ name: 'Test World' }) },
            },
            registerContentEndpoint: (name, handler) => { registered.endpoint = [name, handler]; },
            registerCommand: (name) => registered.commands.push(name),
        });
        assert.equal(registered.endpoint[0], 'hiscores');
        assert.deepEqual(registered.commands, ['hiscores', 'highscores']);
        const get = (search, segments = []) => plugin._test.hiscores(new URLSearchParams(search), segments);

        const meta = get('');
        assert.equal(meta.world, 'Test World');
        assert.equal(meta.players, 2, 'the league character, the bot and the unreadable save are left out');
        assert.equal(meta.online, 1, 'bots are not counted as online');
        assert.equal(meta.skills.length, SKILLS.length);
        assert.ok(meta.skills[0].icon.startsWith('data:image/png'), 'skill icons come along');
        assert.deepEqual(meta.modes.map((mode) => mode.key), ['regular', 'ironman', 'hardcore', 'ultimate']);
        assert.equal(get('', ['extra']), undefined, 'no sub-paths');
        assert.equal(get('view=nonsense'), undefined);

        const mining = get('view=skill&name=Mining');
        assert.deepEqual(mining.rows.map((row) => [row.rank, row.name, row.level, row.online]), [[1, 'Sam', 60, false], [2, 'Kat', 50, true]]);
        assert.equal(get('view=skill').table, 'skill:overall', 'overall when no skill is named');
        assert.equal(get('view=player&name=kat').skills[MINING].rank, 2);
        assert.equal(get('view=player&name=nobody'), undefined);

        // A newer save moves the player once the tables are read again; an unchanged row is not parsed again.
        put.run('kat', JSON.stringify(save('Kat', { Mining: [70, 737_627] })), '2026-11-15T00:10:00.000Z');
        assert.equal(get('view=skill&name=mining').rows[0].name, 'Sam', 'still the tables read a moment ago');
        plugin._test.currentBoard(Date.now() + 60_000);
        assert.deepEqual(get('view=skill&name=mining').rows.map((row) => row.name), ['Kat', 'Sam']);
        db.prepare('DELETE FROM player_saves WHERE username = ?').run('sam');
        plugin._test.currentBoard(Date.now() + 120_000);
        assert.equal(get('').players, 1, 'a deleted save leaves the tables');

        // ::hiscores mining, in the journal scroll.
        const sent = [];
        const sender = new Proxy({}, { get: (_, method) => (...args) => { if (method === 'sendString') sent.push(args[0]); return sender; } });
        const player = { getUsername: () => 'Kat', getPacketSender: () => sender, sendMessage: (text) => sent.push(`message: ${text}`) };
        assert.equal(plugin._test.showHiscores({ player, parts: ['hiscores', 'min'] }), true);
        assert.ok(sent[0].includes('Hiscores: Mining'));
        assert.ok(sent[1].includes('1. Kat - level 70 (737,627 xp)'));
        assert.ok(sent.some((line) => line.includes('Your rank: 1 of 1')));
        sent.length = 0;
        plugin._test.showHiscores({ player, parts: ['hiscores', 'nonsense'] });
        assert.deepEqual(sent, ['message: There is no skill called "nonsense". Try ::hiscores, or ::hiscores mining.']);
    } finally {
        if (before === undefined) delete process.env.PLAYER_SAVE_DATABASE_PATH;
        else process.env.PLAYER_SAVE_DATABASE_PATH = before;
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
