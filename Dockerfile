FROM mcr.microsoft.com/playwright:v1.60.0-noble

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    BIND_ADDRESS=0.0.0.0 \
    PORT=5174 \
    TRUST_PROXY=1

WORKDIR /app

# Install only production deps (skips Playwright's browser download since the
# base image already includes Chromium under /ms-playwright).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm rebuild sharp \
 && rm -rf /root/.npm

COPY server.mjs ./
COPY lib ./lib
COPY public ./public

# The base image ships a non-root `pwuser` (uid 1000). The Chromium sandbox
# requires user namespaces; running as a non-root user keeps the sandbox real.
RUN mkdir -p /app/output && chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5174)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
