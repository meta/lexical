/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The layout 3 seed (D22 under layout 3): the seed's own pass writes each
// container's covered formats as canonical runs interleaved with its content
// (Cursor#insert, Ident.seedRunsOf). It is the one layout 3 seed path, so its
// bytes are golden: every admitted seeder at a seed layout writes the same
// bytes for the same content, and a change to them needs a seed-format bump.
// It is structurally identical to writeLayout3Formats's output for the same
// values: the same openers and ends at the same places relative to the
// content, every end naming the same opener, the same reads (only clocks,
// origins and end distances differ).

import {$createLinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createMarkNode} from '@lexical/mark';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc} from '../..';
import {readYState, seedYState} from '../../headless';
import {covered} from '../../internal/Ident';
import {readLayout3Formats, writeLayout3Formats} from '../../internal/Layout3';
import {$createBoxNode, NODES} from '../utils/harness';

const config = {nodes: NODES, onWarn: () => {}, schemaVersion: 1};

const $t = (text: string, format = 0, style = '') =>
  $createTextNode(text).setFormat(format).setStyle(style);
const BOLD = 1;
const ITALIC = 2;

const SHAPES: [string, () => LexicalNode[]][] = [
  [
    'overlapping keys and styles',
    () => [
      $createParagraphNode().append(
        $t('ab', BOLD),
        $t('cd', BOLD | ITALIC),
        $t('ef', ITALIC, 'color: red'),
        $t('gh', 0, 'color: red'),
        $t('ij'),
      ),
    ],
  ],
  [
    'wrappers and marks',
    () => [
      $createParagraphNode().append(
        $createLinkNode('https://x.test').append($t('ab'), $t('cd', BOLD)),
        $createMarkNode(['c1']).append($t('ef', BOLD)),
        $t('gh'),
      ),
    ],
  ],
  [
    'nested containers',
    () => [
      $createHeadingNode('h1').append($t('title', ITALIC)),
      $createQuoteNode().append($t('q', ITALIC), $t('r')),
      $createListNode('bullet').append(
        $createListItemNode().append($t('one', BOLD)),
        $createListItemNode().append($t('two', BOLD)),
      ),
      $createBoxNode('blue').append(
        $createParagraphNode().append($t('in box', BOLD)),
      ),
    ],
  ],
  [
    'table',
    () => [
      $createTableNode().append(
        $createTableRowNode().append(
          $createTableCellNode().append(
            $createParagraphNode().append($t('a1', BOLD)),
          ),
          $createTableCellNode().append(
            $createParagraphNode().append($t('a2', BOLD)),
          ),
        ),
        $createTableRowNode().append(
          $createTableCellNode().append(
            $createParagraphNode().append($t('b1')),
          ),
          $createTableCellNode().append(
            $createParagraphNode().append($t('b2', ITALIC)),
          ),
        ),
      ),
    ],
  ],
  [
    'a tab and a line break',
    () => [
      $createParagraphNode().append(
        $t('x', BOLD),
        $createTabNode().setFormat(BOLD),
        $t('y', BOLD),
        $createLineBreakNode(),
        $t('z', BOLD),
      ),
    ],
  ],
];

/** Every container under `node`, in document order (sequence, then map). */
function containers(node: Y.Node, out: Y.Node[] = []): Y.Node[] {
  out.push(node);
  for (
    let it = node._start as Y.Item | null;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    const c = it.content as unknown as {type?: unknown};
    if (!it.deleted && c.type instanceof Y.Node) {
      containers(c.type, out);
    }
  }
  for (const key of [...node._map.keys()].sort()) {
    const it = node._map.get(key)!;
    const c = it.content as unknown as {type?: unknown};
    if (!it.deleted && c.type instanceof Y.Node) {
      containers(c.type, out);
    }
  }
  return out;
}

/**
 * A container's covered layout relative to its content: one `u` per
 * countable unit, each covered item as `{key=value}`, an end as
 * `{key=>n}` (n: its opener's position in this list).
 */
