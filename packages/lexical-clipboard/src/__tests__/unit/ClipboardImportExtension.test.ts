/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $insertDataTransferForRichText,
  $insertGeneratedNodes,
  ClipboardImportExtension,
} from '@lexical/clipboard';
import {
  buildEditorFromExtensions,
  configExtension,
  defineExtension,
} from '@lexical/extension';
import {
  $generateNodesFromDOMViaExtension,
  contextValue,
  CoreImportExtension,
  ImportSource,
} from '@lexical/html';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getEditor,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function $initialEditorState(): void {
  $getRoot().append($createParagraphNode()).select();
}

function dataTransferWithHtml(html: string): DataTransfer {
  const dt = new DataTransfer();
  dt.setData('text/html', html);
  return dt as unknown as DataTransfer;
}

function dataTransferWithPlainText(text: string): DataTransfer {
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  return dt as unknown as DataTransfer;
}

function $pasteHtml(
  editor: ReturnType<typeof buildEditorFromExtensions>,
  html: string,
) {
  editor.update(
    () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'expected RangeSelection');
      $insertDataTransferForRichText(
        dataTransferWithHtml(html),
        selection,
        editor,
      );
    },
    {discrete: true},
  );
}

describe('ClipboardImportExtension', () => {
  test('default importer handles a basic <p> paste (no extension configured)', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({$initialEditorState, name: 'host'}),
    );
    $pasteHtml(editor, '<p>hello</p>');
    editor.read(() => {
      const lastChild = $getRoot().getLastChild();
      assert($isParagraphNode(lastChild), 'expected paragraph');
      expect(lastChild.getTextContent()).toBe('hello');
    });
  });

  test('a registered text/html handler runs before the default and can stop the chain', () => {
    let called = 0;
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState,
        dependencies: [
          configExtension(ClipboardImportExtension, {
            $importMimeType: {
              'text/html': [
                (_html, selection) => {
                  called++;
                  const p = $createParagraphNode().append(
                    $createTextNode('[custom]'),
                  );
                  $insertGeneratedNodes($getEditor(), [p], selection);
                  return true;
                },
              ],
            },
          }),
        ],
        name: 'host',
      }),
    );
    $pasteHtml(editor, '<p>ignored</p>');
    editor.read(() => {
      const lastChild = $getRoot().getLastChild();
      assert($isParagraphNode(lastChild), 'expected paragraph');
      expect(lastChild.getTextContent()).toBe('[custom]');
    });
    expect(called).toBe(1);
  });

  test('handler can call next() to defer to the default', () => {
    let deferred = false;
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState,
        dependencies: [
          configExtension(ClipboardImportExtension, {
            $importMimeType: {
              'text/html': [
                (_html, _selection, $next) => {
                  deferred = true;
                  return $next();
                },
              ],
            },
          }),
        ],
        name: 'host',
      }),
    );
    $pasteHtml(editor, '<p>hello</p>');
    editor.read(() => {
      const lastChild = $getRoot().getLastChild();
      assert($isParagraphNode(lastChild), 'expected paragraph');
      expect(lastChild.getTextContent()).toBe('hello');
    });
    expect(deferred).toBe(true);
  });

  test('app-defined MIME type is reached when added to both stack and priority', () => {
    let saw = '';
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState,
        dependencies: [
          configExtension(ClipboardImportExtension, {
            $importMimeType: {
              'application/vnd.myapp+json': [
                (data, selection) => {
                  saw = data;
                  const p = $createParagraphNode().append(
                    $createTextNode(`[${data}]`),
                  );
                  $insertGeneratedNodes($getEditor(), [p], selection);
                  return true;
                },
              ],
            },
            // Slot the custom MIME type between lexical-editor (0) and
            // text/html (10). The other built-in weights inherit from
            // the defaults; we don't need to enumerate them.
            priority: {'application/vnd.myapp+json': 5},
          }),
        ],
        name: 'host',
      }),
    );
    const dt = new DataTransfer();
    dt.setData('text/html', '<p>html-fallback</p>');
    dt.setData('application/vnd.myapp+json', '{"a":1}');
    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'expected RangeSelection');
        $insertDataTransferForRichText(
          dt as unknown as DataTransfer,
          selection,
          editor,
        );
      },
      {discrete: true},
    );
    expect(saw).toBe('{"a":1}');
    editor.read(() => {
      const lastChild = $getRoot().getLastChild();
      assert($isParagraphNode(lastChild), 'expected paragraph');
      expect(lastChild.getTextContent()).toBe('[{"a":1}]');
    });
  });

  test('priority weights compose without coordination between extensions', () => {
    let myAppCalls = 0;
    let htmlCalls = 0;
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState,
        dependencies: [
          configExtension(ClipboardImportExtension, {
            $importMimeType: {
              'application/vnd.myapp+json': [
                () => {
                  myAppCalls++;
                  return true;
                },
              ],
              'text/html': [
                (_html, _selection, $next) => {
                  htmlCalls++;
                  return $next();
                },
              ],
            },
            // myapp gets weight 1 → runs ahead of html (default weight 10).
            priority: {'application/vnd.myapp+json': 1},
          }),
        ],
        name: 'host',
      }),
    );
    const dt = new DataTransfer();
    dt.setData('text/html', '<p>x</p>');
    dt.setData('application/vnd.myapp+json', '{}');
    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'expected RangeSelection');
        $insertDataTransferForRichText(
          dt as unknown as DataTransfer,
          selection,
          editor,
        );
      },
      {discrete: true},
    );
    expect(myAppCalls).toBe(1);
    expect(htmlCalls).toBe(0);
  });

  test('text/html can be routed through DOMImportExtension', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState,
        dependencies: [
          CoreImportExtension,
          configExtension(ClipboardImportExtension, {
            $importMimeType: {
              'text/html': [
                (html, selection) => {
                  const parser = new DOMParser();
                  const dom = parser.parseFromString(html, 'text/html');
                  const nodes = $generateNodesFromDOMViaExtension(dom, {
                    context: [contextValue(ImportSource, 'paste')],
                  });
                  $insertGeneratedNodes($getEditor(), nodes, selection);
                  return true;
                },
              ],
            },
          }),
        ],
        name: 'host',
      }),
    );
    $pasteHtml(editor, '<p>via <strong>new</strong> pipeline</p>');
    editor.read(() => {
      const lastChild = $getRoot().getLastChild();
      assert($isParagraphNode(lastChild), 'expected paragraph');
      expect(lastChild.getTextContent()).toBe('via new pipeline');
    });
  });
});

