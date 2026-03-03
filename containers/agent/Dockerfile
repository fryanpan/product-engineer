FROM oven/bun:latest

RUN apt-get update && \
    apt-get install -y git curl ca-certificates gnupg && \
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

COPY agent/ /app/agent/
WORKDIR /app/agent
RUN bun install

RUN mkdir -p /workspace
WORKDIR /app/agent
CMD ["bun", "run", "src/server.ts"]
