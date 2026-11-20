/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
} from '@lexical/list';
import {$createTextNode, $getRoot} from 'lexical';
import {describe, expect, test} from 'vitest';

import {Reader} from '../../internal/Read';
import {Writer} from '../../internal/Write';
import {$block, $p, $selectIn, expectConverged, setup} from '../utils/harness';

describe('@lexical/y read recovery', () => {
  test('a remote read that throws rebuilds the editor from the document, reported, and the peers converge', async () => {
    const t = await setup(() => $getRoot().append($p('hello'), $p('world')));
    const proto = Reader.prototype as unknown as {
      $apply: (...args: unknown[]) => void;
    };
    const apply = proto.$apply;
    let fail = true;
    proto.$apply = function (this: Reader, ...args: unknown[]) {
      if (fail) {
        fail = false;
        throw new Error('simulated reader failure');
      }
      return apply.apply(this, args);
    };
    try {
      t.a.update(() => $selectIn([0], 5).insertText(' there'));
      await t.sync();
    } finally {
      proto.$apply = apply;
    }
    expect(
      t.b.warnings.some(
        w =>
          w.includes('simulated reader failure') &&
          w.startsWith('a remote change could not be read'),
      ),
    ).toBe(true);
    expect(t.b.errors).toEqual([]);
    t.b.warnings.length = 0;
    // Later edits from both sides keep working.
    t.a.update(() => $selectIn([1], 5).insertText('!'));
    t.b.update(() => $selectIn([1], 0).insertText('>'));
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("hello there") / paragraph(">world!")',
    );
  });
});

describe('@lexical/y write recovery', () => {
  test('a write that throws part way is followed by a rewrite, reported, and the peers converge', async () => {
    const t = await setup(() => $getRoot().append($p('one'), $p('two')));
    const proto = Writer.prototype as unknown as {$run: () => void};
    const run = proto.$run;
    let calls = 0;
    proto.$run = function (this: Writer) {
      calls++;
      if (calls === 1) {
        // Write part of the change, then fail.
        (this as unknown as {plan: {lines: Set<string>}}).plan.lines.clear();
        run.call(this);
        throw new Error('simulated writer failure');
      }
      return run.call(this);
    };
    try {
      t.a.update(() => {
        $selectIn([0], 3).insertText(' more');
        $selectIn([1], 0).insertParagraph();
      });
    } finally {
      proto.$run = run;
    }
    expect(t.a.warnings.some(w => w.includes('simulated writer failure'))).toBe(
      true,
    );
    t.a.warnings.length = 0;
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("one more") / paragraph() / paragraph("two")',
    );
  });

  test('a nested list that becomes a level of its list is not written into its old shared node', async () => {
    // A list stored inside a line (paste into a list item) whose item is
    // then outdented: the old shared list is deleted; later edits go to the
    // list's items in their group.
    const t = await setup(() =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('a')),
          $createListItemNode().append(
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('b')),
            ),
          ),
        ),
      ),
    );
    t.a.update(() => ($block([0, 1, 0, 0]) as ListItemNode).setIndent(0));
    t.a.update(() => $selectIn([0, 1], 1).insertText('c'));
    await t.sync();
    expect(t.a.warnings).toEqual([]);
    await expectConverged(
      t.peers,
      'list[bullet](listitem("a") listitem("bc"))',
    );
  });
});
