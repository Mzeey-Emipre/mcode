# Syntax Highlighting Test Prompt

## Prompt

Paste this into a chat thread:

> Write me code examples in these languages:
>
> 1. A TypeScript generic function that retries an async operation with exponential backoff
> 2. A Python decorator that caches function results with a TTL
> 3. A Bash script that monitors disk usage and sends an alert if above 90%
> 4. A SQL query joining 3 tables with a CTE, window function, and HAVING clause
> 5. A JSON schema for a user profile with nested address
> 6. A YAML GitHub Actions workflow that runs tests on PR
> 7. A Dockerfile for a Node.js app with multi-stage build
> 8. A CSS animation for a loading spinner
> 9. A block of code with no language tag

## Verification Checklist

| Check | What to look for |
|-------|-----------------|
| Syntax colors | Each language should have distinct keyword/string/comment coloring |
| Language label | Header bar shows the correct language name (e.g., "typescript", "python") |
| No-language block | Should render as a full code block (not inline), with label "text" |
| Copy button | Click it on any block, checkmark shows for ~2 seconds |
| Clipboard | Paste somewhere after copying to confirm raw code (not HTML) was copied |
| Streaming | While the response streams in, code blocks should be plain monospace with no copy button |
| Highlighting transition | After streaming completes, colors should appear with no layout jump |
| Theme toggle | Switch dark/light in settings, all code blocks should re-highlight with matching colors |
| Console errors | Open DevTools, check for Worker or Shiki errors |
