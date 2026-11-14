/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Reads `src/internal` with the TypeScript compiler and reports every write
// of Yjs's `Item.keep` outside its owner (see internal/Keeps), found by
// the declaration the property resolves to: through an alias of the item,
// a line break, an element access or a compound assignment, and not in a
// comment or a string. What it does not see: a write through a computed
// property name, through `Object.assign`, through a destructuring
// assignment (`({keep: item.keep} = {keep: false})`, `[item.keep] = [false]`),
// or through a type of the item's shape (`const flag: {keep: boolean} =
// item`, a generic `T extends {keep: boolean}`).
import * as path from 'node:path';
import * as ts from 'typescript';

import {ownerName, readInternalSources} from './shownGuard';

/** The owner of the flag. */
const OWNER = 'Keeps.ts';

/**
 * Every write of `Item.keep` in `src/internal` outside Keeps, as
 * `File.ts function`, sorted. `extra` adds or replaces sources by file
 * name, for the guard's own test.
 */
export function scanKeepWrites(extra: Record<string, string> = {}): string[] {
  const {checker, sources} = readInternalSources(extra);
  /** Whether `target` is the `keep` of a Yjs item (or of a value of no known type). */
  const isItemKeep = (target: ts.Expression): boolean => {
    let e = target;
    while (
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAsExpression(e)
    ) {
      e = e.expression;
    }
    let symbol: ts.Symbol | undefined;
    let receiver: ts.Expression;
    if (ts.isPropertyAccessExpression(e)) {
      if (e.name.text !== 'keep') {
        return false;
      }
      symbol = checker.getSymbolAtLocation(e.name);
      receiver = e.expression;
    } else if (
      ts.isElementAccessExpression(e) &&
      ts.isStringLiteralLike(e.argumentExpression) &&
      e.argumentExpression.text === 'keep'
    ) {
      receiver = e.expression;
      symbol = checker.getPropertyOfType(
        checker.getNonNullableType(checker.getTypeAtLocation(receiver)),
        'keep',
      );
    } else {
      return false;
    }
    if ((checker.getTypeAtLocation(receiver).flags & ts.TypeFlags.Any) !== 0) {
      return true;
    }
    return (
      symbol !== undefined &&
      (symbol.declarations || []).some(d =>
        d.getSourceFile().fileName.includes('/@y/y/'),
      )
    );
  };
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const written =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ? node.left
        : (ts.isPrefixUnaryExpression(node) ||
              ts.isPostfixUnaryExpression(node)) &&
            (node.operator === ts.SyntaxKind.PlusPlusToken ||
              node.operator === ts.SyntaxKind.MinusMinusToken)
          ? node.operand
          : ts.isDeleteExpression(node)
            ? node.expression
            : null;
    if (written !== null && isItemKeep(written)) {
      found.push(
        `${path.basename(node.getSourceFile().fileName)} ${ownerName(node)}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  sources
    .filter(source => path.basename(source.fileName) !== OWNER)
    .forEach(visit);
  return found.sort();
}
