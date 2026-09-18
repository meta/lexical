/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {effect, namedSignals, watchedSignal} from '@lexical/extension';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  defineExtension,
  getActiveElementDeep,
  getEditorPropertyFromDOMNode,
  isLexicalEditor,
  type LexicalEditor,
  safeCast,
  type TextFormatType,
} from 'lexical';

interface WithWindowState {
  [WINDOW_STATE_KEY]?: WindowState | undefined;
}

const TEXT_FORMAT_BY_EXEC_COMMAND: {readonly [K in string]?: TextFormatType} = {
  bold: 'bold',
  italic: 'italic',
  strikeThrough: 'strikethrough',
  subscript: 'subscript',
  superscript: 'superscript',
  underline: 'underline',
};

const WINDOW_STATE_KEY = Symbol.for('@lexical/dragon/WindowState');
type InstallKey = symbol;

interface WindowState {
  editors: Map<LexicalEditor, Set<InstallKey>>;
  installs: Set<InstallKey>;
  dispose: () => void;
}

function getOrCreateWindowState(
  targetWindow: Window & WithWindowState,
): WindowState {
  let state = targetWindow[WINDOW_STATE_KEY];
  if (state === undefined) {
    state = {dispose: () => {}, editors: new Map(), installs: new Set()};
    targetWindow[WINDOW_STATE_KEY] = state;
  }
  return state;
}

function defaultWindow(): Window | undefined {
  return typeof window !== 'undefined' ? window : undefined;
}

/**
 * Install the shared window listener that handles Dragon NaturallySpeaking's
 * web extension messages for every registered editor in the given window.
 *
 * Browsers invoke a window's message listeners in registration order, and
 * the extension's content script registers its own listener at document_end
 * of the initial page load. {@link registerDragonSupport} installs this
 * listener lazily, when an editor's root element is mounted, which loses
 * that race whenever editors mount after the initial load (a navigation in
 * a single page app, a dialog, any lazily rendered field). The extension
 * then edits the DOM directly before Lexical can stopImmediatePropagation,
 * and the edit is applied twice.
 *
 * Call this synchronously from every entrypoint that may render an editor
 * lazily, before document_end, so the listener is ahead of the extension's
 * and editors win the race no matter when they mount.
 *
 * Pass `targetWindow` to install the listener on a window other than the
 * global one (for example, an editor mounted inside an iframe). When
 * omitted, defaults to the current `window` when available. Returns a
 * teardown function; the listener for a window is removed once every
 * teardown for it (including the ones returned by
 * {@link registerDragonSupport}) has been called.
 */
export function installDragonSupport(
  targetWindow: undefined | Window = defaultWindow(),
): () => void {
  return targetWindow
    ? addInstall(
        targetWindow,
        Symbol('@lexical/dragon/globalInstall'),
        undefined,
      )
    : () => {};
}

function addInstall(
  targetWindow: Window,
  installKey: InstallKey,
  editor: undefined | LexicalEditor,
): () => void {
  const state = getOrCreateWindowState(targetWindow);
  if (state.installs.size === 0) {
    const boundHandleMessage = handleMessage.bind(targetWindow);
    targetWindow.addEventListener('message', boundHandleMessage, true);
    state.dispose = () => {
      targetWindow.removeEventListener('message', boundHandleMessage, true);
    };
  }
  state.installs.add(installKey);
  if (editor) {
    const installSet = state.editors.get(editor) || new Set();
    installSet.add(installKey);
    state.editors.set(editor, installSet);
  }
  return removeInstall.bind(null, targetWindow, state, installKey, editor);
}

function removeInstall(
  targetWindow: Window & WithWindowState,
  state: WindowState,
  installKey: InstallKey,
  editor?: LexicalEditor,
): void {
  if (editor) {
    const installSet = state.editors.get(editor);
    if (installSet && installSet.delete(installKey) && installSet.size === 0) {
      state.editors.delete(editor);
    }
  }
  if (state.installs.delete(installKey) && state.installs.size === 0) {
    state.dispose();
    delete targetWindow[WINDOW_STATE_KEY];
  }
}

function getDefaultView(el: HTMLElement | null): Window | null {
  return el && el.ownerDocument.defaultView;
}

export function registerDragonSupport(editor: LexicalEditor): () => void {
  const windowSignal = watchedSignal(
    () => getDefaultView(editor.getRootElement()),
    self =>
      editor.registerRootListener(rootElement => {
        self.value = getDefaultView(rootElement);
      }),
  );
  return effect(() => {
    const targetWindow = windowSignal.value;
    if (targetWindow) {
      return addInstall(
        targetWindow,
        Symbol('@lexical/dragon/editorInstall'),
        editor,
      );
    }
  });
}

