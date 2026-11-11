/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {MathTypeFormula} from './MathTypeData';
import type {MathTypeIntegrationInstance} from './MathTypeGlobals';
import type {LexicalEditor, NodeKey} from 'lexical';
import type {JSX} from 'react';

import '@wiris/mathtype-generic';

import {ReactExtension} from '@lexical/react/ReactExtension';
import {useExtensionDependency} from '@lexical/react/useExtensionComponent';
import {
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
} from 'lexical';
import {useEffect, useRef} from 'react';

import {createFormulaFromImage, createImageFromFormula} from './MathTypeData';
import {getWirisPlugin} from './MathTypeGlobals';
import {
  $createMathTypeNode,
  $isMathTypeNode,
  MathTypeNode,
} from './MathTypeNode';

type InsertFormulaResult = {
  focusElement: HTMLElement | Window;
  node: HTMLImageElement | null;
  windowTarget: Window;
};

/**
 * The mutable bridge state, created once per editor by
 * {@link MathTypeExtension}'s `build`. It deliberately stays private to that
 * closure: the extension output exposes functions that operate on it rather
 * than the object itself, so nothing that crosses a React hook boundary is
 * mutable.
 */
type MathTypeSession = {
  /** The MathType integration, while {@link MathTypeIntegrationComponent} is mounted. */
  integration: MathTypeIntegrationInstance | null;
  /**
   * The node the open MathType dialog is editing, or `null` when the dialog
   * will insert a new formula.
   */
  pendingNodeKey: NodeKey | null;
};

/**
 * The document that owns the editor. MathType elements are built here rather
 * than from the `document` global so they come from the editor's realm when it
 * lives in an iframe (see the Shadow DOM notes in the repository AGENTS.md).
 */
function getEditorDocument(editor: LexicalEditor): Document {
  const rootElement = editor.getRootElement();
  return rootElement !== null ? rootElement.ownerDocument : globalThis.document;
}

function $commitFormula(
  nodeKey: NodeKey | null,
  formula: MathTypeFormula,
): void {
  if (nodeKey !== null) {
    const node = $getNodeByKey(nodeKey);
    if ($isMathTypeNode(node)) {
      node.setFormula(formula);
      return;
    }
  }

  const mathTypeNode = $createMathTypeNode(formula);
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    selection.insertNodes([mathTypeNode]);
    return;
  }

  $getRoot().append($createParagraphNode().append(mathTypeNode));
}

function $removeFormula(nodeKey: NodeKey): void {
  const node = $getNodeByKey(nodeKey);
  if ($isMathTypeNode(node)) {
    node.remove();
  }
}

function createIntegration(
  editor: LexicalEditor,
  session: MathTypeSession,
  target: HTMLElement,
  toolbar: HTMLElement,
): MathTypeIntegrationInstance {
  const wirisPlugin = getWirisPlugin();
  const integration = new wirisPlugin.GenericIntegration({
    target,
    toolbar,
  });
  wirisPlugin.currentInstance = integration;

  const openNewFormulaEditor =
    integration.openNewFormulaEditor.bind(integration);
  integration.openNewFormulaEditor = () => {
    session.pendingNodeKey = null;
    // GenericIntegration.openNewFormulaEditor() reopens the *existing* formula
    // editor whenever editionProperties.temporalImage is still set. editFormula
    // sets it and only a completed insertion clears it, so without this reset a
    // cancelled edit would reopen the dismissed formula here and then insert it
    // as a second node. Clearing it is enough: the base implementation restores
    // dbclick and isNewElement itself once it takes the new-formula branch.
    integration.core.editionProperties.temporalImage = null;
    wirisPlugin.currentInstance = integration;
    openNewFormulaEditor();
  };

  integration.insertFormula = (
    focusElement: HTMLElement | Window,
    windowTarget: Window,
    mathML: null | string,
    wirisProperties: null | object,
  ): InsertFormulaResult => {
    const nodeKey = session.pendingNodeKey;
    session.pendingNodeKey = null;
    integration.core.editionProperties.temporalImage = null;
    // Focus once the formula is on screen; editor.update() is batched, so
    // focusing straight after it would run before reconciliation.
    const updateOptions = {onUpdate: () => editor.focus()};

    // ContentManager.submitAction() calls updateFormula(null) whenever the
    // dialog is accepted with an empty formula - Accept on a blank new
    // formula, or erasing an existing one - and the Accept button is never
    // disabled. Core.insertFormula reads empty MathML as "remove the
    // formula", and Parser.mathmlToImgObject would throw on it.
    if (!mathML) {
      if (nodeKey !== null) {
        editor.update(() => {
          $removeFormula(nodeKey);
        }, updateOptions);
      }
      return {focusElement, node: null, windowTarget};
    }

    // Null when the showimage service rejects the MathML as malformed; there
    // is nothing to commit, so leave the document as it was.
    const image = wirisPlugin.Parser.mathmlToImgObject(
      target.ownerDocument,
      mathML,
      wirisProperties,
    );
    if (image === null) {
      return {focusElement, node: null, windowTarget};
    }

    const formula = createFormulaFromImage(image, mathML);
    editor.update(() => {
      $commitFormula(nodeKey, formula);
    }, updateOptions);

    return {focusElement, node: image, windowTarget};
  };

  return integration;
}

