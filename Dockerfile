# Playwright base image: ships Chromium + all system deps, and node. Lets the
# proxy do its own stealth render (?render=1) from this (residential) IP, so
# callers don't need a browser in their own CI. Pin to the same playwright-core
# version as package.json.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy
WORKDIR /app
COPY package.json server.js ./
RUN npm install --omit=dev
EXPOSE 3000
CMD ["node", "server.js"]
