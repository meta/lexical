/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Leftovers (`@lexical/y/offline`, D134): the blocks of a report a replay
// cannot apply (both sides changed them, the block is gone, there is no
// base or no ids). A replay never drops them: it writes them into the
// document through the app's `wrap`, in the update that replays the rest,
// or hands them to the app's `handle`. This file holds the types of that
// choice, the one run-time check of it, the default wrapper, and the checks
// of a wrapper's output. The editor update itself is in OfflineSession.

import {blockIdState} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getState,
  $isDecoratorNode,
  $isElementNode,
  $parseSerializedNode,
  getRegisteredNode,
  type LexicalEditor,
  type LexicalNode,
  type SerializedLexicalNode,
} from 'lexical';

import {
  type YUnsyncedBlock,
  type YUnsyncedReason,
  type YUnsyncedReport,
} from '../headless';

/**
 * @experimental A leftover block with content: one the user added or
 * changed that the replay cannot apply. `yours` is the block as they had it.
 */
export type YLeftoverBlock = YUnsyncedBlock & {
  readonly yours: SerializedLexicalNode;
};

/** @experimental Where {@link YLeftoversWrapped.wrap}'s output is written. */
export type YLeftoversPlacement = 'after-block' | 'top';

/** @experimental What a {@link YLeftoversWrap} is told about one call. */
export interface YLeftoversContext {
  readonly placement: YLeftoversPlacement;
  /**
   * The id of the top-level block the output is written after; null when it
   * is written at the top of the document (`'top'`, or no block of the
   * user's before these is left).
   */
  readonly after: string | null;
  /** When the edits were captured (Unix ms). */
  readonly capturedAt: number;
  /** Why the edits did not sync. */
  readonly reason: YUnsyncedReason;
  /** Whether the editor has a node of this type (`'quote'`, `'heading'`). */
  hasNode(type: string): boolean;
}

/**
 * @experimental Turns leftover blocks into the top-level blocks written
 * into the document, as serialized nodes (for example one collapsible
 * "Offline edits that didn't merge" node of your app around them). It is
 * called once per place: with `'after-block'`, once for the blocks that go
 * after the same block; with `'top'`, once.
 *
 * The output must hold every block it was given, in the order given, each
 * as a node of its own: one whose text is exactly the block's (its `yours`,
 * or another node around the same text: a paragraph may become a quote),
 * or, for a block without text, its `yours` as it is. Named slots count as
 * children. It must use node types the editor has, and each top-level node
 * must be a block.
 * Output that fails any of that is not written: the blocks are written as
 * they are instead, and the result says why (`fallback`). Block ids in the
 * output are ignored: every block written gets a new one.
 */
export type YLeftoversWrap = (
  blocks: readonly YLeftoverBlock[],
  context: YLeftoversContext,
) => readonly SerializedLexicalNode[];

/**
 * @experimental Takes the blocks a replay did not apply (see
 * {@link YLeftoversHandled}).
 */
export type YLeftoversHandle = (
  blocks: readonly YUnsyncedBlock[],
  context: {
    /** The report the blocks are from (a `YOfflineReport` in a recovery). */
    readonly report: YUnsyncedReport;
    /** The stored capture's id, in `recoverYOfflineEdits`; else null. */
    readonly captureId: string | null;
  },
) => void;

/**
 * @experimental Write the blocks that cannot be replayed into the document,
 * through `wrap`, in the update that replays the rest (one undo step).
 * `wrapLeftoversAsQuote('Offline edits that did not merge')` is a ready
 * `wrap`.
 */
export interface YLeftoversWrapped {
  readonly wrap: YLeftoversWrap;
  /**
   * `'after-block'` (the default): after the block of the same id; when it
   * is gone, after the nearest block before it in the user's document that
   * is left (a nested one counts as the top-level block it is in), else at
   * the top. `'top'`: all of them at the top of the document, in one call
   * of `wrap`.
   * @defaultValue `'after-block'`
   */
  readonly placement?: YLeftoversPlacement;
  readonly handle?: never;
}

/**
 * @experimental Take the blocks that cannot be replayed yourself: nothing
 * of them is written, `handle` is called with them, and a stored capture
 * stays until your app deletes it (`store.deleteCapture`). Show them to
 * the user (an Offline edits panel): this is the only place they go.
 */
export interface YLeftoversHandled {
  readonly handle: YLeftoversHandle;
  readonly wrap?: never;
  readonly placement?: never;
}

