/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

/**
 * Soak 4 probe (seed 9406138): indenting a list item (Lexical
 * creates a nested list) when the list and its items carry textFormat.
 */
import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {freshReader, type Peer, setup} from '../utils/harness';

const json = (p: Peer) => JSON.stringify(p.editor.getEditorState().toJSON());

describe('indenting a list item when the list carries textFormat', () => {
  for (const listFmt of [0, 16] as const) {
    for (const itemFmt of [0, 2] as const) {
      for (const tag of ['block-id-repair', undefined] as const) {
        test(`list textFormat ${listFmt}, items ${itemFmt}${tag ? ' (follow-up)' : ''}`, async () => {
          const t = await setup(() => {
            const list = $createListNode('bullet');
            for (const s of ['i1', 'i2', 'i3']) {
              const it = $createListItemNode().append($createTextNode(s));
              if (itemFmt) it.setTextFormat(itemFmt);
              list.append(it);
            }
            if (listFmt) list.setTextFormat(listFmt);
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              list,
            );
          });
          t.b.update(() => {
            (
              ($getRoot().getChildAtIndex(1) as ListNode).getChildAtIndex(
                1,
              ) as ListItemNode
            ).setIndent(1);
            $setSelection(null);
          }, tag);
          const author = json(t.b);
          await t.sync();
          const fresh = await freshReader(t.b);
          const f = json(fresh);
          if (f !== author) {
            let i = 0;
            while (i < f.length && f[i] === author[i]) i++;
            // eslint-disable-next-line no-console
            console.log(
              `[${listFmt} ${itemFmt} ${tag ?? 'edit'}] at ${i}:\n  author …${author.slice(Math.max(0, i - 120), i + 60)}\n  fresh  …${f.slice(Math.max(0, i - 120), i + 60)}`,
            );
          }
          expect(f).toBe(author);
          expect(json(t.a)).toBe(author);
        });
      }
    }
  }

  // Nested list with its own textFormat next to the indented item (seed 9406138's shape).
  for (const which of [0, 1, 2] as const) {
    for (const dir of ['indent', 'outdent'] as const) {
      for (const tag of ['block-id-repair', undefined] as const) {
        test(`nested list textFormat 18 under list 16: ${dir} item ${which}${tag ? ' (follow-up)' : ''}`, async () => {
          const t = await setup(() => {
            const nested = $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('n1')),
              $createListItemNode().append($createTextNode('n2')),
            );
            nested.setTextFormat(18);
            const list = $createListNode('bullet');
            const a = $createListItemNode().append($createTextNode('i1'));
            a.setTextFormat(2);
            const b = $createListItemNode().append(nested);
            const c = $createListItemNode().append($createTextNode('i3'));
            c.setTextFormat(2);
            list.append(a, b, c);
            list.setTextFormat(16);
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              list,
            );
          });
          t.b.update(() => {
            const list = $getRoot().getChildAtIndex(1) as ListNode;
            const items: ListItemNode[] = [];
            const walk = (l: ListNode) => {
              for (const it of l.getChildren() as ListItemNode[]) {
                const f = it.getFirstChild();
                if (f && f.getType() === 'list') walk(f as ListNode);
                else items.push(it);
              }
            };
            walk(list);
            const it = items[Math.min(which, items.length - 1)];
            it.setIndent(
              Math.max(0, it.getIndent() + (dir === 'indent' ? 1 : -1)),
            );
            $setSelection(null);
          }, tag);
          const author = json(t.b);
          await t.sync();
          const fresh = await freshReader(t.b);
          const f = json(fresh);
          if (f !== author) {
            let i = 0;
            while (i < f.length && f[i] === author[i]) i++;
            // eslint-disable-next-line no-console
            console.log(
              `[nested ${dir} ${which} ${tag ?? 'edit'}] at ${i}:\n  author …${author.slice(Math.max(0, i - 120), i + 60)}\n  fresh  …${f.slice(Math.max(0, i - 120), i + 60)}`,
            );
          }
          expect(f).toBe(author);
          expect(json(t.a)).toBe(author);
        });
      }
    }
  }
});
