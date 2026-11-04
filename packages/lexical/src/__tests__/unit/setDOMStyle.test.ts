/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  getStyleObjectFromCSS,
  setDOMStyleFromCSS,
  setDOMStyleObject,
} from 'lexical';
import {describe, expect, it} from 'vitest';

describe('setDOMStyle', () => {
  it('parses CSS text into a style object', () => {
    expect(
      getStyleObjectFromCSS(
        'color: red; margin: 0 !important; --custom: example;',
      ),
    ).toEqual({
      '--custom': 'example',
      color: 'red',
      margin: '0 !important',
    });
  });

  it('parses values with comments, semicolons and colons inside quotes and parentheses', () => {
    expect(
      getStyleObjectFromCSS(
        'background-image: url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'></svg>"); /* ignored */ content: "semi;colon:value"; color: red;',
      ),
    ).toEqual({
      'background-image':
        'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'></svg>")',
      color: 'red',
      content: '"semi;colon:value"',
    });
  });

  it('returns a fresh style object for each parse', () => {
    const styleObject = getStyleObjectFromCSS('color: red;');
    styleObject.color = 'blue';

    expect(getStyleObjectFromCSS('color: red;')).toEqual({color: 'red'});
  });

  it('applies CSS text without cssText', () => {
    const element = document.createElement('div');

    setDOMStyleFromCSS(
      element.style,
      'color: red; margin: 0 !IMPORTANT; --custom: example;',
    );

    expect(element.style.color).toBe('red');
    expect(element.style.getPropertyPriority('margin')).toBe('important');
    expect(element.style.getPropertyValue('--custom')).toBe('example');
  });

  it('replaces previous inline styles when CSS text changes', () => {
    const element = document.createElement('div');

    setDOMStyleFromCSS(
      element.style,
      'color: red; margin: 0 !important; --custom: example;',
    );
    setDOMStyleFromCSS(
      element.style,
      'padding: 1px;',
      'color: red; margin: 0 !important; --custom: example;',
    );

    expect(element.style.color).toBe('');
    expect(element.style.margin).toBe('');
    expect(element.style.getPropertyValue('--custom')).toBe('');
    expect(element.style.padding).toBe('1px');
  });

  it('applies direct style objects', () => {
    const element = document.createElement('div');

    setDOMStyleObject(element.style, {
      color: 'red',
      margin: '0 !IMPORTANT',
      padding: null,
    });

    expect(element.style.color).toBe('red');
    expect(element.style.getPropertyPriority('margin')).toBe('important');
    expect(element.style.padding).toBe('');
  });

  it('drops comments and respects quotes and parentheses', () => {
    // A comment in the middle of a value is removed, joining the surrounding
    // text.
    expect(getStyleObjectFromCSS('color: re/* x */d; margin: 0')).toEqual({
      color: 'red',
      margin: '0',
    });
    // Consecutive comments in a property name are also removed.
    expect(getStyleObjectFromCSS('a/* c1 *//* c2 */b: c')).toEqual({ab: 'c'});
    // Escaped quotes, ';' and ':' inside a quoted value are preserved.
    expect(getStyleObjectFromCSS('content: "a\\"b;c:d"')).toEqual({
      content: '"a\\"b;c:d"',
    });
    // ';' and ':' inside parentheses are not treated as delimiters.
    expect(getStyleObjectFromCSS('background: url(http://x/a;b);')).toEqual({
      background: 'url(http://x/a;b)',
    });
  });

  it('closes a string or parentheses left open at the end, as CSS does', () => {
    expect(getStyleObjectFromCSS('font-family: "Arial')).toEqual({
      'font-family': '"Arial"',
    });
    expect(getStyleObjectFromCSS("color: red; font-family: 'Arial")).toEqual({
      color: 'red',
      'font-family': "'Arial'",
    });
    expect(getStyleObjectFromCSS('background-image: url(a.png')).toEqual({
      'background-image': 'url(a.png)',
    });
    expect(getStyleObjectFromCSS('background-image: url("a.png')).toEqual({
      'background-image': 'url("a.png")',
    });
    // An unterminated comment runs to the end; the parentheses still close.
    expect(getStyleObjectFromCSS('background-image: url(a.png/* x')).toEqual({
      'background-image': 'url(a.png)',
    });
    // A trailing backslash inside the string escapes nothing and is dropped.
    expect(getStyleObjectFromCSS('font-family: "Arial\\')).toEqual({
      'font-family': '"Arial"',
    });
    // Outside a string it is kept.
    expect(getStyleObjectFromCSS('color: red\\')).toEqual({color: 'red\\'});
  });
});
