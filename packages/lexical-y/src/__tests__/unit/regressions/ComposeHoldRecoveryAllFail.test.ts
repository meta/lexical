/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A change that types a character while a hold is on, whose write and every
// recovery of it fail (faults where each starts): recovered as on main (a
// change that inserts characters takes main's recovery path unchanged), so
// the editor keeps what was typed and is never read over with what is
// stored. Where main then loses the typed character, it is pinned as on main
// (see #9775).

import {
  $create,
  $createParagraphNode,
  $getDocument,
  $getRoot,
  $removeSlot,
  $setCompositionKey,
  $setSelection,
  $setSlot,
  ElementNode,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

import {Writer} from '../../../internal/Write';
import {freshReader, NODES, type Peer, setup} from '../../utils/harness';

class AllFailBox extends ElementNode {
  $config() {
    return this.config('all_fail_box', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isInline() {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM() {
    return false;
  }
}

class AllFailGroup extends ElementNode {
  $config() {
    return this.config('all_fail_group', {extends: ElementNode});
  }
  createDOM() {
    return $getDocument().createElement('div');
  }
  updateDOM() {
    return false;
  }
}

class AllFailHost extends ParagraphNode {
  $config() {
    return this.config('all_fail_host', {
      extends: ParagraphNode,
      slots: ['title'],
    });
  }
}

const text = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join('|'),
  );

const $source = () =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent().startsWith('a'))!;

describe('a typing change whose write and every recovery fail, under a hold', () => {
  for (const gc of [false, true]) {
    for (const shape of ['inline', 'block', 'slot'] as const) {
      for (const place of ['earlier', 'later', 'same-parent'] as const) {
        const asOnMain = !(shape === 'slot' && place === 'same-parent');
        (asOnMain ? test.fails : test)(
          `${shape}, moved to ${place === 'same-parent' ? 'the same parent' : `${place === 'earlier' ? 'an earlier' : 'a later'} line`}: the typed X is kept once${asOnMain ? ' (as on main, see #9775)' : ''} (gc ${gc ? 'on' : 'off'})`,
          async () => {
            const t = await setup(
              () => {
                const composed = $create(TextNode).setTextContent('abc');
                const destination = $createParagraphNode().append(
                  $create(TextNode).setTextContent('destination'),
                );
                let source: ElementNode;
                if (shape === 'inline') {
                  source = $createParagraphNode().append(
                    $create(TextNode).setTextContent('left'),
                    $create(AllFailBox).append(composed),
                    $create(TextNode).setTextContent('uv'),
                  );
                } else if (shape === 'block') {
                  source = $create(AllFailGroup).append(
                    $createParagraphNode().append(
                      $create(TextNode).setTextContent('left'),
                    ),
                    $create(AllFailGroup).append(
                      $createParagraphNode().append(composed),
                    ),
                    $createParagraphNode().append(
                      $create(TextNode).setTextContent('uv'),
                    ),
                  );
                } else {
                  source = $create(AllFailHost).append(
                    $create(TextNode).setTextContent('left'),
                  );
                  $setSlot(
                    source,
                    'title',
                    $createParagraphNode().append(composed),
                  );
                }
                $getRoot().append(
                  ...(place === 'earlier'
                    ? [destination, source]
                    : [source, destination]),
                  $createParagraphNode().append(
                    $create(TextNode).setTextContent('separator'),
                  ),
                );
              },
              {
                gc,
                ids: [1, 2, 3],
                nodes: [...NODES, AllFailBox, AllFailGroup, AllFailHost],
              },
            );
            const {a, b} = t;
            const errors = vi
              .spyOn(console, 'error')
              .mockImplementation(() => {});
            onTestFinished(() => errors.mockRestore());
            onTestFinished(() => t.peers.forEach(p => p.stop()));
            a.update(() => {
              const n = $source();
              n.select(1, 1);
              $setCompositionKey(n.getKey());
            });
            await t.sync();
            b.update(() => {
              $source().spliceText(1, 0, 'R');
              $setSelection(null);
            });
            await t.sync();
            // The write and its recoveries each fail where they start.
            const run = Writer.prototype.$run;
            let faults = 3;
            Writer.prototype.$run = function (this: Writer) {
              if (faults > 0 && this.tr.doc === a.doc) {
                faults--;
                throw new Error('a fault where a write starts');
              }
              return run.call(this);
            };
            onTestFinished(() => {
              Writer.prototype.$run = run;
            });
            // The last recovery's fault reaches the editor's onError (which
            // the test harness rethrows), as on main.
            let reported: unknown = null;
            try {
              a.update(() => {
                const n = $source();
                n.spliceText(0, 3, 'aX');
                const container =
                  shape === 'inline'
                    ? n.getParentOrThrow()
                    : shape === 'block'
                      ? n.getParentOrThrow().getParentOrThrow()
                      : n.getParentOrThrow();
                const root = $getRoot();
                const destination = root
                  .getChildren()
                  .find(
                    c => c.getTextContent() === 'destination',
                  ) as ElementNode;
                if (shape === 'slot') {
                  const host = root
                    .getChildren()
                    .find(c => c instanceof AllFailHost) as AllFailHost;
                  if (place === 'same-parent') {
                    $removeSlot(host, 'title');
                    host.append(container);
                  } else {
                    $removeSlot(host, 'title');
                    destination.insertAfter(container);
                  }
                } else if (place === 'same-parent') {
                  container.getParentOrThrow().append(container);
                } else if (shape === 'inline') {
                  destination.append(container);
                } else {
                  destination.insertAfter(container);
                }
                $setSelection(null);
              });
            } catch (e) {
              reported = e;
            }
            expect(String(reported)).toContain('a fault where a write starts');
            a.errors.length = 0;
            await t.sync();
            Writer.prototype.$run = run;
            a.update(() => $setCompositionKey(null));
            await t.sync();
            const fresh = await freshReader(a);
            onTestFinished(() => fresh.stop());
            const stored = text(fresh);
            for (const p of t.peers) {
              expect(text(p)).toBe(stored);
            }
            expect(stored.split('X')).toHaveLength(2);
            expect(stored.split('left')).toHaveLength(2);
          },
        );
      }
    }
  }
});
