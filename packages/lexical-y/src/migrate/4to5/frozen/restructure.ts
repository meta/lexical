/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// FROZEN (@lexical/y/migrate/4to5): never edited after release; a change to
// what it writes or reads is a new revision of the step, with new golden
// fixtures.
//
// Layout 4 stored a shadow-root instance of a line class at a block
// position (a quote that holds paragraphs) as a line: its blocks were nodes
// of their own in the line's inline content (`i:paragraph`, c = 'i'), and
// text in it that no block held (a concurrent edit's leftover) was inline
// content of the line, read as a paragraph stored nowhere. Layout 5 stores
// it as a container of blocks (`b:<type>`, c = 'b'), as a table cell: its
// paragraphs are lines of its own sequence (text, then a marker).
//
// What the step knows is what is stored; it has no node classes. A line is
// such a quote when its marker holds `t` = 'quote' and `s:shadowRoot` =
// true (QuoteNode's per-instance flat state, the only shadow root of a line
// class layout 5 stores as a container), with or without group keys (`g`,
// `g:<field>`, `l`: a concurrent edit that turned the quoted paragraph
// into a list item leaves them on the quote's marker; readers show a quote
// and the binding stores it as a container, so the step converts it too,
// and the new node keeps none of its group keys).
// In its inline content, a node is a block when the root records its type as
// a line or a group (`k:<type>`), when it holds blocks (c = 'b'), or when it
// is a leaf (no `c`) with no text in the same run; text and every other node
// are inline content, which a reader shows as a paragraph per run.
//
// Block ids. Where the root stores a block id anywhere, the step computes,
// before writing, the id every block shows (see shownIds): the rule readers
// apply, in document order: a block shows its stored id unless a block
// before it shows it, else the id derived from its own item, else that id
// followed by `_d`s; blocks in a named slot show their stored id or the
// derived one, outside that order. Every block the step writes anew that
// shows an id stores it, so it keeps it; a list item that holds only a
// nested list where lists are group lines has no marker, and stores it in
// `o[level]['@'].$` of the nested list's line that records its fields
// (see groupStarts).

import {
  ContentAny,
  ContentFormat,
  ContentString,
  ContentType,
  createID,
  Item,
  Node as YNode,
  type Transaction,
} from '@y/y';

import {
  isCoveredKey,
  readLayout4Formats,
  storedUnit,
  writeLayout4Formats,
} from './layout4';

export const MARKER = '\u00b6';
export const RUN_END = '\u00a6';
export const BLOCK_PREFIX = 'b:';
export const INLINE_PREFIX = 'i:';
const SLOT_PREFIX = 'slot:';
const SHADOW_ROOT = 's:shadowRoot';
/** The shadow root flag where a node stores it: a flat NodeState, a field. */
const SHADOW_ROOT_FIELD = 'p:shadowRoot';
const BLOCK_ID = 's:blockId';
const KIND_PREFIX = 'k:';

type Values = ReadonlyMap<string, unknown>;

const nameOf = (it: Item): string | null =>
  it.content instanceof ContentType
    ? ((it.content.type as YNode).name as string | null)
    : null;

const typeOf = (it: Item): YNode => (it.content as ContentType).type as YNode;

/** A stored node's name (`b:<type>`, `i:<type>`, a marker). */
const nameOfNode = (node: YNode): string => (node.name as string | null) ?? '';

/** The live items of `node`'s own sequence, formats included, in order. */
function liveItems(node: YNode): Item[] {
  const out: Item[] = [];
  for (let it = node._start; it !== null; it = it.right as Item | null) {
    if (!it.deleted) {
      out.push(it);
    }
  }
  return out;
}

/** The live attributes of `node`, by name, in code-unit order. */
function attrsOf(node: YNode): [string, unknown][] {
  const attrs = node.getAttrs() as Record<string, unknown>;
  return Object.keys(attrs)
    .sort()
    .map(k => [k, attrs[k]]);
}

/** Whether a marker item is a quote that holds blocks (see the header). */
export function isShadowLine(it: Item): boolean {
  if (nameOf(it) !== MARKER) {
    return false;
  }
  const m = typeOf(it);
  return m.getAttr('t') === 'quote' && m.getAttr(SHADOW_ROOT) === true;
}

/** A unit of a line's inline content, with what it was read with. */
type Unit = {item: Item; offset: number; values: Values};

/** One element of a quote's inline content: a block node, or a run. */
type Part = {block: Item} | {run: Unit[]};

/**
 * A container's own sequence as lines: per line, its units (the content
 * before its end item) and the end item (a marker, a run end or a block
 * node; null for content no end item ends).
 */
function linesOf(
  node: YNode,
): {units: Unit[]; end: Item | null; endValues: Values | null}[] {
  const values = readLayout4Formats(node);
  const out: {units: Unit[]; end: Item | null; endValues: Values | null}[] = [];
  let units: Unit[] = [];
  let at = 0;
  for (const it of liveItems(node)) {
    if (!it.countable) {
      continue;
    }
    const name = nameOf(it);
    if (
      name === MARKER ||
      name === RUN_END ||
      (name !== null && name.startsWith(BLOCK_PREFIX))
    ) {
      out.push({end: it, endValues: values[at], units});
      units = [];
      at++;
      continue;
    }
    for (let i = 0; i < it.length; i++) {
      units.push({item: it, offset: i, values: values[at++]});
    }
  }
  if (units.length > 0) {
    out.push({end: null, endValues: null, units});
  }
  return out;
}

/** Whether node item `it` in a quote's inline content is a block. */
function isBlock(root: YNode, it: Item, besideText: boolean): boolean {
  const node = typeOf(it);
  const name = node.name as string;
  if (!name.startsWith(INLINE_PREFIX) && !name.startsWith(BLOCK_PREFIX)) {
    return false;
  }
  const kind = root.getAttr(KIND_PREFIX + name.slice(2));
  if (
    kind === 'line' ||
    (typeof kind === 'string' && kind.startsWith('group|'))
  ) {
    return true;
  }
  const c = node.getAttr('c');
  if (c === 'b') {
    return true;
  }
  // A leaf, or a node that holds inline content (an element whose class
  // declares no `children`, such as a box of text), with no text in its
  // stretch: a block of its own, as readers show it.
  return (c === undefined || c === 'i') && !besideText;
}

/** A quote's inline content as block nodes and runs (see the header). */
function partsOf(root: YNode, units: Unit[]): Part[] {
  // Whether each node unit has text in its stretch of non-block units.
  const isText = (u: Unit) => u.item.content instanceof ContentString;
  const parts: Part[] = [];
  let i = 0;
  while (i < units.length) {
    const u = units[i];
    if (u.item.content instanceof ContentType) {
      // A leaf next to text is inline: look at the stretch it is in.
      let j = i;
      let text = false;
      while (j < units.length) {
        const v = units[j];
        if (isText(v)) {
          text = true;
        } else if (
          v.item.content instanceof ContentType &&
          isBlock(root, v.item, true)
        ) {
          break;
        }
        j++;
      }
      let k = i;
      while (
        k > 0 &&
        !(
          units[k - 1].item.content instanceof ContentType &&
          isBlock(root, units[k - 1].item, true)
        )
      ) {
        if (isText(units[k - 1])) {
          text = true;
        }
        k--;
      }
      if (isBlock(root, u.item, text)) {
        parts.push({block: u.item});
        i++;
        continue;
      }
    }
    const last = parts[parts.length - 1];
    if (last !== undefined && 'run' in last) {
      last.run.push(u);
    } else {
      parts.push({run: [u]});
    }
    i++;
  }
  return parts;
}

/** `y`, a client, `_` and a clock, in base 36: a derived block id. */
function derivedId(client: number, clock: number): string {
  return 'y' + client.toString(36) + '_' + clock.toString(36);
}

/** The id readers derive from a marker or a stored node (its own item). */
const derivedOf = (it: Item): string => derivedId(it.id.client, it.id.clock);

/**
 * The id readers derive for a run of inline content without a marker: from
 * its first unit's item, `_l` when that item is a node.
 */
