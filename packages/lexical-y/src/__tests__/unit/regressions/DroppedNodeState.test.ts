/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// #9789: node state an editor shows that the document does not store:
// - a text node emptied with setTextContent('') that is not simple text (a
//   token or segmented TextNode, a TextNode subclass, a code highlight):
//   Lexical's normalization removes only empty simple text, and text is
//   stored as runs of characters, which an empty node has none of;
// - NodeState set on the root: the document stores the root's children, not
//   its own fields.
// The editing client kept it while every other client and a fresh reader did
// not, with no warning. An emptied text node is now read back after the
// write (removed), with a warning; root NodeState is left as it is (apps
// share document metadata there themselves), a documented limit.

import {$createCodeHighlightNode, $createCodeNode} from '@lexical/code';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $getSlot,
  $getState,
  $hasUpdateTag,
  $setCompositionKey,
  $setSelection,
  $setSlot,
  $setState,
  COLLABORATION_TAG,
  createState,
  type ElementNode,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../../utils/harness';

/** The warnings of what a local update left that is not stored. */
const unstorable = (peer: Peer) =>
  peer.warnings.filter(w => w.includes('does not store'));

const data = createState('dropped_state', {
  parse: v => (typeof v === 'string' ? v : ''),
});

/** A TextNode subclass with nothing of its own. */
class PlainSubclassText extends TextNode {
  $config() {
    return this.config('dropped_subclass_text', {extends: TextNode});
  }
}

type Kind =
  | 'token'
  | 'segmented'
  | 'unmergeable'
  | 'subclass'
  | 'code highlight';

function $node(kind: Kind): ElementNode {
  if (kind === 'code highlight') {
    return $createCodeNode().append(
      $createCodeHighlightNode('body', 'keyword'),
    );
  }
  const text =
    kind === 'subclass'
      ? $create(PlainSubclassText).setTextContent('body')
      : kind === 'unmergeable'
        ? $createTextNode('body').toggleUnmergeable()
        : $createTextNode('body').setMode(kind);
  return $createParagraphNode().append(text.setStyle('color: green;'));
}

/** What each client shows of the last block's text nodes. */
function $texts(): unknown[] {
  const block = $getRoot().getLastChildOrThrow() as ElementNode;
  return block
    .getAllTextNodes()
    .map(n => [
      n.getType(),
      n.getTextContent(),
      n.getMode(),
      n.getStyle(),
      $getState(n, data),
    ]);
}

describe('an emptied text node that is not simple text is read back', () => {
  for (const kind of [
    'token',
    'segmented',
    'unmergeable',
    'subclass',
    'code highlight',
  ] as const) {
    for (const gc of [false, true]) {
      test(`${kind}, gc ${gc}`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('one')),
              $node(kind),
            ),
          {gc, nodes: [...NODES, PlainSubclassText]},
        );
        t.a.update(() => {
          const block = $getRoot().getLastChildOrThrow() as ElementNode;
          const text = block.getAllTextNodes()[0];
          text.setTextContent('');
          $setState(text, data, 'kept');
        });
        await t.sync();
        const fresh = await freshReader(t.a);
        // The document does not store it: the editor reads it back, and no
        // client shows it.
        expect(t.a.read($texts)).toEqual([]);
        expect(t.a.read($texts)).toEqual(fresh.read($texts));
        expect(t.b.read($texts)).toEqual(t.a.read($texts));
        expect(unstorable(t.a)).toHaveLength(1);
        await expectConverged(t.peers);
      });
    }
  }
});

