/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A binding stopped in the task that used it (a server opening documents in
// a synchronous loop) is not kept, with its editor and document, by a
// microtask it scheduled until the caller yields.
// @vitest-environment node

import * as Y from '@y/y';
import {$getRoot, createEditor} from 'lexical';
import {setFlagsFromString} from 'node:v8';
import {runInNewContext} from 'node:vm';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {$p, NODES} from '../utils/harness';
import {writeEditorToYDoc} from '../utils/headless';

test('40 editors bound, edited and disposed in a synchronous loop hold no document', () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const heap = () => {
    gc();
    gc();
    return process.memoryUsage().heapUsed;
  };
  const source = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
  });
  source.update(
    () => {
      for (let i = 0; i < 1000; i++) {
        $getRoot().append($p(`paragraph ${i} with some text in it`));
      }
    },
    {discrete: true},
  );
  const seedDoc = createYDoc();
  writeEditorToYDoc(source, seedDoc);
  const stored = Y.encodeStateAsUpdate(seedDoc);
  const start = heap();
  // No await: nothing scheduled in a microtask runs in the loop.
  for (let i = 0; i < 40; i++) {
    const doc = createYDoc();
    Y.applyUpdate(doc, stored);
    const editor = createEditor({
      nodes: NODES,
      onError: e => {
        throw e;
      },
    });
    const binding = new YBinding(editor, doc, {schemaVersion: 1});
    const stop = binding.start();
    editor.update(() => $getRoot().append($p('x')), {discrete: true});
    stop();
    doc.destroy();
  }
  // Each editor held about 1.8 MB (the editor, the document and the
  // binding) until the loop yielded.
  expect(heap() - start).toBeLessThan(8e6);
  // About 3 s alone (forty 1,000-line documents), over vitest's default 5 s
  // limit when the whole suite runs.
}, 30_000);
