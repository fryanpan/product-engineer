# Administrative Operations

- Adding products, updating registry config, or changing orchestrator settings must be done via the admin API (POST/PUT/DELETE /api/products, PUT /api/settings/*), not by writing new code files or config files
- Never commit project-specific configuration (repo URLs, channel IDs, secret names, GitHub tokens) into source code — these belong in the runtime registry (SQLite via admin API)
- The registry.json file in orchestrator/src/ is a seed template only — do not add real product configs to it
