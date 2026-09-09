FROM node:24-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:24-alpine
ENV NODE_ENV=production \
    FROND_EAR_HOST=127.0.0.1 \
    FROND_EAR_DATABASE=/data/frond-ear.db \
    FROND_EAR_POLICY=/config/policy.json
WORKDIR /app
COPY --from=build /app/dist/src ./dist
USER node
VOLUME ["/data", "/config"]
EXPOSE 8791
CMD ["node", "dist/main.js"]
