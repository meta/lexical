/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// An inline container being composed keeps the DOM text node the browser
// composes in through a remote change that reaches into it, and through
// the composer's ordinary typing after it, as a line does (see
// ComposeHoldKeepsDomTarget): the container's reads go by the held view.
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getNodeByKey,
  $getRoot,
  $setCompositionKey,
  $setSelection,
  ElementNode,
  type TextNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, setup} from '../../utils/harness';

class LegacyInline extends ElementNode {
  $config() {
    return this.config('compose_legacy_inline', {
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

function container(doc: Y.Doc): Y.Node {
  for (const structs of doc.store.clients.values())
    for (const it of structs) {
      if (
        it instanceof Y.Item &&
        it.content instanceof Y.ContentString &&
        it.content.str.includes('four')
      )
        return it.parent as Y.Node;
    }
  throw new Error('no text container');
}

for (const gc of [false, true]) {
  for (const nested of [false, true]) {
    for (const forceRead of [false, true]) {
      test(`a composed inline container keeps the DOM text node composed in through a remote change and typing (nested ${nested}, read ${forceRead}, gc ${gc})`, async () => {
        const t = await setup(
          () => {
            const text = $createTextNode('one two three four');
            $getRoot().append(
              $createParagraphNode().append($createTextNode('zero')),
              $createParagraphNode().append(
                nested
                  ? $create(LegacyInline).append(
                      $create(LegacyInline).append(text),
                    )
                  : text,
              ),
            );
          },
          {gc, ids: [1, 2, 3], nodes: [...NODES, LegacyInline]},
        );
        const {a, b, c} = t;
        const host = document.createElement('div');
        host.contentEditable = 'true';
        document.body.append(host);
        a.editor.setRootElement(host);
        onTestFinished(() => {
          a.editor.setRootElement(null);
          host.remove();
          for (const p of t.peers) p.stop();
        });
        t.offline();
        b.update(() => {
          const n = $getRoot()
            .getAllTextNodes()
            .find(x => x.getTextContent().includes('four'))!;
          n.select(0, 7).formatText('bold');
          $setSelection(null);
        });
        c.update(() => {
          const n = $getRoot()
            .getAllTextNodes()
            .find(x => x.getTextContent().includes('four'))!;
          n.select(4, 13).formatText('bold');
          $setSelection(null);
        });
        await t.sync();
        const parent = container(c.doc);
        if (nested) expect(parent).not.toBe(c.doc.get('lexical-y'));
        const own: Y.Item[] = [];
        for (let it = parent._start; it; it = it.right) {
          if (
            !it.deleted &&
            it.id.client === c.doc.clientID &&
            it.content instanceof Y.ContentFormat &&
            it.content.key === 'f:bold'
          )
            own.push(it);
        }
        const opener = own.find(
          it => (it.content as Y.ContentFormat).value === true,
        )!;
        const end =
          own.find(it =>
            Array.isArray((it.content as Y.ContentFormat).value),
          ) ?? own.find(it => (it.content as Y.ContentFormat).value === null);
        expect(opener).toBeDefined();
        expect(end).toBeDefined();
        c.doc.transact(tr => end!.delete(tr), 'remove end');
        await t.sync();
        let key = '';
        a.update(() => {
          const n = $getRoot()
            .getAllTextNodes()
            .find(x => x.getTextContent().includes('four'))!;
          key = n.getKey();
          n.selectEnd();
          $setCompositionKey(key);
        });
        const oldText = a.editor.getElementByKey(key)!.firstChild!;
        expect(oldText.isConnected).toBe(true);
        const snapshot = () =>
          a.read(() =>
            $getRoot()
              .getAllTextNodes()
              .flatMap(n =>
                [...n.getTextContent()].map(ch => [ch, n.getFormat()]),
              ),
          );
        const heldBefore = snapshot();
        const p = container(b.doc);
        const flat = p
          .toDelta()
          .children.map(v => {
            const insert = (v as {insert?: unknown}).insert;
            return typeof insert === 'string' ? insert : '\u0001';
          })
          .join('');
        const start = flat.indexOf('one');
        const value =
          b.doc.get('lexical-y').getAttr('lexical-y:4') === true
            ? [opener.id.client, opener.id.clock]
            : null;
        p.format(start + 13, 1, {'f:bold': value});
        await t.sync();
        expect(snapshot()).toEqual(heldBefore);
        if (forceRead) {
          p.delete(start, 1);
          await t.sync();
          expect(oldText.isConnected).toBe(true);
          const afterDelete = [...heldBefore];
          afterDelete.splice(4, 1);
          expect(snapshot()).toEqual(afterDelete);
        }
        expect(a.read(() => $getNodeByKey(key)?.isAttached())).toBe(true);
        expect(oldText.isConnected).toBe(true);
        a.update(() => {
          const n = $getNodeByKey(key) as TextNode;
          n.setTextContent(n.getTextContent() + 'X');
        });
        expect(oldText.isConnected).toBe(true);
        a.update(() => $setCompositionKey(null));
        await t.sync();
        expect(a.warnings.filter(w => /self-check|recovered/.test(w))).toEqual(
          [],
        );
        expect(a.read(() => $getRoot().getTextContent())).toContain('fourX');
        // (A paragraph's text format derived from A's DOM selection is not
        // stored, on main too: compared without it.)
        for (const peer of t.peers) {
          expect(peer.describe()).toBe(a.describe());
        }
        expect((await freshReader(a)).describe()).toBe(a.describe());
      });
    }
  }
}
