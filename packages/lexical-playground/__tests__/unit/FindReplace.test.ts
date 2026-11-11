/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import invariant from '@lexical/internal/invariant';
import {$createLinkNode, $isLinkNode, LinkExtension} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSlot,
  DecoratorNode,
  defineExtension,
  IS_BOLD,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $buildOffsetMap,
  $replaceAllMatches,
  $replaceMatch,
  $resolveMatchToPoints,
  CLOSE_FIND_REPLACE_COMMAND,
  expandReplacement,
  FIND_NEXT_COMMAND,
  FIND_PREV_COMMAND,
  findMatches,
  FindReplaceExtension,
  REPLACE_ALL_COMMAND,
  REPLACE_CURRENT_COMMAND,
  SET_SEARCH_TERM_COMMAND,
  TOGGLE_CASE_SENSITIVE_COMMAND,
  TOGGLE_FIND_REPLACE_COMMAND,
  TOGGLE_REGEX_COMMAND,
} from '../../src/plugins/FindReplaceExtension';

class TestDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test-decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): false {
    return false;
  }
  getTextContent(): string {
    return 'URL';
  }
}

function $createTestDecoratorNode(): TestDecoratorNode {
  return $create(TestDecoratorNode);
}

class SlotDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('slot-decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): false {
    return false;
  }
}
function $createSlotDecoratorNode(): SlotDecoratorNode {
  return $create(SlotDecoratorNode);
}

const TestExtension = defineExtension({
  dependencies: [RichTextExtension, ListExtension, LinkExtension],
  name: '[test-find-replace]',
  nodes: [TestDecoratorNode, SlotDecoratorNode],
});

describe('findMatches', () => {
  test.for([
    {
      caseSensitive: false,
      expected: [],
      isRegex: false,
      label: 'empty search term',
      term: '',
      text: 'hello world',
    },
    {
      caseSensitive: false,
      expected: [],
      isRegex: false,
      label: 'empty text',
      term: 'hello',
      text: '',
    },
    {
      caseSensitive: false,
      expected: [{end: 11, matchText: 'world', start: 6}],
      isRegex: false,
      label: 'single match with matchText',
      term: 'world',
      text: 'hello world',
    },
    {
      caseSensitive: false,
      expected: [
        {end: 3, matchText: 'foo', start: 0},
        {end: 11, matchText: 'foo', start: 8},
        {end: 19, matchText: 'foo', start: 16},
      ],
      isRegex: false,
      label: 'multiple non-overlapping matches',
      term: 'foo',
      text: 'foo bar foo baz foo',
    },
    {
      caseSensitive: false,
      expected: [
        {end: 5, matchText: 'Hello', start: 0},
        {end: 11, matchText: 'HELLO', start: 6},
        {end: 17, matchText: 'hello', start: 12},
      ],
      isRegex: false,
      label: 'case-insensitive preserves original case in matchText',
      term: 'hello',
      text: 'Hello HELLO hello',
    },
    {
      caseSensitive: true,
      expected: [{end: 17, matchText: 'hello', start: 12}],
      isRegex: false,
      label: 'case-sensitive search',
      term: 'hello',
      text: 'Hello HELLO hello',
    },
    {
      caseSensitive: false,
      expected: [
        {end: 6, matchText: '123', start: 3},
        {end: 12, matchText: '456', start: 9},
      ],
      isRegex: true,
      label: 'regex: basic pattern',
      term: '\\d+',
      text: 'foo123bar456',
    },
    {
      caseSensitive: false,
      expected: [{end: 7, matchText: '2026-07', start: 0}],
      isRegex: true,
      label: 'regex: with groups uses full match range',
      term: '(\\d{4})-(\\d{2})',
      text: '2026-07-03',
    },
    {
      caseSensitive: false,
      expected: [],
      isRegex: true,
      label: 'regex: invalid regex returns empty',
      term: '[invalid',
      text: 'hello',
    },
    {
      caseSensitive: false,
      expected: [{end: 15, matchText: '$10.00', start: 9}],
      isRegex: false,
      label: 'non-regex escapes special characters',
      term: '$10.00',
      text: 'price is $10.00',
    },
    {
      caseSensitive: false,
      expected: [{end: 3, matchText: 'abc', start: 0}],
      isRegex: false,
      label: 'matches at string boundaries',
      term: 'abc',
      text: 'abc',
    },
    {
      caseSensitive: false,
      expected: [{end: 5, matchText: 'hello', start: 0}],
      isRegex: false,
      label: 'matches at start of string',
      term: 'hello',
      text: 'hello world',
    },
    {
      caseSensitive: false,
      expected: [],
      isRegex: false,
      label: 'no match returns empty',
      term: 'xyz',
      text: 'hello world',
    },
    {
      caseSensitive: false,
      expected: [],
      isRegex: true,
      label: 'skips zero-length regex matches',
      term: '(?=a)',
      text: 'abc',
    },
  ])('$label', ({text, term, caseSensitive, isRegex, expected}) => {
    expect(findMatches(text, term, caseSensitive, isRegex)).toEqual(expected);
  });
});

