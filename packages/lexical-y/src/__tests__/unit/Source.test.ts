/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import {expect, test} from 'vitest';

import * as mainEntry from '../..';
import * as headlessEntry from '../../headless';
import {STEP_LOADERS} from '../../internal/StepLoaders';
import {PUBLISHED_STEPS} from '../../internal/StepTable';
import * as migrateEntry from '../../migrate';
import * as step1to2Entry from '../../migrate/1to2';
import * as step2to3Entry from '../../migrate/2to3';
import * as offlineEntry from '../../offline';
import * as serverEntry from '../../server';

// Bundlers replace only process.env.NODE_ENV: any other process.env read in
// shipped source throws "process is not defined" in a browser.
test('shipped source reads no process.env but NODE_ENV', () => {
  const src = path.resolve(__dirname, '../..');
  const offenders: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') {
          visit(p);
        }
      } else if (/\.tsx?$/.test(entry.name)) {
        const text = fs.readFileSync(p, 'utf8');
        for (const m of text.matchAll(/process\.env\.(\w+)/g)) {
          if (m[1] !== 'NODE_ENV') {
            offenders.push(`${path.relative(src, p)}: process.env.${m[1]}`);
          }
        }
      }
    }
  };
  visit(src);
  expect(offenders).toEqual([]);
});