function structure(container: Y.Node): string[] {
  const out: string[] = [];
  const at = new Map<string, number>();
  for (
    let it = container._start as Y.Item | null;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof Y.ContentFormat) {
      const {key, value} = it.content;
      if (!covered(key)) {
        continue;
      }
      if (Array.isArray(value) && value.length > 0) {
        const opener =
          value.length === 1
            ? `${it.id.client}:${it.id.clock - (value[0] as number)}`
            : `${value[0]}:${value[1]}`;
        out.push(`{${key}=>${at.get(opener) ?? '?'}}`);
      } else {
        at.set(`${it.id.client}:${it.id.clock}`, out.length);
        out.push(`{${key}=${JSON.stringify(value)}}`);
      }
    } else if (it.countable) {
      for (let i = 0; i < it.length; i++) {
        out.push('u');
      }
    }
  }
  return out;
}

const fresh = (state: Uint8Array) =>
  readYState(state, config, () => JSON.stringify($getRoot().exportJSON()));

/**
 * Golden seed bytes per shape (base64), the canonical (full-map) form: a
 * change to them at layout 3 needs a seed-format bump.
 */
const GOLDEN: Record<string, string> = {
  'a tab and a line break':
    'ARaXpqvEnfqLCQAoAQlsZXhpY2FsLXkLbGV4aWNhbC15OjEBeCgBCWxleGljYWwteQtsZXhpY2FsLXk6MwF4KAEJbGV4aWNhbC15EmxleGljYWwteS1zY2hlbWE6MQF4KAEJbGV4aWNhbC15C2s6cGFyYWdyYXBoAXcEbGluZQYBCWxleGljYWwteQZmOmJvbGQEdHJ1ZYSXpqvEnfqLCQQBeIaXpqvEnfqLCQUGZjpib2xkA1syXYaXpqvEnfqLCQYGZjpib2xkBHRydWWGl6arxJ36iwkHAWsPIjFlZWt1dzhwdmRqLjQihpemq8Sd+osJCAF0BSJ0YWIihJemq8Sd+osJCQEJhpemq8Sd+osJCgZmOmJvbGQDWzRdhpemq8Sd+osJCwFrA1s0XYaXpqvEnfqLCQwBdANbNF2Gl6arxJ36iwkNBmY6Ym9sZAR0cnVlhJemq8Sd+osJDgF5hpemq8Sd+osJDwZmOmJvbGQDWzJdhJemq8Sd+osJEAEKhpemq8Sd+osJEQZmOmJvbGQEdHJ1ZYSXpqvEnfqLCRIBeoaXpqvEnfqLCRMGZjpib2xkA1syXYeXpqvEnfqLCRQDAsK2AA==',
  'nested containers':
    'ASvpl56r7dd2ACgBCWxleGljYWwteQtsZXhpY2FsLXk6MQF4KAEJbGV4aWNhbC15C2xleGljYWwteTozAXgoAQlsZXhpY2FsLXkSbGV4aWNhbC15LXNjaGVtYToxAXgoAQlsZXhpY2FsLXkJazpoZWFkaW5nAXcEbGluZSgBCWxleGljYWwteQdrOnF1b3RlAXcEbGluZSgBCWxleGljYWwteQZrOmxpc3QBdw5ncm91cHxsaXN0VHlwZSgBCWxleGljYWwteQprOmxpc3RpdGVtAXcEbGluZSgBCWxleGljYWwteQprOnRlc3RfYm94AXcGbmVzdGVkKAEJbGV4aWNhbC15C2s6cGFyYWdyYXBoAXcEbGluZQYBCWxleGljYWwteQhmOml0YWxpYwR0cnVlhOmXnqvt13YJBXRpdGxlhumXnqvt13YOCGY6aXRhbGljA1s2XYfpl56r7dd2DwMCwraG6Zeeq+3XdhAIZjppdGFsaWMEdHJ1ZYTpl56r7dd2EQFxhumXnqvt13YSCGY6aXRhbGljA1syXYTpl56r7dd2EwFyh+mXnqvt13YUAwLCtobpl56r7dd2FQZmOmJvbGQEdHJ1ZYTpl56r7dd2FgNvbmWG6Zeeq+3XdhkGZjpib2xkA1s0XYfpl56r7dd2GgMCwraG6Zeeq+3XdhsGZjpib2xkBHRydWWE6Zeeq+3XdhwDdHdvhumXnqvt13YfBmY6Ym9sZANbNF2H6Zeeq+3XdiADAsK2KADpl56r7dd2EAF0AXcHaGVhZGluZygA6Zeeq+3XdhUBdAF3BXF1b3RlKADpl56r7dd2GwF0AXcIbGlzdGl0ZW0oAOmXnqvt13YbAWcBdwRsaXN0KADpl56r7dd2GwpnOmxpc3RUeXBlAXcGYnVsbGV0KADpl56r7dd2GwFsAX0AKADpl56r7dd2IQF0AXcIbGlzdGl0ZW0oAOmXnqvt13YhAWcBdwRsaXN0KADpl56r7dd2IQpnOmxpc3RUeXBlAXcGYnVsbGV0KADpl56r7dd2IQFsAX0Ah+mXnqvt13YhAwpiOnRlc3RfYm94KADpl56r7dd2LAZwOnRvbmUBdwRibHVlKADpl56r7dd2LAFjAXcBYgYA6Zeeq+3XdiwGZjpib2xkBHRydWWE6Zeeq+3Xdi8GaW4gYm94humXnqvt13Y1BmY6Ym9sZANbN12H6Zeeq+3XdjYDAsK2AA==',
  'overlapping keys and styles':
    'ARaw+5y16JjqCwAoAQlsZXhpY2FsLXkLbGV4aWNhbC15OjEBeCgBCWxleGljYWwteQtsZXhpY2FsLXk6MwF4KAEJbGV4aWNhbC15EmxleGljYWwteS1zY2hlbWE6MQF4KAEJbGV4aWNhbC15C2s6cGFyYWdyYXBoAXcEbGluZQYBCWxleGljYWwteQZmOmJvbGQEdHJ1ZYSw+5y16JjqCwQCYWKGsPucteiY6gsGBmY6Ym9sZANbM12GsPucteiY6gsHBmY6Ym9sZAR0cnVlhrD7nLXomOoLCAhmOml0YWxpYwR0cnVlhLD7nLXomOoLCQJjZIaw+5y16JjqCwsGZjpib2xkA1s0XYaw+5y16JjqCwwIZjppdGFsaWMDWzRdhrD7nLXomOoLDQhmOml0YWxpYwR0cnVlhrD7nLXomOoLDgdwOnN0eWxlDCJjb2xvcjogcmVkIoSw+5y16JjqCw8CZWaGsPucteiY6gsRCGY6aXRhbGljA1s0XYaw+5y16JjqCxIHcDpzdHlsZQNbNF2GsPucteiY6gsTB3A6c3R5bGUMImNvbG9yOiByZWQihLD7nLXomOoLFAJnaIaw+5y16JjqCxYHcDpzdHlsZQNbM12EsPucteiY6gsXAmlqh7D7nLXomOoLGQMCwrYA',
  table:
    'ASPQ5Nuak+KNDQAoAQlsZXhpY2FsLXkLbGV4aWNhbC15OjEBeCgBCWxleGljYWwteQtsZXhpY2FsLXk6MwF4KAEJbGV4aWNhbC15EmxleGljYWwteS1zY2hlbWE6MQF4KAEJbGV4aWNhbC15B2s6dGFibGUBdwZuZXN0ZWQoAQlsZXhpY2FsLXkKazp0YWJsZXJvdwF3Bm5lc3RlZCgBCWxleGljYWwteQtrOnRhYmxlY2VsbAF3Bm5lc3RlZCgBCWxleGljYWwteQtrOnBhcmFncmFwaAF3BGxpbmUHAQlsZXhpY2FsLXkDB2I6dGFibGUoANDk25qT4o0NBwFjAXcBYgcA0OTbmpPijQ0HAwpiOnRhYmxlcm93KADQ5Nuak+KNDQkBYwF3AWIHANDk25qT4o0NCQMLYjp0YWJsZWNlbGwoANDk25qT4o0NCwFjAXcBYgYA0OTbmpPijQ0LBmY6Ym9sZAR0cnVlhNDk25qT4o0NDQJhMYbQ5Nuak+KNDQ8GZjpib2xkA1szXYfQ5Nuak+KNDRADAsK2h9Dk25qT4o0NCwMLYjp0YWJsZWNlbGwoANDk25qT4o0NEgFjAXcBYgYA0OTbmpPijQ0SBmY6Ym9sZAR0cnVlhNDk25qT4o0NFAJhMobQ5Nuak+KNDRYGZjpib2xkA1szXYfQ5Nuak+KNDRcDAsK2h9Dk25qT4o0NCQMKYjp0YWJsZXJvdygA0OTbmpPijQ0ZAWMBdwFiBwDQ5Nuak+KNDRkDC2I6dGFibGVjZWxsKADQ5Nuak+KNDRsBYwF3AWIEANDk25qT4o0NGwJiMYfQ5Nuak+KNDR4DAsK2h9Dk25qT4o0NGwMLYjp0YWJsZWNlbGwoANDk25qT4o0NIAFjAXcBYgYA0OTbmpPijQ0gCGY6aXRhbGljBHRydWWE0OTbmpPijQ0iAmIyhtDk25qT4o0NJAhmOml0YWxpYwNbM12H0OTbmpPijQ0lAwLCtgA=',
  'wrappers and marks':
    'ARbPlsmc1K+/BgAoAQlsZXhpY2FsLXkLbGV4aWNhbC15OjEBeCgBCWxleGljYWwteQtsZXhpY2FsLXk6MwF4KAEJbGV4aWNhbC15EmxleGljYWwteS1zY2hlbWE6MQF4KAEJbGV4aWNhbC15C2s6cGFyYWdyYXBoAXcEbGluZSgBCWxleGljYWwteQZrOmxpbmsBdxtmb3JtYXR8dXJsLHRhcmdldCxyZWwsdGl0bGUoAQlsZXhpY2FsLXkGazptYXJrAXcGbmVzdGVkBgEJbGV4aWNhbC15Bnc6bGluaxh7InVybCI6Imh0dHBzOi8veC50ZXN0In2Ez5bJnNSvvwYGAmFihs+WyZzUr78GCAZ3OmxpbmsDWzNdhs+WyZzUr78GCQZmOmJvbGQEdHJ1ZYbPlsmc1K+/BgoGdzpsaW5rGHsidXJsIjoiaHR0cHM6Ly94LnRlc3QifYTPlsmc1K+/BgsCY2SGz5bJnNSvvwYNBmY6Ym9sZANbNF2Gz5bJnNSvvwYOBnc6bGluawNbNF2Hz5bJnNSvvwYPAwZpOm1hcmsoAM+WyZzUr78GEAVwOmlkcwF1AXcCYzEoAM+WyZzUr78GEAFjAXcBaQYAz5bJnNSvvwYQBmY6Ym9sZAR0cnVlhM+WyZzUr78GEwJlZoTPlsmc1K+/BhACZ2iHz5bJnNSvvwYXAwLCtobPlsmc1K+/BhUGZjpib2xkA1s2XQA=',
};