describe('findMatches — zero-length regex edge cases', () => {
  test.for([
    {
      expected: [{end: 3, matchText: 'abc', start: 0}],
      label: '.* matches entire text as single match',
      term: '.*',
      text: 'abc',
    },
    {
      expected: [
        {end: 2, matchText: 'aa', start: 0},
        {end: 5, matchText: 'aa', start: 3},
      ],
      label: 'a* matches non-empty runs only',
      term: 'a*',
      text: 'aabaa',
    },
    {
      expected: [],
      label: 'x? on text without x returns no matches',
      term: 'x?',
      text: 'abc',
    },
  ])('$label', ({text, term, expected}) => {
    expect(findMatches(text, term, false, true)).toEqual(expected);
  });
});

describe('expandReplacement', () => {
  test.for([
    {
      expected: '$1',
      label: 'returns template as-is when no regex',
      matchText: 'foo',
      regex: null,
      template: '$1',
    },
    {
      expected: '2026-07',
      label: 'expands $1/$2 capture groups',
      matchText: '2026-07',
      regex: /(\d{4})-(\d{2})/,
      template: '$1-$2',
    },
    {
      expected: 'year=2026',
      label: 'expands named capture groups with different template',
      matchText: '2026-07',
      regex: /(\d{4})-(\d{2})/,
      template: 'year=$1',
    },
    {
      expected: '[foo]',
      label: 'expands $& for full match',
      matchText: 'foo',
      regex: /foo/,
      template: '[$&]',
    },
    {
      expected: 'host/user',
      label: 'swaps groups',
      matchText: 'user@host',
      regex: /(\w+)@(\w+)/,
      template: '$2/$1',
    },
    {
      expected: '$1',
      label: 'literal $1 with no groups in regex',
      matchText: 'hello',
      regex: /hello/,
      template: '$1',
    },
  ])('$label', ({template, matchText, regex, expected}) => {
    expect(expandReplacement(template, matchText, regex)).toBe(expected);
  });
});

