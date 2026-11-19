// Finds method calls on a tile that is a plain { x, y, z }, not a Location.
//
// The engine hands most hooks their tile as a plain object (PluginObjectInteractionEvent.location and
// its like in PluginTypes.ts), and plugins pass that same object on in custom events (Doors' door:toggle
// goes to about 80 listeners). `location.getZ()` on it throws; hook errors are caught and logged, so
// what a player sees is the handler's rule silently not applying (a gate that should refuse opens).
//
// This follows the plain tiles from every hook that carries one, through local variables, helper
// functions (also in required modules), handler tables and custom events, and reports each method
// call on one that the code around it does not guard (`?.`, a typeof test, `x.getX ? … : …`).
//
// It follows what it can name: a handler handed over through a Map, or kept and called later, is not
// followed, and a tile passed into an engine method is not looked into. Location itself keeps public
// x, y and z, so reading `.x` on a real Location is fine: only the getters on a plain tile break.
//
// Usage (from server/): node scripts/scan-plain-tiles.cjs [--payloads] [--debug] [--source=<server dir>]
// tests/plugin-references.test.cjs holds it at no finding.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** Hook name -> the event fields that are plain tiles (from the engine's emitters, see PluginTypes.ts). */
const TILE = "tile";
const OBJECT_EVENT = { location: TILE, sourceLocation: TILE };
const PLAIN_TILE_HOOKS = {
  onObjectInteraction: OBJECT_EVENT, onBeforeObjectInteraction: OBJECT_EVENT, onObjectClick: OBJECT_EVENT,
  onObjectFirstClick: OBJECT_EVENT, onObjectSecondClick: OBJECT_EVENT, onObjectThirdClick: OBJECT_EVENT,
  onObjectFourthClick: OBJECT_EVENT, onObjectFifthClick: OBJECT_EVENT,
  onObjectRoute: { sourceLocation: TILE, destination: TILE },
  onWalkRoute: { destination: TILE },
  onNpcInteraction: { location: TILE }, onBeforeNpcInteraction: { location: TILE }, onNpcRoute: { location: TILE },
  onNpcsInteraction: { location: TILE }, onAnyNpcInteraction: { location: TILE }, onNpcClick: { location: TILE },
  onNpcFirstClick: { location: TILE }, onNpcSecondClick: { location: TILE }, onNpcThirdClick: { location: TILE },
  onNpcFourthClick: { location: TILE },
  onNpcDeath: { location: TILE },
  onItemOnObject: { location: TILE },
  onSpellOnObject: { location: TILE }, onSpellOnNpc: { location: TILE },
  onItemOnGroundItem: { location: TILE }, onGroundItemClick: { location: TILE }, onGroundItemPickup: { location: TILE },
  onPathBlocked: { from: TILE, to: TILE }, onPlayerPathBlocked: { from: TILE, to: TILE },
};

