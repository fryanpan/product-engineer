---
alwaysApply: true
---

# Continuous Feedback & Learning

## After Completing a Feature
1. **Self-review** before declaring done:
   - Did I miss any edge cases?
   - Is this the simplest solution?
   - Did I update all places that needed updating?

2. **Capture learnings**: Proactively identify things worth remembering:
   - Technical gotchas or surprises
   - Patterns that worked well
   - Mistakes to avoid repeating
   - API quirks or environment issues

   Log specific additions to `docs/process/learnings.md`:
   ```markdown
   ## [Category]
   - [Specific gotcha or discovery]
   ```

## Elevating to Learnings

After fixing issues or completing features, look for things that should persist:
- Did we hit a gotcha that will recur?
- Did we discover something about the codebase/tools?
- Did an approach work particularly well or poorly?

Log to `docs/process/retrospective.md`:
```markdown
## YYYY-MM-DD - [Context]
**What worked:** ...
**What didn't:** ...
**Action:** ...
```
