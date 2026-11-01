/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// An editor can show something other than the document when a remote change
// arrives: an update tagged SKIP_COLLAB_TAG is not written, by design. A
// read then places what it reads by the binding's units, never next to a
// node it moves while reading (S7-25: a paragraph stored in a quote's line,
// moved out of the quote by such an update, was taken back into the quote by
// the read of a block inserted before it, and the quote was placed after
// that paragraph, inside itself: Lexical's next walk up the tree never
// ended, and the tab hung). A read that would still place a node inside
// itself, as a child or as a named slot's value, throws instead: the binding
// warns and reads the document again. A read-only binding's editor never
// shows a change it did not read: what a local update changes there (code
// that edits the editor, which is not editable) is read again, with a
// warning (S7-25 came from such updates on a client read only for a node
// type it does not register).

import {
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $removeSlot,
  $setCompositionKey,
  $setSlot,
  configExtension,
  defineExtension,
  ElementNode,
  type LexicalEditorWithDispose,
  SKIP_COLLAB_TAG,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  createYDoc,
  isYWarning,
  RECOVERED_READ_WARNING,
  UNKNOWN_NODE_TYPES_WARNING,
  UNSUPPORTED_EDIT_WARNING,
  UNSUPPORTED_SLOTS_WARNING,
  type YBinding,
  YCollabExtension,
} from '../..';
import {Reader} from '../../internal/Read';
import {
  $createBoxNode,
  $createEquation,
  $p,
  BoxNode,
  describeNode,
  EquationNode,
  flush,
  NODES,
  setup,
  WidgetNode,
} from '../utils/harness';

/** A block container with two named slots. */
class ChannelNode extends ElementNode {
  $config() {
    return this.config('test_channel', {
      children: 'block',
      extends: ElementNode,
      slots: ['body', 'title'],
    });
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
}

const RELAY = {relay: true};

type Client = {
  binding: YBinding;
  doc: Y.Doc;
  editor: LexicalEditorWithDispose;
  warnings: unknown[];
};

/**
 * Clients that relay every update to each other at once; those for which
 * `widgets(i)` is false do not register WidgetNode (`test_widget`).
 */
function clients(
  n: number,
  blockIds: boolean,
  {
    selfCheck = true,
    widgets = () => true,
  }: {selfCheck?: boolean; widgets?: (i: number) => boolean} = {},
): Client[] {
  const all: Client[] = [];
  for (let i = 0; i < n; i++) {
    const doc = createYDoc(null, {gc: false});
    doc.clientID = i + 1;
    const warnings: unknown[] = [];
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          ListExtension,
          configExtension(YCollabExtension, {doc, schemaVersion: 1, selfCheck}),
          ...(blockIds ? [BlockIdExtension] : []),
        ],
        name: `@lexical/y/test/drift-${i}`,
        nodes: () => [
          BoxNode,
          ChannelNode,
          EquationNode,
          ...(widgets(i) ? [WidgetNode] : []),
        ],
        onWarn: warning => {
          warnings.push(warning);
        },
      }),
    );
    const {binding} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== RELAY) {
        for (const other of all) {
          if (other.doc !== doc) {
            Y.applyUpdate(other.doc, update, RELAY);
          }
        }
      }
    });
    all.push({binding, doc, editor, warnings});
  }
  return all;
}

const show = (c: Client) =>
  c.editor.read(() => $getRoot().getChildren().map(describeNode).join(' / '));

/**
 * The binding's RECOVERED_READ_WARNINGs: their reason, and whether the read
 * refused to place a node inside itself.
 */
const recovered = (warnings: unknown[]) =>
  warnings
    .filter(isYWarning)
    .filter(warning => warning.code === RECOVERED_READ_WARNING)
    .map(warning => [
      (warning.data as {reason: string}).reason,
      warning.message.includes('a read would place a node inside itself'),
    ]);

