/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$removeMarkID} from '@lexical/mark';
import {registerRichText} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {expect, test, vi} from 'vitest';

import {flush, setup, WITH_GC} from '../../utils/harness';
import {prepareMarkState} from '../../utils/sizeOps';

// Replay the desktop Safari handler. This checks Lexical's DOM target;
// jsdom does not simulate a system IME or WebKit's layout engine.
vi.mock('lexical/src/environment', async importOriginal => ({
  ...(await importOriginal<typeof import('lexical/src/environment')>()),
  IS_APPLE: true,
  IS_APPLE_WEBKIT: true,
  IS_CHROME: false,
  IS_FIREFOX: false,
  IS_IOS: false,
  IS_SAFARI: true,
}));

test('Safari empty composition target survives read-back of other segment parts', async () => {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('alpha beta gamma').setMode('segmented'),
        ),
      ),
    {gc: WITH_GC, prepare: prepareMarkState},
  );
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  const off = registerRichText(t.b.editor);
  try {
    const raw = t.a.doc.get('lexical-y') as unknown as {
      format(at: number, length: number, attrs: object): void;
    };
    t.a.doc.transact(
      () => raw.format(6, 4, {'s:markIds\u001fc5': true}),
      'outside',
    );
    await t.sync();
    t.b.editor.setRootElement(root);
    root.focus();
    t.b.update(() => {
      const first = (
        $getRoot().getFirstChildOrThrow() as ElementNode
      ).getFirstChildOrThrow() as TextNode;
      first.select(6, 6);
    });
    root.dispatchEvent(
      new CompositionEvent('compositionstart', {bubbles: true, data: ''}),
    );
    await flush();
    const key = t.b.editor._compositionKey!;
    expect(key).not.toBeNull();
    expect(t.b.read(() => $getNodeByKey(key)?.getTextContent())).toBe('');
    const target = t.b.editor.getElementByKey(key);
    expect(target).not.toBeNull();
    t.b.update(() => $removeMarkID('c5'));
    await t.sync();
    expect(root.contains(target)).toBe(true);
    expect(t.b.editor._compositionKey).toBe(key);
    expect(t.b.editor.getElementByKey(key)).toBe(target);
  } finally {
    off();
    t.b.editor.setRootElement(null);
    root.remove();
    for (const peer of t.peers) {
      peer.stop();
      peer.doc.destroy();
    }
  }
});
