/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createTextNode,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  shallowMergeConfig,
  TextNode,
} from 'lexical';

import {AutoLinkAnnounceExtension} from './AutoLinkAnnounceExtension';
import {LinkExtension} from './LexicalLinkExtension';
import {
  $createAutoLinkNode,
  $isAutoLinkNode,
  $isLinkNode,
  type AutoLinkAttributes,
  AutoLinkNode,
  TOGGLE_LINK_COMMAND,
} from './LexicalLinkNode';

/**
 * A callback invoked when the auto-link plugin creates, updates, or removes an
 * automatic link. It receives the new `url` and the `prevUrl`; either may be
 * `null` when a link is added or removed.
 */
export type ChangeHandler = (
  url: string | null,
  prevUrl: string | null,
) => void;

export interface LinkMatcherResult {
  attributes?: AutoLinkAttributes;
  index: number;
  length: number;
  text: string;
  url: string;
}

/**
 * A function that inspects a piece of `text` and returns a
 * {@link LinkMatcherResult} for the first URL it recognizes, or `null` if none
 * is found. Used by the auto-link plugin to detect links as the user types.
 */
export type LinkMatcher = (text: string) => LinkMatcherResult | null;

/**
 * Builds a {@link LinkMatcher} from a regular expression. The matched text is
 * used as the link URL, optionally rewritten by `urlTransformer` (for example
 * to prepend a protocol). Pass the result to the auto-link plugin's `matchers`.
 *
 * @returns A matcher that reports the first match of `regExp` in the text.
 */
export function createLinkMatcherWithRegExp(
  regExp: RegExp,
  urlTransformer: (text: string) => string = text => text,
) {
  return (text: string) => {
    const match = regExp.exec(text);
    if (match === null) {
      return null;
    }
    return {
      index: match.index,
      length: match[0].length,
      text: match[0],
      url: urlTransformer(match[0]),
    };
  };
}

const URL_REGEX =
  /((https?:\/\/(www\.)?)|(www\.))[-\p{L}\p{N}@:%._+~#=]{1,256}\.[\p{L}\p{N}]{1,6}(?:[-\p{L}\p{N}()@:%_+.~#?&//=]*[\p{L}\p{N}()@_~#?&//=])?/u;

const EMAIL_REGEX =
  /(([^<>()[\]\\.,;:\s@"]{1,64}(\.[^<>()[\]\\.,;:\s@"]{1,64}){0,63})|(".{1,255}"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]{1,63}\.){1,127}[a-zA-Z]{2,63}))/;

/**
 * A ready-to-use {@link LinkMatcher} for URLs with full Unicode support
 * (`\\p{L}`, `\\p{N}`). Handles parenthesis balancing so that Wikipedia-style
 * URLs like `https://en.wikipedia.org/wiki/Fish_(disambiguation)` are matched
 * correctly even when wrapped in prose parentheses.
 */
export const autoLinkUrlMatcher: LinkMatcher = text => {
  const match = URL_REGEX.exec(text);
  if (match === null) {
    return null;
  }
  let matched = match[0];
  let depth = 0;
  for (const ch of matched) {
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    }
  }
  while (depth < 0 && matched.endsWith(')')) {
    matched = matched.slice(0, -1);
    depth++;
  }
  return {
    index: match.index,
    length: matched.length,
    text: matched,
    url: matched.startsWith('http') ? matched : `https://${matched}`,
  };
};

/**
 * A ready-to-use {@link LinkMatcher} for email addresses. Bounded quantifiers
 * keep matching linear-time; the limits comfortably exceed RFC 5321 maximums.
 */
export const autoLinkEmailMatcher: LinkMatcher = createLinkMatcherWithRegExp(
  EMAIL_REGEX,
  text => `mailto:${text}`,
);

function findFirstMatch(
  text: string,
  matchers: LinkMatcher[],
): LinkMatcherResult | null {
  for (let i = 0; i < matchers.length; i++) {
    const match = matchers[i](text);

    if (match) {
      return match;
    }
  }

  return null;
}

const PUNCTUATION_OR_SPACE = /[.,;\s]/;

function isSeparator(char: string, separatorRegex: RegExp): boolean {
  return separatorRegex.test(char);
}

function endsWithSeparator(
  textContent: string,
  separatorRegex: RegExp,
): boolean {
  return isSeparator(textContent[textContent.length - 1], separatorRegex);
}

function startsWithSeparator(
  textContent: string,
  separatorRegex: RegExp,
): boolean {
  return isSeparator(textContent[0], separatorRegex);
}

