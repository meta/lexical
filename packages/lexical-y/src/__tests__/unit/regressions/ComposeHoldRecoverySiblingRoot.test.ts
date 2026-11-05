/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Two bindings on one Y.Doc (two roots, side by side or the second stored
// inside the first's tree). While the first holds a
// collaborator's R back, its write fails at its start (an insertion-free
// change, the decision bypassed), so its recovery undoes the failed attempt
// inside the transaction. A write the second binding makes in that same
// transaction (from a beforeTransaction listener, from inside the failed
// write, or from an observer of the first root) is not the attempt's: it is
// kept. X is kept once, R once, and every peer and a fresh reader agree.

import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $setCompositionKey,
  $setSelection,
  createEditor,
  ElementNode,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

import {createYDoc} from '../../..';
import {YBinding} from '../../../internal/Binding';
import {Writer} from '../../../internal/Write';

class SiblingBox extends ElementNode {
  $config() {
    return this.config('sibling_box', {
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

type View = {
  binding: YBinding;
  editor: LexicalEditor;
  root: Y.Node;
  errors: unknown[];
};
type Client = {doc: Y.Doc; views: View[]; stop: () => void};

const $source = () =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getParent() instanceof SiblingBox)!;

const text = (v: View) =>
  v.editor.getEditorState().read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join('|'),
  );

type Layout = 'side by side' | 'the second stored inside the first';

function client(
  id: number,
  gc: boolean,
  seed: Uint8Array | null,
  layout: Layout,
): Client {
  const doc = createYDoc(seed, {gc});
  doc.clientID = id;
  const app = doc.get('app');
  if (seed === null) {
    app.setAttr('one', new Y.Node('editor-root'));
    // A root stored inside the first binding's root (an attribute it does
    // not own): a write under it is the second binding's, not the first's.
    (layout === 'side by side' ? app : (app.getAttr('one') as Y.Node)).setAttr(
      'two',
      new Y.Node('editor-root'),
    );
  }
  const rootOf = (key: string): Y.Node =>
    key === 'one' || layout === 'side by side'
      ? (app.getAttr(key) as Y.Node)
      : ((app.getAttr('one') as Y.Node).getAttr(key) as Y.Node);
  const views = ['one', 'two'].map(key => {
    const errors: unknown[] = [];
    const editor = createEditor({
      nodes: [SiblingBox],
      onError: e => {
        errors.push(e);
        throw e;
      },
      onWarn: () => {},
    });
    if (seed === null) {
      editor.update(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $create(SiblingBox).append($createTextNode('abc')),
            ),
            $createParagraphNode().append($createTextNode('separator')),
          ),
        {discrete: true},
      );
    }
    const root = rootOf(key);
    const binding = new YBinding(editor, doc, {
      root,
      schemaVersion: 1,
      selfCheck: true,
    });
    binding.start();
    if (seed === null) {
      binding.initialize();
    }
    return {binding, editor, errors, root};
  });
  return {doc, stop: () => views.forEach(v => v.binding.dispose()), views};
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('a recovery undoes only its own failed attempt', () => {
  for (const layout of [
    'side by side',
    'the second stored inside the first',
  ] as const) {
    for (const gc of [false, true]) {
      for (const ids of [
        [1, 2, 3],
        [3, 2, 1],
      ]) {
        for (const when of [
          'in a beforeTransaction listener',
          'from inside the failed write',
          'from an observer of the first root',
        ] as const) {
          test(`roots ${layout}: a sibling root's write ${when} is kept (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
            const errors = vi
              .spyOn(console, 'error')
              .mockImplementation(() => {});
            onTestFinished(() => errors.mockRestore());
            const origin = {};
            const a = client(ids[0], gc, null, layout);
            await tick();
            const seed = Y.encodeStateAsUpdate(a.doc);
            const peers = [
              a,
              client(ids[1], gc, seed, layout),
              client(ids[2], gc, seed, layout),
            ];
            onTestFinished(() => peers.forEach(p => p.stop()));
            await tick();
            const queue: [Client, Uint8Array][] = [];
            let pumping = false;
            for (const p of peers) {
              p.doc.on('update', (u: Uint8Array, o: unknown) => {
                if (o === origin) {
                  return;
                }
                for (const q of peers) {
                  if (q !== p) {
                    queue.push([q, u]);
                  }
                }
                if (pumping) {
                  return;
                }
                pumping = true;
                try {
                  while (queue.length > 0) {
                    const [q, packet] = queue.shift()!;
                    Y.applyUpdate(q.doc, packet, origin);
                  }
                } finally {
                  pumping = false;
                }
              });
            }
            const [one, two] = a.views;
            one.editor.update(
              () => {
                $source().select(1, 1);
                $setCompositionKey($source().getKey());
              },
              {discrete: true},
            );
            await tick();
            peers[1].views[0].editor.update(
              () => {
                $source().spliceText(1, 0, 'R');
                $setSelection(null);
              },
              {discrete: true},
            );
            await tick();
            let armed = false;
            let wrote = false;
            let faulted = false;
            const siblingWrite = () => {
              if (wrote) {
                return;
              }
              wrote = true;
              two.editor.update(
                () => {
                  $source().spliceText(3, 0, 'X');
                  $setSelection(null);
                },
                {discrete: true},
              );
            };
            const endangers = Writer.prototype.$endangersHeld;
            Writer.prototype.$endangersHeld = function (this: Writer) {
              const decided = endangers.call(this);
              return armed && this.tr.doc === a.doc ? false : decided;
            };
            const run = Writer.prototype.$run;
            Writer.prototype.$run = function (this: Writer) {
              if (
                armed &&
                !faulted &&
                this.tr.doc === a.doc &&
                (this as unknown as {state: {root: Y.Node}}).state.root ===
                  one.root
              ) {
                if (when === 'from inside the failed write') {
                  siblingWrite();
                }
                faulted = true;
                throw new Error('the first root fails at its start');
              }
              return run.call(this);
            };
            const before = (tr: Y.Transaction) => {
              if (
                armed &&
                when === 'in a beforeTransaction listener' &&
                tr.origin === one.binding
              ) {
                siblingWrite();
              }
            };
            const observer = () => {
              if (armed && when === 'from an observer of the first root') {
                siblingWrite();
              }
            };
            a.doc.on('beforeTransaction', before);
            one.root.observeDeep(observer);
            onTestFinished(() => {
              Writer.prototype.$endangersHeld = endangers;
              Writer.prototype.$run = run;
              a.doc.off('beforeTransaction', before);
              one.root.unobserveDeep(observer);
            });
            armed = true;
            one.editor.update(
              () => {
                $source().getParentOrThrow().remove();
                if (when === 'from an observer of the first root') {
                  // Something the recovery does write on the first root (a
                  // deletion: still no character inserted), so that its
                  // observers run (in the transaction's cleanup).
                  $getRoot()
                    .getAllTextNodes()
                    .find(n => n.getTextContent() === 'separator')!
                    .spliceText(8, 1, '');
                }
                $setSelection(null);
              },
              {discrete: true},
            );
            armed = false;
            Writer.prototype.$endangersHeld = endangers;
            Writer.prototype.$run = run;
            await tick();
            one.editor.update(() => $setCompositionKey(null), {discrete: true});
            await tick();
            expect(faulted).toBe(true);
            expect(wrote).toBe(true);
            const fresh = client(99, gc, Y.encodeStateAsUpdate(a.doc), layout);
            onTestFinished(() => fresh.stop());
            await tick();
            const all = [...peers, fresh];
            for (const p of all) {
              expect(text(p.views[1]).split('X')).toHaveLength(2);
              expect(text(p.views[0]).split('R')).toHaveLength(2);
            }
            for (const i of [0, 1]) {
              const stored = text(fresh.views[i]);
              for (const p of peers) {
                expect(text(p.views[i])).toBe(stored);
              }
            }
            expect(peers.flatMap(p => p.views.flatMap(v => v.errors))).toEqual(
              [],
            );
          });
        }
      }
    }
  }
});
