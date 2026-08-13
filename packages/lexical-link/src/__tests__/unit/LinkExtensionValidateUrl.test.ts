/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$isLinkNode, LinkExtension, TOGGLE_LINK_COMMAND} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  $isTextNode,
  configExtension,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, it} from 'vitest';

const ALLOWED = 'https://lexical.dev/';
// Rejected by the configured policy below (https-only), which is the shape
// most validateUrl implementations take: an allowlist, not a scheme blocklist.
const REJECTED = 'http://not-allowed.example.com/';

function makeExtension(validateUrl?: (url: string) => boolean) {
  return defineExtension({
    $initialEditorState: () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode('Hello'));
      $getRoot().append(paragraph);
    },
    dependencies: [
      configExtension(
        LinkExtension,
        validateUrl === undefined ? {} : {validateUrl},
      ),
      RichTextExtension,
    ],
    name: '[root-validate-url]',
  });
}

function $selectHello(): void {
  const textNode = $assertNodeType($getRoot().getLastDescendant(), $isTextNode);
  textNode.select(0, textNode.getTextContentSize());
}

function $hasLink(): boolean {
  const paragraph = $assertNodeType(
    $getRoot().getFirstChild(),
    $isParagraphNode,
  );
  return $isLinkNode(paragraph.getFirstChild());
}

/**
 * Dispatch the given payload over a selection of "Hello" and report whether
 * the command claimed it and whether a LinkNode was actually produced.
 */
function toggleLink(
  payload: string | {url: string},
  validateUrl?: (url: string) => boolean,
): {handled: boolean; linked: boolean} {
  using editor = buildEditorFromExtensions(makeExtension(validateUrl));
  let handled = false;
  editor.update(
    () => {
      $selectHello();
      handled = editor.dispatchCommand(TOGGLE_LINK_COMMAND, payload);
    },
    {discrete: true},
  );
  return {handled, linked: editor.read($hasLink)};
}

const isHttps = (url: string) => url.startsWith('https://');

describe('LinkExtension validateUrl', () => {
  it('rejects a URL the validator refuses, for an object payload', () => {
    expect(toggleLink({url: REJECTED}, isHttps)).toEqual({
      handled: false,
      linked: false,
    });
  });

  it('rejects a URL the validator refuses, for a string payload', () => {
    expect(toggleLink(REJECTED, isHttps)).toEqual({
      handled: false,
      linked: false,
    });
  });

  it('accepts a URL the validator allows, for an object payload', () => {
    expect(toggleLink({url: ALLOWED}, isHttps)).toEqual({
      handled: true,
      linked: true,
    });
  });

  it('accepts any URL when no validator is configured', () => {
    expect(toggleLink({url: REJECTED})).toEqual({handled: true, linked: true});
    expect(toggleLink(REJECTED)).toEqual({handled: true, linked: true});
  });
});
