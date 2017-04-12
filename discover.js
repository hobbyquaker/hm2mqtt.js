const net = require('net');

module.exports = (host, interfaces, callback) => {
    const sum = Object.keys(interfaces).length;
    const connections = {};
    let count = 0;

    Object.keys(interfaces).forEach(service => {
        connections[service] = net.connect({host, port: interfaces[service].port}, () => {
            connections[service].end();
            checkDone();
        });
        connections[service].on('error', () => {
            delete interfaces[service];
            checkDone();
        });
    });

    function checkDone() {
        if (++count >= sum) {
            callback(interfaces);
        }
    }
};
