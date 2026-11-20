/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A browser room's tab-format leak, replayed from the room's relay update
// log (not part of the repository): a reader loads the stored state just
// before a client's undo of its tab, and the undo leaves another client's
// `t: 'tab'` opener open. Skipped unless SOAKB2_TAB_LOG names the log:
//
//   SOAKB2_TAB_LOG=<relay log> pnpm exec vitest run --project unit packages/lexical-y/src/__tests__/unit/TabLeakReplay.test.ts
// @vitest-environment node

import {HashtagNode} from '@lexical/hashtag';
import * as Y from '@y/y';
import {$getRoot} from 'lexical';
import fs from 'node:fs';
import {expect, test} from 'vitest';

import {flush, NODES, Peer} from '../utils/harness';

const LOG = process.env.SOAKB2_TAB_LOG || '';
const BEFORE = 16873;
const UNDO = 16874;

test.skipIf(LOG === '' || !fs.existsSync(LOG))(
  'a tab undone by its author does not turn the next lines into tabs',
  async () => {
    const lines = fs
      .readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as {u?: string});
    const base = new Y.Doc({gc: false});
    for (let n = 1; n <= BEFORE; n++) {
      const u = lines[n - 1].u;
      if (u !== undefined) {
        Y.applyUpdate(base, new Uint8Array(Buffer.from(u, 'base64')));
      }
    }
    const net = {
      delivery: 'causal' as const,
      peers: [] as Peer[],
      pumping: false,
      queue: [] as [Peer, Uint8Array][],
    };
    const r = new Peer(515151, net as never, [...NODES, HashtagNode]);
    Y.applyUpdate(r.doc, Y.encodeStateAsUpdate(base), 'load');
    r.binding.initialize();
    await flush();
    const before = r.read(() => $getRoot().getTextContent());
    expect(before).toContain(
      'Server kb556z one use which store team, are back morning take.',
    );
    expect(before).toContain('kc544z');
    // D's undo arrives.
    Y.applyUpdate(
      r.doc,
      new Uint8Array(Buffer.from(lines[UNDO - 1].u!, 'base64')),
      'net',
    );
    await flush();
    const after = r.read(() => $getRoot().getTextContent());
    const i = after.indexOf('meeting. ');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(after.slice(i, i + 120)));
    expect(after).toContain(
      'Server kb556z one use which store team, are back morning take.',
    );
    expect(after).toContain('kc544z');
  },
);