function runIdOf(first: Unit): string {
  return (
    derivedId(first.item.id.client, first.item.id.clock + first.offset) +
    (first.item.content instanceof ContentType ? '_l' : '')
  );
}

/** The key of the block a marker or a node is (see shownIds). */
const keyOf = (it: Item): string => `${it.id.client}:${it.id.clock}`;

/** The key of the block a run without a marker is (see shownIds). */
const runKeyOf = (first: Unit): string =>
  `r${first.item.id.client}:${first.item.id.clock + first.offset}`;

/**
 * Whether a node of a line class is stored as the line's content: a node
 * that holds blocks (`c` = 'b', a quote that holds paragraphs) is a
 * container, whatever its class.
 */
function isLineNode(root: YNode, node: YNode): boolean {
  return (
    root.getAttr(KIND_PREFIX + nameOfNode(node).slice(2)) === 'line' &&
    node.getAttr('c') !== 'b'
  );
}

/** Whether the root records `node`'s type as a group (a list stored as a node). */
function isGroupNode(root: YNode, node: YNode): boolean {
  const kind = root.getAttr(KIND_PREFIX + nameOfNode(node).slice(2));
  return typeof kind === 'string' && kind.startsWith('group|');
}

/** Sorts attributes by name. */
function sorted(attrs: [string, unknown][]): [string, unknown][] {
  return attrs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `attrs` with the block id set to `id` (left as it is where `id` is null). */
function withBlockId(
  attrs: [string, unknown][],
  id: string | null,
): [string, unknown][] {
  if (id === null) {
    return sorted(attrs);
  }
  return sorted([...attrs.filter(([k]) => k !== BLOCK_ID), [BLOCK_ID, id]]);
}

/**
 * The attributes of the container a quote's marker becomes: the marker's
 * but `t` (the node's name carries the type), the shadow root flag where a
 * node stores it (a field), and `c` = 'b'; the block id the quote shows,
 * where it shows one.
 */
function containerAttrs(marker: YNode, id: string | null): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [key, value] of attrsOf(marker)) {
    if (key === SHADOW_ROOT) {
      out.push([SHADOW_ROOT_FIELD, value]);
    } else if (key !== 't' && !isGroupKey(key)) {
      out.push([key, value]);
    }
  }
  out.push(['c', 'b']);
  return withBlockId(out, id);
}

/**
 * Whether `key` is one of a group line's keys (`g`, `g:<field>`, `l`, `o`),
 * which a quote's marker can carry after concurrent edits and a node does
 * not keep (readers ignore them on a quote).
 */
const isGroupKey = (key: string): boolean =>
  key === 'g' || key === 'l' || key === 'o' || key.startsWith('g:');

/** A node's own attributes (its slots aside), with the block id it shows. */
function nodeAttrs(node: YNode, id: string | null): [string, unknown][] {
  return withBlockId(
    attrsOf(node).filter(([k]) => !k.startsWith(SLOT_PREFIX)),
    id,
  );
}

/**
 * The attributes a node of a line class keeps as a line's marker: its own
 * (but `c`, `t` and its slots), its type as `t` (left out for a
 * paragraph), and the block id it shows.
 */
function markerAttrs(node: YNode, id: string | null): [string, unknown][] {
  const type =
    (node.getAttr('t') as string | undefined) ?? nameOfNode(node).slice(2);
  const out: [string, unknown][] = [];
  for (const [key, value] of attrsOf(node)) {
    if (key !== 'c' && key !== 't' && !key.startsWith(SLOT_PREFIX)) {
      out.push([key, value]);
    }
  }
  if (type !== 'paragraph') {
    out.push(['t', type]);
  }
  return withBlockId(out, id);
}

/** Whether any marker or node under `node` stores a block id. */
export function storesBlockIds(node: YNode): boolean {
  if (node.getAttr(BLOCK_ID) !== undefined) {
    return true;
  }
  for (const it of liveItems(node)) {
    if (it.content instanceof ContentType && storesBlockIds(typeOf(it))) {
      return true;
    }
  }
  for (const [key, value] of attrsOf(node)) {
    if (key.startsWith(SLOT_PREFIX) && value instanceof YNode) {
      if (storesBlockIds(value)) {
        return true;
      }
    }
  }
  return false;
}

/** JSON with object keys sorted (a group key's signature). */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    return JSON.stringify(v) ?? 'null';
  }
  if (Array.isArray(v)) {
    return '[' + v.map(stable).join(',') + ']';
  }
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .sort()
      .map(k => JSON.stringify(k) + ':' + stable(o[k]))
      .join(',') +
    '}'
  );
}

/** Whether `v` is a plain object (a JSON object). */
const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A line of a group, as readers parse its marker in a container that is not
 * itself a group (see GroupLine): `g` names the group's type, `l` its level
 * and `o` the outer levels' keys and wrapper fields (`o[level]['@']`).
 */
type GroupLine = {
  marker: Item;
  level: number;
  gtype: string;
  /** The outer levels' records, when they match the level; else null. */
  outer: Record<string, unknown>[] | null;
};

/** A marker's group line, or null (see GroupLine). */
function groupLineOf(it: Item): GroupLine | null {
  const m = typeOf(it);
  const g = m.getAttr('g');
  if (typeof g !== 'string') {
    return null;
  }
  const raw = m.getAttr('l');
  const o = m.getAttr('o');
  const level =
    typeof raw === 'number' && Number.isInteger(raw) && raw > 0
      ? Array.isArray(o) && o.length === raw
        ? raw
        : Math.min(64, raw)
      : 0;
  const outer =
    level > 0 && Array.isArray(o) && o.length === level && o.every(isPlain)
      ? (o as Record<string, unknown>[])
      : null;
  return {gtype: g, level, marker: it, outer};
}

/**
 * What readers build of consecutive group lines (Reader's $buildGroups and
 * $groupChildren): for each line, the groups and wrapper items (a list item
 * that holds a nested list, with no marker of its own) that start at it, in
 * document order. A group derives its id from its first line's marker and
 * its level (`_g`, `_g1`, …), a wrapper from its nested group's first
 * line's marker and its level (`_w`, `_w1`, …); a wrapper's stored id is in
 * `o[level]['@'].$` of the first line of its nested group that records
 * wrapper fields at that level (`fields`, or -1 for none).
 */
type GroupStart =
  | {kind: 'group'; level: number}
  | {kind: 'wrapper'; level: number; fields: number};

function groupStarts(root: YNode, lines: GroupLine[]): GroupStart[][] {
  const out: GroupStart[][] = lines.map(() => []);
  const keyFields = (gtype: string): string[] => {
    const kind = root.getAttr(KIND_PREFIX + gtype);
    return typeof kind === 'string' && kind.startsWith('group|')
      ? kind
          .slice(6)
          .split(',')
          .filter(f => f !== '')
      : [];
  };
  const keyAt = (x: GroupLine, level: number): string | null => {
    let fields: Record<string, unknown> | null = null;
    if (level === x.level) {
      const m = typeOf(x.marker);
      fields = {};
      for (const f of keyFields(x.gtype)) {
        const v = m.getAttr('g:' + f);
        if (v !== undefined) {
          fields[f] = v;
        }
      }
    } else if (level < x.level && x.outer !== null) {
      const o = x.outer[level];
      fields = {};
      for (const f of keyFields(x.gtype)) {
        if (o[f] !== undefined) {
          fields[f] = o[f];
        }
      }
    }
    return fields === null ? null : x.gtype + '\u0000' + stable(fields);
  };
  const wrapperFields = (x: GroupLine, level: number): boolean =>
    x.outer !== null && isPlain(x.outer[level]['@']);
  const build = (from: number, to: number, level: number) => {
    let i = from;
    while (i < to) {
      let sig = keyAt(lines[i], level);
      let j = i + 1;
      while (j < to) {
        const sj = keyAt(lines[j], level);
        if (
          lines[j].level > level
            ? sj !== null && sig !== null && sj !== sig
            : sj !== sig && sig !== null
        ) {
          break;
        }
        if (sig === null && sj !== null) {
          sig = sj;
        }
        j++;
      }
      out[i].push({kind: 'group', level});
      children(i, j, level);
      i = j;
    }
  };
  const children = (from: number, to: number, level: number) => {
    let i = from;
    while (i < to) {
      if (lines[i].level <= level) {
        i++;
        continue;
      }
      let j = i;
      while (j < to && lines[j].level > level) {
        j++;
      }
      // Each nested group gets a wrapper: find where they start.
      const before = out.map(starts => starts.length);
      build(i, j, level + 1);
      for (let k = i; k < j; k++) {
        const added = out[k].slice(before[k]);
        if (added.some(st => st.kind === 'group' && st.level === level + 1)) {
          let end = k + 1;
          while (
            end < j &&
            !out[end]
              .slice(before[end])
              .some(st => st.kind === 'group' && st.level === level + 1)
          ) {
            end++;
          }
          let fields = -1;
          for (let f = k; f < end; f++) {
            if (wrapperFields(lines[f], level)) {
              fields = f;
              break;
            }
          }
          // Before the nested group it holds.
          out[k].splice(before[k], 0, {fields, kind: 'wrapper', level});
        }
      }
      i = j;
    }
  };
  build(0, lines.length, 0);
  return out;
}

