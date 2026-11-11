/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {useLexicalEditable} from '@lexical/react/useLexicalEditable';
import {useLexicalNodeSelection} from '@lexical/react/useLexicalNodeSelection';
import {
  $createParagraphNode,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isTextNode,
  $onUpdate,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  getActiveElement,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  mergeRegister,
  type NodeKey,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import * as React from 'react';
import {type JSX, useCallback, useEffect, useRef, useState} from 'react';

import EquationEditor from '../ui/EquationEditor';
import KatexRenderer from '../ui/KatexRenderer';
import {$isEquationNode} from './EquationNode';

type EquationComponentProps = {
  equation: string;
  inline: boolean;
  nodeKey: NodeKey;
};

export default function EquationComponent({
  equation,
  inline,
  nodeKey,
}: EquationComponentProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const isEditable = useLexicalEditable();
  const [isSelected, setSelected, clearSelection] =
    useLexicalNodeSelection(nodeKey);
  const [equationValue, setEquationValue] = useState(equation);
  const [showEquationEditor, setShowEquationEditor] = useState<boolean>(false);
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);

  // Promote a click on the rendered KaTeX into a NodeSelection on this
  // EquationNode. Without this, an EquationNode that is the only root
  // child has no way to receive a selection — lexical's generic click
  // handler does not turn DecoratorNode clicks into NodeSelection, so
  // `$getSelection()` would stay `null` and downstream commands
  // (Backspace, copy, ...) have nothing to act on.
  //
  // Listening through `CLICK_COMMAND` (instead of a React DOM `onClick`)
  // matches the ImageComponent pattern: the lexical command fires
  // *after* lexical's own selection normalization for the click, so the
  // NodeSelection we set here is not immediately overwritten by the
  // RangeSelection attempt that follows the native `selectionchange`.
  const onClick = useCallback(
    (event: MouseEvent) => {
      const dom = editor.getElementByKey(nodeKey);
      if (dom === null || !dom.contains(event.target as Node)) {
        return false;
      }
      if (event.shiftKey) {
        setSelected(!isSelected);
      } else {
        clearSelection();
        setSelected(true);
      }
      return true;
    },
    [clearSelection, editor, isSelected, nodeKey, setSelected],
  );

  useEffect(() => {
    return editor.registerCommand(CLICK_COMMAND, onClick, COMMAND_PRIORITY_LOW);
  }, [editor, onClick]);

  // Pressing Enter while this equation is the lone NodeSelection
  // inserts a fresh empty paragraph right after it and moves the caret
  // into the new paragraph. Without this, the default rich-text path
  // (lifted to a RangeSelection past the decorator via
  // RichTextExtension's block-decorator branch) leaves the caret on a
  // root-level element point that swallows further keystrokes — the
  // user sees an editor that won't accept text after a fresh equation.
  const $onEnter = useCallback(
    (event: null | KeyboardEvent) => {
      const latestSelection = $getSelection();
      if (
        !(
          $isNodeSelection(latestSelection) &&
          latestSelection.has(nodeKey) &&
          latestSelection.getNodes().length === 1
        )
      ) {
        return false;
      }
      const node = $getNodeByKey(nodeKey);
      if (!$isEquationNode(node)) {
        return false;
      }
      // The KEY_ENTER_COMMAND handler runs inside an active editor
      // scope, so lexical state mutations happen directly here (no
      // `editor.update` wrap — wrapping would defer the work to a
      // microtask, and the surrounding `event.preventDefault() +
      // return true` would fall through to the default rich-text
      // path before our paragraph insertion lands).
      if (node.isInline()) {
        const parent = node.getParent();
        if (!$isElementNode(parent)) {
          return false;
        }
        const paragraph = $createParagraphNode();
        parent.insertAfter(paragraph);
        paragraph.select();
      } else {
        const paragraph = $createParagraphNode();
        node.insertAfter(paragraph);
        paragraph.select();
      }
      event?.preventDefault();
      return true;
    },
    [nodeKey],
  );

  useEffect(() => {
    if (!isEditable) {
      return undefined;
    }
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      $onEnter,
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, isEditable, $onEnter]);

  // Remove this equation when the user presses Backspace inside an
  // already-empty `EquationEditor`. Without this, the LaTeX input
  // swallows the keystroke (its value is already empty so the browser
  // does nothing), and lexical never sees the deletion attempt — the
  // node would otherwise sit empty in the editor forever.
  const onDeleteEmpty = useCallback(() => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isEquationNode(node)) {
        return;
      }
      if (node.isInline()) {
        // Clear lexical's selection first (avoid stale NodeSelection
        // node refs surviving the remove) and preserve the wrapper
        // paragraph (`remove(true)`) so lexical doesn't try to chain-
        // delete a now-empty parent during commit.
        $setSelection(null);
        node.remove(true);
        return;
      }
      const prevSibling = node.getPreviousSibling();
      if ($isElementNode(prevSibling) || $isTextNode(prevSibling)) {
        node.remove();
        prevSibling.selectEnd();
        return;
      }
      // Block equation with no previous sibling — naive `node.remove()`
      // here would leave the root with zero children and no parkable
      // cursor (lexical's `EditorState.isEmpty()` accepts an empty
      // root, and rich-text does not re-seed a paragraph), forcing
      // the user to reload. Swap the equation for a fresh empty
      // paragraph instead.
      const paragraph = $createParagraphNode();
      node.replace(paragraph);
      paragraph.select();
    });
  }, [editor, nodeKey]);

  // Mirror `isSelected` onto the keyed `<div|span class="editor-equation">`
  // (the element returned by `EquationNode.createDOM`) so the existing
  // `.editor-equation.focused` CSS rule renders the outline. React owns
  // the inner `KatexRenderer` subtree but not the keyed wrapper, so we
  // toggle the class imperatively.
  useEffect(() => {
    const dom = editor.getElementByKey(nodeKey);
    if (dom === null) {
      return;
    }
    if (isSelected && isEditable) {
      dom.classList.add('focused');
    } else {
      dom.classList.remove('focused');
    }
  }, [editor, nodeKey, isSelected, isEditable]);

  const onHide = useCallback(
    (restoreSelection?: boolean) => {
      setShowEquationEditor(false);
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isEquationNode(node)) {
          node.setEquation(equationValue);
          if (restoreSelection) {
            node.selectNext(0, 0);
          }
        }
      });
    },
    [editor, equationValue, nodeKey],
  );

  useEffect(() => {
    if (!showEquationEditor && equationValue !== equation) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEquationValue(equation);
    }
  }, [showEquationEditor, equation, equationValue]);

  useEffect(() => {
    if (!isEditable) {
      return;
    }
    if (showEquationEditor) {
      return mergeRegister(
        editor.registerCommand(
          SELECTION_CHANGE_COMMAND,
          payload => {
            $onUpdate(() => {
              const inputElem = inputRef.current;
              // getActiveElement rather than document.activeElement, which
              // reports the shadow host when the editor is in a shadow root.
              const activeElement = inputElem
                ? getActiveElement(inputElem)
                : null;
              if (inputElem !== activeElement) {
                onHide();
              }
            });
            return false;
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          KEY_ESCAPE_COMMAND,
          payload => {
            const inputElem = inputRef.current;
            const activeElement = inputElem
              ? getActiveElement(inputElem)
              : null;
            if (inputElem === activeElement) {
              onHide(true);
              return true;
            }
            return false;
          },
          COMMAND_PRIORITY_HIGH,
        ),
      );
    }
    // Previously this branch promoted any NodeSelection on this
    // equation into the EquationEditor input automatically. That
    // collides with the new single-click → NodeSelection flow (a click
    // would immediately drop the user into the input). The double-click
    // gesture (`KatexRenderer.onDoubleClick`) is now the only path into
    // edit mode.
    return undefined;
  }, [editor, nodeKey, onHide, showEquationEditor, isEditable]);

  return (
    <>
      {showEquationEditor && isEditable ? (
        <EquationEditor
          equation={equationValue}
          setEquation={setEquationValue}
          inline={inline}
          onDeleteEmpty={onDeleteEmpty}
          ref={inputRef}
        />
      ) : (
        <LexicalErrorBoundary onError={e => editor._onError(e)} fallback={null}>
          <KatexRenderer
            equation={equationValue}
            inline={inline}
            onDoubleClick={() => {
              if (isEditable) {
                setShowEquationEditor(true);
              }
            }}
          />
        </LexicalErrorBoundary>
      )}
    </>
  );
}
