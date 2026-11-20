import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { projectRoot } from './helpers';
import { commandsFor } from '../src/cli/registry';
import { failureCodes } from '../src/cli/errors';

// Route scan: what counts as a route, and how the scan reads it
// ==============================================================
//
// The HTTP service has no route table. Each handler tests the request in code, so the scan reads the
// TypeScript syntax tree of the service files (not their text, so line breaks, comments and spacing don't
// matter) and recognises a route in two ways:
//
// 1. Path comparison: an `===`, `!==`, `==` or `!=` that has a string literal starting `/api/` on one side,
//    as in `url.pathname === '/api/projects'`.
// 2. Path pattern: a regular expression literal starting `^\/api\/` passed to `.match(...)`, as in
//    `url.pathname.match(/^\/api\/documents\/([a-z0-9-]+)\/duplicate$/)`.
//
// Methods and actions then come from the code that follows. The scan takes the longest handler block that
// holds every anchor of a file, expands each pattern into its concrete paths (an alternation such as
// `(download|open)` and an optional group each give separate paths; a parameter shows as `*`), and walks the
// block statement by statement for every pair of method and path, the way the server would: it evaluates the
// conditions it can (`req.method === 'POST'`, `action === 'restore'`, `!commentId`, `route && ...`) and treats
// anything else (a function call, a lookup) as "could be either way". A pair is a route when it reaches a
// `return` that answers the request (not a 404 or other error status, not `return false`) after a condition
// that depended on the path. So a new `if (...)` branch, a new method on a known path, or a new word in a
// pattern's alternation shows up as a new route without anyone editing a list.
//
// What the scan can't read is caught instead of ignored: every other string, template or pattern literal that
// mentions `/api/` (a `startsWith('/api/')`, a pattern used with `.test`, ...) must be on `knownLiterals`
// below with a reason, or the test fails. A route the scan can't see at all (one built from pieces at run
// time, say) goes on `byHand`, with its reason. There is none today.

export interface Route { method: string; path: string; file: string }

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const unknown = Symbol('unknown');

interface Match { caps: (string | undefined)[] }
type Value = string | boolean | null | undefined | Match | typeof unknown;
interface Bound { value: Value; dep: boolean }
class Scope {
  private vars = new Map<string, Bound>();
  constructor(private parent?: Scope) {}
  get(name: string): Bound | undefined { return this.vars.get(name) ?? this.parent?.get(name); }
  set(name: string, bound: Bound) { this.vars.set(name, bound); }
}
interface Expansion { path: string; caps: (string | undefined)[]; anchor: number }
/** `routed`: a path test definitely held. `narrowed`: a path test decided one way or the other. `uncertain`: this branch was entered on a condition the scan can't decide. */
interface Pair { key: string; method: string; expansion: Expansion; scope: Scope; routed: boolean; narrowed: boolean; uncertain: boolean }
const answers = (pair: Pair) => pair.routed || (pair.narrowed && !pair.uncertain);

