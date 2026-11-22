/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes in "abc", in an inline element before a link around "next",
// with the selection's focus on the paragraph's end (an element point);
// the paragraph's canBeEmpty() reads NodeState. B unlinks "next"; C deletes
// "c" and changes that state. The held display ends "ab" at the caret,
// before the link the hold keeps. Lexical's next update resolves the focus
// to text (through the changed canBeEmpty), then moves the anchor and the
// composition into the kept link at the boundary: the binding's check,
// which saw no element point, did not see it coming. Main keeps the
// composition. The binding now foresees the next update read-only, element
// points resolved as Lexical resolves them (see YBinding#foreseeNextUpdate).
import {$createLinkNode} from '@lexical/link';
import {
  $create,
  $createRangeSelection,
  $createTextNode,
  $getDocument,
  $getRoot,
  $getSelection,
  $getState,
  $isRangeSelection,
  $setCompositionKey,
  $setSelection,
  $setState,
  createState,
  ElementNode,
  ParagraphNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, setup} from '../../utils/harness';

const closed = createState('r25_closed', {parse: v => v === true});
class SwitchParagraph extends ParagraphNode {
  $config() {
    return this.config('r25_switch', {
      extends: ParagraphNode,
      stateConfigs: [{stateConfig: closed}],
    });
  }
  canBeEmpty() {
    return !$getState(this, closed);
  }
}
class Box extends ElementNode {
  $config() {
    return this.config('r25_element_hold', {
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
for (const gc of [false, true])
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ])
    test(`a selection with an element end that resolves to text at the next update keeps the composition (gc ${gc}, ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $create(SwitchParagraph).append(
              $create(Box).append(
                $createTextNode('abc'),
                $createLinkNode('https://test').append($createTextNode('next')),
              ),
            ),
          );
        },
        {gc, ids, nodes: [...NODES, Box, SwitchParagraph]},
      );
      const {a, b, c} = t;
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      a.editor.setRootElement(host);
      onTestFinished(() => {
        a.editor.setRootElement(null);
        host.remove();
        t.peers.forEach(p => p.stop());
      });
      let key = '';
      a.update(() => {
        const n = $getRoot()
          .getAllTextNodes()
          .find(x => x.getTextContent() === 'abc')!;
        key = n.getKey();
        const s = $createRangeSelection();
        s.anchor.set(key, 2, 'text');
        s.focus.set($getRoot().getFirstChild()!.getKey(), 1, 'element');
        $setSelection(s);
        $setCompositionKey(key);
      });
      a.update(() => {});
      expect(a.editor._compositionKey).toBe(key);
      a.update(() => {
        const s = $getSelection();
        if (!$isRangeSelection(s)) throw Error('not range');
        s.focus.set($getRoot().getFirstChild()!.getKey(), 1, 'element');
      });
      expect(a.editor._compositionKey).toBe(key);
      const old = a.editor.getElementByKey(key)!.firstChild!;
      b.update(() => {
        const n = $getRoot()
          .getAllTextNodes()
          .find(x => x.getTextContent() === 'next')!;
        const link = n.getParent()!;
        link.replace(n);
        $setSelection(null);
      });
      await t.sync();
      c.update(() => {
        const n = $getRoot()
          .getAllTextNodes()
          .find(x => x.getTextContent().includes('abc'))!;
        n.select(2, 3).removeText();
        $setState($getRoot().getFirstChild()!, closed, true);
        $setSelection(null);
      });
      await t.sync();
      a.update(() => {});
      expect(a.editor._compositionKey).toBe(key);
      expect(old.isConnected).toBe(true);
      a.update(() => $setCompositionKey(null));
      await t.sync();
      expect((await freshReader(a)).describe()).toBe(a.describe());
    });
