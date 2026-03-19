FROM oven/bun:latest
COPY . /app/
WORKDIR /app
RUN bun install
LABEL version="2026-03-19-interactive-fix"
CMD ["bun", "run", "index.ts"]
