/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// Two @lexical/yjs v2 peers (wired like the React collaboration plugin) edit
// the paragraphs of a QuoteContainerNode while offline, then exchange their
// updates: one splits a paragraph (Enter) or joins two (Backspace at a
// paragraph's start), the other types in the text the edit moves.
//
// The v2 binding stores every element as a Y.XmlElement, so a paragraph in a
// quote container is stored as a paragraph in the root is. Each case
// therefore runs in the root too, and the container must end as the root
// does: the peers agree, and the paragraphs hold the same text.
//
// That is parity, not the absence of loss. A join moves the second
// paragraph's text into the first element and deletes the second, so v2
// loses what the other peer typed in it, in the root as in the container
// (`keepsTyping: false` below). A split keeps the typing in both.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createQuoteContainerNode,
  QuoteContainerExtension,
} from '@lexical/rich-text';
import {
  type BindingV2,
  createBindingV2__EXPERIMENTAL,
  type Provider,
  syncLexicalUpdateToYjsV2__EXPERIMENTAL,
  syncYjsChangesToLexicalV2__EXPERIMENTAL,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
  SKIP_COLLAB_TAG,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  UndoManager,
  type XmlElement,
} from 'yjs';

const REMOTE = 'remote';
const provider = {
  awareness: {
    getLocalState: () => null,
    getStates: () => new Map(),
    off: () => {},
    on: () => {},
    setLocalState: () => {},
    setLocalStateField: () => {},
  },
  connect: () => {},
  disconnect: () => {},
  off: () => {},
  on: () => {},
} as unknown as Provider;

class Peer {
  readonly doc: Doc;
  readonly editor: LexicalEditor & {dispose: () => void};
  readonly binding: BindingV2;

  constructor(clientID: number) {
    this.doc = new Doc({gc: false});
    this.doc.clientID = clientID;
    this.editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [QuoteContainerExtension],
      name: `[v2-quote-container-${clientID}]`,
      onError: e => {
        throw e;
      },
    });
    const binding = createBindingV2__EXPERIMENTAL(
      this.editor,
      'main',
      this.doc,
      new Map([['main', this.doc]]),
    );
    this.binding = binding;
    (binding.root as XmlElement).observeDeep(((
      events: never,
      transaction: {origin: unknown},
    ) => {
      if (transaction.origin !== binding) {
        syncYjsChangesToLexicalV2__EXPERIMENTAL(
          binding,
          provider,
          events,
          transaction as never,
          transaction.origin instanceof UndoManager,
        );
      }
    }) as never);
    this.editor.registerUpdateListener(
      ({
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      }) => {
        if (!tags.has(SKIP_COLLAB_TAG)) {
          syncLexicalUpdateToYjsV2__EXPERIMENTAL(
            binding,
            provider,
            prevEditorState,
            editorState,
            dirtyElements,
            dirtyLeaves,
            normalizedNodes,
            tags,
          );
        }
      },
    );
    this.editor.read(() => {});
  }

  update(fn: () => void) {
    this.editor.update(fn, {discrete: true});
    this.flush();
  }

  /** Applies everything `from` has that this peer lacks. */
  pull(from: Peer) {
    applyUpdate(
      this.doc,
      encodeStateAsUpdate(from.doc, encodeStateVector(this.doc)),
      REMOTE,
    );
    this.flush();
  }

  flush() {
    for (let i = 0; i < 20 && this.editor._pendingEditorState !== null; i++) {
      this.editor.read(() => {});
    }
  }

  describe(): string {
    this.flush();
    return this.editor.read(() =>
      $getRoot().getChildren().map($describe).join(' / '),
    );
  }

  dispose() {
    this.editor.dispose();
    this.doc.destroy();
  }
}

function $describe(node: LexicalNode): string {
  return $isElementNode(node)
    ? `${node.getType()}(${node.getChildren().map($describe).join(' ')})`
    : JSON.stringify(node.getTextContent());
}

const $p = (text: string) =>
  $createParagraphNode().append($createTextNode(text));

function $selectIn(path: number[], offset: number): RangeSelection {
  let node: ElementNode = $getRoot();
  for (const index of path) {
    const child = node.getChildAtIndex(index);
    if (!$isElementNode(child)) {
      throw new Error(`no element at ${path.join('.')}`);
    }
    node = child;
  }
  const text = node.getFirstChild();
  if (!$isTextNode(text)) {
    throw new Error('no text');
  }
  return text.select(offset, offset);
}

