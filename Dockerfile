FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data /app/logs

# OJO: no poner USER node.
# Railway monta el volumen en /app/data con dueno root. Al correr como 'node',
# SQLite abre la base para lectura pero falla toda escritura con
# SQLITE_READONLY, y la app pierde en silencio cada evento de WhatsApp, cada
# comprobante y cada factura. El proceso corre como root, igual que hacia el
# builder anterior (RAILPACK) durante meses.
#
# Railway usa este Dockerfile aunque el servicio diga builder: RAILPACK: si hay
# Dockerfile en la raiz del repo, gana el Dockerfile.
EXPOSE 8080

CMD ["node", "server.js"]