describe('$buildOffsetMap', () => {
  test('maps single paragraph with one TextNode', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('hello'));
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    const map = editor.read(() => $buildOffsetMap());
    expect(map).toHaveLength(1);
    expect(map[0].globalStart).toBe(0);
    expect(map[0].globalEnd).toBe(5);
  });

  test('maps paragraph with multiple TextNodes (bold boundary)', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        const plain = $createTextNode('hel');
        const bold = $createTextNode('lo');
        bold.setFormat(IS_BOLD);
        p.append(plain, bold);
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    const map = editor.read(() => $buildOffsetMap());
    expect(map).toHaveLength(2);
    expect(map[0].globalStart).toBe(0);
    expect(map[0].globalEnd).toBe(3);
    expect(map[1].globalStart).toBe(3);
    expect(map[1].globalEnd).toBe(5);
  });

  test('maps across multiple paragraphs with double line break offset', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p1 = $createParagraphNode();
        p1.append($createTextNode('abc'));
        const p2 = $createParagraphNode();
        p2.append($createTextNode('def'));
        $getRoot().clear().append(p1, p2);
      },
      {discrete: true},
    );
    const map = editor.read(() => $buildOffsetMap());
    expect(map).toHaveLength(2);
    expect(map[0]).toMatchObject({globalEnd: 3, globalStart: 0});
    expect(map[1]).toMatchObject({globalEnd: 8, globalStart: 5});
  });

  test('maps one block node inside a slot without extra offset', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const host = $createParagraphNode();
        const slotP = $createParagraphNode();
        slotP.append($createTextNode('hello'));
        $setSlot(host, 'mySlot', slotP);
        $getRoot().clear().append(host);
      },
      {discrete: true},
    );
    const result = editor.read(() => {
      const map = $buildOffsetMap();
      const text = $getRoot().getTextContent();
      return {map, text};
    });
    expect(result.map).toHaveLength(1);
    expect(result.map[0]).toMatchObject({globalEnd: 5, globalStart: 0});
    expect(result.text).toBe('hello');
  });

  test('maps multiple block slots without extra offset between them', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot1 = $createParagraphNode();
        slot1.append($createTextNode('abc'));
        const slot2 = $createParagraphNode();
        slot2.append($createTextNode('def'));
        $setSlot(host, 'slot1', slot1);
        $setSlot(host, 'slot2', slot2);
        $getRoot().clear().append(host);
      },
      {discrete: true},
    );
    const result = editor.read(() => {
      const map = $buildOffsetMap();
      const text = $getRoot().getTextContent();
      return {map, text};
    });
    expect(result.map).toHaveLength(2);
    expect(result.map[0]).toMatchObject({globalEnd: 3, globalStart: 0});
    expect(result.map[1]).toMatchObject({globalEnd: 6, globalStart: 3});
    expect(result.text).toBe('abcdef');
  });

  test('maps slot content followed by normal children without extra offset', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const host = $createParagraphNode();
        const slot = $createParagraphNode();
        slot.append($createTextNode('slot'));
        $setSlot(host, 'mySlot', slot);
        host.append($createTextNode('child'));
        $getRoot().clear().append(host);
      },
      {discrete: true},
    );
    const result = editor.read(() => {
      const map = $buildOffsetMap();
      const text = $getRoot().getTextContent();
      return {map, text};
    });
    expect(result.map).toHaveLength(2);
    expect(result.map[0]).toMatchObject({globalEnd: 4, globalStart: 0});
    expect(result.map[1]).toMatchObject({globalEnd: 9, globalStart: 4});
    expect(result.text).toBe('slotchild');
  });
  test('maps across DecoratorNode without extra offset loss', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p1 = $createParagraphNode();
        p1.append($createTextNode('A'));
        const dec = $createTestDecoratorNode();
        const p2 = $createParagraphNode();
        p2.append($createTextNode('B'));
        $getRoot().clear().append(p1, dec, p2);
      },
      {discrete: true},
    );
    const result = editor.read(() => {
      const map = $buildOffsetMap();
      const text = $getRoot().getTextContent();
      return {map, text};
    });
    expect(result.map).toHaveLength(2);
    expect(result.map[0]).toMatchObject({globalEnd: 1, globalStart: 0});
    expect(result.map[1]).toMatchObject({globalEnd: 7, globalStart: 6});
    expect(result.text).toBe('A\n\nURLB');
  });

  test('maps across DecoratorNode with block slot content without extra offset loss', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p1 = $createParagraphNode();
        p1.append($createTextNode('A'));
        const dec = $createSlotDecoratorNode();
        const slotP = $createParagraphNode();
        slotP.append($createTextNode('S'));
        $setSlot(dec, 'mySlot', slotP);
        const p2 = $createParagraphNode();
        p2.append($createTextNode('B'));
        $getRoot().clear().append(p1, dec, p2);
      },
      {discrete: true},
    );
    const result = editor.read(() => {
      const map = $buildOffsetMap();
      const text = $getRoot().getTextContent();
      return {map, text};
    });
    expect(result.map).toHaveLength(3);
    expect(result.map[0]).toMatchObject({globalEnd: 1, globalStart: 0});
    expect(result.map[1]).toMatchObject({globalEnd: 4, globalStart: 3}); // S
    expect(result.map[2]).toMatchObject({globalEnd: 5, globalStart: 4}); // B
    expect(result.text).toBe('A\n\nSB');
  });

  test('handles empty editor', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    const map = editor.read(() => $buildOffsetMap());
    expect(map).toEqual([]);
  });

  test('accounts for LineBreakNode in offset calculation', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append(
          $createTextNode('hello'),
          $createLineBreakNode(),
          $createTextNode('world'),
        );
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    const result = editor.read(() => {
      const map = $buildOffsetMap();
      const text = $getRoot().getTextContent();
      return {map, text};
    });
    expect(result.text).toBe('hello\nworld');
    expect(result.map).toHaveLength(2);
    expect(result.map[0]).toMatchObject({globalEnd: 5, globalStart: 0});
    expect(result.map[1]).toMatchObject({globalEnd: 11, globalStart: 6});
  });

  test('handles empty paragraph between text paragraphs', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p1 = $createParagraphNode();
        p1.append($createTextNode('abc'));
        const p2 = $createParagraphNode();
        const p3 = $createParagraphNode();
        p3.append($createTextNode('def'));
        $getRoot().clear().append(p1, p2, p3);
      },
      {discrete: true},
    );
    const result = editor.read(() => {
      const map = $buildOffsetMap();
      const text = $getRoot().getTextContent();
      return {map, text};
    });
    expect(result.text).toBe('abc\n\n\n\ndef');
    expect(result.map).toHaveLength(2);
    expect(result.map[0]).toMatchObject({globalEnd: 3, globalStart: 0});
    expect(result.map[1]).toMatchObject({globalEnd: 10, globalStart: 7});
  });

  test('maps list items without extra offset for parent→child', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('before'));
        const list = $createListNode('bullet');
        list.append(
          $createListItemNode().append($createTextNode('aaa')),
          $createListItemNode().append($createTextNode('bbb')),
        );
        $getRoot().clear().append(p, list);
      },
      {discrete: true},
    );
    const result = editor.read(() => {
      const map = $buildOffsetMap();
      const text = $getRoot().getTextContent();
      return {map, text};
    });
    expect(result.text).toBe('before\n\naaa\n\nbbb');
    expect(result.map).toHaveLength(3);
    expect(result.map[0]).toMatchObject({globalEnd: 6, globalStart: 0});
    expect(result.map[1]).toMatchObject({globalEnd: 11, globalStart: 8});
    expect(result.map[2]).toMatchObject({globalEnd: 16, globalStart: 13});
  });
});

