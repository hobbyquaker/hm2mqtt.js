const os = require('os');

const interfaces = os.networkInterfaces();
const addresses = [];
Object.keys(interfaces).forEach(i => {
    Object.keys(interfaces[i]).forEach(a => {
        const address = interfaces[i][a];
        if (address.family === 'IPv4' && !address.internal) {
            addresses.push(address.address);
        }
    });
});

const [firstAddress] = addresses;

module.exports = firstAddress;