/**
 * Check if the text content starts with a fullstop followed by a top-level domain.
 * Meaning if the text content can be a beginning of a top level domain.
 * @param textContent
 * @param isEmail
 * @returns boolean
 */
function startsWithTLD(textContent: string, isEmail: boolean): boolean {
  if (isEmail) {
    return /^\.[a-zA-Z]{2,}/.test(textContent);
  } else {
    return /^\.[a-zA-Z0-9]{1,}/.test(textContent);
  }
}

function isPreviousNodeValid(
  node: LexicalNode,
  separatorRegex: RegExp,
): boolean {
  let previousNode = node.getPreviousSibling();
  if ($isElementNode(previousNode)) {
    previousNode = previousNode.getLastDescendant();
  }
  return (
    previousNode === null ||
    $isLineBreakNode(previousNode) ||
    ($isTextNode(previousNode) &&
      endsWithSeparator(previousNode.getTextContent(), separatorRegex))
  );
}

function isNextNodeValid(node: LexicalNode, separatorRegex: RegExp): boolean {
  let nextNode = node.getNextSibling();
  if ($isElementNode(nextNode)) {
    nextNode = nextNode.getFirstDescendant();
  }
  return (
    nextNode === null ||
    $isLineBreakNode(nextNode) ||
    ($isTextNode(nextNode) &&
      startsWithSeparator(nextNode.getTextContent(), separatorRegex))
  );
}

function isContentAroundIsValid(
  matchStart: number,
  matchEnd: number,
  separatorRegex: RegExp,
  text: string,
  nodes: TextNode[],
): boolean {
  const contentBeforeIsValid =
    matchStart > 0
      ? isSeparator(text[matchStart - 1], separatorRegex)
      : isPreviousNodeValid(nodes[0], separatorRegex);
  if (!contentBeforeIsValid) {
    return false;
  }

  const contentAfterIsValid =
    matchEnd < text.length
      ? isSeparator(text[matchEnd], separatorRegex)
      : isNextNodeValid(nodes[nodes.length - 1], separatorRegex);
  return contentAfterIsValid;
}

function extractMatchingNodes(
  nodes: TextNode[],
  startIndex: number,
  endIndex: number,
): [
  matchingOffset: number,
  unmodifiedBeforeNodes: TextNode[],
  matchingNodes: TextNode[],
  unmodifiedAfterNodes: TextNode[],
] {
  const unmodifiedBeforeNodes: TextNode[] = [];
  const matchingNodes: TextNode[] = [];
  const unmodifiedAfterNodes: TextNode[] = [];
  let matchingOffset = 0;

  let currentOffset = 0;
  const currentNodes = [...nodes];

  while (currentNodes.length > 0) {
    const currentNode = currentNodes[0];
    const currentNodeText = currentNode.getTextContent();
    const currentNodeLength = currentNodeText.length;
    const currentNodeStart = currentOffset;
    const currentNodeEnd = currentOffset + currentNodeLength;

    if (currentNodeEnd <= startIndex) {
      unmodifiedBeforeNodes.push(currentNode);
      matchingOffset += currentNodeLength;
    } else if (currentNodeStart >= endIndex) {
      unmodifiedAfterNodes.push(currentNode);
    } else {
      matchingNodes.push(currentNode);
    }
    currentOffset += currentNodeLength;
    currentNodes.shift();
  }
  return [
    matchingOffset,
    unmodifiedBeforeNodes,
    matchingNodes,
    unmodifiedAfterNodes,
  ];
}

