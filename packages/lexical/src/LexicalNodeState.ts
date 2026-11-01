/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {PROTOTYPE_CONFIG_METHOD} from './LexicalConstants';
import type {
  AnyStaticNodeConfigValue,
  GetStaticNodeOwnConfig,
  GetStaticNodeType,
} from './LexicalNode';

import invariant from '@lexical/internal/invariant';

import {
  $getEditor,
  type Klass,
  type LexicalNode,
  type LexicalNodeConfig,
  type LexicalParseJSON,
  NODE_STATE_KEY,
  type SerializedLexicalNode,
  type Spread,
} from '.';
import {
  type AnySerializationSchema,
  isSchemaEqual,
  type SchemaInput,
  type SerializationSchema,
} from './LexicalSchema';
import {errorOnReadOnly} from './LexicalUpdates';
import {
  getRegisteredNodeOrThrow,
  iterStaticNodeConfigChain,
} from './LexicalUtils';

const __DEV__ = process.env.NODE_ENV !== 'production';

/**
 * Read the state directly from the given object without `node.getLatest()`.
 * Safe to use outside of editor state context or to read a previous version,
 * equivalent to reading the property directly.
 */
export const NODE_STATE_DIRECT = 'direct';
/**
 * Use `node.getLatest()` before reading the state, per the lexical convention
 * of only working with the latest version of a node.
 */
export const NODE_STATE_LATEST = 'latest';

export type NodeStateVersion =
  | typeof NODE_STATE_DIRECT
  | typeof NODE_STATE_LATEST;

/**
 * Get the value type (V) from a StateConfig
 */
export type StateConfigValue<S extends AnyStateConfig> =
  S extends StateConfig<infer _K, infer V> ? V : never;
/**
 * Get the key type (K) from a StateConfig
 */
export type StateConfigKey<S extends AnyStateConfig> =
  S extends StateConfig<infer K, infer _V> ? K : never;

/**
 * A value type, or an updater for that value type. For use with
 * {@link $setState} or any user-defined wrappers around it.
 */
export type ValueOrUpdater<V> = V | ((prevValue: V) => V);

/**
 * A type alias to make it easier to define setter methods on your node class
 *
 * @example
 * ```ts
 * const fooState = createState("foo", { parse: ... });
 * class MyClass extends TextNode {
 *   // ...
 *   setFoo(valueOrUpdater: StateValueOrUpdater<typeof fooState>): this {
 *     return $setState(this, fooState, valueOrUpdater);
 *   }
 * }
 * ```
 */
export type StateValueOrUpdater<Cfg extends AnyStateConfig> = ValueOrUpdater<
  StateConfigValue<Cfg>
>;

export interface NodeStateConfig<S extends AnyStateConfig> {
  stateConfig: S;
  flat?: boolean;
}

export type RequiredNodeStateConfig =
  | NodeStateConfig<AnyStateConfig>
  | AnyStateConfig;

export type StateConfigJSON<S> =
  S extends StateConfig<infer K, infer V>
    ? {[Key in K]?: V}
    : Record<never, never>;

export type RequiredNodeStateConfigJSON<
  Config extends RequiredNodeStateConfig,
  Flat extends boolean,
> = StateConfigJSON<
  Config extends NodeStateConfig<infer S>
    ? Spread<Config, {flat: false}> extends {flat: Flat}
      ? S
      : never
    : false extends Flat
      ? Config
      : never
>;

export type Prettify<T> = {[K in keyof T]: T[K]} & {};

/* eslint-disable @typescript-eslint/no-explicit-any */
export type UnionToIntersection<T> = (
  T extends any ? (x: T) => any : never
) extends (x: infer R) => any
  ? R
  : never;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type CollectStateJSON<
  Tuple extends readonly RequiredNodeStateConfig[],
  Flat extends boolean,
> = UnionToIntersection<
  {[K in keyof Tuple]: RequiredNodeStateConfigJSON<Tuple[K], Flat>}[number]
>;

// Read a node's own config out of its $config() record. Preferentially read it
// from the STATIC_NODE_CONFIG accessor (see {@link GetStaticNodeOwnConfig}),
// which resolves the most-derived own config directly — including for an
// abstract base class keyed by a symbol, which has no string `type` to index by.
// A record produced by the {@link BaseStaticNodeConfig} fallback (a node that
// declares no `extends`, or a legacy node) sets no accessor; for those we fall
// back to resolving the own `type` (see {@link GetStaticNodeType}) and indexing
// by it. The own type is read through a mapped type (`{[P in Type]: ...}[Type]`)
// so that the indexed access resolves against the concrete key literal rather
// than the record's broad string index signature when `T` is still generic.
/** @internal */
export type GetStaticNodeConfig<T extends LexicalNode> = [
  GetStaticNodeOwnConfig<T>,
] extends [never]
  ? GetStaticNodeType<T> extends infer Type extends string
    ? string extends Type
      ? never
      : {
            [P in Type]: NonNullable<
              ReturnType<T[typeof PROTOTYPE_CONFIG_METHOD]>[P]
            >;
          }[Type] extends infer Config extends AnyStaticNodeConfigValue
        ? Config & {readonly type: Type}
        : never
    : never
  : GetStaticNodeOwnConfig<T> extends infer Config extends
        AnyStaticNodeConfigValue
    ? Config & {readonly type: GetStaticNodeType<T>}
    : never;
