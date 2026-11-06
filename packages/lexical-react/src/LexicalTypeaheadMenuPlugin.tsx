/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  type CommandListenerPriority,
  getDOMSelection,
  getDOMSelectionPoints,
  type LexicalEditor,
  type RangeSelection,
  type TextNode,
} from 'lexical';
import {
  type JSX,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  LexicalMenu,
  MenuOption,
  type MenuRenderFn,
  type MenuResolution,
  type MenuTextMatch,
  type TriggerFn,
  useMenuAnchorRef,
} from './shared/LexicalMenu';

function getTextUpToAnchor(selection: RangeSelection): string | null {
  const anchor = selection.anchor;
  if (anchor.type !== 'text') {
    return null;
  }
  const anchorNode = anchor.getNode();
  if (!anchorNode.isSimpleText()) {
    return null;
  }
  const anchorOffset = anchor.offset;
  return anchorNode.getTextContent().slice(0, anchorOffset);
}

function tryToPositionRange(
  leadOffset: number,
  range: Range,
  editorWindow: Window,
  rootElement: HTMLElement | null,
): boolean {
  const domSelection = getDOMSelection(editorWindow);
  if (domSelection === null || !domSelection.isCollapsed) {
    return false;
  }
  const points = getDOMSelectionPoints(domSelection, rootElement);
  const anchorNode = points.anchorNode;
  const startOffset = leadOffset;
  const endOffset = points.anchorOffset;

  if (anchorNode == null || endOffset == null) {
    return false;
  }

  try {
    range.setStart(anchorNode, startOffset);
    range.setEnd(anchorNode, endOffset);
  } catch (_error) {
    return false;
  }

  return true;
}

function getQueryTextForSearch(editor: LexicalEditor): string | null {
  let text = null;
  editor.read('latest', () => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return;
    }
    text = getTextUpToAnchor(selection);
  });
  return text;
}

function isSelectionOnEntityBoundary(
  editor: LexicalEditor,
  offset: number,
): boolean {
  if (offset !== 0) {
    return false;
  }
  return editor.read('latest', () => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      const anchor = selection.anchor;
      const anchorNode = anchor.getNode();
      const prevSibling = anchorNode.getPreviousSibling();
      return $isTextNode(prevSibling) && prevSibling.isTextEntity();
    }
    return false;
  });
}

