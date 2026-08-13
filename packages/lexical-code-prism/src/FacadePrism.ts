/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Token, TokenStream} from 'prismjs';

// Side-effect import: loads prismjs and sets up the global `Prism` that the
// component imports below extend. Must stay separate from the type-only import
// above so it is not elided.
import 'prismjs';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-objectivec';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-cpp';

import {$createCodeHighlightNode, type CodeNode} from '@lexical/code-core';
import {
  $createLineBreakNode,
  $createTabNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  tokenizeRawText,
} from 'lexical';

declare global {
  interface Window {
    Prism: typeof import('prismjs');
  }
}

export const Prism: typeof import('prismjs') =
  // eslint-disable-next-line no-restricted-syntax
  (globalThis as {Prism?: typeof import('prismjs')}).Prism || window.Prism;

export const CODE_LANGUAGE_FRIENDLY_NAME_MAP: Record<string, string> = {
  c: 'C',
  clike: 'C-like',
  cpp: 'C++',
  css: 'CSS',
  go: 'Go',
  html: 'HTML',
  java: 'Java',
  js: 'JavaScript',
  markdown: 'Markdown',
  objc: 'Objective-C',
  plain: 'Plain Text',
  powershell: 'PowerShell',
  py: 'Python',
  rust: 'Rust',
  sql: 'SQL',
  swift: 'Swift',
  typescript: 'TypeScript',
  xml: 'XML',
};

export const CODE_LANGUAGE_MAP: Record<string, string> = {
  cpp: 'cpp',
  golang: 'go',
  java: 'java',
  javascript: 'js',
  md: 'markdown',
  plaintext: 'plain',
  python: 'py',
  text: 'plain',
  ts: 'typescript',
};

