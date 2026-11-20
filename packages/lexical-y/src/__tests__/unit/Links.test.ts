/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Link fields and links that span a line break.
// @vitest-environment node
import {$createLinkNode, $isLinkNode} from '@lexical/link';
import {$wrapSelectionInMarkNode} from '@lexical/mark';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isTextNode,
  $setState,
  createState,
  type ElementNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $selectIn,
  type Delivery,
  expectConverged,
  freshReader,
  setup,
} from '../utils/harness';

const ORDERS: [number[], Delivery][] = [
  [[1, 2], 'causal'],
  [[2, 1], 'causal'],
  [[1, 2], 'sender'],
  [[2, 1], 'sender'],
];

describe('@lexical/y links', () => {
  test('one user deletes from inside a link into the text after it', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createParagraphNode().append(
          $createLinkNode('https://a.x').append($createTextNode('abcd')),
          $createTextNode('efgh'),
        ),
      ),
    );
    t.a.update(() => {
      const s = $assertNodeType(
        $assertNodeType(
          $block([0]).getFirstChild(),
          $isLinkNode,
        ).getFirstChild(),
        $isTextNode,
      ).select(2, 2);
      s.focus.set(
        $assertNodeType($block([0]).getLastChild(), $isTextNode).getKey(),
        2,
        'text',
      );
      s.removeText();
    });
    await t.sync();
    await expectConverged(t.peers, 'paragraph(link<https://a.x>("ab") "gh")');
  });

  test('single writer: LinkNode.setURL is written', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('a '),
          $createLinkNode('https://u1').append($createTextNode('foo')),
        ),
      ),
    );
    t.a.update(() => {
      $assertNodeType($block([0]).getChildAtIndex(1), $isLinkNode).setURL(
        'https://u2',
      );
    });
    await t.sync();
    expect(t.b.describe()).toBe(t.a.describe());
    await expectConverged(t.peers);
  });
  test('single writer: LinkNode.setURL + setTarget + text edit', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('a '),
          $createLinkNode('https://u1').append($createTextNode('foo')),
        ),
      ),
    );
    t.a.update(() => {
      const l = $assertNodeType($block([0]).getChildAtIndex(1), $isLinkNode);
      l.setURL('https://u2');
      $assertNodeType(l.getFirstChild(), $isTextNode).setTextContent('fooX');
    });
    await t.sync();
    expect(t.b.describe()).toBe(t.a.describe());
    await expectConverged(t.peers);
  });

  for (const [ids, delivery] of ORDERS) {
    test(`link setURL || Enter inside link ${ids} ${delivery}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('a '),
              $createLinkNode('https://u1').append($createTextNode('foo bar')),
              $createTextNode(' z'),
            ),
          ),
        {delivery, ids},
      );
      t.offline();
      t.a.update(() => {
        const l = $block([0]).getChildAtIndex(1);
        if ($isLinkNode(l)) {
          l.setURL('https://u2');
        }
      });
      t.b.update(() => {
        $selectIn([0], 5).insertParagraph();
      });
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain('https://u2');
    });
  }

  for (const [ids, delivery] of ORDERS) {
    test(`align para || Enter inside link ${ids} ${delivery}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('Hello '),
              $createLinkNode('https://l').append($createTextNode('link text')),
              $createTextNode(' end'),
            ),
          ),
        {delivery, ids},
      );
      t.offline();
      t.a.update(() => {
        $block([0]).setFormat('right');
      });
      t.b.update(() => {
        $selectIn([0], 11).insertParagraph();
      });
      await t.sync();
      await expectConverged(t.peers);
    });
    test(`type in para1 || Enter inside link ${ids} ${delivery}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('Hello '),
              $createLinkNode('https://l').append($createTextNode('link text')),
              $createTextNode(' end'),
            ),
          ),
        {delivery, ids},
      );
      t.offline();
      t.a.update(() => {
        $selectIn([0], 1).insertText('X');
      });
      t.b.update(() => {
        $selectIn([0], 11).insertParagraph();
      });
      await t.sync();
      await expectConverged(t.peers);
    });
  }

  for (const [ids, delivery] of ORDERS) {
    for (const withAlign of [false, true]) {
      test(`link spans marker; ${withAlign ? 'align p0 || ' : ''}wrap text of p0 in MarkNode ${ids} ${delivery}`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('Hello '),
                $createLinkNode('https://l').append(
                  $createTextNode('link text'),
                ),
                $createTextNode(' end'),
              ),
            ),
          {delivery, ids},
        );
        t.b.update(() => {
          $selectIn([0], 11).insertParagraph();
        });
        await t.sync();
        t.offline();
        if (withAlign) {
          t.a.update(() => {
            $block([0]).setFormat('right');
          });
        }
        t.b.update(() => {
          $wrapSelectionInMarkNode($selectIn([0], 1, 4), false, 'm1');
        });
        await t.sync();
        await expectConverged(t.peers);
      });
    }
  }
});

const anyValueState = createState('linkTestValue', {
  parse: (v: unknown) => v,
});

describe('a link value reads back with its type and value', () => {
  // Every value a link's NodeState (or field) can hold, among them strings
  // that start with NUL, as the binding marks values that are not
  // primitives. Before, such a string read as the JSON after the NUL: lost
  // ("\u0000abc"), or another type ("\u000042" read as 42).
  const values: unknown[] = [
    'plain',
    '',
    'abc\u0000def',
    '\u0000',
    '\u0000\u0000',
    '\u0000abc',
    '\u0000"x"',
    '\u000042',
    '\u0000null',
    '\u0000{"a":1}',
    0,
    42,
    -1.5,
    true,
    false,
    null,
    {key: 'value'},
    {n: 1, nested: '\u0000x'},
    ['a', '\u0000b', 2],
  ];
  for (const value of values) {
    test(JSON.stringify(value), async () => {
      const t = await setup(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('start')),
        );
      });
      t.a.update(() => {
        const link = $createLinkNode('https://example.test').append(
          $createTextNode('link'),
        );
        $setState(link, anyValueState, value);
        $getRoot().clear().append($createParagraphNode().append(link));
      });
      await t.sync();
      const fresh = await freshReader(t.a);
      const read = (p: typeof t.a) =>
        p.read(() =>
          $getState(
            ($getRoot().getFirstChild() as ElementNode).getFirstChild()!,
            anyValueState,
          ),
        );
      for (const p of [t.a, t.b, fresh]) {
        const got = read(p);
        expect(typeof got).toBe(typeof value);
        expect(got).toEqual(value);
      }
    });
  }
});
