/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$createQuoteNode} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$block, $createEquation, freshReader, setup} from '../utils/harness';

for (const inline of ['break', 'equation'])
  for (const field of ['textFormat', 'textStyle'])
    test(`raw ${inline} paragraph follow-up ${field}`, async () => {
      const t = await setup(() =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Title')),
          $createParagraphNode().append($createTextNode('one')),
          $createParagraphNode().append($createTextNode('end')),
        ),
      );
      t.offline();
      t.a.update(() => {
        const p = $block([1]);
        const q = $createQuoteNode({shadowRoot: true});
        p.insertBefore(q);
        q.append(p);
        $setSelection(null);
      });
      t.b.update(() => {
        const s = $block([1]).selectEnd();
        if (inline === 'break') s.insertLineBreak();
        else s.insertNodes([$createEquation('e')]);
      });
      await t.sync();
      const before = t.b.describe();
      t.b.update(() => {
        const q = $block([1]);
        const p = q.getLastChild() as ElementNode;
        if (field === 'textFormat') p.setTextFormat(8);
        else p.setTextStyle('color:red');
        $setSelection(null);
      }, 'block-id-repair');
      const f = await freshReader(t.b);
      await t.sync();
      // eslint-disable-next-line no-console
      console.log(
        'R15RAWFIELD',
        JSON.stringify({
          author: t.b.json(),
          before,
          field,
          fresh: f.json(),
          inline,
          peer: t.a.json(),
        }),
      );
      expect(t.b.json()).toEqual(f.json());
      expect(t.b.json()).toEqual(t.a.json());
      for (const p of [...t.peers, f]) p.stop();
    });
