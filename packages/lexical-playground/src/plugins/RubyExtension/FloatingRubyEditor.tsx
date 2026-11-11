/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './FloatingRubyEditor.css';

import {
  autoUpdate,
  flip,
  inline,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $onUpdate,
  CLICK_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  getActiveElement,
  getDOMSelection,
  getParentElement,
  isHTMLElement,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
  mergeRegister,
  type NodeKey,
  registerEventListener,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import {
  type Dispatch,
  type JSX,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {createPortal} from 'react-dom';

import {
  $isRubyNode,
  $toggleRuby,
  $unwrapRubyNode,
  type RubyNode,
} from './RubyNode';

function preventDefault(
  event: React.KeyboardEvent<HTMLInputElement> | React.MouseEvent<HTMLElement>,
): void {
  event.preventDefault();
}

function $getRubyNodeFromDOM(target: EventTarget | null): RubyNode | null {
  if (!isHTMLElement(target)) {
    return null;
  }
  const node = $getNearestNodeFromDOMNode(target);
  return $isRubyNode(node) ? node : null;
}

function FloatingRubyEditor({
  editor,
  anchorElem,
  isRubyEditMode,
  setIsRubyEditMode,
}: {
  editor: LexicalEditor;
  anchorElem: HTMLElement;
  isRubyEditMode: boolean;
  setIsRubyEditMode: Dispatch<boolean>;
}): JSX.Element {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isEditorPointerDownRef = useRef(false);
  const [baseText, setBaseText] = useState('');
  const [annotation, setAnnotation] = useState('');
  const [rubyNodeKey, setRubyNodeKey] = useState<NodeKey | null>(null);
  const [isRubyClick, setIsRubyClick] = useState(false);

  const isVisible = isRubyClick || isRubyEditMode;
  const scrollerElem = getParentElement(anchorElem);

  const {refs, floatingStyles} = useFloating({
    middleware: [
      inline(),
      offset(10),
      flip({
        boundary: scrollerElem || undefined,
        padding: 10,
      }),
      shift({
        boundary: scrollerElem || undefined,
        crossAxis: true,
        mainAxis: true,
        padding: 10,
      }),
    ],
    placement: 'bottom-start',
    strategy: 'absolute',
    whileElementsMounted: (...args) =>
      autoUpdate(...args, {ancestorScroll: false}),
  });

  const positionToRubyNode = useCallback(
    (node: RubyNode) => {
      setBaseText(node.getTextContent());
      setAnnotation(node.getAnnotation());
      setRubyNodeKey(node.getKey());

      const element = editor.getElementByKey(node.getKey());
      if (element) {
        refs.setPositionReference({
          getBoundingClientRect: () => element.getBoundingClientRect(),
          getClientRects: () => element.getClientRects(),
        });
      }
    },
    [editor, refs],
  );

  const $positionToSelection = useCallback(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || selection.isCollapsed()) {
      return;
    }
    setBaseText(selection.getTextContent());
    setAnnotation('');
    setRubyNodeKey(null);

    const nativeSelection = getDOMSelection(editor._window);
    if (nativeSelection !== null && nativeSelection.rangeCount > 0) {
      refs.setPositionReference(nativeSelection.getRangeAt(0));
    }
  }, [editor, refs]);

  useEffect(() => {
    if (!isRubyEditMode) {
      return;
    }
    editor.read('latest', $positionToSelection);
  }, [editor, isRubyEditMode, $positionToSelection]);

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        CLICK_COMMAND,
        event => {
          if (editorRef.current?.contains(event.target as Node)) {
            return false;
          }
          const selection = $getSelection();
          if ($isRangeSelection(selection) && !selection.isCollapsed()) {
            setIsRubyClick(false);
            return false;
          }
          const node = $getRubyNodeFromDOM(event.target);
          if (node) {
            positionToRubyNode(node);
            setIsRubyClick(true);
          } else {
            setIsRubyClick(false);
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          if (isRubyEditMode) {
            $onUpdate(() => editor.read('latest', $positionToSelection));
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        () => {
          if (isVisible) {
            setIsRubyClick(false);
            setIsRubyEditMode(false);
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [
    editor,
    isRubyEditMode,
    isRubyClick,
    isVisible,
    positionToRubyNode,
    $positionToSelection,
    setIsRubyEditMode,
  ]);

  useEffect(() => {
    if (isVisible && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isVisible]);

  useEffect(() => {
    const editorElement = editorRef.current;
    if (editorElement === null) {
      return;
    }
    const handleBlur = (event: FocusEvent) => {
      if (!isVisible) {
        return;
      }
      if (isEditorPointerDownRef.current) {
        return;
      }
      const next = event.relatedTarget as Element | null;
      if (next !== null) {
        if (!editorElement.contains(next)) {
          setIsRubyClick(false);
          setIsRubyEditMode(false);
        }
        return;
      }
      requestAnimationFrame(() => {
        // getActiveElement rather than document.activeElement, which
        // reports the shadow host (never contained by editorElement) when
        // the editor UI is rendered inside a shadow root, and the wrong
        // document entirely when it is rendered in an iframe.
        if (editorElement.contains(getActiveElement(editorElement))) {
          return;
        }
        setIsRubyClick(false);
        setIsRubyEditMode(false);
      });
    };
    return registerEventListener(editorElement, 'focusout', handleBlur);
  }, [editorRef, setIsRubyEditMode, isVisible]);

  const handleSubmit = (
    event: React.KeyboardEvent<HTMLElement> | React.MouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    const value = annotation.trim();
    if (!value) {
      return;
    }
    editor.update(() => {
      if (rubyNodeKey) {
        const node = $getNodeByKey(rubyNodeKey);
        if ($isRubyNode(node)) {
          node.setAnnotation(value);
        }
      } else {
        $toggleRuby(value);
      }
    });
    setIsRubyClick(false);
    setIsRubyEditMode(false);
    requestAnimationFrame(() => editor.focus());
  };

  const handleDelete = () => {
    editor.update(() => {
      if (rubyNodeKey) {
        const node = $getNodeByKey(rubyNodeKey);
        if ($isRubyNode(node)) {
          $unwrapRubyNode(node);
        }
      } else {
        $toggleRuby(null);
      }
    });
    setIsRubyClick(false);
    setIsRubyEditMode(false);
    requestAnimationFrame(() => editor.focus());
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === 'Enter') {
      handleSubmit(event);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setIsRubyClick(false);
      setIsRubyEditMode(false);
    }
  };

  return (
    <div
      ref={el => {
        editorRef.current = el;
        refs.setFloating(el);
      }}
      className="ruby-editor"
      onMouseDown={() => {
        isEditorPointerDownRef.current = true;
      }}
      onMouseUp={() => {
        isEditorPointerDownRef.current = false;
        if (
          inputRef.current &&
          getActiveElement(inputRef.current) !== inputRef.current
        ) {
          inputRef.current.focus();
        }
      }}
      style={{
        ...floatingStyles,
        opacity: isVisible ? 1 : 0,
        pointerEvents: isVisible ? 'auto' : 'none',
      }}>
      {isVisible && (
        <>
          <span className="ruby-base-text" title={baseText}>
            {baseText}
          </span>
          <input
            ref={inputRef}
            className="ruby-input"
            placeholder="annotation"
            aria-label="Ruby annotation"
            value={annotation}
            onChange={event => {
              setAnnotation(event.target.value);
            }}
            onKeyDown={handleKeyDown}
          />
          <div
            className="ruby-confirm button"
            role="button"
            tabIndex={0}
            aria-label="Confirm"
            onMouseDown={preventDefault}
            onClick={handleSubmit}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                handleSubmit(event);
              }
            }}
          />
          {rubyNodeKey !== null && (
            <div
              className="ruby-trash button"
              role="button"
              tabIndex={0}
              aria-label="Delete ruby"
              onMouseDown={preventDefault}
              onClick={handleDelete}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleDelete();
                }
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function useFloatingRubyEditorToolbar(
  editor: LexicalEditor,
  anchorElem: HTMLElement,
  isRubyEditMode: boolean,
  setIsRubyEditMode: Dispatch<boolean>,
): JSX.Element | null {
  const [activeEditor, setActiveEditor] = useState(editor);

  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      (_payload, newEditor) => {
        setActiveEditor(newEditor);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor]);

  return createPortal(
    <FloatingRubyEditor
      editor={activeEditor}
      anchorElem={anchorElem}
      isRubyEditMode={isRubyEditMode}
      setIsRubyEditMode={setIsRubyEditMode}
    />,
    anchorElem,
  );
}

export default function FloatingRubyEditorPlugin({
  anchorElem = document.body,
  isRubyEditMode,
  setIsRubyEditMode,
}: {
  anchorElem?: HTMLElement;
  isRubyEditMode: boolean;
  setIsRubyEditMode: Dispatch<boolean>;
}): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  return useFloatingRubyEditorToolbar(
    editor,
    anchorElem,
    isRubyEditMode,
    setIsRubyEditMode,
  );
}
