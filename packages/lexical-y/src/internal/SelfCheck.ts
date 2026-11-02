/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Writer} from './Write';

import {buildEditorFromExtensions, LexicalBuilder} from '@lexical/extension';
import {ContentFormat, ContentType, type Item, type Node as YNode} from '@y/y';
import {
  $getNodeByKey,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $parseSerializedNode,
  createEditor,
  type EditorState,
  ElementNode,
  getDeclaredNodeStructure,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  TextNode,
} from 'lexical';

import {forgiveRepeatedIds} from './BlockIds';
import {equalFormatValue, type Formats} from './Cursor';
import {$pushInline, Atoms, readAtoms} from './Inline';
import {Reader} from './Read';
import {
  type Attrs,
  decodeFormatValue,
  equalValue,
  getContainerGroupSpec,
  getGroupSpec,
  getWrapperSpec,
  INLINE_PREFIX,
  isSetStateConfig,
  MARKER,
  ownsFormat,
  RUN_END,
  SEGMENT_KEY,
  SET_MEMBER_SEPARATOR,
  stableStringify,
  STATE_PREFIX,
  TEXT_FORMAT_PREFIX,
  TYPE_KEY,
  WRAPPER_PREFIX,
} from './Schema';
import {prevLiveEnd} from './Seen';
import {type CS, EMPTY_FORMATS, State} from './State';

// The opt-in self-check (YBindingOptions.selfCheck): the lines a local
// write touched, read back from Yjs and compared with the editor
// ($checkWrite), and a fresh read of a whole container compared with the
// editor (checkContainer). Known differences that are not bugs (derived list
// fields, text fields of groups, block ids the document repeats) are left out
// of the comparison.
//
// Invariant: a check changes nothing: no node, no segment key, no shared
// content. Why: it runs wherever it is enabled, production included, and
// only reports; after a remote change the binding itself reads a container
// that differs again (see YBinding#checkRead).
//
// This module also holds the follow-up check ($followUpDifference), which
// is not opt-in: the binding runs it after every follow-up it writes and
// reads again a container where it finds a difference (see
// YBinding#$checkFollowUp). It changes nothing either; the binding acts on
// its result.

/**
 * The shared text without stored elements a reader does not show (an
 * element that cannot be empty, emptied by peers).
 */
function $shownText(writer: Writer, atoms: Atoms): string {
  let out = '';
  for (let i = 0; i < atoms.text.length; i++) {
    const sp = atoms.specials.get(i);
    if (
      sp !== undefined &&
      sp.kind === 'oldNode' &&
      sp.item.content instanceof ContentType
    ) {
      const y = sp.item.content.type as YNode;
      const name = typeof y.name === 'string' ? y.name : '';
      const info = name.startsWith(INLINE_PREFIX)
        ? writer.state.editor._nodes.get(name.slice(INLINE_PREFIX.length))
        : undefined;
      if (
        info !== undefined &&
        info.klass.prototype instanceof ElementNode &&
        !(info.klass.prototype as ElementNode).canBeEmpty.call(
          Object.create(info.klass.prototype),
        ) &&
        !hasLiveContent(y)
      ) {
        continue;
      }
    }
    out += atoms.text[i];
  }
  return out;
}

function hasLiveContent(y: YNode): boolean {
  for (let it = y._start; it !== null; it = it.right) {
    if (!it.deleted && it.countable) {
      return true;
    }
  }
  return false;
}

/**
 * Development self-check of a local write: every line the write touched is
 * read back from Yjs (characters, owned formats, child nodes, marker
 * attributes) and compared with the editor's content. Returns the
 * mismatches found (empty when the write is faithful).
 */
