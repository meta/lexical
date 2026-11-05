/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The text format a link stores (its wrapper value, stored where the link
// holds no text: around an inline container holding an equation) is what
// the composer's display shows while the inline container around it is
// being composed: the link keeps the text format it showed while a remote
// change that sets a new one is held back, also when that change edits the
// inner container too (which reads it and settles the text fields of the
// wrappers around it, see Reader#$settleWrapperTextFields). The settling
// took the stored formats there, held items included, for every owner but
// a line, and showed the new text format during the composition (main,
// which reads the same settling, shows it too). When the composition ends,
// the link shows the stored one.

import {$createLinkNode, $isLinkNode, type LinkNode} from '@lexical/link';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $setCompositionKey,
  ElementNode,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$createEquation, freshReader, NODES, setup} from '../../utils/harness';

class LegacyInline extends ElementNode {
  $config() {
    return this.config('compose_wrapper_inline', {
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

function $link(): LinkNode {
  const find = (node: LexicalNode): LinkNode | null => {
    if ($isLinkNode(node)) {
      return node;
    }
    if (node instanceof ElementNode) {
      for (const child of node.getChildren()) {
        const found = find(child);
        if (found !== null) {
          return found;
        }
      }
    }
    return null;
  };
  return find($getRoot())!;
}

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ]) {
    test(`a link in a composed inline container shows the text format it showed while a new one is held (ids ${ids}, gc ${gc})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $create(LegacyInline).append(
                $createTextNode('four five '),
                $createLinkNode('https://l.test/1').append(
                  $create(LegacyInline).append($createEquation('x')),
                ),
              ),
            ),
          ),
        {gc, ids, nodes: [...NODES, LegacyInline]},
      );
      const {a, b} = t;
      let key = '';
      a.update(() => {
        const text = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'four five ')!;
        key = text.getKey();
        text.select(4, 4);
        $setCompositionKey(key);
      });
      const before = a.read(() => $link().getTextFormat());
      b.update(() => {
        const link = $link();
        link.setTextFormat(1);
        (link.getFirstChild() as ElementNode).append($createEquation('y'));
      });
      await t.sync();
      expect(a.read(() => $link().getTextFormat())).toBe(before);
      expect(a.editor._compositionKey).toBe(key);
      a.update(() => $setCompositionKey(null));
      await t.sync();
      expect(a.read(() => $link().getTextFormat())).toBe(
        b.read(() => $link().getTextFormat()),
      );
      expect((await freshReader(a)).describe()).toBe(a.describe());
      expect(b.describe()).toBe(a.describe());
      for (const p of t.peers) {
        expect(p.warnings.filter(w => w.includes('self-check'))).toEqual([]);
        p.stop();
      }
    });
  }
}
