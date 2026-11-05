/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// An app's code that runs in the update of a remote change's read, after
// the binding's read, and edits the document: a TextNode's
// selectionTransform. The read's commit is tagged as a remote change, which
// is not written: A showed "tail!" while the document, every other peer and
// a fresh reader had "tail". The edit is now written (A's own, not in the
// undo history), and every peer reads it. Where a selectionTransform moved
// the caret, Lexical extended the read's commit with SELECTION_CHANGE_COMMAND
// (its handlers' edits unwritten too) and ran every node transform in it;
// the command now runs once the read has committed, in an update of its
// own, and the read runs no node transforms.

import {$createCodeNode} from '@lexical/code';
import {registerCodeHighlighting} from '@lexical/code-prism';
import {
  $createListItemNode,
  $createListNode,
  type ListNode,
} from '@lexical/list';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getDocument,
  $getEditor,
  $getRoot,
  $getSelection,
  $getState,
  $hasUpdateTag,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  $setSlot,
  $setState,
  arrayValue,
  type BaseSelection,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  createState,
  DecoratorNode,
  type ElementNode,
  type LexicalEditor,
  nodeSchema,
  numberValue,
  ParagraphNode,
  type RangeSelection,
  SELECTION_CHANGE_COMMAND,
  stringValue,
  TextNode,
  withField,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {expectConverged, freshReader, NODES, setup} from '../../utils/harness';

const shut = createState('read_edit_shut', {parse: v => v === true});

/** A paragraph an app's NodeState flag shuts. */
class Line extends ParagraphNode {
  $config() {
    return this.config('read_edit_line', {
      extends: ParagraphNode,
      stateConfigs: [{stateConfig: shut}],
    });
  }
}

/** Whether the first line is shut now and in the state committed before. */
function $shutNowAndBefore(): boolean {
  const first = $getRoot().getFirstChild();
  if (first === null || !$getState(first, shut)) {
    return false;
  }
  return $getEditor()
    .getEditorState()
    .read(() => {
      const was = $getRoot().getFirstChild();
      return was !== null && $getState(was, shut);
    });
}

/** Append `mark` to the last line's text, once per editor. */
function $appendOnce(done: WeakSet<LexicalEditor>, mark: string): void {
  const editor = $getEditor();
  if (done.has(editor)) {
    return;
  }
  const last = $getRoot().getLastChild();
  const text = $isElementNode(last) ? last.getLastDescendant() : null;
  if ($isTextNode(text)) {
    done.add(editor);
    text.setTextContent(text.getTextContent() + mark);
  }
}

const hooked = new WeakSet<LexicalEditor>();

/** Edits the last line from its selectionTransform once its line is shut. */
class EditingText extends TextNode {
  $config() {
    return this.config('read_edit_editing', {extends: TextNode});
  }
  selectionTransform(_prev: BaseSelection | null, _next: RangeSelection) {
    if ($shutNowAndBefore()) {
      $appendOnce(hooked, '!');
    }
  }
}

/**
 * Moves a collapsed caret in it to the end of the text before it once its
 * line is shut (a selection change Lexical then notifies).
 */
class LeaningText extends TextNode {
  $config() {
    return this.config('read_edit_leaning', {extends: TextNode});
  }
  selectionTransform(_prev: BaseSelection | null, next: RangeSelection) {
    const previous = this.getPreviousSibling();
    if (
      !$shutNowAndBefore() ||
      !next.isCollapsed() ||
      next.anchor.key !== this.getKey() ||
      !$isTextNode(previous)
    ) {
      return;
    }
    const size = previous.getTextContentSize();
    next.anchor.set(previous.getKey(), size, 'text');
    next.focus.set(previous.getKey(), size, 'text');
  }
}

type Shape = 'selectionTransform' | 'selection command' | 'node transform';

