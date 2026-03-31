FROM node:20-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@latest --activate && pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

ENV PORT=3000
EXPOSE 3000

CMD ["node", "build/index.js"]
