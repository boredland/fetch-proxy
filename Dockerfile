# Playwright base image: ships Chromium + all system deps, and node. Lets the
# proxy do its own stealth render (?render=1) from this (residential) IP, so
# callers don't need a browser in their own CI. Pin to the same playwright-core
# version as package.json.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy
WORKDIR /app
# Bun is the runtime; the base image only ships node, so pull in the bun binary.
# Installed via npm so we don't need curl/unzip and the version tracks the image's node.
RUN npm install -g bun@1.3
# --frozen-lockfile: build fails loudly if bun.lock is stale rather than silently resolving.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server.ts tsconfig.json ./
EXPOSE 3000
CMD ["bun", "server.ts"]