async function run(shape: Shape, gc: boolean, ids: number[]): Promise<void> {
  const t = await setup(
    () =>
      $getRoot().append(
        $create(Line).append(
          $createTextNode('one '),
          shape === 'selectionTransform'
            ? $create(EditingText).setTextContent('two')
            : $create(LeaningText).setTextContent('two'),
        ),
        $createParagraphNode().append($createTextNode('three')),
        $createParagraphNode().append($createTextNode('tail')),
      ),
    {gc, ids, nodes: [...NODES, Line, EditingText, LeaningText]},
  );
  const {a, b, c} = t;
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  a.editor.setRootElement(host);
  host.focus();
  onTestFinished(() => {
    a.editor.setRootElement(null);
    host.remove();
    t.peers.forEach(p => p.stop());
  });
  const done = new WeakSet<LexicalEditor>();
  if (shape === 'selection command') {
    onTestFinished(
      a.editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          if ($shutNowAndBefore()) {
            $appendOnce(done, '?');
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  } else if (shape === 'node transform') {
    onTestFinished(
      a.editor.registerNodeTransform(TextNode, () => {
        if ($shutNowAndBefore()) {
          $appendOnce(done, '*');
        }
      }),
    );
  }
  a.update(() => {
    $getRoot().getAllTextNodes()[1].select(1, 1);
  });
  await t.sync();
  // C shuts the first line, and B edits the second; A reads C's change,
  // then B's, in which the app's code runs (the line was shut before).
  c.update(() => {
    $setState($getRoot().getFirstChildOrThrow(), shut, true);
    $setSelection(null);
  });
  b.update(() => {
    const three = $getRoot().getAllTextNodes()[2];
    three.setTextContent('three 3');
    $setSelection(null);
  });
  await t.sync();
  const shown = a.describe();
  if (shape === 'node transform') {
    // A read runs no node transforms, also where an app's
    // selectionTransform moved the caret after it: Lexical would run them
    // over what the read brought as it notifies the selection change.
    expect(shown).toMatch(/"tail"/);
  } else {
    expect(shown).toMatch(/tail[!?]/);
  }
  expect(shown).toBe((await freshReader(a)).describe());
  await expectConverged(t.peers);
}

describe('an app edit made in the update of a remote read is stored', () => {
  for (const shape of [
    'selectionTransform',
    'selection command',
    'node transform',
  ] as const) {
    for (const gc of [false, true]) {
      for (const ids of [
        [1, 2, 3],
        [3, 2, 1],
      ]) {
        test(`${shape}, gc ${gc}, ids ${ids}`, () => run(shape, gc, ids));
      }
    }
  }
});

const payload = createState('read_edit_payload', {parse: v => v ?? null});

type Kind =
  | 'NodeState'
  | 'move'
  | 'appended text'
  | 'empty line style'
  | 'merged tokens'
  | 'NodeState shaped like a node'
  | 'line break line style'
  | 'decorator JSON shaped like text'
  | 'decorator line format'
  | 'slot text host format'
  | 'text the read changed'
  | 'slot the read changed'
  | 'list item at the start'
  | 'update the app queues';

/** The kinds, and one the document cannot store. */
type Edit = Kind | 'unstorable slot';

/** One edit of `kind`, once per editor. */
function $editOnce(done: WeakSet<LexicalEditor>, kind: Edit): void {
  const editor = $getEditor();
  if (done.has(editor)) {
    return;
  }
  done.add(editor);
  const lines = $getRoot().getChildren();
  const tail = lines[2];
  if (!$isElementNode(tail)) {
    return;
  }
  if (kind === 'NodeState') {
    $setState(tail.getFirstDescendant()!, payload, {deep: {at: ['x']}, n: 1});
  } else if (kind === 'move') {
    // Within the same parent: only the order of the lines changes.
    lines[1].insertBefore(tail);
  } else if (kind === 'appended text') {
    // Lexical merges it into the text before it as it commits.
    tail.append($createTextNode('!'));
  } else if (kind === 'NodeState shaped like a node') {
    // Keys a node's JSON has too.
    $setState(tail, payload, {children: ['x'], textStyle: 'NEW'});
  } else if (kind === 'line break line style') {
    // An element with no text in it keeps the style set on it.
    (lines[5] as ParagraphNode).setTextStyle('color: blue');
  } else if (kind === 'decorator JSON shaped like text') {
    // Its JSON has `text`, `textFormat` and `children`: none is derived.
    const data = (lines[6] as ParagraphNode).getFirstChildOrThrow() as DataNode;
    data.getWritable().__formatData = 2;
  } else if (kind === 'decorator line format') {
    // A line holding only a decorator has no text to take a format from.
    (lines[6] as ParagraphNode).setTextFormat(2);
  } else if (kind === 'unstorable slot') {
    // A plain paragraph is stored as a line, which has no slots.
    $setSlot(
      tail as unknown as CaptionedNode,
      'title',
      $createParagraphNode().append($createTextNode('nowhere')),
    );
  } else if (kind === 'update the app queues') {
    // Lexical runs it in the read's update, behind the read.
    editor.update(() => {
      const text = (
        $getRoot().getChildAtIndex(2) as ParagraphNode
      ).getFirstChildOrThrow() as TextNode;
      text.setTextContent(text.getTextContent() + '+');
    });
  } else if (kind === 'slot the read changed') {
    // The read set this slot on the host; the app sets it again.
    $setSlot(
      lines[7] as CaptionedNode,
      'title',
      $createParagraphNode().append($createTextNode('app caption')),
    );
  } else if (kind === 'list item at the start') {
    // Every item after it takes a new value.
    const list = lines[8] as ListNode;
    list
      .getFirstChildOrThrow()
      .insertBefore($createListItemNode().append($createTextNode('first')));
  } else if (kind === 'text the read changed') {
    // The read's own node, which Lexical changes in place from then on.
    const three = (
      lines[1] as ParagraphNode
    ).getFirstChildOrThrow() as TextNode;
    three.setTextContent(three.getTextContent() + '#');
  } else if (kind === 'slot text host format') {
    // Its only text is in a named slot, which the reconciler renders apart.
    (lines[7] as CaptionedNode).setTextFormat(2);
  } else if (kind === 'merged tokens') {
    // Two token nodes, which Lexical does not merge itself.
    const [first, second] = (lines[4] as ParagraphNode).getAllTextNodes();
    first.mergeWithSibling(second);
  } else {
    (lines[3] as ParagraphNode).setTextStyle('color: red');
  }
}

const dataSchema = nodeSchema<DataNode>()({
  children: withField(arrayValue(stringValue()), {field: '__jsonChildren'}),
  text: withField(stringValue(), {field: '__caption'}),
  textFormat: withField(numberValue(), {field: '__formatData'}),
});

/** A decorator whose JSON has the keys a text node's and an element's have. */
class DataNode extends DecoratorNode<null> {
  __caption: string = 'opaque';
  __formatData: number = 0;
  __jsonChildren: string[] = [];
  $config() {
    return this.config('read_edit_data', {
      extends: DecoratorNode,
      json: dataSchema,
    });
  }
  isInline(): true {
    return true;
  }
  createDOM(): HTMLElement {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/** A paragraph with a named slot next to its children (a card's title). */
class CaptionedNode extends ParagraphNode {
  $config() {
    return this.config('read_edit_captioned', {
      extends: ParagraphNode,
      slots: ['title'],
    });
  }
}

const kinds = new WeakMap<LexicalEditor, Edit>();
const kindsDone = new WeakSet<LexicalEditor>();

/** Makes its editor's kind of edit from its selectionTransform once its line is shut. */
class KindText extends TextNode {
  $config() {
    return this.config('read_edit_kind', {extends: TextNode});
  }
  selectionTransform(_prev: BaseSelection | null, _next: RangeSelection) {
    const kind = kinds.get($getEditor());
    if (kind !== undefined && $shutNowAndBefore()) {
      $editOnce(kindsDone, kind);
    }
  }
}

/** JSON with every object's keys in order. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)),
        )
      : v,
  );
}

async function runKind(kind: Kind, gc: boolean): Promise<void> {
  const t = await setup(
    () =>
      $getRoot().append(
        $create(Line).append(
          $createTextNode('one '),
          $create(KindText).setTextContent('two'),
        ),
        $createParagraphNode().append($createTextNode('three')),
        $setState(
          $createParagraphNode().append($createTextNode('tail')),
          payload,
          {children: ['x'], textStyle: 'OLD'},
        ),
        $createParagraphNode(),
        $createParagraphNode().append(
          $createTextNode('to').setMode('token'),
          $createTextNode('ken').setMode('token'),
        ),
        $createParagraphNode().append($createLineBreakNode()),
        $createParagraphNode().append($create(DataNode)),
        $setSlot(
          $create(CaptionedNode),
          'title',
          $createParagraphNode().append($createTextNode('caption')),
        ),
        $createListNode('number').append(
          $createListItemNode().append($createTextNode('second')),
          $createListItemNode().append($createTextNode('third')),
        ),
      ),
    {
      gc,
      ids: [1, 2, 3],
      nodes: [...NODES, Line, KindText, DataNode, CaptionedNode],
    },
  );
  const {a, b, c} = t;
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  a.editor.setRootElement(host);
  host.focus();
  onTestFinished(() => {
    a.editor.setRootElement(null);
    host.remove();
    t.peers.forEach(p => p.stop());
  });
  kinds.set(a.editor, kind);
  a.update(() => {
    $getRoot().getAllTextNodes()[1].select(1, 1);
  });
  await t.sync();
  c.update(() => {
    $setState($getRoot().getFirstChildOrThrow(), shut, true);
    $setSelection(null);
  });
  b.update(() => {
    $getRoot().getAllTextNodes()[2].setTextContent('three 3');
    if (kind === 'slot the read changed') {
      $setSlot(
        $getRoot().getChildAtIndex(7) as CaptionedNode,
        'title',
        $createParagraphNode().append($createTextNode('remote caption')),
      );
    }
    $setSelection(null);
  });
  await t.sync();
  expect(kindsDone.has(a.editor)).toBe(true);
  const shown = stable(a.json());
  expect(shown).toContain(
    {
      NodeState: '"read_edit_payload":{"deep":{"at":["x"]},"n":1}',
      'NodeState shaped like a node':
        '"read_edit_payload":{"children":["x"],"textStyle":"NEW"}',
      'appended text': '"text":"tail!"',
      'decorator JSON shaped like text': '"text":"opaque","textFormat":2',
      'decorator line format':
        '"textFormat":2,"textStyle":"","type":"paragraph"',
      'empty line style': '"textStyle":"color: red"',
      'line break line style': '"textStyle":"color: blue"',
      'list item at the start': '"text":"first"',
      'merged tokens': '"text":"token"',
      move: '"text":"tail"',
      'slot text host format':
        '"textFormat":2,"textStyle":"","type":"read_edit_captioned"',
      'slot the read changed': '"text":"app caption"',
      'text the read changed': '"text":"three 3#"',
      'update the app queues': '"text":"tail+"',
    }[kind],
  );
  if (kind === 'move') {
    expect(a.describe()).toMatch(/"tail".*"three 3"/);
  }
  expect(shown).toBe(stable((await freshReader(a)).json()));
  await expectConverged(t.peers);
}

describe('every kind of app edit made in the update of a remote read is stored', () => {
  for (const kind of [
    'NodeState',
    'move',
    'appended text',
    'empty line style',
    'merged tokens',
    'NodeState shaped like a node',
    'line break line style',
    'decorator JSON shaped like text',
    'decorator line format',
    'slot text host format',
    'text the read changed',
    'slot the read changed',
    'list item at the start',
    'update the app queues',
  ] as const) {
    for (const gc of [false, true]) {
      test(`${kind}, gc ${gc}`, () => runKind(kind, gc));
    }
  }
});

/**
 * Sets a selection of its own at the end of the text before it, once its
 * line is shut (Lexical then extends the read's commit with the selection
 * change command itself).
 */
class ReplacingText extends TextNode {
  $config() {
    return this.config('read_edit_replacing', {extends: TextNode});
  }
  selectionTransform(_prev: BaseSelection | null, next: RangeSelection) {
    const previous = this.getPreviousSibling();
    if (
      !$shutNowAndBefore() ||
      !next.isCollapsed() ||
      next.anchor.key !== this.getKey() ||
      !$isTextNode(previous)
    ) {
      return;
    }
    const size = previous.getTextContentSize();
    const selection = $createRangeSelection();
    selection.anchor.set(previous.getKey(), size, 'text');
    selection.focus.set(previous.getKey(), size, 'text');
    $setSelection(selection);
  }
}

describe('the selection change an app makes in a remote read is notified once', () => {
  for (const shape of [
    'moved',
    'replaced',
    'replaced after the read moved it',
  ] as const) {
    for (const gc of [false, true]) {
      test(`${shape}, gc ${gc}`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $create(Line).append(
                $createTextNode('one '),
                shape === 'moved'
                  ? $create(LeaningText).setTextContent('two')
                  : $create(ReplacingText).setTextContent('two'),
              ),
              $createParagraphNode().append($createTextNode('three')),
            ),
          {
            gc,
            ids: [1, 2, 3],
            nodes: [...NODES, Line, LeaningText, ReplacingText],
          },
        );
        const {a, b, c} = t;
        const host = document.createElement('div');
        host.contentEditable = 'true';
        document.body.append(host);
        a.editor.setRootElement(host);
        host.focus();
        onTestFinished(() => {
          a.editor.setRootElement(null);
          host.remove();
          t.peers.forEach(p => p.stop());
        });
        a.update(() => {
          $getRoot().getAllTextNodes()[1].select(1, 1);
        });
        await t.sync();
        c.update(() => {
          $setState($getRoot().getFirstChildOrThrow(), shut, true);
          $setSelection(null);
        });
        await t.sync();
        let notified = 0;
        onTestFinished(
          a.editor.registerCommand(
            SELECTION_CHANGE_COMMAND,
            () => {
              notified++;
              return false;
            },
            COMMAND_PRIORITY_LOW,
          ),
        );
        b.update(() => {
          if (shape === 'replaced after the read moved it') {
            // Text before A's caret, in its own node: the read moves it.
            $getRoot().getAllTextNodes()[1].spliceText(0, 0, 'X');
          } else {
            $getRoot().getAllTextNodes()[2].setTextContent('three 3');
          }
          $setSelection(null);
        });
        await t.sync();
        expect(notified).toBe(1);
        expect(
          a.read(() => {
            const selection = $getSelection();
            return $isRangeSelection(selection) ? selection.anchor.offset : -1;
          }),
        ).toBe(4);
        await expectConverged(t.peers);
      });
    }
  }
});

describe('a selection an app sets in a remote read is notified after the read, which runs no node transforms', () => {
  for (const gc of [false, true]) {
    for (const early of ['none', 'continuing', 'stopping'] as const) {
      test(`code highlighting, ${early} handler ahead of the binding's, gc ${gc}`, async () => {
        // The app's handler only touches the code block; Lexical's
        // highlighter, a node transform, then rewrites it, in the handler's
        // own update: a local one, as where the app touches it any other
        // time.
        let armed = false;
        let touched = false;
        let inRead: boolean | null = null;
        let earlyCalls = 0;
        const $touch = () => {
          if (!armed || touched || !$shutNowAndBefore()) {
            return;
          }
          touched = true;
          inRead = $hasUpdateTag(COLLABORATION_TAG);
          const code = $getRoot().getLastChildOrThrow() as ElementNode;
          code.getWritable();
          for (const text of code.getAllTextNodes()) {
            text.getWritable();
          }
        };
        const editors: LexicalEditor[] = [];
        const t = await setup(
          () =>
            $getRoot().append(
              $create(Line).append(
                $createTextNode('one '),
                $create(ReplacingText).setTextContent('two'),
              ),
              $createParagraphNode().append($createTextNode('three')),
              $createCodeNode('javascript').append(
                $createTextNode('const answer = 42;').toggleFormat('bold'),
              ),
            ),
          {
            gc,
            ids: [1, 2, 3],
            nodes: [...NODES, Line, ReplacingText],
            // Registered before the binding's, at the highest priority.
            prepare: editor => {
              editors.push(editor);
              if (early === 'none' || editors.length > 1) {
                return;
              }
              editor.registerCommand(
                SELECTION_CHANGE_COMMAND,
                () => {
                  if (!armed) {
                    return false;
                  }
                  earlyCalls++;
                  if (early === 'stopping') {
                    $touch();
                    return true;
                  }
                  return false;
                },
                COMMAND_PRIORITY_CRITICAL,
              );
            },
          },
        );
        const {a, b, c} = t;
        expect(a.editor).toBe(editors[0]);
        const host = document.createElement('div');
        host.contentEditable = 'true';
        document.body.append(host);
        a.editor.setRootElement(host);
        host.focus();
        onTestFinished(() => {
          a.editor.setRootElement(null);
          host.remove();
          t.peers.forEach(p => p.stop());
        });
        onTestFinished(registerCodeHighlighting(a.editor));
        onTestFinished(
          a.editor.registerCommand(
            SELECTION_CHANGE_COMMAND,
            () => {
              $touch();
              return false;
            },
            COMMAND_PRIORITY_LOW,
          ),
        );
        a.update(() => {
          $getRoot().getAllTextNodes()[1].select(1, 1);
        });
        await t.sync();
        c.update(() => {
          $setState($getRoot().getFirstChildOrThrow(), shut, true);
          $setSelection(null);
        });
        await t.sync();
        armed = true;
        b.update(() => {
          $getRoot().getAllTextNodes()[2].setTextContent('three 3');
          $setSelection(null);
        });
        await t.sync();
        expect(touched).toBe(true);
        expect(inRead).toBe(false);
        expect(earlyCalls).toBe(early === 'none' ? 0 : 1);
        expect(a.describe()).toBe((await freshReader(a)).describe());
        await expectConverged(t.peers);
      });
    }
  }
});

describe('an app edit in a remote read the binding does not write', () => {
  for (const gc of [false, true]) {
    test(`read only: read again, gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $create(Line).append(
              $createTextNode('one '),
              $create(EditingText).setTextContent('two'),
            ),
            $createParagraphNode().append($createTextNode('three')),
            $createParagraphNode().append($createTextNode('tail')),
          ),
        {gc, ids: [1, 2, 3], nodes: [...NODES, Line, EditingText]},
      );
      const {a, b, c} = t;
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      a.editor.setRootElement(host);
      host.focus();
      onTestFinished(() => {
        a.editor.setRootElement(null);
        host.remove();
        t.peers.forEach(p => p.stop());
      });
      a.update(() => {
        $getRoot().getAllTextNodes()[1].select(1, 1);
      });
      await t.sync();
      c.update(() => {
        $setState($getRoot().getFirstChildOrThrow(), shut, true);
        $setSelection(null);
      });
      await t.sync();
      // A alone goes read only (as it does on a schema it does not know,
      // but without telling the other clients), and reads on.
      (a.binding as unknown as {setStatus(s: string): void}).setStatus(
        'readonly',
      );
      expect(a.binding.status).toBe('readonly');
      expect(b.binding.status).toBe('active');
      b.update(() => {
        $getRoot().getAllTextNodes()[2].setTextContent('three 3');
        $setSelection(null);
      });
      await t.sync();
      // The app's edit is made in A's read, and read again: A shows what
      // the document has.
      expect(hooked.has(a.editor)).toBe(true);
      const $tail = () => $getRoot().getLastChildOrThrow().getTextContent();
      expect(a.read($tail)).toBe('tail');
      expect((await freshReader(a)).read($tail)).toBe('tail');
      expect(b.read($tail)).toBe('tail');
    });

    test(`a slot the document cannot store: read only, gc ${gc}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $create(Line).append(
              $createTextNode('one '),
              $create(KindText).setTextContent('two'),
            ),
            $createParagraphNode().append($createTextNode('three')),
            $createParagraphNode().append($createTextNode('tail')),
          ),
        {gc, ids: [1, 2, 3], nodes: [...NODES, Line, KindText]},
      );
      const {a, b, c} = t;
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      a.editor.setRootElement(host);
      host.focus();
      onTestFinished(() => {
        a.editor.setRootElement(null);
        host.remove();
        t.peers.forEach(p => p.stop());
      });
      kinds.set(a.editor, 'unstorable slot');
      a.update(() => {
        $getRoot().getAllTextNodes()[1].select(1, 1);
      });
      await t.sync();
      c.update(() => {
        $setState($getRoot().getFirstChildOrThrow(), shut, true);
        $setSelection(null);
      });
      await t.sync();
      b.update(() => {
        $getRoot().getAllTextNodes()[2].setTextContent('three 3');
        $setSelection(null);
      });
      await t.sync();
      // As for the same edit in a local update: warned, and read only.
      expect(kindsDone.has(a.editor)).toBe(true);
      expect(a.binding.status).toBe('readonly');
      expect(a.warnings.some(w => w.includes('slots on nodes stored'))).toBe(
        true,
      );
    });
  }
});
