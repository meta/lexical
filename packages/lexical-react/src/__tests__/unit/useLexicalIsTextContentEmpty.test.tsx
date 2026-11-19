/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {useLexicalIsTextContentEmpty} from '@lexical/react/useLexicalIsTextContentEmpty';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  createEditor,
  type LexicalEditor,
  ParagraphNode,
} from 'lexical';
import * as React from 'react';
import {act, createRef} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';

// getTextContent can depend on the editor, e.g. to read an extension's config
// (https://github.com/meta/lexical/issues/9934).
class EditorReadingParagraphNode extends ParagraphNode {
  $config() {
    return this.config('editor-reading-paragraph', {extends: ParagraphNode});
  }

  getTextContent(): string {
    $getEditor();
    return super.getTextContent();
  }
}

describe('useLexicalIsTextContentEmpty', () => {
  let container: HTMLDivElement | null = null;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    reactRoot = createRoot(container);
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container!);
    container = null;

    vi.restoreAllMocks();
  });

  function useLexicalEditor(
    rootElementRef: React.RefObject<null | HTMLDivElement>,
  ) {
    const editor = React.useMemo(
      () =>
        createEditor({
          namespace: '',
          nodes: [ParagraphNode],
          onError: err => {
            throw err;
          },
        }),
      [],
    );

    React.useEffect(() => {
      const rootElement = rootElementRef.current;
      editor.setRootElement(rootElement);
    }, [rootElementRef, editor]);

    return editor;
  }

  test('hook works', async () => {
    const ref = createRef<null | HTMLDivElement>();
    let editor: LexicalEditor;
    let hasText = false;

    function TestBase() {
      editor = useLexicalEditor(ref);
      const isBlank = useLexicalIsTextContentEmpty(editor);

      expect(isBlank).toBe(!hasText);

      return <div ref={ref} contentEditable={true} />;
    }

    act(() => {
      reactRoot.render(<TestBase />);
    });

    await act(async () => {
      await editor.update(() => {
        const root = $getRoot();

        const paragraph = $createParagraphNode();
        const text = $createTextNode('foo');

        root.append(paragraph);
        paragraph.append(text);

        hasText = true;
      });
    });
  });

  // The editor has no root element, so no reconciled text is cached and the
  // read reaches the paragraph's own getTextContent.
  test('reads the text of an update with the active editor', async () => {
    const editor = buildEditorFromExtensions({
      name: 'test',
      nodes: [EditorReadingParagraphNode],
    });
    onTestFinished(() => editor.dispose());
    let isEmpty: boolean | undefined;

    function Test() {
      isEmpty = useLexicalIsTextContentEmpty(editor);
      return null;
    }

    await act(async () => {
      reactRoot.render(<Test />);
    });
    expect(isEmpty).toBe(true);

    await act(async () => {
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $create(EditorReadingParagraphNode).append(
                $createTextNode('foo'),
              ),
            );
        },
        {discrete: true},
      );
    });
    expect(isEmpty).toBe(false);
  });
});