describe('the layout 3 seed', () => {
  for (const [name, $build] of SHAPES) {
    test(`${name}: golden seed bytes`, () => {
      const seed = seedYState(config, () => $getRoot().append(...$build()));
      const again = seedYState(config, () => $getRoot().append(...$build()));
      expect(again).toEqual(seed);
      const b64 = Buffer.from(seed).toString('base64');
      const golden = GOLDEN[name];
      if (process.env.SEED_GOLDEN_PRINT === '1') {
        // eslint-disable-next-line no-console
        console.log(`GOLDEN ${JSON.stringify(name)}: ${b64}`);
      }
      expect(golden).toBeDefined();
      expect(b64).toBe(golden);
    });

    test(`${name}: structurally identical to writeLayout3Formats`, () => {
      const seed = seedYState(config, () => $getRoot().append(...$build()));
      const doc = createYDoc(seed, {gc: false});
      const copy = createYDoc(seed, {gc: false});
      copy.clientID = 424242;
      const mine = containers(doc.get('lexical-y'));
      const theirs = containers(copy.get('lexical-y'));
      expect(theirs.length).toBe(mine.length);
      let covering = 0;
      copy.transact(tr => {
        mine.forEach((c, i) => {
          const values = readLayout3Formats(c);
          covering += values.filter(v => v.size > 0).length;
          writeLayout3Formats(tr, theirs[i], values);
        });
      });
      expect(covering).toBeGreaterThan(0);
      mine.forEach((c, i) => {
        if (process.env.SEED_STRUCT_PRINT === '1') {
          // eslint-disable-next-line no-console
          console.log('STRUCT', name, i, structure(c).join(' '));
        }
        expect(structure(theirs[i])).toEqual(structure(c));
        expect(readLayout3Formats(theirs[i])).toEqual(readLayout3Formats(c));
      });
      // The binding's read of both documents is the same.
      expect(fresh(Y.encodeStateAsUpdate(copy))).toBe(
        fresh(Y.encodeStateAsUpdate(doc)),
      );
    });
  }
});
