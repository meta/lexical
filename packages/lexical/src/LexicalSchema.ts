/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {PROTOTYPE_CONFIG_METHOD} from './LexicalConstants';
import type {LEXICAL_NODE_BRAND} from './LexicalNode';

import invariant from '@lexical/internal/invariant';

/**
 * The key of {@link SerializationSchema}'s phantom `Names` member. Declared
 * rather than defined: it exists only in the type system, so no value is ever
 * created and nothing is emitted for it.
 *
 * @internal
 */
declare const NAMES: unique symbol;

/**
 * The key of {@link NodeSerializationSchema}'s phantom `N` member, which
 * records the node a schema's names were checked against. Declared rather than
 * defined, like {@link NAMES}.
 *
 * @internal
 */
declare const CHECKED_AGAINST: unique symbol;

/**
 * The key of {@link SerializationSchema}'s phantom `In` member. Declared rather
 * than defined, like {@link NAMES}.
 *
 * @internal
 */
declare const INPUT: unique symbol;

/**
 * A function that validates an untrusted `value` (such as a property parsed
 * from JSON) and coerces it into the expected type `T`, returning a default
 * value when `value` is not in the expected domain.
 *
 * By convention — and exactly like the `parse` of {@link StateValueConfig} —
 * calling a `Parse` with `undefined` returns its default value.
 */
export type Parse<T> = (value: unknown) => T;

/**
 * A structural, introspectable description of a {@link SerializationSchema}. It carries
 * exactly the information needed to coerce a value (which the schema closes
 * over) so that tooling can also walk it — for example to derive a `fast-check`
 * arbitrary that generates example values, or to emit a JSON Schema document. The data
 * here is the same domain information the parser already needs, so making it
 * available costs (almost) nothing in the production bundle.
 */
export type SerializationSchemaMeta =
  | {readonly kind: 'string'}
  | {
      readonly kind: 'number';
      /** The inclusive lower bound of the domain, when constrained. */
      readonly min?: number;
      /** The inclusive upper bound of the domain, when constrained. */
      readonly max?: number;
      /** Whether the domain is restricted to integers. */
      readonly integer?: boolean;
      /** Whether a finite value outside the bounds clamps to the nearest. */
      readonly clamp?: boolean;
    }
  | {readonly kind: 'boolean'}
  | {readonly kind: 'enum'; readonly values: readonly unknown[]}
  | {readonly kind: 'array'; readonly item: InnerSerializationSchema}
  | {
      /**
       * An {@link arraySetValue}: an array of distinct `item` strings used as
       * a set, sorted, so that its order carries no meaning.
       *
       * This kind is also how code outside the core recognizes a set-valued
       * NodeState: `stateConfig.schema?.meta.kind === 'set'` marks the value
       * as a set whose members are independent, so code that stores or
       * merges NodeState can treat each member separately.
       *
       * @experimental
       */
      readonly kind: 'set';
      readonly item: InnerSerializationSchema;
    }
  | {
      readonly kind: 'nullable';
      readonly inner: InnerSerializationSchema;
      /** Whether a value equal to `inner`'s default is treated as `null`. */
      readonly defaultAsNull?: boolean;
    }
  | {
      readonly kind: 'optional';
      readonly inner: InnerSerializationSchema;
      /** Whether a value equal to `inner`'s default is treated as absent. */
      readonly omitDefault?: boolean;
    }
  | {
      readonly kind: 'union';
      readonly members: readonly InnerSerializationSchema[];
    }
  | {readonly kind: 'raw'}
  | {readonly kind: 'object'; readonly fields: SerializationSchemaFields}
  | {
      readonly kind: 'aliased';
      readonly inner: InnerSerializationSchema;
      /** Legacy input spellings, mapped to the value each denotes. */
      readonly aliases: {readonly [alias: string]: unknown};
    }
  | {
      /**
       * A {@link transformValue}: `inner`'s domain on the way in, and an
       * opaque function on the way out.
       *
       * The kind exists to say that last part. The transform is an arbitrary
       * closure, so it is the one part of a schema that cannot be described
       * structurally, and a consumer that walked into `inner` and stopped —
       * which is what inheriting `inner`'s meta made every consumer do — would
       * be describing the schema's *input* while believing it had described
       * its output. For a generator of example inputs that is the right
       * answer; for a code generator it is a parse that silently drops the
       * transform.
       */
      readonly kind: 'transform';
      readonly inner: InnerSerializationSchema;
    };

/** Domain constraints for {@link numberValue}. */
export interface NumberValueOptions {
  /**
   * Reject values below this bound (inclusive). With `integer`, the bound is
   * rounded up to the integer it admits — the same domain, stated so that
   * `clamp` and anything reading the schema's `meta` see a member.
   */
  readonly min?: number;
  /** Reject values above this bound (inclusive); see {@link NumberValueOptions.min}. */
  readonly max?: number;
  /** Reject values that are not integers. */
  readonly integer?: boolean;
  /**
   * Bring a value outside `min`/`max` to the nearest bound instead of
   * rejecting it. Only a finite number is clamped: a value that is not a
   * number at all, or is not an integer when `integer` is set, still falls
   * back to the default, because there is no nearest bound for it.
   *
   * The distinction matters wherever the bound exists to cap work rather than
   * to describe the domain. `ListItemNode`'s indent is capped because
   * applying it nests one list per level, and an over-deep item read as the
   * default `0` would be flattened, where clamping keeps it as deep as the
   * cap allows.
   */
  readonly clamp?: boolean;
}

/**
 * A `SerializationSchema` is a {@link Parse} (so it can be called directly to coerce a value
 * and dropped straight into {@link createState}'s `parse` option) that also
 * carries its recoverable {@link SerializationSchema.defaultValue | default} and an
 * introspectable {@link SerializationSchemaMeta | meta} description of its domain.
 *
 * Schemas are built with {@link stringValue}, {@link numberValue},
 * {@link booleanValue}, {@link enumValue}, {@link nullable}, and composed into
 * whole-object schemas with {@link objectValue} — {@link nodeSchema} for a
 * node's own, which is where accessors are named.
 */
export interface SerializationSchema<T, Decls = never, In = T> {
  (value: unknown): T;
  /**
   * The serialized values this schema *accepts*, as distinct from the `T` it
   * parses them to. The two differ wherever a schema reads more than it
   * writes: `numberValue` reads a stringified number, `aliasedValue` reads the
   * legacy spellings a document may still carry, `optional` reads an absent
   * property. Carried so that what generates or type-checks an *input* — a
   * `@lexical/fast-check` arbitrary, a document being parsed — can say what is
   * admissible rather than describing the output and being wrong about the
   * difference.
   *
   * Defaults to `T`, which is right for every schema that accepts exactly what
   * it produces.
   *
   * @internal
   */
  readonly [INPUT]?: In;
  /**
   * Every node member this schema's declarations name — each `field`, each
   * accessor `method`, each `when` predicate — carried in the type so that
   * `$config` can check them against the node they are declared for. Erased at
   * runtime: nothing reads it, and no combinator assigns it.
   *
   * Defaults to `never` — a schema that names nothing constrains nothing, and
   * `never` satisfies every checked position — so `SerializationSchema<T>`
   * still means what it always did and a plain `stringValue()` needs no node
   * to be declared against.
   *
   * @internal
   */
  readonly [NAMES]?: Decls;
  /** The value returned for an out-of-domain input, i.e. `schema(undefined)`. */
  readonly defaultValue: T;
  /**
   * @experimental
   *
   * `true` when the node's own code recomputes the property from the
   * document (declared with `withField(schema, {derived: true, field})` or
   * `withAccessors(schema, {derived: true})`). It is serialized as usual, but
   * tools that copy or compare a node's data can leave it out, and
   * `mergeAdjacent` may not name it.
   */
  readonly derived?: true;
  /** An introspectable description of this schema's domain. */
  readonly meta: SerializationSchemaMeta;
  /**
   * The name of the node setter that applies a parsed value of this schema when
   * the base {@link LexicalNode.updateFromJSON} walks a node's serialization
   * schema. When omitted, the setter name defaults to `set<Prop>` for the
   * property this
   * schema is bound to in a {@link nodeSchema} (e.g. `foo` → `setFoo`). Use
   * {@link withAccessors} to record a name that doesn't follow that convention
   * (e.g. TextNode's `text` → `setTextContent`), or a {@link SchemaField} to
   * write the value straight to a node field.
   */
  readonly setter?: SchemaSetterAccessor;
  /**
   * The name of the node getter that reads this property's value when the base
   * {@link LexicalNode.exportJSON} walks a node's serialization schema. When
   * omitted, the getter name defaults to `get<Prop>` (e.g. `foo` → `getFoo`).
   * Use
   * {@link withAccessors} to record a name that doesn't follow that convention
   * (e.g. TextNode's `text` → `getTextContent`), or a {@link SchemaField} to
   * read the value straight from a node field. A getter that returns
   * `undefined` omits the property from the exported JSON.
   */
  readonly getter?: SchemaGetterAccessor;
  /**
   * Whether two values of this schema's domain say the same thing, for the
   * comparisons that treat a value as absent: compaction dropping a property
   * whose value is {@link SerializationSchema.defaultValue | the default}, and
   * `optional({omitDefault})` / `nullable({defaultAsNull})`.
   *
   * Absent means identity, which is right for the primitive domains but never
   * true of a reference-typed default: {@link arrayValue} and
   * {@link objectValue} return a fresh value per parse, so without this an
   * array-valued property equal to its default would still be written out.
   * Mirrors `StateValueConfig.isEqual`, which exists for the same reason.
   *
   * Not consulted through a {@link unionValue}, which compares structurally
   * because it cannot know which member produced a value. The built-in
   * reference-typed comparators *are* that comparison, so only a custom one
   * from {@link transformValue} differs there; see `unionValue` for what it
   * costs.
   *
   * Declared with method syntax deliberately: TypeScript checks a method's
   * parameters bivariantly, which keeps `SerializationSchema<T>` assignable to
   * {@link AnySerializationSchema}. A property would make the type invariant
   * in `T` and every `AnySerializationSchema` position would reject it.
   *
   * `this: void` because method syntax otherwise implies a receiver this never
   * has: every caller reads the comparator off the schema and calls it on its
   * own — NodeState equality, `optional({omitDefault})` and the compact export
   * all do — so a comparator written to read `this.meta` type-checked and then
   * threw. Declaring the receiver away says so, and costs nothing: the `this`
   * parameter is not a parameter for bivariance's purposes, so the
   * assignability above is unchanged.
   */
  isEqual?(this: void, a: T, b: T): boolean;
  /**
   * Whether `value` is in this schema's domain, for {@link unionValue} deciding
   * which member a value belongs to.
   *
   * A schema is total — it always returns a value — so membership normally has
   * to be inferred from the parse: landing anywhere but the default means the
   * value was recognized. That inference cannot see a value the schema
   * *normalizes into* its own default, which is why a schema that accepts more
   * than its own value type says so directly.
   *
   * This asks about a serialized *input*, not about a parsed value, so it is
   * not a predicate on `T`: a schema that reads more than it writes accepts
   * inputs no `T` ever equals, and a {@link transformValue} out of its inner
   * type accepts none of the values it produces. In particular, a combinator
   * may — and {@link numberValue} with a `min` deliberately does — decline the
   * very value it defaults to, which is how a union member says "this value is
   * not mine" and lets the union fall through to the member that owns it.
   */
  accepts?(value: unknown): boolean;
}

/**
 * Whether two values of `schema`'s domain say the same thing: identity, unless
 * the schema declares otherwise. The identity test comes first so a primitive
 * domain — every schema but {@link arrayValue} and {@link objectValue} — costs
 * a comparison rather than a call.
 *
 * @internal
 */
export function isSchemaEqual<T>(
  schema: SerializationSchema<T, unknown, unknown>,
  a: T,
  b: T,
): boolean {
  const {isEqual} = schema;
  return a === b || (isEqual !== undefined && isEqual(a, b));
}

/**
 * Whether `value` is the one `schema` would restore for an absent property, so
 * writing it says nothing.
 *
 * @internal
 */
export function isSchemaDefault<T>(
  schema: SerializationSchema<T, unknown, unknown>,
  value: T,
): boolean {
  return isSchemaEqual(schema, value, schema.defaultValue);
}

/**
 * Declares that a serialized property *is* a node field, read and written
 * directly rather than through an accessor method. The kind is stated rather
 * than inferred from the name: a field and a method are different things to
 * reach for, and deciding between them by looking at the string would make a
 * node's field naming part of this API's contract.
 */
export interface SchemaFieldBase {
  readonly field: string;
  /**
   * The accessor method this direct field access stands in for, when it is not
   * the conventional `get<Prop>`/`set<Prop>` for the property. Naming one keeps
   * a subclass in charge of its own property: if any class between the one that
   * declared this field and the node's own class overrides that method, the
   * field access is abandoned and the method is called instead.
   *
   * Leaving it out defers to the conventional name, which is what nearly every
   * property wants — a node that predates its schema already has those
   * accessors, and overriding `getStyle()` on a TextNode subclass is ordinary,
   * so migrating a property to a field must not silently take that back. Name
   * one only when the accessor is spelled differently, as TextNode's `text` is
   * (`getTextContent`) and LinkNode's `url` is (`getURL`). A class with no such
   * method defers to nothing, since both prototypes then resolve `undefined`.
   */
  readonly method?: string;
}

/** A node field read directly on export. */
export interface SchemaGetterField extends SchemaFieldBase {
  /**
   * Declared as `never` rather than left out: an excess property is only
   * rejected for a fresh object literal, and these accessors are captured by
   * an inferred type parameter (so the schema can carry the names it
   * declares), which is not fresh. Stating the wrong direction's table as
   * `never` rejects it by assignability instead, which inference cannot
   * launder away.
   */
  readonly setterTable?: never;
  /**
   * The name of a node predicate that decides whether this property is written
   * at all. Naming it keeps the property on the direct-field path: without it,
   * a conditionally-persisted property needs an accessor method, and a method
   * is a call plus a `getLatest()` on every export of every node.
   *
   * The property is written only when its value differs from the schema
   * default *and* the predicate returns true — the default is what parsing
   * would restore anyway, so writing it says nothing, and testing it first is
   * what keeps the predicate off the common path. ElementNode's `textFormat`
   * and `textStyle` are the motivating case: both are persisted only for an
   * element with no TextNode child.
   *
   * The predicate must be a pure, zero-argument method: it is called once per
   * export by the walk for each property that names it, and once in total by
   * generated code, which hoists a predicate that several properties share.
   *
   * Like the field read it gates, this is what {@link SchemaFieldBase.method}
   * stands in for: a subclass that overrides that accessor abandons the field
   * *and* the predicate, because a method that replaces the read replaces the
   * decision to make it.
   */
  readonly when?: string;
  /**
   * A lookup table from the stored field value to the serialized one, for a
   * property whose two representations differ — TextNode stores `mode` as a
   * bitmask and serializes it as a name.
   *
   * Without this such a property needs an accessor method, and a method is a
   * call plus, by convention, a `getLatest()`. Stating the mapping keeps the
   * property on the direct-read path: the table is a plain object of
   * primitives, so it is as inlinable by a code generator as the field read is.
   *
   * The export direction's table; {@link SchemaSetterField.setterTable} is its
   * import mirror. Each is declared only on the direction that reads it, so
   * naming the wrong one is a type error rather than a silently ignored
   * property.
   */
  readonly getterTable?: {readonly [key: string]: unknown};
}

/** A node field written directly on import. */
export interface SchemaSetterField extends SchemaFieldBase {
  /** @see {@link SchemaGetterField.setterTable} for why this is `never`. */
  readonly getterTable?: never;
  /**
   * A predicate gates the export direction only, so naming one here is the
   * same mistake as naming the wrong table; see
   * {@link SchemaGetterField.setterTable}.
   */
  readonly when?: never;
  /**
   * A lookup table from the serialized value to the stored one — the inverse of
   * {@link SchemaGetterField.getterTable}, for the import direction. The parsed
   * value is the key, so the schema still owns the domain: only a value the
   * schema admitted is ever looked up.
   */
  readonly setterTable?: {readonly [key: string]: unknown};
}

/**
 * A node field in whichever direction it was declared for. Prefer the
 * direction-specific types when the direction is known — this union admits
 * both tables, so it cannot reject the one that does not belong.
 */
export type SchemaField = SchemaGetterField | SchemaSetterField;

/**
 * One direction of a {@link SerializationSchema} field: a method name, a
 * {@link SchemaField} naming a node field, or `null` for a direction that is
 * deliberately unsupported.
 */
