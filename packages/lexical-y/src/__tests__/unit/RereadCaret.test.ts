/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type LexicalNode,
  ParagraphNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $p,
  $selectIn,
  expectConverged,
  flush,
  type Peer,
  setup,
} from '../utils/harness';

/**
 * Backspace as RichTextExtension's DELETE_CHARACTER_COMMAND does it: inside
 * a text node, the character before the caret (headless editors have no
 * window for `deleteCharacter`'s DOM-based extension of a text caret);
 * anywhere else, `deleteCharacter(true)`.
 */
function $backspace(): void {
  const s = $getSelection();
  if (!$isRangeSelection(s)) {
    return;
  }
  if (s.isCollapsed() && s.anchor.type === 'text' && s.anchor.offset > 0) {
    s.anchor.set(s.anchor.key, s.anchor.offset - 1, 'text');
    s.removeText();
  } else {
    s.deleteCharacter(true);
  }
}

const $item = (text: string): ListItemNode =>
  $createListItemNode().append($createTextNode(text));

// Two bullet lists, each with a wrapper item holding a nested list.
function $init() {
  const nestedA = $createListNode('bullet').append(
    $item('A nested one'),
    $item('A nested two'),
    $item('A nested three'),
  );
  const listA = $createListNode('bullet').append(
    $item('A top'),
    $createListItemNode().append(nestedA),
    $item('A after'),
  );
  // The caret's text node is its line's second child (as in the incident:
  // `Meeting, now ` + `but buq|`): Lexical then puts the moved caret after
  // the wrapper's nested list (moveSelectionPointToSibling uses the text
  // node's index as the offset in the wrapper).
  const nestedB = $createListNode('bullet').append(
    $item('B nested one'),
    $createListItemNode().append(
      $createTextNode('B nested '),
      $createTextNode('two').toggleFormat('bold'),
    ),
  );
  const listB = $createListNode('bullet').append(
    $item('B top'),
    $createListItemNode().append(nestedB),
    $item('B after'),
  );
  $getRoot().append(listA, $p('between'), listB, $p('last'));
}

function rereadRoot(peer: Peer) {
  const binding = peer.binding as unknown as {
    rereadContainers: (list: unknown[]) => void;
    state: {containers: Map<unknown, unknown>};
    _root: unknown;
  };
  binding.rereadContainers([binding.state.containers.get(binding._root)]);
}

function caret(peer: Peer): string {
  return peer.read(() => {
    const s = $getSelection();
    if (!$isRangeSelection(s)) {
      return String(s);
    }
    const point = (n: LexicalNode, offset: number, type: string) => {
      const path: number[] = [];
      for (
        let x: LexicalNode | null = n;
        x !== null && x.getParent() !== null;
        x = x.getParent()
      ) {
        path.unshift(x.getIndexWithinParent());
      }
      return `${type} ${JSON.stringify($isTextNode(n) ? n.getTextContent() : n.getType())}@${offset} [${path.join(',')}]`;
    };
    return (
      point(s.anchor.getNode(), s.anchor.offset, s.anchor.type) +
      (s.isCollapsed()
        ? ''
        : ' ~ ' + point(s.focus.getNode(), s.focus.offset, s.focus.type))
    );
  });
}

function wrapperKeys(peer: Peer): string[] {
  return peer.read(() =>
    $getRoot()
      .getChildren()
      .map(list =>
        list.getType() === 'list'
          ? ((list as ReturnType<typeof $createListNode>)
              .getChildAtIndex(1)
              ?.getKey() ?? '-')
          : '-',
      ),
  );
}

describe('soakb2: a full re-read keeps the local caret', () => {
  test('the caret stays in its line through rereadContainers (no document change)', async () => {
    const {b} = await setup($init);
    // Caret in "B nested two", after "B nested tw".
    b.update(() => {
      $selectIn([2, 1, 0, 1], 11);
    });
    const before = caret(b);
    const keysBefore = wrapperKeys(b);
    rereadRoot(b);
    await flush();
    const after = caret(b);
    const keysAfter = wrapperKeys(b);
    // eslint-disable-next-line no-console
    console.log({after, before, keysAfter, keysBefore});
    expect(after).toBe(before);
  });

  test('with the self-check off: a refused follow-up (a transform registered while the document is open) re-reads and keeps the caret', async () => {
    const {b, sync} = await setup($init);
    (
      b.binding as unknown as {options: {selfCheck: boolean}}
    ).options.selfCheck = false;
    b.update(() => {
      $selectIn([2, 1, 0, 1], 11);
    });
    const before = caret(b);
    // Full re-reads: `rereadContainers`, or `$rereadRefused` (which reads
    // refused containers there).
    let rereads = 0;
    const bb = b.binding as unknown as Record<
      string,
      ((...x: unknown[]) => unknown) | undefined
    >;
    for (const name of ['rereadContainers', '$rereadRefused']) {
      const fn = bb[name];
      if (typeof fn === 'function') {
        const orig = fn.bind(bb);
        bb[name] = (...x: unknown[]) => {
          rereads++;
          return orig(...x);
        };
      }
    }
    // An app plugin that mounts after the document is read registers a
    // transform; Lexical runs it over the document (a follow-up, which may
    // not insert): the binding refuses it and reads the root again.
    b.editor.registerNodeTransform(ParagraphNode, node => {
      if (node.getNextSibling() === null && node.getTextContent() !== 'end') {
        node.insertAfter($createParagraphNode().append($createTextNode('end')));
      }
    });
    await flush();
    await flush();
    const after = caret(b);
    // eslint-disable-next-line no-console
    console.log({after, before, rereads});
    expect(rereads).toBeGreaterThan(0);
    expect(after).toBe(before);
    await sync();
  });

  test('one Backspace after the re-read deletes only one character', async () => {
    const {a, b, sync} = await setup($init);
    b.update(() => {
      $selectIn([2, 1, 0, 1], 11);
    });
    rereadRoot(b);
    await flush();
    // Backspace (what RichTextExtension's DELETE_CHARACTER_COMMAND does).
    b.update(() => {
      $backspace();
    });
    await sync();
    const text = a.read(() => $getRoot().getTextContent());
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(text));
    expect(text).toContain('A nested one');
    expect(text).toContain('A nested two');
    expect(text).toContain('A nested three');
    expect(text).toContain('B nested to');
    await expectConverged([a, b]);
  });
});
