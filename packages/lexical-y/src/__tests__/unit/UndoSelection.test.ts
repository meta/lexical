/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

import {
  buildEditorFromExtensions,
  configExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  CheckListExtension,
  ListExtension,
  type ListItemNode,
  type ListType,
} from '@lexical/list';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $addUpdateTag,
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $onUpdate,
  $selectAll,
  $setSelection,
  DecoratorNode,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  OUTDENT_CONTENT_COMMAND,
  REDO_COMMAND,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding, YCollabExtension, type YDoc} from '../..';

const EXTENSIONS = [RichTextExtension, ListExtension, CheckListExtension];

/** A document written by another client, as a stored state. */
function seed($build: () => void): Uint8Array {
  const editor = buildEditorFromExtensions(
    defineExtension({dependencies: EXTENSIONS, name: 'undo-selection-seed'}),
  );
  editor.update(
    () => {
      $getRoot().clear();
      $build();
    },
    {discrete: true},
  );
  const doc = createYDoc();
  doc.clientID = 7;
  const binding = new YBinding(editor, doc, {
    captureTimeout: null,
    schemaVersion: 1,
  });
  binding.start();
  binding.initialize();
  binding.dispose();
  return Y.encodeStateAsUpdate(doc);
}

/** An editor with YCollabExtension (and its UNDO_COMMAND handler). */
function open(
  state: Uint8Array,
  clientID: number,
): {editor: LexicalEditor; binding: YBinding; doc: Y.Doc} {
  const doc = createYDoc();
  doc.clientID = clientID;
  Y.applyUpdate(doc, state, 'load');
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        ...EXTENSIONS,
        configExtension(YCollabExtension, {
          captureTimeout: 0,
          doc,
          schemaVersion: 1,
        }),
      ],
      name: 'undo-selection',
      onError: e => {
        throw e;
      },
    }),
  );
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  binding.initialize();
  return {binding, doc, editor};
}

const selection = (editor: LexicalEditor) =>
  editor.read(() => {
    const s = $getSelection();
    return $isRangeSelection(s)
      ? `${s.anchor.offset}-${s.focus.offset}`
      : String(s);
  });

const text = (editor: LexicalEditor) =>
  editor.read(() => $getRoot().getTextContent());

function $firstText() {
  const node = $getRoot().getFirstDescendant();
  if (!$isTextNode(node)) {
    throw new Error('no text');
  }
  return node;
}

describe('undo puts the selection back where the step started', () => {
  const state = seed(() =>
    $getRoot().append(
      $createParagraphNode().append($createTextNode('abc def')),
    ),
  );
  for (const how of ['binding.undo()', 'UNDO_COMMAND']) {
    const undo = (c: ReturnType<typeof open>) =>
      how === 'UNDO_COMMAND'
        ? c.editor.dispatchCommand(UNDO_COMMAND, undefined)
        : c.binding.undo();
    const redo = (c: ReturnType<typeof open>) =>
      how === 'UNDO_COMMAND'
        ? c.editor.dispatchCommand(REDO_COMMAND, undefined)
        : c.binding.redo();

    test(`a Backspace (${how})`, () => {
      const c = open(state, 1);
      c.editor.update(() => $firstText().select(4, 4), {discrete: true});
      c.editor.update(() => $firstText().spliceText(3, 1, '', true), {
        discrete: true,
      });
      expect([text(c.editor), selection(c.editor)]).toEqual(['abcdef', '3-3']);
      undo(c);
      expect([text(c.editor), selection(c.editor)]).toEqual(['abc def', '4-4']);
      // Redo puts back the selection from when the step was undone (mapped
      // through the redo), not the one it finds.
      c.editor.update(() => $firstText().select(7, 7), {discrete: true});
      redo(c);
      expect([text(c.editor), selection(c.editor)]).toEqual(['abcdef', '3-3']);
    });

    test(`typing over a selection (${how})`, () => {
      const c = open(state, 1);
      c.editor.update(() => $firstText().select(4, 7), {discrete: true});
      c.editor.update(
        () => {
          const s = $getSelection();
          if ($isRangeSelection(s)) {
            s.insertText('x');
          }
        },
        {discrete: true},
      );
      expect(text(c.editor)).toBe('abc x');
      undo(c);
      expect([text(c.editor), selection(c.editor)]).toEqual(['abc def', '4-7']);
    });
  }
});

const $li = (content: string) =>
  $createListItemNode().append($createTextNode(content));
const $wrap = (type: ListType, ...items: ListItemNode[]) =>
  $createListItemNode().append($createListNode(type).append(...items));

/** Every list item's own text and number, in document order. */
function numbers(editor: LexicalEditor): string[] {
  return editor.read(() => {
    const out: string[] = [];
    const walk = (node: LexicalNode) => {
      if ($isListItemNode(node)) {
        const own = node
          .getChildren()
          .filter(c => !$isListNode(c))
          .map(c => c.getTextContent())
          .join('');
        out.push(`${own || '(wrapper)'}:${node.getValue()}`);
      }
      if ('getChildren' in node) {
        for (const c of (
          node as unknown as {getChildren(): LexicalNode[]}
        ).getChildren()) {
          walk(c);
        }
      }
    };
    walk($getRoot());
    return out;
  });
}

