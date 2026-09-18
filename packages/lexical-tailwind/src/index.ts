/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  declarePeerDependency,
  defineExtension,
  type EditorThemeClasses,
} from 'lexical';

function join(...args: string[]) {
  return args.join(' ');
}

const checklistItemCommonClasses =
  // This [&]: is necessary to override the mx-8 from listitem since the theme is not designed for tailwind semantics (both sets of classes are applied)
  join(
    'relative [&]:mx-[0.5em] px-[1.5em] list-none outline-none block min-h-[1.5em]',
    'before:w-4 before:h-4 before:top-0.5 before:left-0 before:cursor-pointer before:block before:bg-color before:absolute before:border before:border-solid before:rounded-sm',
    'rtl:before:left-auto rtl:before:right-0',
    'focus:before:shadow-[0_0_0_2px_#a6cdfe]',
  );

const listCommonClasses = 'p-0 m-0 list-outside';

const theme: EditorThemeClasses = {
  // TODO animation
  blockCursor: join(
    'block pointer-events-none absolute',
    'after:block after:absolute after:-top-0.5 after:width-5 after:border-t after:border-solid after:border-black after:animate-lexical-cursor-blink',
  ),
  // characterLimit: "PlaygroundEditorTheme__characterLimit",
  // code: 'PlaygroundEditorTheme__code',
  // codeHighlight: {
  //   atrule: 'PlaygroundEditorTheme__tokenAttr',
  //   attr: 'PlaygroundEditorTheme__tokenAttr',
  //   boolean: 'PlaygroundEditorTheme__tokenProperty',
  //   builtin: 'PlaygroundEditorTheme__tokenSelector',
  //   cdata: 'PlaygroundEditorTheme__tokenComment',
  //   char: 'PlaygroundEditorTheme__tokenSelector',
  //   class: 'PlaygroundEditorTheme__tokenFunction',
  //   'class-name': 'PlaygroundEditorTheme__tokenFunction',
  //   comment: 'PlaygroundEditorTheme__tokenComment',
  //   constant: 'PlaygroundEditorTheme__tokenProperty',
  //   deleted: 'PlaygroundEditorTheme__tokenProperty',
  //   doctype: 'PlaygroundEditorTheme__tokenComment',
  //   entity: 'PlaygroundEditorTheme__tokenOperator',
  //   function: 'PlaygroundEditorTheme__tokenFunction',
  //   important: 'PlaygroundEditorTheme__tokenVariable',
  //   inserted: 'PlaygroundEditorTheme__tokenSelector',
  //   keyword: 'PlaygroundEditorTheme__tokenAttr',
  //   namespace: 'PlaygroundEditorTheme__tokenVariable',
  //   number: 'PlaygroundEditorTheme__tokenProperty',
  //   operator: 'PlaygroundEditorTheme__tokenOperator',
  //   prolog: 'PlaygroundEditorTheme__tokenComment',
  //   property: 'PlaygroundEditorTheme__tokenProperty',
  //   punctuation: 'PlaygroundEditorTheme__tokenPunctuation',
  //   regex: 'PlaygroundEditorTheme__tokenVariable',
  //   selector: 'PlaygroundEditorTheme__tokenSelector',
  //   string: 'PlaygroundEditorTheme__tokenSelector',
  //   symbol: 'PlaygroundEditorTheme__tokenProperty',
  //   tag: 'PlaygroundEditorTheme__tokenProperty',
  //   url: 'PlaygroundEditorTheme__tokenOperator',
  //   variable: 'PlaygroundEditorTheme__tokenVariable',
  // },
  // embedBlock: {
  //   base: 'PlaygroundEditorTheme__embedBlock',
  //   focus: 'PlaygroundEditorTheme__embedBlockFocus',
  // },
  // hashtag: 'PlaygroundEditorTheme__hashtag',
  heading: {
    h1: 'text-[24px] text-neutral-950 font-normal m-0',
    h2: 'text-[15px] text-gray-500 font-bold m-0 uppercase',
    h3: 'text-[12px] m-0 uppercase',
    h4: undefined,
    h5: undefined,
    h6: undefined,
  },
  hr: join(
    'p-0.5 border-none mx-0 my-[1em] cursor-pointer',
    `after:block after:content-[''] after:h-[2px] after:leading-[2px] after:bg-[#ccc]`,
  ),
  hrSelected: 'outline-[2px] outline-solid outline-[rgb(60,132,244)]',
  // image: 'editor-image',
  // inlineImage: 'inline-editor-image',
  // layoutContainer: 'PlaygroundEditorTheme__layoutContainer',
  // layoutItem: 'PlaygroundEditorTheme__layoutItem',
  link: join('text-blue-600', 'hover:underline hover:cursor-pointer'),
  list: {
    checklist: '',
    listitem: join(
      'mx-8 my-0',
      'font-(family-name:--listitem-marker-font-family) text-(length:--listitem-marker-font-size) bg-(--listitem-marker-background-color)',
      'marker:text-(--listitem-marker-color) marker:font-(family-name:--listitem-marker-font-family) marker:text-(length:--listitem-marker-font-size) marker:bg-(--listitem-marker-background-color)',
    ),
    // TODO fix up checked/unchecked
    listitemChecked: join(
      checklistItemCommonClasses,
      'line-through',
      'before:border-[rgb(61,135,245)] before:bg-[#3d87f5] before:bg-no-repeat',
      'after:cursor-pointer after:border-white after:border-solid after:absolute after:block after:top-1.5 after:width-[3px] after:inset-x-[7px] after:height-1.5 after:rotate-45 after:border-t-0 after:border-r-0.5 after:border-b-0.5 after:border-l-0',
    ),
    listitemUnchecked: join(checklistItemCommonClasses, 'before:border-[#999]'),
    nested: {
      listitem: join('list-none', 'before:hidden', 'after:hidden'),
    },
    olDepth: [
      'list-decimal',
      'list-[upper-alpha]',
      'list-[lower-alpha]',
      'list-[upper-roman]',
      'list-[lower-roman]',
    ].map(cls => join(listCommonClasses, cls)),
    ul: join(listCommonClasses, 'list-disc'),
  },
  // mark: 'PlaygroundEditorTheme__mark',
  // markOverlap: 'PlaygroundEditorTheme__markOverlap',
  paragraph: 'relative m-0',
  quote:
    'm-0 ml-5 mb-2.5 text-[15px] text-gray-500 border-slate-300 border-l-4 border-solid pl-4',
  // tab: 'PlaygroundEditorTheme__tabNode',
  table:
    'border-collapse border-spacing-0 overflow-scroll table-fixed w-max mt-0 mr-[25px] mb-[30px] ml-0',
  tableCell:
    'border border-solid border-[#bbb] w-[75px] min-w-[75px] align-top text-start py-[6px] px-2 relative outline-none',
  tableCellEditing: 'shadow-[0_0_5px_rgba(0,0,0,0.4)] rounded-[3px]',
  tableCellHeader: 'bg-[#f2f3f5] text-start',
  tableSelection: 'selection:bg-transparent',
  // tableAddColumns: 'absolute bg-[#eee] h-full border-0 cursor-pointer animate-lexical-table-controls',
  // tableAddRows: 'PlaygroundEditorTheme__tableAddRows',
  // tableAlignment: {
  //   center: 'PlaygroundEditorTheme__tableAlignmentCenter',
  //   right: 'PlaygroundEditorTheme__tableAlignmentRight',
  // },
  // tableCellActionButton: 'PlaygroundEditorTheme__tableCellActionButton',
  // tableCellActionButtonContainer:
  //   'PlaygroundEditorTheme__tableCellActionButtonContainer',
  // tableCellPrimarySelected: 'PlaygroundEditorTheme__tableCellPrimarySelected',
  // tableCellResizer: 'PlaygroundEditorTheme__tableCellResizer',
  // tableCellSelected: 'PlaygroundEditorTheme__tableCellSelected',
  // tableFrozenColumn: 'PlaygroundEditorTheme__tableFrozenColumn',
  // tableFrozenRow: 'PlaygroundEditorTheme__tableFrozenRow',
  // tableRowStriping: 'PlaygroundEditorTheme__tableRowStriping',
  // tableScrollableWrapper: 'PlaygroundEditorTheme__tableScrollableWrapper',
  // tableCellSortedIndicator: 'PlaygroundEditorTheme__tableCellSortedIndicator',
  // tableResizeRuler: 'PlaygroundEditorTheme__tableCellResizeRuler',
  // tableSelected: 'PlaygroundEditorTheme__tableSelected',
  // tableSelection: 'PlaygroundEditorTheme__tableSelection',
  text: {
    bold: 'font-bold',
    capitalize: 'capitalize',
    code: 'font-mono text-[94%] py-px px-1 background-color: bg-slate-100',
    highlight:
      'bg-[rgba(255,212,0,0.14)] border-solid border-b-[2px] border-[rgba(255,212,0,0.3)]',
    italic: 'italic',
    lowercase: 'lowercase',
    strikethrough: 'line-through',
    subscript: 'text-[0.8em] !align-sub',
    superscript: 'text-[0.8em] align-super',
    underline: 'underline',
    underlineStrikethrough: '[text-decoration:underline_line-through]',
    uppercase: 'uppercase',
  },
};

/**
 * Configures the lexical theme ({@link EditorThemeClasses}) with tailwind defaults
 */
export const TailwindExtension = defineExtension({
  name: '@lexical/tailwind',
  peerDependencies: [
    declarePeerDependency('@lexical/react/TreeView', {
      timeTravelButtonClassName:
        'absolute top-[10px] right-[15px] border-0 p-0 text-xs bg-transparent text-white hover:underline cursor-pointer',
      timeTravelPanelButtonClassName:
        'p-0 border-0 bg-transparent flex-1 text-white text-xs hover:underline cursor-pointer',
      timeTravelPanelClassName: 'overflow-hidden p-0 pb-2.5 mx-auto flex',
      timeTravelPanelSliderClassName: 'p-0 flex-[8]',
      treeTypeButtonClassName:
        'absolute top-[10px] right-[85px] border-0 p-0 text-xs bg-transparent text-white hover:underline cursor-pointer',
      viewClassName:
        'block bg-neutral-950 text-white p-1.5 text-xs whitespace-pre-wrap mx-auto my-1 mb-2.5 max-h-[250px] relative rounded-b-[10px] overflow-auto leading-3.5',
    }),
  ],
  theme,
});
