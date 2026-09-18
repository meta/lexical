/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {AnyDOMImportRule, DOMImportFn} from './types';

import {isDOMTextNode, isHTMLElement} from 'lexical';

import {getSelectorImpl, type Predicate, type SelectorImpl} from './sel';

const __DEV__ = process.env.NODE_ENV !== 'production';

/** @internal */
export interface CompiledRule {
  readonly name: string;
  readonly predicate: Predicate;
  readonly $import: DOMImportFn<Node, Record<string, RegExpMatchArray>>;
}

/** @internal */
export interface CompiledDispatch {
  /** All rules in registration order. Index = registration order. */
  readonly rules: readonly CompiledRule[];
  /**
   * For each (uppercased) HTML tag name, the ordered list of rule indices
   * considered when dispatching that tag. Includes interleaved wildcard
   * element rules so a single iteration handles both.
   */
  readonly byTag: ReadonlyMap<string, readonly number[]>;
  /** Indices of rules whose match has no tag restriction. */
  readonly wildcardIndices: readonly number[];
  /** Indices of rules whose match is `sel.text()`. */
  readonly textIndices: readonly number[];
  /** Indices of rules whose match is `sel.comment()`. */
  readonly commentIndices: readonly number[];
}

function mergeSortedAsc(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] <= b[j]) {
      out.push(a[i++]);
    } else {
      out.push(b[j++]);
    }
  }
  while (i < a.length) {
    out.push(a[i++]);
  }
  while (j < b.length) {
    out.push(b[j++]);
  }
  return out;
}

/**
 * Compile an ordered list of {@link DOMImportRule}s into the dispatch tables
 * used by the import runtime. Dispatch reads the list front to back, so the
 * rule at index 0 is the highest-priority one. `DOMImportExtension.mergeConfig`
 * prepends each contribution to the list, so the rules of the most dependent
 * contributor occupy the lowest indices.
 *
 * @internal
 */
export function compileImportRules(
  rules: readonly AnyDOMImportRule[],
): CompiledDispatch {
  const compiled: CompiledRule[] = [];
  const byTag = new Map<string, number[]>();
  const wildcardIndices: number[] = [];
  const textIndices: number[] = [];
  const commentIndices: number[] = [];
  const seenNames = new Set<string>();

  rules.forEach((rule, i) => {
    const sel = getSelectorImpl(rule.match);
    const name = rule.name || defaultRuleName(sel, i);
    if (__DEV__ && typeof rule.name === 'string' && seenNames.has(rule.name)) {
      console.warn(
        `[lexical] duplicate DOMImportRule name "${rule.name}" — keep names unique to aid debugging.`,
      );
    }
    if (rule.name) {
      seenNames.add(rule.name);
    }
    compiled.push({
      $import: rule.$import as DOMImportFn<
        Node,
        Record<string, RegExpMatchArray>
      >,
      name,
      predicate: sel.predicate,
    });

    if (sel.kind === 'text') {
      textIndices.push(i);
    } else if (sel.kind === 'comment') {
      commentIndices.push(i);
    } else if (sel.tags.size === 0) {
      wildcardIndices.push(i);
    } else {
      for (const tag of sel.tags) {
        let list = byTag.get(tag);
        if (!list) {
          list = [];
          byTag.set(tag, list);
        }
        list.push(i);
      }
    }
  });

  // Interleave wildcard-element indices into each tag's list in registration
  // (ascending-index) order, so iterating a tag bucket visits both tag-
  // specific and wildcard rules in the same priority sequence.
  const finalByTag = new Map<string, readonly number[]>();
  if (wildcardIndices.length === 0) {
    for (const [tag, list] of byTag) {
      finalByTag.set(tag, list);
    }
  } else {
    for (const [tag, list] of byTag) {
      finalByTag.set(tag, mergeSortedAsc(list, wildcardIndices));
    }
  }

  return {
    byTag: finalByTag,
    commentIndices,
    rules: compiled,
    textIndices,
    wildcardIndices,
  };
}

function defaultRuleName(sel: SelectorImpl, index: number): string {
  if (sel.kind === 'text') {
    return `#text@${index}`;
  }
  if (sel.kind === 'comment') {
    return `#comment@${index}`;
  }
  if (sel.tags.size === 0) {
    return `*@${index}`;
  }
  const tagList = Array.from(sel.tags).join(',').toLowerCase();
  return `${tagList}@${index}`;
}

/**
 * Look up the (already interleaved) rule indices relevant to `node`. Element
 * nodes hit `byTag` (with wildcards merged in) or fall back to the wildcard
 * bucket if no tag-specific rules exist; text and comment nodes use their
 * own buckets.
 *
 * @internal
 */
export function getDispatchIndices(
  dispatch: CompiledDispatch,
  node: Node,
): readonly number[] {
  if (isDOMTextNode(node)) {
    return dispatch.textIndices;
  }
  if (node.nodeType === 8 /* COMMENT_NODE */) {
    return dispatch.commentIndices;
  }
  if (isHTMLElement(node)) {
    return dispatch.byTag.get(node.nodeName) || dispatch.wildcardIndices;
  }
  return EMPTY_INDICES;
}

const EMPTY_INDICES: readonly number[] = Object.freeze([]);