describe('$resolveMatchToPoints', () => {
  test('single-node match returns correct points with format', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        const text = $createTextNode('hello world');
        text.setFormat(IS_BOLD);
        p.append(text);
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    const result = editor.read(() => {
      const map = $buildOffsetMap();
      return $resolveMatchToPoints({end: 5, matchText: 'hello', start: 0}, map);
    });
    invariant(result !== null, 'expected non-null match points');
    expect(result.anchorKey).toBe(result.focusKey);
    expect(result.anchorOffset).toBe(0);
    expect(result.focusOffset).toBe(5);
    expect(result.format).toBe(IS_BOLD);
  });

  test('cross-node match returns different keys with format 0', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        const plain = $createTextNode('hel');
        const bold = $createTextNode('lo');
        bold.setFormat(IS_BOLD);
        p.append(plain, bold);
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    const result = editor.read(() => {
      const map = $buildOffsetMap();
      return $resolveMatchToPoints({end: 5, matchText: 'hello', start: 0}, map);
    });
    invariant(result !== null, 'expected non-null match points');
    expect(result.anchorKey).not.toBe(result.focusKey);
    expect(result.anchorOffset).toBe(0);
    expect(result.focusOffset).toBe(2);
    expect(result.format).toBe(0);
  });

  test('match falling in paragraph boundary gap returns null', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p1 = $createParagraphNode();
        p1.append($createTextNode('abc'));
        const p2 = $createParagraphNode();
        p2.append($createTextNode('def'));
        $getRoot().clear().append(p1, p2);
      },
      {discrete: true},
    );
    const result = editor.read(() => {
      const map = $buildOffsetMap();
      return $resolveMatchToPoints(
        {end: 5, matchText: 'c\n\nd', start: 3},
        map,
      );
    });
    expect(result).toBeNull();
  });
});

