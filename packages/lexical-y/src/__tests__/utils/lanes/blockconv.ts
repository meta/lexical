/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Block conversion lane. A composes (IME) in a block; while the composition
// holds the line back, a collaborator converts the block (to another type,
// joined into the line before it, a round trip through another type, or the
// same type) and may append an untouched block after it; A's update that ends
// the composition lets transforms run: hashtags, autolinks, code highlighting,
// app transforms that depend on the parent (bold, upper-case or a NodeState in
// headings and quotes), and, in the release-transform family, app transforms
// on headings that restructure or rewrite one (replace it, turn it into code,
// split it, move its first child out, unwrap it, upper-case or extend its
// text), registered on a heading's text nodes so that the composer's ending
// update, which dirties the held text node, runs them.
// Some histories hold an inline decorator in the line, set bold or a NodeState
// over the composed node or the whole line in the ending update, or have the
// collaborator delete the held line, delivered right after A's ending write.
//
// Checks, on this tree alone: editor errors, self-check and recovered-write
// warnings, storage structure and the paired-run grammar on every document,
// convergence of every peer and a fresh reader, the untouched block's
// characters as stored before the ending update, the inline decorator and
// the composed text kept, and the ending-phase invariant: from the stored
// state just before the ending update to the settled one, no other block
// changes (characters, attributes, block type or alignment), no block
// boundary is added or removed unless the collaborator's delete of the held
// line accounts for it, and the held line changes only as the ending update
// or a registered transform asked (never a collaborator's format, NodeState
// or block type, never a highlight token outside code).

import {$createCodeNode} from '@lexical/code';
import {
  PrismTokenizer,
  registerCodeHighlighting as registerPrism,
} from '@lexical/code-prism';
import {
  registerCodeHighlighting as registerShiki,
  ShikiTokenizer,
} from '@lexical/code-shiki';
import {HashtagNode, registerLexicalHashtag} from '@lexical/hashtag';
import {
  $isAutoLinkNode,
  $isLinkNode,
  createLinkMatcherWithRegExp,
  registerAutoLink,
} from '@lexical/link';
import {$createListItemNode, $createListNode, $isListNode} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getState,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  $setState,
  createState,
  DecoratorNode,
  type ElementNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  stringValue,
  TextNode,
} from 'lexical';

import {flush, freshReader, NODES, Peer, setup} from '../harness';
import {
  changesOf,
  convergenceFindings,
  describeChars,
  type Finding,
  flatten,
  type Lane,
  type LaneHistory,
  neutralVariants,
  peerFindings,
  pick,
  rng,
  trace,
} from './common';

