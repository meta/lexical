/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {
  buildEditorFromExtensions,
  configExtension,
  getExtensionDependencyFromEditor,
  NestedEditorExtension,
} from '@lexical/extension';
import {
  $getEditor,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

describe('NestedEditorExtension', () => {
  test('it sets _parentEditor implicitly', () => {
    using editor = buildEditorFromExtensions({name: 'parent'});
    const childEditor = editor.read(() =>
      buildEditorFromExtensions({
        dependencies: [NestedEditorExtension],
        name: 'child',
      }),
    );
    expect(childEditor._parentEditor).toBe(editor);
  });
  test('$getParentEditor can be overridden', () => {
    using editor = buildEditorFromExtensions({name: 'parent'});
    const childEditor = buildEditorFromExtensions({
      dependencies: [
        configExtension(NestedEditorExtension, {
          $getParentEditor: () => editor,
        }),
      ],
      name: 'child',
    });
    expect(childEditor._parentEditor).toBe(editor);
  });
  test('The theme is inherited by default', () => {
    const editor = buildEditorFromExtensions({
      name: 'parent',
      theme: {text: {bold: 'bold'}},
    });
    const childEditor = editor.read(() =>
      buildEditorFromExtensions({
        dependencies: [NestedEditorExtension],
        name: 'child',
      }),
    );
    expect(childEditor._config.theme.text?.bold).toBe('bold');
  });
  test('If the child has a theme it is not inherited', () => {
    using editor = buildEditorFromExtensions({
      name: 'parent',
      theme: {text: {bold: 'bold', italic: 'italic'}},
    });
    const childEditor = editor.read(() =>
      buildEditorFromExtensions({
        dependencies: [NestedEditorExtension],
        name: 'child',
        theme: {text: {italic: 'child-italic'}},
      }),
    );
    expect(childEditor._config.theme.text?.bold).toBe(undefined);
    expect(childEditor._config.theme.text?.italic).toBe('child-italic');
  });
  test('inheritEditableFromParent defaults false but can be enabled later', () => {
    using editor = buildEditorFromExtensions({
      name: 'parent',
    });
    const childEditor = editor.read(() =>
      buildEditorFromExtensions({
        dependencies: [NestedEditorExtension],
        editable: false,
        name: 'child',
      }),
    );
    expect(editor.isEditable()).toBe(true);
    expect(childEditor.isEditable()).toBe(false);
    getExtensionDependencyFromEditor(
      childEditor,
      NestedEditorExtension,
    ).output.inheritEditableFromParent.value = true;
    expect(childEditor.isEditable()).toBe(true);
    editor.setEditable(false);
    expect(editor.isEditable()).toBe(false);
    expect(childEditor.isEditable()).toBe(false);
  });
  test('inheritEditableFromParent works when configured true', () => {
    using editor = buildEditorFromExtensions({
      editable: false,
      name: 'parent',
    });
    const childEditor = editor.read(() =>
      buildEditorFromExtensions({
        dependencies: [
          configExtension(NestedEditorExtension, {
            inheritEditableFromParent: true,
          }),
        ],
        editable: false,
        name: 'child',
      }),
    );
    expect(editor.isEditable()).toBe(false);
    expect(childEditor.isEditable()).toBe(false);
    editor.setEditable(true);
    expect(editor.isEditable()).toBe(true);
    expect(childEditor.isEditable()).toBe(true);
  });

  test('Commands delegate to parent synchronously when parent is not updating', () => {
    const TEST_COMMAND = createCommand<string>('TEST_COMMAND');
    using parentEditor = buildEditorFromExtensions({name: 'parent'});
    using childEditor = parentEditor.read(() =>
      buildEditorFromExtensions({
        dependencies: [NestedEditorExtension],
        name: 'child',
      }),
    );

    const parentListener = vi.fn((_payload: string, editor: LexicalEditor) => {
      expect(editor).toBe(childEditor);
      expect($getEditor()).toBe(parentEditor);
      return true;
    });
    const childListener = vi.fn((_payload: string, editor: LexicalEditor) => {
      expect(editor).toBe(childEditor);
      expect($getEditor()).toBe(childEditor);
      return false;
    });

    // Register listeners
    childEditor.registerCommand(
      TEST_COMMAND,
      childListener,
      COMMAND_PRIORITY_EDITOR,
    );
    parentEditor.registerCommand(
      TEST_COMMAND,
      parentListener,
      COMMAND_PRIORITY_EDITOR,
    );

    // Dispatch command from child editor
    childEditor.update(
      () => {
        const result = childEditor.dispatchCommand(
          TEST_COMMAND,
          'test-payload',
        );
        // Verify synchronous execution
        expect(childListener).toHaveBeenCalledTimes(1);
        expect(parentListener).toHaveBeenCalledTimes(1);
        expect(result).toBe(true);
      },
      {discrete: true},
    );
    expect(childListener).toHaveBeenCalledTimes(1);
    expect(parentListener).toHaveBeenCalledTimes(1);
  });

  test('Commands delegate to parent asynchronously when parent is updating', async () => {
    const TEST_COMMAND = createCommand<string>('TEST_COMMAND');
    using parentEditor = buildEditorFromExtensions({name: 'parent'});
    using childEditor = parentEditor.read(() =>
      buildEditorFromExtensions({
        dependencies: [NestedEditorExtension],
        name: 'child',
      }),
    );

    const parentListener = vi.fn((_payload: string, editor: LexicalEditor) => {
      expect(editor).toBe(childEditor);
      expect($getEditor()).toBe(parentEditor);
      return true;
    });
    const childListener = vi.fn((_payload: string, editor: LexicalEditor) => {
      expect(editor).toBe(childEditor);
      expect($getEditor()).toBe(childEditor);
      return false;
    });

    // Register listeners
    childEditor.registerCommand(
      TEST_COMMAND,
      childListener,
      COMMAND_PRIORITY_EDITOR,
    );
    parentEditor.registerCommand(
      TEST_COMMAND,
      parentListener,
      COMMAND_PRIORITY_EDITOR,
    );

    parentEditor.update(
      () => {
        const result = childEditor.dispatchCommand(
          TEST_COMMAND,
          'test-payload',
        );
        // Verify synchronous execution of child listener
        expect(childListener).toHaveBeenCalledTimes(1);
        expect(result).toBe(false);
        // Parent not called yet
        expect(parentListener).toHaveBeenCalledTimes(0);
      },
      {discrete: true},
    );
    // Parent called after containing update
    expect(parentListener).toHaveBeenCalledTimes(1);
  });
});
