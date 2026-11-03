/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  $createTextNode,
  $getSelection,
  $getWritableNodeState,
  $isRangeSelection,
  $isTextNode,
  type EditorState,
  INTERNAL_$recordTextMove,
  INTERNAL_$recordTextRetype,
  INTERNAL_getActiveEditorState,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  TextNode,
} from 'lexical';

export type EntityMatch = {end: number; start: number};

// How many matches in a text node are passed over to check the node after it,
// where its transform returns before the loop that checks that node.
const MAX_MATCHES_PASSED = 8;

// How many times one update turns the same token or segmented entity back into
// text before it leaves it as an entity.
const MAX_TURNED_INTO_TEXT = 2;

/**
 * Give `to`, the text node that takes the place of `from` with the same
 * characters (an entity made plain text, or plain text made an entity), the
 * NodeState of `from`: the ad-hoc data an app keeps on text, such as comment
 * ids or block ids, flat states included, as `splitText` gives it to its
 * pieces. The properties inherent to the entity type (its class fields and
 * mode) are not NodeState and stay with the type. A key that `to` already
 * holds keeps its value (when the text is made an entity: state that
 * `createNode` gave it).
 */
function $carryNodeState(from: TextNode, to: TextNode): void {
  // @internal access, like `__text`: the NodeState of the node
  const fromState = from.getLatest().__state;
  if (fromState === undefined || fromState.size === 0) {
    return;
  }
  const held = new Set<string>();
  const toState = to.getLatest().__state;
  if (toState !== undefined) {
    const [heldUnknown, heldKnown] = toState.getInternalState();
    for (const key in heldUnknown) {
      held.add(key);
    }
    for (const stateConfig of heldKnown.keys()) {
      held.add(stateConfig.key);
    }
  }
  const [unknown, known] = fromState.getInternalState();
  let state: undefined | ReturnType<typeof $getWritableNodeState<TextNode>>;
  const $state = () => state || (state = $getWritableNodeState(to));
  for (const [stateConfig, value] of known) {
    const key = stateConfig.key;
    if (held.has(key)) {
      continue;
    }
    held.add(key);
    if (stateConfig.isEqual(value, stateConfig.defaultValue)) {
      continue;
    }
    const writable = $state();
    const own = writable.sharedNodeState.sharedConfigMap.get(key);
    if (own === undefined || own === stateConfig) {
      // The same value object (comment ids compare by identity)
      writable.updateFromKnown(stateConfig, value);
    } else {
      // The type of `to` has another config for this key: parse with it
      writable.updateFromUnknown(key, stateConfig.unparse(value));
    }
  }
  if (unknown !== undefined) {
    for (const [key, value] of Object.entries(unknown)) {
      if (!held.has(key)) {
        $state().updateFromUnknown(key, value);
      }
    }
  }
}

type AnyNodeState = NonNullable<TextNode['__state']>;

/**
 * The value `state` holds for `stateConfig` (parsed from JSON if it was not
 * read yet), without caching it, or its default
 */
function readStateValue(
  state: undefined | AnyNodeState,
  stateConfig: Parameters<AnyNodeState['getValue']>[0],
): unknown {
  if (state === undefined) {
    return stateConfig.defaultValue;
  }
  const [unknown, known] = state.getInternalState();
  if (known.has(stateConfig)) {
    return known.get(stateConfig);
  }
  if (unknown !== undefined && stateConfig.key in unknown) {
    return stateConfig.parse(unknown[stateConfig.key]);
  }
  return stateConfig.defaultValue;
}

/**
 * Whether `a` and `b` hold equivalent NodeState, by the rule that decides
 * whether two text nodes merge: known values compared with their
 * `StateConfig.isEqual`, values not read yet compared as they are
 */
