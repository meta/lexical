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
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  type LexicalEditor,
  type PointType,
} from 'lexical';

Object.defineProperty(HTMLElement.prototype, 'contentEditable', {
  get() {
    return this.getAttribute('contenteditable');
  },

  set(value) {
    this.setAttribute('contenteditable', value);
  },
});

type Segment = {
  index: number;
  isWordLike: boolean;
  segment: string;
};

if (!Selection.prototype.modify) {
  const wordBreakPolyfillRegex =
    /[\s.,\\/#!$%^&*;:{}=\-`~()\uD800-\uDBFF\uDC00-\uDFFF\u3000-\u303F]/u;

  const pushSegment = function (
    segments: Segment[],
    index: number,
    str: string,
    isWordLike: boolean,
  ): void {
    segments.push({
      index: index - str.length,
      isWordLike,
      segment: str,
    });
  };

  const getWordsFromString = function (string: string): Segment[] {
    const segments: Segment[] = [];
    let wordString = '';
    let nonWordString = '';
    let i;

    for (i = 0; i < string.length; i++) {
      const char = string[i];

      if (wordBreakPolyfillRegex.test(char)) {
        if (wordString !== '') {
          pushSegment(segments, i, wordString, true);
          wordString = '';
        }

        nonWordString += char;
      } else {
        if (nonWordString !== '') {
          pushSegment(segments, i, nonWordString, false);
          nonWordString = '';
        }

        wordString += char;
      }
    }

    if (wordString !== '') {
      pushSegment(segments, i, wordString, true);
    }

    if (nonWordString !== '') {
      pushSegment(segments, i, nonWordString, false);
    }

    return segments;
  };

  Selection.prototype.modify = function (alter, direction, granularity) {
    // This is not a thorough implementation, it was more to get tests working
    // given the refactor to use this selection method.
    if (this.anchorNode === null || this.focusNode === null) {
      return;
    }
    const focus = {node: this.focusNode, offset: this.focusOffset};
    const anchor = {node: this.anchorNode, offset: this.anchorOffset};

    if (granularity === 'character') {
      let anchorNode = anchor.node;
      let anchorOffset = anchor.offset;
      let _$isTextNode = false;

      if (anchorNode.nodeType === 3) {
        _$isTextNode = true;
        anchorNode = anchorNode.parentElement!;
      } else if (anchorNode.nodeName === 'BR') {
        const parentNode = anchorNode.parentElement!;
        const childNodes = Array.from<Node>(parentNode.childNodes);
        anchorOffset = childNodes.indexOf(anchorNode);
        anchorNode = parentNode;
      }

      if (direction === 'backward') {
        if (anchorOffset === 0) {
          let prevSibling = anchorNode.previousSibling;

          if (prevSibling === null) {
            prevSibling =
              anchorNode.parentElement!.previousSibling?.lastChild ?? null;
          }
          if (prevSibling) {
            if (prevSibling.nodeName === 'P') {
              prevSibling = prevSibling.firstChild!;
            }

            if (prevSibling.nodeName === 'BR') {
              anchor.node = prevSibling;
              anchor.offset = 0;
            } else {
              anchor.node = prevSibling.firstChild!;
              anchor.offset = anchor.node.nodeValue!.length - 1;
            }
          }
        } else if (!_$isTextNode) {
          anchor.node = anchorNode.childNodes[anchorOffset - 1];
          anchor.offset = anchor.node.nodeValue!.length - 1;
        } else {
          anchor.offset--;
        }
      } else {
        if (
          (_$isTextNode && anchorOffset === anchorNode.textContent!.length) ||
          (!_$isTextNode &&
            (anchorNode.childNodes.length === anchorOffset ||
              (anchorNode.childNodes.length === 1 &&
                anchorNode.firstChild!.nodeName === 'BR')))
        ) {
          let nextSibling =
            anchorNode.nextSibling ??
            anchorNode.parentElement!.nextSibling!.lastChild!;

          if (nextSibling.nodeName === 'P') {
            nextSibling = nextSibling.lastChild!;
          }

          if (nextSibling.nodeName === 'BR') {
            anchor.node = nextSibling;
            anchor.offset = 0;
          } else {
            anchor.node = nextSibling.firstChild!;
            anchor.offset = 0;
          }
        } else {
          anchor.offset++;
        }
      }
    } else if (granularity === 'word') {
      const anchorNode = this.anchorNode!;
      const targetTextContent =
        direction === 'backward'
          ? anchorNode.textContent!.slice(0, this.anchorOffset)
          : anchorNode.textContent!.slice(this.anchorOffset);
      const segments = getWordsFromString(targetTextContent);
      const segmentsLength = segments.length;
      let index = anchor.offset;
      let foundWordNode = false;

      if (direction === 'backward') {
        for (let i = segmentsLength - 1; i >= 0; i--) {
          const segment = segments[i];
          const nextIndex = segment.index;

          if (segment.isWordLike) {
            index = nextIndex;
            foundWordNode = true;
          } else if (foundWordNode) {
            break;
          } else {
            index = nextIndex;
          }
        }
      } else {
        for (let i = 0; i < segmentsLength; i++) {
          const segment = segments[i];
          const nextIndex = segment.index + segment.segment.length;

          if (segment.isWordLike) {
            index = nextIndex;
            foundWordNode = true;
          } else if (foundWordNode) {
            break;
          } else {
            index = nextIndex;
          }
        }
      }

      if (direction === 'forward') {
        index += anchor.offset;
      }

      anchor.offset = index;
    }

    if (alter === 'move') {
      focus.offset = anchor.offset;
      focus.node = anchor.node;
    }
    this.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  };
}

export function printWhitespace(whitespaceCharacter: string) {
  return whitespaceCharacter.charCodeAt(0) === 160
    ? '&nbsp;'
    : whitespaceCharacter;
}

export function insertText(text: string) {
  return {
    text,
    type: 'insert_text',
  };
}

export function insertTokenNode(text: string) {
  return {
    text,
    type: 'insert_token_node',
  };
}

export function insertSegmentedNode(text: string) {
  return {
    text,
    type: 'insert_segmented_node',
  };
}

export function convertToTokenNode() {
  return {
    text: null,
    type: 'convert_to_token_node',
  };
}

export function convertToSegmentedNode() {
  return {
    text: null,
    type: 'convert_to_segmented_node',
  };
}

export function insertParagraph() {
  return {
    type: 'insert_paragraph',
  };
}

export function deleteWordBackward(n: number | null | undefined) {
  return {
    text: null,
    times: n,
    type: 'delete_word_backward',
  };
}

export function deleteWordForward(n: number | null | undefined) {
  return {
    text: null,
    times: n,
    type: 'delete_word_forward',
  };
}

export function moveBackward(n: number | null | undefined) {
  return {
    text: null,
    times: n,
    type: 'move_backward',
  };
}

export function moveForward(n: number | null | undefined) {
  return {
    text: null,
    times: n,
    type: 'move_forward',
  };
}

export function moveEnd() {
  return {
    type: 'move_end',
  };
}

export function deleteBackward(n: number | null | undefined) {
  return {
    text: null,
    times: n,
    type: 'delete_backward',
  };
}

export function deleteForward(n: number | null | undefined) {
  return {
    text: null,
    times: n,
    type: 'delete_forward',
  };
}

export function formatBold() {
  return {
    format: 'bold',
    type: 'format_text',
  };
}

export function formatItalic() {
  return {
    format: 'italic',
    type: 'format_text',
  };
}

export function formatStrikeThrough() {
  return {
    format: 'strikethrough',
    type: 'format_text',
  };
}

export function formatUnderline() {
  return {
    format: 'underline',
    type: 'format_text',
  };
}

export function redo(n: number | null | undefined) {
  return {
    text: null,
    times: n,
    type: 'redo',
  };
}

export function undo(n: number | null | undefined) {
  return {
    text: null,
    times: n,
    type: 'undo',
  };
}

export function pastePlain(text: string) {
  return {
    text: text,
    type: 'paste_plain',
  };
}

export function pasteLexical(text: string) {
  return {
    text: text,
    type: 'paste_lexical',
  };
}

export function pasteHTML(text: string) {
  return {
    text: text,
    type: 'paste_html',
  };
}

export function moveNativeSelection(
  anchorPath: number[],
  anchorOffset: number,
  focusPath: number[],
  focusOffset: number,
) {
  return {
    anchorOffset,
    anchorPath,
    focusOffset,
    focusPath,
    type: 'move_native_selection',
  };
}

export function getNodeFromPath(path: number[], rootElement: Node) {
  let node = rootElement;

  for (let i = 0; i < path.length; i++) {
    node = node.childNodes[path[i]];
  }

  return node;
}

export function setNativeSelection(
  anchorNode: Node,
  anchorOffset: number,
  focusNode: Node,
  focusOffset: number,
) {
  const domSelection = window.getSelection()!;
  const range = document.createRange();
  range.setStart(anchorNode, anchorOffset);
  range.setEnd(focusNode, focusOffset);
  domSelection.removeAllRanges();
  domSelection.addRange(range);
  Promise.resolve().then(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

export function setNativeSelectionWithPaths(
  rootElement: Node,
  anchorPath: number[],
  anchorOffset: number,
  focusPath: number[],
  focusOffset: number,
) {
  const anchorNode = getNodeFromPath(anchorPath, rootElement);
  const focusNode = getNodeFromPath(focusPath, rootElement);
  setNativeSelection(anchorNode, anchorOffset, focusNode, focusOffset);
}

function getLastTextNode(startingNode: Node) {
  let node = startingNode;

  mainLoop: while (node !== null) {
    if (node !== startingNode && node.nodeType === 3) {
      return node;
    }

    const child = node.lastChild;

    if (child !== null) {
      node = child;
      continue;
    }

    const previousSibling = node.previousSibling;

    if (previousSibling !== null) {
      node = previousSibling;
      continue;
    }

    let parent = node.parentNode;

    while (parent !== null) {
      const parentSibling = parent.previousSibling;

      if (parentSibling !== null) {
        node = parentSibling;
        continue mainLoop;
      }

      parent = parent.parentNode;
    }
  }

  return null;
}

function getNextTextNode(startingNode: Node) {
  let node = startingNode;

  mainLoop: while (node !== null) {
    if (node !== startingNode && node.nodeType === 3) {
      return node;
    }

    const child = node.firstChild;

    if (child !== null) {
      node = child;
      continue;
    }

    const nextSibling = node.nextSibling;

    if (nextSibling !== null) {
      node = nextSibling;
      continue;
    }

    let parent = node.parentNode;

    while (parent !== null) {
      const parentSibling = parent.nextSibling;

      if (parentSibling !== null) {
        node = parentSibling;
        continue mainLoop;
      }

      parent = parent.parentNode;
    }
  }

  return null;
}

function moveNativeSelectionBackward() {
  const domSelection = window.getSelection()!;
  let anchorNode = domSelection.anchorNode!;
  let anchorOffset = domSelection.anchorOffset!;

  if (domSelection.isCollapsed) {
    const target = (
      anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentNode
    )!;
    const keyDownEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowLeft',
      keyCode: 37,
    });
    target.dispatchEvent(keyDownEvent);

    if (!keyDownEvent.defaultPrevented) {
      if (anchorNode.nodeType === 3) {
        if (anchorOffset === 0) {
          const lastTextNode = getLastTextNode(anchorNode);

          if (lastTextNode === null) {
            throw new Error('moveNativeSelectionBackward: TODO');
          } else {
            const textLength = lastTextNode.nodeValue!.length;
            setNativeSelection(
              lastTextNode,
              textLength,
              lastTextNode,
              textLength,
            );
          }
        } else {
          setNativeSelection(
            anchorNode,
            anchorOffset - 1,
            anchorNode,
            anchorOffset - 1,
          );
        }
      } else if (anchorNode.nodeType === 1) {
        if (anchorNode.nodeName === 'BR') {
          const parentNode = anchorNode.parentNode!;
          const childNodes = Array.from(parentNode.childNodes);
          anchorOffset = childNodes.indexOf(anchorNode as ChildNode);
          anchorNode = parentNode;
        } else {
          anchorOffset--;
        }

        setNativeSelection(anchorNode, anchorOffset, anchorNode, anchorOffset);
      } else {
        throw new Error('moveNativeSelectionBackward: TODO');
      }
    }

    const keyUpEvent = new KeyboardEvent('keyup', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowLeft',
      keyCode: 37,
    });
    target.dispatchEvent(keyUpEvent);
  } else {
    throw new Error('moveNativeSelectionBackward: TODO');
  }
}

