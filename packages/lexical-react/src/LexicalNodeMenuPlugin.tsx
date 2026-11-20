/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $getNodeByKey,
  COMMAND_PRIORITY_LOW,
  type CommandListenerPriority,
  type NodeKey,
  type TextNode,
} from 'lexical';
import * as React from 'react';
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
  type MenuStatusMessageFn,
  useMenuAnchorRef,
} from './shared/LexicalMenu';

/**
 * Props for the {@link LexicalNodeMenuPlugin} component.
 */
export type NodeMenuPluginProps<TOption extends MenuOption> = {
  onSelectOption: (
    option: TOption,
    textNodeContainingQuery: TextNode | null,
    closeMenu: () => void,
    matchingString: string,
  ) => void;
  options: TOption[];
  nodeKey: NodeKey | null;
  menuRenderFn?: MenuRenderFn<TOption>;
  onClose?: () => void;
  onOpen?: (resolution: MenuResolution) => void;
  anchorClassName?: string;
  commandPriority?: CommandListenerPriority;
  parent?: HTMLElement;
  /**
   * Accessible label for the menu.
   * Screen readers will announce this when the menu opens.
   * @default 'Typeahead menu'
   */
  menuAriaLabel?: string;
  /**
   * Replaces the spoken status line, for translation or to change the
   * wording. Return `null` to stay silent.
   */
  getStatusMessage?: MenuStatusMessageFn;
};

/**
 * Renders a floating menu anchored to a specific node (identified by
 * `nodeKey`), for example to offer actions on a just-inserted node. It is the
 * node-anchored counterpart to {@link LexicalTypeaheadMenuPlugin}: provide the
 * `options` to show and an `onSelectOption` handler, and the menu opens while
 * `nodeKey` refers to a node and closes when it becomes `null`.
 *
 * @returns The floating menu element, or `null` when the menu is closed.
 */
export function LexicalNodeMenuPlugin<TOption extends MenuOption>({
  options,
  nodeKey,
  onClose,
  onOpen,
  onSelectOption,
  menuRenderFn,
  anchorClassName,
  commandPriority = COMMAND_PRIORITY_LOW,
  parent,
  menuAriaLabel,
  getStatusMessage,
}: NodeMenuPluginProps<TOption>): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [resolution, setResolution] = useState<MenuResolution | null>(null);
  const anchorElementRef = useMenuAnchorRef(
    resolution,
    setResolution,
    anchorClassName,
    parent,
    true, // shouldIncludePageYOffset__EXPERIMENTAL
    menuAriaLabel,
    menuRenderFn != null,
  );

  const closeNodeMenu = useCallback(() => {
    setResolution(null);
    if (onClose != null && resolution !== null) {
      onClose();
    }
  }, [onClose, resolution]);

  const openNodeMenu = useCallback(
    (res: MenuResolution) => {
      setResolution(res);
      if (onOpen != null && resolution === null) {
        onOpen(res);
      }
    },
    [onOpen, resolution],
  );

  const positionOrCloseMenu = useCallback(() => {
    if (nodeKey) {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        const domElement = editor.getElementByKey(nodeKey);
        if (node != null && domElement != null) {
          if (resolution == null) {
            startTransition(() =>
              openNodeMenu({
                getRect: () => domElement.getBoundingClientRect(),
              }),
            );
          }
        }
      });
    } else if (nodeKey == null && resolution != null) {
      closeNodeMenu();
    }
  }, [closeNodeMenu, editor, nodeKey, openNodeMenu, resolution]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    positionOrCloseMenu();
  }, [positionOrCloseMenu, nodeKey]);

  useEffect(() => {
    if (nodeKey != null) {
      return editor.registerUpdateListener(({dirtyElements}) => {
        if (dirtyElements.get(nodeKey)) {
          positionOrCloseMenu();
        }
      });
    }
  }, [editor, positionOrCloseMenu, nodeKey]);

  return anchorElementRef.current === null ||
    resolution === null ||
    editor === null ? null : (
    <LexicalMenu
      ariaLabel={menuAriaLabel}
      getStatusMessage={getStatusMessage}
      close={closeNodeMenu}
      resolution={resolution}
      editor={editor}
      anchorElementRef={anchorElementRef}
      options={options}
      menuRenderFn={menuRenderFn}
      onSelectOption={onSelectOption}
      commandPriority={commandPriority}
    />
  );
}

export {MenuOption, MenuRenderFn, MenuResolution};
