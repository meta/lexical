/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  AnySerializationSchema,
  Klass,
  LexicalNode,
  LexicalSchemaInput,
  SerializationSchemaMeta,
} from 'lexical';

import * as fc from 'fast-check';
// `declaredAccepts` is `@internal`, re-exported from the package entry the way
// `getComposedSchemaFields` is: a deep `lexical/src/*` import resolves only
// through this repo's tsconfig paths, so it does not build and would give a
// consumer a second copy of the module — and a second `DERIVED_ACCEPTS`, which
// is module-scope state the answer depends on.
import {declaredAccepts, getComposedSchemaFields} from 'lexical';

/**
 * Derive a fast-check arbitrary for the node-specific properties of `klass`'s
 * serialized JSON, composing the schemas it inherits
 * — so an element-based node generates the properties it gets from ElementNode
 * as well as its own. Spread the result with `type`/`version` to feed
 * `importJSON`. Because each property's schema is the same one the node uses
 * to parse its JSON, the generated values are exactly what the node's parser
 * accepts — a single declaration powers both parsing and example generation.
 *
 * Every property is generated independently as present or absent
 * (`requiredKeys: []`), because that is the domain the parsers actually face:
 * a `SerializedPartial` may omit any node-specific property — older documents
 * predate a property, and a compact export omits one whose value equals its
 * default. Generating complete records only would leave the defaulting path
 * (the whole point of a schema carrying a `defaultValue`) untested.
 *
 * The values are typed as what the class's schemas *accept*, composed across
 * its `$config` chain — not as what they parse to. The two differ wherever a
 * schema reads more than it writes, and this generator produces exactly that
 * difference: an `aliasedValue`'s legacy spellings are in the generated domain
 * (see the `aliased` case below), so a type describing the parsed output would
 * be wrong about the values it hands back.
 */
export function nodeArbitrary<T extends LexicalNode>(
  klass: Klass<T>,
): fc.Arbitrary<LexicalSchemaInput<T>> {
  const fields = getComposedSchemaFields(klass);
  const record: {[key: string]: fc.Arbitrary<unknown>} = {};
  for (const key of Object.keys(fields)) {
    record[key] = schemaArbitrary(fields[key]);
  }
  // Both sides now read the same `$config` chain — the value through
  // `getComposedSchemaFields`, the type through `LexicalSchemaInput` — so the
  // cast is asserting that two walks of one declaration agree. Where they can
  // still part company is a config that names no `extends`: the runtime walk
  // falls back to the prototype parent, the type walk has nothing to follow
  // and stops, and the type comes back missing the properties the value
  // carries. Naming `extends` is what keeps them together.
  //
  // What the cast is *not* covering is a flat NodeState: this generates the
  // JSON that carries one, and `LexicalSchemaInput` types those keys `unknown`
  // for the same reason `StateConfig.parse` takes `unknown` — nothing records
  // what a state accepted on the way in. It said `V` until recently, which the
  // cast would have asserted away: a `string`-to-`Date` state generated strings
  // that a caller could have read as dates.
  return fc.record(record, {requiredKeys: []}) as fc.Arbitrary<
    LexicalSchemaInput<T>
  >;
}

/**
 * The arbitrary for one schema: what its metadata describes, narrowed to what
 * the schema itself admits.
 *
 * The metadata describes what the *combinator* accepts, and a schema whose
 * author installed a membership predicate of its own admits less than that —
 * a `nullable(stringValue())` that takes only `#`-prefixed strings still
 * carries `nullable` metadata, so generating from the metadata alone produced
 * values it declines. A round-trip property then failed on values this claimed
 * were in domain, or passed while a sibling union member silently rewrote
 * them.
 *
 * Filtered rather than generated differently, because the predicate is an
 * opaque function: what it admits can only be discovered by asking it.
 */
function schemaArbitrary(
  schema: AnySerializationSchema,
): fc.Arbitrary<unknown> {
  const arbitrary = metaArbitrary(schema.meta);
  const accepts = declaredAccepts(schema);
  if (accepts === undefined) {
    return arbitrary;
  }
  const claims = (value: unknown) => accepts.call(schema, value);
  // `filter` retries without a cap, so a predicate the metadata's domain
  // cannot satisfy makes generation spin rather than fail — synchronously, so
  // a test runner's own timeout cannot interrupt it and nothing names the
  // property responsible. A `rawValue()` narrowed to strings is exactly that:
  // its metadata describes no domain, so `raw` generates `undefined` alone and
  // no draw is ever accepted. Probing first turns the hang into a diagnostic.
  //
  // Asked once per schema: the answer cannot change, and this recurses, so a
  // node with five narrowed properties otherwise burned five thousand
  // discarded draws every time its arbitrary was built.
  let satisfiable = SATISFIABLE.get(schema);
  if (satisfiable === undefined) {
    satisfiable = fc
      .sample(arbitrary, {numRuns: FILTER_PROBE_RUNS, seed: 0})
      .some(claims);
    SATISFIABLE.set(schema, satisfiable);
  }
  if (!satisfiable) {
    throw new Error(
      `nodeArbitrary: a schema of kind ${String(
        schema.meta.kind,
      )} declares a membership predicate that rejected all ${FILTER_PROBE_RUNS} values its metadata generates, so no example can be drawn for it. Widen the predicate, or describe the narrowed domain in the schema's metadata.`,
    );
  }
  return arbitrary.filter(claims);
}

