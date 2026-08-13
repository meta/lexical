/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $getRoot,
  $isElementNode,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {
  $createExcalidrawNode,
  $isExcalidrawNode,
  ExcalidrawNode,
} from '../../src/nodes/ExcalidrawNode';

const ExcalidrawTestExtension = defineExtension({
  $initialEditorState: null,
  name: '[test-excalidraw]',
  nodes: [ExcalidrawNode],
});

const DATA = '[{"type":"rectangle","id":"a"}]';

function $getExcalidrawNodes(): ExcalidrawNode[] {
  const paragraph = $getRoot().getFirstChild();
  assert($isElementNode(paragraph), 'expected a paragraph');
  return paragraph.getChildren().filter($isExcalidrawNode);
}

function $getExcalidrawNode(): ExcalidrawNode {
  const [node] = $getExcalidrawNodes();
  assert($isExcalidrawNode(node), 'expected an ExcalidrawNode');
  return node;
}

describe('ExcalidrawNode', () => {
  it('keeps the drawing data when the node is resized', () => {
    using editor = buildEditorFromExtensions(ExcalidrawTestExtension);
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createExcalidrawNode(DATA, 100, 200)),
        );
      },
      {discrete: true},
    );

    // Resizing calls setWidth/setHeight, each of which goes through
    // getWritable() and therefore through the node's clone.
    editor.update(
      () => {
        $getExcalidrawNode().setWidth(300).setHeight(400);
      },
      {discrete: true},
    );

    expect(editor.read(() => $getExcalidrawNode().exportJSON())).toMatchObject({
      data: DATA,
      height: 400,
      width: 300,
    });
  });

  it('keeps the dimensions when the drawing data is saved', () => {
    using editor = buildEditorFromExtensions(ExcalidrawTestExtension);
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createExcalidrawNode('[]', 100, 200)),
        );
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $getExcalidrawNode().setData(DATA);
      },
      {discrete: true},
    );

    expect(editor.read(() => $getExcalidrawNode().exportJSON())).toMatchObject({
      data: DATA,
      height: 200,
      width: 100,
    });
  });

  it('keeps the drawing data when the node is moved', () => {
    using editor = buildEditorFromExtensions(ExcalidrawTestExtension);
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append(
            $createExcalidrawNode(DATA, 100, 200),
            $createExcalidrawNode('[]'),
          ),
        );
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const [first, second] = $getExcalidrawNodes();
        // insertAfter() writes to both nodes, cloning each of them.
        second.insertAfter(first);
      },
      {discrete: true},
    );

    expect(
      editor.read(() => $getExcalidrawNodes().map(node => node.exportJSON())),
    ).toMatchObject([{data: '[]'}, {data: DATA, height: 200, width: 100}]);
  });
});
