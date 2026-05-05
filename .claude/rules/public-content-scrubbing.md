# Public Content Scrubbing

Rule for any agent that drafts external/public content (blog posts, READMEs, public-facing docs, fryanpan content, marketing copy, emails to people outside Bryan's immediate team) OR that flips a repo from private to public.

## Core rule

**Anything in a public GitHub repo is fine to mention by name in external content. Anything in a private repo always requires a review pass before being mentioned.** When in doubt, default to anonymizing or omitting.

## When this applies

- Drafting a blog post, README, fryanpan page, llms.txt, public-facing doc
- Drafting an email or message to a recipient outside Bryan's immediate fleet
- Flipping a repo from private to public (one-way; treat as point of no return)
- Updating an already-public repo where new content might reference private repos

## Required review pass before publishing public content

1. **Files in commit history** — any file ever committed to the repo, even if later deleted. Check via `git log --all --full-history -- <path>`. A deleted-but-historical file with private-repo references will still be visible to anyone cloning.

2. **PR descriptions and PR comments** — these are exposed via GitHub's web UI even after merge. Check for: private repo URLs, agent / project / peer names that aren't safe to associate publicly, internal jargon that telegraphs a private context, links to private Notion / Linear / docs.

3. **Commit messages** — same surface as PR descriptions. Often missed because they look "internal." Check via `git log --all --pretty=full`.

4. **Code comments and docstrings** — any reference to a private repo, internal tool name, or coworker's name that isn't already public.

5. **Test fixtures and seed data** — easy to overlook. Real names, email addresses, internal URLs, project codenames hidden in JSON / YAML / SQL / mock files.

6. **CI configuration and scripts** — `.github/workflows/`, `Makefile`, `package.json` scripts, shell scripts. Often reference private repos for deploy targets, internal dashboards, etc.

## Reference rule for drafting external content

When writing about Bryan's tools / projects in external-facing content:

- **Public repo + public artifact**: name freely. Link to GitHub URL, mention version numbers, quote commit hashes if relevant.
- **Private repo or private artifact**: anonymize or omit. Do not name the repo. If the work itself is the subject of the post, describe it in generic terms ("a personal CRM tool I built") without enabling enumeration of related private work.
- **Anything mixed (a private repo about to flip public)**: treat as private until the flip lands. Schedule the public mention for *after* the flip, not in anticipation of it.
- **Other people's names**: mentioned only with their explicit consent for that specific public artifact. Past consent for one venue doesn't carry to another.

## When flipping a repo public

This is a one-way operation. Before the flip:

1. Run the review pass above on every category (files, PR descriptions, commit messages, code comments, test fixtures, CI config).
2. Produce a redaction plan: list of items to remove, rewrite, or leave (with reason).
3. Apply redactions on a `redact/<date>` branch — squash commits if the redaction itself reveals sensitive context.
4. Get explicit user greenlight on the redacted state before flipping.
5. Flip in the GitHub UI (manual; agents do not flip repos public).
6. After the flip: do a public-view sanity check (open the repo in incognito, confirm what a stranger sees).

## When already-public content needs scrubbing

If you discover that an already-public repo or artifact contains references that should not be public (e.g., a private peer name in a commit message, an internal URL in a README):

1. Surface the issue to the user immediately — don't silently rewrite history.
2. If the content is in current files: PR a fix with sanitized content.
3. If the content is in commit history / PR descriptions / closed-but-public discussions: discuss with the user whether to rewrite history (force-push), edit/delete the offending PR comment / issue body, or leave + accept the exposure.

## What to escalate immediately

- A draft you're about to publish that references a private repo or peer by a name that isn't already public elsewhere
- A request to flip a repo public without an explicit review pass
- Discovery of cross-repo leakage in an already-public artifact (especially commit messages or PR descriptions, which are easy to miss)

## Why this rule exists

Bryan operates a multi-repo / multi-agent fleet where some repos are public (and some peers' names + tool names are publicly safe) and most are private (and most peers' names + project details are not publicly safe). External content drafted by any single agent can leak cross-repo context the agent doesn't realize is private — by referencing a private peer name, by linking to a private repo URL, or by including jargon that telegraphs a private context. The rule keeps that leakage from happening by default and forces a review when the line is crossed.
