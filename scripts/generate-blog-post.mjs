#!/usr/bin/env node

/**
 * Odea Works Blog Post Generator
 *
 * Picks the highest-priority unused keyword from keyword-bank.json,
 * generates a blog post via Claude API, validates frontmatter,
 * writes it to src/content/blog/, and marks the keyword as used.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/generate-blog-post.mjs
 *   ANTHROPIC_API_KEY=sk-... KEYWORD_OVERRIDE="my keyword" node scripts/generate-blog-post.mjs
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const KEYWORD_BANK_PATH = path.join(__dirname, 'keyword-bank.json');
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'system-prompt.md');
const PROJECT_CONTEXT_PATH = path.join(__dirname, 'project-context.json');
const BLOG_DIR = path.join(ROOT, 'src', 'content', 'blog');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read JSON file safely */
function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`ERROR: Failed to read ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

/** Write JSON file safely — writes to temp file first, then renames */
function writeJSON(filePath, data) {
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Turn a keyword string into a URL-safe slug */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Get existing blog post slugs for cross-linking context */
function getExistingPostSlugs() {
  if (!fs.existsSync(BLOG_DIR)) {
    fs.mkdirSync(BLOG_DIR, { recursive: true });
    return [];
  }
  return fs
    .readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => f.replace(/\.md$/, ''));
}

/** Validate that the generated content has proper YAML frontmatter */
function validateFrontmatter(content) {
  const errors = [];

  // Must start with ---
  if (!content.startsWith('---')) {
    errors.push('Content does not start with YAML frontmatter delimiter (---)');
    return { valid: false, errors };
  }

  // Must have closing ---
  const secondDelimiter = content.indexOf('---', 3);
  if (secondDelimiter === -1) {
    errors.push('Missing closing YAML frontmatter delimiter (---)');
    return { valid: false, errors };
  }

  const frontmatter = content.substring(3, secondDelimiter).trim();
  const body = content.substring(secondDelimiter + 3).trim();

  // Required fields
  const requiredFields = ['title', 'description', 'pubDate', 'category', 'tags', 'targetKeyword'];
  for (const field of requiredFields) {
    // Simple check: field name followed by colon
    const regex = new RegExp(`^${field}\\s*:`, 'm');
    if (!regex.test(frontmatter)) {
      errors.push(`Missing required frontmatter field: ${field}`);
    }
  }

  // Validate category is one of the allowed values
  const allowedCategories = [
    'ai-consulting',
    'software-engineering',
    'technical-strategy',
    'devops-infrastructure',
    'ai-engineering',
  ];
  const categoryMatch = frontmatter.match(/^category\s*:\s*(.+)$/m);
  if (categoryMatch) {
    const category = categoryMatch[1].trim().replace(/^["']|["']$/g, '');
    if (!allowedCategories.includes(category)) {
      errors.push(`Invalid category "${category}". Must be one of: ${allowedCategories.join(', ')}`);
    }
  }

  // Check description length (should be under 160 chars)
  const descMatch = frontmatter.match(/^description\s*:\s*["'](.+?)["']$/m);
  if (descMatch && descMatch[1].length > 160) {
    errors.push(`Description is ${descMatch[1].length} chars (should be under 160)`);
  }

  // Body should have meaningful content
  if (body.length < 500) {
    errors.push(`Body content seems too short (${body.length} chars)`);
  }

  return { valid: errors.length === 0, errors, frontmatter, body };
}

/** Calculate reading time from word count */
function calculateReadingTime(text) {
  const words = text.replace(/<[^>]*>/g, '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Odea Works Blog Post Generator ===\n');

  // 1. Validate API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  // 2. Read keyword bank
  const keywordBank = readJSON(KEYWORD_BANK_PATH);
  if (!keywordBank.keywords || !Array.isArray(keywordBank.keywords)) {
    console.error('ERROR: keyword-bank.json must have a "keywords" array');
    process.exit(1);
  }

  // 3. Select keyword
  let selectedKeyword;
  const keywordOverride = process.env.KEYWORD_OVERRIDE?.trim();

  if (keywordOverride) {
    // Find override keyword in bank (or use it as-is)
    selectedKeyword = keywordBank.keywords.find(
      (k) => k.keyword.toLowerCase() === keywordOverride.toLowerCase()
    );
    if (!selectedKeyword) {
      // Use the override as a custom keyword
      selectedKeyword = {
        keyword: keywordOverride,
        category: 'ai-engineering',
        postType: 'technical-deep-dive',
        difficulty: 'medium',
        used: false,
        priority: 1,
        _custom: true, // flag so we don't try to mark it in the bank
      };
      console.log(`Using custom keyword (not in bank): "${keywordOverride}"`);
    } else {
      console.log(`Using override keyword from bank: "${selectedKeyword.keyword}"`);
    }
  } else {
    // Pick highest-priority unused keyword, preferring low difficulty
    const difficultyOrder = { low: 0, medium: 1, high: 2 };
    const unused = keywordBank.keywords
      .filter((k) => !k.used)
      .sort((a, b) => {
        // Sort by: priority (asc), then difficulty (low first), then category spread
        if (a.priority !== b.priority) return a.priority - b.priority;
        const diffA = difficultyOrder[a.difficulty] ?? 1;
        const diffB = difficultyOrder[b.difficulty] ?? 1;
        return diffA - diffB;
      });

    if (unused.length === 0) {
      console.log('All keywords have been used! No post generated.');
      process.exit(0);
    }

    selectedKeyword = unused[0];
    console.log(`Selected keyword: "${selectedKeyword.keyword}" (priority: ${selectedKeyword.priority}, difficulty: ${selectedKeyword.difficulty})`);
  }

  // 4. Read system prompt and project context
  let systemPromptText;
  try {
    systemPromptText = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
  } catch (err) {
    console.error(`ERROR: Failed to read system prompt: ${err.message}`);
    process.exit(1);
  }

  const projectContext = readJSON(PROJECT_CONTEXT_PATH);

  // 5. Get existing blog posts for cross-linking
  const existingSlugs = getExistingPostSlugs();
  console.log(`Found ${existingSlugs.length} existing blog post(s)`);

  // 6. Build the user prompt
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  let additionalContext = '';
  if (selectedKeyword.postType === 'case-study') {
    // Include more project details for case studies
    additionalContext = `\n\nFor this case study, here are real projects you can draw from:\n${JSON.stringify(projectContext.projects, null, 2)}`;
  } else if (selectedKeyword.postType === 'strategy-guide') {
    additionalContext = `\n\nReference these services when relevant:\n${JSON.stringify(projectContext.services, null, 2)}`;
  }

  const userPrompt = `Write a blog post targeting the keyword: "${selectedKeyword.keyword}"