export type SchemaAccessor = string | SchemaField | null;

/** How the export direction reaches a property. */
export type SchemaGetterAccessor = string | SchemaGetterField | null;

/** How the import direction reaches a property. */
export type SchemaSetterAccessor = string | SchemaSetterField | null;

/**
 * Both directions of a property that *is* a node field, as {@link withField}
 * takes them: the field name, the two value tables (each used by the one
 * direction it names), and the accessor each direction stands in for.
 */
export interface FieldOptions {
  readonly field: string;
  /** @see {@link SchemaGetterField.getterTable} */
  readonly getterTable?: {readonly [key: string]: unknown};
  /** @see {@link SchemaSetterField.setterTable} */
  readonly setterTable?: {readonly [key: string]: unknown};
  /** The getter this field read stands in for; see {@link SchemaFieldBase.method}. */
  readonly getter?: string;
  /** The setter this field write stands in for; see {@link SchemaFieldBase.method}. */
  readonly setter?: string;
  /**
   * The predicate gating the export direction; see
   * {@link SchemaGetterField.when}. Like `getterTable`, it belongs to one direction
   * only — the import direction has nothing to gate, since a property that was
   * not written is simply absent.
   */
  readonly when?: string;
  /**
   * @experimental
   *
   * `true` when the node's own code recomputes this property from the
   * document (a list item's `value` follows from its position in its list).
   * See {@link SerializationSchema.derived}.
   */
  readonly derived?: boolean;
}

/**
 * The node accessors a {@link SerializationSchema} field is applied through.
 *
 * A string resolves to a method on the node; `{field}` resolves to one of the
 * node's own fields. `null` states that the direction is deliberately
 * unsupported — an export-only property computed from others (`setter: null`,
 * as ListNode's `tag` is derived from `listType`) or an import-only one
 * (`getter: null`). Leaving a direction undefined uses the conventional
 * `get<Prop>`/`set<Prop>` name, which must exist: a name that resolves to
 * nothing would silently drop the property, so it fails at registration.
 *
 * The two directions are independent, and a node may reasonably mix them:
 * TableCellNode reads `headerState` straight off the field but applies it
 * through `setHeaderStyles`, which supplies a default mask.
 */
export interface SchemaAccessors {
  readonly getter?: SchemaGetterAccessor;
  readonly setter?: SchemaSetterAccessor;
  /**
   * @experimental
   *
   * `true` when the node's own code recomputes the property from the
   * document (a list item's `indent` follows from its nesting). See
   * {@link SerializationSchema.derived}.
   */
  readonly derived?: boolean;
}

/**
 * Every member of `N` a schema may name: its own fields (`__`-prefixed by
 * convention, which is what makes them distinguishable) and its methods, which
 * covers accessors and `when` predicates alike.
 *
 * This is what `$config` checks a node's schema against, so a `field`,
 * `getter`, `setter` or `when` naming something the node does not have is a
 * compile error at the declaration rather than a property that silently stops
 * round-tripping.
 */
export type MemberOf<N> =
  | TaggedNamesOf<N>
  | ObligationsOf<N>
  // Which directions a declaration covers (see {@link AccessorName}) asks
  // nothing of the node, so every node discharges it — as does a direction
  // declared `null`, which is derived.
  | `declared:${'get' | 'set'}`
  | `derived:${'get' | 'set'}`;

/**
 * A node {@link nodeSchema} can check: one with a member list. A class with a
 * string index signature — and `any` — has `keyof N` of `string | number`, so
 * every name filter above reduces to `never` and a correctly spelled name was
 * refused with an error that named no member. Rather than declare such a node
 * unchecked, which is the silent failure the check exists to remove, it is
 * refused where the node is named.
 */
type Checkable<N> = string extends keyof N ? never : unknown;

/**
 * Every tagged name `N` admits, per position — the check that a declaration
 * names a member the node has *and* one usable where it was written.
 */
type TaggedNamesOf<N> =
  | `field:${FieldsOf<N>}`
  | `get:${ZeroArgMethodsOf<N, unknown>}`
  | `set:${SettersOf<N>}`
  | `when:${ZeroArgMethodsOf<N, boolean>}`;

/**
 * What a declaration requires of the node member it names, beyond the member
 * existing: a field holds what the schema parses, a getter returns it, a setter
 * accepts it. A name says which member; these say what it has to be.
 *
 * Carried in the same phantom as the names, so nothing has to thread a second
 * one: a typo is a string mismatch and reports with the correction suggested,
 * while a type mismatch is an object mismatch and reports the two types.
 */
/**
 * Reading a field of `V` for a schema of `T`: safe when the field's type fits
 * the schema's domain, so the value travels in the parameter position and the
 * check is contravariant — the same shape, and the same reason, as
 * {@link GetterObligation}.
 */
/**
 * `Returnable` for the same reason {@link GetterObligation} uses it: `readonly`
 * is a property of the reference, not of the JSON, and serializing an array
 * does not mutate it — so a field declared `readonly number[]` satisfies an
 * `arrayValue(numberValue())` read, exactly as a method getter returning one
 * does. Checking the bare `T` rejected the field and accepted the method for
 * the same schema.
 */
interface FieldReadObligation<F extends string, V> {
  readonly reads: F;
  readonly read: (value: V) => void;
}
/**
 * Writing a field of `V` with a schema of `T`: safe when what the schema
 * parses fits the field, so the value is covariant, as {@link
 * SetterObligation} is.
 *
 * Split from the read direction because one obligation cannot answer both. It
 * was covariant only, which let `withField(stringValue(), {field: '__label'})`
 * discharge against `__label: string | number` — exporting `42` and parsing it
 * back gave `''` — while rejecting a getter-only `booleanValue()` reading
 * `__flag: true`, which is sound in the direction that one actually travels.
 */
interface FieldWriteObligation<F extends string, V> {
  readonly writes: F;
  readonly write: V;
}
/**
 * A `getterTable`'s check, in place of the field read it stands in for: every
 * value the table maps a stored value to has to be one the schema serializes,
 * or `undefined`, which omits the property. Nothing on the node can discharge
 * it — the field holds the table's keys, not its values — so it is decided
 * here: `never` when every value fits, and otherwise a shape no
 * {@link MemberOf} contains, reported at the property with the values that do
 * not. The import direction needs no counterpart: a `setterTable`'s values
 * are written into the field, which is a {@link FieldWriteObligation} over
 * those values.
 */
type GetterTableMismatch<F extends string, D, T> = [
  Exclude<D[keyof D], Returnable<T> | undefined>,
] extends [never]
  ? never
  : TableValueMismatch<
      'getterTable',
      F,
      Exclude<D[keyof D], Returnable<T> | undefined>
    >;
interface TableValueMismatch<Table extends string, F extends string, V> {
  readonly table: Table;
  readonly field: F;
  readonly maps: V;
}
/**
 * A `setterTable`'s coverage: a parsed value the table does not map is stored
 * as the *encoded default*, so the table has to map every value the schema
 * can produce, the default first of all — one it does not map has no stored
 * form, and the walk would write the raw default into the field. A finite
 * domain (an enum's) is decidable here, compared as the property keys the
 * lookup uses; a domain the types cannot enumerate (`stringValue`'s) is left
 * to registration, which checks that the default is mapped. `never` when
 * every member has an entry, and otherwise a shape no {@link MemberOf}
 * contains, naming the members that do not.
 */
type SetterTableMissing<F extends string, E, T> = string extends T
  ? never
  : number extends T
    ? never
    : [Exclude<`${T & Keyable}`, `${keyof E & Keyable}`>] extends [never]
      ? never
      : TableKeyMissing<
          'setterTable',
          F,
          Exclude<`${T & Keyable}`, `${keyof E & Keyable}`>
        >;
/** What a template literal type can spell, which is what a property key is. */
type Keyable = string | number | bigint | boolean | null | undefined;
interface TableKeyMissing<Table extends string, F extends string, K> {
  readonly table: Table;
  readonly field: F;
  readonly lacks: K;
}
/**
 * What a getter may return for a schema of `T`.
 *
 * `readonly` is a property of the reference, not of the JSON: `MarkNode.getIDs`
 * returns `readonly string[]` for an `arrayValue(stringValue())` property, and
 * that is the same serialized array. Widening the array here accepts it without
 * accepting an element type the schema does not describe.
 */
type Returnable<T> = T extends readonly (infer E)[] ? readonly E[] : T;

interface GetterObligation<M extends string, R> {
  readonly get: M;
  /**
   * A function of `R` rather than an `R`, so the parameter position gives the
   * check its direction: what the getter *returns* has to be assignable to
   * what the schema says the property is, which is the direction the value
   * actually travels on export.
   */
  readonly returns: (value: R) => void;
}
interface SetterObligation<M extends string, A, R> {
  readonly set: M;
  /** Covariant: the parsed value is passed in, so it must fit the parameter. */
  readonly accepts: A;
  /**
   * What the setter may return, in the parameter position so the check runs in
   * the direction a value would travel. Nothing reads a setter's return — the
   * walk and the generated parsers both keep the node they already hold — but
   * a method that hands back something which is neither the node nor nothing
   * is not a setter, and naming one in this position is the mistake this
   * catches. `setLabel(v: string): string` type-checked before this existed.
   */
  readonly returns: (value: R) => void;
}

/**
 * What a setter may hand back: a `LexicalNode` — conventionally `this`, the
 * writable node it wrote — or nothing, for a setter that only mutates.
 *
 * The node is stated by the brand every `LexicalNode` carries rather than as
 * `LexicalNode`, because relating a class to `LexicalNode` compares every
 * member — the `this`-typed ones bring the whole class back in — and a schema
 * above its class naming a `this`-returning setter thereby resolved
 * `$config()`, whose return type is inferred from that schema: a cycle
 * reported as `TS7022` for a class nothing else had resolved first, and passed
 * for the rest by luck of ordering. Relating it to the brand resolves the
 * brand. A `{__key: string}` built by hand does not carry it.
 */
type SetterReturn = {readonly [LEXICAL_NODE_BRAND]: true} | void;

/** The obligations `N` satisfies, which is what discharges the ones declared. */
type ObligationsOf<N> =
  | {
      [K in FieldsOf<N> & keyof N]: FieldReadObligation<K, N[K]>;
    }[FieldsOf<N> & keyof N]
  | {
      [K in ZeroArgMethodsOf<N, unknown> & keyof N]: GetterObligation<
        K,
        ReturnOf<N[K]>
      >;
    }[ZeroArgMethodsOf<N, unknown> & keyof N]
  | {
      [K in FieldsOf<N> & keyof N]: FieldWriteObligation<K, N[K]>;
    }[FieldsOf<N> & keyof N]
  | {
      [K in SettersOf<N> & keyof N]: SetterObligation<
        K,
        FirstParamOf<N[K]>,
        ReturnOf<N[K]>
      >;
    }[SettersOf<N> & keyof N];

// Not `ReturnType`: `N[K]` is not constrained to a function, and a member that
// is not one has to fall to `never`, not `any` — `any` discharges everything.
type ReturnOf<M> = M extends (...args: never[]) => infer R ? R : never;
/**
 * The one value a setter is called with — when the method really is callable
 * with one value and nothing else.
 *
 * Matched as a *one-parameter* signature rather than "the first of however
 * many": a method with a second required parameter is not assignable to it,
 * which is the point. The walk calls a setter with the parsed value alone, so
 * `setter: 'setDimensions'` on a `setDimensions(width: number, height: number)`
 * type-checked and then wrote `undefined` into `__height`. A trailing
 * *optional* parameter still matches, because such a method genuinely is
 * callable with one argument.
 */
type FirstParamOf<M> = M extends (value: infer P) => unknown ? P : never;

/** `N`'s own fields, which are `__`-prefixed by convention. */
type FieldsOf<N> = Extract<Extract<keyof N, `__${string}`>, string>;

/**
 * `N`'s keys, less the ones whose *types* a node may derive from its own
 * `$config()`: `$config` itself, whose return type is inferred from the `json`
 * it is handed — the schema being checked — and the two JSON methods a node
 * types from it (`LexicalExportJSON<this>`, `LexicalUpdateJSON<...>`).
 * Deciding whether a key is a getter or a setter means instantiating `N[K]`,
 * and for those it is a cycle, which TypeScript resolves by dropping the
 * constraint — silently, so the whole check went quiet wherever a schema
 * reached its `$config`. None of the three is a member a declaration may
 * name, so skipping them costs nothing.
 *
 * By name, not by cause, and so not complete: a *fourth* member typed from
 * `$config` — an unannotated `helper() { return this.$config(); }`, or one
 * annotated `toJSON(): LexicalExportJSON<this>` — reopens the cycle for its
 * class alone, with no diagnostic. A second, keys-only name layer would
 * survive that cycle, but beside this check it made the ordinary case too
 * large for TypeScript to represent and the annotated one a hard error even
 * when its schema was right; so the rule is stated instead: a node whose
 * schema is checked keeps its members' types independent of its own
 * `$config`.
 */
type ScannableKeys<N> = Exclude<
  keyof N,
  typeof PROTOTYPE_CONFIG_METHOD | 'exportJSON' | 'updateFromJSON'
>;

/**
 * `N`'s methods that take no argument and return `R`.
 *
 * A method that requires an argument is not assignable to `() => R`, which is
 * what rules a setter out of the getter position: `getter: 'setStyle'` names a
 * real method, and the walk would call it with nothing.
 */
type ZeroArgMethodsOf<N, R> = Extract<
  // No `-?`: over a key set that is not `keyof N` the mapped type is not
  // homomorphic, so the modifier would strip nothing — and an *optional*
  // method (`getFoo?(): string`) is rightly not a member here, since the walk
  // would call it and it may not exist.
  {[K in ScannableKeys<N>]: N[K] extends () => R ? K : never}[ScannableKeys<N>],
  string
>;

/**
 * `N`'s methods that take at least one argument.
 *
 * The length test is what a signature check cannot do on its own: a zero-arg
 * method *is* assignable to `(value: never) => unknown`, so without it
 * `setter: 'getStyle'` would pass.
 */
type SettersOf<N> = Extract<
  {
    [K in ScannableKeys<N>]: N[K] extends (...args: infer P) => unknown
      ? P['length'] extends 0
        ? never
        : K
      : never;
  }[ScannableKeys<N>],
  string
>;

/**
 * The node member an accessor names, tagged with the position it was named in.
 *
 * The tag is what carries the *role* into the flat union every declaration
 * merges into, and the role is what lets {@link MemberOf} answer a different
 * question per position rather than one question — "does the node have this
 * member?" — for all four. Still a union of string literals, so a typo is
 * still reported with the correction suggested.
 */
type AccessorName<A, Role extends 'get' | 'set', T> = A extends {
  readonly field: infer F extends string;
}
  ?
      | `field:${F}`
      // Which direction this declares, for {@link Conventional}: a direction
      // no declaration covers is the conventional accessor's, and checked as
      // such.
      | `declared:${Role}`
      | (A extends {readonly method: infer M extends string}
          ? `${Role}:${M}` | MethodObligation<Role, M, T>
          : never)
      | (A extends {readonly when: infer W extends string}
          ? `when:${W}`
          : never)
      // A field whose stored and serialized forms differ says so with a table,
      // and the table is the declaration of that relationship for the one
      // direction it serves. `getterTable` maps the stored value on export, so
      // what has to fit the schema is the table's values, not the field;
      // `setterTable` maps the parsed value on import, so what has to fit the
      // field is the table's values, not what the schema parses. A direction
      // with no table keeps the field's own check: either table once withheld
      // both, and a `getterTable` alone let import write the parsed string
      // into the numeric field it was its `setterTable` was declared for.
      | (Role extends 'get'
          ? A extends {readonly getterTable: infer D}
            ? GetterTableMismatch<F, D, T>
            : FieldReadObligation<F, Returnable<T>>
          : A extends {readonly setterTable: infer E}
            ? FieldWriteObligation<F, E[keyof E]> | SetterTableMissing<F, E, T>
            : FieldWriteObligation<F, T>)
  : A extends string
    ? `${Role}:${A}` | `declared:${Role}` | MethodObligation<Role, A, T>
    : A extends null
      ? // A declared `null` names nothing to check, but it is a declaration
        // — that the direction is derived — and so one a combinator refuses
        // like any other; see {@link withAccessors}.
        `derived:${Role}`
      : never;

/**
 * The obligation an accessor method carries, per direction.
 *
 * The getter's admits `undefined` on top of the schema's type: returning it is
 * how a getter omits the property from the exported JSON, which is what a
 * `when`-gated one does when its predicate says no.
 */
