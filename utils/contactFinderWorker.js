// Runs one Contact Finder check in its own thread – a slow / odd website can never block the main server
const { parentPort, workerData } = require('worker_threads');
const { findContacts } = require('./contactFinder');

findContacts(workerData.domain)
    .then(result => parentPort.postMessage({ result }))
    .catch(err => parentPort.postMessage({ error: err.message || 'Check failed' }));