describe('an undo started while the editor is updating', () => {
  const state = seed(() =>
    $getRoot().append(
      $createListNode('bullet').append(
        $li('First bullet'),
        $wrap('bullet', $li('Nested'), $wrap('bullet', $li('Deeper'))),
        $li('Second bullet'),
      ),
      $createListNode('number').append(
        $li('Ship'),
        $wrap('number', $li('Rich docs'), $li('Rich sheets')),
        $li('Measure'),
      ),
      $createListNode('check').append(
        $li('Storage'),
        $li('Co-editing'),
        $wrap('check', $li('Nested task')),
      ),
      $createParagraphNode().append($createTextNode('end')),
    ),
  );
  test.each([
    'binding.undo()',
    'UNDO_COMMAND',
    'inside an update',
    "in an update's $onUpdate",
  ])('is read in an update of its own: list numbers come back (%s)', how => {
    const c = open(state, 1);
    const before = numbers(c.editor);
    c.editor.update(
      () => {
        $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === 'Nested task')!
          .select(5, 0);
      },
      {discrete: true},
    );
    c.editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
    expect(numbers(c.editor)).not.toEqual(before);
    if (how === 'binding.undo()') {
      c.binding.undo();
    } else if (how === 'UNDO_COMMAND') {
      c.editor.dispatchCommand(UNDO_COMMAND, undefined);
    } else if (how === 'inside an update') {
      c.editor.update(
        () => {
          $addUpdateTag('test');
          c.binding.undo();
        },
        {discrete: true},
      );
    } else {
      c.editor.update(() => $onUpdate(() => void c.binding.undo()), {
        discrete: true,
      });
    }
    expect(numbers(c.editor)).toEqual(before);
    // And the editor shows the document.
    const fresh = open(Y.encodeStateAsUpdate(c.doc), 2);
    expect(fresh.editor.getEditorState().toJSON()).toEqual(
      c.editor.getEditorState().toJSON(),
    );
  });
});

/** A block decorator (an image). */
class PictureNode extends DecoratorNode<null> {
  $config() {
    return this.config('undo_selection_picture', {extends: DecoratorNode});
  }
  isInline(): false {
    return false;
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/** An editor with PictureNode bound to `doc` (YCollabExtension). */
function openWithPictures(
  doc: YDoc,
  captureTimeout: number,
  warnings: string[],
): {editor: LexicalEditor; binding: YBinding} {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        ...EXTENSIONS,
        configExtension(YCollabExtension, {
          captureTimeout,
          doc,
          schemaVersion: 1,
        }),
      ],
      name: 'undo-selection-picture',
      nodes: () => [PictureNode],
      onError: e => {
        throw e;
      },
      onWarn: w => {
        warnings.push(w.message);
      },
    }),
  );
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  binding.initialize();
  return {binding, editor};
}

/** What a client that opens `doc` now shows. */
function freshJSON(doc: Y.Doc): string {
  const copy = createYDoc();
  copy.clientID = 9;
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc), 'load');
  const {editor} = openWithPictures(copy, 0, []);
  return JSON.stringify(editor.getEditorState().toJSON());
}

// The undo puts back the selection of its step, a range over the whole
// document. The redo's read then reused the text node that range ended in
// for shorter text, leaving a point past its end; Lexical threw on it when
// the read removed the picture, so the read failed and the editor was
// rebuilt, showing text the redo had deleted until the rebuild ran.
describe('select all over a block decorator, type, undo, redo', () => {
  for (const captureTimeout of [500, 0]) {
    for (const how of ['UNDO_COMMAND', 'binding.undo()']) {
      test(`undo and redo read cleanly (captureTimeout ${captureTimeout}, ${how})`, () => {
        const seedDoc = createYDoc();
        seedDoc.clientID = 7;
        const seeder = openWithPictures(seedDoc, 0, []);
        seeder.editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode('Owner: Ada')),
                $create(PictureNode),
                $createParagraphNode().append(
                  $createTextNode('Text after the picture'),
                ),
                $createParagraphNode().append(
                  $createTextNode('Closing paragraph'),
                ),
              );
          },
          {discrete: true},
        );
        const doc = createYDoc();
        doc.clientID = 1;
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(seedDoc), 'load');
        const warnings: string[] = [];
        const {binding, editor} = openWithPictures(
          doc,
          captureTimeout,
          warnings,
        );
        const original = text(editor);
        expect(original).toBe(
          'Owner: Ada\n\nText after the picture\n\nClosing paragraph',
        );
        editor.update(() => $selectAll(), {discrete: true});
        editor.update(
          () => {
            const s = $getSelection();
            if ($isRangeSelection(s)) {
              s.insertText('ok');
            }
          },
          {discrete: true},
        );
        expect(text(editor)).toBe('ok');
        if (how === 'UNDO_COMMAND') {
          editor.dispatchCommand(UNDO_COMMAND, undefined);
        } else {
          binding.undo();
        }
        expect(text(editor)).toBe(original);
        // The step's selection: the whole document.
        expect(selection(editor)).toBe('0-17');
        expect(JSON.stringify(editor.getEditorState().toJSON())).toBe(
          freshJSON(doc),
        );
        if (how === 'UNDO_COMMAND') {
          editor.dispatchCommand(REDO_COMMAND, undefined);
        } else {
          binding.redo();
        }
        // The redo showed "Text after the picture\n\nok" here, with a
        // recovered read's warning.
        expect({text: text(editor), warnings}).toEqual({
          text: 'ok',
          warnings: [],
        });
        expect(JSON.stringify(editor.getEditorState().toJSON())).toBe(
          freshJSON(doc),
        );
      });
    }
  }
});

