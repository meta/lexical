/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A deletion whose neighbours Lexical then merges, where the deleted text
// equals the text that merges in after it: a line "la " | **la ** | "la " |
// _end_, the bold node deleted, the two plain nodes merged into "la la ".
// The writer keeps the items of the node that merged, which Lexical's
// normalization names, never the deleted node's equal characters: a peer's
// concurrent delete of, or typing in front of, the plain "la " stays where
// it was made (R13-A D1; before, the deleted bold "la " came back).

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {MarkStateExtension} from '@lexical/mark';
import * as Y from '@y/y';
import {
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
        MarkStateExtension,
      ],
      name: 'r13a/' + id,
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
    if (!tr.local) {
      return;
    }
    Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        written.inserted += s.content.str;
      }
    });
    Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        written.deleted += s.content.str;
      }
    });
  });
  return {
    binding,
    doc,
    editor,
    errors,
    json: () => JSON.stringify(editor.getEditorState().toJSON()),
    update(fn: () => void) {
      editor.update(fn, {discrete: true});
    },
    warnings,
    written,
  };
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
const $line = () => $getRoot().getChildAtIndex(1) as ElementNode;
const $texts = () => $line().getAllTextNodes();
function lineOf(p: Peer): string {
  return p.editor.getEditorState().read(() =>
    $texts()
      .map(t => {
        const s = t.getTextContent();
        return t.hasFormat('bold')
          ? `**${s}**`
          : t.hasFormat('italic')
            ? `_${s}_`
            : s;
      })
      .join('|'),
  );
}
function textOf(p: Peer): string {
  return p.editor.getEditorState().read(() => $line().getTextContent());
}

type Seg = [string, '' | 'bold' | 'italic'];
async function start(segs: Seg[]) {
  const a = peer(1);
  const b = peer(2);
  a.update(() => {
    const p = $createParagraphNode();
    for (const [s, f] of segs) {
      const t = $createTextNode(s);
      if (f !== '') {
        t.toggleFormat(f);
      }
      p.append(t);
    }
    $getRoot()
      .clear()
      .append($createParagraphNode().append($createTextNode('Title')), p);
    $setSelection(null);
  });
  a.binding.initialize();
  await flush();
  await sync([a, b]);
  b.binding.initialize();
  await flush();
  return {a, b};
}
function $selectNode(t: TextNode, from = 0, to = t.getTextContentSize()) {
  const sel = $createRangeSelection();
  sel.anchor.set(t.getKey(), from, 'text');
  sel.focus.set(t.getKey(), to, 'text');
  $setSelection(sel);
  return sel;
}

const SEGS: Seg[] = [
  ['la ', ''],
  ['la ', 'bold'],
  ['la ', ''],
  ['end', 'italic'],
];

type How =
  | 'remove(), no selection'
  | 'remove(), caret in the title'
  | 'select it and removeText()';
const HOWS: How[] = [
  'remove(), no selection',
  'remove(), caret in the title',
  'select it and removeText()',
];
function $authorDeletesBold(how: How) {
  const bold = $texts()[1];
  if (how === 'select it and removeText()') {
    $selectNode(bold).removeText();
    return;
  }
  if (how === 'remove(), caret in the title') {
    const title = (
      $getRoot().getFirstChild() as ElementNode
    ).getFirstChild() as TextNode;
    $selectNode(title, 2, 2);
  } else {
    $setSelection(null);
  }
  bold.remove();
}

describe('deleted text equal to the text that merges in after it', () => {
  for (const how of HOWS) {
    test(`author deletes the bold "la " (${how}); peer deletes the plain "la " after it`, async () => {
      const {a, b} = await start(SEGS);
      a.written.inserted = a.written.deleted = '';
      a.update(() => $authorDeletesBold(how));
      // The bold "la " goes; the merge writes no text.
      expect(a.written).toEqual({deleted: 'la ', inserted: ''});
      expect(lineOf(a)).toBe('la la |_end_');
      b.update(() => {
        $selectNode($texts()[2]).removeText();
      });
      await sync([a, b]);
      const ta = textOf(a);
      const tb = textOf(b);
      expect(ta).toBe(tb);
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
      // Both "la " nodes were deleted, one by each client.
      expect(ta).toBe('la end');
    });
    test(`author deletes the bold "la " (${how}); peer types X in front of the plain "la " after it`, async () => {
      const {a, b} = await start(SEGS);
      a.update(() => $authorDeletesBold(how));
      b.update(() => {
        const plain = $texts()[2];
        $selectNode(plain, 0, 0);
        plain.spliceText(0, 0, 'X', true);
      });
      await sync([a, b]);
      const ta = textOf(a);
      expect(ta).toBe(textOf(b));
      // X was typed in front of the plain "la ", which stays.
      expect(ta).toBe('la Xla end');
    });
  }
});
