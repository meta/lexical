/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A remote change that reaches into the line being composed never replaces
// the DOM text node the browser composes in: the composition goes on in
// it. A composes in "one two" (an editor with a DOM root); a raw writer
// formats from the start of "one two" into "after", the next line, with
// items it only inserts: a text format (bold), or a text node type (the
// `t` key). The DOM text node A composes in stays connected, as on main.

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setCompositionKey,
  TextNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {NODES, setup} from '../../utils/harness';

class ReadKind extends TextNode {
  $config() {
    return this.config('compose_dom_text_kind', {extends: TextNode});
  }
}

type Root = {
  format(at: number, length: number, attrs: object): void;
  toDelta(): {children: {insert?: unknown}[]};
};

for (const kind of ['type', 'bold'] as const) {
  for (const gc of [false, true]) {
    test(`a remote ${kind} change across the composed line keeps the DOM text node composed in (gc ${gc})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
            $createParagraphNode().append($createTextNode('after')),
          ),
        {gc, nodes: [...NODES, ReadKind]},
      );
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      onTestFinished(() => {
        t.a.editor.setRootElement(null);
        host.remove();
        for (const peer of t.peers) {
          peer.stop();
        }
      });
      t.a.editor.setRootElement(host);
      let key = '';
      t.a.update(() => {
        const node = $getRoot().getAllTextNodes()[0];
        key = node.getKey();
        node.select(1, 1);
        $setCompositionKey(key);
      });
      const text = t.a.editor.getElementByKey(key)!.firstChild!;
      expect(text.isConnected).toBe(true);
      const root = t.b.doc.get('lexical-y') as unknown as Root;
      const flat = root
        .toDelta()
        .children.map(p => (typeof p.insert === 'string' ? p.insert : '\u0001'))
        .join('');
      const from = flat.indexOf('one');
      root.format(
        from,
        flat.indexOf('after') + 2 - from,
        kind === 'type' ? {t: 'compose_dom_text_kind'} : {'f:bold': true},
      );
      await t.sync();
      expect(text.isConnected).toBe(true);
      t.a.update(() => $setCompositionKey(null));
    });
  }
}
