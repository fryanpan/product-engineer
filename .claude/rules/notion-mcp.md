# Notion MCP Conventions

## Identify yourself in comments and content

Comments and pages created via the Notion MCP currently appear as Bryan (the integration uses his personal auth). Until per-agent Notion integrations are set up, **prepend every comment and every page you create with `**From: <Your Agent Name>**` on its own line**, then a blank line, then your content.

Use the friendly name from `registry.yaml`'s `session_name` field (e.g., "Blog Assistant", "Octoturtle Assistant", "Bike Map", "Conductor"). Don't use technical IDs.

Example comment body:
```
**From: Blog Assistant**

Suggesting we tighten this paragraph — it currently runs ~85 words but the surrounding ones are 30-50.
```

This applies to:
- Comments created via `notion-create-comment`
- New pages created via `notion-create-pages` (prepend in the page body)
- Major content rewrites via `notion-update-page` (note in a comment, don't rewrite the whole page silently)

Skip the prefix only when:
- You're updating a page Bryan explicitly asked you to maintain (e.g., a status doc you own)
- The audience is you (e.g., your own agent's logs/notes)

## Retry Behavior

`notion-update-page` and `notion-fetch` frequently fail on the first attempt and succeed immediately on retry. **Retry once before investigating.** This is a known MCP quirk, not an error in your request.

## Fetching Pages

Always use the **page ID** directly with `notion-fetch`, not the full Notion URL. Fetching by URL fails with an `invalid_type` error.

## Replacing Content

Prefer `replace_content_range` or `insert_content_after` over `replace_content` with `allow_deleting_content: true`. The latter archives child pages that were embedded in the old content — this is destructive and hard to undo.

When replacing content on a page that has child pages, preserve the `<page url="...">` tags in your new content to avoid archiving them.
