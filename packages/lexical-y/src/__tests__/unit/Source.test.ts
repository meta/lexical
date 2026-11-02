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
    // YjsContract.ts probes @y/y on scratch documents of its own, never a
    // document a binding reads, so its writes have no Seen record to keep.
    if (
      !name.endsWith('.ts') ||
      name === 'Seen.ts' ||
      name === 'YjsContract.ts'
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
  ]);
});

// Old clients (@lexical/yjs) write other roots, so servers need no API of
// their own: the package has no server entry, and the two constants a
// server may want come from the main entry, with `createYDoc`, the document
// every client binds and a relay loads a state into (also exported by
// `@lexical/y/headless`, for servers that import only that entry).
// `@lexical/y/headless` is plain functions (`createYWriter` makes the writer
// `editYState` requires), plus its warning codes.
test('public entries', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'),
  ) as {exports: Record<string, unknown>};
  expect(Object.keys(pkg.exports).sort()).toEqual([
    '.',
    './headless',
    './headless.js',
  ]);
  expect(mainEntry.DEFAULT_ROOT_NAME).toBe('lexical-y');
  expect(typeof mainEntry.LAYOUT_VERSION).toBe('number');
  expect(Object.keys(mainEntry).sort()).toEqual([
    'DEFAULT_ROOT_NAME',
    'LAYOUT_VERSION',
    'NESTED_FALLBACK_WARNING',
    'RECOVERED_READ_WARNING',
    'RECOVERED_WRITE_WARNING',
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
    'createYDoc',
    'describeStorage',
    'isYWarning',
  ]);
  expect(Object.keys(headlessEntry).sort()).toEqual([
    'EDITOR_WARNING',
    'FOLLOW_UPS_EXHAUSTED_WARNING',
    'WRITER_NEW_CLIENT_ID_WARNING',
    'YHeadlessError',
    'YUnsupportedYjsError',
    'createYDoc',
    'createYWriter',
    'editYState',
    'readYState',
    'seedYState',
  ]);
});

// The headless helpers' hook into the binding is not part of its published
// type (`private` to the type only, so the declarations do not offer it).
test('YBinding does not offer flushPending', () => {
  type Offered = 'flushPending' extends keyof mainEntry.YBinding ? true : false;
  const offered: Offered = false;
  expect(offered).toBe(false);
});
