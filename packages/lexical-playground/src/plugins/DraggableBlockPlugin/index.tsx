/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './index.css';

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  type DraggableBlockBehavior,
  DraggableBlockPlugin_EXPERIMENTAL,
} from '@lexical/react/LexicalDraggableBlockPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $isParagraphNode,
  $isTextNode,
  getComposedEventTarget,
  type LexicalNode,
  type NodeKey,
  registerEventListener,
} from 'lexical';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as ReactDOM from 'react-dom';

import useModal from '../../hooks/useModal';
import {$isCollapsibleContainerNode} from '../CollapsibleExtension/CollapsibleContainerNode';
import {$isCollapsibleContentNode} from '../CollapsibleExtension/CollapsibleContentNode';
import {$isCollapsibleTitleNode} from '../CollapsibleExtension/CollapsibleTitleNode';
import {
  ComponentPickerMenuItem,
  type ComponentPickerOption,
  getBaseOptions,
  getDynamicOptions,
} from '../ComponentPickerPlugin';

const DRAGGABLE_BLOCK_MENU_CLASSNAME = 'draggable-block-menu';

type PickerState = {
  insertBefore: boolean;
  targetNodeKey: NodeKey;
};

/**
 * A collapsible is dragged as a whole from its title, and the blocks of its
 * content are dragged on their own. Everything else keeps the default.
 */
function $getBlockBehavior(node: LexicalNode): DraggableBlockBehavior | null {
  if ($isCollapsibleContainerNode(node)) {
    return 'draggable';
  }
  if ($isCollapsibleTitleNode(node)) {
    return 'ignored';
  }
  if ($isCollapsibleContentNode(node)) {
    return 'transparent';
  }
  return null;
}

function isOnMenu(element: HTMLElement): boolean {
  return !!element.closest(`.${DRAGGABLE_BLOCK_MENU_CLASSNAME}`);
}

export default function DraggableBlockPlugin({
  anchorElem = document.body,
}: {
  anchorElem?: HTMLElement;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [modal, showModal] = useModal();
  const menuRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const targetLineRef = useRef<HTMLDivElement>(null);
  const [draggableElement, setDraggableElement] = useState<HTMLElement | null>(
    null,
  );
  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [queryString, setQueryString] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [pickerPosition, setPickerPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const options = useMemo(() => {
    const baseOptions = getBaseOptions(editor, showModal);

    if (!queryString) {
      return baseOptions;
    }

    const regex = new RegExp(queryString, 'i');
    return [
      ...getDynamicOptions(editor, queryString),
      ...baseOptions.filter(
        option =>
          regex.test(option.title) ||
          option.keywords.some(keyword => regex.test(keyword)),
      ),
    ];
  }, [editor, queryString, showModal]);

  useEffect(() => {
    if (isPickerOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isPickerOpen]);

  useEffect(() => {
    if (!isPickerOpen || !options.length) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlightedIndex(current =>
      Math.min(current, Math.max(options.length - 1, 0)),
    );
  }, [isPickerOpen, options.length]);

  useEffect(() => {
    if (!isPickerOpen) {
      return;
    }
    const handleClickOutside = (event: MouseEvent) => {
      const target = getComposedEventTarget(event) as Node | null;
      if (
        (pickerRef.current && pickerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return;
      }
      setIsPickerOpen(false);
      setPickerState(null);
    };
    return registerEventListener(
      anchorElem.ownerDocument,
      'mousedown',
      handleClickOutside,
    );
  }, [isPickerOpen, anchorElem]);

  const selectOption = useCallback(
    (option: ComponentPickerOption) => {
      if (!pickerState) {
        setIsPickerOpen(false);
        return;
      }
      setIsPickerOpen(false);
      editor.update(() => {
        const node = $getNodeByKey(pickerState.targetNodeKey);
        if (!node) {
          return;
        }
        const placeholder = $createParagraphNode();
        const textNode = $createTextNode('');
        placeholder.append(textNode);
        if (pickerState.insertBefore) {
          node.insertBefore(placeholder);
        } else {
          node.insertAfter(placeholder);
        }
        textNode.select();
        option.onSelect(queryString);
        const latestPlaceholder = placeholder.getLatest();
        if ($isParagraphNode(latestPlaceholder)) {
          const onlyChild = latestPlaceholder.getFirstChild();
          if (
            $isTextNode(onlyChild) &&
            onlyChild.getTextContent().length === 0 &&
            latestPlaceholder.getChildrenSize() === 1
          ) {
            latestPlaceholder.remove();
          }
        }
      });
    },
    [editor, pickerState, queryString],
  );

  useEffect(() => {
    if (!isPickerOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isPickerOpen || !options.length) {
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex(index =>
          index + 1 >= options.length ? 0 : index + 1,
        );
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex(index =>
          index - 1 < 0 ? options.length - 1 : index - 1,
        );
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const option = options[highlightedIndex];
        if (option) {
          selectOption(option);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setIsPickerOpen(false);
        setPickerState(null);
      }
    };
    return registerEventListener(window, 'keydown', handleKeyDown);
  }, [highlightedIndex, isPickerOpen, options, selectOption]);

  function openComponentPicker(e: React.MouseEvent) {
    if (!draggableElement || !editor) {
      return;
    }

    let targetNodeKey: NodeKey | null = null;
    editor.read(() => {
      const resolvedNode = $getNearestNodeFromDOMNode(draggableElement);
      if (resolvedNode) {
        targetNodeKey = resolvedNode.getKey();
      }
    });

    if (!targetNodeKey) {
      return;
    }

    const insertBefore = e.altKey || e.ctrlKey;
    const rect = menuRef.current?.getBoundingClientRect();
    setPickerPosition(
      rect
        ? {
            left: rect.left + rect.width + window.scrollX + 8,
            top: rect.top + window.scrollY,
          }
        : null,
    );
    setPickerState({insertBefore, targetNodeKey});
    setQueryString('');
    setHighlightedIndex(0);
    setIsPickerOpen(true);
  }

  return (
    <>
      {modal}
      {isPickerOpen && pickerPosition
        ? ReactDOM.createPortal(
            <div
              className="typeahead-popover component-picker-menu draggable-block-component-picker"
              ref={pickerRef}
              style={{
                left: pickerPosition.left,
                position: 'absolute',
                top: pickerPosition.top,
                zIndex: 10,
              }}>
              <input
                className="component-picker-search"
                placeholder="Filter blocks..."
                value={queryString}
                ref={searchInputRef}
                onChange={event => setQueryString(event.target.value)}
              />
              <ul>
                {options.map((option, i: number) => (
                  <ComponentPickerMenuItem
                    index={i}
                    isSelected={highlightedIndex === i}
                    onClick={() => {
                      setHighlightedIndex(i);
                      selectOption(option);
                    }}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    key={option.key}
                    option={option}
                  />
                ))}
              </ul>
            </div>,
            anchorElem.ownerDocument.body,
          )
        : null}
      <DraggableBlockPlugin_EXPERIMENTAL
        anchorElem={anchorElem}
        menuRef={menuRef}
        targetLineRef={targetLineRef}
        menuComponent={
          <div ref={menuRef} className="icon draggable-block-menu">
            <button
              title="Click to add below"
              className="icon icon-plus"
              onClick={openComponentPicker}
            />
            <div className="icon" />
          </div>
        }
        targetLineComponent={
          <div ref={targetLineRef} className="draggable-block-target-line" />
        }
        isOnMenu={isOnMenu}
        onElementChanged={setDraggableElement}
        $getBlockBehavior={$getBlockBehavior}
      />
    </>
  );
}
