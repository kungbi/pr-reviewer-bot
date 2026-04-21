/**
 * test-10-cycles.js
 *
 * Test script for 10 consecutive polling cycles.
 * Simulates PR polling and review execution without external dependencies.
 *
 * Run: node test/test-10-cycles.js
 */

const fs = require('fs');
const path = require('path');

// Ensure test output directory
const TEST_OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(TEST_OUTPUT_DIR)) {
  fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
}

// Override state file for testing
const TEST_STATE_FILE = path.join(TEST_OUTPUT_DIR, 'test-reviewed-prs.json');

// Override learnings progress file for testing
const DATA_DIR = TEST_OUTPUT_DIR;
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.txt');

// ─────────────────────────────────────────────
// Mock modules to avoid external dependencies
// ─────────────────────────────────────────────

// Mock ReviewedPRsState to use test state file
const ReviewedPRsState = require('../src/state-manager');

// Override MAX_RETRIES
const MAX_RETRIES = ReviewedPRsState.MAX_RETRIES || 3;

// Mock learnings to use test directory
const learnings = require('../src/learnings');

// Patch learnings to use test directory
const originalInit = learnings.init;
learnings.init = function() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(PROGRESS_FILE)) {
    fs.writeFileSync(PROGRESS_FILE, '');
  }
};
learnings.init();

// Note: We don't need to mock sessions_spawn because we simulate reviews inline
// without calling the actual webhook handler

// ─────────────────────────────────────────────
// Mock PR data generator
// ─────────────────────────────────────────────

function generateMockPRs(cycle) {
  const repos = ['kungbi-spiders/kungbi-pr-reviewer', 'kungbi-spiders/backend-api', 'kungbi-spiders/frontend'];
  const titles = [
    'Fix authentication bug',
    'Add new feature',
    'Refactor database queries',
    'Update dependencies',
    'Fix memory leak',
    'Improve error handling',
    'Add unit tests',
    'Fix race condition',
    'Update API endpoints',
    'Improve logging',
  ];

  return Array.from({ length: 3 }, (_, i) => {
    const prNum = cycle * 100 + i + 1;
    const repo = repos[i % repos.length];
    const [owner, repoName] = repo.split('/');
    return {
      number: prNum,
      title: titles[(cycle + i) % titles.length],
      url: `https://github.com/${owner}/${repoName}/pull/${prNum}`,
      owner,
      repo: repoName,
    };
  });
}

// ─────────────────────────────────────────────
// Simulate review execution (mock)
// ─────────────────────────────────────────────

async function simulateReview(prInfo, cycle) {
  const timestamp = new Date().toISOString();
  const prLabel = `${prInfo.owner}/${prInfo.repo}#${prInfo.prNumber}`;

  // Simulate some processing time
  await new Promise(resolve => setTimeout(resolve, 50));

  // Simulate occasional errors (10% chance) to test retry logic
  if (Math.random() < 0.1) {
    throw new Error('Simulated random review error');
  }

  // Simulate review findings based on cycle
  const findings = [];
  const quality = 60 + Math.floor(Math.random() * 35);

  if (cycle % 2 === 0) {
    findings.push('Consider adding input validation');
  }
  if (prInfo.title.toLowerCase().includes('fix')) {
    findings.push('Ensure test coverage for the fix');
  }
  if (cycle % 3 === 0) {
    findings.push('Review error handling in production path');
  }

  const feedback = findings.length > 0
    ? `Found ${findings.length} suggestion(s). See comments.`
    : 'Code looks good! No major issues.';

  // Record learnings
  learnings.recordReviewQuality({
    prNumber: prInfo.prNumber,
    repoOwner: prInfo.owner,
    repoName: prInfo.repo,
    iteration: cycle,
    quality,
    feedback,
    suggestions: findings.join('; ') || 'None',
  });

  return {
    success: true,
    prLabel,
    quality,
    findings,
    timestamp,
  };
}

// ─────────────────────────────────────────────
// Core test logic
// ─────────────────────────────────────────────