function $createAutoLinkNode_(
  nodes: TextNode[],
  startIndex: number,
  endIndex: number,
  match: LinkMatcherResult,
): TextNode | undefined {
  const linkNode = $createAutoLinkNode(match.url, match.attributes);
  if (nodes.length === 1) {
    let remainingTextNode = nodes[0];
    let linkTextNode;
    if (startIndex === 0) {
      [linkTextNode, remainingTextNode] = remainingTextNode.splitText(endIndex);
    } else {
      [, linkTextNode, remainingTextNode] = remainingTextNode.splitText(
        startIndex,
        endIndex,
      );
    }
    const textNode = $createTextNode(match.text);
    textNode.setFormat(linkTextNode.getFormat());
    textNode.setDetail(linkTextNode.getDetail());
    textNode.setStyle(linkTextNode.getStyle());
    linkNode.append(textNode);
    linkTextNode.replace(linkNode);
    return remainingTextNode;
  } else if (nodes.length > 1) {
    const firstTextNode = nodes[0];
    let offset = firstTextNode.getTextContent().length;
    let firstLinkTextNode;
    if (startIndex === 0) {
      firstLinkTextNode = firstTextNode;
    } else {
      [, firstLinkTextNode] = firstTextNode.splitText(startIndex);
    }
    const linkNodes = [];
    let remainingTextNode;
    for (let i = 1; i < nodes.length; i++) {
      const currentNode = nodes[i];
      const currentNodeText = currentNode.getTextContent();
      const currentNodeLength = currentNodeText.length;
      const currentNodeStart = offset;
      const currentNodeEnd = offset + currentNodeLength;
      if (currentNodeStart < endIndex) {
        if (currentNodeEnd <= endIndex) {
          linkNodes.push(currentNode);
        } else {
          const [linkTextNode, endNode] = currentNode.splitText(
            endIndex - currentNodeStart,
          );
          linkNodes.push(linkTextNode);
          remainingTextNode = endNode;
        }
      }
      offset += currentNodeLength;
    }
    const selection = $getSelection();
    const selectedTextNode = selection
      ? selection.getNodes().find($isTextNode)
      : undefined;
    const textNode = $createTextNode(firstLinkTextNode.getTextContent());
    textNode.setFormat(firstLinkTextNode.getFormat());
    textNode.setDetail(firstLinkTextNode.getDetail());
    textNode.setStyle(firstLinkTextNode.getStyle());
    linkNode.append(textNode, ...linkNodes);
    // it does not preserve caret position if caret was at the first text node
    // so we need to restore caret position
    if (selectedTextNode && selectedTextNode === firstLinkTextNode) {
      if ($isRangeSelection(selection)) {
        textNode.select(selection.anchor.offset, selection.focus.offset);
      } else if ($isNodeSelection(selection)) {
        textNode.select(0, textNode.getTextContent().length);
      }
    }
    firstLinkTextNode.replace(linkNode);
    return remainingTextNode;
  }
  return undefined;
}

function $handleLinkCreation(
  nodes: TextNode[],
  matchers: LinkMatcher[],
  onChange: ChangeHandler,
  separatorRegex: RegExp,
): void {
  // Early return if any node is already part of an AutoLinkNode (idempotency check)
  for (const node of nodes) {
    const parent = node.getParent();
    if ($isAutoLinkNode(parent) && !parent.getIsUnlinked()) {
      return;
    }
  }

  let currentNodes = [...nodes];
  const initialText = currentNodes.map(node => node.getTextContent()).join('');
  let text = initialText;
  let match;
  let invalidMatchEnd = 0;

  while ((match = findFirstMatch(text, matchers)) && match !== null) {
    const matchStart = match.index;
    const matchLength = match.length;
    const matchEnd = matchStart + matchLength;
    const isValid = isContentAroundIsValid(
      invalidMatchEnd + matchStart,
      invalidMatchEnd + matchEnd,
      separatorRegex,
      initialText,
      currentNodes,
    );

    if (isValid) {
      const [matchingOffset, , matchingNodes, unmodifiedAfterNodes] =
        extractMatchingNodes(
          currentNodes,
          invalidMatchEnd + matchStart,
          invalidMatchEnd + matchEnd,
        );

      // Skip if matching nodes are already part of an AutoLinkNode
      let alreadyLinked = false;
      for (const node of matchingNodes) {
        const parent = node.getParent();
        if ($isAutoLinkNode(parent) && !parent.getIsUnlinked()) {
          alreadyLinked = true;
          break;
        }
      }
      if (alreadyLinked) {
        invalidMatchEnd += matchEnd;
        text = text.substring(matchEnd);
        continue;
      }

      const actualMatchStart = invalidMatchEnd + matchStart - matchingOffset;
      const actualMatchEnd = invalidMatchEnd + matchEnd - matchingOffset;
      const remainingTextNode = $createAutoLinkNode_(
        matchingNodes,
        actualMatchStart,
        actualMatchEnd,
        match,
      );
      currentNodes = remainingTextNode
        ? [remainingTextNode, ...unmodifiedAfterNodes]
        : unmodifiedAfterNodes;
      onChange(match.url, null);
      invalidMatchEnd = 0;
    } else {
      invalidMatchEnd += matchEnd;
    }

    text = text.substring(matchEnd);
  }
}

