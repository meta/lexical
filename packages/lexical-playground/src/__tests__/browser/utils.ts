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
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type AnyLexicalExtensionArgument,
  defineExtension,
  IS_APPLE,
  type LexicalEditor,
} from 'lexical';
import {expect, onTestFinished} from 'vitest';
import {commands, userEvent} from 'vitest/browser';

import theme from '../../themes/PlaygroundEditorTheme';

export function setupEditor(dependencies: AnyLexicalExtensionArgument[]) {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.style.whiteSpace = 'pre-wrap';
  document.body.append(root);
  const editor = buildEditorFromExtensions(
    defineExtension({dependencies, name: '[browser-test]', theme}),
  );
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
    window.getSelection()?.removeAllRanges();
  });
  editor.update(
    () => {
      $getRoot().clear().append($createParagraphNode());
      $getRoot().selectEnd();
    },
    {discrete: true},
  );
  window.focus();
  root.focus();
  return {editor, root};
}

export async function typeText(text: string) {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement) || !target.isContentEditable) {
    throw new Error('typeText requires a focused editor');
  }
  // :focus can stop matching when the browser temporarily deactivates this
  // frame. Bind the command to this element so it cannot resume in a later
  // test's editor after a timeout.
  const inputId = Math.random().toString(36).slice(2);
  target.setAttribute('data-lexical-test-input', inputId);
  try {
    await commands.typeText(text, `[data-lexical-test-input="${inputId}"]`);
  } finally {
    target.removeAttribute('data-lexical-test-input');
  }
}

export async function press(chord: string, count = 1) {
  const keys = chord.split('+');
  const key = keys.pop()!;
  const modifiers = keys.map(modifier =>
    modifier === 'ControlOrMeta' ? (IS_APPLE ? 'Meta' : 'Control') : modifier,
  );
  const input =
    modifiers.map(modifier => `{${modifier}>}`).join('') +
    (key.length === 1 ? key : `{${key}}`) +
    [...modifiers]
      .reverse()
      .map(modifier => `{/${modifier}}`)
      .join('');
  for (let i = 0; i < count; i++) {
    await userEvent.keyboard(input);
  }
}

export const undo = () => press('ControlOrMeta+z');
export const redo = () => press(IS_APPLE ? 'Meta+Shift+z' : 'Control+y');

export function html(strings: TemplateStringsArray, ...values: unknown[]) {
  return strings.reduce(
    (result, part, i) => result + part + (i < values.length ? values[i] : ''),
    '',
  );
}

// Like the E2E HTML assertions, normalize whitespace, CSS serialization, and
// invisible decorator boundary anchors while comparing the editor's content.
export function normalizeHTML(value: string): string {
  const template = document.createElement('template');
  template.innerHTML = value;
  const walker = document.createTreeWalker(
    template.content,
    NodeFilter.SHOW_TEXT,
  );
  while (walker.nextNode()) {
    walker.currentNode.textContent = walker.currentNode.textContent!.trim();
  }
  for (const element of template.content.querySelectorAll('*')) {
    if (element.hasAttribute('data-lexical-decorator-boundary')) {
      element.remove();
      continue;
    }
    if (element.hasAttribute('class')) {
      element.setAttribute('class', Array.from(element.classList).join(' '));
    }
    if (element instanceof HTMLElement && element.hasAttribute('style')) {
      element.setAttribute('style', element.style.cssText);
    }
    const attributes = Array.from(element.attributes).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const attribute of attributes) {
      element.removeAttribute(attribute.name);
    }
    for (const {name, value: attributeValue} of attributes) {
      element.setAttribute(name, attributeValue);
    }
  }
  return template.innerHTML;
}

export async function assertHTML(root: HTMLElement, expected: string) {
  await expect
    .poll(() => normalizeHTML(root.innerHTML))
    .toBe(normalizeHTML(expected));
}

// Native navigation and Lexical's selectionchange handler settle separately.
// Follow-up edits need both carets at the intended boundary.
export async function assertCaret(
  editor: LexicalEditor,
  selector: string,
  offset?: number,
) {
  // Poll a description rather than a boolean, so that a failure shows where
  // each of the DOM and the editor had the caret.
  const describe = () => {
    const root = editor.getRootElement();
    const target = root?.querySelector(selector);
    const domSelection = root?.ownerDocument.defaultView?.getSelection();
    const describeDOM = (node: Node | null | undefined) =>
      node == null
        ? null
        : node === target || node === target?.firstChild
          ? selector
          : node.nodeName;
    return editor.read('latest', () => {
      const selection = $getSelection();
      return {
        dom:
          domSelection == null
            ? null
            : {
                isCollapsed: domSelection.isCollapsed,
                node: describeDOM(domSelection.anchorNode),
                offset: domSelection.anchorOffset,
              },
        lexical: $isRangeSelection(selection)
          ? {
              isCollapsed: selection.isCollapsed(),
              node: describeDOM(editor.getElementByKey(selection.anchor.key)),
              offset: selection.anchor.offset,
            }
          : String(selection),
      };
    });
  };
  await expect
    .poll(describe)
    .toSatisfy(
      ({dom, lexical}) =>
        dom !== null &&
        typeof lexical === 'object' &&
        dom.isCollapsed &&
        lexical.isCollapsed &&
        dom.node === selector &&
        lexical.node === selector &&
        dom.offset === lexical.offset &&
        (offset === undefined || lexical.offset === offset),
    );
}

interface SelectionExpectation {
  anchorOffset: number | [number, number];
  anchorPath: number[];
  focusOffset: number | [number, number];
  focusPath: number[];
}

export async function assertSelection(
  root: HTMLElement,
  expected: SelectionExpectation,
) {
  const offset = (actual: number, wanted: number | [number, number]) =>
    Array.isArray(wanted) && actual >= wanted[0] && actual <= wanted[1]
      ? wanted
      : actual;
  const path = (node: Node | null) => {
    const result: number[] = [];
    while (node !== root && node?.parentNode) {
      result.unshift(
        Array.from(node.parentNode.childNodes)
          .filter(
            child =>
              !(
                child instanceof Element &&
                child.hasAttribute('data-lexical-decorator-boundary')
              ),
          )
          .indexOf(node as ChildNode),
      );
      node = node.parentNode;
    }
    return node === root ? result : null;
  };
  await expect
    .poll(() => {
      const selection = window.getSelection();
      return (
        selection && {
          anchorOffset: offset(selection.anchorOffset, expected.anchorOffset),
          anchorPath: path(selection.anchorNode),
          focusOffset: offset(selection.focusOffset, expected.focusOffset),
          focusPath: path(selection.focusNode),
        }
      );
    })
    .toEqual(expected);
}
