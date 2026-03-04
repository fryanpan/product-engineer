FROM oven/bun:1.3.10

RUN apt-get update && \
    apt-get install -y git curl ca-certificates gnupg s3fs fuse && \
    # Node.js 22 via nodesource (provides npx for stdio MCP servers)
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    # GitHub CLI
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Non-root user — Claude Code refuses bypassPermissions as root
RUN useradd -m -s /bin/bash agent
RUN mkdir -p /workspace && chown agent:agent /workspace

COPY . /app/
WORKDIR /app
RUN bun install

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

USER agent
ENTRYPOINT ["/app/entrypoint.sh"]
