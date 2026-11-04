/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

const IMPORTANT_FLAG = '!important';

/**
 * Parses inline CSS text into an object that is compatible with
 * `CSSStyleDeclaration.setProperty()`.
 *
 * Property names are expected to be kebab-case, such as `font-size`, and
 * values are expected to include explicit units where needed, such as `12px`.
 */
export function getStyleObjectFromCSS(css: string): Record<string, string> {
  const styles: Record<string, string> = {};

  if (!css) {
    return styles;
  }

  let currentProperty = '';
  let currentValue = '';
  let currentQuote: '"' | "'" | null = null;
  let inComment = false;
  let isEscaped = false;
  let isParsingValue = false;
  let parenthesisDepth = 0;
  const length = css.length;
  // Characters that belong to the current property/value (normal text, quotes,
  // escapes and parentheses) are accumulated as contiguous slices rather than
  // appended one-by-one, which avoids O(n) per-character string concatenation.
  // `chunkStart` marks the start of the pending run, or -1 when nothing is
  // pending. The run is flushed whenever a character is dropped (a comment) or
  // acts as a delimiter (`:` or `;`).
  let chunkStart = -1;

  for (let i = 0; i < length; i++) {
    const char = css[i];

    if (inComment) {
      if (char === '*' && css[i + 1] === '/') {
        inComment = false;
        i++;
      }
      continue;
    }

    if (isEscaped) {
      if (chunkStart === -1) {
        chunkStart = i;
      }
      isEscaped = false;
      continue;
    }

    if (currentQuote !== null) {
      if (chunkStart === -1) {
        chunkStart = i;
      }

      if (char === '\\') {
        isEscaped = true;
      } else if (char === currentQuote) {
        currentQuote = null;
      }

      continue;
    }

    if (char === '/' && css[i + 1] === '*') {
      // The comment is dropped, so flush everything accumulated before it.
      if (chunkStart !== -1) {
        if (isParsingValue) {
          currentValue += css.slice(chunkStart, i);
        } else {
          currentProperty += css.slice(chunkStart, i);
        }
        chunkStart = -1;
      }
      inComment = true;
      i++;
      continue;
    }

    if (char === '"' || char === "'") {
      if (chunkStart === -1) {
        chunkStart = i;
      }
      currentQuote = char;
      continue;
    }

    if (char === '(') {
      if (chunkStart === -1) {
        chunkStart = i;
      }
      parenthesisDepth++;
      continue;
    }

    if (char === ')') {
      if (chunkStart === -1) {
        chunkStart = i;
      }
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      continue;
    }

    if (!isParsingValue && char === ':' && parenthesisDepth === 0) {
      // The separator is dropped; flush the accumulated property name.
      if (chunkStart !== -1) {
        currentProperty += css.slice(chunkStart, i);
        chunkStart = -1;
      }
      isParsingValue = true;
      continue;
    }

    if (char === ';' && parenthesisDepth === 0) {
      if (chunkStart !== -1) {
        if (isParsingValue) {
          currentValue += css.slice(chunkStart, i);
        } else {
          currentProperty += css.slice(chunkStart, i);
        }
        chunkStart = -1;
      }
      const property = currentProperty.trim();
      const value = currentValue.trim();

      if (property !== '' && value !== '') {
        styles[property] = value;
      }

      currentProperty = '';
      currentValue = '';
      isParsingValue = false;
      continue;
    }

    if (chunkStart === -1) {
      chunkStart = i;
    }
  }

  if (chunkStart !== -1) {
    // A backslash at the very end escapes nothing, so a string ending there
    // drops it, as CSS does.
    const end = isEscaped ? length - 1 : length;
    if (isParsingValue) {
      currentValue += css.slice(chunkStart, end);
    } else {
      currentProperty += css.slice(chunkStart, end);
    }
  }
  // CSS closes a string or parentheses still open at the end of the input.
  // Close them here too, so that serializing the value and appending another
  // declaration doesn't put that declaration inside them.
  if (isParsingValue) {
    if (currentQuote !== null) {
      currentValue += currentQuote;
    }
    currentValue += ')'.repeat(parenthesisDepth);
  }

  const property = currentProperty.trim();
  const value = currentValue.trim();

  if (property !== '' && value !== '') {
    styles[property] = value;
  }

  return styles;
}

function setDOMStyleProperty(
  domStyle: CSSStyleDeclaration,
  property: string,
  value: string,
): void {
  // Detect (and strip) a trailing `!important` flag using plain string
  // operations. A regexp such as `/\s*!important\s*$/i` runs in O(n^2) time on
  // whitespace-heavy values (the leading `\s*` backtracks from every starting
  // offset), whereas `trimEnd` + `slice` is linear.
  const trimmedValue = value.trimEnd();
  const flagStart = trimmedValue.length - IMPORTANT_FLAG.length;
  const hasImportant =
    flagStart >= 0 &&
    trimmedValue.slice(flagStart).toLowerCase() === IMPORTANT_FLAG;

  if (hasImportant) {
    domStyle.setProperty(
      property,
      trimmedValue.slice(0, flagStart).trim(),
      'important',
    );
  } else {
    domStyle.setProperty(property, value, '');
  }
}

/**
 * Applies a style object to a DOM style declaration using
 * `CSSStyleDeclaration.setProperty()`.
 *
 * Property names are expected to be kebab-case, such as `font-size`, and
 * values are expected to include explicit units where needed, such as `12px`.
 */
export function setDOMStyleObject(
  domStyle: CSSStyleDeclaration,
  styleObject: Record<string, string | null | undefined>,
): void {
  for (const property in styleObject) {
    const value = styleObject[property];
    if (value == null) {
      domStyle.removeProperty(property);
    } else {
      setDOMStyleProperty(domStyle, property, value);
    }
  }
}

/**
 * Applies inline CSS text to a DOM style declaration using
 * `CSSStyleDeclaration.setProperty()`.
 *
 * Property names are expected to be kebab-case, such as `font-size`, and
 * values are expected to include explicit units where needed, such as `12px`.
 */
export function setDOMStyleFromCSS(
  domStyle: CSSStyleDeclaration,
  cssText: string,
  prevCSSText: string = '',
): void {
  if (cssText === prevCSSText) {
    return;
  }

  const prevCSS = getStyleObjectFromCSS(prevCSSText);
  const nextCSS = getStyleObjectFromCSS(cssText);

  for (const property in nextCSS) {
    delete prevCSS[property];
    setDOMStyleProperty(domStyle, property, nextCSS[property]);
  }

  for (const property in prevCSS) {
    domStyle.removeProperty(property);
  }
}
