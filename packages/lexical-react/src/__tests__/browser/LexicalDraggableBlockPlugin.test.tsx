/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {defineExtension} from '@lexical/extension';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {DraggableBlockPlugin_EXPERIMENTAL} from '@lexical/react/LexicalDraggableBlockPlugin';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  IS_APPLE_WEBKIT,
  IS_IOS,
  type LexicalEditor,
} from 'lexical';
import {act, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, onTestFinished, test, vi} from 'vitest';

const extension = defineExtension({
  $initialEditorState: () => {
    for (let i = 0; i < 100; i++) {
      $getRoot().append(
        $createParagraphNode().append($createTextNode(`Block ${i}`)),
      );
    }
  },
  dependencies: [RichTextExtension],
  name: '[draggable-block-test]',
});

function setup(autoScroll?: boolean) {
  let editor: LexicalEditor;
  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed;left:60px;top:60px;width:400px;height:240px;overflow:auto;';
  const anchor = document.createElement('div');
  anchor.style.position = 'relative';
  container.append(anchor);
  document.body.append(container);
  function Plugin() {
    [editor] = useLexicalComposerContext();
    const menuRef = useRef<HTMLDivElement>(null);
    const targetLineRef = useRef<HTMLDivElement>(null);
    return (
      <DraggableBlockPlugin_EXPERIMENTAL
        anchorElem={anchor}
        autoScroll={autoScroll}
        menuRef={menuRef}
        targetLineRef={targetLineRef}
        menuComponent={
          <div ref={menuRef} className="drag-menu">
            Drag
          </div>
        }
        targetLineComponent={
          <div ref={targetLineRef} className="target-line" />
        }
        isOnMenu={el => el.closest('.drag-menu') !== null}
      />
    );
  }
  const reactRoot = createRoot(anchor);
  act(() =>
    reactRoot.render(
      <LexicalExtensionComposer extension={extension}>
        <Plugin />
      </LexicalExtensionComposer>,
    ),
  );
  anchor
    .querySelectorAll('p')
    .forEach(p => (p.style.cssText = 'height:40px;margin:0;'));
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      act(() => reactRoot.unmount());
      mounted = false;
    }
  };
  onTestFinished(() => {
    unmount();
    container.remove();
  });
  const first = anchor.querySelector('p')!;
  const rect = first.getBoundingClientRect();
  act(() =>
    first.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: rect.left + 50,
        clientY: rect.top + 10,
      }),
    ),
  );
  const handle = anchor.querySelector('[draggable="true"]')!;
  // Drive frames deterministically while preserving real browser geometry.
  // Background browser workers can throttle RAF; native timing is tested E2E.
  let frameId = 0;
  let time = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    callbacks.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
    callbacks.delete(id);
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const tick = (count = 5) => {
    for (let i = 0; i < count; i++) {
      const pending = Array.from(callbacks.values());
      callbacks.clear();
      time += 16;
      act(() => pending.forEach(callback => callback(time)));
    }
  };
  const transfer = new DataTransfer();
  const drag = (type: string, target: Element = first, y = 299) =>
    act(() =>
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: 110,
          clientY: y,
          dataTransfer: transfer,
        }),
      ),
    );
  return {
    anchor,
    container,
    drag,
    editor: editor!,
    handle,
    tick,
    transfer,
    unmount,
  };
}

test('scrolls while the pointer stays still and drops onto the newly revealed target', () => {
  const {anchor, container, drag, handle, editor, tick} = setup(true);
  drag('dragstart', handle);
  drag('dragover');
  const line = anchor.querySelector<HTMLElement>('.target-line')!;
  const initialTransform = line.style.transform;
  tick(10);
  expect(container.scrollTop).toBeGreaterThan(120);
  expect(line.style.transform).not.toBe(initialTransform);
  drag('dragover', anchor.querySelector('p')!, 180); // Center stops scrolling.
  const paragraphs = Array.from(anchor.querySelectorAll('p'));
  const target = paragraphs.find(p => {
    const rect = p.getBoundingClientRect();
    return rect.top <= 180 && rect.bottom > 180;
  })!;
  expect(target).toBeDefined();
  const label = target.textContent;
  drag('drop', target, 180);
  const before = container.scrollTop;
  tick();
  expect(container.scrollTop).toBe(before);
  editor.read(() => {
    const labels = $getRoot()
      .getChildren()
      .map(node => node.getTextContent());
    expect(labels[labels.indexOf(label!) + 1]).toBe('Block 0');
  });
});

test.each([false, undefined])(
  'respects autoScroll=%s and ignores unrelated drags',
  autoScroll => {
    const {container, drag, handle, tick} = setup(autoScroll);
    drag('dragover');
    tick();
    expect(container.scrollTop).toBe(0);
    drag('dragstart', handle);
    drag('dragover');
    tick();
    if (autoScroll === undefined && IS_APPLE_WEBKIT && !IS_IOS) {
      expect(container.scrollTop).toBeGreaterThan(0);
    } else {
      expect(container.scrollTop).toBe(0);
    }
    drag('dragend', handle);
  },
);

test('does not autoscroll unrelated drags or file transfers', () => {
  const {container, drag, handle, tick, transfer} = setup(true);
  drag('dragover');
  tick();
  expect(container.scrollTop).toBe(0);
  drag('dragstart', handle);
  transfer.items.add(new File(['test'], 'test.txt'));
  drag('dragover');
  tick();
  expect(container.scrollTop).toBe(0);
  drag('dragend', handle);
});

test.each([
  'dragend',
  'external-drop',
  'read-only',
  'unmount',
  'root-detached',
  'blur',
])('stops scrolling on %s', reason => {
  const {container, drag, handle, editor, tick, unmount} = setup(true);
  drag('dragstart', handle);
  drag('dragover');
  tick(3);
  expect(container.scrollTop).toBeGreaterThan(30);
  if (reason === 'dragend') {
    drag('dragend', handle);
  } else if (reason === 'external-drop') {
    drag('drop', document.body);
  } else if (reason === 'read-only') {
    act(() => editor.setEditable(false));
  } else if (reason === 'root-detached') {
    act(() => editor.setRootElement(null));
  } else if (reason === 'blur') {
    window.dispatchEvent(new FocusEvent('blur'));
  } else {
    unmount();
  }
  const before = container.scrollTop;
  tick();
  expect(container.scrollTop).toBe(before);
});
