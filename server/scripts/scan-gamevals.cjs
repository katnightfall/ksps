// Cache names ("gamevals") the code asks for that the cache does not have.
//
// CacheDefinitions.getVarbitId("deadman_mode"), getObjId, getLocId, getNpcId, getSeqId, getSpotanimId,
// getInterfaceId, getComponentId and their like answer null for a name the cache lacks, and these
// names change between cache builds. Two passes: every such call written with a literal name in a
// plugin or the engine (wherever it sits, also in code that only runs when a player gets there), and
// every such call made while the plugins load (names that come from data files).
//
// Usage (after `yarn build`, from server/): node scripts/scan-gamevals.cjs
// tests/plugin-references.test.cjs holds the literal names at its list of known ones. The names asked
// for while loading include deliberate probes (Doors asks for an "_open" twin of every door).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const LOOKUPS = ["getVarbitId", "getVarpId", "getInventoryId", "getLocId", "getNpcId", "getObjId", "getSeqId", "getSpotanimId",
  "getSpriteId", "getComponentId", "getInterfaceId", "getDbTableId", "getDbRowId"];

function walkFiles(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e)) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Records, from now on, every lookup that answers null (or -1): [{ method, name, site }]. */
function recordMisses(CacheDefinitions, serverDir) {
  const misses = [];
  const calls = { count: 0 };
  const originals = {};
  const marker = path.join(serverDir, "plugins") + path.sep;
  for (const method of LOOKUPS) {
    const original = CacheDefinitions[method];
    if (typeof original !== "function") continue;
    originals[method] = original;
    CacheDefinitions[method] = function (name, ...rest) {
      const result = original.call(this, name, ...rest);
      calls.count++;
      if (result === null || result === undefined || result === -1) {
        const frame = new Error().stack.split("\n").slice(2).find((line) => line.includes(marker));
        const m = frame && /[\\/](plugins[\\/].*?):(\d+):\d+\)?$/.exec(frame.trim());
        misses.push({ method, name: String(name), site: m ? m[1].replace(/\\/g, "/") + ":" + m[2] : "engine" });
      }
      return result;
    };
  }
  return { misses, calls, restore: () => { for (const [method, original] of Object.entries(originals)) CacheDefinitions[method] = original; } };
}

/** Every lookup written with a literal name: [{ file, line, method, name, guarded }] for the names the cache lacks. */
function scanLiterals({ serverDir, CacheDefinitions, dirs = ["plugins", "src"], lookup }) {
  const ts = require(path.join(serverDir, "node_modules", "typescript"));
  const findings = [];
  let checked = 0;
  const ask = lookup ?? ((method, name) => CacheDefinitions[method](name));
  for (const dir of dirs) {
    const root = path.join(serverDir, dir);
    if (!fs.existsSync(root)) continue;
    for (const file of walkFiles(root, [".js", ".cjs", ".ts"])) {
      const text = fs.readFileSync(file, "utf8");
      if (!LOOKUPS.some((m) => text.includes(m))) continue;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
      (function visit(node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LOOKUPS.includes(node.expression.name.text) && node.arguments.length >= 1) {
          const arg = node.arguments[0];
          if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
            checked++;
            let result;
            try { result = ask(node.expression.name.text, arg.text); } catch { result = null; }
            if (result === null || result === undefined || result === -1) {
              // `getObjId("x") ?? fallback`, or an `if` over it: the code expects that it may be missing
              let n = node, p = node.parent;
              while (p && ts.isParenthesizedExpression(p)) { n = p; p = p.parent; }
              const guarded = !!p && ((ts.isBinaryExpression(p) && p.left === n && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind))
                || (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)));
              findings.push({ file: path.relative(serverDir, file).replace(/\\/g, "/"), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, method: node.expression.name.text, name: arg.text, guarded });
            }
          }
        }
        ts.forEachChild(node, visit);
      })(sf);
    }
  }
  return { findings, checked };
}

module.exports = { LOOKUPS, recordMisses, scanLiterals };

if (require.main === module) {
  const serverDir = path.resolve(process.argv.find((a) => a.startsWith("--server="))?.slice(9) ?? path.join(__dirname, ".."));
  process.chdir(serverDir);
  process.env.DISABLE_PLAYER_BOTS = "1";
  require(path.join(serverDir, "dist", "Server")).Server.installProductionPathResolver();
  const { PluginManager } = require(path.join(serverDir, "dist", "plugins", "PluginManager"));
  const { CachePipeline } = require(path.join(serverDir, "dist", "game", "cache", "CachePipeline"));
  const { CacheDefinitions } = require(path.join(serverDir, "dist", "game", "cache", "CacheDefinitions"));
  (async () => {
    const log = console.log;
    console.log = console.info = console.debug = () => {};
    await CachePipeline.initialize(serverDir);
    const literal = scanLiterals({ serverDir, CacheDefinitions });
    const recorded = recordMisses(CacheDefinitions, serverDir);
    PluginManager.loadFromDirectory(path.join(serverDir, "plugins"));
    recorded.restore();
    console.log = log;
    for (const f of literal.findings) console.log(`${f.file}:${f.line}  ${f.method}(${JSON.stringify(f.name)}) is not in the cache${f.guarded ? "  (the code allows for that)" : ""}`);
    const seen = new Set(literal.findings.map((f) => f.method + ":" + f.name));
    for (const m of recorded.misses) if (!seen.has(m.method + ":" + m.name)) { seen.add(m.method + ":" + m.name); console.log(`${m.site}  ${m.method}(${JSON.stringify(m.name)}) answered nothing while the plugins loaded`); }
    console.log(JSON.stringify({ literalLookups: literal.checked, literalMissing: literal.findings.length, lookupsAtLoad: recorded.calls.count, missesAtLoad: recorded.misses.length }));
    process.exit(0);
  })().catch((error) => { console.error(error); process.exit(1); });
}
