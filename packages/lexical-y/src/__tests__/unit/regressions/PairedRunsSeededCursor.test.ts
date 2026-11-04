/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

import {$createLinkNode} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $createBoxNode,
  $p,
  expectConverged,
  freshReader,
  setup,
  WITH_GC,
} from '../../utils/harness';

// A writer seeded with the formats of a line's start (a line moved, or
// written again) steps over the format items between the previous line's
// end and the line's content a second time. A plain value just sets itself
// again; a paired run must not be pushed twice, or its end closes one copy
// and the author's editor keeps the value on text its document no longer
// gives it (or the reverse).

const SHAPES: [string, () => LexicalNode][] = [
  [
    'a link over the whole line',
    () =>
      $createParagraphNode().append(
        $createLinkNode('https://x.test/').append($createTextNode('t62z')),
      ),
  ],
  [
    'a link over the start of the line',
    () =>
      $createParagraphNode().append(
        $createLinkNode('https://x.test/').append($createTextNode('t62')),
        $createTextNode('z'),
      ),
  ],
  [
    'bold over the whole line',
    () => $createParagraphNode().append($createTextNode('t62z').setFormat(1)),
  ],
];

describe.each(
  SHAPES.flatMap(([name, $line]) => [
    [name + ', at the root', $line, false] as const,
    [name + ', inside a container', $line, true] as const,
  ]),
)('%s', (_name, $line, boxed) => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    for (const where of ['down', 'up'] as const) {
      test(`moved ${where}, client ids ${ids.join(',')}`, async () => {
        const t = await setup(
          () => {
            const lines = [$p('one'), $line(), $p('two'), $p('three')];
            if (boxed) {
              $getRoot().append(
                $p('before'),
                $createBoxNode().append(...lines),
              );
            } else {
              $getRoot().append(...lines);
            }
          },
          {gc: WITH_GC, ids},
        );
        t.a.update(() => {
          const root = boxed
            ? ($getRoot().getChildAtIndex(1) as ElementNode)
            : $getRoot();
          const line = root.getChildAtIndex(1) as ElementNode;
          if (where === 'down') {
            root.getChildAtIndex(2)!.insertAfter(line);
          } else {
            root.getFirstChild()!.insertBefore(line);
          }
        });
        const fresh = await freshReader(t.a);
        expect(t.a.describe()).toBe(fresh.describe());
        await t.sync();
        await expectConverged(t.peers);
        // Then a collaborator types after the line's content.
        t.b.update(() => {
          const root = boxed
            ? ($getRoot().getChildAtIndex(1) as ElementNode)
            : $getRoot();
          const line = root.getChildAtIndex(
            where === 'down' ? 2 : 0,
          ) as ElementNode;
          line.selectEnd().insertText('!');
        });
        await t.sync();
        await expectConverged(t.peers);
      });
    }
  }
});
