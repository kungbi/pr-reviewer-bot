#!/bin/bash
# TEST.sh - Run integration tests for kungbi-pr-reviewer-bot

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_ROOT"

echo "============================================================"
echo "KUNGBI PR REVIEWER BOT - INTEGRATION TEST RUNNER"
echo "============================================================"
echo ""

# Check if node is available
if ! command -v node &> /dev/null; then
    echo "ERROR: node is not installed or not in PATH"
    exit 1
fi

echo "Node version: $(node --version)"
echo "npm version: $(npm --version 2>/dev/null || echo 'N/A')"
echo ""

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    echo ""
fi

# Create test directory if it doesn't exist
mkdir -p test

# Check if integration test exists
if [ ! -f "test/integration-test.js" ]; then
    echo "ERROR: test/integration-test.js not found"
    exit 1
fi

# Run the integration test
echo "Running integration tests..."
echo ""

node test/integration-test.js

TEST_EXIT_CODE=$?

echo ""
echo "============================================================"
if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo "TEST RESULT: SUCCESS"
else
    echo "TEST RESULT: FAILED (exit code: $TEST_EXIT_CODE)"
fi
echo "============================================================"

exit $TEST_EXIT_CODE