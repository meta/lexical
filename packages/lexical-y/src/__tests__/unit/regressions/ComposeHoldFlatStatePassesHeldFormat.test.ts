/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A composes in an inline container; B bolds the composed text, which the
// composer's hold keeps back from A (see Hidden); A sets a flat NodeState
// value (`s:<key>`, written by main's format rules, Cursor#formatPlain) on
// the composed text while the hold lasts. The write passes over B's held
// format items as if they were not there (a held item gives nothing a value
// and is never deleted): once the composition ends, every peer and a fresh
// reader show the text bold, with A's value.

import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $getState,
  $setCompositionKey,
  $setSelection,
  $setState,
  createState,
  ElementNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {expectConverged, freshReader, NODES, setup} from '../../utils/harness';

class Box extends ElementNode {
  $config() {
    return this.config('compose_flat_state_box', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isInline(): true {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
}

const tone = createState('tone', {
  parse: v => (typeof v === 'string' ? v : ''),
});

const $show = () =>
  $getRoot()
    .getAllTextNodes()
    .map(n => `${n.getTextContent()}:${n.getFormat()}:${$getState(n, tone)}`)
    .join('|');

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`a flat NodeState value set on text composed in an inline container passes over a collaborator's format held from the composer (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $create(Box).append($createTextNode('abc')),
            ),
          );
        },
        {gc, ids, nodes: [...NODES, Box]},
      );
      const {a, b} = t;
      a.update(() => {
        const n = $getRoot().getAllTextNodes()[0];
        n.select(1, 1);
        $setCompositionKey(n.getKey());
      });
      await t.sync();
      b.update(() => {
        $getRoot().getAllTextNodes()[0].setFormat('bold');
        $setSelection(null);
      });
      await t.sync();
      // Held from A while it composes.
      expect(
        (a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
      ).not.toBeNull();
      expect(a.read($show)).toBe('abc:0:');
      a.update(() => $setState($getRoot().getAllTextNodes()[0], tone, 'x'));
      await t.sync();
      expect(a.read($show)).toBe('abc:0:x');
      a.update(() => $setCompositionKey(null));
      await t.sync();
      expect(a.warnings.filter(w => /self-check|recovered/.test(w))).toEqual(
        [],
      );
      await expectConverged(t.peers);
      for (const p of t.peers) {
        expect(p.read($show)).toBe('abc:1:x');
      }
      expect((await freshReader(a)).describe()).toBe(a.describe());
    });
  }
}