// The two maps above are plain objects, so a language whose name matches a
// member of `Object.prototype` reads the inherited value: `CODE_LANGUAGE_MAP`
// indexed with `constructor` hands back the `Object` function, not a string.
// A code block's language comes from the document, so the name is not ours to
// choose.
function ownValue(
  map: Record<string, string>,
  key: string,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function normalizeCodeLanguage(lang: string) {
  return ownValue(CODE_LANGUAGE_MAP, lang) || lang;
}

export function getLanguageFriendlyName(lang: string) {
  const _lang = normalizeCodeLanguage(lang);
  return ownValue(CODE_LANGUAGE_FRIENDLY_NAME_MAP, _lang) || _lang;
}

export const getCodeLanguages = (): string[] =>
  Object.keys(Prism.languages)
    .filter(
      // Prism has several language helpers mixed into languages object
      // so filtering them out here to get langs list
      language => typeof Prism.languages[language] !== 'function',
    )
    .sort();

export function getCodeLanguageOptions(): [string, string][] {
  const options: [string, string][] = [];

  for (const [lang, friendlyName] of Object.entries(
    CODE_LANGUAGE_FRIENDLY_NAME_MAP,
  )) {
    options.push([lang, friendlyName]);
  }

  return options;
}

// Prism has no theme support
export function getCodeThemeOptions(): [string, string][] {
  const options: [string, string][] = [];
  return options;
}

function getDiffedLanguage(language: string) {
  const DIFF_LANGUAGE_REGEX = /^diff-([\w-]+)/i;
  const diffLanguageMatch = DIFF_LANGUAGE_REGEX.exec(language);
  return diffLanguageMatch ? diffLanguageMatch[1] : null;
}

export function isCodeLanguageLoaded(language: string) {
  const diffedLanguage = getDiffedLanguage(language);
  const langId = diffedLanguage ? diffedLanguage : language;
  try {
    // eslint-disable-next-line no-prototype-builtins
    return langId ? Prism.languages.hasOwnProperty(langId) : false;
  } catch {
    return false;
  }
}

export async function loadCodeLanguage(
  language: string,
  editor?: LexicalEditor,
  codeNodeKey?: NodeKey,
) {
  // NOT IMPLEMENTED
}

function getTextContent(token: TokenStream): string {
  if (typeof token === 'string') {
    return token;
  } else if (Array.isArray(token)) {
    return token.map(getTextContent).join('');
  } else {
    return getTextContent(token.content);
  }
}

// The following code is extracted/adapted from prismjs v2
// It will probably be possible to use it directly from prism v2
// in the future when prismjs v2 is published and Lexical upgrades
// the prismsjs dependency
export function tokenizeDiffHighlight(
  tokens: (string | Token)[],
  language: string,
): (string | Token)[] {
  const diffLanguage = language;
  const diffGrammar = Prism.languages[diffLanguage];
  const env = {tokens};
  const PREFIXES: Record<string, string> = (
    Prism.languages.diff as Record<string, Record<string, string>>
  ).PREFIXES;
  for (const token of env.tokens) {
    if (
      typeof token === 'string' ||
      !(token.type in PREFIXES) ||
      !Array.isArray(token.content)
    ) {
      continue;
    }

    const type = token.type as keyof typeof PREFIXES;
    let insertedPrefixes = 0;
    const getPrefixToken = () => {
      insertedPrefixes++;
      return new Prism.Token(
        'prefix',
        PREFIXES[type],
        type.replace(/^(\w+).*/, '$1'),
      );
    };

    const withoutPrefixes = token.content.filter(
      t => typeof t === 'string' || t.type !== 'prefix',
    );
    const prefixCount = token.content.length - withoutPrefixes.length;
    const diffTokens = Prism.tokenize(
      getTextContent(withoutPrefixes),
      diffGrammar,
    );

    // re-insert prefixes
    // always add a prefix at the start
    diffTokens.unshift(getPrefixToken());

    const LINE_BREAK = /\r\n|\n/g;
    const insertAfterLineBreakString = (text: string) => {
      const result: TokenStream = [];
      LINE_BREAK.lastIndex = 0;
      let last = 0;
      let m;
      while (insertedPrefixes < prefixCount && (m = LINE_BREAK.exec(text))) {
        const end = m.index + m[0].length;
        result.push(text.slice(last, end));
        last = end;
        result.push(getPrefixToken());
      }

      if (result.length === 0) {
        return undefined;
      }

      if (last < text.length) {
        result.push(text.slice(last));
      }
      return result;
    };
    const insertAfterLineBreak = (toks: (string | Token)[]) => {
      for (let i = 0; i < toks.length && insertedPrefixes < prefixCount; i++) {
        const tok = toks[i];

        if (typeof tok === 'string') {
          const inserted = insertAfterLineBreakString(tok);
          if (inserted) {
            toks.splice(i, 1, ...inserted);
            i += inserted.length - 1;
          }
        } else if (typeof tok.content === 'string') {
          const inserted = insertAfterLineBreakString(tok.content);
          if (inserted) {
            tok.content = inserted;
          }
        } else if (Array.isArray(tok.content)) {
          insertAfterLineBreak(tok.content);
        } else {
          insertAfterLineBreak([tok.content]);
        }
      }
    };
    insertAfterLineBreak(diffTokens);

    if (insertedPrefixes < prefixCount) {
      // we are missing the last prefix
      diffTokens.push(getPrefixToken());
    }

    token.content = diffTokens;
  }
  return env.tokens;
}

export function $getHighlightNodes(
  codeNode: CodeNode,
  language: string,
): LexicalNode[] {
  const DIFF_LANGUAGE_REGEX = /^diff-([\w-]+)/i;
  const diffLanguageMatch = DIFF_LANGUAGE_REGEX.exec(language);

  const code = codeNode.getTextContent();

  let tokens: (string | Token)[] = Prism.tokenize(
    code,
    Prism.languages[diffLanguageMatch ? 'diff' : language],
  );
  if (diffLanguageMatch) {
    tokens = tokenizeDiffHighlight(tokens, diffLanguageMatch[1]);
  }
  return $mapTokensToLexicalStructure(tokens);
}

function $mapTokensToLexicalStructure(
  tokens: (string | Token)[],
  type?: string,
): LexicalNode[] {
  const nodes: LexicalNode[] = [];

  for (const token of tokens) {
    if (typeof token === 'string') {
      tokenizeRawText(token, {
        linebreak: () => nodes.push($createLineBreakNode()),
        tab: () => nodes.push($createTabNode()),
        text: part => nodes.push($createCodeHighlightNode(part, type)),
      });
    } else {
      const {content, alias} = token;
      if (typeof content === 'string') {
        nodes.push(
          ...$mapTokensToLexicalStructure(
            [content],
            token.type === 'prefix' && typeof alias === 'string'
              ? alias
              : token.type,
          ),
        );
      } else if (Array.isArray(content)) {
        nodes.push(
          ...$mapTokensToLexicalStructure(
            content,
            token.type === 'unchanged' ? undefined : token.type,
          ),
        );
      }
    }
  }

  return nodes;
}