describe.each([false, true])('blockIds %s', blockIds => {
  test('a block inserted before a quote whose paragraph a skipped update moved out (S7-25)', async () => {
    const [a, b] = clients(2, blockIds);
    b.editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $p('one'),
            $createQuoteNode({shadowRoot: true}).append($p('inner')),
          );
      },
      {discrete: true},
    );
    b.binding.initialize();
    await flush();
    expect(show(a)).toBe('paragraph("one") / quote(paragraph("inner"))');
    a.editor.update(
      () => {
        const quote = $getRoot().getChildAtIndex(1) as ElementNode;
        quote.insertBefore(quote.getFirstChildOrThrow());
      },
      {discrete: true, tag: SKIP_COLLAB_TAG},
    );
    expect(show(a)).toBe('paragraph("one") / paragraph("inner") / quote()');
    b.editor.update(
      () => {
        ($getRoot().getChildAtIndex(1) as ElementNode).insertBefore(
          $p('before'),
        );
      },
      {discrete: true},
    );
    await flush();
    const expected =
      'paragraph("one") / paragraph("before") / quote(paragraph("inner"))';
    expect(show(b)).toBe(expected);
    expect(show(a)).toBe(expected);
    expect(a.warnings).toEqual([]);
    a.editor.dispose();
    b.editor.dispose();
  });

  test('a block inserted before a box that a skipped update made hold the box storing it: read again, with a warning', async () => {
    const [a, b] = clients(2, blockIds);
    b.editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $p('top'),
            $createBoxNode('c').append(
              $p('c1'),
              $createBoxNode('d').append($p('d1')),
              $p('c2'),
            ),
          );
      },
      {discrete: true},
    );
    b.binding.initialize();
    await flush();
    // Box d moves out of box c, and c into d: the content that stores d is
    // now inside d.
    a.editor.update(
      () => {
        const c = $getRoot().getChildAtIndex(1) as ElementNode;
        const d = c.getChildAtIndex(1) as ElementNode;
        c.insertBefore(d);
        d.append(c);
      },
      {discrete: true, tag: SKIP_COLLAB_TAG},
    );
    expect(show(a)).toBe(
      'paragraph("top") / test_box[d](paragraph("d1") test_box[c](paragraph("c1") paragraph("c2")))',
    );
    b.editor.update(
      () => {
        const c = $getRoot().getChildAtIndex(1) as ElementNode;
        c.getChildAtIndex(1)!.insertBefore($p('new'));
      },
      {discrete: true},
    );
    await flush();
    const expected =
      'paragraph("top") / test_box[c](paragraph("c1") paragraph("new") test_box[d](paragraph("d1")) paragraph("c2"))';
    expect(show(b)).toBe(expected);
    expect(show(a)).toBe(expected);
    expect(recovered(a.warnings)).toEqual([['remote-change', true]]);
    a.editor.dispose();
    b.editor.dispose();
  });
  // #9513: the read that finds the drift (the self-check's read of the
  // container again) placed box d in box c, which the editor held inside d:
  // c was taken out of the tree with everything in it, and nothing placed
  // it again. A shows only "top" until it reloads.
  for (const selfCheck of [true, false]) {
    test(`a block inserted after a box that a skipped update made hold the box storing it (self-check ${selfCheck}): nothing goes missing`, async () => {
      const [a, b] = clients(2, blockIds, {selfCheck});
      b.editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $p('top'),
              $createBoxNode('c').append(
                $p('c1'),
                $createBoxNode('d').append($p('d1')),
                $p('c2'),
              ),
            );
        },
        {discrete: true},
      );
      b.binding.initialize();
      await flush();
      a.editor.update(
        () => {
          const c = $getRoot().getChildAtIndex(1) as ElementNode;
          const d = c.getChildAtIndex(1) as ElementNode;
          c.insertBefore(d);
          d.append(c);
        },
        {discrete: true, tag: SKIP_COLLAB_TAG},
      );
      b.editor.update(
        () => {
          const c = $getRoot().getChildAtIndex(1) as ElementNode;
          c.getChildAtIndex(1)!.insertAfter($p('new'));
        },
        {discrete: true},
      );
      await flush();
      const expected =
        'paragraph("top") / test_box[c](paragraph("c1") test_box[d](paragraph("d1")) paragraph("new") paragraph("c2"))';
      expect(show(b)).toBe(expected);
      if (selfCheck) {
        // The self-check finds box c different and reads it again, which
        // would drop box c: the whole document is read again instead.
        expect(show(a)).toBe(expected);
        expect(recovered(a.warnings)).toEqual([['remote-change', false]]);
        expect(
          a.warnings
            .filter(isYWarning)
            .some(w =>
              w.message.includes(
                'a read would drop a node the document still holds',
              ),
            ),
        ).toBe(true);
      } else {
        // A keeps its unwritten nesting, with the insert read into it.
        expect(show(a)).toBe(
          'paragraph("top") / test_box[d](paragraph("d1") test_box[c](paragraph("c1") paragraph("new") paragraph("c2")))',
        );
        expect(a.warnings).toEqual([]);
      }
      // A's next edit reaches B, and A shows every block.
      a.editor.update(
        () => {
          ($getRoot().getFirstChildOrThrow() as ElementNode).append(
            $createTextNode('!'),
          );
        },
        {discrete: true},
      );
      await flush();
      expect(show(b)).toBe(expected.replace('"top"', '"top!"'));
      a.editor.dispose();
      b.editor.dispose();
    });
  }

  // #9513, the same for a line: A moves paragraph t1 before t0 in an update
  // tagged SKIP_COLLAB_TAG; B removes t1. The read of B's change took out
  // every node between the first and the last node of the lines it read
  // (t0 among them, as A held it after t1), and t0 was gone from A's editor
  // (without the self-check, which reads that container again).
  test('a line removed after a skipped update moved it before another: the other stays', async () => {
    const [a, b] = clients(2, blockIds, {selfCheck: false});
    b.editor.update(
      () => {
        $getRoot().clear().append($p('top'), $p('t0'), $p('t1'), $p('t2'));
      },
      {discrete: true},
    );
    b.binding.initialize();
    await flush();
    const $find = (text: string) =>
      $getRoot()
        .getChildren()
        .find(n => n.getTextContent() === text)!;
    a.editor.update(() => $find('t0').insertBefore($find('t1')), {
      discrete: true,
      tag: SKIP_COLLAB_TAG,
    });
    b.editor.update(() => $find('t1').remove(), {discrete: true});
    await flush();
    expect(show(b)).toBe(
      'paragraph("top") / paragraph("t0") / paragraph("t2")',
    );
    expect(
      a.editor.read(() =>
        $getRoot()
          .getChildren()
          .map(n => n.getTextContent())
          .sort(),
      ),
    ).toEqual(['t0', 't2', 'top']);
    expect(a.warnings).toEqual([]);
    a.editor.dispose();
    b.editor.dispose();
  });

  // The same, where the self-check reads the container again in full: A
  // moves paragraph p2 into box b (unwritten); B types a paragraph into b.
  // The full read of b set p2 aside (the document stores it in the root,
  // which nothing read): A read the whole document again instead.
  test('a container a skipped update moved a line into, read again in full: the line stays', async () => {
    const [a, b] = clients(2, blockIds);
    b.editor.update(
      () => {
        $getRoot()
          .clear()
          .append($p('top'), $createBoxNode('b').append($p('b1')), $p('p2'));
      },
      {discrete: true},
    );
    b.binding.initialize();
    await flush();
    a.editor.update(
      () => {
        const box = $getRoot().getChildAtIndex(1) as ElementNode;
        box.append($getRoot().getLastChildOrThrow());
      },
      {discrete: true, tag: SKIP_COLLAB_TAG},
    );
    b.editor.update(
      () => {
        ($getRoot().getChildAtIndex(1) as ElementNode).append($p('new'));
      },
      {discrete: true},
    );
    await flush();
    const expected =
      'paragraph("top") / test_box[b](paragraph("b1") paragraph("new")) / paragraph("p2")';
    expect(show(b)).toBe(expected);
    expect(show(a)).toBe(expected);
    a.editor.dispose();
    b.editor.dispose();
  });

  test('a block inserted after a run whose last node a skipped update moved: placed after what stays', async () => {
    // Without the self-check, which reads such a container again.
    const [a, b] = clients(2, blockIds, {selfCheck: false});
    b.editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createBoxNode('c').append(
              $p('left'),
              $createEquation('a'),
              $createEquation('b'),
              $p('target'),
              $createBoxNode('e').append($p('else')),
            ),
          );
      },
      {discrete: true},
    );
    b.binding.initialize();
    await flush();
    a.editor.update(
      () => {
        const c = $getRoot().getFirstChildOrThrow() as ElementNode;
        (c.getLastChild() as ElementNode).append(c.getChildAtIndex(2)!);
      },
      {discrete: true, tag: SKIP_COLLAB_TAG},
    );
    b.editor.update(
      () => {
        const c = $getRoot().getFirstChildOrThrow() as ElementNode;
        c.getChildAtIndex(3)!.insertBefore($p('new'));
      },
      {discrete: true},
    );
    await flush();
    expect(show(a)).toBe(
      'test_box[c](paragraph("left") eq[a] paragraph("new") paragraph("target") test_box[e](paragraph("else") eq[b]))',
    );
    expect(a.warnings).toEqual([]);
    a.editor.dispose();
    b.editor.dispose();
  });

  test("a slot restored on a host that a skipped update moved into that slot's value: read again, with a warning", async () => {
    const [a, b] = clients(2, blockIds);
    const $text = (text: string) =>
      $createParagraphNode().append($createTextNode(text));
    b.editor.update(
      () => {
        const host = $create(ChannelNode);
        $setSlot(host, 'body', $create(ChannelNode).append($text('body')));
        $getRoot().clear().append(host);
      },
      {discrete: true},
    );
    b.binding.initialize();
    await flush();
    // The body leaves its slot, and the host moves into it.
    a.editor.update(
      () => {
        const host = $getRoot().getFirstChildOrThrow() as ChannelNode;
        const body = $getSlot(host, 'body') as ChannelNode;
        $removeSlot(host, 'body');
        host.insertBefore(body);
        body.append(host);
      },
      {discrete: true, tag: SKIP_COLLAB_TAG},
    );
    // Setting another slot reads the host's slots again, the body included.
    b.editor.update(
      () => {
        const host = $getRoot().getFirstChildOrThrow() as ChannelNode;
        $setSlot(host, 'title', $create(ChannelNode).append($text('title')));
      },
      {discrete: true},
    );
    await flush();
    const slots = (c: Client) =>
      c.editor.read(() => {
        const host = $getRoot().getFirstChildOrThrow() as ChannelNode;
        return [
          $getRoot().getChildrenSize(),
          host.getType(),
          $getSlot(host, 'body')?.getTextContent(),
          $getSlot(host, 'title')?.getTextContent(),
        ];
      });
    expect(slots(b)).toEqual([1, 'test_channel', 'body', 'title']);
    expect(slots(a)).toEqual(slots(b));
    expect(recovered(a.warnings)).toEqual([['remote-change', true]]);
    a.editor.dispose();
    b.editor.dispose();
  });

  describe('a client read only for a node type it does not register', () => {
    /** B registers WidgetNode; A does not, and is read only. */
    async function readOnly(): Promise<{a: Client; b: Client}> {
      const [b, a] = clients(2, blockIds, {widgets: i => i === 0});
      b.editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $p('one'),
              $createQuoteNode({shadowRoot: true}).append($p('inner')),
              $create(WidgetNode),
            );
        },
        {discrete: true},
      );
      b.binding.initialize();
      await flush();
      expect(a.binding.status).toBe('readonly');
      a.warnings.length = 0;
      return {a, b};
    }

    const edits = (warnings: unknown[]) =>
      warnings
        .filter(isYWarning)
        .filter(warning => warning.code === UNSUPPORTED_EDIT_WARNING)
        .map(warning => warning.data);

    test('a local update is read again, with a warning, and nothing is written', async () => {
      const {a, b} = await readOnly();
      const vector = Y.encodeStateVector(a.doc);
      a.editor.update(
        () => {
          const quote = $getRoot().getChildAtIndex(1) as ElementNode;
          quote.insertBefore(quote.getFirstChildOrThrow());
          ($getRoot().getFirstChildOrThrow() as ElementNode).append($p('x'));
        },
        {discrete: true},
      );
      await flush();
      expect(show(a)).toBe('paragraph("one") / quote(paragraph("inner"))');
      expect(edits(a.warnings)).toEqual([{reason: 'read-only'}]);
      expect(Y.encodeStateVector(a.doc)).toEqual(vector);
      a.editor.dispose();
      b.editor.dispose();
    });

    test('remote changes after a local update show as a fresh reader shows them (S7-25)', async () => {
      const {a, b} = await readOnly();
      a.editor.update(
        () => {
          const quote = $getRoot().getChildAtIndex(1) as ElementNode;
          quote.insertBefore(quote.getFirstChildOrThrow());
        },
        {discrete: true},
      );
      await flush();
      b.editor.update(
        () => {
          const quote = $getRoot().getChildAtIndex(1) as ElementNode;
          quote.insertBefore($create(WidgetNode));
          quote.insertAfter($p('after'));
        },
        {discrete: true},
      );
      await flush();
      expect(show(b)).toBe(
        'paragraph("one") / test_widget / quote(paragraph("inner")) / paragraph("after") / test_widget',
      );
      const [fresh] = clients(1, blockIds, {widgets: () => false});
      Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(a.doc), RELAY);
      fresh.binding.initialize();
      await flush();
      const expected =
        'paragraph("one") / quote(paragraph("inner")) / paragraph("after")';
      expect(show(fresh)).toBe(expected);
      expect(show(a)).toBe(expected);
      expect(edits(a.warnings)).toEqual([{reason: 'read-only'}]);
      for (const c of [a, b, fresh]) {
        c.editor.dispose();
      }
    });

    // S9-8: a change that brings a layout record makes the read-only client
    // read the whole document again. A line whose type the same change
    // changed is made anew there, its unit kept for the new node; the old
    // node's stale entry took it for a line another container still holds,
    // the read threw, and the client failed closed, showing what it showed
    // before for good.
    test('a change that retypes a line and brings a layout record is read', async () => {
      const {a, b} = await readOnly();
      b.editor.update(
        () => {
          const line = $getRoot().getFirstChildOrThrow() as ElementNode;
          line.replace($createHeadingNode('h2'), true);
        },
        {discrete: true},
      );
      await flush();
      expect(show(a)).toBe(show(b).replace(' / test_widget', ''));
      // One transaction, so A reads it as one change.
      b.doc.transact(() => {
        b.editor.update(
          () => {
            const line = $getRoot().getFirstChildOrThrow() as ElementNode;
            line.replace($createParagraphNode(), true);
            const quote = $getRoot().getChildAtIndex(1) as ElementNode;
            (quote.getFirstChildOrThrow() as ElementNode).append(
              $createTextNode(' typed'),
            );
          },
          {discrete: true},
        );
        b.binding.root.setAttr('lexical-y:2', true);
      });
      await flush();
      expect(show(b)).toBe(
        'paragraph("one") / quote(paragraph("inner typed")) / test_widget',
      );
      expect(show(a)).toBe(
        'paragraph("one") / quote(paragraph("inner typed"))',
      );
      expect(edits(a.warnings)).toEqual([]);
      a.editor.dispose();
      b.editor.dispose();
    });

    test('local updates in separate tasks are each read again, list numbering included', async () => {
      const [b, a] = clients(2, blockIds, {widgets: i => i === 0});
      b.editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createListNode('number').append(
                $createListItemNode().append($createTextNode('one')),
                $createListItemNode().append($createTextNode('two')),
              ),
              $create(WidgetNode),
            );
        },
        {discrete: true},
      );
      b.binding.initialize();
      await flush();
      expect(a.binding.status).toBe('readonly');
      const values = () =>
        a.editor.read(() =>
          ($getRoot().getFirstChildOrThrow() as ListNode)
            .getChildren()
            .map(item => (item as ListItemNode).getValue()),
        );
      const seen: number[][] = [];
      for (let i = 0; i < 6; i++) {
        a.editor.update(
          () =>
            (
              (
                $getRoot().getFirstChildOrThrow() as ListNode
              ).getFirstChild() as ListItemNode
            ).setValue(100 + i),
          {discrete: true},
        );
        await flush();
        seen.push(values());
      }
      expect(seen).toEqual(Array.from({length: 6}, () => [1, 2]));
      // Warned once while read only.
      expect(edits(a.warnings)).toEqual([{reason: 'read-only'}]);
      a.editor.dispose();
      b.editor.dispose();
    });

    test('once the document cannot be read, a local update goes back to what the editor showed', async () => {
      const [b, a] = clients(2, blockIds);
      b.editor.update(
        () => {
          $getRoot().clear().append($p('hello'));
        },
        {discrete: true},
      );
      b.binding.initialize();
      await flush();
      // Every read throws, and so does the fresh read after it: a fails
      // closed and reads nothing more.
      const proto = Reader.prototype as unknown as {
        $apply: (...args: unknown[]) => void;
        $readFull: (...args: unknown[]) => void;
      };
      const {$apply, $readFull} = proto;
      proto.$apply = proto.$readFull = () => {
        throw new Error('simulated reader failure');
      };
      try {
        b.editor.update(
          () =>
            ($getRoot().getFirstChildOrThrow() as ElementNode).append(
              $createTextNode(' there'),
            ),
          {discrete: true},
        );
        await flush();
      } finally {
        proto.$apply = $apply;
        proto.$readFull = $readFull;
      }
      expect(a.binding.status).toBe('readonly');
      expect(show(a)).toBe('paragraph("hello")');
      const vector = Y.encodeStateVector(a.doc);
      a.editor.update(() => $getRoot().append($p('local')), {
        discrete: true,
      });
      await flush();
      expect(show(a)).toBe('paragraph("hello")');
      expect(edits(a.warnings)).toEqual([{reason: 'read-only'}]);
      expect(Y.encodeStateVector(a.doc)).toEqual(vector);
      a.editor.dispose();
      b.editor.dispose();
    });

    test('a change to the layout record leaves the client read only, never editable', async () => {
      const {a, b} = await readOnly();
      const editable: boolean[] = [];
      const stop = a.editor.registerEditableListener(value => {
        editable.push(value);
      });
      const unknown = () =>
        a.warnings
          .filter(isYWarning)
          .filter(warning => warning.code === UNKNOWN_NODE_TYPES_WARNING)
          .length;
      const warned = unknown();
      // A peer records a layout version this binding reads: the document
      // is read again.
      b.doc.transact(() => b.binding.root.setAttr('lexical-y:1', true));
      await flush();
      expect(a.binding.status).toBe('readonly');
      expect(editable).toEqual([]);
      expect(unknown()).toBe(warned);
      stop();
      a.editor.dispose();
      b.editor.dispose();
    });

    test('a local update during a composition is read again once it ends', async () => {
      const [b, a] = clients(2, blockIds, {widgets: i => i === 0});
      b.editor.update(
        () => {
          $getRoot().clear().append($p('abc'), $p('other'));
        },
        {discrete: true},
      );
      b.binding.initialize();
      await flush();
      const $firstText = () =>
        (
          $getRoot().getFirstChildOrThrow() as ElementNode
        ).getFirstChildOrThrow() as TextNode;
      a.editor.update(
        () => {
          const text = $firstText();
          text.select(1, 1);
          $setCompositionKey(text.getKey());
        },
        {discrete: true},
      );
      // What b types into the composed line waits for the composition.
      b.editor.update(() => $firstText().spliceText(3, 0, 'X'), {
        discrete: true,
      });
      await flush();
      b.editor.update(() => $getRoot().append($create(WidgetNode)), {
        discrete: true,
      });
      await flush();
      expect(a.binding.status).toBe('readonly');
      a.editor.update(() => $getRoot().append($p('refused')), {
        discrete: true,
      });
      await flush();
      // Still composing: nothing is read into the composed line.
      expect(show(a)).toBe(
        'paragraph("abc") / paragraph("other") / paragraph("refused")',
      );
      a.editor.update(() => $setCompositionKey(null), {discrete: true});
      await flush();
      expect(show(a)).toBe('paragraph("abcX") / paragraph("other")');
      expect(edits(a.warnings)).toEqual([{reason: 'read-only'}]);
      a.editor.dispose();
      b.editor.dispose();
    });

    test('a change the binding cannot store stays, and so do local updates after it', async () => {
      const [c] = clients(1, blockIds);
      c.editor.update(
        () => {
          $getRoot().clear().append($p('stored'));
        },
        {discrete: true},
      );
      c.binding.initialize();
      await flush();
      const vector = Y.encodeStateVector(c.doc);
      // A slot on a paragraph cannot be stored: read only, the change kept.
      c.editor.update(
        () => {
          const host = $p('host');
          $setSlot(host, 'note', $p('note'));
          $getRoot().append(host);
        },
        {discrete: true},
      );
      await flush();
      expect(c.binding.status).toBe('readonly');
      c.editor.update(() => $getRoot().append($p('later')), {discrete: true});
      await flush();
      // Each block's own text, and its note slot's.
      const shown = c.editor.read(() =>
        $getRoot()
          .getChildren()
          .map(node => [
            (node as ElementNode)
              .getChildren()
              .map(child => child.getTextContent())
              .join(''),
            $getSlot(node, 'note')?.getTextContent() ?? null,
          ]),
      );
      expect(shown).toEqual([
        ['stored', null],
        ['host', 'note'],
        ['later', null],
      ]);
      expect(
        c.warnings
          .filter(isYWarning)
          .map(warning => warning.code)
          .filter(code => code !== UNSUPPORTED_SLOTS_WARNING),
      ).toEqual([]);
      expect(Y.encodeStateVector(c.doc)).toEqual(vector);
      c.editor.dispose();
    });
  });
});