type MethodObligation<
  Role extends 'get' | 'set',
  M extends string,
  T,
> = Role extends 'get'
  ? GetterObligation<M, Returnable<T> | undefined>
  : SetterObligation<M, T, SetterReturn>;

/**
 * Both directions of a {@link SchemaAccessors}.
 *
 * Each direction is inferred from an *optional* property, so a value typed as
 * the interface rather than written as a literal yields the whole declared
 * type — `string` for a name — instead of `never`. Requiring the property
 * would make such a value name nothing and so discharge the check that
 * {@link nodeSchema} performs, which is the one thing this must not do:
 * `string` is not assignable to any node's {@link MemberOf}, so laundering an
 * accessor through a variable fails loudly rather than silently.
 */
type AccessorNames<A, T> =
  | (A extends {readonly getter?: infer G} ? AccessorName<G, 'get', T> : never)
  | (A extends {readonly setter?: infer S} ? AccessorName<S, 'set', T> : never);

/**
 * Every name a {@link FieldOptions} declares, across both directions;
 * inferred from optional properties for the reason {@link AccessorNames} is.
 */
type FieldOptionNames<F, T> =
  | (F extends {readonly field: infer N extends string}
      ? `field:${N}` | `declared:${'get' | 'set'}`
      : never)
  | (F extends {readonly getter?: infer G extends string} ? `get:${G}` : never)
  | (F extends {readonly setter?: infer S extends string} ? `set:${S}` : never)
  | (F extends {readonly when?: infer W extends string} ? `when:${W}` : never)
  // The obligations behind those names; see {@link FieldReadObligation}.
  // Both directions, because a field declared here is read *and* written,
  // each replaced by its table's check where a table declares that the stored
  // and serialized forms differ in that direction; see {@link AccessorName}.
  | (F extends {readonly field: infer N extends string}
      ?
          | (F extends {readonly getterTable: infer D}
              ? GetterTableMismatch<N, D, T>
              : FieldReadObligation<N, Returnable<T>>)
          | (F extends {readonly setterTable: infer E}
              ?
                  | FieldWriteObligation<N, E[keyof E]>
                  | SetterTableMissing<N, E, T>
              : FieldWriteObligation<N, T>)
      : never)
  | (F extends {readonly getter?: infer G extends string}
      ? GetterObligation<G, Returnable<T> | undefined>
      : never)
  | (F extends {readonly setter?: infer S extends string}
      ? SetterObligation<S, T, SetterReturn>
      : never);

/** The members a schema's declarations name; see {@link MemberOf}. */
export type NamesOf<S> =
  S extends SerializationSchema<unknown, infer Decls, unknown> ? Decls : never;

/**
 * The obligations a property's *conventional* accessors carry: `get<Prop>` and
 * `set<Prop>`, which the walk resolves for any direction the schema does not
 * declare. A declared name is checked through {@link MemberOf}; a conventional
 * one was not checked at all, so `label: stringValue()` beside a
 * `setLabel(value: string): string` compiled, and `importJSON` handed back the
 * string. Each is one member indexed by name, so nothing here resolves the
 * class as a whole.
 *
 * `unknown` where the direction is declared or the accessor is sound, which
 * leaves the field's own type alone; otherwise a shape the field cannot be,
 * naming the accessor at fault.
 */
type Conventional<N, F> = {
  readonly [K in keyof F]: K extends string
    ? ConventionalAccessor<N, `get${Capitalize<K>}`, 'get', F[K]> &
        ConventionalAccessor<N, `set${Capitalize<K>}`, 'set', F[K]>
    : unknown;
};

type ConventionalAccessor<
  N,
  M extends string,
  Role extends 'get' | 'set',
  S,
> = [Extract<NamesOf<S>, `declared:${Role}` | `derived:${Role}`>] extends [
  never,
]
  ? M extends keyof N
    ? (
        Role extends 'get'
          ? GetterObligation<
              M,
              Returnable<SerializationSchemaValue<S>> | undefined
            >
          : SetterObligation<M, SerializationSchemaValue<S>, SetterReturn>
      ) extends (
        Role extends 'get'
          ? N[M] extends () => unknown
            ? GetterObligation<M, ReturnOf<N[M]>>
            : never
          : SetterObligation<M, FirstParamOf<N[M]>, ReturnOf<N[M]>>
      )
      ? unknown
      : ConventionalMismatch<M, SerializationSchemaValue<S>>
    : ConventionalMissing<M>
  : unknown;

/** A conventional accessor that exists but cannot take, or return, `T`. */
interface ConventionalMismatch<M extends string, T> {
  readonly conventionalAccessor: M;
  readonly mustHandle: T;
}
/** A conventional accessor the node does not have; the walk would throw. */
interface ConventionalMissing<M extends string> {
  readonly conventionalAccessor: M;
  readonly missing: true;
}

/**
 * Whether an accessor names a node field rather than a method.
 *
 * Generic in the field type so it narrows to the direction it was handed:
 * given a {@link SchemaGetterAccessor} it yields a {@link SchemaGetterField},
 * whose `getterTable` is then the only table in scope.
 */
export function isSchemaField<T extends SchemaFieldBase>(
  accessor: string | T | null | undefined,
): accessor is T {
  return typeof accessor === 'object' && accessor !== null;
}

/**
 * A class's composed serialization schema, property by property: what a
 * generated module is handed when its code is attached to a class, so that
 * the lookup tables it reads are the schema's own objects rather than copies
 * written into the module at build time.
 *
 * @internal
 */
export type ComposedSchemaFields = ReadonlyMap<string, AnySerializationSchema>;

/**
 * The `getterTable` table the property `key` exports through, from the schema it
 * was declared with. For generated code, which was compiled against a schema
 * that declared one; a schema without it is not the one the code was
 * generated from.
 *
 * A null-prototype copy, taken once when the code is attached: generated
 * code reaches a table with `in`, which walks the prototype, and the key it
 * reaches it with comes from the JSON on import and from the node's field on
 * export — so on a plain object `'toString'` would resolve to
 * Object.prototype's method and be stored or serialized as the property's
 * value. The walk reads the schema's own object through `hasOwnKey`, which
 * asks the same question of the same entries.
 *
 * @internal
 */
export function getterTableOf(
  fields: ComposedSchemaFields,
  key: string,
): {readonly [key: string]: unknown} {
  const getter = schemaOf(fields, key).getter;
  invariant(
    isSchemaField(getter) && getter.getterTable !== undefined,
    'getterTableOf: "%s" declares no getterTable',
    key,
  );
  return nullPrototype(getter.getterTable);
}

/**
 * The `setterTable` table the property `key` imports through; see
 * {@link getterTableOf}.
 *
 * @internal
 */
export function setterTableOf(
  fields: ComposedSchemaFields,
  key: string,
): {readonly [key: string]: unknown} {
  const setter = schemaOf(fields, key).setter;
  invariant(
    isSchemaField(setter) && setter.setterTable !== undefined,
    'setterTableOf: "%s" declares no setterTable',
    key,
  );
  return nullPrototype(setter.setterTable);
}

/**
 * The `index`th alias table in the property `key`'s schema, counting from the
 * outermost. Generated code numbers the tables in the order the compiler met
 * them, so this has to descend exactly the schemas the compiler descends, in
 * the same order: `aliasedValue` (which is also the one that has a table),
 * `nullable`, `optional` and `arrayValue` — each of which wraps a single inner
 * schema, so the walk is a chain. Every other kind is one the compiler refuses,
 * which means it emitted no code for this property and nothing calls this.
 * Descending one the compiler does not would find a table it never numbered and
 * hand back the wrong one, so anything else ends the walk. See
 * {@link getterTableOf}.
 *
 * @internal
 */
export function aliasTableOf(
  fields: ComposedSchemaFields,
  key: string,
  index: number,
): {readonly [key: string]: unknown} {
  let {meta} = schemaOf(fields, key);
  for (let seen = 0; ; ) {
    if (meta.kind === 'aliased') {
      if (seen === index) {
        return nullPrototype(meta.aliases);
      }
      seen++;
      meta = meta.inner.meta;
    } else if (meta.kind === 'nullable' || meta.kind === 'optional') {
      meta = meta.inner.meta;
    } else if (meta.kind === 'array') {
      meta = meta.item.meta;
    } else {
      invariant(
        false,
        'aliasTableOf: "%s" declares no alias table %s',
        key,
        String(index),
      );
    }
  }
}

/**
 * The stored form of the property `key`'s schema default: what its `setterTable`
 * table maps the default to, which is what the walk stores for a parsed value
 * the table does not map. Generated code falls back to it the same way — and
 * a miss is possible, since coverage is proved only for an enum's domain and
 * sampled for a bounded numeric one — so it reads the value here, off the
 * schema when the code is attached, rather than carrying it as a literal. A
 * table without the entry is refused when the class is registered.
 *
 * @internal
 */
export function setterDefaultOf(
  fields: ComposedSchemaFields,
  key: string,
): unknown {
  const schema = schemaOf(fields, key);
  const {setter} = schema;
  invariant(
    isSchemaField(setter) && setter.setterTable !== undefined,
    'setterDefaultOf: "%s" declares no setterTable',
    key,
  );
  const stored = String(schema.defaultValue);
  invariant(
    hasOwnKey(setter.setterTable, stored),
    'setterDefaultOf: "%s" has no setterTable entry for its default %s',
    key,
    stored,
  );
  return setter.setterTable[stored];
}

function nullPrototype(table: {readonly [key: string]: unknown}): {
  readonly [key: string]: unknown;
} {
  return Object.assign(Object.create(null), table);
}

function schemaOf(
  fields: ComposedSchemaFields,
  key: string,
): AnySerializationSchema {
  const schema = fields.get(key);
  invariant(
    schema !== undefined,
    'the composed schema declares no property "%s"',
    key,
  );
  return schema;
}

/** A {@link SerializationSchema} for an unknown type, used where the type is not relevant. */
export type AnySerializationSchema = SerializationSchema<
  unknown,
  unknown,
  unknown
>;

/**
 * A {@link SerializationSchema} that names no accessor: what every combinator
 * takes (see {@link withAccessors}), and what every `inner`, `item` and
 * `members` in a schema's {@link SerializationSchemaMeta | meta} is, so a
 * schema reached through those can be wrapped again as it is. A `fields`
 * record is not: see {@link SerializationSchemaFields}.
 */
export type InnerSerializationSchema = SerializationSchema<
  unknown,
  never,
  unknown
>;

/**
 * The serialized values a schema accepts; see {@link SerializationSchema} and
 * its `In` parameter.
 */
export type SchemaInput<S> =
  S extends SerializationSchema<unknown, unknown, infer In>
    ? In
    : // A node schema carries the same phantom without being a parser, since
      // its properties are applied to a node rather than combined into a
      // value. `LexicalSchemaInput` is this, composed across a config chain.
      // `never` for the node, not `unknown`: the phantom that records which
      // node a schema was checked against is a function *of* it, so the
      // position is contravariant and only `never` matches every node.
      S extends NodeSerializationSchema<never, infer In>
      ? In
      : never;

/** The value type a {@link SerializationSchema} parses to. */
export type SerializationSchemaValue<S> =
  S extends SerializationSchema<infer T, unknown, unknown> ? T : never;

/**
 * A record of named {@link SerializationSchema}s: what an object schema's
 * {@link SerializationSchemaMeta | meta} holds in `fields`. A {@link nodeSchema}
 * is an object schema whose fields name accessors and an {@link objectValue}
 * is one whose fields do not, and the `meta` of the two is one type — so a
 * field read back from it may name one, and its type says so.
 */
export type SerializationSchemaFields = {
  readonly [key: string]: AnySerializationSchema;
};

/**
 * The record {@link objectValue} takes: fields that name no accessor, since an
 * object's field is not a node's property (see {@link withAccessors}).
 */
export type InnerSerializationSchemaFields = {
  readonly [key: string]: InnerSerializationSchema;
};

/**
 * Maps an object type `T` to the record of per-property
 * {@link SerializationSchema}s.
 *
 * The input domain is left open. A schema's `In` is what it *accepts*, which
 * is wider than what it produces wherever a schema reads more than it writes —
 * `numberValue()` is a `SerializationSchema<number, never, number | string>`,
 * since a stringified number is a value it reads. Pinning `In` to `T[K]` made
 * this type reject the combinator for the very type it names: a
 * `SerializationSchemaShape<{count: number}>` would not accept
 * `{count: numberValue()}`. What the shape is for is saying what each property
 * parses *to*, which is the `T[K]` above.
 */
export type SerializationSchemaShape<T> = {
  readonly [K in keyof T]-?: SerializationSchema<T[K], never, unknown>;
};

function makeSchema<T, Decls = never, In = T>(
  parse: Parse<T>,
  meta: SerializationSchemaMeta,
  // Parsing `undefined` is how most combinators name their own default, but a
  // schema whose domain *contains* `undefined` — an enum listing it, a union
  // with an optional member — would derive `undefined` and silently discard
  // the fallback its caller declared, so those pass it explicitly.
  defaultValue?: T,
  isEqual?: (a: T, b: T) => boolean,
  accepts?: (value: unknown) => boolean,
): SerializationSchema<T, Decls, In> {
  if (accepts !== undefined) {
    // This one came from a combinator, so `$fitOf` may skip it and read the
    // metadata instead — see `DERIVED_ACCEPTS`.
    DERIVED_ACCEPTS.add(accepts);
  }
  const derived = defaultValue === undefined;
  const resolved: T = derived ? parse(undefined) : defaultValue;
  if (derived) {
    // The default is metadata every parse shares, and StateConfig hands it
    // straight to $getState for a node that has none of its own. Freezing it
    // turns "mutate one node's default and corrupt every node in the process"
    // into a loud error; a parsed value is a fresh object and is untouched.
    // Only a default this call derived: one the caller passed in is theirs.
    deepFreeze(resolved);
  }
  // The cast is the phantom: `Names` has no runtime member to assign, which
  // is the whole point of carrying it in the type alone.
  return Object.assign(parse, {
    // Passed through as declared. An earlier version wrapped this as
    // `value === resolved || accepts(value)`, to spare each combinator from
    // restating "a schema recognizes its own default" — which was the wrong
    // rule in the wrong place. `accepts` is a predicate on a schema's *input*
    // (`In`), and `defaultValue` is one of its *values* (`T`); the two are the
    // same domain only where a schema reads exactly what it writes. Comparing
    // them made `transformValue(numberValue(), v => 'n' + v)` claim the input
    // `'n0'` because that is what its transform *produced*, and a union then
    // handed a caller a value from the wrong side of the transform.
    //
    // It was also wrong within one domain: a member that declares a default
    // outside its own constraints (`numberValue(0, {min: 1})`) started
    // accepting the one value it exists to reject, so the fall-through
    // `unionValue`'s docblock promises stopped happening. And being `===`, it
    // never fired for a reference-typed default read back from JSON — inert
    // exactly where a caller would reach for it. The shapes that needed it
    // needed their own predicate fixed instead; see `rawValue` and `enumValue`.
    accepts,
    defaultValue: resolved,
    isEqual,
    meta,
  }) as SerializationSchema<T, Decls, In>;
}

/**
 * Whether `value` is a {@link nodeSchema} rather than a schema for one
 * property's value.
 *
 * Its own `meta` kind answers this. A node schema used to be an object schema
 * that named its accessors on its fields, indistinguishable from an
 * {@link objectValue} by looking at it, so every one built had to be recorded
 * in a `WeakSet` for this question to have an answer. Giving the two separate
 * representations is what replaced that with a comparison, and it took a
 * module-scope `new WeakSet()` — a side effect no bundler can drop — out of
 * this module along with it.
 *
 * Written to answer for a value from untyped code as well, since that is the
 * caller the checks below exist for.
 */
function isNodeSchema(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.meta) &&
    (value.meta as {kind?: unknown}).kind === 'node'
  );
}

const __DEV__ = process.env.NODE_ENV !== 'production';

/**
 * Refuse a schema that names an accessor, for the caller the types do not
 * reach (JavaScript, Flow, a cast): the rule every combinator's inner type
 * states, see {@link withAccessors}.
 *
 * A development build only, like every check a combinator runs on the schema
 * it is given: what it catches is a declaration written wrong, which the
 * first development run reports, and a production build should not pay for
 * the check. The parse each schema performs on serialized input is not a
 * check of this kind and is the same in every build.
 */
function undeclared(combinator: string, inner: AnySerializationSchema): void {
  if (__DEV__) {
    invariant(
      inner.getter === undefined &&
        inner.setter === undefined &&
        !isNodeSchema(inner),
      '%s: the schema it wraps names an accessor. Accessors are named once, on the outermost schema of a property, both directions in that one call',
      combinator,
    );
    notNestedSet(combinator, inner);
  }
}

