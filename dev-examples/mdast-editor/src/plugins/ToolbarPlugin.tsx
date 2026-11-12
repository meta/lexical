/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
} from '@lexical/list';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useExtensionSignalValue} from '@lexical/react/useExtensionSignalValue';
import {INSERT_TABLE_COMMAND} from '@lexical/table';
import {
  FORMAT_TEXT_COMMAND,
  type LexicalEditor,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical';

import {INSERT_ALERT_COMMAND} from '../extensions/MdastAlertExtension';
import {INSERT_COLLAPSIBLE_COMMAND} from '../extensions/MdastCollapsibleExtension';
import {
  FORMAT_HEADING_COMMAND,
  FORMAT_PARAGRAPH_COMMAND,
  MdastEditorExtension,
} from '../extensions/MdastEditorExtension';
import {INSERT_FOOTNOTE_COMMAND} from '../extensions/MdastFootnoteExtension';
import {FORMAT_KBD_COMMAND} from '../extensions/MdastKbdExtension';
import {
  type BlockType,
  ToolbarStateExtension,
} from '../extensions/ToolbarStateExtension';
import {
  applyTableAction,
  TABLE_ACTIONS,
  type TableAction,
} from './tableActions';

const BLOCK_TYPES: readonly {label: string; value: BlockType}[] = [
  {label: 'Paragraph', value: 'paragraph'},
  {label: 'Heading 1', value: 'h1'},
  {label: 'Heading 2', value: 'h2'},
  {label: 'Heading 3', value: 'h3'},
  {label: 'Bullet List', value: 'bullet'},
  {label: 'Numbered List', value: 'number'},
  {label: 'Check List', value: 'check'},
];

const INSERT_TYPES = [
  {label: 'Keyboard key', value: 'kbd'},
  {label: 'Collapsible section', value: 'details'},
  {label: 'Alert', value: 'alert'},
  {label: 'Footnote', value: 'footnote'},
  {label: 'Table', value: 'table'},
] as const;

type InsertType = (typeof INSERT_TYPES)[number]['value'];

function applyInsert(editor: LexicalEditor, type: InsertType): void {
  switch (type) {
    case 'kbd':
      editor.dispatchCommand(FORMAT_KBD_COMMAND);
      return;
    case 'details':
      editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND);
      return;
    case 'alert':
      editor.dispatchCommand(INSERT_ALERT_COMMAND, 'note');
      return;
    case 'footnote':
      editor.dispatchCommand(INSERT_FOOTNOTE_COMMAND);
      return;
    case 'table':
      // GFM has a header row, not a header column.
      editor.dispatchCommand(INSERT_TABLE_COMMAND, {
        columns: '2',
        includeHeaders: {columns: false, rows: true},
        rows: '2',
      });
      return;
  }
}

function applyBlockType(editor: LexicalEditor, type: BlockType): void {
  switch (type) {
    case 'paragraph':
      editor.dispatchCommand(REMOVE_LIST_COMMAND);
      editor.dispatchCommand(FORMAT_PARAGRAPH_COMMAND);
      return;
    case 'h1':
    case 'h2':
    case 'h3':
      editor.dispatchCommand(FORMAT_HEADING_COMMAND, type);
      return;
    case 'bullet':
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND);
      return;
    case 'number':
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND);
      return;
    case 'check':
      editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND);
      return;
  }
}

const selectClass =
  'h-7 cursor-pointer appearance-none rounded-md border border-solid border-transparent bg-transparent px-2 text-sm font-medium text-zinc-700 transition-colors duration-150 enabled:hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-30 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-zinc-200 dark:enabled:hover:bg-zinc-700';

const buttonBase =
  'group flex h-7 cursor-pointer items-center justify-center rounded-md border-0 px-2 font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500';
const buttonInactive =
  'bg-transparent text-zinc-700 enabled:hover:bg-zinc-200 dark:text-zinc-200 dark:enabled:hover:bg-zinc-700';