/** An inline element that cannot be empty, stored as a node of its own. */
class NonEmptyInline extends ElementNode {
  $config() {
    return this.config('test_nonempty_inline', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isInline(): true {
    return true;
  }
  canBeEmpty(): false {
    return false;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
}

// A stored inline element that cannot be empty is left out of the editor
// once collaborators empty it, as Lexical would remove it, while its
// Y.Node stays: that is no loss, and the read stands (#9513 review).
test.each(['a raw Yjs delete', 'a peer deleting its text'])(
  'an emptied stored inline element that cannot be empty is left out without a recovery (%s)',
  async how => {
    const t = await setup(
      () =>
        $getRoot().append(
          $p('pre').append(
            $create(NonEmptyInline).append($createTextNode('x')),
            $createTextNode('post'),
          ),
        ),
      {nodes: [...NODES, NonEmptyInline]},
    );
    for (const peer of t.peers) {
      peer.warnings.length = 0;
    }
    if (how === 'a raw Yjs delete') {
      const state = (
        t.a.binding as unknown as {state: {csByKey: Map<string, {y: Y.Node}>}}
      ).state;
      const y = [...state.csByKey.values()]
        .map(cs => cs.y)
        .find(n => n.name === 'i:test_nonempty_inline')!;
      t.a.doc.transact(() => y.delete(0, 1), t.a.net);
    } else {
      t.b.update(() => {
        const line = $getRoot().getFirstChildOrThrow() as ElementNode;
        const inline = line.getChildAtIndex(1) as ElementNode;
        (inline.getFirstChildOrThrow() as TextNode).select(0, 1).removeText();
      });
    }
    await t.sync();
    // A raw delete applied to A's document as a remote change (not relayed).
    for (const peer of how === 'a raw Yjs delete' ? [t.a] : t.peers) {
      expect(peer.describe()).toBe('paragraph("prepost")');
      expect(peer.warnings).toEqual([]);
    }
    for (const peer of t.peers) {
      peer.stop();
    }
  },
);
