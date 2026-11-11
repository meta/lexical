/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A node selection made before initialization is kept on the nodes the
// read-back shows for the selected ones, whatever kind of node is selected:
// a list and a list item holding a nested list (no item stores either: by
// the first line inside them), a text node (by its first character), a
// link (by its text), a paragraph (by its marker), into a pristine or a
// used root. Delete then
// does what it does without the binding. Before, the read-back kept only
// nodes stored by an item of their own, and dropped a selected list, link
// or text node (R12B-S1).

import {$createLinkNode, LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {registerRichText} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  $setSelection,
  createEditor,
  DELETE_CHARACTER_COMMAND,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';

const idle = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

const KINDS = [
  'list',
  'listitem',
  'text',
  'paragraph',
  'nested list wrapper',
  'text after a line feed',
  'link',
] as const;

function make() {
  const editor = createEditor({
    namespace: 'init-node-selection',
    nodes: [ListNode, ListItemNode, LinkNode],
    onError: e => {
      throw e;
    },
    onWarn: () => {},
  });
  const stop = registerRichText(editor);
  return {editor, stop};
}

function seed(
  editor: ReturnType<typeof make>['editor'],
  kind: (typeof KINDS)[number],
) {
  editor.update(
    () => {
      const text = $createTextNode('chosen text');
      const item = $createListItemNode().append(text);
      const nestedItem = $createListItemNode().append(
        $createTextNode('nested'),
      );
      const wrapper = $createListItemNode().append(
        $createListNode('bullet').append(nestedItem),
      );
      const list = $createListNode('number').append(item, wrapper);
      // A raw line feed before the selected text node: the read-back shows
      // a line break node there, which moves the nodes after it along.
      const before = $createTextNode('a\nb');
      before.toggleFormat('bold');
      const after = $createTextNode('after');
      const link = $createLinkNode('https://lexical.dev').append(
        $createTextNode('linked'),
      );
      const paragraph = $createParagraphNode().append(before, after, link);
      const guard = $createParagraphNode().append($createTextNode('guard'));
      $getRoot().clear().append(list, paragraph, guard);
      const target: LexicalNode =
        kind === 'list'
          ? list
          : kind === 'listitem'
            ? item
            : kind === 'text'
              ? text
              : kind === 'paragraph'
                ? guard
                : kind === 'nested list wrapper'
                  ? wrapper
                  : kind === 'link'
                    ? link
                    : after;
      const selection = $createNodeSelection();
      selection.add(target.getKey());
      $setSelection(selection);
    },
    {discrete: true},
  );
}

function selected(editor: ReturnType<typeof make>['editor']) {
  return editor.read('latest', () => {
    const s = $getSelection();
    return $isNodeSelection(s)
      ? s.getNodes().map(n => ({text: n.getTextContent(), type: n.getType()}))
      : [];
  });
}

for (const used of [false, true]) {
  for (const kind of KINDS) {
    test(`a node selection of a ${kind} is kept (${
      used ? 'a used root' : 'a pristine root'
    })`, async () => {
      const a = make();
      const control = make();
      const doc = createYDoc(null, {gc: false});
      if (used) {
        const root = doc.get('lexical-y');
        root.setAttr('probe', true);
        root.deleteAttr('probe');
      }
      const binding = new YBinding(a.editor, doc, {
        schemaVersion: 1,
        selfCheck: true,
      });
      const finish = binding.start();
      try {
        await idle();
        seed(a.editor, kind);
        seed(control.editor, kind);
        await idle();
        const before = selected(a.editor);
        expect(before).toHaveLength(1);
        binding.initialize();
        await idle();
        expect(selected(a.editor)).toEqual(before);
        // Delete removes what it removes without the binding.
        const handled = a.editor.dispatchCommand(
          DELETE_CHARACTER_COMMAND,
          true,
        );
        const plainHandled = control.editor.dispatchCommand(
          DELETE_CHARACTER_COMMAND,
          true,
        );
        await idle();
        expect(handled).toBe(plainHandled);
        const shown = (e: ReturnType<typeof make>['editor']) =>
          e.read('latest', () => $getRoot().getTextContent());
        expect(shown(a.editor)).toBe(shown(control.editor));
      } finally {
        finish();
        a.stop();
        control.stop();
        doc.destroy();
      }
    });
  }
}
