/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeHighlightNode, $createCodeNode} from '@lexical/code';
import {$createLinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$createTableNodeWithDimensions} from '@lexical/table';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {describe, expect, test} from 'vitest';

import {initializeUnitTest} from '../utils';

function $createEditorContent() {
  const root = $getRoot();
  if (root.getFirstChild() === null) {
    const heading = $createHeadingNode('h1');
    heading.append($createTextNode('Welcome to the playground'));
    root.append(heading);
    const quote = $createQuoteNode();
    quote.append(
      $createTextNode(
        `In case you were wondering what the black box at the bottom is – it's the debug view, showing the current state of the editor. ` +
          `You can disable it by pressing on the settings control in the bottom-left of your screen and toggling the debug view setting.`,
      ),
    );
    root.append(quote);
    const paragraph = $createParagraphNode();
    paragraph.append(
      $createTextNode('The playground is a demo environment built with '),
      $createTextNode('@lexical/react').toggleFormat('code'),
      $createTextNode('.'),
      $createTextNode(' Try typing in '),
      $createTextNode('some text').toggleFormat('bold'),
      $createTextNode(' with '),
      $createTextNode('different').toggleFormat('italic'),
      $createTextNode(' formats.'),
    );
    root.append(paragraph);
    const paragraph2 = $createParagraphNode();
    paragraph2.append(
      $createTextNode(
        'Make sure to check out the various plugins in the toolbar. You can also use #hashtags or @-mentions too!',
      ),
    );
    root.append(paragraph2);
    const paragraph3 = $createParagraphNode();
    paragraph3.append(
      $createTextNode(`If you'd like to find out more about Lexical, you can:`),
    );
    root.append(paragraph3);
    const list = $createListNode('bullet');
    list.append(
      $createListItemNode().append(
        $createTextNode(`Visit the `),
        $createLinkNode('https://lexical.dev/').append(
          $createTextNode('Lexical website'),
        ),
        $createTextNode(` for documentation and more information.`),
      ),
      $createListItemNode().append(
        $createTextNode(`Check out the code on our `),
        $createLinkNode('https://github.com/meta/lexical').append(
          $createTextNode('GitHub repository'),
        ),
        $createTextNode(`.`),
      ),
      $createListItemNode().append(
        $createTextNode(`Playground code can be found `),
        $createLinkNode(
          'https://github.com/meta/lexical/tree/main/packages/lexical-playground',
        ).append($createTextNode('here')),
        $createTextNode(`.`),
      ),
      $createListItemNode().append(
        $createTextNode(`Join our `),
        $createLinkNode('https://discord.com/invite/KmG4wQnnD9').append(
          $createTextNode('Discord Server'),
        ),
        $createTextNode(` and chat with the team.`),
      ),
    );
    root.append(list);
    const paragraph4 = $createParagraphNode();
    paragraph4.append(
      $createTextNode(
        `Lastly, we're constantly adding cool new features to this playground. So make sure you check back here when you next get a chance :).`,
      ),
    );
    root.append(paragraph4);
    const codeBlock = $createCodeNode('javascript');
    codeBlock.append($createCodeHighlightNode('const lexical = "awesome"'));
    root.append(codeBlock);
    const table = $createTableNodeWithDimensions(5, 5, true);
    root.append(table);
  }
}