/** Expand a path pattern into concrete paths with the value of each capture group; parameters become `*`. */
export function expandPattern(source: string, anchor: number): Expansion[] {
  let position = 0, groups = 0;
  type Partial = { text: string; caps: Record<number, string> };
  const fail = (message: string): never => { throw new Error(`Cannot read the route pattern /${source}/: ${message}`); };
  const peek = () => source[position];
  const product = (left: Partial[], right: Partial[]): Partial[] => left.flatMap(a => right.map(b => ({ text: a.text + b.text, caps: { ...a.caps, ...b.caps } })));
  const empty = (): Partial => ({ text: '', caps: {} });

  function alternation(): Partial[] {
    const branches = [sequence()];
    while (peek() === '|') { position++; branches.push(sequence()); }
    return branches.flat();
  }
  function sequence(): Partial[] {
    let parts: Partial[] = [empty()];
    while (position < source.length && peek() !== '|' && peek() !== ')') parts = product(parts, item());
    return parts;
  }
  function item(): Partial[] {
    const char = source[position++];
    let parts: Partial[];
    let optional = false;
    if (char === '^' || char === '$') return [empty()];
    if (char === '(') {
      let capture = 0;
      if (source.startsWith('?:', position)) position += 2; else capture = ++groups;
      const start = position;
      const innerGroupsBefore = groups;
      const body = alternation();
      if (peek() !== ')') fail('an unclosed group');
      const bodyText = source.slice(start, position);
      position++;
      if (capture && groups === innerGroupsBefore && /\[|\\[dws]/.test(bodyText)) parts = [{ text: '*', caps: {} }]; // a parameter such as ([a-z0-9-]+)
      else parts = body;
      if (capture) parts = parts.map(part => ({ text: part.text, caps: { ...part.caps, [capture]: part.text } }));
    } else if (char === '[') {
      while (position < source.length && peek() !== ']') position += peek() === '\\' ? 2 : 1;
      position++;
      parts = [{ text: '*', caps: {} }];
    } else if (char === '\\') {
      const escaped = source[position++];
      parts = [{ text: /[dws]/i.test(escaped) ? '*' : escaped, caps: {} }];
    } else if (char === '.') parts = [{ text: '*', caps: {} }];
    else parts = [{ text: char, caps: {} }];
    // Quantifier: ?, +, *, {n} or {n,m}, each optionally lazy.
    const quantifier = /^(?:[?+*]|\{\d+(?:,\d*)?\})\??/.exec(source.slice(position))?.[0];
    if (quantifier) {
      position += quantifier.length;
      optional = quantifier[0] === '?' || quantifier[0] === '*';
      if (quantifier[0] === '+' || quantifier[0] === '*' || quantifier[0] === '{') parts = parts.map(part => part.text === '*' ? part : fail(`a repeated ${JSON.stringify(part.text)}`));
    }
    return optional ? [...parts, empty()] : parts;
  }
  const parts = alternation();
  if (position !== source.length) fail('an unexpected ")"');
  return parts.map(part => ({ path: part.text, caps: Array.from({ length: groups + 1 }, (_, index) => index === 0 ? part.text : part.caps[index]), anchor }));
}

const text = (node: ts.Node) => node.getText();
const isPath = (value: string) => value.startsWith('/api/') && value.length > '/api/'.length;
const comparisons = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

/** `dep`: the value came from the path. `proof`: if the value is not false, a path test definitely held. */
type Result = { value: Value; dep: boolean; proof: boolean };
const truthy = (value: Value): boolean | typeof unknown => value === unknown ? unknown : !(value === undefined || value === null || value === false || value === '');
const result = (value: Value, dep = false, proof = dep && truthy(value) === true): Result => ({ value, dep, proof });

/** Walks one handler block for every method and path pair, as described at the top. */
class Walker {
  readonly handled = new Set<string>();
  constructor(private anchors: Map<ts.Node, number>, private methodsToTry: string[], private expansions: Expansion[]) {}

  run(block: ts.Block): void {
    const pairs = this.expansions.flatMap(expansion => this.methodsToTry.map(method => ({ key: `${method} ${expansion.path}`, method, expansion, scope: new Scope(), routed: false, narrowed: false, uncertain: false })));
    const live = this.statements(block.statements, pairs);
    const last = block.statements.at(-1);
    if (last && !this.refusal(block.statements, block.statements.length - 1)) for (const pair of pairs) if (live.has(pair.key) && answers(pair)) this.handled.add(pair.key);
  }

  private refusal(list: readonly ts.Statement[], index: number): boolean {
    const statement = list[index];
    if (ts.isReturnStatement(statement) && statement.expression?.kind === ts.SyntaxKind.FalseKeyword) return true;
    // A statement that answers with an error status (`json(res, {...}, 404)`, `socket.end('HTTP/1.1 403 ...')`) or an `error` body.
    const sentErrorStatus = /(?:,\s*|\s)[45]\d\d\b|\{\s*error\b/;
    return list.slice(0, ts.isReturnStatement(statement) ? index : index + 1).some(before => ts.isExpressionStatement(before) && sentErrorStatus.test(text(before)));
  }

  private statements(list: readonly ts.Statement[], incoming: Pair[]): Set<string> {
    let live = incoming;
    list.forEach((statement, index) => {
      if (!live.length) return;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) for (const pair of live) this.declare(declaration, pair);
      } else if (ts.isReturnStatement(statement)) {
        if (!this.refusal(list, index)) for (const pair of live) if (answers(pair)) this.handled.add(pair.key);
        live = [];
      } else if (ts.isThrowStatement(statement)) {
        live = [];
      } else if (ts.isIfStatement(statement)) {
        const thenPairs: Pair[] = [], elsePairs: Pair[] = [];
        for (const pair of live) {
          const condition = this.evaluate(statement.expression, pair);
          const decided = truthy(condition.value);
          const narrowed = pair.narrowed || (condition.dep && decided !== unknown);
          pair.narrowed = narrowed; // The pairs that stay live after this statement have passed the same test.
          const uncertain = pair.uncertain || decided === unknown;
          if (decided !== false) thenPairs.push({ ...pair, scope: new Scope(pair.scope), routed: pair.routed || condition.proof, narrowed, uncertain });
          if (decided !== true) elsePairs.push({ ...pair, scope: new Scope(pair.scope), narrowed, uncertain });
        }
        const thenFall = this.statements(ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement], thenPairs);
        const elseFall = statement.elseStatement
          ? this.statements(ts.isBlock(statement.elseStatement) ? statement.elseStatement.statements : [statement.elseStatement], elsePairs)
          : new Set(elsePairs.map(pair => pair.key));
        live = live.filter(pair => thenFall.has(pair.key) || elseFall.has(pair.key));
      } else if (ts.isBlock(statement) || ts.isTryStatement(statement)) {
        const block = ts.isBlock(statement) ? statement : statement.tryBlock;
        const fall = this.statements(block.statements, live.map(pair => ({ ...pair, scope: new Scope(pair.scope) })));
        live = live.filter(pair => fall.has(pair.key));
      }
    });
    return new Set(live.map(pair => pair.key));
  }

  private declare(declaration: ts.VariableDeclaration, pair: Pair) {
    const init = declaration.initializer ? this.evaluate(declaration.initializer, pair) : result(undefined);
    const name = declaration.name;
    if (ts.isIdentifier(name)) { pair.scope.set(name.text, init); return; }
    const bindNames = (pattern: ts.BindingName, bound: Bound) => {
      if (ts.isIdentifier(pattern)) pair.scope.set(pattern.text, bound);
      else for (const element of pattern.elements) if (ts.isBindingElement(element)) bindNames(element.name, bound);
    };
    if (ts.isArrayBindingPattern(name)) {
      name.elements.forEach((element, index) => {
        if (!ts.isBindingElement(element)) return;
        const value = typeof init.value === 'object' && init.value ? init.value.caps[index] : unknown;
        bindNames(element.name, { value, dep: init.dep });
      });
    } else bindNames(name, { value: unknown, dep: false });
  }

  /** The value of an expression for one pair, or `unknown` when the scan can't tell. `dep` marks a value that came from the path. */
  private evaluate(node: ts.Expression, pair: Pair): Result {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return this.evaluate(node.expression, pair);
    if (ts.isAwaitExpression(node)) { const inner = this.evaluate(node.expression, pair); return ts.isCallExpression(node.expression) ? result(unknown, inner.dep, false) : inner; }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return result(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return result(true);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return result(false);
    if (node.kind === ts.SyntaxKind.NullKeyword) return result(null);
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return result(undefined);
      return this.lookup(node.text, pair);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'method' && !node.questionDotToken) return result(pair.method);
      if (node.name.text === 'pathname') return result(pair.expansion.path, true);
      return result(unknown);
    }
    if (ts.isElementAccessExpression(node)) {
      const base = this.evaluate(node.expression, pair);
      const index = ts.isNumericLiteral(node.argumentExpression) ? Number(node.argumentExpression.text) : NaN;
      if (typeof base.value === 'object' && base.value && !Number.isNaN(index)) return result(base.value.caps[index], true);
      if (base.value === null && node.questionDotToken) return result(undefined, base.dep);
      return result(unknown, base.dep);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'match' && node.arguments.length === 1 && ts.isRegularExpressionLiteral(node.arguments[0])) {
        const anchor = this.anchors.get(node.arguments[0]);
        if (anchor === undefined) return result(unknown);
        return result(anchor === pair.expansion.anchor ? { caps: pair.expansion.caps } : null, true);
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'includes' && ts.isArrayLiteralExpression(callee.expression) && node.arguments.length === 1) {
        const list = callee.expression.elements.map(element => ts.isStringLiteral(element) ? element.text : unknown);
        const argument = this.evaluate(node.arguments[0], pair);
        if (typeof argument.value === 'string' && !list.includes(unknown)) return result(list.includes(argument.value), argument.dep);
      }
      return result(unknown);
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = this.evaluate(node.operand, pair);
      const decided = truthy(operand.value);
      return result(decided === unknown ? unknown : !decided, operand.dep, false);
    }
    if (ts.isBinaryExpression(node)) return this.binary(node, pair);
    return result(unknown);
  }

  private lookup(name: string, pair: Pair): Result {
    const bound = pair.scope.get(name);
    return bound ? result(bound.value, bound.dep) : result(unknown);
  }

  private binary(node: ts.BinaryExpression, pair: Pair): Result {
    const operator = node.operatorToken.kind;
    if (comparisons.has(operator)) {
      let left = this.evaluate(node.left, pair), right = this.evaluate(node.right, pair);
      // A path read some other way (`req.url?.split('?')[0] !== '/api/events'`) is still the path.
      if (left.value === unknown && ts.isStringLiteral(node.right) && isPath(node.right.text)) left = result(pair.expansion.path, true);
      if (right.value === unknown && ts.isStringLiteral(node.left) && isPath(node.left.text)) right = result(pair.expansion.path, true);
      const dep = left.dep || right.dep;
      if (left.value === unknown || right.value === unknown) return result(unknown, dep);
      const same = left.value === right.value;
      const equal = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
      return result(equal ? same : !same, dep);
    }
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = this.evaluate(node.left, pair), decided = truthy(left.value);
      if (decided === false) return result(false, left.dep);
      const right = this.evaluate(node.right, pair), dep = left.dep || right.dep, proof = left.proof || right.proof;
      if (decided === true) return result(right.value, dep, proof);
      return truthy(right.value) === false ? result(false, dep) : result(unknown, dep, proof);
    }
    if (operator === ts.SyntaxKind.BarBarToken) {
      const left = this.evaluate(node.left, pair), decided = truthy(left.value);
      if (decided === true) return left;
      const right = this.evaluate(node.right, pair), dep = left.dep || right.dep, proof = left.proof && right.proof;
      if (decided === false) return result(right.value, dep, right.proof);
      return truthy(right.value) === true ? result(true, dep, proof) : result(unknown, dep, proof);
    }
    if (operator === ts.SyntaxKind.QuestionQuestionToken) {
      const left = this.evaluate(node.left, pair);
      if (left.value === unknown) return left;
      if (left.value !== undefined && left.value !== null) return left;
      const right = this.evaluate(node.right, pair);
      return result(right.value, left.dep || right.dep, right.proof);
    }
    return result(unknown);
  }
}

