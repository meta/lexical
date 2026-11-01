/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ExtensionState} from '../../store';
import type {SerializedRawEditorState} from '../../types';
import type {IPegasusRPCService, PegasusRPCMessage} from '@webext-pegasus/rpc';
import type {LexicalEditor} from 'lexical';
import type {StoreApi} from 'zustand';

import {generateContent, type LexicalCommandLog} from '@lexical/devtools-core';

import {ElementPicker} from '../../element-picker';
import {readEditorState} from '../../lexicalForExtension';
import {deserializeEditorState} from '../../serializeEditorState';
import {isLexicalNode} from '../../utils/isLexicalNode';
import {assertTrustedRPCCaller} from './assertTrustedRPCCaller';
import scanAndListenForEditors from './scanAndListenForEditors';
import {
  queryLexicalEditorByKey,
  queryLexicalNodeByKey,
} from './utils/queryLexicalByKey';

const ELEMENT_PICKER_STYLE = {borderColor: '#0000ff'};

export type IInjectedPegasusService = InstanceType<
  typeof InjectedPegasusService
>;

/**
 * Services exposed by the injected script.
 *
 * This code runs in the page's main world, so every method here is reachable
 * by anything that can talk on the extension's window messaging channel.
 * Each entry point therefore starts by asserting that its caller is an
 * extension surface (the DevTools panel or the popup) rather than the page.
 */
export class InjectedPegasusService implements IPegasusRPCService<InjectedPegasusService> {
  private pickerActive: ElementPicker | null = null;

  constructor(
    private readonly tabID: number,
    private readonly extensionStore: StoreApi<ExtensionState>,
    private readonly commandLog: WeakMap<LexicalEditor, LexicalCommandLog>,
  ) {}

  refreshLexicalEditors(message: PegasusRPCMessage) {
    assertTrustedRPCCaller(message);

    scanAndListenForEditors(this.tabID, this.extensionStore, this.commandLog);
  }

  setEditorReadOnly(
    message: PegasusRPCMessage,
    editorKey: string,
    isReadonly: boolean,
  ): void {
    assertTrustedRPCCaller(message);

    const editorNode = queryLexicalNodeByKey(editorKey);
    if (editorNode == null) {
      throw new Error(`Can't find editor with key: ${editorKey}`);
    }

    editorNode.contentEditable = isReadonly ? 'false' : 'true';
  }

  generateTreeViewContent(
    message: PegasusRPCMessage,
    editorKey: string,
    exportDOM: boolean,
    // Defaults to redacting the editor's text. Callers that are rendering the
    // tree for a panel the user has explicitly opened opt back in.
    obfuscateText: boolean = true,
  ): string {
    assertTrustedRPCCaller(message);

    const editor = queryLexicalEditorByKey(editorKey);
    if (editor == null) {
      throw new Error(`Can't find editor with key: ${editorKey}`);
    }

    return readEditorState(editor, editor.getEditorState(), () =>
      generateContent(
        editor,
        this.commandLog.get(editor) ?? [],
        exportDOM,
        undefined,
        obfuscateText,
      ),
    );
  }

  setEditorState(
    message: PegasusRPCMessage,
    editorKey: string,
    editorState: SerializedRawEditorState,
  ): void {
    assertTrustedRPCCaller(message);

    const editor = queryLexicalEditorByKey(editorKey);
    if (editor == null) {
      throw new Error(`Can't find editor with key: ${editorKey}`);
    }

    editor.setEditorState(deserializeEditorState(editorState));
  }

  toggleEditorPicker(message: PegasusRPCMessage): void {
    assertTrustedRPCCaller(message);

    if (this.pickerActive !== null) {
      this.deactivatePicker();
    } else {
      this.activatePicker();
    }
  }

  private activatePicker(): void {
    this.extensionStore.getState().setIsSelecting(this.tabID, true);

    this.pickerActive = new ElementPicker({style: ELEMENT_PICKER_STYLE});
    this.pickerActive.start({
      elementFilter: el => {
        let parent: HTMLElement | null = el;
        while (parent !== null && parent.tagName !== 'BODY') {
          if ('__lexicalEditor' in parent) {
            return parent;
          }
          parent = parent.parentElement;
        }

        return false;
      },

      onClick: el => {
        this.deactivatePicker();
        if (isLexicalNode(el)) {
          this.extensionStore
            .getState()
            .setSelectedEditorKey(this.tabID, el.__lexicalEditor.getKey());
        } else {
          console.warn('Selected Element is not a Lexical node');
        }
      },
    });
  }

  private deactivatePicker(): void {
    this.pickerActive?.stop();
    this.pickerActive = null;
    this.extensionStore.getState().setIsSelecting(this.tabID, false);
  }
}