describe('$replaceMatch', () => {
  test('single-node replace preserves text format', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        const text = $createTextNode('hello world');
        text.setFormat(IS_BOLD);
        p.append(text);
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const map = $buildOffsetMap();
        const match = {end: 5, matchText: 'hello', start: 0};
        const points = $resolveMatchToPoints(match, map);
        invariant(points !== null, 'expected non-null match points');
        $replaceMatch(points, 'goodbye', match, null);
      },
      {discrete: true},
    );
    editor.read(() => {
      const text = $getRoot().getTextContent();
      expect(text).toBe('goodbye world');
      const p = $getRoot().getFirstChild();
      invariant($isElementNode(p), 'expected ElementNode');
      const firstChild = p.getFirstChild();
      invariant($isTextNode(firstChild), 'expected TextNode');
      expect(firstChild.getFormat()).toBe(IS_BOLD);
    });
  });

  test('multi-node replace produces plain text', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        const plain = $createTextNode('hel');
        const bold = $createTextNode('lo');
        bold.setFormat(IS_BOLD);
        p.append(plain, bold);
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const map = $buildOffsetMap();
        const match = {end: 5, matchText: 'hello', start: 0};
        const points = $resolveMatchToPoints(match, map);
        invariant(points !== null, 'expected non-null match points');
        $replaceMatch(points, 'hi', match, null);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('hi');
    });
  });

  test('replace with empty string deletes match', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('hello world'));
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const map = $buildOffsetMap();
        const match = {end: 6, matchText: 'hello ', start: 0};
        const points = $resolveMatchToPoints(match, map);
        invariant(points !== null, 'expected non-null match points');
        $replaceMatch(points, '', match, null);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('world');
    });
  });

  test('regex capture group replacement with $1/$2', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('user@host'));
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const map = $buildOffsetMap();
        const match = {end: 9, matchText: 'user@host', start: 0};
        const points = $resolveMatchToPoints(match, map);
        invariant(points !== null, 'expected non-null match points');
        $replaceMatch(points, '$2/$1', match, /(\w+)@(\w+)/);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('host/user');
    });
  });

  test('non-regex mode ignores $1 in replacement', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('hello world'));
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const map = $buildOffsetMap();
        const match = {end: 5, matchText: 'hello', start: 0};
        const points = $resolveMatchToPoints(match, map);
        invariant(points !== null, 'expected non-null match points');
        $replaceMatch(points, '$1', match, null);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('$1 world');
    });
  });

  test('single-node replace inside LinkNode preserves link', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        const link = $createLinkNode('https://example.com');
        link.append($createTextNode('repository'));
        p.append($createTextNode('visit '), link, $createTextNode(' now'));
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const map = $buildOffsetMap();
        const match = {end: 16, matchText: 'repository', start: 6};
        const points = $resolveMatchToPoints(match, map);
        invariant(points !== null, 'expected non-null match points');
        $replaceMatch(points, 'repo', match, null);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('visit repo now');
      const p = $getRoot().getFirstChild();
      invariant($isElementNode(p), 'expected ElementNode');
      const children = p.getChildren();
      expect(children).toHaveLength(3);
      invariant($isLinkNode(children[1]), 'expected LinkNode');
      expect(children[1].getTextContent()).toBe('repo');
    });
  });
});

