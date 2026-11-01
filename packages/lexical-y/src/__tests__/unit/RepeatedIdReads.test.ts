/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Once a block id is stored on two blocks (two peers made the same
// restructure at once, or a raw copy kept it), a local write re-checks only
// the ids it changed: a keystroke elsewhere reads nothing again and costs
// about what it costs without a repeated id.

import {
  BlockIdExtension,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$insertList} from '@lexical/list';
import {$createTableNodeWithDimensions} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  defineExtension,
  type ElementNode,
} from 'lexical';
import {afterAll, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';
import {Reader} from '../../internal/Read';
import {$createBoxNode, NODES} from '../utils/harness';

const idle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

let fullReads = 0;
const readFull = Reader.prototype.$readFull;
Reader.prototype.$readFull = function (
  this: Reader,
  ...args: Parameters<typeof readFull>
) {
  fullReads++;
  return readFull.apply(this, args);
};
afterAll(() => {
  Reader.prototype.$readFull = readFull;
});

function peer(id: number, stored: Uint8Array | null = null) {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  if (stored !== null) {
    Y.applyUpdate(doc, stored);
  }
  let next = 0;
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        configExtension(BlockIdExtension, {
          generateId: () => `b${id}x${next++}`,
        }),
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: false,
        }),
      ],
      name: `peer${id}`,
      nodes: NODES,
      onError: e => {
        throw e;
      },
    }),
  );
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.binding;
  return {binding, doc, editor};
}

/** Full reads and milliseconds of each keystroke in the first paragraph. */
async function keystrokes(p: ReturnType<typeof peer>, n: number) {
  const reads: number[] = [];
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    fullReads = 0;
    const t0 = performance.now();
    p.editor.update(
      () => {
        ($getRoot().getFirstChild() as ElementNode).selectEnd().insertText('x');
      },
      {discrete: true},
    );
    ms.push(performance.now() - t0);
    await idle();
    reads.push(fullReads);
  }
  return {ms, reads};
}

test('two peers turn the same paragraph in a box into a list: later keystrokes elsewhere read nothing again', async () => {
  const a = peer(1);
  const b = peer(2);
  a.editor.update(
    () => {
      const root = $getRoot().clear();
      root.append(
        $createParagraphNode().append($createTextNode('top')),
        $createBoxNode().append(
          $createParagraphNode().append($createTextNode('hello world')),
        ),
      );
      for (let i = 0; i < 50; i++) {
        root.append(
          $createParagraphNode().append($createTextNode('filler ' + i)),
        );
      }
    },
    {discrete: true},
  );
  a.binding.initialize();
  await idle();
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'net');
  b.binding.initialize();
  await idle();
  for (const p of [a, b]) {
    p.editor.update(
      () => {
        const box = $getRoot().getChildAtIndex(1) as ElementNode;
        (box.getFirstChild() as ElementNode).select(2, 2);
        $insertList('bullet');
      },
      {discrete: true},
    );
  }
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc), 'net');
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), 'net');
  await idle();
  expect((await keystrokes(a, 4)).reads).toEqual([0, 0, 0, 0]);
  expect((await keystrokes(b, 4)).reads).toEqual([0, 0, 0, 0]);
});

/**
 * A document of `n` paragraphs after a table; with `repeat`, the third
 * top-level paragraph stores the second's id. Read by a second client.
 */
