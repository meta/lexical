/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {glob} from 'glob';
import * as fs from 'node:fs';
import {describe, expect, test} from 'vitest';

/** Every `exportJSON` *method* declaration's parameter list, comments removed. */
function exportJSONParameterLists(source: string): string[] {
  // A comment mentioning `exportJSON(compact)` is prose, not a declaration, and
  // several of these files carry exactly that sentence above the declaration it
  // explains. Blanking comments first is what keeps the scan looking at code.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const lists: string[] = [];
  // `exportJSON` followed by `(` is the method; `exportJSON:` is the property
  // on a DOM-export config, which takes a node rather than a compact flag.
  // `static? exportJSON(` at the start of a member, not `.exportJSON(`: `\b`
  // matches after a dot too, so a *call* — `node.exportJSON(true)`, which the
  // flowtest file makes — was collected as a declaration and either reported as
  // a bogus offender or padded the count enough to hide a real one.
  const re = /(?:^|[;{}])\s*(?:static\s+)?exportJSON\s*\(/gm;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < code.length && depth > 0; i++) {
      const c = code[i];
      if (c === '(') {
        depth++;
      } else if (c === ')') {
        depth--;
      }
    }
    // Collapse the whitespace so a declaration Prettier wrapped across lines
    // reads the same as one that fits on a single line. The line-anchored
    // regex this replaced saw only the latter, so a wrap would have dropped a
    // declaration from the scan without failing anything.
    if (depth !== 0) {
      // The scan lost track — a stray paren, or a comment stripper that ate
      // one. Say so, rather than pushing the rest of the file as a parameter
      // list and silently dropping every later declaration with it.
      throw new Error(
        `exportJSONParameterLists: unbalanced parentheses after offset ${m.index}`,
      );
    }
    lists.push(
      code
        .slice(re.lastIndex, i - 1)
        .replace(/\s+/g, ' ')
        .trim(),
    );
    re.lastIndex = i;
  }
  return lists;
}

/**
 * The compact export omits every property equal to its schema default, so a
 * declaration returning the full serialized type for a compact call promises
 * properties the value does not carry. TypeScript overloads on `compact` to say
 * which shape came back; Flow cannot — its method-override check pairs no
 * branch, so every node from TextNode down would fail to extend — and the
 * declarations instead take `compact?: false`, which refuses a compact call
 * where it is written rather than answering it wrongly.
 *
 * That rule has to hold for *every* declaration, not just the base: a subclass
 * re-declaring `exportJSON` with `boolean` reinstates the promise for its own
 * type, which is where `node.exportJSON(true).text.length` type-checked from.
 * Every declaration is checked for that shape, and the count is a floor so
 * that adding a correct one does not fail this guard.
 */
describe('a Flow exportJSON declaration refuses a compact call', () => {
  const files = glob.sync('packages/*/flow/*.js.flow', {
    ignore: ['**/*.flowtest.js.flow'],
    windowsPathsNoEscape: true,
  });

  test('every declaration takes `compact?: false`', () => {
    expect(files.length).toBeGreaterThan(0);
    const declarations: string[] = [];
    for (const file of files) {
      for (const list of exportJSONParameterLists(
        fs.readFileSync(file, 'utf8'),
      )) {
        declarations.push(`${file}: exportJSON(${list})`);
      }
    }
    // Compared as a set rather than counted, so a failure names the file and
    // the parameter list it actually found. A declaration that takes `boolean`
    // (or `compact?: boolean`) is the regression this exists for; one that
    // takes nothing at all refuses a compact call too, and is equally fine.
    expect(
      declarations.filter(
        // A trailing comma is allowed because Prettier is configured with
        // `trailingComma: "all"`: the moment a declaration is wrapped across
        // lines — the case this scanner exists to read — the collapsed list is
        // `compact?: false,`, and a correct, Prettier-formatted file failed.
        decl => !/exportJSON\((|compact\?: false,?)\)$/.test(decl),
      ),
    ).toEqual([]);
    // A floor, not a census: the shape check above is what catches a widened
    // declaration, and this only has to catch a scan that stopped finding
    // them. An exact count made the *correct* action fail — adding an
    // `exportJSON(compact?: false)` to a package that gains a node, which is
    // what the docblock above instructs — with a bare number mismatch naming
    // nothing, and the natural reaction is to bump it until it passes.
    expect(declarations.length).toBeGreaterThanOrEqual(8);
  });
});