// Lexical keeps an emptied node the caret (or a composition) is in while
// native input goes on, and removes it itself (on some platforms a moment
// later): it is read back only once a later commit finds the caret out of it.
describe('an emptied token the caret is in is read back once the caret leaves', () => {
  for (const gc of [false, true]) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one')),
            $node('token'),
          ),
        {gc},
      );
      t.a.update(() => {
        const block = $getRoot().getLastChildOrThrow() as ElementNode;
        block.getAllTextNodes()[0].setTextContent('').select(0, 0);
      });
      await t.sync();
      // Held: the editor still shows it, nothing is warned yet.
      expect(t.a.read($texts)).toHaveLength(1);
      expect(unstorable(t.a)).toEqual([]);
      t.a.update(() => {
        const first = $getRoot().getFirstChildOrThrow() as ElementNode;
        first.getAllTextNodes()[0].spliceText(3, 0, '!', true);
      });
      await t.sync();
      const fresh = await freshReader(t.a);
      expect(t.a.read($texts)).toEqual([]);
      expect(t.a.read($texts)).toEqual(fresh.read($texts));
      expect(t.b.read($texts)).toEqual(t.a.read($texts));
      expect(unstorable(t.a)).toHaveLength(1);
      await expectConverged(t.peers);
    });
  }
});

describe('an emptied token a composition is in is read back once the composition ends', () => {
  for (const gc of [false, true]) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one')),
            $node('token'),
          ),
        {gc},
      );
      t.a.update(() => {
        const block = $getRoot().getLastChildOrThrow() as ElementNode;
        const text = block.getAllTextNodes()[0].setTextContent('');
        $setCompositionKey(text.getKey());
        $setSelection(null);
      });
      await t.sync();
      // Held: the editor still shows it, nothing is warned yet.
      expect(t.a.read($texts)).toHaveLength(1);
      expect(unstorable(t.a)).toEqual([]);
      t.a.update(() => {
        $setCompositionKey(null);
      });
      await t.sync();
      const fresh = await freshReader(t.a);
      expect(t.a.read($texts)).toEqual([]);
      expect(t.a.read($texts)).toEqual(fresh.read($texts));
      expect(unstorable(t.a)).toHaveLength(1);
      await expectConverged(t.peers);
    });
  }
});

describe('an emptied node held for the caret is read back by a commit that only moves the selection', () => {
  for (const kind of ['token', 'code highlight'] as const) {
    for (const move of ['no selection', 'another line'] as const) {
      for (const gc of [false, true]) {
        test(`${kind}, ${move}, gc ${gc}`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append($createTextNode('one')),
                $node(kind),
              ),
            {gc},
          );
          t.a.update(() => {
            const block = $getRoot().getLastChildOrThrow() as ElementNode;
            block.getAllTextNodes()[0].setTextContent('').select(0, 0);
          });
          await t.sync();
          expect(t.a.read($texts)).toHaveLength(1);
          t.a.update(() => {
            if (move === 'no selection') {
              $setSelection(null);
            } else {
              $getRoot().getAllTextNodes()[0].select(1, 1);
            }
          });
          await t.sync();
          const fresh = await freshReader(t.a);
          expect(t.a.read($texts)).toEqual([]);
          expect(t.a.read($texts)).toEqual(fresh.read($texts));
          expect(unstorable(t.a)).toHaveLength(1);
          await expectConverged(t.peers);
        });
      }
    }
  }
});

/** Runs an app's callback in the update of a remote change's read. */
const inRead = new WeakMap<LexicalEditor, () => void>();
class ReadHook extends TextNode {
  $config() {
    return this.config('dropped_read_hook', {extends: TextNode});
  }
  selectionTransform(): void {
    const editor = $getEditor();
    const run = inRead.get(editor);
    if (run !== undefined && $hasUpdateTag(COLLABORATION_TAG)) {
      inRead.delete(editor);
      run();
    }
  }
}

