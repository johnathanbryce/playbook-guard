FROM node:22

WORKDIR /app

# Install deps first so the Linux-built node_modules layer caches independently of source.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 3001

CMD ["npm", "run", "dev"]