/** Where a `/api/` literal is fine without being a route. Everything else the scan can't place fails the test. */
export const knownLiterals: { file?: string; text: string; reason: string }[] = [
  { text: '/api/', reason: 'The prefix test that sends every other path to the client.' },
  { file: 'src/server/packs-http.ts', text: '/api/packs/staged/', reason: 'The preview address built for a staged pack (a response, not a route; the route is the pattern above it).' },
];

/** Routes written out by hand because the scan can't see them. Each: method, path with `*` for a parameter, file, reason. */
export const byHand: (Route & { reason: string })[] = [];

interface Scanned { routes: Route[]; unplaced: string[] }

/** Find every route in the given sources (a file name for messages, and its text). */
export function scanRoutes(sources: { file: string; text: string }[]): Scanned {
  const routes: Route[] = [], unplaced: string[] = [];
  for (const { file, text: code } of sources) {
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const anchors = new Map<ts.Node, number>(), expansions: Expansion[] = [], nodes: ts.Node[] = [];
    const literals: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && comparisons.has(node.operatorToken.kind)) {
        for (const side of [node.left, node.right]) {
          if (ts.isStringLiteral(side) && isPath(side.text)) {
            const id = anchors.size;
            anchors.set(side, id); nodes.push(side);
            expansions.push({ path: side.text, caps: [side.text], anchor: id });
          }
        }
      } else if (ts.isRegularExpressionLiteral(node) && node.text.startsWith('/^\\/api\\/') && ts.isCallExpression(node.parent)
        && ts.isPropertyAccessExpression(node.parent.expression) && node.parent.expression.name.text === 'match') {
        const id = anchors.size;
        anchors.set(node, id); nodes.push(node);
        const pattern = node.text.slice(1, node.text.lastIndexOf('/'));
        expansions.push(...expandPattern(pattern, id));
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node)) literals.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);

    for (const literal of literals) {
      const value = ts.isRegularExpressionLiteral(literal) ? literal.text : (literal as ts.StringLiteral).text;
      if (anchors.has(literal) || !/\\?\/api\\?\//.test(value)) continue;
      const known = knownLiterals.some(entry => (!entry.file || entry.file === file) && entry.text === value);
      let parent: ts.Node | undefined = literal;
      while (parent && !(ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.name.text === 'readOnlyWrites')) parent = parent.parent;
      if (!known && !parent) unplaced.push(`${file}: ${JSON.stringify(value)} at line ${source.getLineAndCharacterOfPosition(literal.getStart()).line + 1}`);
    }
    if (!nodes.length) continue;

    // The handler is the smallest block that holds every anchor.
    let block: ts.Node | undefined = nodes[0].parent;
    while (block && !(ts.isBlock(block) && nodes.every(node => node.pos >= block!.pos && node.end <= block!.end))) block = block.parent;
    if (!block || !ts.isBlock(block)) throw new Error(`${file}: the routes are not inside one block, so the scan can't read them.`);
    // A WebSocket upgrade handler has no method.
    let upgrade = false;
    for (let up: ts.Node | undefined = block; up; up = up.parent) {
      if (ts.isCallExpression(up) && ts.isPropertyAccessExpression(up.expression) && up.expression.name.text === 'on' && up.arguments[0] && ts.isStringLiteral(up.arguments[0]) && up.arguments[0].text === 'upgrade') upgrade = true;
    }
    const unique = [...new Map(expansions.map(expansion => [`${expansion.anchor}:${expansion.path}`, expansion])).values()];
    const walker = new Walker(anchors, upgrade ? ['UPGRADE'] : methods, unique);
    walker.run(block);
    const found = new Map<string, Set<string>>();
    for (const key of walker.handled) { const [method, path] = key.split(' '); found.set(path, (found.get(path) ?? new Set()).add(method)); }
    for (const [path, set] of found) {
      if (!upgrade && methods.every(method => set.has(method))) routes.push({ method: 'ANY', path, file });
      else for (const method of set) routes.push({ method, path, file });
    }
  }
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return { routes, unplaced };
}

