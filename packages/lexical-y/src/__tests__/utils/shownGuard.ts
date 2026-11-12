/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Reads `src/internal` with the TypeScript compiler and reports, by symbol,
// every place outside the shown-items filter (see internal/Shown) that
// decides what the editor shows:
//
// 1. a use of what only the filter may ask (the hold's own answers, the
//    unread changes' and a left-out predicate's), found by the declaration
//    a name resolves to, so through an alias, a destructuring, a line break
//    or a type that only looks like the hold's;
// 2. a condition that joins the answers of two different lanes of the
//    filter, directly or through a local function that returns a lane's
//    answer.
//
// Comments and formatting are not syntax, so neither hides a use nor makes
// one. What the scan does not see: two lanes asked in separate statements
// (`if (a(x)) { if (b(x)) ... }`), and a use behind a computed property
// name.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '../../../../..');
const INTERNAL = path.resolve(__dirname, '../../internal');

/** The filter itself and the two inputs it reads: they ask freely. */
const OWNERS = new Set(['Shown.ts', 'Hidden.ts', 'Unread.ts']);

/** The hold's answers about an item (methods of Hidden). */
const HOLD_ANSWERS = new Set(['hides', 'keeps', 'overlaps', 'runs']);
/** The unread changes' answers about an item (functions of Unread). */
const UNREAD_ANSWERS = new Set(['inserted', 'deleted']);
/** The fields of a view that answer for an item (see Unread). */
const VIEW_ANSWERS = new Set(['removed', 'keeps']);

export interface ShownGuardReport {
  /**
   * Uses of what only the filter may ask, as `File.ts function: what`, one
   * per use, sorted.
   */
  asks: string[];
  /**
   * Conditions that join two different lanes, as
   * `File.ts function: laneA + laneB`, sorted.
   */
  joins: string[];
  /** The lanes found: the exports of Shown that return a boolean. */
  lanes: string[];
}

/** The name of the function, method or class member that holds `node`. */
export function ownerName(node: ts.Node): string {
  const names: string[] = [];
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      (ts.isFunctionDeclaration(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isPropertyDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) ||
        ts.isSetAccessorDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isVariableDeclaration(n)) &&
      n.name !== undefined &&
      ts.isIdentifier(n.name)
    ) {
      // The outermost two: `Class#member`, or a module-level function.
      names.unshift(n.name.text);
    } else if (ts.isConstructorDeclaration(n)) {
      names.unshift('constructor');
    }
  }
  return names.slice(0, 2).join('#') || '(module)';
}

/** The package's internal sources, as the TypeScript compiler reads them. */
export interface InternalSources {
  checker: ts.TypeChecker;
  /** One per file of `src/internal`. */
  sources: ts.SourceFile[];
}

/**
 * Read `src/internal` with the repository's compiler options. `extra` adds
 * or replaces sources by file name, for a guard's own tests.
 */
export function readInternalSources(
  extra: Record<string, string> = {},
): InternalSources {
  const {config} = ts.readConfigFile(
    path.join(ROOT, 'tsconfig.json'),
    ts.sys.readFile,
  );
  const {options} = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  const overlay = new Map(
    Object.entries(extra).map(([name, text]) => [
      path.join(INTERNAL, name),
      text,
    ]),
  );
  const rootNames = [
    ...new Set([
      ...fs
        .readdirSync(INTERNAL)
        .filter(name => name.endsWith('.ts'))
        .map(name => path.join(INTERNAL, name)),
      ...overlay.keys(),
    ]),
  ];
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = name => overlay.get(name) ?? readFile(name);
  host.fileExists = name => overlay.has(name) || fileExists(name);
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const text = overlay.get(name);
    return text === undefined
      ? getSourceFile(name, languageVersion, ...rest)
      : ts.createSourceFile(name, text, languageVersion, true);
  };
  const program = ts.createProgram({host, options, rootNames});
  const checker = program.getTypeChecker();
  const sources = rootNames.map(name => {
    const source = program.getSourceFile(name);
    if (source === undefined) {
      throw new Error(`no source for ${name}`);
    }
    return source;
  });
  return {checker, sources};
}

/**
 * Scan the package's internal sources (see the head of this file). `extra`
 * adds or replaces sources by file name, for the guard's own tests.
 */
