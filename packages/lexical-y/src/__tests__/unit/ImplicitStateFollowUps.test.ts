/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

/**
 * R15-A probe: follow-ups (BlockIdExtension's naming tag) that change a line
 * without a marker or the paragraph a read shows around raw text in a quote
 * that holds paragraphs, in ways the refusal rule does not name:
 * NodeState of the element itself (not a field: `__state` is in NOT_FIELDS),
 * NodeState of its text, a child removed, its text replaced. Each must be
 * written within the follow-up rule or refused and read again: the author
 * must end equal to a fresh reader and to the peer.
 */
import {$createQuoteNode} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setSelection,
  $setState,
  createState,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  freshReader,
  type Peer,
  setup,
  WidgetNode,
} from '../utils/harness';

const r15 = createState('r15', {parse: v => (typeof v === 'string' ? v : '')});

function stable(v: unknown): string {
  if (Array.isArray(v)) {
    return '[' + v.map(stable).join(',') + ']';
  }
  if (v !== null && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v as object)
        .filter(k => (v as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map(
          k =>
            JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k]),
        )
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}
const json = (p: Peer) => stable(p.editor.getEditorState().toJSON());

const CHANGES: Record<string, (e: ElementNode) => void> = {
  'NodeState of its first text': e =>
    $setState(e.getFirstChild() as TextNode, r15, 'v2'),
  'NodeState of the element': e => $setState(e, r15, 'v1'),
  'a character deleted': e =>
    (e.getFirstChild() as TextNode).spliceText(0, 1, ''),
  'a text appended': e => e.append($createTextNode(' t9z')),
  'its first text removed': e => (e.getFirstChild() as LexicalNode).remove(),
  'its text replaced': e =>
    (e.getFirstChild() as TextNode).setTextContent('QQ'),
};

describe('follow-ups on a line without a marker or a quote run paragraph', () => {
  for (const unit of [
    'markerless trailing line',
    'quote run paragraph',
  ] as const) {
    for (const [name, change] of Object.entries(CHANGES)) {
      for (const tag of ['block-id-repair', undefined] as const) {
        test(`${unit}: ${name}${tag ? ' (follow-up)' : ''}`, async () => {
          const t = await setup(() => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Title')),
              $createParagraphNode().append($createTextNode('t1z ')),
              $createParagraphNode().append($createTextNode('end')),
            );
          });
          t.offline();
          if (unit === 'markerless trailing line') {
            t.a.update(() => {
              $getRoot().getLastChild()!.remove();
              $getRoot().getChildAtIndex(1)!.insertAfter($create(WidgetNode));
              $setSelection(null);
            });
            t.b.update(() => {
              ($getRoot().getLastChild() as ElementNode)
                .selectEnd()
                .insertText(' XX');
            });
          } else {
            t.a.update(() => {
              const para = $block([1]);
              const quote = $createQuoteNode({shadowRoot: true});
              para.insertBefore(quote);
              quote.append(para);
            });
            t.b.update(() => {
              $block([1]).selectStart().insertText('t5z ');
            });
          }
          await t.sync();
          const before = json(t.b);
          const w0 = t.b.warnings.length;
          t.b.update(() => {
            const target =
              unit === 'markerless trailing line'
                ? ($getRoot().getLastChild() as ElementNode)
                : ((
                    $getRoot().getChildAtIndex(1) as ElementNode
                  ).getFirstChild() as ElementNode);
            change(target);
            $setSelection(null);
          }, tag);
          const author = json(t.b);
          await t.sync();
          const authorAfter = json(t.b);
          const fresh = await freshReader(t.b);
          const states = t.b.read(() => {
            const out: string[] = [];
            const walk = (n: LexicalNode) => {
              const s = $getState(n, r15);
              if (s) {
                out.push(n.getType() + ':' + s);
              }
              if ('getChildren' in n) {
                (n as ElementNode).getChildren().forEach(walk);
              }
            };
            walk($getRoot());
            return out;
          });
          // eslint-disable-next-line no-console
          console.log(
            `[R15FU ${unit} | ${name} | ${tag ?? 'edit'}] ${JSON.stringify({authorChangedThenSynced: author !== authorAfter, authorEqualsBefore: authorAfter === before, freshEq: json(fresh) === authorAfter, peerEq: json(t.a) === authorAfter, states, warnings: t.b.warnings.slice(w0).map(w => w.slice(0, 120))})}`,
          );
          expect(json(fresh)).toBe(authorAfter);
          expect(json(t.a)).toBe(authorAfter);
          expect(t.a.errors).toEqual([]);
          expect(t.b.errors).toEqual([]);
        });
      }
    }
  }
});
