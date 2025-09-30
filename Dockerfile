FROM node:18-alpine

WORKDIR /app

# instala dependencias sólo de producción
COPY package*.json ./
RUN npm ci --omit=dev

# Copia el resto del código
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