// A binding writes node attributes through Seen (setAttr, deleteAttr): while
// a remote change waits to be read, those write where the binding's editor
// sees the document. Written raw, an attribute is set where Yjs has it now,
// and the write brings back what that change deleted. The root's records
// (the layout and schema versions written, and the pinned storage of a
// type) are written raw: they are not content the editor shows. The scan is
// syntactic (the TypeScript AST of each internal module): it lists every
// use of a Y.Node method that writes attributes (`setAttr`, `deleteAttr`,
// `clearAttrs`, `applyDelta`), called or not, and every call shaped like
// Y.Node's `delete(index, length)` or `format(index, length, attrs)`, by
// the function it is in and its first argument.
test('internal writes of node attributes go through Seen', () => {
  const ATTR_WRITES = new Set([
    'setAttr',
    'deleteAttr',
    'clearAttrs',
    'applyDelta',
  ]);
  const dir = path.resolve(__dirname, '../../internal');
  const found: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    // YjsContract.ts and YjsMigrationContract.ts probe @y/y on scratch
    // documents of their own, and the migration runner (Runner.ts) and the
    // server helpers (Server.ts) write observer-free copies of their own,
    // never a document a binding reads, so their writes have no Seen record
    // to keep.
    if (
      !name.endsWith('.ts') ||
      name === 'Seen.ts' ||
      name === 'YjsContract.ts' ||
      name === 'YjsMigrationContract.ts' ||
      name === 'Runner.ts' ||
      name === 'Server.ts'
    ) {
      continue;
    }
    const file = ts.createSourceFile(
      name,
      fs.readFileSync(path.join(dir, name), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const where = (node: ts.Node): string => {
      for (let n: ts.Node | undefined = node; n; n = n.parent) {
        if (
          (ts.isFunctionDeclaration(n) ||
            ts.isMethodDeclaration(n) ||
            ts.isPropertyDeclaration(n)) &&
          n.name !== undefined
        ) {
          return n.name.getText(file);
        }
      }
      return '(module)';
    };
    const visit = (node: ts.Node) => {
      let method: string | null = null;
      if (ts.isPropertyAccessExpression(node)) {
        method = node.name.text;
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        method = node.argumentExpression.text;
      } else if (ts.isBindingElement(node)) {
        const key = node.propertyName ?? node.name;
        const text =
          ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : '';
        if (ATTR_WRITES.has(text)) {
          found.push(`${name} ${where(node)}: {${text}} (destructured)`);
        }
      }
      if (method !== null) {
        let callee: ts.Node = node;
        while (ts.isParenthesizedExpression(callee.parent)) {
          callee = callee.parent;
        }
        const call =
          ts.isCallExpression(callee.parent) &&
          callee.parent.expression === callee
            ? callee.parent
            : null;
        const args = call === null ? null : call.arguments;
        if (
          ATTR_WRITES.has(method) ||
          (method === 'delete' && args !== null && args.length === 2) ||
          (method === 'format' && args !== null && args.length === 3)
        ) {
          const receiver = (
            node as ts.PropertyAccessExpression | ts.ElementAccessExpression
          ).expression.getText(file);
          const first =
            args === null
              ? '(not called)'
              : args.length === 0
                ? ''
                : args[0].getText(file);
          found.push(`${name} ${where(node)}: ${receiver}.${method}(${first})`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(found).toEqual([
    'Binding.ts recordSchema: root.setAttr(key)',
    'Binding.ts recordLayout: root.setAttr(key)',
    'Binding.ts $writeInitial: root.setAttr(LAYOUT_PREFIX + BASE_LAYOUT_VERSION)',
    'Binding.ts $writeInitial: root.setAttr(SCHEMA_PREFIX + this.options.schemaVersion)',
    'Binding.ts recordPins: root.setAttr(PIN_PREFIX + type)',
    'Ident.ts writeIdentityRecord: root.setAttr(LAYOUT_PREFIX + IDENTITY_LAYOUT_VERSION)',
  ]);
});

// The constants a client or server may want come from the main entry, with
// `createYDoc`, the document every client binds and a relay loads a state
// into (also exported by `@lexical/y/headless`, for servers that import only
// that entry). `@lexical/y/server` exports its own Yjs-only `createYDoc`,
// for relays (format cleanup off, nothing the binding adds).
// `@lexical/y/headless` is plain functions (`createYWriter` makes the writer
// `editYState` requires), plus its warning codes. Layout migrations (D102):
// `@lexical/y/migrate` (the runner), one frozen step per layout
// (`@lexical/y/migrate/<n>to<n+1>`, a default export), and
// `@lexical/y/server` (the authority's side of the fence).
// `@lexical/y/offline`: the local store and the offline session.
test('public entries', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'),
  ) as {exports: Record<string, unknown>};
  expect(Object.keys(pkg.exports).sort()).toEqual([
    '.',
    './headless',
    './headless.js',
    './migrate',
    './migrate.js',
    './migrate/1to2',
    './migrate/1to2.js',
    './migrate/2to3',
    './migrate/2to3.js',
    './offline',
    './offline.js',
    './server',
    './server.js',
  ]);
  expect(Object.keys(migrateEntry).sort()).toEqual([
    'YMigrationError',
    'getYLayoutInfo',
    'loadYMigrationSteps',
    'migrateYState',
  ]);
  expect(Object.keys(step1to2Entry)).toEqual(['default']);
  expect(Object.keys(step2to3Entry)).toEqual(['default']);
  expect(Object.keys(offlineEntry).sort()).toEqual([
    'Y_OFFLINE_DEFAULTS',
    'Y_OFFLINE_STAGES',
    'attachYOfflineSession',
    'describeYOfflineCapture',
    'loadYOffline',
    'openYOfflineStore',
    'recoverYOfflineEdits',
    'replayUnsyncedEdits',
  ]);
  expect(Object.keys(serverEntry).sort()).toEqual([
    'LAYOUT_VERSION',
    'MIN_LAYOUT',
    'SEED_LAYOUT',
    'UNKNOWN_GENERATION',
    'checkYSession',
    'createYDoc',
    'createYQuarantineRecord',
    'createYServerLayoutUpgrade',
    'createYSessionCapture',
    'describeYRoom',
    'getYGeneration',
    'isYLayoutUpgradeHandle',
    'prepareYRoom',
    'sourceView',
  ]);
  expect(mainEntry.DEFAULT_ROOT_NAME).toBe('lexical-y');
  expect(typeof mainEntry.LAYOUT_VERSION).toBe('number');
  expect(Object.keys(mainEntry).sort()).toEqual([
    'DEFAULT_ROOT_NAME',
    'LAYOUT_VERSION',
    'MIN_LAYOUT',
    'NESTED_FALLBACK_WARNING',
    'RAW_YJS_WRITE_WARNING',
    'RECOVERED_READ_WARNING',
    'RECOVERED_WRITE_WARNING',
    'SEED_LAYOUT',
    'SELF_CHECK_WARNING',
    'STORAGE_MISMATCH_WARNING',
    'SUPPORTED_YJS_VERSION',
    'UNKNOWN_NODE_TYPES_WARNING',
    'UNSUPPORTED_CONFIG_WARNING',
    'UNSUPPORTED_EDIT_WARNING',
    'UNSUPPORTED_LAYOUT_WARNING',
    'UNSUPPORTED_SCHEMA_WARNING',
    'UNSUPPORTED_SLOTS_WARNING',
    'UNSUPPORTED_YJS_ERROR',
    'UNSYNCED_VALUE_WARNING',
    'YBinding',
    'YCollabExtension',
    'YUnsupportedYjsError',
    'Y_DEFAULTS',
    'createYBinding',
    'createYCollabConfig',
    'createYDoc',
    'createYHandshake',
    'createYServerLayoutUpgrade',
    'describeStorage',
    'isYLayoutUpgradeHandle',
    'isYWarning',
    'onYMigrationEpoch',
    'parseYGeneration',
    'yCollab',
  ]);
  expect(Object.keys(headlessEntry).sort()).toEqual([
    'EDITOR_WARNING',
    'FOLLOW_UPS_EXHAUSTED_WARNING',
    'WRITER_NEW_CLIENT_ID_WARNING',
    'YHeadlessError',
    'YUnsupportedYjsError',
    'createYDoc',
    'createYWriter',
    'describeUnsyncedEdits',
    'editYState',
    'readYState',
    'seedYState',
  ]);
});

// The headless helpers' hook into the binding is not part of its published
// type (`private` to the type only, so the declarations do not offer it).
test('the layout constants are typed number, in the core and the server entry', () => {
  // A later release raises LAYOUT_VERSION: code naming these types must keep
  // compiling, so none of them is a literal type.
  const raised: [
    typeof mainEntry.LAYOUT_VERSION,
    typeof mainEntry.MIN_LAYOUT,
    typeof mainEntry.SEED_LAYOUT,
    typeof serverEntry.LAYOUT_VERSION,
    typeof serverEntry.MIN_LAYOUT,
    typeof serverEntry.SEED_LAYOUT,
  ] = [99, 98, 97, 99, 98, 97];
  expect(raised).toHaveLength(6);
  for (const entry of [mainEntry, serverEntry]) {
    for (const value of [
      entry.LAYOUT_VERSION,
      entry.MIN_LAYOUT,
      entry.SEED_LAYOUT,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  }
});

test('policy: raising the floor is deliberate, and the runner targets it by default', () => {
  // While @lexical/y is experimental a release may raise MIN_LAYOUT and stop
  // reading an older layout (y.md "Layout upgrades", D110): its rooms open
  // read only until their server migrates them. Such a release updates this
  // bound, the docs and its changelog together. Published steps stay
  // published either way, and an app may raise its own floor (its server
  // stops admitting clients that cannot read the next layout).
  expect(mainEntry.MIN_LAYOUT).toBeLessThanOrEqual(3);
  expect(serverEntry.MIN_LAYOUT).toBe(mainEntry.MIN_LAYOUT);
  // Published steps stay published: this list only grows (add a step here
  // when you publish it; removing one fails).
  const everPublished = ['1to2', '2to3'];
  const manifest = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../migrate/manifest.json'),
      'utf8',
    ),
  ) as string[];
  expect(manifest).toEqual(expect.arrayContaining(everPublished));
});

test('one manifest of published steps: the files, the exports, the lazy loaders and the static table all follow it', () => {
  const pkgDir = path.resolve(__dirname, '../../..');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pkgDir, 'src/migrate/manifest.json'), 'utf8'),
  ) as string[];
  const files = fs
    .readdirSync(path.join(pkgDir, 'src/migrate'))
    .filter(f => /^[^.]+\.ts$/.test(f))
    .map(f => f.replace(/\.ts$/, ''))
    .sort();
  expect([...manifest].sort()).toEqual(files);
  const exportsOf = Object.keys(
    JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
      .exports as Record<string, unknown>,
  );
  expect(
    exportsOf
      .filter(k => /^\.\/migrate\/[^.]+$/.test(k))
      .map(k => k.slice('./migrate/'.length))
      .sort(),
  ).toEqual([...manifest].sort());
  const fromOf = (name: string) => Number(name.replace(/to.*$/, ''));
  expect(Object.keys(STEP_LOADERS).map(Number).sort()).toEqual(
    manifest.map(fromOf).sort(),
  );
  expect(PUBLISHED_STEPS.map(s => s.id).sort()).toEqual(
    manifest.map(n => `lexical-y/layout/${n}`).sort(),
  );
});

test('YBinding does not offer flushPending', () => {
  type Offered = 'flushPending' extends keyof mainEntry.YBinding ? true : false;
  const offered: Offered = false;
  expect(offered).toBe(false);
});

// The core never loads the migration runner or a step, and the
// runner, the steps and the server entry never load Lexical or the
// binding: their module graphs, followed through relative imports, stay
// apart.
test('the core, the runner, the steps and the server entry stay apart', () => {
  const src = path.resolve(__dirname, '../..');
  const graph = (entry: string): {files: Set<string>; bare: Set<string>} => {
    const files = new Set<string>();
    const bare = new Set<string>();
    const visit = (file: string) => {
      if (files.has(file)) {
        return;
      }
      files.add(file);
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (
          (ts.isImportDeclaration(statement) ||
            ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          const typeOnly = ts.isImportDeclaration(statement)
            ? statement.importClause !== undefined &&
              statement.importClause.isTypeOnly
            : statement.isTypeOnly;
          if (typeOnly) {
            continue;
          }
          const spec = statement.moduleSpecifier.text;
          if (spec.startsWith('.')) {
            const target = path.resolve(path.dirname(file), spec);
            visit(
              fs.existsSync(target + '.ts')
                ? target + '.ts'
                : fs.existsSync(target + '.tsx')
                  ? target + '.tsx'
                  : path.join(target, 'index.ts'),
            );
          } else {
            bare.add(spec);
          }
        }
      }
    };
    visit(path.join(src, entry));
    return {bare, files: new Set([...files].map(f => path.relative(src, f)))};
  };
  const migrationCode = (f: string) =>
    f === 'internal/Runner.ts' ||
    f === 'internal/Server.ts' ||
    f === 'internal/StepLoaders.ts' ||
    f === 'internal/StepTable.ts' ||
    f === 'internal/YjsMigrationContract.ts' ||
    f.startsWith('migrate/');
  for (const entry of ['index.ts', 'headless.ts']) {
    expect([...graph(entry).files].filter(migrationCode)).toEqual([]);
  }
  for (const entry of [
    'migrate.ts',
    'migrate/1to2.ts',
    'migrate/2to3.ts',
    'server.ts',
  ]) {
    const {files, bare} = graph(entry);
    // The server's static step table imports the published steps by their
    // own entries (never inlined); the runner loads them on demand.
    expect([...bare].sort()).toEqual(
      entry === 'server.ts'
        ? ['@lexical/y/migrate/1to2', '@lexical/y/migrate/2to3', '@y/y']
        : ['@y/y'],
    );
    expect(files.has('internal/Binding.ts')).toBe(false);
    // Their documents come from the Yjs-only factory (RawYDoc), never from
    // a client's createYDoc (YDoc.ts), which may add what the binding needs.
    expect(files.has('internal/YDoc.ts')).toBe(false);
  }
  // A server's layout constants are the core's, from the constants module
  // alone (the server never needs the core entry).
  expect([
    serverEntry.LAYOUT_VERSION,
    serverEntry.MIN_LAYOUT,
    serverEntry.SEED_LAYOUT,
  ]).toEqual([
    mainEntry.LAYOUT_VERSION,
    mainEntry.MIN_LAYOUT,
    mainEntry.SEED_LAYOUT,
  ]);
  expect(graph('server.ts').files.has('index.ts')).toBe(false);
  // The server entry reaches the runner through the public migrate entry
  // (external in the build: one runner, one YMigrationError class).
  const serverImports = graph('internal/Server.ts');
  expect(serverImports.files.has('migrate.ts')).toBe(true);
  expect(
    fs
      .readFileSync(path.join(src, 'internal/Server.ts'), 'utf8')
      .includes("from './Runner'"),
  ).toBe(false);
  // Core's createYDoc builds on the Yjs-only factory.
  expect(graph('internal/YDoc.ts').files.has('internal/RawYDoc.ts')).toBe(true);
  // A step imports nothing of the package but its own frozen sources.
  for (const step of ['1to2', '2to3']) {
    expect(
      [...graph(`migrate/${step}.ts`).files].filter(
        f => !f.startsWith(`migrate/${step}`),
      ),
    ).toEqual([]);
  }
});