describe('LexicalSerialization tests', () => {
  initializeUnitTest(testEnv => {
    test('serializes and deserializes from JSON', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        $createEditorContent();
      });

      const stringifiedEditorState = JSON.stringify(editor.getEditorState());
      const expectedStringifiedEditorState = `{"root":{"children":[{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"Welcome to the playground","type":"text","version":1}],"direction":null,"format":"","indent":0,"type":"heading","version":1,"tag":"h1"},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"In case you were wondering what the black box at the bottom is – it's the debug view, showing the current state of the editor. You can disable it by pressing on the settings control in the bottom-left of your screen and toggling the debug view setting.","type":"text","version":1}],"direction":null,"format":"","indent":0,"type":"quote","version":1},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"The playground is a demo environment built with ","type":"text","version":1},{"detail":0,"format":16,"mode":"normal","style":"","text":"@lexical/react","type":"text","version":1},{"detail":0,"format":0,"mode":"normal","style":"","text":". Try typing in ","type":"text","version":1},{"detail":0,"format":1,"mode":"normal","style":"","text":"some text","type":"text","version":1},{"detail":0,"format":0,"mode":"normal","style":"","text":" with ","type":"text","version":1},{"detail":0,"format":2,"mode":"normal","style":"","text":"different","type":"text","version":1},{"detail":0,"format":0,"mode":"normal","style":"","text":" formats.","type":"text","version":1}],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"Make sure to check out the various plugins in the toolbar. You can also use #hashtags or @-mentions too!","type":"text","version":1}],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"If you'd like to find out more about Lexical, you can:","type":"text","version":1}],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1},{"children":[{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"Visit the ","type":"text","version":1},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"Lexical website","type":"text","version":1}],"direction":null,"format":"","indent":0,"type":"link","version":1,"rel":null,"target":null,"title":null,"url":"https://lexical.dev/"},{"detail":0,"format":0,"mode":"normal","style":"","text":" for documentation and more information.","type":"text","version":1}],"direction":null,"format":"","indent":0,"type":"listitem","version":1,"value":1},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"Check out the code on our ","type":"text","version":1},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"GitHub repository","type":"text","version":1}],"direction":null,"format":"","indent":0,"type":"link","version":1,"rel":null,"target":null,"title":null,"url":"https://github.com/meta/lexical"},{"detail":0,"format":0,"mode":"normal","style":"","text":".","type":"text","version":1}],"direction":null,"format":"","indent":0,"type":"listitem","version":1,"value":2},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"Playground code can be found ","type":"text","version":1},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"here","type":"text","version":1}],"direction":null,"format":"","indent":0,"type":"link","version":1,"rel":null,"target":null,"title":null,"url":"https://github.com/meta/lexical/tree/main/packages/lexical-playground"},{"detail":0,"format":0,"mode":"normal","style":"","text":".","type":"text","version":1}],"direction":null,"format":"","indent":0,"type":"listitem","version":1,"value":3},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"Join our ","type":"text","version":1},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"Discord Server","type":"text","version":1}],"direction":null,"format":"","indent":0,"type":"link","version":1,"rel":null,"target":null,"title":null,"url":"https://discord.com/invite/KmG4wQnnD9"},{"detail":0,"format":0,"mode":"normal","style":"","text":" and chat with the team.","type":"text","version":1}],"direction":null,"format":"","indent":0,"type":"listitem","version":1,"value":4}],"direction":null,"format":"","indent":0,"type":"list","version":1,"listType":"bullet","start":1,"tag":"ul"},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"Lastly, we're constantly adding cool new features to this playground. So make sure you check back here when you next get a chance :).","type":"text","version":1}],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1},{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"const lexical = \\"awesome\\"","type":"code-highlight","version":1}],"direction":null,"format":"","indent":0,"type":"code","version":1,"language":"javascript"},{"children":[{"children":[{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":3,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":1,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":1,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":1,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":1,"rowSpan":1}],"direction":null,"format":"","indent":0,"type":"tablerow","version":1},{"children":[{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":2,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1}],"direction":null,"format":"","indent":0,"type":"tablerow","version":1},{"children":[{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":2,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1}],"direction":null,"format":"","indent":0,"type":"tablerow","version":1},{"children":[{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":2,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1}],"direction":null,"format":"","indent":0,"type":"tablerow","version":1},{"children":[{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":2,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1},{"children":[{"children":[],"direction":null,"format":"","indent":0,"textFormat":0,"textStyle":"","type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"tablecell","version":1,"backgroundColor":null,"colSpan":1,"headerState":0,"rowSpan":1}],"direction":null,"format":"","indent":0,"type":"tablerow","version":1}],"direction":null,"format":"","indent":0,"type":"table","version":1}],"direction":null,"format":"","indent":0,"type":"root","version":1}}`;

      expect(JSON.parse(stringifiedEditorState)).toEqual(
        JSON.parse(expectedStringifiedEditorState),
      );

      // Check that this JSON round-trips
      const editorState = editor.parseEditorState(stringifiedEditorState);
      const otherStringifiedEditorState = JSON.stringify(editorState);
      expect(JSON.parse(otherStringifiedEditorState)).toEqual(
        JSON.parse(expectedStringifiedEditorState),
      );
    });
  });
});