async function runCycle(cycleNum, state, allResults) {
  const timestamp = new Date().toISOString();
  console.log(`\n=== Cycle ${cycleNum} ===`);
  console.log(`Timestamp: ${timestamp}`);

  // Generate mock PRs
  const mockPRs = generateMockPRs(cycleNum);
  console.log(`Generated ${mockPRs.length} mock PRs`);

  let cycleSuccess = 0;
  let cycleSkipped = 0;
  let cycleFailed = 0;

  for (const pr of mockPRs) {
    const prLabel = `${pr.owner}/${pr.repo}#${pr.number}`;

    // Check if already reviewed
    if (state.isPRReviewed(pr.owner, pr.repo, pr.number)) {
      console.log(`  [SKIP] ${prLabel} - already reviewed`);
      cycleSkipped++;
      continue;
    }

    // Check if permanently skipped
    if (state.isPRSkipped(pr.owner, pr.repo, pr.number)) {
      console.log(`  [SKIP] ${prLabel} - permanently skipped`);
      cycleSkipped++;
      continue;
    }

    // Get retry count
    const retryCount = state.getPRRetryCount(pr.owner, pr.repo, pr.number);
    const attempt = retryCount + 1;

    console.log(`  [REVIEW] ${prLabel} "${pr.title}" (attempt ${attempt}/${MAX_RETRIES})`);

    try {
      const result = await simulateReview(pr, cycleNum);

      // Success
      state.clearPRRetries(pr.owner, pr.repo, pr.number);
      state.markPRReviewed(pr.owner, pr.repo, pr.number, 'reviewed');
      console.log(`  [OK] ${prLabel} - quality: ${result.quality}/100`);
      cycleSuccess++;

      allResults.reviews.push({
        cycle: cycleNum,
        pr: prLabel,
        status: 'success',
        quality: result.quality,
        timestamp,
      });

    } catch (err) {
      // Failure - increment retry count
      const newCount = state.markPRRetryFailure(pr.owner, pr.repo, pr.number, err.message);

      if (newCount >= MAX_RETRIES) {
        console.log(`  [FAIL] ${prLabel} - permanently skipped after ${newCount} failures`);
        cycleFailed++;
        allResults.reviews.push({
          cycle: cycleNum,
          pr: prLabel,
          status: 'skipped',
          error: err.message,
          timestamp,
        });
      } else {
        console.log(`  [RETRY] ${prLabel} - failure ${newCount}/${MAX_RETRIES}: ${err.message}`);
        cycleFailed++;
        allResults.reviews.push({
          cycle: cycleNum,
          pr: prLabel,
          status: 'retry',
          retryCount: newCount,
          error: err.message,
          timestamp,
        });
      }
    }
  }

  console.log(`Cycle ${cycleNum} summary: ${cycleSuccess} success, ${cycleSkipped} skipped, ${cycleFailed} failed`);

  return { cycleSuccess, cycleSkipped, cycleFailed };
}

// ─────────────────────────────────────────────
// Main test runner
// ─────────────────────────────────────────────