describe('$insertDataTransferForRichText selection argument (#6278)', () => {
  // Two paragraphs, with the *editor's* selection parked at the end of the
  // second one so that inserting at the current selection is distinguishable
  // from inserting at the supplied one.
  function makeEditor() {
    return buildEditorFromExtensions(
      defineExtension({
        $initialEditorState() {
          const second = $createTextNode('second');
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('first')),
              $createParagraphNode().append(second),
            );
          second.select();
        },
        name: 'host',
      }),
    );
  }

  function $insertOverFirstParagraph(
    editor: ReturnType<typeof buildEditorFromExtensions>,
    dataTransfer: DataTransfer,
  ) {
    editor.update(
      () => {
        const [firstParagraph] = $getRoot().getChildren();
        const selection = $createRangeSelection();
        selection.anchor.set(firstParagraph.getKey(), 0, 'element');
        selection.focus.set(firstParagraph.getKey(), 1, 'element');
        $insertDataTransferForRichText(dataTransfer, selection, editor);
      },
      {discrete: true},
    );
  }

  function paragraphTexts(
    editor: ReturnType<typeof buildEditorFromExtensions>,
  ): string[] {
    return editor.read(() =>
      $getRoot()
        .getChildren()
        .map(node => node.getTextContent()),
    );
  }

  test('text/plain is inserted at the supplied selection', () => {
    using editor = makeEditor();
    $insertOverFirstParagraph(editor, dataTransferWithPlainText('replacement'));
    expect(paragraphTexts(editor)).toEqual(['replacement', 'second']);
  });

  test('multi-line text/plain is inserted at the supplied selection', () => {
    using editor = makeEditor();
    $insertOverFirstParagraph(editor, dataTransferWithPlainText('one\ntwo'));
    expect(paragraphTexts(editor)).toEqual(['one', 'two', 'second']);
  });

  test('text/uri-list is inserted at the supplied selection', () => {
    using editor = makeEditor();
    const dt = new DataTransfer();
    dt.setData('text/uri-list', 'https://lexical.dev');
    $insertOverFirstParagraph(editor, dt as unknown as DataTransfer);
    expect(paragraphTexts(editor)).toEqual(['https://lexical.dev', 'second']);
  });

  test('text/html is inserted at the supplied selection', () => {
    // Control: the text/html handler already honored the argument before
    // this fix, so this passes with or without it.
    using editor = makeEditor();
    $insertOverFirstParagraph(
      editor,
      dataTransferWithHtml('<p>replacement</p>'),
    );
    expect(paragraphTexts(editor)).toEqual(['replacement', 'second']);
  });

  test('text/plain still lands at the caret on the ordinary paste path', () => {
    // Control: when the argument *is* the editor's selection (every paste
    // and drop), behaviour is unchanged. Passes with or without the fix.
    using editor = makeEditor();
    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'expected RangeSelection');
        $insertDataTransferForRichText(
          dataTransferWithPlainText('!'),
          selection,
          editor,
        );
      },
      {discrete: true},
    );
    expect(paragraphTexts(editor)).toEqual(['first', 'second!']);
  });
});