/**
 * @experimental What a replay does with the blocks it cannot apply. There
 * is no default, so they cannot be forgotten: pass
 * `leftovers: {wrap: wrapLeftoversAsQuote('…')}` to write them into the
 * document, or `leftovers: {handle: blocks => …}` to take them yourself.
 */
export type YLeftovers = YLeftoversWrapped | YLeftoversHandled;

/**
 * @experimental The required `leftovers` of `replayUnsyncedEdits` and
 * `recoverYOfflineEdits`. A call without it does not compile, and the
 * compiler names this type: pass
 * `leftovers: {wrap: wrapLeftoversAsQuote('…')}` or
 * `leftovers: {handle: blocks => …}`.
 */
export interface YLeftoversRequiredPassWrapOrHandle {
  /**
   * What to do with the blocks that cannot be replayed: pass
   * `leftovers: {wrap: wrapLeftoversAsQuote('…')}` (write them into the
   * document) or `leftovers: {handle: blocks => …}` (take them yourself).
   */
  readonly leftovers: YLeftovers;
}

/**
 * @experimental Which blocks a replay writes over the document by itself.
 *
 * - `'replayable'`: every replayable block (one only the user changed),
 *   as it is; the rest go to `leftovers`.
 * - `'none'`: no block is replayed; every block the user added or changed
 *   goes to `leftovers` (a block they deleted stays, listed in
 *   `notApplied`).
 * - `{maxBaseAge}`: `'replayable'` when the copy the edits were made on is
 *   at most `maxBaseAge` milliseconds old (the report's `baseAt`), else
 *   `'none'`. A report whose `baseAt` is unknown (a capture of an earlier
 *   release, a report built by `describeUnsyncedEdits`) counts as older.
 *   The longer a copy was apart from the document, the more a replay of
 *   it can undo what happened since without anything to show for it.
 */
export type YAutoReplay = 'replayable' | 'none' | {readonly maxBaseAge: number};

/**
 * @experimental The required `autoReplay` of `replayUnsyncedEdits` and
 * `recoverYOfflineEdits`. A call without it does not compile, and the
 * compiler names this type: pass `autoReplay: 'replayable'`,
 * `autoReplay: 'none'`, or `autoReplay: {maxBaseAge: 3 * 24 * 3600 * 1000}`.
 */
export interface YAutoReplayRequiredPassReplayableNoneOrMaxBaseAge {
  /**
   * Which blocks are written over the document by themselves:
   * `'replayable'`, `'none'` (all to `leftovers`), or `{maxBaseAge}` (ms:
   * `'none'` for an older copy). See {@link YAutoReplay}.
   */
  readonly autoReplay: YAutoReplay;
}

/**
 * The run-time check of `autoReplay`, beside `requireLeftovers`: a
 * JavaScript caller that passes none would otherwise get a policy it did
 * not choose (replaying a copy days old is the risk it guards). Called
 * before anything is read or written.
 */
export function requireAutoReplay(
  entry: string,
  input: unknown,
): asserts input is YAutoReplayRequiredPassReplayableNoneOrMaxBaseAge {
  const autoReplay =
    typeof input === 'object' && input !== null
      ? (input as {autoReplay?: unknown}).autoReplay
      : undefined;
  if (
    autoReplay === 'replayable' ||
    autoReplay === 'none' ||
    (typeof autoReplay === 'object' &&
      autoReplay !== null &&
      typeof (autoReplay as {maxBaseAge?: unknown}).maxBaseAge === 'number' &&
      (autoReplay as {maxBaseAge: number}).maxBaseAge >= 0)
  ) {
    return;
  }
  throw new TypeError(
    `@lexical/y/offline: ${entry} needs autoReplay (got ${
      autoReplay === null
        ? 'null'
        : (JSON.stringify(autoReplay) ?? typeof autoReplay)
    }): pass autoReplay: 'replayable' (replay every block only the user changed), 'none' (send every block to leftovers) or {maxBaseAge: <milliseconds>} (replay only a copy at most that old, for example {maxBaseAge: 3 * 24 * 3600 * 1000}). Nothing was read or written.`,
  );
}

/** Whether `autoReplay` replays a report whose base is `baseAt` old at `now`. */
export function autoReplays(
  autoReplay: YAutoReplay,
  baseAt: number | null,
  now: number,
): boolean {
  if (typeof autoReplay === 'string') {
    return autoReplay === 'replayable';
  }
  return baseAt !== null && now - baseAt <= autoReplay.maxBaseAge;
}