/**
 * Refuse an {@link arraySetValue} anywhere but as the whole value of a
 * `createState`. Only a StateConfig puts a value written with `$setState`
 * into the canonical form; a node property set through its setter, or a
 * value inside another schema, would keep whatever order and duplicates it
 * was given. A development build only, like {@link undeclared}.
 */
function notNestedSet(
  combinator: string,
  inner: AnySerializationSchema | null | undefined,
): void {
  // A hand-rolled schema may carry no meta at all
  const meta: SerializationSchemaMeta | null | undefined =
    inner == null ? undefined : inner.meta;
  invariant(
    meta == null || meta.kind !== 'set',
    '%s: arraySetValue can only be the whole value of a createState, not part of another schema or a node property',
    combinator,
  );
}

/**
 * Every predicate a combinator installed on a schema it built.
 *
 * `$fitOf` answers each kind from its metadata, and a combinator's own
 * predicate is derived from that same metadata — `arrayValue`'s is
 * `Array.isArray`, `objectValue`'s is the undeclared-key test, and every
 * wrapper's and `unionValue`'s recurses into the very schemas the case is
 * about to walk. So asking one is at best a second call that decides nothing
 * and at worst a second full traversal of the subtree: measured over directly
 * nested unions, asking them took a leaf from 4/8/12/16 checks at depths
 * 4/8/12/16 to 14/44/90/152.
 *
 * What `$fitOf` does need to honor is a predicate the schema's *author*
 * installed, which is a statement about a domain no metadata describes. This
 * set is how the two are told apart. `withAccessors` copies `accepts` by
 * reference, so a `withField` wrapper of a built-in stays recognized as one.
 */
const DERIVED_ACCEPTS = new WeakSet<(value: unknown) => boolean>();

/**
 * The predicate `schema`'s author installed, or `undefined` where it has none
 * or carries only the one its combinator derived — see {@link DERIVED_ACCEPTS}.
 *
 * Exported for the two consumers that read a schema's *metadata* to stand in
 * for the schema — `@lexical/fast-check`'s arbitraries and the JSON code
 * generator — because a schema with one of these describes a domain no
 * metadata records, so neither may answer for it from the metadata alone.
 *
 * @internal
 */
export function declaredAccepts(
  schema: AnySerializationSchema,
): undefined | ((value: unknown) => boolean) {
  const {accepts} = schema;
  return accepts === undefined || DERIVED_ACCEPTS.has(accepts)
    ? undefined
    : accepts;
}

/**
 * Freeze a derived default and everything reachable from it. Freezing only the
 * outer value would leave an array or object *nested* in an {@link objectValue}
 * default writable, and a nested value is shared by every node that has none of
 * its own exactly as the outer one is — so it is the same hazard one level
 * down. Already-frozen values are skipped, which also terminates a cycle.
 */
/**
 * Values a caller handed the schema, which a derived default may contain and
 * which this must not freeze.
 *
 * A `transformValue`'s default is whatever its `transform` returned, possibly a
 * module constant the caller also uses elsewhere — which is why `transformValue`
 * passes its default explicitly rather than letting `makeSchema` derive and
 * freeze one. That is not enough on its own: an `objectValue` *containing* such
 * a field derives its own default, which holds that same object, and the
 * recursion below reached it.
 *
 * Every combinator that takes a default from its caller is in the same
 * position, which is the whole of the rule: `unionValue(members, shared)` and
 * `enumValue(members)` hand back a value the caller still holds, and an
 * enclosing schema deriving its own default reached straight through it and
 * froze the caller's object.
 */
const CALLER_OWNED = new WeakSet<object>();

/** Records a value as the caller's, and returns it. See {@link CALLER_OWNED}. */
function markCallerOwned<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    CALLER_OWNED.add(value);
  }
  return value;
}

function deepFreeze(value: unknown): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.isFrozen(value) ||
    CALLER_OWNED.has(value)
  ) {
    return;
  }
  Object.freeze(value);
  for (const inner of Object.values(value)) {
    deepFreeze(inner);
  }
}

/**
 * `source` is untrusted parsed JSON, whose prototype is `Object.prototype`: a
 * plain `key in source` (or `source[key]`) would report an inherited member —
 * `toString`, `constructor` — as a present value and hand it to a node setter.
 *
 * A type predicate rather than a `boolean`, so a caller reads the value off the
 * narrowed `source` instead of casting an unindexable `object`.
 */
function isRecord(value: unknown): value is {readonly [key: string]: unknown} {
  return typeof value === 'object' && value !== null;
}

/**
 * Carry `inner`'s equality onto a wrapper that adds a nil to its domain: the
 * two describe the same property, and identity already answers the nil cases.
 */
function liftIsEqual<T>(
  inner: SerializationSchema<T, unknown, unknown>,
): undefined | ((a: T | null | undefined, b: T | null | undefined) => boolean) {
  const {isEqual} = inner;
  return isEqual === undefined
    ? undefined
    : (a, b) => (a == null || b == null ? a === b : isEqual(a, b));
}

/**
 * Carry `inner`'s domain membership onto a wrapper that adds a nil to its
 * domain.
 *
 * Declared unconditionally, and asked of `inner` *before* the wrapper
 * normalizes: membership is a question about the input, and a wrapper answers
 * it by delegating, so the fact that `inner` has no explicit `accepts` of its
 * own is not a reason for the wrapper to have none either.
 *
 * Leaving it undefined in that case left a union inferring the wrapper's
 * membership from what it *parsed to*, which for a wrapper is exactly where
 * the inference breaks down: `nullable(stringValue(), {defaultAsNull: true})`
 * reads `''` as `null`, its own default, so the inference reads a recognized
 * value as a fallback and declines it —
 * `unionValue([that, enumValue(['auto'])], 'auto')` answered `'auto'` for `''`
 * instead of `null`. Asking `inner` first is the whole fix; `$schemaMatch` is
 * the same inference the union would have run, applied one level down where it
 * is sound.
 *
 * `isNil` is the wrapper's own nil test, not `== null` for both: `nullable`
 * maps `null` *and* `undefined` to null, while `optional` maps only
 * `undefined` and hands `null` to `inner`. Claiming to accept a value the
 * wrapper then delegates is what makes wrapping change a union's answer —
 * `unionValue([optional(numberValue()), enumValue(['inherit'])], 'inherit')`
 * would commit to the optional member for `null` and return `inner`'s
 * fallback `0`, where the unwrapped member correctly declines it.
 */
function liftAccepts<T>(
  inner: SerializationSchema<T, unknown, unknown>,
  isNil: (value: unknown) => boolean,
): (value: unknown) => boolean {
  return value => isNil(value) || $acceptsValue(inner, value);
}

/**
 * Whether `schema` recognizes `value` — its declared `accepts` when it has one,
 * and otherwise the parse-inference {@link $schemaMatch} applies.
 *
 * The membership half of `$schemaMatch` without the parsed value, for a caller
 * that is deciding rather than parsing.
 *
 * A declared `accepts` is asked directly rather than through `$schemaMatch`,
 * which parses in order to return the parsed value alongside its answer. Every
 * caller here throws that away, and `objectValue`'s own `accepts` asks this of
 * each declared field — so routing through it made deciding cost a parse, and
 * a parse of a nested object asked again for every field beneath it. Ten
 * levels of `unionValue`/`objectValue` reached 59,049 parses of the leaf, 3 per
 * level compounding, where the value is read once.
 */
function $acceptsValue<T>(
  schema: SerializationSchema<T, unknown, unknown>,
  value: unknown,
): boolean {
  const {accepts} = schema;
  // `.call(schema, ...)`, as `$fitOf` and `@lexical/fast-check` both do: the
  // interface declares `accepts` with method syntax, so a predicate may read
  // `this.meta`. Calling it destructured left `this` undefined here and bound
  // there, so one predicate answered on one path and threw on the other.
  return accepts !== undefined
    ? accepts.call(schema, value)
    : $schemaMatch(schema as AnySerializationSchema, value) !== undefined;
}

/**
 * Memoized because the answer is a property of the schema alone, and `$fitOf`
 * now asks it while *measuring* a union rather than only when one is choosing:
 * without this, a value node under N nested unions walks the schema below it
 * once per level, which is work that grows with the nesting for a question
 * whose answer was fixed when the schema was built.
 */
const CATCH_ALL_CACHE = new WeakMap<AnySerializationSchema, boolean>();

/**
 * Whether `schema` describes nothing — a `rawValue`, or a wrapper or union that
 * bottoms out at one.
 *
 * A raw schema admits every value, so it is *neutral* wherever it is one part
 * of a larger shape: a `rawValue()` field cannot make its object a worse fit,
 * and treating it as a mismatch took the whole object out of the union. But
 * where it is the *whole* answer — a union member — it is a catch-all, and
 * letting it claim a complete match hands a caller unvalidated input under a
 * declared type, ahead of the member that describes the value.
 *
 * So the two places that must pass over a catch-all ask this rather than
 * reading `meta.kind` themselves: `optional(rawValue())` and
 * `unionValue([arrayValue(numberValue()), rawValue()])` are catch-alls too, and
 * checking the outer kind alone let both win the specific pass.
 *
 * It does *not* look inside an array's items or an object's fields: a container
 * that happens to carry a raw property still describes everything else about
 * the value, which is exactly the case the neutrality above exists for.
 */
function $isCatchAll(schema: AnySerializationSchema): boolean {
  const cached = CATCH_ALL_CACHE.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const result = $computeIsCatchAll(schema);
  CATCH_ALL_CACHE.set(schema, result);
  return result;
}

function $computeIsCatchAll(schema: AnySerializationSchema): boolean {
  const meta: SerializationSchemaMeta | undefined | null = schema.meta;
  if (meta == null) {
    return false;
  }
  if (declaredAccepts(schema) !== undefined) {
    // It describes *something* — that is what a declared predicate is — so it
    // is not the last resort a catch-all is, however raw its metadata. Without
    // this the demotion in `$bestUnionMember` still ranked a `rawValue()`
    // narrowed to `#`-prefixed strings behind a plain `stringValue()`, and the
    // plain member won a value only the narrowed one claimed.
    return false;
  }
  switch (meta.kind) {
    case 'raw':
      return true;
    case 'union':
      // *Every* member, not some. A union that merely contains a catch-all is
      // not one — it still describes whatever its other members describe, and
      // calling it a catch-all skipped those members' matches along with the
      // raw one, so `unionValue([arrayValue(numberValue()), unionValue([
      // arrayValue(stringValue()), rawValue()])])` passed over the nested union
      // entirely and let the first member coerce `['red', '42']` to `[0, 42]`.
      return (
        meta.members != null &&
        meta.members.length > 0 &&
        meta.members.every(member => $isCatchAll(member))
      );
    case 'nullable':
    case 'optional':
    case 'transform':
    case 'aliased':
      return meta.inner != null && $isCatchAll(meta.inner);
    default:
      return false;
  }
}

/**
 * How well a schema fits a value, in one traversal.
 *
 * `1` fits entirely. `2` fits entirely but only because a catch-all covers
 * some part of it. `3` is accepted but would be coerced. `4` is not accepted.
 * Lower wins, and ties go to declaration order.
 *
 * One number rather than a pair of predicates, because asking twice is what
 * kept going wrong. Measuring a union used to run its selection and then
 * re-measure the member it picked, which doubled the traversal at every level
 * of nesting — a leaf under sixteen nested unions was visited 65,535 times.
 * And a boolean "does it fit entirely" could not say *how*, so a union that fit
 * only through its `rawValue()` outranked a sibling that owned every element:
 * `unionValue([unionValue([numberValue(), rawValue()]), arrayValue(
 * numberValue())])` read `['42']` as `['42']` rather than `[42]`.
 *
 * Carrying "via a catch-all" as its own rank answers both. It is computed once
 * per schema node per value node, and nothing recomputes it.
 */
const FIT_WHOLE = 1;
const FIT_VIA_CATCH_ALL = 2;
const FIT_COERCIBLE = 3;
const FIT_NONE = 4;

function $fitOf(schema: AnySerializationSchema, value: unknown): number {
  const meta: SerializationSchemaMeta | undefined | null = schema.meta;
  // A hand-rolled schema has opted out of the type, so `meta` and the payload
  // a `kind` implies may be missing however it is declared. Its own `accepts`
  // is then the whole of what it has told us.
  if (meta == null) {
    return $acceptsValue(schema, value) ? FIT_WHOLE : FIT_NONE;
  }
  // A predicate the schema's *author* installed is it saying what its domain
  // is, asked once, before anything below narrows the value: a predicate is
  // declared over `unknown`, so one that reaches past its metadata — an
  // `arrayValue` schema that also reads the comma-separated spelling an older
  // version wrote — is not overruled by a structural test. It must therefore
  // be total; `value.length` without a guard throws out of `importJSON`.
  //
  // Only such a predicate. `declaredAccepts` skips the one a combinator
  // derived, which every case below re-derives from the metadata anyway.
  // Asking those cost a second traversal of the same subtree at every level,
  // and for `unionValue`, whose predicate excludes `undefined` where the
  // `union` case ranks its members, it also answered a different question: a
  // `{width: undefined}` field went from a whole fit to none and took its
  // object out of the enclosing union.
  const declared = declaredAccepts(schema);
  const narrowed = declared !== undefined;
  if (narrowed && !declared.call(schema, value)) {
    return FIT_NONE;
  }
  const fit = $metaFitOf(schema, meta, value, narrowed);
  // Claimed by its author but not measured by its metadata — the wider case
  // above. The claim stands, so it is not `FIT_NONE`, but nothing walked the
  // value, so it ranks below a member that structurally owns it: as
  // `FIT_WHOLE` a merely permissive predicate tied with an exact match and won
  // on declaration order, reading `'hello'` as `['hello']`.
  //
  // Stated once here rather than per case, which is what let the array and
  // object cases honor a wider predicate while `union`, `optional` and the
  // other wrappers still let their metadata overrule one.
  return narrowed && fit === FIT_NONE ? FIT_COERCIBLE : fit;
}

/**
 * How well a schema's *metadata* fits a value — the part of {@link $fitOf}
 * that reads only what the combinator recorded.
 *
 * `narrowed` says whether the schema's author declared a predicate, which
 * {@link $fitOf} has already asked. It matters to one case: a `rawValue()`
 * describes nothing and so can only ever be a catch-all, but one narrowed by a
 * predicate describes what that predicate admits, and fits the way any other
 * schema that recognizes a value does.
 */
function $metaFitOf(
  schema: AnySerializationSchema,
  meta: SerializationSchemaMeta,
  value: unknown,
  narrowed: boolean,
): number {
  switch (meta.kind) {
    case 'raw':
      return narrowed ? FIT_WHOLE : FIT_VIA_CATCH_ALL;
    case 'array': {
      if (!Array.isArray(value)) {
        return FIT_NONE;
      }
      if (meta.item == null) {
        return FIT_WHOLE;
      }
      let worst = FIT_WHOLE;
      for (let i = 0; i < value.length; i++) {
        // An absent element is filled from the item's own default, exactly as
        // `objectValue` fills an absent field, so it is not a mismatch.
        if (value[i] !== undefined) {
          const itemFit = $fitOf(meta.item, value[i]);
          if (itemFit > worst) {
            worst = itemFit;
          }
        }
      }
      // An array parse is total — it coerces every element — so an element
      // that does not fit costs coercion, not the array.
      return worst >= FIT_COERCIBLE ? FIT_COERCIBLE : worst;
    }
    case 'object': {
      const fields = meta.fields;
      if (!isPlainObject(value)) {
        return FIT_NONE;
      }
      if (fields == null) {
        return FIT_WHOLE;
      }
      // The undeclared-key test is `objectValue`'s own predicate, so a schema
      // that states a domain of its own has answered for this already.
      if (!narrowed && hasUndeclaredKey(value, fields)) {
        return FIT_NONE;
      }
      let worst = FIT_WHOLE;
      for (const key of Object.keys(value)) {
        // `hasOwnKey`, not a bare index: the key comes straight out of
        // untrusted JSON, so `'toString'` would otherwise resolve to
        // Object.prototype's method and be walked as if it were a schema.
        if (hasOwnKey(fields, key)) {
          const fieldFit = $fitOf(fields[key], value[key]);
          if (fieldFit > worst) {
            worst = fieldFit;
          }
        }
      }
      return worst >= FIT_COERCIBLE ? FIT_COERCIBLE : worst;
    }
    case 'union':
      // Literally the selection, so what a union reports is what it will do.
      // Ranking the members without the catch-all demotion answered for a
      // member the union would not have picked: `union[array[number], raw]`
      // reported the raw's 2 while selecting the array, so an object holding
      // that field claimed a better fit than the sibling whose own `tags`
      // matched every element, won the enclosing union, and read
      // `{tags: ['red', '42']}` back as `{tags: [0, 42]}`.
      return meta.members == null
        ? FIT_WHOLE
        : $bestUnionMember(meta.members, value).fit;
    case 'aliased':
    // Each wrapper owns one nil and forwards everything else; `nullable` maps
    // both, `optional` only `undefined`, and a transform owns neither.
    // eslint-disable-next-line no-fallthrough
    case 'nullable':
    case 'optional':
    case 'transform': {
      const owned =
        meta.kind === 'aliased'
          ? typeof value === 'string' &&
            meta.aliases != null &&
            // An alias is an exact spelling, so it is as whole a fit as there is.
            hasOwnKey(meta.aliases, value)
          : meta.kind === 'nullable'
            ? value == null
            : meta.kind === 'optional' && value === undefined;
      return owned || meta.inner == null
        ? FIT_WHOLE
        : $fitOf(meta.inner, value);
    }
    default:
      // A leaf, or a kind from a newer core. Its own domain is the answer and
      // there is no metadata here to read it from, so a narrowed one was
      // already answered above and this is the combinator's predicate, or the
      // parse inference for a schema with none.
      return narrowed || $acceptsValue(schema, value) ? FIT_WHOLE : FIT_NONE;
  }
}

