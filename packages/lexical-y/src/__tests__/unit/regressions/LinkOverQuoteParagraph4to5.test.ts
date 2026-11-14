/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A link run that concurrent edits stretched over a paragraph stored as a
// node in a layout 4 quote that holds paragraphs (here in a quote nested in
// such quotes): layout 4 readers show the link around the paragraph,
// `quote(paragraph(link(paragraph("inner x"))))`. Layout 5 stores a quote's
// paragraphs as lines of its sequence, where no wrapper goes around a
// block, so the 4to5 step cannot keep the link. Its first revisions dropped
// it and passed the runner's checks (the reads compared a block node's text,
// not the values on its own unit); the runner now refuses such a room (y.md,
// Limits: Migrating quotes to layout 5), which keeps it read only rather
// than lose the link. Written by main (layout 4) in a seeded random session
// of two peers, block ids off, gc off.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {migrateYState} from '../../../migrate';
import step4to5 from '../../../migrate/4to5';

const LAYOUT4 = [
  'AzCy8ZnviL/ZDwAoAQlsZXhpY2FsLXkLbGV4aWNhbC15OjQBeCgBCWxleGljYWwteRJsZXhp',
  'Y2FsLXktc2NoZW1hOjEBeCgBCWxleGljYWwteQtrOnBhcmFncmFwaAF3BGxpbmUoAQlsZXhp',
  'Y2FsLXkHazpxdW90ZQF3BGxpbmUEAQlsZXhpY2FsLXkBdISy8ZnviL/ZDwQEaXRsZYey8Znv',
  'iL/ZDwgDAsK2h7Lxme+Iv9kPCQMLaTpwYXJhZ3JhcGgoALLxme+Iv9kPCgFjAXcBaQQAsvGZ',
  '74i/2Q8KCWFscGhhIG9uZYey8ZnviL/ZDwoDC2k6cGFyYWdyYXBoKACy8ZnviL/ZDxUBYwF3',
  'AWkEALLxme+Iv9kPFQlicmF2byB0d2+HsvGZ74i/2Q8VAwdpOnF1b3RlKACy8ZnviL/ZDyAM',
  'cDpzaGFkb3dSb290AXgoALLxme+Iv9kPIAFjAXcBYgQAsvGZ74i/2Q8gAWmEsvGZ74i/2Q8j',
  'Bm5uZXIgeIey8ZnviL/ZDykDAsK2hLLxme+Iv9kPKgZpbm5lciCEsvGZ74i/2Q8wAXmHsvGZ',
  '74i/2Q8xAwLCtoey8ZnviL/ZDyADC2k6cGFyYWdyYXBoKACy8ZnviL/ZDzMBYwF3AWkEALLx',
  'me+Iv9kPMw1jaGFybGllIHRocmVlh7Lxme+Iv9kPMwMCwraEsvGZ74i/2Q9CAm1phLLxme+I',
  'v9kPRARkZGxlh7Lxme+Iv9kPSAMCwraHsvGZ74i/2Q9JAwtpOnBhcmFncmFwaCgAsvGZ74i/',
  '2Q9KAWMBdwFpBgCy8ZnviL/ZD0oIczphbmNob3IEInMwIoay8ZnviL/ZD0wMczptYXJrSWRz',
  'H3MwBHRydWWEsvGZ74i/2Q9NBnN0YXRlZIey8ZnviL/ZD0oDC2k6cGFyYWdyYXBoKACy8Znv',
  'iL/ZD1QBYwF3AWkEALLxme+Iv9kPVAVkZWx0YYey8ZnviL/ZD1QDAsK2hLLxme+Iv9kPWwFl',
  'hLLxme+Iv9kPXAFuhLLxme+Iv9kPXQFkh7Lxme+Iv9kPXgMCwrYoALLxme+Iv9kPQgF0AXcF',
  'cXVvdGUoALLxme+Iv9kPQgxzOnNoYWRvd1Jvb3QBeCgAsvGZ74i/2Q9bAXQBdwVxdW90ZSgA',
  'svGZ74i/2Q9bDHM6c2hhZG93Um9vdAF4hrLxme+Iv9kPUwhzOmFuY2hvcgRbMjRdhrLxme+I',
  'v9kPZAxzOm1hcmtJZHMfczAEWzI0XQsCAMay8ZnviL/ZDyOy8ZnviL/ZDyQGdzpsaW5rGXsi',
  'dXJsIjoiaHR0cHM6Ly9sMi50ZXN0In3GsvGZ74i/2Q8psvGZ74i/2Q8qBnc6bGluawNbMV0o',
  'AQlsZXhpY2FsLXkGazpsaW5rAXcbZm9ybWF0fHVybCx0YXJnZXQscmVsLHRpdGxlRLLxme+I',
  'v9kPDAJHNkey8ZnviL/ZDwQDD2k6dGVzdF9lcXVhdGlvbigAAgUKcDplcXVhdGlvbgF3AmU4',
  'xLLxme+Iv9kPRLLxme+Iv9kPRQNLMTDHsvGZ74i/2Q9dsvGZ74i/2Q9eAw9pOnRlc3RfZXF1',
  'YXRpb24oAAIKCnA6ZXF1YXRpb24BdwNlMTjHsvGZ74i/2Q8EsvGZ74i/2Q8FAw9pOnRlc3Rf',
  'ZXF1YXRpb24oAAIMCnA6ZXF1YXRpb24BdwNlMjQaAQBGsvGZ74i/2Q8MCHM6YW5jaG9yBCJj',
  'MSKGsvGZ74i/2Q8UCHM6YW5jaG9yA1sxXcYBALLxme+Iv9kPDAxzOm1hcmtJZHMfbTEEdHJ1',
  'Zcay8ZnviL/ZDxQBAQxzOm1hcmtJZHMfbTEDWzFdxgECsvGZ74i/2Q8MDHM6bWFya0lkcx9t',
  'MgR0cnVlxrLxme+Iv9kPFAEDDHM6bWFya0lkcx9tMgNbMV3HsvGZ74i/2Q8psvGZ74i/2Q8q',
  'AwtpOnBhcmFncmFwaCgAAQYBYwF3AWkEAAEGB2lubmVyIHgoALLxme+Iv9kPKgF0AXcFcXVv',
  'dGUoALLxme+Iv9kPKgxzOnNoYWRvd1Jvb3QBeEay8ZnviL/ZD1YGZjpib2xkBHRydWWGsvGZ',
  '74i/2Q9aBmY6Ym9sZANbMV2EARICSDfEsvGZ74i/2Q9csvGZ74i/2Q9dAko5x7Lxme+Iv9kP',
  'CbLxme+Iv9kPCgMNYjp0ZXN0X3dpZGdldMSy8ZnviL/ZDxQBBQNQMTXEAgSy8ZnviL/ZDwwD',
  'UjE3xgIFsvGZ74i/2Q8EBmY6Ym9sZAR0cnVlxrLxme+Iv9kPCLLxme+Iv9kPCQZmOmJvbGQD',
  'WzFdxgEEAgMIczphbmNob3IFImMyMyKGAQEIczphbmNob3IDWzFdxgEgAgMNczptYXJrSWRz',
  'H20yMwR0cnVlxgEBASENczptYXJrSWRzH20yMwNbMV3GASICAw1zOm1hcmtJZHMfbTI0BHRy',
  'dWXGAQEBIw1zOm1hcmtJZHMfbTI0A1sxXQKy8ZnviL/ZDwMjBzEBVAcBAgAGEQQ=',
].join('');

