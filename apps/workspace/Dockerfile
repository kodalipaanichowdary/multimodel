# Build context: repo root
FROM node:20-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/schemas/ts/package.json packages/schemas/ts/package.json
COPY apps/workspace/package.json apps/workspace/package.json
RUN npm ci --no-audit --no-fund
COPY packages/schemas packages/schemas
COPY apps/workspace apps/workspace
RUN npm run build -w @pos/workspace

FROM nginx:1.27-alpine
COPY infrastructure/nginx/workspace.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/workspace/dist /usr/share/nginx/html
EXPOSE 80
