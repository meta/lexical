/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import devInvariant from '@lexical/internal/devInvariant';
import {
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type AnyStateConfig,
  createEditor,
  createSharedNodeState,
  ElementNode,
  getComposedSchemaFields,
  getDeclaredNodeStructure,
  getDeclaredSlots,
  getStaticNodeConfig,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  TEXT_TYPE_TO_FORMAT,
  type TextNode,
} from 'lexical';

import {
  NESTED_FALLBACK_WARNING,
  noteOnce,
  UNSYNCED_VALUE_WARNING,
  type YNestedFallbackData,
} from './Warnings';

// What each Lexical node class is to the binding, and how node properties
// become Yjs attributes and formats: the storage kind derived from what a
// class declares in $config (line, format, group or nested node), the
// document's pins, the specs of lines, groups and wrappers, and the
// encodings of fields, NodeState, text and wrappers.
//
// Invariant: a class's storage kind is a function of its declarations, and a
// document keeps the kind it first recorded for a type (see withPins). Why:
// every client stores and reads a type the same way; a later client whose
// class derives another kind reads the document as written, or opens it read
// only.

export type Attrs = Record<string, unknown>;

/** Name of a line marker child. */
export const MARKER = '\u00b6';
/** Name of the terminator of inline content that belongs to a container. */
export const RUN_END = '\u00a6';
/** Name prefix of a child node that is a unit of its container. */
export const BLOCK_PREFIX = 'b:';
/** Name prefix of a child node inside inline content. */
export const INLINE_PREFIX = 'i:';

export {LAYOUT_PREFIX, LAYOUT_VERSION} from './constants';
/** Container attribute: 'b' when it holds blocks, 'i' when inline content. */
export const KIND_KEY = 'c';

// Marker keys
export const TYPE_KEY = 't';

/**
 * A stored node's type: its name's (`b:<type>` / `i:<type>`, fixed when it
 * was created), or `t` when the node was replaced in place by a node of
 * another type (the shared node and its content are kept).
 */
export function storedTypeOf(y: {
  name: unknown;
  getAttr: (k: string) => unknown;
}): string {
  const t = y.getAttr(TYPE_KEY);
  return typeof t === 'string' ? t : String(y.name).slice(2);
}
export const GROUP_KEY = 'g';
export const GROUP_FIELD_PREFIX = 'g:';
export const LEVEL_KEY = 'l';
/**
 * The key fields of the outer groups of a nested group item (level > 0):
 * one array of key-field values per outer level, outermost first. An outer
 * group holding only nested items has no item of its own to carry its key.
 */
export const OUTER_KEY = 'o';
// Property keys (markers, nodes, text)
export const FIELD_PREFIX = 'p:';
export const STATE_PREFIX = 's:';
// Text format keys
export const TEXT_FORMAT_PREFIX = 'f:';
export const SEGMENT_KEY = 'k';
export const WRAPPER_PREFIX = 'w:';

/**
 * The family of a format key: the keys whose items together give content
 * one attribute, which the write cursor bounds and keeps at boundaries as
 * one (see Cursor#format). A set-valued state's
 * member entries (`s:<key>\u001f<member>`, see setMemberEntry) are the
 * family of the set's key (`s:<key>`), with an array an earlier build
 * stored whole under that key (see joinSetMembers): together they give
 * content the set. Every other key is a family of its own.
 */
export function formatFamily(key: string): string {
  if (key.startsWith(STATE_PREFIX)) {
    const separator = key.indexOf(SET_MEMBER_SEPARATOR, STATE_PREFIX.length);
    if (separator >= 0) {
      return key.slice(0, separator);
    }
  }
  return key;
}

/** Whether `obj` has an own property `key`. */
export const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

/** `T` without `K`, per member of a union. */
type OmitEach<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * The class being derived falls back to nested storage: reported to the
 * editor's `onWarn` by a binding, once per class and reason (see noteOnce).
 */
function warnOnce(
  message: string,
  detail: OmitEach<YNestedFallbackData, 'type'>,
): void {
  // The innermost class being derived.
  let klass: Klass<LexicalNode> | undefined;
  for (const k of deriving) {
    klass = k;
  }
  let type = '';
  if (klass !== undefined) {
    try {
      type = klass.getType();
    } catch (_e) {
      type = klass.name;
    }
  }
  noteOnce(NESTED_FALLBACK_WARNING, `${type}: ${message}`, {
    ...detail,
    type,
  } as YNestedFallbackData);
}

export const klassOf = (node: LexicalNode) =>
  node.constructor as Klass<LexicalNode>;

// ---------------------------------------------------------------------------
// Schema completeness

/**
 * Whether a class wrote its own afterCloneFrom. Lexical synthesizes one for
 * every class whose $config declares fields (it copies those fields) and
 * marks it, as core's own declaresOwnAfterCloneFrom checks.
 */
function ownsHandWrittenAfterCloneFrom(k: Klass<LexicalNode>): boolean {
  if (!hasOwn(k.prototype, 'afterCloneFrom')) {
    return false;
  }
  const own = (k.prototype as unknown as {afterCloneFrom?: unknown})
    .afterCloneFrom as {__lexicalSynthesizedAfterCloneFrom?: true} | undefined;
  return own === undefined || own.__lexicalSynthesizedAfterCloneFrom !== true;
}

/**
 * Whether everything a node of `klass` holds is in its serialization schema
 * and NodeState, which is all a marker or a format stores. Every class from
 * `klass` up to (excluding) the class that declares the hint must declare its
 * own `$config()` and must not hand-write `exportJSON`, `updateFromJSON` or
 * `afterCloneFrom` (each can carry properties the schema does not describe).
 * The declaring class itself is trusted: the hint is its author's statement.
 */
function isSchemaComplete(
  klass: Klass<LexicalNode>,
  declares: (k: Klass<LexicalNode>) => boolean,
): boolean {
  for (
    let k: Klass<LexicalNode> | null = klass;
    k !== null &&
    k !== ElementNode &&
    k !== (Object.getPrototypeOf(ElementNode) as Klass<LexicalNode>);
    k = Object.getPrototypeOf(k) as Klass<LexicalNode> | null
  ) {
    if (declares(k)) {
      return k === klass || !hasUndeclaredFields(klass, k);
    }
    const config = getStaticNodeConfig(k);
    if (
      !config.declaresOwnConfig ||
      hasOwn(k.prototype, 'exportJSON') ||
      hasOwn(k.prototype, 'updateFromJSON') ||
      ownsHandWrittenAfterCloneFrom(k)
    ) {
      return false;
    }
  }
  return false;
}

/**
 * Whether instances of `klass` carry own properties (`__name`) that neither
 * `declaring` (the class with the collab declaration) nor `klass`'s schema
 * declares: a subclass with its own $config and an extra property outside it
 * would lose that property silently in a line or a format.
 */
