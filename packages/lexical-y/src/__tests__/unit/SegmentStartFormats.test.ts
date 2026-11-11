/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// After a segment of a structure write, the unit after it starts with the
// formats in effect after the segment, without its own format items: an
// outside writer's bold run over "A ¶ bB ¶ x", the middle line deleted, "x"
// deleted and a paragraph added after "y", keeps its closer before "y"
// (R13-A P2: the start was taken at the unit's end item, the closer judged
// redundant and deleted, and readers showed "y" and the next line bold).

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  configExtension,
  defineExtension,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';

function peer(id: number) {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  const errors: unknown[] = [];
  const warnings: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
      ],
      name: 'r13a-seg/' + id,
      onError: e => {
        errors.push(e);
        throw e;
      },
      onWarn: e => {
        warnings.push(String(e && (e as Error).message));
      },
    }),
  );
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.binding;
  return {binding, doc, editor, errors, warnings};
}
type Peer = ReturnType<typeof peer>;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function sync(peers: Peer[]) {
  for (let round = 0; round < 2; round++) {
    for (const from of peers) {
      for (const to of peers) {
        if (from !== to) {
          Y.applyUpdate(
            to.doc,
            Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
            'net',
          );
        }
      }
    }
    await flush();
  }
}
function shown(p: Peer): string {
  return p.editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map(c =>
        (c as ElementNode)
          .getAllTextNodes()
          .map(t =>
            t.hasFormat('bold')
              ? `**${t.getTextContent()}**`
              : t.getTextContent(),
          )
          .join(''),
      )
      .join(' ¶ '),
  );
}
const $bold = (s: string) => {
  const t = $createTextNode(s);
  t.toggleFormat('bold');
  return t;
};

describe('a segment, then a changed line that joins the next segment', () => {
  for (const outside of [false, true])
    for (const variant of [
      'delete the bold start',
      'type at the bold start',
      'delete the plain end',
    ] as const) {
      test(`bold open across markers${outside ? ' (an outside writer)' : ''}; delete the middle line, ${variant}, add a paragraph after`, async () => {
        const a = peer(1);
        const b = peer(2);
        a.editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode('Title')),
                outside
                  ? $createParagraphNode().append($createTextNode('aA'))
                  : $createParagraphNode().append(
                      $createTextNode('a'),
                      $bold('A'),
                    ),
                outside
                  ? $createParagraphNode().append($createTextNode('bB'))
                  : $createParagraphNode().append($bold('bB')),
                outside
                  ? $createParagraphNode().append($createTextNode('xy'))
                  : $createParagraphNode().append(
                      $bold('x'),
                      $createTextNode('y'),
                    ),
                $createParagraphNode().append($createTextNode('c')),
              );
            $setSelection(null);
          },
          {discrete: true},
        );
        a.binding.initialize();
        await flush();
        await sync([a, b]);
        b.binding.initialize();
        await flush();
        if (outside) {
          // One bold run over "A ¶ bB ¶ x": Title¶ = 0..5, a 6, A 7, ¶ 8, b 9, B 10, ¶ 11, x 12.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const root = a.doc.get('lexical-y') as any;
          a.doc.transact(() => {
            root.format(7, 6, {'f:bold': true});
          }, 'outside');
          await flush();
          await sync([a, b]);
        }
        a.editor.update(
          () => {
            const root = $getRoot();
            root.getChildAtIndex(2)!.remove();
            const line = root.getChildAtIndex(2) as ElementNode;
            const [x, y] = line.getAllTextNodes() as TextNode[];
            if (variant === 'delete the bold start') {
              x.remove();
            } else if (variant === 'type at the bold start') {
              x.setTextContent('xz');
            } else {
              y.remove();
            }
            line.insertAfter($createParagraphNode());
            $setSelection(null);
          },
          {discrete: true},
        );
        await flush();
        await sync([a, b]);
        const fresh = peer(9);
        Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(a.doc), 'load');
        fresh.binding.initialize();
        await flush();
        expect(a.errors).toEqual([]);
        expect(shown(b)).toBe(shown(a));
        expect(shown(fresh)).toBe(shown(a));
      });
    }
});
