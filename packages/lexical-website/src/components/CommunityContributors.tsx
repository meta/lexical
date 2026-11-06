/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import Translate from '@docusaurus/Translate';

export default function CommunityContributors() {
  return (
    <div>
      <h2>
        <Translate
          id="pages.community.contributors.subHeader"
          description="Subtitle of section on contributors">
          Contributors
        </Translate>
      </h2>

      <p>
        <Translate
          id="pages.community.contributors.subtext"
          description="The descriptive text of the header section of the community page">
          Lexical development is led by core team of maintainers, which includes
          representation from Meta and outside contributors. It also welcomes
          contributions from people all over the world. Here are just a few
          members.
        </Translate>
      </p>

      <p>
        <a
          href="https://github.com/meta/lexical/graphs/contributors"
          target="_blank"
          rel="noreferrer">
          <Translate
            id="pages.community.contributors.gitHubLink"
            description="Link to GitHub's contribute page for the repository">
            See all of the contributors on Github.
          </Translate>
        </a>
      </p>

      <div className="mt-12 flex flex-wrap items-stretch gap-10">
        <a
          href="https://github.com/meta/lexical/graphs/contributors"
          target="_blank"
          rel="noreferrer">
          <img
            src="https://contrib.rocks/image?repo=meta/lexical"
            alt="GitHub avatars of Lexical contributors"
          />
        </a>
      </div>
    </div>
  );
}
