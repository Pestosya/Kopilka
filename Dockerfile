FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY scripts ./scripts
COPY modules ./modules
COPY tests ./tests
COPY index.html styles.css app.js manifest.webmanifest service-worker.js sync-config.js ./
COPY icon.svg icon-192.png icon-512.png apple-touch-icon.png ./
ARG KOPILKA_SUPABASE_URL
ARG KOPILKA_SUPABASE_PUBLISHABLE_KEY
ENV KOPILKA_SUPABASE_URL=$KOPILKA_SUPABASE_URL
ENV KOPILKA_SUPABASE_PUBLISHABLE_KEY=$KOPILKA_SUPABASE_PUBLISHABLE_KEY
RUN npm run ci

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
