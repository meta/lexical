/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode} from '@lexical/code';
import {INSERT_HORIZONTAL_RULE_COMMAND} from '@lexical/extension';
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from '@lexical/list';
import {INSERT_EMBED_COMMAND} from '@lexical/react/LexicalAutoEmbedPlugin';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {INSERT_TABLE_COMMAND} from '@lexical/table';
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  FORMAT_ELEMENT_COMMAND,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {type JSX, useCallback, useMemo, useState} from 'react';

import useModal from '../../hooks/useModal';
import catTypingGif from '../../images/cat-typing.gif';
import {EmbedConfigs} from '../AutoEmbedPlugin';
import {INSERT_CARD_COMMAND} from '../CardExtension';
import {INSERT_COLLAPSIBLE_COMMAND} from '../CollapsibleExtension';
import {INSERT_DATETIME_COMMAND} from '../DateTimeExtension';
import {InsertEquationDialog} from '../EquationsExtension';
import {INSERT_EXCALIDRAW_COMMAND} from '../ExcalidrawExtension';
import {INSERT_IMAGE_COMMAND, InsertImageDialog} from '../ImagesExtension';
import InsertLayoutDialog from '../LayoutExtension/InsertLayoutDialog';
import {INSERT_PAGE_BREAK} from '../PageBreakExtension';
import {InsertPollDialog} from '../PollExtension';
import {INSERT_PULLQUOTE_COMMAND} from '../PullQuoteExtension';
import {INSERT_REVIEW_COMMAND} from '../ReviewExtension';
import {InsertTableDialog} from '../TablePlugin';

export class ComponentPickerOption extends MenuOption {
  // What shows up in the editor
  title: string;
  // Icon for display
  icon?: JSX.Element;
  // For extra searching.
  keywords: string[];
  // TBD
  keyboardShortcut?: string;
  // What happens when you select this option?
  onSelect: (queryString: string) => void;

  constructor(
    title: string,
    options: {
      icon?: JSX.Element;
      keywords?: string[];
      keyboardShortcut?: string;
      onSelect: (queryString: string) => void;
    },
  ) {
    super(title);
    this.title = title;
    this.keywords = options.keywords || [];
    this.icon = options.icon;
    this.keyboardShortcut = options.keyboardShortcut;
    this.onSelect = options.onSelect.bind(this);
  }
}

export function ComponentPickerMenuItem({
  index,
  isSelected,
  onClick,
  onMouseEnter,
  option,
}: {
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  option: ComponentPickerOption;
}) {
  let className = 'item';
  if (isSelected) {
    className += ' selected';
  }
  return (
    <li
      key={option.key}
      tabIndex={-1}
      className={className}
      ref={option.setRefElement}
      role="option"
      aria-selected={isSelected}
      id={'typeahead-item-' + index}
      onMouseEnter={onMouseEnter}
      onClick={onClick}>
      {option.icon}
      <span className="text">{option.title}</span>
    </li>
  );
}

export function getDynamicOptions(editor: LexicalEditor, queryString: string) {
  const options: ComponentPickerOption[] = [];

  if (queryString == null) {
    return options;
  }

  const tableMatch = queryString.match(/^([1-9]\d?)(?:x([1-9]\d?)?)?$/);

  if (tableMatch !== null) {
    const rows = tableMatch[1];
    const colOptions = tableMatch[2]
      ? [tableMatch[2]]
      : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(String);

    options.push(
      ...colOptions.map(
        columns =>
          new ComponentPickerOption(`${rows}x${columns} Table`, {
            icon: <i className="icon table" />,
            keywords: ['table'],
            onSelect: () =>
              editor.dispatchCommand(INSERT_TABLE_COMMAND, {columns, rows}),
          }),
      ),
    );
  }

  return options;
}

export type ShowModal = ReturnType<typeof useModal>[1];

