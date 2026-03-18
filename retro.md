## BC-172 Retrospective

### What worked well
- Clear reproduction case in the ticket description made it easy to identify both issues
- Systematic investigation using grep and file reads to trace the data flow
- The architecture separation (orchestrator → types → ticket-agent → agent) was clear to follow
- Agent-manager tests caught potential issues and confirmed the changes work
- The recent UUID-to-ID refactor (BC-163) made it easy to understand the naming convention

### What didn't work / challenges
- Had to trace through multiple layers to understand the full config chain (orchestrator → agent-manager → ticket-agent → agent server → agent tools)
- `ticketIdentifier` was only set dynamically in the agent server from event payload, not persisted in env vars
- Easy to miss one of the two places UUIDs were displayed (status command + agent messages)

### Learnings
- **Always propagate display metadata through the full config chain**: When adding display fields like `ticketId` and `ticketTitle`, ensure they flow all the way from database → agent config → env vars → agent runtime
- **Grep for all display sites**: When fixing display issues, search for all places the identifier is shown (status queries, thread updates, logs)
- **Environment variables are the bridge**: The ticket-agent passes config to the container via env vars. Any runtime metadata must be in `resolveAgentEnvVars()`

### Action items
- None - fix is complete and tested