/** The files the brief names: the service, the listener and every `*-http.ts` module. */
function serviceSources(overrides: Record<string, string> = {}) {
  const directory = resolve(projectRoot, 'src/server');
  const files = ['service.ts', 'index.ts', ...readdirSync(directory).filter(name => name.endsWith('-http.ts')).sort()];
  return files.map(name => ({ file: `src/server/${name}`, text: overrides[name] ?? readFileSync(resolve(directory, name), 'utf8') }));
}


// The map
// =======
//
// Every route is either covered by a CLI command from the registry (`opendoc help --json`) or exempt with a
// reason. Keys are `METHOD /api/path`, with `*` for a path parameter and `UPGRADE` for the WebSocket. Adding a
// route to the service fails the first test below until it is added to one of the two tables.

/** The CLI command (or commands) that does what the route does, as typed: `comments add`. */
export const covered: Record<string, string | string[]> = {
  'GET /api/assets': 'assets list',
  'POST /api/assets/logo': 'assets import logo',
  'POST /api/assets/font': 'assets import font',
  'GET /api/assets/logo/*': 'assets inspect',
  'GET /api/assets/font/*': 'assets inspect',
  'PATCH /api/assets/logo/*': 'assets revise',
  'PATCH /api/assets/font/*': 'assets revise',
  'POST /api/assets/logo/*/archive': 'assets archive',
  'POST /api/assets/font/*/archive': 'assets archive',
  'POST /api/assets/logo/*/restore': 'assets restore',
  'POST /api/assets/font/*/restore': 'assets restore',
  'POST /api/assets/logo/*/variations': 'assets add-variation',
  'POST /api/assets/font/*/faces': 'assets add-faces',
  'GET /api/themes/*/assets': 'assets defaults',
  'PUT /api/themes/*/assets': 'assets defaults',

  'GET /api/projects': 'projects list',
  'POST /api/projects': 'projects create',
  'PATCH /api/projects/*': 'projects update',
  'DELETE /api/projects/*': 'projects delete',
  'PUT /api/documents/*/project': 'projects assign',

  'POST /api/documents': 'create',
  'GET /api/starters': 'create',
  'POST /api/templates/*/documents': 'create',
  'GET /api/documents': 'documents list',
  'GET /api/documents/*': 'documents show',
  'PATCH /api/documents/*': 'documents rename',
  'POST /api/documents/*/duplicate': 'documents duplicate',
  'DELETE /api/documents/*': 'documents delete',
  'POST /api/document-trash/*/restore': 'documents restore',

  'GET /api/documents/*/comments': 'comments list',
  'POST /api/documents/*/comments': 'comments add',
  'PATCH /api/documents/*/comments/*': ['comments edit', 'comments resolve', 'comments reopen'],
  'DELETE /api/documents/*/comments/*': 'comments delete',
  'POST /api/documents/*/comments/*/restore': 'comments restore',

  'GET /api/documents/*/history': 'history list',
  'GET /api/documents/*/history/*': 'history show',
  'GET /api/documents/*/history/blocks/*': 'history block',
  'POST /api/documents/*/history/*/restore': 'history restore',

  'POST /api/documents/*/exports': 'export',
  'GET /api/documents/*/exports': 'export history list',
  'GET /api/exports/*': 'export history list',
  'DELETE /api/exports/*': 'export history delete',
  'POST /api/exports/*/restore': 'export history restore',
  'POST /api/exports/*/reveal': 'export history reveal',

  'GET /api/materials': 'media list',
  'POST /api/materials/*/import': 'media import',
  'PATCH /api/materials/*/meta': 'media edit',

  'GET /api/themes': 'themes list',
  'GET /api/themes/*/preview': 'themes preview',
  'PUT /api/themes/*/folder': 'themes assign',
  'PUT /api/themes/*/tags': 'themes tags',
  'GET /api/theme-folders': 'themes folders list',
  'POST /api/theme-folders': 'themes folders create',
  'PATCH /api/theme-folders/*': 'themes folders rename',
  'DELETE /api/theme-folders/*': 'themes folders delete',

  'GET /api/templates': 'templates list',
  'GET /api/templates/*/preview': 'templates preview',
  'GET /api/templates/*/guide': 'templates inspect',

  'GET /api/tags': 'tags list',
  'PUT /api/tags/documents/*': 'tags set',
  'PUT /api/tags/templates/*': 'tags set',
  'PUT /api/tags/themes/*': 'tags set',
  'PUT /api/tags/documents/*/status': 'tags status',

  'POST /api/packs/export': 'packs export',
  'POST /api/packs/inspect': 'packs inspect',
  'POST /api/packs/install': 'packs install',
};

