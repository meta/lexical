/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {getScrollParent as getScrollParent_} from '@lexical/utils';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  type CommandListenerPriority,
  createCommand,
  getDOMSelection,
  getDOMSelectionPoints,
  type LexicalCommand,
  type LexicalEditor,
  type RangeSelection,
  type TextNode,
} from 'lexical';
import {
  type JSX,
  startTransition,
  useCallback,
  useEffect,
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

/**
 * The default set of punctuation characters (as a character-class fragment)
 * that terminate a typeahead query. Used as the default `punctuation` option of
 * {@link useBasicTypeaheadTriggerMatch}.
 */
export const PUNCTUATION =
  '\\.,\\+\\*\\?\\$\\@\\|#{}\\(\\)\\^\\-\\[\\]\\\\/!%\'"~=<>_:;';

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
/** @deprecated Moved to `@lexical/utils`. Import `getScrollParent` from there. */
export const getScrollParent = getScrollParent_;

/**
 * Command dispatched while the typeahead menu is open to scroll the option at
 * the given `index` into view. The default menu renderer listens for it; custom
 * {@link MenuRenderFn}s can handle it to implement their own scrolling.
 */
export const SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND: LexicalCommand<{
  index: number;
  option: MenuOption;
}> = /* @__PURE__ */ createCommand('SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND');

/**
 * Builds a {@link TriggerFn} for the common case of a single-character
 * `trigger` (such as `@` or `#`) followed by a query. The returned function
 * matches when the trigger is preceded by whitespace or the start of the line
 * and is followed by between `minLength` and `maxLength` non-`punctuation`
 * characters (optionally allowing whitespace).
 *
 * @returns A memoized trigger function for {@link LexicalTypeaheadMenuPlugin}.
 */
export function useBasicTypeaheadTriggerMatch(
  trigger: string,
  {
    minLength = 1,
    maxLength = 75,
    punctuation = PUNCTUATION,
    allowWhitespace = false,
  }: {
    minLength?: number;
    maxLength?: number;
    punctuation?: string;
    allowWhitespace?: boolean;
  },
): TriggerFn {
  return useCallback(
    (text: string) => {
      const validCharsSuffix = allowWhitespace ? '' : '\\s';
      const validChars = '[^' + trigger + punctuation + validCharsSuffix + ']';
      const TypeaheadTriggerRegex = new RegExp(
        '(^|\\s|\\()(' +
          '[' +
          trigger +
          ']' +
          '((?:' +
          validChars +
          '){0,' +
          maxLength +
          '})' +
          ')$',
      );
      const match = TypeaheadTriggerRegex.exec(text);
      if (match !== null) {
        const maybeLeadingWhitespace = match[1];
        const matchingString = match[3];
        if (matchingString.length >= minLength) {
          return {
            leadOffset: match.index + maybeLeadingWhitespace.length,
            matchingString,
            replaceableString: match[2],
          };
        }
      }
      return null;
    },
    [allowWhitespace, trigger, punctuation, maxLength, minLength],
  );
}

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
  /**
   * Accessible label for the menu container.
   * Screen readers will announce this when the menu opens.
   * @default 'Typeahead menu'
   */
  menuAriaLabel?: string;
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
  menuAriaLabel,
}: TypeaheadMenuPluginProps<TOption>): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [resolution, setResolution] = useState<MenuResolution | null>(null);
  const anchorElementRef = useMenuAnchorRef(
    resolution,
    setResolution,
    anchorClassName,
    parent,
    true, // shouldIncludePageYOffset__EXPERIMENTAL
    menuAriaLabel,
  );

  const closeTypeahead = useCallback(() => {
    if (resolution === null) {
      return;
    }
    const finish = () => {
      setResolution(null);
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
  }, [onClose, resolution]);

  const openTypeahead = useCallback(
    (res: MenuResolution) => {
      setResolution(res);
      if (onOpen != null && resolution === null) {
        onOpen(res);
      }
    },
    [onOpen, resolution],
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
          if (isRangePositioned !== null) {
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
      ariaLabel={menuAriaLabel}
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
