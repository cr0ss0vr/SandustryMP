// SandustryMP UPnP Internet Gateway Device port mapping.
'use strict';

const dgram = require('dgram');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DISCOVERY_ADDRESS = '239.255.255.250';
const DISCOVERY_PORT = 1900;
const SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be a whole number from 1 to 65535');
  return port;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function requestText(urlValue, options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlValue);
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, { ...options, timeout: timeoutMs || 3000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error('UPnP request timed out')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function discoverLocations(timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const locations = new Set();
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch (e) {}
      if (error) reject(error); else resolve([...locations]);
    };
    const timer = setTimeout(() => finish(), timeoutMs || 2500);
    socket.on('error', finish);
    socket.on('message', (message) => {
      const match = /^location:\s*(.+)$/im.exec(message.toString('utf8'));
      if (match) locations.add(match[1].trim());
    });
    socket.bind(0, () => {
      for (const serviceType of SERVICE_TYPES) {
        const message = Buffer.from([
          'M-SEARCH * HTTP/1.1',
          'HOST: ' + DISCOVERY_ADDRESS + ':' + DISCOVERY_PORT,
          'MAN: "ssdp:discover"',
          'MX: 2',
          'ST: ' + serviceType,
          '', '',
        ].join('\r\n'));
        socket.send(message, DISCOVERY_PORT, DISCOVERY_ADDRESS);
      }
    });
  });
}

function findGatewayService(descriptionUrl, descriptionXml) {
  const services = descriptionXml.match(/<service\b[\s\S]*?<\/service>/gi) || [];
  for (const preferredType of SERVICE_TYPES) {
    for (const serviceXml of services) {
      const typeMatch = /<serviceType>\s*([^<]+)\s*<\/serviceType>/i.exec(serviceXml);
      const controlMatch = /<controlURL>\s*([^<]+)\s*<\/controlURL>/i.exec(serviceXml);
      if (typeMatch && controlMatch && typeMatch[1].trim() === preferredType) {
        return { serviceType: preferredType, controlUrl: new URL(controlMatch[1].trim(), descriptionUrl).href };
      }
    }
  }
  return null;
}

function getLocalAddressFor(urlValue) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlValue);
    const socket = dgram.createSocket('udp4');
    socket.on('error', (error) => { try { socket.close(); } catch (e) {} reject(error); });
    socket.connect(Number(target.port) || 80, target.hostname, () => {
      const address = socket.address().address;
      socket.close();
      resolve(address);
    });
  });
}

async function soap(service, action, argumentsXml, timeoutMs) {
  const body = '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><u:' + action + ' xmlns:u="' + xmlEscape(service.serviceType) + '">' + argumentsXml + '</u:' + action + '></s:Body></s:Envelope>';
  const response = await requestText(service.controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': Buffer.byteLength(body),
      SOAPAction: '"' + service.serviceType + '#' + action + '"',
    },
  }, body, timeoutMs);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const code = /<errorCode>\s*([^<]+)\s*<\/errorCode>/i.exec(response.text);
    const description = /<errorDescription>\s*([^<]+)\s*<\/errorDescription>/i.exec(response.text);
    throw new Error('UPnP ' + action + ' failed' + (code ? ' (' + code[1].trim() + ')' : '') + (description ? ': ' + description[1].trim() : ''));
  }
  return response.text;
}

async function addPortMapping(options) {
  const port = normalizePort(options.port);
  const locations = await discoverLocations(options.discoveryTimeoutMs);
  if (!locations.length) throw new Error('No UPnP Internet Gateway Device was found');
  let lastError = null;
  for (const location of locations) {
    try {
      const description = await requestText(location, { method: 'GET' }, null, options.requestTimeoutMs);
      if (description.statusCode < 200 || description.statusCode >= 300) continue;
      const service = findGatewayService(location, description.text);
      if (!service) continue;
      const internalAddress = await getLocalAddressFor(service.controlUrl);
      await soap(service, 'AddPortMapping',
        '<NewRemoteHost></NewRemoteHost>' +
        '<NewExternalPort>' + port + '</NewExternalPort>' +
        '<NewProtocol>TCP</NewProtocol>' +
        '<NewInternalPort>' + port + '</NewInternalPort>' +
        '<NewInternalClient>' + xmlEscape(internalAddress) + '</NewInternalClient>' +
        '<NewEnabled>1</NewEnabled>' +
        '<NewPortMappingDescription>' + xmlEscape(options.description || 'SandustryMP') + '</NewPortMappingDescription>' +
        '<NewLeaseDuration>0</NewLeaseDuration>', options.requestTimeoutMs);
      let externalAddress = null;
      try {
        const externalResponse = await soap(service, 'GetExternalIPAddress', '', options.requestTimeoutMs);
        const addressMatch = /<NewExternalIPAddress>\s*([^<]+)\s*<\/NewExternalIPAddress>/i.exec(externalResponse);
        if (addressMatch) externalAddress = addressMatch[1].trim();
      } catch (e) {}
      return { ...service, port, protocol: 'TCP', internalAddress, externalAddress };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('The UPnP gateway does not provide a compatible WAN connection service');
}

async function removePortMapping(mapping) {
  if (!mapping || !mapping.controlUrl || !mapping.serviceType) return;
  await soap(mapping, 'DeletePortMapping',
    '<NewRemoteHost></NewRemoteHost><NewExternalPort>' + normalizePort(mapping.port) + '</NewExternalPort><NewProtocol>' + xmlEscape(mapping.protocol || 'TCP') + '</NewProtocol>', 3000);
}

module.exports = { addPortMapping, removePortMapping, normalizePort };
