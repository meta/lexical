/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, it, onTestFinished, vi} from 'vitest';

import {CollapsibleExtension} from '../../src/plugins/CollapsibleExtension';
import {
  $createCollapsibleContainerNode,
  $isCollapsibleContainerNode,
} from '../../src/plugins/CollapsibleExtension/CollapsibleContainerNode';
import {$createCollapsibleContentNode} from '../../src/plugins/CollapsibleExtension/CollapsibleContentNode';
import {$createCollapsibleTitleNode} from '../../src/plugins/CollapsibleExtension/CollapsibleTitleNode';

// Exercise the native <details> path even if the test environment's user agent
// changes. No layout or selection engine is needed for these event/state races.
vi.mock('lexical/src/environment', async importOriginal => ({
  ...(await importOriginal<typeof import('lexical/src/environment')>()),
  IS_CHROME: false,
  IS_FIREFOX: false,
}));

function setup() {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [CollapsibleExtension],
      name: '[test-collapsible-toggle-synchronization]',
    }),
  );
  const roots: HTMLElement[] = [];
  function mountRoot() {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    roots.push(root);
    editor.setRootElement(root);
    return root;
  }
  onTestFinished(() => {
    editor.dispose();
    roots.forEach(root => root.remove());
  });
  mountRoot();
  let key = '';
  editor.update(
    () => {
      const container = $createCollapsibleContainerNode(true).append(
        $createCollapsibleTitleNode().append(
          $createParagraphNode().append($createTextNode('Title')),
        ),
        $createCollapsibleContentNode().append(
          $createParagraphNode().append($createTextNode('Body')),
        ),
      );
      key = container.getKey();
      $getRoot().append(container, $createParagraphNode());
    },
    {discrete: true},
  );
  const dom = editor.getElementByKey(key);
  assert(dom instanceof HTMLDetailsElement);
  function $container() {
    const node = $getNodeByKey(key);
    assert($isCollapsibleContainerNode(node));
    return node;
  }
  return {$container, dom, editor, key, mountRoot};
}

function nextToggle(dom: HTMLDetailsElement): Promise<void> {
  return new Promise(resolve => {
    dom.addEventListener('toggle', () => resolve(), {once: true});
  });
}

describe('CollapsibleContainerNode native toggle synchronization', () => {
  it('ignores a queued toggle from the DOM of a previous root', async () => {
    const {$container, dom: oldDOM, editor, key, mountRoot} = setup();
    const toggled = nextToggle(oldDOM);
    oldDOM.open = false;

    // Switching roots recreates the DOM, retaining the node and its key.
    mountRoot();
    const currentDOM = editor.getElementByKey(key);
    assert(currentDOM instanceof HTMLDetailsElement);
    expect(currentDOM).not.toBe(oldDOM);
    expect(currentDOM.open).toBe(true);
    expect(oldDOM.isConnected).toBe(false);
    expect(editor.read('latest', () => $container().isAttached())).toBe(true);

    // jsdom delivers the real queued native event after recreation.
    await toggled;

    expect(editor.read(() => $container().getOpen())).toBe(true);
    expect(currentDOM.open).toBe(true);
  });

  it('ignores a queued toggle after the removed node is restored by editor state', async () => {
    const {$container, dom: oldDOM, editor, key} = setup();
    const savedState = editor.getEditorState();
    const toggled = nextToggle(oldDOM);
    oldDOM.open = false;
    editor.update(() => $container().remove(), {discrete: true});
    expect(editor.getElementByKey(key)).toBe(null);

    // History restores EditorStates with their original keys, rather than
    // deserializing JSON into new keys. This exercises the same public API.
    editor.setEditorState(savedState);
    editor.read(() => {});
    const currentDOM = editor.getElementByKey(key);
    assert(currentDOM instanceof HTMLDetailsElement);
    expect(currentDOM).not.toBe(oldDOM);
    expect(currentDOM.open).toBe(true);

    await toggled;

    expect(editor.read(() => $container().getOpen())).toBe(true);
    expect(currentDOM.open).toBe(true);
  });

  it('does not invert a pending update that already matches the native toggle', async () => {
    const {$container, dom, editor} = setup();
    const toggled = nextToggle(dom);
    dom.open = false;
    // A capture listener can write pending state before the element's own
    // listener runs. This is a single event, without duplicate delivery.
    dom.addEventListener(
      'toggle',
      () => {
        editor.update(() => $container().setOpen(false));
        expect(editor.read('latest', () => $container().getOpen())).toBe(true);
        expect(editor.read('pending', () => $container().getOpen())).toBe(
          false,
        );
      },
      {capture: true, once: true},
    );
    await toggled;

    expect(editor.read(() => $container().getOpen())).toBe(false);
    expect(dom.open).toBe(false);
  });
});
