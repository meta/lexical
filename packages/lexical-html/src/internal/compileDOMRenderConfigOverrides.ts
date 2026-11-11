/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {AnyDOMRenderMatch, DOMRenderConfig, DOMRenderMatch} from './types';

import {getKnownTypesAndNodes} from '@lexical/extension';
import invariant from '@lexical/internal/invariant';
import {
  $isLexicalNode,
  DEFAULT_EDITOR_DOM_CONFIG,
  type EditorDOMRenderConfig,
  getRegisteredSubtypeMap,
  type InitialEditorConfig,
  iterStaticNodeConfigChain,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';

import {ALWAYS_TRUE} from './constants';

type PredicateOrTypes =
  | ((node: LexicalNode) => boolean)
  | {[NodeType in string]?: true};
type TypeRender<T> = {[NodeType in string]?: T[]};
type AnyRender<T> =
  | readonly [(node: LexicalNode) => boolean, T]
  | readonly ['types', TypeRender<T>];

type PreEditorDOMRenderConfig = {
  [K in keyof EditorDOMRenderConfig]: AnyRender<AnyDOMRenderMatch[K]>[];
};

function buildNodePredicate<T extends LexicalNode>(klass: Klass<T>) {
  return (node: LexicalNode): node is T => node instanceof klass;
}

function getPredicate(
  subtypeMap: Map<string, Set<string>>,
  {nodes}: DOMRenderMatch<LexicalNode>,
): {[NodeType in string]?: true} | ((node: LexicalNode) => boolean) {
  if (nodes === '*') {
    return ALWAYS_TRUE;
  }
  let types: undefined | {[NodeType in string]?: true} = {};
  const predicates: ((node: LexicalNode) => boolean)[] = [];
  for (const klassOrPredicate of nodes) {
    if ('getType' in klassOrPredicate) {
      const type = klassOrPredicate.getType();
      if (types) {
        const subtypes = subtypeMap.get(type);
        invariant(
          subtypes !== undefined,
          'Node class %s with type %s not registered in editor',
          klassOrPredicate.name,
          type,
        );
        for (const subtype of subtypes) {
          types[subtype] = true;
        }
      }
      predicates.push(buildNodePredicate(klassOrPredicate));
    } else {
      types = undefined;
      predicates.push(klassOrPredicate);
    }
  }
  if (types) {
    return types;
  } else if (predicates.length === 1) {
    return predicates[0];
  }
  return (node: LexicalNode): boolean => {
    for (const predicate of predicates) {
      if (predicate(node)) {
        return true;
      }
    }
    return false;
  };
}

function makePrerender(): PreEditorDOMRenderConfig {
  return {
    $createDOM: [],
    $decorateDOM: [],
    $exportDOM: [],
    $extractWithChild: [],
    $getDOMSlot: [],
    $getSlotTargetElement: [],
    $shouldExclude: [],
    $shouldInclude: [],
    $updateDOM: [],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AccFn<T, N extends LexicalNode, Args extends any[]> = (
  node: N,
  ...rest: [...Args, editor: LexicalEditor]
) => T;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GetOverrideFn<T, N extends LexicalNode, Args extends any[]> = (
  n: N,
) => undefined | OverrideFn<T, N, Args>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OverrideFn<T, N extends LexicalNode, Args extends any[]> = (
  node: N,
  ...rest: [...Args, $next: () => T, editor: LexicalEditor]
) => T;

function ignoreNext2<T, N extends LexicalNode>(
  acc: AccFn<T, N, []>,
): OverrideFn<T, N, []> {
  return (node: N, _$next: () => T, editor: LexicalEditor) => acc(node, editor);
}
function ignoreNext3<T, N extends LexicalNode, A>(
  acc: AccFn<T, N, [A]>,
): OverrideFn<T, N, [A]> {
  return (node: N, a: A, _$next: () => T, editor: LexicalEditor) =>
    acc(node, a, editor);
}
function ignoreNext4<T, N extends LexicalNode, A, B>(
  acc: AccFn<T, N, [A, B]>,
): OverrideFn<T, N, [A, B]> {
  return (node: N, a: A, b: B, _$next: () => T, editor: LexicalEditor) =>
    acc(node, a, b, editor);
}
function ignoreNext5<T, N extends LexicalNode, A, B, C>(
  acc: AccFn<T, N, [A, B, C]>,
): OverrideFn<T, N, [A, B, C]> {
  return (node: N, a: A, b: B, c: C, _$next: () => T, editor: LexicalEditor) =>
    acc(node, a, b, c, editor);
}

function merge2<T, N extends LexicalNode>(
  $acc: AccFn<T, N, []>,
  $getOverride: GetOverrideFn<T, N, []>,
): typeof $acc {
  return (node, editor) => {
    const $next = () => $acc(node, editor);
    const $override = $getOverride(node);
    return $override ? $override(node, $next, editor) : $next();
  };
}

function merge3<T, N extends LexicalNode, A>(
  acc: AccFn<T, N, [A]>,
  $getOverride: GetOverrideFn<T, N, [A]>,
): typeof acc {
  return (node, a, editor) => {
    const $next = () => acc(node, a, editor);
    const $override = $getOverride(node);
    return $override ? $override(node, a, $next, editor) : $next();
  };
}

const merge3GetDOMSlot = merge3 as (
  acc: EditorDOMRenderConfig['$getDOMSlot'],
  $getOverride: (n: LexicalNode) => DOMRenderMatch<LexicalNode>['$getDOMSlot'],
) => EditorDOMRenderConfig['$getDOMSlot'];

const ignoreNext3GetDOMSlot = ignoreNext3 as (
  fn: EditorDOMRenderConfig['$getDOMSlot'],
) => DOMRenderMatch<LexicalNode>['$getDOMSlot'];

function merge4<T, N extends LexicalNode, A, B>(
  $acc: AccFn<T, N, [A, B]>,
  $getOverride: GetOverrideFn<T, N, [A, B]>,
): typeof $acc {
  return (node, a, b, editor) => {
    const $next = () => $acc(node, a, b, editor);
    const $override = $getOverride(node);
    return $override ? $override(node, a, b, $next, editor) : $next();
  };
}

function merge5<T, N extends LexicalNode, A, B, C>(
  acc: AccFn<T, N, [A, B, C]>,
  $getOverride: GetOverrideFn<T, N, [A, B, C]>,
): typeof acc {
  return (node, a, b, c, editor) => {
    const $next = () => acc(node, a, b, c, editor);
    const $override = $getOverride(node);
    return $override ? $override(node, a, b, c, $next, editor) : $next();
  };
}

function sequence4<N extends LexicalNode, A, B>(
  $acc: AccFn<void, N, [A, B]>,
  $getOverride: (n: N) => undefined | AccFn<void, N, [A, B]>,
): typeof $acc {
  return (node, a, b, editor) => {
    $acc(node, a, b, editor);
    const $override = $getOverride(node);
    if ($override) {
      $override(node, a, b, editor);
    }
  };
}

function compilePrerenderKey<K extends keyof PreEditorDOMRenderConfig>(
  prerender: PreEditorDOMRenderConfig,
  k: K,
  defaults: EditorDOMRenderConfig,
  mergeFunction: (
    $acc: EditorDOMRenderConfig[K],
    $getOverride: (node: LexicalNode) => AnyDOMRenderMatch[K],
  ) => typeof $acc,
  ignoreNextFunction: (fn: EditorDOMRenderConfig[K]) => AnyDOMRenderMatch[K],
): void {
  let acc = defaults[k];
  for (const pair of prerender[k]) {
    if (typeof pair[0] === 'function') {
      const [$predicate, $override] = pair;
      acc = mergeFunction(
        acc,
        node => ($predicate(node) && $override) || undefined,
      );
    } else {
      const typeOverrides = pair[1];
      const compiled: Record<string, undefined | EditorDOMRenderConfig[K]> = {};
      for (const type in typeOverrides) {
        const arr = typeOverrides[type];
        if (arr) {
          compiled[type] = arr.reduce(
            ($acc, $override) => mergeFunction($acc, () => $override),
            acc,
          );
        }
      }
      acc = mergeFunction(acc, node => {
        const f = compiled[node.getType()];
        return f && ignoreNextFunction(f);
      });
    }
  }
  defaults[k] = acc;
}

function addOverride<K extends keyof PreEditorDOMRenderConfig>(
  prerender: PreEditorDOMRenderConfig,
  k: K,
  predicateOrTypes: PredicateOrTypes,
  override: AnyDOMRenderMatch[K],
): void {
  if (!override) {
    return;
  }
  const arr = prerender[k];
  if (typeof predicateOrTypes === 'function') {
    arr.push([predicateOrTypes, override]);
  } else {
    const last = arr[arr.length - 1];
    let types: TypeRender<AnyDOMRenderMatch[K]>;
    if (last && last[0] === 'types') {
      types = last[1];
    } else {
      types = {};
      arr.push(['types', types]);
    }
    for (const type in predicateOrTypes) {
      const typeArr = types[type] || [];
      types[type] = typeArr;
      typeArr.push(override);
    }
  }
}

type NormalizedDOMRenderMatch<T> = Omit<
  DOMRenderMatch<LexicalNode>,
  'nodes'
> & {
  nodes: T;
};

function isWildcard(
  override: DOMRenderMatch<LexicalNode>,
): override is NormalizedDOMRenderMatch<'*'> {
  return override.nodes === '*';
}

function sortedOverrides(
  overrides: DOMRenderMatch<LexicalNode>[],
): DOMRenderMatch<LexicalNode>[] {
  const byWildcard: NormalizedDOMRenderMatch<'*'>[] = [];
  const byPredicate: NormalizedDOMRenderMatch<
    [(node: LexicalNode) => node is LexicalNode]
  >[] = [];
  const byNode: NormalizedDOMRenderMatch<[Klass<LexicalNode>]>[] = [];
  for (const override of overrides) {
    if (isWildcard(override)) {
      byWildcard.push(override);
    } else if (Array.isArray(override.nodes)) {
      for (const klassOrPredicate of override.nodes) {
        if ($isLexicalNode(klassOrPredicate.prototype)) {
          byNode.push(
            override.nodes.length === 1
              ? (override as NormalizedDOMRenderMatch<[Klass<LexicalNode>]>)
              : {...override, nodes: [klassOrPredicate]},
          );
        } else {
          byPredicate.push(
            override.nodes.length === 1
              ? (override as NormalizedDOMRenderMatch<
                  [(node: LexicalNode) => node is LexicalNode]
                >)
              : {...override, nodes: [klassOrPredicate]},
          );
        }
      }
    }
  }
  const depths = new Map<Klass<LexicalNode>, number>();
  const depthOf = (klass: Klass<LexicalNode>): number => {
    let depth = depths.get(klass);
    if (depth === undefined) {
      depth = -1;
      for (const _ of iterStaticNodeConfigChain(klass)) {
        depth++;
      }
      depths.set(klass, depth);
    }
    return depth;
  };
  byNode.sort((a, b) => depthOf(a.nodes[0]) - depthOf(b.nodes[0]));
  return [...byNode, ...byPredicate, ...byWildcard];
}

export function precompileDOMRenderConfigOverrides(
  editorConfig: Pick<InitialEditorConfig, 'nodes'>,
  overrides: DOMRenderConfig['overrides'],
): PreEditorDOMRenderConfig {
  const subtypeMap = getRegisteredSubtypeMap(
    getKnownTypesAndNodes(editorConfig).nodes,
  );
  const prerender = makePrerender();
  for (const override of sortedOverrides(overrides)) {
    const predicateOrTypes = getPredicate(subtypeMap, override);
    for (const k_ in prerender) {
      const k = k_ as keyof typeof prerender;
      addOverride(prerender, k, predicateOrTypes, override[k]);
    }
  }
  return prerender;
}

function identity<T>(v: T) {
  return v;
}

export function compileDOMRenderConfigOverrides(
  editorConfig: Pick<InitialEditorConfig, 'nodes' | 'dom'>,
  {overrides}: Pick<DOMRenderConfig, 'overrides'>,
): EditorDOMRenderConfig {
  const prerender = precompileDOMRenderConfigOverrides(editorConfig, overrides);
  const dom = {
    ...DEFAULT_EDITOR_DOM_CONFIG,
    ...editorConfig.dom,
  };
  compilePrerenderKey(prerender, '$createDOM', dom, merge2, ignoreNext2);
  compilePrerenderKey(prerender, '$exportDOM', dom, merge2, ignoreNext2);
  compilePrerenderKey(prerender, '$extractWithChild', dom, merge5, ignoreNext5);
  compilePrerenderKey(
    prerender,
    '$getDOMSlot',
    dom,
    merge3GetDOMSlot,
    ignoreNext3GetDOMSlot,
  );
  compilePrerenderKey(prerender, '$shouldExclude', dom, merge3, ignoreNext3);
  compilePrerenderKey(prerender, '$shouldInclude', dom, merge3, ignoreNext3);
  compilePrerenderKey(
    prerender,
    '$getSlotTargetElement',
    dom,
    merge4,
    ignoreNext4,
  );
  compilePrerenderKey(prerender, '$updateDOM', dom, merge4, ignoreNext4);
  compilePrerenderKey(prerender, '$decorateDOM', dom, sequence4, identity);
  return dom;
}
