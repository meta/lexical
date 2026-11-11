/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A list item's `value` and `indent` are derived (ListItemNode declares them
// so): they are not stored, and every reader numbers the items of a list
// from its `start` with the list's own transforms, in the refresh that
// follows a read (see YBinding#flushRefresh). In an editor that uses named
// slots, Lexical re-renders in an update of its own whenever the editable
// state changes, which is what the binding's status changes after a read do:
// activation after the first read, read only after a remote change it cannot
// write past. With that update still pending, the refresh waited for the
// editor to be idle, a microtask later, and until then a freshly bound editor
// numbered every list item 1 (`getValue()`, `<li value>`) and dropped a
// custom `start`. The refresh now commits that update first, and runs once
// the read's work is done. Everything here is read right after the binding's
// call returns, with nothing awaited.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListExtension,
} from '@lexical/list';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $setSlot,
  configExtension,
  DecoratorNode,
  defineExtension,
  ElementNode,
  getDeclaredNodeStructure,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {YBinding, YCollabExtension} from '../../..';
import {createYDoc, readYState, seedYState} from '../../../headless';

/** An element with a declared slot next to its children (a card). */
class CalloutNode extends ElementNode {
  $config() {
    return this.config('test_ls_callout', {
      extends: ElementNode,
      slots: ['body'],
    });
  }
  isShadowRoot(): true {
    return true;
  }
  createDOM(): HTMLElement {
    return document.createElement('aside');
  }
  updateDOM(): false {
    return false;
  }
}