/** @experimental One place a replay wrote leftover blocks at. */
export interface YLeftoversInserted {
  /** The report's ids of the blocks written here, in the order given to `wrap`. */
  readonly blocks: readonly string[];
  /**
   * The new ids of the top-level blocks written, in document order
   * (`'#<index>'`, their positions, in an editor without block ids).
   */
  readonly inserted: readonly string[];
  /** The id of the block they were written after; null: at the top. */
  readonly after: string | null;
  /**
   * Null when `wrap`'s output was written. Otherwise why it was not (the
   * fix is in the text): the blocks were written as they are instead.
   */
  readonly fallback: string | null;
}

/**
 * The one run-time check of `leftovers`: a JavaScript caller (or a cast)
 * that passes none, or a malformed one, would otherwise drop the blocks
 * silently. Called before anything is read or written.
 */
export function requireLeftovers(
  entry: string,
  input: unknown,
): asserts input is YLeftoversRequiredPassWrapOrHandle {
  const fix =
    "pass leftovers: {wrap: wrapLeftoversAsQuote('Offline edits that did not merge')} to write the blocks that cannot be replayed into the document (wrapLeftoversAsQuote is exported from @lexical/y/offline), or leftovers: {handle: blocks => showInYourPanel(blocks)} to take them yourself. Nothing was read or written.";
  const leftovers =
    typeof input === 'object' && input !== null
      ? (input as {leftovers?: unknown}).leftovers
      : undefined;
  if (typeof leftovers !== 'object' || leftovers === null) {
    throw new TypeError(
      `@lexical/y/offline: ${entry} needs leftovers (got ${
        leftovers === null ? 'null' : typeof leftovers
      }): ${fix}`,
    );
  }
  const {handle, placement, wrap} = leftovers as {
    handle?: unknown;
    placement?: unknown;
    wrap?: unknown;
  };
  const hasWrap = wrap !== undefined;
  const hasHandle = handle !== undefined;
  if (hasWrap === hasHandle) {
    throw new TypeError(
      `@lexical/y/offline: ${entry}'s leftovers needs ${
        hasWrap ? 'one of wrap and handle, not both' : 'wrap or handle'
      }: ${fix}`,
    );
  }
  if (typeof (hasWrap ? wrap : handle) !== 'function') {
    throw new TypeError(
      `@lexical/y/offline: ${entry}'s leftovers.${
        hasWrap ? 'wrap' : 'handle'
      } is not a function (got ${typeof (hasWrap ? wrap : handle)}): ${fix}`,
    );
  }
  if (
    placement !== undefined &&
    (hasHandle || (placement !== 'after-block' && placement !== 'top'))
  ) {
    throw new TypeError(
      `@lexical/y/offline: ${entry}'s leftovers.placement is ${
        hasHandle
          ? 'only for wrap (a handler writes nothing)'
          : `'after-block' (the default) or 'top'; got ${String(placement)}`
      }: ${fix}`,
    );
  }
}

type Json = {readonly [key: string]: unknown};

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A copy of `node` without block ids, at any depth (new ones are minted). */
export function withoutBlockIds<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map(withoutBlockIds) as T;
  }
  if (!isRecord(node)) {
    return node;
  }
  const copy: {[key: string]: unknown} = {};
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (key === '$' && isRecord(value)) {
      const state: {[key: string]: unknown} = {};
      for (const name of Object.keys(value)) {
        if (name !== 'blockId') {
          state[name] = withoutBlockIds(value[name]);
        }
      }
      if (Object.keys(state).length > 0) {
        copy.$ = state;
      }
    } else {
      copy[key] = withoutBlockIds(value);
    }
  }
  return copy as T;
}

/**
 * The nodes directly under a serialized `node`, in document order: its
 * named slots' values (`$slots`, in key order: a host's slots come before
 * its children), then its children. A wrapper may put the blocks in a
 * decorator's slot (a collapsible whose body is a slot).
 */
function nodesUnder(node: Json): unknown[] {
  const under: unknown[] = [];
  if (isRecord(node.$slots)) {
    for (const name of Object.keys(node.$slots)) {
      under.push(node.$slots[name]);
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      under.push(child);
    }
  }
  return under;
}

/** The text of every text node under `node`, in document order. */
export function textsOf(node: unknown, into: string[] = []): string[] {
  if (isRecord(node)) {
    if (typeof node.text === 'string' && node.text !== '') {
      into.push(node.text);
    }
    for (const child of nodesUnder(node)) {
      textsOf(child, into);
    }
  }
  return into;
}