function hasUndeclaredFields(
  klass: Klass<LexicalNode>,
  declaring: Klass<LexicalNode>,
): boolean {
  let found = false;
  try {
    const probe = createEditor({
      namespace: '@lexical/y schema probe',
      nodes: [klass, declaring],
      onError: () => {},
    });
    probe.update(
      () => {
        const sub = new klass();
        const base = new declaring();
        const known = new Set(Object.keys(base));
        for (const f of Object.keys(getComposedSchemaFields(klass))) {
          known.add('__' + f);
        }
        const extra = Object.keys(sub).filter(
          k => k.startsWith('__') && !known.has(k),
        );
        if (extra.length > 0) {
          found = true;
          warnOnce(
            `properties outside its $config() schema (${extra.join(', ')}) are not serialized`,
            {properties: extra, reason: 'undeclared-properties'},
          );
        }
      },
      {discrete: true},
    );
  } catch (_e) {
    // A class that cannot be built without arguments: not checked.
    return false;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Storage derivation
//
// Storage is derived from general facts the classes declare in $config()
// (`inline`, `children`, `mergeAdjacent`, `derived`), with one fixed rule,
// first match wins:
//
// - block + `children: 'inline'` -> line;
// - inline + `mergeAdjacent` -> format;
// - block + `children: [classes]` whose classes all derive as lines, +
//   `mergeAdjacent` -> group ("a line holding its own group", a list item
//   holding a list, is the only nesting allowed);
// - otherwise -> nested.
//
// Any of the first three also needs the class's data to be fully in its
// schema and NodeState (schema completeness), otherwise nested with a dev
// warning.

/** @experimental How `@lexical/y` stores an element type; see `describeStorage`. */
export type StorageKind = 'line' | 'format' | 'group' | 'nested';

const isElementKlass = (k: Klass<LexicalNode>): boolean =>
  k.prototype instanceof ElementNode;

/** Whether instances of an element class are inline (class-level). */
function isInlineKlass(klass: Klass<LexicalNode>): boolean {
  const declared = getDeclaredNodeStructure(klass).inline;
  if (declared !== undefined) {
    return declared;
  }
  const proto = klass.prototype as {isInline?: () => boolean};
  if (proto.isInline === ElementNode.prototype.isInline) {
    return false;
  }
  try {
    return proto.isInline!.call(Object.create(klass.prototype)) === true;
  } catch (_e) {
    return false;
  }
}

const declaresKey =
  (key: 'children' | 'mergeAdjacent') =>
  (klass: Klass<LexicalNode>) =>
  (k: Klass<LexicalNode>): boolean =>
    getDeclaredNodeStructure(klass).declaredBy[key] === k;

/** A group candidate by shape: lists classes only, and merges. */
function isGroupShape(klass: Klass<LexicalNode>): boolean {
  const d = getDeclaredNodeStructure(klass);
  return (
    isElementKlass(klass) &&
    !isInlineKlass(klass) &&
    Array.isArray(d.children) &&
    d.children.length > 0 &&
    !d.children.includes('inline') &&
    d.mergeAdjacent !== undefined
  );
}

const subclassOf = (k: Klass<LexicalNode>, base: Klass<LexicalNode>) =>
  k === base || k.prototype instanceof base;

/** Children that make a block a line: inline content, plus its own groups. */
function lineChildren(klass: Klass<LexicalNode>): boolean {
  const children = getDeclaredNodeStructure(klass).children;
  if (children === 'inline') {
    return true;
  }
  if (!Array.isArray(children) || !children.includes('inline')) {
    return false;
  }
  return children.every(
    e =>
      e === 'inline' ||
      (isGroupShape(e as Klass<LexicalNode>) &&
        (
          getDeclaredNodeStructure(e as Klass<LexicalNode>)
            .children as readonly unknown[]
        ).some(
          i =>
            typeof i === 'function' &&
            subclassOf(klass, i as Klass<LexicalNode>),
        )),
  );
}

/**
 * Lexical classes whose merge is decided by an overridable method, by the
 * type of the class that declares `mergeAdjacent` (whose `by` names what the
 * method compares).
 */
const MERGE_METHODS: Readonly<Record<string, string>> = {
  link: 'shouldMergeAdjacentLink',
};

/** The merge rule of a format class is declarative (no method override). */
function hasDeclarativeMerge(klass: Klass<LexicalNode>): boolean {
  const d = getDeclaredNodeStructure(klass);
  const config = d.mergeAdjacent;
  const declaring = d.declaredBy.mergeAdjacent;
  if (config === undefined || declaring === undefined) {
    return false;
  }
  const declaringType = getStaticNodeConfig(declaring).ownNodeType;
  const method =
    typeof declaringType === 'string' &&
    Object.prototype.hasOwnProperty.call(MERGE_METHODS, declaringType)
      ? MERGE_METHODS[declaringType]
      : undefined;
  if (method !== undefined) {
    const own = (klass.prototype as unknown as Record<string, unknown>)[method];
    const declared = (
      declaring.prototype as unknown as Record<string, unknown>
    )[method];
    if (own !== declared) {
      warnOnce(`overrides ${method}: stored as a nested node`, {
        method,
        reason: 'merge-override',
      });
      return false;
    }
  }
  return true;
}

const derivedKinds = new WeakMap<Klass<LexicalNode>, StorageKind>();
const deriving = new Set<Klass<LexicalNode>>();

/**
 * The storage a class derives from its declarations (see above). Depends on
 * the class only; a document may pin another kind (see the binding's pins).
 */
export function deriveStorageKind(klass: Klass<LexicalNode>): StorageKind {
  let kind = derivedKinds.get(klass);
  if (kind !== undefined) {
    return kind;
  }
  if (deriving.has(klass)) {
    return 'nested';
  }
  deriving.add(klass);
  try {
    kind = deriveUncached(klass);
  } finally {
    deriving.delete(klass);
  }
  derivedKinds.set(klass, kind);
  return kind;
}

function deriveUncached(klass: Klass<LexicalNode>): StorageKind {
  if (!isElementKlass(klass)) {
    return 'nested';
  }
  const d = getDeclaredNodeStructure(klass);
  const inline = isInlineKlass(klass);
  const slots = getDeclaredSlots(klass).length > 0;
  if (!inline && lineChildren(klass)) {
    if (slots) {
      warnOnce(
        'holds inline content and declares slots: stored as a nested node',
        {
          reason: 'inline-slots',
        },
      );
      return 'nested';
    }
    if (!isSchemaComplete(klass, declaresKey('children')(klass))) {
      warnOnce(
        'holds inline content and is not schema-complete: stored as a nested node',
        {reason: 'inline-incomplete-schema'},
      );
      return 'nested';
    }
    return 'line';
  }
  if (inline && d.mergeAdjacent !== undefined && hasDeclarativeMerge(klass)) {
    const type = getStaticNodeConfig(klass).ownNodeType;
    if (typeof type === 'string' && type.includes(':')) {
      warnOnce('the type contains ":": stored as a nested node', {
        reason: 'type-name',
      });
      return 'nested';
    }
    if (!isSchemaComplete(klass, declaresKey('mergeAdjacent')(klass))) {
      warnOnce(
        'merges adjacent siblings and is not schema-complete: stored as a nested node',
        {reason: 'merge-incomplete-schema'},
      );
      return 'nested';
    }
    if (slots) {
      warnOnce(
        'merges adjacent siblings and declares slots: stored as a nested node',
        {reason: 'merge-slots'},
      );
      return 'nested';
    }
    return 'format';
  }
  if (isGroupShape(klass)) {
    const items = (d.children as readonly Klass<LexicalNode>[]).slice();
    if (items.some(i => deriveStorageKind(i) !== 'line')) {
      warnOnce(
        'not all its children are stored as lines: stored as a nested node',
        {reason: 'group-children'},
      );
      return 'nested';
    }
    if (d.mergeAdjacent!.by.some(e => typeof e !== 'string')) {
      warnOnce('merges by NodeState: stored as a nested node', {
        reason: 'group-state-merge',
      });
      return 'nested';
    }
    if (slots || !isSchemaComplete(klass, declaresKey('children')(klass))) {
      warnOnce(
        'a group that is not schema-complete or declares slots: stored as a nested node',
        {reason: 'group-incomplete-schema'},
      );
      return 'nested';
    }
    return 'group';
  }
  return 'nested';
}

// ---------------------------------------------------------------------------
// Document pins
//
// The first write of a type records its kind (and a group's or format's
// identity fields) in the document. A later client whose class derives
// differently uses the recorded kind when its class can be read that way,
// and opens read only otherwise (the existing gate).

/** Root attribute prefix of a type's recorded storage kind. */
export const PIN_PREFIX = 'k:';

export type Pin = {readonly kind: StorageKind; readonly by?: readonly string[]};

let activePins: ReadonlyMap<string, Pin> | null = null;

/** Run `fn` with a document's pins in effect (re-entrant). */
export function withPins<T>(
  pins: ReadonlyMap<string, Pin> | null,
  fn: () => T,
): T {
  const prev = activePins;
  activePins = pins;
  try {
    return fn();
  } finally {
    activePins = prev;
  }
}

/**
 * Whether every class from `klass` up to ElementNode declares its own
 * $config() and hand-writes no exportJSON/updateFromJSON/afterCloneFrom.
 */
function isOwnSchemaComplete(klass: Klass<LexicalNode>): boolean {
  for (
    let k: Klass<LexicalNode> | null = klass;
    k !== null && k !== ElementNode;
    k = Object.getPrototypeOf(k) as Klass<LexicalNode> | null
  ) {
    const config = getStaticNodeConfig(k);
    if (
      !config.declaresOwnConfig ||
      hasOwn(k.prototype, 'exportJSON') ||
      hasOwn(k.prototype, 'updateFromJSON') ||
      ownsHandWrittenAfterCloneFrom(k)
    ) {
      return false;
    }
  }
  return true;
}

/** Whether a class can be read and written with `kind`. */
export function canStoreAs(
  klass: Klass<LexicalNode>,
  kind: StorageKind,
): boolean {
  if (kind === 'nested' || deriveStorageKind(klass) === kind) {
    return true;
  }
  if (!isElementKlass(klass) || getDeclaredSlots(klass).length > 0) {
    return false;
  }
  const inline = isInlineKlass(klass);
  const complete = isOwnSchemaComplete(klass);
  const children = getDeclaredNodeStructure(klass).children;
  if (kind === 'line') {
    // A block whose content may be inline (undeclared, or declared so).
    return (
      !inline && complete && (children === undefined || lineChildren(klass))
    );
  }
  if (kind === 'format') {
    return (
      inline && complete && (children === undefined || children === 'inline')
    );
  }
  return false;
}

/** The kind a class is stored with in the active document. */
export function storageKindOf(klass: Klass<LexicalNode>): StorageKind {
  const derived = deriveStorageKind(klass);
  if (activePins === null) {
    return derived;
  }
  const type = getStaticNodeConfig(klass).ownNodeType;
  const pin = typeof type === 'string' ? activePins.get(type) : undefined;
  if (
    pin === undefined ||
    pin.kind === derived ||
    !canStoreAs(klass, pin.kind)
  ) {
    return derived;
  }
  return pin.kind;
}

/** The identity fields a pin records for a class (groups and formats). */
export function identityOf(klass: Klass<LexicalNode>): readonly string[] {
  const config = getDeclaredNodeStructure(klass).mergeAdjacent;
  return config === undefined
    ? []
    : config.by.map(e => (typeof e === 'string' ? e : '$' + String(e.key)));
}

/** Items' fields Lexical recomputes (and that are not stored). */
function derivedFieldsOf(klasses: readonly Klass<LexicalNode>[]): Set<string> {
  const out = new Set<string>();
  for (const k of klasses) {
    for (const f of Object.keys(getComposedSchemaFields(k))) {
      if (getDeclaredNodeStructure(k).derived.has(f)) {
        out.add(f);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Specs

type LineSpec = {readonly fields: ReadonlySet<string>};
export type GroupSpec = {
  readonly klass: Klass<LexicalNode>;
  readonly items: readonly Klass<LexicalNode>[];
  readonly key: readonly string[];
  readonly nested: boolean;
  readonly derived: ReadonlySet<string>;
};
type WrapperSpec = {readonly fields: ReadonlySet<string>};

const lineSpecs = new WeakMap<Klass<LexicalNode>, LineSpec>();
const groupSpecs = new WeakMap<Klass<LexicalNode>, GroupSpec | null>();
const wrapperSpecs = new WeakMap<Klass<LexicalNode>, WrapperSpec>();

export function getLineSpec(klass: Klass<LexicalNode>): LineSpec | null {
  if (storageKindOf(klass) !== 'line') {
    return null;
  }
  let spec = lineSpecs.get(klass);
  if (spec === undefined) {
    spec = {fields: schemaFieldsOf(klass)};
    lineSpecs.set(klass, spec);
  }
  return spec;
}

/** A group spec by shape (whether or not the class is stored as a group). */
function groupSpecByShape(klass: Klass<LexicalNode>): GroupSpec | null {
  let spec = groupSpecs.get(klass);
  if (spec === undefined) {
    spec = null;
    if (isGroupShape(klass)) {
      const d = getDeclaredNodeStructure(klass);
      const items = (d.children as readonly Klass<LexicalNode>[]).slice();
      spec = {
        derived: derivedFieldsOf([klass, ...items]),
        items,
        key: identityOf(klass),
        klass,
        // A line holding its own group: an item may be a nesting level.
        nested: items.some(i => {
          const c = getDeclaredNodeStructure(i).children;
          return (
            Array.isArray(c) &&
            c.some(
              e => e !== 'inline' && subclassOf(klass, e as Klass<LexicalNode>),
            )
          );
        }),
      };
    }
    groupSpecs.set(klass, spec);
  }
  return spec;
}

/**
 * The group declaration of a class stored as a node (a subclass that is not
 * schema-complete): its children are already the group's items, so readers
 * must not wrap them in another group.
 */
export function getContainerGroupSpec(
  klass: Klass<LexicalNode>,
): GroupSpec | null {
  return groupSpecByShape(klass);
}

export function getGroupSpec(klass: Klass<LexicalNode>): GroupSpec | null {
  return storageKindOf(klass) === 'group' ? groupSpecByShape(klass) : null;
}

/** Whether a node is a group (a list). */
export function $isGroupNode(
  n: LexicalNode | null | undefined,
): n is ElementNode {
  return $isElementNode(n) && getGroupSpec(klassOf(n)) !== null;
}

let elementFields: ReadonlySet<string> | undefined;
const getElementFieldNames = (): ReadonlySet<string> => {
  if (elementFields === undefined) {
    elementFields = new Set(Object.keys(getComposedSchemaFields(ElementNode)));
  }
  return elementFields;
};

export function getWrapperSpec(klass: Klass<LexicalNode>): WrapperSpec | null {
  if (storageKindOf(klass) !== 'format') {
    return null;
  }
  let spec = wrapperSpecs.get(klass);
  if (spec === undefined) {
    const base = getElementFieldNames();
    spec = {
      fields: new Set(
        Object.keys(getComposedSchemaFields(klass)).filter(f => !base.has(f)),
      ),
    };
    wrapperSpecs.set(klass, spec);
  }
  return spec;
}

/** An inline element stored as formats over the content it wraps. */
export function $isWrapper(node: LexicalNode | null): boolean {
  return (
    node !== null &&
    $isElementNode(node) &&
    node.isInline() &&
    getWrapperSpec(klassOf(node)) !== null
  );
}

export function $isLine(node: LexicalNode | null): node is ElementNode {
  return (
    node !== null &&
    $isElementNode(node) &&
    !node.isInline() &&
    getLineSpec(klassOf(node)) !== null
  );
}

/** A group node whose children are all items (or nesting levels). */
export function $isGroup(node: LexicalNode | null): node is ElementNode {
  if (node === null || !$isElementNode(node) || node.isInline()) {
    return false;
  }
  const spec = getGroupSpec(klassOf(node));
  if (spec === null) {
    return false;
  }
  let c = node.getFirstChild();
  if (c === null) {
    return false;
  }
  for (; c !== null; c = c.getNextSibling()) {
    if (!spec.items.includes(klassOf(c)) || !$isLine(c)) {
      return false;
    }
  }
  return true;
}

/** The group an item holds when it only is a nesting level. */
export function $nestedGroupOf(
  item: LexicalNode,
  spec: GroupSpec,
): ElementNode | null {
  if (!spec.nested || !$isElementNode(item)) {
    return null;
  }
  const first = item.getFirstChild();
  return first !== null &&
    first === item.getLastChild() &&
    $isElementNode(first) &&
    klassOf(first) === spec.klass &&
    $isGroup(first)
    ? first
    : null;
}

export const $isInlineChild = (n: LexicalNode): boolean =>
  $isTextNode(n) || $isLineBreakNode(n) || n.isInline();

// ---------------------------------------------------------------------------
// Values

/**
 * `v` as plain JSON, as JSON.stringify would write it (object members that
 * are undefined are left out, array entries that are undefined become null),
 * or undefined when it is not JSON (a class instance such as a nested
 * editor, a function, a non-finite number, a cycle).
 */
const toPlainJSON = (v: unknown, depth = 0): unknown => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }
  if (depth > 32 || typeof v !== 'object') {
    return undefined;
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) {
      if (x === undefined) {
        out.push(null);
        continue;
      }
      const y = toPlainJSON(x, depth + 1);
      if (y === undefined) {
        return undefined;
      }
      out.push(y);
    }
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    return undefined;
  }
  const out: Attrs = {};
  for (const k of Object.keys(v as Attrs)) {
    const x = (v as Attrs)[k];
    if (x === undefined) {
      continue;
    }
    const y = toPlainJSON(x, depth + 1);
    if (y === undefined) {
      return undefined;
    }
    out[k] = y;
  }
  return out;
};

export const isUnsafeKey = (key: string) =>
  key === '__proto__' || key === 'constructor' || key === 'prototype';

export const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map(k => [k, v[k]]),
        )
      : v,
  );

export const equalValue = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null &&
    stableStringify(a) === stableStringify(b));