type GetStaticNodeConfigs<T extends LexicalNode> =
  GetStaticNodeConfig<T> extends infer OwnConfig
    ? // `[X] extends [never]` checks for never without distributing (a naked
      // `never` would otherwise collapse the whole conditional to never). A node
      // with no $config — e.g. a legacy node keyed only by static getType() —
      // yields never here and contributes no state configs.
      [OwnConfig] extends [never]
      ? []
      : OwnConfig extends {extends: Klass<infer Parent>}
        ? [GetStaticNodeConfig<Parent>] extends [never]
          ? [OwnConfig]
          : [OwnConfig, ...GetStaticNodeConfigs<Parent>]
        : [OwnConfig]
    : [];

type CollectStateConfigs<Configs> = Configs extends [
  infer OwnConfig,
  ...infer ParentConfigs,
]
  ? OwnConfig extends {stateConfigs: infer StateConfigs}
    ? StateConfigs extends readonly RequiredNodeStateConfig[]
      ? [...StateConfigs, ...CollectStateConfigs<ParentConfigs>]
      : CollectStateConfigs<ParentConfigs>
    : CollectStateConfigs<ParentConfigs>
  : [];

export type GetNodeStateConfig<T extends LexicalNode> = CollectStateConfigs<
  GetStaticNodeConfigs<T>
>;

/**
 * The contribution of a class that declares no schema: no properties, and the
 * neutral element of the fold below.
 *
 * An empty object rather than `unknown`, which is also neutral for `&` but is
 * not a *value* type — a node with no schema anywhere in its chain would
 * otherwise come back as `unknown`, which cannot even be spread.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type NoSchemaInput = {};

/**
 * What one config's schema accepts, or {@link NoSchemaInput} where it declares
 * none.
 *
 * Both tests are written against `[Config]` so that neither distributes.
 * `never` is the fold's absorbing element twice over — `never & X` is `never`,
 * and `keyof never` is every key, so an `Omit` against it erases the whole
 * ancestor chain — and a naked check maps `never` to `never` rather than to the
 * neutral element. Not distributing also gives a union-valued config the
 * conservative answer: `keyof` a union is the *intersection* of its keys, so a
 * distributed check would quietly hand the `Omit` below an empty key set and
 * turn off the derived-wins rule it exists to enforce.
 */
type SchemaInputOfConfig<Config> = [Config] extends [never]
  ? NoSchemaInput
  : [Config] extends [{json: infer Json}]
    ? SchemaInput<Json>
    : NoSchemaInput;

/**
 * Fold a class's config chain, most derived first, into the properties it
 * accepts.
 *
 * `Omit` rather than a bare intersection: a subclass that re-declares an
 * inherited property *replaces* it — `composeSchema` resolves the key to one
 * winning schema, most derived first — so intersecting the two would report
 * the ancestor's domain for a property the subclass widened, and `never` for
 * one it changed outright. Accumulating derived-first means the winner is
 * always already in `Acc`, so each ancestor is admitted only for the keys
 * nothing below it claimed.
 *
 * An accumulator rather than the direct form (`Own & Omit<Rest, keyof Own>`):
 * the recursive call is then the whole of the true branch, which is what makes
 * it a tail call TypeScript can eliminate. Nesting it inside the intersection
 * instead caps the fold at ~30 links with a bare TS2589 and a silently
 * truncated result.
 */
type ComposeSchemaInputs<
  Configs extends readonly unknown[],
  Acc = NoSchemaInput,
> = Configs extends [infer OwnConfig, ...infer ParentConfigs]
  ? ComposeSchemaInputs<
      ParentConfigs,
      Spread<Acc, SchemaInputOfConfig<OwnConfig>>
    >
  : Acc;

/**
 * The flat NodeState keys a node accepts, each holding whatever JSON carried
 * it.
 *
 * The keys of {@link CollectStateJSON}, with the values widened to `unknown`.
 * A `StateConfig`'s `parse` is `(jsonValue: unknown) => V` — a state is read
 * from unparsed JSON and normalizes it, and nothing records what it accepted on
 * the way in, so `V` describes what comes *out* of that parse and says nothing
 * about what may go in. Naming `V` here claimed the two were the same and was
 * wrong for any state whose parse converts: a `string`-to-`Date` state typed its
 * input as `Date`, so `nodeArbitrary` handed a caller a string that
 * `timestamp.getTime()` would compile against and throw on.
 */
type CollectStateInput<Tuple extends readonly RequiredNodeStateConfig[]> = {
  readonly [K in keyof CollectStateJSON<Tuple, true>]?: unknown;
};

/**
 * Every serialized property `T` accepts, composed across its `$config` chain —
 * its own and the ones it inherits.
 *
 * The *accepted* input rather than the parsed output, which is wider wherever
 * a schema reads more than it writes: a legacy alias, a number spelled as a
 * string, an absent property. That is what a generator of example JSON should
 * say it produces.
 *
 * Both halves are folded over one binding of {@link GetStaticNodeConfigs} — the
 * chain walk NodeState already runs for its own configs — so nothing here can
 * disagree with `getComposedSchemaFields` about which classes are in a node's
 * chain. That walk follows each config's `extends`, which is why every config
 * in the tree names one: the runtime defaults it to the superclass, but the
 * type has no way to recover what was left out, and a class that omits it
 * contributes only its own declarations and hides its ancestors'.
 *
 * The walk is the only bound on chain depth, shared with `GetNodeStateConfig`
 * and reached in the hundreds rather than the sixteen an earlier bound here
 * allowed; the fold itself is tail-recursive and adds none.
 */
export type LexicalSchemaInput<T extends LexicalNode> =
  GetStaticNodeConfigs<T> extends infer Configs extends readonly unknown[]
    ? Prettify<
        ComposeSchemaInputs<Configs> &
          // Flat NodeState is the other half of what a node serializes as
          // top-level properties — `getComposedSchemaFields` folds it in
          // beside the schema's, so anything describing what a node accepts
          // has to as well.
          CollectStateInput<CollectStateConfigs<Configs>>
      >
    : never;

