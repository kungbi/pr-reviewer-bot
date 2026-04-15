/**
 * Test script for sendReviewCompletedNotification
 * Run: node test/discord-notifier-test.js
 */

// Mock the environment
process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test/mock';

const {
  sendReviewCompletedNotification
} = require('../src/discord-notifier');

// Test cases
async function runTests() {
  console.log('=== Discord Notifier Test ===\n');

  // Test 1: Clean PR (no issues, high score)
  console.log('Test 1: Clean PR');
  const cleanResult = await sendReviewCompletedNotification({
    owner: 'kungbi-spiders',
    repo: 'kungbi-pr-reviewer',
    prNumber: 42,
    prTitle: 'Add new feature',
    issuesFound: [],
    score: 95,
  });
  console.log('Result:', cleanResult ? 'SENT' : 'FAILED (no webhook configured)');
  console.log('');

  // Test 2: PR with issues found
  console.log('Test 2: PR with issues');
  const issuesResult = await sendReviewCompletedNotification({
    owner: 'kungbi-spiders',
    repo: 'kungbi-pr-reviewer',
    prNumber: 43,
    prTitle: 'Fix authentication bug',
    issuesFound: [
      'Missing error handling in auth.js:45',
      'Security: SQL injection risk in query',
      'Unused variable: tempUser',
    ],
    score: 45,
  });
  console.log('Result:', issuesResult ? 'SENT' : 'FAILED (no webhook configured)');
  console.log('');

  // Test 3: Low score without issues
  console.log('Test 3: Low score without specific issues');
  const lowScoreResult = await sendReviewCompletedNotification({
    owner: 'kungbi-spiders',
    repo: 'kungbi-pr-reviewer',
    prNumber: 44,
    prTitle: 'Refactor codebase',
    issuesFound: [],
    score: 50,
  });
  console.log('Result:', lowScoreResult ? 'SENT' : 'FAILED (no webhook configured)');
  console.log('');

  // Test 4: Many issues (truncated to 5)
  console.log('Test 4: Many issues (truncation test)');
  const manyIssues = Array.from({ length: 8 }, (_, i) => `Issue #${i + 1}: This is issue number ${i + 1}`);
  const manyResult = await sendReviewCompletedNotification({
    owner: 'kungbi-spiders',
    repo: 'kungbi-pr-reviewer',
    prNumber: 45,
    prTitle: 'Big refactor PR',
    issuesFound: manyIssues,
    score: 30,
  });
  console.log('Result:', manyResult ? 'SENT' : 'FAILED (no webhook configured)');
  console.log('');

  console.log('=== Tests Complete ===');
  console.log('Note: Messages show "FAILED" if DISCORD_WEBHOOK_URL is not a real webhook.');
}

runTests().catch(console.error);