export function $checkWrite(writer: Writer): string[] {
  const problems: string[] = [];
  // A line written twice in one write (its container rewritten after it)
  // is checked as last written.
  const last = new Map<string, number>();
  writer.touched.forEach(({unit}, at) => {
    if (unit.key !== null) {
      last.set(unit.key, at);
    }
  });
  for (const [at, {unit, d}] of writer.touched.entries()) {
    if (unit.key !== null && last.get(unit.key) !== at) {
      continue;
    }
    const end = unit.end;
    if (end === null || end.deleted) {
      problems.push(`unit ${String(unit.key)} has no live end`);
      continue;
    }
    const name = (end.content as ContentType).type.name;
    if (name !== (d.kind === 'run' ? RUN_END : MARKER)) {
      problems.push(`unit ${String(unit.key)} ends with ${String(name)}`);
      continue;
    }
    const nodes =
      d.part !== undefined
        ? d.part
        : d.kind === 'line'
          ? (() => {
              const line = $getNodeByKey(d.key!);
              return $isElementNode(line)
                ? (line as ElementNode).getChildren()
                : null;
            })()
          : d.nodes;
    if (nodes === null) {
      continue;
    }
    const want = new Atoms();
    // What was written: no node gets a new segment key here (a node this
    // write did not rewrite keeps the key it was read with, or none, as the
    // reader shows it).
    const ctx = writer.$ctx();
    ctx.segments = {
      create: () => null,
      get: key => writer.state.segments.get(key),
    };
    $pushInline(want, nodes, ctx);
    const left = prevLiveEnd(end, writer.state.hidden);
    const have = new Atoms();
    readAtoms(
      left === null ? unit.cs.y._start : left.right,
      end,
      unit.start || EMPTY_FORMATS,
      have,
      writer.state.hidden,
    );
    if (want.text !== have.text && want.text !== $shownText(writer, have)) {
      problems.push(
        `line ${String(unit.key)}: text ${JSON.stringify(have.text)} != ${JSON.stringify(want.text)}`,
      );
      continue;
    }
    if (want.text !== have.text) {
      // Equal once stored elements the reader hides are left out.
      continue;
    }
    let ra = 0;
    let rb = 0;
    let lastKey = '';
    for (let i = 0; i < want.length; i++) {
      while (ra < want.runs.length && want.runs[ra].end <= i) {
        ra++;
      }
      while (rb < have.runs.length && have.runs[rb].end <= i) {
        rb++;
      }
      const a = ra < want.runs.length ? want.runs[ra].attrs : {};
      const b = rb < have.runs.length ? have.runs[rb].attrs : {};
      const isBreak = !want.specials.has(i) && want.text.charCodeAt(i) === 10;
      const wrappersOnly = want.specials.has(i) || isBreak;
      const key =
        ra + '/' + rb + '/' + (wrappersOnly ? 1 : 0) + (isBreak ? i : '');
      if (key === lastKey) {
        continue;
      }
      lastKey = key;
      const fields = writer.textFields(a[TYPE_KEY], b[TYPE_KEY]);
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        // A segment key under text the editor holds in a node Lexical
        // merges (an opener an undo restored, left open over later lines):
        // a reader keeps such a node apart only by its type, mode or detail,
        // so it shows the key nowhere (see Reader#$readInline).
        if (k === SEGMENT_KEY && a[k] === undefined && !wrappersOnly) {
          continue;
        }
        // A wrapper's textFormat/textStyle at a character: Lexical's
        // reconciler derives them from the wrapper's text (see
        // stripGroupText).
        const derivedText = !wrappersOnly && k.startsWith(WRAPPER_PREFIX);
        if (
          !wrappersOnly &&
          k.startsWith(TEXT_FORMAT_PREFIX) &&
          dropsFormats(writer.state, a)
        ) {
          // A text class that keeps no formats (a code highlight): the
          // reader shows none, whatever is stored.
          continue;
        }
        // What the write stores of it, where the editor owns it (see
        // ownsFormat, Writer#formatAsStored).
        if (
          (!wrappersOnly ||
            k.startsWith(WRAPPER_PREFIX) ||
            (isBreak && k.startsWith(STATE_PREFIX))) &&
          ownsFormat(k, fields, writer.wrapperFields) &&
          !equalFormatValue(
            withoutTextFields(
              writer.formatAsStored(k, a[k] ?? null, b[k]),
              derivedText,
            ),
            withoutTextFields(b[k] ?? null, derivedText),
          )
        ) {
          problems.push(`line ${String(unit.key)}: format ${k} at ${i}`);
          i = want.length;
          break;
        }
      }
    }
    // (Not a marker whose attributes are held back: the line shows its old
    // ones until the hold ends, see Hidden.)
    const hidden = writer.state.hidden;
    if (
      d.kind === 'line' &&
      (hidden === null ||
        hidden.marker === null ||
        !hidden.marker.ends.has(end))
    ) {
      const attrs = (end.content as ContentType).type.getAttrs() as Record<
        string,
        unknown
      >;
      const desired = writer.$marker(d);
      const marker = writer.$markerAsStored(
        desired,
        attrs,
        writer.markerOwners(desired, attrs),
        null,
      );
      for (const k in marker) {
        if (
          !equalValue(attrs[k], marker[k]) &&
          !writer.keepsStored(k, attrs[k], marker[k])
        ) {
          problems.push(`line ${String(unit.key)}: marker ${k}`);
        }
      }
    }
  }
  return problems;
}

