/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {EditorRefPlugin} from '@lexical/react/LexicalEditorRefPlugin';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  type MenuRenderFn,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  DELETE_CHARACTER_COMMAND,
  type LexicalEditor,
  ParagraphNode,
  type TextNode,
} from 'lexical';
import * as React from 'react';
import {act, useCallback} from 'react';
import ReactDOM from 'react-dom';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

class TestMenuOption extends MenuOption {
  title: string;
  constructor(title: string) {
    super(title);
    this.title = title;
  }
}

const TEST_OPTIONS = [
  new TestMenuOption('Alpha'),
  new TestMenuOption('Beta'),
  new TestMenuOption('Gamma'),
];

function TypeaheadPluginWithMenuRenderFn({
  options = TEST_OPTIONS,
}: {
  options?: TestMenuOption[];
}) {
  const checkForTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
    minLength: 0,
  });

  const onSelectOption = useCallback(
    (
      _option: TestMenuOption,
      nodeToRemove: TextNode | null,
      closeMenu: () => void,
    ) => {
      closeMenu();
    },
    [],
  );

  const menuRenderFn: MenuRenderFn<TestMenuOption> = useCallback(
    (anchorElementRef, itemProps, matchingString) => {
      return anchorElementRef.current && itemProps.options.length
        ? ReactDOM.createPortal(
            <div
              className="custom-typeahead-menu"
              data-testid="custom-typeahead">
              <ul>
                {itemProps.options.map((option, i) => (
                  <li
                    key={option.key}
                    data-selected={itemProps.selectedIndex === i}
                    className="custom-item">
                    {option.title}
                  </li>
                ))}
              </ul>
              {matchingString != null && (
                <span data-testid="matching-string">{matchingString}</span>
              )}
            </div>,
            anchorElementRef.current,
          )
        : null;
    },
    [],
  );

  return (
    <LexicalTypeaheadMenuPlugin<TestMenuOption>
      onQueryChange={vi.fn()}
      onSelectOption={onSelectOption}
      triggerFn={checkForTriggerMatch}
      options={options}
      menuRenderFn={menuRenderFn}
    />
  );
}

function TypeaheadPluginWithoutMenuRenderFn({
  options = TEST_OPTIONS,
}: {
  options?: TestMenuOption[];
}) {
  const checkForTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
    minLength: 0,
  });

  const onSelectOption = useCallback(
    (
      _option: TestMenuOption,
      nodeToRemove: TextNode | null,
      closeMenu: () => void,
    ) => {
      closeMenu();
    },
    [],
  );

  return (
    <LexicalTypeaheadMenuPlugin<TestMenuOption>
      onQueryChange={vi.fn()}
      onSelectOption={onSelectOption}
      triggerFn={checkForTriggerMatch}
      options={options}
    />
  );
}

function createApp(
  plugin: React.ReactNode,
  nodes: (typeof ParagraphNode)[] = [],
): React.FC {
  return function App() {
    return (
      <LexicalComposer
        initialConfig={{
          namespace: 'test-typeahead',
          nodes,
          onError: err => {
            throw err;
          },
          theme: {},
        }}>
        <RichTextPlugin
          contentEditable={<ContentEditable />}
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        {plugin}
      </LexicalComposer>
    );
  };
}