function haveEquivalentNodeState(a: TextNode, b: TextNode): boolean {
  // @internal access, like `__text`: the NodeState of the nodes
  const stateA = a.getLatest().__state;
  const stateB = b.getLatest().__state;
  if (stateA === stateB) {
    return true;
  }
  const keys = new Set<string>();
  const hasUnequalKnown = (
    source: undefined | AnyNodeState,
    other: undefined | AnyNodeState,
  ): boolean => {
    if (source !== undefined) {
      for (const [stateConfig, value] of source.getInternalState()[1]) {
        if (keys.has(stateConfig.key)) {
          continue;
        }
        keys.add(stateConfig.key);
        const otherValue = readStateValue(other, stateConfig);
        if (otherValue !== value && !stateConfig.isEqual(otherValue, value)) {
          return true;
        }
      }
    }
    return false;
  };
  const hasUnequalUnknown = (
    source: undefined | AnyNodeState,
    other: undefined | AnyNodeState,
  ): boolean => {
    const unknown = source === undefined ? undefined : source.unknownState;
    const otherUnknown = other === undefined ? undefined : other.unknownState;
    if (unknown !== undefined) {
      for (const [key, value] of Object.entries(unknown)) {
        if (keys.has(key)) {
          continue;
        }
        keys.add(key);
        if (
          value !== (otherUnknown === undefined ? undefined : otherUnknown[key])
        ) {
          return true;
        }
      }
    }
    return false;
  };
  return !(
    hasUnequalKnown(stateA, stateB) ||
    hasUnequalKnown(stateB, stateA) ||
    hasUnequalUnknown(stateA, stateB) ||
    hasUnequalUnknown(stateB, stateA)
  );
}

/**
 * Whether `a` and `b` would merge as text: the same format, style, detail and
 * NodeState
 */
function $wouldMerge(a: TextNode, b: TextNode): boolean {
  return (
    a.getFormat() === b.getFormat() &&
    a.getStyle() === b.getStyle() &&
    a.getDetail() === b.getDetail() &&
    haveEquivalentNodeState(a, b)
  );
}

/**
 * Before `entity` takes the first `count` characters of `node`, the text node
 * after it: move a selection point in those characters (or right after them)
 * into the entity, and one in the rest of `node` back by `count`.
 */
function $moveSelectionIntoEntity(
  node: TextNode,
  entity: TextNode,
  count: number,
): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return;
  }
  const key = node.getKey();
  const entitySize = entity.getTextContentSize();
  for (const point of [selection.anchor, selection.focus]) {
    if (point.key === key && point.type === 'text') {
      if (point.offset <= count) {
        point.set(entity.getKey(), entitySize + point.offset, 'text');
      } else {
        point.set(key, point.offset - count, 'text');
      }
    }
  }
}

// The keys of the text nodes that `$reverseNodeTransform` split off the end of
// an entity (and of their pieces), by pending editor state (one update, or the
// updates batched into one), shared by every registration on the editor.
// `splitText` gives such a piece a copy of the entity's NodeState, but its text
// was inserted after the entity (typed or pasted), so that NodeState is not its
// own, and no entity made from it (of this registration or another) takes it.
const splitOffInUpdate = new WeakMap<EditorState, Set<NodeKey>>();

// The keys of the parents of the entities turned into text, by pending
// editor state, shared by every registration on the editor (see
// `$isInsertedText`).
const demotedInUpdate = new WeakMap<EditorState, Set<NodeKey>>();

function $demotedParents(editor: LexicalEditor): Set<NodeKey> {
  const editorState =
    INTERNAL_getActiveEditorState() || editor.getEditorState();
  let keys = demotedInUpdate.get(editorState);
  if (keys === undefined) {
    keys = new Set();
    demotedInUpdate.set(editorState, keys);
  }
  return keys;
}

/**
 * Whether the characters [start, end) of `node`, whose text is `text`, were
 * inserted into it in this update, at its start or its end, with no entity
 * turned into text in its parent in this update (whose text may have merged
 * into it): it existed in the committed state, and they are outside the text
 * it shares with its committed version at its start and its end. Such
 * characters have a copy of the node's NodeState (as text inserted into a
 * node does), not NodeState of their own, so an entity made of them does not
 * take it (`MarkStateExtension` does not add text inserted at a comment's
 * edge to it, for example).
 */
