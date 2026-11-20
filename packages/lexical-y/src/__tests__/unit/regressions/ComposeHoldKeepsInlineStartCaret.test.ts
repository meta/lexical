/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes at offset 1 in MIDDLE, in an inline element between "prefix "
// and " tail". B bolds MIDDLE (held), C deletes its M: A's caret is at the
// start of the inline element's text. Lexical's normalization moves no
// collapsed caret there (only a selection's focus, for a moment, which it
// then puts back on the anchor), but the binding's check said it moved,
// released the hold, and replaced the DOM text node A composes in. Main
// keeps both.
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $setCompositionKey,
  $setSelection,
  ElementNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, setup} from '../../utils/harness';

class InlineBox extends ElementNode {
  $config() {
    return this.config('r24_inline_start', {
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
    test(`a composing caret at the start of an inline container keeps the hold and the DOM text node (gc ${gc}, ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('prefix '),
              $create(InlineBox).append($createTextNode('MIDDLE')),
              $createTextNode(' tail'),
            ),
          );
        },
        {gc, ids, nodes: [...NODES, InlineBox]},
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
          .find(x => x.getTextContent() === 'MIDDLE')!;
        key = n.getKey();
        n.select(1, 1);
        $setCompositionKey(key);
      });
      a.update(() => {});
      expect(a.editor._compositionKey).toBe(key);
      const old = a.editor.getElementByKey(key)!.firstChild!;
      b.update(() => {
        const n = $getRoot()
          .getAllTextNodes()
          .find(x => x.getTextContent() === 'MIDDLE')!;
        n.select(0, 6).formatText('bold');
        $setSelection(null);
      });
      await t.sync();
      expect(old.isConnected).toBe(true);
      c.update(() => {
        const n = $getRoot()
          .getAllTextNodes()
          .find(x => x.getTextContent() === 'MIDDLE')!;
        n.select(0, 1).removeText();
        $setSelection(null);
      });
      await t.sync();
      a.update(() => {});
      await t.sync();
      expect(a.editor._compositionKey).toBe(key);
      expect(old.isConnected).toBe(true);
      a.update(() => $setCompositionKey(null));
      await t.sync();
      expect((await freshReader(a)).describe()).toBe(a.describe());
      expect(a.warnings.filter(w => /self-check|could not be/.test(w))).toEqual(
        [],
      );
    });
