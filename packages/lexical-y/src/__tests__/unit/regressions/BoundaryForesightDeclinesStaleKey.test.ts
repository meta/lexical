/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A stale DOM key (a keyed span naming a node the editor no longer has)
// inside a link's text: Lexical's DOM lookup stops at the first key it finds
// and resolves nothing there, keeping the composition; the binding's
// foresight (Boundary.$nextUpdateSelection) climbed past it and foresaw a
// move. It now foresees nothing there (the safety net covers it).
import {$createLinkNode, LinkNode} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $setCompositionKey,
  createEditor,
} from 'lexical';
import {expect, test} from 'vitest';

import {$nextUpdateSelection} from '../../../internal/Boundary';

test('a stale DOM key makes the binding foresee nothing', () => {
  const editor = createEditor({
    namespace: 'stale',
    nodes: [LinkNode],
    onError: e => {
      throw e;
    },
  });
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  editor.setRootElement(host);
  host.focus();
  let key = '';
  editor.update(
    () => {
      const n = $createTextNode('cd');
      key = n.getKey();
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('ab'),
          $createLinkNode('https://test').append(n),
          $createTextNode('ef'),
        ),
      );
      n.select(2, 2);
      $setCompositionKey(key);
    },
    {discrete: true},
  );
  editor.setEditable(false);
  const outer = editor.getElementByKey(key)!;
  const text = outer.firstChild!;
  const inner = document.createElement('span');
  (inner as unknown as Record<string, string>)[`__lexicalKey_${editor._key}`] =
    'missing';
  outer.append(inner);
  inner.append(text);
  window.getSelection()!.setBaseAndExtent(text, 2, text, 2);
  const predicted = editor.read('latest', () => $nextUpdateSelection(editor));
  editor.update(() => {}, {discrete: true, event: new Event('beforeinput')});
  const selection = editor.read('latest', () => $getSelection());
  const actual = editor._compositionKey;
  expect(selection).not.toBeNull();
  expect(actual).toBe(key);
  expect(predicted).toBeUndefined();
  editor.setRootElement(null);
  host.remove();
});