/**
 * Creates the MathType integration for the given toolbar and edition target,
 * returning the function that tears it down again.
 */
function mountIntegration(
  editor: LexicalEditor,
  session: MathTypeSession,
  target: HTMLElement,
  toolbar: HTMLElement,
): () => void {
  const wirisPlugin = getWirisPlugin();
  const integration = createIntegration(editor, session, target, toolbar);
  integration.init();
  integration.listeners.fire('onTargetReady', {});
  session.integration = integration;

  // Give the editor its focus back whenever the dialog closes. Cancelling runs
  // IntegrationModel.setActionsOnCancelButtons(), which focuses `target` - the
  // offscreen, aria-hidden edition target - so without this the caret is
  // stranded there and typing goes nowhere the reader can see.
  const modalCloseListener = wirisPlugin.Listeners.newListener(
    'onModalClose',
    () => {
      if (wirisPlugin.currentInstance === integration) {
        editor.focus();
      }
    },
  );
  wirisPlugin.Core.globalListeners.add(modalCloseListener);

  return () => {
    // Listeners exposes add() but no remove(), so drop it from the array.
    const {listeners} = wirisPlugin.Core.globalListeners;
    const index = listeners.indexOf(modalCloseListener);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
    if (session.integration === integration) {
      session.integration = null;
    }
    toolbar.textContent = '';
    integration.destroy();
  };
}

/**
 * Opens the MathType dialog for an existing formula node. Returns false if the
 * integration has not mounted yet.
 */
function editFormula(
  editor: LexicalEditor,
  session: MathTypeSession,
  nodeKey: NodeKey,
  formula: MathTypeFormula,
): boolean {
  const integration = session.integration;
  if (integration === null) {
    return false;
  }
  session.pendingNodeKey = nodeKey;
  const {editionProperties} = integration.core;
  editionProperties.temporalImage = createImageFromFormula(
    formula,
    getEditorDocument(editor),
  );
  editionProperties.dbclick = true;
  editionProperties.isNewElement = false;

  const customEditors = integration.core.getCustomEditors();
  customEditors.disable();
  if (formula.customEditor !== null) {
    customEditors.enable(formula.customEditor);
  }

  integration.openExistingFormulaEditor();
  return true;
}

/**
 * Renders the MathType toolbar and the hidden element the MathType dialog uses
 * as its edition target. Mount it anywhere inside the editor with
 * `<ExtensionComponent lexical:extension={MathTypeExtension} />`.
 */
export function MathTypeIntegrationComponent(): JSX.Element {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLDivElement | null>(null);
  const extension = useExtensionDependency(MathTypeExtension).output;

  useEffect(() => {
    const toolbar = toolbarRef.current;
    const target = targetRef.current;
    if (toolbar === null || target === null) {
      return;
    }
    return extension.mountIntegration(target, toolbar);
  }, [extension]);

  return (
    <>
      <div className="mathtype-toolbar" ref={toolbarRef} />
      {/*
        MathType needs a contenteditable element to anchor its dialog, but this
        editor commits formulas to Lexical nodes instead, so the element is kept
        offscreen and hidden from assistive technology. tabIndex={-1} keeps it
        out of the tab order: a contenteditable element is focusable by default,
        and an aria-hidden element must never be reachable by keyboard.
      */}
      <div
        aria-hidden="true"
        className="mathtype-target"
        contentEditable={true}
        ref={targetRef}
        tabIndex={-1}
      />
    </>
  );
}

/**
 * Bridges the WIRIS MathType generic integration to Lexical: it renders the
 * MathType toolbar, stores formulas as {@link MathTypeNode} instead of letting
 * MathType write into the contenteditable, and reopens MathType when a formula
 * is double-clicked.
 */
export const MathTypeExtension = defineExtension({
  build(editor) {
    const session: MathTypeSession = {integration: null, pendingNodeKey: null};
    return {
      Component: MathTypeIntegrationComponent,
      editFormula: (nodeKey: NodeKey, formula: MathTypeFormula) =>
        editFormula(editor, session, nodeKey, formula),
      mountIntegration: (target: HTMLElement, toolbar: HTMLElement) =>
        mountIntegration(editor, session, target, toolbar),
    };
  },
  dependencies: [ReactExtension],
  name: '@lexical/react-mathtype-example/MathType',
  // Referenced lazily: MathTypeNode imports this module back for
  // useExtensionDependency, and an eager reference would be a temporal dead
  // zone error when MathTypeNode is the module the bundle evaluates first.
  nodes: () => [MathTypeNode],
});