class CustomParagraph extends ParagraphNode {
  $config() {
    return this.config('lane_custom_paragraph', {extends: ParagraphNode});
  }
}
class InnerParagraph extends ParagraphNode {
  $config() {
    return this.config('lane_inner_paragraph', {extends: ParagraphNode});
  }
}
class OuterParagraph extends InnerParagraph {
  $config() {
    return this.config('lane_outer_paragraph', {extends: InnerParagraph});
  }
}
class InlineAtom extends DecoratorNode<null> {
  $config() {
    return this.config('lane_inline_atom', {extends: DecoratorNode});
  }
  isInline(): boolean {
    return true;
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
  getTextContent(): string {
    return DECOR_TEXT;
  }
}

const BASE: Klass<LexicalNode>[] = [
  ...NODES,
  HashtagNode,
  CustomParagraph,
  InnerParagraph,
  OuterParagraph,
  InlineAtom,
];
const PARAGRAPH_TYPES = new Set([
  'lane_custom_paragraph',
  'lane_inner_paragraph',
  'lane_outer_paragraph',
]);
const note = createState('lane_note', {parse: stringValue()});
const parentNote = createState('lane_pnote', {parse: stringValue()});
const OBJ = '\uFFFC';
/** An inline decorator's text content. */
const DECOR_TEXT = 'x^2';
const BOLD = 1;

const BLOCKS = ['paragraph', 'heading', 'quote', 'listitem', 'code'] as const;
type Block = (typeof BLOCKS)[number];
const CONVS = [
  'paragraph',
  'heading',
  'quote',
  'listitem',
  'code',
  'join',
  'roundtrip',
  'same-paragraph',
] as const;
const CONTENT = {
  code: 'let x = 1;',
  hashtag: '#tag',
  plain: 'word',
  url: 'https://lexical.dev',
};
/** Release-transform family: what an app's heading transform does. */
const RELXFORMS = [
  'replace',
  'replace-code',
  'split',
  'movefirst',
  'unwrap',
  'upper',
  'bang',
] as const;

export type BlockConvConfig = {
  from: Block;
  conv: (typeof CONVS)[number];
  via: Block;
  align: boolean;
  content: keyof typeof CONTENT;
  hashtag: boolean;
  autolink: boolean;
  highlighter: 'Prism' | 'Shiki' | 'none';
  replacement: 'none' | 'withKlass' | 'factory' | 'chain';
  scope: 'composer' | 'all';
  endInsert: boolean;
  endBold: boolean;
  endNote: boolean;
  xformScope: 'composer' | 'all';
  firstBlock: boolean;
  parentXform: 'none' | 'bold' | 'upper' | 'note';
  pxScope: 'composer' | 'all';
  decor: boolean;
  endScope: 'node' | 'line';
  untouched: 'none' | 'code' | 'paragraph';
  deleteHeld: boolean;
  relxform: 'none' | (typeof RELXFORMS)[number];
  rxScope: 'composer' | 'all';
};

export const NEUTRAL: Partial<BlockConvConfig> = {
  align: false,
  autolink: false,
  content: 'plain',
  decor: false,
  deleteHeld: false,
  endBold: false,
  endInsert: false,
  endNote: false,
  endScope: 'node',
  firstBlock: false,
  hashtag: false,
  highlighter: 'none',
  parentXform: 'none',
  pxScope: 'composer',
  relxform: 'none',
  replacement: 'none',
  rxScope: 'composer',
  scope: 'composer',
  untouched: 'none',
  xformScope: 'composer',
};

export function generate(
  seed: number,
  gc: boolean,
): LaneHistory<BlockConvConfig> {
  const r = rng(seed * 9301 + (gc ? 7 : 0) + 11);
  const from = pick(r, BLOCKS);
  const conv = pick(r, CONVS);
  const cfg: BlockConvConfig = {
    align: r() < 0.35,
    autolink: r() < 0.65,
    content: pick(r, ['hashtag', 'hashtag', 'url', 'url', 'code', 'plain']),
    conv,
    decor: false,
    deleteHeld: false,
    endBold: r() < 0.25,
    endInsert: r() < 0.12,
    endNote: r() < 0.25,
    endScope: 'node',
    firstBlock: r() < 0.5,
    from,
    hashtag: r() < 0.75,
    highlighter: pick(r, ['Prism', 'Shiki', 'none']),
    parentXform: 'none',
    pxScope: 'composer',
    relxform: 'none',
    replacement: pick(r, ['none', 'withKlass', 'factory', 'chain']),
    rxScope: 'composer',
    scope: r() < 0.7 ? 'composer' : 'all',
    untouched: 'none',
    via: pick(
      r,
      BLOCKS.filter(b => b !== from),
    ),
    xformScope: r() < 0.6 ? 'composer' : 'all',
  };
  cfg.parentXform = r() < 0.4 ? pick(r, ['bold', 'upper', 'note']) : 'none';
  cfg.pxScope = r() < 0.6 ? 'composer' : 'all';
  cfg.decor = from !== 'code' && r() < 0.35;
  cfg.endScope = r() < 0.5 ? 'node' : 'line';
  cfg.untouched = r() < 0.4 ? pick(r, ['code', 'paragraph']) : 'none';
  cfg.deleteHeld = conv !== 'join' && r() < 0.25;
  if (cfg.deleteHeld && cfg.untouched === 'none') {
    cfg.untouched = pick(r, ['code', 'paragraph']);
  }
  // A quarter of histories: an app transform on headings that restructures
  // or rewrites the held heading where it is edited.
  if (r() < 0.25) {
    cfg.relxform = pick(r, RELXFORMS);
    cfg.rxScope = r() < 0.6 ? 'composer' : 'all';
    cfg.conv = 'heading';
    if (cfg.from === 'heading') {
      cfg.from = 'paragraph';
    }
  }
  return {
    cfg,
    gc,
    ids: seed % 2 === 0 ? [11, 22] : [22, 11],
    lane: 'blockconv',
    seed,
  };
}

function simplify(
  h: LaneHistory<BlockConvConfig>,
): LaneHistory<BlockConvConfig>[] {
  const out = neutralVariants(h.cfg, NEUTRAL).map(cfg => ({...h, cfg}));
  if (h.cfg.conv === 'roundtrip') {
    out.push({...h, cfg: {...h.cfg, conv: 'same-paragraph'}});
  }
  if (h.cfg.from !== 'paragraph' && h.cfg.from !== 'code') {
    out.push({...h, cfg: {...h.cfg, from: 'paragraph'}});
  }
  if (h.gc) {
    out.push({...h, gc: false});
  }
  return out;
}

function replacements(mode: BlockConvConfig['replacement']) {
  if (mode === 'withKlass') {
    return [
      {
        replace: ParagraphNode,
        with: () => new CustomParagraph(),
        withKlass: CustomParagraph,
      },
    ];
  }
  if (mode === 'factory') {
    return [{replace: ParagraphNode, with: () => new CustomParagraph()}];
  }
  if (mode === 'chain') {
    return [
      {
        replace: ParagraphNode,
        with: () => $create(InnerParagraph),
        withKlass: InnerParagraph,
      },
      {
        replace: InnerParagraph,
        with: () => $create(OuterParagraph),
        withKlass: OuterParagraph,
      },
    ];
  }
  return [];
}

/** The harness takes classes; an editor's nodes may also be replacements. */
const withReplacements = (repl: ReturnType<typeof replacements>) =>
  [...BASE, ...repl] as unknown as Klass<LexicalNode>[];

function registerParentXform(
  editor: LexicalEditor,
  kind: BlockConvConfig['parentXform'],
) {
  if (kind === 'none') {
    return;
  }
  editor.registerNodeTransform(TextNode, n => {
    const p = n.getParent();
    if (!($isHeadingNode(p) || $isQuoteNode(p))) {
      return;
    }
    if (kind === 'bold' && !n.hasFormat('bold')) {
      n.toggleFormat('bold');
    }
    const text = n.getTextContent();
    if (kind === 'upper' && text !== text.toUpperCase()) {
      n.setTextContent(text.toUpperCase());
    }
    if (kind === 'note' && $getState(n, parentNote) !== 'H') {
      $setState(n, parentNote, 'H');
    }
  });
}

function $flattenInto(target: ElementNode, from: ElementNode) {
  for (const k of from.getChildren()) {
    if ($isElementNode(k)) {
      target.append(...k.getChildren());
    } else {
      target.append(k);
    }
  }
}

/** An app transform on the held heading that restructures or rewrites it. */
/**
 * Whether the composer's app transform on the held heading changed it during
 * the ending phase of the current history (`active` between the composer's
 * ending update and the settled state; reset by `run`): the ending-phase
 * invariant lets through what such a transform writes only then.
 */
const relXformLog = {active: false, ran: false};

function registerRelXform(
  editor: LexicalEditor,
  kind: BlockConvConfig['relxform'],
  composer: boolean,
) {
  if (kind === 'none') {
    return;
  }
  const mutated = () => {
    if (composer && relXformLog.active) {
      relXformLog.ran = true;
    }
  };
  // On the heading's text, which an edit of the heading dirties (an
  // element transform runs only when the element itself is marked dirty).
  editor.registerNodeTransform(TextNode, n => {
    const h = n.getParent();
    if (
      !$isHeadingNode(h) ||
      !h.getTextContent().toLowerCase().includes('see')
    ) {
      return;
    }
    if (kind === 'replace') {
      h.replace($createParagraphNode(), true);
      mutated();
    } else if (kind === 'replace-code') {
      const code = $createCodeNode('javascript');
      $flattenInto(code, h);
      h.replace(code);
      mutated();
    } else if (kind === 'split') {
      if (h.getChildrenSize() > 1) {
        h.insertAfter($createParagraphNode().append(h.getLastChildOrThrow()));
        mutated();
      }
    } else if (kind === 'movefirst') {
      if (h.getChildrenSize() > 1) {
        h.insertBefore($createParagraphNode().append(h.getFirstChildOrThrow()));
        mutated();
      }
    } else if (kind === 'unwrap') {
      const prev = h.getPreviousSibling();
      if ($isParagraphNode(prev)) {
        prev.append(...h.getChildren());
        h.remove();
      } else {
        h.replace($createParagraphNode(), true);
      }
      mutated();
    } else if (kind === 'upper') {
      for (const t of h.getAllTextNodes()) {
        const text = t.getTextContent();
        if (text !== text.toUpperCase()) {
          t.setTextContent(text.toUpperCase());
          mutated();
        }
      }
    } else {
      const last = h.getLastDescendant();
      if ($isTextNode(last) && !last.getTextContent().endsWith('!')) {
        last.setTextContent(last.getTextContent() + '!');
        mutated();
      }
    }
  });
}

function makePrepare(cfg: BlockConvConfig, composer: boolean) {
  return (editor: LexicalEditor) => {
    if (composer || cfg.xformScope === 'all') {
      if (cfg.hashtag) {
        registerLexicalHashtag(editor);
      }
      if (cfg.autolink) {
        registerAutoLink(editor, {
          changeHandlers: [],
          excludeParents: [],
          matchers: [createLinkMatcherWithRegExp(/https?:\/\/[^\s]+/)],
        });
      }
      if (cfg.highlighter === 'Prism') {
        registerPrism(editor, PrismTokenizer);
      } else if (cfg.highlighter === 'Shiki') {
        registerShiki(editor, ShikiTokenizer);
      }
    }
    if (composer || cfg.pxScope === 'all') {
      registerParentXform(editor, cfg.parentXform);
    }
    if (composer || cfg.rxScope === 'all') {
      registerRelXform(editor, cfg.relxform, composer);
    }
  };
}

function $makeBlock(kind: Block): ElementNode {
  if (kind === 'heading') {
    return $createHeadingNode('h2');
  }
  if (kind === 'quote') {
    return $createQuoteNode();
  }
  if (kind === 'code') {
    return $createCodeNode('javascript');
  }
  if (kind === 'listitem') {
    return $createListItemNode();
  }
  return $createParagraphNode();
}
function $container(kind: Block, block: ElementNode): ElementNode {
  return kind === 'listitem' ? $createListNode('bullet').append(block) : block;
}
function $targetBlock(target: number): ElementNode {
  const c = $getRoot().getChildAtIndex(target) as ElementNode;
  return $isListNode(c) ? (c.getFirstChildOrThrow() as ElementNode) : c;
}
function $convert(target: number, to: Block, align: boolean) {
  const container = $getRoot().getChildAtIndex(target) as ElementNode;
  const next = $makeBlock(to);
  const block = $targetBlock(target);
  if (to === 'code') {
    $flattenInto(next, block);
  } else {
    next.append(...block.getChildren());
  }
  if (align) {
    next.setFormat('center');
  }
  container.replace($container(to, next));
}

type Char = {
  ch: string;
  kind: string;
  fmt: number;
  note: string;
  pnote: string;
};
export type View = {type: string; format: string; chars: Char[]}[];

function $charsOf(el: ElementNode): Char[] {
  const out: Char[] = [];
  for (const n of el.getChildren()) {
    if ($isTextNode(n)) {
      for (const ch of n.getTextContent()) {
        out.push({
          ch,
          fmt: n.getFormat(),
          kind: n.getType(),
          note: $getState(n, note),
          pnote: $getState(n, parentNote),
        });
      }
    } else if ($isDecoratorNode(n)) {
      out.push({
        ch: OBJ,
        fmt: 0,
        kind: 'deco:' + n.getType(),
        note: '',
        pnote: '',
      });
    } else if ($isLineBreakNode(n)) {
      out.push({ch: '\n', fmt: 0, kind: 'linebreak', note: '', pnote: ''});
    } else if ($isElementNode(n)) {
      const wrapper = $isAutoLinkNode(n)
        ? 'autolink>'
        : $isLinkNode(n)
          ? 'link>'
          : n.getType() + '>';
      for (const c of $charsOf(n)) {
        out.push({...c, kind: wrapper + c.kind});
      }
    }
  }
  return out;
}

function view(p: Peer): View {
  return p.read(() => {
    const blocks: View = [];
    const push = (b: ElementNode, type: string) =>
      blocks.push({
        chars: $charsOf(b),
        format: b.getFormatType(),
        type: PARAGRAPH_TYPES.has(type) ? 'paragraph' : type,
      });
    for (const c of $getRoot().getChildren()) {
      if ($isListNode(c)) {
        for (const item of c.getChildren()) {
          push(item as ElementNode, 'listitem');
        }
      } else if ($isElementNode(c)) {
        push(c, c.getType());
      }
    }
    return blocks;
  });
}

async function storedView(bytes: Uint8Array, gc: boolean): Promise<View> {
  const net = {
    delivery: 'causal' as const,
    peers: [],
    pumping: false,
    queue: [],
  };
  const p = new Peer(98, net, BASE, undefined, false, gc);
  try {
    Y.applyUpdate(p.doc, bytes, 'load');
    p.binding.initialize();
    await flush();
    return view(p);
  } finally {
    p.stop();
  }
}

const textOf = (v: View) =>
  v.map(b => b.chars.map(c => c.ch).join('')).join('\n');
const describeBlock = (b: View[number]) =>
  `${b.type}(${b.format}) ${describeChars(b.chars)}`;
const UNTOUCHED = 'let untouched = 1;';
/** The untouched block, cut to its own characters. */
function untouchedOf(v: View): View[number] | undefined {
  for (const b of v) {
    const at = b.chars
      .map(c => c.ch)
      .join('')
      .indexOf(UNTOUCHED);
    if (at >= 0) {
      return {...b, chars: b.chars.slice(at, at + UNTOUCHED.length)};
    }
  }
  return undefined;
}

/**
 * The self-check compares the editor's node types with the stored ones: a
 * paragraph made by a node replacement on the composer (the class an editor
 * with that replacement makes for every stored paragraph) is reported as a
 * mismatch, although a fresh reader with that configuration reads the same.
 * One warning joins several problems with `; `: only those mismatches are
 * dropped, and the finding only when nothing else is left.
 */
const REPLACEMENT_MISMATCH =
  /\.type: editor "lane_(custom|inner|outer)_paragraph" != shared "paragraph"$/;
function withoutReplacementMismatches(f: Finding): Finding | null {
  const m =
    f.cls === 'self-check'
      ? /^(.*?self-check(?: \(remote\))?: )([\s\S]*)$/.exec(f.detail)
      : null;
  if (m === null) {
    return f;
  }
  const kept = m[2].split('; ').filter(p => !REPLACEMENT_MISMATCH.test(p));
  return kept.length === 0 ? null : {...f, detail: m[1] + kept.join('; ')};
}

async function run(h: LaneHistory<BlockConvConfig>): Promise<Finding[]> {
  const {cfg, gc, ids} = h;
  relXformLog.active = false;
  relXformLog.ran = false;
  const target = cfg.firstBlock && cfg.conv !== 'join' ? 0 : 1;
  const repl = replacements(cfg.replacement);
  const t = await setup(
    () => {
      const intro = $createParagraphNode().append($createTextNode('intro'));
      const b = $makeBlock(cfg.from);
      if (cfg.decor) {
        b.append($create(InlineAtom));
      }
      b.append($createTextNode('see '));
      if (target === 0) {
        $getRoot().append($container(cfg.from, b), intro);
      } else {
        $getRoot().append(intro, $container(cfg.from, b));
      }
    },
    {
      gc,
      ids,
      nodes: cfg.scope === 'all' ? withReplacements(repl) : BASE,
      prepare: makePrepare(cfg, false),
      withBlockIds: false,
    },
  );
  const net = {
    delivery: 'causal' as const,
    peers: [],
    pumping: false,
    queue: [],
  };
  const a = new Peer(
    33,
    net,
    withReplacements(repl),
    makePrepare(cfg, true),
    false,
    gc,
  );
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  const deliver = (from: Peer, to: Peer) =>
    Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc), 'transport');
  const peers: Peer[] = [...t.peers, a];
  let fresh: Peer | undefined;
  let hook: ((tr: Y.Transaction) => void) | null = null;
  try {
    deliver(t.a, a);
    a.binding.initialize();
    await flush();
    a.editor.setRootElement(host);
    host.focus();
    let key = '';
    a.update(() => {
      const ns = $targetBlock(target).getAllTextNodes();
      const n = ns[ns.length - 1];
      n.select(n.getTextContentSize(), n.getTextContentSize());
      key = n.getKey();
      $setCompositionKey(key);
      const sel = $getSelection();
      if ($isRangeSelection(sel)) {
        sel.insertText(CONTENT[cfg.content]);
      }
    });
    deliver(a, t.a);
    await t.sync();
    trace('A composed', {A: a, B: t.b, C: t.a});
    t.b.update(() => {
      if (cfg.conv === 'join') {
        const intro = $getRoot().getFirstChildOrThrow() as ElementNode;
        const container = $getRoot().getChildAtIndex(target) as ElementNode;
        intro.append(...$targetBlock(target).getChildren());
        container.remove();
        if (cfg.align) {
          intro.setFormat('center');
        }
      } else if (cfg.conv === 'roundtrip') {
        $convert(target, cfg.via, false);
      } else if (cfg.conv === 'same-paragraph') {
        $convert(target, 'paragraph', cfg.align);
      } else {
        $convert(target, cfg.conv, cfg.align);
      }
      if (cfg.untouched !== 'none') {
        const text = $setState(
          $createTextNode(UNTOUCHED).setFormat('underline'),
          note,
          'old',
        );
        const blk =
          cfg.untouched === 'code'
            ? $createCodeNode('javascript')
            : $createParagraphNode();
        blk.append(text);
        const anchor = $getRoot().getChildAtIndex(
          cfg.conv === 'join' ? 0 : target,
        );
        if (anchor) {
          anchor.insertAfter(blk);
        } else {
          $getRoot().append(blk);
        }
      }
      $setSelection(null);
    });
    await t.sync();
    if (cfg.conv === 'roundtrip') {
      t.b.update(() => {
        $convert(target, cfg.from, cfg.align);
        $setSelection(null);
      });
      await t.sync();
    }
    deliver(t.a, a);
    await flush();
    trace('B converted', {A: a, B: t.b, C: t.a});
    let deleted = false;
    if (cfg.deleteHeld) {
      // B deletes the held line; A receives it right after its ending write.
      t.offline();
      t.b.update(() => {
        $getRoot()
          .getChildAtIndex(cfg.conv === 'join' ? 0 : target)
          ?.remove();
        $setSelection(null);
      });
      const remote = Y.encodeStateAsUpdate(t.b.doc, Y.encodeStateVector(a.doc));
      hook = (tr: Y.Transaction) => {
        if (!deleted && tr.origin === a.binding) {
          deleted = true;
          Y.applyUpdate(a.doc, remote, 'provider-after-write');
        }
      };
      a.doc.on('afterTransactionCleanup', hook);
      trace('B deleted the held line', {A: a, B: t.b, C: t.a});
    }
    const preEnd = Y.encodeStateAsUpdate(a.doc);
    relXformLog.active = true;
    a.update(() => {
      $setCompositionKey(null);
      const n = $getNodeByKey(key);
      if (!$isTextNode(n) || !n.isAttached()) {
        $setSelection(null);
        return;
      }
      const blk = n.getParent();
      n.getWritable();
      if (cfg.endInsert) {
        n.select(n.getTextContentSize(), n.getTextContentSize());
        const sel = $getSelection();
        if ($isRangeSelection(sel)) {
          sel.insertText(' z');
        }
      }
      const targets =
        cfg.endScope === 'line' && blk ? blk.getAllTextNodes() : [n];
      for (const tn of targets) {
        if (cfg.endBold && !tn.hasFormat('bold')) {
          tn.toggleFormat('bold');
        }
        if (cfg.endNote) {
          $setState(tn, note, 'N');
        }
      }
      $setSelection(null);
    });
    await flush();
    trace('A ended its composition', {A: a, B: t.b, C: t.a});
    if (hook) {
      a.doc.off('afterTransactionCleanup', hook);
      hook = null;
      t.b.online = true;
      t.a.online = true;
    }
    for (let round = 0; round < 3; round++) {
      deliver(a, t.a);
      await t.sync();
      deliver(t.a, a);
      await flush();
    }
    fresh = await freshReader(a);
    trace('synced', {A: a, B: t.b, C: t.a, fresh});
    const all = [...peers, fresh];
    // As the traces name them: t.a is C, t.b is B.
    const labels = ['C', 'B', 'A', 'fresh'];
    const findings: Finding[] = [];
    all.forEach((p, i) => {
      for (const f of peerFindings(p, labels[i])) {
        const kept = withoutReplacementMismatches(f);
        if (kept !== null) {
          findings.push(kept);
        }
      }
    });
    relXformLog.active = false;
    const views = all.map(view);
    findings.push(...convergenceFindings(views, labels));
    const final = views[views.length - 1];
    const pre = await storedView(preEnd, gc);
    // The collaborator's untouched block keeps its characters as stored
    // before the ending update (text the composer wrote into the line a
    // collaborator deleted joins the next line, so the block may gain text
    // before its own).
    const preUntouched = untouchedOf(pre);
    if (preUntouched !== undefined) {
      const now = untouchedOf(final);
      if (
        now === undefined ||
        now.type !== preUntouched.type ||
        JSON.stringify(now.chars) !== JSON.stringify(preUntouched.chars)
      ) {
        findings.push({
          cls: 'untouched-block-changed',
          detail: `${describeBlock(preUntouched)} -> ${now ? describeBlock(now) : 'gone'}`,
        });
      }
    }
    if (!cfg.deleteHeld) {
      const count = (v: View) => [...textOf(v)].filter(c => c === OBJ).length;
      // A code highlighter turns an inline decorator in a code block into
      // text, with or without collaboration.
      const inCode = final.some(
        b => b.type === 'code' && textOf([b]).toLowerCase().includes('see'),
      );
      if (
        count(final) < count(pre) &&
        !(inCode && cfg.highlighter !== 'none')
      ) {
        findings.push({
          cls: 'decorator-lost',
          detail: `${count(pre)} -> ${count(final)}: ${textOf(final)}`,
        });
      }
      const typed = CONTENT[cfg.content].toLowerCase();
      // Block boundaries aside: a collaborator's split or move-first
      // transform may put one inside the composed text.
      if (!textOf(final).toLowerCase().replaceAll('\n', '').includes(typed)) {
        findings.push({
          cls: 'composed-text-lost',
          detail: `${JSON.stringify(typed)} not in ${JSON.stringify(textOf(final))}`,
        });
      }
    }
    // The ending phase's net effect: from the stored state just before the
    // ending update to the stored state once every write has settled (the
    // collaborators make no edit in between, except deleting the held line).
    findings.push(
      ...endingPhase(
        cfg,
        pre,
        await storedView(Y.encodeStateAsUpdate(a.doc), gc),
        relXformLog.ran,
      ),
    );
    return findings;
  } finally {
    if (hook) {
      a.doc.off('afterTransactionCleanup', hook);
    }
    fresh?.stop();
    a.editor.setRootElement(null);
    host.remove();
    for (const p of peers) {
      p.stop();
    }
  }
}