/** The key of a group a line starts (see shownIds). */
const groupKeyOf = (it: Item, level: number): string =>
  `g${level}:${it.id.client}:${it.id.clock}`;

/**
 * The key of the wrapper whose id a line stores at `o[level]['@'].$` (see
 * shownIds): the step writes the id a wrapper shows there when it copies
 * that line.
 */
const wrapperKeyOf = (it: Item, level: number): string =>
  `o${level}:${it.id.client}:${it.id.clock}`;

/** The block id a wrapper's fields store, if any. */
function wrapperStoredId(x: GroupLine, level: number): unknown {
  const w = x.outer === null ? null : x.outer[level]['@'];
  const st = isPlain(w) ? w.$ : null;
  return isPlain(st) ? st.blockId : undefined;
}

/**
 * The group lines of `node`'s lines, by line index, where `node` is a
 * container whose lines can be groups (not itself a group stored as a
 * node); each line's group starts (see groupStarts).
 */
function groupsOf(
  root: YNode,
  node: YNode,
  lines: {end: Item | null}[],
): Map<number, {line: GroupLine; starts: GroupStart[]; run: GroupLine[]}> {
  const out = new Map<
    number,
    {line: GroupLine; starts: GroupStart[]; run: GroupLine[]}
  >();
  if (node !== root && isGroupNode(root, node)) {
    return out;
  }
  let i = 0;
  while (i < lines.length) {
    const run: GroupLine[] = [];
    const at: number[] = [];
    while (i < lines.length) {
      const end = lines[i].end;
      const g =
        end !== null && nameOf(end) === MARKER && !isShadowLine(end)
          ? groupLineOf(end)
          : null;
      if (g === null) {
        break;
      }
      run.push(g);
      at.push(i);
      i++;
    }
    if (run.length === 0) {
      i++;
      continue;
    }
    const starts = groupStarts(root, run);
    at.forEach((index, k) =>
      out.set(index, {line: run[k], run, starts: starts[k]}),
    );
  }
  return out;
}

/**
 * `o` (a group line's outer levels) with the id each wrapper shows written
 * where readers read it (`o[level]['@'].$.blockId`), for the wrappers whose
 * fields this line records (see wrapperKeyOf); `o` itself when none.
 */
function outerWithWrapperIds(
  it: Item,
  o: unknown,
  shown: Shown | null,
): unknown {
  if (shown === null || !Array.isArray(o)) {
    return o;
  }
  let out: unknown[] | null = null;
  for (let level = 0; level < o.length; level++) {
    const id = shown.get(wrapperKeyOf(it, level));
    const entry: unknown = o[level];
    if (id === undefined || !isPlain(entry) || !isPlain(entry['@'])) {
      continue;
    }
    const fields = entry['@'];
    const st = isPlain(fields.$) ? fields.$ : {};
    out = out ?? [...o];
    out[level] = {...entry, '@': {...fields, $: {...st, blockId: id}}};
  }
  return out ?? o;
}

/**
 * Whether a nested stored node is a block readers identify by default
 * (BlockIdExtension's `$defaultIsIdentifiedBlock`), as storage tells it: a
 * leaf (a block decorator), a node of a line class (the root records its
 * type as a line), or a quote stored as a node that holds blocks but is not
 * a shadow root (readers show it as a quote of text). A node of a type the
 * root records as nested that holds inline content (a class that declares
 * no `children`, such as a collapsible's title) is not one, nor is any
 * other node that holds blocks.
 */
function isIdentifiedNested(root: YNode, node: YNode): boolean {
  if (node.getAttr('c') === 'b') {
    // The flag where a node stores it (`p:`), or as a marker does (`s:`).
    return (
      nodeType(node) === 'quote' &&
      node.getAttr(SHADOW_ROOT_FIELD) !== true &&
      node.getAttr(SHADOW_ROOT) !== true
    );
  }
  return node.getAttr('c') === undefined || isLineNode(root, node);
}

/** The id each block shows, by block key (see shownIds). */
export type Shown = ReadonlyMap<string, string>;

/**
 * The id every block of the root shows, by its key (a marker's or a node's
 * item, or a run's first unit), in the rule readers apply (see the header):
 * in document order, every block that a reader identifies by default
 * (BlockIdExtension's `$defaultIsIdentifiedBlock`, as storage tells it:
 * every child of the root; nested, every line, every paragraph a layout 4
 * quote shows around a run of inline content, every line class's node,
 * every leaf, a quote of text stored as a node (see isIdentifiedNested),
 * and every list item that holds only a nested list (`_w`); not a nested
 * group, another node that holds blocks, nor a node of another class that
 * holds inline content) shows its stored id unless a block before it shows
 * that id, else the id derived from its item, else that id followed by
 * `_d`s. A block in a named slot shows its stored id, or the derived one,
 * outside that order. A layout 4 quote that holds paragraphs comes before
 * what it holds.
 */