function moveNativeSelectionForward() {
  const domSelection = window.getSelection()!;
  const anchorNode = domSelection.anchorNode!;
  const anchorOffset = domSelection.anchorOffset!;

  if (domSelection.isCollapsed) {
    const target = (
      anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentNode
    )!;
    const keyDownEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowRight',
      keyCode: 39,
    });
    target.dispatchEvent(keyDownEvent);

    if (!keyDownEvent.defaultPrevented) {
      if (anchorNode.nodeType === 3) {
        const text = anchorNode.nodeValue!;

        if (text.length === anchorOffset) {
          const nextTextNode = getNextTextNode(anchorNode);

          if (nextTextNode === null) {
            throw new Error('moveNativeSelectionForward: TODO');
          } else {
            setNativeSelection(nextTextNode, 0, nextTextNode, 0);
          }
        } else {
          setNativeSelection(
            anchorNode,
            anchorOffset + 1,
            anchorNode,
            anchorOffset + 1,
          );
        }
      } else {
        throw new Error('moveNativeSelectionForward: TODO');
      }
    }

    const keyUpEvent = new KeyboardEvent('keyup', {
      bubbles: true,
      cancelable: true,
      key: 'ArrowRight',
      keyCode: 39,
    });
    target.dispatchEvent(keyUpEvent);
  } else {
    throw new Error('moveNativeSelectionForward: TODO');
  }
}

