/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The runtime guard on the Yjs @lexical/y runs against (YjsContract): the
// contract lists match what the sources use of @y/y, the supported version
// is the exact peer dependency, a matching @y/y passes, and a different one
// (a missing export, member or event, a changed arity, a document from
// another copy) is refused with a typed error before anything is written,
// by every entry point. The check runs once per module.

import * as Y from '@y/y';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {afterEach, describe, expect, expectTypeOf, test, vi} from 'vitest';

import {
  SUPPORTED_YJS_VERSION,
  UNSUPPORTED_YJS_ERROR,
  type YUnsupportedYjsData,
  YUnsupportedYjsError,
} from '../..';
import {
  probeYjs,
  YJS_EVENTS,
  YJS_EXPORTS,
  yjsMembers,
} from '../../internal/YjsContract';

const PACKAGE_DIR = path.resolve(__dirname, '../../..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src');
const REPO_DIR = path.resolve(PACKAGE_DIR, '../..');

function readJson(file: string): Record<string, Record<string, string>> {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('the supported version', () => {
  test('is the exact @y/y peer dependency, the dev dependency and the installed @y/y', () => {
    const pkg = readJson(path.join(PACKAGE_DIR, 'package.json'));
    const installed = readJson(
      path.join(PACKAGE_DIR, 'node_modules/@y/y/package.json'),
    );
    // A mismatch with package.json: run `pnpm run update-version`, which
    // regenerates src/internal/SupportedYjs.ts.
    expect(SUPPORTED_YJS_VERSION).toBe(pkg.peerDependencies['@y/y']);
    expect(pkg.devDependencies['@y/y']).toBe(SUPPORTED_YJS_VERSION);
    expect(installed.version).toBe(SUPPORTED_YJS_VERSION);
    // The playground pins @y/y on its own: a bump updates it too, or its
    // document and its provider would load two copies.
    const playground = readJson(
      path.join(REPO_DIR, 'packages/lexical-playground/package.json'),
    );
    expect(playground.dependencies['@y/y']).toBe(SUPPORTED_YJS_VERSION);
    expect(SUPPORTED_YJS_VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});

/**
 * A program over `files` in which the types @y/y's declarations name
 * without importing them (`Transaction#doc: Doc`, `RelativePosition#item:
 * ID | null`: the reason apps need `skipLibCheck`) resolve, so that values
 * of those types are not `any` and their members are seen. The names are
 * declared as globals in a virtual file, for this test only.
 */
function programWithResolvedYjsTypes(
  files: string[],
  options: ts.CompilerOptions,
  yDir: string,
): ts.Program {
  const base = {...options, noEmit: true};
  // skipLibCheck would hide the missing names.
  const first = ts.createProgram(files, {...base, skipLibCheck: false});
  const inYDir = (sf: ts.SourceFile) =>
    fs.realpathSync(sf.fileName).startsWith(yDir);
  const missing = new Set<string>();
  for (const sf of first.getSourceFiles()) {
    if (inYDir(sf)) {
      for (const d of first.getSemanticDiagnostics(sf)) {
        const m = ts
          .flattenDiagnosticMessageText(d.messageText, '\n')
          .match(/^Cannot find name '(\w+)'/);
        if (m) {
          missing.add(m[1]);
        }
      }
    }
  }
  // Where @y/y declares each missing name, and how many type parameters
  // it takes.
  const declared = new Map<string, {file: string; params: number}>();
  for (const sf of first.getSourceFiles()) {
    if (!inYDir(sf)) {
      continue;
    }
    for (const statement of sf.statements) {
      if (
        (ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.name &&
        missing.has(statement.name.text) &&
        !declared.has(statement.name.text) &&
        (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) !== 0
      ) {
        declared.set(statement.name.text, {
          file: sf.fileName.replace(/\.d\.ts$/, ''),
          params: statement.typeParameters
            ? statement.typeParameters.length
            : 0,
        });
      }
    }
  }
  const lines = [...declared].map(([name, {file, params}]) => {
    const args = Array.from({length: params}, (_, i) => `T${i}`);
    const formal = args.map(a => `${a} = any`).join(', ');
    return params === 0
      ? `  type ${name} = import(${JSON.stringify(file)}).${name};`
      : `  type ${name}<${formal}> = import(${JSON.stringify(file)}).${name}<${args.join(', ')}>;`;
  });
  const virtual = path.join(PACKAGE_DIR, '__yjs_contract_globals__.d.ts');
  const text = `export {};\ndeclare global {\n${lines.join('\n')}\n}\n`;
  const host = ts.createCompilerHost(base);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === virtual
      ? ts.createSourceFile(fileName, text, languageVersion)
      : getSourceFile(fileName, languageVersion, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = fileName => fileName === virtual || fileExists(fileName);
  return ts.createProgram([...files, virtual], base, host, first);
}

/**
 * Everything the package's sources (not tests) use of @y/y, as the
 * TypeScript checker resolves it: `import X` for value imports, `new X`,
 * `Owner#member` for a member read or called on a value whose type @y/y
 * declares (or a member @y/y declares), destructured fields and option
 * properties, and `Owner@event` for an `on`/`off`/`once` event name.
 * Anonymous types are named by their declaration in @y/y
 * (`decodeUpdate#structs`).
 */
function inventory(): Map<string, Set<string>> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('__')) {
          walk(p);
        }
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.(test|bench)\.tsx?$/.test(entry.name) &&
        // The contract's own probe is not a use.
        entry.name !== 'YjsContract.ts'
      ) {
        files.push(p);
      }
    }
  };
  walk(SRC_DIR);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(REPO_DIR, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: d => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (parsed === undefined) {
    throw new Error('tsconfig.json did not parse');
  }
  const yDir = fs.realpathSync(path.join(PACKAGE_DIR, 'node_modules/@y/y'));
  const program = programWithResolvedYjsTypes(files, parsed.options, yDir);
  const checker = program.getTypeChecker();
  const inY = (decl: ts.Node) =>
    fs.realpathSync(decl.getSourceFile().fileName).startsWith(yDir);
  const nameOf = (decl: ts.Node): string => {
    const parts: string[] = [];
    for (let p: ts.Node | undefined = decl; p && !ts.isSourceFile(p); ) {
      const name = (p as {name?: ts.Node}).name;
      if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
        parts.unshift(name.text);
        if (parts.length === 2) {
          break;
        }
      }
      p = p.parent;
    }
    return parts.join('.') || '?';
  };
  // The @y/y types a value's type is or extends: through unions,
  // intersections, type parameters' constraints and the base types of a
  // local interface or class (`YDoc extends Doc` is a `Doc`).
  const owners = (type: ts.Type, seen = new Set<ts.Type>()): string[] => {
    if (seen.has(type)) {
      return [];
    }
    seen.add(type);
    if (type.isUnionOrIntersection()) {
      return type.types.flatMap(t => owners(t, seen));
    }
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint ? owners(constraint, seen) : [];
    }
    const symbol = type.aliasSymbol || type.getSymbol();
    const decl = symbol && symbol.declarations && symbol.declarations[0];
    if (symbol && decl && inY(decl)) {
      return [
        symbol.name === '__type' || symbol.name === '__object'
          ? nameOf(decl)
          : symbol.name,
      ];
    }
    if (
      symbol &&
      type.flags & ts.TypeFlags.Object &&
      (type as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface
    ) {
      return (checker.getBaseTypes(type as ts.InterfaceType) || []).flatMap(t =>
        owners(t, seen),
      );
    }
    return [];
  };
  // Whether `node` is (an expression whose root is) a value @y/y declares:
  // a member access on such a value.
  const fromY = (node: ts.Expression): boolean => {
    if (owners(checker.getTypeAtLocation(node)).length > 0) {
      return true;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      const decl = symbol && symbol.declarations && symbol.declarations[0];
      return (decl !== undefined && inY(decl)) || fromY(node.expression);
    }
    return false;
  };
  // Whether `node`, typed `any`, holds a value from @y/y: a member @y/y
  // declares (`tr.doc`, whose declared type does not resolve), a call of a
  // method @y/y declares, an untyped local initialized from either, or an
  // untyped parameter of a callback given to a method of a value from @y/y
  // (`tr.changed.forEach((subs, type) => ...)`).
  const fromYUntyped = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
      return fromYUntyped(node.expression);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      const decl = symbol && symbol.declarations && symbol.declarations[0];
      return decl !== undefined && inY(decl);
    }
    if (ts.isCallExpression(node)) {
      return (
        ts.isPropertyAccessExpression(node.expression) &&
        (fromYUntyped(node.expression) || fromY(node.expression.expression))
      );
    }
    if (!ts.isIdentifier(node)) {
      return false;
    }
    const symbol = checker.getSymbolAtLocation(node);
    const decl = symbol && symbol.valueDeclaration;
    if (!decl) {
      return false;
    }
    if (ts.isVariableDeclaration(decl)) {
      return (
        !decl.type &&
        decl.initializer !== undefined &&
        (fromYUntyped(decl.initializer) || fromY(decl.initializer))
      );
    }
    if (ts.isParameter(decl) && !decl.type) {
      const fn = decl.parent;
      const call = fn.parent;
      return (
        (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        fromY(call.expression.expression)
      );
    }
    return false;
  };
  const uses = new Map<string, Set<string>>();
  const add = (key: string, file: string) => {
    const where = uses.get(key) || new Set<string>();
    where.add(path.relative(SRC_DIR, file));
    uses.set(key, where);
  };
  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) {
      throw new Error(`not in the program: ${file}`);
    }
    const visit = (n: ts.Node) => {
      let receiver: ts.Expression | undefined;
      let nameNode: ts.Node | undefined;
      let name = '';
      if (ts.isPropertyAccessExpression(n)) {
        receiver = n.expression;
        nameNode = n.name;
        name = n.name.text;
      } else if (
        ts.isElementAccessExpression(n) &&
        ts.isStringLiteral(n.argumentExpression)
      ) {
        receiver = n.expression;
        nameNode = n.argumentExpression;
        name = n.argumentExpression.text;
      }
      if (
        receiver &&
        checker.getTypeAtLocation(receiver).flags & ts.TypeFlags.Any &&
        fromYUntyped(receiver)
      ) {
        // A value from @y/y whose type does not resolve (`any`): its
        // members would escape the inventory. Type it.
        const {line} = sourceFile.getLineAndCharacterOfPosition(
          receiver.getStart(),
        );
        add(
          `untyped @y/y value '${receiver.getText()}' at line ${line + 1}`,
          file,
        );
      }
      if (receiver && nameNode) {
        const of = owners(
          checker.getNonNullableType(checker.getTypeAtLocation(receiver)),
        );
        const symbol = checker.getSymbolAtLocation(nameNode);
        const decl = symbol && symbol.declarations && symbol.declarations[0];
        if (of.length > 0) {
          of.forEach(o => add(`${o}#${name}`, file));
        } else if (decl && inY(decl)) {
          add(`${nameOf(decl.parent)}#${name}`, file);
        }
        const call = n.parent;
        if (
          of.length > 0 &&
          (name === 'on' || name === 'off' || name === 'once') &&
          ts.isCallExpression(call) &&
          call.arguments.length > 0 &&
          ts.isStringLiteral(call.arguments[0])
        ) {
          const event = (call.arguments[0] as ts.StringLiteral).text;
          of.forEach(o => add(`${o}@${event}`, file));
        }
      }
      if (ts.isObjectBindingPattern(n)) {
        const of = owners(
          checker.getNonNullableType(checker.getTypeAtLocation(n)),
        );
        for (const element of n.elements) {
          const prop = element.propertyName || element.name;
          if (ts.isIdentifier(prop)) {
            of.forEach(o => add(`${o}#${prop.text}`, file));
          }
        }
      }
      if (ts.isObjectLiteralExpression(n)) {
        const contextual = checker.getContextualType(n);
        if (contextual) {
          const type = checker.getApparentType(
            checker.getNonNullableType(contextual),
          );
          for (const p of n.properties) {
            if (p.name && ts.isIdentifier(p.name)) {
              const prop = checker.getPropertyOfType(type, p.name.text);
              const decl = prop && prop.declarations && prop.declarations[0];
              if (decl && inY(decl)) {
                add(`${nameOf(decl.parent)}#${p.name.text}`, file);
              }
            }
          }
        }
      }
      if (ts.isNewExpression(n)) {
        let symbol = checker.getSymbolAtLocation(n.expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol);
        }
        const decl = symbol && symbol.declarations && symbol.declarations[0];
        if (symbol && decl && inY(decl)) {
          add(`new ${symbol.name}`, file);
        }
      }
      if (
        ts.isImportDeclaration(n) &&
        ts.isStringLiteral(n.moduleSpecifier) &&
        n.moduleSpecifier.text === '@y/y' &&
        n.importClause &&
        !n.importClause.isTypeOnly
      ) {
        const bindings = n.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly) {
              add(
                `import ${(element.propertyName || element.name).text}`,
                file,
              );
            }
          }
        } else if (bindings) {
          add('import * (a namespace import: name each export)', file);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sourceFile);
  }
  return uses;
}