const sameAs = (route: string) => `Same route as ${route}: the pattern also takes a trailing segment, which the handler ignores.`;

/** Routes with no CLI command, each with its reason. "No CLI command yet" marks a real gap rather than a design choice. */
export const exempt: Record<string, string> = {
  'GET /api/session': 'UI only: gives the page its session token and read-only state; `status` reports who owns the workspace.',
  'POST /api/context': 'UI only: the app records its selection here; `context` reads it back.',
  'GET /api/events': 'Transport: an empty 204 for old pages that still ask for the event stream.',
  'UPGRADE /api/events': 'Transport: the WebSocket that tells the page to refetch; the CLI reads the files.',
  'GET /api/guides': 'UI only: shows a guide file in the Guide dialog; the CLI and agents read the file itself.',
  'GET /api/exports/capabilities': 'UI only: whether this machine can copy a file to the clipboard.',
  'POST /api/exports/*/copy': 'UI only: copies an exported file to the clipboard of the machine running the service.',
  'GET /api/exports/*/download': 'Bytes for the page: streams an earlier export to the browser; `export history reveal` prints its path.',
  'GET /api/exports/*/open': 'Bytes for the page: shows an earlier export in a tab; `export history reveal` prints its path.',

  'POST /api/documents/*/edits': 'UI only: saves the page\'s text editor; the CLI edits the source files.',
  'POST /api/documents/*/edits/*/undo': 'UI only: undoes a save from the page\'s text editor.',
  'POST /api/documents/*/edits/preview': 'UI only: renders the page\'s unsaved text edits.',
  'GET /api/documents/*/edits/previews/*/pdf': 'Bytes for the page: the PDF of the unsaved text edits.',

  'GET /api/documents/*/pdf': 'Bytes for the page: the open document\'s PDF; `export` and `review` write PDFs to disk.',
  'GET /api/documents/*/cover': 'Bytes for the page: the library cover image.',
  'POST /api/documents/*/export': 'Download in the page: sends the PDF or PowerPoint to the browser without saving it; `export` saves it (POST /exports).',
  'GET /api/themes/*/pdf': 'Bytes for the page: the gallery\'s preview PDF; `themes preview` writes one to disk.',
  'GET /api/templates/*/pdf': 'Bytes for the page: the gallery\'s preview PDF; `templates preview` writes one to disk.',
  'GET /api/themes/*/guide': 'UI only: shows design.md in the Guide dialog; `themes inspect` gives its path and agents read the file.',
  'GET /api/materials/*/image': 'Bytes for the page: a media image; `media list` gives the file paths.',
  'GET /api/materials/*/file': 'Bytes for the page: a media source file; `media list` gives the file paths.',
  'GET /api/assets/logo/*/file': 'Bytes for the page: a logo file; `assets inspect` gives the files.',
  'GET /api/assets/font/*/file': 'Bytes for the page: a font file; `assets inspect` gives the files.',
  'GET /api/packs/staged/*/previews/*': 'Bytes for the page: a staged pack\'s preview PDF; `packs inspect` reads the pack file itself.',
  'DELETE /api/packs/staged/*': 'UI-only cleanup of the app\'s own staging; the CLI has no staging.',

  'GET /api/documents/*/comments/*': sameAs('GET /api/documents/*/comments'),
  'GET /api/documents/*/comments/*/restore': sameAs('GET /api/documents/*/comments'),
  'GET /api/documents/*/cover/*': sameAs('GET /api/documents/*/cover'),
  'GET /api/documents/*/cover/*/restore': sameAs('GET /api/documents/*/cover'),
  'GET /api/documents/*/pdf/*': sameAs('GET /api/documents/*/pdf'),
  'GET /api/documents/*/pdf/*/restore': sameAs('GET /api/documents/*/pdf'),
  'POST /api/documents/*/export/*': sameAs('POST /api/documents/*/export'),
  'POST /api/documents/*/export/*/restore': sameAs('POST /api/documents/*/export'),
};

