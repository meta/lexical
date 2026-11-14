/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Klass, LexicalNode} from 'lexical';

import {CodeHighlightNode, CodeNode} from '@lexical/code';
import {HorizontalRuleNode} from '@lexical/extension';
import {HashtagNode} from '@lexical/hashtag';
import {AutoLinkNode, LinkNode} from '@lexical/link';
import {ListItemNode, ListNode} from '@lexical/list';
import {MarkNode} from '@lexical/mark';
import {OverflowNode} from '@lexical/overflow';
import {HeadingNode, QuoteContainerNode, QuoteNode} from '@lexical/rich-text';
import {TableCellNode, TableNode, TableRowNode} from '@lexical/table';

import {CardNode} from '../plugins/CardExtension/CardNode';
import {CollapsibleContainerNode} from '../plugins/CollapsibleExtension/CollapsibleContainerNode';
import {CollapsibleContentNode} from '../plugins/CollapsibleExtension/CollapsibleContentNode';
import {CollapsibleTitleNode} from '../plugins/CollapsibleExtension/CollapsibleTitleNode';
import {PullQuoteNode} from '../plugins/PullQuoteExtension/PullQuoteNode';
import {ReviewNode} from '../plugins/ReviewExtension/ReviewNode';
import {DateTimeNode} from './DateTimeNode/DateTimeNode';
import {EmojiNode} from './EmojiNode';
import {EquationNode} from './EquationNode';
import {ExcalidrawNode} from './ExcalidrawNode';
import {FigmaNode} from './FigmaNode';
import {ImageNode} from './ImageNode';
import {KeywordNode} from './KeywordNode';
import {LayoutContainerNode} from './LayoutContainerNode';
import {LayoutItemNode} from './LayoutItemNode';
import {MentionNode} from './MentionNode';
import {PageBreakNode} from './PageBreakNode';
import {PollNode} from './PollNode';
import {SlotContainerNode} from './SlotContainerNode';
import {SpecialTextNode} from './SpecialTextNode';
import {StickyNode} from './StickyNode';
import {TweetNode} from './TweetNode';
import {YouTubeNode} from './YouTubeNode';

const PlaygroundNodes: Klass<LexicalNode>[] = [
  HeadingNode,
  ListNode,
  ListItemNode,
  QuoteNode,
  QuoteContainerNode,
  CodeNode,
  TableNode,
  TableCellNode,
  TableRowNode,
  HashtagNode,
  CodeHighlightNode,
  AutoLinkNode,
  LinkNode,
  OverflowNode,
  PollNode,
  StickyNode,
  ImageNode,
  MentionNode,
  EmojiNode,
  ExcalidrawNode,
  EquationNode,
  KeywordNode,
  HorizontalRuleNode,
  TweetNode,
  YouTubeNode,
  FigmaNode,
  MarkNode,
  CollapsibleContainerNode,
  CollapsibleContentNode,
  CollapsibleTitleNode,
  PageBreakNode,
  LayoutContainerNode,
  LayoutItemNode,
  SpecialTextNode,
  DateTimeNode,
  CardNode,
  SlotContainerNode,
  ReviewNode,
  PullQuoteNode,
];

export default PlaygroundNodes;
