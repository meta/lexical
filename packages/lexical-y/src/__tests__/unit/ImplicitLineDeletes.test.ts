/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Text left without a marker before a block node (A joins two lines while B
// puts a widget between them), then the widget deleted, alone or with the
// line after it, in an edit and in a follow-up. The write deletes only what
// the author deleted: the text without a marker is never deleted with them,
// nor the lines before it (R13-A P1: the segment after it was written from
// the container's start, and a follow-up's delete of the line after the
// widget reached back over it). A follow-up that deletes only the widget
// would join that text to the next line for readers (only a marker, an
// insert, keeps them apart): it is not written, and the author reads the
// document again.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
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
import {WidgetNode} from '../utils/harness';

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
      name: 'r13a-impl/' + id,
      nodes: [WidgetNode],
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
  const written = {deleted: '', inserted: ''};
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    if (!tr.local) return;
    Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString)
        written.inserted += s.content.str;
    });
    Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString)
        written.deleted += s.content.str;
    });
  });
  return {binding, doc, editor, errors, warnings, written};
}
type Peer = ReturnType<typeof peer>;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function sync(peers: Peer[]) {
  for (let round = 0; round < 2; round++) {
    for (const from of peers)
      for (const to of peers)
        if (from !== to) {
          Y.applyUpdate(
            to.doc,
            Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
            'net',
          );
        }
    await flush();
  }
}
function shown(p: Peer): string {
  return p.editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map(c =>
        c.getType() === 'paragraph'
          ? (c as ElementNode).getTextContent()
          : `<${c.getType()}>`,
      )
      .join(' ¶ '),
  );
}
function yText(doc: Y.Doc): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root = doc.get('lexical-y') as any;
  let s = '';
  for (let it = root._start as Y.Item | null; it !== null; it = it.right) {
    if (it.deleted) continue;
    const c = it.content;
    if (c instanceof Y.ContentString) s += c.str;
    else if (c instanceof Y.ContentType)
      s += ` ${String((c.type as Y.Node).name)} `;
  }
  return s;
}

describe('a structure write after a line left without a marker', () => {
  for (const tag of [undefined, 'block-id-repair'] as const)
    for (const who of [
      'the client that added the widget',
      'the client that joined',
    ] as const) {
      for (const what of [
        'deletes the widget and the line after it',
        'deletes the widget',
      ] as const) {
        test(`${who} ${what}${tag ? ' (a follow-up)' : ''}`, async () => {
          const a = peer(1);
          const b = peer(2);
          a.editor.update(
            () => {
              $getRoot()
                .clear()
                .append(
                  $createParagraphNode().append($createTextNode('Title')),
                  $createParagraphNode().append($createTextNode('one')),
                  $createParagraphNode().append($createTextNode('two')),
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
          // A joins "one" and "two" (Delete at the end of "one").
          a.editor.update(
            () => {
              const one = (
                $getRoot().getChildAtIndex(1) as ElementNode
              ).getFirstChild() as TextNode;
              const two = (
                $getRoot().getChildAtIndex(2) as ElementNode
              ).getFirstChild() as TextNode;
              const sel = $createRangeSelection();
              sel.anchor.set(one.getKey(), 3, 'text');
              sel.focus.set(two.getKey(), 0, 'text');
              $setSelection(sel);
              sel.removeText();
            },
            {discrete: true},
          );
          // B, meanwhile, puts a widget between them.
          b.editor.update(
            () => {
              $getRoot().getChildAtIndex(1)!.insertAfter($create(WidgetNode));
              $setSelection(null);
            },
            {discrete: true},
          );
          await sync([a, b]);
          // "one" is left without a marker, before the widget.
          expect(yText(a.doc)).toBe('Title ¶ one b:test_widget two ¶ ');
          expect(shown(b)).toBe(shown(a));
          const actor = who === 'the client that added the widget' ? b : a;
          actor.written.deleted = actor.written.inserted = '';
          actor.editor.update(
            () => {
              const kids = $getRoot().getChildren();
              const wi = kids.findIndex(k => k.getType() === 'test_widget');
              const after = kids[wi + 1];
              kids[wi].remove();
              if (what === 'deletes the widget and the line after it' && after)
                after.remove();
              $setSelection(null);
            },
            {discrete: true, tag},
          );
          const authorView = shown(actor);
          const authorWrote = {...actor.written};
          await sync([a, b]);
          const fresh = peer(9);
          Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(a.doc), 'load');
          fresh.binding.initialize();
          await flush();
          // Only what the author deleted: the line after the widget, if
          // that (a follow-up that deletes only the widget writes nothing).
          expect(authorWrote).toEqual({
            deleted: what === 'deletes the widget' ? '' : 'two',
            inserted: '',
          });
          expect(authorView).toBe(
            what === 'deletes the widget'
              ? tag === undefined
                ? 'Title ¶ one ¶ two'
                : 'Title ¶ one ¶ <test_widget> ¶ two'
              : 'Title ¶ one',
          );
          expect(shown(fresh)).toBe(authorView);
          expect(shown(a)).toBe(shown(b));
          expect(shown(a)).toBe(authorView);
        });
      }
    }
});