// An app's code that empties a token in the update of a remote change's read
// (in that update, or in an update it queues there): written as this
// client's change (D111), and read back as a local update's is.
describe('an emptied token an app writes in a remote read is read back', () => {
  for (const route of ['in the read', 'queued in the read'] as const) {
    for (const gc of [false, true]) {
      test(`${route}, gc ${gc}`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                $create(ReadHook).setTextContent('anchor'),
              ),
              $node('token'),
              $createParagraphNode().append($createTextNode('other')),
            ),
          {gc, nodes: [...NODES, ReadHook]},
        );
        try {
          t.a.update(() => $getRoot().getAllTextNodes()[0].select(1, 1));
          await t.sync();
          const $empty = () => {
            ($getRoot().getChildAtIndex(1) as ElementNode)
              .getAllTextNodes()[0]
              .setTextContent('');
          };
          inRead.set(t.a.editor, () => {
            if (route === 'queued in the read') {
              t.a.editor.update($empty);
            } else {
              $empty();
            }
          });
          t.b.update(() => {
            $getRoot().getAllTextNodes().at(-1)!.spliceText(5, 0, '!');
            $setSelection(null);
          });
          await t.sync();
          const fresh = await freshReader(t.a);
          const $middle = () =>
            ($getRoot().getChildAtIndex(1) as ElementNode)
              .getAllTextNodes()
              .map(n => n.getTextContent());
          expect(t.a.read($middle)).toEqual([]);
          expect(t.a.read($middle)).toEqual(fresh.read($middle));
          expect(t.b.read($middle)).toEqual([]);
          await expectConverged(t.peers);
        } finally {
          inRead.delete(t.a.editor);
        }
      });
    }
  }
});

// An app's code that empties the token again in the update of every read,
// the binding's re-reads included: read back a bounded number of times (see
// MAX_REREADS), then left until a user's edit, so that it cannot loop.
describe('an app that empties a token in every read is read back a bounded number of times', () => {
  for (const gc of [false, true]) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $create(ReadHook).setTextContent('anchor'),
            ),
            $node('token'),
            $createParagraphNode().append($createTextNode('other')),
          ),
        {gc, nodes: [...NODES, ReadHook]},
      );
      let calls = 0;
      const $again = (): void => {
        calls++;
        if (calls < 50) {
          inRead.set(t.a.editor, $again);
        }
        const block = $getRoot().getChildAtIndex(1) as ElementNode;
        const text = block.getAllTextNodes()[0];
        if (text === undefined) {
          block.append($createTextNode('').setMode('token'));
        } else {
          text.setTextContent('');
        }
      };
      try {
        t.a.update(() => $getRoot().getAllTextNodes()[0].select(1, 1));
        await t.sync();
        inRead.set(t.a.editor, $again);
        t.b.update(() => {
          $getRoot().getAllTextNodes().at(-1)!.spliceText(5, 0, '!');
          $setSelection(null);
        });
        await t.sync();
        await t.sync();
        expect(calls).toBeLessThan(10);
        expect(unstorable(t.a).length).toBeLessThan(10);
        expect(t.a.binding.status).toBe('active');
        await expectConverged(t.peers.filter(p => p !== t.a));
        // The app stops; the next user's edit, anywhere, reads it back.
        inRead.delete(t.a.editor);
        calls = 50;
        t.a.update(() => {
          $getRoot().getAllTextNodes().at(-1)!.spliceText(0, 0, 'u');
          $setSelection(null);
        });
        await t.sync();
        const fresh = await freshReader(t.a);
        const $middle = () =>
          ($getRoot().getChildAtIndex(1) as ElementNode)
            .getAllTextNodes()
            .map(n => n.getTextContent());
        expect(t.a.read($middle)).toEqual([]);
        expect(t.a.read($middle)).toEqual(fresh.read($middle));
        await expectConverged(t.peers);
      } finally {
        inRead.delete(t.a.editor);
      }
    });
  }
});

// NodeState on the root is not stored (the document stores the root's
// children, not its fields), and is left as it is: apps keep document
// metadata there and share it themselves (a limit, see D113).
describe('NodeState on the root stays on the editor that set it', () => {
  for (const gc of [false, true]) {
    test(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one')),
          ),
        {gc},
      );
      t.a.update(() => $setState($getRoot(), data, 'meta'));
      await t.sync();
      const fresh = await freshReader(t.a);
      const $root = () => $getState($getRoot(), data);
      expect(t.a.read($root)).toBe('meta');
      expect(fresh.read($root)).toBe('');
      expect(t.b.read($root)).toBe('');
      expect(unstorable(t.a)).toEqual([]);
    });
  }
});

