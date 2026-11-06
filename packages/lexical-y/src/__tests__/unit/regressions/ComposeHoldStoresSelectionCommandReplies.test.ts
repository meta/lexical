/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes at offset 1 in "abc", in an inline element before a link,
// with the selection's focus on the paragraph's end (an element point); the
// paragraph's canBeEmpty reads NodeState. B bolds "abc" (held), C flips that
// state. Whatever the binding does to foresee A's next update must not
// commit a selection change in an update of its own, tagged as remote:
// Lexical would dispatch SELECTION_CHANGE_COMMAND inside it, and the app's
// handler, which edits another paragraph to "tail!", would make an edit the
// binding never writes (A showing "tail!", every other peer "tail", also
// after the release). The binding foresees the next update read-only (see
// YBinding#foreseeNextUpdate).

import type {TextNode} from 'lexical';

import {$createLinkNode} from '@lexical/link';
import {
  $create,
  $createParagraphNode,
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
  COMMAND_PRIORITY_LOW,
  createState,
  ElementNode,
  ParagraphNode,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, setup} from '../../utils/harness';

const closed = createState('command_reply_closed', {
  parse: v => v === true,
});
class SwitchParagraph extends ParagraphNode {
  $config() {
    return this.config('command_reply_paragraph', {
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
    return this.config('command_reply_box', {
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
    test(`an app's reply to a selection change around a held boundary is stored (gc ${gc}, ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $create(SwitchParagraph).append(
              $create(Box).append(
                $createTextNode('abc'),
                $createLinkNode('https://test').append($createTextNode('next')),
              ),
            ),
            $createParagraphNode().append($createTextNode('tail')),
          );
        },
        {gc, ids, nodes: [...NODES, SwitchParagraph, Box]},
      );
      const {a, b, c} = t;
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      a.editor.setRootElement(host);
      host.focus();
      let key = '';
      let fired = 0;
      let composedDOM: Node | null = null;
      onTestFinished(() => {
        a.editor.setRootElement(null);
        host.remove();
        t.peers.forEach(p => p.stop());
      });
      a.update(() => {
        const n = $getRoot().getAllTextNodes()[0];
        key = n.getKey();
        const s = $createRangeSelection();
        s.anchor.set(key, 1, 'text');
        s.focus.set($getRoot().getFirstChild()!.getKey(), 1, 'element');
        $setSelection(s);
        $setCompositionKey(key);
      });
      a.update(() => {});
      expect(a.editor._compositionKey).toBe(key);
      composedDOM = a.editor.getElementByKey(key)!.firstChild;
      a.editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          const s = $getSelection();
          if (
            fired === 0 &&
            $isRangeSelection(s) &&
            s.focus.type === 'text' &&
            $getState($getRoot().getFirstChild()!, closed)
          ) {
            fired++;
            (
              (
                $getRoot().getLastChildOrThrow() as ElementNode
              ).getLastDescendant() as TextNode
            ).setTextContent('tail!');
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      );
      b.update(() => {
        const n = $getRoot().getAllTextNodes()[0];
        n.select(0, 3).formatText('bold');
        $setSelection(null);
      });
      await t.sync();
      c.update(() => {
        $setState($getRoot().getFirstChild()!, closed, true);
        $setSelection(null);
      });
      await t.sync();
      const during = {
        domConnected: composedDOM!.isConnected,
        key: a.editor._compositionKey,
      };
      a.update(() => $setCompositionKey(null));
      await t.sync();
      const fresh = await freshReader(a);
      expect(during.key).toBe(key);
      expect(during.domConnected).toBe(true);
      expect(fired).toBe(1);
      expect(a.warnings.filter(w => /self-check|could not be/.test(w))).toEqual(
        [],
      );
      expect(a.describe()).toBe(fresh.describe());
      expect(a.read(() => $getRoot().getTextContent())).toContain('tail!');
      for (const p of t.peers) {
        expect(p.describe()).toBe(a.describe());
      }
    });