describe('a link run over a paragraph stored as a node in a layout 4 quote', () => {
  test('the layout 4 room holds a link value on a paragraph node unit', () => {
    const doc = new Y.Doc({gc: false});
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(LAYOUT4, 'base64')));
    // A `w:link` format item right before a paragraph stored as a node.
    const found: string[] = [];
    const visit = (node: Y.Node) => {
      for (let it = node._start; it !== null; it = it.right as typeof it) {
        if (it.deleted) {
          continue;
        }
        const content = it.content as {key?: string; type?: unknown};
        // The next live item that is not a format.
        let next = it.right as typeof it;
        while (
          next !== null &&
          (next.deleted || next.content instanceof Y.ContentFormat)
        ) {
          next = next.right as typeof it;
        }
        if (
          content.key === 'w:link' &&
          next !== null &&
          next.content instanceof Y.ContentType &&
          (next.content.type as Y.Node).name === 'i:paragraph'
        ) {
          found.push(content.key);
        }
        if (content.type instanceof Y.Node) {
          visit(content.type);
        }
      }
    };
    visit(doc.get('lexical-y') as Y.Node);
    expect(found).toEqual(['w:link']);
  });
  for (const gc of [false, true]) {
    test(`gc ${gc ? 'on' : 'off'}: the runner refuses the room rather than drop the link`, () => {
      expect(() =>
        migrateYState(
          new Uint8Array(Buffer.from(LAYOUT4, 'base64')),
          [step4to5],
          {
            gc,
          },
        ),
      ).toThrow(/failed its checks/);
    });
  }
});
