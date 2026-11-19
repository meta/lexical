/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// registerLexicalTextEntity records what its transforms do with the
// characters they touch (see registerLexicalTextEntityRecord.test.ts), around
// the calls it made before. This compares it with a copy of the helper as it
// was before that change, in two editors with a DOM root driven by the same
// random edits next to two kinds of entities: after every edit, the same
// JSON, the same selection, the same mutation-listener events and the same
// node keys, without recording; with recording too, where the only change in
// the record is that a move stands for the two text sets it replaces, and
// that retypes are added.

import {
  $create,
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  createEditor,
  type EditorState,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  type NodeMap,
  resetRandomKey,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {type EntityMatch, registerLexicalTextEntity} from '../..';

type TextEditRecord =
  NonNullable<EditorState['_textEdits']> extends WeakMap<NodeMap, (infer E)[]>
    ? E
    : never;

/** registerLexicalTextEntity as it was before it recorded its edits. */
function registerLexicalTextEntityBefore<T extends TextNode>(
  editor: LexicalEditor,
  getMatch: (text: string) => null | EntityMatch,
  targetNode: Klass<T>,
  createNode: (textNode: TextNode) => T,
): (() => void)[] {
  const isTargetNode = (node: LexicalNode | null | undefined): node is T => {
    return node instanceof targetNode;
  };

  const $replaceWithSimpleText = (node: TextNode): void => {
    const textNode = $createTextNode(node.getTextContent())
      .setFormat(node.getFormat())
      .setStyle(node.getStyle())
      .setDetail(node.getDetail());
    node.replace(textNode);
  };

  const getMode = (node: TextNode): number => {
    return node.getLatest().__mode;
  };

  const $textNodeTransform = (node: TextNode) => {
    if (!node.isSimpleText()) {
      return;
    }

    let prevSibling = node.getPreviousSibling();
    let text = node.getTextContent();
    let currentNode = node;
    let match;

    if ($isTextNode(prevSibling)) {
      const previousText = prevSibling.getTextContent();
      const combinedText = previousText + text;
      const prevMatch = getMatch(combinedText);

      if (isTargetNode(prevSibling)) {
        if (prevMatch === null || getMode(prevSibling) !== 0) {
          $replaceWithSimpleText(prevSibling);

          return;
        } else {
          const diff = prevMatch.end - previousText.length;

          if (diff > 0) {
            const concatText = text.slice(0, diff);
            const newTextContent = previousText + concatText;
            prevSibling.select();
            prevSibling.setTextContent(newTextContent);

            if (diff === text.length) {
              node.remove();
            } else {
              const remainingText = text.slice(diff);
              node.setTextContent(remainingText);
            }

            return;
          }
        }
      } else if (prevMatch === null || prevMatch.start < previousText.length) {
        return;
      }
    }

    let prevMatchLengthToSkip = 0;

    while (true) {
      const remainingText = text;
      match = getMatch(remainingText);
      const nextText = match === null ? '' : remainingText.slice(match.end);
      text = nextText;

      if (nextText === '') {
        const nextSibling = currentNode.getNextSibling();

        if ($isTextNode(nextSibling)) {
          const combinedText = remainingText + nextSibling.getTextContent();
          const nextMatch = getMatch(combinedText);

          if (nextMatch === null) {
            if (isTargetNode(nextSibling)) {
              $replaceWithSimpleText(nextSibling);
            } else {
              nextSibling.markDirty();
            }

            return;
          } else if (match === null || nextMatch.start !== match.start) {
            return;
          }
        }
      }

      if (match === null) {
        return;
      }

      if (
        match.start === 0 &&
        $isTextNode(prevSibling) &&
        prevSibling.isTextEntity()
      ) {
        prevMatchLengthToSkip += match.end;
        continue;
      }

      let nodeToReplace;
      if (match.start === 0) {
        [nodeToReplace, currentNode] = currentNode.splitText(match.end);
      } else {
        [, nodeToReplace, currentNode] = currentNode.splitText(
          match.start + prevMatchLengthToSkip,
          match.end + prevMatchLengthToSkip,
        );
      }

      if (nodeToReplace === undefined) {
        throw new Error('nodeToReplace should not be undefined');
      }

      const replacementNode = createNode(nodeToReplace);
      replacementNode
        .setFormat(nodeToReplace.getFormat())
        .setStyle(nodeToReplace.getStyle())
        .setDetail(nodeToReplace.getDetail());
      nodeToReplace.replace(replacementNode);

      if (currentNode == null) {
        return;
      }
      prevMatchLengthToSkip = 0;
      prevSibling = replacementNode;
    }
  };

  const $reverseNodeTransform = (node: T) => {
    const text = node.getTextContent();
    const match = getMatch(text);

    if (match === null || match.start !== 0) {
      $replaceWithSimpleText(node);

      return;
    }

    if (text.length > match.end) {
      node.splitText(match.end);

      return;
    }

    const prevSibling = node.getPreviousSibling();

    if ($isTextNode(prevSibling) && prevSibling.isTextEntity()) {
      $replaceWithSimpleText(prevSibling);
      $replaceWithSimpleText(node);
    }

    const nextSibling = node.getNextSibling();

    if ($isTextNode(nextSibling) && nextSibling.isTextEntity()) {
      $replaceWithSimpleText(nextSibling);

      if (isTargetNode(node)) {
        $replaceWithSimpleText(node);
      }
    }
  };

  const removePlainTextTransform = editor.registerNodeTransform(
    TextNode,
    $textNodeTransform,
  );
  const removeReverseNodeTransform = editor.registerNodeTransform(
    targetNode,
    $reverseNodeTransform,
  );

  return [removePlainTextTransform, removeReverseNodeTransform];
}

/** A hashtag-like entity whose setter refuses to clear it. */
class TagNode extends TextNode {
  $config() {
    return this.config('equivalence-tag', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
  setTextContent(text: string): this {
    if (text === '' && this.getTextContent() !== '') {
      throw new Error('a tag is never cleared');
    }
    return super.setTextContent(text);
  }
}

/** A plain entity (the review's repros). */
class EntityNode extends TextNode {
  $config() {
    return this.config('equivalence-entity', {extends: TextNode});
  }
  isTextEntity(): true {
    return true;
  }
}

/** A keyword entity that text is not typed into from either end. */
class KeywordNode extends TextNode {
  $config() {
    return this.config('equivalence-keyword', {extends: TextNode});
  }
  canInsertTextBefore(): boolean {
    return false;
  }
  canInsertTextAfter(): boolean {
    return false;
  }
  isTextEntity(): true {
    return true;
  }
}

const tagMatch = (text: string): null | EntityMatch => {
  const m = /#[a-z0-9]+/.exec(text);
  return m === null ? null : {end: m.index + m[0].length, start: m.index};
};
const keywordMatch = (text: string): null | EntityMatch => {
  const m = /(^|\s)(la)(?=\s|$)/.exec(text);
  if (m === null) {
    return null;
  }
  const start = m.index + m[1].length;
  return {end: start + 2, start};
};

type Register = typeof registerLexicalTextEntity;

function makeEditor(register: Register, record: boolean) {
  const editor = createEditor({
    nodes: [TagNode, KeywordNode],
    onError: e => {
      throw e;
    },
  });
  editor._recordTextEdits = record;
  register(editor, tagMatch, TagNode, node =>
    $create(TagNode).setTextContent(node.getTextContent()),
  );
  register(editor, keywordMatch, KeywordNode, node =>
    $create(KeywordNode).setTextContent(node.getTextContent()),
  );
  const events: unknown[] = [];
  for (const klass of [TextNode, TagNode, KeywordNode]) {
    editor.registerMutationListener(
      klass,
      mutations => {
        events.push([klass.getType(), [...mutations.entries()].sort()]);
      },
      {skipInitialization: true},
    );
  }
  editor.setRootElement(document.createElement('div'));
  return {editor, events};
}

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

const $texts = (): TextNode[] => {
  const line = $getRoot().getFirstChildOrThrow();
  return $isElementNode(line) ? line.getChildren().filter($isTextNode) : [];
};

function $pointAt(at: number, left: boolean): [TextNode, number] | null {
  let p = 0;
  let found: [TextNode, number] | null = null;
  for (const t of $texts()) {
    const n = t.getTextContentSize();
    if (at >= p && at <= p + n) {
      found = [t, at - p];
      if (left || at < p + n) {
        return found;
      }
    }
    p += n;
  }
  return found;
}

function $selection(): unknown {
  const s = $getSelection();
  if ($isRangeSelection(s)) {
    return [
      s.anchor.key,
      s.anchor.offset,
      s.anchor.type,
      s.focus.key,
      s.focus.offset,
      s.focus.type,
      s.format,
      s.style,
    ];
  }
  return $isNodeSelection(s) ? s.getNodes().map(n => n.getKey()) : null;
}

const PIECES = ['#ab', ' ', 'la', 'la ', 'cd', '#', 'x y', 'ab', ' #c', 'a '];
const TYPED = ['a', ' ', '#', 'la', 'b ', '#ab', 'x', 'l', 'a ', '1', 'cd'];
const KINDS = [
  'type',
  'type',
  'backspace',
  'delete',
  'over',
  'set',
  'remove',
] as const;

type Op = {
  at: number;
  /** At the end of text node `node` instead of at `at`. */
  edge: boolean;
  kind: (typeof KINDS)[number];
  left: boolean;
  len: number;
  node: number;
  s: string;
};

/** One edit, as a caret edit (or app code setting or removing a node). */
function $apply(op: Op): void {
  const textLen = $getRoot().getTextContent().length;
  if (op.kind === 'set' || op.kind === 'remove') {
    const texts = $texts();
    const node = texts[op.node % Math.max(1, texts.length)];
    if (node === undefined) {
      return;
    }
    if (op.kind === 'remove') {
      node.remove();
    } else {
      const t = node.getTextContent();
      const at = op.at % (t.length + 1);
      const next = t.slice(0, at) + op.s + t.slice(at + op.len);
      if (next !== '') {
        node.setTextContent(next);
      }
    }
    return;
  }
  let at = op.at;
  if (op.edge) {
    const texts = $texts();
    at = 0;
    for (const t of texts.slice(0, (op.node % texts.length) + 1)) {
      at += t.getTextContentSize();
    }
  }
  let from = at;
  let to = at;
  if (op.kind === 'backspace') {
    from = at - 1;
  } else if (op.kind === 'delete') {
    to = at + 1;
  } else if (op.kind === 'over') {
    to = Math.min(textLen, at + op.len);
  }
  if (from < 0 || to > textLen) {
    return;
  }
  const a = $pointAt(from, from === to ? op.left : true);
  const b = from === to ? a : $pointAt(to, false);
  if (a === null || b === null) {
    return;
  }
  const sel = $createRangeSelection();
  sel.anchor.set(a[0].getKey(), a[1], 'text');
  sel.focus.set(b[0].getKey(), b[1], 'text');
  $setSelection(sel);
  if (op.kind === 'type' || op.kind === 'over') {
    sel.insertText(op.s);
  } else if (from !== to) {
    sel.removeText();
  }
}

/**
 * The record of an update as it was before (see the header): each move as
 * the two text sets it stands for (the second, of the node it left, only
 * where it left any text there), without retypes.
 */
function expand(log: readonly TextEditRecord[]): TextEditRecord[] {
  const out: TextEditRecord[] = [];
  for (const e of log) {
    if (e[0] === 'move') {
      const [, from, to, count, fromText, toText] = e;
      out.push(['set', to, toText, toText + fromText.slice(0, count)]);
      if (count < fromText.length) {
        out.push(['set', from, fromText, fromText.slice(count)]);
      }
    } else if (e[0] !== 'retype') {
      out.push(e);
    }
  }
  return out;
}

type Step = {
  events: unknown[];
  json: unknown;
  log: TextEditRecord[] | null;
  result: string;
  selection: unknown;
};

/** A session: its initial pieces, then its ops, each step after an op. */
function session(
  register: Register,
  record: boolean,
  pieces: string[],
  ops: Op[],
): Step[] {
  resetRandomKey();
  const {editor, events} = makeEditor(register, record);
  editor.update(
    () => {
      $getRoot().append(
        $createParagraphNode().append(...pieces.map(s => $createTextNode(s))),
      );
    },
    {discrete: true},
  );
  const steps: Step[] = [];
  for (const op of ops) {
    events.length = 0;
    const prev = editor.getEditorState();
    let result = 'ok';
    try {
      editor.update(() => $apply(op), {discrete: true});
    } catch (e) {
      result = String(e);
    }
    const state = editor.getEditorState();
    const log =
      state._textEdits === null
        ? null
        : (state._textEdits.get(prev._nodeMap) ?? null);
    steps.push({
      events: [...events],
      json: state.toJSON(),
      log: log === null ? null : [...log],
      result,
      selection: editor.read($selection),
    });
  }
  // (Unregister its DOM listeners: thousands of editors are made here.)
  editor.setRootElement(null);
  return steps;
}

const SESSIONS = Number(process.env.TEXT_ENTITY_EQUIVALENCE_SESSIONS || 300);

describe('registerLexicalTextEntity against the helper before it recorded its edits', () => {
  for (const record of [false, true]) {
    test(
      `${SESSIONS} random sessions of 8 edits next to entities, ${
        record ? 'recording' : 'not recording'
      } text edits: the same JSON, selection, mutations and keys`,
      () => {
        let moves = 0;
        let retypes = 0;
        for (let seed = 1; seed <= SESSIONS; seed++) {
          const r = rng(seed * 7919 + 13);
          const pick = <X>(xs: readonly X[]): X =>
            xs[Math.floor(r() * xs.length)];
          const pieces = Array.from({length: 2 + Math.floor(r() * 4)}, () =>
            pick(PIECES),
          );
          const ops: Op[] = Array.from({length: 8}, () => ({
            at: Math.floor(r() * 20),
            edge: r() < 0.5,
            kind: pick(KINDS),
            left: r() < 0.5,
            len: Math.floor(r() * 3),
            node: Math.floor(r() * 6),
            s: pick(TYPED),
          }));
          const before = session(
            registerLexicalTextEntityBefore,
            record,
            pieces,
            ops,
          );
          const after = session(registerLexicalTextEntity, record, pieces, ops);
          for (let k = 0; k < ops.length; k++) {
            const a = before[k];
            const b = after[k];
            const where = `seed ${seed}, edit ${k} ${JSON.stringify(ops[k])}`;
            expect({...b, log: null}, where).toEqual({...a, log: null});
            if (!record) {
              expect(b.log, where).toBe(null);
              continue;
            }
            expect(b.log && expand(b.log), where).toEqual(a.log);
            for (const e of b.log ?? []) {
              moves += e[0] === 'move' ? 1 : 0;
              retypes += e[0] === 'retype' ? 1 : 0;
            }
          }
        }
        if (record) {
          // The sessions do grow and remake entities.
          expect(moves).toBeGreaterThan(SESSIONS / 8);
          expect(retypes).toBeGreaterThan(SESSIONS);
        }
      },
      5000 + 20 * SESSIONS,
    );
  }
});

describe('the edge cases where a change of the calls would differ', () => {
  // Merging into a fresh node instead of replace() would leave a stale caret
  // inside the entity unclamped, run a setter that refuses empty text, and
  // turn a NodeSelection into a range: the helper makes the same calls.
  type Case = 'range' | 'node selection' | 'strict setter' | 'shortened';
  const run = (register: Register, record: boolean, kind: Case) => {
    resetRandomKey();
    const errors: string[] = [];
    const editor = createEditor({
      nodes: [TagNode, EntityNode],
      onError: e => {
        errors.push(e.message);
      },
    });
    editor._recordTextEdits = record;
    const $entity = (text: string) =>
      kind === 'strict setter'
        ? $create(TagNode).setTextContent(text)
        : $create(EntityNode).setTextContent(text);
    if (kind === 'strict setter') {
      register(editor, tagMatch, TagNode, node =>
        $create(TagNode).setTextContent(node.getTextContent()),
      );
    } else {
      register(editor, tagMatch, EntityNode, node =>
        $create(EntityNode).setTextContent(node.getTextContent()),
      );
    }
    editor.setRootElement(document.createElement('div'));
    if (kind === 'shortened') {
      editor.update(
        () => {
          const node = $entity('#abc');
          $getRoot().append($createParagraphNode().append(node));
          node.select(4, 4);
        },
        {discrete: true},
      );
      editor.update(
        () => {
          ($getRoot().getFirstDescendant() as TextNode).setTextContent('xx');
        },
        {discrete: true},
      );
    } else {
      editor.update(
        () => {
          const text = $createTextNode('#abc');
          $getRoot().append($createParagraphNode().append(text));
          if (kind === 'node selection') {
            const sel = $createNodeSelection();
            sel.add(text.getKey());
            $setSelection(sel);
          } else {
            const sel = text.select(2, 3);
            sel.setFormat(1);
            sel.setStyle('color: red');
          }
        },
        {discrete: true, skipTransforms: true},
      );
      editor.update(
        () => {
          ($getRoot().getFirstDescendant() as TextNode).markDirty();
        },
        {discrete: true},
      );
    }
    const result = {
      errors,
      json: editor.getEditorState().toJSON(),
      selection: editor.read($selection),
    };
    editor.setRootElement(null);
    return result;
  };
  for (const kind of [
    'range',
    'node selection',
    'strict setter',
    'shortened',
  ] as const) {
    for (const record of [false, true]) {
      test(`${kind}, ${record ? 'recording' : 'not recording'}`, () => {
        const before = run(registerLexicalTextEntityBefore, record, kind);
        expect(run(registerLexicalTextEntity, record, kind)).toEqual(before);
        expect(before.errors).toEqual([]);
      });
    }
  }
});
