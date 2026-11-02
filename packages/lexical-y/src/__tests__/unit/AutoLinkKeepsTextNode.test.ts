/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {autoLinkUrlMatcher, registerAutoLink} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setState,
  createState,
} from 'lexical';
import {expect, test} from 'vitest';

import {$selectIn, expectConverged, type Peer, setup} from '../utils/harness';

const state = createState('autolink-collab-comment', {
  parse: value => (typeof value === 'string' ? value : ''),
});

function atoms(peer: Peer) {
  const result: [string, string][] = [];
  type Item = {
    right: Item | null;
    deleted: boolean;
    id: {client: number; clock: number};
    content: {str?: string; type?: {_start?: Item | null}};
  };
  const root = peer.binding.root as unknown as {_start: Item | null};
  const walk = (first: Item | null) => {
    for (let item = first; item; item = item.right) {
      if (item.deleted) continue;
      const text = item.content.str;
      if (typeof text === 'string') {
        for (let i = 0; i < text.length; i++) {
          result.push([`${item.id.client}:${item.id.clock + i}`, text[i]]);
        }
      } else if (item.content.type?._start) {
        walk(item.content.type._start);
      }
    }
  };
  walk(root._start);
  return result;
}

test.each([false, true])(
  'autolinking keeps Y characters, concurrent edits and undo coherent (several: %s)',
  async several => {
    let enabled = false;
    const {a, b, peers, offline, sync} = await setup(
      () => {
        const first = $setState(
          $createTextNode(several ? 'https://a' : 'https://a.com').setStyle(
            'color: red;',
          ),
          state,
          'comment',
        );
        const paragraph = $createParagraphNode().append(first);
        if (several) {
          paragraph.append(
            $setState($createTextNode('.com').setFormat(1), state, 'comment'),
          );
        }
        $getRoot().append(paragraph);
      },
      {
        gc: true,
        prepare: editor =>
          registerAutoLink(editor, {
            changeHandlers: [],
            excludeParents: [],
            matchers: [text => (enabled ? autoLinkUrlMatcher(text) : null)],
          }),
      },
    );
    try {
      const before = atoms(a);
      enabled = true;
      a.update(() => $getRoot().getAllTextNodes()[0].markDirty());
      expect(atoms(a).map(([, char]) => char)).toEqual(
        before.map(([, char]) => char),
      );
      await expectConverged(peers);
      for (const peer of peers) {
        peer.read(() => {
          expect(
            $getRoot()
              .getAllTextNodes()
              .map(node => $getState(node, state)),
          ).toEqual(several ? ['comment', 'comment'] : ['comment']);
        });
      }
      a.undo();
      expect(atoms(a).map(([, char]) => char)).toEqual(
        before.map(([, char]) => char),
      );
      await expectConverged(peers);
      a.binding.redo();
      expect(atoms(a).map(([, char]) => char)).toEqual(
        before.map(([, char]) => char),
      );
      await expectConverged(peers);
      const linked = atoms(a);
      offline();
      a.update(() => $selectIn([0], 10).insertText('x'));
      b.update(() => $selectIn([0], 10, 11).insertText(''));
      await sync();
      await expectConverged(peers);
      expect(a.read(() => $getRoot().getTextContent())).toBe('https://a.xom');
      expect(
        atoms(a).filter(([id]) => linked.some(([old]) => old === id)),
      ).toEqual(linked.filter((_, i) => i !== 10));
    } finally {
      peers.forEach(peer => {
        peer.stop();
        peer.doc.destroy();
      });
    }
  },
);
