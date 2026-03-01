FROM oven/bun:latest

# Install git for repo cloning and gh CLI for PR creation
RUN apt-get update && \
    apt-get install -y git curl && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy the generic PE agent
COPY agent/ /app/agent/
WORKDIR /app/agent
RUN bun install

# Workspace for cloned repos
RUN mkdir -p /workspace

WORKDIR /workspace
