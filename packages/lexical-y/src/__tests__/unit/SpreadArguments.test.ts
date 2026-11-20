/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The number of arguments a call can take is bounded by the stack it runs
// on (a RangeError past 131,072 on Node's main thread), and content is as
// long as a user makes it: a list of content spread into a call's arguments
// (`array.push(...items)`, `parent.append(...nodes)`, `Math.max(...values)`,
// `fn.apply(null, values)`) throws on a large enough document (#9880). This
// test reads every source file of the package and allows such a call only
// where it is listed below with the reason its list is bounded (a chunk of
// at most ARGUMENTS_CHUNK items, an argument tuple).
// Anything else uses `pushAll`, `spliceAll` or `$appendAll`
// (internal/Arrays.ts), or a loop.

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import {expect, test} from 'vitest';

const SRC = path.resolve(__dirname, '../..');

/** Spread arguments that are bounded, by file and call text, with why. */
const ALLOWED: Record<string, Record<string, string>> = {
  'internal/Arrays.ts': {
    'array.splice(start, deleteCount, ...items)':
      'spliceAll: only when items.length <= ARGUMENTS_CHUNK',
    'parent.append(...nodes.slice(i, i + ARGUMENTS_CHUNK))':
      '$appendAll: a chunk of at most ARGUMENTS_CHUNK nodes',
  },
  'internal/Binding.ts': {
    'head.splitText( ...offsets.slice(Math.max(0, end - ARGUMENTS_CHUNK), end), )':
      'a chunk of at most ARGUMENTS_CHUNK offsets',
    'super.emit(...args)': "an event's argument tuple (forwarded)",
    'um.emit(...args)': "an event's argument tuple (held, then forwarded)",
  },
  'internal/Read.ts': {
    'this.$readInline(...args)': "$readInline's own parameters (forwarded)",
  },
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') {
        sourceFiles(full, out);
      }
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

type Found = {file: string; line: number; call: string};

/** The calls in `source` that pass a list as their arguments. */
function spreadCallsIn(source: ts.SourceFile, file: string): Found[] {
  const found: Found[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      node.arguments !== undefined
    ) {
      const spread = node.arguments.some(arg => ts.isSpreadElement(arg));
      // fn.apply(thisArg, list), fn['apply'](...), Reflect.apply(fn, thisArg,
      // list), Reflect.construct(C, list): the list is the arguments. (An
      // alias of Function.prototype.apply or of Reflect is not recognized.)
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) &&
            ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : null;
      const onReflect =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'Reflect';
      const apply =
        ts.isCallExpression(node) &&
        ((name === 'apply' && (node.arguments.length >= 2 || onReflect)) ||
          (name === 'construct' && onReflect));
      if (spread || apply) {
        found.push({
          call: oneLine(node.getText(source)),
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const parse = (file: string, text: string) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

/** Every such call in the package's sources. */
function spreadCalls(): Found[] {
  return sourceFiles(SRC).flatMap(full =>
    spreadCallsIn(
      parse(full, fs.readFileSync(full, 'utf8')),
      path.relative(SRC, full).split(path.sep).join('/'),
    ),
  );
}

test('no list of content is spread into a call', () => {
  const calls = spreadCalls();
  const unbounded = calls
    .filter(({file, call}) => ALLOWED[file]?.[call] === undefined)
    .map(({file, line, call}) => `${file}:${line}: ${call}`);
  expect(unbounded).toEqual([]);
  // Every allowance still names a call in the source.
  const seen = new Set(calls.map(({file, call}) => `${file}\0${call}`));
  const stale = Object.entries(ALLOWED).flatMap(([file, entries]) =>
    Object.keys(entries)
      .filter(call => !seen.has(`${file}\0${call}`))
      .map(call => `${file}: ${call}`),
  );
  expect(stale).toEqual([]);
});

test('the check finds every call given a list as its arguments', () => {
  const probe = parse(
    'probe.ts',
    [
      'out.push(...items);',
      'Math.max(...values);',
      'new Set(...lists);',
      'String.fromCharCode.apply(null, codes);',
      "fn['apply'](null, codes);",
      'Reflect.apply(fn, null, codes);',
      'Reflect.construct(Array, items);',
      'parent.append(...nodes.slice(i, i + ARGUMENTS_CHUNK));',
      // A method named apply that takes one value is not a list call.
      'this.apply(step);',
    ].join('\n'),
  );
  expect(spreadCallsIn(probe, 'probe.ts').map(f => f.call)).toEqual([
    'out.push(...items)',
    'Math.max(...values)',
    'new Set(...lists)',
    'String.fromCharCode.apply(null, codes)',
    "fn['apply'](null, codes)",
    'Reflect.apply(fn, null, codes)',
    'Reflect.construct(Array, items)',
    // Chunks too: each is listed in ALLOWED with its bound.
    'parent.append(...nodes.slice(i, i + ARGUMENTS_CHUNK))',
  ]);
});