export function shownIds(root: YNode): Shown {
  const shown = new Map<string, string>();
  const used = new Set<string>();
  const show = (
    key: string,
    stored: unknown,
    derived: string,
    inSlot: boolean,
  ) => {
    const own = typeof stored === 'string' ? stored : undefined;
    if (inSlot) {
      shown.set(key, own ?? derived);
      return;
    }
    let id: string;
    if (own !== undefined && !used.has(own)) {
      id = own;
    } else {
      id = derived;
      while (used.has(id) || id === own) {
        id += '_d';
      }
    }
    used.add(id);
    shown.set(key, id);
  };
  const slots = (node: YNode) => {
    for (const [key, value] of attrsOf(node)) {
      if (key.startsWith(SLOT_PREFIX) && value instanceof YNode) {
        walk(value, true, false);
      }
    }
  };
  // A line's content: a node of a line class in it is a block of its own
  // (a line written inside a line), after the line in document order.
  const content = (units: Unit[], inSlot: boolean) => {
    for (const u of units) {
      if (u.item.content instanceof ContentType && u.offset === 0) {
        const node = typeOf(u.item);
        if (isLineNode(root, node)) {
          show(
            keyOf(u.item),
            node.getAttr(BLOCK_ID),
            derivedOf(u.item),
            inSlot,
          );
          content(
            linesOf(node).flatMap(l => l.units),
            inSlot,
          );
        } else if (node.getAttr('c') === 'b') {
          // A node that holds blocks in a line (a list nested in a list
          // item): its blocks, after the line.
          walk(node, inSlot, false);
        }
        slots(node);
      }
    }
  };
  const block = (it: Item, inSlot: boolean, atRoot: boolean) => {
    const node = typeOf(it);
    if (node.getAttr('c') === 'b') {
      if (atRoot && !inSlot) {
        show(keyOf(it), node.getAttr(BLOCK_ID), derivedOf(it), false);
      } else if (isIdentifiedNested(root, node)) {
        show(keyOf(it), node.getAttr(BLOCK_ID), derivedOf(it), inSlot);
      }
      walk(node, inSlot, false);
    } else {
      if (atRoot || isIdentifiedNested(root, node)) {
        show(keyOf(it), node.getAttr(BLOCK_ID), derivedOf(it), inSlot);
      }
      content(
        linesOf(node).flatMap(l => l.units),
        inSlot,
      );
    }
    slots(node);
  };
  function walk(node: YNode, inSlot: boolean, atRoot: boolean): void {
    const lines = linesOf(node);
    const groups = groupsOf(root, node, lines);
    for (let index = 0; index < lines.length; index++) {
      const {units, end} = lines[index];
      const group = groups.get(index);
      if (group !== undefined) {
        // The groups and wrappers that start at this line, before it.
        for (const start of group.starts) {
          if (start.kind === 'group') {
            // A group is a block readers identify at the root's top level.
            if (atRoot && !inSlot && start.level === 0) {
              const st = typeOf(end!).getAttr('g:$');
              show(
                groupKeyOf(end!, 0),
                isPlain(st) ? st.blockId : undefined,
                derivedOf(end!) + '_g',
                false,
              );
            }
          } else {
            const fields = start.fields < 0 ? null : group.run[start.fields];
            show(
              fields === null
                ? groupKeyOf(end!, start.level) + 'w'
                : wrapperKeyOf(fields.marker, start.level),
              fields === null
                ? undefined
                : wrapperStoredId(fields, start.level),
              derivedOf(end!) + (start.level === 0 ? '_w' : '_w' + start.level),
              inSlot,
            );
          }
        }
      }
      if (end !== null && isShadowLine(end)) {
        const marker = typeOf(end);
        if (atRoot && !inSlot) {
          show(keyOf(end), marker.getAttr(BLOCK_ID), derivedOf(end), false);
        }
        for (const part of partsOf(root, units)) {
          if ('block' in part) {
            block(part.block, inSlot, false);
          } else {
            show(
              runKeyOf(part.run[0]),
              undefined,
              runIdOf(part.run[0]),
              inSlot,
            );
            content(part.run, inSlot);
          }
        }
        continue;
      }
      const name = end === null ? null : nameOf(end);
      if (name === RUN_END) {
        content(units, inSlot);
        continue;
      }
      if (name === MARKER) {
        // The line, then what its content holds.
        show(
          keyOf(end!),
          typeOf(end!).getAttr(BLOCK_ID),
          derivedOf(end!),
          inSlot,
        );
        content(units, inSlot);
        continue;
      }
      if (units.length > 0) {
        // Content no marker ends: a line read as a paragraph.
        show(runKeyOf(units[0]), undefined, runIdOf(units[0]), inSlot);
      }
      content(units, inSlot);
      if (end !== null) {
        block(end, inSlot, atRoot);
      }
    }
  }
  walk(root, false, true);
  return shown;
}

// ---------------------------------------------------------------------------
// The normalized read (readBefore and readAfter)

