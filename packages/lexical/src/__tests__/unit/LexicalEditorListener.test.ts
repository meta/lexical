/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

describe('LexicalEditor listeners', () => {
  describe('registerRootListener', () => {
    test('can return a function that is called when unregistered', () => {
      using editor = buildEditorFromExtensions({name: '@test'});
      const rootListenerCallback = vi.fn();
      const rootListener = vi
        .fn()
        .mockImplementation((nextRoot, prevRoot) => rootListenerCallback);
      const unregister = editor.registerRootListener(rootListener);
      expect(editor._listeners.root.has(rootListener)).toBe(true);
      expect(rootListener).toHaveBeenCalledTimes(1);
      expect(rootListener).toHaveBeenLastCalledWith(null, null);
      expect(rootListenerCallback).toHaveBeenCalledTimes(0);
      unregister();
      expect(rootListener).toHaveBeenCalledTimes(2);
      expect(rootListener).toHaveBeenLastCalledWith(null, null);
      // Called once to unregister the original return value and then again after the finalization (null, …) call
      expect(rootListenerCallback).toHaveBeenCalledTimes(2);
      expect(editor._listeners.root.has(rootListener)).toBe(false);
    });
    test('updates the function on each call', () => {
      using editor = buildEditorFromExtensions({name: '@test'});
      const rootListenerCallback = vi.fn();
      const rootListener = vi
        .fn()
        .mockImplementationOnce((nextRoot, prevRoot) => rootListenerCallback);
      const unregister = editor.registerRootListener(rootListener);
      expect(rootListener).toHaveBeenCalledTimes(1);
      expect(rootListener).toHaveBeenLastCalledWith(null, null);
      expect(rootListenerCallback).toHaveBeenCalledTimes(0);
      unregister();
      expect(rootListener).toHaveBeenCalledTimes(2);
      expect(rootListener).toHaveBeenLastCalledWith(null, null);
      // Only the first call returns the function
      expect(rootListenerCallback).toHaveBeenCalledTimes(1);
    });
    test('works when the root element changes too', () => {
      using editor = buildEditorFromExtensions({name: '@test'});
      const rootListenerCallback = vi.fn();
      const rootListener = vi
        .fn()
        .mockImplementation((nextRoot, prevRoot) =>
          rootListenerCallback.bind(null, nextRoot, prevRoot),
        );
      const initialRoot = document.createElement('div');
      const nextRoot = document.createElement('div');
      editor.setRootElement(initialRoot);
      const unregister = editor.registerRootListener(rootListener);
      expect(rootListenerCallback).toHaveBeenCalledTimes(0);
      editor.setRootElement(nextRoot);
      editor.setRootElement(null);
      editor.setRootElement(initialRoot);
      // We haven't unregistered the call to initialRoot yet
      expect(rootListenerCallback.mock.calls).toEqual([
        [initialRoot, null],
        [nextRoot, initialRoot],
        [null, nextRoot],
      ]);
      unregister();
      expect(rootListenerCallback.mock.calls).toEqual([
        [initialRoot, null],
        [nextRoot, initialRoot],
        [null, nextRoot],
        [initialRoot, null],
        [null, initialRoot],
      ]);
    });
  });

  describe('registerEditableListener', () => {
    test('can return a function that is called when unregistered', () => {
      using editor = buildEditorFromExtensions({name: '@test'});
      const editableListenerCallback = vi.fn();
      const editableListener = vi
        .fn()
        .mockImplementation(() => editableListenerCallback);
      const unregister = editor.registerEditableListener(editableListener);
      expect(editor._listeners.editable.has(editableListener)).toBe(true);
      // Not called immediately on registration
      expect(editableListener).toHaveBeenCalledTimes(0);
      expect(editableListenerCallback).toHaveBeenCalledTimes(0);
      editor.setEditable(false);
      // Called on first change
      expect(editableListener).toHaveBeenCalledTimes(1);
      expect(editableListenerCallback).toHaveBeenCalledTimes(0);
      unregister();
      // Called on unregister
      expect(editableListener).toHaveBeenCalledTimes(1);
      expect(editableListenerCallback).toHaveBeenCalledTimes(1);
      expect(editor._listeners.editable.has(editableListener)).toBe(false);
    });
    test('updates the function on each call', () => {
      using editor = buildEditorFromExtensions({name: '@test'});
      const editableListenerCallback = vi.fn();
      const editableListener = vi
        .fn()
        .mockImplementationOnce(() => editableListenerCallback);
      const unregister = editor.registerEditableListener(editableListener);
      // Not called immediately
      expect(editableListener).toHaveBeenCalledTimes(0);
      expect(editableListenerCallback).toHaveBeenCalledTimes(0);
      editor.setEditable(false);
      expect(editableListener).toHaveBeenCalledTimes(1);
      expect(editableListener).toHaveBeenLastCalledWith(false);
      expect(editableListenerCallback).toHaveBeenCalledTimes(0);
      editor.setEditable(true);
      expect(editableListener).toHaveBeenCalledTimes(2);
      expect(editableListener).toHaveBeenLastCalledWith(true);
      // Only the first call returns the function
      expect(editableListenerCallback).toHaveBeenCalledTimes(1);
      unregister();
      // Only the first call returns the function
      expect(editableListenerCallback).toHaveBeenCalledTimes(1);
    });
    test('works when editable state changes', () => {
      using editor = buildEditorFromExtensions({name: '@test'});
      const editableListenerCallback = vi.fn();
      const editableListener = vi
        .fn()
        .mockImplementation(editable =>
          editableListenerCallback.bind(null, editable),
        );
      const unregister = editor.registerEditableListener(editableListener);
      // Not called on registration
      expect(editableListener).toHaveBeenCalledTimes(0);
      expect(editableListenerCallback).toHaveBeenCalledTimes(0);
      editor.setEditable(false);
      expect(editableListener).toHaveBeenCalledTimes(1);
      expect(editableListenerCallback).toHaveBeenCalledTimes(0);
      editor.setEditable(true);
      expect(editableListener).toHaveBeenCalledTimes(2);
      // Previous callback is called when state changes
      expect(editableListenerCallback.mock.calls).toEqual([[false]]);
      editor.setEditable(false);
      expect(editableListenerCallback.mock.calls).toEqual([[false], [true]]);
      unregister();
      // Final callback is called on unregister
      expect(editableListenerCallback.mock.calls).toEqual([
        [false],
        [true],
        [false],
      ]);
    });
  });

  // UpdateListener / DecoratorListener / TextContentListener are typed
  // `=> void`, so TypeScript lets them return any value. Those values must not
  // be treated as unregister callbacks — doing so threw
  // "unregister is not a function" out of the next commit.
  describe('listener return values', () => {
    function buildRichTextEditor() {
      return buildEditorFromExtensions({
        dependencies: [RichTextExtension],
        name: '@test-void-listeners',
      });
    }

    function $appendParagraph(text: string) {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode(text)));
    }

    test('an update listener may return a non-function value', () => {
      using editor = buildRichTextEditor();
      const seen: string[] = [];
      // Extensions in the editor may keep update listeners of their own, so
      // compare against what was registered before rather than against zero.
      const before = editor._listeners.update.size;
      // `Array.prototype.push` returns a number; assignable to `=> void`.
      const unregister = editor.registerUpdateListener(() => seen.push('x'));

      editor.update(() => $appendParagraph('a'), {discrete: true});
      editor.update(() => $appendParagraph('b'), {discrete: true});
      unregister();

      expect(seen).toEqual(['x', 'x']);
      expect(editor._listeners.update.size).toBe(before);
    });

    test('a text content listener may return a non-function value', () => {
      using editor = buildRichTextEditor();
      const seen: string[] = [];
      const unregister = editor.registerTextContentListener(text =>
        seen.push(text),
      );

      editor.update(() => $appendParagraph('a'), {discrete: true});
      editor.update(() => $appendParagraph('b'), {discrete: true});
      unregister();

      expect(seen).toEqual(['a', 'b']);
    });

    test('an update listener returning a function gets it called as cleanup', () => {
      using editor = buildRichTextEditor();
      const cleanup = vi.fn();
      const unregister = editor.registerUpdateListener(() => cleanup);

      editor.update(() => $appendParagraph('a'), {discrete: true});
      // The cleanup from the first call runs before the second call.
      expect(cleanup).toHaveBeenCalledTimes(0);
      editor.update(() => $appendParagraph('b'), {discrete: true});
      expect(cleanup).toHaveBeenCalledTimes(1);
      unregister();
      expect(cleanup).toHaveBeenCalledTimes(2);
    });
  });
});
