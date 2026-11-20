# syntax=docker/dockerfile:1

# Production image for the Web Spaces server. Generic: every setting comes
# from the environment at run time (see the README's Environment Variables
# table). docs/deployment-fly.io.md covers running it.

# Build stage: compile src/ into dist/.
FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# The build context carries no .git, so the commit that dist/build-info.json
# records comes from this build argument. Without it the commit is null. The
# version and build time are stamped either way.
ARG GIT_COMMIT=""
RUN GIT_COMMIT="$GIT_COMMIT" pnpm run build

# Runtime stage: production dependencies, dist/, and the static assets.
FROM node:24-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY common ./common
COPY --from=build /app/dist ./dist

# Runs as root: platform volumes often mount owned by root, and the
# filesystem backend writes to one. Add a USER line where the data directory
# can be owned by an unprivileged user.
EXPOSE 3002
# Plain JSON logs (no pino-pretty), for the platform's log collector.
CMD ["node", "dist/start.js"]
