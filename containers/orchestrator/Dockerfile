FROM oven/bun:latest
COPY containers/orchestrator/ /app/
WORKDIR /app
RUN bun install
CMD ["bun", "run", "index.ts"]
