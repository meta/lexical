/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {getExtensionDependencyFromEditor, signal} from '@lexical/extension';
import {CharacterLimitPlugin} from '@lexical/react/LexicalCharacterLimitPlugin';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useSignalValue} from '@lexical/react/useExtensionSignalValue';
import {CAN_USE_DOM, registerEventListener} from 'lexical';
import {type JSX, useCallback, useEffect, useMemo, useState} from 'react';

import {createWebsocketProvider} from './collaboration';
import {useSettings} from './context/SettingsContext';
import {useSynchronizeSettings} from './hooks/useSynchronizeSettings';
import ActionsPlugin from './plugins/ActionsPlugin';
import AutoEmbedPlugin from './plugins/AutoEmbedPlugin';
import CodeActionMenuPlugin from './plugins/CodeActionMenuPlugin';
import CommentPlugin from './plugins/CommentPlugin';
import ComponentPickerPlugin from './plugins/ComponentPickerPlugin';
import ContextMenuPlugin from './plugins/ContextMenuPlugin';
import DraggableBlockPlugin from './plugins/DraggableBlockPlugin';
import EmojiPickerPlugin from './plugins/EmojiPickerPlugin';
import {ExcalidrawPlugin} from './plugins/ExcalidrawExtension';
import FloatingLinkEditorPlugin from './plugins/FloatingLinkEditorPlugin';
import FloatingTextFormatToolbarPlugin from './plugins/FloatingTextFormatToolbarPlugin';
import {MentionsPlugin} from './plugins/MentionsExtension';
import FloatingRubyEditorPlugin from './plugins/RubyExtension/FloatingRubyEditor';
import {ShortcutsExtension} from './plugins/ShortcutsExtension';
import SpeechToTextPlugin from './plugins/SpeechToTextPlugin';
import TableCellActionMenuPlugin from './plugins/TableActionMenuPlugin';
import TableCellResizer from './plugins/TableCellResizer';
import TableFitNestedTablePlugin from './plugins/TableFitNestedTablePlugin';
import TableHoverActionsV2Plugin from './plugins/TableHoverActionsV2Plugin';
import TableOfContentsPlugin from './plugins/TableOfContentsPlugin';
import TableScrollShadowPlugin from './plugins/TableScrollShadowPlugin';
import ToolbarPlugin from './plugins/ToolbarPlugin';
import TreeViewPlugin from './plugins/TreeViewPlugin';
import ContentEditable from './ui/ContentEditable';

