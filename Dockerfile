FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY index.html styles.css app.js README.md ./
COPY server ./server
ENV NODE_ENV=production
ENV PORT=4173
EXPOSE 4173
CMD ["npm", "start"]
