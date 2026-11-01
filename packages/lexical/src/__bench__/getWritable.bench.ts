/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {describe, test} from 'vitest';

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $selectAll,
  createEditor,
  type LexicalEditor,
  type TextNode,
} from '..';

// Headless updates include cloning, transforms, GC and commit, but exclude DOM
// reconciliation. Run with NODE_ENV=production to measure production behavior.
// Keep document size fixed so first-write and reuse costs remain comparable.
// Retain the returned text nodes: setTextContent can skip writes when its
// argument matches the old value on a stale node reference.
for (const size of [100, 1000]) {
  describe(`size=${size} :: writable nodes`, () => {
    for (const workload of [
      '100000 getWritable calls',
      'one text change',
      'one setter per node',
      'five setters per node',
      'replace document',
      'select all and format',
    ]) {
      test(workload, async ({bench}) => {
        let editor: LexicalEditor;
        let nodes: TextNode[];
        let cycle: number;

        const $populate = () => {
          nodes = [];
          const root = $getRoot();
          root.clear();
          for (let i = 0; i < size; i++) {
            const text = $createTextNode('original');
            nodes.push(text);
            root.append($createParagraphNode().append(text));
          }
        };

        const run = () => {
          editor.update(
            () => {
              cycle++;
              const text = cycle % 2 ? 'changed' : 'original';
              const format = cycle % 2 ? 1 : 0;
              switch (workload) {
                case '100000 getWritable calls':
                  for (let i = 0; i < 100000; i++) {
                    nodes[i % nodes.length].getWritable();
                  }
                  break;
                case 'one text change':
                  nodes[nodes.length - 1] =
                    nodes[nodes.length - 1].setTextContent(text);
                  break;
                case 'one setter per node':
                  for (let i = 0; i < nodes.length; i++) {
                    nodes[i] = nodes[i].setTextContent(text);
                  }
                  break;
                case 'five setters per node':
                  for (let i = 0; i < nodes.length; i++) {
                    nodes[i] = nodes[i]
                      .setTextContent(text)
                      .setFormat(format)
                      .setStyle(format ? 'color: red' : '')
                      .setDetail(format)
                      .setMode(format ? 'token' : 'normal');
                  }
                  break;
                case 'replace document':
                  $populate();
                  break;
                case 'select all and format': {
                  $selectAll();
                  const selection = $getSelection();
                  if (!$isRangeSelection(selection)) {
                    throw new Error('Expected a range selection');
                  }
                  selection.formatText('bold');
                  break;
                }
              }
            },
            {discrete: true},
          );
        };
        const verify = () => {
          editor.read(() => {
            const texts = $getRoot().getAllTextNodes();
            if (texts.length !== size) {
              throw new Error('Unexpected document size');
            }
            if (
              workload === 'one text change' ||
              workload === 'one setter per node' ||
              workload === 'five setters per node'
            ) {
              const expected = cycle % 2 ? 'changed' : 'original';
              const changed =
                workload === 'one text change' ? texts.slice(-1) : texts;
              if (changed.some(node => node.getTextContent() !== expected)) {
                throw new Error('The measured edit did not change the text');
              }
            }
            if (
              workload === 'select all and format' &&
              texts.some(node => node.hasFormat('bold') !== Boolean(cycle % 2))
            ) {
              throw new Error('The measured edit did not change the format');
            }
          });
        };

        await bench(
          workload,
          {
            afterAll: verify,
            beforeAll: () => {
              editor = createEditor({
                onError(error) {
                  throw error;
                },
              });
              cycle = 0;
              editor.update($populate, {discrete: true});
              // Check both alternating edits before timing. A final-only check
              // can miss stale-reference no-ops when the last cycle is odd.
              for (let i = 0; i < 2; i++) {
                run();
                verify();
              }
            },
          },
          run,
        ).run({throws: true, time: 1500, warmupTime: 500});
      });
    }
  });
}