/** Method names that belong to Map, Set, Array, Promise and console: never a plugin's own function. */
const BUILTIN_METHODS = new Set(["get", "set", "has", "add", "delete", "push", "unshift", "includes", "indexOf", "forEach", "map", "filter",
  "find", "findIndex", "some", "every", "reduce", "concat", "join", "slice", "splice", "sort", "keys", "values", "entries", "then", "catch",
  "log", "info", "warn", "error", "debug", "call", "apply", "bind", "toString", "test", "exec", "match", "replace", "split", "assign", "freeze"]);

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (/\.(js|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function scan({ serverDir, sourceRoot = serverDir, dirs = ["plugins"] }) {
  const ts = require(path.join(serverDir, "node_modules", "typescript"));
  const SK = ts.SyntaxKind;
  const files = new Map(); // absolute path -> info
  const isFn = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
  const strip = (n) => { while (n && ts.isParenthesizedExpression(n)) n = n.expression; return n; };

  const callsByName = new Map(); // simple callee name -> call sites, for callbacks handed to a wrapper
  const all = [];
  for (const dir of dirs) { const full = path.join(sourceRoot, dir); if (fs.existsSync(full)) walkFiles(full, all); }
  for (const sourceFile of all) {
    const file = path.join(serverDir, path.relative(sourceRoot, sourceFile));
    const sf = ts.createSourceFile(file, fs.readFileSync(sourceFile, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const info = { file, rel: path.relative(serverDir, file).replace(/\\/g, "/"), sf, fnByName: new Map(), tables: new Map(), requires: new Map(), imported: new Map(), factories: new Map() };
    const addFn = (name, node) => { if (!info.fnByName.has(name)) info.fnByName.set(name, []); info.fnByName.get(name).push(node); };
    const resolve = (spec) => {
      if (!spec.startsWith(".")) return null;
      const abs = path.resolve(path.dirname(file), spec);
      for (const c of [abs, `${abs}.js`, `${abs}.cjs`, path.join(abs, "index.js")]) if (/\.c?js$/.test(c) && fs.existsSync(path.join(sourceRoot, path.relative(serverDir, c)))) return c;
      return null;
    };
    (function index(node) {
      if (ts.isFunctionDeclaration(node) && node.name) addFn(node.name.text, node);
      else if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = strip(node.initializer);
        if (ts.isIdentifier(node.name)) {
          if (isFn(init)) addFn(node.name.text, init);
          else if (ts.isObjectLiteralExpression(init)) {
            const fns = init.properties.map((p) => (ts.isMethodDeclaration(p) ? p : ts.isPropertyAssignment(p) && isFn(strip(p.initializer)) ? strip(p.initializer) : null)).filter(Boolean);
            if (fns.length) info.tables.set(node.name.text, fns);
          } else if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require" && init.arguments[0] && ts.isStringLiteral(init.arguments[0])) {
            const target = resolve(init.arguments[0].text);
            if (target) info.requires.set(node.name.text, target);
          } else if (ts.isCallExpression(init)) {
            // what a required module's function returned: require("./X")(api), X.create(api), createX(api)
            const callee = strip(init.expression);
            const root = ts.isPropertyAccessExpression(callee) ? strip(callee.expression) : callee;
            let target = null;
            if (ts.isCallExpression(root) && ts.isIdentifier(root.expression) && root.expression.text === "require" && root.arguments[0] && ts.isStringLiteral(root.arguments[0])) target = resolve(root.arguments[0].text);
            else if (ts.isIdentifier(root)) target = info.requires.get(root.text) ?? info.imported.get(root.text)?.file ?? null;
            if (target) info.factories.set(node.name.text, target);
          }
        } else if (ts.isObjectBindingPattern(node.name) && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require" && init.arguments[0] && ts.isStringLiteral(init.arguments[0])) {
          const target = resolve(init.arguments[0].text);
          if (target) for (const el of node.name.elements) if (ts.isIdentifier(el.name)) info.imported.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).getText(sf) });
        }
      } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && isFn(strip(node.initializer))) addFn(node.name.text, strip(node.initializer));
      else if (ts.isMethodDeclaration(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) addFn(node.name.text, node);
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === SK.EqualsToken && ts.isPropertyAccessExpression(node.left) && isFn(strip(node.right))) addFn(node.left.name.text, strip(node.right));
      if (ts.isCallExpression(node)) {
        const callee = strip(node.expression);
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
        if (name) { if (!callsByName.has(name)) callsByName.set(name, []); callsByName.get(name).push({ info, node }); }
      }
      ts.forEachChild(node, index);
    })(sf);
    files.set(file, info);
  }

  const passed = { tiles: new Map(), events: new Map(), tileSites: [] };
  const unresolvedHooks = [];
  const findings = new Map(); // key -> finding
  const stats = { files: files.size, hookHandlers: 0, customEventListeners: 0, functionsFollowed: 0, tileMethodCalls: 0 };
  const payloads = new Map(); // custom event name -> merged fields
  const seen = new Set();
  let payloadsChanged = false;

  // Objects are followed three levels deep (an event inside a payload inside a payload); deeper is cut.
  const valueKey = (v, depth = 0) => (v === TILE ? "T" : v && v.fields && depth < 3 ? "E{" + Object.keys(v.fields).sort().map((k) => k + ":" + valueKey(v.fields[k], depth + 1)).filter((s) => !s.endsWith(":")).join(",") + "}" : "");
  const copyValue = (v, depth = 0) => {
    if (v === TILE) return TILE;
    if (!v || !v.fields || depth >= 3) return undefined;
    const fields = {};
    for (const [k, inner] of Object.entries(v.fields)) { const c = copyValue(inner, depth + 1); if (c) fields[k] = c; }
    return Object.keys(fields).length ? { fields } : undefined;
  };
  const mergeFields = (into, fields, depth = 0) => {
    let changed = false;
    for (const [k, v] of Object.entries(fields)) {
      if (!v) continue;
      if (!into[k]) { const c = copyValue(v, depth + 1); if (c) { into[k] = c; changed = true; } }
      else if (into[k] !== TILE && v !== TILE && v.fields && into[k].fields && depth < 2) changed = mergeFields(into[k].fields, v.fields, depth + 1) || changed;
    }
    return changed;
  };

  function analyze(info, fnNode, paramValues, origin) {
    const key = info.file + ":" + fnNode.pos + ":" + paramValues.map(valueKey).join("|");
    if (!paramValues.some(Boolean) || seen.has(key)) return;
    seen.add(key);
    stats.functionsFollowed++;
    const { sf } = info;
    const env = new Map();
    const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

    const bind = (pattern, value) => {
      if (ts.isIdentifier(pattern)) { if (value) env.set(pattern.text, value); else env.delete(pattern.text); return; }
      if (ts.isObjectBindingPattern(pattern)) {
        for (const el of pattern.elements) {
          if (el.dotDotDotToken) { bind(el.name, value && value.fields ? value : undefined); continue; }
          const prop = el.propertyName ?? el.name;
          const v = value && value.fields && (ts.isIdentifier(prop) || ts.isStringLiteral(prop)) ? value.fields[prop.text] : undefined;
          bind(el.name, v);
        }
      } else if (ts.isArrayBindingPattern(pattern)) {
        for (const el of pattern.elements) if (ts.isBindingElement(el)) bind(el.name, undefined);
      }
    };
    fnNode.parameters.forEach((p, i) => bind(p.name, paramValues[i]));

    const evaluate = (node) => {
      node = strip(node);
      if (!node) return undefined;
      if (ts.isIdentifier(node)) return env.get(node.text);
      if (ts.isPropertyAccessExpression(node)) {
        const base = evaluate(node.expression);
        return base && base.fields ? base.fields[node.name.text] : undefined;
      }
      if (ts.isBinaryExpression(node) && (node.operatorToken.kind === SK.QuestionQuestionToken || node.operatorToken.kind === SK.BarBarToken)) {
        // `event.object?.getLocation?.() ?? event.location`: the left side wins whenever it has a value,
        // and what it is is not known here, so only a known left side (or a literal null) decides.
        const left = strip(node.left);
        if (left.kind === SK.NullKeyword || (ts.isIdentifier(left) && left.text === "undefined")) return evaluate(node.right);
        return evaluate(left);
      }
      if (ts.isObjectLiteralExpression(node)) {
        const names = new Set(node.properties.map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null)));
        if (names.has("x") && names.has("y") && !node.properties.some((p) => ts.isMethodDeclaration(p) || (ts.isPropertyAssignment(p) && isFn(strip(p.initializer))))) return TILE;
        const fields = {};
        for (const p of node.properties) {
          if (ts.isSpreadAssignment(p)) { const v = evaluate(p.expression); if (v && v.fields) Object.assign(fields, v.fields); }
          else if (ts.isShorthandPropertyAssignment(p)) { const v = env.get(p.name.text); if (v) fields[p.name.text] = v; else delete fields[p.name.text]; }
          else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) { const v = evaluate(p.initializer); if (v) fields[p.name.text] = v; else delete fields[p.name.text]; }
        }
        return Object.keys(fields).length ? { fields } : undefined;
      }
      return undefined;
    };

    const guarded = (call, receiverText, method) => {
      if (call.questionDotToken || call.expression.questionDotToken) return true;
      // `location.x ?? location.getX()`: a plain tile answers on the left
      {
        let n = call, p = call.parent;
        while (p && ts.isParenthesizedExpression(p)) { n = p; p = p.parent; }
        if (p && ts.isBinaryExpression(p) && p.right === n && [SK.QuestionQuestionToken, SK.BarBarToken].includes(p.operatorToken.kind)) {
          const left = strip(p.left);
          if (ts.isPropertyAccessExpression(left) && left.expression.getText(sf) === receiverText && /^[xyz]$/.test(left.name.text)) return true;
        }
      }
      const probe = new RegExp("(^|[^\\w$.])" + receiverText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\??\\.\\s*(" + method + "|get[XYZ]|getDistance|equals|clone)\\b(?!\\s*\\()");
      const typed = new RegExp("instanceof|typeof\\s+" + receiverText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\??\\.");
      for (let n = call, p = call.parent; p && p !== fnNode.parent; n = p, p = p.parent) {
        let test;
        if (ts.isConditionalExpression(p) && p.condition !== n) test = p.condition;
        else if (ts.isIfStatement(p) && p.expression !== n) test = p.expression;
        else if (ts.isBinaryExpression(p) && p.right === n && [SK.AmpersandAmpersandToken, SK.BarBarToken].includes(p.operatorToken.kind)) test = p.left;
        if (test) { const text = test.getText(sf); if (probe.test(text) || typed.test(text)) return true; }
      }
      return false;
    };

    const targetsOf = (callee) => {
      callee = strip(callee);
      const out = [];
      const push = (targetInfo, name) => { for (const fn of targetInfo?.fnByName.get(name) ?? []) out.push([targetInfo, fn]); };
      if (ts.isIdentifier(callee)) {
        const imp = info.imported.get(callee.text);
        if (imp) push(files.get(imp.file), imp.name); else push(info, callee.text);
      } else if (ts.isPropertyAccessExpression(callee)) {
        const obj = strip(callee.expression);
        const name = callee.name.text;
        if (name === "call" || name === "apply" || name === "bind") return targetsOf(obj).map((t) => [...t, name]);
        if (ts.isIdentifier(obj) && info.requires.has(obj.text)) push(files.get(info.requires.get(obj.text)), name);
        else if (ts.isCallExpression(obj) && ts.isIdentifier(obj.expression) && obj.expression.text === "require" && obj.arguments[0] && ts.isStringLiteral(obj.arguments[0])) {
          // require("./Other").handle(event)
          const abs = path.resolve(path.dirname(info.file), obj.arguments[0].text);
          push(files.get(abs) ?? files.get(abs + ".js"), name);
        } else if (!BUILTIN_METHODS.has(name) && !(ts.isIdentifier(obj) && env.has(obj.text))) {
          // a method of something made in this file, or of what a required module's factory returned
          // (`const Dream = require("./Dream")(api)`): followed by name in the file that defines it
          if (ts.isIdentifier(obj) && info.factories.has(obj.text)) push(files.get(info.factories.get(obj.text)), name);
          else push(info, name);
        }
      } else if (ts.isElementAccessExpression(callee) && ts.isIdentifier(strip(callee.expression))) {
        for (const fn of info.tables.get(strip(callee.expression).text) ?? []) out.push([info, fn]);
      }
      return out;
    };

    const visit = (node) => {
      if (isFn(node) && node !== fnNode) {
        // a closure: its own parameters and locals shadow the outer names
        const saved = new Map(env);
        for (const p of node.parameters) bind(p.name, undefined);
        ts.forEachChild(node, visit);
        env.clear(); for (const [k, v] of saved) env.set(k, v);
        return;
      }
      if (ts.isVariableDeclaration(node)) {
        if (node.initializer) visit(node.initializer);
        bind(node.name, node.initializer ? evaluate(node.initializer) : undefined);
        return;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === SK.EqualsToken && ts.isIdentifier(node.left)) {
        visit(node.right);
        const v = evaluate(node.right);
        if (v) env.set(node.left.text, v); else env.delete(node.left.text);
        return;
      }
      if (ts.isCallExpression(node)) {
        const callee = strip(node.expression);
        // sink: a method called on a plain tile
        if (ts.isPropertyAccessExpression(callee) && evaluate(callee.expression) === TILE) {
          stats.tileMethodCalls++;
          const method = callee.name.text;
          if (!(method in Object.prototype) && !guarded(node, callee.expression.getText(sf), method)) {
            const k = info.rel + ":" + lineOf(node) + ":" + callee.getText(sf);
            if (!findings.has(k)) findings.set(k, { file: info.rel, line: lineOf(node), text: callee.getText(sf) + "()", origin });
          }
        }
        // a custom event carrying a plain tile on
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "emitCustomEvent" && node.arguments.length >= 2 && ts.isStringLiteral(strip(node.arguments[0]))) {
          const payload = evaluate(node.arguments[1]);
          if (payload && payload.fields) {
            const name = strip(node.arguments[0]).text;
            if (!payloads.has(name)) payloads.set(name, { fields: {}, from: new Set() });
            if (mergeFields(payloads.get(name).fields, payload.fields)) payloadsChanged = true;
            payloads.get(name).from.add(info.rel + ":" + lineOf(node));
          }
        }
        const args = node.arguments.map((a) => (ts.isSpreadElement(a) ? undefined : evaluate(a)));
        if (args.some(Boolean)) {
          for (const [targetInfo, fn, via] of targetsOf(callee)) {
            const shifted = via === "call" || via === "bind" ? args.slice(1) : via === "apply" ? [] : args;
            analyze(targetInfo, fn, shifted, origin);
          }
          // a callback the enclosing wrapper was given: function onObject(api, ids, handler) { ... handler(event) }
          if (ts.isIdentifier(callee) && !targetsOf(callee).length) {
            for (let outer = node.parent; outer; outer = outer.parent) {
              if (!isFn(outer)) continue;
              const index = outer.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === callee.text);
              if (index < 0) continue;
              const wrapperName = outer.name && ts.isIdentifier(outer.name) ? outer.name.text
                : ts.isVariableDeclaration(outer.parent) && ts.isIdentifier(outer.parent.name) ? outer.parent.name.text
                : ts.isPropertyAssignment(outer.parent) && ts.isIdentifier(outer.parent.name) ? outer.parent.name.text : null;
              if (wrapperName && !BUILTIN_METHODS.has(wrapperName)) {
                for (const site of callsByName.get(wrapperName) ?? []) {
                  if (site.node.arguments.length <= index) continue;
                  for (const [target, fn, bound = 0] of functionArgs(site.info, { arguments: [site.node.arguments[index]] })) {
                    const params = []; args.forEach((v, i) => { if (v) params[bound + i] = v; });
                    analyze(target, fn, params, origin);
                  }
                }
              }
              break;
            }
          }
          const targets = targetsOf(callee);
          args.forEach((v, i) => {
            if (!v) return;
            const name = callee.getText(sf).replace(/^.*\.(?=[^.]+\.[^.]+$)/, "");
            if (v === TILE) { passed.tiles.set(name + (targets.length ? " (followed)" : ""), (passed.tiles.get(name + (targets.length ? " (followed)" : "")) ?? 0) + 1); if (!targets.length) passed.tileSites.push(`${info.rel}:${lineOf(node)} ${callee.getText(sf)} #${i}`); }
            else if (!targets.length) passed.events.set(name, (passed.events.get(name) ?? 0) + 1);
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    if (fnNode.body) visit(fnNode.body);
  }

  const functionArgs = (info, node) => {
    const out = [];
    for (const arg of node.arguments) {
      const a = strip(arg);
      if (isFn(a)) out.push([info, a]);
      else if (ts.isObjectLiteralExpression(a)) {
        // the option table of a named interaction: { Open: open, "Pick-lock": (event) => ... }
        for (const p of a.properties) {
          if (ts.isMethodDeclaration(p)) out.push([info, p]);
          else if (ts.isPropertyAssignment(p)) out.push(...functionArgs(info, { arguments: [p.initializer] }));
          else if (ts.isShorthandPropertyAssignment(p)) out.push(...functionArgs(info, { arguments: [p.name] }));
        }
      } else if (ts.isIdentifier(a)) {
        const imp = info.imported.get(a.text);
        const target = imp ? files.get(imp.file) : info;
        for (const fn of target?.fnByName.get(imp ? imp.name : a.text) ?? []) out.push([target, fn]);
        if (!imp) for (const fn of info.tables.get(a.text) ?? []) out.push([info, fn]);
      } else if (ts.isPropertyAccessExpression(a) && ts.isIdentifier(strip(a.expression))) {
        const obj = strip(a.expression).text;
        const target = info.requires.has(obj) ? files.get(info.requires.get(obj)) : info;
        for (const fn of target?.fnByName.get(a.name.text) ?? []) out.push([target, fn]);
      } else if (ts.isCallExpression(a) && ts.isPropertyAccessExpression(a.expression) && a.expression.name.text === "bind") {
        // handler.bind(null, api): the bound arguments come first
        const bound = a.arguments.length - 1;
        for (const [target, fn] of functionArgs(info, { arguments: [a.expression.expression] })) out.push([target, fn, bound]);
      }
    }
    return out;
  };

  // Seeds: every handler given to a hook whose event carries plain tiles.
  const listeners = [];
  for (const info of files.values()) {
    (function find(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const hook = node.expression.name.text;
        if (Object.hasOwn(PLAIN_TILE_HOOKS, hook)) {
          if (!functionArgs(info, node).length) unresolvedHooks.push(`${info.rel}:${info.sf.getLineAndCharacterOfPosition(node.getStart(info.sf)).line + 1} ${node.getText(info.sf).slice(0, 90).replace(/\s+/g, " ")}`);
          for (const [target, fn, bound = 0] of functionArgs(info, node)) {
            stats.hookHandlers++;
            const params = []; params[bound] = { fields: { ...PLAIN_TILE_HOOKS[hook] } };
            analyze(target, fn, params, `${hook} in ${info.rel}`);
          }
        } else if (hook === "onCustomEvent" && node.arguments.length >= 2 && ts.isStringLiteral(strip(node.arguments[0]))) {
          listeners.push({ info, node, name: strip(node.arguments[0]).text });
        }
      }
      ts.forEachChild(node, find);
    })(info.sf);
  }
  stats.customEventListeners = listeners.length;
  for (let round = 0; round < 8; round++) {
    payloadsChanged = false;
    for (const { info, node, name } of listeners) {
      const payload = payloads.get(name);
      if (!payload) continue;
      for (const [target, fn, bound = 0] of functionArgs(info, { arguments: node.arguments.slice(1) })) {
        const params = []; params[bound] = { fields: payload.fields };
        analyze(target, fn, params, `custom event ${name} (sent from ${[...payload.from][0]})`);
      }
    }
    if (!payloadsChanged) break;
  }
  stats.customEventsCarryingTiles = payloads.size;
  return { passed, unresolvedHooks, findings: [...findings.values()].sort((a, b) => (a.file + String(a.line).padStart(6, "0")).localeCompare(b.file + String(b.line).padStart(6, "0"))), stats, payloads: [...payloads].map(([name, p]) => ({ name, fields: valueKey({ fields: p.fields }), from: [...p.from] })) };
}

module.exports = { scan, PLAIN_TILE_HOOKS };

if (require.main === module) {
  const serverDir = path.resolve(process.argv.find((a) => a.startsWith("--server="))?.slice(9) ?? path.join(__dirname, ".."));
  const sourceRoot = process.argv.find((a) => a.startsWith("--source="))?.slice(9);
  const result = scan({ serverDir, sourceRoot: sourceRoot && path.resolve(sourceRoot) });
  for (const f of result.findings) console.log(`${f.file}:${f.line}  ${f.text}   <- ${f.origin}`);
  if (process.argv.includes("--payloads")) for (const p of result.payloads) console.log(`  ${p.name} ${p.fields}  from ${p.from.slice(0, 3).join(", ")}`);
  if (process.argv.includes("--debug")) {
    console.log("unresolved hook registrations:", result.unresolvedHooks.length); for (const u of result.unresolvedHooks) console.log("   " + u);
    console.log("tiles passed to:", [...result.passed.tiles].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join("; "));
    console.log("events passed to (not followed):", [...result.passed.events].sort((a, b) => b[1] - a[1]).slice(0, 150).map(([k, v]) => `${k} x${v}`).join("; "));
    for (const t of result.passed.tileSites) console.log("   tile -> " + t);
  }
  console.log(JSON.stringify(result.stats));
  console.log(`${result.findings.length} method calls on plain tiles`);
}