/**
 * The NodeState JSON produced by this LexicalNode
 */
export type NodeStateJSON<T extends LexicalNode> = Prettify<
  {
    [NODE_STATE_KEY]?: Prettify<CollectStateJSON<GetNodeStateConfig<T>, false>>;
  } & CollectStateJSON<GetNodeStateConfig<T>, true>
>;

/**
 * Configure a value to be used with StateConfig.
 *
 * The value type should be inferred from the definition of parse.
 *
 * If the value type is not JSON serializable, then unparse must also be provided.
 *
 * Values should be treated as immutable, much like React.useState. Mutating
 * stored values directly will cause unpredictable behavior, is not supported,
 * and may trigger errors in the future.
 *
 * @example
 * ```ts
 * const numberOrNullState = createState('numberOrNull', {parse: (v) => typeof v === 'number' ? v : null});
 * //    ^? State<'numberOrNull', StateValueConfig<number | null>>
 * const numberState = createState('number', {parse: (v) => typeof v === 'number' ? v : 0});
 * //    ^? State<'number', StateValueConfig<number>>
 * ```
 *
 * The {@link Parse} schema builders exported from `lexical` (such as
 * {@link stringValue}, {@link numberValue}, {@link booleanValue}, and
 * {@link enumValue}) cover the common primitive and enumeration cases and
 * return a parse function you can use directly:
 *
 * @example
 * ```ts
 * const formatState = createState('format', {parse: numberValue()});
 * //    ^? State<'format', StateValueConfig<number>>
 * ```
 *
 * {@link arraySetValue} builds an array of strings used as a set: frozen,
 * sorted and without duplicates, both when it is parsed and when it is
 * written with {@link $setState}:
 *
 * @example
 * ```ts
 * const tagsState = createState('tags', {parse: arraySetValue(stringValue())});
 * //    ^? StateConfig<'tags', readonly string[]>
 * ```
 *
 * Only the parse option is required, it is generally not useful to
 * override `unparse` or `isEqual`. However, if you are using
 * non-primitive types such as Array, Object, Date, or something
 * more exotic then you would want to override this. In these
 * cases you might want to reach for third party libraries.
 *
 * @example
 * ```ts
 * const isoDateState = createState('isoDate', {
 *   parse: (v): null | Date => {
 *     const date = typeof v === 'string' ? new Date(v) : null;
 *     return date && !isNaN(date.valueOf()) ? date : null;
 *   }
 *   isEqual: (a, b) => a === b || (a && b && a.valueOf() === b.valueOf()),
 *   unparse: (v) => v && v.toString()
 * });
 * ```
 *
 * You may find it easier to write a parse function using libraries like
 * zod, valibot, ajv, Effect, TypeBox, etc. perhaps with a wrapper function.
 */
export interface StateValueConfig<V> {
  /**
   * This function must return a default value when called with undefined,
   * otherwise it should parse the given JSON value to your type V. Note
   * that it is not required to copy or clone the given value, you can
   * pass it directly through if it matches the expected type.
   *
   * When you encounter an invalid value, it's up to you to decide
   * as to whether to ignore it and return the default value,
   * return some non-default error value, or throw an error.
   *
   * It is possible for V to include undefined, but if it does, then
   * it should also be considered the default value since undefined
   * can not be serialized to JSON so it is indistinguishable from the
   * default.
   *
   * Similarly, if your V is a function, then usage of {@link $setState}
   * must use an updater function because your type will be indistinguishable
   * from an updater function.
   */
  parse: (jsonValue: unknown) => V;
  /**
   * This is optional and for advanced use cases only.
   *
   * You may specify a function that converts V back to JSON.
   * This is mandatory when V is not a JSON serializable type.
   */
  unparse?: (parsed: V) => unknown;
  /**
   * This is optional and for advanced use cases only.
   *
   * Used to define the equality function so you can use an Array or Object
   * as V and still omit default values from the exported JSON.
   *
   * The default is `Object.is`, but something like `fast-deep-equal` might be
   * more appropriate for your use case.
   */
  isEqual?: (a: V, b: V) => boolean;
  /**
   * When a node is copied with {@link $copyNode} (not cloned), reset this
   * value to the default.
   */
  resetOnCopyNode?: boolean;
  /**
   * @experimental
   *
   * `true` when the node's own code recomputes this value from the document
   * (like a list item's number). It is serialized as usual, but tools that
   * copy or compare a node's data can leave it out, and `mergeAdjacent` may
   * not name it.
   */
  derived?: boolean;
}

/**
 * The return value of {@link createState}, for use with
 * {@link $getState} and {@link $setState}.
 */
