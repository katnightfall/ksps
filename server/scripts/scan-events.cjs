// Custom events: every name sent (emitCustomEvent) and every name listened for (onCustomEvent), in
// the plugins and in the engine. A name listened for that nothing sends is a rule that never runs; a
// name sent that nothing hears is either an open extension point or a misspelt one.
//
// Most one-sided names are deliberate: a plugin answers a question nobody asks yet, or a deed is
// announced for the league task tables (modes/data/*.json name their events, and helpers pass names
// on in variables, which this does not follow). What it is for is the misspelling: a name listened
// for that nothing sends and that sits one or two letters from a name that is sent.
//
// Usage (from server/): node scripts/scan-events.cjs [--unresolved]
// tests/plugin-references.test.cjs holds the near-misses at its list of known ones.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function walkFiles(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e)) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function scan({ serverDir }) {
  const ts = require(path.join(serverDir, "node_modules", "typescript"));
  const emitted = new Map(); // name -> [site]
  const heard = new Map();
  const unresolved = [];
  const add = (map, name, site) => { if (!map.has(name)) map.set(name, []); map.get(name).push(site); };
  const files = [
    ...walkFiles(path.join(serverDir, "plugins"), [".js", ".cjs"]),
    ...walkFiles(path.join(serverDir, "src"), [".ts"]),
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (!/emitCustomEvent|onCustomEvent|CustomEvent/.test(text)) continue;
    const rel = path.relative(serverDir, file).replace(/\\/g, "/");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    // string constants of the file: const NAME = "a:b"; const EVENTS = { open: "a:b" }
    const constants = new Map();
    const objects = new Map();
    (function collect(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let init = node.initializer;
        while (ts.isParenthesizedExpression(init) || ts.isAsExpression?.(init)) init = init.expression;
        if (ts.isCallExpression(init) && init.expression.getText(sf) === "Object.freeze" && init.arguments[0]) init = init.arguments[0];
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) constants.set(node.name.text, init.text);
        else if (ts.isObjectLiteralExpression(init)) {
          const fields = new Map();
          for (const p of init.properties) if (ts.isPropertyAssignment(p) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && ts.isStringLiteral(p.initializer)) fields.set(p.name.text, p.initializer.text);
          if (fields.size) objects.set(node.name.text, fields);
        }
      } else if (ts.isPropertyDeclaration?.(node) && node.initializer && ts.isStringLiteral(node.initializer) && ts.isIdentifier(node.name)) {
        constants.set(node.name.text, node.initializer.text);
      }
      ts.forEachChild(node, collect);
    })(sf);
    const nameOf = (arg) => {
      while (ts.isParenthesizedExpression(arg) || ts.isAsExpression?.(arg)) arg = arg.expression;
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return [arg.text];
      if (ts.isIdentifier(arg) && constants.has(arg.text)) return [constants.get(arg.text)];
      if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression) && objects.get(arg.expression.text)?.has(arg.name.text)) return [objects.get(arg.expression.text).get(arg.name.text)];
      if (ts.isPropertyAccessExpression(arg) && constants.has(arg.name.text) && /^[A-Z]/.test(arg.expression.getText(sf))) return [constants.get(arg.name.text)];
      if (ts.isConditionalExpression(arg)) { const a = nameOf(arg.whenTrue), b = nameOf(arg.whenFalse); return a && b ? [...a, ...b] : null; }
      if (ts.isTemplateExpression(arg)) return ["~" + arg.head.text + arg.templateSpans.map((s) => "*" + s.literal.text).join("")];
      return null;
    };
    (function visit(node) {
      if (ts.isCallExpression(node)) {
        let callee = node.expression;
        const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null;
        if ((method === "emitCustomEvent" || method === "onCustomEvent" || method === "hasCustomEventListener" || method === "emitCustomEventUntil") && node.arguments.length) {
          const names = nameOf(node.arguments[0]);
          const site = `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
          if (!names) unresolved.push({ site, method, text: node.arguments[0].getText(sf).slice(0, 80) });
          else for (const name of names) add(method === "onCustomEvent" ? heard : emitted, name, site);
        }
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
  return { emitted, heard, unresolved };
}

function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** Names listened for that nothing sends, each with the sent names it could be a misspelling of. */
function nearMisses({ emitted, heard }) {
  const squash = (name) => name.replace(/[-_:]/g, "").toLowerCase();
  const patterns = [...emitted.keys()].filter((n) => n.startsWith("~"))
    .map((n) => new RegExp("^" + n.slice(1).split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+") + "$"));
  const out = [];
  for (const name of heard.keys()) {
    if (name.startsWith("~") || emitted.has(name) || patterns.some((p) => p.test(name))) continue;
    const near = [...emitted.keys()].filter((o) => !o.startsWith("~") && (levenshtein(name, o) <= 2 || squash(name) === squash(o)));
    if (near.length) out.push({ name, near, sites: heard.get(name) });
  }
  return out;
}

module.exports = { scan, levenshtein, nearMisses };

if (require.main === module) {
  const serverDir = path.resolve(process.argv.find((a) => a.startsWith("--server="))?.slice(9) ?? path.join(__dirname, ".."));
  const { emitted, heard, unresolved } = scan({ serverDir });
  const patterns = (map) => [...map.keys()].filter((n) => n.startsWith("~")).map((n) => new RegExp("^" + n.slice(1).split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+") + "$"));
  const emittedPatterns = patterns(emitted), heardPatterns = patterns(heard);
  const neverSent = [...heard.keys()].filter((n) => !n.startsWith("~") && !emitted.has(n) && !emittedPatterns.some((p) => p.test(n)));
  const neverHeard = [...emitted.keys()].filter((n) => !n.startsWith("~") && !heard.has(n) && !heardPatterns.some((p) => p.test(n)));
  const near = (name, others) => others.filter((o) => o !== name && !o.startsWith("~") && (levenshtein(name, o) <= 2 || name.replace(/[-_:]/g, "").toLowerCase() === o.replace(/[-_:]/g, "").toLowerCase())).slice(0, 3);
  console.log(`names sent: ${emitted.size}, names listened for: ${heard.size}, calls whose name is not a constant: ${unresolved.length}`);
  console.log(`\nLISTENED FOR, NEVER SENT (${neverSent.length})`);
  for (const n of neverSent.sort()) {
    const close = near(n, [...emitted.keys()]);
    console.log(`  ${n}  <- ${heard.get(n).slice(0, 3).join(", ")}${heard.get(n).length > 3 ? ` (+${heard.get(n).length - 3})` : ""}${close.length ? `   NEAR SENT: ${close.join(", ")}` : ""}`);
  }
  console.log(`\nSENT, NEVER LISTENED FOR (${neverHeard.length})`);
  for (const n of neverHeard.sort()) {
    const close = near(n, [...heard.keys()]);
    console.log(`  ${n}  <- ${emitted.get(n).slice(0, 2).join(", ")}${close.length ? `   NEAR HEARD: ${close.join(", ")}` : ""}`);
  }
  if (process.argv.includes("--unresolved")) { console.log("\nUNRESOLVED"); for (const u of unresolved) console.log(`  ${u.site} ${u.method}(${u.text}`); }
}
