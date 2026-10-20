FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY index.html styles.css app.js README.md ./
COPY server ./server
COPY shared ./shared
ENV NODE_ENV=production
ENV PORT=4173
ENV DATA_FILE=/data/arena.json
RUN mkdir -p /data
EXPOSE 4173
CMD ["npm", "start"]
