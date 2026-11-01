/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createTableNodeWithDimensions,
  $isTableNode,
  getTableObserverFromTableElement,
  type HTMLTableElementWithWithTableSelectionState,
  registerTablePlugin,
  registerTableSelectionObserver,
  TableCellNode,
  TableExtension,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $getRoot,
  createEditor,
  defineExtension,
  type LexicalEditor,
  type LexicalEditorWithDispose,
  mergeRegister,
} from 'lexical';
import {afterEach, assert, describe, expect, test} from 'vitest';

function $appendTable() {
  $getRoot().append(
    $createTableNodeWithDimensions(2, 2, false),
    $createParagraphNode(),
  );
}

function $getTableKey(): string | null {
  const table = $getRoot().getChildren().find($isTableNode);
  return table ? table.getKey() : null;
}

/** Serialized editor state holding one 2x2 table, made by a separate editor. */
function tableStateJSON(): string {
  const source = buildEditorFromExtensions(
    defineExtension({dependencies: [TableExtension], name: 'table-source'}),
  );
  source.update($appendTable, {discrete: true});
  const json = JSON.stringify(source.getEditorState().toJSON());
  source.dispose();
  return json;
}

function getRenderedTable(
  rootElement: HTMLElement,
): HTMLTableElementWithWithTableSelectionState {
  const tableElement = rootElement.querySelector('table');
  assert(tableElement !== null, 'Expected a rendered table');
  return tableElement;
}

/**
 * An extension listed before TableExtension that replaces the editor state
 * from its register, as an extension that loads stored content does.
 */
function setStateOnRegister(json: string) {
  return defineExtension({
    name: 'set-state-on-register',
    register: (editor: LexicalEditor) => {
      editor.setEditorState(editor.parseEditorState(json));
      return () => {};
    },
  });
}

describe('table selection observer for tables that exist before their DOM', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
  });

  function buildWithTableSetOnRegister(): LexicalEditorWithDispose {
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [setStateOnRegister(tableStateJSON()), TableExtension],
        name: 'state-before-table',
      }),
    );
    cleanups.push(() => editor.dispose());
    return editor;
  }

  function attachRoot(editor: LexicalEditor): HTMLDivElement {
    const rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    document.body.appendChild(rootElement);
    cleanups.push(() => rootElement.remove());
    editor.setRootElement(rootElement);
    cleanups.push(() => editor.setRootElement(null));
    return rootElement;
  }

  test('builds when an earlier extension sets a state holding a table during register', () => {
    const editor = buildWithTableSetOnRegister();
    expect(editor.read($getTableKey)).not.toBe(null);
  });

  test('observes the table once a root element renders it', () => {
    const editor = buildWithTableSetOnRegister();
    const rootElement = attachRoot(editor);
    const tableElement = getRenderedTable(rootElement);
    const observer = getTableObserverFromTableElement(tableElement);
    assert(observer !== null, 'Expected the rendered table to be observed');
    expect(observer.tableNodeKey).toBe(editor.read($getTableKey));
  });

  test('observes the new table DOM when the root element is replaced', () => {
    const editor = buildWithTableSetOnRegister();
    const firstTable = getRenderedTable(attachRoot(editor));
    editor.setRootElement(null);
    const secondTable = getRenderedTable(attachRoot(editor));
    expect(secondTable).not.toBe(firstTable);
    expect(getTableObserverFromTableElement(firstTable)).toBe(null);
    expect(getTableObserverFromTableElement(secondTable)).not.toBe(null);
  });

  test('registerTableSelectionObserver accepts an unrendered table', () => {
    const editor = createEditor({
      nodes: [TableNode, TableRowNode, TableCellNode],
      onError: error => {
        throw error;
      },
    });
    editor.update($appendTable, {discrete: true});
    cleanups.push(
      mergeRegister(
        registerTablePlugin(editor),
        registerTableSelectionObserver(editor),
      ),
    );
    const rootElement = attachRoot(editor);
    expect(
      getTableObserverFromTableElement(getRenderedTable(rootElement)),
    ).not.toBe(null);
  });
});
