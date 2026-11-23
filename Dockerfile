FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Build the client bundle and the server, so production never runs the Vite dev
# server. The dev server exposes source, sourcemaps and a file-serving surface
# that has no business being reachable from the internet.
RUN npm run build

ENV NODE_ENV=production

# Drop privileges; the node image ships an unprivileged 'node' user.
USER node

EXPOSE 3000

CMD ["npm", "start"]
