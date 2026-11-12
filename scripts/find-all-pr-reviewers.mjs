/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @ts-check

/**
 * This script was used to seed the initial data for
 * https://github.com/meta/lexical/pull/8270
 * and may be removed later
 */

import {execSync} from 'child_process';

/**
 * Executes a shell command and returns the output
 * @param {string} command the shell command to execute
 * @returns {string | null} the trimmed stdout, or null if the command failed
 */
function exec(command) {
  try {
    return execSync(command, {encoding: 'utf8'}).trim();
  } catch (error) {
    console.error(`Error executing command: ${command}`);
    console.error(/** @type {Error} */ (error).message);
    return null;
  }
}

/**
 * Fetches all PR reviewers who have approved PRs using pagination
 */
async function findAllPRReviewers() {
  console.log('Scanning all merged PRs for reviewers...\n');

  const reviewers = new Set();
  let hasNextPage = true;
  let cursor = null;
  let pageCount = 0;
  let totalPRs = 0;

  while (hasNextPage) {
    pageCount++;
    console.log(
      `Fetching page ${pageCount}${cursor ? ` (cursor: ${cursor.substring(0, 20)}...)` : ''}...`,
    );

    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      repository(owner: "meta", name: "lexical") {
        pullRequests(states: MERGED, first: 100${afterClause}) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            number
            reviews(states: APPROVED, first: 100) {
              nodes {
                author {
                  login
                }
              }
            }
          }
        }
      }
    }`;

    const result = exec(`gh api graphql -f query='${query}'`);

    if (!result) {
      console.error('Failed to fetch data');
      break;
    }

    try {
      const data = JSON.parse(result);
      const pullRequests = data.data.repository.pullRequests;

      // Process reviews from this batch
      for (const pr of pullRequests.nodes) {
        totalPRs++;
        if (pr.reviews && pr.reviews.nodes) {
          for (const review of pr.reviews.nodes) {
            if (review.author && review.author.login) {
              reviewers.add(review.author.login);
            }
          }
        }
      }

      // Update pagination info
      hasNextPage = pullRequests.pageInfo.hasNextPage;
      cursor = pullRequests.pageInfo.endCursor;

      console.log(
        `  Processed ${pullRequests.nodes.length} PRs. Found ${reviewers.size} unique reviewers so far.`,
      );

      // Add a small delay to avoid rate limiting
      if (hasNextPage) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(
        'Error parsing response:',
        /** @type {Error} */ (error).message,
      );
      break;
    }
  }

  console.log(`\n✅ Scan complete!`);
  console.log(`Total PRs scanned: ${totalPRs}`);
  console.log(`Total unique reviewers found: ${reviewers.size}\n`);

  // Convert to sorted array (case-insensitive)
  const reviewerList = Array.from(reviewers).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );

  console.log('=== All PR Reviewers (Alphabetical) ===\n');
  reviewerList.forEach(reviewer => {
    console.log(reviewer);
  });

  console.log('\n=== Array Format for prReviewers ===\n');
  console.log(JSON.stringify(reviewerList, null, 2));

  return reviewerList;
}

// Run the script
findAllPRReviewers().catch(error => {
  console.error('Error finding PR reviewers:', error);
  process.exit(1);
});