/**
 * The key the follow-up check marks the JSON of an element the follow-up
 * changed with (see stripFollowUpText).
 */
const CHANGED = '\u0000changed';

/**
 * A node's JSON with its children and named slots, as exportJSON gives it.
 * Adjacent text nodes that differ only in their text are compared as one
 * (Lexical keeps them apart while one of them is being composed). `unstored`
 * are nodes whose NodeState is left out (see $runNodes); `changed`, elements
 * marked CHANGED (see stripFollowUpText).
 */
function $deepJSON(
  node: LexicalNode,
  unstored: ReadonlySet<NodeKey> | null = null,
  changed: ReadonlySet<NodeKey> | null = null,
): Attrs {
  const json = node.exportJSON() as unknown as Attrs;
  if (unstored !== null && unstored.has(node.getKey())) {
    delete json.$;
  }
  if ($isElementNode(node)) {
    if (changed !== null && changed.has(node.getKey())) {
      json[CHANGED] = true;
    }
    const children: Attrs[] = [];
    for (const child of node.getChildren()) {
      const c = $deepJSON(child, unstored, changed);
      const prev = children[children.length - 1];
      if (
        prev !== undefined &&
        typeof prev.text === 'string' &&
        typeof c.text === 'string' &&
        stableStringify({...prev, text: ''}) ===
          stableStringify({...c, text: ''})
      ) {
        children[children.length - 1] = {...prev, text: prev.text + c.text};
      } else {
        children.push(c);
      }
    }
    json.children = children;
  }
  const names = $getSlotNames(node);
  if (names.length > 0) {
    const slots: Attrs = {};
    for (const name of names) {
      const slot = $getSlot(node, name);
      if (slot !== null) {
        slots[name] = $deepJSON(slot, unstored, changed);
      }
    }
    json.$slots = slots;
  }
  return json;
}

/**
 * The inline nodes held directly by a container that holds blocks (a run,
 * which only a writer without Lexical's normalization stores, and its author
 * normalizes): an update that follows a commit on every client (an
 * extension naming blocks) can give one a NodeState value, which it does not
 * write (that would insert formats, see Writer#followUp).
 */
function $runNodes(state: State): Set<NodeKey> {
  const keys = new Set<NodeKey>();
  for (const cs of state.csByKey.values()) {
    if (cs.kind !== 'b') {
      continue;
    }
    for (const u of cs.units) {
      if (u.kind !== 'run' || u.first === null) {
        continue;
      }
      for (
        let n: LexicalNode | null = $getNodeByKey(u.first);
        n !== null;
        n = n.getNextSibling()
      ) {
        keys.add(n.getKey());
        if (n.getKey() === u.last) {
          break;
        }
      }
    }
  }
  return keys;
}

/**
 * Remove the textFormat/textStyle of groups and of the items that hold a
 * nested group. Lexical's reconciler derives them from the first text it
 * renders under the element, when it reconciles it, so clients (and the
 * author, after its write) that reconcile different parts of a list derive
 * different values, as they do for a line with text (which Lexical does not
 * serialize them for). They are still stored, so that an edit that sets them
 * (formatting a selection that holds a list) reaches every client.
 */
function stripGroupText(
  json: unknown,
  groupTypes: ReadonlySet<string>,
): unknown {
  if (Array.isArray(json)) {
    return json.map(j => stripGroupText(j, groupTypes));
  }
  if (json !== null && typeof json === 'object') {
    const node = json as Attrs;
    const children = Array.isArray(node.children)
      ? (node.children as Attrs[])
      : null;
    const strip =
      groupTypes.has(node.type as string) ||
      (children !== null &&
        children.length > 0 &&
        groupTypes.has(children[0].type as string));
    const out: Attrs = {};
    for (const k in node) {
      if (!strip || (k !== 'textFormat' && k !== 'textStyle')) {
        out[k] =
          k === 'children' ? stripGroupText(node[k], groupTypes) : node[k];
      }
    }
    return out;
  }
  return json;
}