export async function applySelectionInputs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputs: Record<string, any>[],
  update: (fn: () => void) => Promise<void>,
  editor: LexicalEditor,
) {
  const rootElement = editor.getRootElement()!;

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const times = input?.times ?? 1;

    for (let j = 0; j < times; j++) {
      await update(() => {
        const selection = $getSelection()!;

        switch (input.type) {
          case 'insert_text': {
            selection.insertText(input.text);
            break;
          }

          case 'insert_paragraph': {
            if ($isRangeSelection(selection)) {
              selection.insertParagraph();
            }
            break;
          }

          case 'move_backward': {
            moveNativeSelectionBackward();
            break;
          }

          case 'move_forward': {
            moveNativeSelectionForward();
            break;
          }

          case 'move_end': {
            if ($isRangeSelection(selection)) {
              const anchorNode = selection.anchor.getNode();
              if ($isTextNode(anchorNode)) {
                anchorNode.select();
              }
            }
            break;
          }

          case 'delete_backward': {
            if ($isRangeSelection(selection)) {
              selection.deleteCharacter(true);
            }
            break;
          }

          case 'delete_forward': {
            if ($isRangeSelection(selection)) {
              selection.deleteCharacter(false);
            }
            break;
          }

          case 'delete_word_backward': {
            if ($isRangeSelection(selection)) {
              selection.deleteWord(true);
            }
            break;
          }

          case 'delete_word_forward': {
            if ($isRangeSelection(selection)) {
              selection.deleteWord(false);
            }
            break;
          }

          case 'format_text': {
            if ($isRangeSelection(selection)) {
              selection.formatText(input.format);
            }
            break;
          }

          case 'move_native_selection': {
            setNativeSelectionWithPaths(
              rootElement,
              input.anchorPath,
              input.anchorOffset,
              input.focusPath,
              input.focusOffset,
            );
            break;
          }

          case 'insert_token_node': {
            const text = $createTextNode(input.text);
            text.setMode('token');
            if ($isRangeSelection(selection)) {
              selection.insertNodes([text]);
            }
            break;
          }

          case 'insert_segmented_node': {
            const text = $createTextNode(input.text);
            text.setMode('segmented');
            if ($isRangeSelection(selection)) {
              selection.insertNodes([text]);
            }
            text.selectNext();
            break;
          }

          case 'convert_to_token_node': {
            const text = $createTextNode(selection.getTextContent());
            text.setMode('token');
            if ($isRangeSelection(selection)) {
              selection.insertNodes([text]);
            }
            text.selectNext();
            break;
          }

          case 'convert_to_segmented_node': {
            const text = $createTextNode(selection.getTextContent());
            text.setMode('segmented');
            if ($isRangeSelection(selection)) {
              selection.insertNodes([text]);
            }
            text.selectNext();
            break;
          }

          case 'undo': {
            rootElement.dispatchEvent(
              new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                ctrlKey: true,
                key: 'z',
                keyCode: 90,
              }),
            );
            break;
          }

          case 'redo': {
            rootElement.dispatchEvent(
              new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                ctrlKey: true,
                key: 'z',
                keyCode: 90,
                shiftKey: true,
              }),
            );
            break;
          }

          case 'paste_plain': {
            rootElement.dispatchEvent(
              Object.assign(
                new Event('paste', {
                  bubbles: true,
                  cancelable: true,
                }),
                {
                  clipboardData: {
                    getData: (type: string) => {
                      if (type === 'text/plain') {
                        return input.text;
                      }

                      return '';
                    },
                  },
                },
              ),
            );
            break;
          }

          case 'paste_lexical': {
            rootElement.dispatchEvent(
              Object.assign(
                new Event('paste', {
                  bubbles: true,
                  cancelable: true,
                }),
                {
                  clipboardData: {
                    getData: (type: string) => {
                      if (type === 'application/x-lexical-editor') {
                        return input.text;
                      }

                      return '';
                    },
                  },
                },
              ),
            );
            break;
          }

          case 'paste_html': {
            rootElement.dispatchEvent(
              Object.assign(
                new Event('paste', {
                  bubbles: true,
                  cancelable: true,
                }),
                {
                  clipboardData: {
                    getData: (type: string) => {
                      if (type === 'text/html') {
                        return input.text;
                      }

                      return '';
                    },
                  },
                },
              ),
            );
            break;
          }
        }
      });
    }
  }
}

export function $setAnchorPoint(
  point: Pick<PointType, 'type' | 'offset' | 'key'>,
) {
  const selection = $getSelection();

  if (!$isRangeSelection(selection)) {
    const dummyTextNode = $createTextNode();
    dummyTextNode.select();
    return $setAnchorPoint(point);
  }

  if ($isNodeSelection(selection)) {
    return;
  }

  selection.anchor.set(point.key, point.offset, point.type);
}

export function $setFocusPoint(
  point: Pick<PointType, 'type' | 'offset' | 'key'>,
) {
  const selection = $getSelection();

  if (!$isRangeSelection(selection)) {
    const dummyTextNode = $createTextNode();
    dummyTextNode.select();
    return $setFocusPoint(point);
  }

  if ($isNodeSelection(selection)) {
    return;
  }

  selection.focus.set(point.key, point.offset, point.type);
}
