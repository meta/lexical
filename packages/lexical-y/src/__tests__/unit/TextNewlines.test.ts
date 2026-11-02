/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A text node holding a line feed (code that calls setTextContent('a\nb')
// or $createTextNode('x\ny')) is split into text and line break nodes in
// the author's own edit, whatever its mode or class: every client and a
// fresh reader show the same (R6-A S3). The parts keep the node's format
// and NodeState (the first part is the node itself, as Lexical's splitText
// makes it), and each line break the NodeState its line feed had. An update
// with skipTransforms is split in the author's normalization of it.
// @vitest-environment node

import {CodeHighlightNode} from '@lexical/code';
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$addMarkID, $getNodeMarkIDs, MarkStateExtension} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  $setState,
  configExtension,
  createEditor,
  createState,
  defineExtension,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {expect, test} from 'vitest';

import {createYDoc, YBinding, YCollabExtension} from '../..';
import {$p, expectConverged, flush, freshReader, setup} from '../utils/harness';

for (const how of ['setTextContent', '$createTextNode']) {
  test(`a text node holding "\\n" (${how})`, async () => {
    const {a, b, sync} = await setup(() => {
      $getRoot().append($p('one'), $p('two'));
    });
    a.update(() => {
      const first = $getRoot().getFirstChild() as ElementNode;
      if (how === 'setTextContent') {
        (first.getFirstChild() as TextNode).setTextContent(
          'line one\nline two',
        );
      } else {
        first.append($createTextNode(' more\nlines'));
      }
    });
    await sync();
    await flush();
    const fresh = await freshReader(a);
    expect(a.describe()).toBe(fresh.describe());
    expect(b.describe()).toBe(a.describe());
  });
}

for (const what of ['token', 'segmented', 'code highlight', 'bold']) {
  test(`a ${what} text node holding "\\n"`, async () => {
    const {a, b, sync} = await setup(() => {
      $getRoot().append($p('one'));
    });
    a.update(() => {
      const n =
        what === 'code highlight'
          ? new CodeHighlightNode('x\ny')
          : what === 'bold'
            ? $createTextNode('x\ny').toggleFormat('bold')
            : $createTextNode('x\ny').setMode(what as 'token' | 'segmented');
      ($getRoot().getFirstChild() as ElementNode).append(n);
    });
    await sync();
    await flush();
    await expectConverged([a, b]);
    expect(a.describe()).not.toContain('\\n');
  });
}

const note = createState('newline-note', {
  parse: (v: unknown) => (typeof v === 'string' ? v : ''),
});

test('the line break keeps the NodeState of its line feed', async () => {
  const {a, b, sync} = await setup(() => {
    $getRoot().append($p('before'));
  });
  a.update(() => {
    const t = $createTextNode('one\ntwo');
    $setState(t, note, 'annotation');
    ($getRoot().getFirstChild() as ElementNode).clear().append(t);
  });
  await sync();
  await flush();
  const children = (
    a.json().root.children[0] as unknown as {
      children: {type: string; $?: Record<string, unknown>}[];
    }
  ).children;
  expect(
    children.map(c => [c.type, c.$ === undefined ? null : c.$['newline-note']]),
  ).toEqual([
    ['text', 'annotation'],
    ['linebreak', 'annotation'],
    ['text', 'annotation'],
  ]);
  await expectConverged([a, b]);
});

for (const marks of [false, true]) {
  test(`a comment on just the line feed stays on the line break (MarkStateExtension ${marks ? 'on' : 'off'})`, async () => {
    const doc = createYDoc();
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [
          configExtension(YCollabExtension, {
            doc,
            schemaVersion: 1,
            selfCheck: true,
          }),
          ...(marks ? [MarkStateExtension] : []),
        ],
        name: 'newline-mark',
        onError: e => {
          throw e;
        },
      }),
    );
    const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
      .output.binding;
    editor.update(() => $getRoot().append($createParagraphNode()), {
      discrete: true,
    });
    binding.initialize();
    await flush();
    editor.update(
      () => {
        const t = $createTextNode('one\ntwo');
        ($getRoot().getFirstChild() as ElementNode).append(t);
        $addMarkID('comment-LF', t.select(3, 4));
      },
      {discrete: true},
    );
    await flush();
    const shown = editor.read(() =>
      ($getRoot().getFirstChild() as ElementNode)
        .getChildren()
        .map(n => [n.getType(), $getNodeMarkIDs(n)]),
    );
    expect(shown).toEqual([
      ['text', []],
      ['linebreak', ['comment-LF']],
      ['text', []],
    ]);
    editor.dispose();
  });
}