/** A wrapper's format value without its textFormat/textStyle (`strip`). */
function withoutTextFields(value: unknown, strip: boolean): unknown {
  if (!strip || value === null || typeof value !== 'object') {
    return value;
  }
  const out: Attrs = {...(value as Attrs)};
  delete out.textFormat;
  delete out.textStyle;
  return out;
}

/** Remove fields every client derives itself (list numbering). */
function stripDerived(json: unknown, derived: ReadonlySet<string>): unknown {
  if (Array.isArray(json)) {
    return json.map(j => stripDerived(j, derived));
  }
  if (json !== null && typeof json === 'object') {
    const out: Attrs = {};
    for (const k of Object.keys(json as Attrs).sort()) {
      if (!derived.has(k)) {
        out[k] = stripDerived((json as Attrs)[k], derived);
      }
    }
    return out;
  }
  return json;
}

function firstDifference(a: unknown, b: unknown, path: string): string | null {
  if (stableStringify(a) === stableStringify(b)) {
    return null;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d !== null) {
        return d;
      }
    }
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const d = firstDifference(
        (a as Attrs)[k],
        (b as Attrs)[k],
        `${path}.${k}`,
      );
      if (d !== null) {
        return d;
      }
    }
  }
  const short = (v: unknown) => {
    const s = stableStringify(v) ?? 'undefined';
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  };
  return `${path}: editor ${short(a)} != shared ${short(b)}`;
}

/**
 * Make the set-valued StateConfigs known to `from` (registered by an
 * extension, or used there) known to `to` too, so that `to` joins the
 * per-member entries it reads into sets the way `from` does. A StateConfig
 * whose key contains the member separator is shared too: the reader keeps
 * an entry of that name as an ordinary key only when it knows a StateConfig
 * for it (see joinSetMembers).
 */
function shareSetStateConfigs(from: LexicalEditor, to: LexicalEditor): void {
  for (const [type, info] of from._nodes) {
    const target = to._nodes.get(type);
    if (target === undefined) {
      continue;
    }
    const {sharedConfigMap} = target.sharedNodeState;
    for (const stateConfig of info.sharedNodeState.sharedConfigMap.values()) {
      if (
        (isSetStateConfig(stateConfig) ||
          stateConfig.key.includes(SET_MEMBER_SEPARATOR)) &&
        !sharedConfigMap.has(stateConfig.key)
      ) {
        sharedConfigMap.set(stateConfig.key, stateConfig);
      }
    }
  }
}

/**
 * Development self-check of a whole container: a fresh reader (a new editor
 * with the same nodes) reads the container's shared content, and the result
 * must equal the editor's container (node types, fields, NodeState, list
 * structure, link fields, text and formats; derived fields aside). Catches
 * writer and reader mapping bugs alike.
 */
export function checkContainer(
  state: State,
  cs: CS,
  editorState: EditorState,
): string[] {
  if (state.differsOnPurpose()) {
    return [];
  }
  const live = editorState.read(() => {
    const node = $getNodeByKey(cs.key);
    return $isElementNode(node) && node.isAttached()
      ? $deepJSON(node, $runNodes(state))
      : null;
  });
  if (live === null) {
    return [];
  }
  const derived = derivedFieldsOf(state);
  let read: Attrs | null = null;
  let problem: string | null = null;
  const {editor: fresh, dispose} = freshEditorFor(state);
  try {
    fresh.update(
      () => {
        const freshState = new State(fresh, state.doc, state.root);
        freshState.blockIds = state.blockIds;
        const reader = new Reader(freshState);
        let el: ElementNode;
        if (cs.y === state.root) {
          el = $getRoot();
        } else {
          el = $parseSerializedNode({
            ...live,
            $slots: undefined,
            children: [],
          } as unknown as SerializedLexicalNode) as ElementNode;
          $getRoot().append(el);
        }
        reader.$readFull(freshState.newCS(cs.y, el.getKey(), cs.kind), el);
        read = $deepJSON(el);
      },
      {discrete: true},
    );
  } catch (e) {
    problem = `container ${String(cs.key)} could not be read: ${String(e)}`;
  } finally {
    if (dispose !== null) {
      dispose();
    }
  }
  if (problem !== null) {
    return [problem];
  }
  if (read === null) {
    return [];
  }
  const groupTypes = groupTypesOf(state);
  // A block id that blocks in other containers store too is settled across
  // the document (see BlockIdSettler#$settleIds), which a read of this
  // container alone cannot do: there, the editor's id is taken.
  if (state.ids.repeatedIds.size > 0) {
    forgiveRepeatedIds(live as Attrs, read as Attrs, state.ids.repeatedIds);
  }
  const d = firstDifference(
    stripGroupText(stripDerived((live as Attrs).children, derived), groupTypes),
    stripGroupText(stripDerived((read as Attrs).children, derived), groupTypes),
    `container ${String(cs.key)}`,
  );
  return d === null ? [] : [d];
}

