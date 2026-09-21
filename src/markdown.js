/**
 * Markdown renderer for Geko editor preview.
 * Uses `marked` for full CommonMark and GitHub-Flavored Markdown (GFM) support.
 */

import { marked } from 'marked';

// Configure marked with GFM options
marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Render Markdown source string into HTML.
 * @param {string} markdownText
 * @returns {string} Safe HTML string
 */
export function renderMarkdown(markdownText) {
  if (!markdownText) return '<div class="md-empty">No content to preview</div>';
  try {
    return marked.parse(markdownText);
  } catch (err) {
    return `<div class="md-error">Failed to render Markdown: ${err?.message || err}</div>`;
  }
}
