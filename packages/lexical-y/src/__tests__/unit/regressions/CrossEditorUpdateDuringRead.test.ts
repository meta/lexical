/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// Editor B composes while a hold keeps deleted format items in its line.
// During a later read of B's, app code (a text node's selectionTransform, or
// an update listener) makes an ordinary update to editor A: it deletes the
// text of a stored inline container inside a link. A's update runs its own
// transforms (the link's text fields) while B's read is running; its
// readers and writers use A's view, and the update completes (development
// builds check each explicit view against the running work's in the part
// that applies to the items read).

import {$createLinkNode} from '@lexical/link';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getEditor,
  $getRoot,
  $hasUpdateTag,
  $setCompositionKey,
  $setSelection,
  COLLABORATION_TAG,
  ElementNode,
  TextNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, setup} from '../../utils/harness';

const triggers = new WeakMap<object, () => void>();

class TriggerText extends TextNode {
  $config() {
    return this.config('cross_editor_trigger', {extends: TextNode});
  }
  selectionTransform() {
    const editor = $getEditor();
    const trigger = triggers.get(editor);
    if (trigger !== undefined && $hasUpdateTag(COLLABORATION_TAG)) {
      triggers.delete(editor);
      trigger();
    }
  }
}

class Box extends ElementNode {
  $config() {
    return this.config('cross_editor_box', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isInline() {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM() {
    return false;
  }
}

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ]) {
    for (const hook of [
      'a selectionTransform',
      'an update listener',
    ] as const) {
      test(`an update ${hook} makes to another editor during a read completes (ids ${ids}, gc ${gc})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append(
                $create(TriggerText).setTextContent('abc').setFormat(1),
              ),
              $createParagraphNode().append(
                $createLinkNode('https://x.test').append(
                  $create(Box).append(
                    $createTextNode('xyz').setStyle('color: red;'),
                    $createLineBreakNode(),
                  ),
                ),
              ),
            );
          },
          {gc, ids, nodes: [...NODES, Box, TriggerText]},
        );
        const {a, b, c} = t;
        const hosts = [a, b].map(p => {
          const host = document.createElement('div');
          host.contentEditable = 'true';
          document.body.append(host);
          p.editor.setRootElement(host);
          return host;
        });
        onTestFinished(() => {
          [a, b].forEach((p, i) => {
            p.editor.setRootElement(null);
            hosts[i].remove();
          });
          t.peers.forEach(p => p.stop());
        });
        // B composes in the bold line; A removes the bold: B's hold keeps
        // the deleted format items.
        hosts[1].focus();
        b.update(() => {
          const text = $getRoot().getAllTextNodes()[0];
          text.select(1, 1);
          $setCompositionKey(text.getKey());
        });
        a.update(() => {
          $getRoot().getAllTextNodes()[0].setFormat(0);
          $setSelection(null);
        });
        await t.sync();
        const edit = () =>
          a.update(() => {
            $getRoot()
              .getAllTextNodes()
              .find(n => n.getTextContent() === 'xyz')!
              .remove();
          });
        let caught: string | null = null;
        if (hook === 'a selectionTransform') {
          triggers.set(b.editor, () => {
            try {
              edit();
            } catch (e) {
              caught = String(e);
            }
          });
        } else {
          let armed = true;
          onTestFinished(
            b.editor.registerUpdateListener(payload => {
              if (armed && payload.tags.has(COLLABORATION_TAG)) {
                armed = false;
                try {
                  edit();
                } catch (e) {
                  caught = String(e);
                }
              }
            }),
          );
        }
        // A remote change B reads, with B's hold on.
        c.update(() => {
          ($getRoot().getFirstChildOrThrow() as ElementNode).setIndent(1);
          $setSelection(null);
        });
        await t.sync();
        b.update(() => $setCompositionKey(null));
        await t.sync();
        const fresh = await freshReader(a);
        onTestFinished(() => fresh.stop());
        expect(a.errors).toEqual([]);
        expect(caught).toBeNull();
        expect(a.describe()).not.toContain('xyz');
        expect(a.describe()).toBe(fresh.describe());
      });
    }
  }
}