export function scanShownGuard(
  extra: Record<string, string> = {},
): ShownGuardReport {
  const {checker, sources} = readInternalSources(extra);
  const fileOf = (node: ts.Node) =>
    path.basename(node.getSourceFile().fileName);
  const inInternal = (node: ts.Node) =>
    path.dirname(node.getSourceFile().fileName) === INTERNAL;

  /** The symbol `node` names, through import and export aliases. */
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  };
  /** A declaration of `symbol` in internal file `file`, if it has one. */
  const declaredIn = (
    symbol: ts.Symbol | undefined,
    file: string,
  ): ts.Declaration | undefined =>
    symbol === undefined || symbol.declarations === undefined
      ? undefined
      : symbol.declarations.find(d => inInternal(d) && fileOf(d) === file);

  const sourceNamed = (file: string): ts.SourceFile => {
    const source = sources.find(s => path.basename(s.fileName) === file);
    if (source === undefined) {
      throw new Error(`no ${file} in src/internal`);
    }
    return source;
  };
  const exportsOf = (file: string): ts.Symbol[] => {
    const moduleSymbol = checker.getSymbolAtLocation(sourceNamed(file));
    return moduleSymbol === undefined
      ? []
      : checker.getExportsOfModule(moduleSymbol);
  };
  const exportNamed = (file: string, name: string): ts.Symbol => {
    const symbol = exportsOf(file).find(s => s.name === name);
    if (symbol === undefined) {
      throw new Error(`${file} does not export ${name}`);
    }
    return symbol;
  };

  // What only the filter may ask, as symbols.
  const hiddenClass = exportNamed('Hidden.ts', 'Hidden');
  const hiddenType = checker.getDeclaredTypeOfSymbol(hiddenClass);
  const leftOutAlias = exportNamed('Shown.ts', 'LeftOut');

  // The lanes: every export of Shown that answers with a boolean.
  const lanes = new Map<ts.Symbol, string>();
  for (const symbol of exportsOf('Shown.ts')) {
    const declaration = symbol.declarations && symbol.declarations[0];
    if (declaration === undefined || !ts.isFunctionDeclaration(declaration)) {
      continue;
    }
    const signature = checker.getSignatureFromDeclaration(declaration);
    if (
      signature !== undefined &&
      (checker.getReturnTypeOfSignature(signature).flags &
        ts.TypeFlags.BooleanLike) !==
        0
    ) {
      lanes.set(symbol, symbol.name);
    }
  }

  const scanned = sources.filter(s => !OWNERS.has(path.basename(s.fileName)));
  const asks: string[] = [];
  const ask = (node: ts.Node, what: string) => {
    asks.push(`${fileOf(node)} ${ownerName(node)}: ${what}`);
  };

  /** Whether `symbol` is declared with the type LeftOut. */
  const isLeftOutValue = (symbol: ts.Symbol | undefined): boolean => {
    if (symbol === undefined) {
      return false;
    }
    if (checker.getTypeOfSymbol(symbol).aliasSymbol === leftOutAlias) {
      return true;
    }
    return (symbol.declarations || []).some(d => {
      const type = (d as {type?: ts.TypeNode}).type;
      return (
        type !== undefined &&
        ts.isTypeReferenceNode(type) &&
        symbolOf(type.typeName) === leftOutAlias
      );
    });
  };

  /** The hold's or a view's answer that member `name` of `type` is, if any. */
  const answerOf = (
    symbol: ts.Symbol | undefined,
    name: string,
    receiver: ts.Type | undefined,
  ): string | null => {
    if (HOLD_ANSWERS.has(name)) {
      if (
        declaredIn(symbol, 'Hidden.ts') !== undefined ||
        declaredIn(symbol, 'Shown.ts') !== undefined
      ) {
        return `the hold's ${name}`;
      }
      // A type that only looks like the hold's (the hold is assignable to
      // it), or one the compiler knows nothing of.
      if (receiver !== undefined) {
        const type = checker.getNonNullableType(receiver);
        if (
          (type.flags & ts.TypeFlags.Any) !== 0 ||
          (declaredIn(symbol, 'Unread.ts') === undefined &&
            checker.isTypeAssignableTo(hiddenType, type))
        ) {
          return `the hold's ${name}`;
        }
      }
    }
    if (
      VIEW_ANSWERS.has(name) &&
      declaredIn(symbol, 'Unread.ts') !== undefined
    ) {
      return `a view's ${name}`;
    }
    return null;
  };

  const visitAsks = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // An import is not a use: the name's uses are found where they are.
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const what = answerOf(
        symbolOf(node.name),
        node.name.text,
        checker.getTypeAtLocation(node.expression),
      );
      if (what !== null) {
        ask(node, what);
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      const receiver = checker.getTypeAtLocation(node.expression);
      const name = node.argumentExpression.text;
      const what = answerOf(
        checker.getPropertyOfType(checker.getNonNullableType(receiver), name),
        name,
        receiver,
      );
      if (what !== null) {
        ask(node, what);
      }
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent)
    ) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
        const receiver = checker.getTypeAtLocation(node.parent);
        const what = answerOf(
          checker.getPropertyOfType(
            checker.getNonNullableType(receiver),
            key.text,
          ),
          key.text,
          receiver,
        );
        if (what !== null) {
          ask(node, what);
        }
      }
    } else if (ts.isIdentifier(node)) {
      const symbol = symbolOf(node);
      if (
        UNREAD_ANSWERS.has(symbol === undefined ? '' : symbol.name) &&
        declaredIn(symbol, 'Unread.ts') !== undefined
      ) {
        ask(node, `the unread changes' ${symbol!.name}`);
      }
    }
    if (
      ts.isCallExpression(node) &&
      isLeftOutValue(symbolOf(node.expression))
    ) {
      ask(node, 'a left-out predicate');
    }
    ts.forEachChild(node, visitAsks);
  };
  scanned.forEach(visitAsks);

  // Conditions that join two lanes. A local function that returns a lane's
  // answer carries that lane (and those of the functions it returns the
  // answers of), so wrapping a lane does not hide it.
  const carried = new Map<ts.Symbol, Set<string>>();
  const isJoin = (node: ts.Node): boolean =>
    (ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) ||
    ts.isConditionalExpression(node);
  const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node);
  /** The lanes the calls of `node` ask, those in nested functions too. */
  const lanesIn = (node: ts.Node, found: Set<string>): Set<string> => {
    if (ts.isCallExpression(node)) {
      const symbol = symbolOf(node.expression);
      if (symbol !== undefined) {
        const lane = lanes.get(symbol);
        if (lane !== undefined) {
          found.add(lane);
        }
        for (const name of carried.get(symbol) || []) {
          found.add(name);
        }
      }
    }
    ts.forEachChild(node, child => {
      lanesIn(child, found);
    });
    return found;
  };
  /** The expressions function `fn` returns. */
  const returned = (fn: ts.FunctionLikeDeclaration): ts.Expression[] => {
    if (fn.body === undefined) {
      return [];
    }
    if (!ts.isBlock(fn.body)) {
      return [fn.body];
    }
    const out: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        return;
      }
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        out.push(node.expression);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    return out;
  };
  /** The lanes whose answer `expression` is: its calls, through `!`, `&&`... */
  const answerLanes = (expression: ts.Expression, found: Set<string>): void => {
    let e = expression;
    while (
      ts.isParenthesizedExpression(e) ||
      (ts.isPrefixUnaryExpression(e) &&
        e.operator === ts.SyntaxKind.ExclamationToken)
    ) {
      e =
        e.kind === ts.SyntaxKind.ParenthesizedExpression
          ? (e as ts.ParenthesizedExpression).expression
          : (e as ts.PrefixUnaryExpression).operand;
    }
    if (ts.isBinaryExpression(e) && isJoin(e)) {
      answerLanes(e.left, found);
      answerLanes(e.right, found);
    } else if (ts.isConditionalExpression(e)) {
      answerLanes(e.condition, found);
      answerLanes(e.whenTrue, found);
      answerLanes(e.whenFalse, found);
    } else if (ts.isCallExpression(e)) {
      const symbol = symbolOf(e.expression);
      if (symbol !== undefined) {
        const lane = lanes.get(symbol);
        if (lane !== undefined) {
          found.add(lane);
        }
        for (const name of carried.get(symbol) || []) {
          found.add(name);
        }
      }
    }
  };
  const functions: [ts.Symbol, ts.FunctionLikeDeclaration][] = [];
  const collect = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const named =
        node.name !== undefined
          ? node.name
          : ts.isVariableDeclaration(node.parent) ||
              ts.isPropertyDeclaration(node.parent)
            ? node.parent.name
            : undefined;
      const symbol = named === undefined ? undefined : symbolOf(named);
      if (symbol !== undefined) {
        functions.push([symbol, node]);
      }
    }
    ts.forEachChild(node, collect);
  };
  scanned.forEach(collect);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [symbol, fn] of functions) {
      const found = new Set<string>();
      for (const expression of returned(fn)) {
        answerLanes(expression, found);
      }
      const known = carried.get(symbol);
      if (found.size > (known === undefined ? 0 : known.size)) {
        carried.set(symbol, found);
        changed = true;
      }
    }
  }
  const joins: string[] = [];
  const visitJoins = (node: ts.Node): void => {
    if (isJoin(node)) {
      const found = [...lanesIn(node, new Set())].sort();
      if (found.length > 1) {
        joins.push(`${fileOf(node)} ${ownerName(node)}: ${found.join(' + ')}`);
      }
      // The outermost condition only: its parts are in it.
      return;
    }
    ts.forEachChild(node, visitJoins);
  };
  scanned.forEach(visitJoins);

  return {
    asks: asks.sort(),
    joins: joins.sort(),
    lanes: [...lanes.values()].sort(),
  };
}
