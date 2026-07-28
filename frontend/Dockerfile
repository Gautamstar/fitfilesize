# Build stage. `npm run build` is `tsc -b && vite build`, so a type error fails
# the image build rather than shipping broken code.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Serve stage. nginx-unprivileged listens on 8080 as a non-root user, so the
# static tier needs no root anywhere in the chain.
FROM nginxinc/nginx-unprivileged:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
