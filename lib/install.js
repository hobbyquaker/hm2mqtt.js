/**
 * --install / --uninstall: systemd template service hm2mqtt@<name> (mqtt-interfaces-core installer).
 */

import {createInstaller} from 'mqtt-interfaces-core';

export const SERVICE = 'hm2mqtt';
export const ENV_PREFIX = 'HM2MQTT';

const installer = createInstaller({
    service: SERVICE,
    envPrefix: ENV_PREFIX,
    description: `${SERVICE} %i - Homematic CCU to MQTT bridge`,
    documentation: 'https://github.com/hobbyquaker/hm2mqtt.js',
});

export const {unitFile, envFile, installService, uninstallService, handle} = installer;