/** A node of a wrapper's output, as the check reads it. */
interface OutputNode {
  /** The node as JSON (block ids removed). */
  readonly json: string;
  /** The text of every text node under it, joined. */
  readonly text: string;
  /** It holds nodes (children or slots): a block's text can be its own. */
  readonly holds: boolean;
  /** What it holds (its slots' values, then its children), as JSON. */
  readonly inside: string;
  /** The index after its last descendant, in `outline`'s order. */
  end: number;
}

/** Every node under `nodes`, in document order (a node before its own). */
function outline(nodes: readonly unknown[], into: OutputNode[]): OutputNode[] {
  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }
    const entry: OutputNode = {
      end: 0,
      holds: Array.isArray(node.children) || isRecord(node.$slots),
      inside: JSON.stringify(nodesUnder(node)),
      json: JSON.stringify(node),
      text: textsOf(node).join(''),
    };
    into.push(entry);
    outline(nodesUnder(node), into);
    entry.end = into.length;
  }
  return into;
}

/** The first node type under `node` the editor has not registered, or null. */
function unregisteredType(editor: LexicalEditor, node: unknown): string | null {
  if (!isRecord(node)) {
    return 'a value that is not a serialized node';
  }
  if (typeof node.type !== 'string') {
    return 'a node without a type';
  }
  if (getRegisteredNode(editor, node.type) === undefined) {
    return `'${node.type}'`;
  }
  if (node.children !== undefined && !Array.isArray(node.children)) {
    return `a '${node.type}' whose children is not an array`;
  }
  if (node.$slots !== undefined && !isRecord(node.$slots)) {
    return `a '${node.type}' whose $slots is not an object of nodes`;
  }
  for (const child of nodesUnder(node)) {
    const found = unregisteredType(editor, child);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

const $isTopLevelBlock = (node: LexicalNode): boolean =>
  ($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline();

const idOfBlock = (block: YUnsyncedBlock) => `block ${block.id}`;

/**
 * Why `output` (a wrapper's) cannot be written, or null: checked against
 * the editor's registered nodes and the blocks it was given, before any of
 * it is parsed.
 */
export function refuseWrapped(
  editor: LexicalEditor,
  blocks: readonly YLeftoverBlock[],
  output: unknown,
): string | null {
  if (!Array.isArray(output)) {
    return `leftovers.wrap returned ${
      output === null ? 'null' : typeof output
    }; return an array of serialized top-level blocks (node.exportJSON() shapes).`;
  }
  for (const node of output) {
    const missing = unregisteredType(editor, node);
    if (missing !== null) {
      return `leftovers.wrap returned ${missing}, which is not a node type this editor has; register the node (its extension) in the editor, or use only types it has (context.hasNode(type) tells).`;
    }
  }
  // Every block given, in order, each as a node of its own, after the
  // previous block's node and outside it: a block with text as a node that
  // holds exactly its text (so a paragraph may become a quote, but its text
  // cannot be found in a label or split across nodes), a block without text
  // as itself. Two equal blocks need two nodes.
  const nodes = outline(withoutBlockIds(output), []);
  let next = 0;
  for (const block of blocks) {
    const clean = withoutBlockIds(block.yours);
    const text = textsOf(clean).join('');
    const json = JSON.stringify(clean);
    // What the block holds, exactly: its text with its formats, its inline
    // nodes without text (an equation, a mention, a line break), its slots.
    // A wrapper may change the node around them (a paragraph into a
    // quote), not them.
    const inside = isRecord(clean) ? JSON.stringify(nodesUnder(clean)) : '';
    let at = next;
    while (
      at < nodes.length &&
      !(text === ''
        ? nodes[at].json === json
        : nodes[at].holds &&
          nodes[at].text === text &&
          nodes[at].inside === inside)
    ) {
      at++;
    }
    if (at === nodes.length) {
      return text === ''
        ? `leftovers.wrap's output does not hold ${idOfBlock(
            block,
          )} (a ${block.yours.type} without text, after the one before it); put each block.yours in the output as it is, in the order given.`
        : `leftovers.wrap's output does not hold the text of ${idOfBlock(
            block,
          )} as a node of its own (one that holds exactly what the block holds: its text, formats and inline nodes, after the one before it); keep every block it is given, in the order given (block.yours as it is, or a node of yours around its children, as wrapLeftoversAsQuote's quote).`;
    }
    next = nodes[at].end;
  }
  return null;
}

/**
 * Parse a wrapper's checked output into nodes (in an editor update); a
 * string says why it cannot be written.
 */
export function $parseWrapped(
  output: readonly SerializedLexicalNode[],
): LexicalNode[] | string {
  const nodes: LexicalNode[] = [];
  for (const json of withoutBlockIds(output)) {
    let node: LexicalNode;
    try {
      node = $parseSerializedNode(json);
    } catch (error) {
      return `leftovers.wrap's output does not parse with this editor's nodes (${String(
        error,
      )}); return what node.exportJSON() returns for each node.`;
    }
    if (!$isTopLevelBlock(node)) {
      return `leftovers.wrap returned a top-level '${json.type}', which is not a block; return block nodes (paragraphs, or your container), with text and inline nodes inside them.`;
    }
    nodes.push(node);
  }
  return nodes;
}

/**
 * A leftover block as a node, without a wrapper: the block as the user had
 * it, or, when the editor cannot build it (a node type it lacks), a
 * paragraph of its text. Never nothing.
 */
export function $rawLeftover(
  editor: LexicalEditor,
  block: YLeftoverBlock,
): LexicalNode {
  const json = withoutBlockIds(block.yours);
  if (unregisteredType(editor, json) === null) {
    try {
      const node = $parseSerializedNode(json);
      if ($isTopLevelBlock(node)) {
        return node;
      }
    } catch {
      // Its text, below.
    }
  }
  return $createParagraphNode().append($createTextNode(plainText(block.yours)));
}

/**
 * A block's text as one line: the text of each node that holds nodes (a
 * list item, a cell) separated by a space, so list items `a` and `b` read
 * `a b`, not `ab`.
 */
function plainText(node: unknown): string {
  if (!isRecord(node)) {
    return '';
  }
  if (typeof node.text === 'string') {
    return node.text;
  }
  const parts: string[] = [];
  let run = '';
  for (const child of nodesUnder(node)) {
    if (
      isRecord(child) &&
      (Array.isArray(child.children) || isRecord(child.$slots))
    ) {
      if (run !== '') {
        parts.push(run);
        run = '';
      }
      parts.push(plainText(child));
    } else {
      run += plainText(child);
    }
  }
  if (run !== '') {
    parts.push(run);
  }
  return parts.filter(part => part !== '').join(' ');
}

/** The block id a live node stores, or null. */
export function $storedBlockId(node: LexicalNode): string | null {
  const id: unknown = $getState(node, blockIdState);
  return typeof id === 'string' && id !== '' ? id : null;
}

const BOLD = 1;

/**
 * @experimental A ready {@link YLeftoversWrap}: a paragraph with `label` in
 * bold, then each block the user had. A paragraph with text becomes a
 * quote where the editor has quotes (`@lexical/rich-text`); every other
 * block (a heading, a list, a table, an empty paragraph), and a paragraph
 * where it has none, stays as it was. It needs only the paragraph and text nodes every editor has.
 *
 * `label` may be a function of the call's context, to name the time or the
 * place:
 *
 * @example
 * ```ts
 * recoverYOfflineEdits({
 *   // ...
 *   leftovers: {
 *     wrap: wrapLeftoversAsQuote(
 *       ({capturedAt}) =>
 *         `Offline edits that did not merge · ${new Date(capturedAt).toLocaleString()}`,
 *     ),
 *   },
 * });
 * ```
 */
export function wrapLeftoversAsQuote(
  label: string | ((context: YLeftoversContext) => string),
): YLeftoversWrap {
  return (blocks, context) => {
    const quotes = context.hasNode('quote');
    const title = {
      children: [
        {
          detail: 0,
          format: BOLD,
          mode: 'normal',
          style: '',
          text: typeof label === 'function' ? label(context) : label,
          type: 'text',
          version: 1,
        },
      ],
      direction: null,
      format: '',
      indent: 0,
      textFormat: BOLD,
      textStyle: '',
      type: 'paragraph',
      version: 1,
    };
    return [
      title,
      ...blocks.map(({yours}): SerializedLexicalNode => {
        // A block without text (an empty paragraph, a horizontal rule) stays
        // as it is: only as itself can it be told to be in the output.
        if (
          !quotes ||
          yours.type !== 'paragraph' ||
          textsOf(yours).length === 0
        ) {
          return yours;
        }
        // The paragraph's own fields carried over: its NodeState (`$`, of
        // which the block id is minted anew) and its text format and style.
        const {$, children, direction, format, indent, textFormat, textStyle} =
          yours as Json;
        return {
          ...($ !== undefined ? {$} : null),
          children: Array.isArray(children) ? children : [],
          direction: direction ?? null,
          format: format ?? '',
          indent: indent ?? 0,
          ...(textFormat !== undefined ? {textFormat} : null),
          ...(textStyle !== undefined ? {textStyle} : null),
          type: 'quote',
          version: 1,
        } as SerializedLexicalNode;
      }),
    ];
  };
}
