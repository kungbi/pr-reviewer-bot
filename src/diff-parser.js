'use strict';

/**
 * diff-parser.js
 *
 * Parses a unified diff and builds a set of line numbers visible in the diff
 * for each file (added lines + context lines on the RIGHT/new side).
 *
 * Used to validate that AI-suggested line numbers are actually present in the
 * PR diff before posting inline comments via the GitHub line+side API.
 */

/**
 * Build a map of { filePath: Set<newLineNumber> } from a unified diff.
 * Only new-file lines (context + additions) are included — deletions have no
 * new-file line number and cannot receive RIGHT-side inline comments.
 *
 * @param {string} diff - Raw unified diff text
 * @returns {Object} lineSet — { filePath: Set<number> }
 */
function buildDiffLineSet(diff) {
  const lineSet = {};
  const lines = diff.split('\n');

  let currentFile = null;
  let newLineNumber = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
      lineSet[currentFile] = new Set();
      newLineNumber = 0;
      inHunk = false;
      continue;
    }
    if (line.startsWith('+++ /dev/null')) {
      currentFile = null;
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }

    if (line.startsWith('@@')) {
      inHunk = true;
      const match = line.match(/\+(\d+)/);
      if (match) newLineNumber = parseInt(match[1], 10) - 1;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('+')) {
      newLineNumber++;
      lineSet[currentFile].add(newLineNumber);
    } else if (line.startsWith('-')) {
      // deleted line — no new-file line number
    } else if (line.startsWith(' ')) {
      newLineNumber++;
      lineSet[currentFile].add(newLineNumber);
    }
  }

  return lineSet;
}

/**
 * Check whether a given line is present in the diff for a file.
 *
 * @param {Object} lineSet - Result of buildDiffLineSet
 * @param {string} filePath
 * @param {number} lineNumber
 * @returns {boolean}
 */
function isLineInDiff(lineSet, filePath, lineNumber) {
  return lineSet[filePath]?.has(lineNumber) ?? false;
}

/**
 * Parse file:line references from an AI review report.
 *
 * Looks for patterns like:
 *   **src/user.js:97**        — single line
 *   **src/user.js:97-104**    — line range
 *
 * Severity is determined by which section (### Blockers / ### Important / ### Minor)
 * the reference falls under — not by parsing the text after the marker.
 *
 * @param {string} reviewText
 * @returns {Array<{file: string, line: number, severity: string, context: string}>}
 */
function parseFileLineRefs(reviewText) {
  // Build section map: each ref's position mapped to its severity
  const sectionPattern = /^###\s*(Blockers?|Important|Minor)/gim;
  const sections = [];
  let sm;
  while ((sm = sectionPattern.exec(reviewText)) !== null) {
    const name = sm[1].toLowerCase().replace(/s$/, ''); // 'blocker', 'important', 'minor'
    sections.push({ index: sm.index, name });
  }

  function severityAt(pos) {
    let current = null;
    for (const sec of sections) {
      if (sec.index <= pos) current = sec.name;
      else break;
    }
    return current || 'minor';
  }

  const refs = [];
  const refPattern = /\*\*([^\*\s:]+\.[a-zA-Z0-9]+):(\d+)(?:-\d+)?\*\*/g;
  const matches = [];
  let m;
  while ((m = refPattern.exec(reviewText)) !== null) {
    matches.push({ file: m[1], line: parseInt(m[2], 10), index: m.index, endIndex: refPattern.lastIndex });
  }

  // Find all section header positions to use as hard boundaries
  const sectionHeaderPattern = /^#{1,3}\s+\S/gm;
  const sectionBoundaries = [];
  let sh;
  while ((sh = sectionHeaderPattern.exec(reviewText)) !== null) {
    sectionBoundaries.push(sh.index);
  }

  for (let i = 0; i < matches.length; i++) {
    const { file, line, index, endIndex } = matches[i];
    const severity = severityAt(index);

    // Stop at next ref OR next section header, whichever comes first
    const nextRefIndex = matches[i + 1] ? matches[i + 1].index : Infinity;
    const nextSectionIndex = sectionBoundaries.find(pos => pos > endIndex) ?? Infinity;
    const nextBoundary = Math.min(nextRefIndex, nextSectionIndex, reviewText.length);
    const rawContext = reviewText.slice(endIndex, nextBoundary);

    const context = rawContext
      .replace(/^\s*🔴\s*Blockers?\s*/i, '')   // strip stray severity tokens
      .replace(/^\s*🟡\s*Important\s*/i, '')
      .replace(/^\s*🟢\s*Minor\s*/i, '')
      .replace(/^\s*[—–-]+\s*/, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s*[-•]\s*/, '')
      .trim();

    const severityLabel = severity === 'blocker' ? '🔴 Blocker' :
                          severity === 'important' ? '🟡 Important' : '🟢 Minor';

    refs.push({ file, line, severity, context: `${severityLabel}\n${context}` });
  }
  return refs;
}

module.exports = { buildDiffLineSet, isLineInDiff, parseFileLineRefs };