// While read only, a local update is not written and what it changed is read
// again; a slot on a node the document cannot store slots on (a line, the
// root) was not removed by that re-read, so it stayed on this client only.
describe('a slot the document cannot store, set while read only, is read back', () => {
  for (const host of ['a line', 'the root'] as const) {
    for (const route of ['a local update', 'a remote read'] as const) {
      for (const gc of [false, true]) {
        test(`${host}, ${route}, gc ${gc}`, async () => {
          const t = await setup(
            () =>
              $getRoot().append(
                $createParagraphNode().append(
                  $create(ReadHook).setTextContent('one'),
                ),
                $createParagraphNode().append($createTextNode('other')),
              ),
            {gc, nodes: [...NODES, ReadHook]},
          );
          const {a} = t;
          try {
            a.update(() => $getRoot().getAllTextNodes()[0].select(1, 1));
            await t.sync();
            (a.binding as unknown as {setStatus(s: string): void}).setStatus(
              'readonly',
            );
            const $host = () =>
              host === 'the root'
                ? $getRoot()
                : $getRoot().getFirstChildOrThrow();
            const $set = () =>
              $setSlot(
                $host() as ElementNode,
                'note',
                $createParagraphNode().append($createTextNode('APP SLOT')),
              );
            if (route === 'a local update') {
              a.update($set);
            } else {
              inRead.set(a.editor, $set);
              t.b.update(() => {
                $getRoot().getAllTextNodes().at(-1)!.spliceText(5, 0, '!');
                $setSelection(null);
              });
            }
            await t.sync();
            const fresh = await freshReader(a);
            const $slot = () => {
              const value = $getSlot($host(), 'note');
              return value === null || value === undefined
                ? null
                : value.getTextContent();
            };
            expect(a.read($slot)).toBe(null);
            expect(a.read($slot)).toBe(fresh.read($slot));
          } finally {
            inRead.delete(a.editor);
          }
        });
      }
    }
  }
});

// A binding that went read only to keep showing a slot it cannot store
// leaves later updates as they are too: an edit an app's code makes in a
// remote read's update should not remove that slot. Since layout 3 the read
// edit's line is read again on main, which removes it (this fix does not
// either: its own removal is skipped while keepsUnstored):
// https://github.com/meta/lexical/issues/9813.
describe('a slot kept when the binding went read only stays through a read edit', () => {
  for (const gc of [false, true]) {
    test.fails(`gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $create(ReadHook).setTextContent('one'),
            ),
            $createParagraphNode().append($createTextNode('other')),
          ),
        {gc, nodes: [...NODES, ReadHook]},
      );
      const {a} = t;
      try {
        a.update(() => {
          $setSlot(
            $getRoot().getFirstChildOrThrow() as ElementNode,
            'note',
            $createParagraphNode().append($createTextNode('APP SLOT')),
          );
          $getRoot()
            .getAllTextNodes()
            .find(n => n instanceof ReadHook)!
            .select(1, 1);
        });
        expect(a.binding.status).toBe('readonly');
        let ran = false;
        inRead.set(a.editor, () => {
          ran = true;
          $getRoot()
            .getAllTextNodes()
            .find(n => n instanceof ReadHook)!
            .spliceText(3, 0, '?');
        });
        t.b.update(() => {
          $getRoot().getAllTextNodes().at(-1)!.spliceText(5, 0, '!');
          $setSelection(null);
        });
        await t.sync();
        expect(ran).toBe(true);
        expect(
          a.read(() => {
            const value = $getSlot($getRoot().getFirstChildOrThrow(), 'note');
            return value === null || value === undefined
              ? null
              : value.getTextContent();
          }),
        ).toBe('APP SLOT');
      } finally {
        inRead.delete(a.editor);
      }
    });
  }
});