describe('$replaceAllMatches', () => {
  test('replaces all matches in reverse order', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('foo bar foo'));
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const map = $buildOffsetMap();
        const matches = findMatches('foo bar foo', 'foo', false, false);
        const count = $replaceAllMatches(matches, map, 'baz', null);
        expect(count).toBe(2);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('baz bar baz');
    });
  });

  test('replaces all with shorter replacement', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('foo bar foo'));
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const text = $getRoot().getTextContent();
        const map = $buildOffsetMap();
        const matches = findMatches(text, 'foo', false, false);
        const count = $replaceAllMatches(matches, map, 'x', null);
        expect(count).toBe(2);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('x bar x');
    });
  });

  test('replaces all with longer replacement', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('foo bar foo'));
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const text = $getRoot().getTextContent();
        const map = $buildOffsetMap();
        const matches = findMatches(text, 'foo', false, false);
        const count = $replaceAllMatches(matches, map, 'quxxx', null);
        expect(count).toBe(2);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('quxxx bar quxxx');
    });
  });

  test('replaces all with regex capture groups', () => {
    using editor = buildEditorFromExtensions(TestExtension);
    editor.update(
      () => {
        const p = $createParagraphNode();
        p.append($createTextNode('a@b and c@d'));
        $getRoot().clear().append(p);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const text = $getRoot().getTextContent();
        const map = $buildOffsetMap();
        const matches = findMatches(text, '(\\w+)@(\\w+)', false, true);
        const regex = /(\w+)@(\w+)/;
        const count = $replaceAllMatches(matches, map, '$2/$1', regex);
        expect(count).toBe(2);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('b/a and d/c');
    });
  });
});