export class StateConfig<K extends string | symbol, V> {
  /** The string key used when serializing this state to JSON */
  readonly key: K;
  /** The parse function from the StateValueConfig passed to createState */
  readonly parse: (value?: unknown) => V;
  /**
   * The unparse function from the StateValueConfig passed to createState,
   * with a default that is simply a pass-through that assumes the value is
   * JSON serializable.
   */
  readonly unparse: (value: V) => unknown;
  /**
   * An equality function from the StateValueConfig, with a default of
   * Object.is.
   */
  readonly isEqual: (a: V, b: V) => boolean;
  /**
   * The result of `stateValueConfig.parse(undefined)`, which is computed only
   * once and used as the default value. When the current value `isEqual` to
   * the `defaultValue`, it will not be serialized to JSON.
   */
  readonly defaultValue: V;
  readonly resetOnCopyNode: boolean;
  /** @experimental See {@link StateValueConfig.derived}. */
  readonly derived: boolean;
  /**
   * The {@link SerializationSchema} for this state's value, present when its
   * `parse` is a schema (e.g. `createState('mode', {parse: enumValue([...])})`).
   * It exposes the value's introspectable domain so tooling such as
   * `@lexical/fast-check` can generate examples of this state. It is undefined
   * when `parse` is a plain function with no schema metadata.
   */
  readonly schema?: AnySerializationSchema;
  constructor(key: K, stateValueConfig: StateValueConfig<V>) {
    this.key = key;
    this.derived = stateValueConfig.derived === true;
    // Binding below strips a schema's own properties from this.parse, so
    // resolve it first and keep the original when it carries introspectable
    // metadata.
    const schema = isIntrospectableSchema(stateValueConfig.parse)
      ? stateValueConfig.parse
      : undefined;
    this.schema = schema;
    this.parse = stateValueConfig.parse.bind(stateValueConfig);
    this.unparse = (stateValueConfig.unparse || coerceToJSON).bind(
      stateValueConfig,
    );
    // A schema already knows its own domain, so a `parse` that is one supplies
    // the equality and the default this state compares against — unless the
    // caller declared its own. Without this a reference-typed schema
    // (arrayValue/objectValue, which return a fresh value per parse) would fall
    // back to Object.is: NodeState.toJSON would never recognize the default and
    // would write it into every node, and $setState would dirty the node on
    // every write of an equal value.
    this.isEqual = stateValueConfig.isEqual
      ? stateValueConfig.isEqual.bind(stateValueConfig)
      : schema !== undefined && schema.isEqual !== undefined
        ? (a, b) => isSchemaEqual(schema, a, b)
        : Object.is;
    // $getState hands this very value to every node that has none of its own,
    // so a reference-typed default is shared. Every combinator that derives
    // its own default deep-freezes it, which turns "mutate one node's default
    // and corrupt every node" into a loud error; the exception is
    // `transformValue`, whose default is the caller's `transform` applied to
    // the inner default and so the caller's object to keep unfrozen.
    this.defaultValue =
      schema !== undefined ? schema.defaultValue : this.parse(undefined);
    this.resetOnCopyNode = stateValueConfig.resetOnCopyNode || false;
  }
}

/**
 * Whether a `parse` is one of the {@link SerializationSchema} builders, which
 * carry their domain alongside the coercion.
 *
 * It tests `meta.kind`, not `meta` alone: an unrelated parse function that
 * happens to own a `meta` property is not a schema, and publishing it as one
 * would hand introspecting tools a shape they cannot read. `defaultValue` is
 * required for the same reason from the other direction — it is what this
 * state's default is *taken from* below, so a function matching on `meta` but
 * carrying no default would silently replace `parse(undefined)` with
 * `undefined`, and every node with no value of its own would read as unset.
 */
function isIntrospectableSchema<V>(
  parse: StateValueConfig<V>['parse'],
): parse is SerializationSchema<V> {
  return (
    'meta' in parse &&
    typeof parse.meta === 'object' &&
    parse.meta !== null &&
    'kind' in parse.meta &&
    typeof parse.meta.kind === 'string' &&
    'defaultValue' in parse
  );
}

/**
 * For advanced use cases, using this type is not recommended unless
 * it is required (due to TypeScript's lack of features like
 * higher-kinded types).
 *
 * A {@link StateConfig} type with any key and any value that can be
 * used in situations where the key and value type can not be known,
 * such as in a generic constraint when working with a collection of
 * StateConfig.
 *
 * {@link StateConfigKey} and {@link StateConfigValue} will be
 * useful when this is used as a generic constraint.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStateConfig = StateConfig<any, any>;

/**
 * Create a StateConfig for the given string key and StateValueConfig.
 *
 * The key must be locally unique. In dev you will get a key collision error
 * when you use two separate StateConfig on the same node with the same key.
 *
 * The returned StateConfig value should be used with {@link $getState} and
 * {@link $setState}.
 *
 * @param key The key to use
 * @param valueConfig Configuration for the value type
 * @returns a StateConfig
 *
 * @__NO_SIDE_EFFECTS__
 */
export function createState<K extends symbol | string, V>(
  key: K,
  valueConfig: StateValueConfig<V>,
): StateConfig<K, V> {
  return new StateConfig(key, valueConfig);
}

/**
 * The accessor for working with node state. This will read the value for the
 * state on the given node, and will return `stateConfig.defaultValue` if the
 * state has never been set on this node.
 *
 * The `version` parameter is optional and should generally be {@link NODE_STATE_LATEST},
 * consistent with the behavior of other node methods and functions,
 * but for certain use cases such as `updateDOM` you may have a need to
 * use {@link NODE_STATE_DIRECT} to read the state from a previous version of the node.
 *
 * For very advanced use cases, you can expect that {@link NODE_STATE_DIRECT} does not
 * require an editor state, just like directly accessing other properties
 * of a node without an accessor (e.g. `textNode.__text`).
 *
 * @param node Any LexicalNode
 * @param stateConfig The configuration of the state to read
 * @param version The default value {@link NODE_STATE_LATEST} will read the latest version of the node state, {@link NODE_STATE_DIRECT} will read the version that is stored on this LexicalNode which not reflect the version used in the current editor state
 * @returns The current value from the state, or the default value provided by the configuration.
 */
export function $getState<K extends string, V>(
  node: LexicalNode,
  stateConfig: StateConfig<K, V>,
  version: NodeStateVersion = NODE_STATE_LATEST,
): V {
  const latestOrDirectNode =
    version === NODE_STATE_LATEST ? node.getLatest() : node;
  const state = latestOrDirectNode.__state;
  if (state) {
    $checkCollision(node, stateConfig, state);
    return state.getValue(stateConfig);
  }
  return stateConfig.defaultValue;
}

