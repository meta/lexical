/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import Link from '@docusaurus/Link';
import Translate from '@docusaurus/Translate';

export default function CommunityHowToContribute() {
  return (
    <div className="flex flex-col">
      <h2>
        <Translate
          id="pages.community.howTo.howToSubHeader"
          description="Subtitle of section on contribution guidelines">
          How to contribute
        </Translate>
      </h2>
      <p>
        <Translate
          id="pages.community.howTo.beforeParticipating"
          description="Phrase before paragraph listing documents and policies to read before contributing">
          Before participating in Lexical's communities, please read our
        </Translate>{' '}
        <Link to="https://github.com/meta/lexical/blob/main/CODE_OF_CONDUCT.md">
          <Translate
            id="pages.community.howTo.codeOfConductLink"
            description="Hyperlink to code of conduct">
            Code of Conduct
          </Translate>
        </Link>
        .{' '}
        <Translate
          id="pages.community.howTo.covenant"
          description="Phrase about adoption of the contributor covenant policy">
          We have adopted the
        </Translate>{' '}
        <Link to="https://www.contributor-covenant.org/">
          <Translate
            id="pages.community.howTo.covenantLink"
            description="Hyperlink to contributor covenant">
            Contributor Covenant
          </Translate>
        </Link>{' '}
        <Translate
          id="pages.community.howTo.guidelines"
          description="Phrase about our expectations that all contributors adhere to all policies listed herein.">
          and we expect that all community members adhere to the
        </Translate>{' '}
        <Link to="https://github.com/meta/lexical/blob/main/CONTRIBUTING.md">
          <Translate
            id="pages.community.howTo.contributingLink"
            description="Hyperlink to contributing technical instructions">
            contributing guidelines
          </Translate>
        </Link>
        .{' '}
      </p>
      <p>
        <Translate
          id="pages.community.howTo.joinUs"
          description="Phrase inviting users to join us as contributors after agreeing to the guidelines">
          Once you've read over those, we invite you to join us on the
        </Translate>{' '}
        <Link to="https://github.com/meta/lexical">
          <Translate id="pages.community.contributors.joinUsRepoLink">
            Lexical GitHub repository
          </Translate>
        </Link>
        .
      </p>
    </div>
  );
}