function $isInsertedText(
  editor: LexicalEditor,
  node: TextNode,
  text: string,
  start: number,
  end: number,
): boolean {
  // @internal access: the node in the committed state
  const prev = editor.getEditorState()._nodeMap.get(node.getKey());
  if (!$isTextNode(prev)) {
    return false;
  }
  const parent = node.getParent();
  if (parent !== null && $demotedParents(editor).has(parent.getKey())) {
    return false;
  }
  // @internal access: the text of the committed version
  const prevText = prev.__text;
  const max = Math.min(prevText.length, text.length);
  let prefix = 0;
  while (prefix < max && prevText[prefix] === text[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < max - prefix &&
    prevText[prevText.length - 1 - suffix] === text[text.length - 1 - suffix]
  ) {
    suffix++;
  }
  return start >= prefix && end <= text.length - suffix && end > start;
}

function $splitOff(editor: LexicalEditor): Set<NodeKey> {
  const editorState =
    INTERNAL_getActiveEditorState() || editor.getEditorState();
  let keys = splitOffInUpdate.get(editorState);
  if (keys === undefined) {
    keys = new Set();
    splitOffInUpdate.set(editorState, keys);
  }
  return keys;
}

/**
 * Returns a tuple that can be rested (...) into mergeRegister to clean up
 * node transforms listeners that transforms text into another node, eg. a HashtagNode.
 * @example
 * ```ts
 *   useEffect(() => {
    return mergeRegister(
      ...registerLexicalTextEntity(editor, getMatch, targetNode, createNode),
    );
  }, [createNode, editor, getMatch, targetNode]);
 * ```
 * Where targetNode is the type of node containing the text you want to transform (like a text input),
 * then getMatch uses a regex to find a matching text and creates the proper node to include the matching text.
 * @param editor - The lexical editor.
 * @param getMatch - Finds a matching string that satisfies a regex expression.
 * @param targetNode - The node type that contains text to match with. eg. HashtagNode
 * @param createNode - A function that creates a new node to contain the matched text. eg createHashtagNode
 * @returns An array containing the plain text and reverse node transform listeners.
 */
export function registerLexicalTextEntity<T extends TextNode>(
  editor: LexicalEditor,
  getMatch: (text: string) => null | EntityMatch,
  targetNode: Klass<T>,
  createNode: (textNode: TextNode) => T,
): (() => void)[] {
  const isTargetNode = (node: LexicalNode | null | undefined): node is T => {
    return node instanceof targetNode;
  };

  const $replaceWithSimpleText = (node: TextNode): void => {
    const parent = node.getParent();
    if (parent !== null) {
      $demotedParents(editor).add(parent.getKey());
    }
    const textNode = $createTextNode(node.getTextContent())
      .setFormat(node.getFormat())
      .setStyle(node.getStyle())
      .setDetail(node.getDetail());
    $carryNodeState(node, textNode);
    node.replace(textNode);
    // The same characters in a plain text node (for collaboration).
    INTERNAL_$recordTextRetype(node, textNode);
  };

  // The keys of the text nodes the entity transform marked dirty, by pending
  // editor state (one update, or the updates batched into one commit).
  const markedInUpdate = new WeakMap<EditorState, Set<NodeKey>>();

  // How many times each token or segmented entity was turned back into text,
  // by pending editor state (one update, or the updates batched into one
  // commit) and its parent, place and text.
  const turnedIntoTextInUpdate = new WeakMap<
    EditorState,
    Map<string, number>
  >();

  // Whether a token or segmented entity with the same parent, place and text
  // as `entity` was turned back into text as many times as it may be in one
  // update; counts this time if not.
  const $wasTurnedIntoText = (entity: TextNode, why = ''): boolean => {
    // Told by the first node before it that is no text entity, which the
    // transforms leave in place while they make the entity and turn it back
    // (text that merges with it keeps its key), and the size of the text
    // entities between (which they may make again too).
    let before = entity.getPreviousSibling();
    let entitiesBefore = 0;
    while ($isTextNode(before) && before.isTextEntity()) {
      entitiesBefore += before.getTextContentSize();
      before = before.getPreviousSibling();
    }
    const at = `${before === null ? '' : before.getKey()}+${entitiesBefore}`;
    const parent = entity.getParent();
    const id = `${why}${parent === null ? '' : parent.getKey()}:${at}:${entity.getTextContent()}`;
    const updateState =
      INTERNAL_getActiveEditorState() || editor.getEditorState();
    let turned = turnedIntoTextInUpdate.get(updateState);
    if (turned === undefined) {
      turned = new Map();
      turnedIntoTextInUpdate.set(updateState, turned);
    }
    const count = turned.get(id) || 0;
    if (count >= MAX_TURNED_INTO_TEXT) {
      return true;
    }
    turned.set(id, count + 1);
    return false;
  };

  const getMode = (node: TextNode): number => {
    return node.getLatest().__mode;
  };

  // Whether the first match of `textAfter` after `text` starts where
  // `textAfter` does, passing over the matches of `text` as the loop below
  // does (it leaves those as text when the transform returns before it), and
  // telling a match that ends where `textAfter` starts (which touches it) from
  // one that starts there. Null when `text` has more matches than are worth
  // passing over.
  const getFirstMatchAfter = (
    text: string,
    textAfter: string,
  ): boolean | null => {
    const combinedText = text + textAfter;
    let offset = 0;
    for (let i = 0; i < MAX_MATCHES_PASSED; i++) {
      const match = getMatch(combinedText.slice(offset));
      if (match === null) {
        return false;
      }
      const start = offset + match.start;
      const end = offset + match.end;
      if (end <= start) {
        return null;
      }
      if (end >= text.length) {
        return start === text.length;
      }
      offset = end;
    }
    return null;
  };

  // Whether the node after `node` is a text entity (an entity right after
  // another is handled by the entity's own transform).
  const isNextTextEntity = (node: TextNode): boolean => {
    const after = node.getNextSibling();
    return $isTextNode(after) && after.isTextEntity();
  };

  // Whether a text node after `entity` is not text it was split from: one in
  // another format, style or detail, or not simple text.
  const isTextAfterOutsideSource = (entity: TextNode): boolean => {
    const after = entity.getNextSibling();
    return (
      $isTextNode(after) &&
      !(
        after.isSimpleText() &&
        !isTargetNode(after) &&
        after.getFormat() === entity.getFormat() &&
        after.getStyle() === entity.getStyle() &&
        after.getDetail() === entity.getDetail()
      )
    );
  };

  // Whether `entity`, right after a simple text node with `textBefore`, is an
  // entity the transforms keep: the first match from `textBefore` on starts
  // where it does, with the text after it in its source node (the simple text
  // node after it in the same format, style and detail, which it was split
  // from), as the check that made it an entity found it; and that match still
  // holds with the text of any other text node after it, as the check that
  // keeps a match at the end of a node from becoming an entity found it. When
  // `textBefore` has too many matches to tell, `ifUnsure` is returned.
  const isEntityAfter = (
    textBefore: string,
    entity: TextNode,
    ifUnsure: boolean,
  ): boolean => {
    const holds = (result: boolean | null) =>
      result === null ? ifUnsure : result;
    const entityText = entity.getTextContent();
    const after = entity.getNextSibling();
    if (!$isTextNode(after)) {
      return holds(getFirstMatchAfter(textBefore, entityText));
    }
    const isSuffix = !isTextAfterOutsideSource(entity);
    const withAfter = getFirstMatchAfter(
      textBefore,
      entityText + after.getTextContent(),
    );
    if (isSuffix) {
      return holds(withAfter);
    }
    return (
      holds(withAfter) && holds(getFirstMatchAfter(textBefore, entityText))
    );
  };

  // Checks the entity after a simple text node whose transform returned
  // before its loop, which checks that node: it is turned back into text
  // unless the first match from this node's text on, with the text after the
  // entity, starts where the entity does, as it must for a match at the start
  // of a node to be made an entity.
  const $checkNextSibling = (node: TextNode, text: string) => {
    const nextSibling = node.getNextSibling();
    if (isTargetNode(nextSibling)) {
      const entityText = nextSibling.getTextContent();
      const entityMatch = getMatch(entityText);
      if (
        // Leave an entity that its own transform is still splitting or
        // turning back into text to that transform.
        entityMatch === null ||
        entityMatch.start !== 0 ||
        entityMatch.end !== entityText.length
      ) {
        return;
      }
      if (!isEntityAfter(text, nextSibling, true)) {
        $replaceWithSimpleText(nextSibling);
      }
    }
  };

  const $textNodeTransform = (node: TextNode) => {
    if (!node.isSimpleText()) {
      return;
    }
    // Text split off the end of an entity in this update: its pieces do not
    // give their NodeState to the entities made from them
    const splitOff = $splitOff(editor).has(node.getKey())
      ? $splitOff(editor)
      : null;

    let prevSibling = node.getPreviousSibling();
    let text = node.getTextContent();
    const nodeText = text;
    let currentNode = node;
    let match;
    // The first match of the previous text node's text and this node's.
    let firstMatch: null | EntityMatch = null;

    if ($isTextNode(prevSibling)) {
      const previousText = prevSibling.getTextContent();
      const combinedText = previousText + text;
      const prevMatch = getMatch(combinedText);
      firstMatch = prevMatch;

      if (isTargetNode(prevSibling)) {
        if (
          prevMatch === null ||
          (getMode(prevSibling) !== 0 &&
            // A token or segmented entity followed by text is turned back
            // into text, unless the same entity was already turned back into
            // text twice for this pending editor state: the transforms would
            // only make it again and turn it back forever. It is kept then
            // (below).
            !(
              prevMatch.start === 0 &&
              prevMatch.end >= previousText.length &&
              $wasTurnedIntoText(prevSibling)
            ))
        ) {
          $replaceWithSimpleText(prevSibling);

          return;
        } else {
          const diff = prevMatch.end - previousText.length;
          // Whether the entity takes the first `diff` characters of this node
          let grows = diff > 0;
          const textBefore = prevSibling.getPreviousSibling();
          if (grows && $isTextNode(textBefore)) {
            if (textBefore.isTextEntity()) {
              // Two entities next to each other: the entities' own transforms
              // turn them back into text (or keep them as they are); this
              // one does not take this node's text first.
              grows = false;
            } else if (textBefore.isSimpleText()) {
              const before = textBefore.getTextContent();
              if (!isEntityAfter(before, prevSibling, true)) {
                // An entity that the transforms do not keep after the text
                // before it is turned back into text rather than grown over
                // this node first (which would give this node's characters
                // its format and NodeState before it turns into text anyway).
                $replaceWithSimpleText(prevSibling);

                return;
              }
              if (!isEntityAfter(before, prevSibling, false)) {
                // Not sure (too many matches in the text before it to tell):
                // it stays as it is, without taking this node's text.
                grows = false;
              }
            }
          }
          if (
            grows &&
            // A token or segmented entity kept above takes the text its match
            // extends into, as an entity in normal mode does, only when that
            // text would merge with it (the same format, style, detail and
            // NodeState); text with other NodeState or format stays apart,
            // rather than take the entity's (or make it drop its own).
            (getMode(prevSibling) === 0 || $wouldMerge(prevSibling, node))
          ) {
            const concatText = text.slice(0, diff);
            const newTextContent = previousText + concatText;
            if (getMode(prevSibling) === 0) {
              prevSibling.select();
            } else {
              // A token or segmented entity kept above: the selection stays
              // where it was in the text
              $moveSelectionIntoEntity(node, prevSibling, diff);
            }
            // The entity takes the first `diff` characters of this node: a
            // move of those characters (for collaboration).
            const entityNode = prevSibling;
            INTERNAL_$recordTextMove(node, entityNode, diff, () => {
              entityNode.setTextContent(newTextContent);

              if (diff === text.length) {
                node.remove();
              } else {
                const remainingText = text.slice(diff);
                node.setTextContent(remainingText);
              }
            });

            return;
          }
        }
      } else if (prevMatch === null || prevMatch.start < previousText.length) {
        $checkNextSibling(node, text);
        return;
      }
    }

    let prevMatchLengthToSkip = 0;

    while (true) {
      const remainingText = text;
      match = getMatch(remainingText);
      const nextText = match === null ? '' : remainingText.slice(match.end);
      text = nextText;

      if (nextText === '') {
        const nextSibling = currentNode.getNextSibling();

        if ($isTextNode(nextSibling)) {
          // The match ends where this node ends, so the next sibling's text may
          // extend, shorten or invalidate it. Re-run getMatch over the text that
          // is still to be processed plus the sibling's text and bail out unless
          // the same match is found at the same offset. Matches that were
          // already replaced (or skipped) are excluded from `remainingText`, so
          // the comparison is against `match.start` rather than 0.
          const combinedText = remainingText + nextSibling.getTextContent();
          const nextMatch = getMatch(combinedText);

          if (nextMatch === null) {
            if (isTargetNode(nextSibling)) {
              // Unless the transforms keep it there, which they do for a
              // match that needs the text after it in its source node.
              if (!isEntityAfter(remainingText, nextSibling, false)) {
                $replaceWithSimpleText(nextSibling);
              }
            } else {
              nextSibling.markDirty();
            }

            return;
          } else if (match === null || nextMatch.start !== match.start) {
            return;
          }
        }
      }

      if (match === null) {
        return;
      }

      if (
        match.start === 0 &&
        $isTextNode(prevSibling) &&
        (prevSibling.isTextEntity() ||
          // The transform of a simple text node checks the entity after it
          // with its own text in front, and turns it back into text if that
          // is no match. Leave a match there as text (and any match right
          // after it) rather than make an entity that check undoes, which
          // would make the two transforms undo each other forever (#9637).
          (prevSibling.isSimpleText() &&
            match.end > 0 &&
            (prevMatchLengthToSkip > 0 ||
              (getMatch(
                prevSibling.getTextContent() +
                  remainingText.slice(0, match.end),
              ) === null &&
                // Unless it is this match with the text after it too.
                !(
                  firstMatch !== null &&
                  firstMatch.start === prevSibling.getTextContentSize() &&
                  firstMatch.end ===
                    prevSibling.getTextContentSize() + match.end
                )))))
      ) {
        prevMatchLengthToSkip += match.end;
        continue;
      }

      // The offsets of the match in the text the node had (`currentNode` is
      // what is left of its end)
      const base = nodeText.length - currentNode.getTextContentSize();
      const [matchStart, matchEnd] =
        match.start === 0
          ? [base, base + match.end]
          : [
              base + match.start + prevMatchLengthToSkip,
              base + match.end + prevMatchLengthToSkip,
            ];
      let nodeToReplace;
      if (match.start === 0) {
        [nodeToReplace, currentNode] = currentNode.splitText(match.end);
      } else {
        [, nodeToReplace, currentNode] = currentNode.splitText(
          match.start + prevMatchLengthToSkip,
          match.end + prevMatchLengthToSkip,
        );
      }
      if (splitOff !== null && currentNode !== undefined) {
        splitOff.add(currentNode.getKey());
      }

      invariant(
        nodeToReplace !== undefined,
        '%s should not be undefined. You may want to check splitOffsets passed to the splitText.',
        'nodeToReplace',
      );

      const replacementNode = createNode(nodeToReplace);
      replacementNode
        .setFormat(nodeToReplace.getFormat())
        .setStyle(nodeToReplace.getStyle())
        .setDetail(nodeToReplace.getDetail());
      if (
        splitOff === null &&
        !$isInsertedText(editor, node, nodeText, matchStart, matchEnd)
      ) {
        // The NodeState of the text becomes the entity's
        $carryNodeState(nodeToReplace, replacementNode);
      }
      nodeToReplace.replace(replacementNode);
      // The same characters in the entity node (for collaboration), where
      // createNode gave it the same text.
      INTERNAL_$recordTextRetype(nodeToReplace, replacementNode);

      if (currentNode == null) {
        return;
      }
      prevMatchLengthToSkip = 0;
      prevSibling = replacementNode;
    }
  };

  const $reverseNodeTransform = (node: T) => {
    const text = node.getTextContent();
    const match = getMatch(text);

    if (match === null || match.start !== 0) {
      $replaceWithSimpleText(node);

      return;
    }

    if (text.length > match.end) {
      // This will split out the rest of the text as simple text
      const [, rest] = node.splitText(match.end);
      if (rest !== undefined) {
        $splitOff(editor).add(rest.getKey());
      }

      return;
    }

    const prevSibling = node.getPreviousSibling();

    if (
      $isTextNode(prevSibling) &&
      prevSibling.isSimpleText() &&
      // The text node before it checks it on its own while it is a match
      // after its text.
      !isNextTextEntity(node) &&
      !isEntityAfter(prevSibling.getTextContent(), node, true)
    ) {
      // The text after this entity may have changed so that the transforms
      // no longer keep it after the text before it: the transform of the text
      // node before it turns it back into text then. Once per pending editor
      // state, as the transforms of other entities may leave it dirty again.
      const updateState =
        INTERNAL_getActiveEditorState() || editor.getEditorState();
      let marked = markedInUpdate.get(updateState);
      if (marked === undefined) {
        marked = new Set();
        markedInUpdate.set(updateState, marked);
      }
      if (!marked.has(prevSibling.getKey())) {
        marked.add(prevSibling.getKey());
        prevSibling.markDirty();
      }
    }

    // Two entities next to each other are turned back into text, unless this
    // entity was already turned back into text for that twice for this
    // pending editor state: entities of two registrations that touch would
    // be made again and turned back forever. They are kept then.
    if (
      $isTextNode(prevSibling) &&
      prevSibling.isTextEntity() &&
      !$wasTurnedIntoText(node, 'adjacent:')
    ) {
      $replaceWithSimpleText(prevSibling);
      $replaceWithSimpleText(node);
    }

    const nextSibling = node.getNextSibling();

    if (
      $isTextNode(nextSibling) &&
      nextSibling.isTextEntity() &&
      // This may have already been converted in the previous block
      (!isTargetNode(node) || !$wasTurnedIntoText(node, 'adjacent:'))
    ) {
      $replaceWithSimpleText(nextSibling);

      if (isTargetNode(node)) {
        $replaceWithSimpleText(node);
      }
    }
  };

  const removePlainTextTransform = editor.registerNodeTransform(
    TextNode,
    $textNodeTransform,
  );
  const removeReverseNodeTransform = editor.registerNodeTransform(
    targetNode,
    $reverseNodeTransform,
  );

  return [removePlainTextTransform, removeReverseNodeTransform];
}