/**
 * Given two versions of a node and a stateConfig, compare their state values
 * using `$getState(nodeVersion, stateConfig, NODE_STATE_DIRECT)`.
 * If the values are equal according to `stateConfig.isEqual`, return `null`,
 * otherwise return `[value, prevValue]`.
 *
 * This is useful for implementing updateDOM. Note that the `NODE_STATE_DIRECT`
 * version argument is used for both nodes.
 *
 * @param node Any LexicalNode
 * @param prevNode A previous version of node
 * @param stateConfig The configuration of the state to read
 * @returns `[value, prevValue]` if changed, otherwise `null`
 */
export function $getStateChange<T extends LexicalNode, K extends string, V>(
  node: T,
  prevNode: T,
  stateConfig: StateConfig<K, V>,
): null | [value: V, prevValue: V] {
  const value = $getState(node, stateConfig, NODE_STATE_DIRECT);
  const prevValue = $getState(prevNode, stateConfig, NODE_STATE_DIRECT);
  return stateConfig.isEqual(value, prevValue) ? null : [value, prevValue];
}

/**
 * Set the state defined by stateConfig on node. Like with `React.useState`
 * you may directly specify the value or use an updater function that will
 * be called with the previous value of the state on that node (which will
 * be the `stateConfig.defaultValue` if not set).
 *
 * When an updater function is used, the node will only be marked dirty if
 * `stateConfig.isEqual(prevValue, value)` is false.
 *
 * @example
 * ```ts
 * const toggle = createState('toggle', {parse: Boolean});
 * // set it direction
 * $setState(node, counterState, true);
 * // use an updater
 * $setState(node, counterState, (prev) => !prev);
 * ```
 *
 * @param node The LexicalNode to set the state on
 * @param stateConfig The configuration for this state
 * @param valueOrUpdater The value or updater function
 * @returns node
 */
export function $setState<Node extends LexicalNode, K extends string, V>(
  node: Node,
  stateConfig: StateConfig<K, V>,
  valueOrUpdater: ValueOrUpdater<V>,
): Node {
  errorOnReadOnly();
  let value: V;
  if (typeof valueOrUpdater === 'function') {
    const latest = node.getLatest();
    const prevValue = $getState(latest, stateConfig);
    value = canonicalValue(
      stateConfig,
      (valueOrUpdater as (v: V) => V)(prevValue),
    );
    if (stateConfig.isEqual(prevValue, value)) {
      return latest;
    }
  } else {
    value = canonicalValue(stateConfig, valueOrUpdater);
  }
  const writable = node.getWritable();
  const state = $getWritableNodeState(writable);
  $checkCollision(node, stateConfig, state);
  state.updateFromKnown(stateConfig, value);
  return writable;
}

/**
 * The value {@link $setState} stores. An {@link arraySetValue} state puts a
 * written value into the canonical form its parse produces (frozen, sorted,
 * no duplicates), so a value set directly is stored, read back and compared
 * like one loaded from JSON. Every other state stores the value as given.
 */
function canonicalValue<K extends string, V>(
  stateConfig: StateConfig<K, V>,
  value: V,
): V {
  const {schema} = stateConfig;
  return schema !== undefined && schema.meta.kind === 'set'
    ? stateConfig.parse(value)
    : value;
}

/**
 * @internal
 *
 * Register the config to this node's sharedConfigMap and throw an exception in
 * `__DEV__` when a collision is detected.
 */
function $checkCollision<Node extends LexicalNode, K extends string, V>(
  node: Node,
  stateConfig: StateConfig<K, V>,
  state: NodeState<Node>,
): void {
  if (__DEV__) {
    const collision = state.sharedNodeState.sharedConfigMap.get(
      stateConfig.key,
    );
    if (collision !== undefined && collision !== stateConfig) {
      invariant(
        false,
        '$setState: State key collision %s detected in %s node with type %s and key %s. Only one StateConfig with a given key should be used on a node.',
        JSON.stringify(stateConfig.key),
        node.constructor.name,
        node.getType(),
        node.getKey(),
      );
    }
  }
}

/**
 * @internal
 *
 * Opaque state to be stored on the editor's RegisterNode for use by NodeState
 */
export type SharedNodeState = {
  sharedConfigMap: SharedConfigMap;
  flatKeys: Set<string>;
};

/**
 * @internal
 *
 * Create the state to store on RegisteredNode
 */
export function createSharedNodeState(
  nodeConfig: LexicalNodeConfig,
): SharedNodeState {
  const sharedConfigMap = new Map<string, AnyStateConfig>();
  const flatKeys = new Set<string>();
  for (const {ownNodeConfig} of iterStaticNodeConfigChain(
    typeof nodeConfig === 'function' ? nodeConfig : nodeConfig.replace,
  )) {
    if (ownNodeConfig && ownNodeConfig.stateConfigs) {
      for (const requiredStateConfig of ownNodeConfig.stateConfigs) {
        let stateConfig: AnyStateConfig;
        if ('stateConfig' in requiredStateConfig) {
          stateConfig = requiredStateConfig.stateConfig;
          if (requiredStateConfig.flat) {
            if (__DEV__) {
              // A flat state serializes at the top level of the node's JSON,
              // where it is read bare and told from an absent key by being
              // `undefined`. A serialized node comes from JSON.parse and
              // inherits Object.prototype, so a key named for one of its
              // members reads that member for a document that never carried
              // it. The same rule `objectSchema` applies to a schema property,
              // for the same reason. A nested state key is unaffected: it is
              // read out of the `$` blob, which is a record of its own.
              invariant(
                !(stateConfig.key in Object.prototype),
                'createState: flat state key "%s" is a member of Object.prototype, which a serialized node inherits, so it cannot be told apart from a key the document never carried',
                stateConfig.key,
              );
            }
            flatKeys.add(stateConfig.key);
          }
        } else {
          stateConfig = requiredStateConfig;
        }
        sharedConfigMap.set(stateConfig.key, stateConfig);
      }
    }
  }
  return {flatKeys, sharedConfigMap};
}

