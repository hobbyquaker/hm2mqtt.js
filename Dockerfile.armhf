FROM hypriot/rpi-node:slim
LABEL maintainer="Holger Imbery <contact@connectedobjects.cloud>" \
      version="1.1a" \
      description="HM2MQTT (hm2mqtt.js) dockerized version of https://github.com/hobbyquaker/hm2mqtt.js"

RUN npm config set unsafe-perm true
RUN npm install -g hm2mqtt

EXPOSE 2126
EXPOSE 2127
ENTRYPOINT ["hm2mqtt"]
