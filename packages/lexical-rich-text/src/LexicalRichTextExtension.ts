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
  defaultShouldHandlePasteAsFiles,
  type EscapeFormatTriggerConfig,
  HeadingNode,
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

export const RichTextExtension = /* @__PURE__ */ defineExtension({
  build: (_editor, config) => namedSignals(config),
  config: /* @__PURE__ */ safeCast<RichTextConfig>(DEFAULT_RICH_TEXT_CONFIG),
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
    /* @__PURE__ */ configExtension(DOMImportExtension, {
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
 * Bundles {@link RichTextImportRules} together with the runtime
 * {@link RichTextExtension}.
 *
 * @experimental
 * @deprecated {@link RichTextExtension} now registers
 * {@link RichTextImportRules} (and `CoreImportExtension`) itself —
 * depend on it directly instead.
 */
export const RichTextImportExtension = /* @__PURE__ */ defineExtension({
  dependencies: [RichTextExtension],
  name: '@lexical/rich-text/Import',
});
