# syntax=docker/dockerfile:1

# ---- build: compile the server and bundle the web app ----
FROM node:24-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 downloads a prebuilt binary; the toolchain is only a fallback if none matches this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies first so this layer is cached until a package.json changes.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY server server
COPY web web
RUN npm run build

# Replace the full install (which includes build tools and the web app's libraries) with just what the server needs to run.
RUN rm -rf node_modules && npm ci --omit=dev --workspace server


# ---- runtime: a small image with the compiled server and the built web app ----
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/tasks.db
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

# The database lives in a volume so it survives container restarts and upgrades.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# JWT_SECRET must be provided at run time (the server refuses to start in production without it).
CMD ["node", "server/dist/index.js"]
