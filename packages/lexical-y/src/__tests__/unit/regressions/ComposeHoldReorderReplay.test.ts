/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment jsdom

// A held line's transforms run again once the hold ends are written in place
// only where the text nodes of before keep their order in their element
// (see $reordersTextOfBefore in Binding.ts): moves the replay of the
// update's text edits must see through, from the review of #9897. A node of
// before attached after a new part split from its peer, a node of before
// taken out, replaced in the meantime by a new node, and put back after its
// peer, a node of before moved before its peer and merged into the node
// before it, and two retyped nodes of before put back swapped are refused, and B's concurrent edit stays in the node it made.

import {$createHashtagNode, HashtagNode} from '@lexical/hashtag';
import {$createHeadingNode} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setCompositionKey,
  $setSelection,
  $setState,
  createState,
  type ElementNode,
  TextNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {HOLD_NODES} from '../../utils/composeHold';
import {expectConverged, setup} from '../../utils/harness';

const $line = () => $getRoot().getFirstChildOrThrow() as ElementNode;
const note = createState('reorder-replay-note', {
  parse: v => (typeof v === 'string' ? v : ''),
});
for (const kind of ['insert', 'format', 'state'] as const)
  for (const gc of [false, true])
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      test(`a move after a new part split from its peer is refused, and keeps B's ${kind} in place (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('#ab').toggleFormat('bold'),
                $createTextNode('#abx'),
              ),
            );
          },
          {gc, ids, nodes: [...HOLD_NODES, HashtagNode], withBlockIds: false},
        );
        onTestFinished(() => t.peers.forEach(p => p.stop()));
        let armed = false;
        let performed = false;
        onTestFinished(
          t.a.editor.registerNodeTransform(TextNode, node => {
            if (
              !armed ||
              node.getType() !== 'text' ||
              node.getParent()?.getKey() !== $line().getKey()
            )
              return;
            if (!performed && node.getParent()?.getType() === 'heading') {
              performed = true;
              const [first, second] = $line().getChildren();
              // B's suffix is new, while B's prefix keeps its key: A crosses
              // all of B but is attached only after the new suffix.
              const parts = (second as TextNode).splitText(2);
              parts[parts.length - 1].insertAfter(first);
            }
            node.replace($createHashtagNode(node.getTextContent()));
          }),
        );
        t.a.update(() => {
          const n = $line().getFirstChildOrThrow() as TextNode;
          n.select(3, 3);
          $setCompositionKey(n.getKey());
          n.spliceText(3, 0, 'x');
        });
        await t.sync();
        t.b.update(() => {
          const l = $line();
          l.replace($createHeadingNode('h2').append(...l.getChildren()));
          $setSelection(null);
        });
        await t.sync();
        expect(
          (t.a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
        ).not.toBe(null);
        t.offline();
        t.b.update(() => {
          const n = $line().getFirstChildOrThrow() as TextNode;
          if (kind === 'insert') n.spliceText(1, 0, 'REMOTE');
          else if (kind === 'format') n.toggleFormat('italic');
          else $setState(n, note, 'B');
          $setSelection(null);
        });
        armed = true;
        t.a.update(() => {
          $setCompositionKey(null);
          ($line().getFirstChildOrThrow() as TextNode).markDirty();
          $setSelection(null);
        });
        await new Promise(r => setTimeout(r, 20));
        armed = false;
        expect(performed).toBe(true);
        await t.sync();
        await t.sync();
        await expectConverged(t.peers);
        for (const p of t.peers) {
          const result = p.read(() => {
            const texts = $line().getAllTextNodes();
            return {
              all: $line().getTextContent(),
              bold: texts
                .filter(n => n.hasFormat('bold'))
                .map(n => n.getTextContent())
                .join(''),
              italic: texts
                .filter(n => n.hasFormat('italic'))
                .map(n => n.getTextContent())
                .join(''),
              note: texts
                .filter(n => $getState(n, note) === 'B')
                .map(n => n.getTextContent())
                .join(''),
              types: texts.map(n => n.getType()),
            };
          });

          expect(result.bold).toBe(kind === 'insert' ? '#REMOTEabx' : '#abx');
          if (kind === 'format') expect(result.italic).toBe('#abx');
          if (kind === 'state') expect(result.note).toBe('#abx');
          // Not written.
          expect(result.types.every(x => x === 'text')).toBe(true);
        }
      });
    }

test('a node of before taken out, replaced in the meantime, and put back after its peer is refused', async () => {
  const t = await setup(
    () => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('aa').toggleFormat('bold'),
          $createTextNode('aaa'),
        ),
      );
    },
    {
      gc: false,
      ids: [1, 2],
      nodes: [...HOLD_NODES, HashtagNode],
      withBlockIds: false,
    },
  );
  onTestFinished(() => t.peers.forEach(p => p.stop()));
  let armed = false;
  let performed = false;
  onTestFinished(
    t.a.editor.registerNodeTransform(TextNode, node => {
      if (
        !armed ||
        node.getType() !== 'text' ||
        node.getParent()?.getKey() !== $line().getKey()
      )
        return;
      if (!performed && node.getParent()?.getType() === 'heading') {
        performed = true;
        const [a, b] = $line().getChildren() as TextNode[];
        const p = $line();
        // Not a replace: A survives. Its detach and the new prefix's attach
        // look like one, so A, attached again after B, must stand for itself.
        a.remove();
        const prefix = $createTextNode('a');
        b.insertBefore(prefix);
        a.setTextContent('aa');
        p.append(a);
      }
      node.replace($createHashtagNode(node.getTextContent()));
    }),
  );
  t.a.update(() => {
    const n = $line().getFirstChildOrThrow() as TextNode;
    n.select(2, 2);
    $setCompositionKey(n.getKey());
    n.spliceText(2, 0, 'a');
  });
  await t.sync();
  t.b.update(() => {
    const l = $line();
    l.replace($createHeadingNode('h2').append(...l.getChildren()));
    $setSelection(null);
  });
  await t.sync();
  expect(
    (t.a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
  ).not.toBe(null);
  t.offline();
  t.b.update(() => {
    ($line().getFirstChildOrThrow() as TextNode).spliceText(1, 0, 'REMOTE');
    $setSelection(null);
  });
  armed = true;
  t.a.update(() => {
    $setCompositionKey(null);
    ($line().getFirstChildOrThrow() as TextNode).markDirty();
    $setSelection(null);
  });
  await new Promise(r => setTimeout(r, 20));
  armed = false;
  expect(performed).toBe(true);
  await t.sync();
  await t.sync();
  await expectConverged(t.peers);
  for (const p of t.peers) {
    const out = p.read(() => ({
      bold: $line()
        .getAllTextNodes()
        .filter(n => n.hasFormat('bold'))
        .map(n => n.getTextContent())
        .join(''),
      text: $line().getTextContent(),
      types: $line()
        .getAllTextNodes()
        .map(n => n.getType()),
    }));
    expect(out.text).toBe('aREMOTEaaaaa');
    expect(out.bold).toBe('aREMOTEaa');
    expect(out.types.every(x => x === 'text')).toBe(true);
  }
});

test('a node of before moved before its peer and merged into the node before it is refused', async () => {
  const t = await setup(
    () => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('aa').toggleFormat('bold'),
          $createTextNode('aaa'),
          $createTextNode('aaa').toggleFormat('italic'),
        ),
      );
    },
    {
      gc: false,
      ids: [1, 2],
      nodes: [...HOLD_NODES, HashtagNode],
      withBlockIds: false,
    },
  );
  onTestFinished(() => t.peers.forEach(p => p.stop()));
  let armed = false;
  let performed = false;
  onTestFinished(
    t.a.editor.registerNodeTransform(TextNode, node => {
      if (
        !armed ||
        node.getType() !== 'text' ||
        node.getParent()?.getKey() !== $line().getKey()
      )
        return;
      if (!performed && node.getParent()?.getType() === 'heading') {
        performed = true;
        const [a, , c] = $line().getChildren() as TextNode[];
        a.insertAfter(c);
        a.mergeWithSibling(c);
      }
      node.replace($createHashtagNode(node.getTextContent()));
    }),
  );
  t.a.update(() => {
    const n = $line().getFirstChildOrThrow() as TextNode;
    n.select(2, 2);
    $setCompositionKey(n.getKey());
    n.spliceText(2, 0, 'a');
  });
  await t.sync();
  t.b.update(() => {
    const l = $line();
    l.replace($createHeadingNode('h2').append(...l.getChildren()));
    $setSelection(null);
  });
  await t.sync();
  expect(
    (t.a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
  ).not.toBe(null);
  t.offline();
  t.b.update(() => {
    ($line().getLastChildOrThrow() as TextNode).spliceText(1, 0, 'REMOTE');
    $setSelection(null);
  });
  armed = true;
  t.a.update(() => {
    $setCompositionKey(null);
    ($line().getFirstChildOrThrow() as TextNode).markDirty();
    $setSelection(null);
  });
  await new Promise(r => setTimeout(r, 20));
  armed = false;
  expect(performed).toBe(true);
  await t.sync();
  await t.sync();
  await expectConverged(t.peers);
  for (const p of t.peers) {
    const out = p.read(() => ({
      italic: $line()
        .getAllTextNodes()
        .filter(n => n.hasFormat('italic'))
        .map(n => n.getTextContent())
        .join(''),
      text: $line().getTextContent(),
      types: $line()
        .getAllTextNodes()
        .map(n => n.getType()),
    }));
    expect(out.text).toBe('aaaaaaaREMOTEaa');
    expect(out.italic).toBe('aREMOTEaa');
    expect(out.types.every(x => x === 'text')).toBe(true);
  }
});

test('three nodes of before merged in order, one into the next, are written', async () => {
  const t = await setup(
    () => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('aa').toggleFormat('bold'),
          $createTextNode('aaa'),
          $createTextNode('aaa').toggleFormat('italic'),
        ),
      );
    },
    {
      gc: false,
      ids: [1, 2],
      nodes: [...HOLD_NODES, HashtagNode],
      withBlockIds: false,
    },
  );
  onTestFinished(() => t.peers.forEach(p => p.stop()));
  let armed = false;
  let performed = false;
  onTestFinished(
    t.a.editor.registerNodeTransform(TextNode, node => {
      if (
        !armed ||
        node.getType() !== 'text' ||
        node.getParent()?.getKey() !== $line().getKey()
      )
        return;
      if (!performed && node.getParent()?.getType() === 'heading') {
        performed = true;
        const [a, b, c] = $line().getChildren() as TextNode[];
        a.mergeWithSibling(b).mergeWithSibling(c);
      }
      node.replace($createHashtagNode(node.getTextContent()));
    }),
  );
  t.a.update(() => {
    const n = $line().getFirstChildOrThrow() as TextNode;
    n.select(2, 2);
    $setCompositionKey(n.getKey());
    n.spliceText(2, 0, 'a');
  });
  await t.sync();
  t.b.update(() => {
    const l = $line();
    l.replace($createHeadingNode('h2').append(...l.getChildren()));
    $setSelection(null);
  });
  await t.sync();
  expect(
    (t.a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
  ).not.toBe(null);
  t.offline();
  t.b.update(() => {
    ($line().getLastChildOrThrow() as TextNode).spliceText(1, 0, 'REMOTE');
    $setSelection(null);
  });
  armed = true;
  t.a.update(() => {
    $setCompositionKey(null);
    ($line().getFirstChildOrThrow() as TextNode).markDirty();
    $setSelection(null);
  });
  await new Promise(r => setTimeout(r, 20));
  armed = false;
  expect(performed).toBe(true);
  await t.sync();
  await t.sync();
  await expectConverged(t.peers);
  for (const p of t.peers) {
    const out = p.read(() => ({
      italic: $line()
        .getAllTextNodes()
        .filter(n => n.hasFormat('italic'))
        .map(n => n.getTextContent())
        .join(''),
      text: $line().getTextContent(),
      types: $line()
        .getAllTextNodes()
        .map(n => n.getType()),
    }));
    // Written: one hashtag, with B's edit where it was typed.
    expect(out.text).toBe('aaaaaaaREMOTEaa');
    expect(out.types).toEqual(['hashtag']);
  }
});

test('two retyped nodes of before, taken out and put back swapped, are refused', async () => {
  const t = await setup(
    () => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('#ab').toggleFormat('bold'),
          $createTextNode('#abx'),
        ),
      );
    },
    {
      gc: false,
      ids: [1, 2],
      nodes: [...HOLD_NODES, HashtagNode],
      withBlockIds: false,
    },
  );
  onTestFinished(() => t.peers.forEach(p => p.stop()));
  let armed = false;
  let performed = false;
  onTestFinished(
    t.a.editor.registerNodeTransform(TextNode, node => {
      if (
        !armed ||
        node.getType() !== 'text' ||
        node.getParent()?.getKey() !== $line().getKey()
      )
        return;
      if (!performed && node.getParent()?.getType() === 'heading') {
        performed = true;
        const [a, b] = $line().getChildren() as TextNode[];
        const ha = $createHashtagNode(a.getTextContent());
        const hb = $createHashtagNode(b.getTextContent());
        a.replace(ha);
        b.replace(hb);
        // ha and hb ALREADY carry A/B's identities. Detaching hb, then ha, and
        // attaching hb must not re-label hb as A just because its key is new.
        hb.remove();
        ha.remove();
        $line().append(hb, ha);
        return;
      }
      node.replace($createHashtagNode(node.getTextContent()));
    }),
  );
  t.a.update(() => {
    const n = $line().getFirstChildOrThrow() as TextNode;
    n.select(3, 3);
    $setCompositionKey(n.getKey());
    n.spliceText(3, 0, 'x');
  });
  await t.sync();
  t.b.update(() => {
    const l = $line();
    l.replace($createHeadingNode('h2').append(...l.getChildren()));
    $setSelection(null);
  });
  await t.sync();
  expect(
    (t.a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
  ).not.toBe(null);
  t.offline();
  t.b.update(() => {
    ($line().getFirstChildOrThrow() as TextNode).spliceText(1, 0, 'REMOTE');
    $setSelection(null);
  });
  armed = true;
  t.a.update(() => {
    $setCompositionKey(null);
    ($line().getFirstChildOrThrow() as TextNode).markDirty();
    $setSelection(null);
  });
  await new Promise(r => setTimeout(r, 20));
  armed = false;
  expect(performed).toBe(true);
  await t.sync();
  await t.sync();
  await expectConverged(t.peers);
  for (const p of t.peers) {
    const out = p.read(() => ({
      bold: $line()
        .getAllTextNodes()
        .filter(n => n.hasFormat('bold'))
        .map(n => n.getTextContent())
        .join(''),
      text: $line().getTextContent(),
      types: $line()
        .getAllTextNodes()
        .map(n => n.getType()),
    }));
    expect(out.text).toBe('#REMOTEabx#abx');
    expect(out.bold).toBe('#REMOTEabx');
    expect(out.types.every(x => x === 'text')).toBe(true);
  }
});
