/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Record-independent identity syntax: a `[]` opener means "no value" from birth, also while the end
// that closes it waits for content another client wrote, and before the
// layout 3 record: the reader never shows main's plain reading of it (an
// empty-URL link). Once the end arrives, every client converges.

import {$createLinkNode, $isLinkNode, $toggleLink} from '@lexical/link';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {
  $p,
  $selectIn,
  flush,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';
import {
  setFormatIdentityWrites,
  setFormatIdentityWritesDefault,
} from '../../utils/noSwitch';

beforeEach(() => setFormatIdentityWritesDefault(false));
afterEach(() => setFormatIdentityWritesDefault(false));

function $text(token: string): TextNode {
  const nodes = $getRoot().getAllTextNodes();
  const n =
    nodes.find(x => x.getTextContent() === token) ??
    nodes.find(x => x.getTextContent().includes(token));
  if (!n || !$isTextNode(n)) {
    throw new Error(`no ${token}`);
  }
  return n;
}

/** Each text node of the first line with the URL of its link, if any. */
const links = (p: Peer) =>
  p.editor.read(() =>
    ($getRoot().getFirstChildOrThrow() as ElementNode)
      .getAllTextNodes()
      .map((t: TextNode) => {
        const parent = t.getParent();
        return `${t.getTextContent()}${$isLinkNode(parent) ? `<${parent.getURL()}>` : ''}`;
      })
      .join('|'),
  );

function deliver(
  to: Peer,
  from: Peer,
  which: (list: Uint8Array[]) => Uint8Array[],
) {
  const list = to.pending.get(from) ?? [];
  const chosen = which(list);
  to.pending.set(
    from,
    list.filter(u => !chosen.includes(u)),
  );
  for (const u of chosen) {
    Y.applyUpdate(to.doc, u, to.net);
  }
}

for (const gc of [false, true]) {
  test(`a [] opener delivered while its end waits for another client's text shows no empty link (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createLinkNode('https://u.test').append($createTextNode('ac')),
          ),
          $p('q'),
        );
      },
      {delivery: 'sender', gc, ids: [1, 2, 3]},
    );
    const [l, r, s] = t.peers;
    setFormatIdentityWrites(r.doc, true);
    // R's first paired write records layout 3 (withheld from L).
    r.update(() => {
      $selectIn([1], 0, 1).formatText('bold');
      $setSelection(null);
    });
    // S types "b" between a and c; only R gets it.
    s.update(() => {
      const ac = $text('ac');
      ac.select(1, 1).insertText('b');
      $setSelection(null);
    });
    deliver(r, s, list => list);
    await flush();
    // R removes the link over "ab": a [] opener before a, its end after b.
    r.update(() => {
      const abc = $text('abc');
      const sel = $createRangeSelection();
      sel.anchor.set(abc.getKey(), 0, 'text');
      sel.focus.set(abc.getKey(), 2, 'text');
      $setSelection(sel);
      $toggleLink(null);
      $setSelection(null);
    });
    await flush();
    // L gets only R's link removal: the opener integrates, its end waits
    // for S's "b".
    deliver(l, r, list => list.slice(-1));
    await flush();
    expect(links(l)).not.toContain('<>');
    // S's "b" arrives, then everything.
    deliver(l, s, list => list);
    await flush();
    await t.sync();
    const fresh = await freshReader(l);
    for (const p of [l, r, s, fresh]) {
      expect(links(p)).toBe('ab|c<https://u.test>');
    }
  });
}
