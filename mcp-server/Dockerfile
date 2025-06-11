FROM node:22-alpine

# enable pnpm via Corepack
RUN corepack enable \
 && corepack prepare pnpm@latest --activate

WORKDIR /app

# copy everything in one go
COPY . .

# install, build, then remove devDeps
RUN pnpm install \
 && pnpm run build \
 && pnpm prune --ignore-scripts

# expose port & run
EXPOSE 3000
CMD ["node", "dist/index.js"]
