/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$isLinkNode, AutoLinkNode, LinkNode} from '@lexical/link';
import {
  type AutoEmbedOption,
  type EmbedConfig,
  INSERT_EMBED_COMMAND,
} from '@lexical/react/LexicalAutoEmbedPluginUtils';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  LexicalNodeMenuPlugin,
  type MenuRenderFn,
} from '@lexical/react/LexicalNodeMenuPlugin';
import {objectKlassEquals} from '@lexical/utils';
import {
  $getNodeByKey,
  $getSelection,
  $onUpdate,
  COMMAND_PRIORITY_BEFORE_EDITOR,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  type CommandListenerPriority,
  type LexicalNode,
  mergeRegister,
  type MutationListener,
  type NodeKey,
  PASTE_COMMAND,
  PASTE_TAG,
  type TextNode,
} from 'lexical';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export {
  AutoEmbedOption,
  type EmbedConfig,
  type EmbedMatchResult,
  INSERT_EMBED_COMMAND,
  URL_MATCHER,
} from '@lexical/react/LexicalAutoEmbedPluginUtils';

type LexicalAutoEmbedPluginProps<TEmbedConfig extends EmbedConfig> = {
  /**
   * An array of configurations used to insert Embed elements
   */
  embedConfigs: TEmbedConfig[];
  /**
   * Callback for handling the {@link INSERT_EMBED_COMMAND} command.
   * If no function is passed, the command is not registered
   * @param embedConfig - the config corresponding to the {@link EmbedConfig.type} of the inserted Embed
   * @returns
   */
  onOpenEmbedModalForConfig?: (embedConfig: TEmbedConfig) => void;
  /**
   * A function that links a specific configuration to a set of options.
   * Each option can be handling by click or press the Enter or Tab key
   * when the cursor hovers over it.
   * Pass the necessary callbacks to {@link AutoEmbedOption.onSelect}
   * @param activeEmbedConfig - the current active config is determined by a match
   * from the {@link EmbedConfig.parseUrl} of the inserted AutoLinkNode
   * @param embedFn - callback for handling option selection.
   * Calling the callback will invoke the {@link EmbedConfig.insertNode} method
   * and remove the inserted AutoLinkNode
   * @param dismissFn - сallback to deselect. Calling the callback will hide the options menu
   * @returns array of options from {@link AutoEmbedOption} instances
   */
  getMenuOptions: (
    activeEmbedConfig: TEmbedConfig,
    embedFn: () => void,
    dismissFn: () => void,
  ) => AutoEmbedOption[];
  /**
   * A function for rendering button menu.
   * By default, it displays a plain list with the option titles
   */
  menuRenderFn?: MenuRenderFn<AutoEmbedOption>;
  /**
   * Priority for key handling in the menu. The default is `COMMAND_PRIORITY_LOW`
   */
  menuCommandPriority?: CommandListenerPriority;
  /**
   * Optional predicate to suppress the menu for specific locations, e.g.
   * inside nodes that only accept inline content. It receives the matched
   * AutoLinkNode; if it returns true, the menu is not shown and the pasted
   * link is left as-is (the Tab/Enter/Esc handling is part of the menu,
   * so it is skipped too). The predicate can inspect the node's ancestors,
   * e.g. with `$getNearestNodeOfType` from `@lexical/utils`.
   */
  $disableMenuFor?: (node: LexicalNode) => boolean;
};

type EmbedMatch<TEmbedConfig extends EmbedConfig> = {
  embedConfig: TEmbedConfig;
  key: NodeKey;
  result: Parameters<TEmbedConfig['insertNode']>[1];
  url: string;
};

function $getCurrentLink(key: NodeKey, url: string): LinkNode | null {
  const linkNode = $getNodeByKey(key);
  return $isLinkNode(linkNode) &&
    linkNode.isAttached() &&
    linkNode.getURL() === url
    ? linkNode
    : null;
}

function $isMenuDisabledForNode(
  linkNode: LexicalNode,
  $disableMenuFor?: (node: LexicalNode) => boolean,
): boolean {
  return $disableMenuFor != null && $disableMenuFor(linkNode);
}

/**
 * Watches for pasted AutoLink nodes that match any of the provided embed configurations (e.g., YouTube, Twitter URLs).
 * When a match is found, it shows a menu offering to replace the link with an embedded node.
 *
 * You can pass a generic type to the plugin to extend {@link EmbedConfig}
 * with additional data in {@link EmbedMatchResult} that will be passed to the callbacks
 *
 * @example
 * Usage
 * ```tsx
 * interface CustomEmbedConfig extends EmbedConfig<{
 *   domain: string;
 *   oid?: string;
 * }> {
 *   // Icon for display.
 *   icon?: JSX.Element;
 *   // Embed a Figma Project.
 *   description?: string;
 * };
 *
 * return (
 *  <LexicalAutoEmbedPlugin<CustomEmbedConfig>
 *    embedConfigs={EmbedConfigs}
 *    getMenuOptions={getMenuOptions}
 *  />
 * );
 * ```
 */
