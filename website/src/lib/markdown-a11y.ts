import { sanitizeHtml } from "./sanitize-html";

/**
 * Accessibility post-processing for marked-generated markdown HTML.
 *
 * axe flags two issues on rendered markdown that we fix here rather than in the
 * source content:
 *  - `scrollable-region-focusable`: <pre> and <table> blocks can overflow on the
 *    x-axis, so they must be keyboard focusable to let keyboard users scroll them.
 *  - `label`: GitHub-style task-list checkboxes (`- [ ]` / `- [x]`) render as bare
 *    disabled <input type="checkbox"> elements with no accessible name.
 *
 * The edits run on the sanitized tree rather than the HTML string, because a
 * `<` inside a quoted attribute survives sanitizing and must stay attribute
 * text. `sanitizeHtml` is isomorphic, so this still runs both at build time
 * (src/lib/detail-page.ts) and on the client (SkillDetail, CookbookRecipe).
 */
export function enhanceMarkdownA11y(html: string): string {
  if (!html) return html;

  return sanitizeHtml(html, undefined, (root) => {
    // Make scrollable code/table blocks keyboard focusable.
    for (const block of Array.from(
      root.querySelectorAll("pre:not([tabindex]), table:not([tabindex])"),
    )) {
      block.setAttribute("tabindex", "0");
    }

    // Give task-list checkboxes an accessible name based on their checked state.
    for (const checkbox of Array.from(
      root.querySelectorAll('input[type="checkbox"]:not([aria-label])'),
    )) {
      checkbox.setAttribute(
        "aria-label",
        checkbox.hasAttribute("checked") ? "Completed task" : "Incomplete task",
      );
    }
  });
}
