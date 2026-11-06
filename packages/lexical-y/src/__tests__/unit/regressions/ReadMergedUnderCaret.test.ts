/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment jsdom

// A remote read that leaves two text nodes side by side which Lexical merges
// (they differ only in what the binding stores, here their segment), with the
// caret in the second one, in an editor with a root element. Lexical's
// normalization at the end of the read's update merges them and moves the
// caret onto the merged node. The binding counts the read's selection as
// notified (see $quietSelection); when it counted a copy, the commit saw the
// moved caret as a selection change and extended the read's commit with the
// selection change command, running every node transform over what the read
// brought: here the code highlighter turned a code highlight outside code
// into plain text, which the binding neither wrote nor read again. The
// editor then showed what no other client and no fresh reader shows.

import {$createCodeHighlightNode} from '@lexical/code';
import {registerCodeHighlighting} from '@lexical/code-prism';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  type ElementNode,
  type LexicalEditor,
  SELECTION_CHANGE_COMMAND,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../../..';
import {NODES} from '../../utils/harness';

const idle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

function client(id: number, state?: Uint8Array, dom = false) {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  const editor = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
  });
  let root: HTMLElement | null = null;
  if (dom) {
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    editor.setRootElement(root);
    registerCodeHighlighting(editor);
  }
  if (state !== undefined) {
    Y.applyUpdate(doc, state, 'load');
  }
  const binding = new YBinding(editor, doc, {schemaVersion: 1});
  const stop = binding.start();
  return {binding, doc, editor, root, stop};
}

/** Each line's children, by type and text. */
const describe = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map(
        line =>
          `${line.getType()}(` +
          (line as ElementNode)
            .getChildren()
            .map(c => `${c.getType()}:${JSON.stringify(c.getTextContent())}`)
            .join(' ') +
          ')',
      )
      .join(' / '),
  );

/** What a fresh reader of `doc` shows. */
function fresh(doc: Y.Doc): string {
  const f = client(9, Y.encodeStateAsUpdate(doc));
  f.binding.initialize();
  const out = describe(f.editor);
  f.stop();
  return out;
}

/** Index of `str` in the shared root's content. */
function indexIn(doc: Y.Doc, str: string): number {
  const root = doc.get('lexical-y') as unknown as {_start: Y.Item | null};
  let at = 0;
  for (let it = root._start; it !== null; it = it.right as Y.Item | null) {
    if (it.deleted || !it.countable) {
      continue;
    }
    const c = it.content as unknown as {str?: string};
    if (typeof c.str === 'string' && c.str.includes(str)) {
      return at + c.str.indexOf(str);
    }
    at += it.length;
  }
  throw new Error(`not found: ${str}`);
}

const $text = (text: string) =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent() === text) as TextNode;

for (const ids of [
  [1, 2],
  [2, 1],
] as const) {
  for (const delivery of ['together', 'segment first', 'delete first']) {
    test(`a read Lexical merges under the caret runs no transforms: a code highlight outside code stays as stored (ids ${ids}, ${delivery})`, async () => {
      // A (no highlighter) stores a code highlight outside code.
      const a = client(ids[0]);
      a.editor.update(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('one two'),
              $createTextNode('Z').toggleFormat('bold'),
              $createCodeHighlightNode(' y'),
              $createTextNode(' three'),
            ),
          ),
        {discrete: true},
      );
      a.binding.initialize();
      await idle();
      // B has a root element and the highlighter, and its caret in "Z".
      const b = client(ids[1], Y.encodeStateAsUpdate(a.doc), true);
      b.binding.initialize();
      let notified = 0;
      b.editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          notified++;
          return false;
        },
        COMMAND_PRIORITY_EDITOR,
      );
      await idle();
      expect(describe(b.editor)).toBe(fresh(b.doc));
      b.editor.update(() => $text('Z').select(1, 1), {discrete: true});
      await idle();
      const before = notified;
      // An outside writer gives "two" a segment of its own (two nodes every
      // reader shows, which Lexical merges); A removes "Z".
      const outside = new Y.Doc({gc: false});
      outside.clientID = 7;
      Y.applyUpdate(outside, Y.encodeStateAsUpdate(a.doc));
      const sv = Y.encodeStateVector(outside);
      (
        outside.get('lexical-y') as unknown as {
          format(index: number, length: number, attrs: object): void;
        }
      ).format(indexIn(outside, 'two'), 3, {k: 'outside.1'});
      const segment = Y.encodeStateAsUpdate(outside, sv);
      const sa = Y.encodeStateVector(a.doc);
      a.editor.update(() => $text('Z').remove(), {discrete: true});
      await idle();
      const removal = Y.encodeStateAsUpdate(a.doc, sa);
      if (delivery === 'together') {
        Y.applyUpdate(b.doc, Y.mergeUpdates([segment, removal]), 'provider');
      } else {
        const [first, second] =
          delivery === 'segment first'
            ? [segment, removal]
            : [removal, segment];
        Y.applyUpdate(b.doc, first, 'provider');
        await idle();
        Y.applyUpdate(b.doc, second, 'provider');
      }
      await idle();
      expect(describe(b.editor)).toBe(fresh(b.doc));
      expect(describe(b.editor)).toBe(
        'paragraph(text:"one two" code-highlight:" y" text:" three")',
      );
      // Selection listeners still heard of the read's selection change.
      expect(notified).toBeGreaterThan(before);
      a.stop();
      b.stop();
      b.root!.remove();
    });
  }
}
