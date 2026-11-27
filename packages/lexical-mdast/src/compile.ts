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

import {
  cjkFriendlyEmphasis,
  cjkFriendlyStrikethrough,
  probeLayout,
  strictEmphasis,
} from './cjkFriendly';

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

/**
 * Whether `extension` holds a CJK-friendly variant, as the syntax from
 * {@link getStrikethroughSyntax} does and a copy of it does not.
 *
 * @internal
 */
export function hasCjkFriendlyVariant(extension: MicromarkExtension): boolean {
  return Object.prototype.hasOwnProperty.call(extension, CJK_FRIENDLY_VARIANT);
}

// The key under which a micromark extension is marked by
// {@link referenceAgnostic}. Not enumerable, so micromark does not read it as
// a hook.
const REFERENCE_AGNOSTIC = '__lexicalReferenceAgnostic';

/**
 * The syntax that `factory` makes, marked as one that, in what an export
 * writes, matches beside a character reference with a `*` or `~` run on its
 * other side as it does beside the character that the reference stands for,
 * so that a CJK-friendly export writes such a reference beside the ASCII
 * punctuation that the syntax starts with as that character. A copy of the
 * syntax, such as a spread of it, is not marked, and the reference stays.
 *
 * @internal
 * @__NO_SIDE_EFFECTS__
 */
export function referenceAgnostic(
  factory: () => MicromarkExtension,
): MicromarkExtension {
  return Object.defineProperty(factory(), REFERENCE_AGNOSTIC, {value: true});
}

/** Whether {@link referenceAgnostic} marked `extension`. */
export function isReferenceAgnostic(extension: MicromarkExtension): boolean {
  return (
    (extension as {[REFERENCE_AGNOSTIC]?: true})[REFERENCE_AGNOSTIC] === true
  );
}

/**
 * Whether {@link referenceAgnostic} marked `extension` itself, not one it is
 * made from, which the cmark-gfm pass's model of micromark asks: a syntax
 * made from a marked one may replace its hooks.
 *
 * @internal
 */
export function isOwnReferenceAgnostic(extension: MicromarkExtension): boolean {
  return Object.prototype.hasOwnProperty.call(extension, REFERENCE_AGNOSTIC);
}

// The key under which a micromark extension is marked by
// {@link referenceNeutral}. Not enumerable, so micromark does not read it as
// a hook.
const REFERENCE_NEUTRAL = '__lexicalReferenceNeutral';

/**
 * The syntax that `factory` makes, marked as one whose constructs read a
 * document alike when a character other than ASCII punctuation is written
 * as a character reference, beside a marker or anywhere else, so that the
 * cmark-gfm pass of a strict export may judge its edits with its model of
 * micromark rather than by parsing. A copy of the syntax is not marked.
 *
 * @internal
 * @__NO_SIDE_EFFECTS__
 */
export function referenceNeutral(
  factory: () => MicromarkExtension,
): MicromarkExtension {
  return Object.defineProperty(factory(), REFERENCE_NEUTRAL, {value: true});
}

/**
 * Whether {@link referenceNeutral} marked `extension` itself: one made from
 * it, which may replace its hooks, is not marked.
 */
export function isReferenceNeutral(extension: MicromarkExtension): boolean {
  return Object.prototype.hasOwnProperty.call(extension, REFERENCE_NEUTRAL);
}

// The key under which a compiled registry holds the micromark extensions of
// a strict import, which a strict export reads its Markdown with whatever the
// import reads. Not enumerable, so a copy of the registry does not hold it.
const STRICT_SYNTAX = '__lexicalStrictSyntax';

/**
 * The micromark extensions that `compiled` reads Markdown with in a strict
 * import: the strict emphasis and the contributed syntax extensions as they
 * are, not their CJK-friendly variants. `null` for a registry that
 * {@link compileMdast} did not compile.
 *
 * @internal
 */
export function getStrictMicromarkExtensions(
  compiled: CompiledMdast,
): MicromarkExtension[] | null {
  return (
    (compiled as {[STRICT_SYNTAX]?: MicromarkExtension[]})[STRICT_SYNTAX] ||
    null
  );
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

  // Reads CJK-friendly by default, and any other mode strictly, as in
  // @lexical/markdown.
  const cjkFriendly =
    config.importPunctuation === undefined ||
    config.importPunctuation === 'cjk-friendly';
  if (cjkFriendly) {
    probeLayout();
  }
  // micromark tries the constructs of later extensions first, so the
  // emphasis goes first, before the extensions of the config, which may
  // handle markers of their own.
  const strictSyntax = [strictEmphasis(), ...config.micromarkExtensions];
  const compiled: CompiledMdast = {
    exportHandlers,
    exportPunctuation: config.exportPunctuation,
    importHandlers,
    inlineShortcutTriggers: new Set(config.inlineShortcutTriggers),
    inlineShortcutTypes: new Set(config.inlineShortcutTypes),
    mdastExtensions: [...config.mdastExtensions],
    micromarkExtensions: cjkFriendly
      ? [
          cjkFriendlyEmphasis(),
          ...config.micromarkExtensions.map(toCjkFriendlyVariant),
        ]
      : strictSyntax,
    toMarkdownExtensions: [...config.toMarkdownExtensions],
  };
  return Object.defineProperty(compiled, STRICT_SYNTAX, {value: strictSyntax});
}
