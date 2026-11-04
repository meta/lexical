/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Test-only helpers for cells that store format items straight into a
// binding's document (as a raw writer, or a client of a later layout does)
// and compare how every reader takes them: the editor that reads the item
// as a change, a peer, fresh readers loaded from a JSON (V1) and a binary
// (V2) update, the binding's fold and Layout3's pure reader.

import {$createLinkNode, $isLinkNode} from '@lexical/link';
import * as Y from '@y/y';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
} from 'lexical';

import {covered, isShadowKey, stepFormat} from '../../internal/Ident';
import {readLayout3Formats} from '../../internal/Layout3';
import {flush, Peer} from './harness';

/** A family of covered names, and how the editor shows one of its runs. */
export type Family = {
  key: string;
  /** A value a raw writer stores (an unpaired run). */
  raw: unknown;
  /** Text `text` with the family's value, built by the editor. */
  $node: (text: string) => LexicalNode;
};

export const FAMILIES: readonly Family[] = [
  {
    $node: text => $createTextNode(text).setFormat('bold'),
    key: 'f:bold',
    raw: true,
  },
  {
    $node: text => $createTextNode(text).setStyle('color: red;'),
    key: 'p:style',
    raw: 'color: red;',
  },
  {
    $node: text =>
      $createLinkNode('https://x.test').append($createTextNode(text)),
    key: 'w:link',
    raw: {url: 'https://x.test'},
  },
];

/** Where a stored item goes: a line, and right before which of its text. */
export type Scenario = {
  name: string;
  /** The line's content, as the seed writes it. */
  $line: (family: Family) => LexicalNode[];
  /** Right before this text. */
  at: string;
  /** Raw items stored before the item (an unpaired run). */
  before?: (peer: Peer, family: Family) => void;
};

export const SCENARIOS: readonly Scenario[] = [
  {$line: () => [$createTextNode('abcd')], at: 'cd', name: 'alone'},
  {
    $line: f => [f.$node('ab'), $createTextNode('cd'), f.$node('ef')],
    at: 'd',
    name: 'between paired runs',
  },
  {$line: f => [f.$node('abcd')], at: 'cd', name: 'inside a paired run'},
  {
    $line: () => [$createTextNode('abcd')],
    at: 'cd',
    before: (peer, f) => storeBefore(peer, 'ab', f.key, f.raw),
    name: 'inside an unpaired run',
  },
];

export const rootOf = (peer: Peer): Y.Node => peer.doc.get('lexical-y');

/**
 * Store a format item `key`=`value` right before the first `text` of the
 * root's own sequence, in a transaction of no binding.
 */
export function storeBefore(
  peer: Peer,
  text: string,
  key: string,
  value: unknown,
): Y.Item {
  const doc = peer.doc;
  let item: Y.Item | null = null;
  doc.transact(tr => {
    let right: Y.Item | null = null;
    for (let it = rootOf(peer)._start; it; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentString) {
        const at = it.content.str.indexOf(text);
        if (at >= 0) {
          right =
            at === 0
              ? it
              : Y.getItemCleanStart(
                  tr,
                  Y.createID(it.id.client, it.id.clock + at),
                );
          break;
        }
      }
    }
    if (right === null) {
      throw new Error(`no text ${text}`);
    }
    const left: Y.Item | null = right.left;
    item = new Y.Item(
      Y.createID(doc.clientID, doc.store.getClock(doc.clientID)),
      left,
      left && left.lastId,
      right,
      right.id,
      rootOf(peer),
      null,
      new Y.ContentFormat(key, value as object),
    );
    item.integrate(tr, 0);
  }, 'raw');
  return item!;
}

/**
 * An orphan end of `key` right before `text`: `[client, clock]` naming the
 * first unit of the text (content, not an opener). The grammar's reading of
 * an end whose run is not open.
 */
export function storeOrphanEndBefore(
  peer: Peer,
  text: string,
  key: string,
): void {
  for (let it = rootOf(peer)._start; it; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentString) {
      const at = it.content.str.indexOf(text);
      if (at >= 0) {
        storeBefore(peer, text, key, [it.id.client, it.id.clock + at]);
        return;
      }
    }
  }
  throw new Error(`no text ${text}`);
}

/** The first line as text runs: format, style and links, by value. */
export function lineView(peer: Peer): string {
  const $show = (node: LexicalNode): string => {
    if ($isTextNode(node)) {
      const format = node.getFormat();
      const style = node.getStyle();
      return (
        JSON.stringify(node.getTextContent()) +
        (format ? `{${format}}` : '') +
        (style ? `[${style}]` : '')
      );
    }
    if ($isLinkNode(node)) {
      return `link<${node.getURL()}>(${node.getChildren().map($show).join(' ')})`;
    }
    return $isElementNode(node)
      ? `${node.getType()}(${node.getChildren().map($show).join(' ')})`
      : node.getType();
  };
  return peer.read(() =>
    ($getRoot().getFirstChildOrThrow() as ElementNode)
      .getChildren()
      .map($show)
      .join(' '),
  );
}

/** The binding's fold per countable unit of `root`, covered keys only. */
export function coreRead(root: Y.Node): Record<string, unknown>[] {
  const formats = new Map<string, unknown>();
  const out: Record<string, unknown>[] = [];
  for (let it = root._start; it; it = it.right) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof Y.ContentFormat) {
      stepFormat(formats, it);
    } else if (it.countable) {
      const unit = Object.fromEntries(
        [...formats].filter(([k]) => covered(k) && !isShadowKey(k)),
      );
      for (let i = 0; i < it.length; i++) {
        out.push(unit);
      }
    }
  }
  return out;
}

/** Layout3's pure read per countable unit of `root`. */
export const pureRead = (root: Y.Node): Record<string, unknown>[] =>
  readLayout3Formats(root).map(m => Object.fromEntries(m));

/** A fresh reader of `from`'s state sent as a binary (V2) update. */
export async function freshReaderV2(from: Peer): Promise<Peer> {
  const net = {delivery: 'causal', peers: [], pumping: false, queue: []};
  const peer = new Peer(
    98,
    net as unknown as ConstructorParameters<typeof Peer>[1],
    from.nodes,
    from.prepare,
    from.withBlockIds,
    from.gc,
  );
  Y.applyUpdateV2(peer.doc, Y.encodeStateAsUpdateV2(from.doc), 'load');
  peer.binding.initialize();
  await flush();
  return peer;
}

/**
 * A document holding "ab" with `key`=`value` stored over "a", read back
 * after a JSON (V1) and a binary (V2) update: the value each holds.
 */
export function transported(
  gc: boolean,
  key: string,
  value: unknown,
): {docs: Y.Doc[]; values: unknown[]} {
  const doc = new Y.Doc({gc});
  doc.cleanupFormatting = false;
  doc.get('c').insert(0, 'ab');
  doc.get('c').format(0, 1, {[key]: value});
  const v1 = new Y.Doc({gc});
  Y.applyUpdate(v1, Y.encodeStateAsUpdate(doc));
  const v2 = new Y.Doc({gc});
  Y.applyUpdateV2(v2, Y.encodeStateAsUpdateV2(doc));
  const valueIn = (d: Y.Doc) => {
    for (let it = d.get('c')._start; it; it = it.right) {
      if (it.content instanceof Y.ContentFormat && !it.deleted) {
        return it.content.value as unknown;
      }
    }
    throw new Error('no format item');
  };
  const docs = [doc, v1, v2];
  return {docs, values: docs.map(valueIn)};
}