function handleLinkEdit(
  linkNode: AutoLinkNode,
  matchers: LinkMatcher[],
  onChange: ChangeHandler,
  separatorRegex: RegExp,
): void {
  // Check children are simple text
  const children = linkNode.getChildren();
  const childrenLength = children.length;
  for (let i = 0; i < childrenLength; i++) {
    const child = children[i];
    if (!$isTextNode(child) || !child.isSimpleText()) {
      replaceWithChildren(linkNode);
      onChange(null, linkNode.getURL());
      return;
    }
  }

  // Check text content fully matches
  const text = linkNode.getTextContent();
  const match = findFirstMatch(text, matchers);
  if (match === null || match.text !== text) {
    replaceWithChildren(linkNode);
    onChange(null, linkNode.getURL());
    return;
  }

  // Check neighbors
  if (
    !isPreviousNodeValid(linkNode, separatorRegex) ||
    !isNextNodeValid(linkNode, separatorRegex)
  ) {
    replaceWithChildren(linkNode);
    onChange(null, linkNode.getURL());
    return;
  }

  const url = linkNode.getURL();
  if (url !== match.url) {
    linkNode.setURL(match.url);
    onChange(match.url, url);
  }

  if (match.attributes) {
    // `ChangeHandler` is documented as receiving the new url and the previous
    // url, so an attribute refresh is not something it can describe: passing a
    // rel or target through it reports that value as the link's url. These
    // assignments keep the node in sync with the matcher without reporting a
    // url change that did not happen.
    if (linkNode.getRel() !== match.attributes.rel) {
      linkNode.setRel(match.attributes.rel || null);
    }

    if (linkNode.getTarget() !== match.attributes.target) {
      linkNode.setTarget(match.attributes.target || null);
    }

    // `title` is the third member of LinkAttributes and the creation path
    // ($createAutoLinkNode(match.url, match.attributes)) already applies it,
    // so the edit path has to refresh it too or it goes stale.
    if (linkNode.getTitle() !== match.attributes.title) {
      linkNode.setTitle(match.attributes.title || null);
    }
  }
}

// Bad neighbors are edits in neighbor nodes that make AutoLinks incompatible.
// Given the creation preconditions, these can only be simple text nodes.
function handleBadNeighbors(
  textNode: TextNode,
  matchers: LinkMatcher[],
  onChange: ChangeHandler,
  separatorRegex: RegExp,
): void {
  const parent = textNode.getParent();
  const previousSibling = textNode.getPreviousSibling();
  const nextSibling = textNode.getNextSibling();
  const text = textNode.getTextContent();

  // Skip if textNode is already part of an AutoLinkNode (idempotency check)
  // The handleLinkEdit on the parent will handle unwrapping if needed
  if ($isAutoLinkNode(parent) && !parent.getIsUnlinked()) {
    return;
  }

  // Handle case: textNode added AFTER a link, making link invalid
  // Check if previousSibling is a link and adding this textNode makes it invalid
  if ($isAutoLinkNode(previousSibling) && !previousSibling.getIsUnlinked()) {
    // Check if the textNode is still a sibling (hasn't been moved) to prevent loops
    if (
      previousSibling.is(textNode.getPreviousSibling()) &&
      textNode.getParent() === previousSibling.getParent()
    ) {
      // If text doesn't start with separator, link should be unwrapped
      // because non-separator after link makes the boundary invalid
      if (!startsWithSeparator(text, separatorRegex)) {
        // Non-separator after link - unwrap the link
        replaceWithChildren(previousSibling);
        onChange(null, previousSibling.getURL());
        return; // Early return after unwrapping to avoid further processing
      }

      // If text starts with separator, check if it's valid TLD continuation
      if (startsWithTLD(text, previousSibling.isEmailURI())) {
        // Valid TLD continuation - try to append
        const combinedText = previousSibling.getTextContent() + text;
        const match = findFirstMatch(combinedText, matchers);
        if (match !== null && match.text === combinedText) {
          previousSibling.append(textNode);
          handleLinkEdit(previousSibling, matchers, onChange, separatorRegex);
          onChange(null, previousSibling.getURL());
        }
      }
      // If starts with separator but not valid TLD, do nothing (link stays valid)
    }
  }

  // Handle case: textNode added BEFORE a link, making link invalid
  if (
    $isAutoLinkNode(nextSibling) &&
    !nextSibling.getIsUnlinked() &&
    !endsWithSeparator(text, separatorRegex)
  ) {
    // Check if the nextSibling is still a sibling (hasn't been moved) to prevent loops
    if (
      nextSibling.is(textNode.getNextSibling()) &&
      textNode.getParent() === nextSibling.getParent()
    ) {
      replaceWithChildren(nextSibling);
      onChange(null, nextSibling.getURL());
    }
  }
}

