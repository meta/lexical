/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A quote whose layout 4 marker kept a list item's group keys. One peer
// wraps a paragraph in a quote that holds paragraphs
// (`para.replace(quote); quote.append(para)`) while another turns the same
// paragraph into a list item; in half the client orders, layout 4 stores
// the quote's marker as `{g: 'list', g:listType: 'bullet', l: 0,
// s:shadowRoot: true, t: 'quote'}` with the paragraph as a node in its line.
// Readers show a quote, and the layout 5 binding stores a quote there as a
// container. The 4to5 step's first revisions left such a marker a line
// (they skipped a marker with `g`), so the binding found no container to
// write into: every later edit to that quote was shown locally and never
// stored, and peers diverged without a warning. The step now converts it
// (the new node keeps none of its group keys).

import * as Y from '@y/y';
import {
  $createRangeSelection,
  $getRoot,
  $setSelection,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {migrateYState} from '../../../migrate';
import step4to5 from '../../../migrate/4to5';
import {freshReader, NODES, Peer} from '../../utils/harness';

// Written by main (layout 4) after that race: client order 2, 1, block ids
// off. The other orders store the same shape.
const LAYOUT4 =
  'Awmwg5zdmPaDBAAoAQlsZXhpY2FsLXkLbGV4aWNhbC15OjQBeCgBCWxleGljYWwteRJsZXhpY2FsLXktc2NoZW1hOjEBeCgBCWxleGljYWwteQtrOnBhcmFncmFwaAF3BGxpbmUEAQlsZXhpY2FsLXkBdIewg5zdmPaDBAMDAsK2hLCDnN2Y9oMEBAVnYSBnYoewg5zdmPaDBAkDAsK2hLCDnN2Y9oMECgFlh7CDnN2Y9oMECwMCwrYGAgDHsIOc3Zj2gwQJsIOc3Zj2gwQKAwtpOnBhcmFncmFwaCgAAgABYwF3AWkEAAIABWdhIGdiKACwg5zdmPaDBAoBdAF3BXF1b3RlKACwg5zdmPaDBAoMczpzaGFkb3dSb290AXgoAQlsZXhpY2FsLXkHazpxdW90ZQF3BGxpbmUGAQAoALCDnN2Y9oMECgF0AXcIbGlzdGl0ZW0oALCDnN2Y9oMECgFnAXcEbGlzdCgAsIOc3Zj2gwQKCmc6bGlzdFR5cGUBdwZidWxsZXQoALCDnN2Y9oMECgFsAX0AKAEJbGV4aWNhbC15Bms6bGlzdAF3Dmdyb3VwfGxpc3RUeXBlKAEJbGV4aWNhbC15Cms6bGlzdGl0ZW0BdwRsaW5lArCDnN2Y9oMEAQUFAQEAAQ==';

function $typeAfter(token: string, text: string): void {
  const node = $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent().includes(token)) as TextNode;
  const offset = node.getTextContent().indexOf(token) + token.length;
  const selection = $createRangeSelection();
  selection.anchor.set(node.getKey(), offset, 'text');
  selection.focus.set(node.getKey(), offset, 'text');
  $setSelection(selection);
  selection.insertText(text);
}

describe('a quote whose layout 4 marker kept group keys', () => {
  for (const gc of [false, true]) {
    test(`gc ${gc ? 'on' : 'off'}: after 4to5, edits to the quote are stored and reach a fresh reader`, async () => {
      const layout4 = new Uint8Array(Buffer.from(LAYOUT4, 'base64'));
      const before = new Y.Doc({gc: false});
      Y.applyUpdate(before, layout4);
      const marker = JSON.stringify(
        (before.get('lexical-y') as Y.Node).toJSON(),
      );
      expect(marker).toContain('"g":"list"');
      const {state} = migrateYState(layout4, [step4to5], {gc});
      const net = {
        delivery: 'causal',
        peers: [] as Peer[],
        pumping: false,
        queue: [],
      } as never;
      const a = new Peer(11, net, NODES, undefined, false, gc);
      Y.applyUpdate(a.doc, state, 'load');
      a.binding.initialize();
      await new Promise(r => setTimeout(r, 0));
      expect(a.describe()).toBe(
        'paragraph("t") / quote(paragraph("ga gb")) / paragraph("e")',
      );
      const stored = Y.encodeStateVector(a.doc);
      a.update(() => $typeAfter('ga', 'AAA'));
      await new Promise(r => setTimeout(r, 0));
      expect(a.describe()).toBe(
        'paragraph("t") / quote(paragraph("gaAAA gb")) / paragraph("e")',
      );
      // The edit was written.
      expect(Y.encodeStateAsUpdate(a.doc, stored).length).toBeGreaterThan(30);
      const fresh = await freshReader(a);
      expect(fresh.describe()).toBe(
        'paragraph("t") / quote(paragraph("gaAAA gb")) / paragraph("e")',
      );
      expect(a.warnings).toEqual([]);
    });
  }
});
