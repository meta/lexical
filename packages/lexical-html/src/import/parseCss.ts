/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {ElementSelectorBuilder} from './types';

import invariant from '@lexical/internal/invariant';

import {
  buildAttrPredicate,
  buildClassAllPredicate,
  buildSelector,
  type Predicate,
} from './sel';

const IDENT_CHAR = /[A-Za-z0-9_-]/;

class Cursor {
  constructor(
    public readonly source: string,
    public pos: number,
  ) {}
  peek(offset = 0): string {
    return this.source[this.pos + offset] || '';
  }
  consume(): string {
    return this.source[this.pos++] || '';
  }
  eof(): boolean {
    return this.pos >= this.source.length;
  }
  skipWhitespace(): void {
    while (!this.eof() && /\s/.test(this.peek())) {
      this.pos++;
    }
  }
  readIdent(): string {
    const start = this.pos;
    while (!this.eof() && IDENT_CHAR.test(this.peek())) {
      this.pos++;
    }
    return this.source.slice(start, this.pos);
  }
  readQuoted(): string {
    const quote = this.consume();
    this.assert(quote === '"' || quote === "'", 'expected quote');
    const start = this.pos;
    while (!this.eof() && this.peek() !== quote) {
      if (this.peek() === '\\') {
        this.pos += 2;
      } else {
        this.pos++;
      }
    }
    this.assert(!this.eof(), 'unterminated string');
    const value = this.source.slice(start, this.pos);
    this.pos++; // consume closing quote
    return value.replace(/\\(.)/g, '$1');
  }
  /**
   * `invariant(cond, fmt, …)`-flavored assertion that also surfaces the
   * cursor's position context. Use for parse-time errors so a malformed
   * CSS selector gets a useful, position-annotated message.
   */
  assert(cond: boolean, msg: string): asserts cond {
    invariant(
      cond,
      'invalid CSS selector at col %s: %s in %s',
      String(this.pos + 1),
      msg,
      this.source,
    );
  }
}

interface ParsedSimpleSelector {
  readonly tags: Set<string>;
  readonly predicates: Predicate[];
}

function parseSimpleSelector(c: Cursor): ParsedSimpleSelector {
  const tags = new Set<string>();
  const predicates: Predicate[] = [];
  const classes: string[] = [];
  let isUniversal = false;

  c.skipWhitespace();

  // Optional tag or '*'
  if (c.peek() === '*') {
    c.consume();
    isUniversal = true;
  } else if (IDENT_CHAR.test(c.peek())) {
    const tag = c.readIdent();
    if (tag) {
      tags.add(tag.toUpperCase());
    }
  }

  // Zero or more refinements: .class, #id, [attr]
  while (!c.eof()) {
    const ch = c.peek();
    if (ch === '.') {
      c.consume();
      const cls = c.readIdent();
      c.assert(cls !== '', 'expected class name after "."');
      classes.push(cls);
    } else if (ch === '#') {
      c.consume();
      const id = c.readIdent();
      c.assert(id !== '', 'expected id after "#"');
      predicates.push(buildAttrPredicate('id', id));
    } else if (ch === '[') {
      c.consume();
      c.skipWhitespace();
      const name = c.readIdent();
      c.assert(name !== '', 'expected attribute name after "["');
      c.skipWhitespace();
      let value: true | string = true;
      if (c.peek() === '=') {
        c.consume();
        c.skipWhitespace();
        const next = c.peek();
        if (next === '"' || next === "'") {
          value = c.readQuoted();
        } else {
          value = c.readIdent();
          c.assert(value !== '', 'expected attribute value');
        }
        c.skipWhitespace();
      }
      c.assert(c.peek() === ']', 'expected "]"');
      c.consume();
      predicates.push(buildAttrPredicate(name, value));
    } else {
      break;
    }
  }

  if (classes.length > 0) {
    predicates.push(buildClassAllPredicate(classes));
  }

  // Neither tag nor refinement is only legitimate when the group came from a
  // lone `*`. Otherwise the source is empty or its list has a hole, and
  // accepting it would silently turn a typo into a universal selector.
  c.assert(
    isUniversal || tags.size > 0 || predicates.length > 0,
    'expected a selector',
  );

  return {predicates, tags};
}

/**
 * Parse a reduced CSS-selector subset and return a {@link CompiledSelector}.
 * Supported:
 * - Tag (`p`), wildcard (`*`).
 * - Tag list (`h1, h2, h3`).
 * - Class (`.foo`, `.foo.bar`).
 * - ID (`#foo`).
 * - Attribute presence (`[name]`).
 * - Attribute equality (`[name="value"]`, `[name=value]`).
 *
 * Anything outside the subset (regex attribute, inline-style match,
 * combinators, pseudo-classes) is intentionally rejected — chain combinator
 * methods off the returned builder instead.
 *
 * @experimental
 */
export function parseSelector(
  source: string,
): ElementSelectorBuilder<HTMLElement> {
  const c: Cursor = new Cursor(source, 0);
  const groups: ParsedSimpleSelector[] = [];

  while (true) {
    groups.push(parseSimpleSelector(c));
    c.skipWhitespace();
    if (c.eof()) {
      break;
    }
    c.assert(
      c.peek() === ',',
      'expected "," (selector lists are the only supported combinator)',
    );
    c.consume();
    c.skipWhitespace();
  }

  if (groups.length === 1) {
    return buildSelector(groups[0].tags, groups[0].predicates);
  }

  // Comma-separated list. Merge tag sets only when every group is tag-
  // restricted; an unrestricted group requires wildcard dispatch. OR-combine
  // the per-group refinement predicates so each candidate satisfies some
  // group entirely.
  const tags = new Set<string>();
  if (groups.every(g => g.tags.size > 0)) {
    for (const g of groups) {
      for (const t of g.tags) {
        tags.add(t);
      }
    }
  }
  const orPredicate: Predicate = (node, captures) => {
    for (const g of groups) {
      const upper = node.nodeName;
      if (g.tags.size > 0 && !g.tags.has(upper)) {
        continue;
      }
      let ok = true;
      for (const p of g.predicates) {
        if (!p(node, captures)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return true;
      }
    }
    return false;
  };
  return buildSelector(tags, [orPredicate]);
}