describe('the contract', () => {
  // Type-checks the package's sources: about 1.5 s alone, more under load.
  test('lists exactly what the sources use of @y/y', {timeout: 60_000}, () => {
    const uses = inventory();
    // `YNode` is the class @y/y exports as `Node`.
    const exportName = (name: string) => (name === 'YNode' ? 'Node' : name);
    const used = new Set<string>();
    for (const key of uses.keys()) {
      if (key.startsWith('import ')) {
        used.add(`export ${exportName(key.slice(7))}`);
      } else if (key.startsWith('new ')) {
        used.add(`export ${exportName(key.slice(4))}`);
      } else {
        used.add(key);
      }
    }
    const listed = new Set<string>([
      ...YJS_EXPORTS.map(name => `export ${name}`),
      ...Object.entries(yjsMembers()).flatMap(([owner, members]) =>
        Object.keys(members).map(m => `${owner}#${m}`),
      ),
      ...Object.entries(YJS_EVENTS).flatMap(([owner, events]) =>
        events.map(e => `${owner}@${e}`),
      ),
    ]);
    const where = (key: string) => {
      const files =
        uses.get(key) || uses.get(key.replace('export ', 'import '));
      return files ? ` (${[...files].join(', ')})` : '';
    };
    // Used but not in the contract: add it to the lists in
    // src/internal/YjsContract.ts (its arity for an export), so the runtime
    // check probes it. Listed but no longer used: remove it.
    expect({
      listedButUnused: [...listed].filter(k => !used.has(k)).sort(),
      usedButNotListed: [...used]
        .filter(k => !listed.has(k))
        .sort()
        .map(k => k + where(k)),
    }).toEqual({listedButUnused: [], usedButNotListed: []});
  });

  test('the installed @y/y passes the probe', () => {
    expect(probeYjs()).toEqual([]);
  });

  test('content classes are told apart by identity, not name', () => {
    // A minifier can give every class the same name.
    const classes = [
      Y.ContentAny,
      Y.ContentBinary,
      Y.ContentFormat,
      Y.ContentString,
      Y.ContentType,
    ];
    const names = classes.map(klass =>
      Object.getOwnPropertyDescriptor(klass, 'name'),
    );
    const proto = Y.ContentAny.prototype as {getContent?: unknown};
    const getContent = proto.getContent;
    classes.forEach(klass =>
      Object.defineProperty(klass, 'name', {configurable: true, value: 'e'}),
    );
    proto.getContent = undefined;
    try {
      expect(probeYjs()).toEqual(['AbstractContent(e)#getContent']);
    } finally {
      proto.getContent = getContent;
      classes.forEach((klass, i) =>
        Object.defineProperty(klass, 'name', names[i]!),
      );
    }
    expect(probeYjs()).toEqual([]);
  });

  test('the check runs in another realm than @y/y', async () => {
    // As a VM-pool test runner or an embedder does: @lexical/y evaluated in
    // a realm of its own (its own Map, Uint8Array), @y/y loaded by the host.
    const esbuild = await import('esbuild');
    const {outputFiles} = await esbuild.build({
      bundle: true,
      entryPoints: [path.join(SRC_DIR, 'internal/YjsContract.ts')],
      external: ['@y/y'],
      format: 'cjs',
      platform: 'neutral',
      write: false,
    });
    const context = vm.createContext({});
    expect(vm.runInContext('Map', context)).not.toBe(Map);
    const module = {exports: {} as {probeYjs: () => string[]}};
    vm.runInContext(
      `(function (module, exports, require) {${outputFiles[0].text}\n})`,
      context,
    )(module, module.exports, (id: string) => {
      expect(id).toBe('@y/y');
      return Y;
    });
    expect(module.exports.probeYjs()).toEqual([]);
  });

  test('every kind of content is checked, attribute values included', () => {
    const proto = Y.ContentAny.prototype as {getContent?: unknown};
    const getContent = proto.getContent;
    proto.getContent = undefined;
    try {
      expect(probeYjs()).toEqual([
        expect.stringMatching(/^AbstractContent\(\w*ContentAny\)#getContent$/),
      ]);
    } finally {
      proto.getContent = getContent;
    }
    expect(probeYjs()).toEqual([]);
  });
});

describe('the error', () => {
  test('is typed data with a short message that names the fix', () => {
    expectTypeOf<YUnsupportedYjsData>().toEqualTypeOf<{
      readonly supported: string;
      readonly found: readonly string[];
      readonly reason: 'changed-internals' | 'other-copy';
    }>();
    const error = new YUnsupportedYjsError({
      found: ['Item#parentSub'],
      reason: 'changed-internals',
      supported: SUPPORTED_YJS_VERSION,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('YUnsupportedYjsError');
    expect(error.code).toBe(UNSUPPORTED_YJS_ERROR);
    expect(error.message).toBe(
      `@lexical/y supports exactly @y/y ${SUPPORTED_YJS_VERSION}, and the @y/y the app loaded differs (Item#parentSub). Install @y/y@${SUPPORTED_YJS_VERSION}, once per app.`,
    );
  });
});

type YModule = typeof Y;

/**
 * Load @lexical/y (and its headless entry) afresh against a @y/y changed by
 * `change`, as an app that installed another version would.
 */
async function loadWith(change: (y: YModule) => Partial<YModule>) {
  vi.resetModules();
  vi.doMock('@y/y', async importOriginal => {
    const y = await importOriginal<YModule>();
    return {...y, ...change(y)};
  });
  const y = await import('@y/y');
  const lexical = await import('lexical');
  const extension = await import('@lexical/extension');
  const lexicalY = await import('../..');
  const headless = await import('../../headless');
  const contract = await import('../../internal/YjsContract');
  return {contract, extension, headless, lexical, lexicalY, y};
}

afterEach(() => {
  vi.doUnmock('@y/y');
  vi.resetModules();
});

const config = {schemaVersion: 1};

function seeded(): Uint8Array {
  // A stored state, made with the installed @y/y before any change.
  const doc = new Y.Doc();
  doc.cleanupFormatting = false;
  doc.get('root').insert(0, 'stored');
  return Y.encodeStateAsUpdate(doc);
}

/** A copy of `Base` that keeps its arity (`Function#length`). */
function sameArity<T extends {length: number}>(Base: T, Derived: T): T {
  Object.defineProperty(Derived, 'length', {value: Base.length});
  return Derived;
}

const CHANGES: [string, (y: YModule) => Partial<YModule>, string[]][] = [
  [
    'a missing export',
    () => ({
      getItemCleanStart: undefined as unknown as YModule['getItemCleanStart'],
    }),
    ['getItemCleanStart'],
  ],
  [
    'an emptied method',
    y => ({
      UndoManager: sameArity(
        y.UndoManager,
        class extends y.UndoManager {
          constructor(...args: ConstructorParameters<YModule['UndoManager']>) {
            super(...args);
            (this as {canRedo?: unknown}).canRedo = undefined;
          }
        },
      ),
    }),
    ['UndoManager#canRedo'],
  ],
  [
    'a field that is null',
    y => ({
      decodeUpdate: ((update: Uint8Array) => ({
        ...y.decodeUpdate(update),
        ds: null,
      })) as unknown as YModule['decodeUpdate'],
    }),
    ['decodeUpdate#ds'],
  ],
  [
    'a missing member',
    y => ({
      Doc: sameArity(
        y.Doc,
        class extends y.Doc {
          constructor(...args: ConstructorParameters<YModule['Doc']>) {
            super(...args);
            delete (this as {_transactionCleanups?: unknown})
              ._transactionCleanups;
          }
        },
      ),
    }),
    ['Doc#_transactionCleanups'],
  ],
  [
    'a renamed field the probe assigns',
    y => ({
      Doc: sameArity(
        y.Doc,
        class extends y.Doc {
          constructor(...args: ConstructorParameters<YModule['Doc']>) {
            super(...args);
            const self = this as {
              cleanupFormatting?: boolean;
              cleanupFormattingRenamed?: boolean;
            };
            self.cleanupFormattingRenamed = self.cleanupFormatting;
            delete self.cleanupFormatting;
          }
        },
      ),
    }),
    ['Doc#cleanupFormatting'],
  ],
  [
    'a missing event',
    y => ({
      UndoManager: sameArity(
        y.UndoManager,
        class extends y.UndoManager {
          emit(name: string, args: unknown[]) {
            if (name !== 'stack-cleared') {
              super.emit(name as 'stack-cleared', args as never);
            }
          }
        },
      ),
    }),
    ['UndoManager@stack-cleared'],
  ],
];

describe.each(CHANGES)('with %s', (_, change, found) => {
  // Each change is named in `found`; what it then breaks may follow.
  const expected = {
    data: {
      found: expect.arrayContaining(found),
      reason: 'changed-internals',
      supported: SUPPORTED_YJS_VERSION,
    },
  };

  test('createYDoc throws before it makes or loads a document', async () => {
    const {lexicalY} = await loadWith(change);
    const state = seeded();
    const before = new Uint8Array(state);
    let thrown: unknown;
    try {
      lexicalY.createYDoc(state);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lexicalY.YUnsupportedYjsError);
    expect(thrown).toMatchObject(expected);
    expect(state).toEqual(before);
  });

  test('YBinding and YCollabExtension throw before writing to the document', async () => {
    const {extension, lexicalY} = await loadWith(change);
    // A document of the installed @y/y holding a stored state, as the
    // app's provider would have loaded it: nothing reaches it.
    const doc = new Y.Doc();
    doc.cleanupFormatting = false;
    Y.applyUpdate(doc, seeded());
    const before = Y.encodeStateAsUpdate(doc);
    const shared = doc.share.size;
    const ydoc = doc as unknown as ReturnType<typeof lexicalY.createYDoc>;
    const editor = extension.buildEditorFromExtensions(
      extension.defineExtension({name: '@lexical/y/test/yjs-contract'}),
    );
    expect(() => new lexicalY.YBinding(editor, ydoc, config)).toThrow(
      expect.objectContaining(expected),
    );
    let thrown: unknown;
    try {
      extension.buildEditorFromExtensions(
        extension.defineExtension({
          dependencies: [
            extension.configExtension(lexicalY.YCollabExtension, {
              doc: ydoc,
              schemaVersion: 1,
            }),
          ],
          name: '@lexical/y/test/yjs-contract-extension',
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(lexicalY.YUnsupportedYjsError);
    expect(thrown).toMatchObject(expected);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.share.size).toBe(shared);
  });

  test('the headless helpers throw before building the editor', async () => {
    const {extension, headless, lexical, lexicalY} = await loadWith(change);
    const state = seeded();
    const before = new Uint8Array(state);
    const $build = () => {
      lexical.$getRoot().append(lexical.$createParagraphNode());
    };
    const built = {build: 0, register: 0};
    const counted = {
      extensions: [
        extension.defineExtension({
          build: () => {
            built.build++;
          },
          name: '@lexical/y/test/yjs-contract-counted',
          register: () => {
            built.register++;
            return () => {};
          },
        }),
      ],
      schemaVersion: 1,
    };
    expect(headless.YUnsupportedYjsError).toBe(lexicalY.YUnsupportedYjsError);
    for (const call of [
      () => headless.seedYState(counted, $build),
      () => headless.readYState(state, counted, () => null),
      () => headless.editYState(state, counted, $build, {writer: null}),
    ]) {
      expect(call).toThrow(lexicalY.YUnsupportedYjsError);
      expect(call).toThrow(expect.objectContaining(expected));
    }
    expect(state).toEqual(before);
    expect(built).toEqual({build: 0, register: 0});
  });

  test('the check runs once per module', async () => {
    const {contract, lexicalY} = await loadWith(change);
    expect(contract.getYjsProbeRuns()).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect(() => lexicalY.createYDoc()).toThrow(
        lexicalY.YUnsupportedYjsError,
      );
    }
    expect(contract.getYjsProbeRuns()).toBe(1);
  });

  test("the error's data cannot change the verdict", async () => {
    const {lexicalY} = await loadWith(change);
    let first: InstanceType<typeof lexicalY.YUnsupportedYjsError> | null = null;
    try {
      lexicalY.createYDoc();
    } catch (error) {
      first = error as InstanceType<typeof lexicalY.YUnsupportedYjsError>;
    }
    expect(first).not.toBe(null);
    expect(Object.isFrozen(first!.data)).toBe(true);
    expect(() => {
      (first!.data.found as string[]).length = 0;
    }).toThrow(TypeError);
    expect(() => lexicalY.createYDoc()).toThrow(
      expect.objectContaining(expected),
    );
  });
});

describe('with the supported @y/y', () => {
  test('every entry point works, and the check runs once', async () => {
    const {contract, extension, headless, lexical, lexicalY} = await loadWith(
      () => ({}),
    );
    const {$createParagraphNode, $createTextNode, $getRoot} = lexical;
    expect(contract.getYjsProbeRuns()).toBe(0);
    const state = headless.seedYState(config, () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('hello')),
      );
    });
    expect(
      headless.readYState(state, config, () => $getRoot().getTextContent()),
    ).toBe('hello');
    const {state: next} = headless.editYState(
      state,
      config,
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('world')),
        );
      },
      {writer: null},
    );
    expect(
      headless.readYState(next, config, () => $getRoot().getTextContent()),
    ).toBe('hello\n\nworld');
    const doc = lexicalY.createYDoc(next);
    const editor = extension.buildEditorFromExtensions(
      extension.defineExtension({
        dependencies: [
          extension.configExtension(lexicalY.YCollabExtension, {
            doc,
            schemaVersion: 1,
          }),
        ],
        name: '@lexical/y/test/yjs-contract-ok',
      }),
    );
    expect(editor.read(() => $getRoot().getTextContent())).toBe(
      'hello\n\nworld',
    );
    editor.dispose();
    expect(contract.getYjsProbeRuns()).toBe(1);
  });

  test('a build that changes arities or renames properties consistently passes', async () => {
    // Transpilers change Function#length (Babel's default and destructured
    // parameters); the check does not compare arities.
    const {contract} = await loadWith(y => ({
      Doc: Object.defineProperty(class extends y.Doc {}, 'length', {
        value: 1,
      }) as unknown as YModule['Doc'],
      findIndexSS: ((...args: Parameters<YModule['findIndexSS']>) =>
        y.findIndexSS(...args)) as unknown as YModule['findIndexSS'],
    }));
    expect(contract.probeYjs()).toEqual([]);
  });

  test('a @y/y whose collections come from another realm passes', async () => {
    // As when @y/y is loaded in a VM context: its Maps are not this realm's.
    const OtherMap = vm.runInNewContext('Map') as MapConstructor;
    const {contract} = await loadWith(y => ({
      Doc: Object.defineProperty(
        class extends y.Doc {
          constructor(...args: ConstructorParameters<YModule['Doc']>) {
            super(...args);
            this.share = new OtherMap(this.share);
          }
        },
        'length',
        {value: y.Doc.length},
      ) as unknown as YModule['Doc'],
    }));
    expect(contract.probeYjs()).toEqual([]);
  });

  test('a document or root from another copy of @y/y is refused', async () => {
    const {extension, lexicalY} = await loadWith(() => ({}));
    const editor = extension.buildEditorFromExtensions(
      extension.defineExtension({name: '@lexical/y/test/yjs-contract-copy'}),
    );
    // Stand-ins for another copy's classes: not instances of the ones
    // @lexical/y loaded.
    const other = {clientID: 1} as unknown as ReturnType<
      typeof lexicalY.createYDoc
    >;
    expect(() => new lexicalY.YBinding(editor, other, config)).toThrow(
      expect.objectContaining({
        data: {
          found: ['Y.Doc'],
          reason: 'other-copy',
          supported: SUPPORTED_YJS_VERSION,
        },
        message: `@lexical/y: the Y.Doc comes from another copy of @y/y than the one @lexical/y loaded. Install @y/y@${SUPPORTED_YJS_VERSION} once per app and create the document with createYDoc.`,
      }),
    );
    const doc = lexicalY.createYDoc();
    expect(
      () =>
        new lexicalY.YBinding(editor, doc, {
          root: {} as unknown as Y.Node,
          schemaVersion: 1,
        }),
    ).toThrow(
      expect.objectContaining({
        data: expect.objectContaining({found: ['Y.Node (the root)']}),
      }),
    );
    expect(doc.share.size).toBe(0);
  });
});
