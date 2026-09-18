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
  $createLineBreakNode,
  $createParagraphNode,
  $getRoot,
  $isParagraphNode,
  configExtension,
  defineExtension,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  type LexicalCommand,
} from 'lexical';
import {describe, expect, it} from 'vitest';

describe('CodeIndentExtension', () => {
  describe('escapeWithArrows', () => {
    it.each([
      ['ArrowDown', KEY_ARROW_DOWN_COMMAND],
      ['ArrowRight', KEY_ARROW_RIGHT_COMMAND],
    ])(
      'should escape code block to a new paragraph by %s when cursor is at the end',
      (key, command) => {
        const ext = defineExtension({
          $initialEditorState: () => {
            const codeNode = $createCodeNode('javascript');
            const text = $createCodeHighlightNode('hello world');
            codeNode.append(text);
            $getRoot().append(codeNode);
            text.selectEnd();
          },
          dependencies: [
            configExtension(CodeIndentExtension, {escapeWithArrows: true}),
            RichTextExtension,
          ],
          name: '[root-middle]',
        });
        using editor = buildEditorFromExtensions(ext);

        editor.dispatchCommand(command, new KeyboardEvent('keydown', {key}));

        editor.update(
          () => {
            const root = $getRoot();
            expect(root.getChildrenSize()).toBe(2);
            const paragraph = root.getLastChildOrThrow();
            expect($isParagraphNode(paragraph)).toBe(true);
          },
          {discrete: true},
        );
      },
    );

    it.each([
      ['ArrowDown', KEY_ARROW_DOWN_COMMAND],
      ['ArrowRight', KEY_ARROW_RIGHT_COMMAND],
    ])(
      'should not escape code block to a new paragraph by %s when cursor is not at the end',
      (key, command) => {
        const ext = defineExtension({
          $initialEditorState: () => {
            const codeNode = $createCodeNode('javascript');
            const text = $createCodeHighlightNode('hello world');
            codeNode.append(text);
            $getRoot().append(codeNode);
            const length = text.getTextContentSize();
            text.select(length - 1, length - 1);
          },
          dependencies: [
            configExtension(CodeIndentExtension, {escapeWithArrows: true}),
            RichTextExtension,
          ],
          name: '[root-middle]',
        });
        using editor = buildEditorFromExtensions(ext);

        editor.dispatchCommand(command, new KeyboardEvent('keydown', {key}));

        editor.update(
          () => {
            const root = $getRoot();
            expect(root.getChildrenSize()).toBe(1);
            expect($isCodeNode(root.getFirstChildOrThrow())).toBe(true);
          },
          {discrete: true},
        );
      },
    );

    it.each([
      ['ArrowDown', KEY_ARROW_DOWN_COMMAND],
      ['ArrowRight', KEY_ARROW_RIGHT_COMMAND],
    ])(
      'should not escape code block to a new paragraph by %s when cursor is at the end and code block has next sibling',
      (key, command) => {
        const ext = defineExtension({
          $initialEditorState: () => {
            const codeNode = $createCodeNode('javascript');
            const text = $createCodeHighlightNode('hello world');
            codeNode.append(text);
            $getRoot().append(codeNode, $createParagraphNode());
            text.selectEnd();
          },
          dependencies: [
            configExtension(CodeIndentExtension, {escapeWithArrows: true}),
            RichTextExtension,
          ],
          name: '[root-middle]',
        });
        using editor = buildEditorFromExtensions(ext);

        editor.dispatchCommand(command, new KeyboardEvent('keydown', {key}));

        editor.update(
          () => {
            const root = $getRoot();
            expect(root.getChildrenSize()).toBe(2);
            expect($isCodeNode(root.getFirstChildOrThrow())).toBe(true);
            expect($isParagraphNode(root.getLastChildOrThrow())).toBe(true);
          },
          {discrete: true},
        );
      },
    );

    it.each([
      ['ArrowUp', KEY_ARROW_UP_COMMAND],
      ['ArrowLeft', KEY_ARROW_LEFT_COMMAND],
    ])(
      'should escape code block to a new paragraph by %s when cursor is at the beginning',
      (key, command) => {
        const ext = defineExtension({
          $initialEditorState: () => {
            const codeNode = $createCodeNode('javascript');
            const text = $createCodeHighlightNode('hello world');
            codeNode.append(text);
            $getRoot().append(codeNode);
            text.selectStart();
          },
          dependencies: [
            configExtension(CodeIndentExtension, {escapeWithArrows: true}),
            RichTextExtension,
          ],
          name: '[root-middle]',
        });
        using editor = buildEditorFromExtensions(ext);

        editor.dispatchCommand(command, new KeyboardEvent('keydown', {key}));

        editor.update(
          () => {
            const root = $getRoot();
            expect(root.getChildrenSize()).toBe(2);
            const paragraph = root.getFirstChildOrThrow();
            expect($isParagraphNode(paragraph)).toBe(true);
          },
          {discrete: true},
        );
      },
    );

    it.each([
      ['ArrowUp', KEY_ARROW_UP_COMMAND],
      ['ArrowLeft', KEY_ARROW_LEFT_COMMAND],
    ])(
      'should not escape code block to a new paragraph by %s when cursor is not at the beginning',
      (key, command) => {
        const ext = defineExtension({
          $initialEditorState: () => {
            const codeNode = $createCodeNode('javascript');
            const text = $createCodeHighlightNode('hello world');
            codeNode.append(text);
            $getRoot().append(codeNode);
            text.select(1, 1);
          },
          dependencies: [
            configExtension(CodeIndentExtension, {escapeWithArrows: true}),
            RichTextExtension,
          ],
          name: '[root-middle]',
        });
        using editor = buildEditorFromExtensions(ext);

        editor.dispatchCommand(command, new KeyboardEvent('keydown', {key}));

        editor.update(
          () => {
            const root = $getRoot();
            expect(root.getChildrenSize()).toBe(1);
            expect($isCodeNode(root.getFirstChildOrThrow())).toBe(true);
          },
          {discrete: true},
        );
      },
    );

    it.each([
      ['ArrowUp', KEY_ARROW_UP_COMMAND],
      ['ArrowLeft', KEY_ARROW_LEFT_COMMAND],
    ])(
      'should not escape code block to a new paragraph by %s when cursor is at the beginning and code block has previous sibling',
      (key, command) => {
        const ext = defineExtension({
          $initialEditorState: () => {
            const codeNode = $createCodeNode('javascript');
            const text = $createCodeHighlightNode('hello world');
            codeNode.append(text);
            $getRoot().append($createParagraphNode(), codeNode);
            text.selectStart();
          },
          dependencies: [
            configExtension(CodeIndentExtension, {escapeWithArrows: true}),
            RichTextExtension,
          ],
          name: '[root-middle]',
        });
        using editor = buildEditorFromExtensions(ext);

        editor.dispatchCommand(command, new KeyboardEvent('keydown', {key}));

        editor.update(
          () => {
            const root = $getRoot();
            expect(root.getChildrenSize()).toBe(2);
            expect($isParagraphNode(root.getFirstChildOrThrow())).toBe(true);
            expect($isCodeNode(root.getLastChildOrThrow())).toBe(true);
          },
          {discrete: true},
        );
      },
    );

    it.each([
      ['ArrowUp', KEY_ARROW_UP_COMMAND],
      ['ArrowLeft', KEY_ARROW_LEFT_COMMAND],
    ])(
      'should escape code block to a new paragraph by %s when cursor is inside an empty block',
      (key, command) => {
        const ext = defineExtension({
          $initialEditorState: () => {
            const codeNode = $createCodeNode('javascript');
            $getRoot().append(codeNode);
            codeNode.selectStart();
          },
          dependencies: [
            configExtension(CodeIndentExtension, {escapeWithArrows: true}),
            RichTextExtension,
          ],
          name: '[root-middle]',
        });
        using editor = buildEditorFromExtensions(ext);

        editor.dispatchCommand(command, new KeyboardEvent('keydown', {key}));

        editor.update(
          () => {
            const root = $getRoot();
            expect(root.getChildrenSize()).toBe(2);
            const paragraph = root.getFirstChildOrThrow();
            expect($isParagraphNode(paragraph)).toBe(true);
          },
          {discrete: true},
        );
      },
    );

    it.each([
      ['ArrowDown', KEY_ARROW_DOWN_COMMAND],
      ['ArrowRight', KEY_ARROW_RIGHT_COMMAND],
    ])(
      'should escape code block to a new paragraph by %s when cursor is inside an empty block',
      (key, command) => {
        const ext = defineExtension({
          $initialEditorState: () => {
            const codeNode = $createCodeNode('javascript');
            $getRoot().append(codeNode);
            codeNode.selectStart();
          },
          dependencies: [
            configExtension(CodeIndentExtension, {escapeWithArrows: true}),
            RichTextExtension,
          ],
          name: '[root-middle]',
        });
        using editor = buildEditorFromExtensions(ext);

        editor.dispatchCommand(command, new KeyboardEvent('keydown', {key}));

        editor.update(
          () => {
            const root = $getRoot();
            expect(root.getChildrenSize()).toBe(2);
            const paragraph = root.getLastChildOrThrow();
            expect($isParagraphNode(paragraph)).toBe(true);
          },
          {discrete: true},
        );
      },
    );

    it('should not escape code block to a new paragraph by Alt/Option + ArrowDown when cursor is at the end', () => {
      const ext = defineExtension({
        $initialEditorState: () => {
          const codeNode = $createCodeNode('javascript');
          const text = $createCodeHighlightNode('hello world');
          codeNode.append(text);
          $getRoot().append(codeNode);
          text.selectEnd();
        },
        dependencies: [
          configExtension(CodeIndentExtension, {escapeWithArrows: true}),
          RichTextExtension,
        ],
        name: '[root-middle]',
      });
      using editor = buildEditorFromExtensions(ext);

      editor.dispatchCommand(
        KEY_ARROW_DOWN_COMMAND,
        new KeyboardEvent('keydown', {altKey: true, key: 'ArrowDown'}),
      );

      editor.update(
        () => {
          const root = $getRoot();
          expect(root.getChildrenSize()).toBe(1);
          expect($isCodeNode(root.getFirstChildOrThrow())).toBe(true);
        },
        {discrete: true},
      );
    });

    it('should not escape code block to a new paragraph by Alt/Option + ArrowUp when cursor is at the beginning', () => {
      const ext = defineExtension({
        $initialEditorState: () => {
          const codeNode = $createCodeNode('javascript');
          const text = $createCodeHighlightNode('hello world');
          codeNode.append(text);
          $getRoot().append(codeNode);
          text.selectStart();
        },
        dependencies: [
          configExtension(CodeIndentExtension, {escapeWithArrows: true}),
          RichTextExtension,
        ],
        name: '[root-middle]',
      });
      using editor = buildEditorFromExtensions(ext);

      editor.dispatchCommand(
        KEY_ARROW_UP_COMMAND,
        new KeyboardEvent('keydown', {altKey: true, key: 'ArrowUp'}),
      );

      editor.update(
        () => {
          const root = $getRoot();
          expect(root.getChildrenSize()).toBe(1);
          expect($isCodeNode(root.getFirstChildOrThrow())).toBe(true);
        },
        {discrete: true},
      );
    });
  });

  describe('shiftLines', () => {
    // "A", "" and "B" — a blank line between two lines of code.
    function buildBlankLineEditor(caretOnLastLine: boolean) {
      const ext = defineExtension({
        $initialEditorState: () => {
          const codeNode = $createCodeNode('javascript');
          const first = $createCodeHighlightNode('A');
          const last = $createCodeHighlightNode('B');
          codeNode.append(
            first,
            $createLineBreakNode(),
            $createLineBreakNode(),
            last,
          );
          $getRoot().append(codeNode);
          (caretOnLastLine ? last : first).select(0, 0);
        },
        dependencies: [CodeIndentExtension, RichTextExtension],
        name: '[root-shift-lines]',
      });
      return buildEditorFromExtensions(ext);
    }

    function shift(
      editor: ReturnType<typeof buildBlankLineEditor>,
      command: LexicalCommand<KeyboardEvent>,
    ) {
      const key = command === KEY_ARROW_UP_COMMAND ? 'ArrowUp' : 'ArrowDown';
      editor.dispatchCommand(
        command,
        new KeyboardEvent('keydown', {altKey: true, key}),
      );
    }

    it('moves a line up past a blank line without merging it into the line above', () => {
      using editor = buildBlankLineEditor(true);

      shift(editor, KEY_ARROW_UP_COMMAND);

      editor.read(() => {
        const codeNode = $getRoot().getFirstChildOrThrow();
        expect($isCodeNode(codeNode)).toBe(true);
        expect(codeNode.getTextContent()).toBe('A\nB\n');
      });
    });

    it('moves a line down past a blank line without merging it into the line below', () => {
      using editor = buildBlankLineEditor(false);

      shift(editor, KEY_ARROW_DOWN_COMMAND);

      editor.read(() => {
        const codeNode = $getRoot().getFirstChildOrThrow();
        expect($isCodeNode(codeNode)).toBe(true);
        expect(codeNode.getTextContent()).toBe('\nA\nB');
      });
    });
  });
});
