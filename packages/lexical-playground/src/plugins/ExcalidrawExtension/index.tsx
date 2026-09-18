/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {ExcalidrawInitialElements} from '../../ui/ExcalidrawModal';
import type {AppState, BinaryFiles} from '@excalidraw/excalidraw/types';

import '@excalidraw/excalidraw/index.css';

import {defineImportRule, DOMImportExtension, sel} from '@lexical/html';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$wrapNodeInElement} from '@lexical/utils';
import {
  $createParagraphNode,
  $insertNodes,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  defineExtension,
  type LexicalCommand,
} from 'lexical';
import {type JSX, useEffect, useState} from 'react';

import {
  $createExcalidrawNode,
  ExcalidrawNode,
} from '../../nodes/ExcalidrawNode';
import ExcalidrawModal from '../../ui/ExcalidrawModal';

export const INSERT_EXCALIDRAW_COMMAND: LexicalCommand<void> = createCommand(
  'INSERT_EXCALIDRAW_COMMAND',
);

const ExcalidrawImportRule = defineImportRule({
  $import: (ctx, el) => {
    const data = el.getAttribute('data-lexical-excalidraw-json')!;
    const styles = window.getComputedStyle(el);
    const parseDimension = (v: string) =>
      !v || v === 'inherit' ? 'inherit' : parseInt(v, 10);
    return [
      $createExcalidrawNode(
        data,
        parseDimension(styles.getPropertyValue('width')),
        parseDimension(styles.getPropertyValue('height')),
      ),
    ];
  },
  match: sel.tag('span').attr('data-lexical-excalidraw-json', true),
  name: '@lexical/playground/excalidraw',
});

export const ExcalidrawExtension = defineExtension({
  dependencies: [
    configExtension(DOMImportExtension, {
      rules: [ExcalidrawImportRule],
    }),
  ],
  name: '@lexical/playground/Excalidraw',
  nodes: [ExcalidrawNode],
});

export function ExcalidrawPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [isModalOpen, setModalOpen] = useState<boolean>(false);

  useEffect(() => {
    if (!editor.hasNodes([ExcalidrawNode])) {
      throw new Error(
        'ExcalidrawPlugin: ExcalidrawNode not registered on editor',
      );
    }

    return editor.registerCommand(
      INSERT_EXCALIDRAW_COMMAND,
      () => {
        setModalOpen(true);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  const onClose = () => {
    setModalOpen(false);
  };

  const onDelete = () => {
    setModalOpen(false);
  };

  const onSave = (
    elements: ExcalidrawInitialElements,
    appState: Partial<AppState>,
    files: BinaryFiles,
  ) => {
    editor.update(() => {
      const excalidrawNode = $createExcalidrawNode();
      excalidrawNode.setData(
        JSON.stringify({
          appState,
          elements,
          files,
        }),
      );
      $insertNodes([excalidrawNode]);
      if ($isRootOrShadowRoot(excalidrawNode.getParentOrThrow())) {
        $wrapNodeInElement(excalidrawNode, $createParagraphNode).selectEnd();
      }
    });
    setModalOpen(false);
  };

  return isModalOpen ? (
    <ExcalidrawModal
      initialElements={[]}
      initialAppState={{} as AppState}
      initialFiles={{}}
      isShown={isModalOpen}
      onDelete={onDelete}
      onClose={onClose}
      onSave={onSave}
      closeOnClickOutside={false}
    />
  ) : null;
}