async function runTest() {
  const TOTAL_CYCLES = 10;
  const SLEEP_BETWEEN_CYCLES_MS = 200;

  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   KungbiSpiders PR Reviewer Bot - 10 Cycle Test         ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`\nStart time: ${new Date().toISOString()}`);
  console.log(`Test state file: ${TEST_STATE_FILE}`);
  console.log(`Total cycles: ${TOTAL_CYCLES}`);

  // Initialize state
  const state = new ReviewedPRsState(TEST_STATE_FILE);
  state.load();

  const allResults = {
    startTime: new Date().toISOString(),
    endTime: null,
    totalCycles: TOTAL_CYCLES,
    reviews: [],
    cycles: [],
    learnings: [],
  };

  // Run cycles
  for (let cycle = 1; cycle <= TOTAL_CYCLES; cycle++) {
    const cycleResult = await runCycle(cycle, state, allResults);
    allResults.cycles.push({
      cycle,
      timestamp: new Date().toISOString(),
      ...cycleResult,
    });

    // Brief sleep between cycles
    if (cycle < TOTAL_CYCLES) {
      await new Promise(resolve => setTimeout(resolve, SLEEP_BETWEEN_CYCLES_MS));
    }
  }

  // Finalize
  allResults.endTime = new Date().toISOString();

  // Summary
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║                   TEST SUMMARY                          ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  const totalSuccess = allResults.cycles.reduce((sum, c) => sum + c.cycleSuccess, 0);
  const totalSkipped = allResults.cycles.reduce((sum, c) => sum + c.cycleSkipped, 0);
  const totalFailed = allResults.cycles.reduce((sum, c) => sum + c.cycleFailed, 0);
  const totalReviews = allResults.reviews.length;

  console.log(`\nTotal reviews processed: ${totalReviews}`);
  console.log(`  - Success: ${totalSuccess}`);
  console.log(`  - Skipped: ${totalSkipped}`);
  console.log(`  - Failed/Retry: ${totalFailed}`);

  // Learnings summary
  const metrics = learnings.getQualityMetrics();
  console.log(`\nLearnings accumulated:`);
  console.log(`  - Total iterations recorded: ${metrics.totalIterations}`);
  if (metrics.averageQuality) {
    console.log(`  - Average quality score: ${metrics.averageQuality}/10`);
  }

  // Cycle-by-cycle table
  console.log('\nCycle breakdown:');
  console.log('┌───────┬──────────┬──────────┬──────────┬─────────────────────┐');
  console.log('│ Cycle │ Success  │ Skipped  │ Failed   │ Timestamp           │');
  console.log('├───────┼──────────┼──────────┼──────────┼─────────────────────┤');
  for (const c of allResults.cycles) {
    const ts = c.timestamp.split('T')[1].split('.')[0];
    console.log(`│   ${String(c.cycle).padStart(2)}  │    ${String(c.cycleSuccess).padStart(2)}    │    ${String(c.cycleSkipped).padStart(2)}    │    ${String(c.cycleFailed).padStart(2)}    │ ${ts} │`);
  }
  console.log('└───────┴──────────┴──────────┴──────────┴─────────────────────┘');

  // Error check
  const erroredReviews = allResults.reviews.filter(r => r.status === 'retry');
  const skippedReviews = allResults.reviews.filter(r => r.status === 'skipped');

  console.log(`\nError handling:`);
  console.log(`  - Reviews that hit retries: ${erroredReviews.length}`);
  console.log(`  - Reviews permanently skipped: ${skippedReviews.length}`);

  // Duration
  const start = new Date(allResults.startTime);
  const end = new Date(allResults.endTime);
  const durationMs = end - start;
  console.log(`\nTotal duration: ${durationMs}ms`);

  // Save results to file
  const resultsFile = path.join(TEST_OUTPUT_DIR, 'test-results.json');
  fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));
  console.log(`\nResults saved to: ${resultsFile}`);

  // Save learnings to file
  const learningsContent = learnings.getLearnings();
  const learningsFile = path.join(TEST_OUTPUT_DIR, 'learnings-output.txt');
  fs.writeFileSync(learningsFile, learningsContent);
  console.log(`Learnings saved to: ${learningsFile}`);

  // Final status
  console.log('\n════════════════════════════════════════════════════════');
  const hasCrashes = allResults.reviews.some(r => r.status === 'skipped' && r.retryCount === undefined);
  const allPassed = totalSuccess >= 10 && !hasCrashes;

  if (allPassed) {
    console.log('✅ TEST PASSED - All acceptance criteria met');
  } else {
    console.log('⚠️  TEST COMPLETED - Some reviews did not succeed');
  }
  console.log('════════════════════════════════════════════════════════\n');

  return allPassed ? 0 : 1;
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

runTest()
  .then(code => process.exit(code))
  .catch(err => {
    console.error('Test crashed with unhandled error:', err);
    process.exit(1);
  });
