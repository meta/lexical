/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $generateJSONFromSelectedNodes,
  type BaseSerializedNode,
} from '@lexical/clipboard';
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $selectAll,
  $withCompactExport,
  type SerializedPartial,
  type SerializedTextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

const extension = defineExtension({
  $initialEditorState: () => {
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append(
          $createTextNode('plain'),
          $createTextNode('secret').setFormat('bold'),
        ),
      );
  },
  dependencies: [RichTextExtension],
  name: '[selection-serialization]',
});

// The selection covers only text nodes, and a compact export omits any
// property equal to its default, so the payload is a partial text node.
type SelectedTextJSON = SerializedPartial<SerializedTextNode>;

function selectionJSON(compact = false): SelectedTextJSON[] {
  using editor = buildEditorFromExtensions({
    dependencies: [extension],
    name: '[root]',
    namespace: '',
    onError: err => {
      throw err;
    },
  });
  let nodes: SelectedTextJSON[] = [];
  editor.update(
    () => {
      $selectAll();
      nodes = $withCompactExport(
        compact,
        () =>
          $generateJSONFromSelectedNodes<SelectedTextJSON>(
            editor,
            $getSelection(),
          ).nodes,
      );
    },
    {discrete: true},
  );
  return nodes;
}

// A RangeSelection over a paragraph's contents yields its text nodes at the
// top level of the payload, with no paragraph wrapper.
describe('selection export honors the serialization context', () => {
  test('legacy is the default', () => {
    const [plain] = selectionJSON();
    expect(plain).toMatchObject({
      detail: 0,
      format: 0,
      mode: 'normal',
      style: '',
      text: 'plain',
      type: 'text',
      version: 1,
    });
  });

  test('compact applies to a selection export too', () => {
    const nodes = selectionJSON(true);
    expect(nodes).toEqual([
      {text: 'plain', type: 'text'},
      {format: 1, text: 'secret', type: 'text'},
    ]);
  });

  test('the legacy form can be forced at a call site', () => {
    // Whatever an editor is configured to do, a caller that needs the old
    // format for compatibility can ask for it around any export.
    const [plain] = selectionJSON(false);
    expect(plain.version).toBe(1);
  });
});

// What the payload is for: handing it back. `BaseSerializedNode` is an
// interface whose `version` is optional, so it matched neither of
// `parseEditorState`'s two document forms — the full one requires `version`,
// and an interface never satisfies the compact one's index signature — and
// the nodes the clipboard API produces could not be parsed without a cast.
test('the serialized nodes parse back as a document without a cast', () => {
  using editor = buildEditorFromExtensions({
    dependencies: [extension],
    name: '[root]',
    namespace: '',
    onError: err => {
      throw err;
    },
  });
  let nodes: BaseSerializedNode[] = [];
  editor.update(
    () => {
      // The paragraph itself, so the payload is a subtree a root can hold.
      const selection = $createNodeSelection();
      selection.add($getRoot().getFirstChildOrThrow().getKey());
      nodes = $generateJSONFromSelectedNodes(editor, selection).nodes;
    },
    {discrete: true},
  );
  const state = editor.parseEditorState({
    root: {
      children: nodes,
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  });
  expect(state.read(() => $getRoot().getTextContent())).toBe('plainsecret');
});
