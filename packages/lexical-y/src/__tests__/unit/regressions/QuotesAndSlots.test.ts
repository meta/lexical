/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Regression cases for quote and slot findings of the #9400 soaks whose
// original repros were not committed. Each case is named after its finding.

import {$createQuoteNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {expectConverged, freshReader, setup} from '../../utils/harness';

// S4-8: an outside writer's link run (a plain Yjs client, formats not
// cleaned up) over the root sequence that opens before a shadow-root quote's
// paragraph and closes after the next quote's paragraph. A client then
// deletes the first quote: its write must delete only that quote's text. It
// deleted and inserted the second quote's paragraph again, so a peer's
// concurrent typing there was lost and its delete undone. Open for the
// runs that reach the second quote (#9571; `@lexical/y`'s own writers do
// not leave such runs); the run inside the first quote is a control.
describe('S4-8: an outside link run over two quotes, then a client deletes the first quote', () => {
  const runs = [
    'title to second quote end',
    'first quote to second quote end',
    'first quote paragraph only',
  ] as const;
  const peerEdits = ['nothing', 'empties q2', 'types in q2'] as const;
  for (const run of runs) {
    for (const peerEdit of peerEdits) {
      const open = run !== 'first quote paragraph only';
      (open ? test.fails : test)(
        `S4-8 run: ${run}; peer: ${peerEdit}: only the first quote's text is deleted`,
        async () => {
          const t = await setup(() => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              $createQuoteNode({shadowRoot: true}).append(
                $createParagraphNode().append($createTextNode('q1 one')),
              ),
              $createQuoteNode({shadowRoot: true}).append(
                $createParagraphNode().append($createTextNode('q2 two')),
              ),
              $createParagraphNode().append($createTextNode('end')),
            );
          });
          const outside = new Y.Doc();
          outside.cleanupFormatting = false;
          Y.applyUpdate(outside, Y.encodeStateAsUpdate(t.a.doc));
          const sv = Y.encodeStateVector(outside);
          const root = outside.get('lexical-y');
          // The indices of the quotes' paragraph items in the root sequence.
          const paragraphs: number[] = [];
          let index = 0;
          for (let item = root._start; item !== null; item = item.right) {
            if (item.deleted || !item.countable) {
              continue;
            }
            if (
              item.content instanceof Y.ContentType &&
              String(item.content.type.name).startsWith('i:')
            ) {
              paragraphs.push(index);
            }
            index += item.length;
          }
          const from = run === 'title to second quote end' ? 2 : paragraphs[0];
          const to = (open ? paragraphs[1] : paragraphs[0]) + 1;
          outside.transact(() =>
            root.format(from, to - from, {
              'w:link': {url: 'https://o.example'},
            }),
          );
          const update = Y.encodeStateAsUpdate(outside, sv);
          Y.applyUpdate(t.a.doc, update, 'net');
          Y.applyUpdate(t.b.doc, update, 'net');
          await t.sync();

          const wrote = {del: '', ins: ''};
          t.b.doc.on('afterTransaction', (tr: Y.Transaction) => {
            if (!tr.local) {
              return;
            }
            Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
              if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
                wrote.ins += s.content.str;
              }
            });
            Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
              if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
                wrote.del += s.content.str;
              }
            });
          });
          t.offline();
          t.b.update(() => {
            $getRoot().getChildAtIndex(1)!.remove();
            $setSelection(null);
          });
          const $q2 = () =>
            (
              $getRoot().getChildAtIndex(2) as ElementNode
            ).getFirstChild() as ElementNode;
          if (peerEdit === 'empties q2') {
            t.a.update(() => {
              $q2().clear();
              $setSelection(null);
            });
          } else if (peerEdit === 'types in q2') {
            t.a.update(() => {
              $q2().selectEnd().insertText(' X');
            });
          }
          await t.sync();
          expect(wrote).toEqual({del: 'q1 one', ins: ''});
          const expected =
            peerEdit === 'empties q2'
              ? ''
              : peerEdit === 'types in q2'
                ? 'q2 two X'
                : 'q2 two';
          const fresh = await freshReader(t.a);
          for (const p of [t.a, t.b, fresh]) {
            expect(
              p.read(() => $getRoot().getChildAtIndex(1)!.getTextContent()),
            ).toBe(expected);
          }
          await expectConverged(t.peers);
        },
      );
    }
  }
});
