/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$generateHtmlFromNodes, $generateNodesFromDOM} from '@lexical/html';
import invariant from '@lexical/internal/invariant';
import {
  $createListItemNode,
  $createListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  TableCellNode,
  TableRowNode,
} from '@lexical/table';
import {JSDOM} from 'jsdom';
import * as lexical from 'lexical';
import {
  $createLineBreakNode,
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $extendCaretToRange,
  $getChildCaret,
  $getEditor,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $isRootNode,
  $isTextNode,
  $parseSerializedNode,
  $setCompositionKey,
  $setSelection,
  COMMAND_PRIORITY_BEFORE_EDITOR,
  COMMAND_PRIORITY_BEFORE_LOW,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  type CommandListenerPriority,
  type CommandListenerPriorityBefore,
  createCommand,
  createEditor,
  type EditorState,
  getDOMSelection,
  HISTORY_MERGE_TAG,
  type Klass,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
  type LexicalNodeReplacement,
  mergeRegister,
  ParagraphNode,
  RootNode,
  safeCast,
  SKIP_DOM_SELECTION_TAG,
  TextNode,
  type UpdateListenerPayload,
} from 'lexical';
import * as React from 'react';
import {
  act,
  createRef,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {createPortal} from 'react-dom';
import {createRoot, type Root} from 'react-dom/client';
import {
  afterEach,
  assert,
  assertType,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {emptyFunction} from '../../LexicalUtils';
import {
  $assertNodeType,
  $createTestDecoratorNode,
  $createTestElementNode,
  $createTestInlineElementNode,
  createTestEditor,
  createTestHeadlessEditor,
  expectHtmlToBeEqual,
  html,
  TestComposer,
  TestTextNode,
} from '../utils';

function $getAllNodes(): Set<LexicalNode> {
  const root = $getRoot();
  const set = new Set<LexicalNode>();
  for (const {origin} of $extendCaretToRange($getChildCaret(root, 'next'))) {
    set.add(origin);
  }
  set.add(root);
  return set;
}

function computeUpdateListenerPayload(
  editor: LexicalEditor,
  prevEditorState: EditorState,
  hasDOM: boolean,
): UpdateListenerPayload {
  return editor.read((): UpdateListenerPayload => {
    const dirtyElements: UpdateListenerPayload['dirtyElements'] = new Map();
    const dirtyLeaves: UpdateListenerPayload['dirtyLeaves'] = new Set();
    const mutatedNodes: UpdateListenerPayload['mutatedNodes'] = new Map();
    const tags: UpdateListenerPayload['tags'] = new Set();
    const normalizedNodes: UpdateListenerPayload['normalizedNodes'] = new Set();
    if (hasDOM) {
      for (const node of prevEditorState.read($getAllNodes)) {
        const key = node.getKey();
        const klass = node.constructor;
        const m = mutatedNodes.get(klass) || new Map();
        m.set(key, 'destroyed');
        mutatedNodes.set(klass, m);
      }
    }
    for (const node of $getAllNodes()) {
      const key = node.getKey();
      if ($isElementNode(node)) {
        dirtyElements.set(key, true);
      } else {
        dirtyLeaves.add(key);
      }
      if (hasDOM) {
        const klass = node.constructor;
        const m = mutatedNodes.get(klass) || new Map();
        m.set(
          key,
          prevEditorState.read(() =>
            $getNodeByKey(key) ? 'updated' : 'created',
          ),
        );
        mutatedNodes.set(klass, m);
      }
    }
    // This looks like a corner case in element tracking where
    // dirtyElements has keys that were destroyed!
    for (const [klass, m] of mutatedNodes) {
      if ($isElementNode(klass.prototype)) {
        for (const [nodeKey, value] of m) {
          if (value === 'destroyed') {
            dirtyElements.set(nodeKey, true);
          }
        }
      }
    }
    return {
      dirtyElements,
      dirtyLeaves,
      editorState: editor.getEditorState(),
      mutatedNodes,
      normalizedNodes,
      prevEditorState,
      tags,
    };
  });
}

describe('LexicalEditor tests', () => {
  let container: HTMLElement;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    reactRoot = createRoot(container);
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
    // @ts-ignore
    container = null;

    vi.restoreAllMocks();
  });

  function useLexicalEditor(
    rootElementRef: React.RefObject<null | HTMLDivElement>,
    onError?: (error: Error) => void,
    nodes?: readonly (Klass<LexicalNode> | LexicalNodeReplacement)[],
    onWarn?: (error: Error) => void,
  ) {
    const editor = useMemo(
      () =>
        createTestEditor({
          nodes: nodes ?? [],
          onError: onError || vi.fn(),
          onWarn,
          theme: {
            tableAlignment: {
              center: 'editor-table-alignment-center',
              right: 'editor-table-alignment-right',
            },
            text: {
              bold: 'editor-text-bold',
              italic: 'editor-text-italic',
              underline: 'editor-text-underline',
            },
          },
        }),
      [onError, nodes, onWarn],
    );

    useEffect(() => {
      const rootElement = rootElementRef.current;

      editor.setRootElement(rootElement);
    }, [rootElementRef, editor]);

    return editor;
  }

  let editor: LexicalEditor;

  function init(
    onError?: (error: Error) => void,
    nodes?: readonly (Klass<LexicalNode> | LexicalNodeReplacement)[],
    onWarn?: (error: Error) => void,
  ) {
    const ref = createRef<HTMLDivElement>();

    function TestBase() {
      editor = useLexicalEditor(ref, onError, nodes, onWarn);

      return <div ref={ref} contentEditable={true} />;
    }

    act(() => {
      reactRoot.render(<TestBase />);
    });
  }

  async function update(fn: () => void) {
    editor.update(fn);

    return Promise.resolve().then();
  }

  describe('registerNodeTransform', () => {
    it('Calls the RootNode transform last on every update', async () => {
      init(function onError(err) {
        throw err;
      });
      const events: string[] = [];
      const $transform = (node: LexicalNode) =>
        events.push(`transform ${node.getType()} ${node.getKey()}`);
      editor.registerNodeTransform(RootNode, $transform);
      editor.registerNodeTransform(ParagraphNode, $transform);
      editor.registerNodeTransform(TextNode, $transform);
      editor.registerNodeTransform(ParagraphNode, node => {
        const lastChild = node.getLastChild();
        if (
          $isTextNode(lastChild) &&
          lastChild.getTextContent() === '[third]'
        ) {
          node.append($createTextNode('fourth').setMode('token'));
        }
      });
      // clear any transforms that occurred with the initial state on register
      await Promise.resolve();
      events.length = 0;
      let paragraphNode: ParagraphNode;
      editor.update(
        () => {
          paragraphNode = $createParagraphNode();
          $getRoot()
            .clear()
            .append(
              paragraphNode.append(
                $createTextNode('first').setMode('token'),
                $createTextNode('second').setMode('token'),
              ),
            );
        },
        {discrete: true},
      );
      let textNodes = editor.read(() => $getRoot().getAllTextNodes());
      expect(events).toEqual([
        `transform text ${textNodes[0].getKey()}`,
        `transform text ${textNodes[1].getKey()}`,
        `transform paragraph ${paragraphNode!.getKey()}`,
        'transform root root',
      ]);
      events.length = 0;
      // Add a transform that mutates the text
      await editor.registerNodeTransform(TextNode, node => {
        const textContent = node.getTextContent();
        if (textContent.startsWith('[')) {
          return;
        }
        node.setTextContent(`[${textContent}]`);
      });
      textNodes = editor.read(() => $getRoot().getAllTextNodes());
      expect(events).toEqual([
        // leaf transform runs once with mutations
        `transform text ${textNodes[0].getKey()}`,
        `transform text ${textNodes[1].getKey()}`,
        // leaf transforms run again with no mutations
        `transform text ${textNodes[0].getKey()}`,
        `transform text ${textNodes[1].getKey()}`,
        // element transforms run, but the paragraph is not intentionally dirty
        'transform root root',
      ]);
      expect(
        editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(node => node.getTextContent()),
        ),
      ).toEqual(['[first]', '[second]']);
      events.length = 0;
      await editor.update(() => {
        $getRoot()
          .getAllTextNodes()
          .forEach(node =>
            node.setTextContent(`:${node.getTextContent().slice(1, -1)}:`),
          );
        paragraphNode.append($createTextNode('third').setMode('token'));
      });
      textNodes = editor.read(() => $getRoot().getAllTextNodes());
      expect(events).toEqual([
        // leaf transform runs once with mutations
        `transform text ${textNodes[0].getKey()}`,
        `transform text ${textNodes[1].getKey()}`,
        `transform text ${textNodes[2].getKey()}`,
        // leaf transforms run again with no mutations
        `transform text ${textNodes[0].getKey()}`,
        `transform text ${textNodes[1].getKey()}`,
        `transform text ${textNodes[2].getKey()}`,
        // element transforms run, now the paragraph
        // is dirty because its last child changed
        `transform paragraph ${paragraphNode!.getKey()}`,
        'transform root root',
        // leaf transforms run again because the ParagraphNode transform created one,
        // which creates another one, and one of the nodes is dirty because it is a sibling
        `transform text ${textNodes[3].getKey()}`,
        `transform text ${textNodes[2].getKey()}`,
        `transform text ${textNodes[3].getKey()}`,
        // The paragraph is still intentionally dirty due to the append
        `transform paragraph ${paragraphNode!.getKey()}`,
        'transform root root',
      ]);
      expect(
        editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(node => node.getTextContent()),
        ),
      ).toEqual(['[:first:]', '[:second:]', '[third]', '[fourth]']);
    });
  });
  describe('read()', () => {
    it('Can read the editor state', async () => {
      init(function onError(err) {
        throw err;
      });
      expect(editor.read(() => $getRoot().getTextContent())).toEqual('');
      expect(editor.read(() => $getEditor())).toBe(editor);
      const onUpdate = vi.fn();
      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          const text = $createTextNode('This works!');
          root.append(paragraph);
          paragraph.append(text);
        },
        {onUpdate},
      );
      expect(onUpdate).toHaveBeenCalledTimes(0);
      // This read will flush pending updates
      expect(editor.read(() => $getRoot().getTextContent())).toEqual(
        'This works!',
      );
      expect(onUpdate).toHaveBeenCalledTimes(1);
      // Check to make sure there is not an unexpected reconciliation
      await Promise.resolve().then();
      expect(onUpdate).toHaveBeenCalledTimes(1);
      editor.read(() => {
        const rootElement = editor.getRootElement();
        expect(rootElement).toBeDefined();
        // The root element now carries __lexicalKey_* = 'root' so
        // $getNearestNodeFromDOMNode resolves it to the RootNode.
        assert($isRootNode($getNearestNodeFromDOMNode(rootElement!)));
        const paragraphDom = rootElement!.querySelector('p');
        expect(paragraphDom).toBeDefined();
        expect(
          $isParagraphNode($getNearestNodeFromDOMNode(paragraphDom!)),
        ).toBe(true);
        expect(
          $getNearestNodeFromDOMNode(paragraphDom!)!.getTextContent(),
        ).toBe('This works!');
        const textDom = paragraphDom!.querySelector('span');
        expect(textDom).toBeDefined();
        expect($isTextNode($getNearestNodeFromDOMNode(textDom!))).toBe(true);
        expect($getNearestNodeFromDOMNode(textDom!)!.getTextContent()).toBe(
          'This works!',
        );
        expect(
          $getNearestNodeFromDOMNode(textDom!.firstChild!)!.getTextContent(),
        ).toBe('This works!');
      });
      expect(onUpdate).toHaveBeenCalledTimes(1);
    });
    it('runs transforms the editor state', async () => {
      init(function onError(err) {
        throw err;
      });
      expect(editor.read(() => $getRoot().getTextContent())).toEqual('');
      expect(editor.read(() => $getEditor())).toBe(editor);
      editor.registerNodeTransform(TextNode, node => {
        if (node.getTextContent() === 'This works!') {
          node.replace($createTextNode('Transforms work!'));
        }
      });
      const onUpdate = vi.fn();
      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          const text = $createTextNode('This works!');
          root.append(paragraph);
          paragraph.append(text);
        },
        {onUpdate},
      );
      expect(onUpdate).toHaveBeenCalledTimes(0);
      // This read will flush pending updates
      expect(editor.read(() => $getRoot().getTextContent())).toEqual(
        'Transforms work!',
      );
      expect(editor.getRootElement()!.textContent).toEqual('Transforms work!');
      expect(onUpdate).toHaveBeenCalledTimes(1);
      // Check to make sure there is not an unexpected reconciliation
      await Promise.resolve().then();
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(editor.read(() => $getRoot().getTextContent())).toEqual(
        'Transforms work!',
      );
    });
    it('can be nested in an update or read', async () => {
      init(function onError(err) {
        throw err;
      });
      editor.update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('This works!');
        root.append(paragraph);
        paragraph.append(text);
        editor.read(() => {
          expect($getRoot().getTextContent()).toBe('This works!');
        });
        editor.read(() => {
          // Nesting update in read works, although it is discouraged in the documentation.
          editor.update(() => {
            expect($getRoot().getTextContent()).toBe('This works!');
          });
        });
        // Updating after a nested read will fail as it has already been committed
        expect(() => {
          root.append(
            $createParagraphNode().append(
              $createTextNode('update-read-update'),
            ),
          );
        }).toThrow();
      });
      editor.read(() => {
        editor.read(() => {
          expect($getRoot().getTextContent()).toBe('This works!');
        });
      });
    });
  });

  it('Should create an editor with an initial editor state', async () => {
    const rootElement = document.createElement('div');

    container.appendChild(rootElement);

    const initialEditor = createTestEditor({
      onError: vi.fn(),
    });

    initialEditor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const text = $createTextNode('This works!');
      root.append(paragraph);
      paragraph.append(text);
    });

    initialEditor.setRootElement(rootElement);

    // Wait for update to complete
    await Promise.resolve().then();

    expect(container.innerHTML).toBe(
      '<div style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">This works!</span></p></div>',
    );

    const initialEditorState = initialEditor.getEditorState();
    initialEditor.setRootElement(null);

    expect(container.innerHTML).toBe(
      '<div style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"></div>',
    );

    editor = createTestEditor({
      editorState: initialEditorState,
      onError: vi.fn(),
    });
    editor.setRootElement(rootElement);

    expect(editor.getEditorState()).toEqual(initialEditorState);
    expect(container.innerHTML).toBe(
      '<div style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">This works!</span></p></div>',
    );
  });

  it('Should handle nested updates in the correct sequence', async () => {
    init();
    const onUpdate = vi.fn();

    let log: string[] = [];

    editor.registerUpdateListener(onUpdate);
    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const text = $createTextNode('This works!');
      root.append(paragraph);
      paragraph.append(text);
    });

    editor.update(
      () => {
        log.push('A1');
        // To enforce the update
        $getRoot().markDirty();
        editor.update(
          () => {
            log.push('B1');
            editor.update(
              () => {
                log.push('C1');
              },
              {
                onUpdate: () => {
                  log.push('F1');
                },
              },
            );
          },
          {
            onUpdate: () => {
              log.push('E1');
            },
          },
        );
      },
      {
        onUpdate: () => {
          log.push('D1');
        },
      },
    );

    // Wait for update to complete
    await Promise.resolve().then();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['A1', 'B1', 'C1', 'D1', 'E1', 'F1']);

    log = [];
    editor.update(
      () => {
        log.push('A2');
        // To enforce the update
        $getRoot().markDirty();
      },
      {
        onUpdate: () => {
          log.push('B2');
          editor.update(
            () => {
              // force flush sync
              $setCompositionKey('root');
              log.push('D2');
            },
            {
              onUpdate: () => {
                log.push('F2');
              },
            },
          );
          log.push('C2');
          editor.update(
            () => {
              log.push('E2');
            },
            {
              onUpdate: () => {
                log.push('G2');
              },
            },
          );
        },
      },
    );

    // Wait for update to complete
    await Promise.resolve().then();

    expect(log).toEqual(['A2', 'B2', 'C2', 'D2', 'E2', 'F2', 'G2']);

    log = [];
    editor.registerNodeTransform(TextNode, () => {
      log.push('TextTransform A3');
      editor.update(
        () => {
          log.push('TextTransform B3');
        },
        {
          onUpdate: () => {
            log.push('TextTransform C3');
          },
        },
      );
    });

    // Wait for update to complete
    await Promise.resolve().then();

    expect(log).toEqual([
      'TextTransform A3',
      'TextTransform B3',
      'TextTransform C3',
    ]);

    log = [];
    editor.update(
      () => {
        log.push('A3');
        $getRoot().getLastDescendant()!.markDirty();
      },
      {
        onUpdate: () => {
          log.push('B3');
        },
      },
    );

    // Wait for update to complete
    await Promise.resolve().then();

    expect(log).toEqual([
      'A3',
      'TextTransform A3',
      'TextTransform B3',
      'B3',
      'TextTransform C3',
    ]);
  });

  it('nested update after selection update triggers exactly 1 update', async () => {
    init();
    const onUpdate = vi.fn();
    editor.registerUpdateListener(onUpdate);
    const prevEditorState = editor.getEditorState();
    editor.update(() => {
      $setSelection($createRangeSelection());
      editor.update(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Sync update')),
        );
      });
    });

    await Promise.resolve().then();

    const textContent = editor.read('latest', () =>
      $getRoot().getTextContent(),
    );
    expect(textContent).toBe('Sync update');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    // Calculate an expected update listener paylaod
    expect(onUpdate.mock.calls).toEqual([
      [computeUpdateListenerPayload(editor, prevEditorState, false)],
    ]);
  });

  it('update does not call onUpdate callback when no dirty nodes', () => {
    init();

    const fn = vi.fn();
    editor.update(
      () => {
        //
      },
      {
        onUpdate: fn,
      },
    );
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it('editor.focus() callback is called', async () => {
    init();

    await editor.update(() => {
      const root = $getRoot();
      root.append($createParagraphNode());
    });

    const fn = vi.fn();

    await editor.focus(fn);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('Synchronously runs three transforms, two of them depend on the other', async () => {
    init();

    // 2. Add italics
    const italicsListener = editor.registerNodeTransform(TextNode, node => {
      if (
        node.getTextContent() === 'foo' &&
        node.hasFormat('bold') &&
        !node.hasFormat('italic')
      ) {
        node.toggleFormat('italic');
      }
    });

    // 1. Add bold
    const boldListener = editor.registerNodeTransform(TextNode, node => {
      if (node.getTextContent() === 'foo' && !node.hasFormat('bold')) {
        node.toggleFormat('bold');
      }
    });

    // 2. Add underline
    const underlineListener = editor.registerNodeTransform(TextNode, node => {
      if (
        node.getTextContent() === 'foo' &&
        node.hasFormat('bold') &&
        !node.hasFormat('underline')
      ) {
        node.toggleFormat('underline');
      }
    });

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      paragraph.append($createTextNode('foo'));
    });
    italicsListener();
    boldListener();
    underlineListener();

    expect(container.innerHTML).toBe(
      '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><strong class="editor-text-bold editor-text-italic editor-text-underline" data-lexical-text="true">foo</strong></p></div>',
    );
  });

  it('Synchronously runs three transforms, two of them depend on the other (2)', async () => {
    await init();

    // Add transform makes everything dirty the first time (let's not leverage this here)
    const skipFirst = [true, true, true];

    // 2. (Block transform) Add text
    const testParagraphListener = editor.registerNodeTransform(
      ParagraphNode,
      paragraph => {
        if (skipFirst[0]) {
          skipFirst[0] = false;

          return;
        }

        if (paragraph.isEmpty()) {
          paragraph.append($createTextNode('foo'));
        }
      },
    );

    // 2. (Text transform) Add bold to text
    const boldListener = editor.registerNodeTransform(TextNode, node => {
      if (node.getTextContent() === 'foo' && !node.hasFormat('bold')) {
        node.toggleFormat('bold');
      }
    });

    // 3. (Block transform) Add italics to bold text
    const italicsListener = editor.registerNodeTransform(
      ParagraphNode,
      paragraph => {
        const child = paragraph.getLastDescendant();

        if (
          $isTextNode(child) &&
          child.hasFormat('bold') &&
          !child.hasFormat('italic')
        ) {
          child.toggleFormat('italic');
        }
      },
    );

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
    });

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = root.getFirstChild();
      paragraph!.markDirty();
    });

    testParagraphListener();
    boldListener();
    italicsListener();

    expect(container.innerHTML).toBe(
      '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><strong class="editor-text-bold editor-text-italic" data-lexical-text="true">foo</strong></p></div>',
    );
  });

  it('Synchronously runs three transforms, two of them depend on previously merged text content', async () => {
    const hasRun = [false, false, false];
    init();

    // 1. [Foo] into [<empty>,Fo,o,<empty>,!,<empty>]
    const fooListener = editor.registerNodeTransform(TextNode, node => {
      if (node.getTextContent() === 'Foo' && !hasRun[0]) {
        const [before, after] = node.splitText(2);

        before.insertBefore($createTextNode(''));
        after.insertAfter($createTextNode(''));
        after.insertAfter($createTextNode('!'));
        after.insertAfter($createTextNode(''));

        hasRun[0] = true;
      }
    });

    // 2. [Foo!] into [<empty>,Fo,o!,<empty>,!,<empty>]
    const megaFooListener = editor.registerNodeTransform(
      ParagraphNode,
      paragraph => {
        const child = paragraph.getFirstChild();

        if (
          $isTextNode(child) &&
          child.getTextContent() === 'Foo!' &&
          !hasRun[1]
        ) {
          const [before, after] = child.splitText(2);

          before.insertBefore($createTextNode(''));
          after.insertAfter($createTextNode(''));
          after.insertAfter($createTextNode('!'));
          after.insertAfter($createTextNode(''));

          hasRun[1] = true;
        }
      },
    );

    // 3. [Foo!!] into formatted bold [<empty>,Fo,o!!,<empty>]
    const boldFooListener = editor.registerNodeTransform(TextNode, node => {
      if (node.getTextContent() === 'Foo!!' && !hasRun[2]) {
        node.toggleFormat('bold');

        const [before, after] = node.splitText(2);
        before.insertBefore($createTextNode(''));
        after.insertAfter($createTextNode(''));

        hasRun[2] = true;
      }
    });

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();

      root.append(paragraph);
      paragraph.append($createTextNode('Foo'));
    });

    fooListener();
    megaFooListener();
    boldFooListener();

    expect(container.innerHTML).toBe(
      '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><strong class="editor-text-bold" data-lexical-text="true">Foo!!</strong></p></div>',
    );
  });

  it('text transform runs when node is removed', async () => {
    init();

    const executeTransform = vi.fn();
    let hasBeenRemoved = false;
    const removeListener = editor.registerNodeTransform(TextNode, node => {
      if (hasBeenRemoved) {
        executeTransform();
      }
    });

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      paragraph.append(
        $createTextNode('Foo').toggleUnmergeable(),
        $createTextNode('Bar').toggleUnmergeable(),
      );
    });

    await editor.update(() => {
      $getRoot().getLastDescendant()!.remove();
      hasBeenRemoved = true;
    });

    expect(executeTransform).toHaveBeenCalledTimes(1);

    removeListener();
  });

  it('transforms only run on nodes that were explicitly marked as dirty', async () => {
    init();

    let executeParagraphNodeTransform = () => {
      return;
    };

    let executeTextNodeTransform = () => {
      return;
    };

    const removeParagraphTransform = editor.registerNodeTransform(
      ParagraphNode,
      node => {
        executeParagraphNodeTransform();
      },
    );
    const removeTextNodeTransform = editor.registerNodeTransform(
      TextNode,
      node => {
        executeTextNodeTransform();
      },
    );

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      paragraph.append($createTextNode('Foo'));
    });

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $assertNodeType(root.getFirstChild(), $isParagraphNode);
      const textNode = $assertNodeType(paragraph.getFirstChild(), $isTextNode);

      textNode.getWritable();

      executeParagraphNodeTransform = vi.fn();
      executeTextNodeTransform = vi.fn();
    });

    expect(executeParagraphNodeTransform).toHaveBeenCalledTimes(0);
    expect(executeTextNodeTransform).toHaveBeenCalledTimes(1);

    removeParagraphTransform();
    removeTextNodeTransform();
  });

  it('transforms do not discard unintentional dirtyElements', () => {
    // See https://github.com/facebook/lexical/issues/7333
    // We are assuming that ListNode automatically registers a transform
    // to merge adjacent lists
    init(undefined, [ListItemNode, ListNode]);
    function $createNestedListNode(text: string) {
      return $createListNode('bullet').append(
        $createListItemNode().append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode(text)),
          ),
        ),
      );
    }
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createNestedListNode('1'),
            $createParagraphNode(),
            $createNestedListNode('2'),
          );
      },
      {discrete: true},
    );
    expectHtmlToBeEqual(
      container.innerHTML,
      html`
        <div
          contenteditable="true"
          style="user-select: text; white-space: pre-wrap; word-break: break-word;"
          data-lexical-editor="true">
          <ul dir="auto">
            <li value="1">
              <ul>
                <li value="1"><span data-lexical-text="true">1</span></li>
              </ul>
            </li>
          </ul>
          <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
          <ul dir="auto">
            <li value="1">
              <ul>
                <li value="1"><span data-lexical-text="true">2</span></li>
              </ul>
            </li>
          </ul>
        </div>
      `,
    );
    editor.update(
      () => {
        $getRoot()
          .getChildren()
          .filter($isParagraphNode)
          .forEach(node => node.remove());
      },
      {discrete: true},
    );
    expectHtmlToBeEqual(
      container.innerHTML,
      html`
        <div
          contenteditable="true"
          style="user-select: text; white-space: pre-wrap; word-break: break-word;"
          data-lexical-editor="true">
          <ul dir="auto">
            <li value="1">
              <ul>
                <li value="1"><span data-lexical-text="true">1</span></li>
                <li value="2"><span data-lexical-text="true">2</span></li>
              </ul>
            </li>
          </ul>
        </div>
      `,
    );
  });

  describe('transforms on siblings', () => {
    let textNodeKeys: string[];
    let textTransformCount: number[];
    let removeTransform: () => void;

    beforeEach(async () => {
      init();

      textNodeKeys = [];
      textTransformCount = [];

      await editor.update(() => {
        const root = $getRoot();
        const paragraph0 = $createParagraphNode();
        const paragraph1 = $createParagraphNode();
        const textNodes: LexicalNode[] = [];

        for (let i = 0; i < 6; i++) {
          const node = $createTextNode(String(i)).toggleUnmergeable();
          textNodes.push(node);
          textNodeKeys.push(node.getKey());
          textTransformCount[i] = 0;
        }

        root.append(paragraph0, paragraph1);
        paragraph0.append(...textNodes.slice(0, 3));
        paragraph1.append(...textNodes.slice(3));
      });

      removeTransform = editor.registerNodeTransform(TextNode, node => {
        textTransformCount[Number(node.__text)]++;
      });
    });

    afterEach(() => {
      removeTransform();
    });

    it('on remove', async () => {
      await editor.update(() => {
        const textNode1 = $getNodeByKey(textNodeKeys[1])!;
        textNode1.remove();
      });
      expect(textTransformCount).toEqual([2, 1, 2, 1, 1, 1]);
    });

    it('on replace', async () => {
      await editor.update(() => {
        const textNode1 = $getNodeByKey(textNodeKeys[1])!;
        const textNode4 = $getNodeByKey(textNodeKeys[4])!;
        textNode4.replace(textNode1);
      });
      expect(textTransformCount).toEqual([2, 2, 2, 2, 1, 2]);
    });

    it('on insertBefore', async () => {
      await editor.update(() => {
        const textNode1 = $getNodeByKey(textNodeKeys[1])!;
        const textNode4 = $getNodeByKey(textNodeKeys[4])!;
        textNode4.insertBefore(textNode1);
      });
      expect(textTransformCount).toEqual([2, 2, 2, 2, 2, 1]);
    });

    it('on insertAfter', async () => {
      await editor.update(() => {
        const textNode1 = $getNodeByKey(textNodeKeys[1])!;
        const textNode4 = $getNodeByKey(textNodeKeys[4])!;
        textNode4.insertAfter(textNode1);
      });
      expect(textTransformCount).toEqual([2, 2, 2, 1, 2, 2]);
    });

    it('on splitText', async () => {
      await editor.update(() => {
        const textNode1 = $assertNodeType(
          $getNodeByKey(textNodeKeys[1]),
          $isTextNode,
        );
        textNode1.setTextContent('67');
        textNode1.splitText(1);
        textTransformCount.push(0, 0);
      });
      expect(textTransformCount).toEqual([2, 1, 2, 1, 1, 1, 1, 1]);
    });

    it('on append', async () => {
      await editor.update(() => {
        const paragraph1 = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        paragraph1.append($createTextNode('6').toggleUnmergeable());
        textTransformCount.push(0);
      });
      expect(textTransformCount).toEqual([1, 1, 2, 1, 1, 1, 1]);
    });
  });

  it('Detects infinite recursivity on transforms', async () => {
    const errorListener = vi.fn();
    init(errorListener);

    const boldListener = editor.registerNodeTransform(TextNode, node => {
      node.toggleFormat('bold');
    });

    expect(errorListener).toHaveBeenCalledTimes(0);

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      paragraph.append($createTextNode('foo'));
    });

    expect(errorListener).toHaveBeenCalledTimes(1);
    boldListener();
  });

  // The recursion guard in $triggerEnqueuedUpdates breaks the cascade (clears
  // the update queue) and then routes the recovered condition through the
  // editor's warn-level hook, editor._onWarn, rather than reporting a recovered
  // condition as an uncaught error via editor._onError. The default _onWarn
  // throws in development (so the recursion is impossible to miss) and only
  // console.warns in production; embedders can supply their own onWarn to
  // capture guard trips as warn-severity telemetry without an error alarm.
  function runCascade(onWarn?: (error: Error) => void): {
    errorListener: ReturnType<typeof vi.fn>;
    unregister: () => void;
  } {
    const errorListener = vi.fn();
    init(errorListener, undefined, onWarn);

    const unregister = editor.registerUpdateListener(() => {
      editor.update(() => {
        $getRoot().markDirty();
      });
    });

    expect(errorListener).toHaveBeenCalledTimes(0);
    return {errorListener, unregister};
  }

  it('Detects infinite recursivity on update listeners (dev: default onWarn throws)', async () => {
    // Development behavior: with the default onWarn, the guard throws once the
    // cascade limit is exceeded. The cascade is broken (update queue cleared)
    // before the guard signals, so the throw surfaces from the scheduled
    // microtask rather than synchronously from editor.update(), and is NOT
    // routed through editor._onError.
    const {errorListener, unregister} = runCascade();

    const caught: Error[] = [];
    const onUnhandled = (reason: unknown) => {
      caught.push(reason instanceof Error ? reason : new Error(String(reason)));
    };
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUnhandled);

    try {
      editor.update(() => {
        $getRoot().markDirty();
      });

      // drain the microtask chain produced by the cascade
      for (let i = 0; i < 200 && caught.length === 0; i++) {
        await Promise.resolve();
      }
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.off('uncaughtException', onUnhandled);
    }

    expect(caught).toHaveLength(1);
    expect(caught[0].message).toMatch(/endlessly enqueueing/);
    // The error message should include the editor's namespace so the loop can
    // be attributed to a specific product/editor in error aggregation, even
    // when the production stack is minified to core frames.
    expect(caught[0].message).toContain(
      `Editor namespace: ${editor._config.namespace}`,
    );

    unregister();

    // editor should be usable again after the cascade is cut
    editor.update(
      () => {
        $getRoot().markDirty();
      },
      {discrete: true},
    );
    // drain any lingering microtask chain to confirm no further cascade
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    // The guard never routes through editor._onError — recovered conditions go
    // through editor._onWarn instead.
    expect(errorListener).toHaveBeenCalledTimes(0);
  });

  it('routes the recursion guard through a custom onWarn for embedder telemetry', async () => {
    // Embedder behavior: a custom onWarn fully replaces the default and does
    // not throw, so the recovered condition is captured for telemetry without
    // surfacing as an uncaught error (neither via editor._onError nor as an
    // unhandled rejection/exception). The cascade must still be broken and the
    // editor must remain usable.
    const warnListener = vi.fn();
    const {errorListener, unregister} = runCascade(warnListener);

    const caught: Error[] = [];
    const onUnhandled = (reason: unknown) => {
      caught.push(reason instanceof Error ? reason : new Error(String(reason)));
    };
    process.on('unhandledRejection', onUnhandled);
    process.on('uncaughtException', onUnhandled);

    try {
      editor.update(() => {
        $getRoot().markDirty();
      });

      // drain the microtask chain produced by the cascade; the custom onWarn
      // does not throw, so just give the queue a chance to settle.
      for (let i = 0; i < 200; i++) {
        await Promise.resolve();
      }
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.off('uncaughtException', onUnhandled);
    }

    // onWarn received the namespace-tagged Error exactly once, so the guard
    // trip is observable as warn-level telemetry...
    expect(warnListener).toHaveBeenCalledTimes(1);
    const warnArg = warnListener.mock.calls[0][0];
    expect(warnArg).toBeInstanceOf(Error);
    expect(warnArg.message).toMatch(/endlessly enqueueing/);
    expect(warnArg.message).toContain(
      `Editor namespace: ${editor._config.namespace}`,
    );
    // ...and nothing surfaced as an uncaught error or via editor._onError.
    expect(caught).toHaveLength(0);
    expect(errorListener).toHaveBeenCalledTimes(0);

    unregister();

    // editor should still be usable after the cascade is cut
    editor.update(
      () => {
        $getRoot().markDirty();
      },
      {discrete: true},
    );
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(errorListener).toHaveBeenCalledTimes(0);
  });

  it('does not trip the recursion guard on bounded re-enqueueing across separate actions', async () => {
    // Regression test for over-firing (#8635): a listener that re-enqueues a
    // bounded amount of work per commit must not accumulate cascade budget
    // across many independent user actions. The enqueued no-op never produces
    // a commit, so the queue is never observed empty by
    // $triggerEnqueuedUpdates and, before the fix, _cascadeCount leaked +1 per
    // action and falsely tripped after ~100 ordinary keystrokes.
    const errorListener = vi.fn();
    const warnListener = vi.fn();
    init(errorListener, undefined, warnListener);

    const unregister = editor.registerUpdateListener(() => {
      editor.update(() => {
        // bounded: a single no-op update per commit
      });
    });

    for (let i = 0; i < 150; i++) {
      editor.update(() => {
        $getRoot().markDirty();
      });
      // Each action yields to the event loop, like real typing, which lets
      // the macrotask budget reset run between actions.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    unregister();

    expect(warnListener).toHaveBeenCalledTimes(0);
    expect(errorListener).toHaveBeenCalledTimes(0);
  });

  it('does not trip the recursion guard on a fast input burst driven by commands', async () => {
    // Rapid input (key repeat, synthetic events) can deliver many commands
    // without the event loop running the macrotask budget reset in between.
    // Each dispatched command is a fresh external action, so it resets the
    // cascade budget directly (see triggerCommandListeners).
    const errorListener = vi.fn();
    const warnListener = vi.fn();
    init(errorListener, undefined, warnListener);

    const BURST_COMMAND = createCommand<void>('BURST_COMMAND');
    const unregisterCommand = editor.registerCommand(
      BURST_COMMAND,
      () => {
        editor.update(() => {
          $getRoot().markDirty();
        });
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
    const unregisterUpdate = editor.registerUpdateListener(() => {
      editor.update(() => {
        // bounded: a single no-op update per commit
      });
    });

    for (let i = 0; i < 150; i++) {
      editor.dispatchCommand(BURST_COMMAND);
      // Yield only microtasks: commits flush, but the macrotask budget reset
      // never gets a chance to run within the burst.
      for (let j = 0; j < 4; j++) {
        await Promise.resolve();
      }
    }
    unregisterUpdate();
    unregisterCommand();

    expect(warnListener).toHaveBeenCalledTimes(0);
    expect(errorListener).toHaveBeenCalledTimes(0);
  });

  it('still detects a runaway cascade that dispatches commands from a mutation listener', async () => {
    // Mutation listeners run during $commitPendingUpdates with
    // editor._updating === false. A runaway loop whose every cycle also
    // dispatches a command from one must not reset its own cascade budget and
    // escape detection: commands dispatched mid-commit are update machinery,
    // not fresh external actions (see isCommittingPendingUpdates).
    const errorListener = vi.fn();
    const warnListener = vi.fn();
    init(errorListener, undefined, warnListener);

    const NOOP_COMMAND = createCommand<void>('NOOP_COMMAND');
    let textKey = '';
    editor.update(
      () => {
        const text = $createTextNode('a');
        $getRoot().clear().append($createParagraphNode().append(text));
        textKey = text.getKey();
      },
      {discrete: true},
    );
    await new Promise(resolve => setTimeout(resolve, 0));

    const unregisterMutation = editor.registerMutationListener(TextNode, () => {
      editor.dispatchCommand(NOOP_COMMAND);
    });
    // Unbounded: flips the text content again on every commit, forever.
    const unregisterUpdate = editor.registerUpdateListener(() => {
      editor.update(() => {
        const text = $getNodeByKey<TextNode>(textKey);
        if (text !== null) {
          text.setTextContent(text.getTextContent() === 'a' ? 'b' : 'a');
        }
      });
    });

    editor.update(() => {
      const text = $getNodeByKey<TextNode>(textKey);
      if (text !== null) {
        text.setTextContent('b');
      }
    });
    // Drain only microtasks: the runaway never yields to the event loop, so
    // the macrotask budget reset cannot save it either.
    for (let i = 0; i < 800 && warnListener.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    unregisterUpdate();
    unregisterMutation();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(warnListener).toHaveBeenCalledTimes(1);
    expect(warnListener.mock.calls[0][0].message).toMatch(
      /endlessly enqueueing/,
    );
    expect(errorListener).toHaveBeenCalledTimes(0);

    // editor should still be usable after the cascade is cut
    editor.update(
      () => {
        $getRoot().markDirty();
      },
      {discrete: true},
    );
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(errorListener).toHaveBeenCalledTimes(0);
  });

  it('applies (and warns in DEV) when a command dispatched from a read-only context mutates the editor', async () => {
    init();

    const READONLY_MUTATE_COMMAND = createCommand<void>(
      'READONLY_MUTATE_COMMAND',
    );
    // A listener that mutates the editor state, mirroring the real-world case
    // (e.g. CLEAR_EDITOR_COMMAND building a fresh paragraph).
    const unregister = editor.registerCommand(
      READONLY_MUTATE_COMMAND,
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('mutated')));
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // Dispatching from inside editor.read() (a read-only context) is the
      // application anti-pattern. Previously the mutating listener ran inline
      // against the frozen node map and threw (caught by _onError, silently
      // dropping the mutation). It should now be deferred to a writable update
      // so the mutation actually applies, and warn in DEV.
      editor.read(() => {
        editor.dispatchCommand(READONLY_MUTATE_COMMAND);
      });
      // Deferred update flushes on the next tick.
      await Promise.resolve();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/read-only context/);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('mutated');
      });

      // A top-level (writable) dispatch must NOT warn and applies inline.
      warnSpy.mockClear();
      editor.dispatchCommand(READONLY_MUTATE_COMMAND);
      expect(warnSpy).toHaveBeenCalledTimes(0);
    } finally {
      warnSpy.mockRestore();
      unregister();
    }
  });

  it('Should be able to update an editor state without a root element', () => {
    const ref = createRef<HTMLDivElement>();

    function TestBase({element}: {element: HTMLElement | null}) {
      editor = useMemo(() => createTestEditor(), []);

      useEffect(() => {
        editor.setRootElement(element);
      }, [element]);

      return <div ref={ref} contentEditable={true} />;
    }

    act(() => {
      reactRoot.render(<TestBase element={null} />);
    });
    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const text = $createTextNode('This works!');
      root.append(paragraph);
      paragraph.append(text);
    });

    expect(container.innerHTML).toBe('<div contenteditable="true"></div>');

    act(() => {
      reactRoot.render(<TestBase element={ref.current} />);
    });

    expect(container.innerHTML).toBe(
      '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">This works!</span></p></div>',
    );
  });

  it('Should be able to recover from an update error', async () => {
    const errorListener = vi.fn();
    init(errorListener);
    editor.update(() => {
      const root = $getRoot();

      if (root.getFirstChild() === null) {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('This works!');
        root.append(paragraph);
        paragraph.append(text);
      }
    });

    // Wait for update to complete
    await Promise.resolve().then();

    expect(container.innerHTML).toBe(
      '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">This works!</span></p></div>',
    );
    expect(errorListener).toHaveBeenCalledTimes(0);

    editor.update(() => {
      const root = $getRoot();
      $assertNodeType(
        $assertNodeType(
          $assertNodeType(root.getFirstChild(), $isElementNode).getFirstChild(),
          $isElementNode,
        ).getFirstChild(),
        $isTextNode,
      ).setTextContent('Foo');
    });

    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toBe(
      '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">This works!</span></p></div>',
    );
  });

  it('Should be able to handle a change in root element', async () => {
    const rootListener = vi.fn();
    const updateListener = vi.fn();

    function TestBase({changeElement}: {changeElement: boolean}) {
      editor = useMemo(() => createTestEditor(), []);

      useEffect(() => {
        editor.update(() => {
          const root = $getRoot();
          const firstChild = root.getFirstChild();
          const text = changeElement ? 'Change successful' : 'Not changed';

          if (firstChild === null) {
            const paragraph = $createParagraphNode();
            const textNode = $createTextNode(text);
            paragraph.append(textNode);
            root.append(paragraph);
          } else {
            const textNode = $assertNodeType(
              $assertNodeType(firstChild, $isParagraphNode).getFirstChild(),
              $isTextNode,
            );
            textNode.setTextContent(text);
          }
        });
      }, [changeElement]);

      useEffect(() => {
        return editor.registerRootListener(rootListener);
      }, []);

      useEffect(() => {
        return editor.registerUpdateListener(updateListener);
      }, []);

      const ref = useCallback((node: HTMLElement | null) => {
        editor.setRootElement(node);
      }, []);

      return changeElement ? (
        <span ref={ref} contentEditable={true} />
      ) : (
        <div ref={ref} contentEditable={true} />
      );
    }

    await act(() => {
      reactRoot.render(<TestBase changeElement={false} />);
    });

    expect(container.innerHTML).toBe(
      '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">Not changed</span></p></div>',
    );

    await act(() => {
      reactRoot.render(<TestBase changeElement={true} />);
    });

    expect(rootListener).toHaveBeenCalledTimes(3);
    expect(updateListener).toHaveBeenCalledTimes(4);
    expect(container.innerHTML).toBe(
      '<span contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">Change successful</span></p></span>',
    );
  });

  for (const editable of [true, false]) {
    it(`Retains pendingEditor while rootNode is not set (${
      editable ? 'editable' : 'non-editable'
    })`, async () => {
      const JSON_EDITOR_STATE =
        '{"root":{"children":[{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"123","type":"text","version":1}],"direction":null,"format":"","indent":0,"type":"paragraph","version":1,"textFormat":0,"textStyle":""}],"direction":null,"format":"","indent":0,"type":"root","version":1}}';
      init();
      const contentEditable = editor.getRootElement();
      editor.setEditable(editable);
      editor.update(() => {
        // Cause the editor to become dirty, so we can ensure
        // that the getEditorState()._readOnly invariant holds
        $getRoot().markDirty();
      });
      editor.setRootElement(null);
      expect(editor.getEditorState()._readOnly).toBe(true);
      const editorState = editor.parseEditorState(JSON_EDITOR_STATE);
      editor.setEditorState(editorState);
      editor.update(() => {
        //
      });
      editor.setRootElement(contentEditable);
      expect(JSON.stringify(editor.getEditorState().toJSON())).toBe(
        JSON_EDITOR_STATE,
      );
    });
  }

  it('setRootElement preserves queued updates and tags across reset (#7360)', () => {
    const rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    document.body.appendChild(rootElement);

    const newEditor = createTestEditor({onError: vi.fn()});

    let queuedRan = false;
    newEditor._updates.push([
      () => {
        queuedRan = true;
      },
      undefined,
    ]);
    newEditor._updateTags.add('custom_tag');

    let listenerTags: Set<string> | null = null;
    newEditor.registerUpdateListener(({tags}) => {
      if (tags.has('custom_tag')) {
        listenerTags = tags;
      }
    });

    newEditor.setRootElement(rootElement);

    // setRootElement calls $commitPendingUpdates which drains _updates via
    // $triggerEnqueuedUpdates. Before the fix, resetEditor wiped _updates
    // and _updateTags despite preserving _pendingEditorState, so the queued
    // callback never ran and the tag never reached update listeners.
    expect(queuedRan).toBe(true);
    expect(listenerTags).not.toBeNull();
    expect(listenerTags!.has('custom_tag')).toBe(true);

    document.body.removeChild(rootElement);
  });

  describe('With node decorators', () => {
    function useDecorators() {
      const [decorators, setDecorators] = useState(() =>
        editor.getDecorators<ReactNode>(),
      );

      // Subscribe to changes
      useEffect(() => {
        return editor.registerDecoratorListener<ReactNode>(nextDecorators => {
          setDecorators(nextDecorators);
        });
      }, []);

      const decoratedPortals = useMemo(
        () =>
          Object.keys(decorators).map(nodeKey => {
            const reactDecorator = decorators[nodeKey];
            const element = editor.getElementByKey(nodeKey)!;

            return createPortal(reactDecorator, element);
          }),
        [decorators],
      );

      return decoratedPortals;
    }

    afterEach(async () => {
      // Clean up so we are not calling setState outside of act
      await act(async () => {
        reactRoot.render(null);
        await Promise.resolve().then();
      });
    });

    it('Should correctly render React component into Lexical node #1', async () => {
      const listener = vi.fn();

      function Test() {
        editor = useMemo(() => createTestEditor(), []);

        useEffect(() => {
          editor.registerRootListener(listener);
        }, []);

        const ref = useCallback((node: HTMLDivElement | null) => {
          editor.setRootElement(node);
        }, []);

        const decorators = useDecorators();

        return (
          <>
            <div ref={ref} contentEditable={true} />
            {decorators}
          </>
        );
      }

      act(() => {
        reactRoot.render(<Test />);
      });
      // Update the editor with the decorator
      await act(async () => {
        await editor.update(() => {
          const paragraph = $createParagraphNode();
          const test = $createTestDecoratorNode();
          paragraph.append(test);
          $getRoot().append(paragraph);
        });
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(container.innerHTML).toBe(
        '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto">' +
          '<span data-lexical-decorator="true" contenteditable="false"><span>Hello world</span></span><br data-lexical-managed-linebreak="true"></p></div>',
      );
    });

    it('Should correctly render React component into Lexical node #2', async () => {
      const listener = vi.fn();

      function Test({divKey}: {divKey: number}): JSX.Element {
        function TestPlugin() {
          [editor] = useLexicalComposerContext();

          useEffect(() => {
            return editor.registerRootListener(listener);
          }, []);

          return null;
        }

        return (
          <TestComposer>
            <RichTextPlugin
              contentEditable={
                // @ts-ignore
                // eslint-disable-next-line jsx-a11y/aria-role
                <ContentEditable key={divKey} role={null} spellCheck={null} />
              }
              placeholder={null}
              ErrorBoundary={LexicalErrorBoundary}
            />
            <TestPlugin />
          </TestComposer>
        );
      }

      await act(async () => {
        reactRoot.render(<Test divKey={0} />);
        // Wait for update to complete
        await Promise.resolve().then();
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(container.innerHTML).toBe(
        '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><br data-lexical-managed-linebreak="true"></p></div>',
      );

      await act(async () => {
        reactRoot.render(<Test divKey={1} />);
        // Wait for update to complete
        await Promise.resolve().then();
      });

      expect(listener).toHaveBeenCalledTimes(5);
      expect(container.innerHTML).toBe(
        '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><br data-lexical-managed-linebreak="true"></p></div>',
      );

      // Wait for update to complete
      await Promise.resolve().then();

      editor.read('latest', () => {
        const root = $getRoot();
        const paragraph = root.getFirstChild()!;
        expect(root).toEqual({
          __cachedText: '',
          __dir: null,
          __first: paragraph.getKey(),
          __format: 0,
          __indent: 0,
          __key: 'root',
          __last: paragraph.getKey(),
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
          __first: null,
          __format: 0,
          __indent: 0,
          __key: paragraph.getKey(),
          __last: null,
          __next: null,
          __parent: 'root',
          __prev: null,
          __size: 0,
          __slotHost: null,
          __slots: null,
          __style: '',
          __textFormat: 0,
          __textStyle: '',
          __type: 'paragraph',
        });
      });
    });
  });

  describe('parseEditorState()', () => {
    let originalText: TextNode;
    let parsedParagraph: ParagraphNode;
    let parsedRoot: RootNode;
    let parsedText: TextNode;
    let paragraphKey: string;
    let textKey: string;
    let parsedEditorState: EditorState;

    it('exportJSON API - parses parsed JSON', async () => {
      await update(() => {
        const paragraph = $createParagraphNode();
        paragraph.setDirection('rtl');
        originalText = $createTextNode('Hello world');
        originalText.select(6, 11);
        paragraph.append(originalText);
        $getRoot().clear().append(paragraph);
      });
      const stringifiedEditorState = JSON.stringify(editor.getEditorState());
      const parsedEditorStateFromObject = editor.parseEditorState(
        JSON.parse(stringifiedEditorState),
      );
      parsedEditorStateFromObject.read(() => {
        const root = $getRoot();
        expect(
          $assertNodeType(
            root.getFirstChild(),
            $isParagraphNode,
          ).getDirection(),
        ).toBe('rtl');
        expect(root.getTextContent()).toMatch(/Hello world/);
      });
    });

    describe('range selection', () => {
      beforeEach(async () => {
        await init();

        await update(() => {
          const paragraph = $createParagraphNode();
          originalText = $createTextNode('Hello world');
          originalText.select(6, 11);
          paragraph.append(originalText);
          $getRoot().append(paragraph);
        });
        const stringifiedEditorState = JSON.stringify(
          editor.getEditorState().toJSON(),
        );
        parsedEditorState = editor.parseEditorState(stringifiedEditorState);
        parsedEditorState.read(() => {
          parsedRoot = $getRoot();
          parsedParagraph = $assertNodeType(
            parsedRoot.getFirstChild(),
            $isParagraphNode,
          );
          paragraphKey = parsedParagraph.getKey();
          parsedText = $assertNodeType(
            parsedParagraph.getFirstChild(),
            $isTextNode,
          );
          textKey = parsedText.getKey();
        });
      });

      it('Parses the nodes of a stringified editor state', async () => {
        expect(parsedRoot).toEqual({
          __cachedText: null,
          __dir: null,
          __first: paragraphKey,
          __format: 0,
          __indent: 0,
          __key: 'root',
          __last: paragraphKey,
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
        expect(parsedParagraph).toEqual({
          __dir: null,
          __first: textKey,
          __format: 0,
          __indent: 0,
          __key: paragraphKey,
          __last: textKey,
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
        expect(parsedText).toEqual({
          __detail: 0,
          __format: 0,
          __key: textKey,
          __mode: 0,
          __next: null,
          __parent: paragraphKey,
          __prev: null,
          __style: '',
          __text: 'Hello world',
          __type: 'text',
        });
      });

      it('Parses the text content of the editor state', async () => {
        expect(parsedEditorState.read(() => $getRoot().__cachedText)).toBe(
          null,
        );
        expect(parsedEditorState.read(() => $getRoot().getTextContent())).toBe(
          'Hello world',
        );
      });
    });

    describe('node selection', () => {
      beforeEach(async () => {
        init();

        await update(() => {
          const paragraph = $createParagraphNode();
          originalText = $createTextNode('Hello world');
          const selection = $createNodeSelection();
          selection.add(originalText.getKey());
          $setSelection(selection);
          paragraph.append(originalText);
          $getRoot().append(paragraph);
        });
        const stringifiedEditorState = JSON.stringify(
          editor.getEditorState().toJSON(),
        );
        parsedEditorState = editor.parseEditorState(stringifiedEditorState);
        parsedEditorState.read(() => {
          parsedRoot = $getRoot();
          parsedParagraph = $assertNodeType(
            parsedRoot.getFirstChild(),
            $isParagraphNode,
          );
          paragraphKey = parsedParagraph.getKey();
          parsedText = $assertNodeType(
            parsedParagraph.getFirstChild(),
            $isTextNode,
          );
          textKey = parsedText.getKey();
        });
      });

      it('Parses the nodes of a stringified editor state', async () => {
        expect(parsedRoot).toEqual({
          __cachedText: null,
          __dir: null,
          __first: paragraphKey,
          __format: 0,
          __indent: 0,
          __key: 'root',
          __last: paragraphKey,
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
        expect(parsedParagraph).toEqual({
          __dir: null,
          __first: textKey,
          __format: 0,
          __indent: 0,
          __key: paragraphKey,
          __last: textKey,
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
        expect(parsedText).toEqual({
          __detail: 0,
          __format: 0,
          __key: textKey,
          __mode: 0,
          __next: null,
          __parent: paragraphKey,
          __prev: null,
          __style: '',
          __text: 'Hello world',
          __type: 'text',
        });
      });

      it('Parses the text content of the editor state', async () => {
        expect(parsedEditorState.read(() => $getRoot().__cachedText)).toBe(
          null,
        );
        expect(parsedEditorState.read(() => $getRoot().getTextContent())).toBe(
          'Hello world',
        );
      });
    });
  });

  describe('$parseSerializedNode()', () => {
    it('parses serialized nodes', async () => {
      const expectedTextContent = 'Hello world\n\nHello world';
      let actualTextContent: string;
      let root: RootNode;
      await update(() => {
        root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('Hello world'));
        root.append(paragraph);
      });
      const stringifiedEditorState = JSON.stringify(editor.getEditorState());
      const parsedEditorStateJson = JSON.parse(stringifiedEditorState);
      const rootJson = parsedEditorStateJson.root;
      await update(() => {
        const children = rootJson.children.map($parseSerializedNode);
        root = $getRoot();
        root.append(...children);
        actualTextContent = root.getTextContent();
      });
      expect(actualTextContent!).toEqual(expectedTextContent);
    });
  });

  describe('Node children', () => {
    beforeEach(async () => {
      init();

      await reset();
    });

    async function reset() {
      init();

      await update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
      });
    }

    it('moves node to different tree branches', async () => {
      function $createElementNodeWithText(text: string) {
        const elementNode = $createTestElementNode();
        const textNode = $createTextNode(text);
        elementNode.append(textNode);

        return [elementNode, textNode];
      }

      let paragraphNodeKey: string;
      let elementNode1Key: string;
      let textNode1Key: string;
      let elementNode2Key: string;
      let textNode2Key: string;

      await update(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        paragraphNodeKey = paragraph.getKey();

        const [elementNode1, textNode1] = $createElementNodeWithText('A');
        elementNode1Key = elementNode1.getKey();
        textNode1Key = textNode1.getKey();

        const [elementNode2, textNode2] = $createElementNodeWithText('B');
        elementNode2Key = elementNode2.getKey();
        textNode2Key = textNode2.getKey();

        paragraph.append(elementNode1, elementNode2);
      });

      await update(() => {
        const elementNode1 = $assertNodeType(
          $getNodeByKey(elementNode1Key),
          $isElementNode,
        );
        const elementNode2 = $assertNodeType(
          $getNodeByKey(elementNode2Key),
          $isElementNode,
        );
        elementNode1.append(elementNode2);
      });
      const keys = [
        paragraphNodeKey!,
        elementNode1Key!,
        textNode1Key!,
        elementNode2Key!,
        textNode2Key!,
      ];

      for (let i = 0; i < keys.length; i++) {
        expect(editor._editorState._nodeMap.has(keys[i])).toBe(true);
        expect(editor._keyToDOMMap.has(keys[i])).toBe(true);
      }

      expect(editor._editorState._nodeMap.size).toBe(keys.length + 1); // + root
      expect(editor._keyToDOMMap.size).toBe(keys.length + 1); // + root
      expect(container.innerHTML).toBe(
        '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><div><span data-lexical-text="true">A</span><div><span data-lexical-text="true">B</span></div></div></p></div>',
      );
    });

    it('moves node to different tree branches (inverse)', async () => {
      function $createElementNodeWithText(text: string) {
        const elementNode = $createTestElementNode();
        const textNode = $createTextNode(text);
        elementNode.append(textNode);

        return elementNode;
      }

      let elementNode1Key: string;
      let elementNode2Key: string;

      await update(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );

        const elementNode1 = $createElementNodeWithText('A');
        elementNode1Key = elementNode1.getKey();

        const elementNode2 = $createElementNodeWithText('B');
        elementNode2Key = elementNode2.getKey();

        paragraph.append(elementNode1, elementNode2);
      });

      await update(() => {
        const elementNode1 = $assertNodeType(
          $getNodeByKey(elementNode1Key),
          $isElementNode,
        );
        const elementNode2 = $assertNodeType(
          $getNodeByKey(elementNode2Key),
          $isElementNode,
        );
        elementNode2.append(elementNode1);
      });

      expect(container.innerHTML).toBe(
        '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><div><span data-lexical-text="true">B</span><div><span data-lexical-text="true">A</span></div></div></p></div>',
      );
    });

    it('moves node to different tree branches (node appended twice in two different branches)', async () => {
      function $createElementNodeWithText(text: string) {
        const elementNode = $createTestElementNode();
        const textNode = $createTextNode(text);
        elementNode.append(textNode);

        return elementNode;
      }

      let elementNode1Key: string;
      let elementNode2Key: string;
      let elementNode3Key: string;

      await update(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );

        const elementNode1 = $createElementNodeWithText('A');
        elementNode1Key = elementNode1.getKey();

        const elementNode2 = $createElementNodeWithText('B');
        elementNode2Key = elementNode2.getKey();

        const elementNode3 = $createElementNodeWithText('C');
        elementNode3Key = elementNode3.getKey();

        paragraph.append(elementNode1, elementNode2, elementNode3);
      });

      await update(() => {
        const elementNode1 = $assertNodeType(
          $getNodeByKey(elementNode1Key),
          $isElementNode,
        );
        const elementNode2 = $assertNodeType(
          $getNodeByKey(elementNode2Key),
          $isElementNode,
        );
        const elementNode3 = $assertNodeType(
          $getNodeByKey(elementNode3Key),
          $isElementNode,
        );
        elementNode2.append(elementNode3);
        elementNode1.append(elementNode3);
      });

      expect(container.innerHTML).toBe(
        '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><div><span data-lexical-text="true">A</span><div><span data-lexical-text="true">C</span></div></div><div><span data-lexical-text="true">B</span></div></p></div>',
      );
    });
  });

  it('can subscribe and unsubscribe from commands and the callback is fired', () => {
    init();

    const commandListener = vi.fn();
    const command = createCommand('TEST_COMMAND');
    const payload = 'testPayload';
    const removeCommandListener = editor.registerCommand(
      command,
      commandListener,
      COMMAND_PRIORITY_EDITOR,
    );
    editor.dispatchCommand(command, payload);
    editor.dispatchCommand(command, payload);
    editor.dispatchCommand(command, payload);

    expect(commandListener).toHaveBeenCalledTimes(3);
    expect(commandListener).toHaveBeenCalledWith(payload, editor);

    removeCommandListener();

    editor.dispatchCommand(command, payload);
    editor.dispatchCommand(command, payload);
    editor.dispatchCommand(command, payload);

    expect(commandListener).toHaveBeenCalledTimes(3);
    expect(commandListener).toHaveBeenCalledWith(payload, editor);
  });

  it('removes the command from the command map when no listener are attached', () => {
    init();

    const commandListener = vi.fn();
    const commandListenerTwo = vi.fn();
    const command = createCommand('TEST_COMMAND');
    const removeCommandListener = editor.registerCommand(
      command,
      commandListener,
      COMMAND_PRIORITY_EDITOR,
    );
    const removeCommandListenerTwo = editor.registerCommand(
      command,
      commandListenerTwo,
      COMMAND_PRIORITY_EDITOR,
    );

    expect(editor._commands.has(command)).toEqual(true);
    expect(editor._commands.get(command)?.map(v => [...v])).toEqual([
      [commandListener, commandListenerTwo],
      [],
      [],
      [],
      [],
    ]);

    removeCommandListener();

    expect(editor._commands.get(command)?.map(v => [...v])).toEqual([
      [commandListenerTwo],
      [],
      [],
      [],
      [],
    ]);

    removeCommandListenerTwo();

    expect(editor._commands.has(command)).toEqual(false);
  });

  it('can register transforms before updates', async () => {
    init();

    const emptyTransform = () => {
      return;
    };

    const removeTextTransform = editor.registerNodeTransform(
      TextNode,
      emptyTransform,
    );
    const removeParagraphTransform = editor.registerNodeTransform(
      ParagraphNode,
      emptyTransform,
    );

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
    });

    removeTextTransform();
    removeParagraphTransform();
  });

  it('textcontent listener', async () => {
    init();

    const fn = vi.fn();
    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const textNode = $createTextNode('foo');
      root.append(paragraph);
      paragraph.append(textNode);
    });
    editor.registerTextContentListener(text => {
      fn(text);
    });

    await editor.update(() => {
      const root = $getRoot();
      const child = root.getLastDescendant()!;
      child.insertAfter($createTextNode('bar'));
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('foobar');

    await editor.update(() => {
      const root = $getRoot();
      const child = root.getLastDescendant()!;
      child.insertAfter($createLineBreakNode());
    });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledWith('foobar\n');

    await editor.update(() => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      const paragraph2 = $createParagraphNode();
      root.append(paragraph);
      paragraph.append($createTextNode('bar'));
      paragraph2.append($createTextNode('yar'));
      paragraph.insertAfter(paragraph2);
    });

    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenCalledWith('bar\n\nyar');

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const paragraph2 = $createParagraphNode();
      root.getLastChild()!.insertAfter(paragraph);
      paragraph.append($createTextNode('bar2'));
      paragraph2.append($createTextNode('yar2'));
      paragraph.insertAfter(paragraph2);
    });

    expect(fn).toHaveBeenCalledTimes(4);
    expect(fn).toHaveBeenCalledWith('bar\n\nyar\n\nbar2\n\nyar2');
  });

  it('mutation listener', async () => {
    init();

    const paragraphNodeMutations = vi.fn();
    const textNodeMutations = vi.fn();
    const onUpdate = vi.fn();
    editor.registerUpdateListener(onUpdate);
    editor.registerMutationListener(ParagraphNode, paragraphNodeMutations, {
      skipInitialization: false,
    });
    editor.registerMutationListener(TextNode, textNodeMutations, {
      skipInitialization: false,
    });
    const paragraphKeys: string[] = [];
    const textNodeKeys: string[] = [];
    let prevEditorState = editor.getEditorState();

    // No await intentional (batch with next)
    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const textNode = $createTextNode('foo');
      root.append(paragraph);
      paragraph.append(textNode);
      paragraphKeys.push(paragraph.getKey());
      textNodeKeys.push(textNode.getKey());
    });

    await editor.update(() => {
      const textNode = $assertNodeType(
        $getNodeByKey(textNodeKeys[0]),
        $isTextNode,
      );
      const textNode2 = $createTextNode('bar').toggleFormat('bold');
      const textNode3 = $createTextNode('xyz').toggleFormat('italic');
      textNode.insertAfter(textNode2);
      textNode2.insertAfter(textNode3);
      textNodeKeys.push(textNode2.getKey());
      textNodeKeys.push(textNode3.getKey());
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    // Calculate an expected update listener paylaod
    expect(onUpdate.mock.lastCall).toEqual([
      computeUpdateListenerPayload(editor, prevEditorState, true),
    ]);

    prevEditorState = editor.getEditorState();
    await editor.update(() => {
      $getRoot().clear();
    });

    expect(onUpdate).toHaveBeenCalledTimes(2);
    // Calculate an expected update listener payload after destroying
    // everything
    expect(onUpdate.mock.lastCall).toEqual([
      computeUpdateListenerPayload(editor, prevEditorState, true),
    ]);

    prevEditorState = editor.getEditorState();
    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();

      paragraphKeys.push(paragraph.getKey());

      // Created and deleted in the same update (not attached to node)
      textNodeKeys.push($createTextNode('zzz').getKey());
      root.append(paragraph);
    });

    expect(onUpdate).toHaveBeenCalledTimes(3);
    // Calculate an expected update listener payload after destroying
    // everything
    expect(onUpdate.mock.lastCall).toEqual([
      computeUpdateListenerPayload(editor, prevEditorState, true),
    ]);

    expect(paragraphNodeMutations.mock.calls.length).toBe(3);
    expect(textNodeMutations.mock.calls.length).toBe(2);

    const [paragraphMutation1, paragraphMutation2, paragraphMutation3] =
      paragraphNodeMutations.mock.calls;
    const [textNodeMutation1, textNodeMutation2] = textNodeMutations.mock.calls;

    expect(paragraphMutation1[0].size).toBe(1);
    expect(paragraphMutation1[0].get(paragraphKeys[0])).toBe('created');
    expect(paragraphMutation1[0].size).toBe(1);
    expect(paragraphMutation2[0].get(paragraphKeys[0])).toBe('destroyed');
    expect(paragraphMutation3[0].size).toBe(1);
    expect(paragraphMutation3[0].get(paragraphKeys[1])).toBe('created');
    expect(textNodeMutation1[0].size).toBe(3);
    expect(textNodeMutation1[0].get(textNodeKeys[0])).toBe('created');
    expect(textNodeMutation1[0].get(textNodeKeys[1])).toBe('created');
    expect(textNodeMutation1[0].get(textNodeKeys[2])).toBe('created');
    expect(textNodeMutation2[0].size).toBe(3);
    expect(textNodeMutation2[0].get(textNodeKeys[0])).toBe('destroyed');
    expect(textNodeMutation2[0].get(textNodeKeys[1])).toBe('destroyed');
    expect(textNodeMutation2[0].get(textNodeKeys[2])).toBe('destroyed');
  });
  it('rejects creating an editor with invalid LexicalNode parent class', async () => {
    class FakeLexicalNode {
      static getType() {
        return 'fake-node';
      }
    }
    expect(() =>
      // @ts-expect-error
      createEditor({nodes: [FakeLexicalNode]}),
    ).toThrow(
      /nodes\[0\] FakeLexicalNode \(type fake-node\) is not a constructor that subclasses LexicalNode from the lexical package used by this editor/,
    );
  });
  it('rejects creating an editor with invalid LexicalNode parent class (no getType)', async () => {
    class FakeLexicalNode {}
    // @ts-expect-error
    expect(() => createEditor({nodes: [FakeLexicalNode]})).toThrow(
      /nodes\[0\] FakeLexicalNode is not a constructor that subclasses LexicalNode from the lexical package used by this editor/,
    );
  });
  it('rejects creating an editor with invalid LexicalNode parent class (undefined)', async () => {
    // @ts-expect-error
    expect(() => createEditor({nodes: [undefined]})).toThrow(
      /nodes\[0\] undefined is not a constructor that subclasses LexicalNode from the lexical package used by this editor/,
    );
  });
  it('mutation listener on newly initialized editor', async () => {
    editor = createEditor();
    const textNodeMutations = vi.fn();
    editor.registerMutationListener(TextNode, textNodeMutations, {
      skipInitialization: false,
    });
    expect(textNodeMutations.mock.calls.length).toBe(0);
  });
  it('mutation listener with setEditorState', async () => {
    init();

    await editor.update(() => {
      $getRoot().append($createParagraphNode());
    });

    const initialEditorState = editor.getEditorState();
    const textNodeMutations = vi.fn();
    editor.registerMutationListener(TextNode, textNodeMutations, {
      skipInitialization: false,
    });
    const textNodeKeys: string[] = [];

    await editor.update(() => {
      const paragraph = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );
      const textNode1 = $createTextNode('foo');
      paragraph.append(textNode1);
      textNodeKeys.push(textNode1.getKey());
    });

    const fooEditorState = editor.getEditorState();

    await editor.setEditorState(initialEditorState);
    // This line should have no effect on the mutation listeners
    const parsedFooEditorState = editor.parseEditorState(
      JSON.stringify(fooEditorState),
    );

    await editor.update(() => {
      const paragraph = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );
      const textNode2 = $createTextNode('bar').toggleFormat('bold');
      const textNode3 = $createTextNode('xyz').toggleFormat('italic');
      paragraph.append(textNode2, textNode3);
      textNodeKeys.push(textNode2.getKey(), textNode3.getKey());
    });

    await editor.setEditorState(parsedFooEditorState);

    expect(textNodeMutations.mock.calls.length).toBe(4);

    const [
      textNodeMutation1,
      textNodeMutation2,
      textNodeMutation3,
      textNodeMutation4,
    ] = textNodeMutations.mock.calls;

    expect(textNodeMutation1[0].size).toBe(1);
    expect(textNodeMutation1[0].get(textNodeKeys[0])).toBe('created');
    expect(textNodeMutation2[0].size).toBe(1);
    expect(textNodeMutation2[0].get(textNodeKeys[0])).toBe('destroyed');
    expect(textNodeMutation3[0].size).toBe(2);
    expect(textNodeMutation3[0].get(textNodeKeys[1])).toBe('created');
    expect(textNodeMutation3[0].get(textNodeKeys[2])).toBe('created');
    expect(textNodeMutation4[0].size).toBe(3); // +1 newly generated key by parseEditorState
    expect(textNodeMutation4[0].get(textNodeKeys[1])).toBe('destroyed');
    expect(textNodeMutation4[0].get(textNodeKeys[2])).toBe('destroyed');
  });

  it('mutation listener set for original node should work with the replaced node', async () => {
    const ref = createRef<HTMLDivElement>();

    function TestBase() {
      editor = useLexicalEditor(ref, undefined, [
        TestTextNode,
        {
          replace: TextNode,
          with: (node: TextNode) => new TestTextNode(node.getTextContent()),
          withKlass: TestTextNode,
        },
      ]);

      return <div ref={ref} contentEditable={true} />;
    }

    act(() => {
      reactRoot.render(<TestBase />);
    });

    const textNodeMutations = vi.fn();
    const textNodeMutationsB = vi.fn();
    editor.registerMutationListener(TextNode, textNodeMutations, {
      skipInitialization: false,
    });
    const textNodeKeys: string[] = [];

    // No await intentional (batch with next)
    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const textNode = $createTextNode('foo');
      root.append(paragraph);
      paragraph.append(textNode);
      textNodeKeys.push(textNode.getKey());
    });

    await editor.update(() => {
      const textNode = $assertNodeType(
        $getNodeByKey(textNodeKeys[0]),
        $isTextNode,
      );
      const textNode2 = $createTextNode('bar').toggleFormat('bold');
      const textNode3 = $createTextNode('xyz').toggleFormat('italic');
      textNode.insertAfter(textNode2);
      textNode2.insertAfter(textNode3);
      textNodeKeys.push(textNode2.getKey());
      textNodeKeys.push(textNode3.getKey());
    });

    editor.registerMutationListener(TextNode, textNodeMutationsB, {
      skipInitialization: false,
    });

    await editor.update(() => {
      $getRoot().clear();
    });

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();

      // Created and deleted in the same update (not attached to node)
      textNodeKeys.push($createTextNode('zzz').getKey());
      root.append(paragraph);
    });

    expect(textNodeMutations.mock.calls.length).toBe(2);
    expect(textNodeMutationsB.mock.calls.length).toBe(2);

    const [textNodeMutation1, textNodeMutation2] = textNodeMutations.mock.calls;

    expect(textNodeMutation1[0].size).toBe(3);
    expect(textNodeMutation1[0].get(textNodeKeys[0])).toBe('created');
    expect(textNodeMutation1[0].get(textNodeKeys[1])).toBe('created');
    expect(textNodeMutation1[0].get(textNodeKeys[2])).toBe('created');
    expect([...textNodeMutation1[1].updateTags]).toEqual([]);
    expect(textNodeMutation2[0].size).toBe(3);
    expect(textNodeMutation2[0].get(textNodeKeys[0])).toBe('destroyed');
    expect(textNodeMutation2[0].get(textNodeKeys[1])).toBe('destroyed');
    expect(textNodeMutation2[0].get(textNodeKeys[2])).toBe('destroyed');
    expect([...textNodeMutation2[1].updateTags]).toEqual([]);

    const [textNodeMutationB1, textNodeMutationB2] =
      textNodeMutationsB.mock.calls;

    expect(textNodeMutationB1[0].size).toBe(3);
    expect(textNodeMutationB1[0].get(textNodeKeys[0])).toBe('created');
    expect(textNodeMutationB1[0].get(textNodeKeys[1])).toBe('created');
    expect(textNodeMutationB1[0].get(textNodeKeys[2])).toBe('created');
    expect([...textNodeMutationB1[1].updateTags]).toEqual([
      'registerMutationListener',
    ]);
    expect(textNodeMutationB2[0].size).toBe(3);
    expect(textNodeMutationB2[0].get(textNodeKeys[0])).toBe('destroyed');
    expect(textNodeMutationB2[0].get(textNodeKeys[1])).toBe('destroyed');
    expect(textNodeMutationB2[0].get(textNodeKeys[2])).toBe('destroyed');
    expect([...textNodeMutationB2[1].updateTags]).toEqual([]);
  });

  it('mutation listener should work with the replaced node', async () => {
    const ref = createRef<HTMLDivElement>();

    function TestBase() {
      editor = useLexicalEditor(ref, undefined, [
        TestTextNode,
        {
          replace: TextNode,
          with: (node: TextNode) => new TestTextNode(node.getTextContent()),
          withKlass: TestTextNode,
        },
      ]);

      return <div ref={ref} contentEditable={true} />;
    }

    act(() => {
      reactRoot.render(<TestBase />);
    });

    const textNodeMutations = vi.fn();
    const textNodeMutationsB = vi.fn();
    editor.registerMutationListener(TestTextNode, textNodeMutations, {
      skipInitialization: false,
    });
    const textNodeKeys: string[] = [];

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const textNode = $createTextNode('foo');
      root.append(paragraph);
      paragraph.append(textNode);
      textNodeKeys.push(textNode.getKey());
    });

    editor.registerMutationListener(TestTextNode, textNodeMutationsB, {
      skipInitialization: false,
    });

    expect(textNodeMutations.mock.calls.length).toBe(1);

    const [textNodeMutation1] = textNodeMutations.mock.calls;

    expect(textNodeMutation1[0].size).toBe(1);
    expect(textNodeMutation1[0].get(textNodeKeys[0])).toBe('created');
    expect([...textNodeMutation1[1].updateTags]).toEqual([]);

    const [textNodeMutationB1] = textNodeMutationsB.mock.calls;

    expect(textNodeMutationB1[0].size).toBe(1);
    expect(textNodeMutationB1[0].get(textNodeKeys[0])).toBe('created');
    expect([...textNodeMutationB1[1].updateTags]).toEqual([
      'registerMutationListener',
    ]);
  });

  it('multiple update tags', async () => {
    init();
    const $mutateSomething = $createTextNode;

    editor.update($mutateSomething, {
      tag: ['a', 'b'],
    });
    expect(editor._updateTags).toEqual(new Set(['a', 'b']));
    editor.update(
      () => {
        editor.update(emptyFunction, {tag: ['e', 'f']});
      },
      {
        tag: ['c', 'd'],
      },
    );
    expect(editor._updateTags).toEqual(new Set(['a', 'b', 'c', 'd', 'e', 'f']));

    await Promise.resolve();
    expect(editor._updateTags).toEqual(new Set([]));
  });

  it('does not leak a no-op update tag into the next update', () => {
    init();
    const observedTags: string[][] = [];
    const unregister = editor.registerUpdateListener(({tags}) => {
      observedTags.push([...tags]);
    });

    // A tagged update that dirties nothing still commits because it carries a
    // deferred onUpdate callback -- this mirrors a remote collaboration sync
    // that turns out to be a no-op (the targeted node was concurrently removed).
    // Its tag must not survive into a later, unrelated update, otherwise a
    // listener such as @lexical/yjs's syncLexicalUpdateToYjs would wrongly skip
    // the next local edit.
    editor.update(emptyFunction, {
      discrete: true,
      onUpdate: emptyFunction,
      tag: 'collaboration',
    });
    expect(editor._updateTags).toEqual(new Set());

    // A subsequent untagged local edit must not observe the leaked tag.
    editor.update(
      () => {
        $getRoot().append($createParagraphNode());
      },
      {discrete: true},
    );
    unregister();

    const lastObservedTags = observedTags[observedTags.length - 1];
    expect(lastObservedTags).not.toContain('collaboration');
  });

  it('setEditorState keeps its tag when committed from inside an update', () => {
    init();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('historic'));
        $getRoot().append(paragraph);
      },
      {discrete: true},
    );
    const historicState = editor.getEditorState();
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('current'));
        root.append(paragraph);
      },
      {discrete: true},
    );

    const observed: {content: string; tags: string[]}[] = [];
    const unregister = editor.registerUpdateListener(({editorState, tags}) => {
      observed.push({
        content: editorState.read(() => $getRoot().getTextContent()),
        tags: [...tags],
      });
    });
    // Applying an editor state with a tag from *inside* an update -- the way
    // history's undo does via dispatchCommand -- force-commits the wrapping
    // no-op update, which resets _updateTags. The tag must still reach the
    // update listener for the commit that actually applies the historic state;
    // otherwise (e.g. @lexical/history) that transition is misclassified as a
    // fresh edit rather than an undo.
    editor.update(
      () => {
        editor.setEditorState(historicState, {tag: 'historic-tag'});
      },
      {discrete: true},
    );
    unregister();

    const historicCommit = observed.find(o => o.content === 'historic');
    expect(historicCommit).toBeDefined();
    expect(historicCommit!.tags).toContain('historic-tag');
  });

  it('defers onUpdate callbacks when setEditorState commits inside an update', async () => {
    init();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('historic'));
        $getRoot().append(paragraph);
      },
      {discrete: true},
    );
    const historicState = editor.getEditorState();
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('current'));
        root.append(paragraph);
      },
      {discrete: true},
    );

    const events: string[] = [];
    editor.update(
      () => {
        events.push('update start');
        editor.setEditorState(historicState);
        events.push('update end');
      },
      {
        onUpdate: () => {
          events.push('onUpdate');
        },
      },
    );
    events.push('after update');

    expect(events).toEqual(['update start', 'update end', 'after update']);

    await Promise.resolve();
    expect(events).toEqual([
      'update start',
      'update end',
      'after update',
      'onUpdate',
    ]);
  });

  it('mutation listeners does not trigger when other node types are mutated', async () => {
    init();

    const paragraphNodeMutations = vi.fn();
    const textNodeMutations = vi.fn();
    editor.registerMutationListener(ParagraphNode, paragraphNodeMutations, {
      skipInitialization: false,
    });
    editor.registerMutationListener(TextNode, textNodeMutations, {
      skipInitialization: false,
    });

    await editor.update(() => {
      $getRoot().append($createParagraphNode());
    });

    expect(paragraphNodeMutations.mock.calls.length).toBe(1);
    expect(textNodeMutations.mock.calls.length).toBe(0);
  });

  it('mutation listeners with normalization', async () => {
    init();

    const textNodeMutations = vi.fn();
    editor.registerMutationListener(TextNode, textNodeMutations, {
      skipInitialization: false,
    });
    const textNodeKeys: string[] = [];

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const textNode1 = $createTextNode('foo');
      const textNode2 = $createTextNode('bar');

      textNodeKeys.push(textNode1.getKey(), textNode2.getKey());
      root.append(paragraph);
      paragraph.append(textNode1, textNode2);
    });

    await editor.update(() => {
      const paragraph = $assertNodeType(
        $getRoot().getFirstChild(),
        $isParagraphNode,
      );
      const textNode3 = $createTextNode('xyz').toggleFormat('bold');
      paragraph.append(textNode3);
      textNodeKeys.push(textNode3.getKey());
    });

    await editor.update(() => {
      const textNode3 = $assertNodeType(
        $getNodeByKey(textNodeKeys[2]),
        $isTextNode,
      );
      textNode3.toggleFormat('bold'); // Normalize with foobar
    });

    expect(textNodeMutations.mock.calls.length).toBe(3);

    const [textNodeMutation1, textNodeMutation2, textNodeMutation3] =
      textNodeMutations.mock.calls;

    expect(textNodeMutation1[0].size).toBe(1);
    expect(textNodeMutation1[0].get(textNodeKeys[0])).toBe('created');
    expect(textNodeMutation2[0].size).toBe(2);
    expect(textNodeMutation2[0].get(textNodeKeys[2])).toBe('created');
    expect(textNodeMutation3[0].size).toBe(2);
    expect(textNodeMutation3[0].get(textNodeKeys[0])).toBe('updated');
    expect(textNodeMutation3[0].get(textNodeKeys[2])).toBe('destroyed');
  });

  it('mutation "update" listener', async () => {
    init();

    const paragraphNodeMutations = vi.fn();
    const textNodeMutations = vi.fn();

    editor.registerMutationListener(ParagraphNode, paragraphNodeMutations, {
      skipInitialization: false,
    });
    editor.registerMutationListener(TextNode, textNodeMutations, {
      skipInitialization: false,
    });

    const paragraphNodeKeys: string[] = [];
    const textNodeKeys: string[] = [];

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const textNode1 = $createTextNode('foo');
      textNodeKeys.push(textNode1.getKey());
      paragraphNodeKeys.push(paragraph.getKey());
      root.append(paragraph);
      paragraph.append(textNode1);
    });

    expect(paragraphNodeMutations.mock.calls.length).toBe(1);

    const [paragraphNodeMutation1] = paragraphNodeMutations.mock.calls;
    expect(textNodeMutations.mock.calls.length).toBe(1);

    const [textNodeMutation1] = textNodeMutations.mock.calls;

    expect(textNodeMutation1[0].size).toBe(1);
    expect(paragraphNodeMutation1[0].size).toBe(1);

    // Change first text node's content.
    await editor.update(() => {
      const textNode1 = $assertNodeType(
        $getNodeByKey(textNodeKeys[0]),
        $isTextNode,
      );
      textNode1.setTextContent('Test'); // Normalize with foobar
    });

    // Append text node to paragraph.
    await editor.update(() => {
      const paragraphNode1 = $assertNodeType(
        $getNodeByKey(paragraphNodeKeys[0]),
        $isParagraphNode,
      );
      const textNode1 = $createTextNode('foo');
      paragraphNode1.append(textNode1);
    });

    expect(textNodeMutations.mock.calls.length).toBe(3);

    const textNodeMutation2 = textNodeMutations.mock.calls[1];

    // Show TextNode was updated when text content changed.
    expect(textNodeMutation2[0].get(textNodeKeys[0])).toBe('updated');
    expect(paragraphNodeMutations.mock.calls.length).toBe(2);

    const paragraphNodeMutation2 = paragraphNodeMutations.mock.calls[1];

    // Show ParagraphNode was updated when new text node was appended.
    expect(paragraphNodeMutation2[0].get(paragraphNodeKeys[0])).toBe('updated');

    let tableCellKey: string;
    let tableRowKey: string;

    const tableCellMutations = vi.fn();
    const tableRowMutations = vi.fn();

    editor.registerMutationListener(TableCellNode, tableCellMutations, {
      skipInitialization: false,
    });
    editor.registerMutationListener(TableRowNode, tableRowMutations, {
      skipInitialization: false,
    });
    // Create Table

    await editor.update(() => {
      const root = $getRoot();
      const tableCell = $createTableCellNode();
      const tableRow = $createTableRowNode();
      const table = $createTableNode();

      tableRow.append(tableCell);
      table.append(tableRow);
      root.append(table);

      tableRowKey = tableRow.getKey();
      tableCellKey = tableCell.getKey();
    });
    // Add New Table Cell To Row

    await editor.update(() => {
      const tableRow = $getNodeByKey(tableRowKey) as TableRowNode;
      const tableCell = $createTableCellNode();
      tableRow.append(tableCell);
    });

    // Update Table Cell
    await editor.update(() => {
      const tableCell = $getNodeByKey(tableCellKey) as TableCellNode;
      tableCell.toggleHeaderStyle(1);
    });

    expect(tableCellMutations.mock.calls.length).toBe(3);
    const tableCellMutation3 = tableCellMutations.mock.calls[2];

    // Show table cell is updated when header value changes.
    expect(tableCellMutation3[0].get(tableCellKey!)).toBe('updated');
    expect(tableRowMutations.mock.calls.length).toBe(2);

    const tableRowMutation2 = tableRowMutations.mock.calls[1];

    // Show row is updated when a new child is added.
    expect(tableRowMutation2[0].get(tableRowKey!)).toBe('updated');
  });

  it('editable listener', () => {
    init();

    const editableFn = vi.fn();
    editor.registerEditableListener(editableFn);

    expect(editor.isEditable()).toBe(true);

    editor.setEditable(false);

    expect(editor.isEditable()).toBe(false);

    editor.setEditable(true);

    expect(editableFn.mock.calls).toEqual([[false], [true]]);
  });

  it('does not add new listeners while triggering existing', async () => {
    const updateListener = vi.fn();
    const mutationListener = vi.fn();
    const nodeTransformListener = vi.fn();
    const textContentListener = vi.fn();
    const editableListener = vi.fn();
    const commandListener = vi.fn();
    const TEST_COMMAND = createCommand('TEST_COMMAND');

    init();

    editor.registerUpdateListener(() => {
      updateListener();

      editor.registerUpdateListener(() => {
        updateListener();
      });
    });

    editor.registerMutationListener(
      TextNode,
      map => {
        mutationListener();
        editor.registerMutationListener(
          TextNode,
          () => {
            mutationListener();
          },
          {skipInitialization: true},
        );
      },
      {skipInitialization: false},
    );

    editor.registerNodeTransform(ParagraphNode, () => {
      nodeTransformListener();
      editor.registerNodeTransform(ParagraphNode, () => {
        nodeTransformListener();
      });
    });

    editor.registerEditableListener(() => {
      editableListener();
      editor.registerEditableListener(() => {
        editableListener();
      });
    });

    editor.registerTextContentListener(() => {
      textContentListener();
      editor.registerTextContentListener(() => {
        textContentListener();
      });
    });

    editor.registerCommand(
      TEST_COMMAND,
      (): boolean => {
        commandListener();
        editor.registerCommand(
          TEST_COMMAND,
          commandListener,
          COMMAND_PRIORITY_LOW,
        );
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    await update(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Hello world')),
      );
    });

    editor.dispatchCommand(TEST_COMMAND, false);

    editor.setEditable(false);

    expect(updateListener).toHaveBeenCalledTimes(1);
    expect(editableListener).toHaveBeenCalledTimes(1);
    expect(commandListener).toHaveBeenCalledTimes(1);
    expect(textContentListener).toHaveBeenCalledTimes(1);
    expect(nodeTransformListener).toHaveBeenCalledTimes(1);
    expect(mutationListener).toHaveBeenCalledTimes(1);
  });

  it('calls command listeners in deque order', async () => {
    const calls: string[] = [];
    let regOrder = 0;
    const names = {
      [COMMAND_PRIORITY_BEFORE_EDITOR]: 'before:editor',
      [COMMAND_PRIORITY_BEFORE_LOW]: 'before:low',
      [COMMAND_PRIORITY_EDITOR]: 'after:editor',
      [COMMAND_PRIORITY_LOW]: 'after:low',
    } as const;
    const listener = (priority: keyof typeof names) => {
      const idx = regOrder++;
      return editor.registerCommand(
        TEST_COMMAND,
        () => {
          calls.push(`${names[priority]}:${idx}`);
          return false;
        },
        priority,
      );
    };
    const TEST_COMMAND = createCommand('TEST_COMMAND');
    init();
    const unreg = mergeRegister(
      listener(COMMAND_PRIORITY_EDITOR),
      listener(COMMAND_PRIORITY_LOW),
      listener(COMMAND_PRIORITY_EDITOR),
      listener(COMMAND_PRIORITY_LOW),
      listener(COMMAND_PRIORITY_BEFORE_EDITOR),
      listener(COMMAND_PRIORITY_BEFORE_LOW),
      listener(COMMAND_PRIORITY_BEFORE_EDITOR),
      listener(COMMAND_PRIORITY_BEFORE_LOW),
    );
    expect(calls).toHaveLength(0);
    editor.dispatchCommand(TEST_COMMAND, undefined);
    expect(calls).toEqual([
      'before:low:7',
      'before:low:5',
      'after:low:1',
      'after:low:3',
      'before:editor:6',
      'before:editor:4',
      'after:editor:0',
      'after:editor:2',
    ]);
    unreg();
    calls.length = 0;
    editor.dispatchCommand(TEST_COMMAND, undefined);
    expect(calls).toEqual([]);
  });
  it('maps priorities correctly', () => {
    // this brute forces to make sure all of the names match exactly what we expect
    const beforePriorities: [string, number][] = [];
    const afterPriorities: [string, number][] = [];
    for (const [k, v] of Object.entries(lexical)) {
      if (k.startsWith('COMMAND_PRIORITY_')) {
        assert(
          typeof v === 'number' && Math.floor(v) === v,
          'priorities are integers',
        );
        if (k.startsWith('COMMAND_PRIORITY_BEFORE')) {
          expect(v < 0).toBe(true);
          beforePriorities.push([k, v]);
        } else {
          expect(v >= 0).toBe(true);
          afterPriorities.push([k, v]);
        }
      }
    }
    beforePriorities.sort((a, b) => a[1] - b[1]);
    afterPriorities.sort((a, b) => a[1] - b[1]);
    expect(beforePriorities).toHaveLength(5);
    expect(afterPriorities).toHaveLength(5);
    expect(
      beforePriorities.map(([k]) => k.replace(/^COMMAND_PRIORITY_BEFORE_/, '')),
    ).toEqual(
      afterPriorities.map(([k]) => k.replace(/^COMMAND_PRIORITY_/, '')),
    );
    init();
    const command = createCommand('TEST_COMMAND');
    const listeners: (() => void)[] = [];
    const calls: string[] = [];
    for (const count of [0, 1]) {
      for (const arr of [afterPriorities, beforePriorities]) {
        for (const [k, v] of arr) {
          listeners.push(
            editor.registerCommand(
              command,
              () => {
                calls.push(`${k} ${count}`);
                return false;
              },
              v as CommandListenerPriority | CommandListenerPriorityBefore,
            ),
          );
        }
      }
    }
    editor.dispatchCommand(command, undefined);
    expect(calls).toEqual([
      'COMMAND_PRIORITY_BEFORE_CRITICAL 1',
      'COMMAND_PRIORITY_BEFORE_CRITICAL 0',
      'COMMAND_PRIORITY_CRITICAL 0',
      'COMMAND_PRIORITY_CRITICAL 1',
      'COMMAND_PRIORITY_BEFORE_HIGH 1',
      'COMMAND_PRIORITY_BEFORE_HIGH 0',
      'COMMAND_PRIORITY_HIGH 0',
      'COMMAND_PRIORITY_HIGH 1',
      'COMMAND_PRIORITY_BEFORE_NORMAL 1',
      'COMMAND_PRIORITY_BEFORE_NORMAL 0',
      'COMMAND_PRIORITY_NORMAL 0',
      'COMMAND_PRIORITY_NORMAL 1',
      'COMMAND_PRIORITY_BEFORE_LOW 1',
      'COMMAND_PRIORITY_BEFORE_LOW 0',
      'COMMAND_PRIORITY_LOW 0',
      'COMMAND_PRIORITY_LOW 1',
      'COMMAND_PRIORITY_BEFORE_EDITOR 1',
      'COMMAND_PRIORITY_BEFORE_EDITOR 0',
      'COMMAND_PRIORITY_EDITOR 0',
      'COMMAND_PRIORITY_EDITOR 1',
    ]);
    // ensure unregistration works
    mergeRegister(...listeners)();
    calls.length = 0;
    editor.dispatchCommand(command, undefined);
    expect(calls).toHaveLength(0);
  });

  it('has an invariant payload type for commands', () => {
    const EVENT_COMMAND = createCommand<Event>('EVENT_COMMAND');
    const MOUSE_EVENT_COMMAND = createCommand<MouseEvent>(
      'MOUSE_EVENT_COMMAND',
    );
    const MAYBE_MOUSE_EVENT_COMMAND = createCommand<undefined | MouseEvent>(
      'MAYBE_MOUSE_EVENT_COMMAND',
    );
    const VOID_COMMAND = createCommand<void>('VOID_COMMAND');
    // Test expected correct paths
    editor.dispatchCommand(EVENT_COMMAND, new Event('test_event'));
    editor.dispatchCommand(MOUSE_EVENT_COMMAND, new MouseEvent('mouse'));
    editor.dispatchCommand(MAYBE_MOUSE_EVENT_COMMAND, new MouseEvent('mouse'));
    editor.dispatchCommand(MAYBE_MOUSE_EVENT_COMMAND);
    editor.dispatchCommand(VOID_COMMAND, undefined);
    editor.dispatchCommand(VOID_COMMAND);
    // Test expected inference
    editor.registerCommand(
      EVENT_COMMAND,
      e => {
        assertType<Event>(e);
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    )();
    editor.registerCommand(
      MOUSE_EVENT_COMMAND,
      e => {
        assertType<MouseEvent>(e);
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    )();
    editor.registerCommand(
      MAYBE_MOUSE_EVENT_COMMAND,
      e => {
        assertType<undefined | MouseEvent>(e);
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    )();
    editor.registerCommand(
      VOID_COMMAND,
      e => {
        assertType<void>(e);
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    )();
    // Verify that types can't be narrowed with annotations
    editor.registerCommand(
      // @ts-expect-error
      EVENT_COMMAND,
      (e: MouseEvent) => false,
      COMMAND_PRIORITY_EDITOR,
    )();
    editor.registerCommand<LexicalCommand<MouseEvent>>(
      // @ts-expect-error
      EVENT_COMMAND,
      (e: MouseEvent) => false,
      COMMAND_PRIORITY_EDITOR,
    )();
    // Verify that types can't be widened with annotations
    // @ts-expect-error
    safeCast<LexicalCommand<Event>>(MOUSE_EVENT_COMMAND);
    // @ts-expect-error
    safeCast<LexicalCommand<unknown>>(MOUSE_EVENT_COMMAND);
    // @ts-expect-error
    safeCast<LexicalCommand<undefined>>(MAYBE_MOUSE_EVENT_COMMAND);
    // @ts-expect-error
    safeCast<LexicalCommand<MouseEvent>>(MAYBE_MOUSE_EVENT_COMMAND);
    editor.registerCommand(
      // @ts-expect-error
      EVENT_COMMAND,
      (e: MouseEvent) => false,
      COMMAND_PRIORITY_EDITOR,
    )();
  });

  it('allows using the same listener for multiple node types', async () => {
    init();

    const listener = vi.fn();
    editor.registerMutationListener(TextNode, listener);
    editor.registerMutationListener(ParagraphNode, listener);

    let paragraphKey: string;
    let textNodeKey: string;

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const textNode = $createTextNode('Hello world');
      paragraphKey = paragraph.getKey();
      textNodeKey = textNode.getKey();
      root.append(paragraph);
      paragraph.append(textNode);
    });

    expect(listener.mock.calls.length).toBe(2);
    const [textNodeMutation, paragraphMutation] = listener.mock.calls;

    expect(textNodeMutation[0].size).toBe(1);
    expect(textNodeMutation[0].get(textNodeKey!)).toBe('created');
    expect(paragraphMutation[0].size).toBe(1);
    expect(paragraphMutation[0].get(paragraphKey!)).toBe('created');
  });

  it('calls mutation listener with initial state', async () => {
    // TODO add tests for node replacement
    const mutationListenerA = vi.fn();
    const mutationListenerB = vi.fn();
    const mutationListenerC = vi.fn();
    init();

    editor.registerMutationListener(TextNode, mutationListenerA, {
      skipInitialization: false,
    });
    expect(mutationListenerA).toHaveBeenCalledTimes(0);

    await update(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Hello world')),
      );
    });

    function asymmetricMatcher<T>(asymmetricMatch: (x: T) => boolean) {
      return {asymmetricMatch};
    }

    expect(mutationListenerA).toHaveBeenCalledTimes(1);
    expect(mutationListenerA).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        updateTags: asymmetricMatcher(
          (s: Set<string>) => !s.has('registerMutationListener'),
        ),
      }),
    );
    editor.registerMutationListener(TextNode, mutationListenerB, {
      skipInitialization: false,
    });
    editor.registerMutationListener(TextNode, mutationListenerC, {
      skipInitialization: true,
    });
    expect(mutationListenerA).toHaveBeenCalledTimes(1);
    expect(mutationListenerB).toHaveBeenCalledTimes(1);
    expect(mutationListenerB).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        updateTags: asymmetricMatcher((s: Set<string>) =>
          s.has('registerMutationListener'),
        ),
      }),
    );
    expect(mutationListenerC).toHaveBeenCalledTimes(0);
    await update(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Another update!')),
      );
    });
    expect(mutationListenerA).toHaveBeenCalledTimes(2);
    expect(mutationListenerB).toHaveBeenCalledTimes(2);
    expect(mutationListenerC).toHaveBeenCalledTimes(1);
    [mutationListenerA, mutationListenerB, mutationListenerC].forEach(fn => {
      expect(fn).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          updateTags: asymmetricMatcher(
            (s: Set<string>) => !s.has('registerMutationListener'),
          ),
        }),
      );
    });
  });

  it('can use discrete for synchronous updates', () => {
    init();
    const onUpdate = vi.fn();
    editor.registerUpdateListener(onUpdate);
    const prevEditorState = editor.getEditorState();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Sync update')),
        );
      },
      {
        discrete: true,
      },
    );

    const textContent = editor.read('latest', () =>
      $getRoot().getTextContent(),
    );
    expect(textContent).toBe('Sync update');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    // Calculate an expected update listener paylaod
    expect(onUpdate.mock.calls).toEqual([
      [computeUpdateListenerPayload(editor, prevEditorState, false)],
    ]);
  });

  it('can use discrete after a non-discrete update to flush the entire queue', () => {
    const headless = createTestHeadlessEditor();
    const onUpdate = vi.fn();
    headless.registerUpdateListener(onUpdate);
    headless.update(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Async update')),
      );
    });
    headless.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Sync update')),
        );
      },
      {
        discrete: true,
      },
    );

    const textContent = headless.read('latest', () =>
      $getRoot().getTextContent(),
    );
    expect(textContent).toBe('Async update\n\nSync update');
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('can use discrete after a non-discrete setEditorState to flush the entire queue', () => {
    init();
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Async update')),
        );
      },
      {
        discrete: true,
      },
    );

    const headless = createTestHeadlessEditor(editor.getEditorState());
    headless.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Sync update')),
        );
      },
      {
        discrete: true,
      },
    );
    const textContent = headless.read('latest', () =>
      $getRoot().getTextContent(),
    );
    expect(textContent).toBe('Async update\n\nSync update');
  });

  it('can use discrete in a nested update to flush the entire queue', () => {
    init();
    const onUpdate = vi.fn();
    editor.registerUpdateListener(onUpdate);
    editor.update(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Async update')),
      );
      editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Sync update')),
          );
        },
        {
          discrete: true,
        },
      );
    });

    const textContent = editor.read('latest', () =>
      $getRoot().getTextContent(),
    );
    expect(textContent).toBe('Async update\n\nSync update');
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('can read in a nested update', async () => {
    init();
    await editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('foo')));
      editor.read(() => {});
      expect(editor.getRootElement()?.innerHTML).toBe(
        '<p dir="auto"><span data-lexical-text="true">foo</span></p>',
      );
      editor.update(() => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('bar')),
        );
      });
    });
    expect(editor.getRootElement()?.innerHTML).toBe(
      '<p dir="auto"><span data-lexical-text="true">foo</span></p><p dir="auto"><span data-lexical-text="true">bar</span></p>',
    );
  });

  it('does not include linebreak into inline elements', async () => {
    init();

    await editor.update(() => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('Hello'),
          $createTestInlineElementNode(),
        ),
      );
    });

    expect(container.firstElementChild?.innerHTML).toBe(
      '<p dir="auto"><span data-lexical-text="true">Hello</span><a></a></p>',
    );
  });

  it('reconciles state without root element', () => {
    editor = createTestEditor({});
    const state = editor.parseEditorState(
      `{"root":{"children":[{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"Hello world","type":"text","version":1}],"direction":"ltr","format":"","indent":0,"type":"paragraph","version":1}],"direction":"ltr","format":"","indent":0,"type":"root","version":1}}`,
    );
    editor.setEditorState(state);
    // A writable version of the EditorState may have been created, we settle for equal serializations
    expect(editor._editorState.toJSON()).toEqual(state.toJSON());
    expect(editor._pendingEditorState).toBe(null);
  });

  describe('node replacement', () => {
    it('should work correctly', async () => {
      const onError = vi.fn();

      const newEditor = createTestEditor({
        nodes: [
          TestTextNode,
          {
            replace: TextNode,
            with: (node: TextNode) => new TestTextNode(node.getTextContent()),
            withKlass: TestTextNode,
          },
        ],
        onError: onError,
        theme: {
          text: {
            bold: 'editor-text-bold',
            italic: 'editor-text-italic',
            underline: 'editor-text-underline',
          },
        },
      });

      newEditor.setRootElement(container);

      await newEditor.update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('123');
        root.append(paragraph);
        paragraph.append(text);
        expect(text instanceof TestTextNode).toBe(true);
        expect(text.getTextContent()).toBe('123');
      });

      expect(onError).not.toHaveBeenCalled();
    });

    it('should fail if node keys are re-used', async () => {
      const onError = vi.fn();

      const newEditor = createTestEditor({
        nodes: [
          TestTextNode,
          {
            replace: TextNode,
            with: (node: TextNode) =>
              new TestTextNode(node.getTextContent(), node.getKey()),
            withKlass: TestTextNode,
          },
        ],
        onError: onError,
        theme: {
          text: {
            bold: 'editor-text-bold',
            italic: 'editor-text-italic',
            underline: 'editor-text-underline',
          },
        },
      });

      newEditor.setRootElement(container);

      await newEditor.update(() => {
        // this will throw
        $createTextNode('123');
        expect(false).toBe('unreachable');
      });

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringMatching(/TestTextNode.*re-use key.*TextNode/),
        }),
      );
    });

    it('node transform to the nodes specified by "replace" should not be applied to the nodes specified by "with" when "withKlass" is not specified', async () => {
      const onError = vi.fn();
      const mockWarning = vi
        .spyOn(console, 'warn')
        .mockImplementationOnce(() => {});
      const newEditor = createTestEditor({
        nodes: [
          TestTextNode,
          {
            replace: TextNode,
            with: (node: TextNode) => new TestTextNode(node.getTextContent()),
          },
        ],
        onError: onError,
        theme: {
          text: {
            bold: 'editor-text-bold',
            italic: 'editor-text-italic',
            underline: 'editor-text-underline',
          },
        },
      });
      expect(mockWarning).toHaveBeenCalledWith(
        `Override for TextNode specifies 'replace' without 'withKlass'. 'withKlass' will be required in a future version.`,
      );
      mockWarning.mockRestore();

      newEditor.setRootElement(container);

      const mockTransform = vi.fn();
      const removeTransform = newEditor.registerNodeTransform(
        TextNode,
        mockTransform,
      );

      await newEditor.update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('123');
        root.append(paragraph);
        paragraph.append(text);
        expect(text instanceof TestTextNode).toBe(true);
        expect(text.getTextContent()).toBe('123');
      });

      await newEditor.read('latest', () => {
        expect(mockTransform).toHaveBeenCalledTimes(0);
      });

      expect(onError).not.toHaveBeenCalled();
      removeTransform();
    });

    it('node transform to the nodes specified by "replace" should be applied also to the nodes specified by "with" when "withKlass" is specified', async () => {
      const onError = vi.fn();

      const newEditor = createTestEditor({
        nodes: [
          TestTextNode,
          {
            replace: TextNode,
            with: (node: TextNode) => new TestTextNode(node.getTextContent()),
            withKlass: TestTextNode,
          },
        ],
        onError: onError,
        theme: {
          text: {
            bold: 'editor-text-bold',
            italic: 'editor-text-italic',
            underline: 'editor-text-underline',
          },
        },
      });

      newEditor.setRootElement(container);

      const mockTransform = vi.fn();
      const removeTransform = newEditor.registerNodeTransform(
        TextNode,
        mockTransform,
      );

      await newEditor.update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('123');
        root.append(paragraph);
        paragraph.append(text);
        expect(text instanceof TestTextNode).toBe(true);
        expect(text.getTextContent()).toBe('123');
      });

      await newEditor.read('latest', () => {
        expect(mockTransform).toHaveBeenCalledTimes(1);
      });

      expect(onError).not.toHaveBeenCalled();
      removeTransform();
    });

    it('applies the replacement when deserializing a base node type via parseEditorState (#8640 regression)', async () => {
      class CustomParagraphNode extends ParagraphNode {
        $config() {
          return this.config('custom-paragraph', {extends: ParagraphNode});
        }
      }
      const onError = vi.fn();

      const newEditor = createTestEditor({
        nodes: [
          CustomParagraphNode,
          {
            replace: ParagraphNode,
            with: () => new CustomParagraphNode(),
            withKlass: CustomParagraphNode,
          },
        ],
        onError: onError,
      });

      // Serialized state whose paragraph uses the default type ("paragraph"), as
      // an older persisted document (or one produced without the replacement)
      // would contain.
      const json = {
        root: {
          children: [
            {
              children: [],
              type: 'paragraph',
            },
          ],
          type: 'root',
        },
      };

      newEditor.setEditorState(
        newEditor.parseEditorState(JSON.stringify(json)),
      );

      newEditor.read(() => {
        const paragraph = $getRoot().getFirstChild();
        expect(paragraph instanceof CustomParagraphNode).toBe(true);
        expect(paragraph!.getType()).toBe('custom-paragraph');
      });

      expect(onError).not.toHaveBeenCalled();
    });

    it('applies the replacement on import for `with` without `withKlass`', async () => {
      class CustomParagraphNode extends ParagraphNode {
        $config() {
          return this.config('custom-paragraph', {extends: ParagraphNode});
        }
      }
      const onError = vi.fn();

      const newEditor = createTestEditor({
        nodes: [
          CustomParagraphNode,
          {
            replace: ParagraphNode,
            with: () => new CustomParagraphNode(),
          },
        ],
        onError: onError,
      });

      const json = {
        root: {
          children: [
            {
              children: [],
              type: 'paragraph',
            },
          ],
          type: 'root',
        },
      };

      newEditor.setEditorState(
        newEditor.parseEditorState(JSON.stringify(json)),
      );

      newEditor.read(() => {
        const paragraph = $getRoot().getFirstChild();
        expect(paragraph instanceof CustomParagraphNode).toBe(true);
        expect(paragraph!.getType()).toBe('custom-paragraph');
      });

      expect(onError).not.toHaveBeenCalled();
    });
  });

  it('recovers from reconciler failure and trigger proper prev editor state', async () => {
    const updateListener = vi.fn();
    const textListener = vi.fn();
    const onError = vi.fn();
    const updateError = new Error('Failed updateDOM');

    init(onError);

    editor.registerUpdateListener(updateListener);
    editor.registerTextContentListener(textListener);

    await update(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Hello')),
      );
    });

    // Cause reconciler error in update dom, so that it attempts to fallback by
    // resetting editor and rerendering whole content
    vi.spyOn(ParagraphNode.prototype, 'updateDOM').mockImplementation(() => {
      throw updateError;
    });

    const editorState = editor.getEditorState();

    editor.registerUpdateListener(updateListener);

    await update(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('world')),
      );
    });

    expect(onError).toBeCalledWith(updateError);
    expect(textListener).toBeCalledWith('Hello\n\nworld');
    expect(updateListener.mock.lastCall?.[0].prevEditorState).toBe(editorState);
  });

  it('should call importDOM methods only once', async () => {
    vi.spyOn(ParagraphNode, 'importDOM');

    class CustomParagraphNode extends ParagraphNode {
      $config() {
        return this.config('custom-paragraph', {extends: ParagraphNode});
      }
    }

    createTestEditor({nodes: [CustomParagraphNode]});

    expect(ParagraphNode.importDOM).toHaveBeenCalledTimes(1);
  });

  describe('setRootElement', () => {
    it('root element count is always positive', () => {
      const newEditor1 = createTestEditor();
      const newEditor2 = createTestEditor();

      const container1 = document.createElement('div');
      const container2 = document.createElement('div');

      newEditor1.setRootElement(container1);
      newEditor1.setRootElement(null);

      newEditor1.setRootElement(container1);
      newEditor2.setRootElement(container2);
      newEditor1.setRootElement(null);
      newEditor2.setRootElement(null);
    });

    it('should handle root element moving between documents', () => {
      const origEditor = createTestEditor();
      origEditor.setRootElement(container);

      // Register and unregister editor in jsdom document, so that root element
      // count is non-zero.
      const jsdom = new JSDOM();
      const jsdomDocument = jsdom.window.document;
      const jsdomContainer = jsdomDocument.createElement('div');
      const jsdomEditor = createTestEditor();
      jsdomEditor.setRootElement(jsdomContainer);
      jsdomEditor.setRootElement(null);

      // Move container from original document to jsdom document
      jsdomDocument.body.appendChild(container);

      // Ensure that cleanup still works
      origEditor.setRootElement(null);

      // Move node back to the original document so afterEach works
      document.body.appendChild(container);
    });
  });

  describe('html config', () => {
    it('should override export output function', async () => {
      const onError = vi.fn();

      const newEditor = createTestEditor({
        html: {
          export: new Map([
            [
              TextNode,
              (_, target) => {
                invariant($isTextNode(target));

                return {
                  element: target.hasFormat('bold')
                    ? document.createElement('bor')
                    : document.createElement('foo'),
                };
              },
            ],
          ]),
        },
        onError: onError,
      });

      newEditor.setRootElement(container);

      newEditor.update(() => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        const text = $createTextNode();
        root.append(paragraph);
        paragraph.append(text);

        const selection = $createNodeSelection();
        selection.add(text.getKey());

        const htmlFoo = $generateHtmlFromNodes(newEditor, selection);
        expect(htmlFoo).toBe('<foo></foo>');

        text.toggleFormat('bold');

        const htmlBold = $generateHtmlFromNodes(newEditor, selection);
        expect(htmlBold).toBe('<bor></bor>');
      });

      expect(onError).not.toHaveBeenCalled();
    });

    it('should override import conversion function', async () => {
      const onError = vi.fn();

      const newEditor = createTestEditor({
        html: {
          import: {
            figure: () => ({
              conversion: () => ({node: $createTextNode('yolo')}),
              priority: 4,
            }),
          },
        },
        onError: onError,
      });

      newEditor.setRootElement(container);

      newEditor.update(() => {
        const parser = new DOMParser();
        const dom = parser.parseFromString('<figure></figure>', 'text/html');
        const node = $generateNodesFromDOM(newEditor, dom)[0];

        expect(node).toEqual({
          __detail: 0,
          __format: 0,
          __key: node.getKey(),
          __mode: 0,
          __next: null,
          __parent: null,
          __prev: null,
          __style: '',
          __text: 'yolo',
          __type: 'text',
        });
      });

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('selection', () => {
    it('updates the DOM selection', async () => {
      const onError = vi.fn();
      const newEditor = createTestEditor({
        onError: onError,
      });
      const text = 'initial content';
      let textNode!: TextNode;
      await newEditor.update(
        () => {
          textNode = $createTextNode(text);
          $getRoot().append($createParagraphNode().append(textNode));
          textNode.select();
        },
        {tag: HISTORY_MERGE_TAG},
      );
      await newEditor.setRootElement(container);
      const domText = newEditor.getElementByKey(textNode.getKey())
        ?.firstChild as Text;
      expect(domText).not.toBe(null);
      let selection = getDOMSelection(newEditor._window || window) as Selection;
      expect(selection).not.toBe(null);
      expect(selection.rangeCount > 0);
      let range = selection.getRangeAt(0);
      expect(range.collapsed).toBe(true);
      expect(range.startContainer).toBe(domText);
      expect(range.endContainer).toBe(domText);
      expect(range.startOffset).toBe(text.length);
      expect(range.endOffset).toBe(text.length);
      await newEditor.update(() => {
        textNode.select(0);
      });
      selection = getDOMSelection(newEditor._window || window) as Selection;
      expect(selection).not.toBe(null);
      expect(selection.rangeCount > 0);
      range = selection.getRangeAt(0);
      expect(range.collapsed).toBe(false);
      expect(range.startContainer).toBe(domText);
      expect(range.endContainer).toBe(domText);
      expect(range.startOffset).toBe(0);
      expect(range.endOffset).toBe(text.length);
      expect(onError).not.toHaveBeenCalled();
    });
    it('does not update the Lexical->DOM selection with skip-dom-selection', async () => {
      const onError = vi.fn();
      const newEditor = createTestEditor({
        onError: onError,
      });
      const text = 'initial content';
      let textNode!: TextNode;
      await newEditor.update(
        () => {
          textNode = $createTextNode(text);
          $getRoot().append($createParagraphNode().append(textNode));
          textNode.select();
        },
        {tag: HISTORY_MERGE_TAG},
      );
      await newEditor.setRootElement(container);
      const domText = newEditor.getElementByKey(textNode.getKey())
        ?.firstChild as Text;
      expect(domText).not.toBe(null);
      let selection = getDOMSelection(newEditor._window || window) as Selection;
      expect(selection).not.toBe(null);
      expect(selection.rangeCount > 0);
      let range = selection.getRangeAt(0);
      expect(range.collapsed).toBe(true);
      expect(range.startContainer).toBe(domText);
      expect(range.endContainer).toBe(domText);
      expect(range.startOffset).toBe(text.length);
      expect(range.endOffset).toBe(text.length);
      await newEditor.update(
        () => {
          textNode.select(0);
        },
        {tag: SKIP_DOM_SELECTION_TAG},
      );
      selection = getDOMSelection(newEditor._window || window) as Selection;
      expect(selection).not.toBe(null);
      expect(selection.rangeCount > 0);
      range = selection.getRangeAt(0);
      expect(range.collapsed).toBe(true);
      expect(range.startContainer).toBe(domText);
      expect(range.endContainer).toBe(domText);
      expect(range.startOffset).toBe(text.length);
      expect(range.endOffset).toBe(text.length);
      expect(onError).not.toHaveBeenCalled();
    });
  });
});
