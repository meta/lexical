/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {
  AnyContextConfigPairOrUpdater,
  AnyContextSymbol,
  ContextConfig,
  ContextConfigPair,
  ContextConfigUpdater,
  ContextRecord,
} from './types';

import {$getEditor, createState, type LexicalEditor} from 'lexical';

let activeContext: undefined | EditorContext;

type WithContext<Ctx extends AnyContextSymbol> = {
  [K in Ctx]?: undefined | ContextRecord<Ctx>;
};

/**
 * @experimental
 *
 * The LexicalEditor with context
 */
export type EditorContext = {
  editor: LexicalEditor;
} & WithContext<AnyContextSymbol>;

/**
 * @experimental
 *
 * @param contextRecord The ContextRecord
 * @param cfg The configuration
 * @returns The value or defaultValue of cfg
 */
export function getContextValue<Ctx extends AnyContextSymbol, V>(
  contextRecord: undefined | ContextRecord<Ctx>,
  cfg: ContextConfig<Ctx, V>,
): V {
  const {key} = cfg;
  return contextRecord && key in contextRecord
    ? (contextRecord[key] as V)
    : cfg.defaultValue;
}

/**
 * @experimental
 *
 * Read and delete cfg from this layer of context
 *
 * @param contextRecord The ContextRecord
 * @param cfg The configuration
 * @returns The value of the configuration that was removed
 */
export function popOwnContextValue<Ctx extends AnyContextSymbol, V>(
  contextRecord: ContextRecord<Ctx>,
  cfg: ContextConfig<Ctx, V>,
): undefined | V {
  const rval = getOwnContextValue(contextRecord, cfg);
  delete contextRecord[cfg.key];
  return rval;
}

/**
 * @experimental
 *
 * Get the value without a default
 *
 * @param contextRecord The ContextRecord
 * @param cfg The configuration
 * @returns The current value in this context or `undefined` if not set
 */
export function getOwnContextValue<Ctx extends AnyContextSymbol, V>(
  contextRecord: ContextRecord<Ctx>,
  cfg: ContextConfig<Ctx, V>,
): undefined | V {
  const {key} = cfg;
  return key in contextRecord ? (contextRecord[key] as V) : undefined;
}

function getEditorContext(editor: LexicalEditor): undefined | EditorContext {
  return activeContext && activeContext.editor === editor
    ? activeContext
    : undefined;
}

/**
 * @experimental
 *
 * @param sym The symbol for this ContextRecord (e.g. DOMRenderContextSymbol)
 * @param editor The editor
 * @returns The current context or undefined
 */
export function getContextRecord<Ctx extends AnyContextSymbol>(
  sym: Ctx,
  editor: LexicalEditor,
): undefined | ContextRecord<Ctx> {
  const editorContext = getEditorContext(editor);
  return editorContext && editorContext[sym];
}

function toPair<Ctx extends AnyContextSymbol, V>(
  contextRecord: undefined | ContextRecord<Ctx>,
  pairOrUpdater: ContextConfigPair<Ctx, V> | ContextConfigUpdater<Ctx, V>,
): ContextConfigPair<Ctx, V> {
  if ('cfg' in pairOrUpdater) {
    const {cfg, updater} = pairOrUpdater;
    return [cfg, updater(getContextValue(contextRecord, cfg))];
  }
  return pairOrUpdater;
}

/**
 * Construct a new context from a parent context and pairs
 *
 * @param pairs The pairs and updaters to build the context from
 * @param parent The parent context
 * @returns The new context
 */
export function contextFromPairs<Ctx extends AnyContextSymbol>(
  pairs: readonly AnyContextConfigPairOrUpdater<Ctx>[],
  parent: undefined | ContextRecord<Ctx>,
): undefined | ContextRecord<Ctx> {
  let rval = parent;
  for (const pairOrUpdater of pairs) {
    const [k, v] = toPair(rval, pairOrUpdater);
    const key = k.key;
    if (rval === parent && getContextValue(rval, k) === v) {
      continue;
    }
    // If we haven't branched away from `parent` yet, create a fresh child
    // context so we never mutate the caller's parent record. Subsequent
    // pairs in this loop accumulate into the same child. Inside the loop
    // `rval` is non-null after the first iteration, since createChildContext
    // never returns null/undefined.
    const ctx: ContextRecord<Ctx> =
      rval === parent || rval === undefined ? createChildContext(parent) : rval;
    ctx[key] = v;
    rval = ctx;
  }
  return rval;
}

function createChildContext<Ctx extends AnyContextSymbol>(
  parent: undefined | ContextRecord<Ctx>,
): ContextRecord<Ctx> {
  return Object.create(parent || null);
}

/**
 * Create a context config pair that sets a value in the render context.
 * @experimental
 */
export function contextValue<Ctx extends AnyContextSymbol, V>(
  cfg: ContextConfig<Ctx, V>,
  value: V,
): ContextConfigPair<Ctx, V> {
  return [cfg, value];
}

/**
 * Create a context config updater that transforms a value in the render context.
 * @experimental
 */
export function contextUpdater<Ctx extends AnyContextSymbol, V>(
  cfg: ContextConfig<Ctx, V>,
  updater: (prev: V) => V,
): ContextConfigUpdater<Ctx, V> {
  return {cfg, updater};
}

/**
 * @internal
 * @experimental
 * @__NO_SIDE_EFFECTS__
 */
export function $withFullContext<Ctx extends AnyContextSymbol, T>(
  sym: Ctx,
  contextRecord: ContextRecord<Ctx>,
  f: () => T,
  editor: LexicalEditor = $getEditor(),
): T {
  const prevDOMContext = activeContext;
  const parentEditorContext = getEditorContext(editor);
  try {
    activeContext = {...parentEditorContext, editor, [sym]: contextRecord};
    return f();
  } finally {
    activeContext = prevDOMContext;
  }
}

/**
 * @internal
 * @experimental
 * @__NO_SIDE_EFFECTS__
 */
export function $withContext<Ctx extends AnyContextSymbol>(
  sym: Ctx,
  $defaults: (editor: LexicalEditor) => undefined | ContextRecord<Ctx> = () =>
    undefined,
) {
  return (
    cfg: readonly AnyContextConfigPairOrUpdater<Ctx>[],
    editor = $getEditor(),
  ): (<T>(f: () => T) => T) => {
    return f => {
      const parentEditorContext = getEditorContext(editor);
      const parentContextRecord =
        parentEditorContext && parentEditorContext[sym];
      const contextRecord = contextFromPairs(
        cfg,
        parentContextRecord || $defaults(editor),
      );
      if (!contextRecord || contextRecord === parentContextRecord) {
        return f();
      }
      return $withFullContext(sym, contextRecord, f, editor);
    };
  };
}

/**
 * @experimental
 * @internal
 * @__NO_SIDE_EFFECTS__
 */
export function createContextState<Tag extends symbol, V>(
  tag: Tag,
  name: string,
  getDefaultValue: () => V,
  isEqual?: (a: V, b: V) => boolean,
): ContextConfig<Tag, V> {
  return Object.assign(
    createState(Symbol(name), {isEqual, parse: getDefaultValue}),
    {[tag]: true} as const,
  );
}
