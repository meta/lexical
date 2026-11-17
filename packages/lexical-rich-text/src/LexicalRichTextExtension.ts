/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {DragonExtension} from '@lexical/dragon';
import {
  effect,
  namedSignals,
  NormalizeInlineElementsExtension,
  NormalizeTripleClickSelectionExtension,
} from '@lexical/extension';
import {CoreImportExtension, DOMImportExtension} from '@lexical/html';
import {
  configExtension,
  defineExtension,
  safeCast,
  shallowMergeConfig,
  type TextFormatType,
} from 'lexical';

import {HeadingAnnounceExtension} from './HeadingAnnounceExtension';
import {
  $createQuoteContainerNode,
  defaultShouldHandlePasteAsFiles,
  type EscapeFormatTriggerConfig,
  HeadingNode,
  QuoteContainerNode,
  QuoteNode,
  registerRichText,
  type ShouldHandlePasteAsFiles,
  type TriggerConfig,
} from './index';
import {RichTextImportRules} from './RichTextImportExtension';

/**
 * Configuration for {@link RichTextExtension}.
 *
 * @property escapeFormatTriggers - Per-format trigger configuration that
 *   controls which text formats are automatically cleared from the selection
 *   on specific user interactions.
 *
 *   Defaults to:
 *   ```ts
 *   {
 *     capitalize: {enter: true, space: true, tab: true},
 *     lowercase: {enter: true, space: true, tab: true},
 *     uppercase: {enter: true, space: true, tab: true},
 *   }
 *   ```
 *
 *   To opt in to escaping `code` formatting at text node boundaries:
 *   ```ts
 *   configExtension(RichTextExtension, {
 *     escapeFormatTriggers: {
 *       code: {onlyAtBoundary: true, enter: true, click: true, arrow: true},
 *     },
 *   })
 *   ```
 */
export interface RichTextConfig {
  escapeFormatTriggers: EscapeFormatTriggerConfig;
  shouldHandlePasteAsFiles: ShouldHandlePasteAsFiles;
}

const DEFAULT_RICH_TEXT_CONFIG: RichTextConfig = {
  escapeFormatTriggers: {
    capitalize: {enter: true, space: true, tab: true},
    lowercase: {enter: true, space: true, tab: true},
    uppercase: {enter: true, space: true, tab: true},
  },
  shouldHandlePasteAsFiles: defaultShouldHandlePasteAsFiles,
};

function mergeTriggerConfig(
  config: TriggerConfig | null | undefined,
  override: TriggerConfig | null | undefined,
): TriggerConfig | null | undefined {
  if (!config || override === null) {
    return override;
  }
  return shallowMergeConfig(config, override);
}

function mergeEscapeFormatTriggers(
  config: EscapeFormatTriggerConfig,
  overrides: EscapeFormatTriggerConfig,
) {
  const merged = shallowMergeConfig(config, overrides);
  for (const k of Object.keys(overrides) as TextFormatType[]) {
    merged[k] = mergeTriggerConfig(config[k], overrides[k]);
  }
  return merged;
}

function mergeRichTextConfig(
  config: RichTextConfig,
  overrides: Partial<RichTextConfig>,
): RichTextConfig {
  const merged = shallowMergeConfig(config, overrides);
  if (overrides.escapeFormatTriggers) {
    merged.escapeFormatTriggers = mergeEscapeFormatTriggers(
      config.escapeFormatTriggers,
      overrides.escapeFormatTriggers,
    );
  }
  return merged;
}

export const RichTextExtension = defineExtension({
  build: (_editor, config) => namedSignals(config),
  config: safeCast<RichTextConfig>(DEFAULT_RICH_TEXT_CONFIG),
  conflictsWith: ['@lexical/plain-text'],
  dependencies: [
    HeadingAnnounceExtension,
    DragonExtension,
    NormalizeInlineElementsExtension,
    NormalizeTripleClickSelectionExtension,
    // DOMImportExtension support for the nodes registered here. Inert
    // unless the editor routes HTML through the pipeline (e.g. via
    // ClipboardDOMImportExtension or $generateNodesFromDOMViaExtension).
    CoreImportExtension,
    configExtension(DOMImportExtension, {
      rules: RichTextImportRules,
    }),
  ],
  mergeConfig: mergeRichTextConfig,
  name: '@lexical/rich-text',
  nodes: () => [HeadingNode, QuoteNode],
  register: (editor, _config, state) =>
    effect(() => {
      const {escapeFormatTriggers, shouldHandlePasteAsFiles} =
        state.getOutput();
      return registerRichText(
        editor,
        escapeFormatTriggers,
        shouldHandlePasteAsFiles,
      );
    }),
});

/**
 * Registers {@link QuoteContainerNode}, a quote that holds blocks, next to
 * {@link QuoteNode}. Nothing creates one on its own: `$createQuoteNode()`,
 * the `<blockquote>` import and the Markdown `>` still build a `QuoteNode`.
 * Create containers with `$createQuoteContainerNode()`, import them with
 * {@link QuoteContainerRule}, or use
 * {@link QuoteContainerReplacementExtension} to make every quote a container.
 *
 * @experimental
 */
export const QuoteContainerExtension = defineExtension({
  dependencies: [RichTextExtension],
  name: '@lexical/rich-text/QuoteContainer',
  nodes: () => [QuoteContainerNode],
});

/**
 * Makes every quote of the editor a {@link QuoteContainerNode}, with a node
 * replacement of {@link QuoteNode}: `$createQuoteNode()`, the `<blockquote>`
 * import (HTML and paste), the Markdown `>` and JSON of type `'quote'` all
 * build a container, which then serializes as `'quote-container'`. A `quote`
 * that held inline content loads with that content in a paragraph, and one
 * that was a shadow root (`shadowRoot: true`) with the blocks it had.
 *
 * Loading rewrites the type, so JSON saved afterwards cannot be read by an
 * editor that does not register `QuoteContainerNode`.
 *
 * @experimental
 */
export const QuoteContainerReplacementExtension = defineExtension({
  dependencies: [QuoteContainerExtension],
  name: '@lexical/rich-text/QuoteContainerReplacement',
  nodes: () => [
    {
      replace: QuoteNode,
      with: () => $createQuoteContainerNode(),
      withKlass: QuoteContainerNode,
    },
  ],
});
