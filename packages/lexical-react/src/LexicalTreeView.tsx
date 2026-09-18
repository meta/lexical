/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  type CustomPrintNodeFn,
  generateContent,
  TreeView as TreeViewCore,
  useLexicalCommandsLog,
} from '@lexical/devtools-core';
import {type EditorState, type LexicalEditor, mergeRegister} from 'lexical';
import * as React from 'react';
import {type JSX, useEffect, useState} from 'react';

import useLayoutEffect from './shared/useLayoutEffect';

/**
 * TreeView is a React component that provides a visual representation of
 * the Lexical editor's state and enables debugging features like time travel
 * and custom tree node rendering.
 *
 * When building an editor with the extension API, configure
 * {@link TreeViewExtension} to render this debugging view wired to the editor
 * instead of rendering `TreeView` directly.
 *
 * @param {Object} props - The properties passed to the TreeView component.
 * @param {LexicalEditor} props.editor - The Lexical editor instance to be visualized and debugged.
 * @param {string} [props.treeTypeButtonClassName] - Custom class name for the tree type toggle button.
 * @param {string} [props.timeTravelButtonClassName] - Custom class name for the time travel toggle button.
 * @param {string} [props.timeTravelPanelButtonClassName] - Custom class name for buttons inside the time travel panel.
 * @param {string} [props.timeTravelPanelClassName] - Custom class name for the overall time travel panel container.
 * @param {string} [props.timeTravelPanelSliderClassName] - Custom class name for the time travel slider in the panel.
 * @param {string} [props.viewClassName] - Custom class name for the tree view container.
 * @param {CustomPrintNodeFn} [props.customPrintNode] - A function for customizing the display of nodes in the tree.
 *
 * @returns {JSX.Element} - A React element that visualizes the editor's state and supports debugging interactions.
 */

export function TreeView({
  treeTypeButtonClassName,
  timeTravelButtonClassName,
  timeTravelPanelSliderClassName,
  timeTravelPanelButtonClassName,
  timeTravelPanelClassName,
  viewClassName,
  editor,
  customPrintNode,
}: {
  editor: LexicalEditor;
  treeTypeButtonClassName?: string;
  timeTravelButtonClassName?: string;
  timeTravelPanelButtonClassName?: string;
  timeTravelPanelClassName?: string;
  timeTravelPanelSliderClassName?: string;
  viewClassName?: string;
  customPrintNode?: CustomPrintNodeFn;
}): JSX.Element {
  const treeElementRef = React.createRef<HTMLPreElement>();

  const [editorCurrentState, setEditorCurrentState] = useState<EditorState>(
    editor.getEditorState(),
  );

  const commandsLog = useLexicalCommandsLog(editor);

  // useLayoutEffect, like useCanShowPlaceholder and ContentEditableElement, so
  // the state can be re-derived before subscribing without the cascading
  // render that setState inside a useEffect body causes.
  useLayoutEffect(() => {
    // The state was seeded on the first render only, so re-read it here: when
    // the editor prop changes, neither listener has fired yet for the new
    // editor and the view would keep rendering the previous editor's state.
    setEditorCurrentState(editor.getEditorState());
    // Registers listeners to update the tree view when the editor state changes
    return mergeRegister(
      editor.registerUpdateListener(({editorState}) => {
        setEditorCurrentState(editorState);
      }),
      editor.registerEditableListener(() => {
        setEditorCurrentState(editor.getEditorState());
      }),
    );
  }, [editor]);

  useEffect(() => {
    const element = treeElementRef.current;

    if (element !== null) {
      // Assigns the editor instance to the tree view DOM element for internal tracking
      // @ts-ignore Internal field used by Lexical
      element.__lexicalEditor = editor;

      return () => {
        // Cleans up the reference when the component is unmounted
        // @ts-ignore Internal field used by Lexical
        element.__lexicalEditor = null;
      };
    }
  }, [editor, treeElementRef]);

  /**
   * Handles toggling the readonly state of the editor.
   *
   * @param {boolean} isReadonly - Whether the editor should be set to readonly.
   */
  const handleEditorReadOnly = (isReadonly: boolean) => {
    const rootElement = editor.getRootElement();
    if (rootElement == null) {
      return;
    }

    rootElement.contentEditable = isReadonly ? 'false' : 'true';
  };

  return (
    <TreeViewCore
      treeTypeButtonClassName={treeTypeButtonClassName}
      timeTravelButtonClassName={timeTravelButtonClassName}
      timeTravelPanelSliderClassName={timeTravelPanelSliderClassName}
      timeTravelPanelButtonClassName={timeTravelPanelButtonClassName}
      viewClassName={viewClassName}
      timeTravelPanelClassName={timeTravelPanelClassName}
      setEditorReadOnly={handleEditorReadOnly}
      editorState={editorCurrentState}
      setEditorState={state => editor.setEditorState(state)}
      generateContent={async function (exportDOM) {
        // Generates the content for the tree view, allowing customization with exportDOM and customPrintNode
        return generateContent(editor, commandsLog, exportDOM, customPrintNode);
      }}
      ref={treeElementRef}
      commandsLog={commandsLog}
    />
  );
}