/** Fields every client derives itself (list numbering), of every group class. */
function derivedFieldsOf(state: State): Set<string> {
  const derived = new Set<string>();
  for (const {klass} of state.editor._nodes.values()) {
    const spec = getContainerGroupSpec(klass);
    if (spec !== null) {
      spec.derived.forEach(f => derived.add(f));
    }
  }
  return derived;
}

/**
 * The fields of each node type the follow-up check leaves out, by type:
 * those it declares derived (a list item's `value` and `indent`, which
 * every client computes from the list), and those no update stores, which
 * a read again cannot change either (see the README's limits): an inline
 * wrapper's (a link's) own alignment, indent and direction, which only a
 * block uses, and a list's own indent (lists indent by nesting).
 */
function derivedByTypeOf(state: State): Map<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [type, {klass}] of state.editor._nodes) {
    const fields = new Set(getDeclaredNodeStructure(klass).derived);
    if (getWrapperSpec(klass) !== null) {
      fields.add('format');
      fields.add('indent');
      fields.add('direction');
    }
    if (getGroupSpec(klass) !== null) {
      fields.add('indent');
    }
    if (fields.size > 0) {
      out.set(type, fields);
    }
  }
  return out;
}

/**
 * Remove, from each node, the fields its own type declares derived (see
 * derivedByTypeOf); unlike stripDerived, a field of that name on a node of
 * another type (a paragraph's `indent`) is kept.
 */
function stripDerivedOfType(
  json: unknown,
  derived: ReadonlyMap<string, ReadonlySet<string>>,
): unknown {
  if (Array.isArray(json)) {
    return json.map(j => stripDerivedOfType(j, derived));
  }
  if (json !== null && typeof json === 'object') {
    const own = derived.get((json as Attrs).type as string);
    const out: Attrs = {};
    for (const k of Object.keys(json as Attrs).sort()) {
      if (own === undefined || !own.has(k)) {
        out[k] = stripDerivedOfType((json as Attrs)[k], derived);
      }
    }
    return out;
  }
  return json;
}

/** The types of the editor's group classes (see stripGroupText). */
function groupTypesOf(state: State): Set<string> {
  const groupTypes = new Set<string>();
  for (const {klass} of state.editor._nodes.values()) {
    const spec = getContainerGroupSpec(klass);
    if (spec !== null) {
      groupTypes.add(spec.klass.getType());
    }
  }
  return groupTypes;
}

/**
 * A new editor with the bound editor's nodes, for a fresh read. Built the
 * way the bound editor was: a node class whose constructor builds a nested
 * editor from extensions (NestedEditorExtension, an image caption) needs the
 * editor it is created in to come from LexicalBuilder. It knows the bound
 * editor's set-valued StateConfigs (see shareSetStateConfigs).
 */
function freshEditorFor(state: State): {
  editor: LexicalEditor;
  dispose: (() => void) | null;
} {
  const nodes = [...state.editor._nodes.values()].map(info => info.klass);
  const onError = (e: Error) => {
    throw e;
  };
  if (LexicalBuilder.maybeFromEditor(state.editor) !== undefined) {
    const built = buildEditorFromExtensions({
      $initialEditorState: null,
      name: '@lexical/y/self-check',
      namespace: '@lexical/y self-check',
      nodes: () => nodes,
      onError,
    });
    shareSetStateConfigs(state.editor, built);
    return {dispose: () => built.dispose(), editor: built};
  }
  const editor = createEditor({
    namespace: '@lexical/y self-check',
    nodes,
    onError,
  });
  shareSetStateConfigs(state.editor, editor);
  return {dispose: null, editor};
}