const keyOf = (route: Pick<Route, 'method' | 'path'>) => `${route.method} ${route.path}`;

/** Scanned routes plus the hand-listed ones. */
const allRoutes = (scanned: Route[], hand: Route[] = byHand) => [...scanned, ...hand];

/** The routes that are neither covered nor exempt. */
const unmapped = (routes: Route[]) => routes.map(keyOf).filter(key => !(key in covered) && !(key in exempt));

/** Everything the real service files hold, with chosen files replaced (to try a change without touching the source). */
const scanWith = (overrides: Record<string, (text: string) => string> = {}) => {
  const sources = serviceSources().map(source => {
    const edit = overrides[source.file.split('/').at(-1)!];
    if (!edit) return source;
    const text = edit(source.text);
    assert.notEqual(text, source.text, `${source.file}: the edit did not change anything`);
    return { ...source, text };
  });
  return scanRoutes(sources);
};
const insertBefore = (needle: string, addition: string) => (text: string) => text.replace(needle, `${addition}\n${needle}`);

test('every route of the service is covered by a CLI command or exempt with a reason', () => {
  const { routes, unplaced } = scanWith();
  assert.deepEqual(unplaced, [], 'every other /api/ literal is on knownLiterals with a reason');
  assert.deepEqual(unmapped(allRoutes(routes)), [], 'add each of these to `covered` (with its CLI command) or to `exempt` (with a reason)');
});

