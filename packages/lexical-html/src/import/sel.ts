/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {
  AttrMatchOptions,
  CompiledSelector,
  ElementSelectorBuilder,
  StyleMatchOptions,
} from './types';

import invariant from '@lexical/internal/invariant';
import {isDOMTextNode, isHTMLElement} from 'lexical';

/**
 * @internal
 *
 * A predicate that may write into the per-invocation `captures` map. Returns
 * `true` if the rule matches; `false` otherwise.
 */
export type Predicate = (
  node: Node,
  captures: Record<string, RegExpMatchArray>,
) => boolean;

/** @internal */
export type SelectorKind = 'element' | 'text' | 'comment';

/** @internal The runtime shape of a {@link CompiledSelector}. */
export interface SelectorImpl {
  readonly kind: SelectorKind;
  /**
   * Uppercased tag names this selector is restricted to. Empty for wildcard
   * element selectors and for text / comment selectors (dispatched by
   * `kind`).
   */
  readonly tags: ReadonlySet<string>;
  /** Composed predicate run against a candidate node. */
  readonly predicate: Predicate;
}

const IMPL = Symbol.for('@lexical/html/SelectorImpl');

/** @internal */
export function getSelectorImpl(sel: CompiledSelector): SelectorImpl {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const impl = (sel as any)[IMPL] as SelectorImpl | undefined;
  invariant(
    impl !== undefined,
    'match must be a CompiledSelector produced by sel.* or sel.css(); received a raw object.',
  );
  return impl;
}

function combinePredicates(preds: readonly Predicate[]): Predicate {
  if (preds.length === 0) {
    return isHTMLElement;
  }
  if (preds.length === 1) {
    return preds[0];
  }
  return (node, captures) => {
    for (const p of preds) {
      if (!p(node, captures)) {
        return false;
      }
    }
    return true;
  };
}

/**
 * @internal
 *
 * Build a selector value from a tag set and a predicate list. Used by the
 * combinator API and the CSS parser.
 */
export function buildSelector(
  tags: ReadonlySet<string>,
  predicates: readonly Predicate[],
): ElementSelectorBuilder<HTMLElement> {
  const impl: SelectorImpl = {
    kind: 'element',
    predicate: combinePredicates(predicates),
    tags,
  };
  const refine = (additional: Predicate) =>
    buildSelector(tags, [...predicates, additional]);
  const builder = {
    [IMPL]: impl,
    attr: (name: string, value: unknown, options?: AttrMatchOptions) =>
      refine(buildAttrPredicate(name, value, options)),
    classAll: (...classes: readonly string[]) =>
      refine(buildClassAllPredicate(classes)),
    classAny: (...classes: readonly string[]) =>
      refine(buildClassAnyPredicate(classes)),
    styleAny: (prop: string, value: unknown, options?: StyleMatchOptions) =>
      refine(buildStylePredicate(prop, value, options)),
  };
  // The runtime is fully type-erased; cast to satisfy the surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return builder as any;
}

function normalizeClassList(classes: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const c of classes) {
    if (c) {
      out.push(c);
    }
  }
  return out;
}

/** @internal */
export function buildClassAllPredicate(classes: readonly string[]): Predicate {
  const ns = normalizeClassList(classes);
  if (ns.length === 0) {
    return () => true;
  }
  return node => {
    if (!isHTMLElement(node)) {
      return false;
    }
    const cl = node.classList;
    for (const c of ns) {
      if (!cl.contains(c)) {
        return false;
      }
    }
    return true;
  };
}

/** @internal */
export function buildClassAnyPredicate(classes: readonly string[]): Predicate {
  const ns = normalizeClassList(classes);
  if (ns.length === 0) {
    return () => false;
  }
  return node => {
    if (!isHTMLElement(node)) {
      return false;
    }
    const cl = node.classList;
    for (const c of ns) {
      if (cl.contains(c)) {
        return true;
      }
    }
    return false;
  };
}

/** @internal */
export function buildAttrPredicate(
  name: string,
  value: unknown,
  options?: AttrMatchOptions,
): Predicate {
  if (value === true) {
    return node => isHTMLElement(node) && node.hasAttribute(name);
  }
  if (typeof value === 'string') {
    return node => isHTMLElement(node) && node.getAttribute(name) === value;
  }
  if (value instanceof RegExp) {
    const capture = options && options.capture;
    const re = value;
    return (node, captures) => {
      if (!isHTMLElement(node)) {
        return false;
      }
      const v = node.getAttribute(name);
      if (v == null) {
        return false;
      }
      const m = v.match(re);
      if (m === null) {
        return false;
      }
      if (capture !== undefined) {
        captures[capture] = m;
      }
      return true;
    };
  }
  invariant(
    false,
    'sel.attr(%s, ...) requires true, a string, or a RegExp',
    JSON.stringify(name),
  );
}

