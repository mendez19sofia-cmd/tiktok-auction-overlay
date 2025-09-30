# Imagen estable y compatible
FROM node:18-bullseye-slim

WORKDIR /app

# Solo copiamos los manifests primero para cachear instalación
COPY package*.json ./

# Instala deps de producción (evita fallos por lockfile)
RUN npm install --omit=dev

# Copia el resto del código
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