/**
 * Format values are compared one level deep by Yjs, so a value that is not
 * a primitive is stored as `{json: '<stable JSON>'}`.
 */
const encodeFormatValue = (v: unknown): unknown =>
  v === null || typeof v !== 'object' ? v : {json: stableStringify(v)};

export const decodeFormatValue = (v: unknown): unknown => {
  if (v !== null && typeof v === 'object') {
    const json = (v as Attrs).json;
    if (typeof json === 'string') {
      try {
        return JSON.parse(json);
      } catch (_e) {
        return null;
      }
    }
  }
  return v;
};

/** Format attributes of a line break: its NodeState. */
export function $lineBreakAttrs(
  node: LexicalNode,
  wrapperAttrs: Attrs,
  strict = true,
): Attrs {
  const own: Attrs = {};
  $stateAttrs(node, own, '', true, strict);
  return {...wrapperAttrs, ...encodeFormats(own)};
}

/** The NodeState a line break's format attributes give it. */
export function lineBreakStateFromAttrs(encoded: Attrs): Attrs {
  const state: Attrs = {};
  for (const k of Object.keys(encoded).sort()) {
    if (k.startsWith(STATE_PREFIX)) {
      const f = k.slice(STATE_PREFIX.length);
      if (!isUnsafeKey(f)) {
        state[f] = decodeFormatValue(encoded[k]);
      }
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Set-valued NodeState

/**
 * Between a set-valued state's key and a member in the key of a member
 * entry: `<key>\u001f<member>` = `true`.
 */
export const SET_MEMBER_SEPARATOR = '\u001f';

/** Whether `s` holds a surrogate code unit that is not half of a pair. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++;
    }
  }
  return false;
}

/**
 * The name of a set member's entry: the set's key, U+001F and the member.
 * Yjs stores names as UTF-8, which turns a lone surrogate (a code unit from
 * U+D800 to U+DFFF that is not half of a pair) into U+FFFD, so two members
 * that differ only there would be one. A member holding a lone surrogate is
 * stored escaped instead: U+001F, then the member's JSON with every
 * surrogate code unit written as a `\uXXXX` escape (ASCII). A member that
 * starts with U+001F is escaped the same way, so that every name reads back
 * as the member it was written for (see setMemberOfEntry).
 */
export function setMemberEntry(key: string, member: string): string {
  if (member.charAt(0) !== SET_MEMBER_SEPARATOR && !hasLoneSurrogate(member)) {
    return key + SET_MEMBER_SEPARATOR + member;
  }
  const escaped = JSON.stringify(member).replace(
    /[\ud800-\udfff]/g,
    unit => '\\u' + unit.charCodeAt(0).toString(16),
  );
  return key + SET_MEMBER_SEPARATOR + SET_MEMBER_SEPARATOR + escaped;
}

/**
 * The member a member entry's name stores, given what follows the set's key
 * and U+001F in it (see setMemberEntry).
 */
function setMemberOfEntry(stored: string): string {
  if (stored.charAt(0) === SET_MEMBER_SEPARATOR) {
    try {
      const member: unknown = JSON.parse(stored.slice(1));
      if (typeof member === 'string') {
        return member;
      }
    } catch (_e) {
      // Not escaped: the member itself.
    }
  }
  return stored;
}

/**
 * Whether a stored format or attribute name is a member entry (`s:`, then a
 * key and U+001F): what a document that has one needs layout
 * SET_MEMBERS_LAYOUT_VERSION for.
 */
export function isSetMemberEntryName(name: string): boolean {
  return (
    name.startsWith(STATE_PREFIX) &&
    name.indexOf(SET_MEMBER_SEPARATOR, STATE_PREFIX.length) >= 0
  );
}

/**
 * The keys of sets no StateConfig knows that the reader joined from member
 * entries, per node type of an editor (its shared node state): the writer
 * stores an array under such a key one entry per member again, whatever
 * object holds it (a JSON copy of a node's state too), so a semantic no-op
 * writes nothing and a change writes only the members it adds or removes.
 */
const LEARNED_SETS = new WeakMap<object, Set<string>>();

/** The learned set keys of a node type's shared node state (see LEARNED_SETS). */
export function learnedSetKeys(sharedNodeState: object): Set<string> {
  let keys = LEARNED_SETS.get(sharedNodeState);
  if (keys === undefined) {
    keys = new Set();
    LEARNED_SETS.set(sharedNodeState, keys);
  }
  return keys;
}

/**
 * Whether a StateConfig holds a set (its parse is `arraySetValue(...)`),
 * which is stored one entry per member on text runs, line breaks and nodes
 * stored as their own Y.Node, so that concurrent additions and removals of
 * different members merge. Elsewhere (markers, groups, wrappers) a set is one
 * value.
 */
export function isSetStateConfig(config: AnyStateConfig | undefined): boolean {
  return (
    config !== undefined &&
    config.schema !== undefined &&
    config.schema.meta.kind === 'set'
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

/**
 * The joined values of sets no StateConfig knows (see joinSetMembers), which
 * the writer stores one entry per member again.
 */
const UNKNOWN_SETS = new WeakSet<readonly string[]>();

/**
 * The NodeState entries of a node (its JSON `$`) to store, with every
 * set-valued state known for the node (used on it, or registered for its
 * type, as MarkStateExtension does) as one `<key>\u001f<member>` = `true`
 * entry per member. A set whose key contains the separator itself is stored
 * whole, since a reader could not tell where the key ends.
 *
 * Entries no StateConfig knows are written back as they are, except:
 * - the joined value of a set no StateConfig knows, which the reader keeps
 *   (see joinSetMembers): stored one entry per member again, as is any
 *   string array under the key of such a set the reader joined for this
 *   node type (see LEARNED_SETS), so that a copy of the value (a node's
 *   JSON loaded back) is stored the same way and an unchanged set writes
 *   nothing;
 * - member entries of a set that has become known since they were loaded
 *   (JSON exported by a client that did not know the state): the set's
 *   value replaces them when the node holds one.
 *
 * A StateConfig named like a member entry of a known set (its key, U+001F,
 * anything) would be stored under the same name as one of that set's
 * members, and readers that know it would drop that member. Such a pair is
 * refused whenever this node's set or that state is written, whether or not
 * the state holds a value: an invariant in development; in production a
 * warning, and the set is stored whole, as one value. Not `strict` (a reader
 * comparing a node with what is stored, which writes nothing): such a pair
 * is stored whole without a report.
 */
function $splitSetMembers(
  node: LexicalNode,
  entries: Attrs,
  strict = true,
): Attrs {
  const state = node.getLatest().__state;
  if (!state) {
    return entries;
  }
  const {sharedConfigMap} = state.sharedNodeState;
  const learned = LEARNED_SETS.get(state.sharedNodeState);
  const known = state.getInternalState()[1];
  const configOf = (key: string): AnyStateConfig | undefined => {
    const shared = sharedConfigMap.get(key);
    if (shared !== undefined) {
      return shared;
    }
    for (const config of known.keys()) {
      if (config.key === key) {
        return config;
      }
    }
    return undefined;
  };
  const isSetKey = (key: string): boolean => isSetStateConfig(configOf(key));
  // Whether the node holds a value for that set (a value equal to the
  // default, such as an empty set, is left out of `entries`).
  const holdsSet = (key: string): boolean => {
    if (key in entries) {
      return true;
    }
    for (const config of known.keys()) {
      if (config.key === key) {
        return true;
      }
    }
    return false;
  };
  // A known StateConfig named `<set>\u001f…`: the first one found.
  const collisionOf = (set: string): string | null => {
    const prefix = set + SET_MEMBER_SEPARATOR;
    for (const key of sharedConfigMap.keys()) {
      if (key.startsWith(prefix)) {
        return key;
      }
    }
    for (const config of known.keys()) {
      if (config.key.startsWith(prefix)) {
        return config.key;
      }
    }
    return null;
  };
  const refused = new Set<string>();
  const refuse = (key: string, set: string): void => {
    refused.add(set);
    if (!strict) {
      return;
    }
    devInvariant(
      false,
      '@lexical/y: the NodeState key %s has the name of a member entry of the set-valued state %s (its key, U+001F, a member); rename the state.',
      JSON.stringify(key),
      JSON.stringify(set),
    );
  };
  for (const key in entries) {
    const separator = key.indexOf(SET_MEMBER_SEPARATOR);
    if (separator >= 0) {
      const base = key.slice(0, separator);
      if (configOf(key) !== undefined && isSetKey(base)) {
        refuse(key, base);
      }
    }
  }
  for (const key in entries) {
    const value = entries[key];
    if (
      key.indexOf(SET_MEMBER_SEPARATOR) < 0 &&
      isStringArray(value) &&
      isSetKey(key)
    ) {
      const collision = collisionOf(key);
      if (collision !== null && !refused.has(key)) {
        refuse(collision, key);
      }
    }
  }
  let out: Attrs | null = null;
  const copyBefore = (key: string): Attrs => {
    const copy: Attrs = {};
    for (const k in entries) {
      if (k === key) {
        break;
      }
      copy[k] = entries[k];
    }
    return copy;
  };
  for (const key in entries) {
    const value = entries[key];
    const separator = key.indexOf(SET_MEMBER_SEPARATOR);
    const base = separator >= 0 ? key.slice(0, separator) : null;
    let replaced: Attrs | null = null;
    if (base === null) {
      if (
        isStringArray(value) &&
        !refused.has(key) &&
        (isSetKey(key) ||
          (configOf(key) === undefined &&
            (UNKNOWN_SETS.has(value) ||
              (learned !== undefined && learned.has(key)))))
      ) {
        replaced = {};
        for (const member of value) {
          replaced[setMemberEntry(key, member)] = true;
        }
      }
    } else if (
      configOf(key) === undefined &&
      isSetKey(base) &&
      holdsSet(base)
    ) {
      // A member entry read before the set was known: the set's value
      // replaces it.
      replaced = {};
    }
    if (replaced !== null) {
      if (out === null) {
        out = copyBefore(key);
      }
      Object.assign(out, replaced);
    } else if (out !== null) {
      out[key] = value;
    }
  }
  return out === null ? entries : out;
}

/**
 * The NodeState entries read from a text run, line break or node stored as
 * its own Y.Node, with the member entries (`<key>\u001f<member>` = `true`)
 * of each set joined back into one array under the set's key. When a
 * StateConfig uses the entry key itself, or the set's key is a StateConfig
 * that does not hold a set, an entry stays an ordinary key.
 *
 * - A set-valued state that `configs` (the reader's StateConfigs for the
 *   node type) knows: the state's parse turns the array into its canonical
 *   frozen array (sorted, without duplicates).
 * - A set no StateConfig knows yet: the array (sorted and frozen) is kept
 *   as an unknown entry, and the writer stores it one entry per member
 *   again, so a reader that does not know the state never collapses the
 *   members. A client that uses the state after it read the node (its
 *   first `$getState` registers it) reads the set from that entry.
 *
 * A whole array under the set's key next to member entries (stored by an
 * earlier `@lexical/y` build) is joined with them. An escaped member (see
 * setMemberEntry) reads back as the member it was written for. The key of
 * each set no StateConfig knows is added to `learned` (see LEARNED_SETS).
 */
export function joinSetMembers(
  entries: Attrs,
  configs: ReadonlyMap<string, AnyStateConfig> | undefined = new Map(),
  learned?: Set<string>,
): Attrs {
  // The set an entry is a member of, or null.
  const setOf = (key: string): string | null => {
    const i = key.indexOf(SET_MEMBER_SEPARATOR);
    if (i < 0 || entries[key] !== true || configs.has(key)) {
      return null;
    }
    // `i === 0` is a member of a set whose key is the empty string.
    const base = key.slice(0, i);
    const config = configs.get(base);
    if (config !== undefined) {
      return isSetStateConfig(config) ? base : null;
    }
    const whole = entries[base];
    return whole === undefined || isStringArray(whole) ? base : null;
  };
  let out: Attrs | null = null;
  const sets = new Map<string, string[]>();
  for (const key in entries) {
    const base = setOf(key);
    if (base === null) {
      if (out !== null) {
        out[key] = entries[key];
      }
      continue;
    }
    if (out === null) {
      out = {};
      for (const k in entries) {
        if (k === key) {
          break;
        }
        out[k] = entries[k];
      }
    }
    const members = sets.get(base) || [];
    members.push(setMemberOfEntry(key.slice(base.length + 1)));
    sets.set(base, members);
  }
  if (out === null) {
    return entries;
  }
  for (const [base, members] of sets) {
    const whole = entries[base];
    const list: string[] = isStringArray(whole) ? whole.slice() : [];
    for (const member of members) {
      if (!list.includes(member)) {
        list.push(member);
      }
    }
    if (configs.has(base)) {
      out[base] = list;
    } else {
      // Sorted, so that every reader holds the same value.
      const joined = Object.freeze(list.sort());
      UNKNOWN_SETS.add(joined);
      if (learned !== undefined) {
        learned.add(base);
      }
      out[base] = joined;
    }
  }
  return out;
}

/**
 * {@link joinSetMembers} on the NodeState of a node's serialized form, with
 * the StateConfigs `editor` knows for the node's type.
 */
export function joinSetMembersInJSON(
  json: Attrs,
  editor: LexicalEditor,
): Attrs {
  const state = json.$;
  if (state === null || typeof state !== 'object') {
    return json;
  }
  const info = editor._nodes.get(json.type as string);
  const joined = joinSetMembers(
    state as Attrs,
    info && info.sharedNodeState.sharedConfigMap,
    info && learnedSetKeys(info.sharedNodeState),
  );
  return joined === state ? json : {...json, $: joined};
}

function encodeFormats(attrs: Attrs): Attrs {
  for (const k in attrs) {
    attrs[k] = encodeFormatValue(attrs[k]);
  }
  return attrs;
}

function putValue(attrs: Attrs, key: string, value: unknown, what: string) {
  if (value === undefined) {
    return;
  }
  const plain = toPlainJSON(value);
  if (plain === undefined) {
    noteOnce(UNSYNCED_VALUE_WARNING, `${what} is not plain JSON`, {
      property: what,
      reason: 'not-json',
    });
    return;
  }
  attrs[key] = plain;
}

/**
 * NodeState entries as `s:<key>` attributes. With `split`, a set-valued state
 * is one entry per member (see $splitSetMembers, and `strict` there): for
 * line breaks.
 */
export function $stateAttrs(
  node: LexicalNode,
  out: Attrs,
  prefix = '',
  split = false,
  strict = true,
): void {
  const state = node.__state;
  if (!state) {
    return;
  }
  if (split) {
    const own: Attrs = {};
    $stateAttrs(node, own);
    const entries: Attrs = {};
    for (const k in own) {
      entries[k.slice(STATE_PREFIX.length)] = own[k];
    }
    const stored = $splitSetMembers(node, entries, strict);
    for (const k in stored) {
      out[prefix + STATE_PREFIX + k] = stored[k];
    }
    return;
  }
  const [unknown = {}, known] = state.getInternalState();
  // As NodeState#toJSON: a known value replaces an unknown one of its key
  // (read from JSON before the key's config was used), and a known value
  // at its default removes it.
  const knownKeys = new Set<string>();
  for (const [config] of known) {
    knownKeys.add(config.key);
  }
  for (const [k, v] of Object.entries(unknown)) {
    if (!knownKeys.has(k)) {
      putValue(out, prefix + STATE_PREFIX + k, v, `NodeState ${k}`);
    }
  }
  for (const [config, v] of known) {
    // A value reset to its default is not stored (as Lexical's JSON).
    if (config.isEqual(v, config.defaultValue)) {
      continue;
    }
    putValue(
      out,
      prefix + STATE_PREFIX + config.key,
      config.unparse(v),
      `NodeState ${config.key}`,
    );
  }
}

/**
 * The compact JSON the node's serialization schema writes (the base
 * LexicalNode.exportJSON, so an override does not change what is stored),
 * without NodeState.
 */
export function $schemaJSON(node: LexicalNode): Attrs {
  // ElementNode does not override exportJSON: this is LexicalNode's.
  const json = ElementNode.prototype.exportJSON.call(node, true) as Attrs;
  const state = node.__state ? node.__state.toJSON() : undefined;
  if (state !== undefined) {
    for (const key in state) {
      delete json[key];
    }
  }
  return json;
}

const STRUCTURAL_JSON_KEYS = new Set([
  'type',
  'version',
  'children',
  '$slots',
  '$',
]);

/**
 * Whether a value holds an array entry that is undefined (a hole, as
 * inserting a table column past its stored widths leaves in colWidths):
 * stored as null (see toPlainJSON), which a reader's parse can turn into
 * another value (TableNode's: 0).
 */
export function hasArrayHole(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== 'object' || depth > 32) {
    return false;
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      if (x === undefined || hasArrayHole(x, depth + 1)) {
        return true;
      }
    }
    return false;
  }
  for (const k of Object.keys(v as Attrs)) {
    if (hasArrayHole((v as Attrs)[k], depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Attributes of a node stored as its own Y.Node (a 'node' block, an inline
 * decorator or element): the class's own exportJSON, which is complete by
 * contract, split per key. `holes` gets the keys of values that hold an
 * array hole (see hasArrayHole).
 */
export function $nodeAttrs(
  node: LexicalNode,
  holes: string[] | null = null,
  strict = true,
): Attrs {
  const latest = node.getLatest();
  // Compact: properties at their default are left out (parsing restores
  // them); a hand-written exportJSON may ignore the flag, which is fine.
  const json = latest.exportJSON(true) as unknown as Attrs;
  const attrs: Attrs = {};
  for (const key in json) {
    if (!STRUCTURAL_JSON_KEYS.has(key)) {
      putValue(
        attrs,
        FIELD_PREFIX + key,
        json[key],
        `${node.getType()}.${key}`,
      );
      if (holes !== null && hasArrayHole(json[key])) {
        holes.push(FIELD_PREFIX + key);
      }
    }
  }
  const state = json.$ as Attrs | undefined;
  if (state) {
    const stored = $splitSetMembers(latest, state, strict);
    for (const k in stored) {
      putValue(attrs, STATE_PREFIX + k, stored[k], `NodeState ${k}`);
      if (holes !== null && hasArrayHole(stored[k])) {
        holes.push(STATE_PREFIX + k);
      }
    }
  }
  // An element's textFormat/textStyle are always stored (see $lineAttrs).
  if ($isElementNode(latest)) {
    const tf = latest.getTextFormat();
    const ts = latest.getTextStyle();
    if (tf !== 0) {
      attrs[FIELD_PREFIX + 'textFormat'] = tf;
    } else {
      delete attrs[FIELD_PREFIX + 'textFormat'];
    }
    if (ts !== '') {
      attrs[FIELD_PREFIX + 'textStyle'] = ts;
    } else {
      delete attrs[FIELD_PREFIX + 'textStyle'];
    }
  }
  return attrs;
}

/** The serialized form of a node stored with {@link $nodeAttrs}. */
export function nodeJSONFromAttrs(type: string, attrs: Attrs): Attrs {
  const json: Attrs = {type, version: 1};
  const state: Attrs = {};
  let hasState = false;
  // Sorted, so that every reader builds NodeState in the same key order.
  for (const key of Object.keys(attrs).sort()) {
    if (key.startsWith(FIELD_PREFIX)) {
      const f = key.slice(FIELD_PREFIX.length);
      if (!isUnsafeKey(f)) {
        json[f] = attrs[key];
      }
    } else if (key.startsWith(STATE_PREFIX)) {
      const f = key.slice(STATE_PREFIX.length);
      if (!isUnsafeKey(f)) {
        state[f] = attrs[key];
        hasState = true;
      }
    }
  }
  if (hasState) {
    json.$ = state;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Text

let formatNames: string[] | undefined;
const getFormatNames = (): string[] =>
  formatNames || (formatNames = Object.keys(TEXT_TYPE_TO_FORMAT));

/** Whether Lexical would merge this text node with an equal neighbour. */
export const isMergeableText = (node: TextNode): boolean =>
  node.isSimpleText() && !node.isUnmergeable();

/** The flat NodeState keys each class declares (see $foreignFlatKeys). */
const ownFlatKeysOf = new WeakMap<Klass<LexicalNode>, ReadonlySet<string>>();

/**
 * The NodeState keys a node serializes at the top level (flat) although its
 * own class does not read them there, or null: a node made by core's
 * splitText from a node of another class (a custom text class with a flat
 * StateConfig, split into plain text nodes) keeps that class's state
 * configuration, so its JSON has the key flat, where a reader of its own
 * class ignores it.
 */
export function $foreignFlatKeys(
  node: LexicalNode,
): ReadonlySet<string> | null {
  const state = node.__state;
  if (state === undefined || state.sharedNodeState.flatKeys.size === 0) {
    return null;
  }
  const klass = klassOf(node);
  let own = ownFlatKeysOf.get(klass);
  if (own === undefined) {
    own = createSharedNodeState(klass).flatKeys;
    ownFlatKeysOf.set(klass, own);
  }
  let out: Set<string> | null = null;
  for (const key of state.sharedNodeState.flatKeys) {
    if (!own.has(key)) {
      if (out === null) {
        out = new Set();
      }
      out.add(key);
    }
  }
  return out;
}

/**
 * Formats of a text node's characters: its type (`t`, when not 'text'), one
 * key per format bit (`f:bold`), its other JSON fields (`p:style`, ...), its
 * NodeState (`s:<key>`), and for a node Lexical would not merge with an equal
 * neighbour, a segment key (`k`) that keeps it apart.
 *
 * Invariant: a NodeState key the node's class does not read flat is stored
 * as NodeState (see $foreignFlatKeys). Why: a reader builds the node from
 * JSON, and keeps a key under `$` whatever its class, but a top-level key
 * only where the class declares it.
 */
export function $textAttrs(
  node: TextNode,
  segment: string | null,
  strict = true,
): Attrs {
  const latest = node.getLatest();
  const json = latest.exportJSON(true) as unknown as Attrs;
  const attrs: Attrs = {};
  if (latest.getType() !== 'text') {
    attrs[TYPE_KEY] = latest.getType();
  }
  const format = latest.getFormat();
  if (format !== 0) {
    for (const name of getFormatNames()) {
      if (format & TEXT_TYPE_TO_FORMAT[name]) {
        attrs[TEXT_FORMAT_PREFIX + name] = true;
      }
    }
  }
  const foreign = $foreignFlatKeys(latest);
  for (const key in json) {
    if (key !== 'text' && key !== 'format' && !STRUCTURAL_JSON_KEYS.has(key)) {
      if (foreign !== null && foreign.has(key)) {
        putValue(attrs, STATE_PREFIX + key, json[key], `NodeState ${key}`);
      } else {
        putValue(attrs, FIELD_PREFIX + key, json[key], `text.${key}`);
      }
    }
  }
  const state = json.$ as Attrs | undefined;
  if (state) {
    const stored = $splitSetMembers(latest, state, strict);
    for (const k in stored) {
      putValue(attrs, STATE_PREFIX + k, stored[k], `NodeState ${k}`);
    }
  }
  if (segment !== null) {
    attrs[SEGMENT_KEY] = segment;
  }
  return encodeFormats(attrs);
}

export function textJSONFromAttrs(text: string, encoded: Attrs): Attrs {
  const attrs: Attrs = {};
  for (const k in encoded) {
    attrs[k] = decodeFormatValue(encoded[k]);
  }
  const type =
    typeof attrs[TYPE_KEY] === 'string' ? (attrs[TYPE_KEY] as string) : 'text';
  const json: Attrs = {text, type, version: 1};
  let format = 0;
  const state: Attrs = {};
  let hasState = false;
  for (const key of Object.keys(attrs).sort()) {
    if (key.startsWith(TEXT_FORMAT_PREFIX)) {
      const bit = TEXT_TYPE_TO_FORMAT[key.slice(TEXT_FORMAT_PREFIX.length)];
      if (bit && attrs[key] === true) {
        format |= bit;
      }
    } else if (key.startsWith(FIELD_PREFIX)) {
      const f = key.slice(FIELD_PREFIX.length);
      if (!isUnsafeKey(f)) {
        json[f] = attrs[key];
      }
    } else if (key.startsWith(STATE_PREFIX)) {
      const f = key.slice(STATE_PREFIX.length);
      if (!isUnsafeKey(f)) {
        state[f] = attrs[key];
        hasState = true;
      }
    }
  }
  json.format = format;
  if (hasState) {
    json.$ = state;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Ownership
//
// Invariant, in two clauses:
// - A write changes the value a stored name gives content only where its
//   client owns the name (ownsNodeAttr, ownsMarkerAttr, ownsFormat, and
//   ownsMember for the members of a value that holds a node's fields);
//   every other name keeps the value it gives content.
// - Format items that keep every name's value on the content around a write
//   (the negations and restores around inserted content, run ends, gap
//   cleanup, the copies an undo brings back) are written for any name: they
//   change no value, and filtering them by owner would let a value run on
//   past its content.
// Why: a document outlives app versions, and clients of several versions
// edit it at once (during a rollout): a name a client does not know, such
// as a field a newer version of a class declares, is another client's data,
// which this one can neither show nor write back.

/**
 * The fields a client owns at one stored location: those its classes for
 * the location's types declare (see ownedFields).
 */
export interface OwnedFields {
  has(field: string): boolean;
}

/** No fields: a type the editor does not register. */
const NO_FIELDS: OwnedFields = {has: () => false};

/** Every field: a class that writes its JSON by hand (see writesOwnJSON). */
const EVERY_FIELD: OwnedFields = {has: () => true};

/** The member of a value that holds a node's fields that holds its NodeState. */
const STATE_MEMBER = '$';

const schemaFieldSets = new WeakMap<Klass<LexicalNode>, ReadonlySet<string>>();

/** The fields `klass` declares in its `$config` schema, flat NodeState too. */
function schemaFieldsOf(klass: Klass<LexicalNode>): ReadonlySet<string> {
  let fields = schemaFieldSets.get(klass);
  if (fields === undefined) {
    fields = new Set(Object.keys(getComposedSchemaFields(klass)));
    schemaFieldSets.set(klass, fields);
  }
  return fields;
}

/**
 * Whether nodes of `klass` write their JSON by hand: the exportJSON they use
 * is not one of `lexical`'s (LexicalNode's, which ElementNode does not
 * override, writes the schema; ParagraphNode's only adds schema fields), so
 * it may write fields the schema does not declare.
 */
function writesOwnJSON(klass: Klass<LexicalNode>): boolean {
  const exportJSON = (klass.prototype as LexicalNode).exportJSON;
  return (
    exportJSON !== ElementNode.prototype.exportJSON &&
    exportJSON !== ParagraphNode.prototype.exportJSON
  );
}

/**
 * The fields a client owns at a stored location whose type is `stored` and
 * is `written` once its write is done. Where the write changes the type, or
 * leaves none (a line that is not an item of a group holds no group's
 * fields), every field: no node there takes the fields stored for another
 * type. Otherwise those its class of the type declares in its `$config`
 * schema, and none where it does not register the type. Where the location
 * holds the class's own exportJSON (`json`: a node stored as its own Y.Node,
 * a text run), its flat NodeState too (see jsonFieldsOf), and a class that
 * writes its JSON by hand (see writesOwnJSON) owns every field: which ones
 * it writes cannot be known.
 */
export function ownedFields(
  editor: LexicalEditor,
  stored: unknown,
  written: unknown,
  json: boolean,
): OwnedFields {
  if (stored !== written || written === undefined) {
    return EVERY_FIELD;
  }
  const info =
    typeof written === 'string' ? editor._nodes.get(written) : undefined;
  return info === undefined ? NO_FIELDS : ownedFieldsOf(info.klass, json);
}

/** {@link ownedFields} where the type is `klass`'s and stays so. */
export function ownedFieldsOf(
  klass: Klass<LexicalNode>,
  json: boolean,
): OwnedFields {
  if (!json) {
    return schemaFieldsOf(klass);
  }
  return writesOwnJSON(klass) ? EVERY_FIELD : jsonFieldsOf(klass);
}

const jsonFieldSets = new WeakMap<Klass<LexicalNode>, ReadonlySet<string>>();

/**
 * The fields a node of `klass` stores where it holds its exportJSON (see
 * $nodeAttrs, $textAttrs): its schema's (see schemaFieldsOf) and every flat
 * NodeState it declares, whether or not that state has a schema.
 */
function jsonFieldsOf(klass: Klass<LexicalNode>): ReadonlySet<string> {
  let fields = jsonFieldSets.get(klass);
  if (fields === undefined) {
    fields = new Set([
      ...schemaFieldsOf(klass),
      ...createSharedNodeState(klass).flatKeys,
    ]);
    jsonFieldSets.set(klass, fields);
  }
  return fields;
}

/**
 * The fields a client owns where the type is one of `types` (an absent one
 * is a paragraph's): those its classes of them declare in their `$config`
 * schema (see ownedFieldsOf), none of a type it does not register.
 */
export function fieldsOfTypes(
  editor: LexicalEditor,
  types: readonly unknown[],
): OwnedFields {
  const sets: OwnedFields[] = [];
  for (const type of types) {
    const info = editor._nodes.get(
      typeof type === 'string' ? type : 'paragraph',
    );
    if (info !== undefined) {
      sets.push(ownedFieldsOf(info.klass, false));
    }
  }
  return {has: field => sets.some(set => set.has(field))};
}

const itemFieldSets = new WeakMap<GroupSpec, OwnedFields>();

/**
 * The fields a client owns in the stored fields of an item of a group of
 * `spec` that holds a nested group (an outer level's wrapper item, see
 * WRAPPER_FIELDS_KEY): those one of the group's item classes declares.
 */
export function groupItemFields(spec: GroupSpec): OwnedFields {
  let fields = itemFieldSets.get(spec);
  if (fields === undefined) {
    const sets = spec.items.map(schemaFieldsOf);
    fields = {has: field => sets.some(set => set.has(field))};
    itemFieldSets.set(spec, fields);
  }
  return fields;
}

/**
 * The fields a client owns in the value of format wrapper `type` (see
 * ownsMember), or null where it does not store `type` as a format wrapper.
 */
export function wrapperFieldsOf(
  editor: LexicalEditor,
  type: string,
): OwnedFields | null {
  const info = editor._nodes.get(type);
  return info === undefined || getWrapperSpec(info.klass) === null
    ? null
    : schemaFieldsOf(info.klass);
}

/**
 * Whether a client owns attribute `key` of a node stored as its own Y.Node:
 * a field it owns there (`fields`), or NodeState, which the node holds
 * whole (NodeState keeps the keys its client does not know, see
 * $stateAttrs), so a key the node no longer holds was removed.
 */
export function ownsNodeAttr(key: string, fields: OwnedFields): boolean {
  return (
    key.startsWith(STATE_PREFIX) ||
    (key.startsWith(FIELD_PREFIX) && fields.has(key.slice(FIELD_PREFIX.length)))
  );
}

/**
 * Whether a client owns attribute `key` of a line marker: the binding's own
 * keys (type, group, level, outer levels), a field of the line it owns
 * (`fields`) or of the line's group (`groupFields`), and NodeState (see
 * ownsNodeAttr), the group's too.
 */
export function ownsMarkerAttr(
  key: string,
  fields: OwnedFields,
  groupFields: OwnedFields,
): boolean {
  if (key.startsWith(GROUP_FIELD_PREFIX)) {
    const field = key.slice(GROUP_FIELD_PREFIX.length);
    return field === STATE_MEMBER || groupFields.has(field);
  }
  return (
    key === TYPE_KEY ||
    key === GROUP_KEY ||
    key === LEVEL_KEY ||
    key === OUTER_KEY ||
    ownsNodeAttr(key, fields)
  );
}

/**
 * Whether a client owns text format `key`: the binding's own keys (the text
 * node type, a segment key), a text format its Lexical knows, a field of the
 * text's class it owns (`fields`), NodeState (see ownsNodeAttr), and a
 * format wrapper of a type it stores as one (`wrapperFields`, see ownsMember
 * for the members of its value).
 */
export function ownsFormat(
  key: string,
  fields: OwnedFields,
  wrapperFields: (type: string) => OwnedFields | null,
): boolean {
  if (key.startsWith(WRAPPER_PREFIX)) {
    return wrapperFields(key.slice(WRAPPER_PREFIX.length)) !== null;
  }
  if (key.startsWith(TEXT_FORMAT_PREFIX)) {
    return hasOwn(TEXT_TYPE_TO_FORMAT, key.slice(TEXT_FORMAT_PREFIX.length));
  }
  return key === TYPE_KEY || key === SEGMENT_KEY || ownsNodeAttr(key, fields);
}

/**
 * Whether a client owns member `member` of a value that holds a node's
 * fields (a format wrapper's value, an outer level's fields or its wrapper
 * item's in OUTER_KEY): the binding's own members (a wrapper's instance, a
 * level's wrapper item), NodeState, and a field it owns (`fields`).
 */
export function ownsMember(member: string, fields: OwnedFields): boolean {
  return (
    member === INSTANCE_KEY ||
    member === WRAPPER_FIELDS_KEY ||
    member === STATE_MEMBER ||
    member.startsWith(STATE_PREFIX) ||
    fields.has(member)
  );
}

const isPlainObject = (v: unknown): v is Attrs =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `value`, a value that holds a node's fields as its client writes it, with
 * the members of `stored` (the value stored there) that the client does not
 * own (`owns`) kept as stored: `value` itself when there are none.
 */
export function withUnownedMembers(
  value: Attrs,
  stored: unknown,
  owns: (member: string) => boolean,
): Attrs {
  if (!isPlainObject(stored)) {
    return value;
  }
  let out: Attrs | null = null;
  for (const member of Object.keys(stored)) {
    if (!(member in value) && !isUnsafeKey(member) && !owns(member)) {
      if (out === null) {
        out = {...value};
      }
      out[member] = stored[member];
    }
  }
  return out === null ? value : out;
}

/**
 * `value` without the members its reader does not own (`owns`): what the
 * reader's classes read of it. `value` itself when it has none.
 */
export function withoutUnownedMembers(
  value: Attrs,
  owns: (member: string) => boolean,
): Attrs {
  let out: Attrs | null = null;
  for (const member of Object.keys(value)) {
    if (!owns(member)) {
      if (out === null) {
        out = {...value};
      }
      delete out[member];
    }
  }
  return out === null ? value : out;
}

/**
 * Apply `apply` (withUnownedMembers or withoutUnownedMembers) to each level
 * of an OUTER_KEY value, `stored[i]` being what level `i` is stored as: a
 * level's fields are its group's (`groupFields`), and its wrapper item's
 * those of the group's items (`itemFields`). `outer` itself where that
 * changes nothing.
 */
export function eachOuterLevel(
  outer: Attrs[],
  stored: unknown,
  groupFields: OwnedFields,
  itemFields: OwnedFields,
  apply: (
    value: Attrs,
    at: unknown,
    owns: (member: string) => boolean,
  ) => Attrs,
): Attrs[] {
  let out: Attrs[] | null = null;
  outer.forEach((level, i) => {
    const at = Array.isArray(stored) ? stored[i] : undefined;
    let next = apply(level, at, m => ownsMember(m, groupFields));
    const item = level[WRAPPER_FIELDS_KEY];
    if (isPlainObject(item)) {
      const kept = apply(
        item,
        isPlainObject(at) ? at[WRAPPER_FIELDS_KEY] : undefined,
        m => ownsMember(m, itemFields),
      );
      if (kept !== item) {
        next = {...next, [WRAPPER_FIELDS_KEY]: kept};
      }
    }
    if (next !== level) {
      if (out === null) {
        out = outer.slice();
      }
      out[i] = next;
    }
  });
  return out === null ? outer : out;
}

// ---------------------------------------------------------------------------
// Wrappers

/**
 * The key of a wrapper value that tells apart two adjacent wrappers with
 * equal fields (two links to the same URL), which would otherwise read as
 * one.
 */
const INSTANCE_KEY = '#';

/**
 * Wrapper values (see $wrapperAttrs) of wrappers that hold text: their text
 * fields are not written (Lexical does not serialize them), so a value
 * without them does not remove text fields stored there (see
 * Writer#formatAsStored).
 */
const textHoldingValues = new WeakSet<object>();

/** Whether `value` is a wrapper value of a wrapper that holds text. */
export function isTextHoldingWrapperValue(value: unknown): boolean {
  return (
    value !== null && typeof value === 'object' && textHoldingValues.has(value)
  );
}

/**
 * The format of one wrapper: one key, `w:<type>`, whose value is a flat
 * object of its schema fields and NodeState (`s:<key>`); a value that is not
 * a primitive, or a string that starts with NUL, is NUL and its JSON, since
 * Yjs compares format values one level deep. One key keeps a link at two
 * format items: concurrent changes to two fields of one wrapper do not merge
 * (the last one wins).
 */
export function $wrapperAttrs(
  node: ElementNode,
  out: Attrs,
  instance: string | null = null,
): void {
  const spec = getWrapperSpec(klassOf(node))!;
  const own: Attrs = {};
  const json = $schemaJSON(node.getLatest());
  for (const f of spec.fields) {
    putValue(own, f, json[f], `${node.getType()}.${f}`);
  }
  $stateAttrs(node.getLatest(), own);
  // Only when Lexical serializes them (`shouldSerializeTextStyles`: the
  // wrapper holds no text anywhere inside it, and a mark in a link holds
  // text), so that the author and a fresh reader have the same JSON. With
  // text, they follow that text (a format of it sets them), and a write of
  // them alone would write the whole value again over the wrapper's text,
  // which a collaborator's concurrent removal of the wrapper does not delete
  // (the removed link came back).
  const latest = node.getLatest();
  if (
    (latest.getTextFormat() !== 0 || latest.getTextStyle() !== '') &&
    latest.shouldSerializeTextStyles()
  ) {
    $putTextFields(latest, own);
  }
  for (const k in own) {
    const v = own[k];
    // Yjs compares format values one level deep: a value that is not a
    // primitive is stored as NUL and its JSON. So is a string that starts
    // with NUL (as the JSON of that string), so that every value reads back
    // as written, with its type.
    if (
      (v !== null && typeof v === 'object') ||
      (typeof v === 'string' && v.startsWith('\u0000'))
    ) {
      own[k] = '\u0000' + stableStringify(v);
    }
  }
  if (instance !== null) {
    own[INSTANCE_KEY] = instance;
  }
  if (!latest.shouldSerializeTextStyles()) {
    textHoldingValues.add(own);
  }
  // The innermost wrapper of a type wins.
  out[WRAPPER_PREFIX + node.getType()] = own;
}

export type WrapperValue = {
  readonly type: string;
  readonly sig: string;
  readonly json: Attrs;
  readonly instance: string | null;
};

/**
 * Wrapper values in a format map, sorted by type: of the types `fieldsOf`
 * gives the fields of (those its reader stores as format wrappers, see
 * wrapperFieldsOf), each with the members its reader owns (see ownsMember).
 */
export function wrappersFromAttrs(
  attrs: Attrs,
  fieldsOf: (type: string) => OwnedFields | null,
): WrapperValue[] {
  const result: WrapperValue[] = [];
  for (const key in attrs) {
    if (!key.startsWith(WRAPPER_PREFIX)) {
      continue;
    }
    const type = key.slice(WRAPPER_PREFIX.length);
    const value = attrs[key];
    const fields = fieldsOf(type);
    if (fields === null || value === null || typeof value !== 'object') {
      continue;
    }
    const json: Attrs = {type, version: 1};
    const state: Attrs = {};
    let hasState = false;
    let instance: string | null = null;
    for (const f of Object.keys(value as Attrs).sort()) {
      let v = (value as Attrs)[f];
      if (f === INSTANCE_KEY) {
        instance = typeof v === 'string' ? v : null;
        continue;
      }
      if (!ownsMember(f, fields)) {
        continue;
      }
      if (typeof v === 'string' && v.startsWith('\u0000')) {
        try {
          v = JSON.parse(v.slice(1));
        } catch (_e) {
          continue;
        }
      }
      if (f.startsWith(STATE_PREFIX)) {
        const k = f.slice(STATE_PREFIX.length);
        if (!isUnsafeKey(k)) {
          state[k] = v;
          hasState = true;
        }
      } else if (!isUnsafeKey(f)) {
        json[f] = v;
      }
    }
    if (hasState) {
      json.$ = state;
    }
    result.push({
      instance,
      json,
      sig:
        type +
        '\u0000' +
        stableStringify(json) +
        (instance === null ? '' : '\u0000' + instance),
      type,
    });
  }
  result.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return result;
}

// ---------------------------------------------------------------------------
// Lines

/** Fields of a line stored on its marker (schema minus derived). */
export function $lineAttrs(
  line: ElementNode,
  derived: ReadonlySet<string> | null,
): Attrs {
  const latest = line.getLatest();
  // The most common type is left out: a marker without one is a paragraph.
  const attrs: Attrs =
    latest.getType() === 'paragraph' ? {} : {[TYPE_KEY]: latest.getType()};
  const spec = getLineSpec(klassOf(latest))!;
  const json = $schemaJSON(latest);
  for (const f of spec.fields) {
    if (derived === null || !derived.has(f)) {
      putValue(attrs, FIELD_PREFIX + f, json[f], `${latest.getType()}.${f}`);
    }
  }
  // Lexical serializes an element's textFormat/textStyle only while it has
  // no text (otherwise a reconcile derives them from the text), but keeps
  // them: every peer must hold the same values, so they are always stored.
  if (
    spec.fields.has('textFormat') &&
    (derived === null || !derived.has('textFormat'))
  ) {
    const tf = latest.getTextFormat();
    if (tf !== 0) {
      attrs[FIELD_PREFIX + 'textFormat'] = tf;
    } else {
      delete attrs[FIELD_PREFIX + 'textFormat'];
    }
  }
  if (
    spec.fields.has('textStyle') &&
    (derived === null || !derived.has('textStyle'))
  ) {
    const ts = latest.getTextStyle();
    if (ts !== '') {
      attrs[FIELD_PREFIX + 'textStyle'] = ts;
    } else {
      delete attrs[FIELD_PREFIX + 'textStyle'];
    }
  }
  $stateAttrs(latest, attrs);
  return attrs;
}

/**
 * An element's textFormat/textStyle, which Lexical serializes only while
 * the element has no text: every peer must hold the same values, so groups
 * and lines always carry them, and wrapper items while the wrapper holds no
 * text (see $wrapperAttrs).
 */
function $putTextFields(node: ElementNode, out: Attrs): void {
  const tf = node.getTextFormat();
  if (tf !== 0) {
    out.textFormat = tf;
  } else {
    delete out.textFormat;
  }
  const ts = node.getTextStyle();
  if (ts !== '') {
    out.textStyle = ts;
  } else {
    delete out.textStyle;
  }
}

/** Set the textFormat/textStyle a group or wrapper item's fields record. */
export function $setTextFields(node: ElementNode, fields: Attrs): void {
  const tf = typeof fields.textFormat === 'number' ? fields.textFormat : 0;
  if (node.getTextFormat() !== tf) {
    node.setTextFormat(tf);
  }
  const ts = typeof fields.textStyle === 'string' ? fields.textStyle : '';
  if (node.getTextStyle() !== ts) {
    node.setTextStyle(ts);
  }
}

/**
 * The synchronized fields of a group: its schema fields (key fields and the
 * others, such as alignment) except derived ones, and its NodeState under
 * `$`. Adjacent groups with different fields are different groups, so all of
 * them identify a group (an item carries its group's fields).
 */
export function $groupFields(group: ElementNode, spec: GroupSpec): Attrs {
  const latest = group.getLatest();
  const json = $schemaJSON(latest);
  const out: Attrs = {};
  for (const f of Object.keys(json).sort()) {
    if (
      STRUCTURAL_JSON_KEYS.has(f) ||
      spec.derived.has(f) ||
      toPlainJSON(json[f]) === undefined
    ) {
      continue;
    }
    out[f] = toPlainJSON(json[f]);
  }
  $putTextFields(latest, out);
  const st: Attrs = {};
  $stateAttrs(latest, st);
  const state: Attrs = {};
  for (const k of Object.keys(st).sort()) {
    state[k.slice(STATE_PREFIX.length)] = st[k];
  }
  if (Object.keys(state).length > 0) {
    out.$ = state;
  }
  return out;
}

/**
 * Whether a marker or node attribute holds an element's textFormat or
 * textStyle (`p:` on a line or node, `g:` on a group's items): fields
 * Lexical's reconciler derives from the element's first text, which a
 * follow-up does not write (see Writer#followUp).
 */
export function isTextFieldKey(key: string): boolean {
  return (
    key === FIELD_PREFIX + 'textFormat' ||
    key === FIELD_PREFIX + 'textStyle' ||
    key === GROUP_FIELD_PREFIX + 'textFormat' ||
    key === GROUP_FIELD_PREFIX + 'textStyle'
  );
}

/**
 * An OUTER_KEY value (the fields of each outer level and of its wrapper
 * item) without textFormat/textStyle (see isTextFieldKey), as a string.
 */
export function outerWithoutTextFields(value: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(strip);
    }
    if (v === null || typeof v !== 'object') {
      return v;
    }
    const out: Attrs = {};
    for (const k in v as Attrs) {
      if (k !== 'textFormat' && k !== 'textStyle') {
        out[k] =
          k === WRAPPER_FIELDS_KEY ? strip((v as Attrs)[k]) : (v as Attrs)[k];
      }
    }
    return out;
  };
  return stableStringify(strip(value));
}

/**
 * The key of the fields of a nested level's wrapper item (the item that
 * holds a nested group) inside an OUTER_KEY entry.
 */
export const WRAPPER_FIELDS_KEY = '@';

/** The synchronized fields of a nested level's wrapper item. */
export function $levelItemFields(item: ElementNode, spec: GroupSpec): Attrs {
  const latest = item.getLatest();
  const json = $schemaJSON(latest);
  const out: Attrs = {};
  for (const f of Object.keys(json).sort()) {
    if (
      STRUCTURAL_JSON_KEYS.has(f) ||
      spec.derived.has(f) ||
      toPlainJSON(json[f]) === undefined
    ) {
      continue;
    }
    out[f] = toPlainJSON(json[f]);
  }
  $putTextFields(latest, out);
  const st: Attrs = {};
  $stateAttrs(latest, st);
  if (Object.keys(st).length > 0) {
    const state: Attrs = {};
    for (const k of Object.keys(st).sort()) {
      state[k.slice(STATE_PREFIX.length)] = st[k];
    }
    out.$ = state;
  }
  return out;
}

/** The marker attributes of a group from its fields. */
export function groupAttrsOf(group: ElementNode, fields: Attrs): Attrs {
  const attrs: Attrs = {[GROUP_KEY]: group.getType()};
  for (const f in fields) {
    attrs[GROUP_FIELD_PREFIX + f] = fields[f];
  }
  return attrs;
}
