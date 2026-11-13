/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// The accepted limits of the update that ends a held composition
// (DECISIONS.md D119 to D124, y.md's Limits), each pinned on one history of
// the comparison with the composition made as one edit at its end (see
// utils/composeReference.ts and ComposeHoldReference.test.ts): every peer
// and a fresh reader converge, with no error and no storage finding, and the
// result differs from that reference as the row describes. The comparison
// with the reference itself is a `test.fails` per row, so that a change of
// the limit shows here. Before #9870 these histories differed from the
// reference as well; in D120's, the highlighter's tokens (code highlight
// nodes) stayed in the quote the app's transform made of the collaborator's
// code block, where #9870 leaves its text plain.

import {describe, expect, test} from 'vitest';

import {type Cfg, compareWithReference} from '../../utils/composeReference';

const LIMITS: [string, string, Cfg, boolean, string][] = [
  [
    'D119',
    'Enter in a line a collaborator made a code block makes a new block from the heading the composing editor showed, where the composition made as one edit makes a line break in the code block',
    {
      aId: 33,
      allPeers: true,
      at: 1,
      bAttr: 'indent',
      bSaw: false,
      bSplit: 6,
      bText: {at: 2, kind: 'insert'},
      bType: 'code',
      cell: 'type|enter|0',
      collab: 'type',
      end: 'enter',
      endFmt: 'none',
      endScope: 'line',
      extra: ' z',
      from: 'heading',
      ids: [11, 22],
      ins: false,
      interim: ' xyz',
      intro: 'heading',
      retype: 'none',
      spans: [
        {bold: false, note: '', text: 'see '},
        {bold: false, note: '', text: 'alpha'},
      ],
      struct: 'quote',
    },
    true,
    'structure',
  ],
  [
    'D120',
    "an app's transform that converts the composed line to a quote writes the quote over the code block a collaborator made, its text plain, where the composition made as one edit leaves the code block",
    {
      aId: 5,
      allPeers: true,
      at: 2,
      bAttr: 'center',
      bSaw: false,
      bSplit: 4,
      bText: {at: 13, kind: 'insert'},
      bType: 'code',
      cell: 'type|struct|0',
      collab: 'type',
      end: 'struct',
      endFmt: 'none',
      endScope: 'composed',
      extra: ' z',
      from: 'heading',
      ids: [11, 22],
      ins: false,
      interim: 'xyz',
      intro: 'paragraph',
      retype: 'none',
      spans: [
        {bold: false, note: '', text: 'see '},
        {bold: false, note: '', text: 'alpha'},
        {bold: false, note: '', text: ' gamma'},
      ],
      struct: 'quote',
    },
    false,
    'attr',
  ],
  [
    'D121',
    "an app's transform that moves the composed line, in an update that inserts the composed text, leaves the text a collaborator typed in that line at the start of the line after it",
    {
      aId: 33,
      allPeers: true,
      at: 7,
      bAttr: 'right',
      bSaw: false,
      bSplit: 12,
      bText: {at: 9, kind: 'insert'},
      bType: 'heading',
      cell: 'text|struct|1',
      collab: 'text',
      end: 'struct',
      endFmt: 'none',
      endScope: 'composed',
      extra: ' z',
      from: 'listitem',
      ids: [11, 22],
      ins: true,
      interim: 'xyz',
      intro: 'paragraph',
      retype: 'none',
      spans: [
        {bold: false, note: '', text: 'see '},
        {bold: false, note: 'old', text: 'omega'},
        {bold: false, note: '', text: ' beta'},
      ],
      struct: 'move',
    },
    true,
    'text-order',
  ],
  [
    'D122',
    'a collaborator who received the composing text and deleted the line takes that text with it',
    {
      aId: 5,
      allPeers: false,
      at: 1,
      bAttr: 'right',
      bSaw: true,
      bSplit: 2,
      bText: {from: 5, kind: 'delete', to: 7},
      bType: 'quote',
      cell: 'delete|enter|0',
      collab: 'delete',
      end: 'enter',
      endFmt: 'none',
      endScope: 'line',
      extra: ' z',
      from: 'heading',
      ids: [22, 11],
      ins: false,
      interim: 'xyz',
      intro: 'paragraph',
      retype: 'none',
      spans: [
        {bold: false, note: '', text: 'see '},
        {bold: true, note: '', text: 'delta'},
      ],
      struct: 'split',
    },
    true,
    'text-loss',
  ],
  [
    'D123',
    'a format the update that ends the composition sets on the whole line does not reach the text of the line a collaborator joined it into',
    {
      aId: 5,
      allPeers: true,
      at: 12,
      bAttr: 'indent',
      bSaw: false,
      bSplit: 5,
      bText: {from: 8, kind: 'delete', to: 10},
      bType: 'listitem',
      cell: 'join|plain|0',
      collab: 'join',
      end: 'plain',
      endFmt: 'bold',
      endScope: 'line',
      extra: ' z',
      from: 'code',
      ids: [11, 22],
      ins: false,
      interim: ' = 2',
      intro: 'paragraph',
      retype: 'none',
      spans: [
        {bold: false, note: '', text: 'see '},
        {bold: false, note: '', text: 'omega'},
        {bold: false, note: '', text: ' beta'},
      ],
      struct: 'heading',
    },
    true,
    'attr',
  ],
  [
    'D124',
    "a hashtag typed against a bold word a collaborator's split cuts takes the characters on the collaborator's half out of bold",
    {
      aId: 33,
      allPeers: true,
      at: 4,
      bAttr: 'center',
      bSaw: false,
      bSplit: 6,
      bText: {at: 7, kind: 'insert'},
      bType: 'quote',
      cell: 'split|retype|0',
      collab: 'split',
      end: 'retype',
      endFmt: 'none',
      endScope: 'composed',
      extra: ' z',
      from: 'paragraph',
      ids: [22, 11],
      ins: false,
      interim: ' #tag',
      intro: 'paragraph',
      retype: 'hashtag',
      spans: [
        {bold: false, note: '', text: 'see '},
        {bold: true, note: 'old', text: 'alpha'},
      ],
      struct: 'unwrap',
    },
    false,
    'attr',
  ],
];

describe('the update that ends a held composition, against the composition made as one edit at its end', () => {
  for (const [row, what, cfg, gc, cls] of LIMITS) {
    let result: ReturnType<typeof compareWithReference> | null = null;
    const compared = () => (result ??= compareWithReference(cfg, gc));
    test(`${row}: ${what} (${cfg.cell}, every peer and a fresh reader converge)`, async () => {
      const {outcome} = await compared();
      expect(outcome.cls).toBe(cls);
      if (row === 'D120') {
        // The quote's text is plain: no code highlight node outside code.
        expect(outcome.sub).toEqual(['block-type', 'token']);
      }
    }, 60_000);
    test.fails(
      `${row}: matches the composition made as one edit at its end (${cfg.cell})`,
      async () => {
        const {outcome} = await compared();
        expect(outcome.cls).toBe('none');
      },
      60_000,
    );
  }
});