export default function Editor(): JSX.Element {
  const {
    settings: {
      isCollab,
      useCollabV2,
      isCharLimit,
      hasFitNestedTables,
      isCharLimitUtf8,
      isRichText,
      showTreeView,
      showTableOfContents,
      shouldUseLexicalContextMenu,
      shouldPreserveNewLinesInMarkdown,
    },
  } = useSettings();
  // Mirror the settings context onto the editor's reactive extension config
  // signals (NOT via App.tsx's DynamicSettings, which would rebuild the
  // editor). See the hook for details.
  useSynchronizeSettings();
  const placeholder = isCollab
    ? 'Enter some collaborative rich text...'
    : isRichText
      ? 'Enter some rich text...'
      : 'Enter some plain text...';
  const [floatingAnchorElem, setFloatingAnchorElem] =
    useState<HTMLDivElement | null>(null);
  const [isSmallWidthViewport, setIsSmallWidthViewport] =
    useState<boolean>(false);
  const [editor] = useLexicalComposerContext();
  const [activeEditor, setActiveEditor] = useState(editor);
  // The link edit mode state lives on the ShortcutsExtension output so the
  // insert-link keyboard shortcut can set it without any React coupling
  // (the extension is only present in rich text configurations)
  const isLinkEditModeSignal = useMemo(
    () =>
      isRichText
        ? getExtensionDependencyFromEditor(editor, ShortcutsExtension).output
            .isLinkEditMode
        : signal(false),
    [editor, isRichText],
  );
  const isLinkEditMode = useSignalValue(isLinkEditModeSignal);
  const setIsLinkEditMode = useCallback(
    (nextIsLinkEditMode: boolean) => {
      if (isRichText) {
        getExtensionDependencyFromEditor(
          editor,
          ShortcutsExtension,
        ).output.isLinkEditMode.value = nextIsLinkEditMode;
      }
    },
    [editor, isRichText],
  );
  const [isRubyEditMode, setIsRubyEditMode] = useState<boolean>(false);

  const onRef = (_floatingAnchorElem: HTMLDivElement) => {
    if (_floatingAnchorElem !== null) {
      setFloatingAnchorElem(_floatingAnchorElem);
    }
  };

  useEffect(() => {
    const updateViewPortWidth = () => {
      const isNextSmallWidthViewport =
        CAN_USE_DOM && window.matchMedia('(max-width: 1025px)').matches;

      if (isNextSmallWidthViewport !== isSmallWidthViewport) {
        setIsSmallWidthViewport(isNextSmallWidthViewport);
      }
    };
    updateViewPortWidth();
    return registerEventListener(window, 'resize', updateViewPortWidth);
  }, [isSmallWidthViewport]);

  return (
    <>
      {isRichText && (
        <ToolbarPlugin
          editor={editor}
          activeEditor={activeEditor}
          setActiveEditor={setActiveEditor}
          setIsLinkEditMode={setIsLinkEditMode}
          setIsRubyEditMode={setIsRubyEditMode}
        />
      )}
      <div
        className={`editor-container ${showTreeView ? 'tree-view' : ''} ${
          !isRichText ? 'plain-text' : ''
        }`}>
        <ComponentPickerPlugin />
        <EmojiPickerPlugin />
        <AutoEmbedPlugin />
        <MentionsPlugin />
        <SpeechToTextPlugin />
        {!(isCollab && useCollabV2) && (
          <CommentPlugin
            providerFactory={isCollab ? createWebsocketProvider : undefined}
          />
        )}
        {isRichText ? (
          <>
            <div className="editor-scroller">
              <div className="editor" ref={onRef}>
                <ContentEditable placeholder={placeholder} />
              </div>
            </div>
            {hasFitNestedTables ? <TableFitNestedTablePlugin /> : null}
            <TableCellResizer />
            <TableScrollShadowPlugin />
            <ExcalidrawPlugin />
            {floatingAnchorElem && (
              <>
                <FloatingLinkEditorPlugin
                  anchorElem={floatingAnchorElem}
                  isLinkEditMode={isLinkEditMode}
                  setIsLinkEditMode={setIsLinkEditMode}
                />
                <FloatingRubyEditorPlugin
                  anchorElem={floatingAnchorElem}
                  isRubyEditMode={isRubyEditMode}
                  setIsRubyEditMode={setIsRubyEditMode}
                />
                <TableCellActionMenuPlugin
                  anchorElem={floatingAnchorElem}
                  cellMerge={true}
                />
              </>
            )}
            {floatingAnchorElem && !isSmallWidthViewport && (
              <>
                <DraggableBlockPlugin anchorElem={floatingAnchorElem} />
                <CodeActionMenuPlugin anchorElem={floatingAnchorElem} />
                <TableHoverActionsV2Plugin anchorElem={floatingAnchorElem} />
                <FloatingTextFormatToolbarPlugin
                  anchorElem={floatingAnchorElem}
                  setIsLinkEditMode={setIsLinkEditMode}
                  isRubyEditMode={isRubyEditMode}
                />
              </>
            )}
          </>
        ) : (
          <ContentEditable placeholder={placeholder} />
        )}
        {(isCharLimit || isCharLimitUtf8) && (
          <CharacterLimitPlugin
            charset={isCharLimit ? 'UTF-16' : 'UTF-8'}
            maxLength={5}
          />
        )}
        <div>{showTableOfContents && <TableOfContentsPlugin />}</div>
        {shouldUseLexicalContextMenu && <ContextMenuPlugin />}
        <ActionsPlugin
          shouldPreserveNewLinesInMarkdown={shouldPreserveNewLinesInMarkdown}
          useCollabV2={useCollabV2}
        />
      </div>
      {showTreeView && <TreeViewPlugin />}
    </>
  );
}