describe('LexicalTypeaheadMenuPlugin', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      reactRoot.unmount();
    });
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  describe('exports', () => {
    it('should export MenuRenderFn type', () => {
      // This test validates that MenuRenderFn is exported from the plugin.
      // If the export is missing, this file won't compile.
      const fn: MenuRenderFn<TestMenuOption> = () => null;
      expect(fn).toBeDefined();
    });

    it('should export MenuOption class', () => {
      const option = new MenuOption('key');
      expect(option.key).toBe('key');
    });
  });

  describe('with menuRenderFn (backward compatibility)', () => {
    it('should render without errors when menuRenderFn is provided', async () => {
      const App = createApp(<TypeaheadPluginWithMenuRenderFn />);

      await act(async () => {
        reactRoot.render(<App />);
      });

      // The plugin should mount without errors.
      // Since the typeahead menu is not triggered (no user input),
      // the menu should not be visible yet.
      expect(container.querySelector('[contenteditable]')).not.toBeNull();
    });

    it('should accept menuRenderFn as an optional prop', async () => {
      // Verify that TypeScript accepts menuRenderFn in the props.
      // This is a compile-time check that also confirms the prop is wired.
      const App = createApp(<TypeaheadPluginWithMenuRenderFn options={[]} />);

      await act(async () => {
        reactRoot.render(<App />);
      });

      expect(container.querySelector('[contenteditable]')).not.toBeNull();
    });
  });

  describe('without menuRenderFn (new default rendering)', () => {
    it('should render without errors when menuRenderFn is omitted', async () => {
      const App = createApp(<TypeaheadPluginWithoutMenuRenderFn />);

      await act(async () => {
        reactRoot.render(<App />);
      });

      // The plugin should mount without errors even without menuRenderFn.
      expect(container.querySelector('[contenteditable]')).not.toBeNull();
    });

    it('should accept props without menuRenderFn', async () => {
      const App = createApp(
        <TypeaheadPluginWithoutMenuRenderFn options={[]} />,
      );

      await act(async () => {
        reactRoot.render(<App />);
      });

      expect(container.querySelector('[contenteditable]')).not.toBeNull();
    });
  });

  describe('onClose', () => {
    let patchedSelectionModify = false;

    beforeEach(() => {
      class ResizeObserverMock {
        // LexicalMenu only constructs ResizeObserver and calls observe/unobserve/disconnect.
        constructor(_callback: unknown) {}
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal('ResizeObserver', ResizeObserverMock);

      if (typeof Selection.prototype.modify !== 'function') {
        patchedSelectionModify = true;
        Selection.prototype.modify = function (
          this: Selection,
          alter: string,
          direction: string,
          granularity: string,
        ): void {
          const node = this.anchorNode;
          if (
            node?.nodeType !== Node.TEXT_NODE ||
            direction !== 'backward' ||
            granularity !== 'character'
          ) {
            return;
          }
          const text = node as Text;
          const o = this.focusOffset;
          if (o <= 0) {
            return;
          }
          if (alter === 'extend') {
            this.setBaseAndExtent(text, o - 1, text, o);
          } else if (alter === 'move') {
            this.setBaseAndExtent(text, o - 1, text, o - 1);
          }
        };
      }
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      if (patchedSelectionModify) {
        delete (Selection.prototype as {modify?: unknown}).modify;
        patchedSelectionModify = false;
      }
    });

    it('awaits async onClose before unmounting the menu', async () => {
      const editorRef = React.createRef<LexicalEditor>();

      let resolveOnClose!: () => void;
      const onClose = vi.fn(
        () =>
          new Promise<void>(resolve => {
            resolveOnClose = resolve;
          }),
      );

      const menuRenderFn: MenuRenderFn<TestMenuOption> = (
        anchorElementRef,
        itemProps,
        matchingString,
      ) => {
        return anchorElementRef.current && itemProps.options.length
          ? ReactDOM.createPortal(
              <div
                className="custom-typeahead-menu"
                data-testid="custom-typeahead">
                <ul>
                  {itemProps.options.map((option, i) => (
                    <li
                      key={option.key}
                      data-selected={itemProps.selectedIndex === i}
                      className="custom-item">
                      {option.title}
                    </li>
                  ))}
                </ul>
                {matchingString != null && (
                  <span data-testid="matching-string">{matchingString}</span>
                )}
              </div>,
              anchorElementRef.current,
            )
          : null;
      };

      function Harness() {
        const checkForTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
          minLength: 0,
        });
        const onSelectOption = useCallback(
          (
            _option: TestMenuOption,
            _nodeToRemove: TextNode | null,
            closeMenu: () => void,
          ) => {
            closeMenu();
          },
          [],
        );
        return (
          <LexicalTypeaheadMenuPlugin<TestMenuOption>
            onQueryChange={vi.fn()}
            onSelectOption={onSelectOption}
            triggerFn={checkForTriggerMatch}
            options={TEST_OPTIONS}
            menuRenderFn={menuRenderFn}
            onClose={onClose}
          />
        );
      }

      const App = createApp(
        <>
          <EditorRefPlugin editorRef={editorRef} />
          <Harness />
        </>,
        [ParagraphNode],
      );

      await act(async () => {
        reactRoot.render(<App />);
      });

      const editor = editorRef.current;
      expect(editor).not.toBeNull();

      await act(async () => {
        editor!.update(() => {
          $getRoot()
            .clear()
            .append($createParagraphNode())
            .select()
            .insertText('/');
        });
      });

      expect(
        document.querySelector('[data-testid="custom-typeahead"]'),
      ).not.toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => {
        editor!.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
        await Promise.resolve();
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(
        document.querySelector('[data-testid="custom-typeahead"]'),
      ).not.toBeNull();

      await act(async () => {
        resolveOnClose();
        await Promise.resolve();
      });

      expect(
        document.querySelector('[data-testid="custom-typeahead"]'),
      ).toBeNull();
    });

    it('runs synchronous onClose before clearing the menu', async () => {
      const editorRef = React.createRef<LexicalEditor>();
      const callOrder: string[] = [];

      const onClose = vi.fn(() => {
        callOrder.push('onClose');
      });

      const menuRenderFn: MenuRenderFn<TestMenuOption> = (
        anchorElementRef,
        itemProps,
        matchingString,
      ) => {
        return anchorElementRef.current && itemProps.options.length
          ? ReactDOM.createPortal(
              <div
                className="custom-typeahead-menu"
                data-testid="custom-typeahead">
                <ul />
                {matchingString != null && (
                  <span data-testid="matching-string">{matchingString}</span>
                )}
              </div>,
              anchorElementRef.current,
            )
          : null;
      };

      function Harness() {
        const checkForTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
          minLength: 0,
        });
        const onSelectOption = useCallback(
          (
            _option: TestMenuOption,
            _nodeToRemove: TextNode | null,
            closeMenu: () => void,
          ) => {
            closeMenu();
          },
          [],
        );
        return (
          <LexicalTypeaheadMenuPlugin<TestMenuOption>
            onQueryChange={vi.fn()}
            onSelectOption={onSelectOption}
            triggerFn={checkForTriggerMatch}
            options={TEST_OPTIONS}
            menuRenderFn={menuRenderFn}
            onClose={onClose}
          />
        );
      }

      const App = createApp(
        <>
          <EditorRefPlugin editorRef={editorRef} />
          <Harness />
        </>,
        [ParagraphNode],
      );

      await act(async () => {
        reactRoot.render(<App />);
      });

      const editor = editorRef.current;
      expect(editor).not.toBeNull();

      await act(async () => {
        editor!.update(() => {
          $getRoot()
            .clear()
            .append($createParagraphNode())
            .select()
            .insertText('/');
        });
      });

      await act(async () => {
        editor!.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
        await Promise.resolve();
      });

      expect(callOrder).toEqual(['onClose']);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(
        document.querySelector('[data-testid="custom-typeahead"]'),
      ).toBeNull();
    });
  });

  describe('IME composition', () => {
    beforeEach(() => {
      class ResizeObserverMock {
        constructor(_callback: unknown) {}
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const menuRenderFn: MenuRenderFn<TestMenuOption> = (
      anchorElementRef,
      itemProps,
      matchingString,
    ) => {
      return anchorElementRef.current && itemProps.options.length
        ? ReactDOM.createPortal(
            <div
              className="custom-typeahead-menu"
              data-testid="custom-typeahead">
              <ul />
              {matchingString != null && (
                <span data-testid="matching-string">{matchingString}</span>
              )}
            </div>,
            anchorElementRef.current,
          )
        : null;
    };

    function Harness({
      onQueryChange = vi.fn(),
      onClose,
    }: {
      onQueryChange?: (matchingString: string | null) => void;
      onClose?: () => void;
    }) {
      const checkForTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
        minLength: 0,
      });
      const onSelectOption = useCallback(
        (
          _option: TestMenuOption,
          _nodeToRemove: TextNode | null,
          closeMenu: () => void,
        ) => {
          closeMenu();
        },
        [],
      );
      return (
        <LexicalTypeaheadMenuPlugin<TestMenuOption>
          onQueryChange={onQueryChange}
          onSelectOption={onSelectOption}
          triggerFn={checkForTriggerMatch}
          options={TEST_OPTIONS}
          menuRenderFn={menuRenderFn}
          onClose={onClose}
        />
      );
    }

    function $insertTrigger(): void {
      $getRoot()
        .clear()
        .append($createParagraphNode())
        .select()
        .insertText('/');
    }

    function $getQueryTextNode(): TextNode {
      const textNode = $getRoot().getFirstDescendant();
      if (!$isTextNode(textNode)) {
        throw new Error('expected a text node holding the query');
      }
      return textNode;
    }

    function $compose(text: string): void {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        throw new Error('expected a range selection');
      }
      selection.insertText(text);
      $setCompositionKey(selection.anchor.key);
    }

    function $dropTriggerWhileComposing(): void {
      const textNode = $getQueryTextNode();
      textNode.setTextContent('햄');
      $setCompositionKey(textNode.getKey());
    }

    async function mountAndCompose(
      props: React.ComponentProps<typeof Harness>,
    ): Promise<LexicalEditor> {
      const editorRef = React.createRef<LexicalEditor>();
      const App = createApp(
        <>
          <EditorRefPlugin editorRef={editorRef} />
          <Harness {...props} />
        </>,
        [ParagraphNode],
      );

      await act(async () => {
        reactRoot.render(<App />);
      });

      const editor = editorRef.current;
      if (editor === null) {
        throw new Error('expected the editor ref to be populated');
      }

      await act(async () => {
        editor.update($insertTrigger);
      });

      await act(async () => {
        editor.update(() => $compose('햄'));
      });

      return editor;
    }

    it('reports the query while composing without closing the menu', async () => {
      const onQueryChange = vi.fn();
      const editorRef = React.createRef<LexicalEditor>();
      const App = createApp(
        <>
          <EditorRefPlugin editorRef={editorRef} />
          <Harness onQueryChange={onQueryChange} />
        </>,
        [ParagraphNode],
      );

      await act(async () => {
        reactRoot.render(<App />);
      });

      const editor = editorRef.current;
      expect(editor).not.toBeNull();

      await act(async () => {
        editor!.update($insertTrigger);
      });

      expect(
        document.querySelector('[data-testid="custom-typeahead"]'),
      ).not.toBeNull();

      onQueryChange.mockClear();

      await act(async () => {
        editor!.update(() => $compose('햄'));
      });

      expect(editor!.isComposing()).toBe(true);
      expect(onQueryChange).toHaveBeenCalledWith('햄');
      expect(
        document.querySelector('[data-testid="custom-typeahead"]'),
      ).not.toBeNull();
      expect(
        document.querySelector('[data-testid="matching-string"]')?.textContent,
      ).toBe('햄');
    });

    it('keeps the menu open when the trigger match is lost while composing', async () => {
      const onClose = vi.fn();
      const editor = await mountAndCompose({onClose});

      await act(async () => {
        editor.update($dropTriggerWhileComposing);
      });

      expect(editor.isComposing()).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
      expect(
        document.querySelector('[data-testid="custom-typeahead"]'),
      ).not.toBeNull();
    });

    it('closes the menu once composition ends without a trigger match', async () => {
      const onClose = vi.fn();
      const editor = await mountAndCompose({onClose});

      await act(async () => {
        editor.update($dropTriggerWhileComposing);
      });

      expect(
        document.querySelector('[data-testid="custom-typeahead"]'),
      ).not.toBeNull();

      await act(async () => {
        editor.update(() => {
          $setCompositionKey(null);
          $getQueryTextNode().markDirty();
        });
        await Promise.resolve();
      });

      expect(editor.isComposing()).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(
        document.querySelector('[data-testid="custom-typeahead"]'),
      ).toBeNull();
    });
  });
});
