/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  effect,
  namedSignals,
  type NamedSignalsOutput,
} from '@lexical/extension';
import {CoreImportExtension, DOMImportExtension} from '@lexical/html';
import {objectKlassEquals} from '@lexical/utils';
import {
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  configExtension,
  defineExtension,
  type LexicalEditor,
  mergeRegister,
  PASTE_COMMAND,
  shallowMergeConfig,
} from 'lexical';

import {
  $linkNodeTransform,
  $toggleLink,
  type LinkAttributes,
  LinkNode,
  TOGGLE_LINK_COMMAND,
} from './LexicalLinkNode';
import {LinkImportRules} from './LinkImportExtension';

export interface LinkConfig {
  /**
   * If this function is specified a {@link PASTE_COMMAND}
   * listener will be registered to wrap selected nodes
   * when a URL is pasted and `validateUrl(url)` returns true.
   * The default of `undefined` will not register this listener.
   *
   * In the implementation of {@link TOGGLE_LINK_COMMAND}
   * it will reject URLs that return false when specified.
   * The default of `undefined` will always accept URLs.
   */
  validateUrl: undefined | ((url: string) => boolean);
  /**
   * The default anchor tag attributes to use for
   * {@link TOGGLE_LINK_COMMAND}
   */
  attributes: undefined | LinkAttributes;
}

const defaultProps: LinkConfig = {
  attributes: undefined,
  validateUrl: undefined,
};

/** @internal */
export function registerLink(
  editor: LexicalEditor,
  stores: NamedSignalsOutput<LinkConfig>,
) {
  return mergeRegister(
    editor.registerNodeTransform(LinkNode, $linkNodeTransform),
    editor.registerCommand(
      TOGGLE_LINK_COMMAND,
      payload => {
        const validateUrl = stores.validateUrl.peek();
        const attributes = stores.attributes.peek();
        if (payload === null) {
          $toggleLink(null);
          return true;
        } else if (typeof payload === 'string') {
          if (validateUrl === undefined || validateUrl(payload)) {
            $toggleLink(payload, attributes);
            return true;
          }
          return false;
        } else {
          // Only the attributes the payload actually carries may override the
          // configured defaults. Destructuring `rel`/`target`/`title` and
          // spreading them unconditionally would write `undefined` over every
          // configured value, since an explicit `undefined` still shadows a
          // spread key.
          const {url, ...payloadAttributes} = payload;
          // Same gate as the string payload above: validateUrl is documented
          // as rejecting URLs for this command, not for one of its two shapes.
          if (validateUrl !== undefined && !validateUrl(url)) {
            return false;
          }
          $toggleLink(url, {...attributes, ...payloadAttributes});
          return true;
        }
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    effect(() => {
      const validateUrl = stores.validateUrl.value;
      if (!validateUrl) {
        return;
      }
      const attributes = stores.attributes.value;
      return editor.registerCommand(
        PASTE_COMMAND,
        event => {
          const selection = $getSelection();
          if (
            !$isRangeSelection(selection) ||
            selection.isCollapsed() ||
            !objectKlassEquals(event, ClipboardEvent)
          ) {
            return false;
          }
          if (event.clipboardData === null) {
            return false;
          }
          const clipboardText = event.clipboardData.getData('text');
          if (!validateUrl(clipboardText)) {
            return false;
          }
          // Skip link wrapping for non-simple text nodes (e.g. code blocks).
          const nodes = selection.getNodes();
          if (
            !nodes.some(
              node =>
                $isElementNode(node) ||
                ($isTextNode(node) && !node.isSimpleText()),
            )
          ) {
            editor.dispatchCommand(TOGGLE_LINK_COMMAND, {
              ...attributes,
              url: clipboardText,
            });
            event.preventDefault();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      );
    }),
  );
}

/**
 * Provides {@link LinkNode}, an implementation of
 * {@link TOGGLE_LINK_COMMAND}, and a {@link PASTE_COMMAND}
 * listener to wrap selected nodes in a link when a
 * URL is pasted and `validateUrl` is defined.
 */
export const LinkExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: defaultProps,
  dependencies: [
    // DOMImportExtension support for the nodes registered here. Inert
    // unless the editor routes HTML through the pipeline (e.g. via
    // ClipboardDOMImportExtension or $generateNodesFromDOMViaExtension).
    CoreImportExtension,
    configExtension(DOMImportExtension, {
      rules: LinkImportRules,
    }),
  ],
  mergeConfig(config, overrides) {
    const merged = shallowMergeConfig(config, overrides);
    if (config.attributes) {
      merged.attributes = shallowMergeConfig(
        config.attributes,
        merged.attributes,
      );
    }
    return merged;
  },
  name: '@lexical/link/Link',
  nodes: () => [LinkNode],
  register(editor, config, state) {
    return registerLink(editor, state.getOutput());
  },
});

/**
 * Bundles {@link LinkImportRules} together with the runtime
 * {@link LinkExtension}.
 *
 * @experimental
 * @deprecated {@link LinkExtension} now registers
 * {@link LinkImportRules} (and `CoreImportExtension`) itself — depend on
 * it directly instead.
 */
export const LinkImportExtension = defineExtension({
  dependencies: [LinkExtension],
  name: '@lexical/link/Import',
});