// An update with skipTransforms runs no transforms on the text it changes:
// the author's normalization of it (right after, as part of the same edit)
// runs them, so the author splits the line feed as well, and shows what
// every reader shows.
for (const how of [
  'setTextContent',
  'insertText',
  'a new text node',
  'setTextContent and setIndent',
]) {
  for (const mode of ['normal', 'token', 'segmented'] as const) {
    test(`an update with skipTransforms leaving "\\n" in a ${mode} text node (${how}): the author shows what readers show`, async () => {
      const {a, b, sync} = await setup(() => {
        $getRoot().append($p('one two'));
      });
      a.editor.update(
        () => {
          const paragraph = $assertNodeType(
            $getRoot().getFirstChildOrThrow(),
            $isParagraphNode,
          );
          const text = $assertNodeType(
            paragraph.getFirstChildOrThrow(),
            $isTextNode,
          );
          if (how === 'insertText') {
            text.setMode(mode).select(3, 4).insertText('\n');
          } else if (how === 'a new text node') {
            text.replace($createTextNode('one\ntwo').setMode(mode));
          } else {
            text.setMode(mode).setTextContent('one\ntwo');
            if (how === 'setTextContent and setIndent') {
              paragraph.setIndent(1);
            }
          }
        },
        {discrete: true, skipTransforms: true},
      );
      await flush();
      await sync();
      await flush();
      const fresh = await freshReader(a);
      expect(a.describe()).toMatch(/\bbr\b/);
      expect(a.json()).toEqual(fresh.json());
      expect(b.json()).toEqual(fresh.json());
      await expectConverged([a, b]);
    });
  }
}

// splitText takes its offsets as arguments, which are bounded in number: a
// text node with very many line feeds is split in pieces (R10-B C1: one
// call with 600,000 offsets threw a RangeError, and the edit was lost).
test('a text node holding 300,000 line feeds', async () => {
  const count = 300000;
  const make = (id: number) => {
    const errors: unknown[] = [];
    const editor = createEditor({
      onError: e => {
        errors.push(e);
      },
    });
    const doc = createYDoc(null, {gc: false});
    doc.clientID = id;
    const binding = new YBinding(editor, doc, {
      schemaVersion: 1,
      selfCheck: false,
    });
    binding.start();
    return {binding, doc, editor, errors};
  };
  const author = make(1);
  const peer = make(2);
  author.binding.initialize();
  Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(author.doc), 'net');
  peer.binding.initialize();
  author.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'net') {
      Y.applyUpdate(peer.doc, update, 'net');
    }
  });
  const text = 'x\n'.repeat(count);
  author.editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode(text)));
    },
    {discrete: true},
  );
  await flush();
  const fresh = make(3);
  Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(author.doc), 'load');
  fresh.binding.initialize();
  for (const client of [author, peer, fresh]) {
    expect(client.errors).toEqual([]);
    const [content, children, lineBreaks] = client.editor.read(() => {
      const paragraph = $assertNodeType(
        $getRoot().getFirstChildOrThrow(),
        $isElementNode,
      );
      return [
        $getRoot().getTextContent(),
        paragraph.getChildrenSize(),
        paragraph.getChildren().filter($isLineBreakNode).length,
      ];
    });
    // (toBe would print 600,000 characters on a failure.)
    expect(content === text).toBe(true);
    expect([children, lineBreaks]).toEqual([2 * count, count]);
  }
  for (const client of [author, peer, fresh]) {
    client.binding.dispose();
  }
}, 180000);

// The pieces of a split make the same parts as one split: the first is a
// new normal text node for a segmented node, every part keeps the format
// and NodeState, every line break its line feed's NodeState.
test('a segmented text node holding more line feeds than one split takes', async () => {
  const count = 6000;
  const {a, b, sync} = await setup(() => {
    $getRoot().append($p('before'));
  });
  a.update(() => {
    const t = $createTextNode('x\n'.repeat(count) + 'end')
      .setMode('segmented')
      .toggleFormat('bold');
    $setState(t, note, 'annotation');
    ($getRoot().getFirstChild() as ElementNode).clear().append(t);
  });
  await sync();
  await flush();
  const children = (
    a.json().root.children[0] as unknown as {
      children: {
        type: string;
        mode?: string;
        format?: number;
        text?: string;
        $?: Record<string, unknown>;
      }[];
    }
  ).children;
  expect(children.length).toBe(2 * count + 1);
  const kinds = new Set(
    children.map(c =>
      JSON.stringify([
        c.type,
        c.mode ?? null,
        c.format ?? null,
        c.$ === undefined ? null : c.$['newline-note'],
      ]),
    ),
  );
  expect([...kinds].sort()).toEqual([
    JSON.stringify(['linebreak', null, null, 'annotation']),
    JSON.stringify(['text', 'normal', 1, 'annotation']),
  ]);
  await expectConverged([a, b]);
}, 120000);
