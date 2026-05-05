# Notion Channel Protocol

How to handle Notion events that arrive via the notion-channel bridge.

## Setup (do this once on session start)

If your project has a canonical Notion parent page (e.g., a Drafts folder, a CRM root, a planning page), subscribe to it on session start so you receive events on it and all descendants:

```
notion_watch_page(page_id="<parent-page-id>", include_descendants=true)
```

Use `notion_list_my_watches` to see your current subscriptions before adding new ones. The subscribe call is idempotent.

## What you'll receive

Events arrive as `<channel source="claude-hive">` messages — same format as peer pings.

| Event type | When it arrives | Filter |
|---|---|---|
| `comment.created` / `comment.updated` / `comment.deleted` | Always | None — comments are explicit asks |
| `page.content_updated` / `page.properties_updated` | Only when the new page text contains `TODO:` or `Claude` (case-insensitive) | The receiver pre-filters; you only see the routable ones |
| `page.created` / `page.deleted` / `page.undeleted` / `page.moved` / `page.locked` / `page.unlocked` | Always | None — structural events are meaningful |

For filtered page edits, the routed message includes the matching snippet(s) with ~200 chars of surrounding context, so you don't need to re-fetch the page just to see what changed.

## How to respond

**Comments are explicit asks.** Treat them like a peer tap. Read the comment, decide if there's something you can and should do, and if so, do it. If it's outside your scope, route it via claude-hive `send_message` to the right peer.

**Page edits with directives are also explicit asks.** Bryan added `TODO:` or wrote `Claude` because he wants the agent to look. Read the snippet, decide if it's actionable in your domain:
- If yes → do it
- If it needs a different agent → route via claude-hive
- If it's not actionable yet (waiting on something) → ignore

**Page structural events are awareness signals.** Use them to keep your context fresh. Don't necessarily act on them.

## Decision framework

Before acting on any Notion event:
1. **Is this in my domain?** If not, route to the right peer via claude-hive.
2. **Is the ask clear?** If ambiguous, leave a clarifying comment on the same Notion page (don't message Bryan directly — keep the conversation in context).
3. **Can I do this autonomously, or do I need confirmation?** Follow your project's existing Definition of Done for what needs human review.
4. **Did I do it?** Reply with a short confirmation, either as a Notion comment on the same page or back through claude-hive — whichever Bryan can see most easily.

## Anti-patterns

- Don't act on every page edit just because it routed to you. The directive might be for a different agent or context.
- Don't subscribe to overlapping subtrees with peers. Pick one canonical parent per project; let the conductor route work between agents if a directive could fit multiple.
- Don't unsubscribe from a parent just because one specific descendant is irrelevant. The parent subscription is meant to cover the whole tree.
- Don't comment on Notion to acknowledge every event — only when you've taken an action or have a question. Keep Notion threads readable.
