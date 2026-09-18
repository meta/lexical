/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditorWithDispose} from '@lexical/extension';

import {buildEditorFromExtensions} from '@lexical/extension';
import {describe, expect, test} from 'vitest';

import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSlot,
  defineExtension,
  ElementNode,
} from '../..';

// A shadow-root block used as a slot value, mirroring the shape a slot host
// holds in production.
class SlotContainerNode extends ElementNode {
  $config() {
    return this.config('slot_container_parse', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): boolean {
    return false;
  }
  isShadowRoot(): boolean {
    return true;
  }
}

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      name: '[slot-parse-editor-state]',
      nodes: [SlotContainerNode],
    }),
  );
}

function seedSlotDocument(editor: LexicalEditorWithDispose) {
  editor.update(
    () => {
      const host = $createParagraphNode();
      const container = $create(SlotContainerNode).append(
        $createParagraphNode().append($createTextNode('Title')),
      );
      $setSlot(host, 'title', container);
      $getRoot().clear().append(host);
    },
    {discrete: true},
  );
}

describe('_slotsUsed survives parseEditorState', () => {
  test('a state built by update() carries the flag', () => {
    using editor = buildEditor();
    seedSlotDocument(editor);

    expect(editor._slotsUsed).toBe(true);
    expect(editor.getEditorState()._slotsUsed).toBe(true);
  });

  test('a parsed state carries the flag', () => {
    using source = buildEditor();
    seedSlotDocument(source);
    const json = JSON.stringify(source.getEditorState().toJSON());

    using target = buildEditor();
    const parsed = target.parseEditorState(json);

    // Guard the premise: the slot really did survive serialization.
    parsed.read(() => {
      const host = $getRoot().getFirstChildOrThrow();
      expect(host.getTextContent()).toContain('Title');
    });

    expect(parsed._slotsUsed).toBe(true);
  });

  test('setEditorState latches the flag on an editor that did not parse it', () => {
    using source = buildEditor();
    seedSlotDocument(source);
    const json = JSON.stringify(source.getEditorState().toJSON());

    // Parsing is done by one editor and the state handed to another, e.g. a
    // headless parse on the server or a shared document cache. The parsing
    // editor sets its own `_slotsUsed` as a side effect of $setSlot, so only
    // the receiving editor exposes whether the flag travelled with the state.
    using parser = buildEditor();
    const parsed = parser.parseEditorState(json);

    using target = buildEditor();
    expect(target._slotsUsed).toBe(false);
    target.setEditorState(parsed);

    expect(target._slotsUsed).toBe(true);
  });

  test('parsing a slotless document leaves the flag alone', () => {
    using source = buildEditor();
    source.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('plain')));
      },
      {discrete: true},
    );
    const json = JSON.stringify(source.getEditorState().toJSON());

    using target = buildEditor();
    const parsed = target.parseEditorState(json);

    expect(parsed._slotsUsed).toBe(false);
    target.setEditorState(parsed);
    expect(target._slotsUsed).toBe(false);
  });
});
