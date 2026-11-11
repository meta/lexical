/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The registry of bound roots a recovery's undo consults (see Binding's
// ownsUnderRoot): an outer binding whose root stores an inner root, and
// bindings on that inner root that come and go. However they come and go
// (two on the inner root, one disposed; one disposed and started again; an
// old one disposed again after a new one took its place), the outer
// binding's undo never reaches the inner root while a binding is registered
// on it, and the inner binding's X, written nested in the outer's failed
// attempt, is kept once, R once, and every peer agrees.

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

class RegistryBox extends ElementNode {
  $config() {
    return this.config('registry_box', {
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

type View = {binding: YBinding; editor: LexicalEditor; root: Y.Node};

const $source = () =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getParent() instanceof RegistryBox)!;

const text = (v: View) =>
  v.editor.getEditorState().read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent())
      .join('|'),
  );

type YDoc = ReturnType<typeof createYDoc>;

function view(doc: YDoc, root: Y.Node, initialize: boolean): View {
  const editor = createEditor({
    nodes: [RegistryBox],
    onError: e => {
      throw e;
    },
    onWarn: () => {},
  });
  if (initialize) {
    editor.update(
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $create(RegistryBox).append($createTextNode('abc')),
          ),
          $createParagraphNode().append($createTextNode('separator')),
        ),
      {discrete: true},
    );
  }
  const binding = new YBinding(editor, doc, {
    root,
    schemaVersion: 1,
    selfCheck: true,
  });
  binding.start();
  if (initialize) {
    binding.initialize();
  }
  return {binding, editor, root};
}

type Client = {doc: YDoc; outer: View; inner: View; extra: View[]};

function client(id: number, gc: boolean, seed: Uint8Array | null): Client {
  const doc = createYDoc(seed, {gc});
  doc.clientID = id;
  const app = doc.get('app');
  if (seed === null) {
    app.setAttr('one', new Y.Node('editor-root'));
    (app.getAttr('one') as Y.Node).setAttr('two', new Y.Node('editor-root'));
  }
  const outerRoot = app.getAttr('one') as Y.Node;
  const innerRoot = outerRoot.getAttr('two') as Y.Node;
  return {
    doc,
    extra: [],
    inner: view(doc, innerRoot, seed === null),
    outer: view(doc, outerRoot, seed === null),
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const ownsUnderRoot = (v: View, y: Y.Node): boolean =>
  (
    v.binding as unknown as {ownsUnderRoot: (type: Y.Node) => boolean}
  ).ownsUnderRoot(y);

describe('the registry of bound roots, as bindings come and go', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      for (const story of [
        'two bindings on the inner root, one disposed',
        'the inner binding disposed and started again',
        'an old inner binding disposed again after a new one took its place',
      ] as const) {
        test(`${story}: the outer undo keeps the inner X (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const errors = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
          onTestFinished(() => errors.mockRestore());
          const origin = {};
          const a = client(ids[0], gc, null);
          await tick();
          const seed = Y.encodeStateAsUpdate(a.doc);
          const peers = [a, client(ids[1], gc, seed), client(ids[2], gc, seed)];
          onTestFinished(() =>
            peers.forEach(p =>
              [p.outer, p.inner, ...p.extra].forEach(v => v.binding.dispose()),
            ),
          );
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
          const innerRoot = a.inner.root;
          // The inner binding that writes X, as the story leaves it.
          let writer: View = a.inner;
          if (story === 'two bindings on the inner root, one disposed') {
            const second = view(a.doc, innerRoot, false);
            a.extra.push(second);
            await tick();
            second.binding.dispose();
          } else if (story === 'the inner binding disposed and started again') {
            a.inner.binding.dispose();
            a.inner.binding.start();
            await tick();
          } else {
            const old = a.inner;
            old.binding.dispose();
            const next = view(a.doc, innerRoot, false);
            a.extra.push(next);
            await tick();
            old.binding.dispose();
            writer = next;
            // The new binding is the inner root's view from now on.
            a.extra.push(old);
            a.extra.splice(a.extra.indexOf(next), 1);
            a.inner = next;
          }
          expect(ownsUnderRoot(a.outer, innerRoot)).toBe(false);
          a.outer.editor.update(
            () => {
              $source().select(1, 1);
              $setCompositionKey($source().getKey());
            },
            {discrete: true},
          );
          await tick();
          peers[1].outer.editor.update(
            () => {
              $source().spliceText(1, 0, 'R');
              $setSelection(null);
            },
            {discrete: true},
          );
          await tick();
          // The outer's insertion-free write fails at its start, and the
          // inner binding writes X nested in it.
          let armed = false;
          let faulted = false;
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
                a.outer.root
            ) {
              faulted = true;
              // (Into plain text: a binding started again does not write
              // into an inline container it read before it stopped, on main
              // too, a separate issue.)
              writer.editor.update(
                () => {
                  const separator = $getRoot()
                    .getAllTextNodes()
                    .find(n => n.getTextContent() === 'separator')!;
                  separator.spliceText(9, 0, 'X');
                  $setSelection(null);
                },
                {discrete: true},
              );
              throw new Error('the outer root fails at its start');
            }
            return run.call(this);
          };
          onTestFinished(() => {
            Writer.prototype.$endangersHeld = endangers;
            Writer.prototype.$run = run;
          });
          armed = true;
          a.outer.editor.update(
            () => {
              $source().getParentOrThrow().remove();
              $setSelection(null);
            },
            {discrete: true},
          );
          armed = false;
          Writer.prototype.$endangersHeld = endangers;
          Writer.prototype.$run = run;
          await tick();
          a.outer.editor.update(() => $setCompositionKey(null), {
            discrete: true,
          });
          await tick();
          expect(faulted).toBe(true);
          const fresh = client(99, gc, Y.encodeStateAsUpdate(a.doc));
          onTestFinished(() => {
            fresh.outer.binding.dispose();
            fresh.inner.binding.dispose();
          });
          await tick();
          for (const p of [...peers, fresh]) {
            expect(text(p.inner).split('X')).toHaveLength(2);
            expect(text(p.outer).split('R')).toHaveLength(2);
          }
          expect(text(writer).split('X')).toHaveLength(2);
          for (const p of peers) {
            expect(text(p.outer)).toBe(text(fresh.outer));
            expect(text(p.inner)).toBe(text(fresh.inner));
          }
        });
      }
    }
  }
});
