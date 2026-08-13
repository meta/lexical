/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import 'katex/dist/katex.css';

import {defineImportRule, DOMImportExtension, sel} from '@lexical/html';
import {
  $insertNodeIntoLeaf,
  $insertNodeToNearestRoot,
  $wrapNodeInElement,
} from '@lexical/utils';
import {
  $createParagraphNode,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  defineExtension,
  type LexicalCommand,
  type LexicalEditor,
} from 'lexical';
import {type JSX, useCallback} from 'react';

import {
  $createEquationNode,
  decodeEquation,
  EquationNode,
} from '../../nodes/EquationNode';
import KatexEquationAlterer from '../../ui/KatexEquationAlterer';

type CommandPayload = {
  equation: string;
  inline: boolean;
};

export const INSERT_EQUATION_COMMAND: LexicalCommand<CommandPayload> =
  /* @__PURE__ */ createCommand('INSERT_EQUATION_COMMAND');

function $convertEquationElement(el: HTMLElement) {
  const encoded = el.getAttribute('data-lexical-equation');
  if (!encoded) {
    return null;
  }
  const equation = decodeEquation(encoded);
  if (!equation) {
    return null;
  }
  const inline = el.getAttribute('data-lexical-inline') === 'true';
  return $createEquationNode(equation, inline);
}

const EquationImportRule = /* @__PURE__ */ defineImportRule({
  $import: (_ctx, el, $next) => {
    const node = $convertEquationElement(el);
    return node ? [node] : $next();
  },
  match: sel.tag('div', 'span').attr('data-lexical-equation', true),
  name: '@lexical/playground/equation',
});

export const EquationsExtension = /* @__PURE__ */ defineExtension({
  dependencies: [
    /* @__PURE__ */ configExtension(DOMImportExtension, {
      rules: [EquationImportRule],
    }),
  ],
  name: '@lexical/playground/Equations',
  nodes: [EquationNode],
  register: editor =>
    editor.registerCommand(
      INSERT_EQUATION_COMMAND,
      payload => {
        const {equation, inline} = payload;
        const equationNode = $createEquationNode(equation, inline);

        if (inline) {
          $insertNodeIntoLeaf(equationNode);
          if ($isRootOrShadowRoot(equationNode.getParent())) {
            $wrapNodeInElement(equationNode, $createParagraphNode).selectEnd();
          }
        } else {
          $insertNodeToNearestRoot(equationNode);
        }

        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

export function InsertEquationDialog({
  activeEditor,
  onClose,
}: {
  activeEditor: LexicalEditor;
  onClose: () => void;
}): JSX.Element {
  const onEquationConfirm = useCallback(
    (equation: string, inline: boolean) => {
      activeEditor.dispatchCommand(INSERT_EQUATION_COMMAND, {equation, inline});
      onClose();
    },
    [activeEditor, onClose],
  );

  return <KatexEquationAlterer onConfirm={onEquationConfirm} />;
}
