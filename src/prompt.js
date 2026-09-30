'use strict';

/**
 * Builds the LLM prompt for code review and parses its JSON response.
 */

const SYSTEM_PROMPT = `You are a meticulous senior software engineer performing a code review on a GitHub pull request.

You will receive:
1. The PR title and description.
2. The unified diff of the changes.
3. Optionally, the full content of a few key changed files for context.

Your job:
- Find real problems: bugs, security vulnerabilities, race conditions, resource leaks, incorrect error handling, broken API usage, performance pitfalls, and logic errors.
- Also flag: missing edge-case handling, confusing code, and violations of obvious project conventions visible in the diff.
- Do NOT comment on style nitpicks, formatting, or things a linter would catch.
- Do NOT invent problems that are not present in the diff.
- Be specific: reference exact lines and explain WHY something is wrong and HOW to fix it.

Respond with ONLY a JSON object (no markdown fences, no commentary) in exactly this shape:
{
  "summary": "A 2-5 sentence overall assessment of the PR.",
  "critical": true or false,
  "comments": [
    {
      "path": "relative/file/path",
      "line": 42,
      "side": "RIGHT",
      "severity": "critical" | "warning" | "suggestion",
      "body": "Clear explanation of the issue and a concrete fix suggestion."
    }
  ]
}

Rules for "comments":
- "path" must be one of the files present in the diff.
- "line" must be a line number that exists in the NEW version of the file (the + side of the diff).
- "side" is always "RIGHT" (the new code).
- "severity": "critical" = bug/security issue that must be fixed; "warning" = likely problem or significant risk; "suggestion" = improvement worth considering.
- Keep "body" under 500 characters.
- If there are no issues, return an empty "comments" array and set "critical" to false.
- Maximum 25 comments. Prioritize the most important issues.`;

/**
 * Build the user message from PR data.
 */
function buildUserMessage({ title, description, diff, contextFiles }) {
  let msg = `## Pull Request\n\n**Title:** ${title}\n\n`;
  if (description) {
    msg += `**Description:**\n${description.slice(0, 4000)}\n\n`;
  }

  if (contextFiles && contextFiles.length > 0) {
    msg += `## Context: full content of key changed files\n\n`;
    for (const f of contextFiles) {
      msg += `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
    }
  }

  msg += `## Diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n\nReview this pull request now. Respond with the JSON object only.`;
  return msg;
}

/**
 * Parse the LLM response into a normalized review object.
 * Tolerates markdown fences and stray text around the JSON.
 */
function parseReviewResponse(text) {
  let cleaned = (text || '').trim();

  // Strip markdown code fences if present.
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Find the outermost JSON object.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('LLM response does not contain a JSON object');
  }
  cleaned = cleaned.slice(start, end + 1);

  const parsed = JSON.parse(cleaned);

  const comments = Array.isArray(parsed.comments)
    ? parsed.comments
        .filter((c) => c && typeof c.path === 'string' && Number.isFinite(c.line))
        .map((c) => ({
          path: c.path,
          line: Math.floor(c.line),
          side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
          severity: ['critical', 'warning', 'suggestion'].includes(c.severity) ? c.severity : 'suggestion',
          body: String(c.body || '').slice(0, 1000),
        }))
        .filter((c) => c.body.length > 0)
    : [];

  return {
    summary: String(parsed.summary || 'No summary provided.').slice(0, 2000),
    critical: parsed.critical === true,
    comments,
  };
}

module.exports = { SYSTEM_PROMPT, buildUserMessage, parseReviewResponse };