/**
 * The member a union would parse `value` with and how well that member fits.
 *
 * One procedure, called both to choose a member and to answer how well the
 * union fits, so the two cannot disagree: the rank a union reports is the rank
 * of the member it will hand the value to. Splitting them is what let a union
 * advertise a fit it would never deliver — see the `union` case of `$fitOf`.
 *
 * A member that *is* a catch-all is *ranked* no better than coercible: it
 * describes nothing, so letting it win on the strength of admitting everything
 * would put it ahead of the member that describes the data and hand back
 * unvalidated input under a declared type. The demotion applies to a union's
 * own members, which is why `$fitOf` reaches it only through here — a
 * `rawValue()` *field* stays neutral inside its object, as `$isCatchAll`
 * describes.
 *
 * Ranking and reporting are not the same number. The demotion decides *which*
 * member wins; what the union then reports is that member's own fit, because
 * that is what the union is about to do with the value. A member reached
 * through a demotion still fits the way it fits: `union[stringValue(),
 * rawValue()]` given `[]` really does hand it to the raw and write it back
 * unchanged, which is a whole fit earned through a catch-all — reporting the
 * demoted 3 there made an enclosing object under-report and its sibling coerce
 * the field away. Reporting the *undemoted best* is the opposite error:
 * `union[arrayValue(numberValue()), rawValue()]` given `['red', '42']` ranks
 * the array and the raw alike and takes the array by declaration order, so
 * answering with the raw's 2 advertises a fit the union will not deliver.
 *
 * Each member is measured exactly once.
 */
function $bestUnionMember(
  members: readonly AnySerializationSchema[],
  value: unknown,
): {fit: number; member: AnySerializationSchema | undefined} {
  let member: AnySerializationSchema | undefined;
  // What the winner ranked as, and what it actually fits as.
  let bestRank = FIT_NONE;
  let bestFit = FIT_NONE;
  for (let i = 0; i < members.length; i++) {
    const candidate = members[i];
    const fit = $fitOf(candidate, value);
    const rank =
      fit < FIT_COERCIBLE && $isCatchAll(candidate) ? FIT_COERCIBLE : fit;
    if (rank < bestRank) {
      member = candidate;
      bestRank = rank;
      bestFit = fit;
      if (rank === FIT_WHOLE) {
        break;
      }
    }
  }
  return {fit: bestFit, member};
}

/**
 * The member a union would parse `value` with, or `undefined` if none would.
 */
function $selectUnionMember(
  members: readonly AnySerializationSchema[],
  value: unknown,
): AnySerializationSchema | undefined {
  return $bestUnionMember(members, value).member;
}

/**
 * Whether `source` carries `key` as its own property.
 *
 * A type predicate rather than a `boolean`, so a caller can read the value off
 * the narrowed `source` instead of casting an unindexable `object`.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`, which is
 * newer than the browser baseline these packages are linted against. Lives here
 * rather than in LexicalUtils because this module imports nothing from the rest
 * of the core, so it is the one the other direction can reach.
 *
 * @internal
 */
export function hasOwnKey<K extends string>(
  source: object,
  key: K,
): source is {readonly [P in K]: unknown} {
  return Object.prototype.hasOwnProperty.call(source, key);
}

/**
 * {@link isRecord} narrowed to what an {@link objectValue} describes. An array
 * is an object too, and comparing one field-wise against an object default
 * would report `[]` and `{}` as the same value.
 */
function isPlainRecord(
  value: unknown,
): value is {readonly [key: string]: unknown} {
  return isRecord(value) && !Array.isArray(value);
}

/**
 * {@link isPlainRecord}, and carrying no prototype but `Object.prototype` — so
 * its own keys are the whole of it.
 *
 * A `Map`, a `Set` or a class instance is an object with no own keys at all, so
 * a comparison that reads own keys reports any two of them as equal. That is
 * the direction that loses data, and JSON.parse produces nothing but plain
 * objects, so the values a schema really parses to are unaffected.
 */