/**
 * Remove the textFormat/textStyle that a client derives itself, from `live`
 * and `read` walked together (as the comparison pairs them), but on an
 * element the follow-up changed (marked CHANGED in `live`). Lexical's
 * reconciler derives them from the first text it renders under an element,
 * on each client that renders it, so they are derived on an element with
 * text below it, at any depth (a paragraph holding a link, as a line with
 * text, which Lexical does not serialize them for), and on a group and an
 * item holding a nested group (see stripGroupText): a client derives what
 * the others do not store. An element with no text below it (empty, or
 * holding only inline decorators or line breaks) keeps them: there they are
 * its own, stored by every update, follow-ups included (see
 * Writer#keepsStored). On an element the follow-up changed they are
 * compared too: a follow-up does not write derived ones (see
 * WritePlan#unwritable), so one it kept would show nowhere else. Returns
 * whether there is text below either.
 */
function stripFollowUpText(
  live: unknown,
  read: unknown,
  groupTypes: ReadonlySet<string>,
): boolean {
  const asNode = (v: unknown): Attrs | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Attrs)
      : null;
  const a = asNode(live);
  const b = asNode(read);
  if (a === null && b === null) {
    return false;
  }
  let text =
    (a !== null && typeof a.text === 'string') ||
    (b !== null && typeof b.text === 'string');
  const ka = a !== null && Array.isArray(a.children) ? a.children : [];
  const kb = b !== null && Array.isArray(b.children) ? b.children : [];
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    if (stripFollowUpText(ka[i], kb[i], groupTypes)) {
      text = true;
    }
  }
  const sa = a === null ? null : asNode(a.$slots);
  const sb = b === null ? null : asNode(b.$slots);
  if (sa !== null || sb !== null) {
    for (const name of new Set([
      ...Object.keys(sa ?? {}),
      ...Object.keys(sb ?? {}),
    ])) {
      stripFollowUpText(
        sa === null ? undefined : sa[name],
        sb === null ? undefined : sb[name],
        groupTypes,
      );
    }
  }
  const changed = a !== null && a[CHANGED] === true;
  if (a !== null) {
    delete a[CHANGED];
  }
  const group = [a, b].some(
    n =>
      n !== null &&
      (groupTypes.has(n.type as string) ||
        (Array.isArray(n.children) &&
          n.children.length > 0 &&
          groupTypes.has((n.children[0] as Attrs).type as string))),
  );
  if (!changed && (text || group)) {
    for (const n of [a, b]) {
      if (n !== null) {
        delete n.textFormat;
        delete n.textStyle;
      }
    }
  }
  return text;
}

/** The editor each bound editor's follow-up checks read in. */
const followUpEditors = new WeakMap<LexicalEditor, LexicalEditor>();

/**
 * The follow-up check (see YBinding#$checkFollowUp): a fresh reader (a new
 * editor with the same nodes) reads the part of block container `cs` that
 * holds units `from` to `to` of each range (null: all of it, or an inline
 * container), and what it shows must equal the editor's top-level children
 * there: node types, fields, NodeState, named slots, structure, text and
 * formats, with the fields clients derive themselves and those no update
 * stores aside (see derivedByTypeOf; text fields a client's reconciler
 * derives, see stripFollowUpText; block ids settled across the document,
 * and every block id where `settling`, a container whose ids are settled
 * after this write). `changed`: the nodes the follow-up changed. Returns
 * the first difference, or null.
 */
