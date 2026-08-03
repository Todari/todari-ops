FROM node:22-alpine AS base
WORKDIR /app
# bash + coreutils so the SDK's Bash tool finds /bin/bash and POSIX
# variants of sed/awk/etc. Without these the agent can't run git,
# pnpm scripts, or anything shell-driven inside the container.
RUN corepack enable && apk add --no-cache git openssh-client bash coreutils

FROM base AS deps
# pnpm-workspace.yaml carries build-script approvals (allowBuilds) — without
# it pnpm 11 hard-fails install with ERR_PNPM_IGNORED_BUILDS.
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile || pnpm install

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# /home/node/.claude backs the claude_state volume so SDK session transcripts
# (needed for `resume`) survive container rebuilds. Pre-create with node
# ownership so the fresh named volume inherits it.
RUN mkdir -p /data/work /home/node/.claude && chown -R node:node /data /home/node/.claude
USER node
EXPOSE 3000
CMD ["node", "dist/bot.js"]
