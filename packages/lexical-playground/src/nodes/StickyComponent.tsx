/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './StickyNode.css';

import {useCollaborationContext} from '@lexical/react/LexicalCollaborationContext';
import {CollaborationPlugin} from '@lexical/react/LexicalCollaborationPlugin';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalExtensionEditorComposer} from '@lexical/react/LexicalExtensionEditorComposer';
import {calculateZoomLevel} from '@lexical/utils';
import {
  $getNodeByKey,
  type LexicalEditorWithDispose,
  mergeRegister,
  type NodeKey,
  registerEventListener,
  registerEventListeners,
} from 'lexical';
import * as React from 'react';
import {type JSX, useEffect, useLayoutEffect, useRef} from 'react';

import {createWebsocketProvider, skipCollaborationInit} from '../collaboration';
import {$isStickyNode} from './StickyNode';

interface Positioning {
  isDragging: boolean;
  offsetX: number;
  offsetY: number;
  rootElementRect: null | DOMRect;
  x: number;
  y: number;
}

function positionSticky(
  stickyElem: HTMLElement,
  positioning: Positioning,
): void {
  const style = stickyElem.style;
  const rootElementRect = positioning.rootElementRect;
  const rectLeft = rootElementRect !== null ? rootElementRect.left : 0;
  const rectTop = rootElementRect !== null ? rootElementRect.top : 0;
  style.top = rectTop + positioning.y + 'px';
  style.left = rectLeft + positioning.x + 'px';
}

export default function StickyComponent({
  x,
  y,
  nodeKey,
  color,
  caption,
}: {
  caption: LexicalEditorWithDispose;
  color: 'pink' | 'yellow';
  nodeKey: NodeKey;
  x: number;
  y: number;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const stickyContainerRef = useRef<null | HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);
  const positioningRef = useRef<Positioning>({
    isDragging: false,
    offsetX: 0,
    offsetY: 0,
    rootElementRect: null,
    x: 0,
    y: 0,
  });
  const {isCollabActive} = useCollaborationContext();

  useEffect(() => {
    const position = positioningRef.current;
    position.x = x;
    position.y = y;

    const stickyContainer = stickyContainerRef.current;
    if (stickyContainer !== null) {
      positionSticky(stickyContainer, position);
    }
  }, [x, y]);

  useLayoutEffect(() => {
    const position = positioningRef.current;
    const resizeObserver = new ResizeObserver(entries => {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const {target} = entry;
        position.rootElementRect = target.getBoundingClientRect();
        const stickyContainer = stickyContainerRef.current;
        if (stickyContainer !== null) {
          positionSticky(stickyContainer, position);
        }
      }
    });

    const handleWindowResize = () => {
      const rootElement = editor.getRootElement();
      const stickyContainer = stickyContainerRef.current;
      if (rootElement !== null && stickyContainer !== null) {
        position.rootElementRect = rootElement.getBoundingClientRect();
        positionSticky(stickyContainer, position);
      }
    };

    return mergeRegister(
      editor.registerRootListener(nextRootElem => {
        if (nextRootElem !== null) {
          resizeObserver.observe(nextRootElem);
          return () => resizeObserver.unobserve(nextRootElem);
        }
      }),
      registerEventListener(window, 'resize', handleWindowResize),
    );
  }, [editor]);

  useEffect(() => {
    const stickyContainer = stickyContainerRef.current;
    if (stickyContainer !== null) {
      // Delay adding transition so we don't trigger the
      // transition on load of the sticky.
      setTimeout(() => {
        stickyContainer.style.setProperty(
          'transition',
          'top 0.3s ease 0s, left 0.3s ease 0s',
        );
      }, 500);
    }
  }, []);

  const handlePointerMove = (event: PointerEvent) => {
    const stickyContainer = stickyContainerRef.current;
    const positioning = positioningRef.current;
    const rootElementRect = positioning.rootElementRect;
    const zoom = calculateZoomLevel(stickyContainer);
    if (
      stickyContainer !== null &&
      positioning.isDragging &&
      rootElementRect !== null
    ) {
      positioning.x =
        event.pageX / zoom - positioning.offsetX - rootElementRect.left;
      positioning.y =
        event.pageY / zoom - positioning.offsetY - rootElementRect.top;
      positionSticky(stickyContainer, positioning);
    }
  };

  const handlePointerUp = (event: PointerEvent) => {
    const stickyContainer = stickyContainerRef.current;
    const positioning = positioningRef.current;
    if (stickyContainer !== null) {
      positioning.isDragging = false;
      stickyContainer.classList.remove('dragging');
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isStickyNode(node)) {
          node.setPosition(positioning.x, positioning.y);
        }
      });
    }
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
  };

  const handleDelete = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isStickyNode(node)) {
        node.remove();
      }
    });
  };

  const handleColorChange = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isStickyNode(node)) {
        node.toggleColor();
      }
    });
  };

  return (
    <div ref={stickyContainerRef} className="sticky-note-container">
      <div
        className={`sticky-note ${color}`}
        onPointerDown={event => {
          const stickyContainer = stickyContainerRef.current;
          if (
            stickyContainer == null ||
            event.button === 2 ||
            event.target !== stickyContainer.firstChild
          ) {
            // Right click or click on editor should not work
            return;
          }
          const stickContainer = stickyContainer;
          const positioning = positioningRef.current;
          if (stickContainer !== null) {
            const {top, left} = stickContainer.getBoundingClientRect();
            const zoom = calculateZoomLevel(stickContainer);
            positioning.offsetX = event.clientX / zoom - left;
            positioning.offsetY = event.clientY / zoom - top;
            positioning.isDragging = true;
            stickContainer.classList.add('dragging');
            const doc = stickContainer.ownerDocument;
            dragCleanupRef.current?.();
            dragCleanupRef.current = registerEventListeners(doc, {
              pointermove: handlePointerMove,
              pointerup: handlePointerUp,
            });
            event.preventDefault();
          }
        }}>
        <button
          onClick={handleDelete}
          className="delete"
          aria-label="Delete sticky note"
          title="Delete">
          X
        </button>
        <button
          onClick={handleColorChange}
          className="color"
          aria-label="Change sticky note color"
          title="Color">
          <i className="bucket" />
        </button>
        <LexicalExtensionEditorComposer initialEditor={caption}>
          {isCollabActive ? (
            <CollaborationPlugin
              id={caption.getKey()}
              providerFactory={createWebsocketProvider}
              shouldBootstrap={!skipCollaborationInit}
              selectionHighlight={true}
            />
          ) : null}
        </LexicalExtensionEditorComposer>
      </div>
    </div>
  );
}
