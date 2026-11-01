/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Browser-test helper that simulates IME composition sequences by
 * dispatching the same event sequence a real IME produces, combined
 * with direct DOM text-node mutations (since untrusted events don't
 * trigger browser-level DOM updates).
 *
 * Intermediate steps (each keystroke):
 *   keydown(Process) → compositionstart (first only) → compositionupdate →
 *   beforeinput(insertCompositionText) → DOM mutation → input(isComposing=true)
 *
 * Commit / cancel:
 *   DOM mutation (final text or revert) → COMPOSITION_END_COMMAND dispatched
 *   directly through the editor.  This bypasses the platform-specific
 *   deferral in Lexical's native compositionend handler (Safari sets a flag
 *   and defers to the next keydown; Firefox defers to the next input event),
 *   giving the test a single deterministic code path for all browsers.
 *
 * Between each event, the browser yields to the microtask queue so
 * deferred editor updates commit before the next event fires. We
 * replicate this with `await flush()` after every event that triggers
 * a Lexical `updateEditorSync` (compositionstart, input).
 */

import {COMPOSITION_END_COMMAND, type LexicalEditor} from 'lexical';

export interface CompositionStep {
  /** The cumulative composing text at this step. */
  text: string;
  /**
   * Selection offset within the composing text.
   * Defaults to `text.length` (cursor at end).
   */
  selectionStart?: number;
  selectionEnd?: number;
}

export interface CompositionSequence {
  /** Intermediate composition states (each keystroke). */
  steps: CompositionStep[];
  /** The final committed text. If omitted, uses the last step's text. */
  commitText?: string;
  /**
   * If true, simulate composition cancellation (Escape) instead of
   * committing. The DOM reverts to pre-composition text.
   */
  cancel?: boolean;
}

interface CompositionTarget {
  /** The contentEditable root element the editor is attached to. */
  rootElement: HTMLElement;
  /** The Lexical editor instance — used to dispatch COMPOSITION_END_COMMAND. */
  editor: LexicalEditor;
}

function getActiveTextNode(root: HTMLElement): Text | null {
  const sel = document.getSelection();
  if (sel && sel.rangeCount > 0) {
    const node = sel.focusNode;
    if (node instanceof Text && root.contains(node)) {
      return node;
    }
  }
  return null;
}

function dispatchCompositionEvent(
  target: HTMLElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data: string,
): void {
  target.dispatchEvent(
    new CompositionEvent(type, {bubbles: true, cancelable: true, data}),
  );
}

function dispatchBeforeInput(
  target: HTMLElement,
  data: string,
  inputType: string,
  targetRange?: StaticRange,
): void {
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data,
    inputType,
  });
  Object.defineProperty(event, 'getTargetRanges', {
    value: () => (targetRange ? [targetRange] : []),
  });
  target.dispatchEvent(event);
}

function dispatchInputEvent(
  target: HTMLElement,
  data: string,
  inputType: string,
  isComposing: boolean,
): void {
  const event = new InputEvent('input', {
    bubbles: true,
    cancelable: false,
    data,
    inputType,
  });
  // InputEvent.isComposing is readonly; override it for untrusted events.
  Object.defineProperty(event, 'isComposing', {value: isComposing});
  target.dispatchEvent(event);
}