// The same family without select all: the undo puts back a backward range
// from a heading into the paragraph after a picture; the redo's read then
// took apart the heading the range started in, leaving a point in a
// detached node, and Lexical threw on it when the read removed a node: the
// redo's update failed ("selection has been lost") and changed nothing.
describe('Enter over a range after a block decorator, undo, redo', () => {
  for (const how of ['UNDO_COMMAND', 'binding.undo()']) {
    test(`the redo splits again (${how})`, () => {
      const seedDoc = createYDoc();
      seedDoc.clientID = 7;
      const seeder = openWithPictures(seedDoc, 0, []);
      seeder.editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('Owner: Ada')),
              $create(PictureNode),
              $createParagraphNode().append(
                $createTextNode('Text between images and blocks.'),
              ),
              $createHeadingNode('h2').append($createTextNode('Blocks')),
              $createParagraphNode().append(
                $createTextNode('Closing paragraph'),
              ),
            );
        },
        {discrete: true},
      );
      const doc = createYDoc();
      doc.clientID = 1;
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(seedDoc), 'load');
      const warnings: string[] = [];
      const errors: string[] = [];
      const {binding, editor} = openWithPictures(doc, 500, warnings);
      editor.update(
        () => {
          const blocks = $getRoot().getChildren();
          const p = (blocks[2] as ElementNode).getFirstDescendant() as TextNode;
          const h = (blocks[3] as ElementNode).getFirstDescendant() as TextNode;
          const s = $createRangeSelection();
          s.anchor.set(h.getKey(), 2, 'text');
          s.focus.set(p.getKey(), 14, 'text');
          $setSelection(s);
        },
        {discrete: true},
      );
      editor.update(
        () => {
          const s = $getSelection();
          if ($isRangeSelection(s)) {
            s.insertParagraph();
          }
        },
        {discrete: true},
      );
      const split = text(editor);
      try {
        if (how === 'UNDO_COMMAND') {
          editor.dispatchCommand(UNDO_COMMAND, undefined);
        } else {
          binding.undo();
        }
        const undone = text(editor);
        expect(undone).not.toBe(split);
        if (how === 'UNDO_COMMAND') {
          editor.dispatchCommand(REDO_COMMAND, undefined);
        } else {
          binding.redo();
        }
      } catch (e) {
        errors.push(String(e));
      }
      // The redo changed nothing here, with a lost-selection error and a
      // recovered read.
      expect({errors, text: text(editor), warnings}).toEqual({
        errors: [],
        text: split,
        warnings: [],
      });
      expect(JSON.stringify(editor.getEditorState().toJSON())).toBe(
        freshJSON(doc),
      );
    });
  }
});

describe('a selection the binding cannot put back after a read', () => {
  test('leaves the selection the read left, and the read stands', () => {
    const doc = createYDoc();
    doc.clientID = 1;
    const warnings: string[] = [];
    const a = openWithPictures(doc, 0, warnings);
    a.editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('abc def')),
            $createParagraphNode().append($createTextNode('second')),
          );
        $firstText().select(4, 4);
      },
      {discrete: true},
    );
    const other = createYDoc();
    other.clientID = 2;
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc), 'load');
    const b = openWithPictures(other, 0, []);
    // Resolving the cursor fails (a stand-in for any failure there).
    (a.binding as unknown as {$resolvePosition: () => never}).$resolvePosition =
      () => {
        throw new Error('cannot resolve');
      };
    b.editor.update(
      () => {
        const last = $getRoot().getLastDescendant();
        if ($isTextNode(last)) {
          last.select(6, 6).insertText('!');
        }
      },
      {discrete: true},
    );
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
    expect({
      selection: selection(a.editor),
      text: text(a.editor),
      warnings,
    }).toEqual({selection: '4-4', text: 'abc def\n\nsecond!', warnings: []});
  });
});