export function $followUpDifference(
  state: State,
  cs: CS,
  ranges: readonly [number, number][] | null,
  changed: ReadonlySet<NodeKey>,
  settling = false,
): string | null {
  const units = cs.units;
  const container = cs.y === state.root ? $getRoot() : $getNodeByKey(cs.key);
  if (!$isElementNode(container) || !container.isAttached()) {
    return null;
  }
  const whole = ranges === null || cs.kind === 'i';
  // The editor's side: the top-level children each range covers.
  const lives: Attrs[][] = [];
  if (whole) {
    lives.push(container.getChildren().map(c => $deepJSON(c, null, changed)));
  } else {
    for (const [from, to] of ranges!) {
      const first = units[from].first;
      const last = units[to].last;
      const tops: Attrs[] = [];
      let n: LexicalNode | null = first === null ? null : $getNodeByKey(first);
      if (n === null || !container.is(n.getParent())) {
        return `container ${String(cs.key)}: unit ${from} is not shown`;
      }
      for (;;) {
        tops.push($deepJSON(n, null, changed));
        if (n.getKey() === last) {
          break;
        }
        n = n.getNextSibling();
        if (n === null) {
          return `container ${String(cs.key)}: units ${from} to ${to} are not shown in order`;
        }
      }
      lives.push(tops);
    }
  }
  const shallow = (() => {
    const json = container.exportJSON() as unknown as Attrs;
    return {...json, children: []};
  })();
  const reads: Attrs[][] = [];
  let problem: string | null = null;
  // One editor per bound editor, kept for the next check (building one,
  // from extensions, costs more than reading a few blocks).
  let fresh = followUpEditors.get(state.editor);
  if (fresh === undefined) {
    fresh = freshEditorFor(state).editor;
    followUpEditors.set(state.editor, fresh);
  }
  const editor = fresh;
  // A set-valued state first used after the editor was cached.
  shareSetStateConfigs(state.editor, editor);
  try {
    editor.update(
      () => {
        // The formats in effect at the start of each range (ranges are in
        // document order).
        const formats: Formats = new Map();
        let scanned: Item | null = cs.y._start;
        const formatsAt = (item: Item | null): Formats => {
          for (
            ;
            scanned !== null && scanned !== item;
            scanned = scanned.right
          ) {
            const content = scanned.content;
            if (!scanned.deleted && content instanceof ContentFormat) {
              if (content.value === null) {
                formats.delete(content.key);
              } else {
                formats.set(content.key, content.value);
              }
            }
          }
          return new Map(formats);
        };
        const parts: [Item | null, Item | null][] = whole
          ? [[cs.y._start, null]]
          : ranges!.map(([from, to]) => [
              from === 0 ? cs.y._start : units[from - 1].end!.right,
              to === units.length - 1 ? null : units[to].end!.right,
            ]);
        for (const [start, stop] of parts) {
          const freshState = new State(editor, state.doc, state.root);
          freshState.blockIds = state.blockIds;
          const reader = new Reader(freshState);
          let el: ElementNode;
          if (cs.y === state.root) {
            el = $getRoot();
            el.clear();
          } else {
            el = $parseSerializedNode(
              shallow as unknown as SerializedLexicalNode,
            ) as ElementNode;
            $getRoot().clear().append(el);
          }
          const fcs = freshState.newCS(cs.y, el.getKey(), cs.kind);
          if (cs.kind === 'i') {
            reader.$readFull(fcs, el);
          } else {
            reader.$readRange(fcs, el, start, stop, formatsAt(start));
          }
          reads.push(el.getChildren().map(c => $deepJSON(c)));
        }
        $getRoot().clear();
      },
      {discrete: true},
    );
  } catch (e) {
    problem = `container ${String(cs.key)} could not be read: ${String(e)}`;
    // Not reused after a failed read.
    followUpEditors.delete(state.editor);
  }
  if (problem !== null) {
    return problem;
  }
  const derived = derivedByTypeOf(state);
  const groupTypes = groupTypesOf(state);
  for (let r = 0; r < lives.length; r++) {
    const live = {children: stripDerivedOfType(lives[r], derived)};
    const read = {children: stripDerivedOfType(reads[r], derived)};
    stripFollowUpText(live, read, groupTypes);
    if (settling) {
      forgiveRepeatedIds(live, read, 'all');
    } else if (state.ids.repeatedIds.size > 0) {
      forgiveRepeatedIds(live, read, state.ids.repeatedIds);
    }
    const d = firstDifference(
      live.children,
      read.children,
      `container ${String(cs.key)}`,
    );
    if (d !== null) {
      return d;
    }
  }
  return null;
}

/**
 * Whether the text class of `attrs` keeps no format bits: its setFormat is
 * its own (a code highlight's ignores them), so a reader shows none.
 */
function dropsFormats(state: State, attrs: Attrs): boolean {
  const type = decodeFormatValue(attrs[TYPE_KEY] ?? null);
  const info = state.editor._nodes.get(
    typeof type === 'string' ? type : 'text',
  );
  return (
    info !== undefined &&
    info.klass.prototype instanceof TextNode &&
    (info.klass.prototype as TextNode).setFormat !==
      TextNode.prototype.setFormat
  );
}
