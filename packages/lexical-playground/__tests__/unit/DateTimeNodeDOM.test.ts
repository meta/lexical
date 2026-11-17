/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $getRoot,
  defineExtension,
  isHTMLElement,
  type LexicalEditor,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

import {
  $createDateTimeNode,
  $isDateTimeNode,
  DateTimeNode,
} from '../../src/nodes/DateTimeNode/DateTimeNode';

const FIRST = new Date('2026-11-16T04:45:07.891Z');
const SECOND = new Date('2026-11-20T16:02:03.456Z');

const DateTimeTestExtension = defineExtension({
  $initialEditorState: () => {
    $getRoot()
      .clear()
      .append($createParagraphNode().append($createDateTimeNode(FIRST)));
  },
  afterRegistration: editor => {
    editor.setRootElement(document.createElement('div'));
    return () => editor.setRootElement(null);
  },
  dependencies: [RichTextExtension],
  name: '[test-datetime]',
  nodes: [DateTimeNode],
});

function getDateTimeElement(editor: LexicalEditor): Element {
  const rootElement = editor.getRootElement();
  assert(isHTMLElement(rootElement), 'editor must have a root element');
  const dom = rootElement.querySelector('[data-lexical-datetime]');
  assert(dom !== null, 'expected a DateTimeNode element');
  return dom;
}

describe('DateTimeNode data-lexical-datetime', () => {
  it('writes the date as an ISO string', () => {
    using editor = buildEditorFromExtensions(DateTimeTestExtension);
    expect(
      getDateTimeElement(editor).getAttribute('data-lexical-datetime'),
    ).toBe(FIRST.toISOString());
  });

  it('updates the attribute when the date changes or the old state is restored', () => {
    using editor = buildEditorFromExtensions(DateTimeTestExtension);
    const dom = getDateTimeElement(editor);
    const before = editor.getEditorState();
    editor.update(
      () => {
        const node = $getRoot().getFirstDescendant();
        assert($isDateTimeNode(node), 'expected a DateTimeNode');
        node.setDateTime(SECOND);
      },
      {discrete: true},
    );
    expect(getDateTimeElement(editor)).toBe(dom);
    expect(dom.getAttribute('data-lexical-datetime')).toBe(
      SECOND.toISOString(),
    );

    // Undo and redo in @lexical/history apply an earlier state this way
    editor.setEditorState(before);
    expect(getDateTimeElement(editor)).toBe(dom);
    expect(dom.getAttribute('data-lexical-datetime')).toBe(FIRST.toISOString());
  });

  it('writes an empty attribute for a node without a date', () => {
    using editor = buildEditorFromExtensions(DateTimeTestExtension);
    editor.update(
      () => {
        const node = $getRoot().getFirstDescendant();
        assert($isDateTimeNode(node), 'expected a DateTimeNode');
        node.replace(new DateTimeNode());
      },
      {discrete: true},
    );

    expect(
      getDateTimeElement(editor).getAttribute('data-lexical-datetime'),
    ).toBe('');
    expect(editor.read(() => $generateHtmlFromNodes(editor, null))).toContain(
      'data-lexical-datetime=""',
    );
  });
});
