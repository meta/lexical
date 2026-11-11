/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$createCodeNode, type CodeNode} from '@lexical/code';
import {CodeShikiExtension, ShikiTokenizer} from '@lexical/code-shiki';
import {buildEditorFromExtensions, configExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {$createTextNode, $getRoot, defineExtension} from 'lexical';
import {describe, expect, test} from 'vitest';

function createEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        configExtension(CodeShikiExtension, {
          tokenizer: {...ShikiTokenizer, defaultLanguage: null},
        }),
      ],
      name: 'shiki-default-null',
    }),
  );
}

describe('Shiki defaultLanguage: null (#7235)', () => {
  test('leaves `__language` unset and skips highlight mutation', () => {
    using editor = createEditor();

    let codeNode!: CodeNode;
    editor.update(
      () => {
        codeNode = $createCodeNode();
        codeNode.append($createTextNode('hello'));
        $getRoot().append(codeNode);
      },
      {discrete: true},
    );

    editor.read(() => {
      expect(codeNode.getLanguage()).toBe(undefined);
    });
  });

  test('splits text into CodeHighlightNode + LineBreakNode + TabNode for `\\n` / `\\t` so indent + line-move handlers stay compatible', () => {
    using editor = createEditor();

    let codeNode!: CodeNode;
    editor.update(
      () => {
        codeNode = $createCodeNode();
        codeNode.append($createTextNode('a\n\tb'));
        $getRoot().append(codeNode);
      },
      {discrete: true},
    );

    editor.read(() => {
      expect(codeNode.getChildren().map(child => child.getType())).toEqual([
        'code-highlight',
        'linebreak',
        'tab',
        'code-highlight',
      ]);
    });
  });
});