function isPlainObject(
  value: unknown,
): value is {readonly [key: string]: unknown} {
  if (!isPlainRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether `source` carries an own key that `fields` does not describe. */
function hasUndeclaredKey(
  source: {readonly [key: string]: unknown},
  fields: object,
): boolean {
  for (const key of Object.keys(source)) {
    if (!hasOwnKey(fields, key)) {
      return true;
    }
  }
  return false;
}

/**
 * Build a {@link SerializationSchema} that returns `value` when it is a `string`, otherwise
 * returns `defaultValue` (the empty string by default).
 * @__NO_SIDE_EFFECTS__
 */
export function stringValue(defaultValue = ''): SerializationSchema<string> {
  return makeSchema(
    value => (typeof value === 'string' ? value : defaultValue),
    {kind: 'string'},
    undefined,
    undefined,
    // Declared, like every other combinator's, so that deciding whether a value
    // is in this domain costs no parse: `$schemaMatch` falls back to inferring
    // membership from a parse, and a caller that only wanted the answer — an
    // `objectValue` asking about each of its fields — would then parse the
    // value once to decide and once to read it.
    value => typeof value === 'string',
  );
}

/**
 * The JSON number grammar, anchored, for reading a stringified number back as
 * the number it spells. `Number()` alone is far more permissive than JSON:
 * it reads `'0x10'` as 16, `'0b11'` as 3, `'Infinity'` as `Infinity`, `''` and
 * `'  '` as 0, and ignores surrounding whitespace. None of those are shapes a
 * JSON encoder produces, so none of them are evidence of a number that was
 * stringified — they are out-of-domain input, and fall back to the default.
 */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Build a {@link SerializationSchema} that returns `value` when it is a finite `number`,
 * otherwise returns `defaultValue` (`0` by default). `NaN`, `Infinity`, and
 * `-Infinity` are all treated as out of domain since they can not be
 * round-tripped through JSON.
 *
 * A string spelled as a JSON number is accepted and converted, so a document
 * that stored `"120"` where Lexical writes `120` — a hand-authored fixture, a
 * converter, or a backend that stringified its numbers — keeps its value
 * instead of silently falling back to the default. The domain is still
 * numbers: that is what the schema reports and what parsing returns, a string
 * is only an input encoding of it. Only the JSON grammar is read, so notations
 * that JSON itself can not produce (`"0x10"`, `"1_000"`, `"+1"`, `"Infinity"`)
 * stay out of domain.
 *
 * @__NO_SIDE_EFFECTS__
 */
export function numberValue(
  defaultValue = 0,
  options: NumberValueOptions = {},
): SerializationSchema<number, never, number | string> {
  const {integer, clamp} = options;
  // An integer domain's real bounds are the integers inside the declared ones,
  // so they are rounded inward here rather than compared against as given.
  // For the plain bounds that is the same domain — an integer is `>= 0.5`
  // exactly when it is `>= 1` — but `clamp` returns a bound, and returning
  // `0.5` from a domain of integers stores a value the same schema rejects on
  // the way back in, so the property changed every time the document was
  // reloaded. Rounded, every clamped result is a member.
  const min =
    integer && options.min !== undefined ? Math.ceil(options.min) : options.min;
  const max =
    integer && options.max !== undefined
      ? Math.floor(options.max)
      : options.max;
  if (__DEV__) {
    // Empty either way it got that way — `{max: 1, min: 2}`, or bounds with no
    // integer between them — and an empty domain admits nothing, so every
    // value parses to a default that came from nowhere. The same reason
    // `enumValue` refuses an empty list.
    invariant(
      min === undefined || max === undefined || min <= max,
      'numberValue: the domain is empty; min %s is above max %s%s',
      String(min),
      String(max),
      integer && (min !== options.min || max !== options.max)
        ? ` (rounded inward from ${String(options.min)}..${String(
            options.max,
          )} because the domain is integers)`
        : '',
    );
  }
  const coerce = (value: unknown): unknown =>
    typeof value === 'string' && JSON_NUMBER.test(value)
      ? Number(value)
      : value;
  // Everything the domain asks of a value except where it sits in the range,
  // which is the part `clamp` answers differently.
  const isNumeric = (parsed: unknown): parsed is number =>
    typeof parsed === 'number' &&
    Number.isFinite(parsed) &&
    (!integer || Number.isInteger(parsed));
  const inDomain = (parsed: unknown): parsed is number =>
    isNumeric(parsed) &&
    (min === undefined || parsed >= min) &&
    (max === undefined || parsed <= max);
  return makeSchema(
    value => {
      const parsed = coerce(value);
      if (clamp && isNumeric(parsed)) {
        return min !== undefined && parsed < min
          ? min
          : max !== undefined && parsed > max
            ? max
            : parsed;
      }
      return inDomain(parsed) ? parsed : defaultValue;
    },
    {clamp, integer, kind: 'number', max, min},
    undefined,
    undefined,
    // Declared because this domain spans two value types: a union member has
    // no other way to tell `'0'` — a stringified number, in domain, which
    // parsing normalizes to the default — from `'banana'`, which is out of
    // domain and lands on the default too.
    // With `clamp` the bounds no longer decide membership: a value outside
    // them parses to a bound rather than to the default, so it is one this
    // schema reads.
    value => (clamp ? isNumeric(coerce(value)) : inDomain(coerce(value))),
  );
}

/**
 * Build a {@link SerializationSchema} that returns `value` when it is a `boolean`, otherwise
 * returns `defaultValue` (`false` by default).
 * @__NO_SIDE_EFFECTS__
 */
export function booleanValue(
  defaultValue = false,
): SerializationSchema<boolean> {
  return makeSchema(
    value => (typeof value === 'boolean' ? value : defaultValue),
    {kind: 'boolean'},
    undefined,
    undefined,
    // Declared, like every other combinator's, so that deciding whether a value
    // is in this domain costs no parse: `$schemaMatch` falls back to inferring
    // membership from a parse, and a caller that only wanted the answer — an
    // `objectValue` asking about each of its fields — would then parse the
    // value once to decide and once to read it.
    value => typeof value === 'boolean',
  );
}

/**
 * Build a {@link SerializationSchema} for a fixed set of allowed `values` (an
 * enumeration or a union of literals such as the `mode` of a TextNode). Returns
 * `value` when it is strictly equal to one of `values`, otherwise returns
 * `defaultValue`, which defaults to the first entry of `values`.
 *
 * The type parameter is `const`, so the literal types of `values` are inferred
 * directly — the caller does not need an `as const` assertion. (Pass an
 * explicit type argument, e.g. `enumValue<TextModeType>([...])`, to instead
 * assert the values against a known domain type.)
 *
 * `undefined` may be a member of the domain, and a declared `undefined`
 * default is taken as declared: `enumValue([undefined, 'middle', 'bottom'])`
 * and `enumValue(['middle', undefined], undefined)` both default to
 * `undefined`.
 *
 * `values` must be non-empty, which the type states as a tuple: an empty
 * domain admits nothing, so every value — including one the caller believes is
 * in the enum — would parse to a default that came from nowhere. A list built
 * at runtime is checked as well in a development build, since a type can be
 * asserted past.
 *
 * @example
 * ```ts
 * const parseMode = enumValue(['normal', 'token', 'segmented']);
 * //    ^? SerializationSchema<'normal' | 'token' | 'segmented'>, default 'normal'
 * ```
 * @__NO_SIDE_EFFECTS__
 */
export function enumValue<const T, D extends T = T>(
  values: readonly [T, ...T[]],
  // A rest tuple, for the reason `unionValue` uses one. The default has a type
  // parameter of its own, bounded by `T`, so it is checked against the domain
  // `values` declares rather than widening it — inferred into `T`,
  // `enumValue(['a', 'b'], 'c')` was a schema over `'a' | 'b' | 'c'` whose
  // parse never produced `'c'`. (`NoInfer` says the same, but is a TypeScript
  // 5.4 intrinsic and the declarations support 5.2.)
  ...args: [] | [defaultValue: D]
): SerializationSchema<T> {
  // `!== 0`, not `=== 1`: a JavaScript caller's stray trailing argument must
  // not turn a declared default back into `values[0]`.
  //
  // Marked as the caller's either way: both the declared default and the
  // members it is chosen from are values this schema was handed, not ones it
  // derived. See {@link CALLER_OWNED}.
  const defaultValue: T = markCallerOwned(
    args.length !== 0 ? args[0] : values[0],
  );
  if (__DEV__) {
    invariant(
      values.length > 0,
      'enumValue: values must not be empty; an enum with no members admits no value',
    );
  }
  const allowed = new Set<unknown>(values);
  // The rule the type states (`V[number]`), for the caller the type does not
  // reach: a default outside the domain is a value every parse could produce
  // and none could ever read back.
  if (__DEV__) {
    invariant(
      allowed.has(defaultValue),
      'enumValue: the default value is not one of the values',
    );
  }
  return makeSchema(
    // `undefined` is checked before membership even when it is one of the
    // values: an absent JSON property parses as `undefined`, so reading it as
    // the in-band value rather than the fallback would break
    // `schema(undefined) === schema.defaultValue` — the equality compaction
    // relies on when it drops a default-valued property expecting parsing to
    // restore it. (When `undefined` *is* the default the two agree anyway.)
    value =>
      value !== undefined && allowed.has(value) ? (value as T) : defaultValue,
    {kind: 'enum', values},
    // Passed explicitly because `undefined` may itself be the declared default,
    // which makeSchema would otherwise read as "derive it from parse".
    defaultValue,
    undefined,
    // Declared, like every other combinator's, so that deciding whether a value
    // is in this domain costs no parse: `$schemaMatch` falls back to inferring
    // membership from a parse, and a caller that only wanted the answer — an
    // `objectValue` asking about each of its fields — would then parse the
    // value once to decide and once to read it.
    //
    // The parse's own test. `undefined` is the one value the two could disagree
    // about: the parse reads it as "absent" before it checks membership, and
    // answers with the default. Claiming it is honest only when the default
    // *is* `undefined` — `enumValue([undefined, 'top'])`, the documented
    // spelling for defaulting to `undefined` that `TableCellNode`'s
    // `verticalAlign` uses. Listed but not the default (`enumValue(['top',
    // undefined])`) the parse answers `'top'`, so a union that committed here
    // would be handed a value it never asked for.
    value =>
      allowed.has(value) && (value !== undefined || defaultValue === undefined),
  );
}

/**
 * Combinator that makes any {@link SerializationSchema} nullable. The returned schema yields
 * `null` when the value is `null` or `undefined` (so `null` is its recoverable
 * default) and otherwise delegates to `inner`. This guarantees a `T | null`
 * result for an untrusted value, unlike `value || null`, which can pass a
 * non-`T` (or falsy) value straight through with the wrong type.
 *
 * Pass `{defaultAsNull: true}` when an in-band value equal to `inner`'s
 * default also means "no value" — the historical `serializedNode.rel || null`
 * idiom, where an empty string is not a real `rel`. Equality is `inner`'s own
 * (see {@link SerializationSchema.isEqual}), so a reference-typed default is
 * compared by content: `nullable(arrayValue(...), {defaultAsNull: true})`
 * reads an explicitly empty array as `null`.
 *
 * @example
 * ```ts
 * const parseRel = nullable(stringValue(), {defaultAsNull: true});
 * //    ^? SerializationSchema<string | null>
 * parseRel('noopener'); // 'noopener'
 * parseRel('');         // null ('' is stringValue's default)
 * parseRel(null);       // null
 * parseRel(undefined);  // null (the recoverable default)
 * ```
 * @__NO_SIDE_EFFECTS__
 */
export function nullable<T, In = T>(
  inner: SerializationSchema<T, never, In>,
  options: {readonly defaultAsNull?: boolean} = {},
): SerializationSchema<T | null, never, In | null | undefined> {
  undeclared('nullable', inner);
  const {defaultAsNull} = options;
  return makeSchema(
    value => {
      if (value == null) {
        return null;
      }
      const parsed = inner(value);
      return defaultAsNull && isSchemaDefault(inner, parsed) ? null : parsed;
    },
    {defaultAsNull, inner, kind: 'nullable'},
    undefined,
    liftIsEqual(inner),
    // Both nils: the parse above maps `null` and `undefined` alike to null.
    liftAccepts(inner, value => value == null),
  );
}

/**
 * Combinator that makes any {@link SerializationSchema} optional. The returned schema yields
 * `undefined` when the value is `undefined` (so `undefined` is its recoverable
 * default) and otherwise delegates to `inner`. Use it for serialized properties
 * that may be absent and, when absent, should stay absent (an exported `T |
 * undefined` property is omitted from the JSON rather than persisted).
 *
 * Pass `{omitDefault: true}` when an in-band value equal to `inner`'s default
 * means "absent" rather than "explicitly this value" — the historical
 * `serializedNode.width || undefined` idiom, where a falsy `0` is not a real
 * width. Such a value (and any out-of-domain input, which `inner` coerces to
 * its default) yields `undefined`, so it is omitted from the exported JSON
 * instead of being persisted as the default. Equality is `inner`'s own (see
 * {@link SerializationSchema.isEqual}), so a reference-typed default is
 * compared by content: `optional(arrayValue(...), {omitDefault: true})` omits
 * an explicitly empty array rather than persisting it.
 *
 * @example
 * ```ts
 * const parseWidth = optional(numberValue());
 * //    ^? SerializationSchema<number | undefined>
 * parseWidth(120);       // 120
 * parseWidth(undefined); // undefined (the recoverable default)
 *
 * const parseCellWidth = optional(numberValue(), {omitDefault: true});
 * parseCellWidth(0);     // undefined (0 is not a real width)
 * parseCellWidth('x');   // undefined (coerced to the default, then omitted)
 * ```
 * @__NO_SIDE_EFFECTS__
 */
export function optional<T, In = T>(
  inner: SerializationSchema<T, never, In>,
  options: {readonly omitDefault?: boolean} = {},
): SerializationSchema<T | undefined, never, In | undefined> {
  undeclared('optional', inner);
  const {omitDefault} = options;
  return makeSchema(
    value => {
      if (value === undefined) {
        return undefined;
      }
      const parsed = inner(value);
      return omitDefault && isSchemaDefault(inner, parsed) ? undefined : parsed;
    },
    {inner, kind: 'optional', omitDefault},
    undefined,
    liftIsEqual(inner),
    // Only `undefined`: the parse above delegates `null` to `inner`, so
    // claiming to accept it would answer for a domain that is not this one's.
    liftAccepts(inner, value => value === undefined),
  );
}

/**
 * Whether one schema recognizes `value`, and what it parsed to.
 *
 * The membership rule, stated once: a schema that knows its own domain answers
 * directly, and one that does not has its answer inferred from what it parsed.
 * Landing on the schema's default is the one ambiguous result — it means either
 * "this value *is* the default" or "this value was out of domain and I fell
 * back" — and comparing the *input* against the default separates the two for a
 * schema whose domain is a single value type. Every other result is proof the
 * schema recognized the value, including one it normalized, which is why the
 * parsed value is what comes back.
 *
 * Shared by {@link unionValue}, which asks it per member, and
 * {@link aliasedValue}, which needs it to answer for its inner schema: an alias
 * whose target *is* the inner default is exactly the case the inference cannot
 * see, so an aliased schema has to declare `accepts` rather than be inferred.
 *
 * @internal
 */
function $schemaMatch(
  schema: AnySerializationSchema,
  value: unknown,
): undefined | {parsed: unknown} {
  const {accepts} = schema;
  if (accepts !== undefined) {
    // Asked through `$acceptsValue` rather than by calling the destructured
    // `accepts`, so that every membership question in the file goes through one
    // function — `aliasedValue` is the last site that still open-codes it.
    return $acceptsValue(schema, value) ? {parsed: schema(value)} : undefined;
  }
  const parsed = schema(value);
  // `value === schema.defaultValue`, not `isSchemaEqual`: an `isEqual` answers
  // about two *values*, and `value` here is unparsed input. Every schema whose
  // domain needs more than identity to recognize — including all four that
  // carry a comparator — declares `accepts` and returns above, so identity is
  // the whole of what is left to ask.
  return !isSchemaDefault(schema, parsed) || value === schema.defaultValue
    ? {parsed}
    : undefined;
}

/**
 * Structural equality over the values a schema parses to.
 *
 * What a union compares with, in place of deferring to a member's own
 * comparator. Deferring needs to know which member *produced* a value, and a
 * union cannot: it selects a member by what each one accepts, and
 * `transformValue` is where accepting and producing part company — its input
 * domain is the inner schema's and its output is whatever the transform
 * returns. Every proxy for "this member produced that value" is a guess, and a
 * wrong guess runs a comparator on a value it was not written for: an id
 * comparator handed `['red']` and `['blue']` reads two `undefined` ids and
 * calls them equal, and equal is the answer that drops an update.
 *
 * Comparing content instead gives up nothing that was derivable. `arrayValue`
 * and `objectValue` build exactly this comparison — element-wise and
 * field-wise — so a union that would have deferred to one gets the same
 * answer. The only comparator this does not reproduce is a custom
 * `transformValue` one, which is precisely the one whose domain is unknowable;
 * against that, content equality is stricter, and stricter is the safe
 * direction. It reports two values a custom comparator would call equal as
 * different, which costs a property its compaction or marks a node dirty —
 * never the reverse, which loses data.
 *
 * Anything that is not a plain array or object compares by identity, since a
 * value with its own prototype carries state these keys do not describe.
 */
function $sameContent(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    // An index loop rather than `every`, for the reason `arrayValue` uses one:
    // `every` skips the holes of a sparse array and would report `new Array(3)`
    // as equal to any three-element array.
    for (let i = 0; i < a.length; i++) {
      if (!$sameContent(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false;
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(key => hasOwnKey(b, key) && $sameContent(a[key], b[key]))
  );
}

/**
 * Combinator for a value whose domain is the union of several schemas, such as
 * a dimension that is either a number or the literal `'inherit'`. The domain
 * is inferred as the union of the members' value types; annotate the result
 * when you want to assert a narrower intended domain instead.
 *
 * A {@link SerializationSchema} is total — it always returns a value, falling
 * back to its own default rather than reporting a rejection — so a member is
 * considered to accept `value` when parsing it lands anywhere *other* than that
 * member's default, or when the value is itself that default (the one case a
 * total schema cannot distinguish from a fallback).
 *
 * Selection is in two passes. The first asks every member whether it accepts
 * the value *entirely* — every element of an array, every declared field of an
 * object — and the first such member wins. Only if none does are the members
 * asked again for a partial match, where the first accepting one wins and the
 * union yields what it parsed. So a member that normalizes its input
 * ({@link numberValue} reading a stringified number) composes here the same way
 * it behaves alone, and a value that belongs entirely to a later member is not
 * taken by an earlier one that would only partly coerce it — declaration order
 * decides between members that fit equally well, not between a complete fit and
 * a partial one. If no member accepts at all, the result is `defaultValue` when
 * given, otherwise the first member's default.
 *
 * The inference above is only the fallback. A member that declares its own
 * domain — which every combinator here does — is asked directly, and that is
 * the only way to recognize a value it normalizes
 * *into* its own default (`numberValue()` reading `'0'`). A member whose
 * `defaultValue` lies outside its own constrained domain
 * (`numberValue(0, {min: 1})`) is therefore declined for that value rather
 * than accepting it, and the union falls through to the next member.
 *
 * The result is itself a member of the union in both respects: it declares an
 * `accepts` that asks each member in turn, so a union nested in another union
 * (or reached through a wrapper) keeps its domain, and an `isEqual`, so a union
 * over a reference-typed member still compares by content.
 *
 * That equality is a structural comparison, not a member's own: a union picks a
 * member by what each *accepts*, and {@link transformValue} accepts one domain
 * and produces another, so which member produced a value is not something a
 * union can recover. {@link arrayValue} and {@link objectValue} compare
 * element-wise and field-wise, which is what this does, so a union over either
 * is unaffected. A **custom `isEqual` passed to `transformValue` is not
 * consulted through a union** — two values it would call equal are reported as
 * different, so a property holding one is written out instead of compacted
 * away, `optional({omitDefault})` around the union keeps it instead of
 * dropping it, and as a `createState` parse its `NodeState.toJSON()` writes the
 * value rather than omitting it, `$getStateChange` reports a change, and an
 * updater-form `$setState` performs the write. (A plain-value `$setState`
 * compares nothing either way.) Never the reverse, which would discard the
 * difference. Outside a union the comparator is used as declared.
 *
 * @example
 * ```ts
 * const parseDimension = unionValue([numberValue(), enumValue(['inherit'])], 'inherit');
 * //    ^? SerializationSchema<number | 'inherit'>
 * parseDimension(640);       // 640
 * parseDimension('640');     // 640 (numberValue reads a stringified number)
 * parseDimension('inherit'); // 'inherit'
 * parseDimension('banana');  // 'inherit' (no member accepts it)
 * ```
 * @__NO_SIDE_EFFECTS__
 */
export function unionValue<
  // Undeclared members, for the reason every combinator takes an undeclared
  // inner (see {@link withAccessors}): a union parses to any member's value.
  const M extends readonly InnerSerializationSchema[],
>(
  members: M,
  // A rest tuple rather than an optional parameter, so that a *declared*
  // `undefined` is legal only where the union really produces one. An optional
  // parameter admits `undefined` whatever its declared type says, so
  // `unionValue([numberValue(), stringValue()], undefined)` type-checked as
  // `SerializationSchema<number | string>` and then returned `undefined` from
  // every parse that fell through. As the tuple's one element it is checked
  // against the members' domain like any other value — and `args.length` is
  // what tells a declared `undefined` from an omitted one, which `!==
  // undefined` cannot: comparing against it substituted the first member's
  // default (`unionValue([numberValue(), optional(stringValue())], undefined)`
  // defaulted to `0`) and `accepts(undefined)` then declined the value the
  // union was told to fall back to. `enumValue` passes its default explicitly
  // for the same reason.
  ...args: [] | [defaultValue: SerializationSchemaValue<M[number]>]
): SerializationSchema<
  SerializationSchemaValue<M[number]>,
  never,
  SchemaInput<M[number]>
> {
  type T = SerializationSchemaValue<M[number]>;
  if (__DEV__) {
    invariant(
      members.length > 0,
      'unionValue: at least one member schema is required',
    );
    for (const member of members) {
      undeclared('unionValue', member);
    }
  }
  // A declared default is the caller's value; the one taken from a member is
  // that member's, and already answered for by whatever built it. See
  // {@link CALLER_OWNED}.
  const fallback =
    args.length !== 0
      ? markCallerOwned(args[0])
      : (members[0].defaultValue as T);
  /**
   * The member that recognizes `value`, and what it parsed to. The membership
   * rule itself is `$schemaMatch`'s, which the `accepts` below applies through
   * `$acceptsValue` without the parse: the two cannot answer differently
   * because they ask the same question of the same members in the same order.
   */
  const $match = (
    value: unknown,
  ): undefined | {member: AnySerializationSchema; parsed: T} => {
    // The member this union parses with, chosen by the same procedure that
    // answers whether a union is a complete match — see `$selectUnionMember`.
    const member = $selectUnionMember(members, value);
    return member === undefined
      ? undefined
      : {member, parsed: member(value) as T};
  };

  return makeSchema<T, never, SchemaInput<M[number]>>(
    value => {
      if (value === undefined) {
        // A member that accepts `undefined` (an optional or raw one) would
        // otherwise win here and return it, contradicting `defaultValue` —
        // which compaction and `omitDefault` both compare against.
        return fallback;
      }
      const matched = $match(value);
      return matched === undefined ? fallback : matched.parsed;
    },
    {kind: 'union', members},
    // A member that accepts `undefined` (an optional or raw one) would
    // otherwise make `undefined` the derived default, discarding `fallback`.
    fallback,
    // By content, so a union over a reference-typed member
    // (arrayValue/objectValue, which return a fresh value per parse) still
    // compares equal to its default — without this such a property could never
    // compact, and as a `createState` parse it would fall back to Object.is and
    // dirty the node on every write of an equal value.
    //
    // Not by deferring to a member's own comparator, which needs to know which
    // member *produced* a value: the union selects by what each member accepts,
    // and `transformValue` accepts one domain and produces another. See
    // {@link $sameContent} for why every proxy for that is a guess, and what a
    // wrong guess costs.
    //
    // Declared unconditionally, which the codegen also depends on: it reads
    // `isEqual === undefined` as "this property cannot be compared here" and
    // takes the whole class out of the compact half, so a union that withheld
    // one would cost its class a generated compact exporter rather than one
    // property's compaction.
    $sameContent,
    // Declared for the same reason every wrapper declares one: a union used as
    // a member of another union (or wrapped and then used) would otherwise be
    // read by the parse-inference above, which cannot see a value this
    // normalizes into its own default — `unionValue([numberValue(),
    // enumValue(['inherit'])])` parsing '0' to 0 would be read as a fallback
    // and the whole union skipped. `undefined` is excluded to match the parse.
    //
    // Asked of the members rather than through `$match`, which parses with the
    // member it picks: a caller deciding whether this union accepts a value
    // would then parse the whole subtree, and parse it again once it decided
    // to. The two agree by construction — `$match` takes the first member
    // `$schemaMatch` recognizes, and this is that same test without the parse.
    //
    // `undefined` is excluded to match the parse — unless the fallback *is*
    // `undefined`, in which case the parse returns it and declining would be a
    // schema refusing the value it produced. That is the same clause
    // `enumValue` carries, and without it an `objectValue` holding an absent
    // union-typed field declined its own output and lost every sibling.
    value =>
      (value !== undefined || fallback === undefined) &&
      members.some(member => $acceptsValue(member, value)),
  );
}

/**
 * A serialization schema with no outstanding names — every `field`, accessor
 * and predicate it declares has been checked against a node, which is what
 * {@link nodeSchema} does and reports by discharging them.
 *
 * `$config`'s `json` asks for this, so a schema that names anything has to be
 * built with {@link nodeSchema} and cannot reach a node unchecked.
 *
 * `N` records *which* node it was checked against, so discharging the names
 * does not also lose track of whose they were: `$config` asks for the schema
 * of the node it is declared on, and one checked against an unrelated class is
 * a compile error there rather than a set of accessors that happen not to
 * resolve at runtime. A schema checked against a base class still installs on
 * a subclass, which is the direction that stays true — every member it names
 * is inherited — and not the reverse.
 */
/**
 * What a {@link nodeSchema} carries: the properties a node declares, and a
 * kind of its own.
 *
 * Not a member of {@link SerializationSchemaMeta}, because a node schema is
 * never nested inside another schema. It describes a *node*, whose properties
 * are applied one at a time to an object the walk does not own, where an
 * `objectValue` describes a *value* that one property holds. Giving the two
 * separate types is what lets a consumer of either be sure which it has.
 */
export interface NodeSchemaMeta {
  readonly kind: 'node';
  readonly fields: SerializationSchemaFields;
}

export interface NodeSerializationSchema<N = unknown, In = unknown> {
  /**
   * The properties this node declares, and the whole of what a node schema is
   * at run time.
   *
   * A node schema is not a parser. Nothing ever calls one: the composition
   * reads these fields and the walk applies each one to the node, so the
   * whole-object machinery an {@link objectValue} carries — a parse that
   * builds an object, a default object, a field-wise equality, a membership
   * predicate — would be constructed per node class and never used. Leaving it
   * out is what keeps it out of an application that declares schemas and never
   * calls `objectValue` itself.
   */
  readonly meta: NodeSchemaMeta;
  /**
   * What this schema accepts, carried exactly as {@link SerializationSchema}
   * carries it: the composed input type a document is checked against.
   *
   * @internal
   */
  readonly [INPUT]?: In;
  /**
   * Declared as a function of `N` rather than an `N`, so the parameter
   * position gives the assignability its direction: a schema for a base class
   * satisfies a subclass's `$config`, and a subclass's does not satisfy the
   * base's. Optional and never assigned, like {@link SerializationSchema}'s
   * own phantom — a schema that names nothing is checked against nothing and
   * is installable anywhere.
   *
   * @internal
   */
  readonly [CHECKED_AGAINST]?: (node: N) => void;
}

/**
 * A node's serialization schema, checked against the node it is for.
 *
 * The same shape {@link objectValue} takes, with one type argument naming the
 * node — which is what lets every `field`, accessor `method` and `when`
 * predicate be verified to exist. A name the node does not have is a compile
 * error at the property that declares it, with the correction suggested:
 *
 * ```ts
 * const codeNodeSchema = nodeSchema<CodeNode>()({
 *   language: withField(optional(nullable(stringValue())), {
 *     field: '__langauge',
 *   }),
 * });
 * //          ~~~~~~~~~~~~
 * // Type '"field:__langauge"' is not assignable to type '... | TaggedNamesOf<CodeNode> | ObligationsOf<CodeNode>'.
 * //   Did you mean '"field:__language"'?
 * ```
 *
 * Where the schema is written does not change what is checked: a module-scope
 * `const` above the class — a class's *type* is in scope before its
 * definition, and this is what every built-in node does — or inline in
 * `$config()`, as `TabNode` spells it. Checking a declaration means resolving
 * the class's members, and an unannotated `$config()` has a return type
 * inferred from this very schema; the members whose types come from it are
 * skipped (`ScannableKeys`), and what a setter returns is compared against
 * the brand every node carries rather than all of `LexicalNode`
 * (`SetterReturn`), so that neither position asks the check for its own
 * answer.
 *
 * The result reports no outstanding names, which is what `$config`'s `json`
 * requires — so a schema that names anything has to come through here, and the
 * check cannot be skipped by declaring the properties some other way.
 *
 * @__NO_SIDE_EFFECTS__
 */
export function nodeSchema<N extends Checkable<N>>() {
  return <
    const F extends {
      readonly [key: string]: SerializationSchema<
        unknown,
        MemberOf<N>,
        unknown
      >;
    },
  >(
    // `& Conventional`: the accessors a field leaves to convention are checked
    // here, per key, since the constraint above sees only what is declared.
    fields: F & Conventional<N, F>,
  ): NodeSerializationSchema<
    N,
    {readonly [K in keyof F]?: SchemaInput<F[K]>}
  > =>
    nodeSchemaOf(fields) as unknown as NodeSerializationSchema<
      N,
      {readonly [K in keyof F]?: SchemaInput<F[K]>}
    >;
}

/**
 * {@link nodeSchema}'s body, once: the object schema, recorded as a node's,
 * with a field that is itself a node schema refused — the walk resolves
 * accessors on a node's own fields only, so a nested node schema's would be
 * declared and never used. Its fields may name accessors, which is the one
 * thing that sets it apart from {@link objectValue}.
 * @__NO_SIDE_EFFECTS__
 */
function nodeSchemaOf(
  fields: SerializationSchemaFields,
): NodeSerializationSchema {
  checkFieldNames('nodeSchema', fields);
  const schema: NodeSerializationSchema = {meta: {fields, kind: 'node'}};
  if (__DEV__) {
    for (const [key, field] of Object.entries(fields)) {
      invariant(
        !isNodeSchema(field),
        'nodeSchema: field "%s" is itself a node schema; a nested object is an objectValue, whose fields name no accessor',
        key,
      );
    }
  }
  return schema;
}

/**
 * Combinator for a value that older documents may spell as one of a fixed set
 * of names — TextNode's `format: 'bold'` for the numeric bit it stands for.
 * A string matching one of `aliases` yields the value it names; anything else
 * is `inner`'s to validate, so the domain, the default and the equality all
 * stay `inner`'s and only the accepted *input* is wider.
 *
 * This is {@link transformValue} narrowed to the case where the normalization
 * is a lookup, and the reason to prefer it is that the lookup is data: it goes
 * into the schema's {@link SerializationSchemaMeta | meta}, where a tool can
 * see it. A `transformValue` keeps its function to itself, so its meta can say
 * only that a transform happens: example generation still reaches the inner
 * domain, and a code generator refuses the property rather than compile a
 * parse that stores the alias where the schema stores what it names.
 *
 * @example
 * ```ts
 * const parseFormat = aliasedValue(numberValue(), TEXT_TYPE_TO_FORMAT);
 * //    ^? SerializationSchema<number>
 * parseFormat(1);      // 1
 * parseFormat('bold'); // IS_BOLD
 * parseFormat('42');   // 42 (not an alias, so numberValue reads it)
 * parseFormat('junk'); // 0  (numberValue falls back to its default)
 * ```
 * @__NO_SIDE_EFFECTS__
 */
export function aliasedValue<
  T,
  const A extends {readonly [alias: string]: T},
  In = T,
>(
  inner: SerializationSchema<T, never, In>,
  aliases: A,
): SerializationSchema<T, never, In | Extract<keyof A, string>> {
  undeclared('aliasedValue', inner);
  // hasOwnKey, not `alias in aliases` or a bare lookup: `aliases` is a plain
  // object literal, so an untrusted `'toString'` would otherwise resolve to
  // Object.prototype's method and be stored as this property's value.
  const isAlias = (value: unknown): value is string =>
    typeof value === 'string' && hasOwnKey(aliases, value);
  return makeSchema(
    value => (isAlias(value) ? (aliases[value] as T) : inner(value)),
    {aliases, inner, kind: 'aliased'},
    // Naming an alias says nothing about which value is the default.
    inner.defaultValue,
    inner.isEqual,
    // Declared unconditionally. An alias whose target *is* the inner default
    // is precisely what the parse-inference cannot see — it lands on the
    // default, and the input is not the default, so the inference reads it as
    // a fallback and a union skips the member that in fact accepts it. Saying
    // so here is the only way to answer for those; everything else is the
    // inner schema's own domain, asked through the one membership helper.
    value => isAlias(value) || $acceptsValue(inner, value),
  );
}

/**
 * Combinator that normalizes the value another {@link SerializationSchema} parsed, for
 * serialized properties whose accepted domain is wider than the stored one —
 * the motivating case is a legacy shorthand that older documents carry
 * (`format: 'bold'`) being folded into the stored numeric form. `inner` still
 * owns the domain: it validates the untrusted input (falling back to its
 * default as usual), and `transform` then maps every value it can produce
 * into the target domain, so the node's setter only ever sees normalized
 * values.
 *
 * `transform` must be pure and total over `inner`'s outputs: it runs once
 * when the schema is built to derive the {@link SerializationSchema.defaultValue}
 * (the transform of `inner`'s default) and once per parsed value. The
 * {@link SerializationSchemaMeta | meta} is a `transform` kind holding
 * `inner`, so introspection still reaches the accepted input domain — tooling
 * that generates example JSON keeps generating the legacy forms, which is
 * exactly what a parser test wants to exercise. Like every combinator, this
 * takes a schema that names no accessor; see {@link withAccessors}.
 *
 * `inner`'s {@link SerializationSchema.isEqual | isEqual} is *not* inherited:
 * it compares values of `inner`'s domain, and the transformed domain may be a
 * different type entirely. Pass `{isEqual}` when the output domain is
 * reference-typed, or a transformed array/object property can never compact
 * away and, used as a `createState` parse, dirties its node on every write of
 * an equal value.
 *
 * A comparator passed here is used wherever this schema is used directly, but
 * is *not* consulted when the schema is a {@link unionValue} member: a union
 * selects by what a member accepts, and this accepts `inner`'s domain while
 * producing another, so it cannot tell which member made a value and compares
 * structurally instead. The effect is a stricter answer than yours — a value
 * you would call the default is written out rather than compacted away — never
 * a looser one.
 *
 * Only then: an equality is for a domain `===` cannot compare, so declaring
 * one over a primitive output is an error. `===` already answers there, and a
 * comparator can only widen it — call two distinct serialized values equal —
 * after which the compact form omits whichever is not the default and parsing
 * restores the default in its place. A rotation compared modulo 360 serializes
 * `360` as nothing and reads back as `0`. Normalize in the `transform`
 * instead, where the value that reaches storage is the one that round-trips.
 *
 * @example
 * ```ts
 * const parseFormat = transformValue(
 *   unionValue(
 *     [numberValue(), enumValue(['bold', 'italic', 'underline'])],
 *     0,
 *   ),
 *   value => (typeof value === 'string' ? TEXT_TYPE_TO_FORMAT[value] : value),
 * );
 * //    ^? SerializationSchema<number>
 * parseFormat(1);      // 1
 * parseFormat('bold'); // IS_BOLD
 * parseFormat('junk'); // 0 (inner falls back to its default)
 * ```
 * @__NO_SIDE_EFFECTS__
 */
export function transformValue<Inner, Out, In = Inner>(
  inner: SerializationSchema<Inner, never, In>,
  transform: (value: Inner) => Out,
  options: {readonly isEqual?: (a: Out, b: Out) => boolean} = {},
): SerializationSchema<Out, never, In> {
  undeclared('transformValue', inner);
  const schema = makeSchema<Out, never, In>(
    value => transform(inner(value)),
    {inner, kind: 'transform'},
    // Derived here rather than by makeSchema calling `parse(undefined)`, which
    // is the same value: `transform` is the caller's function, so what it
    // returns is the caller's to keep — possibly a module constant it also uses
    // elsewhere — and a default makeSchema derives is one it freezes.
    // Recorded as the caller's, so an enclosing schema deriving *its* default
    // does not reach this object through the recursion either.
    markCallerOwned(transform(inner.defaultValue)),
    options.isEqual,
    // Membership is about the *input* domain, and the transform maps outputs,
    // so what the inner schema admits is exactly what this admits — asked of
    // `inner`, and declared whether or not `inner` declares one of its own.
    // Forwarding a bare `inner.accepts` left this undefined for the common
    // inner, and a union then inferred membership from the *transformed*
    // output: a transform out of the inner's type reads every input as this
    // schema's default and is declined, and the equality that decides it is the
    // caller's, handed a value from the wrong side of the transform.
    value => $acceptsValue(inner, value),
  );
  // An equality is for a domain `===` cannot compare, which means a
  // reference-typed one. Over primitives `===` is already the answer, so a
  // comparator can only widen it — declare two distinct serialized values
  // equal — and the compact form then drops whichever one is not the default
  // and parses it back as the default. `transformValue(numberValue(), v => v,
  // {isEqual: (a, b) => a % 360 === b % 360})` writes no `rotation` for 360 and
  // reads it back as 0.
  //
  // Checked here because this is the only place a comparator is a caller's to
  // pass: `arrayValue` and `objectValue` derive their own, and every wrapper
  // lifts its inner schema's, which has already been through here.
  if (__DEV__) {
    invariant(
      options.isEqual === undefined ||
        (schema.defaultValue !== null &&
          typeof schema.defaultValue === 'object'),
      'transformValue: isEqual compares reference-typed values, but this schema parses to %s. Two primitives that are not === are two different serialized values; declaring them equal loses one of them in the compact form.',
      typeof schema.defaultValue,
    );
  }
  return schema;
}

/**
 * Build a {@link SerializationSchema} for a value this schema deliberately does not
 * validate, because something else owns its domain — the motivating case is a
 * nested {@link SerializedEditor}, which the nested editor's own
 * `parseEditorState` validates when the property is applied.
 *
 * The value is passed through unchanged and `undefined` is the recoverable
 * default, so declaring the property still routes it through the node's setter
 * (and keeps it visible to schema-walking tooling) without pretending to
 * validate its contents.
 * @__NO_SIDE_EFFECTS__
 */
export function rawValue<T>(): SerializationSchema<
  T | undefined,
  never,
  unknown
> {
  return makeSchema(
    value => (value === undefined ? undefined : (value as T)),
    {kind: 'raw'},
    undefined,
    undefined,
    // Declared, like every other combinator's, so that deciding whether a value
    // is in this domain costs no parse: `$schemaMatch` falls back to inferring
    // membership from a parse, and a caller that only wanted the answer — an
    // `objectValue` asking about each of its fields — would then parse the
    // value once to decide and once to read it.
    //
    // Everything, `undefined` included: this schema validates nothing, so it
    // has nothing to decline. Excluding `undefined` here read as "an absent
    // property is not mine", but an absent property is precisely what a raw
    // field holds when it has no value — and `objectValue` asks this of every
    // declared key the input carries, so one `{note: undefined}` took the whole
    // enclosing object out of a union and lost every sibling property with it.
    () => true,
  );
}

/**
 * Build a {@link SerializationSchema} for an array whose entries are each coerced by `item`.
 * A non-array value (including `undefined`) yields the empty array, which is the
 * recoverable default.
 *
 * @example
 * ```ts
 * const parseIds = arrayValue(stringValue());
 * //    ^? SerializationSchema<string[]>
 * parseIds(['a', 'b']); // ['a', 'b']
 * parseIds('nope');     // []
 * ```
 * @__NO_SIDE_EFFECTS__
 */
export function arrayValue<T, In = T>(
  // Undeclared (see {@link withAccessors}), and for a reason of its own too:
  // the item describes an *element*, so a name on it is not this property's.
  item: SerializationSchema<T, never, In>,
): SerializationSchema<T[], never, readonly In[]> {
  undeclared('arrayValue', item);
  return makeSchema(
    value => {
      if (!Array.isArray(value)) {
        return [];
      }
      // An index loop rather than `map`, which preserves the holes of a sparse
      // array: the item schema would never see them, and a property typed as
      // the item's domain would serialize them as `null`.
      const result = new Array<T>(value.length);
      for (let i = 0; i < value.length; i++) {
        result[i] = item(value[i]);
      }
      return result;
    },
    {item, kind: 'array'},
    undefined,
    // A parse returns a fresh array, so identity would never match the empty
    // default and such a property could never be compacted. Compare by
    // content, element-wise through the item schema.
    // Total, not just defined on the parsed domain: the export path hands this
    // whatever the node's getter returned, which nothing validated. An index
    // loop rather than `every`, which skips the holes of a sparse array and
    // would report `new Array(3)` as equal to any three-element array.
    (a, b) => {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false;
      }
      for (let i = 0; i < a.length; i++) {
        if (!isSchemaEqual(item, a[i], b[i])) {
          return false;
        }
      }
      return true;
    },
    // An array whose every element `item` recognizes. Declared rather than
    // inferred so that `$schemaMatch` never has to ask the comparator above
    // about a raw input — a comparator answers about *values*, and the
    // inference has only the input to offer.
    //
    // Just "is an array". Telling one array variant from another is a *whole*
    // match question, which `$fitOf` answers for the union's first
    // pass; this one only has to say whether the member could parse the value
    // at all, and an array parse is total — it coerces every element.
    //
    // Inspecting elements here cost data instead of saving it, because a
    // decline propagates: `objectValue` asks each declared field, so an array
    // no element of which matched took its whole enclosing object out of the
    // union, and `{"label": "keep me", "tags": ["banana"]}` lost the label.
    // The same refusal hit an array whose elements each carried one key a
    // newer version added, and an `arrayValue` over a `transformValue`, whose
    // elements on disk are transform *outputs* while the item's `accepts`
    // describes the inner *input* — so it declined the very array it wrote.
    // Accepting costs at most a coerced element, which is what the parse does
    // with a malformed element anyway.
    //
    // Wrapped rather than passed as the bare `Array.isArray`: `makeSchema`
    // records the predicate it is given as combinator-derived, keyed by
    // function identity, so handing it the global would claim that builtin for
    // the whole process — and an author who then wrote `{accepts: Array.isArray}`
    // would have their own predicate silently ignored.
    value => Array.isArray(value),
  );
}

/**
 * Build a {@link SerializationSchema} for an array of strings used as a set,
 * each coerced by `item`, for use as the value of a NodeState:
 *
 * ```ts
 * const tagsState = createState('tags', {parse: arraySetValue(stringValue())});
 * //    ^? StateConfig<'tags', readonly string[]>
 * ```
 *
 * The value is a frozen array in a canonical form: sorted by UTF-16 code unit,
 * with no duplicates, so its order carries no meaning.
 *
 * - Parsing reads an array, keeps the entries `item` accepts, drops
 *   duplicates, sorts the result and freezes it. Anything else, `undefined`
 *   included, is the empty array, which is the default.
 * - A value written with `$setState` is put into the same form, so
 *   `$setState(node, tagsState, ['b', 'a', 'a'])` stores, and reads back,
 *   the frozen `['a', 'b']`.
 * - Two values are equal when they are equal element by element, which,
 *   since both are canonical, means they have the same members. A state
 *   holding the empty array is left out of the JSON like any default.
 * - The JSON is the same sorted array, so equal sets always serialize
 *   identically and a round trip through JSON is stable.
 *
 * The value is frozen, so changing it in place throws in strict mode: build a
 * new array and write it with `$setState`. It is meant for small sets, such
 * as the ids of the comments on a piece of text or a few tags; a large set
 * does not belong in NodeState.
 *
 * The members are strings so that this order is well defined, and so that a
 * member can be used as a key, for example by code that stores each member
 * on its own (see the `'set'` kind of {@link SerializationSchemaMeta}).
 * Narrower string domains such as `enumValue(['a', 'b'])` work as the item
 * too, and so does an item schema whose `accepts` declines some strings:
 * the members it declines are dropped.
 *
 * `arraySetValue` must be the whole value of a `createState`: it cannot be
 * wrapped by another schema or used for a node property, and a development
 * build refuses both, as well as an item schema that does not produce
 * strings.
 *
 * @example
 * ```ts
 * const parseTags = arraySetValue(stringValue());
 * parseTags(['b', 'a', 'b', 1]); // ['a', 'b'] (frozen)
 * parseTags('nope');             // [] (frozen)
 * ```
 *
 * @experimental
 * @__NO_SIDE_EFFECTS__
 */
export function arraySetValue<T extends string, In = T>(
  item: SerializationSchema<T, never, In>,
): SerializationSchema<readonly T[], never, readonly In[]> {
  undeclared('arraySetValue', item);
  if (__DEV__) {
    // The types require string items; this catches untyped callers, whose
    // members would otherwise be sorted as strings and never be canonical
    invariant(
      typeof item.defaultValue === 'string',
      'arraySetValue: the item schema must produce strings',
    );
  }
  return makeSchema(
    (value): readonly T[] => {
      if (!Array.isArray(value)) {
        return Object.freeze([]);
      }
      if (Object.isFrozen(value) && $isCanonicalSet(item, value)) {
        // Already canonical (a value read back and written again): keep it,
        // so that writing it back is the same value
        return value;
      }
      const members: T[] = [];
      for (let i = 0; i < value.length; i++) {
        const member: unknown = value[i];
        // Dropped rather than coerced: `item` would turn an out-of-domain
        // entry into its default, a member nobody added.
        if (member !== undefined && $acceptsValue(item, member)) {
          members.push(item(member));
        }
      }
      members.sort();
      const result: T[] = [];
      for (let i = 0; i < members.length; i++) {
        if (i === 0 || members[i] !== members[i - 1]) {
          result.push(members[i]);
        }
      }
      return Object.freeze(result);
    },
    {item, kind: 'set'},
    undefined,
    isArraySetEqual,
    value => Array.isArray(value),
  );
}

/**
 * Whether `value` is already in {@link arraySetValue}'s canonical form for
 * `item`: every member accepted and unchanged by it, strictly ascending.
 */
function $isCanonicalSet<T extends string, In>(
  item: SerializationSchema<T, never, In>,
  value: readonly unknown[],
): boolean {
  for (let i = 0; i < value.length; i++) {
    const member = value[i];
    if (
      typeof member !== 'string' ||
      (i > 0 && !((value[i - 1] as string) < member)) ||
      !$acceptsValue(item, member) ||
      item(member) !== member
    ) {
      return false;
    }
  }
  return true;
}

/**
 * {@link arraySetValue}'s equality: element by element, which is "the same
 * members" because both sides are sorted and free of duplicates. Total, like
 * the other built-in comparators.
 */
function isArraySetEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) {
    return true;
  }
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Compose per-property {@link SerializationSchema}s into a single {@link SerializationSchema} for an
 * object-valued property. Calling it coerces each known property in turn
 * (ignoring any extra properties), so `objectValue(...)` applied to a partial
 * or untrusted object returns a fully-populated, validated object;
 * `objectValue(...)(undefined)` returns the all-defaults object. Its fields
 * name no accessor: an object's field is not a node's property, which is what
 * {@link nodeSchema} — the same record, checked against a node — is for.
 *
 * @example
 * ```ts
 * // A property whose value is an object of its own; a node's own schema is
 * // nodeSchema<MyNode>()({...}), whose fields may name accessors.
 * const dimensions = objectValue({
 *   height: numberValue(),
 *   width: numberValue(),
 * });
 * ```
 * @__NO_SIDE_EFFECTS__
 */
export function objectValue<const S extends InnerSerializationSchemaFields>(
  fields: S,
): ObjectSchema<S> {
  const schema = objectSchema('objectValue', fields);
  if (__DEV__) {
    for (const [key, field] of Object.entries(fields)) {
      // Its own message rather than `undeclared`'s: the fix here is not to move
      // the accessor but to build the node's own schema with `nodeSchema`.
      invariant(
        field.getter === undefined &&
          field.setter === undefined &&
          !isNodeSchema(field),
        "objectValue: field \"%s\" names an accessor, and an object's field is not a node's property. A node's own schema is nodeSchema<MyNode>()({...})",
        key,
      );
    }
  }
  return schema;
}

/** What {@link objectValue} returns: one property per field, and no names. */
type ObjectSchema<S extends SerializationSchemaFields> = SerializationSchema<
  {[K in keyof S]: SerializationSchemaValue<S[K]>},
  never,
  {[K in keyof S]?: SchemaInput<S[K]>}
>;

/**
 * The names a serialized property may not have, checked where the schema is
 * written. Shared by {@link objectValue} and {@link nodeSchema}, which read
 * their fields off objects that came from `JSON.parse`.
 *
 * `__proto__` is refused in every build: assigning it on a plain object
 * invokes `Object.prototype`'s setter and reparents the result instead of
 * writing a property, so what it prevents is a parse returning an object
 * missing the property it declared. That is a wrong value rather than a
 * missing diagnostic. It costs one comparison per field when the schema is
 * built, which is once at module scope, and nothing per parse.
 *
 * The rest of `Object.prototype`'s members are refused in a development build,
 * for the same reason one step removed. A serialized object inherits them, and
 * every read of a property is a bare one, because an absent property is
 * `undefined` and that is already its default. A field named for an inherited
 * member is the single case where that reads something: the method, for a
 * property the document never carried. The code generator refuses the same
 * names, so this is the diagnostic for the path that has no build step.
 *
 * @__NO_SIDE_EFFECTS__
 */
function checkFieldNames(
  combinator: string,
  fields: SerializationSchemaFields,
): void {
  for (const key of Object.keys(fields)) {
    invariant(
      key !== '__proto__',
      '%s: "__proto__" is not a valid field name',
      combinator,
    );
    if (__DEV__) {
      invariant(
        !(key in Object.prototype),
        '%s: "%s" is a member of Object.prototype, which a serialized object inherits, so it cannot be told apart from a property the document never carried',
        combinator,
        key,
      );
      notNestedSet(combinator, fields[key]);
    }
  }
}

/**
 * {@link objectValue} without the accessor check, for {@link nodeSchema}: its
 * fields are the one place a name is declared, and the one place it is
 * discharged.
 * @__NO_SIDE_EFFECTS__
 */
function objectSchema<S extends SerializationSchemaFields>(
  combinator: string,
  fields: S,
): ObjectSchema<S> {
  const entries = Object.entries(fields) as [string, AnySerializationSchema][];
  checkFieldNames(combinator, fields);
  return makeSchema(
    value => {
      // A bare read per field, as the node walk makes: an absent property is
      // `undefined`, which is what the field's schema maps to its default, and
      // the names an inherited property could answer for are the ones the
      // field list refused above.
      const source: {readonly [key: string]: unknown} =
        value !== null && typeof value === 'object'
          ? (value as {readonly [key: string]: unknown})
          : {};
      const result: {[key: string]: unknown} = {};
      for (let i = 0; i < entries.length; i++) {
        const [key, schema] = entries[i];
        result[key] = schema(source[key]);
      }
      return result as {[K in keyof S]: SerializationSchemaValue<S[K]>};
    },
    {fields: fields as SerializationSchemaFields, kind: 'object'},
    undefined,
    // As with arrayValue: a parse returns a fresh object, so compare the
    // declared fields rather than the reference — and total, since the export
    // path hands this an unvalidated getter result. A value carrying keys this
    // schema does not declare is *not* equal to the default: those keys say
    // something, and reporting equality would drop them from the export.
    (a, b) =>
      isPlainObject(a) &&
      isPlainObject(b) &&
      !hasUndeclaredKey(a, fields) &&
      !hasUndeclaredKey(b, fields) &&
      entries.every(([key, schema]) => isSchemaEqual(schema, a[key], b[key])),
    // As with arrayValue, and for the same reason: declaring membership keeps
    // the field comparators away from inputs.
    //
    // Not merely "is an object": every objectValue would then accept every
    // object, and the first one in a union would answer for all of them —
    // `unionValue([objectValue({x}), objectValue({label})])` would read
    // `{label: 'hello'}` as `{x: 0}`, losing the property and, through
    // NodeState, the whole state along with it once it compares equal to the
    // default. What tells one object variant from another is its *keys*, which
    // is what the parse-inference this replaces was reading (through the
    // comparator, which rejects an undeclared key).
    //
    // *Structural* only — the keys, not the values behind them — which is the
    // same answer `arrayValue` gives for the same reason. Asking each field
    // about its value asked the wrong question twice over: a `transformValue`
    // field's `accepts` describes the inner *input* while the document holds
    // its *output*, and a field whose declared default sits outside its own
    // domain (`numberValue(0, {min: 1})`) declines that default deliberately.
    // Either way the object declined the very value it had written, and a
    // union then discarded it with every sibling property. Whether the fields
    // *fit* is the whole-match question, which `$fitOf` ranks for the
    // union's first pass; this one only says whether the member could parse
    // the value at all, and an object parse is total — it coerces every field.
    //
    // Presence is deliberately not required. Every field is optional on the way
    // in — a parse fills what is missing from the field's own default — so `{}`
    // is in the domain, and it is a shape this schema really produces: an
    // object whose fields are all `optional({omitDefault})` serializes to `{}`
    // once they hold their defaults.
    value => isPlainObject(value) && !hasUndeclaredKey(value, fields),
  );
}

/**
 * Return a copy of `schema` that declares the serialized property to *be* a
 * node field rather than a pair of accessor methods.
 *
 * This is the fast path in both directions: exporting reads the field, and
 * importing assigns it, with no method call on either side — and no version
 * resolution either way, since the node being parsed into is writable by
 * construction and the node being exported is one the walk already resolved
 * from the EditorState. Because the name is recorded on the schema, an introspecting
 * tool (a codegen pass emitting a specialized parser for a hot node type) can
 * see that a property is a plain field and compile it to a direct assignment.
 * Use {@link withAccessors} with a `{field}` on one side only when the two
 * directions differ — reading the field but writing through a method that
 * normalizes, as TableCellNode's `headerState` does.
 *
 * The trade-off is that a field access is exactly that: normalization,
 * validation or bookkeeping a `set<Prop>` method would do is skipped, and a
 * subclass override of that method is not consulted. Use it when the property
 * really is the field — which is also what makes it safe to compile away.
 *
 * Each direction still stands in for an accessor, so a subclass that overrode
 * one still decides; see {@link SchemaFieldBase.method}. That accessor is the
 * conventional `get<Prop>`/`set<Prop>` unless `getter`/`setter` name a
 * different one, so most declarations need neither — name one only where the
 * accessor is spelled differently, as TextNode's `text` is (`getTextContent`).
 * A node with no such method defers to nothing, which needs no declaring.
 *
 * `getterTable`/`setterTable` declare a property whose stored and serialized forms
 * differ ({@link SchemaGetterField.getterTable} / {@link SchemaSetterField.setterTable}),
 * and `when` names the predicate gating the export direction
 * ({@link SchemaGetterField.when}).
 *
 * @example
 * ```ts
 * nodeSchema<TextNode>()({
 *   // TextNode's own field in both directions, deferring to getStyle/setStyle
 *   // for a subclass that overrides either — neither is spelled here, since
 *   // both are the conventional name for a `style` property.
 *   style: withField(stringValue(), {field: '__style'}),
 *   // LinkNode's own field, standing in for getURL/setURL rather than the
 *   // getUrl/setUrl the property name would derive.
 *   url: withField(stringValue(), {
 *     field: '__url',
 *     getter: 'getURL',
 *     setter: 'setURL',
 *   }),
 * });
 * ```
 * @__NO_SIDE_EFFECTS__
 */
export function withField<T, const F extends FieldOptions, In = T>(
  schema: SerializationSchema<T, never, In>,
  field: F,
): SerializationSchema<T, FieldOptionNames<F, T>, In> {
  // `getterTable`/`setterTable`, `when` and the two method names each belong to one
  // direction, so the single options object is split into the two accessors
  // here rather than making every caller write both out.
  // The two accessor objects are built here rather than written by the
  // caller, so the names can only be recovered from `F` — which the return
  // type does. The runtime value is exactly what withAccessors produced.
  return named(
    'withField',
    schema,
    {
      getter: {
        field: field.field,
        getterTable: field.getterTable,
        method: field.getter,
        when: field.when,
      },
      setter: {
        field: field.field,
        method: field.setter,
        setterTable: field.setterTable,
      },
    },
    field.derived === true,
  );
}

/**
 * Return a copy of `schema` that records both accessor names at once, which is
 * the common case for a property whose node methods do not follow the default
 * `get<Prop>`/`set<Prop>` naming. Either direction may be omitted to keep the
 * conventional name for that one.
 *
 * **This and {@link withField} go outside every other combinator**, because an
 * accessor answers for the property as a whole and each combinator widens what
 * the property holds: `nullable` admits `null`, `optional` admits an absent
 * value, `transformValue` produces a type of its own, and a union produces any
 * member's. `nullable(withAccessors(stringValue(), {setter: 'setLabel'}))`
 * obliged `setLabel` to take a `string` while the parser hands it `null` for a
 * document that omits the property. Written the other way round —
 * `withAccessors(nullable(stringValue()), {setter: 'setNullableLabel'})` — the
 * obligation is stated for what the property really parses to, and the
 * compiler checks it. Exactly once per property: a second layer would name a
 * direction the first already named, and the walk calls only the outer one —
 * an obligation checked for an accessor that is never called — so both
 * directions are named in one call, and every combinator, this one included,
 * refuses a schema that already names an accessor. A development build holds
 * the rule at run time too, for a caller the types do not reach.
 *
 * @example
 * ```ts
 * nodeSchema<TextNode>()({
 *   text: withAccessors(stringValue(), {
 *     getter: 'getTextContent',
 *     setter: 'setTextContent',
 *   }),
 * });
 * ```
 * @__NO_SIDE_EFFECTS__
 */
export function withAccessors<T, const A extends SchemaAccessors, In = T>(
  schema: SerializationSchema<T, never, In>,
  accessors: A,
): SerializationSchema<T, AccessorNames<A, T>, In> {
  return named(
    'withAccessors',
    schema,
    {getter: accessors.getter, setter: accessors.setter},
    accessors.derived === true,
  );
}

/**
 * The copy {@link withAccessors} and {@link withField} return: `schema` with
 * the given accessor names, and nothing else changed. Naming an accessor says
 * nothing about the domain, so the copy keeps the original's default,
 * equality and membership — the predicate by reference, so it keeps the
 * provenance `DERIVED_ACCEPTS` records: claiming it as derived here silenced
 * a caller's predicate on the copy *and*, the claim being keyed by function
 * identity, on the schema it came from.
 */
function named<T, Decls, In>(
  combinator: string,
  schema: SerializationSchema<T, never, In>,
  accessors: SchemaAccessors,
  derived: boolean = false,
): SerializationSchema<T, Decls, In> {
  undeclared(combinator, schema);
  // Not through `makeSchema`: that would claim the forwarded `accepts` as
  // derived (see `DERIVED_ACCEPTS`) and re-derive — and freeze — a default that
  // is `undefined`. Everything but the two names is the original's.
  return Object.assign((value: unknown) => schema(value), {
    accepts: schema.accepts,
    defaultValue: schema.defaultValue,
    ...(derived ? {derived: true as const} : {}),
    getter: accessors.getter,
    isEqual: schema.isEqual,
    meta: schema.meta,
    setter: accessors.setter,
  }) as SerializationSchema<T, Decls, In>;
}
