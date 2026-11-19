// Finds names read from a known object that the object does not have: `ItemIdentifiers.GONE`,
// `core.Skill.TYPO`, `Shared.noSuchFunction()`, `api.noSuchMethod()`, however the plugin reached the
// object (api.core, a destructured alias, a helper that returns it, a require).
//
// Plugins are plain JavaScript: a wrong name is `undefined` at the moment a player uses it, with no
// compiler to say so. This reads every script as a syntax tree, follows each name to the real object
// it stands for (the engine's own classes, as loaded in this process), and reports the reads that
// miss. It follows values, not types: what it cannot follow it leaves alone.
//
// A read the code around it allows to miss (`X.NAME ?? 29873`, `typeof X.fn === "function"`, an
// `if` over it) is marked guarded. A lookup by a computed name (`ItemIdentifiers[name]`) is checked
// when the names are a literal list in the same file or the argument of a small lookup helper;
// names that come from data files are not followed.
//
// Usage (after `yarn build`, from server/): node scripts/scan-member-refs.cjs [--json] [--all] [--light]
// As a module: scan({ serverDir, core, api, moduleExports }) -> { findings, stats, dynamic }
// tests/plugin-references.test.cjs holds it at no unguarded finding.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const IDENTIFIER_CLASSES = ["ItemIdentifiers", "NpcIdentifiers", "ObjectIdentifiers", "ShopIdentifiers", "ItemIds"];
const ARRAY_CALLBACKS = new Set(["map", "forEach", "filter", "some", "every", "find", "flatMap", "findIndex"]);

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (/\.(js|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} options.serverDir the server folder
 * @param {object} options.core the engine's api.core object (PluginManager.getCoreApi())
 * @param {object} [options.api] a plugin api object (PluginManager.createApi("x")); api.<name> reads are checked when given
 * @param {(file: string) => object|undefined} [options.moduleExports] the loaded exports of a plugin module, if known
 * @param {string[]} [options.dirs] folders to scan, relative to serverDir
 */
function scan(options) {
  const ts = require(path.join(options.serverDir, "node_modules", "typescript"));
  const SK = ts.SyntaxKind;
  const serverDir = options.serverDir;
  const srcRoot = path.join(serverDir, "src", "main", "typescript", "elvarg");
  const distRoot = path.join(serverDir, "dist");
  const core = options.core;
  const CORE = { kind: "core" };
  const API = { kind: "api" };
  const objValues = new Map();
  const objValue = (value, label, origin) => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return { kind: "prim", value };
    let v = objValues.get(value);
    if (!v) { v = { kind: "obj", value, label, origin }; objValues.set(value, v); }
    return v;
  };
  for (const name of Object.keys(core)) objValue(core[name], name, "core");
  const identifierObjects = new Set(IDENTIFIER_CLASSES.map((n) => core[n]).filter(Boolean));

  const findings = [];
  const stats = { files: 0, identifierReads: 0, coreMemberReads: 0, coreNameReads: 0, moduleMemberReads: 0, apiReads: 0, dynamicLookups: 0, stringLookups: 0 };
  const dynamic = [];

  const files = [];
  // sourceRoot: read the scripts from another tree (an older checkout) as if they sat in serverDir.
  const sourceRoot = options.sourceRoot ?? serverDir;
  for (const dir of options.dirs ?? ["plugins", "data"]) {
    const full = path.join(sourceRoot, dir);
    if (fs.existsSync(full)) walkFiles(full, files);
  }

  for (const sourceFile of files) {
    const file = path.join(serverDir, path.relative(sourceRoot, sourceFile));
    const text = fs.readFileSync(sourceFile, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    stats.files++;
    scanFile(file, sf);
  }
  return { findings, stats, dynamic };

  function scanFile(file, sf) {
    const rel = path.relative(serverDir, file).replace(/\\/g, "/");
    const scopes = new Map(); // scope node -> Map(name -> entry)
    const scopeOf = (node) => {
      let s = scopes.get(node);
      if (!s) { s = new Map(); scopes.set(node, s); }
      return s;
    };
    const isFunctionNode = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
      || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
    const isScopeNode = (n) => ts.isSourceFile(n) || isFunctionNode(n) || ts.isBlock(n) || ts.isForStatement(n) || ts.isForOfStatement(n)
      || ts.isForInStatement(n) || ts.isCatchClause(n) || ts.isCaseBlock(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n);
    const enclosingScope = (node, functionLevel) => {
      for (let n = node.parent; n; n = n.parent) {
        if (functionLevel ? (ts.isSourceFile(n) || isFunctionNode(n)) : isScopeNode(n)) return n;
      }
      return sf;
    };
    const declare = (scopeNode, name, init) => {
      const s = scopeOf(scopeNode);
      let e = s.get(name);
      if (!e) { e = { name, writes: new Map(), value: undefined, param: false }; s.set(name, e); }
      if (init) Object.assign(e, init);
      return e;
    };
    const bindingNames = (pattern, out = []) => {
      if (ts.isIdentifier(pattern)) out.push(pattern.text);
      else if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
        for (const el of pattern.elements) if (ts.isBindingElement(el)) bindingNames(el.name, out);
      }
      return out;
    };

    // Pass 0: declare every name in its scope, so shadowing is respected.
    (function declareAll(node) {
      if (ts.isVariableDeclaration(node)) {
        const list = node.parent;
        const blockScoped = ts.isVariableDeclarationList(list) && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
        const scopeNode = enclosingScope(ts.isCatchClause(node.parent) ? node : list, !blockScoped && !ts.isCatchClause(node.parent));
        for (const name of bindingNames(node.name)) declare(ts.isCatchClause(node.parent) ? node.parent : scopeNode, name);
      } else if (ts.isParameter(node)) {
        for (const name of bindingNames(node.name)) declare(node.parent, name, { param: true });
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        declare(enclosingScope(node, false), node.name.text, { fn: node });
      } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
        declare(node, node.name.text, ts.isFunctionExpression(node) ? { fn: node } : undefined);
      } else if (ts.isClassDeclaration(node) && node.name) {
        declare(enclosingScope(node, false), node.name.text);
      } else if (ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
        if (node.name) declare(sf, node.name.text);
      }
      ts.forEachChild(node, declareAll);
    })(sf);

    // A value taken for api.core by its name alone (`something.core`, a parameter called core) may be
    // something else (the Wardens' core is an NPC): its misses count only once one of its reads hits.
    const candidates = new Map();
    const candidate = (key) => {
      let c = candidates.get(key);
      if (!c) { c = { kind: "core", hits: 0, pending: [] }; candidates.set(key, c); }
      return c;
    };
    const sameValue = (a, b) => a === b || (a && b && a.kind === "core" && b.kind === "core");
    const lookup = (identifier) => {
      const name = identifier.text;
      for (let n = identifier.parent; n; n = n.parent) {
        const s = scopes.get(n);
        if (s && s.has(name)) return s.get(name);
      }
      return undefined;
    };
    const entryValue = (e) => {
      if (e.fn) return { kind: "fn", node: e.fn };
      let value;
      let seen = false;
      for (const v of e.writes.values()) {
        if (v === null) continue; // `= null` / no initialiser
        if (v === undefined) return undefined;
        if (seen && !sameValue(v, value)) return undefined;
        value = v; seen = true;
      }
      if (seen) return value;
      if (e.param && e.writes.size === 0) {
        if (e.name === "core") return candidate(e);
        if (e.name === "api" || e.name === "pluginApi") return API;
      }
      return undefined;
    };

    let changed = false;
    let collecting = false;
    const write = (entry, node, value) => {
      if (!entry) return;
      if (!entry.writes.has(node) || entry.writes.get(node) !== value) { entry.writes.set(node, value); changed = true; }
    };

    const fnReturnCache = new Map();
    const fnReturn = (fnNode) => {
      if (fnReturnCache.has(fnNode)) return fnReturnCache.get(fnNode);
      fnReturnCache.set(fnNode, undefined); // recursion guard
      let result;
      if (!fnNode.body) result = undefined;
      else if (!ts.isBlock(fnNode.body)) result = evaluate(fnNode.body, true);
      else {
        const returns = [];
        (function collect(n) {
          if (isFunctionNode(n)) return;
          if (ts.isReturnStatement(n)) { returns.push(n); return; }
          ts.forEachChild(n, collect);
        })(fnNode.body);
        let seen = false;
        for (const r of returns) {
          const v = r.expression ? evaluate(r.expression, true) : null;
          if (v === null) continue;
          if (v === undefined || v.kind === "prim" || (seen && !sameValue(v, result))) { result = undefined; seen = false; break; }
          result = v; seen = true;
        }
        if (!seen) result = undefined;
      }
      // A helper that looks its argument up in an identifier class: (name) => ItemIdentifiers[name]
      if (result === undefined && fnNode.parameters.length >= 1 && ts.isIdentifier(fnNode.parameters[0].name)) {
        const param = fnNode.parameters[0].name.text;
        let target;
        (function find(n) {
          if (target || (n !== fnNode && isFunctionNode(n))) return;
          if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.argumentExpression) && n.argumentExpression.text === param) {
            const base = evaluate(n.expression, true);
            if (base && base.kind === "obj" && identifierObjects.has(base.value)) { target = base; return; }
          }
          ts.forEachChild(n, find);
        })(fnNode.body);
        if (target) result = { kind: "lookup", target };
      }
      fnReturnCache.set(fnNode, result);
      return result;
    };

    const stripParens = (n) => { while (n && (ts.isParenthesizedExpression(n) || ts.isNonNullExpression?.(n))) n = n.expression; return n; };

    /** Is a missing read here tolerated by the code around it (`?? fallback`, `typeof`, a test)? */
    const guarded = (node) => {
      let n = node;
      let p = n.parent;
      while (p && ts.isParenthesizedExpression(p)) { n = p; p = p.parent; }
      if (!p) return false;
      if (ts.isBinaryExpression(p)) {
        const op = p.operatorToken.kind;
        if ((op === SK.QuestionQuestionToken || op === SK.BarBarToken || op === SK.AmpersandAmpersandToken) && p.left === n) return true;
        if ([SK.EqualsEqualsEqualsToken, SK.ExclamationEqualsEqualsToken, SK.EqualsEqualsToken, SK.ExclamationEqualsToken].includes(op)) {
          const other = stripParens(p.left === n ? p.right : p.left);
          if (other.kind === SK.NullKeyword || (ts.isIdentifier(other) && other.text === "undefined") || (ts.isStringLiteral(other) && ["function", "undefined", "number", "object"].includes(other.text))) return true;
        }
        if (op === SK.InKeyword) return true;
      }
      if (ts.isTypeOfExpression(p)) return true;
      if (ts.isPrefixUnaryExpression(p) && p.operator === SK.ExclamationToken) return true;
      if ((ts.isIfStatement(p) || ts.isConditionalExpression(p)) && (p.expression === n || p.condition === n)) return true;
      if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === n && p.questionDotToken) return true;
      if (ts.isCallExpression(p) && p.arguments.includes(n) && ts.isPropertyAccessExpression(p.expression)
        && ["isInteger", "isFinite"].includes(p.expression.name.text)) return true;
      return false;
    };
    const isWriteTarget = (node) => {
      const p = node.parent;
      if (ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind >= SK.FirstAssignment && p.operatorToken.kind <= SK.LastAssignment) return true;
      if (ts.isDeleteExpression(p)) return true;
      return false;
    };
    const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const report = (node, kind, base, name, extra, into = findings) => {
      if (!collecting) return;
      into.push({ file: rel, line: lineOf(node), kind, base, name, guarded: guarded(node), text: node.getText(sf).slice(0, 120), ...extra });
    };
    const has = (value, name) => {
      try { return name in value; } catch { return true; }
    };

    const member = (baseValue, name, node, quiet) => {
      if (!baseValue) return undefined;
      if (baseValue === API) {
        if (name === "core") return CORE;
        if (options.api) {
          if (!quiet && collecting) stats.apiReads++;
          if (!has(options.api, name)) { if (!quiet && !isWriteTarget(node)) report(node, "api-member", "api", name); return undefined; }
        }
        return undefined;
      }
      if (baseValue.kind === "core") {
        if (!quiet && collecting) stats.coreNameReads++;
        if (!has(core, name)) {
          if (!quiet && !isWriteTarget(node)) report(node, "core-name", "core", name, undefined, baseValue === CORE ? findings : baseValue.pending);
          return undefined;
        }
        if (!quiet && collecting && baseValue !== CORE) baseValue.hits++;
        return objValue(core[name], name, "core");
      }
      if (baseValue.kind === "obj") {
        const isIdent = identifierObjects.has(baseValue.value);
        if (!quiet && collecting) {
          if (isIdent) stats.identifierReads++;
          else if (baseValue.origin === "core") stats.coreMemberReads++;
          else stats.moduleMemberReads++;
        }
        if (!has(baseValue.value, name)) {
          if (!quiet && !isWriteTarget(node) && baseValue.checkable !== false) {
            report(node, isIdent ? "identifier" : baseValue.origin === "core" ? "core-member" : "module-member", baseValue.label, name);
          }
          return undefined;
        }
        let v;
        try { v = baseValue.value[name]; } catch { return undefined; }
        // Only classes, enums and module exports are closed sets of names; what hangs off them (state
        // objects, instances, maps) is followed no further unless it is one of those itself.
        if (v !== null && (typeof v === "function" || typeof v === "object")) {
          if (v === core) return CORE;
          if (typeof v === "object" && !Array.isArray(v)) { try { if (v.core === core && typeof v.onCustomEvent === "function") return API; } catch { /* a getter that throws */ } }
          const known = objValues.get(v);
          if (known) return known;
          if (typeof v === "function" && /^class\s/.test(Function.prototype.toString.call(v))) return objValue(v, `${baseValue.label}.${name}`, baseValue.origin);
          if (baseValue.origin === "core" && typeof v === "object" && Object.isFrozen(v)) return objValue(v, `${baseValue.label}.${name}`, baseValue.origin);
          return undefined;
        }
        return { kind: "prim", value: v };
      }
      return undefined;
    };

    const resolveRequire = (spec) => {
      if (!spec.startsWith(".")) return undefined;
      let abs = path.resolve(path.dirname(file), spec);
      if (abs.startsWith(srcRoot)) abs = path.join(distRoot, path.relative(srcRoot, abs));
      for (const candidate of [abs, `${abs}.js`, `${abs}.cjs`, `${abs}.json`, path.join(abs, "index.js")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
      // a module that only the tree being read has (sourceRoot): it exists, and what it exports is not known
      if (sourceRoot !== serverDir) {
        for (const candidate of [abs, `${abs}.js`, `${abs}.cjs`, `${abs}.json`]) {
          const other = path.join(sourceRoot, path.relative(serverDir, candidate));
          if (fs.existsSync(other) && fs.statSync(other).isFile()) return undefined;
        }
      }
      return null;
    };

    function evaluate(node, quiet) {
      node = stripParens(node);
      if (!node) return undefined;
      if (node.kind === SK.NullKeyword) return null;
      if (ts.isIdentifier(node)) {
        if (node.text === "undefined") return null;
        const e = lookup(node);
        return e ? entryValue(e) : undefined;
      }
      if (ts.isPropertyAccessExpression(node)) {
        const base = evaluate(node.expression, quiet);
        const name = node.name.text;
        if (base === undefined || base === null) {
          return name === "core" && !ts.isCallExpression(node.parent) ? candidate(node.getText(sf)) : name === "api" || name === "pluginApi" ? API : undefined;
        }
        if (base.kind === "fn" || base.kind === "lookup" || base.kind === "prim") return undefined;
        return member(base, name, node, quiet);
      }
      if (ts.isElementAccessExpression(node)) {
        const base = evaluate(node.expression, quiet);
        const arg = stripParens(node.argumentExpression);
        if (!base || base.kind === "fn" || base.kind === "lookup" || base.kind === "prim") return undefined;
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return member(base, arg.text, node, quiet);
        if (base.kind === "obj" && identifierObjects.has(base.value) && !quiet && collecting) {
          stats.dynamicLookups++;
          checkDynamic(node, base, arg);
        }
        return undefined;
      }
      if (ts.isCallExpression(node)) {
        const callee = stripParens(node.expression);
        if (ts.isIdentifier(callee) && callee.text === "require" && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && !lookup(callee)) {
          const target = resolveRequire(node.arguments[0].text);
          if (target === null) { if (!quiet) report(node, "require", "require", node.arguments[0].text); return undefined; }
          if (!target) return undefined;
          let exportsObject;
          if (target.startsWith(distRoot)) { try { exportsObject = require(target); } catch { return undefined; } }
          else if (options.moduleExports) exportsObject = options.moduleExports(target);
          if (exportsObject === undefined) return undefined;
          return objValue(exportsObject, path.relative(serverDir, target).replace(/\\/g, "/"), "module");
        }
        // X.core(), X.getCore(), core(), getCore()
        if (ts.isPropertyAccessExpression(callee) && (callee.name.text === "core" || callee.name.text === "getCore")) {
          const base = evaluate(callee.expression, true);
          if (base === undefined || base === null) return candidate(callee.getText(sf));
          if (base.kind === "obj" && has(base.value, callee.name.text)) return CORE;
        }
        const fn = evaluate(callee, quiet);
        if (fn && fn.kind === "fn") {
          const r = fnReturn(fn.node);
          if (r && r.kind === "lookup") {
            const arg = node.arguments[0] && stripParens(node.arguments[0]);
            if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
              if (!quiet && collecting) stats.stringLookups++;
              if (!has(r.target.value, arg.text) && !quiet) report(node, "identifier", r.target.label, arg.text, { via: "lookup helper" });
            }
            return undefined;
          }
          return r;
        }
        if (ts.isIdentifier(callee) && (callee.text === "getCore") && !lookup(callee)) return undefined;
        return undefined;
      }
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        if (op === SK.QuestionQuestionToken || op === SK.BarBarToken) {
          const l = evaluate(node.left, quiet);
          const r = evaluate(node.right, quiet);
          if (l && (!r || r === l)) return l.kind === "prim" ? undefined : l;
          if (r && !l && r.kind !== "prim") return r;
          return undefined;
        }
        return undefined;
      }
      if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return { kind: "fn", node };
      return undefined;
    }

    // X[expr]: when expr is the parameter of a callback over a list of string literals, check each.
    function checkDynamic(node, base, arg) {
      const where = { file: rel, line: lineOf(node), base: base.label, text: node.getText(sf).slice(0, 100), resolved: false };
      dynamic.push(where);
      if (!ts.isIdentifier(arg)) return;
      const e = lookup(arg);
      if (!e || !e.param) return;
      // the callback this parameter belongs to
      let fnNode;
      for (let n = arg.parent; n; n = n.parent) { if (isFunctionNode(n) && scopes.get(n)?.get(arg.text) === e) { fnNode = n; break; } }
      if (!fnNode || fnNode.parameters[0]?.name !== undefined && !(ts.isIdentifier(fnNode.parameters[0].name) && fnNode.parameters[0].name.text === arg.text)) return;
      const call = fnNode.parent;
      if (!ts.isCallExpression(call) || !call.arguments.includes(fnNode) || !ts.isPropertyAccessExpression(call.expression)) return;
      if (!ARRAY_CALLBACKS.has(call.expression.name.text)) return;
      const list = literalStrings(call.expression.expression);
      if (!list) return;
      where.resolved = true;
      for (const item of list) {
        stats.stringLookups++;
        if (!has(base.value, item.text)) report(item, "identifier", base.label, item.text, { via: `list read at line ${lineOf(node)}`, guardedAt: guarded(node) });
      }
    }
    function literalStrings(expr, depth = 0) {
      expr = stripParens(expr);
      if (ts.isArrayLiteralExpression(expr)) {
        return expr.elements.every((el) => ts.isStringLiteral(el)) && expr.elements.length ? expr.elements : null;
      }
      if (ts.isIdentifier(expr) && depth < 2) {
        const e = lookup(expr);
        if (!e || e.writes.size !== 1) return null;
        const declNode = [...e.writes.keys()][0];
        return declNode.initializer ? literalStrings(declNode.initializer, depth + 1) : null;
      }
      return null;
    }

    const bindPattern = (pattern, value, node) => {
      if (ts.isIdentifier(pattern)) { write(lookup(pattern), node, value); return; }
      if (ts.isObjectBindingPattern(pattern)) {
        for (const el of pattern.elements) {
          if (el.dotDotDotToken) { bindPattern(el.name, undefined, el); continue; }
          const key = el.propertyName ?? el.name;
          let v;
          if (value && value !== null && (ts.isIdentifier(key) || ts.isStringLiteral(key))) {
            v = value.kind === "fn" || value.kind === "lookup" || value.kind === "prim" ? undefined : member(value, key.text, el, false);
          }
          if (el.initializer && v === undefined) v = undefined;
          bindPattern(el.name, v, el);
        }
        return;
      }
      if (ts.isArrayBindingPattern(pattern)) {
        for (const el of pattern.elements) if (ts.isBindingElement(el)) bindPattern(el.name, undefined, el);
      }
    };

    function visit(node) {
      if (ts.isVariableDeclaration(node)) {
        if (node.initializer) {
          const value = evaluate(node.initializer, false);
          bindPattern(node.name, value, node);
          visitChildrenOf(node.initializer);
        } else if (ts.isIdentifier(node.name) && !ts.isForOfStatement(node.parent.parent) && !ts.isForInStatement(node.parent.parent) && !ts.isCatchClause(node.parent)) {
          write(lookup(node.name), node, null);
        } else {
          bindPattern(node.name, undefined, node);
        }
        return;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === SK.EqualsToken) {
        const left = stripParens(node.left);
        const value = evaluate(node.right, false);
        if (ts.isIdentifier(left)) write(lookup(left), node, value);
        else if (ts.isObjectLiteralExpression(left)) {
          for (const prop of left.properties) {
            if (ts.isShorthandPropertyAssignment(prop)) {
              const v = value && value.kind !== "fn" && value.kind !== "lookup" && value.kind !== "prim" ? member(value, prop.name.text, prop, false) : undefined;
              write(lookup(prop.name), prop, v);
            } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
              const v = value && value.kind !== "fn" && value.kind !== "lookup" && value.kind !== "prim" ? member(value, prop.name.text, prop, false) : undefined;
              write(lookup(prop.initializer), prop, v);
            }
          }
        } else if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
          evaluate(left.expression, false);
          visitChildrenOf(left.expression);
          if (ts.isElementAccessExpression(left)) visit(left.argumentExpression);
        }
        visitChildrenOf(node.right);
        return;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind > SK.EqualsToken && node.operatorToken.kind <= SK.LastAssignment) {
        const left = stripParens(node.left);
        if (ts.isIdentifier(left)) write(lookup(left), node, undefined);
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)
        && (node.operator === SK.PlusPlusToken || node.operator === SK.MinusMinusToken)) {
        write(lookup(node.operand), node, undefined);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) {
        evaluate(node, false);
        visitChildrenOf(node);
        return;
      }
      ts.forEachChild(node, visit);
    }
    // evaluate() already walked the chain under `node`; visit what it does not: call arguments,
    // element keys, and anything nested that is not itself part of the access chain.
    function visitChildrenOf(node) {
      node = stripParens(node);
      if (!node) return;
      if (ts.isPropertyAccessExpression(node)) { visitChain(node.expression); return; }
      if (ts.isElementAccessExpression(node)) { visitChain(node.expression); visit(node.argumentExpression); return; }
      if (ts.isCallExpression(node)) { visitChain(node.expression); node.arguments.forEach(visit); return; }
      if (ts.isIdentifier(node)) return;
      // not an access chain at all: an ordinary expression
      if (ts.isBinaryExpression(node) && (node.operatorToken.kind === SK.QuestionQuestionToken || node.operatorToken.kind === SK.BarBarToken)) {
        visitChildrenOf(node.left); visitChildrenOf(node.right); return;
      }
      visit(node);
    }
    function visitChain(node) {
      node = stripParens(node);
      if (!node) return;
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) visitChildrenOf(node);
      else if (!ts.isIdentifier(node)) visit(node);
    }

    for (let pass = 0; pass < 6; pass++) {
      changed = false;
      fnReturnCache.clear();
      visit(sf);
      if (!changed) break;
    }
    collecting = true;
    fnReturnCache.clear();
    visit(sf);
    collecting = false;
    for (const c of candidates.values()) if (c.hits > 0) findings.push(...c.pending);
  }
}

