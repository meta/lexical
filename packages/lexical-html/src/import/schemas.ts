/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {ChildSchema} from './types';

import {
  $createParagraphNode,
  $isBlockElementNode,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  type ElementNode,
  isHTMLElement,
  type LexicalNode,
} from 'lexical';

import {isAlignmentValue} from './coreImportRules';

/**
 * True if the node fills a block slot at the root or inside another
 * block — covers both ElementNode-style blocks (paragraph, heading,
 * quote) and block-level DecoratorNodes (HorizontalRuleNode,
 * ImageNode-as-block, etc.). Used by {@link BlockSchema},
 * {@link RootSchema}, and {@link NestedBlockSchema}.
 */
export function $isBlockLevel(node: LexicalNode): boolean {
  return (
    $isBlockElementNode(node) || ($isDecoratorNode(node) && !node.isInline())
  );
}

/**
 * Distribute an inline wrapper (`LinkNode`, `MarkNode`, …) across a
 * heterogeneous run of children produced by `$importChildren`, lifting
 * any block children to the top level while keeping the wrapper around
 * the leaf inline content.
 *
 * Use from a rule whose DOM source is an inline element that the
 * browser permitted to enclose block elements — the canonical case is
 * `<a href="…"><h1>title</h1><div>body</div></a>`, which a link rule
 * wants to surface as two block siblings (heading + paragraph), each
 * with its own link wrapping the original inline content. Schemas
 * can't express this because they reason about a parent's children
 * only — they cannot lift the parent out of itself.
 *
 * For each top-level child:
 * - **Inline children** are collected into runs; each run is wrapped
 *   in a single fresh wrapper (from `$makeWrapper()`).
 * - **Block children** are descended into: their own children are
 *   recursively distributed with `$makeWrapper`, then re-attached so
 *   the block keeps its position at the top level.
 *
 * The returned list will contain a mix of blocks and wrapped inline
 * runs. The enclosing schema (typically {@link BlockSchema}) will
 * then package those inline wrappers into paragraphs as usual.
 */
export function $distributeInlineWrapper(
  children: readonly LexicalNode[],
  $makeWrapper: () => ElementNode,
): LexicalNode[] {
  const out: LexicalNode[] = [];
  let inlineRun: LexicalNode[] = [];

  const flushInline = () => {
    if (inlineRun.length === 0) {
      return;
    }
    out.push($makeWrapper().splice(0, 0, inlineRun));
    inlineRun = [];
  };

  for (const child of children) {
    if ($isBlockLevel(child)) {
      flushInline();
      // Recursively distribute the wrapper into the block's own
      // children. A block DecoratorNode (no children) is left alone.
      if ($isElementNode(child)) {
        const wrapped = $distributeInlineWrapper(
          child.getChildren(),
          $makeWrapper,
        );
        child.splice(0, child.getChildrenSize(), wrapped);
      }
      out.push(child);
    } else {
      inlineRun.push(child);
    }
  }
  flushInline();
  return out;
}

/**
 * Apply a {@link ChildSchema} to a flat list of children produced by
 * `$importChildren`. Walks the list once, partitions into accepted vs.
 * rejected runs, packages or drops rejected runs, then runs `$finalize`.
 *
 * @internal
 */
export function $applySchema(
  schema: ChildSchema,
  children: LexicalNode[],
  parent: LexicalNode | null,
  domParent: Node | null,
): LexicalNode[] {
  const out: LexicalNode[] = [];
  let run: LexicalNode[] | null = null;

  const flushRun = () => {
    if (run === null) {
      return;
    }
    const rejected = run;
    run = null;
    if (schema.$packageRun) {
      const packaged = schema.$packageRun(rejected, parent, domParent);
      if (packaged.length > 0) {
        for (const n of packaged) {
          out.push(n);
        }
        return;
      }
    }
    // No $packageRun (or it returned []) — apply onReject. 'drop' (default)
    // discards the run. 'hoist' lets it through unchanged at this level.
    if (schema.onReject === 'hoist') {
      for (const n of rejected) {
        out.push(n);
      }
    }
  };

  for (const child of children) {
    if (schema.$accepts(child, parent)) {
      flushRun();
      out.push(child);
    } else {
      if (run === null) {
        run = [];
      }
      run.push(child);
    }
  }
  flushRun();

  return schema.$finalize ? schema.$finalize(out, parent) : out;
}

