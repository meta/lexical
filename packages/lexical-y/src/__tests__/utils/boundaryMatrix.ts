/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The boundary matrix of BoundaryNormalization*.test.ts (one file per platform,
// which each set the browser before Lexical loads): the binding's view of the
// editor's next update against what Lexical does (see runBoundaryMatrix).
//
// Lines of text siblings, links, inline elements (nested; at a line's start,
// middle and end; that take text beside them or not), an inline decorator, a
// line break, a token, an empty text node being composed (and an empty segment,
// which no normalization removes, after a link), and elements whose canBeEmpty
// and canInsertTextBefore/After read NodeState (flipped in the update before
// the next one, as a remote change does). Selections: every pair of text points
// at a node's start, middle and end (collapsed, forward and backward), and
// every element point (a paragraph's or an inline element's, at every child
// offset) alone or with a text point, either way round; the composition at a
// text node of the selection, or at each text node of the line for element
// points alone.

import {$createLinkNode, LinkNode} from '@lexical/link';
import {
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getDocument,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  $setState,
  createEditor,
  createState,
  DecoratorNode,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  ParagraphNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $nextUpdateSelection,
  $normalizedAtBoundaries,
  type BoundaryPoint,
} from '../../internal/Boundary';

/** An inline element that takes text beside it (ElementNode's default). */
class Inline extends ElementNode {
  $config() {
    return this.config('boundary_inline', {extends: ElementNode});
  }
  isInline(): true {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
}

/** An inline element that takes no text beside it. */
class Closed extends ElementNode {
  $config() {
    return this.config('boundary_closed', {extends: ElementNode});
  }
  isInline(): true {
    return true;
  }
  canInsertTextBefore(): false {
    return false;
  }
  canInsertTextAfter(): false {
    return false;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
}

/** An inline decorator. */
class Chip extends DecoratorNode<null> {
  $config() {
    return this.config('boundary_chip', {extends: DecoratorNode});
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/** Whether a Switch (or SwitchParagraph) is "shut": its NodeState. */
const shut = createState('boundary_shut', {parse: v => v === true});

/**
 * An inline element whose canInsertTextBefore/After and canBeEmpty read
 * NodeState (shut: no text beside it, not empty).
 */
class Switch extends ElementNode {
  $config() {
    return this.config('boundary_switch', {
      extends: ElementNode,
      stateConfigs: [{stateConfig: shut}],
    });
  }
  isInline(): true {
    return true;
  }
  canInsertTextBefore(): boolean {
    return !$getState(this, shut);
  }
  canInsertTextAfter(): boolean {
    return !$getState(this, shut);
  }
  canBeEmpty(): boolean {
    return !$getState(this, shut);
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
}

/** A paragraph whose canBeEmpty reads NodeState. */
class SwitchParagraph extends ParagraphNode {
  $config() {
    return this.config('boundary_switch_paragraph', {
      extends: ParagraphNode,
      stateConfigs: [{stateConfig: shut}],
    });
  }
  canBeEmpty(): boolean {
    return !$getState(this, shut);
  }
}

const $t = (text: string) => $createTextNode(text);
const $bold = (text: string) => $createTextNode(text).toggleFormat('bold');
const $link = (...children: LexicalNode[]) =>
  $createLinkNode('https://b.test').append(...children);
const $inline = (...children: LexicalNode[]) =>
  $create(Inline).append(...children);
const $closed = (...children: LexicalNode[]) =>
  $create(Closed).append(...children);
const $switch = (...children: LexicalNode[]) =>
  $create(Switch).append(...children);

type Shape = {
  /** The line's children (in a paragraph unless `paragraph` says). */
  $children: () => LexicalNode[];
  /** The line's element. */
  $paragraph?: () => ElementNode;
  /** Flipped (shut) in the update that sets the selection. */
  flips?: true;
};

export const SHAPES: Record<string, Shape> = {
  'decorator at the start': {$children: () => [$create(Chip), $t('post')]},
  'empty segment after a link': {
    $children: () => [
      $link($t('ab')),
      $createTextNode('').setMode('segmented'),
    ],
  },
  'empty text being composed': {
    $children: () => [$t('ab'), $t(''), $bold('cd')],
  },
  'inline alone': {$children: () => [$inline($t('mid'))]},
  'inline at the end': {$children: () => [$t('pre '), $inline($t('mid'))]},
  'inline at the start': {$children: () => [$inline($t('mid')), $t(' post')]},
  'inline between texts': {
    $children: () => [$t('pre '), $inline($t('mid')), $t(' post')],
  },
  'inline closed between texts': {
    $children: () => [$t('pre '), $closed($t('mid')), $t(' post')],
  },
  'inline holding a link': {
    $children: () => [$inline($t('a'), $link($t('bc')), $t('d'))],
  },
  'inline nested between texts': {
    $children: () => [$t('pre '), $inline($inline($t('mid'))), $t(' post')],
  },
  'inline of one character': {
    $children: () => [$t('pre '), $inline($t('m')), $t(' post')],
  },
  'inline of two texts': {
    $children: () => [$t('pre '), $inline($t('ab'), $bold('cd'))],
  },
  'line break': {$children: () => [$t('ab'), $createLineBreakNode(), $t('cd')]},
  'link alone': {$children: () => [$link($t('mid'))]},
  'link at the end': {$children: () => [$t('pre '), $link($t('mid'))]},
  'link at the start': {$children: () => [$link($t('mid')), $t(' post')]},
  'link between texts': {
    $children: () => [$t('pre '), $link($t('mid')), $t(' post')],
  },
  'link of one character': {
    $children: () => [$t('pre '), $link($t('m')), $t(' post')],
  },
  'links side by side': {$children: () => [$link($t('ab')), $link($t('cd'))]},
  'switch between texts, flipped': {
    $children: () => [$t('pre '), $switch($t('mid')), $t(' post')],
    flips: true,
  },
  'switch holding a link, flipped': {
    $children: () => [$switch($t('abc'), $link($t('next')))],
    $paragraph: () => $create(SwitchParagraph),
    flips: true,
  },
  'switch paragraph, flipped': {
    $children: () => [$inline($t('abc'), $link($t('next')))],
    $paragraph: () => $create(SwitchParagraph),
    flips: true,
  },
  'text beside a decorator': {
    $children: () => [$t('pre '), $create(Chip), $t(' post')],
  },
  'text siblings': {$children: () => [$t('ab'), $bold('cd'), $t('ef')]},
  'token between texts': {
    $children: () => [
      $t('ab'),
      $createTextNode('cd').setMode('token'),
      $t('ef'),
    ],
  },
};

/** Where a point may sit, by the line's nodes as they are built. */
function $pointsOf(line: ElementNode): {
  texts: BoundaryPoint[];
  elements: BoundaryPoint[];
  textKeys: NodeKey[];
} {
  const texts: BoundaryPoint[] = [];
  const elements: BoundaryPoint[] = [];
  const textKeys: NodeKey[] = [];
  const walk = (node: LexicalNode) => {
    if ($isTextNode(node)) {
      textKeys.push(node.getKey());
      const size = node.getTextContentSize();
      for (const offset of new Set([0, Math.floor(size / 2), size])) {
        texts.push({key: node.getKey(), offset, type: 'text'});
      }
    } else if ($isElementNode(node)) {
      for (let i = 0; i <= node.getChildrenSize(); i++) {
        elements.push({key: node.getKey(), offset: i, type: 'element'});
      }
      node.getChildren().forEach(walk);
    }
  };
  walk(line);
  return {elements, textKeys, texts};
}

type Case = {
  anchor: BoundaryPoint;
  focus: BoundaryPoint;
  /** The text node composed in, by its index in the line's text nodes. */
  composing: number;
  /** Text points only. */
  text: boolean;
};

/**
 * The events the editor's next update can be made for. Lexical makes the
 * selection of an update for one of `READS_DOM` from the DOM selection
 * (every stage of its pipeline, see Boundary.$nextUpdateSelection); for one of
 * `KEEPS`, it keeps the last selection as it is.
 */
const READS_DOM = [
  'beforeinput',
  'selectionchange',
  'compositionstart',
  'compositionend',
  'drop',
  'keydown-arrow',
  'click-triple',
  'none',
] as const;
const KEEPS = [
  'input',
  'compositionupdate',
  'keydown-letter',
  'click-single',
  'focus',
] as const;
type Kind = (typeof READS_DOM)[number] | (typeof KEEPS)[number];

function eventFor(kind: Kind, host: HTMLElement): Event | undefined {
  if (kind === 'none') {
    return undefined;
  }
  if (kind === 'keydown-arrow' || kind === 'keydown-letter') {
    const event = new KeyboardEvent('keydown', {
      key: kind === 'keydown-arrow' ? 'ArrowRight' : 'a',
    });
    Object.defineProperty(event, 'target', {value: host});
    return event;
  }
  if (kind === 'click-single' || kind === 'click-triple') {
    return new MouseEvent('click', {detail: kind === 'click-triple' ? 3 : 1});
  }
  return new Event(kind);
}

/**
 * The selection and the composition key, by position: a text point by its
 * node's index among the line's text nodes, an element point by its node's
 * index among the line's elements (the line first), the composition by its
 * node's index (independent of the keys of one editor).
 */
function $positional(editor: LexicalEditor): string {
  const selection = $getSelection();
  return $isRangeSelection(selection)
    ? $positionOf(selection.anchor, selection.focus, editor._compositionKey)
    : 'none';
}

function $positionOf(
  anchor: BoundaryPoint,
  focus: BoundaryPoint,
  key: NodeKey | null,
): string {
  const line = $getRoot().getFirstChild();
  const texts: NodeKey[] = [];
  const elements: NodeKey[] = [];
  const walk = (node: LexicalNode) => {
    if ($isTextNode(node)) {
      texts.push(node.getKey());
    } else if ($isElementNode(node)) {
      elements.push(node.getKey());
      node.getChildren().forEach(walk);
    }
  };
  if (line !== null) {
    walk(line);
  }
  const point = (p: BoundaryPoint) =>
    p.type === 'text'
      ? `t${texts.indexOf(p.key)}:${p.offset}`
      : `e${elements.indexOf(p.key)}:${p.offset}`;
  return `${point(anchor)}..${point(focus)} composing ${key === null ? 'none' : `t${texts.indexOf(key)}`}`;
}

/** An editor with a DOM root, for one side of the comparison. */
function mount(): {editor: LexicalEditor; host: HTMLElement} {
  const editor = createEditor({
    namespace: 'boundary',
    nodes: [LinkNode, Inline, Closed, Chip, Switch, SwitchParagraph],
    onError: e => {
      throw e;
    },
  });
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  editor.setRootElement(host);
  return {editor, host};
}

/**
 * Run the matrix (`platform` names the browser). For each selection, three
 * kinds of editors start from the same state, each its own (an update's
 * commit changes the DOM selection the next one reads):
 *
 * - the check in the read: Boundary.$normalizedAtBoundaries, for text
 *   points, on what it says the next update ends with;
 * - what the binding foresees for the next update, read-only
 *   (Boundary.$nextUpdateSelection, see YBinding#foreseeNextUpdate): it
 *   changes nothing;
 * - the editor's next update for each event Lexical knows, and what it
 *   commits (after selection transforms, the normalization of dirty text
 *   nodes and the commit's checks).
 *
 * For an event that reads the DOM selection, the next update commits what
 * the binding foresaw (and, for text points, what the check said); for one
 * that keeps the last selection, it commits that selection, the composition
 * where it was.
 */
export function runBoundaryMatrix(platform: string): void {
  test.each(Object.keys(SHAPES))(
    `the binding's view of the next update matches Lexical's, ${platform}: %s`,
    name => {
      const shape = SHAPES[name];
      const sides = [mount(), mount()];
      const differ: string[] = [];
      let count = 0;
      try {
        let points = {
          elements: [] as BoundaryPoint[],
          textKeys: [] as NodeKey[],
          texts: [] as BoundaryPoint[],
        };
        const $build = (): ElementNode => {
          const line = (
            shape.$paragraph ? shape.$paragraph() : $createParagraphNode()
          ).append(...shape.$children());
          $getRoot().clear().append(line);
          return line;
        };
        sides[0].editor.update(() => (points = $pointsOf($build())), {
          discrete: true,
        });
        const at = (key: NodeKey) => points.textKeys.indexOf(key);
        const cases: Case[] = [];
        for (const anchor of points.texts) {
          for (const focus of points.texts) {
            cases.push({anchor, composing: at(anchor.key), focus, text: true});
            if (focus.key !== anchor.key) {
              cases.push({anchor, composing: at(focus.key), focus, text: true});
            }
          }
        }
        for (const element of points.elements) {
          for (let i = 0; i < points.textKeys.length; i++) {
            cases.push({
              anchor: element,
              composing: i,
              focus: element,
              text: false,
            });
          }
          for (const text of points.texts) {
            cases.push({
              anchor: text,
              composing: at(text.key),
              focus: element,
              text: false,
            });
            cases.push({
              anchor: element,
              composing: at(text.key),
              focus: text,
              text: false,
            });
          }
        }
        /** Set `side` up for case `c`: the line built again, the selection
         * and the composition set (by position), the NodeState flipped. */
        const prepare = (editor: LexicalEditor, c: Case): boolean => {
          editor.update(
            () => {
              const fresh = $pointsOf($build());
              const map = (p: BoundaryPoint): BoundaryPoint => {
                const list = p.type === 'text' ? points.texts : points.elements;
                const now = p.type === 'text' ? fresh.texts : fresh.elements;
                return now[list.indexOf(p)];
              };
              const anchor = map(c.anchor);
              const focus = map(c.focus);
              const selection = $createRangeSelection();
              selection.anchor.set(anchor.key, anchor.offset, anchor.type);
              selection.focus.set(focus.key, focus.offset, focus.type);
              $setSelection(selection);
              $setCompositionKey(fresh.textKeys[c.composing]);
              if (shape.flips) {
                for (const n of $getRoot().getAllTextNodes()) {
                  for (
                    let up = n.getParent();
                    up !== null;
                    up = up.getParent()
                  ) {
                    if (up instanceof Switch || up instanceof SwitchParagraph) {
                      $setState(up, shut, true);
                    }
                  }
                }
              }
            },
            {discrete: true},
          );
          // A selection the setup's commit left valid (its normalization can
          // remove an empty text node that is not composed, leaving an
          // element point past the element's end).
          return editor.read(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) {
              return false;
            }
            return [selection.anchor, selection.focus].every(point => {
              const node = $getNodeByKey(point.key);
              return point.type === 'text'
                ? $isTextNode(node) && point.offset <= node.getTextContentSize()
                : $isElementNode(node) &&
                    point.offset <= node.getChildrenSize();
            });
          });
        };
        for (const c of cases) {
          const [mirror, truth] = sides;
          if (!prepare(mirror.editor, c)) {
            continue;
          }
          count++;
          const before = mirror.editor.read(() => $positional(mirror.editor));
          const said = c.text
            ? mirror.editor.read(() => {
                const selection = $getSelection();
                if (!$isRangeSelection(selection)) {
                  return 'none';
                }
                const n = $normalizedAtBoundaries(
                  selection.anchor,
                  selection.focus,
                  mirror.editor._compositionKey,
                );
                return $positionOf(n.anchor, n.focus, n.composing);
              })
            : null;
          // What the binding foresees for the next update (read-only: the
          // editor commits nothing, see after).
          const foreseen = mirror.editor.read(() => {
            const next = $nextUpdateSelection(mirror.editor);
            return next === undefined
              ? 'not foreseen'
              : next === null
                ? 'none'
                : $positionOf(next.anchor, next.focus, next.composing);
          });
          const after = mirror.editor.read(() => $positional(mirror.editor));
          if (after !== before) {
            differ.push(`${name} ${before}: foreseeing changed it to ${after}`);
          }
          for (const kind of [...READS_DOM, ...KEEPS]) {
            prepare(truth.editor, c);
            truth.editor.update(() => {}, {
              discrete: true,
              event: eventFor(kind, truth.host),
            });
            const did = truth.editor.read(() => $positional(truth.editor));
            const reads = (READS_DOM as readonly string[]).includes(kind);
            const where = `${name} ${before} (${kind})`;
            if (reads && did !== foreseen) {
              differ.push(`${where}: foreseen ${foreseen}, did ${did}`);
            }
            if (reads && said !== null && did !== said) {
              differ.push(`${where}: said ${said}, did ${did}`);
            }
            if (!reads && did !== before) {
              differ.push(`${where}: kept? did ${did}`);
            }
            truth.editor.update(() => $setCompositionKey(null), {
              discrete: true,
            });
          }
          mirror.editor.update(() => $setCompositionKey(null), {
            discrete: true,
          });
        }
        expect(count).toBeGreaterThan(0);
        expect(differ.slice(0, 20)).toEqual([]);
      } finally {
        for (const side of sides) {
          side.editor.setRootElement(null);
          side.host.remove();
        }
      }
    },
  );
}