type Where = {
  name: string;
  $init: () => void;
  first: number[];
  /** The paragraphs under test, out of a peer's description. */
  inner: (described: string) => string;
};

const IN_ROOT: Where = {
  $init: () =>
    $getRoot().append($p('title'), $p('Lorem ipsum'), $p('dolor'), $p('end')),
  first: [1],
  inner: described =>
    described
      .replace(/^paragraph\("title"\) \/ /, '')
      .replace(/ \/ paragraph\("end"\)$/, '')
      .replace(/ \/ /g, ' '),
  name: 'the root',
};

const IN_CONTAINER: Where = {
  $init: () =>
    $getRoot().append(
      $p('title'),
      $createQuoteContainerNode().append($p('Lorem ipsum'), $p('dolor')),
      $p('end'),
    ),
  first: [1, 0],
  inner: described => {
    const match = described.match(
      /^paragraph\("title"\) \/ quote-container\((.*)\) \/ paragraph\("end"\)$/,
    );
    if (match === null) {
      throw new Error(`the quote container is gone: ${described}`);
    }
    return match[1];
  },
  name: 'a quote container',
};

const second = (first: number[]) => [
  ...first.slice(0, -1),
  first[first.length - 1] + 1,
];

type Scenario = {
  name: string;
  /** Whether v2 keeps what peer B typed, in the root. */
  keepsTyping: boolean;
  typed: string;
  a: (where: Where) => void;
  b: (where: Where) => void;
};

const SCENARIOS: Scenario[] = [
  {
    a: where => {
      $selectIn(where.first, 5).insertParagraph();
    },
    b: where => {
      $selectIn(where.first, 8).insertText('XY');
    },
    keepsTyping: true,
    name: "Enter in 'Lorem ipsum' at 5 ‖ 'XY' typed at 8",
    typed: 'XY',
  },
  {
    a: where => {
      const first = $selectIn(where.first, 0).anchor.getNode();
      const moved = $selectIn(second(where.first), 0).anchor.getNode();
      // What Backspace at the start of 'dolor' does: its text joins the
      // paragraph before it. (deleteCharacter needs a DOM.)
      const block = moved.getParentOrThrow();
      first.getParentOrThrow().append(...block.getChildren());
      block.remove();
    },
    b: where => {
      $selectIn(second(where.first), 2).insertText('XY');
    },
    keepsTyping: false,
    name: "Backspace at the start of 'dolor' ‖ 'XY' typed in it at 2",
    typed: 'XY',
  },
  {
    a: where => {
      $selectIn(where.first, 5).insertParagraph();
    },
    b: where => {
      const text = $selectIn(where.first, 0).anchor.getNode();
      if (!$isTextNode(text)) {
        throw new Error('no text');
      }
      text.spliceText(6, 5, 'IPSUM', true);
    },
    keepsTyping: true,
    name: "Enter in 'Lorem ipsum' at 5 ‖ 'ipsum' replaced by 'IPSUM'",
    typed: 'IPSUM',
  },
];

function run(where: Where, scenario: Scenario, ids: number[]): string {
  const [a, b] = ids.map(id => new Peer(id));
  onTestFinished(() => {
    a.dispose();
    b.dispose();
  });
  a.update(() => {
    $getRoot().clear();
    where.$init();
  });
  b.pull(a);
  expect(b.describe()).toBe(a.describe());
  // Offline: each peer edits without the other's update.
  a.update(() => scenario.a(where));
  b.update(() => scenario.b(where));
  a.pull(b);
  b.pull(a);
  a.pull(b);
  expect(b.describe()).toBe(a.describe());
  return where.inner(a.describe());
}

describe('v2: a split or join of paragraphs ‖ typing in the text it moves', () => {
  for (const scenario of SCENARIOS) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      test(`ids ${ids}: ${scenario.name}: a quote container ends as the root does`, () => {
        const inRoot = run(IN_ROOT, scenario, ids);
        const inContainer = run(IN_CONTAINER, scenario, ids);
        expect(inContainer).toBe(inRoot);
        // The root is the control for what v2 does with the typing.
        expect(inRoot.includes(scenario.typed)).toBe(scenario.keepsTyping);
      });
    }
  }
});