/**
 * Whether a schema's declared predicate can be satisfied over its metadata's
 * domain — a property of the schema alone, so it is asked once, the same
 * reason the core memoizes `$isCatchAll`.
 */
const SATISFIABLE = new WeakMap<AnySerializationSchema, boolean>();

/**
 * How many draws {@link schemaArbitrary} tries before calling a declared
 * predicate unsatisfiable over its metadata's domain. Large enough that a
 * predicate accepting a reasonable fraction is never mistaken for one that
 * accepts nothing, small enough to cost nothing next to a property run.
 */
const FILTER_PROBE_RUNS = 1000;

function metaArbitrary(meta: SerializationSchemaMeta): fc.Arbitrary<unknown> {
  switch (meta.kind) {
    case 'string':
      return fc.string();
    case 'number': {
      const {min, max, integer} = meta;
      if (!integer) {
        return fc.double({max, min, noDefaultInfinity: true, noNaN: true});
      }
      // `fc.integer` takes an integral interval within the safe integers, and
      // `numberValue` accepts a domain that is neither: an absent bound is
      // unbounded, where fc.integer's own absent bound is the 32-bit range —
      // so a domain starting past 2^31 - 1 arrived as a maximum below its own
      // minimum and threw instead of generating.
      //
      // Clamping to the safe integers is what keeps the values exact: past
      // 2^53 the integers are no longer adjacent — `1e16 + 1 === 1e16` — so
      // generating there would produce values the schema's own `Number
      // .isInteger` test cannot distinguish. The rounding is belt and braces:
      // `numberValue` already rounds an integer domain's bounds inward, so a
      // fractional one reaches here only from a meta built by hand.
      const low = Math.max(
        min === undefined ? Number.MIN_SAFE_INTEGER : Math.ceil(min),
        Number.MIN_SAFE_INTEGER,
      );
      const high = Math.min(
        max === undefined ? Number.MAX_SAFE_INTEGER : Math.floor(max),
        Number.MAX_SAFE_INTEGER,
      );
      if (low <= high) {
        return fc.integer({max: high, min: low});
      }
      // Nothing survived: the domain lies entirely outside the safe integers
      // (`{integer: true, min: 1e16}`), or holds no integer at all
      // (`{integer: true, min: 0.5, max: 0.7}`) — which `numberValue` refuses
      // to build, so it arrives only from a meta written by hand. Its own
      // rounded bound is the closest thing to a member it has: in domain for
      // the first, and for the second parsed back to the schema's default,
      // which is what every value of an empty domain does.
      return fc.constant(min === undefined ? high : Math.ceil(min));
    }
    case 'boolean':
      return fc.boolean();
    case 'enum':
      return fc.constantFrom(...meta.values);
    case 'array':
      return fc.array(schemaArbitrary(meta.item));
    case 'set':
      // An `arraySetValue` reads any array of its items, in any order and
      // with duplicates, so that is the input domain. It is only ever the
      // whole value of a NodeState, never part of a node schema.
      return fc.array(schemaArbitrary(meta.item));
    case 'nullable':
      return fc.option(schemaArbitrary(meta.inner), {nil: null});
    case 'optional':
      return fc.option(schemaArbitrary(meta.inner), {nil: undefined});
    case 'union':
      return fc.oneof(...meta.members.map(member => schemaArbitrary(member)));
    case 'aliased': {
      // The aliases are legacy input spellings the schema still accepts, so
      // they belong in the generated domain exactly as much as the inner one
      // does — that is what makes them worth stating as data.
      const inner = schemaArbitrary(meta.inner);
      const aliases = Object.keys(meta.aliases);
      // `fc.constantFrom()` with nothing to choose from throws, so a schema
      // that declares no alias generates its inner domain alone — which is
      // what it accepts. An empty table parses fine, so it must generate fine.
      return aliases.length === 0
        ? inner
        : fc.oneof(inner, fc.constantFrom(...aliases));
    }
    case 'transform':
      // What is generated here is serialized *input*, and a transform changes
      // only the output, so the domain to draw from is the inner one — the
      // same answer inheriting the inner meta used to give, now reached
      // deliberately rather than by the transform being invisible.
      return schemaArbitrary(meta.inner);
    case 'raw':
      // The schema deliberately does not describe this value's domain (its
      // owner validates it), so there is nothing to generate from.
      return fc.constant(undefined);
    case 'object': {
      const fields: {[key: string]: fc.Arbitrary<unknown>} = {};
      for (const key of Object.keys(meta.fields)) {
        fields[key] = schemaArbitrary(meta.fields[key]);
      }
      return fc.record(fields);
    }
    default:
      // Unreachable for the schemas `lexical` defines — the switch is
      // exhaustive over SerializationSchemaMeta — but a hand-rolled schema
      // (or one from a newer core) can carry a kind this build has never
      // heard of. Say so, rather than returning undefined and failing inside
      // fast-check's record builder.
      throw new Error(
        `nodeArbitrary: unsupported serialization schema kind ${String(
          (meta as {kind?: unknown}).kind,
        )}`,
      );
  }
}