type KnownStateMap = Map<AnyStateConfig, unknown>;
type UnknownStateRecord = Record<string, unknown>;

/**
 * Keys that must never be written into an {@link UnknownStateRecord} from
 * serialized (potentially untrusted) input. Writing a `__proto__` entry would
 * re-parent the record's prototype, and because {@link NodeState.getValue}
 * resolves keys with the `in` operator (which walks the prototype chain) an
 * attacker could otherwise inject arbitrary state values via a crafted
 * `__proto__`. These are never produced by {@link createState}.
 */
const UNSAFE_STATE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
/**
 * @internal
 *
 * A Map of string keys to state configurations to be shared across nodes
 * and/or node versions.
 */
type SharedConfigMap = Map<string, AnyStateConfig>;

/**
 * @internal
 */
export class NodeState<T extends LexicalNode> {
  /**
   * @internal
   *
   * Track the (versioned) node that this NodeState was created for, to
   * facilitate copy-on-write for NodeState. When a LexicalNode is cloned,
   * it will *reference* the NodeState from its prevNode. From the nextNode
   * you can continue to read state without copying, but the first $setState
   * will trigger a copy of the prevNode's NodeState with the node property
   * updated.
   */
  readonly node: LexicalNode;

  /**
   * @internal
   *
   * State that has already been parsed in a get state, so it is safe. (can be returned with
   * just a cast since the proof was given before).
   *
   * Note that it uses StateConfig, so in addition to (1) the CURRENT VALUE, it has access to
   * (2) the State key (3) the DEFAULT VALUE and (4) the PARSE FUNCTION
   */
  readonly knownState: KnownStateMap;

  /**
   * @internal
   *
   * A copy of serializedNode[NODE_STATE_KEY] that is made when JSON is
   * imported but has not been parsed yet.
   *
   * It stays here until a set state replaces it with a known value, or the
   * node is next cloned and its key is known to the node type.
   *
   * Note that since only string keys are used here, we can only allow this
   * state to pass-through on export or on the next version since there is
   * no known value configuration. This pass-through is to support scenarios
   * where multiple versions of the editor code are working in parallel so
   * an old version of your code doesnt erase metadata that was
   * set by a newer version of your code.
   */
  unknownState: undefined | UnknownStateRecord;

  /**
   * @internal
   *
   * This sharedNodeState is preserved across all instances of a given
   * node type in an editor and remains writable. It is how keys are resolved
   * to configuration.
   */
  readonly sharedNodeState: SharedNodeState;
  /**
   * @internal
   *
   * The count of known or unknown keys in this state, ignoring the
   * intersection between the two sets.
   */
  size: number;

  /**
   * @internal
   */
  constructor(
    node: T,
    sharedNodeState: SharedNodeState,
    unknownState: undefined | UnknownStateRecord = undefined,
    knownState: KnownStateMap = new Map(),
    size: number | undefined = undefined,
  ) {
    this.node = node;
    this.sharedNodeState = sharedNodeState;
    this.unknownState = unknownState;
    this.knownState = knownState;
    const {sharedConfigMap} = this.sharedNodeState;
    const computedSize =
      size !== undefined
        ? size
        : computeSize(sharedConfigMap, unknownState, knownState);
    if (__DEV__) {
      invariant(
        size === undefined || computedSize === size,
        'NodeState: size != computedSize (%s != %s)',
        String(size),
        String(computedSize),
      );
      for (const stateConfig of knownState.keys()) {
        invariant(
          sharedConfigMap.has(stateConfig.key),
          'NodeState: sharedConfigMap missing knownState key %s',
          stateConfig.key,
        );
      }
    }
    this.size = computedSize;
  }

  /**
   * @internal
   *
   * Get the value from knownState, or parse it from unknownState
   * and cache in knownState if it contains the given key.
   *
   * Updates the sharedConfigMap when no known state is found.
   */
  getValue<K extends string, V>(stateConfig: StateConfig<K, V>): V {
    const known = this.knownState.get(stateConfig) as V | undefined;
    if (known !== undefined) {
      return known;
    }
    this.sharedNodeState.sharedConfigMap.set(stateConfig.key, stateConfig);
    let parsed = stateConfig.defaultValue;
    if (this.unknownState && stateConfig.key in this.unknownState) {
      const jsonValue = this.unknownState[stateConfig.key];
      if (jsonValue !== undefined) {
        parsed = stateConfig.parse(jsonValue);
      }
      // Record the parsed value. The JSON copy stays in unknownState so that
      // a read does not change the key order of toJSON, and the key is
      // already counted in size.
      this.knownState.set(stateConfig, parsed);
    }
    return parsed;
  }

  /**
   * @internal
   *
   * Used only for advanced use cases, such as collab. The intent here is to
   * allow you to diff states with a more stable interface than the properties
   * of this class.
   */
  getInternalState(): [
    {readonly [k in string]: unknown} | undefined,
    ReadonlyMap<AnyStateConfig, unknown>,
  ] {
    return [this.unknownState, this.knownState];
  }

