/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  $removeList,
  ListExtension,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  $selectAll,
  defineExtension,
} from 'lexical';
import {describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [ListExtension],
      name: 'remove-list-state-host',
    }),
  );
}

function $paragraphState() {
  return $getRoot()
    .getChildren()
    .filter($isParagraphNode)
    .map(p => ({
      direction: p.getDirection(),
      format: p.getFormatType(),
      indent: p.getIndent(),
      style: p.getStyle(),
      text: p.getTextContent(),
    }));
}

describe('$removeList keeps the list item state', () => {
  test('the paragraphs keep the items format, indent, direction and style', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        const list = $createListNode('bullet');
        const outer = $createListItemNode()
          .setFormat('center')
          .setDirection('rtl')
          .setStyle('color: red;');
        outer.append($createTextNode('a'));
        list.append(outer);
        // A nested item renders one level in; getIndent() derives that from the
        // nesting, so the paragraph has to carry it to look the same.
        const wrapper = $createListItemNode();
        const nested = $createListNode('bullet');
        nested.append($createListItemNode().append($createTextNode('b')));
        wrapper.append(nested);
        list.append(wrapper);
        $getRoot().clear().append(list);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $selectAll();
        $removeList();
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($paragraphState()).toEqual([
        {
          direction: 'rtl',
          format: 'center',
          indent: 0,
          style: 'color: red;',
          text: 'a',
        },
        {direction: null, format: '', indent: 1, style: '', text: 'b'},
      ]);
    });
  });

  test('a formatted paragraph round-trips through a list', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        // $createListOrMerge copies the block's format and indent onto the list
        // item it creates, so removing the list again has to give them back.
        const paragraph = $createParagraphNode()
          .setFormat('right')
          .setIndent(2);
        paragraph.append($createTextNode('x'));
        $getRoot().clear().append(paragraph);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $selectAll();
        $insertList('bullet');
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $selectAll();
        $removeList();
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($paragraphState()).toEqual([
        {direction: null, format: 'right', indent: 2, style: '', text: 'x'},
      ]);
    });
  });
});