function setSelectionAt(textNode: Text, start: number, end: number): void {
  const sel = document.getSelection();
  if (!sel) {
    return;
  }
  sel.setBaseAndExtent(textNode, start, textNode, end);
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Mutate the DOM text node to reflect the current composition state,
 * replacing the composing region with the new text.
 *
 * Returns the text node (which may have been created if the target was
 * an empty element).
 */
function applyDOMMutation(
  root: HTMLElement,
  composingText: string,
  composingStart: number,
  previousComposingLength: number,
): Text {
  let textNode = getActiveTextNode(root);
  if (!textNode) {
    // Empty paragraph — create a text node.
    const sel = document.getSelection();
    const focusNode = sel?.focusNode;
    if (focusNode instanceof HTMLElement && root.contains(focusNode)) {
      // Remove any <br> placeholder.
      const br = focusNode.querySelector('br');
      if (br) {
        br.remove();
      }
      textNode = document.createTextNode('');
      focusNode.appendChild(textNode);
    } else {
      throw new Error('compose(): cannot find a suitable insertion point');
    }
  }

  const value = textNode.nodeValue || '';
  const before = value.slice(0, composingStart);
  const after = value.slice(composingStart + previousComposingLength);
  textNode.nodeValue = before + composingText + after;
  return textNode;
}

/**
 * Simulate a full IME composition sequence in a browser test.
 *
 * Usage:
 * ```ts
 * await compose(
 *   {rootElement: editor.getRootElement()!},
 *   {
 *     steps: [
 *       {text: 'ㅎ'},
 *       {text: '하'},
 *       {text: '한'},
 *     ],
 *     commitText: '한',
 *   },
 * );
 * ```
 */
export async function compose(
  target: CompositionTarget,
  sequence: CompositionSequence,
): Promise<void> {
  const {rootElement} = target;
  const {steps, cancel} = sequence;
  const commitText =
    sequence.commitText ??
    (steps.length > 0 ? steps[steps.length - 1].text : '');

  if (steps.length === 0) {
    return;
  }

  let previousComposingLength = 0;
  let composingStart = 0;

  // --- intermediate steps ---
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const {text} = step;
    const selStart = step.selectionStart ?? text.length;
    const selEnd = step.selectionEnd ?? selStart;

    // Each keystroke fires keydown(Process). The first keystroke also
    // triggers compositionstart before compositionupdate — this matches
    // the real browser sequence where one keydown produces both events.
    rootElement.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Process',
        keyCode: 229,
      }),
    );

    if (i === 0) {
      dispatchCompositionEvent(rootElement, 'compositionstart', '');
      await flush();

      // Re-read the range AFTER compositionstart: Lexical may have prepared
      // a text node and selected a temporary character. Match the browser's
      // replacement of that range instead of inserting after it.
      const sel = document.getSelection();
      if (sel && sel.anchorNode === sel.focusNode) {
        composingStart = Math.min(sel.anchorOffset, sel.focusOffset);
        previousComposingLength = Math.abs(sel.focusOffset - sel.anchorOffset);
      } else {
        composingStart = sel ? sel.focusOffset : 0;
      }
    }

    dispatchCompositionEvent(rootElement, 'compositionupdate', text);

    const rangeNode = getActiveTextNode(rootElement);
    const targetRange =
      rangeNode != null
        ? new StaticRange({
            endContainer: rangeNode,
            endOffset: composingStart + previousComposingLength,
            startContainer: rangeNode,
            startOffset: composingStart,
          })
        : undefined;
    dispatchBeforeInput(
      rootElement,
      text,
      'insertCompositionText',
      targetRange,
    );

    const textNode = applyDOMMutation(
      rootElement,
      text,
      composingStart,
      previousComposingLength,
    );

    setSelectionAt(
      textNode,
      composingStart + selStart,
      composingStart + selEnd,
    );

    previousComposingLength = text.length;

    dispatchInputEvent(rootElement, text, 'insertCompositionText', true);
    await flush();
  }

  // --- commit or cancel ---
  // Instead of dispatching a DOM compositionend event (which Lexical
  // defers on Safari and Firefox), we apply the final DOM mutation and
  // then dispatch COMPOSITION_END_COMMAND directly through the editor.
  // This gives a single deterministic path on all browsers.
  if (cancel) {
    rootElement.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'Escape'}),
    );
    applyDOMMutation(rootElement, '', composingStart, previousComposingLength);
    const textNode = getActiveTextNode(rootElement);
    if (textNode) {
      setSelectionAt(textNode, composingStart, composingStart);
    }
  } else {
    const textNode = applyDOMMutation(
      rootElement,
      commitText,
      composingStart,
      previousComposingLength,
    );
    setSelectionAt(
      textNode,
      composingStart + commitText.length,
      composingStart + commitText.length,
    );
  }

  const endData = cancel ? '' : commitText;
  target.editor.dispatchCommand(
    COMPOSITION_END_COMMAND,
    new CompositionEvent('compositionend', {
      bubbles: true,
      cancelable: true,
      data: endData,
    }),
  );
  await flush();
}

/**
 * Convenience: build a Korean Hangul composition sequence from
 * incremental jamo assembly. Each string in `parts` is the cumulative
 * composing text at that keystroke.
 *
 * Example — typing "한":
 * ```ts
 * korean(['ㅎ', '하', '한'])
 * // → {steps: [{text: 'ㅎ'}, {text: '하'}, {text: '한'}], commitText: '한'}
 * ```
 */
export function korean(
  parts: string[],
  commitText?: string,
): CompositionSequence {
  return {
    commitText: commitText ?? parts[parts.length - 1],
    steps: parts.map(text => ({text})),
  };
}
