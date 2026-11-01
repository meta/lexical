/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {BlockWithAlignableContents} from '@lexical/react/LexicalBlockWithAlignableContents';
import {
  DecoratorBlockNode,
  type SerializedDecoratorBlockNode,
} from '@lexical/react/LexicalDecoratorBlockNode';
import {
  $getDocument,
  type DOMExportOutput,
  type EditorConfig,
  type ElementFormatType,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  nodeSchema,
  type Spread,
  stringValue,
  withAccessors,
} from 'lexical';
import * as React from 'react';
import {type JSX, useCallback, useEffect, useRef, useState} from 'react';

const tweetNodeSchema = nodeSchema<TweetNode>()({
  id: withAccessors(stringValue(), {
    getter: {
      field: '__id',
    },
  }),
});

const WIDGET_SCRIPT_URL = 'https://platform.twitter.com/widgets.js';

type TweetComponentProps = Readonly<{
  className: Readonly<{
    base: string;
    focus: string;
  }>;
  format: ElementFormatType | null;
  loadingComponent?: JSX.Element | string;
  nodeKey: NodeKey;
  onError?: (error: string) => void;
  onLoad?: () => void;
  tweetID: string;
}>;

let isTwitterScriptLoading = true;

function TweetComponent({
  className,
  format,
  loadingComponent,
  nodeKey,
  onError,
  onLoad,
  tweetID,
}: TweetComponentProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const previousTweetIDRef = useRef<string>('');
  const [isTweetLoading, setIsTweetLoading] = useState(false);

  const createTweet = useCallback(async () => {
    try {
      // @ts-expect-error Twitter is attached to the window.
      await window.twttr.widgets.createTweet(tweetID, containerRef.current);

      setIsTweetLoading(false);
      isTwitterScriptLoading = false;

      if (onLoad) {
        onLoad();
      }
    } catch (error) {
      if (onError) {
        onError(String(error));
      }
    }
  }, [onError, onLoad, tweetID]);

  useEffect(() => {
    if (tweetID !== previousTweetIDRef.current) {
      setIsTweetLoading(true);

      if (isTwitterScriptLoading) {
        const doc = containerRef.current?.ownerDocument ?? document;
        const script = doc.createElement('script');
        script.src = WIDGET_SCRIPT_URL;
        script.async = true;
        doc.body?.appendChild(script);
        script.onload = createTweet;
        if (onError) {
          script.onerror = onError as OnErrorEventHandler;
        }
      } else {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        createTweet().catch(console.error);
      }

      if (previousTweetIDRef) {
        previousTweetIDRef.current = tweetID;
      }
    }
  }, [createTweet, onError, tweetID]);

  return (
    <BlockWithAlignableContents
      className={className}
      format={format}
      nodeKey={nodeKey}>
      {isTweetLoading ? loadingComponent : null}
      <div
        style={{display: 'inline-block', width: '550px'}}
        ref={containerRef}
      />
    </BlockWithAlignableContents>
  );
}

export type SerializedTweetNode = Spread<
  {
    id: string;
  },
  SerializedDecoratorBlockNode
>;

export class TweetNode extends DecoratorBlockNode {
  __id: string;

  $config() {
    return this.config('tweet', {
      extends: DecoratorBlockNode,
      json: tweetNodeSchema,
    });
  }

  static clone(node: TweetNode): TweetNode {
    return new TweetNode(node.__id, node.__format, node.__key);
  }

  exportDOM(): DOMExportOutput {
    const element = $getDocument().createElement('div');
    element.setAttribute('data-lexical-tweet-id', this.__id);
    const text = $getDocument().createTextNode(this.getTextContent());
    element.append(text);
    return {element};
  }

  setId(id: string): this {
    const self = this.getWritable();
    self.__id = id;
    return self;
  }

  constructor(id: string = '', format?: ElementFormatType, key?: NodeKey) {
    super(format, key);
    this.__id = id;
  }

  getId(): string {
    return this.getLatest().__id;
  }

  getTextContent(
    _includeInert?: boolean | undefined,
    _includeDirectionless?: false | undefined,
  ): string {
    return `https://x.com/i/web/status/${this.__id}`;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element {
    const embedBlockTheme = config.theme.embedBlock || {};
    const className = {
      base: embedBlockTheme.base || '',
      focus: embedBlockTheme.focus || '',
    };
    return (
      <TweetComponent
        className={className}
        format={this.__format}
        loadingComponent="Loading..."
        nodeKey={this.getKey()}
        tweetID={this.__id}
      />
    );
  }
}

export function $createTweetNode(tweetID: string): TweetNode {
  return new TweetNode(tweetID);
}

export function $isTweetNode(
  node: TweetNode | LexicalNode | null | undefined,
): node is TweetNode {
  return node instanceof TweetNode;
}