function buildStylePredicate(
  prop: string,
  value: unknown,
  options?: StyleMatchOptions,
): Predicate {
  if (typeof value === 'string') {
    return node =>
      isHTMLElement(node) && node.style.getPropertyValue(prop) === value;
  }
  if (value instanceof RegExp) {
    const capture = options && options.capture;
    const re = value;
    return (node, captures) => {
      if (!isHTMLElement(node)) {
        return false;
      }
      const v = node.style.getPropertyValue(prop);
      if (!v) {
        return false;
      }
      const m = v.match(re);
      if (m === null) {
        return false;
      }
      if (capture !== undefined) {
        captures[capture] = m;
      }
      return true;
    };
  }
  invariant(
    false,
    'sel.styleAny(%s, ...) requires a string or a RegExp',
    JSON.stringify(prop),
  );
}

const TEXT_SELECTOR_IMPL: SelectorImpl = {
  kind: 'text',
  predicate: isDOMTextNode,
  tags: new Set(),
};

/**
 * Wrap a {@link SelectorImpl} as an opaque {@link CompiledSelector}. The `as`
 * cast is needed because `CompiledSelector` is an opaque branded interface —
 * neither the object literal nor a typed const can declare the internal
 * `IMPL` symbol without exposing it. A function declared side-effect free (so
 * the build annotates the calls) rather than an object literal at module
 * scope: a computed `[IMPL]` key there is a side effect to bundlers, which
 * would pin the selector into every bundle that imports this module.
 *
 * @__NO_SIDE_EFFECTS__
 */
function compiledSelector<T extends Node>(
  impl: SelectorImpl,
): CompiledSelector<T> {
  return {[IMPL]: impl} as CompiledSelector<T>;
}

const TEXT_SELECTOR = compiledSelector<Text>(TEXT_SELECTOR_IMPL);

const COMMENT_SELECTOR_IMPL: SelectorImpl = {
  kind: 'comment',
  predicate: node => node.nodeType === 8 /* COMMENT_NODE */,
  tags: new Set(),
};

const COMMENT_SELECTOR = compiledSelector<Comment>(COMMENT_SELECTOR_IMPL);

/**
 * Match any {@link HTMLElement}.
 *
 * @internal Use `sel.any()`.
 */
export function selAny(): ElementSelectorBuilder<HTMLElement> {
  return buildSelector(new Set(), []);
}

/**
 * Match DOM {@link Comment} nodes.
 *
 * @internal Use `sel.comment()`.
 */
export function selComment(): CompiledSelector<Comment> {
  return COMMENT_SELECTOR;
}

/**
 * Match by tag name(s). With one literal tag the element type is narrowed
 * (e.g. `'a' → HTMLAnchorElement`); with multiple, it is the union of
 * their `HTMLElementTagNameMap` entries.
 *
 * @internal Use `sel.tag()`.
 */
export function selTag<const Tags extends readonly string[]>(
  ...tags: Tags
): ElementSelectorBuilder<
  Tags[number] extends keyof HTMLElementTagNameMap
    ? HTMLElementTagNameMap[Tags[number]]
    : HTMLElement
> {
  invariant(tags.length > 0, 'sel.tag() requires at least one tag name');
  const upper = new Set<string>();
  for (const t of tags) {
    upper.add(t.toUpperCase());
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return buildSelector(upper, []) as any;
}

/**
 * Match DOM {@link Text} nodes.
 *
 * @internal Use `sel.text()`.
 */
export function selText(): CompiledSelector<Text> {
  return TEXT_SELECTOR;
}

// The methods are standalone functions that both this object and the public
// `sel` reference by name. Reading them off this object (`selBase.any`) in
// `./index.ts` would be a module-scope property read, which is a side effect
// to bundlers and would pin every selector into every bundle that imports
// @lexical/html.
/**
 * Combinator API for building {@link CompiledSelector}s. The public
 * `sel` is augmented from this in `./index.ts` (where the CSS parser is
 * available without a circular import); consumers outside `@lexical/html`
 * should always import the public `sel` from the package root.
 *
 * Every method builds a selector and returns it; none of them touch anything
 * outside their arguments, which is what the marker declares. The build
 * annotates module-scope calls to them so an unused rule can be dropped.
 *
 * @internal
 * @lexical-pure-namespace
 */
export const selBase = {
  /** Match any {@link HTMLElement}. */
  any: selAny,
  /** Match DOM {@link Comment} nodes. */
  comment: selComment,
  /**
   * Match by tag name(s). With one literal tag the element type is narrowed
   * (e.g. `'a' → HTMLAnchorElement`); with multiple, it is the union of
   * their `HTMLElementTagNameMap` entries.
   */
  tag: selTag,
  /** Match DOM {@link Text} nodes. */
  text: selText,
} as const;

/**
 * Cross-frame-safe replacement for `node instanceof HTMLXxxElement`. Returns
 * true when `node` is an HTMLElement whose `nodeName` equals `tag` (compared
 * case-insensitively).
 *
 * @experimental
 */
export function isElementOfTag<T extends keyof HTMLElementTagNameMap>(
  node: Node,
  tag: T,
): node is HTMLElementTagNameMap[T] {
  return isHTMLElement(node) && node.nodeName === tag.toUpperCase();
}