function getFocusedEditor(
  targetWindow: Window & WithWindowState,
): LexicalEditor | null {
  const state = targetWindow[WINDOW_STATE_KEY];
  if (state === undefined) {
    return null;
  }
  const activeEditor = getEditorPropertyFromDOMNode(
    getActiveElementDeep(targetWindow.document),
  );
  return isLexicalEditor(activeEditor) && state.editors.has(activeEditor)
    ? activeEditor
    : null;
}

function handleMessage(this: Window, event: MessageEvent): void {
  const targetWindow = this;
  if (event.origin !== targetWindow.location.origin) {
    return;
  }
  const editor = getFocusedEditor(targetWindow);

  if (editor === null) {
    return;
  }

  const data = event.data;

  if (typeof data === 'string') {
    let parsedData;

    try {
      parsedData = JSON.parse(data);
    } catch (_e) {
      return;
    }

    if (
      parsedData &&
      parsedData.protocol === 'nuanria_messaging' &&
      parsedData.type === 'request'
    ) {
      const payload = parsedData.payload;

      if (payload && payload.functionId === 'makeChanges') {
        const args = payload.args;

        if (Array.isArray(args)) {
          const [
            elementStart,
            elementLength,
            text,
            selStart,
            selLength,
            formatCommand,
          ] = args;
          if (
            ![elementStart, elementLength, selStart, selLength].every(
              Number.isFinite,
            ) ||
            (typeof text !== 'string' && text !== -1)
          ) {
            return;
          }
          editor.update(() => {
            const selection = $getSelection();

            if ($isRangeSelection(selection)) {
              const anchor = selection.anchor;
              let anchorNode = anchor.getNode();
              let setSelStart = 0;
              let setSelEnd = 0;

              if ($isTextNode(anchorNode)) {
                // set initial selection
                if (elementStart >= 0 && elementLength >= 0) {
                  setSelStart = elementStart;
                  setSelEnd = elementStart + elementLength;
                  // If the offset is more than the end, make it the end
                  selection.setTextNodeRange(
                    anchorNode,
                    setSelStart,
                    anchorNode,
                    setSelEnd,
                  );
                }
              }

              // Dragon sends -1 (a number, not a string) as text for
              // selection-only changes, such as Select-and-Say
              // corrections and cursor moves by voice
              if (
                typeof text === 'string' &&
                (setSelStart !== setSelEnd || text !== '')
              ) {
                selection.insertRawText(text);
                anchorNode = anchor.getNode();
              }

              if ($isTextNode(anchorNode)) {
                // set final selection
                const anchorNodeTextLength = anchorNode.getTextContentSize();
                // Clamp to the text size. Negative offsets have no meaning
                // in the protocol, so they collapse the selection instead
                // of leaving a range the next input would replace
                setSelStart = Math.min(
                  Math.max(selStart, 0),
                  anchorNodeTextLength,
                );
                setSelEnd =
                  selStart < 0 || selLength < 0
                    ? setSelStart
                    : Math.min(selStart + selLength, anchorNodeTextLength);
                selection.setTextNodeRange(
                  anchorNode,
                  setSelStart,
                  anchorNode,
                  setSelEnd,
                );
              }

              // format the selection, e.g. for the "bold that" voice
              // command. Dragon's extension applies this through
              // document.execCommand, so the values are execCommand names.
              if (
                typeof formatCommand === 'string' &&
                selLength > 0 &&
                !selection.isCollapsed()
              ) {
                const format = TEXT_FORMAT_BY_EXEC_COMMAND[formatCommand];
                if (format !== undefined) {
                  selection.formatText(format);
                }
              }

              // block the chrome extension from handling this event
              event.stopImmediatePropagation();
            }
          });
        }
      }
    }
  }
}

export interface DragonConfig {
  disabled: boolean;
}

/**
 * Add Dragon speech to text input support to the editor, via the
 * \@lexical/dragon module.
 */
export const DragonExtension = defineExtension({
  build: (editor, config, state) => namedSignals(config),
  config: safeCast<DragonConfig>({
    disabled: typeof window === 'undefined',
  }),
  name: '@lexical/dragon',
  register: (editor, config, state) =>
    effect(() =>
      state.getOutput().disabled.value
        ? undefined
        : registerDragonSupport(editor),
    ),
});
