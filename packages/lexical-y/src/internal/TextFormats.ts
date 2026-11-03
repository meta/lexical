/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, LexicalBuilder} from '@lexical/extension';
import {
  $isTextNode,
  $parseSerializedNode,
  createEditor,
  type LexicalEditor,
  type LexicalNodeConfig,
  type SerializedLexicalNode,
  TEXT_TYPE_TO_FORMAT,
  TextNode,
} from 'lexical';

import {
  type Attrs,
  decodeFormatValue,
  FIELD_PREFIX,
  hasOwn,
  joinSetMembersInJSON,
  stableStringify,
  STATE_PREFIX,
  TEXT_FORMAT_PREFIX,
  textJSONFromAttrs,
  TYPE_KEY,
} from './Schema';

// Format bits stored on text that its node does not show. A code highlight
// node's setFormat ignores every bit, so a bit stored over part of one (a
// format written while the token was plain text, or a write from outside the
// editor) is shown nowhere: a reader does not set nodes apart by it (see
// Reader#$pieces), and the self-check does not expect it (see $checkWrite).
// Which bits a node shows is not a property of its class alone (a setter can
// keep some bits, depend on the node's fields, mode or NodeState, or come
// from a replacement), so it is read off the node the stored attributes
// describe, built in a scratch editor with the bound editor's nodes.

/** Per bound editor: its scratch editor and the format each signature shows. */
type Shown = {editor: LexicalEditor | null; formats: Map<string, number>};
const shownByEditor = new WeakMap<LexicalEditor, Shown>();

/** The format bit a stored key names (`f:bold`), or 0. */
export function formatBitOf(key: string): number {
  if (!key.startsWith(TEXT_FORMAT_PREFIX)) {
    return 0;
  }
  const name = key.slice(TEXT_FORMAT_PREFIX.length);
  return hasOwn(TEXT_TYPE_TO_FORMAT, name)
    ? TEXT_TYPE_TO_FORMAT[name as keyof typeof TEXT_TYPE_TO_FORMAT]
    : 0;
}

/** Every format bit: what a node shows when it cannot be built. */
const ALL_FORMATS = -1;

/**
 * Whether text of stored type `type` can show fewer format bits than it
 * stores: its class (or a replacement of it) has a setFormat of its own.
 */
function mayHideFormats(editor: LexicalEditor, type: unknown): boolean {
  const info = editor._nodes.get(typeof type === 'string' ? type : 'text');
  if (info === undefined || !(info.klass.prototype instanceof TextNode)) {
    // Read as plain text (see Reader#$readInline), which keeps every bit.
    return false;
  }
  const own = (klass: object) =>
    (klass as typeof TextNode).prototype.setFormat !==
    TextNode.prototype.setFormat;
  return (
    own(info.klass) ||
    (info.replace !== null &&
      (info.replaceWithKlass === null || own(info.replaceWithKlass)))
  );
}

/**
 * The format bits stored in `attrs` (a text piece's attributes, as stored)
 * that the node they describe does not show: 0 for a text class whose
 * setFormat is TextNode's, every stored bit for a code highlight. A node that
 * cannot be built shows every bit.
 */
export function hiddenTextFormats(editor: LexicalEditor, attrs: Attrs): number {
  const type = decodeFormatValue(attrs[TYPE_KEY] ?? null);
  if (!mayHideFormats(editor, type)) {
    return 0;
  }
  // What the node is built from (see textJSONFromAttrs): its type, fields,
  // NodeState and the format bits stored as set.
  const described: Attrs = {};
  let stored = 0;
  for (const k of Object.keys(attrs)) {
    const bit = formatBitOf(k);
    if (bit !== 0) {
      if (decodeFormatValue(attrs[k]) === true) {
        stored |= bit;
        described[k] = true;
      }
    } else if (
      k === TYPE_KEY ||
      k.startsWith(FIELD_PREFIX) ||
      k.startsWith(STATE_PREFIX)
    ) {
      described[k] = attrs[k];
    }
  }
  if (stored === 0) {
    return 0;
  }
  let shown = shownByEditor.get(editor);
  if (shown === undefined) {
    shown = {editor: null, formats: new Map()};
    shownByEditor.set(editor, shown);
  }
  const format = formatOf(editor, shown, described);
  const hidden = stored & ~format;
  if (hidden === 0) {
    return 0;
  }
  // Hidden only if the node shows the same without them (a setter can turn
  // a bit into another: such a bit is shown, as that other one).
  const without: Attrs = {};
  for (const k of Object.keys(described)) {
    if ((formatBitOf(k) & hidden) === 0) {
      without[k] = described[k];
    }
  }
  return formatOf(editor, shown, without) === format ? hidden : 0;
}

/** The format of the node `described` gives (cached per signature). */
function formatOf(editor: LexicalEditor, shown: Shown, described: Attrs) {
  const sig = stableStringify(described);
  let format = shown.formats.get(sig);
  if (format === undefined) {
    format = shownFormat(editor, shown, described);
    shown.formats.set(sig, format);
  }
  return format;
}

/** The format of the node `described` gives, built in the scratch editor. */
function shownFormat(
  editor: LexicalEditor,
  shown: Shown,
  described: Attrs,
): number {
  let format = ALL_FORMATS;
  try {
    const scratch = shown.editor || (shown.editor = scratchEditorFor(editor));
    const json = joinSetMembersInJSON(
      textJSONFromAttrs('x', described),
      editor,
    );
    scratch.update(
      () => {
        const node = $parseSerializedNode(
          json as unknown as SerializedLexicalNode,
        );
        if ($isTextNode(node)) {
          format = node.getFormat();
        }
      },
      {discrete: true},
    );
  } catch (_e) {
    format = ALL_FORMATS;
  }
  return format;
}

/**
 * A new editor with the bound editor's nodes, replacements and namespace,
 * built the way the bound editor was (see SelfCheck's freshEditorFor).
 * Nothing is attached to its root: the nodes built there are collected at
 * its commit.
 */
function scratchEditorFor(editor: LexicalEditor): LexicalEditor {
  const nodes: LexicalNodeConfig[] = [...editor._nodes.values()].map(info =>
    info.replace === null
      ? info.klass
      : {
          replace: info.klass,
          with: info.replace,
          ...(info.replaceWithKlass !== null
            ? {withKlass: info.replaceWithKlass}
            : {}),
        },
  );
  const onError = (e: Error) => {
    throw e;
  };
  const namespace = editor._config.namespace;
  if (LexicalBuilder.maybeFromEditor(editor) !== undefined) {
    return buildEditorFromExtensions({
      $initialEditorState: null,
      name: '@lexical/y/text-formats',
      namespace,
      nodes: () => nodes,
      onError,
    });
  }
  return createEditor({namespace, nodes, onError});
}