export {useDynamicPositioning} from './shared/LexicalMenu';
export {
  getScrollParent,
  PUNCTUATION,
  SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPluginUtils';

/**
 * Props for the {@link LexicalTypeaheadMenuPlugin} component.
 */
export type TypeaheadMenuPluginProps<TOption extends MenuOption> = {
  onQueryChange: (matchingString: string | null) => void;
  onSelectOption: (
    option: TOption,
    textNodeContainingQuery: TextNode | null,
    closeMenu: () => void,
    matchingString: string,
  ) => void;
  options: TOption[];
  triggerFn: TriggerFn;
  menuRenderFn?: MenuRenderFn<TOption>;
  onOpen?: (resolution: MenuResolution) => void;
  onClose?: () => void | PromiseLike<void>;
  anchorClassName?: string;
  commandPriority?: CommandListenerPriority;
  parent?: HTMLElement;
  preselectFirstItem?: boolean;
  ignoreEntityBoundary?: boolean;
};

/**
 * Renders a floating menu (such as an `@`-mention or slash-command picker) while
 * the text before the cursor matches `triggerFn`. As the user types, the
 * current query is reported via `onQueryChange`; supply the `options` to show
 * and an `onSelectOption` handler to apply the chosen option. Use
 * {@link useBasicTypeaheadTriggerMatch} to build a simple `triggerFn`.
 *
 * @returns The floating menu element, or `null` when no query is active.
 */
export function LexicalTypeaheadMenuPlugin<TOption extends MenuOption>({
  options,
  onQueryChange,
  onSelectOption,
  onOpen,
  onClose,
  menuRenderFn,
  triggerFn,
  anchorClassName,
  commandPriority = COMMAND_PRIORITY_LOW,
  parent,
  preselectFirstItem = true,
  ignoreEntityBoundary = false,
}: TypeaheadMenuPluginProps<TOption>): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [resolution, setResolution] = useState<MenuResolution | null>(null);
  const openGenerationRef = useRef(0);
  // Whether the menu is open as far as onOpen/onClose are concerned. Unlike
  // `resolution`, this sees an open whose transition has not rendered yet and
  // a close whose onClose promise is still pending.
  const isOpenRef = useRef(false);
  const closeTypeahead = useCallback(() => {
    if (!isOpenRef.current) {
      return;
    }
    isOpenRef.current = false;
    const openGeneration = openGenerationRef.current;
    const finish = () => {
      if (openGenerationRef.current === openGeneration) {
        setResolution(null);
      }
    };
    let result;
    try {
      result = onClose && onClose();
    } finally {
      if (result) {
        result.then(finish, finish);
      } else {
        finish();
      }
    }
  }, [onClose]);

  const openTypeahead = useCallback(
    (res: MenuResolution) => {
      // Track pending opens before their transition has rendered.
      openGenerationRef.current++;
      setResolution(res);
      if (!isOpenRef.current) {
        isOpenRef.current = true;
        if (onOpen != null) {
          onOpen(res);
        }
      }
    },
    [onOpen],
  );

  // LexicalMenu hides the menu when its anchor scrolls out of view. Route
  // that through closeTypeahead so onClose still pairs with onOpen.
  const setMenuResolution = useCallback(
    (res: MenuResolution | null) => {
      if (res === null) {
        closeTypeahead();
      } else {
        setResolution(res);
      }
    },
    [closeTypeahead],
  );
  const anchorElementRef = useMenuAnchorRef(
    resolution,
    setMenuResolution,
    anchorClassName,
    parent,
  );

  useEffect(() => {
    const updateListener = () => {
      editor.read('latest', () => {
        // Check if editor is in read-only mode
        if (!editor.isEditable()) {
          closeTypeahead();
          return;
        }

        const closeUnlessComposing = () => {
          if (!editor.isComposing()) {
            closeTypeahead();
          }
        };

        const editorWindow = editor._window || window;
        const range = editorWindow.document.createRange();
        const selection = $getSelection();
        const text = getQueryTextForSearch(editor);

        if (
          !$isRangeSelection(selection) ||
          !selection.isCollapsed() ||
          text === null ||
          range === null
        ) {
          closeUnlessComposing();
          return;
        }

        const match = triggerFn(text, editor);
        onQueryChange(match ? match.matchingString : null);

        if (
          match !== null &&
          (ignoreEntityBoundary ||
            !isSelectionOnEntityBoundary(editor, match.leadOffset))
        ) {
          const isRangePositioned = tryToPositionRange(
            match.leadOffset,
            range,
            editorWindow,
            editor.getRootElement(),
          );
          if (isRangePositioned) {
            startTransition(() =>
              openTypeahead({
                getRect: () => range.getBoundingClientRect(),
                match,
              }),
            );
            return;
          }
        }
        closeUnlessComposing();
      });
    };

    const removeUpdateListener = editor.registerUpdateListener(updateListener);

    return () => {
      removeUpdateListener();
    };
  }, [
    editor,
    triggerFn,
    onQueryChange,
    resolution,
    closeTypeahead,
    openTypeahead,
    ignoreEntityBoundary,
  ]);

  useEffect(
    () =>
      editor.registerEditableListener(isEditable => {
        if (!isEditable) {
          closeTypeahead();
        }
      }),
    [editor, closeTypeahead],
  );

  return resolution === null ||
    editor === null ||
    anchorElementRef.current === null ? null : (
    <LexicalMenu
      close={closeTypeahead}
      resolution={resolution}
      editor={editor}
      anchorElementRef={anchorElementRef}
      options={options}
      menuRenderFn={menuRenderFn}
      shouldSplitNodeWithQuery={true}
      onSelectOption={onSelectOption}
      commandPriority={commandPriority}
      preselectFirstItem={preselectFirstItem}
    />
  );
}

export {MenuOption, MenuRenderFn, MenuResolution, MenuTextMatch, TriggerFn};