const buttonActive =
  'bg-blue-500 text-white enabled:hover:bg-blue-600 dark:bg-blue-600 dark:enabled:hover:bg-blue-700';

function Divider() {
  return (
    <div className="mx-1 h-5 w-px self-center bg-zinc-200 dark:bg-zinc-600" />
  );
}

export function ToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const canUndo = useExtensionSignalValue(ToolbarStateExtension, 'canUndo');
  const canRedo = useExtensionSignalValue(ToolbarStateExtension, 'canRedo');
  const blockType = useExtensionSignalValue(ToolbarStateExtension, 'blockType');
  const isBold = useExtensionSignalValue(ToolbarStateExtension, 'isBold');
  const isItalic = useExtensionSignalValue(ToolbarStateExtension, 'isItalic');
  const isCode = useExtensionSignalValue(ToolbarStateExtension, 'isCode');
  const isEditable = useExtensionSignalValue(
    MdastEditorExtension,
    'isEditable',
  );

  return (
    <div
      className="flex flex-1 items-center gap-0.5 overflow-x-auto"
      role="toolbar"
      aria-label="Formatting">
      <select
        className={selectClass}
        value={blockType}
        disabled={!isEditable}
        onChange={e => applyBlockType(editor, e.target.value as BlockType)}
        aria-label="Block type">
        {BLOCK_TYPES.map(({label, value}) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <Divider />
      <button
        type="button"
        disabled={!isEditable || !canUndo}
        onClick={() => editor.dispatchCommand(UNDO_COMMAND)}
        className={`${buttonBase} ${buttonInactive} text-xs`}
        aria-label="Undo">
        Undo
      </button>
      <button
        type="button"
        disabled={!isEditable || !canRedo}
        onClick={() => editor.dispatchCommand(REDO_COMMAND)}
        className={`${buttonBase} ${buttonInactive} text-xs`}
        aria-label="Redo">
        Redo
      </button>
      <Divider />
      <button
        type="button"
        disabled={!isEditable}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}
        className={`${buttonBase} ${isBold ? buttonActive : buttonInactive} text-sm font-bold`}
        aria-label="Bold"
        aria-pressed={isBold}>
        B
      </button>
      <button
        type="button"
        disabled={!isEditable}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}
        className={`${buttonBase} ${isItalic ? buttonActive : buttonInactive} text-sm italic`}
        aria-label="Italic"
        aria-pressed={isItalic}>
        I
      </button>
      <button
        type="button"
        disabled={!isEditable}
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code')}
        className={`${buttonBase} ${isCode ? buttonActive : buttonInactive} font-mono text-xs`}
        aria-label="Inline code"
        aria-pressed={isCode}>
        {'</>'}
      </button>
      <Divider />
      {/* A value-less controlled select: picking an entry dispatches the
          insert and the label snaps back to "Insert". */}
      <select
        className={selectClass}
        value=""
        disabled={!isEditable}
        onChange={e => applyInsert(editor, e.target.value as InsertType)}
        aria-label="Insert">
        <option value="" hidden={true}>
          Insert
        </option>
        {INSERT_TYPES.map(({label, value}) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <select
        className={selectClass}
        value="-"
        disabled={!isEditable}
        onChange={e => applyTableAction(editor, e.target.value as TableAction)}
        aria-label="Table">
        <option value="-" hidden={true}>
          Table
        </option>
        {TABLE_ACTIONS.map(({label, value}) => (
          <option key={label} value={value}>
            {label}
          </option>
        ))}
      </select>
      <div className="ml-auto flex items-center">
        <Divider />
        <button
          type="button"
          onClick={() => editor.setEditable(!editor.isEditable())}
          className={`${buttonBase} ${isEditable ? buttonInactive : buttonActive} text-sm`}
          aria-label="Toggle read-only mode"
          title={isEditable ? 'Lock editing (read-only)' : 'Unlock editing'}
          aria-pressed={!isEditable}>
          {isEditable ? '\u{1F513}' : '\u{1F512}'}
        </button>
      </div>
    </div>
  );
}
