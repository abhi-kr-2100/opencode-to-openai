FROM oven/bun:1-slim AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

EXPOSE 8000

CMD ["bun", "run", "start"]
