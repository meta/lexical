/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {MdastConfig} from './MdastExtension';
import type {CompiledMdast, MdastExportHandler, MdastExportRule} from './types';
import type {LexicalEditor} from 'lexical';
import type {Extension as MicromarkExtension} from 'micromark-util-types';

import invariant from '@lexical/internal/invariant';
import {getStaticNodeConfig, iterStaticNodeConfigChain} from 'lexical';
import {gfmStrikethrough} from 'micromark-extension-gfm-strikethrough';

import {cjkFriendlyEmphasis, cjkFriendlyStrikethrough} from './cjkFriendly';

// The key under which a micromark extension holds the factory of the one a
// CJK-friendly import uses in its place. Not enumerable, so micromark does
// not read it as a hook.
const CJK_FRIENDLY_VARIANT = '__lexicalCjkFriendlyVariant';

/**
 * The GFM strikethrough syntax that `MdastStrikethroughExtension`
 * contributes, which a CJK-friendly import swaps for its own.
 *
 * @internal
 * @__NO_SIDE_EFFECTS__
 */
export function getStrikethroughSyntax(): MicromarkExtension {
  const syntax = gfmStrikethrough();
  return Object.defineProperty(syntax, CJK_FRIENDLY_VARIANT, {
    value: () => cjkFriendlyStrikethrough(syntax),
  });
}

/** The extension a CJK-friendly import uses in place of `extension`. */
function toCjkFriendlyVariant(
  extension: MicromarkExtension,
): MicromarkExtension {
  const variant = (
    extension as {[CJK_FRIENDLY_VARIANT]?: () => MicromarkExtension}
  )[CJK_FRIENDLY_VARIANT];
  return variant ? variant() : extension;
}

function getExportRuleType(klass: MdastExportRule['type']): string {
  if (typeof klass === 'string') {
    return klass;
  }
  const {ownNodeType, ownNodeConfig, declaresOwnConfig} =
    getStaticNodeConfig(klass);
  // Without an own $config(), a resolved config belongs to an ancestor.
  // A legacy static getType() can declare a distinct type with no config.
  // Checking metadata also works after Lexical synthesizes a getType().
  invariant(
    ownNodeType !== undefined &&
      (declaresOwnConfig || ownNodeConfig === undefined),
    'MdastExtension: export rule node classes must have their own type.',
  );
  return ownNodeType;
}

/**
 * Compiles the raw contribution arrays held in {@link MdastConfig} into the
 * indexed registry used at runtime. Rules earlier in the arrays win for a
 * given node `type`; since {@link MdastExtension}'s `mergeConfig` prepends the
 * rules contributed by extensions merged later (closer to the editor root),
 * those higher-priority rules take precedence — mirroring the dispatch order
 * of `@lexical/html`'s `DOMImportExtension`. Export rules also apply to
 * subclasses, with the nearest ancestor's rules taking precedence. Handlers
 * can delegate to the remaining rules with context.next().
 */
export function compileMdast(
  editor: LexicalEditor,
  config: MdastConfig,
): CompiledMdast {
  const importHandlers: CompiledMdast['importHandlers'] = new Map();

  for (const rule of config.importRules) {
    const handlers = importHandlers.get(rule.type);
    if (handlers) {
      handlers.push(rule.$import);
    } else {
      importHandlers.set(rule.type, [rule.$import]);
    }
  }
  const exportRules: CompiledMdast['exportHandlers'] = new Map();
  for (const rule of config.exportRules) {
    // Class and string rules for the same type share contribution priority.
    const type = getExportRuleType(rule.type);
    const handlers = exportRules.get(type);
    if (handlers) {
      handlers.push(rule.$export);
    } else {
      exportRules.set(type, [rule.$export]);
    }
  }
  const exportHandlers = new Map(exportRules);
  // Resolve rules against the editor's registered node classes, including
  // replacement classes. Same-type rules precede ancestor rules, and each
  // type contributes once even when multiple classes in the chain share it.
  for (const [type, {klass}] of editor._nodes) {
    const handlers: MdastExportHandler[] = [];
    const seenTypes = new Set<string>();
    for (const {ownNodeType} of iterStaticNodeConfigChain(klass)) {
      if (ownNodeType !== undefined && !seenTypes.has(ownNodeType)) {
        seenTypes.add(ownNodeType);
        handlers.push(...(exportRules.get(ownNodeType) || []));
      }
    }
    if (handlers.length > 0) {
      exportHandlers.set(type, handlers);
    }
  }

  return {
    exportHandlers,
    exportPunctuation: config.exportPunctuation,
    importHandlers,
    inlineShortcutTriggers: new Set(config.inlineShortcutTriggers),
    inlineShortcutTypes: new Set(config.inlineShortcutTypes),
    mdastExtensions: [...config.mdastExtensions],
    // micromark tries the constructs of later extensions first, so the
    // CJK-friendly emphasis goes first, before the extensions of the config,
    // which may handle markers of their own.
    micromarkExtensions:
      // Any mode but the CJK-friendly one reads strictly, as in
      // @lexical/markdown.
      (config.importPunctuation || 'cjk-friendly') !== 'cjk-friendly'
        ? [...config.micromarkExtensions]
        : [
            cjkFriendlyEmphasis(),
            ...config.micromarkExtensions.map(toCjkFriendlyVariant),
          ],
    toMarkdownExtensions: [...config.toMarkdownExtensions],
  };
}
