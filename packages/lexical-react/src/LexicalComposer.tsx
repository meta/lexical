/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  createLexicalComposerContext,
  LexicalComposerContext,
  type LexicalComposerContextType,
} from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  CAN_USE_DOM,
  createEditor,
  type EditorState,
  type EditorThemeClasses,
  getActiveElement,
  HISTORY_MERGE_TAG,
  type HTMLConfig,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  type LexicalNodeReplacement,
} from 'lexical';
import * as React from 'react';
import {type JSX, useMemo} from 'react';

import useLayoutEffect from './shared/useLayoutEffect';

const HISTORY_MERGE_OPTIONS = {tag: HISTORY_MERGE_TAG};

/**
 * The initial editor state accepted by {@link LexicalComposer} via
 * `initialConfig.editorState`. Each variant is handled differently:
 *
 * - `null` — skip default initialization entirely. The root is left with no
 *   children for an external owner (typically the
 *   [collaboration plugin](/docs/collaboration/react) and its Yjs document)
 *   to populate.
 * - `string` — a JSON string produced by serializing an `EditorState`. Parsed
 *   with {@link LexicalEditor.parseEditorState} and applied via
 *   {@link LexicalEditor.setEditorState}.
 * - `EditorState` — applied directly via {@link LexicalEditor.setEditorState}.
 * - `(editor) => void` — an updater run inside `editor.update(...)`. Invoked
 *   only when the root is still empty, so it will not overwrite content
 *   bootstrapped by another mechanism, and is silently skipped if the root
 *   already has children.
 *
 * Note that `string` and `EditorState` inputs go through `setEditorState`,
 * which throws when the parsed state satisfies `EditorState.isEmpty()` (root
 * with no children and no selection). The empty serialization produced by
 * initializing with `null` and never modifying the editor falls into this
 * category, so it cannot be re-applied via `setEditorState` after a round-trip.
 */
export type InitialEditorStateType =
  | null
  | string
  | EditorState
  | ((editor: LexicalEditor) => void);

/**
 * The configuration passed to {@link LexicalComposer} via its `initialConfig`
 * prop. It is read once when the editor is created and describes the editor's
 * `namespace`, registered `nodes`, `theme`, error handling, initial editable
 * state, optional initial {@link InitialEditorStateType}, and HTML
 * import/export configuration.
 */
export type InitialConfigType = Readonly<{
  namespace: string;
  nodes?: readonly (Klass<LexicalNode> | LexicalNodeReplacement)[];
  onError: (error: Error, editor: LexicalEditor) => void;
  /**
   * Optional handler for recoverable, warn-level conditions (e.g. the
   * update-recursion guard tripping) that the editor has already recovered
   * from. Mirrors {@link InitialConfigType.onError} but at warn severity, so
   * embedders can route the condition to telemetry without raising an error
   * alarm. Defaults (in core `createEditor`) to a handler that throws in
   * development and only `console.warn`s in production.
   */
  onWarn?: (error: Error, editor: LexicalEditor) => void;
  editable?: boolean;
  theme?: EditorThemeClasses;
  /**
   * The initial state of the editor. Read once on mount; changes after the
   * first render are ignored.
   *
   * Omitting the field (or passing `undefined`) seeds the root with a default
   * empty `ParagraphNode`. Pass `null` to skip that default — required when
   * pairing with the collaboration plugin so that the Yjs document, not
   * Lexical, owns the initial content. See {@link InitialEditorStateType}
   * for the full set of accepted shapes.
   */
  editorState?: InitialEditorStateType;
  html?: HTMLConfig;
}>;

type Props = React.PropsWithChildren<{
  initialConfig: InitialConfigType;
}>;

/**
 * The root component for a Lexical editor in React. It creates a
 * {@link LexicalEditor} from `initialConfig`, provides it (and its
 * {@link LexicalComposerContextType}) to descendants through React context, and
 * renders its `children`. Place plugins and UI such as {@link RichTextPlugin}
 * and {@link ContentEditable} inside it, and read the editor from descendants
 * with {@link useLexicalComposerContext}.
 *
 * `LexicalComposer` uses the legacy plugin pattern and does not support the
 * extension API. To build an editor from extensions, use
 * {@link LexicalExtensionComposer} instead; see the
 * [React extensions guide](https://lexical.dev/docs/extensions/react).
 *
 * @deprecated Superseded by `LexicalExtensionComposer` from
 * `@lexical/react/LexicalExtensionComposer`, and expected to be removed in a
 * future major release. `LexicalComposer` cannot accept extensions, so any
 * feature delivered as an extension is unreachable from an editor built here.
 * See the [React extensions guide](https://lexical.dev/docs/extensions/react)
 * for the migration, which is usually a two-line change.
 * @returns A context provider wrapping `children`.
 */
export function LexicalComposer({initialConfig, children}: Props): JSX.Element {
  const composerContext: [LexicalEditor, LexicalComposerContextType] = useMemo(
    () => {
      const {
        theme,
        namespace,
        nodes,
        onError,
        onWarn,
        editorState: initialEditorState,
        html,
      } = initialConfig;

      const context: LexicalComposerContextType = createLexicalComposerContext(
        null,
        theme,
      );

      const editor = createEditor({
        editable: initialConfig.editable,
        html,
        namespace,
        nodes,
        onError: error => onError(error, editor),
        ...(onWarn ? {onWarn: error => onWarn(error, editor)} : {}),
        theme,
      });
      initializeEditor(editor, initialEditorState);

      return [editor, context];
    },

    // We only do this for init
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useLayoutEffect(() => {
    const isEditable = initialConfig.editable;
    const [editor] = composerContext;
    editor.setEditable(isEditable !== undefined ? isEditable : true);

    // We only do this for init
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <LexicalComposerContext.Provider value={composerContext}>
      {children}
    </LexicalComposerContext.Provider>
  );
}

function initializeEditor(
  editor: LexicalEditor,
  initialEditorState?: InitialEditorStateType,
): void {
  if (initialEditorState === null) {
    return;
  } else if (initialEditorState === undefined) {
    editor.update(() => {
      const root = $getRoot();
      if (root.isEmpty()) {
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        const rootElement = editor.getRootElement();
        // getActiveElement rather than document.activeElement, which reports
        // the shadow host when the editor is in a shadow root.
        const activeElement =
          CAN_USE_DOM && rootElement !== null
            ? getActiveElement(rootElement)
            : null;
        if (
          $getSelection() !== null ||
          (activeElement !== null && activeElement === rootElement)
        ) {
          paragraph.select();
        }
      }
    }, HISTORY_MERGE_OPTIONS);
  } else if (initialEditorState !== null) {
    switch (typeof initialEditorState) {
      case 'string': {
        const parsedEditorState = editor.parseEditorState(initialEditorState);
        editor.setEditorState(parsedEditorState, HISTORY_MERGE_OPTIONS);
        break;
      }
      case 'object': {
        editor.setEditorState(initialEditorState, HISTORY_MERGE_OPTIONS);
        break;
      }
      case 'function': {
        editor.update(() => {
          const root = $getRoot();
          if (root.isEmpty()) {
            initialEditorState(editor);
          }
        }, HISTORY_MERGE_OPTIONS);
        break;
      }
    }
  }
}