/**
 * Apply a parent DOM element's `text-align` (when set to one of the
 * supported {@link ElementFormatType} values) to each block-level child
 * Lexical node that does not yet have its own format.
 *
 * Mirrors the part of the legacy `$wrapContinuousInlines` that wrote
 * `node.setFormat(textAlign)` onto pre-existing block children when the
 * DOM parent carried `style.textAlign`. Pair with
 * {@link $paragraphPackageRun} (which carries the same propagation onto
 * paragraphs synthesized around inline runs) to fully replicate the
 * legacy behavior on a run of mixed children.
 */
export function $propagateTextAlignToBlockChildren(
  children: LexicalNode[],
  domParent: Node | null,
): LexicalNode[] {
  if (!isHTMLElement(domParent)) {
    return children;
  }
  const textAlign = domParent.style.textAlign;
  if (!isAlignmentValue(textAlign)) {
    return children;
  }
  for (const child of children) {
    if ($isBlockElementNode(child) && child.getFormatType() === '') {
      child.setFormat(textAlign);
    }
  }
  return children;
}

/**
 * Wrap a run of inline lexical nodes in a fresh paragraph, propagating the
 * `text-align` of `domParent` as the paragraph's format type (matching the
 * legacy `$wrapContinuousInlines` behavior).
 */
function $paragraphPackageRun(
  run: LexicalNode[],
  _parent: LexicalNode | null,
  domParent: Node | null,
): LexicalNode[] {
  // Mirror the legacy `$wrapInlineNodes` (driven by
  // `selection.insertNodes`) shortcut where a lone `<br>` at this
  // level (a `LineBreakNode` is the only thing in the rejected run)
  // becomes an *empty* paragraph rather than a paragraph wrapping a
  // visible line break — that's the form clipboard pastes ending in a
  // trailing `<br>` (Google Docs, Gmail, …) rely on for the editor's
  // "extra trailing empty line" expectation.
  if (run.length === 1 && $isLineBreakNode(run[0])) {
    run = [];
  }
  const paragraph = $createParagraphNode();
  if (isHTMLElement(domParent)) {
    const textAlign = domParent.style.textAlign;
    if (isAlignmentValue(textAlign)) {
      paragraph.setFormat(textAlign);
    }
  }
  return [paragraph.splice(0, 0, run)];
}

/**
 * Default schema for block-level positions (root of the document, the body
 * of a block element node). Accepts block lexical nodes; packages runs of
 * inline children into fresh paragraph nodes.
 */
export const BlockSchema: ChildSchema = {
  $accepts: $isBlockLevel,
  $packageRun: $paragraphPackageRun,
  name: 'BlockSchema',
};

/**
 * Schema for inline-only positions (the body of an inline lexical node such
 * as a link). Accepts non-block lexical nodes; runs of block children are
 * dropped (`onReject: 'drop'` is the default).
 */
export const InlineSchema: ChildSchema = {
  $accepts: child => !$isBlockLevel(child),
  name: 'InlineSchema',
};

/**
 * Schema for nested block positions — the equivalent of the legacy
 * `ArtificialNode__DO_NOT_USE` flow used when a block DOM element appears
 * inside another block lexical ancestor. Accepts block nodes; runs of inline
 * children are emitted with a line break between consecutive runs (instead
 * of being wrapped in a paragraph, which would introduce an extra level of
 * nesting).
 */
export const NestedBlockSchema: ChildSchema = {
  $accepts: $isBlockLevel,
  /**
   * Pass an inline run through unchanged. Because the schema iterator only
   * groups *maximal* rejected runs (each separated from the next by an
   * accepted block child), the legacy "linebreak between adjacent inline
   * groups" case never arises — adjacent inline siblings are already
   * coalesced into one run.
   */
  $packageRun: run => run,
  name: 'NestedBlockSchema',
};

/**
 * Schema for the topmost level of `$generateNodesFromDOM`. Identical to
 * {@link BlockSchema}; aliased for clarity at the entry point and so it can
 * be overridden separately in the future (e.g. to synthesize a `ListNode`
 * around runs of orphan `ListItemNode`s).
 */
export const RootSchema: ChildSchema = {
  $accepts: $isBlockLevel,
  $packageRun: $paragraphPackageRun,
  name: 'RootSchema',
};