/** A block decorator with undeclared slots (a component). */
class ComponentNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_ls_component', {extends: DecoratorNode});
  }
  isInline(): false {
    return false;
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/** A slot value that holds blocks. */
class SlotBodyNode extends ElementNode {
  $config() {
    return this.config('test_ls_slot_body', {extends: ElementNode});
  }
  isShadowRoot(): true {
    return true;
  }
  canBeEmpty(): false {
    return false;
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): false {
    return false;
  }
}

const AppExtension = defineExtension({
  dependencies: [ListExtension],
  name: 'test-list-slot-app',
  nodes: () => [CalloutNode, ComponentNode, SlotBodyNode],
});

const config = {extensions: [AppExtension], schemaVersion: 1};

const $p = (text: string) =>
  $createParagraphNode().append($createTextNode(text));

/** A numbered list of three items from `start` (their values derived). */
const $list = (start: number) =>
  $createListNode('number', start).append(
    ...[0, 1, 2].map(i =>
      $createListItemNode().append($createTextNode(`item ${start + i}`)),
    ),
  );

/** A list from 5 whose second item holds a nested list. */
const $nestedList = () =>
  $createListNode('number', 5).append(
    $createListItemNode().append($createTextNode('outer 5')),
    $createListItemNode().append(
      $createListNode('number', 1).append(
        $createListItemNode().append($createTextNode('inner 1')),
        $createListItemNode().append($createTextNode('inner 2')),
      ),
    ),
    $createListItemNode().append($createTextNode('outer 6')),
  );

const $callout = () => {
  const host = $create(CalloutNode).append($p('host'));
  $setSlot(host, 'body', $create(SlotBodyNode).append($p('in the callout')));
  return host;
};

const $component = () => {
  const host = $create(ComponentNode);
  $setSlot(host, 'body', $create(SlotBodyNode).append($p('in the component')));
  return host;
};

/** Every list item's value, in document order. */
function $values(): number[] {
  const out: number[] = [];
  const walk = (node: LexicalNode) => {
    if ($isListItemNode(node)) {
      out.push(node.getValue());
    }
    if ($isElementNode(node)) {
      node.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

/** Every list's start, in document order. */
function $starts(): number[] {
  const out: number[] = [];
  const walk = (node: LexicalNode) => {
    if ($isListNode(node)) {
      out.push(node.getStart());
    }
    if ($isElementNode(node)) {
      node.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

/**
 * The fields every node's class declares derived (a list item's `value` and
 * `indent`), in document order, a host's slots before its children.
 */
function $derived(): unknown[] {
  const out: unknown[] = [];
  const walk = (node: LexicalNode) => {
    const {derived} = getDeclaredNodeStructure(
      node.constructor as typeof LexicalNode,
    );
    if (derived.size > 0) {
      const json = node.exportJSON() as unknown as Record<string, unknown>;
      const fields: Record<string, unknown> = {type: node.getType()};
      for (const name of [...derived].sort()) {
        fields[name] = json[name];
      }
      out.push(fields);
    }
    for (const name of $getSlotNames(node)) {
      const slot = $getSlot(node, name);
      if (slot !== null) {
        walk(slot);
      }
    }
    if ($isElementNode(node)) {
      node.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

const $json = () => $getEditor().getEditorState().toJSON();

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function mount(editor: LexicalEditor): HTMLElement {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  editor.setRootElement(root);
  cleanups.push(() => {
    editor.setRootElement(null);
    root.remove();
  });
  return root;
}

type Bind = 'binding' | 'extension' | 'extension-then-sync';

/**
 * An editor with a root element, freshly bound to the document `seed`
 * holds: as a host binds an editor it built (`binding`: a YBinding started
 * and initialized), as YCollabExtension does on a synced document
 * (`extension`), or on one the provider syncs once the editor is mounted
 * (`extension-then-sync`). Read right away, with nothing awaited.
 */
function bind(seed: Uint8Array, how: Bind) {
  const doc = createYDoc(seed);
  const warnings: string[] = [];
  const editorConfig = {
    onError: (error: Error) => {
      throw error;
    },
    onWarn: (warning: Error) => void warnings.push(String(warning)),
  };
  let root: HTMLElement;
  let editor: LexicalEditor;
  let binding: YBinding;
  if (how === 'binding') {
    const built = buildEditorFromExtensions(
      defineExtension({
        ...editorConfig,
        dependencies: [AppExtension],
        name: 'test-host',
      }),
    );
    cleanups.push(() => built.dispose());
    editor = built;
    root = mount(editor);
    binding = new YBinding(editor, doc, {schemaVersion: 1, selfCheck: true});
    cleanups.push(binding.start());
    binding.initialize();
  } else {
    const built = buildEditorFromExtensions(
      defineExtension({
        ...editorConfig,
        dependencies: [
          AppExtension,
          configExtension(YCollabExtension, {
            doc,
            schemaVersion: 1,
            selfCheck: true,
            synced: how === 'extension',
          }),
        ],
        name: 'test-client',
      }),
    );
    cleanups.push(() => built.dispose());
    editor = built;
    root = mount(editor);
    binding = getExtensionDependencyFromEditor(editor, YCollabExtension).output
      .binding;
    if (how === 'extension-then-sync') {
      binding.initialize();
    }
  }
  return {
    binding,
    derived: editor.getEditorState().read($derived),
    doc,
    editor,
    json: editor.getEditorState().toJSON(),
    rendered: Array.from(root.querySelectorAll('li')).map(li => li.value),
    starts: editor.getEditorState().read($starts),
    values: editor.getEditorState().read($values),
    warnings,
  };
}

const DOCS: Record<string, () => void> = {
  'a component slot after the lists': () =>
    $getRoot().append($list(1), $p('between'), $list(9), $component()),
  'a component slot before the lists': () =>
    $getRoot().append($component(), $list(1), $p('between'), $list(9)),
  'a declared slot after the lists': () =>
    $getRoot().append($list(1), $p('between'), $list(9), $callout()),
  'a declared slot before the lists': () =>
    $getRoot().append($callout(), $list(1), $p('between'), $list(9)),
  'a nested list and a declared slot': () =>
    $getRoot().append($callout(), $nestedList(), $p('between'), $list(9)),
  'no slot block': () => $getRoot().append($list(1), $p('between'), $list(9)),
};

/** What an editor with no binding derives for the same content. */
function derivedWithoutCollab($build: () => void): unknown[] {
  const editor = buildEditorFromExtensions(
    defineExtension({dependencies: [AppExtension], name: 'test-plain'}),
  );
  cleanups.push(() => editor.dispose());
  editor.update($build, {discrete: true});
  return editor.getEditorState().read($derived);
}

describe('a freshly bound editor shows the derived fields a fresh reader does', () => {
  for (const how of ['binding', 'extension', 'extension-then-sync'] as const) {
    for (const [name, $build] of Object.entries(DOCS)) {
      test(`${how}: ${name}`, () => {
        const seed = seedYState(config, $build);
        const bound = bind(seed, how);
        if (name !== 'a nested list and a declared slot') {
          expect(readYState(seed, config, $values)).toEqual([
            1, 2, 3, 9, 10, 11,
          ]);
          expect(bound.values).toEqual([1, 2, 3, 9, 10, 11]);
          expect(bound.rendered).toEqual([1, 2, 3, 9, 10, 11]);
          expect(bound.starts).toEqual([1, 9]);
        }
        // Every derived field as an editor with no binding derives it.
        const plain = derivedWithoutCollab($build);
        expect(plain.length).toBeGreaterThan(0);
        expect(bound.derived).toEqual(plain);
        // The self-check invariant: what a fresh reader of its own document
        // shows.
        expect(bound.json).toEqual(readYState(seed, config, $json));
        expect(bound.warnings).toEqual([]);
      });
    }
  }
});

/** A block type only the peer's app registers (a newer version's). */
class NewerBlockNode extends ElementNode {
  $config() {
    return this.config('test_ls_newer_block', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('section');
  }
  updateDOM(): false {
    return false;
  }
}

describe('a remote change that turns the binding read only', () => {
  test('the derived fields it changes are shown right away', async () => {
    const seed = seedYState(config, DOCS['a declared slot before the lists']);
    const a = bind(seed, 'binding');
    // Whatever the binding still runs a task later, done.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(a.editor.getEditorState().read($values)).toEqual([
      1, 2, 3, 9, 10, 11,
    ]);
    // A peer adds an item at the start of the first list, and a block of a
    // type this editor lacks: the binding goes read only once it has read
    // the change (its editor stops being editable, which re-renders it).
    const docB = createYDoc(seed);
    const peer = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          AppExtension,
          configExtension(YCollabExtension, {
            doc: docB,
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: 'test-peer',
        nodes: [NewerBlockNode],
      }),
    );
    cleanups.push(() => peer.dispose());
    const updates: Uint8Array[] = [];
    docB.on('update', (update: Uint8Array) => updates.push(update));
    peer.update(
      () => {
        const list = $getRoot().getChildren().find($isListNode)!;
        list
          .getFirstChildOrThrow()
          .insertBefore(
            $createListItemNode().append($createTextNode('item 0')),
          );
        $getRoot().append($create(NewerBlockNode).append($p('newer')));
      },
      {discrete: true},
    );
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      Y.applyUpdate(a.doc, update);
    }
    expect(a.binding.status).toBe('readonly');
    expect(a.warnings).toEqual([
      expect.stringContaining('test_ls_newer_block'),
    ]);
    expect(a.editor.getEditorState().read($values)).toEqual([
      1, 2, 3, 4, 9, 10, 11,
    ]);
  });
});

describe('undo and redo', () => {
  test('each step shows the derived fields a fresh reader does', () => {
    const seed = seedYState(config, DOCS['a nested list and a declared slot']);
    const a = bind(seed, 'binding');
    const um = a.binding.undoManager!;
    const check = (step: string) =>
      expect(a.editor.getEditorState().read($derived), step).toEqual(
        readYState(Y.encodeStateAsUpdate(a.doc), config, $derived),
      );
    check('open');
    // Items added at the start of the outer and the nested list, each an
    // undo step of its own.
    for (let i = 0; i < 4; i++) {
      a.editor.update(
        () => {
          const outer = $getRoot().getChildren().find($isListNode)!;
          const list =
            i % 2 === 0
              ? outer
              : outer
                  .getChildren()
                  .map(item => (item as ElementNode).getFirstChild())
                  .find($isListNode)!;
          list
            .getFirstChildOrThrow()
            .insertBefore(
              $createListItemNode().append($createTextNode(`${i}`)),
            );
        },
        {discrete: true},
      );
      um.stopCapturing();
      check(`edit ${i}`);
    }
    for (let i = 0; i < 4; i++) {
      a.binding.undo();
      check(`undo ${i}`);
    }
    for (let i = 0; i < 2; i++) {
      a.binding.redo();
      check(`redo ${i}`);
    }
    // A burst, read once it is done.
    a.binding.undo();
    a.binding.undo();
    check('undo burst');
    expect(a.warnings).toEqual([]);
  });
});
