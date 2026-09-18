/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createCodeHighlightNode,
  $createCodeNode,
  $isCodeNode,
  CodeIndentExtension,
} from '@lexical/code';
import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTabNode,
  $getRoot,
  $isTabNode,
  $isTextNode,
  configExtension,
  defineExtension,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

// Shift+Tab (OUTDENT_CONTENT_COMMAND) with a *collapsed* caret at column 0 of
// an indented code line silently did nothing: $getCodeLines drops a trailing
// line when the selection ends exactly at its start, which for a collapsed
// caret is the only line, so the outdent loop had nothing to work on.

function buildEditor(tabSize?: number) {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        const code = $createCodeNode('javascript');
        code.append($createTabNode(), $createCodeHighlightNode('hello'));
        $getRoot().append(code);
      },
      dependencies: [
        tabSize === undefined
          ? CodeIndentExtension
          : configExtension(CodeIndentExtension, {tabSize}),
        RichTextExtension,
      ],
      name: '[root-outdent]',
    }),
  );
}

function $codeText(): string {
  const code = $getRoot().getFirstChildOrThrow();
  assert($isCodeNode(code), 'expected a CodeNode');
  return code.getTextContent();
}

describe('OUTDENT_CONTENT_COMMAND at the start of a code line', () => {
  it('outdents when the caret is collapsed at column 0 (on the TabNode)', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        const tab = $getRoot().getFirstDescendant();
        assert($isTabNode(tab), 'expected a TabNode');
        tab.select(0, 0);
      },
      {discrete: true},
    );
    editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);

    expect(editor.read($codeText)).toBe('hello');
  });

  it('outdents when the caret is collapsed at column 0 of the code text', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        const text = $getRoot().getLastDescendant();
        assert(text !== null, 'expected a text node');
        text.selectStart();
      },
      {discrete: true},
    );
    editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);

    expect(editor.read($codeText)).toBe('hello');
  });

  it('still outdents from a non-zero column (unchanged behaviour)', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        const text = $getRoot().getLastDescendant();
        assert($isTextNode(text), 'expected a text node');
        text.select(1, 1);
      },
      {discrete: true},
    );
    editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);

    expect(editor.read($codeText)).toBe('hello');
  });

  it('strips a space indent from column 0 when tabSize is configured', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const code = $createCodeNode('javascript');
          code.append($createCodeHighlightNode('  hello'));
          $getRoot().append(code);
        },
        dependencies: [
          configExtension(CodeIndentExtension, {tabSize: 2}),
          RichTextExtension,
        ],
        name: '[root-outdent-spaces]',
      }),
    );

    editor.update(
      () => {
        const text = $getRoot().getLastDescendant();
        assert(text !== null, 'expected a text node');
        text.selectStart();
      },
      {discrete: true},
    );
    editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);

    expect(editor.read($codeText)).toBe('hello');
  });

  it('is still a no-op on an unindented line', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const code = $createCodeNode('javascript');
          code.append($createCodeHighlightNode('hello'));
          $getRoot().append(code);
        },
        dependencies: [CodeIndentExtension, RichTextExtension],
        name: '[root-outdent-flat]',
      }),
    );

    editor.update(
      () => {
        const text = $getRoot().getLastDescendant();
        assert(text !== null, 'expected a text node');
        text.selectStart();
      },
      {discrete: true},
    );
    editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);

    expect(editor.read($codeText)).toBe('hello');
  });
});
