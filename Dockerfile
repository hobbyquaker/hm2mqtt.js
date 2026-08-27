FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js config.js paramsets.json example-names.json names.schema.json ./
COPY lib/ ./lib/

ENV NODE_ENV=production \
    HM2MQTT_MQTT_URL=mqtt://localhost \
    HM2MQTT_NAME=hm \
    HM2MQTT_CCU_ADDRESS=homematic-ccu3 \
    HM2MQTT_STATE_DIR=/data \
    HM2MQTT_VERBOSITY=info

VOLUME /data
# the CCU calls back on 2126 (xmlrpc) / 2127 (binrpc): use --network host, or publish the ports
# and set HM2MQTT_INIT_ADDRESS to the docker host's address
EXPOSE 2126 2127

USER node

ENTRYPOINT ["node", "index.js"]