export function getBaseOptions(editor: LexicalEditor, showModal: ShowModal) {
  return [
    new ComponentPickerOption('Paragraph', {
      icon: <i className="icon paragraph" />,
      keywords: ['normal', 'paragraph', 'p', 'text'],
      onSelect: () =>
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $setBlocksType(selection, () => $createParagraphNode());
          }
        }),
    }),
    ...([1, 2, 3] as const).map(
      n =>
        new ComponentPickerOption(`Heading ${n}`, {
          icon: <i className={`icon h${n}`} />,
          keywords: ['heading', 'header', `h${n}`],
          onSelect: () =>
            editor.update(() => {
              const selection = $getSelection();
              if ($isRangeSelection(selection)) {
                $setBlocksType(selection, () => $createHeadingNode(`h${n}`));
              }
            }),
        }),
    ),
    new ComponentPickerOption('Table', {
      icon: <i className="icon table" />,
      keywords: ['table', 'grid', 'spreadsheet', 'rows', 'columns'],
      onSelect: () =>
        showModal('Insert Table', onClose => (
          <InsertTableDialog activeEditor={editor} onClose={onClose} />
        )),
    }),
    new ComponentPickerOption('Numbered List', {
      icon: <i className="icon number" />,
      keywords: ['numbered list', 'ordered list', 'ol'],
      onSelect: () => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND),
    }),
    new ComponentPickerOption('Bulleted List', {
      icon: <i className="icon bullet" />,
      keywords: ['bulleted list', 'unordered list', 'ul'],
      onSelect: () => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND),
    }),
    new ComponentPickerOption('Check List', {
      icon: <i className="icon check" />,
      keywords: ['check list', 'todo list'],
      onSelect: () => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND),
    }),
    new ComponentPickerOption('Quote', {
      icon: <i className="icon quote" />,
      keywords: ['block quote'],
      onSelect: () =>
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $setBlocksType(selection, () => $createQuoteNode());
          }
        }),
    }),
    new ComponentPickerOption('Code', {
      icon: <i className="icon code" />,
      keywords: ['javascript', 'python', 'js', 'codeblock'],
      onSelect: () =>
        editor.update(() => {
          const selection = $getSelection();

          if ($isRangeSelection(selection)) {
            if (selection.isCollapsed()) {
              $setBlocksType(selection, () => $createCodeNode());
            } else {
              // Will this ever happen?
              const textContent = selection.getTextContent();
              const codeNode = $createCodeNode();
              selection.insertNodes([codeNode]);
              selection.insertRawText(textContent);
            }
          }
        }),
    }),
    new ComponentPickerOption('Divider', {
      icon: <i className="icon horizontal-rule" />,
      keywords: ['horizontal rule', 'divider', 'hr'],
      onSelect: () => editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND),
    }),
    new ComponentPickerOption('Page Break', {
      icon: <i className="icon page-break" />,
      keywords: ['page break', 'divider'],
      onSelect: () => editor.dispatchCommand(INSERT_PAGE_BREAK),
    }),
    new ComponentPickerOption('Excalidraw', {
      icon: <i className="icon diagram-2" />,
      keywords: ['excalidraw', 'diagram', 'drawing'],
      onSelect: () => editor.dispatchCommand(INSERT_EXCALIDRAW_COMMAND),
    }),
    new ComponentPickerOption('Poll', {
      icon: <i className="icon poll" />,
      keywords: ['poll', 'vote'],
      onSelect: () =>
        showModal('Insert Poll', onClose => (
          <InsertPollDialog activeEditor={editor} onClose={onClose} />
        )),
    }),
    ...EmbedConfigs.map(
      embedConfig =>
        new ComponentPickerOption(`Embed ${embedConfig.contentName}`, {
          icon: embedConfig.icon,
          keywords: [...embedConfig.keywords, 'embed'],
          onSelect: () =>
            editor.dispatchCommand(INSERT_EMBED_COMMAND, embedConfig.type),
        }),
    ),
    new ComponentPickerOption('Date', {
      icon: <i className="icon calendar" />,
      keywords: ['date', 'calendar', 'time'],
      onSelect: () => {
        const dateTime = new Date();
        dateTime.setHours(0, 0, 0, 0); // Set time to midnight
        editor.dispatchCommand(INSERT_DATETIME_COMMAND, {dateTime});
      },
    }),
    new ComponentPickerOption('Today', {
      icon: <i className="icon calendar" />,
      keywords: ['date', 'calendar', 'time', 'today'],
      onSelect: () => {
        const dateTime = new Date();
        dateTime.setHours(0, 0, 0, 0); // Set time to midnight
        editor.dispatchCommand(INSERT_DATETIME_COMMAND, {dateTime});
      },
    }),
    new ComponentPickerOption('Tomorrow', {
      icon: <i className="icon calendar" />,
      keywords: ['date', 'calendar', 'time', 'tomorrow'],
      onSelect: () => {
        const dateTime = new Date();
        dateTime.setDate(dateTime.getDate() + 1);
        dateTime.setHours(0, 0, 0, 0); // Set time to midnight
        editor.dispatchCommand(INSERT_DATETIME_COMMAND, {dateTime});
      },
    }),
    new ComponentPickerOption('Yesterday', {
      icon: <i className="icon calendar" />,
      keywords: ['date', 'calendar', 'time', 'yesterday'],
      onSelect: () => {
        const dateTime = new Date();
        dateTime.setDate(dateTime.getDate() - 1);
        dateTime.setHours(0, 0, 0, 0); // Set time to midnight
        editor.dispatchCommand(INSERT_DATETIME_COMMAND, {dateTime});
      },
    }),
    new ComponentPickerOption('Equation', {
      icon: <i className="icon equation" />,
      keywords: ['equation', 'latex', 'math'],
      onSelect: () =>
        showModal('Insert Equation', onClose => (
          <InsertEquationDialog activeEditor={editor} onClose={onClose} />
        )),
    }),
    new ComponentPickerOption('GIF', {
      icon: <i className="icon gif" />,
      keywords: ['gif', 'animate', 'image', 'file'],
      onSelect: () =>
        editor.dispatchCommand(INSERT_IMAGE_COMMAND, {
          altText: 'Cat typing on a laptop',
          src: catTypingGif,
        }),
    }),
    new ComponentPickerOption('Image', {
      icon: <i className="icon image" />,
      keywords: ['image', 'photo', 'picture', 'file'],
      onSelect: () =>
        showModal('Insert Image', onClose => (
          <InsertImageDialog activeEditor={editor} onClose={onClose} />
        )),
    }),
    new ComponentPickerOption('Collapsible', {
      icon: <i className="icon caret-right" />,
      keywords: ['collapse', 'collapsible', 'toggle'],
      onSelect: () => editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND),
    }),
    new ComponentPickerOption('Card', {
      icon: <i className="icon caret-right" />,
      keywords: ['card', 'slot', 'named slots'],
      onSelect: () => editor.dispatchCommand(INSERT_CARD_COMMAND),
    }),
    new ComponentPickerOption('Pull Quote', {
      icon: <i className="icon quote" />,
      keywords: ['pull quote', 'quote', 'attribution', 'cite', 'slot'],
      onSelect: () => editor.dispatchCommand(INSERT_PULLQUOTE_COMMAND),
    }),
    new ComponentPickerOption('Review', {
      icon: <i className="icon star" />,
      keywords: ['review', 'testimonial', 'rating', 'stars', 'react', 'slot'],
      onSelect: () => editor.dispatchCommand(INSERT_REVIEW_COMMAND),
    }),
    new ComponentPickerOption('Columns Layout', {
      icon: <i className="icon columns" />,
      keywords: ['columns', 'layout', 'grid'],
      onSelect: () =>
        showModal('Insert Columns Layout', onClose => (
          <InsertLayoutDialog activeEditor={editor} onClose={onClose} />
        )),
    }),
    ...(['left', 'center', 'right', 'justify'] as const).map(
      alignment =>
        new ComponentPickerOption(`Align ${alignment}`, {
          icon: <i className={`icon ${alignment}-align`} />,
          keywords: ['align', 'justify', alignment],
          onSelect: () =>
            editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, alignment),
        }),
    ),
  ];
}

export default function ComponentPickerMenuPlugin(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [modal, showModal] = useModal();
  const [queryString, setQueryString] = useState<string | null>(null);

  const checkForTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
    allowWhitespace: true,
    minLength: 0,
  });

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

  const onSelectOption = useCallback(
    (
      selectedOption: ComponentPickerOption,
      nodeToRemove: TextNode | null,
      closeMenu: () => void,
      matchingString: string,
    ) => {
      editor.update(() => {
        nodeToRemove?.remove();
        selectedOption.onSelect(matchingString);
        closeMenu();
      });
    },
    [editor],
  );

  return (
    <>
      {modal}
      <LexicalTypeaheadMenuPlugin<ComponentPickerOption>
        menuAriaLabel="Blocks"
        onQueryChange={setQueryString}
        onSelectOption={onSelectOption}
        triggerFn={checkForTriggerMatch}
        options={options}
      />
    </>
  );
}
