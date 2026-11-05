/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Options} from 'prettier';

const PRETTIER_PARSER_MODULES = {
  css: [() => import('prettier/parser-postcss')],
  html: [() => import('prettier/parser-html')],
  js: [
    () => import('prettier/parser-babel'),
    () => import('prettier/plugins/estree'),
  ],
  markdown: [() => import('prettier/parser-markdown')],
  typescript: [
    () => import('prettier/parser-typescript'),
    () => import('prettier/plugins/estree'),
  ],
} as const;

type LanguagesType = keyof typeof PRETTIER_PARSER_MODULES;

async function loadPrettierParserByLang(lang: string) {
  const dynamicImports = PRETTIER_PARSER_MODULES[lang as LanguagesType];
  const modules = await Promise.all(
    dynamicImports.map(dynamicImport => dynamicImport()),
  );
  return modules;
}

async function loadPrettierFormat() {
  const {format} = await import('prettier/standalone');
  return format;
}

const PRETTIER_OPTIONS_BY_LANG: Record<string, Options> = {
  css: {parser: 'css'},
  html: {parser: 'html'},
  js: {parser: 'babel'},
  markdown: {parser: 'markdown'},
  typescript: {parser: 'typescript'},
};

const LANG_CAN_BE_PRETTIER = Object.keys(PRETTIER_OPTIONS_BY_LANG);

export function canBePrettier(lang: string): boolean {
  return LANG_CAN_BE_PRETTIER.includes(lang);
}

function getPrettierOptions(lang: string): Options {
  const options = PRETTIER_OPTIONS_BY_LANG[lang];
  if (!options) {
    throw new Error(
      `CodeActionMenuPlugin: Prettier does not support this language: ${lang}`,
    );
  }

  return options;
}

/**
 * Whether opening tag `tag` has a `style` attribute that sets
 * `white-space: pre` (or `pre-wrap`, `pre-line`): Prettier would reflow its
 * text. Scans the attribute value instead of matching the whole tag with one
 * regex, whose overlapping repetitions backtrack polynomially.
 */
function keepsWhiteSpace(tag: string): boolean {
  const attr = /\bstyle\s*=\s*(["'])/i.exec(tag);
  if (attr === null) {
    return false;
  }
  const start = attr.index + attr[0].length;
  const end = tag.indexOf(attr[1], start);
  const value = tag.slice(start, end === -1 ? tag.length : end);
  return /white-space\s*:\s*pre/i.test(value);
}

export async function formatCodeWithPrettier(content: string, lang: string) {
  const format = await loadPrettierFormat();
  const options = getPrettierOptions(lang);
  const prettierParsers = await loadPrettierParserByLang(lang);
  options.plugins = prettierParsers.map(parser => parser.default || parser);
  if (lang === 'html') {
    content = content.replace(/<[a-z][^>]*>/gi, tag =>
      keepsWhiteSpace(tag) ? `<!-- prettier-ignore -->${tag}` : tag,
    );
  }
  let formatted = await format(content, options);
  if (lang === 'html') {
    formatted = formatted.replaceAll(/<!-- prettier-ignore -->/g, '');
  }
  return formatted;
}
