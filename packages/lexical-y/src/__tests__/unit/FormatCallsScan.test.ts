/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Format-only updates (one or two formatText calls)
// must never write text. Random ranges over styled runs, caret kept or cleared.
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type TextFormatType,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {setup} from '../utils/harness';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

test('format-only scan', async () => {
  const fails: string[] = [];
  let n = 0;
  for (let seed = 1; seed <= Number(process.env.SCAN_N ?? 800); seed++) {
    const r = rng(seed * 104729);
    const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
    const k = 2 + Math.floor(r() * 4);
    const nodes: [string, TextFormatType | null][] = [];
    for (let i = 0; i < k; i++) {
      nodes.push([
        pick(['la ', 'da ', 'ab', 'la la ', 't6z ', 'xy z ']),
        r() < 0.5
          ? pick(['bold', 'italic', 'underline'] as TextFormatType[])
          : null,
      ]);
    }
    const t = await setup(() => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('Title')),
        $createParagraphNode().append(
          ...nodes.map(([s, f]) => {
            const x = $createTextNode(s);
            if (f) x.toggleFormat(f);
            return x;
          }),
        ),
      );
    });
    const w = {deleted: '', inserted: ''};
    t.a.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (!tr.local) return;
      Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
        if (s instanceof Y.Item && s.content instanceof Y.ContentString)
          w.inserted += s.content.str;
      });
      Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
        if (s instanceof Y.Item && s.content instanceof Y.ContentString)
          w.deleted += s.content.str;
      });
    });
    const steps: string[] = [];
    const nocaret = r() < 0.5;
    t.a.update(() => {
      const line = $getRoot().getChildAtIndex(1) as ElementNode;
      const nsteps = 1 + Math.floor(r() * 3);
      for (let st = 0; st < nsteps; st++) {
        const spans: [TextNode, number, number][] = [];
        let acc = 0;
        for (const x of line.getAllTextNodes()) {
          spans.push([x, acc, acc + x.getTextContentSize()]);
          acc += x.getTextContentSize();
        }
        const len = acc;
        const at = (o: number, start: boolean): [string, number] => {
          for (let i = 0; i < spans.length; i++) {
            const [x, a, b] = spans[i];
            if ((start ? o < b : o <= b) || i === spans.length - 1)
              return [x.getKey(), o - a];
          }
          throw new Error('o');
        };
        const a = Math.floor(r() * (len - 1));
        const b = a + 1 + Math.floor(r() * (len - a - 1));
        const s = $createRangeSelection();
        const [ak, ao] = at(a, true);
        const [fk, fo] = at(b, false);
        s.anchor.set(ak, ao, 'text');
        s.focus.set(fk, fo, 'text');
        $setSelection(s);
        const f = pick(['bold', 'italic', 'underline'] as TextFormatType[]);
        s.formatText(f);
        steps.push(`${f} [${a},${b})`);
      }
      if (nocaret) $setSelection(null);
    });
    n++;
    if (w.inserted !== '' || w.deleted !== '') {
      fails.push(
        `${nodes.map(([s, f]) => (f ? `<${f[0]}>` : '') + JSON.stringify(s)).join('|')} ${steps.join(' ; ')}${nocaret ? ' (no caret)' : ''}: wrote ${JSON.stringify(w)}`,
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log(`SCAN ${fails.length}/${n}\n` + fails.join('\n'));
  expect(fails).toEqual([]);
}, 120000);