async function reader(n: number, repeat: boolean) {
  const a = peer(1);
  a.editor.update(
    () => {
      const root = $getRoot().clear();
      root.append(
        $createParagraphNode().append($createTextNode('top')),
        $createTableNodeWithDimensions(1, 2, false),
      );
      for (let i = 0; i < n; i++) {
        root.append(
          $createParagraphNode().append($createTextNode('paragraph ' + i)),
        );
      }
    },
    {discrete: true},
  );
  a.binding.initialize();
  await idle();
  if (repeat) {
    const markers: Y.Node[] = [];
    type It = {content: {type?: Y.Node}; deleted: boolean; right: It | null};
    const root = a.doc.get('lexical-y') as unknown as {_start: It | null};
    for (let it = root._start; it !== null; it = it.right) {
      if (!it.deleted && it.content.type && it.content.type.name === '¶') {
        markers.push(it.content.type);
      }
    }
    a.doc.transact(() =>
      markers[2].setAttr('s:blockId', markers[1].getAttr('s:blockId')),
    );
  }
  const b = peer(2, Y.encodeStateAsUpdate(a.doc));
  await idle();
  return b;
}

const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[xs.length >> 1];

test('a keystroke with a repeated block id present costs about what it costs without one', async () => {
  const without = await keystrokes(await reader(2000, false), 9);
  const repeated = await keystrokes(await reader(2000, true), 9);
  expect(without.reads.every(r => r === 0)).toBe(true);
  // Before: a full read of the root on every keystroke.
  expect(repeated.reads.every(r => r === 0)).toBe(true);
  expect(median(repeated.ms)).toBeLessThan(3 * median(without.ms) + 5);
}, 60_000);

/**
 * `n` paragraphs written without ids, the last `2 * r` storing ids in
 * pairs (a duplicated section, as a client without BlockIdExtension
 * writes it), and a reader of them.
 */
async function repeatedReader(n: number, r: number) {
  const doc = new Y.Doc({gc: false});
  doc.clientID = 7;
  const root = doc.get('lexical-y');
  const markers: Y.Node[] = [];
  doc.transact(() => {
    root.setAttr('lexical-y:1', true);
    root.setAttr('k:paragraph', 'line');
    let at = 0;
    for (let i = 0; i < n; i++) {
      const t = `p${i}`;
      root.insert(at, t);
      at += t.length;
      const m = new Y.Node('¶');
      root.insert(at, [m]);
      at += 1;
      markers.push(m);
    }
  });
  doc.transact(() => {
    for (let j = 0; j < 2 * r; j++) {
      markers[n - 2 * r + j].setAttr('s:blockId', 'id' + Math.floor(j / 2));
    }
  });
  const b = peer(2, Y.encodeStateAsUpdate(doc));
  b.binding.initialize();
  await idle();
  return {b, doc, root};
}

/** Milliseconds of each remote keystroke (in the last paragraph). */
async function remoteKeystrokes(
  source: {doc: Y.Doc; root: Y.Node; b: ReturnType<typeof peer>},
  count: number,
) {
  const ms: number[] = [];
  for (let k = 0; k < count; k++) {
    const sv = Y.encodeStateVector(source.doc);
    source.doc.transact(() => {
      source.root.insert(source.root.length - 1, 'x');
    });
    const update = Y.encodeStateAsUpdate(source.doc, sv);
    const t0 = performance.now();
    Y.applyUpdate(source.b.doc, update, 'net');
    ms.push(performance.now() - t0);
    await idle();
  }
  return ms;
}

test('a remote keystroke with many repeated block ids costs about what it costs without them', async () => {
  // Before: every read settled every repeated id, placing each holder by
  // its index in its parent: 300 repeated ids near the end of 3,000
  // paragraphs cost tens of milliseconds per remote keystroke (1,000 at
  // 10,000 paragraphs, about two seconds). Now a read settles the ids its
  // change touched.
  const without = await repeatedReader(3000, 0);
  const repeated = await repeatedReader(3000, 300);
  const a = await remoteKeystrokes(without, 9);
  const b = await remoteKeystrokes(repeated, 9);
  const shown = (p: ReturnType<typeof peer>) =>
    p.editor.getEditorState().read(() => $getRoot().getTextContent());
  expect(shown(repeated.b).endsWith('p2999xxxxxxxxx')).toBe(true);
  expect(median(b)).toBeLessThan(3 * median(a) + 5);
}, 60_000);