test('the scan reads the routes that are there, from every file the brief names', () => {
  const { routes } = scanWith();
  const keys = new Set(routes.map(keyOf));
  for (const key of ['GET /api/session', 'POST /api/context', 'GET /api/documents/*/comments', 'PATCH /api/documents/*/comments/*', 'POST /api/documents/*/comments/*/restore',
    'POST /api/documents/*/history/*/restore', 'GET /api/exports/*/download', 'POST /api/packs/install', 'PUT /api/tags/documents/*/status', 'DELETE /api/theme-folders/*',
    'PUT /api/themes/*/assets', 'POST /api/assets/font/*/faces', 'UPGRADE /api/events']) assert.ok(keys.has(key), `the scan finds ${key}`);
  // A method that a path doesn't have is not invented from its neighbours.
  for (const key of ['POST /api/documents/*/history/*', 'PUT /api/documents/*/comments', 'GET /api/packs/install', 'DELETE /api/session', 'POST /api/documents/*/comments/*']) assert.ok(!keys.has(key), `the scan does not report ${key}`);
  for (const file of serviceSources().map(source => source.file)) assert.ok(routes.some(route => route.file === file), `${file} yields routes`);
  assert.ok(routes.length >= 90, `the service has about a hundred routes; the scan found ${routes.length}`);
});

test('the map has no stale or doubled entries, and names real commands', () => {
  const scanned = new Set(allRoutes(scanWith().routes).map(keyOf));
  const commands = new Set(commandsFor('normal').map(command => command.path.join(' ')));
  for (const key of [...Object.keys(covered), ...Object.keys(exempt)]) assert.ok(scanned.has(key), `${key} is not a route any more: remove it from the map`);
  for (const key of Object.keys(covered)) {
    assert.ok(!(key in exempt), `${key} is both covered and exempt`);
    for (const command of [covered[key]].flat()) assert.ok(commands.has(command), `${key} names "${command}", which is not in the command registry`);
  }
  for (const [key, reason] of Object.entries(exempt)) assert.match(reason, /^[^\n]{20,200}$/, `${key} needs a one-line reason`);
  for (const entry of knownLiterals) assert.ok(entry.reason.length > 10, `${entry.text} needs a reason`);
  for (const entry of byHand) assert.ok(entry.reason.length > 10, `${keyOf(entry)} needs a reason`);
});