/**
 * The exports of a plugin's helper module as the running server has them: what the plugin load left
 * in the module cache, and for a helper only required later (inside a handler), a require now.
 * A *.plugin.js is never required here: the loader owns those.
 */
function loadedModuleExports(file) {
  if (require.cache[file]) return require.cache[file].exports;
  if (file.endsWith(".plugin.js")) return undefined;
  try { return require(file); } catch { return undefined; }
}

module.exports = { scan, loadedModuleExports, IDENTIFIER_CLASSES };

if (require.main === module) {
  // --light: identifier classes and api.core only, without loading the plugins (no cache needed).
  // --source=<dir>: read plugins/ and data/ from another server tree (an older checkout).
  // --all: also list the reads the code around them allows to be missing.
  const serverDir = path.resolve(process.argv.find((a) => a.startsWith("--server="))?.slice(9) ?? path.join(__dirname, ".."));
  process.chdir(serverDir);
  process.env.DISABLE_PLAYER_BOTS = "1";
  require(path.join(serverDir, "dist", "Server")).Server.installProductionPathResolver();
  const { PluginManager } = require(path.join(serverDir, "dist", "plugins", "PluginManager"));
  const light = process.argv.includes("--light");
  (async () => {
    let moduleExports;
    let api;
    if (!light) {
      const { CachePipeline } = require(path.join(serverDir, "dist", "game", "cache", "CachePipeline"));
      const log = console.log, info = console.info, warn = console.warn, debug = console.debug;
      console.log = console.info = console.warn = console.debug = () => {};
      await CachePipeline.initialize(serverDir);
      PluginManager.loadFromDirectory(path.join(serverDir, "plugins"));
      console.log = log; console.info = info; console.warn = warn; console.debug = debug;
      moduleExports = loadedModuleExports;
      api = PluginManager.createApi("ReferenceScan");
    }
    const sourceRoot = process.argv.find((a) => a.startsWith("--source="))?.slice(9);
    const result = scan({ serverDir, core: PluginManager.getCoreApi(), api, moduleExports, sourceRoot: sourceRoot && path.resolve(sourceRoot) });
    if (process.argv.includes("--json")) {
      process.stdout.write(JSON.stringify(result, null, 1));
    } else {
      const all = process.argv.includes("--all");
      for (const f of result.findings) {
        if (f.guarded && !all) continue;
        console.log(`${f.file}:${f.line}  [${f.kind}${f.guarded ? ", guarded" : ""}]  ${f.base}.${f.name}   ${f.text}${f.via ? `   (${f.via})` : ""}`);
      }
      console.log(JSON.stringify(result.stats));
      console.log(`${result.findings.filter((f) => !f.guarded).length} unguarded, ${result.findings.filter((f) => f.guarded).length} guarded`);
    }
    process.exit(0);
  })().catch((error) => { console.error(error); process.exit(1); });
}
