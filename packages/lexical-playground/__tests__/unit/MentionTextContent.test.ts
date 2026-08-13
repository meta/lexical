/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
import {
  $createParagraphNode,
  $getRoot,
  $insertNodes,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {$createMentionNode, $isMentionNode} from '../../src/nodes/MentionNode';
import {PlaygroundImportExtension} from '../../src/nodes/PlaygroundImportExtension';
import {MentionsExtension} from '../../src/plugins/MentionsExtension';

// MentionNode carries a display text that may differ from the mention name;
// exportDOM encodes the split as data-lexical-mention-name and the import rule
// decodes it and passes both values to $createMentionNode.

const MentionTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [MentionsExtension, PlaygroundImportExtension],
  name: '[test-mention-text]',
});

function $importHtml(html: string): void {
  const parser = new DOMParser();
  const dom = parser.parseFromString(html, 'text/html');
  $insertNodes($generateNodesFromDOMViaExtension(dom));
}

function $getMention() {
  const paragraph = $getRoot().getFirstChild();
  assert(paragraph !== null, 'expected a first child');
  const mention = (
    paragraph as ReturnType<typeof $createParagraphNode>
  ).getFirstChild();
  assert($isMentionNode(mention), 'expected a MentionNode');
  return mention;
}

describe('MentionNode display text', () => {
  it('$createMentionNode honours an explicit textContent', () => {
    using editor = buildEditorFromExtensions(MentionTestExtension);
    editor.update(
      () => {
        const mention = $createMentionNode('luke_skywalker', 'Luke Skywalker');
        expect(mention.getTextContent()).toBe('Luke Skywalker');
      },
      {discrete: true},
    );
  });

  it('$createMentionNode defaults textContent to the mention name', () => {
    using editor = buildEditorFromExtensions(MentionTestExtension);
    editor.update(
      () => {
        expect($createMentionNode('Luke').getTextContent()).toBe('Luke');
      },
      {discrete: true},
    );
  });

  it('round-trips a display text that differs from the mention name', () => {
    using editor = buildEditorFromExtensions(MentionTestExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createMentionNode('luke_skywalker', 'Luke Skywalker'),
            ),
          );
      },
      {discrete: true},
    );

    const html = editor.read(() => $generateHtmlFromNodes(editor, null));
    expect(html).toContain('data-lexical-mention-name="luke_skywalker"');

    using target = buildEditorFromExtensions(MentionTestExtension);
    target.update(
      () => {
        $getRoot().clear().select();
        $importHtml(html);
      },
      {discrete: true},
    );

    target.read(() => {
      const mention = $getMention();
      expect(mention.getTextContent()).toBe('Luke Skywalker');
      expect(mention.exportJSON().mentionName).toBe('luke_skywalker');
    });
  });
});
