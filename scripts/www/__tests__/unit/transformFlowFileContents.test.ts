/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {describe, expect, it} from 'vitest';

import transformFlowFileContents from '../../transformFlowFileContents';

const HEADER_BEFORE =
  `
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */
`.trim() + '\n';

const HEADER_AFTER =
  `
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 * @generated
 * @oncall lexical_web_text_editor
 */
`.trim() + '\n';

const IMPORTS_BEFORE =
  `
import type {Doc, RelativePosition, UndoManager, XmlText} from 'yjs';
import type {
  DecoratorNode,
  EditorState,
  ElementNode,
  LexicalCommand,
  LexicalEditor,
  LexicalNode,
  LineBreakNode,
  NodeMap,
  NodeKey,
  TextNode,
} from 'lexical';
export type {YEvent} from 'yjs';
export type {AnyLexicalExtension, AnyLexicalExtensionArgument} from 'lexical';
export {configExtension, defineExtension} from 'lexical';
`.trim() + '\n';

const IMPORTS_AFTER =
  `
import type {Doc, RelativePosition, UndoManager, XmlText} from 'yjs';
import type {
  DecoratorNode,
  EditorState,
  ElementNode,
  LexicalCommand,
  LexicalEditor,
  LexicalNode,
  LineBreakNode,
  NodeMap,
  NodeKey,
  TextNode,
} from 'Lexical';
export type {YEvent} from 'yjs';
export type {AnyLexicalExtension, AnyLexicalExtensionArgument} from 'Lexical';
export {configExtension, defineExtension} from 'Lexical';
`.trim() + '\n';

const EXTRA_BLOCK_COMMENT =
  `
/**
 * LexicalDevToolsCore
 */
`.trim() + '\n';

// Modern Flow variance syntax must survive the transform verbatim. The www
// copies are checked by Flow, which rejects the legacy `+`/`-` sigils with
// "The `-` variance sigil is deprecated. Use `writeonly` instead."
const VARIANCE =
  `
export interface InlineFormattableNode {
  readonly __isInlineFormattable: true;
}
declare export class DOMSlot<out T extends HTMLElement> {
  readonly element: T;
  readonly before: Node | null;
}
export type ContextRecord = {readonly [string | symbol]: unknown};
declare export function $setState<in T>(value: T): void;
`.trim() + '\n';

describe('transformFlowFileContents', () => {
  [
    {
      input: [HEADER_BEFORE, IMPORTS_BEFORE, EXTRA_BLOCK_COMMENT].join('\n'),
      output: [HEADER_AFTER, IMPORTS_AFTER, EXTRA_BLOCK_COMMENT].join('\n'),
      title: 'header-imports-comment',
    },
    {
      input: [HEADER_BEFORE, EXTRA_BLOCK_COMMENT].join('\n'),
      output: [HEADER_AFTER, EXTRA_BLOCK_COMMENT].join('\n'),
      title: 'header-comment',
    },
    {
      input: [HEADER_BEFORE, IMPORTS_BEFORE].join('\n'),
      output: [HEADER_AFTER, IMPORTS_AFTER].join('\n'),
      title: 'header-imports',
    },
    {
      input: [HEADER_BEFORE].join('\n'),
      output: [HEADER_AFTER].join('\n'),
      title: 'header',
    },
    {
      input: [HEADER_BEFORE, VARIANCE].join('\n'),
      output: [HEADER_AFTER, VARIANCE].join('\n'),
      title: 'variance keywords',
    },
  ].forEach(({input, output, title}) => {
    it(`transforms ${title}`, async () => {
      expect(await transformFlowFileContents(input)).toBe(output);
    });
  });
});