const ATTRS = ['kind', 'fmt', 'note', 'pnote'] as const;

/**
 * The ending-phase invariant, on stored views: from `pre`, the stored state
 * just before the composer's ending update, to `after`, once its writes have
 * settled, the held line changes only as the ending update or a registered
 * transform asked, no other block changes (characters, attributes, block
 * type or alignment), and no block boundary is added or removed, except
 * what the collaborator's delete of the held line accounts for. What a
 * release transform writes is let through only when the composer's
 * transform changed the held heading during the ending phase
 * (`relXformRan`), and only as that transform writes it.
 */
export function endingPhase(
  cfg: BlockConvConfig,
  pre: View,
  after: View,
  /**
   * Whether the composer's app transform on the held heading changed it in
   * the ending phase: only then is what it writes let through.
   */
  relXformRan: boolean,
): Finding[] {
  const rel = relXformRan ? cfg.relxform : 'none';
  const held = pre.findIndex(b =>
    b.chars
      .map(c => c.ch)
      .join('')
      .toLowerCase()
      .includes('see '),
  );
  // Upper-casing transforms rewrite letters: a parent-dependent one those of
  // headings and quotes, and of the held line (the composer runs it on the
  // line as its editor has it, which may still be a heading or quote); the
  // release transform, the held line's. Where one may run, characters are
  // aligned case-folded, and a case change is judged where it falls (`och`,
  // the character as stored).
  const parentUpper = cfg.parentXform === 'upper';
  const casefold = parentUpper || rel === 'upper';
  const prep = (v: View) =>
    flatten(v).map(c =>
      c === null || !casefold ? c : {...c, ch: c.ch.toUpperCase(), och: c.ch},
    );
  const ref = prep(pre);
  const changes = changesOf(ref, ref, prep(after), [
    ...ATTRS,
    'bformat',
    ...(casefold ? ['och'] : []),
  ]);
  // The block of `ref` a change is in: an insertion goes into the block
  // that holds the character it follows, or the block after a boundary it
  // follows (block 0 when it follows nothing).
  const blockOf = (at: number | null): number => {
    if (at === null) {
      return 0;
    }
    const c = ref[at];
    return c !== null
      ? c.block
      : ref.slice(0, at + 1).filter(x => x === null).length;
  };
  const blockOfDel = (at: number | null) => {
    const c = at === null ? null : ref[at];
    return c === null ? -1 : c.block;
  };
  // Text the ending phase may write, by character and count: in the held
  // line, what the ending update types (' z'); and when the collaborator
  // deletes the held line, what the ending update wrote into it survives
  // and joins the next line (a line is not a container: delete wins only
  // for containers), at most the held line's own characters and the typed
  // text, in any block.
  const allowance = new Map<string, number>();
  const allow = (text: string) => {
    for (const ch of text) {
      allowance.set(ch, (allowance.get(ch) ?? 0) + 1);
    }
  };
  if (cfg.endInsert) {
    allow(casefold ? ' Z' : ' z');
  }
  if (cfg.deleteHeld && held >= 0) {
    allow(
      ref
        .filter(c => c !== null && c.block === held)
        .map(c => c!.ch)
        .join(''),
    );
  }
  // A trailing-'!' transform adds one '!'.
  if (rel === 'bang') {
    allow('!');
  }
  // A code highlighter turns an inline decorator of a line made code into
  // its text: once per decorator deleted from the held line.
  const decorToText = rel === 'replace-code' && cfg.highlighter !== 'none';
  if (decorToText) {
    for (const c of changes) {
      if (c.kind === 'del' && c.ch === OBJ && blockOfDel(c.at) === held) {
        allow(DECOR_TEXT);
      }
    }
  }
  // The collaborator's delete of the held line removes one boundary, and a
  // block of text that survives it may add one; an unwrap transform removes
  // one; a split or move-first transform adds them in the held line, at
  // most one per character of it. Where a removed boundary falls is
  // ambiguous to the alignment, which cannot tell one boundary from another.
  let boundaryDel = (cfg.deleteHeld ? 1 : 0) + (rel === 'unwrap' ? 1 : 0);
  let boundaryIns = cfg.deleteHeld ? 1 : 0;
  let heldSplits =
    (rel === 'split' || rel === 'movefirst') && held >= 0
      ? pre[held].chars.length
      : 0;
  // What a restructuring transform makes of the held line: its new block
  // type, with no alignment.
  const madeType =
    rel === 'replace-code'
      ? 'code'
      : rel === 'replace' ||
          rel === 'unwrap' ||
          rel === 'split' ||
          rel === 'movefirst'
        ? 'paragraph'
        : null;
  const out: Finding[] = [];
  const bad = (what: string, detail: string) =>
    out.push({cls: `ending-phase-${what}`, detail});
  for (const c of changes) {
    if (c.kind === 'boundary') {
      const asked =
        c.op === 'del'
          ? boundaryDel-- > 0
          : (c.block === held && heldSplits-- > 0) || boundaryIns-- > 0;
      if (!asked) {
        bad(
          'boundary',
          `a block boundary ${c.op === 'ins' ? 'added' : 'removed'} near block ${c.block} (held: ${held})`,
        );
      }
      continue;
    }
    const onHeld = blockOf(c.at) === held;
    if (c.kind === 'ins') {
      const left = allowance.get(c.ch) ?? 0;
      allowance.set(c.ch, left - 1);
      if (left <= 0 || !(onHeld || cfg.deleteHeld)) {
        bad(
          'text',
          `ins ${JSON.stringify(c.ch)} ${onHeld ? 'in the held line' : 'in another block'}`,
        );
      }
      continue;
    }
    if (c.kind === 'del') {
      if (!(onHeld && (cfg.deleteHeld || (decorToText && c.ch === OBJ)))) {
        bad(
          'text',
          `del ${JSON.stringify(c.ch)} ${onHeld ? 'in the held line' : 'in another block'}`,
        );
      }
      continue;
    }
    // The held line is gone: what still maps to its characters is text the
    // ending update wrote into it, joined to the next line.
    if (cfg.deleteHeld && onHeld) {
      continue;
    }
    const {attr, from, to, char} = c;
    const where = `${attr} ${JSON.stringify(from)} -> ${JSON.stringify(to)} on ${JSON.stringify(char.ch)} (${char.btype})`;
    if (attr === 'och') {
      const upperCased = to === String(from).toUpperCase();
      const asked = onHeld
        ? casefold
        : parentUpper && (char.btype === 'heading' || char.btype === 'quote');
      if (!(upperCased && asked)) {
        bad(onHeld ? 'text' : 'other-block', where);
      }
      continue;
    }
    if (!onHeld) {
      bad('other-block', where);
      continue;
    }
    // An autolink wrap writes its text anew, as a new text node in the link,
    // which a parent-dependent transform no longer sees in the block.
    if (
      cfg.autolink &&
      (attr === 'kind' ||
        attr === 'fmt' ||
        attr === 'note' ||
        attr === 'pnote') &&
      String(c.after.kind).startsWith('autolink>') &&
      !String(c.char.kind).startsWith('autolink>')
    ) {
      continue;
    }
    if (attr === 'kind') {
      if (String(to).includes('code-highlight') && c.after.btype !== 'code') {
        bad('code-highlight-outside-code', where);
      }
      continue;
    }
    if (attr === 'btype') {
      if (to !== madeType) {
        bad('block-type', where);
      }
      continue;
    }
    if (attr === 'bformat') {
      if (!(madeType !== null && to === '')) {
        bad('block-format', where);
      }
      continue;
    }
    if (attr === 'fmt') {
      const f = from as number;
      const t = to as number;
      const tokens =
        String(c.after.kind).includes('code-highlight') ||
        c.after.btype === 'code';
      const boldOnly = (f & ~t) === 0 && (t & ~f) === BOLD;
      const boldAsked =
        cfg.endBold ||
        (cfg.parentXform === 'bold' &&
          (char.btype === 'heading' || char.btype === 'quote'));
      if (!tokens && !(boldOnly && boldAsked)) {
        bad('format', where);
      }
    } else if (attr === 'note') {
      if (!(cfg.endNote && to === 'N')) {
        bad('state', where);
      }
    } else if (attr === 'pnote') {
      if (!(cfg.parentXform === 'note' && to === 'H')) {
        bad('state', where);
      }
    }
  }
  return out;
}

export const blockConvLane: Lane<BlockConvConfig> = {
  generate,
  name: 'blockconv',
  run,
  simplify,
};