export function LexicalAutoEmbedPlugin<TEmbedConfig extends EmbedConfig>({
  embedConfigs,
  onOpenEmbedModalForConfig,
  getMenuOptions,
  menuRenderFn,
  menuCommandPriority = COMMAND_PRIORITY_LOW,
  $disableMenuFor,
}: LexicalAutoEmbedPluginProps<TEmbedConfig>): JSX.Element | null {
  const [editor] = useLexicalComposerContext();

  const [embedMatch, setEmbedMatch] = useState<EmbedMatch<TEmbedConfig> | null>(
    null,
  );
  const nodeKey = embedMatch === null ? null : embedMatch.key;
  const activeEmbedConfig = embedMatch === null ? null : embedMatch.embedConfig;
  // Only the most recent paste may open the menu, even when an older
  // asynchronous parseUrl result resolves after a newer one.
  const latestCheckRef = useRef(0);

  const reset = useCallback(() => {
    setEmbedMatch(null);
  }, []);

  const checkIfLinkNodeIsEmbeddable = useCallback(
    async (key: NodeKey) => {
      const check = ++latestCheckRef.current;
      const url = editor.read('latest', function () {
        const linkNode = $getNodeByKey(key);
        if ($isLinkNode(linkNode)) {
          if ($isMenuDisabledForNode(linkNode, $disableMenuFor)) {
            return undefined;
          }
          return linkNode.getURL();
        }
      });
      if (url === undefined) {
        return;
      }
      // When several configs match, the last one wins, so check them from
      // the end and stop at the first match to call parseUrl no more often
      // than needed.
      for (let i = embedConfigs.length - 1; i >= 0; i--) {
        const embedConfig = embedConfigs[i];
        const result = await Promise.resolve(embedConfig.parseUrl(url));
        if (check !== latestCheckRef.current) {
          return;
        }
        if (result != null) {
          // Edits made while parseUrl was pending may not be committed yet,
          // and the link may have moved into a disabled location since
          if (
            editor.read('pending', () => {
              const linkNode = $getCurrentLink(key, url);
              return (
                linkNode !== null &&
                !$isMenuDisabledForNode(linkNode, $disableMenuFor)
              );
            })
          ) {
            setEmbedMatch({embedConfig, key, result, url});
          }
          return;
        }
      }
    },
    [$disableMenuFor, editor, embedConfigs],
  );

  useEffect(() => {
    let isSingleTokenPaste = false;
    const listener: MutationListener = (nodeMutations, {updateTags}) => {
      for (const [key, mutation] of nodeMutations) {
        if (
          mutation === 'created' &&
          updateTags.has(PASTE_TAG) &&
          isSingleTokenPaste
        ) {
          checkIfLinkNodeIsEmbeddable(key);
        } else if (key === nodeKey) {
          reset();
        }
      }
    };
    return mergeRegister(
      editor.registerCommand(
        PASTE_COMMAND,
        event => {
          isSingleTokenPaste =
            objectKlassEquals(event, ClipboardEvent) &&
            event.clipboardData !== null &&
            /^\S+$/.test(event.clipboardData.getData('text/plain'));
          if (isSingleTokenPaste) {
            $onUpdate(() => {
              isSingleTokenPaste = false;
            });
          }
          return false;
        },
        COMMAND_PRIORITY_BEFORE_EDITOR,
      ),
      ...[LinkNode, AutoLinkNode].map(Klass =>
        editor.registerMutationListener(Klass, listener, {
          skipInitialization: true,
        }),
      ),
    );
  }, [checkIfLinkNodeIsEmbeddable, editor, nodeKey, reset]);

  useEffect(() => {
    if (!onOpenEmbedModalForConfig) return;

    return editor.registerCommand(
      INSERT_EMBED_COMMAND,
      (embedConfigType: TEmbedConfig['type']) => {
        const embedConfig = embedConfigs.find(
          ({type}) => type === embedConfigType,
        );
        if (embedConfig) {
          onOpenEmbedModalForConfig(embedConfig);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor, embedConfigs, onOpenEmbedModalForConfig]);

  const embedLinkViaActiveEmbedConfig = useCallback(() => {
    if (embedMatch == null) {
      return;
    }
    const {embedConfig, key, result, url} = embedMatch;
    editor.update(() => {
      const linkNode = $getCurrentLink(key, url);
      if (linkNode === null) {
        return;
      }
      if (!$getSelection()) {
        linkNode.selectEnd();
      }
      embedConfig.insertNode(editor, result);
      if (linkNode.isAttached()) {
        linkNode.remove();
      }
    });
  }, [editor, embedMatch]);

  const options = useMemo(() => {
    return activeEmbedConfig != null && nodeKey != null
      ? getMenuOptions(activeEmbedConfig, embedLinkViaActiveEmbedConfig, reset)
      : [];
  }, [
    activeEmbedConfig,
    embedLinkViaActiveEmbedConfig,
    getMenuOptions,
    nodeKey,
    reset,
  ]);

  const onSelectOption = useCallback(
    (
      selectedOption: AutoEmbedOption,
      targetNode: TextNode | null,
      closeMenu: () => void,
    ) => {
      editor.update(() => {
        selectedOption.onSelect(targetNode);
        closeMenu();
      });
    },
    [editor],
  );

  return nodeKey != null ? (
    <LexicalNodeMenuPlugin<AutoEmbedOption>
      nodeKey={nodeKey}
      onClose={reset}
      onSelectOption={onSelectOption}
      options={options}
      menuRenderFn={menuRenderFn}
      commandPriority={menuCommandPriority}
    />
  ) : null;
}