Post type: ${selectedKeyword.postType}
Category: ${selectedKeyword.category}
Today's date for pubDate: ${today}

Existing blog posts for cross-linking (use slug as /blog/{slug}): ${existingSlugs.length > 0 ? existingSlugs.join(', ') : 'None yet — this is the first post.'}

Real projects you can reference naturally:
${projectContext.projects.map((p) => `- ${p.name}: ${p.description} (${p.tech})`).join('\n')}
${additionalContext}

Remember:
- Use pubDate: ${today}
- Category must be exactly: ${selectedKeyword.category}
- targetKeyword must be exactly: "${selectedKeyword.keyword}"
- Return ONLY the markdown with frontmatter — no extra text, no code fences`;

  // 7. Call Claude API
  console.log('\nGenerating blog post via Claude API...');
  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPromptText,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error(`ERROR: Claude API call failed: ${err.message}`);
    if (err.status === 401) {
      console.error('Check your ANTHROPIC_API_KEY — it may be invalid or expired.');
    } else if (err.status === 429) {
      console.error('Rate limited. Try again later.');
    }
    process.exit(1);
  }

  // Extract text content
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    console.error('ERROR: No text content in Claude response');
    process.exit(1);
  }

  let generatedContent = textBlock.text.trim();

  // Strip code fences if Claude wrapped the response
  if (generatedContent.startsWith('```')) {
    generatedContent = generatedContent
      .replace(/^```(?:markdown|md|yaml)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim();
  }

  // 8. Validate frontmatter
  console.log('Validating generated content...');
  const validation = validateFrontmatter(generatedContent);
  if (!validation.valid) {
    console.error('ERROR: Generated content has validation issues:');
    validation.errors.forEach((e) => console.error(`  - ${e}`));
    // Write it anyway for debugging but warn
    console.error('\nWriting content despite validation issues for manual review.');
  }

  // 9. Calculate reading time and build filename
  const readingTime = calculateReadingTime(generatedContent);
  console.log(`Estimated reading time: ${readingTime} min`);

  const slug = `${today}-${slugify(selectedKeyword.keyword)}`;
  const outputPath = path.join(BLOG_DIR, `${slug}.md`);

  // Ensure blog directory exists
  fs.mkdirSync(BLOG_DIR, { recursive: true });

  // 10. Write the blog post
  fs.writeFileSync(outputPath, generatedContent + '\n', 'utf-8');
  console.log(`\nBlog post written to: ${outputPath}`);

  // 11. Mark keyword as used in the bank (only if it came from the bank)
  if (!selectedKeyword._custom) {
    const keywordIndex = keywordBank.keywords.findIndex(
      (k) => k.keyword === selectedKeyword.keyword
    );
    if (keywordIndex !== -1) {
      keywordBank.keywords[keywordIndex].used = true;
      keywordBank.keywords[keywordIndex].usedDate = today;
      keywordBank.keywords[keywordIndex].outputFile = `${slug}.md`;
      writeJSON(KEYWORD_BANK_PATH, keywordBank);
      console.log(`Marked keyword "${selectedKeyword.keyword}" as used in keyword bank.`);
    }
  }

  // 12. Summary
  const unusedCount = keywordBank.keywords.filter((k) => !k.used).length;
  console.log(`\n=== Generation Complete ===`);
  console.log(`Keyword:  "${selectedKeyword.keyword}"`);
  console.log(`Category: ${selectedKeyword.category}`);
  console.log(`Type:     ${selectedKeyword.postType}`);
  console.log(`File:     ${slug}.md`);
  console.log(`Reading:  ~${readingTime} min`);
  console.log(`Remaining keywords: ${unusedCount}/${keywordBank.keywords.length}`);
  console.log(`Tokens used: ${response.usage?.input_tokens ?? '?'} in / ${response.usage?.output_tokens ?? '?'} out`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
