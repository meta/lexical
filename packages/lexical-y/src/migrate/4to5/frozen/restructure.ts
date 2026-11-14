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
// such a quote when its marker holds `s:shadowRoot` = true and is not a
// group item (no `g`). In its inline content, a node is a block when the
// root records its type as a line or a group (`k:<type>`), when it holds
// blocks (c = 'b'), or when it is a leaf (no `c`) with no text in the same
// run; text and every other node are inline content, which a reader shows
// as a paragraph per run.

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
  return m.getAttr(SHADOW_ROOT) === true && m.getAttr('g') === undefined;
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
  return c === undefined && !besideText;
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

/** The attributes a block keeps as a line's marker: its own, typed. */
function markerAttrs(node: YNode, ids: boolean, it: Item): [string, unknown][] {
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
  if (ids && node.getAttr(BLOCK_ID) === undefined) {
    out.push([BLOCK_ID, derivedId(it.id.client, it.id.clock)]);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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

function unitJSON(u: Unit): string {
  const parts: string[] = [];
  for (const [key, [signature]] of storedUnit(u.values)) {
    parts.push(JSON.stringify(key) + ':' + signature);
  }
  const formats = '{' + parts.join(',') + '}';
  if (u.item.content instanceof ContentString) {
    return JSON.stringify(u.item.content.str[u.offset]) + formats;
  }
  if (u.item.content instanceof ContentType) {
    const node = typeOf(u.item);
    const inner: string[] = [];
    describe(node, inner, null);
    return `${node.name}${attrsJSON(attrsOf(node).filter(([k]) => !k.startsWith(SLOT_PREFIX)))}[${inner.join('|')}]${slotsJSON(node)}${formats}`;
  }
  return JSON.stringify(u.item.content.getContent()[u.offset]) + formats;
}

function slotsJSON(node: YNode): string {
  const slots: string[] = [];
  for (const [key, value] of attrsOf(node)) {
    if (key.startsWith(SLOT_PREFIX) && value instanceof YNode) {
      const inner: string[] = [];
      describe(value, inner, null);
      slots.push(
        `${key}=${value.name}${attrsJSON(attrsOf(value).filter(([k]) => !k.startsWith(SLOT_PREFIX)))}[${inner.join('|')}]`,
      );
    }
  }
  return slots.length === 0 ? '' : `(${slots.join(',')})`;
}

/**
 * One string per block of `node`'s own sequence, in order, blocks stored
 * as nodes followed by theirs. With `convert` (the root, read as layout 4),
 * a quote that holds blocks is read as the container layout 5 stores.
 */
export function describe(
  node: YNode,
  out: string[],
  convert: {root: YNode; ids: boolean} | null,
): void {
  for (const {units, end} of linesOf(node)) {
    const content = units.map(u => unitJSON(u)).join('');
    if (end === null) {
      out.push(`line|none|${content}`);
      continue;
    }
    const name = nameOf(end)!;
    const endNode = typeOf(end);
    if (convert !== null && isShadowLine(end)) {
      const type = (endNode.getAttr('t') as string | undefined) ?? 'paragraph';
      const attrs: [string, unknown][] = [
        ...attrsOf(endNode).filter(([k]) => k !== 't'),
        ['c', 'b'],
      ];
      attrs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      out.push(`node|${BLOCK_PREFIX}${type}|${attrsJSON(attrs)}|`);
      for (const part of partsOf(convert.root, units)) {
        if ('block' in part) {
          const block = typeOf(part.block);
          const kind = convert.root.getAttr(
            KIND_PREFIX + nameOfNode(block).slice(2),
          );
          if (kind === 'line') {
            const inner = linesOf(block).flatMap(l => l.units);
            out.push(
              `line|${attrsJSON(markerAttrs(block, convert.ids, part.block))}|${inner.map(u => unitJSON(u)).join('')}`,
            );
          } else {
            out.push(
              `node|${BLOCK_PREFIX}${nameOfNode(block).slice(2)}|${attrsJSON(attrsOf(block).filter(([k]) => !k.startsWith(SLOT_PREFIX)))}|${slotsJSON(block)}`,
            );
            describe(block, out, convert);
            out.push('end');
          }
        } else {
          const first = part.run[0].item;
          const runAttrs: [string, unknown][] = convert.ids
            ? [
                [
                  BLOCK_ID,
                  derivedId(
                    first.id.client,
                    first.id.clock + part.run[0].offset,
                  ),
                ],
              ]
            : [];
          out.push(
            `line|${attrsJSON(runAttrs)}|${part.run.map(u => unitJSON(u)).join('')}`,
          );
        }
      }
      out.push('end');
      continue;
    }
    if (name === MARKER || name === RUN_END) {
      out.push(
        `${name === MARKER ? 'line' : 'run'}|${attrsJSON(attrsOf(endNode))}|${content}`,
      );
    } else {
      out.push(
        `node|${name}|${attrsJSON(attrsOf(endNode).filter(([k]) => !k.startsWith(SLOT_PREFIX)))}|${slotsJSON(endNode)}`,
      );
      if (content !== '') {
        out.push(`run|none|${content}`);
      }
      describe(endNode, out, convert);
      out.push('end');
    }
  }
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
  parent: YNode,
  left: Item | null,
  units: Unit[],
  values: Values[],
): Item | null {
  let at = left;
  for (const u of units) {
    at = put(tr, parent, at, copyUnit(u));
    values.push(u.values);
    if (u.item.content instanceof ContentType) {
      fillCopy(tr, typeOf(u.item), typeOf(at));
    }
  }
  return at;
}

/** Copy `from`'s attributes, slots and sequence into the new node `to`. */
function fillCopy(tr: Transaction, from: YNode, to: YNode): void {
  for (const [key, value] of attrsOf(from)) {
    if (value instanceof YNode) {
      const slot = new YNode(value.name);
      to.setAttr(key, slot);
      fillCopy(tr, value, slot);
    } else {
      to.setAttr(key, value as never);
    }
  }
  const values: Values[] = [];
  let at: Item | null = null;
  for (const {units, end, endValues} of linesOf(from)) {
    at = writeUnits(tr, to, at, units, values);
    if (end !== null) {
      at = writeUnits(
        tr,
        to,
        at,
        [{item: end, offset: 0, values: endValues!}],
        values,
      );
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
 * Rewrite every quote that holds blocks under `node` (and in the nodes and
 * slots below it) as layout 5 stores it. Returns how many it rewrote.
 */
export function restructure(
  tr: Transaction,
  root: YNode,
  node: YNode,
  ids: boolean,
): number {
  let count = 0;
  for (const it of liveItems(node)) {
    if (
      it.content instanceof ContentType &&
      nameOf(it) !== MARKER &&
      nameOf(it) !== RUN_END
    ) {
      count += restructure(tr, root, typeOf(it), ids);
    }
  }
  for (const [key, value] of attrsOf(node)) {
    if (key.startsWith(SLOT_PREFIX) && value instanceof YNode) {
      count += restructure(tr, root, value, ids);
    }
  }
  const lines = linesOf(node).filter(
    l => l.end !== null && isShadowLine(l.end),
  );
  if (lines.length === 0) {
    return count;
  }
  for (const {units, end} of lines) {
    const marker = typeOf(end!);
    const type = (marker.getAttr('t') as string | undefined) ?? 'paragraph';
    const left = (units.length > 0 ? units[0].item : end!).left as Item | null;
    const quote = typeOf(
      put(tr, node, left, new ContentType(new YNode(BLOCK_PREFIX + type))),
    );
    for (const [key, value] of attrsOf(marker)) {
      if (key !== 't') {
        quote.setAttr(key, value as never);
      }
    }
    quote.setAttr('c', 'b');
    const inner: Values[] = [];
    let at: Item | null = null;
    for (const part of partsOf(root, units)) {
      if ('block' in part) {
        const block = typeOf(part.block);
        const kind = root.getAttr(KIND_PREFIX + nameOfNode(block).slice(2));
        if (kind === 'line') {
          for (const line of linesOf(block)) {
            at = writeUnits(tr, quote, at, line.units, inner);
          }
          at = put(tr, quote, at, new ContentType(new YNode(MARKER)));
          inner.push(new Map());
          for (const [key, value] of markerAttrs(block, ids, part.block)) {
            typeOf(at).setAttr(key, value as never);
          }
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
          fillCopy(tr, block, typeOf(at));
        }
      } else {
        at = writeUnits(tr, quote, at, part.run, inner);
        at = put(tr, quote, at, new ContentType(new YNode(MARKER)));
        inner.push(new Map());
        if (ids) {
          const first = part.run[0];
          typeOf(at).setAttr(
            BLOCK_ID,
            derivedId(first.item.id.client, first.item.id.clock + first.offset),
          );
        }
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