  /**
   * Encode this NodeState to JSON in the format that its node expects.
   * This returns `{[NODE_STATE_KEY]?: UnknownStateRecord}` rather than
   * `UnknownStateRecord | undefined` so that we can support flattening
   * specific entries in the future when nodes can declare what
   * their required StateConfigs are.
   */
  toJSON(): NodeStateJSON<T> {
    const state = {...this.unknownState};
    const flatState: Record<string, unknown> = {};
    for (const [stateConfig, v] of this.knownState) {
      if (stateConfig.isEqual(v, stateConfig.defaultValue)) {
        delete state[stateConfig.key];
      } else {
        state[stateConfig.key] = stateConfig.unparse(v);
      }
    }
    for (const key of this.sharedNodeState.flatKeys) {
      if (key in state) {
        flatState[key] = state[key];
        delete state[key];
      }
    }
    if (undefinedIfEmpty(state)) {
      flatState[NODE_STATE_KEY] = state;
    }
    return flatState as NodeStateJSON<T>;
  }

  /**
   * @internal
   *
   * A NodeState is writable when the node to update matches
   * the node associated with the NodeState. This basically
   * mirrors how the EditorState NodeMap works, but in a
   * bottom-up organization rather than a top-down organization.
   *
   * This allows us to implement the same "copy on write"
   * pattern for state, without having the state version
   * update every time the node version changes (e.g. when
   * its parent or siblings change).
   *
   * @param node The node to associate with the state
   * @returns The next writable state
   */
  getWritable(node: T): NodeState<T> {
    if (this.node === node) {
      return this;
    }
    const {sharedNodeState, unknownState} = this;
    const nextKnownState = new Map(this.knownState);
    return new NodeState(
      node,
      sharedNodeState,
      parseAndPruneNextUnknownState(
        sharedNodeState.sharedConfigMap,
        nextKnownState,
        unknownState,
      ),
      nextKnownState,
      this.size,
    );
  }

  /** @internal */
  resetOnCopyNode(): this {
    for (const stateConfig of this.knownState.keys()) {
      if (stateConfig.resetOnCopyNode) {
        this.knownState.set(stateConfig, stateConfig.defaultValue);
      }
    }
    return this;
  }

  /** @internal */
  updateFromKnown<K extends string, V>(
    stateConfig: StateConfig<K, V>,
    value: V,
  ): void {
    const key = stateConfig.key;
    this.sharedNodeState.sharedConfigMap.set(key, stateConfig);
    const {knownState, unknownState} = this;
    if (unknownState && key in unknownState) {
      // The known value replaces the JSON copy, which getValue would
      // otherwise parse again once the known value is undefined. The key is
      // already counted in size.
      delete unknownState[key];
      this.unknownState = undefinedIfEmpty(unknownState);
    } else if (!knownState.has(stateConfig)) {
      this.size++;
    }
    knownState.set(stateConfig, value);
  }

  /**
   * @internal
   *
   * This is intended for advanced use cases only, such
   * as collab or dev tools.
   *
   * Update a single key value pair from unknown state,
   * parsing it if the key is known to this node. This is
   * basically like updateFromJSON, but the effect is
   * isolated to a single entry.
   *
   * @param k The string key from an UnknownStateRecord
   * @param v The unknown value from an UnknownStateRecord
   */
  updateFromUnknown(k: string, v: unknown): void {
    if (UNSAFE_STATE_KEYS.has(k)) {
      return;
    }
    const stateConfig = this.sharedNodeState.sharedConfigMap.get(k);
    if (stateConfig) {
      this.updateFromKnown(stateConfig, stateConfig.parse(v));
    } else {
      this.unknownState = this.unknownState || {};
      if (!(k in this.unknownState)) {
        this.size++;
      }
      this.unknownState[k] = v;
    }
  }

  /**
   * @internal
   *
   * Reset all existing state to default or empty values,
   * and perform any updates from the given unknownState.
   *
   * This is used when initializing a node's state from JSON,
   * or when resetting a node's state from JSON.
   *
   * @param unknownState The new state in serialized form
   */
  updateFromJSON(unknownState: undefined | UnknownStateRecord): void {
    const {knownState} = this;
    // Reset all known state to defaults
    for (const stateConfig of knownState.keys()) {
      knownState.set(stateConfig, stateConfig.defaultValue);
    }
    // Since we are resetting all state to this new record,
    // the size starts at the number of known keys
    // and will be updated as we traverse the new state
    this.size = knownState.size;
    this.unknownState = undefined;
    if (unknownState) {
      for (const [k, v] of Object.entries(unknownState)) {
        this.updateFromUnknown(k, v);
      }
    }
  }
}

/**
 * @internal
 *
 * Only for direct use in very advanced integrations, such as lexical-yjs.
 * Typically you would only use {@link createState}, {@link $getState}, and
 * {@link $setState}. This is effectively the preamble for {@link $setState}.
 */
export function $getWritableNodeState<T extends LexicalNode>(
  node: T,
): NodeState<T> {
  const writable = node.getWritable();
  const state = writable.__state
    ? writable.__state.getWritable(writable)
    : new NodeState(writable, $getSharedNodeState(writable));
  writable.__state = state;
  return state;
}

/**
 * @internal
 *
 * Get the SharedNodeState for a node on this editor
 */
export function $getSharedNodeState<T extends LexicalNode>(
  node: T,
): SharedNodeState {
  return node.__state
    ? node.__state.sharedNodeState
    : getRegisteredNodeOrThrow($getEditor(), node.getType()).sharedNodeState;
}

