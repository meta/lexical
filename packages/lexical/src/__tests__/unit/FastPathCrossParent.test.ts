/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions} from '@lexical/extension';
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalEditor,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {__benchOnly} from '../../LexicalReconciler';
import {$createTestDecoratorNode, TestDecoratorNode} from '../utils';

function makeEditor(): LexicalEditor {
  const editor = buildEditorFromExtensions({
    dependencies: [RichTextExtension, LinkExtension],
    name: 'fast-path-cross-parent',
    nodes: [TestDecoratorNode],
    onError: e => {
      throw e;
    },
  });
  editor.setRootElement(document.createElement('div'));
  return editor;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng: () => number, len: number): number {
  return Math.floor(rng() * len);
}

// Two big paragraphs (>= 4 inline children each, engaging the fast path on
// both), plus ops that MOVE children between them and wrap children in links —
// stressing first-text-key cache transfer and cross-parent DOM reuse.
function seedTwoParas(editor: LexicalEditor): void {
  editor.update(
    () => {
      const root = $getRoot().clear();
      for (let p = 0; p < 2; p++) {
        const para = $createParagraphNode();
        for (let i = 0; i < 5; i++) {
          para.append($createTextNode(`p${p}w${i}`));
        }
        root.append(para);
      }
    },
    {discrete: true},
  );
}

const OPS: ((rng: () => number) => void)[] = [
  // move a child from one paragraph to the end of the other
  rng => {
    const paras = $getRoot().getChildren();
    if (paras.length < 2) {
      return;
    }
    const fromIdx = pick(rng, paras.length);
    const toIdx = (fromIdx + 1) % paras.length;
    const from = paras[fromIdx];
    const to = paras[toIdx];
    if ($isElementNode(from) && $isElementNode(to)) {
      const kids = from.getChildren();
      if (kids.length > 0) {
        to.append(kids[pick(rng, kids.length)]);
      }
    }
  },
  // move a child to the FRONT of the other paragraph (changes __first)
  rng => {
    const paras = $getRoot().getChildren();
    if (paras.length < 2) {
      return;
    }
    const fromIdx = pick(rng, paras.length);
    const toIdx = (fromIdx + 1) % paras.length;
    const from = paras[fromIdx];
    const to = paras[toIdx];
    if ($isElementNode(from) && $isElementNode(to)) {
      const kids = from.getChildren();
      const first = to.getFirstChild();
      if (kids.length > 0 && first) {
        first.insertBefore(kids[pick(rng, kids.length)]);
      }
    }
  },
  // wrap a child in a link (cross-parent move into a new inline element)
  rng => {
    const paras = $getRoot().getChildren();
    const para = paras[pick(rng, paras.length)];
    if ($isElementNode(para)) {
      const kids = para.getChildren();
      if (kids.length > 0) {
        const target = kids[pick(rng, kids.length)];
        const link = $createLinkNode('https://example.com');
        target.insertBefore(link);
        link.append(target);
      }
    }
  },
  // append text to a paragraph
  rng => {
    const paras = $getRoot().getChildren();
    const para = paras[pick(rng, paras.length)];
    if ($isElementNode(para)) {
      para.append($createTextNode('x'));
    }
  },
  // toggle format on the first child (stresses first-text-key)
  rng => {
    const paras = $getRoot().getChildren();
    const para = paras[pick(rng, paras.length)];
    if ($isElementNode(para)) {
      const first = para.getFirstChild();
      if ($isTextNode(first)) {
        first.toggleFormat('bold');
      }
    }
  },
  // remove the first child (first-text key changes)
  rng => {
    const paras = $getRoot().getChildren();
    const para = paras[pick(rng, paras.length)];
    if ($isElementNode(para)) {
      const first = para.getFirstChild();
      if (first) {
        first.remove();
      }
    }
  },
  // append a decorator / linebreak
  rng => {
    const paras = $getRoot().getChildren();
    const para = paras[pick(rng, paras.length)];
    if ($isElementNode(para)) {
      para.append(
        rng() < 0.5 ? $createTestDecoratorNode() : $createLineBreakNode(),
      );
    }
  },
];

function snapshot(editor: LexicalEditor): {
  json: string;
  text: string;
  dom: string;
} {
  // Read JSON and text from the SAME committed editor state so all three
  // observations are one consistent snapshot. `editor.read` would flush any
  // pending update first and could read a different state than `toJSON`.
  const state = editor.getEditorState();
  return {
    dom: editor.getRootElement()!.innerHTML,
    json: JSON.stringify(state.toJSON()),
    text: state.read(() => $getRoot().getTextContent(), {editor}),
  };
}

// Differential guard: a sequence of cross-parent moves (plus link-wrapping
// and edits) applied to one editor with the children fast path live must
// produce the same editor state, serialized JSON, and DOM as the same
// sequence applied with the fast path disabled (the general walk).
describe('fast path differential fuzz — cross-parent moves', () => {
  afterEach(() => {
    __benchOnly.skipChildrenFastPath = false;
  });

  test('fast path matches the general walk across cross-parent moves', () => {
    const SEEDS = 100;
    const OPS_PER_RUN = 20;
    for (let s = 0; s < SEEDS; s++) {
      const fast = makeEditor();
      const slow = makeEditor();
      try {
        seedTwoParas(fast);
        seedTwoParas(slow);
        const rng = mulberry32(0x165667b1 ^ s);
        for (let i = 0; i < OPS_PER_RUN; i++) {
          const op = OPS[Math.floor(rng() * OPS.length)];
          const localSeed = Math.floor(rng() * 0xffffffff);
          __benchOnly.skipChildrenFastPath = false;
          fast.update(() => op(mulberry32(localSeed)), {discrete: true});
          __benchOnly.skipChildrenFastPath = true;
          slow.update(() => op(mulberry32(localSeed)), {discrete: true});
          __benchOnly.skipChildrenFastPath = false;
          const f = snapshot(fast);
          const sl = snapshot(slow);
          expect(f.text, `seed ${s} step ${i}: text`).toBe(sl.text);
          expect(f.json, `seed ${s} step ${i}: json`).toBe(sl.json);
          expect(f.dom, `seed ${s} step ${i}: dom`).toBe(sl.dom);
        }
      } finally {
        __benchOnly.skipChildrenFastPath = false;
        fast.setRootElement(null);
        slow.setRootElement(null);
      }
    }
    // 2,000 updates of each editor take seconds on a loaded machine.
  }, 30_000);
});