function replaceWithChildren(node: ElementNode): LexicalNode[] {
  const children = node.getChildren();
  const childrenLength = children.length;

  for (let j = childrenLength - 1; j >= 0; j--) {
    node.insertAfter(children[j]);
  }

  node.remove();
  return children.map(child => child.getLatest());
}

function getTextNodesToMatch(textNode: TextNode): TextNode[] {
  // check if next siblings are simple text nodes till a node contains a space separator
  const textNodesToMatch = [textNode];
  let nextSibling = textNode.getNextSibling();
  while (
    nextSibling !== null &&
    $isTextNode(nextSibling) &&
    nextSibling.isSimpleText()
  ) {
    textNodesToMatch.push(nextSibling);
    if (/[\s]/.test(nextSibling.getTextContent())) {
      break;
    }
    nextSibling = nextSibling.getNextSibling();
  }
  return textNodesToMatch;
}

export interface AutoLinkConfig {
  changeHandlers: ChangeHandler[];
  excludeParents: ((parent: ElementNode) => boolean)[];
  matchers: LinkMatcher[];
  /**
   * The regular expression used to determine whether surrounding
   * characters count as separators when validating auto-link
   * boundaries. Defaults to `/[.,;\s]/`.
   */
  separatorRegex: RegExp;
}

const defaultConfig: AutoLinkConfig = {
  changeHandlers: [],
  excludeParents: [],
  matchers: [],
  separatorRegex: PUNCTUATION_OR_SPACE,
};

export function registerAutoLink(
  editor: LexicalEditor,
  config: Partial<AutoLinkConfig> &
    Omit<AutoLinkConfig, 'separatorRegex'> = defaultConfig,
): () => void {
  const {
    matchers,
    changeHandlers,
    excludeParents,
    separatorRegex = PUNCTUATION_OR_SPACE,
  } = config;
  const onChange: ChangeHandler = (url, prevUrl) => {
    for (const handler of changeHandlers) {
      handler(url, prevUrl);
    }
  };
  return mergeRegister(
    editor.registerNodeTransform(TextNode, (textNode: TextNode) => {
      const parent = textNode.getParentOrThrow();
      const previous = textNode.getPreviousSibling();
      if ($isAutoLinkNode(parent)) {
        handleLinkEdit(parent, matchers, onChange, separatorRegex);
      } else if (
        !$isLinkNode(parent) &&
        !excludeParents.some(pred => pred(parent))
      ) {
        if (
          textNode.isSimpleText() &&
          (startsWithSeparator(textNode.getTextContent(), separatorRegex) ||
            !$isAutoLinkNode(previous))
        ) {
          const textNodesToMatch = getTextNodesToMatch(textNode);
          $handleLinkCreation(
            textNodesToMatch,
            matchers,
            onChange,
            separatorRegex,
          );
        }

        handleBadNeighbors(textNode, matchers, onChange, separatorRegex);
      }
    }),
    editor.registerCommand(
      TOGGLE_LINK_COMMAND,
      payload => {
        const selection = $getSelection();
        if (payload !== null || !$isRangeSelection(selection)) {
          return false;
        }
        const nodes = selection.extract();
        nodes.forEach(node => {
          const parent = node.getParent();

          if ($isAutoLinkNode(parent)) {
            // invert the value
            parent.setIsUnlinked(!parent.getIsUnlinked());
            parent.markDirty();
          }
        });
        return false;
      },
      // Has to be higher than TOGGLE_LINK_COMMAND in LinkExtension
      COMMAND_PRIORITY_LOW,
    ),
  );
}

/**
 * An extension to automatically create AutoLinkNode from text
 * that matches the configured matchers. For ready-to-use matchers see
 * {@link autoLinkUrlMatcher} (Unicode URL detection with parenthesis
 * balancing) and {@link autoLinkEmailMatcher} (email addresses). To build
 * a custom matcher from a RegExp, see {@link createLinkMatcherWithRegExp}.
 *
 * The given `matchers` and `changeHandlers` will be merged by
 * concatenating the configured arrays.
 */
export const AutoLinkExtension = defineExtension({
  config: defaultConfig,
  dependencies: [AutoLinkAnnounceExtension, LinkExtension],
  mergeConfig(config, overrides) {
    const merged = shallowMergeConfig(config, overrides);
    for (const k of ['matchers', 'changeHandlers', 'excludeParents'] as const) {
      const v = overrides[k];
      if (Array.isArray(v)) {
        (merged[k] as unknown[]) = [...config[k], ...v];
      }
    }
    return merged;
  },
  name: '@lexical/link/AutoLink',
  nodes: [AutoLinkNode],
  register: registerAutoLink,
});