/**
 * @internal
 *
 * This is used to implement LexicalNode.updateFromJSON and is
 * not intended to be exported from the package.
 *
 * @param node any LexicalNode
 * @param unknownState undefined or a serialized State
 * @returns A writable version of node, with the state set.
 */
export function $updateStateFromJSON<T extends LexicalNode>(
  node: T,
  serialized: LexicalParseJSON<SerializedLexicalNode>,
): T {
  const writable = node.getWritable();
  // Only the nested NodeState (under NODE_STATE_KEY) is applied here; flat
  // states, which serialize at the top level, are applied via $setState by the
  // node's compiled serialization schema (see $applyJSONSetters).
  const unknownState = serialized[NODE_STATE_KEY];
  if (writable.__state || unknownState) {
    $getWritableNodeState(node).updateFromJSON(unknownState);
  }
  return writable;
}

/**
 * @internal
 *
 * Return true if the two nodes have equivalent NodeState, to be used
 * to determine when TextNode are being merged, not a lot of use cases
 * otherwise.
 */
export function nodeStatesAreEquivalent<T extends LexicalNode>(
  a: undefined | NodeState<T>,
  b: undefined | NodeState<T>,
): boolean {
  if (a === b) {
    return true;
  }
  const keys = new Set<string>();
  return !(
    (a && hasUnequalMapEntry(keys, a, b)) ||
    (b && hasUnequalMapEntry(keys, b, a)) ||
    (a && hasUnequalRecordEntry(keys, a, b)) ||
    (b && hasUnequalRecordEntry(keys, b, a))
  );
}

/**
 * Compute the number of distinct keys that will be in a NodeState
 */
function computeSize(
  sharedConfigMap: SharedConfigMap,
  unknownState: UnknownStateRecord | undefined,
  knownState: KnownStateMap,
): number {
  let size = knownState.size;
  if (unknownState) {
    for (const k in unknownState) {
      const sharedConfig = sharedConfigMap.get(k);
      if (!sharedConfig || !knownState.has(sharedConfig)) {
        size++;
      }
    }
  }
  return size;
}

/**
 * @internal
 *
 * Return obj if it is an object with at least one property, otherwise
 * return undefined.
 */
function undefinedIfEmpty<T extends object>(obj: undefined | T): undefined | T {
  if (obj) {
    for (const key in obj) {
      return obj;
    }
  }
  return undefined;
}

/**
 * @internal
 *
 * Cast the given v to unknown
 */
function coerceToJSON(v: unknown): unknown {
  return v;
}

/**
 * @internal
 *
 * Parse all knowable values in an UnknownStateRecord into nextKnownState
 * and return the unparsed values in a new UnknownStateRecord. Returns
 * undefined if no unknown values remain.
 */
function parseAndPruneNextUnknownState(
  sharedConfigMap: SharedConfigMap,
  nextKnownState: KnownStateMap,
  unknownState: undefined | UnknownStateRecord,
): undefined | UnknownStateRecord {
  let nextUnknownState: undefined | UnknownStateRecord = undefined;
  if (unknownState) {
    for (const [k, v] of Object.entries(unknownState)) {
      if (UNSAFE_STATE_KEYS.has(k)) {
        continue;
      }
      const stateConfig = sharedConfigMap.get(k);
      if (stateConfig) {
        if (!nextKnownState.has(stateConfig)) {
          nextKnownState.set(stateConfig, stateConfig.parse(v));
        }
      } else {
        nextUnknownState = nextUnknownState || {};
        nextUnknownState[k] = v;
      }
    }
  }
  return nextUnknownState;
}

/**
 * @internal
 *
 * Compare each entry of sourceState.knownState that is not in keys to
 * otherState (or the default value if otherState is undefined.
 * Note that otherState will return the defaultValue as well if it
 * has never been set. Any checked entry's key will be added to keys.
 *
 * @returns true if any difference is found, false otherwise
 */
function hasUnequalMapEntry<T extends LexicalNode>(
  keys: Set<string>,
  sourceState: NodeState<T>,
  otherState?: NodeState<T>,
): boolean {
  for (const [stateConfig, value] of sourceState.knownState) {
    if (keys.has(stateConfig.key)) {
      continue;
    }
    keys.add(stateConfig.key);
    const otherValue = otherState
      ? otherState.getValue(stateConfig)
      : stateConfig.defaultValue;
    if (otherValue !== value && !stateConfig.isEqual(otherValue, value)) {
      return true;
    }
  }
  return false;
}

/**
 * @internal
 *
 * Compare each entry of sourceState.unknownState that is not in keys to
 * otherState.unknownState (or undefined if otherState is undefined).
 * Any checked entry's key will be added to keys.
 *
 * Notably since we have already checked hasUnequalMapEntry on both sides,
 * we do not do any parsing or checking of knownState.
 *
 * @returns true if any difference is found, false otherwise
 */
function hasUnequalRecordEntry<T extends LexicalNode>(
  keys: Set<string>,
  sourceState: NodeState<T>,
  otherState?: NodeState<T>,
): boolean {
  const {unknownState} = sourceState;
  const otherUnknownState = otherState ? otherState.unknownState : undefined;
  if (unknownState) {
    for (const [key, value] of Object.entries(unknownState)) {
      if (keys.has(key)) {
        continue;
      }
      keys.add(key);
      const otherValue = otherUnknownState ? otherUnknownState[key] : undefined;
      if (value !== otherValue) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @internal
 *
 * Clones the NodeState for a given node. Handles aliasing if the state references the from node.
 */
export function $cloneNodeState<T extends LexicalNode>(
  from: T,
  to: T,
): undefined | NodeState<T> {
  const state = from.__state;
  return state && state.node === from ? state.getWritable(to) : state;
}
