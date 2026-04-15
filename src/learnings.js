const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.txt');
const ITERATION_COUNTER_FILE = path.join(DATA_DIR, 'iteration_counter.json');

// Ensure data directory and files exist
function init() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(PROGRESS_FILE)) {
    fs.writeFileSync(PROGRESS_FILE, '');
  }
  if (!fs.existsSync(ITERATION_COUNTER_FILE)) {
    fs.writeFileSync(ITERATION_COUNTER_FILE, JSON.stringify({ count: 0 }));
  }
}

// Get current iteration number
function getIterationNumber() {
  init();
  try {
    const data = JSON.parse(fs.readFileSync(ITERATION_COUNTER_FILE, 'utf8'));
    return data.count || 0;
  } catch {
    return 0;
  }
}

// Increment and return next iteration number
function nextIteration() {
  init();
  const current = getIterationNumber();
  const next = current + 1;
  fs.writeFileSync(ITERATION_COUNTER_FILE, JSON.stringify({ count: next }));
  return next;
}

/**
 * Append learnings text to progress.txt
 * Format: === Iteration N (ISO timestamp) ===\nlearnings\n\n
 * @param {string} text - Learnings to append
 * @returns {number} - Iteration number used
 */
function appendLearnings(text) {
  init();
  const iteration = nextIteration();
  const timestamp = new Date().toISOString();
  const entry = `=== Iteration ${iteration} (${timestamp}) ===\n${text}\n\n`;
  fs.appendFileSync(PROGRESS_FILE, entry);
  return iteration;
}

/**
 * Read all learnings from progress.txt
 * @returns {string} - All learnings content
 */
function getLearnings() {
  init();
  if (!fs.existsSync(PROGRESS_FILE)) {
    return '';
  }
  return fs.readFileSync(PROGRESS_FILE, 'utf8');
}

/**
 * Parse learnings into structured array
 * @returns {Array<{iteration: number, timestamp: string, text: string}>}
 */
function parseLearnings() {
  const content = getLearnings();
  if (!content.trim()) return [];

  const entries = [];
  const regex = /=== Iteration (\d+) \(([^)]+)\) ===\n([\s\S]*?)(?=\n\n=== Iteration|\n\n$|$)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    entries.push({
      iteration: parseInt(match[1], 10),
      timestamp: match[2],
      text: match[3].trim(),
    });
  }
  return entries;
}

/**
 * Get learnings as structured or plain text
 * @param {object} options - { structured: boolean }
 * @returns {string|Array}
 */
function getLearningsStructured(options = { structured: false }) {
  if (options.structured) {
    return parseLearnings();
  }
  return getLearnings();
}

/**
 * Inject learnings into next review context
 * @param {object} reviewContext - { prNumber, repoOwner, repoName, prTitle, prUrl, prompt }
 * @returns {object} - Modified reviewContext with learnings injected
 */
function applyLearningsToNextReview(reviewContext) {
  const learnings = parseLearnings();

  // Build learnings summary for the prompt
  let learningsSection = '';

  if (learnings.length > 0) {
    const recentLearnings = learnings.slice(-5); // last 5 iterations
    learningsSection = `\n\n## Previous Review Learnings (apply these patterns)\n`;
    recentLearnings.forEach(l => {
      learningsSection += `- [Iter ${l.iteration}] ${l.text}\n`;
    });
    learningsSection += `\nApply these lessons to improve your current review.`;
  }

  // Inject into prompt if present
  if (reviewContext.prompt) {
    reviewContext.prompt += learningsSection;
  } else {
    reviewContext.prompt = `Review the PR changes and provide feedback.${learningsSection}`;
  }

  // Also attach metadata
  reviewContext._learningsApplied = true;
  reviewContext._learningsCount = learnings.length;
  reviewContext._lastIteration = learnings.length > 0 ? learnings[learnings.length - 1].iteration : 0;

  return reviewContext;
}

/**
 * Record a review completion with quality metrics
 * @param {object} params - { prNumber, repoOwner, repoName, iteration, quality, feedback, suggestions }
 * @returns {number} - Iteration number
 */
function recordReviewQuality({ prNumber, repoOwner, repoName, iteration, quality, feedback, suggestions }) {
  const text = [
    `PR: ${repoOwner}/${repoName}#${prNumber}`,
    `Quality: ${quality}/10`,
    `Feedback: ${feedback}`,
    `Suggestions: ${suggestions}`,
  ].join('\n');

  return appendLearnings(text);
}

/**
 * Get quality metrics summary
 * @returns {object} - { totalIterations, averageQuality, recentTrends }
 */
function getQualityMetrics() {
  const learnings = parseLearnings();
  const totalIterations = learnings.length;

  // Extract quality scores
  const qualityScores = learnings
    .map(l => {
      const match = l.text.match(/Quality: (\d+)\/10/);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter(q => q !== null);

  const averageQuality = qualityScores.length > 0
    ? (qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length).toFixed(2)
    : null;

  const recentTrends = qualityScores.length >= 3
    ? qualityScores.slice(-3)
    : qualityScores;

  return {
    totalIterations,
    averageQuality,
    recentTrends,
    qualityScores,
  };
}

module.exports = {
  appendLearnings,
  getLearnings,
  getLearningsStructured,
  applyLearningsToNextReview,
  recordReviewQuality,
  getQualityMetrics,
  parseLearnings,
  getIterationNumber,
};