function valueJSON(v: unknown): string {
  if (v instanceof YNode) {
    return `<${v.name}>`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

function attrsJSON(attrs: [string, unknown][]): string {
  return (
    '{' +
    attrs.map(([k, v]) => JSON.stringify(k) + ':' + valueJSON(v)).join(',') +
    '}'
  );
}

/** A unit's covered values as the frozen writer stores them, as JSON. */
function formatsJSON(values: Values): string {
  if (values.size === 0) {
    return '{}';
  }
  const parts: string[] = [];
  for (const [key, [signature]] of storedUnit(values)) {
    parts.push(JSON.stringify(key) + ':' + signature);
  }
  return '{' + parts.join(',') + '}';
}

/**
 * A line's content as one string: text in runs of equal covered values
 * (each run its text and its values), each node with what it holds.
 */
function contentJSON(units: Unit[], convert: Convert | null): string {
  let out = '';
  let text = '';
  let textFormats = '';
  const flush = () => {
    if (text !== '') {
      out += JSON.stringify(text) + textFormats;
      text = '';
    }
  };
  for (const u of units) {
    const formats = formatsJSON(u.values);
    if (u.item.content instanceof ContentString) {
      if (text !== '' && formats !== textFormats) {
        flush();
      }
      text += u.item.content.str[u.offset];
      textFormats = formats;
      continue;
    }
    flush();
    if (u.item.content instanceof ContentType) {
      const node = typeOf(u.item);
      const inner: string[] = [];
      describe(node, inner, convert);
      const id =
        convert !== null && convert.copying && convert.shown !== null
          ? (convert.shown.get(keyOf(u.item)) ?? null)
          : null;
      out += `${node.name}${attrsJSON(nodeAttrs(node, id))}[${inner.join('|')}]${slotsJSON(node, convert)}${formats}`;
    } else {
      out += JSON.stringify(u.item.content.getContent()[u.offset]) + formats;
    }
  }
  flush();
  return out;
}

function slotsJSON(node: YNode, convert: Convert | null): string {
  const slots: string[] = [];
  for (const [key, value] of attrsOf(node)) {
    if (key.startsWith(SLOT_PREFIX) && value instanceof YNode) {
      const inner: string[] = [];
      describe(value, inner, convert);
      slots.push(
        `${key}=${value.name}${attrsJSON(attrsOf(value).filter(([k]) => !k.startsWith(SLOT_PREFIX)))}[${inner.join('|')}]`,
      );
    }
  }
  return slots.length === 0 ? '' : `(${slots.join(',')})`;
}

/**
 * A marker's attributes as describe reads them: when the step copies it, the
 * block id it shows and the ids of the wrappers it records (see fillCopy).
 */
function markerCopyAttrs(
  end: Item,
  convert: Convert | null,
): [string, unknown][] {
  const node = typeOf(end);
  const shown = convert !== null && convert.copying ? convert.shown : null;
  const attrs = nodeAttrs(
    node,
    shown === null ? null : (shown.get(keyOf(end)) ?? null),
  );
  return attrs.map(([k, v]) =>
    k === 'o' ? [k, outerWithWrapperIds(end, v, shown)] : [k, v],
  );
}

/** How describe reads a root as layout 4 stored it (see describe). */
export type Convert = {
  root: YNode;
  /** The id each block shows, where the root stores block ids. */
  shown: Shown | null;
  /** Inside a block the step copies into a new container. */
  copying: boolean;
};

/**
 * One string per block of `node`'s own sequence, in order, blocks stored
 * as nodes followed by theirs. With `convert` (the root, read as layout 4),
 * a quote that holds blocks is read as the container layout 5 stores, and
 * every block the step writes anew with the id it showed (see shownIds).
 */
export function describe(
  node: YNode,
  out: string[],
  convert: Convert | null,
): void {
  const shownOf = (key: string): string | null =>
    convert !== null && convert.copying && convert.shown !== null
      ? (convert.shown.get(key) ?? null)
      : null;
  // A run without a marker the step gives one (see fillCopy).
  const marksRun = (units: Unit[]): string | null =>
    convert !== null &&
    convert.copying &&
    units.length > 0 &&
    node.getAttr('c') === 'b' &&
    !isGroupNode(convert.root, node)
      ? shownOf(runKeyOf(units[0]))
      : null;
  for (const {units, end} of linesOf(node)) {
    const content = contentJSON(units, convert);
    if (end === null) {
      const id = marksRun(units);
      out.push(
        id === null
          ? `line|none|${content}`
          : `line|${attrsJSON([[BLOCK_ID, id]])}|${content}`,
      );
      continue;
    }
    const name = nameOf(end)!;
    const endNode = typeOf(end);
    if (convert !== null && isShadowLine(end)) {
      const type = (endNode.getAttr('t') as string | undefined) ?? 'paragraph';
      const shown = convert.shown;
      const get = (key: string) =>
        shown === null ? null : (shown.get(key) ?? null);
      out.push(
        `node|${BLOCK_PREFIX}${type}|${attrsJSON(containerAttrs(endNode, get(keyOf(end))))}|`,
      );
      const inner: Convert = {...convert, copying: true};
      for (const part of partsOf(convert.root, units)) {
        if ('block' in part) {
          const block = typeOf(part.block);
          if (isLineNode(convert.root, block)) {
            const text = linesOf(block).flatMap(l => l.units);
            out.push(
              `line|${attrsJSON(markerAttrs(block, get(keyOf(part.block))))}|${contentJSON(text, inner)}`,
            );
          } else {
            out.push(
              `node|${BLOCK_PREFIX}${nameOfNode(block).slice(2)}|${attrsJSON(nodeAttrs(block, get(keyOf(part.block))))}|${slotsJSON(block, inner)}`,
            );
            describe(block, out, inner);
            out.push('end');
          }
        } else {
          const id = get(runKeyOf(part.run[0]));
          out.push(
            `line|${attrsJSON(id === null ? [] : [[BLOCK_ID, id]])}|${contentJSON(part.run, inner)}`,
          );
        }
      }
      out.push('end');
      continue;
    }
    if (name === MARKER || name === RUN_END) {
      out.push(
        `${name === MARKER ? 'line' : 'run'}|${attrsJSON(name === MARKER ? markerCopyAttrs(end, convert) : attrsOf(endNode))}|${content}`,
      );
    } else {
      const id = marksRun(units);
      if (id !== null) {
        out.push(`line|${attrsJSON([[BLOCK_ID, id]])}|${content}`);
      }
      out.push(
        `node|${name}|${attrsJSON(nodeAttrs(endNode, shownOf(keyOf(end))))}|${slotsJSON(endNode, convert)}`,
      );
      if (content !== '' && id === null) {
        out.push(`run|none|${content}`);
      }
      describe(endNode, out, convert);
      out.push('end');
    }
  }
}

// ---------------------------------------------------------------------------
// The structural read (part of readBefore and readAfter)

/** What segments reads with: the root, and the stored ids read so far. */
type Seg = {root: YNode; seen: Set<string>};

/** Whether `id` has the shape of an id readers derive (see derivedId). */
const isDerivedShape = (id: string): boolean =>
  /^y[0-9a-z]+_[0-9a-z]+(_l|_g\d*|_w\d*)?(_d)*$/.test(id);

/**
 * A node's attributes as segments compares them: every name but `c`, `t`,
 * the block id and slots, the shadow root flag under one name wherever it
 * is stored (`s:shadowRoot` on a marker, `p:shadowRoot` on a node); and the
 * stored block id where no block read before it stores the same one and it
 * does not have a derived id's shape (a block whose stored id repeats an
 * earlier one's, or that stores none, shows a derived id, which the step
 * may store: those are compared by describe).
 */
function bagOf(node: YNode, seg: Seg, quote = false): string {
  const out: [string, unknown][] = [];
  for (const [key, value] of attrsOf(node)) {
    if (quote && isGroupKey(key)) {
      // A layout 4 quote's marker reads as the container layout 5 stores,
      // which keeps no group keys (see containerAttrs).
      continue;
    }
    if (key === SHADOW_ROOT || key === SHADOW_ROOT_FIELD) {
      out.push(['shadowRoot', value]);
    } else if (key === BLOCK_ID) {
      if (
        typeof value === 'string' &&
        !isDerivedShape(value) &&
        !seg.seen.has(value)
      ) {
        seg.seen.add(value);
        out.push(['id', value]);
      }
    } else if (key === 'o' && Array.isArray(value)) {
      // A group line's outer levels: a wrapper's stored id (`['@'].$`) is
      // read as a block's (see above).
      out.push([key, value.map(entry => outerEntryOf(entry, seg))]);
    } else if (key !== 'c' && key !== 't' && !key.startsWith(SLOT_PREFIX)) {
      out.push([key, value]);
    }
  }
  return attrsJSON(sorted(out));
}

/** An outer level's record, its wrapper's block id read as bagOf reads one. */
function outerEntryOf(entry: unknown, seg: Seg): unknown {
  if (!isPlain(entry) || !isPlain(entry['@']) || !isPlain(entry['@'].$)) {
    return entry;
  }
  const fields = entry['@'];
  const {blockId, ...rest} = fields.$ as Record<string, unknown>;
  const keep =
    typeof blockId === 'string' &&
    !isDerivedShape(blockId) &&
    !seg.seen.has(blockId);
  if (keep) {
    seg.seen.add(blockId as string);
  }
  const st = keep ? {...rest, blockId} : rest;
  const {$: _drop, ...others} = fields;
  return {
    ...entry,
    '@': Object.keys(st).length === 0 ? others : {...others, $: st},
  };
}

/** A node's type: its replaced type (`t`), else its name without prefix. */
const nodeType = (node: YNode): string =>
  (node.getAttr('t') as string | undefined) ?? nameOfNode(node).slice(2);

/**
 * The root's structure, read apart from describe and the writer: every
 * sequence walked depth first; its text in chunks of equal covered values
 * (as the layout 4 reader reads them, `readPairedFormats`; not through what
 * describe and the writer share), each node (inline or block) after what it
 * holds as `[type bag]`, every marker as `[type bag]` (its `t`, else
 * paragraph), every run end, and a paragraph `[paragraph {}]` wherever a
 * reader shows one that no marker ends (content no marker ends in a
 * container of blocks; in a layout 4 quote that holds paragraphs, each run
 * of inline content between its blocks). A block's bag is read before what
 * it holds (document order, for stored ids). Two documents whose blocks
 * hold the same text with the same formats and NodeState, types,
 * attributes and stored ids (see bagOf) in the same order read the same; a
 * lost paragraph break, a lost empty paragraph, a changed type, attribute,
 * stored id, format or text NodeState, or lost, moved or doubled text reads
 * otherwise. Its only rule shared with the step: a layout 4 quote's marker
 * reads as the container layout 5 stores (`p:shadowRoot` and
 * `s:shadowRoot` read alike).
 */
export function segments(node: YNode, out: string[], root: YNode): void {
  segmentsOf(node, out, {root, seen: new Set()});
  if (node === root && storesBlockIds(root)) {
    out.push('ids|' + idsShown(root).join(','));
  }
}

/**
 * The id every block shows, in document order, read apart from shownIds and
 * the writer (BlockIds' rules, where the root stores a block id anywhere):
 * a block shows its stored id unless a block before it shows that id, else
 * the id derived from its Yjs identity, else that id followed by `_d`s; a
 * block in a named slot shows its stored id, else the derived one, outside
 * that order. Derived: a line's from its marker; a line no marker ends, and
 * a paragraph a layout 4 quote shows around a run of inline content, from
 * the first item (`_l` when it is a node); a block stored as a node from its
 * item (`_g` for a group); a group of lines from its first line's marker and
 * its level (`_g`, `_g1`, …); a list item that holds only a nested list from
 * that list's first line's marker and its level (`_w`, `_w1`, …), stored in
 * `o[level]['@'].$` of a line of the nested list. Blocks that show an id
 * (BlockIdExtension's default `$isIdentifiedBlock`, the model shownIds
 * follows, written again here): the root's children; nested, every line,
 * every paragraph of a layout 4 quote's run, every line class's node
 * (`c` = 'i' and the root records the type as `line`), every leaf (no
 * `c`), a quote stored as a node holding blocks that is not a shadow root
 * (no `p:shadowRoot` or `s:shadowRoot`), and every list item that holds
 * only a nested list; not a nested group, another node that holds blocks,
 * nor a node of another class that holds inline content.
 */
function idsShown(root: YNode): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  const show = (stored: unknown, derived: string, inSlot: boolean) => {
    const own = typeof stored === 'string' ? stored : undefined;
    let id: string;
    if (inSlot) {
      id = own ?? derived;
    } else if (own !== undefined && !used.has(own)) {
      id = own;
    } else {
      id = derived;
      while (used.has(id) || id === own) {
        id += '_d';
      }
    }
    if (!inSlot) {
      used.add(id);
    }
    out.push(id);
  };
  const itemId = (it: Item): string =>
    'y' + it.id.client.toString(36) + '_' + it.id.clock.toString(36);
  const kindOf = (node: YNode): unknown =>
    root.getAttr(KIND_PREFIX + nameOfNode(node).slice(2));
  const isGroupKind = (kind: unknown): boolean =>
    typeof kind === 'string' && kind.startsWith('group|');
  const slotsOf = (node: YNode) => {
    for (const [key, value] of attrsOf(node)) {
      if (key.startsWith(SLOT_PREFIX) && value instanceof YNode) {
        container(value, true, false);
      }
    }
  };
  // Inline content: a line node in it (a line inside a line) and what a
  // node that holds blocks in it holds; slots of every node.
  const inline = (units: Unit[], inSlot: boolean) => {
    for (const u of units) {
      if (!(u.item.content instanceof ContentType) || u.offset !== 0) {
        continue;
      }
      const node = typeOf(u.item);
      if (kindOf(node) === 'line' && node.getAttr('c') !== 'b') {
        show(node.getAttr(BLOCK_ID), itemId(u.item), inSlot);
        inline(
          linesOf(node).flatMap(l => l.units),
          inSlot,
        );
      } else if (node.getAttr('c') === 'b') {
        container(node, inSlot, false);
      }
      slotsOf(node);
    }
  };
  const runId = (units: Unit[]): string => {
    const first = units[0].item;
    return itemId(first) + (first.content instanceof ContentType ? '_l' : '');
  };
  // A node stored as a block.
  const stored = (it: Item, inSlot: boolean, top: boolean) => {
    const node = typeOf(it);
    const kind = kindOf(node);
    // Nested, readers identify a leaf, a line class's node and a quote of
    // text stored as a node (holding blocks, no `p:shadowRoot`); not a node
    // of another class that holds inline content, nor one holding blocks.
    const identified =
      node.getAttr('c') === undefined ||
      (node.getAttr('c') === 'i' && kind === 'line') ||
      (node.getAttr('c') === 'b' &&
        nameOfNode(node) !== '' &&
        ((node.getAttr('t') as string | undefined) ??
          nameOfNode(node).slice(2)) === 'quote' &&
        node.getAttr(SHADOW_ROOT_FIELD) !== true &&
        node.getAttr(SHADOW_ROOT) !== true);
    if (node.getAttr('c') === 'b') {
      if (top && !inSlot) {
        show(
          node.getAttr(BLOCK_ID),
          itemId(it) + (isGroupKind(kind) ? '_g' : ''),
          false,
        );
      } else if (identified) {
        show(node.getAttr(BLOCK_ID), itemId(it), inSlot);
      }
      container(node, inSlot, false);
    } else {
      if (top || identified) {
        show(node.getAttr(BLOCK_ID), itemId(it), inSlot);
      }
      inline(
        linesOf(node).flatMap(l => l.units),
        inSlot,
      );
    }
    slotsOf(node);
  };
  // A layout 4 quote's inline content (see quoteContent).
  const quote = (units: Unit[], inSlot: boolean) => {
    let stretch: Unit[] = [];
    const paragraph = (run: Unit[]) => {
      show(undefined, runId(run), inSlot);
      inline(run, inSlot);
    };
    const close = () => {
      if (stretch.length === 0) {
        return;
      }
      if (stretch.some(u => u.item.content instanceof ContentString)) {
        paragraph(stretch);
      } else {
        let run: Unit[] = [];
        for (const u of stretch) {
          const node =
            u.item.content instanceof ContentType ? typeOf(u.item) : null;
          if (
            node !== null &&
            (node.getAttr('c') === undefined || node.getAttr('c') === 'i')
          ) {
            if (run.length > 0) {
              paragraph(run);
              run = [];
            }
            stored(u.item, inSlot, false);
          } else {
            run.push(u);
          }
        }
        if (run.length > 0) {
          paragraph(run);
        }
      }
      stretch = [];
    };
    for (const u of units) {
      const node =
        u.item.content instanceof ContentType ? typeOf(u.item) : null;
      const kind = node === null ? undefined : kindOf(node);
      if (
        node !== null &&
        (kind === 'line' || isGroupKind(kind) || node.getAttr('c') === 'b')
      ) {
        close();
        stored(u.item, inSlot, false);
      } else {
        stretch.push(u);
      }
    }
    close();
  };
  function container(node: YNode, inSlot: boolean, top: boolean): void {
    const lines = linesOf(node);
    const isGroup = node !== root && isGroupKind(kindOf(node));
    const blocks = node === root || node.getAttr('c') === 'b';
    const starts = isGroup ? new Map() : groupTree(lines);
    lines.forEach(({units, end}, index) => {
      for (const start of starts.get(index) ?? []) {
        if (start.wrapper) {
          show(start.stored, itemId(end!) + start.suffix, inSlot);
        } else if (top && !inSlot && start.level === 0) {
          show(start.stored, itemId(end!) + '_g', false);
        }
      }
      if (end !== null && isShadowLine(end)) {
        if (top && !inSlot) {
          show(typeOf(end).getAttr(BLOCK_ID), itemId(end), false);
        }
        quote(units, inSlot);
        return;
      }
      const name = end === null ? null : nameOf(end);
      if (name === MARKER) {
        show(typeOf(end!).getAttr(BLOCK_ID), itemId(end!), inSlot);
        inline(units, inSlot);
        return;
      }
      if (name !== RUN_END && blocks && units.length > 0) {
        show(undefined, runId(units), inSlot);
      }
      inline(units, inSlot);
      if (end !== null && name !== RUN_END) {
        stored(end, inSlot, top);
      }
    });
  }
  /**
   * Readers' groups of consecutive group lines in a container (Reader's
   * $buildGroups): by line index, the groups (stored id in the first
   * line's `g:$`) and wrapper items that start there, outer first.
   */
  function groupTree(
    lines: {end: Item | null}[],
  ): Map<
    number,
    {wrapper: boolean; level: number; stored: unknown; suffix: string}[]
  > {
    const at = new Map<
      number,
      {wrapper: boolean; level: number; stored: unknown; suffix: string}[]
    >();
    const add = (
      index: number,
      v: {wrapper: boolean; level: number; stored: unknown; suffix: string},
    ) => {
      const list = at.get(index) ?? [];
      list.push(v);
      at.set(index, list);
    };
    type L = {
      index: number;
      m: YNode;
      level: number;
      g: string;
      outer: Record<string, unknown>[] | null;
    };
    const parse = (index: number, end: Item | null): L | null => {
      if (end === null || nameOf(end) !== MARKER || isShadowLine(end)) {
        return null;
      }
      const m = typeOf(end);
      const g = m.getAttr('g');
      if (typeof g !== 'string') {
        return null;
      }
      const l = m.getAttr('l');
      const o = m.getAttr('o');
      const matched =
        Array.isArray(o) && typeof l === 'number' && o.length === l;
      const level =
        typeof l === 'number' && Number.isInteger(l) && l > 0
          ? matched
            ? l
            : Math.min(64, l)
          : 0;
      const outer =
        level > 0 && matched && (o as unknown[]).every(isPlain)
          ? (o as Record<string, unknown>[])
          : null;
      return {g, index, level, m, outer};
    };
    const sig = (x: L, level: number): string | null => {
      const kind = root.getAttr(KIND_PREFIX + x.g);
      const fields =
        typeof kind === 'string' && kind.startsWith('group|')
          ? kind
              .slice(6)
              .split(',')
              .filter(f => f !== '')
          : [];
      const source: ((f: string) => unknown) | null =
        level === x.level
          ? f => x.m.getAttr('g:' + f)
          : level < x.level && x.outer !== null
            ? f => x.outer![level][f]
            : null;
      if (source === null) {
        return null;
      }
      const key: Record<string, unknown> = {};
      for (const f of fields) {
        if (source(f) !== undefined) {
          key[f] = source(f);
        }
      }
      return x.g + '\u0000' + stable(key);
    };
    // Groups at `level` over `xs`; each group's nested runs get wrappers.
    const groups = (xs: L[], level: number) => {
      let i = 0;
      while (i < xs.length) {
        let s = sig(xs[i], level);
        let j = i + 1;
        for (; j < xs.length; j++) {
          const t = sig(xs[j], level);
          const breaks =
            xs[j].level > level
              ? t !== null && s !== null && t !== s
              : t !== s && s !== null;
          if (breaks) {
            break;
          }
          if (s === null && t !== null) {
            s = t;
          }
        }
        const g = xs[i].m.getAttr('g:$');
        add(xs[i].index, {
          level,
          stored: isPlain(g) ? g.blockId : undefined,
          suffix: '',
          wrapper: false,
        });
        nested(xs.slice(i, j), level);
        i = j;
      }
    };
    const nested = (xs: L[], level: number) => {
      let i = 0;
      while (i < xs.length) {
        if (xs[i].level <= level) {
          i++;
          continue;
        }
        let j = i;
        while (j < xs.length && xs[j].level > level) {
          j++;
        }
        // The nested groups, each with a wrapper before it.
        const run = xs.slice(i, j);
        const marks = run.map(x => (at.get(x.index) ?? []).length);
        groups(run, level + 1);
        const firsts = run.filter((x, k) =>
          (at.get(x.index) ?? [])
            .slice(marks[k])
            .some(v => !v.wrapper && v.level === level + 1),
        );
        firsts.forEach((first, f) => {
          const from = run.indexOf(first);
          const to =
            f + 1 < firsts.length ? run.indexOf(firsts[f + 1]) : run.length;
          let wrapperId: unknown;
          for (let k = from; k < to; k++) {
            const o = run[k].outer;
            const w = o === null ? undefined : o[level]['@'];
            if (isPlain(w)) {
              const st = w.$;
              wrapperId = isPlain(st) ? st.blockId : undefined;
              break;
            }
          }
          const list = at.get(first.index)!;
          list.splice(marks[from], 0, {
            level,
            stored: wrapperId,
            suffix: level === 0 ? '_w' : '_w' + level,
            wrapper: true,
          });
        });
        i = j;
      }
    };
    let i = 0;
    while (i < lines.length) {
      const run: L[] = [];
      for (; i < lines.length; i++) {
        const x = parse(i, lines[i].end);
        if (x === null) {
          break;
        }
        run.push(x);
      }
      if (run.length === 0) {
        i++;
      } else {
        groups(run, 0);
      }
    }
    return at;
  }
  container(root, false, true);
  return out;
}

function segmentsOf(node: YNode, out: string[], seg: Seg): void {
  const blocks = node === seg.root || node.getAttr('c') === 'b';
  for (const {units, end} of linesOf(node)) {
    if (end !== null && isShadowLine(end)) {
      const bag = bagOf(typeOf(end), seg, true);
      quoteContent(units, out, seg);
      out.push(`[quote ${bag}]`);
      continue;
    }
    const name = end === null ? null : nameOf(end);
    if (name === MARKER) {
      const marker = typeOf(end!);
      const type = (marker.getAttr('t') as string | undefined) ?? 'paragraph';
      const bag = bagOf(marker, seg);
      unitsOut(units, out, seg);
      out.push(`[${type} ${bag}]`);
      continue;
    }
    unitsOut(units, out, seg);
    if (blocks && name !== RUN_END && units.length > 0) {
      out.push('[paragraph {}]');
    }
    if (end === null) {
      continue;
    }
    if (name === RUN_END) {
      out.push('[run-end]');
    } else {
      nodeOut(typeOf(end), out, seg);
    }
  }
}

/** A node: its bag, then what it holds, its slots, then `[type bag]`. */
function nodeOut(node: YNode, out: string[], seg: Seg): void {
  const bag = bagOf(node, seg);
  segmentsOf(node, out, seg);
  for (const [key, value] of attrsOf(node)) {
    if (key.startsWith(SLOT_PREFIX) && value instanceof YNode) {
      out.push(`(${key}`);
      nodeOut(value, out, seg);
      out.push(')');
    }
  }
  out.push(`[${nodeType(node)} ${bag}]`);
}

/** Covered values as read (`readPairedFormats`), names sorted. */
function valuesOf(values: Values): string {
  if (values.size === 0) {
    return '';
  }
  return JSON.stringify(
    [...values.keys()].sort().map(key => [key, values.get(key)]),
  );
}

/**
 * Text in chunks of equal covered values (split at every node), each node as
 * nodeOut reads it.
 */
function unitsOut(units: Unit[], out: string[], seg: Seg): void {
  let text = '';
  let textValues = '';
  const flush = () => {
    if (text !== '') {
      out.push(JSON.stringify(text) + textValues);
      text = '';
    }
  };
  for (const u of units) {
    if (u.item.content instanceof ContentString) {
      const values = valuesOf(u.values);
      if (values !== textValues) {
        flush();
        textValues = values;
      }
      text += u.item.content.str[u.offset];
      continue;
    }
    flush();
    if (u.item.content instanceof ContentType) {
      nodeOut(typeOf(u.item), out, seg);
    } else {
      out.push('[embed]');
    }
  }
  flush();
}

/**
 * A layout 4 quote's block node with wrapper values on its own unit (a link
 * run a concurrent edit stretched over a paragraph stored as a node, which
 * readers show around it): `<values>`. Layout 5 stores no wrapper around a
 * block of a container, so such a room reads otherwise and the runner
 * refuses it, rather than drop the link (y.md, Limits).
 */
function blockWrappersOut(u: Unit, out: string[]): void {
  const wrappers = new Map(
    [...u.values].filter(([key]) => key.startsWith('w:')),
  );
  if (wrappers.size > 0) {
    out.push('<' + valuesOf(wrappers) + '>');
  }
}

/**
 * The inline content of a layout 4 quote that holds paragraphs: its blocks
 * as nodes, and a paragraph for each stretch of inline content between them
 * (written apart from partsOf: a node is a block when the root records its
 * type as a line or a group, or it holds blocks; in a stretch with no text,
 * each node holding nothing is a block of its own).
 */
function quoteContent(units: Unit[], out: string[], seg: Seg): void {
  const root = seg.root;
  const blockLike = (u: Unit): boolean => {
    if (!(u.item.content instanceof ContentType)) {
      return false;
    }
    const node = typeOf(u.item);
    const kind = root.getAttr(KIND_PREFIX + nameOfNode(node).slice(2));
    return (
      kind === 'line' ||
      (typeof kind === 'string' && kind.startsWith('group|')) ||
      node.getAttr('c') === 'b'
    );
  };
  let stretch: Unit[] = [];
  const close = () => {
    if (stretch.length === 0) {
      return;
    }
    if (stretch.some(u => u.item.content instanceof ContentString)) {
      unitsOut(stretch, out, seg);
      out.push('[paragraph {}]');
    } else {
      // No text: each node holding nothing is a block; nodes that hold
      // content between them are a paragraph.
      let run: Unit[] = [];
      const closeRun = () => {
        if (run.length > 0) {
          unitsOut(run, out, seg);
          out.push('[paragraph {}]');
          run = [];
        }
      };
      for (const u of stretch) {
        const node =
          u.item.content instanceof ContentType ? typeOf(u.item) : null;
        if (
          node !== null &&
          (node.getAttr('c') === undefined || node.getAttr('c') === 'i')
        ) {
          closeRun();
          blockWrappersOut(u, out);
          nodeOut(node, out, seg);
        } else {
          run.push(u);
        }
      }
      closeRun();
    }
    stretch = [];
  };
  for (const u of units) {
    if (blockLike(u)) {
      close();
      blockWrappersOut(u, out);
      nodeOut(typeOf(u.item), out, seg);
    } else {
      stretch.push(u);
    }
  }
  close();
}

// ---------------------------------------------------------------------------
// The writer

/** Insert `content` after `left` in `parent`, as the transaction's client. */
function put(
  tr: Transaction,
  parent: YNode,
  left: Item | null,
  content: Item['content'],
): Item {
  const doc = tr.doc;
  const client = doc.clientID;
  const right = (left === null ? parent._start : left.right) as Item | null;
  const item = new Item(
    createID(client, doc.store.getClock(client)),
    left,
    left && left.lastId,
    right,
    right && right.id,
    parent,
    null,
    content,
  );
  item.integrate(tr, 0);
  return item;
}

/** A unit's content as new content: an empty copy of a node, else the unit. */
function copyUnit(u: Unit): Item['content'] {
  const c = u.item.content;
  if (c instanceof ContentString) {
    return new ContentString(c.str[u.offset]);
  }
  if (c instanceof ContentType) {
    return new ContentType(new YNode(typeOf(u.item).name));
  }
  if (c instanceof ContentAny) {
    return new ContentAny([c.arr[u.offset]]);
  }
  return c.copy();
}

/**
 * Write `units` (with what they were read with) at the end of `parent`'s
 * sequence, after `left`, pushing each unit's values on `values`; returns
 * the last item written. Nodes are copied whole (see fillCopy).
 */
function writeUnits(
  tr: Transaction,
  root: YNode,
  parent: YNode,
  left: Item | null,
  units: Unit[],
  values: Values[],
  shown: Shown | null,
): Item | null {
  let at = left;
  let text = '';
  const flush = () => {
    if (text !== '') {
      at = put(tr, parent, at, new ContentString(text));
      text = '';
    }
  };
  for (const u of units) {
    values.push(u.values);
    if (u.item.content instanceof ContentString) {
      // Consecutive text is written as one item.
      text += u.item.content.str[u.offset];
      continue;
    }
    flush();
    at = put(tr, parent, at, copyUnit(u));
    if (u.item.content instanceof ContentType) {
      fillCopy(tr, root, typeOf(u.item), typeOf(at), shown);
      // A line written inside a line keeps the id it showed.
      const id = shown === null ? undefined : shown.get(keyOf(u.item));
      if (id !== undefined) {
        typeOf(at).setAttr(BLOCK_ID, id);
      }
    }
  }
  flush();
  return at;
}

/** Write a marker after `left` with `attrs`, its unit values empty. */
function putMarker(
  tr: Transaction,
  parent: YNode,
  left: Item | null,
  attrs: [string, unknown][],
  values: Values[],
): Item {
  const at = put(tr, parent, left, new ContentType(new YNode(MARKER)));
  values.push(new Map());
  for (const [key, value] of attrs) {
    typeOf(at).setAttr(key, value as never);
  }
  return at;
}

/**
 * Copy `from`'s attributes, slots and sequence into the new node `to`. With
 * `shown` (the root stores block ids), every block of the sequence that
 * shows an id stores it (see shownIds), and content no marker ends, in a
 * node that holds blocks and is not a group, is ended by a marker that
 * stores the id it showed (it reads as the paragraph it was).
 */
function fillCopy(
  tr: Transaction,
  root: YNode,
  from: YNode,
  to: YNode,
  shown: Shown | null,
): void {
  for (const [key, value] of attrsOf(from)) {
    if (value instanceof YNode) {
      const slot = new YNode(value.name);
      to.setAttr(key, slot);
      fillCopy(tr, root, value, slot, shown);
    } else {
      to.setAttr(key, value as never);
    }
  }
  const marksRuns =
    shown !== null && from.getAttr('c') === 'b' && !isGroupNode(root, from);
  const values: Values[] = [];
  let at: Item | null = null;
  for (const {units, end, endValues} of linesOf(from)) {
    at = writeUnits(tr, root, to, at, units, values, shown);
    const name = end === null ? null : nameOf(end);
    if (marksRuns && units.length > 0 && name !== MARKER && name !== RUN_END) {
      const id = shown!.get(runKeyOf(units[0]));
      if (id !== undefined) {
        at = putMarker(tr, to, at, [[BLOCK_ID, id]], values);
      }
    }
    if (end !== null) {
      at = put(
        tr,
        to,
        at,
        copyUnit({item: end, offset: 0, values: endValues!}),
      );
      values.push(endValues!);
      const copy = typeOf(at);
      fillCopy(tr, root, typeOf(end), copy, shown);
      const id = shown === null ? undefined : shown.get(keyOf(end));
      if (id !== undefined) {
        copy.setAttr(BLOCK_ID, id);
      }
      if (name === MARKER) {
        const o = copy.getAttr('o');
        const patched = outerWithWrapperIds(end, o, shown);
        if (patched !== o) {
          copy.setAttr('o', patched as never);
        }
      }
    }
  }
  copyOtherFormats(tr, from, to);
  writeLayout4Formats(tr, to, values);
}

/**
 * Format items of names layout 4 does not cover (any other name, which the
 * binding never writes) are kept by position: each is written before the
 * unit it was before.
 */
function copyOtherFormats(tr: Transaction, from: YNode, to: YNode): void {
  const targets = liveItems(to).filter(it => it.countable);
  // The countable unit index each item of `to` starts at.
  const starts: number[] = [];
  let n = 0;
  for (const it of targets) {
    starts.push(n);
    n += it.length;
  }
  let at = 0;
  for (const it of liveItems(from)) {
    if (it.countable) {
      at += it.length;
      continue;
    }
    if (it.content instanceof ContentFormat && !isCoveredKey(it.content.key)) {
      const index = starts.findIndex(s => s >= at);
      const left = index <= 0 ? null : (targets[index - 1] as Item);
      const target =
        index === -1 ? (targets[targets.length - 1] ?? null) : left;
      put(tr, to, target, new ContentFormat(it.content.key, it.content.value));
    }
  }
}

/**
 * Rewrite every quote that holds blocks under `node` (in the nodes and slots
 * below it first) as layout 5 stores it, each block it writes anew with the
 * id it shows (`shown`, where the root stores block ids). Returns how many
 * it rewrote.
 */
export function restructure(
  tr: Transaction,
  root: YNode,
  node: YNode,
  shown: Shown | null,
): number {
  let count = 0;
  for (const it of liveItems(node)) {
    if (
      it.content instanceof ContentType &&
      nameOf(it) !== MARKER &&
      nameOf(it) !== RUN_END
    ) {
      count += restructure(tr, root, typeOf(it), shown);
    }
  }
  for (const [key, value] of attrsOf(node)) {
    if (key.startsWith(SLOT_PREFIX) && value instanceof YNode) {
      count += restructure(tr, root, value, shown);
    }
  }
  const lines = linesOf(node).filter(
    l => l.end !== null && isShadowLine(l.end),
  );
  const get = (key: string): string | null =>
    shown === null ? null : (shown.get(key) ?? null);
  for (const {units, end} of lines) {
    const marker = typeOf(end!);
    const type = (marker.getAttr('t') as string | undefined) ?? 'paragraph';
    const left = (units.length > 0 ? units[0].item : end!).left as Item | null;
    const quote = typeOf(
      put(tr, node, left, new ContentType(new YNode(BLOCK_PREFIX + type))),
    );
    for (const [key, value] of containerAttrs(marker, get(keyOf(end!)))) {
      quote.setAttr(key, value as never);
    }
    const inner: Values[] = [];
    let at: Item | null = null;
    for (const part of partsOf(root, units)) {
      if ('block' in part) {
        const block = typeOf(part.block);
        if (isLineNode(root, block)) {
          for (const line of linesOf(block)) {
            at = writeUnits(tr, root, quote, at, line.units, inner, shown);
          }
          at = putMarker(
            tr,
            quote,
            at,
            markerAttrs(block, get(keyOf(part.block))),
            inner,
          );
        } else {
          at = put(
            tr,
            quote,
            at,
            new ContentType(
              new YNode(BLOCK_PREFIX + nameOfNode(block).slice(2)),
            ),
          );
          inner.push(new Map());
          const copy = typeOf(at);
          fillCopy(tr, root, block, copy, shown);
          const id = get(keyOf(part.block));
          if (id !== null) {
            copy.setAttr(BLOCK_ID, id);
          }
        }
      } else {
        at = writeUnits(tr, root, quote, at, part.run, inner, shown);
        const id = get(runKeyOf(part.run[0]));
        at = putMarker(
          tr,
          quote,
          at,
          id === null ? [] : [[BLOCK_ID, id]],
          inner,
        );
      }
    }
    writeLayout4Formats(tr, quote, inner);
    for (const u of units) {
      if (!u.item.deleted) {
        u.item.delete(tr);
      }
    }
    end!.delete(tr);
    count++;
  }
  return count;
}
