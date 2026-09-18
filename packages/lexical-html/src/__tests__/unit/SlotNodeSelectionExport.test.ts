/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import {
  $create,
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $setSelection,
  $setSlot,
  defineExtension,
  ElementNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

// A plain shadow-root ElementNode used as a slot value, mirroring the shape a
// slot host holds in production (shadow-root container with block content).
class PlainShadowRootNode extends ElementNode {
  $config() {
    return this.config('plain_shadow_root_html', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
}

function $createPlainShadowRootNode(): PlainShadowRootNode {
  return $create(PlainShadowRootNode);
}

const TARGET_TEXT = 'SlotNodeTarget';

function buildEditorWithSlottedParagraph() {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      name: '[slot-node-selection-html]',
      nodes: [PlainShadowRootNode],
    }),
  );
  const keys = {paragraph: '', text: ''};
  editor.update(
    () => {
      const host = $createParagraphNode();
      const slot = $createPlainShadowRootNode();
      const text = $createTextNode(TARGET_TEXT);
      const innerParagraph = $createParagraphNode().append(text);
      slot.append(innerParagraph);
      $setSlot(host, 'media', slot);
      $getRoot().append(host);
      keys.paragraph = innerParagraph.getKey();
      keys.text = text.getKey();
    },
    {discrete: true},
  );
  return {editor, keys};
}

describe('$generateHtmlFromNodes slot frame redirect', () => {
  test('a NodeSelection inside a slot exports the node, not empty HTML', () => {
    const {editor, keys} = buildEditorWithSlottedParagraph();
    using disposableEditor = editor;

    disposableEditor.update(
      () => {
        const innerParagraph = $getNodeByKey(keys.paragraph);
        assert(innerParagraph !== null);
        const nodeSelection = $createNodeSelection();
        nodeSelection.add(innerParagraph.getKey());
        $setSelection(nodeSelection);
      },
      {discrete: true},
    );

    disposableEditor.read(() => {
      expect(
        $generateHtmlFromNodes(disposableEditor, $getSelection()),
      ).toContain(TARGET_TEXT);
    });
  });

  test('a RangeSelection inside a slot still exports the node', () => {
    const {editor, keys} = buildEditorWithSlottedParagraph();
    using disposableEditor = editor;

    disposableEditor.update(
      () => {
        const rangeSelection = $createRangeSelection();
        rangeSelection.anchor.set(keys.text, 0, 'text');
        rangeSelection.focus.set(keys.text, TARGET_TEXT.length, 'text');
        $setSelection(rangeSelection);
      },
      {discrete: true},
    );

    disposableEditor.read(() => {
      expect(
        $generateHtmlFromNodes(disposableEditor, $getSelection()),
      ).toContain(TARGET_TEXT);
    });
  });
});
