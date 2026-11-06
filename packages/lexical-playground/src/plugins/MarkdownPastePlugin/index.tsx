/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './index.css';

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useExtensionSignalValue} from '@lexical/react/useExtensionSignalValue';
import {
  getDOMSelection,
  getDOMSelectionRange,
  type LexicalEditor,
  mergeRegister,
  registerEventListener,
} from 'lexical';
import * as React from 'react';
import {type JSX, useLayoutEffect, useRef} from 'react';
import {createPortal} from 'react-dom';

import {
  CONVERT_PASTED_MARKDOWN_COMMAND,
  CONVERT_PASTED_MARKDOWN_SHORTCUT,
  DISMISS_PASTED_MARKDOWN_COMMAND,
  MarkdownPasteExtension,
  type MarkdownPasteOffer,
} from '../MarkdownPasteExtension';

const GAP = 8;

/**
 * Place the prompt just below where the paste ended, so that it does not
 * cover the pasted text, or above that line when there is no room below.
 * The prompt is fixed to the viewport so that nothing in the editor's own
 * stacking context (like the playground's action buttons) paints over it.
 */
function positionPrompt(prompt: HTMLElement, target: DOMRect | null): void {
  const view = prompt.ownerDocument.defaultView;
  if (target === null || view === null) {
    prompt.style.opacity = '0';
    return;
  }
  const {height, width} = prompt.getBoundingClientRect();
  const below = target.bottom + GAP;
  const top =
    below + height > view.innerHeight ? target.top - GAP - height : below;
  const left = Math.max(
    GAP,
    Math.min(target.left, view.innerWidth - width - GAP),
  );
  prompt.style.opacity = '1';
  prompt.style.transform = `translate(${left}px, ${top}px)`;
}

/**
 * Where the paste ended: the caret, which stays there while the offer is
 * pending, or else the DOM element of the node the paste ended in.
 */
function getPasteEndRect(
  editor: LexicalEditor,
  offer: MarkdownPasteOffer,
): DOMRect | null {
  const rootElement = editor.getRootElement();
  if (rootElement === null) {
    return null;
  }
  const domSelection = getDOMSelection(rootElement.ownerDocument.defaultView);
  const range = domSelection && getDOMSelectionRange(domSelection, rootElement);
  if (range) {
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      return rect;
    }
  }
  const element = editor.getElementByKey(offer.end.key);
  return element ? element.getBoundingClientRect() : null;
}

function MarkdownPastePrompt({
  offer,
}: {
  offer: MarkdownPasteOffer;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const promptRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const prompt = promptRef.current;
    const view = prompt && prompt.ownerDocument.defaultView;
    if (prompt === null || view === null) {
      return;
    }
    const update = () => positionPrompt(prompt, getPasteEndRect(editor, offer));
    update();
    // Scrolling does not move the selection, so the offer stays pending.
    return mergeRegister(
      registerEventListener(view, 'scroll', update, true),
      registerEventListener(view, 'resize', update),
    );
  }, [editor, offer]);

  // Keep the editor focused and its selection where the paste left it, which
  // a click on the prompt would otherwise move (and so dismiss the offer).
  const keepEditorFocus = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div
      ref={promptRef}
      className="markdown-paste-prompt"
      role="group"
      aria-label="Pasted Markdown">
      <i className="format markdown" aria-hidden="true" />
      <span className="markdown-paste-prompt-text">
        The pasted text looks like Markdown.
      </span>
      <button
        type="button"
        className="markdown-paste-prompt-convert"
        aria-keyshortcuts={CONVERT_PASTED_MARKDOWN_SHORTCUT}
        onMouseDown={keepEditorFocus}
        onClick={() =>
          editor.dispatchCommand(CONVERT_PASTED_MARKDOWN_COMMAND, undefined)
        }>
        Convert <kbd>{CONVERT_PASTED_MARKDOWN_SHORTCUT}</kbd>
      </button>
      <button
        type="button"
        className="markdown-paste-prompt-dismiss"
        aria-label="Keep as pasted"
        title="Keep as pasted (Esc)"
        onMouseDown={keepEditorFocus}
        onClick={() =>
          editor.dispatchCommand(DISMISS_PASTED_MARKDOWN_COMMAND, undefined)
        }>
        <i className="format close" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Shows a prompt to convert a paste that {@link MarkdownPasteExtension}
 * offers, next to where the paste ended.
 */
export default function MarkdownPastePlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const offer = useExtensionSignalValue(MarkdownPasteExtension, 'offer');
  const rootElement = editor.getRootElement();
  return offer && rootElement
    ? createPortal(
        <MarkdownPastePrompt offer={offer} />,
        rootElement.ownerDocument.body,
      )
    : null;
}
