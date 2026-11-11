/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Shared by the unit and browser tests of the editor's MutationObserver
// revert. Kept out of ./index.tsx, which pulls in Node-only modules such as
// @prettier/sync, so that browser tests can import it.

import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $getRoot,
  DecoratorNode,
  type ElementDOMSlot,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  setDOMUnmanaged,
} from 'lexical';
import {onTestFinished} from 'vitest';

export class InlineDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_inline_decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.textContent = 'X';
    return span;
  }
  updateDOM(): false {
    return false;
  }
  isInline(): true {
    return true;
  }
  decorate(): null {
    return null;
  }
}

export class BlockDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_block_decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/**
 * A block whose DOM slot keeps a non-lexical marker after its children. Like
 * TableNode's colgroup, the slot finds the marker in the live DOM, so it
 * names none once an edit has removed it.
 */
export class MarkedBlockNode extends ElementNode {
  $config() {
    return this.config('test_marked_block', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    const div = document.createElement('div');
    const marker = document.createElement('span');
    marker.setAttribute('data-marker', 'true');
    marker.contentEditable = 'false';
    div.appendChild(marker);
    return div;
  }
  updateDOM(): false {
    return false;
  }
  getDOMSlot(dom: HTMLElement): ElementDOMSlot<HTMLElement> {
    return super
      .getDOMSlot(dom)
      .withBefore(dom.querySelector(':scope > [data-marker]'));
  }
}

const headers = new WeakMap<HTMLElement, HTMLElement>();

/**
 * A block whose DOM slot keeps a non-lexical header before its children and
 * a footer after them. The slot holds on to the header, so it still names it
 * after an edit has removed it; it finds the footer in the live DOM.
 */
export class FramedBlockNode extends ElementNode {
  $config() {
    return this.config('test_framed_block', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    const div = document.createElement('div');
    const header = document.createElement('span');
    header.setAttribute('data-header', 'true');
    header.contentEditable = 'false';
    const footer = document.createElement('span');
    footer.setAttribute('data-footer', 'true');
    footer.contentEditable = 'false';
    div.append(header, footer);
    headers.set(div, header);
    return div;
  }
  updateDOM(): false {
    return false;
  }
  getDOMSlot(dom: HTMLElement): ElementDOMSlot<HTMLElement> {
    return super
      .getDOMSlot(dom)
      .withAfter(headers.get(dom))
      .withBefore(dom.querySelector(':scope > [data-footer]'));
  }
}

/** A block whose children live in an inner element of its DOM. */
export class WrappedBlockNode extends ElementNode {
  $config() {
    return this.config('test_wrapped_block', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    const div = document.createElement('div');
    div.appendChild(document.createElement('div'));
    return div;
  }
  updateDOM(): false {
    return false;
  }
  getDOMSlot(dom: HTMLElement): ElementDOMSlot<HTMLElement> {
    return super
      .getDOMSlot(dom)
      .withElement(dom.firstElementChild as HTMLElement);
  }
}

function buildEditor(
  $initialEditorState: string | (() => void),
  onError: (error: Error) => void,
): LexicalEditorWithDispose {
  return buildEditorFromExtensions({
    $initialEditorState,
    dependencies: [RichTextExtension],
    name: '[observed-mutation]',
    nodes: [
      BlockDecoratorNode,
      FramedBlockNode,
      InlineDecoratorNode,
      MarkedBlockNode,
      WrappedBlockNode,
    ],
    onError,
  });
}

/**
 * Mount an editor whose root holds `$rootChildren()`, recording any error it
 * reports, along with what it rendered for that initial state.
 */
export function mountEditor($rootChildren: () => LexicalNode[]) {
  const errors: string[] = [];
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditor(
    () => {
      $getRoot().append(...$rootChildren());
    },
    error => {
      errors.push(error.message);
    },
  );
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  editor.setRootElement(root);
  return {
    /** The first block, which most tests mutate. */
    block: root.firstElementChild as HTMLElement,
    editor,
    errors,
    renderedHTML: root.innerHTML,
    renderedJSON: editor.getEditorState().toJSON(),
    root,
  };
}

export type MountedEditor = ReturnType<typeof mountEditor>;

/** The HTML a fresh editor renders for `editor`'s current editor state. */
export function renderFresh(editor: LexicalEditor): string {
  const container = document.createElement('div');
  container.contentEditable = 'true';
  document.body.appendChild(container);
  const fresh = buildEditor(JSON.stringify(editor.getEditorState()), error => {
    throw error;
  });
  onTestFinished(() => {
    fresh.dispose();
    container.remove();
  });
  fresh.setRootElement(container);
  return container.innerHTML;
}

/**
 * Run `mutate` as one synchronous batch and resolve once the editor's
 * MutationObserver has handled it. This observer is created after the
 * editor's, and observers are notified in creation order, so its callback
 * runs after the editor's (and after any commit that callback scheduled).
 */
export function observeBatch(
  root: HTMLElement,
  mutate: () => void,
): Promise<void> {
  const handled = new Promise<void>(resolve => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(root, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
  mutate();
  return handled;
}

export function remove(...nodes: Node[]): void {
  for (const node of nodes) {
    node.parentNode!.removeChild(node);
  }
}

/** The managed line break of `element`: [img, br] on WebKit, else [br]. */
export function managedLineBreak(element: Element): Element[] {
  return Array.from(
    element.querySelectorAll(':scope > [data-lexical-managed-linebreak]'),
  );
}

export function decorators(element: Element): Element[] {
  return Array.from(element.querySelectorAll('[data-lexical-decorator]'));
}

/** A keyless span marked with setDOMUnmanaged, as an extension adds one. */
export function unmanagedSpan(text: string): HTMLElement {
  const span = document.createElement('span');
  span.setAttribute('data-unmanaged', 'true');
  span.textContent = text;
  setDOMUnmanaged(span);
  return span;
}
