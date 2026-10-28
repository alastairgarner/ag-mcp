# Same glibc-based Node version in both stages for native SQLite compatibility.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NODE_LLAMA_CPP_SKIP_DOWNLOAD=true
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@12.14.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN pnpm test && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HTTP_HOST=0.0.0.0 PORT=3000 \
    NOTES_ROOT=/data/notes STATE_DIR=/data/state AUTH_CONFIG=/config/auth.json NODE_LLAMA_CPP_SKIP_DOWNLOAD=true
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json ./
RUN mkdir -p /data/notes /data/state /config && chmod 700 /data/notes /data/state /config && chown -R node:node /data /config
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/http-main.js"]