describe('FindReplaceExtension — command dispatch integration', () => {
  test('TOGGLE_FIND_REPLACE_COMMAND toggles isOpen signal', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    expect(dep.output.isOpen.peek()).toBe(false);
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    expect(dep.output.isOpen.peek()).toBe(true);
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    expect(dep.output.isOpen.peek()).toBe(false);
  });

  test('CLOSE_FIND_REPLACE_COMMAND sets isOpen to false', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    expect(dep.output.isOpen.peek()).toBe(true);
    editor.dispatchCommand(CLOSE_FIND_REPLACE_COMMAND);
    expect(dep.output.isOpen.peek()).toBe(false);
  });

  test('matches computed signal updates when searchTerm and text change', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('hello world hello')),
          );
      },
      {discrete: true},
    );
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    dep.output.searchTerm.value = 'hello';
    expect(dep.output.matches.peek()).toHaveLength(2);
    expect(dep.output.matches.peek()[0]).toMatchObject({
      matchText: 'hello',
      start: 0,
    });
  });

  test('FIND_NEXT_COMMAND / FIND_PREV_COMMAND cycle currentIndex', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('a b a b a')));
      },
      {discrete: true},
    );
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    dep.output.searchTerm.value = 'a';
    expect(dep.output.matches.peek()).toHaveLength(3);
    expect(dep.output.currentIndex.peek()).toBe(0);

    editor.dispatchCommand(FIND_NEXT_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(1);

    editor.dispatchCommand(FIND_NEXT_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(2);

    // wrap around
    editor.dispatchCommand(FIND_NEXT_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(0);

    // backward wrap
    editor.dispatchCommand(FIND_PREV_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(2);
  });

  test('FIND_NEXT_COMMAND with zero matches is a no-op', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    dep.output.searchTerm.value = 'nonexistent';
    expect(dep.output.matches.peek()).toHaveLength(0);
    editor.dispatchCommand(FIND_NEXT_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(0);
    editor.dispatchCommand(FIND_PREV_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(0);
  });

  test('matches returns empty when isOpen is false', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('hello')));
      },
      {discrete: true},
    );
    dep.output.searchTerm.value = 'hello';
    expect(dep.output.isOpen.peek()).toBe(false);
    expect(dep.output.matches.peek()).toEqual([]);
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    expect(dep.output.matches.peek()).toHaveLength(1);
  });

  test('effectiveIndex clamps when match count decreases', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('a b a b a')));
      },
      {discrete: true},
    );
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    dep.output.searchTerm.value = 'a';
    expect(dep.output.matches.peek()).toHaveLength(3);
    editor.dispatchCommand(FIND_NEXT_COMMAND);
    editor.dispatchCommand(FIND_NEXT_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(2);
    dep.output.searchTerm.value = 'a b';
    expect(dep.output.matches.peek()).toHaveLength(2);
    expect(dep.output.effectiveIndex.peek()).toBe(1);
  });

  test('regexError computed returns true for invalid regex', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    dep.output.isRegex.value = true;
    dep.output.searchTerm.value = '[invalid';
    expect(dep.output.regexError.peek()).toBe(true);
    dep.output.searchTerm.value = '\\d+';
    expect(dep.output.regexError.peek()).toBe(false);
  });

  test('SET_SEARCH_TERM_COMMAND resets currentIndex to 0', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('a b a b a')));
      },
      {discrete: true},
    );
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    dep.output.searchTerm.value = 'a';
    editor.dispatchCommand(FIND_NEXT_COMMAND);
    editor.dispatchCommand(FIND_NEXT_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(2);
    editor.dispatchCommand(SET_SEARCH_TERM_COMMAND, 'b');
    expect(dep.output.currentIndex.peek()).toBe(0);
    expect(dep.output.searchTerm.peek()).toBe('b');
  });

  test('TOGGLE_CASE_SENSITIVE / TOGGLE_REGEX reset currentIndex to 0', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('a b a b a')));
      },
      {discrete: true},
    );
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    dep.output.searchTerm.value = 'a';
    editor.dispatchCommand(FIND_NEXT_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(1);
    editor.dispatchCommand(TOGGLE_CASE_SENSITIVE_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(0);
    expect(dep.output.caseSensitive.peek()).toBe(true);

    editor.dispatchCommand(FIND_NEXT_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(1);
    editor.dispatchCommand(TOGGLE_REGEX_COMMAND);
    expect(dep.output.currentIndex.peek()).toBe(0);
    expect(dep.output.isRegex.peek()).toBe(true);
  });

  test('REPLACE_CURRENT_COMMAND replaces the current match', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('foo bar foo')),
          );
      },
      {discrete: true},
    );
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    dep.output.searchTerm.value = 'foo';
    dep.output.replaceTerm.value = 'baz';
    expect(dep.output.matches.peek()).toHaveLength(2);
    editor.dispatchCommand(REPLACE_CURRENT_COMMAND);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('baz bar foo');
    });
  });

  test('REPLACE_ALL_COMMAND replaces all matches', () => {
    using editor = buildEditorFromExtensions(FindReplaceExtension);
    const dep = getExtensionDependencyFromEditor(editor, FindReplaceExtension);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('foo bar foo')),
          );
      },
      {discrete: true},
    );
    editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
    dep.output.searchTerm.value = 'foo';
    dep.output.replaceTerm.value = 'qux';
    expect(dep.output.matches.peek()).toHaveLength(2);
    editor.dispatchCommand(REPLACE_ALL_COMMAND);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('qux bar qux');
    });
  });
});
