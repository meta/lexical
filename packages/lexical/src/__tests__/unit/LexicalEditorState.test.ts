/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $isParagraphNode,
  $isTextNode,
  type ParagraphNode,
  type RootNode,
  type TextNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {EditorState} from '../../LexicalEditorState';
import {$createRootNode} from '../../nodes/LexicalRootNode';
import {initializeUnitTest} from '../utils';

describe('LexicalEditorState tests', () => {
  initializeUnitTest(testEnv => {
    test('isEmpty', async () => {
      const root = $createRootNode();
      expect(new EditorState(new Map([['root', root]])).isEmpty()).toBe(true);
      // A state with nothing in it at all is emptier still. Reporting it as
      // non-empty let `setEditorState` commit an editor with no root for
      // `$getRoot` to find, rather than refusing it.
      expect(new EditorState(new Map()).isEmpty()).toBe(true);
    });

    test('constructor', async () => {
      const root = $createRootNode();
      const nodeMap = new Map([['root', root]]);

      const editorState = new EditorState(nodeMap);
      expect(editorState._nodeMap).toBe(nodeMap);
      expect(editorState._selection).toBe(null);
    });

    test("read('pending' | 'latest' | 'force-commit')", () => {
      const {editor} = testEnv;
      const $textContent = () => $getRoot().getTextContent();

      // a regular update is processed synchronously but committed
      // asynchronously
      editor.update(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('foo')),
        );
      });
      expect(editor.getEditorState().read($textContent)).toBe('');
      // read('pending') observes the pending state without flushing it
      expect(editor.read('pending', $textContent)).toBe('foo');
      // read('latest') reads the committed state without flushing the pending
      // state, equivalent to editor.getEditorState().read(fn, {editor})
      expect(editor.read('latest', $textContent)).toBe('');
      // neither 'pending' nor 'latest' commits the pending state
      expect(editor.getEditorState().read($textContent)).toBe('');
      // read() defaults to 'force-commit', which flushes the pending state
      expect(editor.read($textContent)).toBe('foo');
      expect(editor.getEditorState().read($textContent)).toBe('foo');
      // without a pending state, all modes read the committed state
      expect(editor.read('pending', $textContent)).toBe('foo');
      expect(editor.read('latest', $textContent)).toBe('foo');
      expect(editor.read('force-commit', $textContent)).toBe('foo');
    });

    test('read()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('foo');
        paragraph.append(text);
        $getRoot().append(paragraph);
      });

      let root!: RootNode;
      let paragraph!: ParagraphNode;
      let text!: TextNode;

      editor.getEditorState().read(() => {
        root = $getRoot();
        const firstChild = root.getFirstChild();
        assert($isParagraphNode(firstChild), 'Expected a ParagraphNode');
        paragraph = firstChild;
        const firstGrandchild = firstChild.getFirstChild();
        assert($isTextNode(firstGrandchild), 'Expected a TextNode');
        text = firstGrandchild;
      });

      expect(root).toEqual({
        __cachedText: 'foo',
        __dir: null,
        __first: '1',
        __format: 0,
        __indent: 0,
        __key: 'root',
        __last: '1',
        __next: null,
        __parent: null,
        __prev: null,
        __size: 1,
        __slotHost: null,
        __slots: null,
        __style: '',
        __textFormat: 0,
        __textStyle: '',
        __type: 'root',
      });
      expect(paragraph).toEqual({
        __dir: null,
        __first: '2',
        __format: 0,
        __indent: 0,
        __key: '1',
        __last: '2',
        __next: null,
        __parent: 'root',
        __prev: null,
        __size: 1,
        __slotHost: null,
        __slots: null,
        __style: '',
        __textFormat: 0,
        __textStyle: '',
        __type: 'paragraph',
      });
      expect(text).toEqual({
        __detail: 0,
        __format: 0,
        __key: '2',
        __mode: 0,
        __next: null,
        __parent: '1',
        __prev: null,
        __style: '',
        __text: 'foo',
        __type: 'text',
      });
      expect(() => editor.getEditorState().read(() => $getEditor())).toThrow(
        /Unable to find an active editor/,
      );
      expect(
        editor.getEditorState().read(() => $getEditor(), {editor: editor}),
      ).toBe(editor);
    });

    test('toJSON()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('Hello world');
        text.select(6, 11);
        paragraph.append(text);
        $getRoot().append(paragraph);
      });

      // Compared as a structure rather than as bytes. Key order is not part of
      // the serialization format — nothing reads a document positionally, and
      // `JSON.parse` gives back the same object whichever order it was written
      // in — so a test that pins the bytes fails for a reordering that changes
      // nothing about the document.
      expect(editor.getEditorState().toJSON()).toEqual(
        JSON.parse(
          `{"root":{"children":[{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"Hello world","type":"text","version":1}],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"root","version":1}}`,
        ),
      );
    });

    test('ensure garbage collection works as expected', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('foo');
        paragraph.append(text);
        $getRoot().append(paragraph);
      });
      // Remove the first node, which should cause a GC for everything

      await editor.update(() => {
        $getRoot().getFirstChild()!.remove();
      });

      expect(editor.getEditorState()._nodeMap).toEqual(
        new Map([
          [
            'root',
            {
              __cachedText: '',
              __dir: null,
              __first: null,
              __format: 0,
              __indent: 0,
              __key: 'root',
              __last: null,
              __next: null,
              __parent: null,
              __prev: null,
              __size: 0,
              __slotHost: null,
              __slots: null,
              __style: '',
              __textFormat: 0,
              __textStyle: '',
              __type: 'root',
            },
          ],
        ]),
      );
    });
  });
});