test('a route added without a mapping fails the check', () => {
  const failing = (scan: ReturnType<typeof scanRoutes>) => unmapped(allRoutes(scan.routes));
  // A new path comparison in the service.
  assert.deepEqual(failing(scanWith({ 'service.ts': insertBefore("if (req.method === 'GET' && url.pathname === '/api/starters')", "if (req.method === 'POST' && url.pathname === '/api/fake') { json(res, { ok: true }); return; }") })), ['POST /api/fake']);
  // A new path pattern, with two methods.
  assert.deepEqual(failing(scanWith({ 'service.ts': insertBefore("const draftPDF = url.pathname.match(", [
    'const fakeRoute = url.pathname.match(/^\\/api\\/fakes\\/([a-z0-9-]+)(?:\\/(open|close))?$/);',
    "if (fakeRoute && req.method === 'DELETE' && !fakeRoute[2]) { json(res, { ok: true }); return; }",
    "if (fakeRoute && req.method === 'POST' && fakeRoute[2] === 'close') { json(res, { ok: true }); return; }",
  ].join('\n')) })), ['DELETE /api/fakes/*', 'POST /api/fakes/*/close']);
  // A new route in an `*-http.ts` module.
  assert.deepEqual(failing(scanWith({ 'tags-http.ts': insertBefore("const status = url.pathname.match(", "if (url.pathname === '/api/tags/fake' && req.method === 'POST') { json(res, {}); return true; }") })), ['POST /api/tags/fake']);
  // A new word in an existing pattern's alternation, handled on its own line.
  assert.deepEqual(failing(scanWith({ 'service.ts': text => insertBefore("if (req.method === 'POST' && action === 'copy')", "if (req.method === 'POST' && action === 'purge') { json(res, { ok: true }); return; }")(text.replace('(download|open|reveal|copy|restore)', '(download|open|reveal|copy|restore|purge)')) })), ['POST /api/exports/*/purge']);
  // A new method on a path the map already knows.
  assert.deepEqual(failing(scanWith({ 'service.ts': insertBefore("if (documentRoute && req.method === 'PATCH')", "if (documentRoute && req.method === 'PUT') { json(res, {}); return; }") })), ['PUT /api/documents/*']);
  // A `/api/` the scan can't place as a route (a prefix test, a pattern used with .test) is reported, not skipped.
  const prefix = scanWith({ 'service.ts': insertBefore("if (req.method === 'GET' && url.pathname === '/api/starters')", "if (url.pathname.startsWith('/api/blobs/')) { json(res, {}); return; }") });
  assert.equal(prefix.unplaced.length, 1);
  assert.match(prefix.unplaced[0], /service\.ts: "\/api\/blobs\/"/);
  // A route the scan can't see goes on `byHand`; unmapped, it fails like any other.
  assert.deepEqual(unmapped(allRoutes(scanWith().routes, [{ method: 'POST', path: '/api/hand-listed', file: 'src/server/service.ts' }])), ['POST /api/hand-listed']);
});

test('the scan survives a change of formatting', () => {
  // Print every file again, one construct per line and without comments: the routes must not change.
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const reprinted = serviceSources().map(({ file, text }) => ({ file, text: printer.printFile(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)) }));
  assert.notEqual(reprinted.map(source => source.text).join(), serviceSources().map(source => source.text).join());
  assert.deepEqual(scanRoutes(reprinted), scanRoutes(serviceSources()));
});

test('the pattern expander reads the shapes the service uses', () => {
  const paths = (pattern: string) => expandPattern(pattern, 0).map(expansion => expansion.path).sort();
  assert.deepEqual(paths('^\\/api\\/a\\/([a-z0-9-]+)$'), ['/api/a/*']);
  assert.deepEqual(paths('^\\/api\\/a\\/([^/]+)\\/(x|y)(?:\\/([^/]+)(?:\\/(z))?)?$'), ['/api/a/*/x', '/api/a/*/x/*', '/api/a/*/x/*/z', '/api/a/*/y', '/api/a/*/y/*', '/api/a/*/y/*/z']);
  assert.deepEqual(paths('^\\/api\\/p\\/(e|staged\\/([^/]+)\\/previews\\/([^/]+))$'), ['/api/p/e', '/api/p/staged/*/previews/*']);
  const [, action, id] = expandPattern('^\\/api\\/p\\/(e|staged\\/([^/]+))$', 0).find(expansion => expansion.path.includes('staged'))!.caps;
  assert.deepEqual([action, id], ['staged/*', '*']);
  assert.throws(() => expandPattern('^\\/api\\/a(b', 0), /Cannot read the route pattern/);
});

test('docs/HEADLESS.md names every command and every failure code', () => {
  const guide = readFileSync(resolve(projectRoot, 'docs/HEADLESS.md'), 'utf8');
  for (const edition of ['normal', 'headless'] as const) {
    for (const command of commandsFor(edition)) {
      const path = command.path.join(' ');
      // A code span that starts with the command, as in `comments add <doc> <block-id> "text"`.
      assert.match(guide, new RegExp(`\`${path}(?: [^\`]*)?\``), `docs/HEADLESS.md has no \`${path}\` (${edition} edition)`);
    }
  }
  for (const code of Object.keys(failureCodes)) assert.ok(guide.includes(`\`${code}\``), `docs/HEADLESS.md does not list the failure code ${code}`);
});
