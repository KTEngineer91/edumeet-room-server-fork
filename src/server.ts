process.title = 'edumeet-room-server';

import fs from 'fs';
import https from 'https';
import http from 'http';
import ServerManager from './ServerManager';
import { Server as IOServer } from 'socket.io';
import { interactiveServer } from './interactiveServer';
import { Logger } from 'edumeet-common';
import MediaService from './MediaService';
import { socketHandler } from './common/socketHandler';
import { Peer } from './Peer';
import Room from './Room';
import ManagementService from './ManagementService';
import { getConfig } from './Config';

const logger = new Logger('Server');
const config = getConfig();

const peers = new Map<string, Peer>();
const rooms = new Map<string, Room>();
const managedPeers = new Map<string, Peer>();
const managedRooms = new Map<string, Room>();

logger.debug('Starting... [config: %o]', config);

const mediaService = MediaService.create();

let managementService: ManagementService | undefined;

if (config.managementService)
	managementService = new ManagementService({ managedPeers, managedRooms, mediaService });

const serverManager = new ServerManager({ peers, rooms, managedRooms, managedPeers, mediaService, managementService });

interactiveServer(serverManager, managementService);

let webServer: http.Server | https.Server;

if (config.tls?.cert && config.tls?.key) {
	webServer = https.createServer({
		cert: fs.readFileSync(config.tls.cert),
		key: fs.readFileSync(config.tls.key),
		minVersion: 'TLSv1.2',
		ciphers: [
			'ECDHE-ECDSA-AES128-GCM-SHA256',
			'ECDHE-RSA-AES128-GCM-SHA256',
			'ECDHE-ECDSA-AES256-GCM-SHA384',
			'ECDHE-RSA-AES256-GCM-SHA384',
			'ECDHE-ECDSA-CHACHA20-POLY1305',
			'ECDHE-RSA-CHACHA20-POLY1305',
			'DHE-RSA-AES128-GCM-SHA256',
			'DHE-RSA-AES256-GCM-SHA384'
		].join(':'),
		honorCipherOrder: true
	});
} else {
	logger.debug('No TLS certificate or key provided, using HTTP');

	webServer = http.createServer();
}

webServer.listen({ port: config.listenPort, host: config.listenHost }, () =>
	logger.debug('webServer.listen() [port: %s]', config.listenPort));

const socketServer = new IOServer(webServer, {
	cors: { origin: '*' },
	cookie: false,
	connectionStateRecovery: {
		// the backup duration of the sessions and the packets
		maxDisconnectionDuration: 5 * 60 * 1000,
		// whether to skip middlewares upon successful recovery
		skipMiddlewares: true,
	}
});

socketServer.on('connection', socketHandler);

// HTTP endpoint for participant counts (registered after Socket.io)
webServer.on('request', async (req, res) => {
	// Only handle requests to /internal/rooms/participants
	if (req.url !== '/internal/rooms/participants') {
		// Let Socket.io handle other requests
		return;
	}

	// Set CORS headers
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

	// Handle preflight OPTIONS request
	if (req.method === 'OPTIONS') {
		res.writeHead(200);
		res.end();
		return;
	}

	// Only handle POST requests
	if (req.method !== 'POST') {
		res.writeHead(405, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Method not allowed' }));
		return;
	}

	// Optional API key authentication
	if (config.internalApiKey) {
		const authHeader = req.headers.authorization;
		const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

		if (!apiKey || apiKey !== config.internalApiKey) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Unauthorized' }));
			return;
		}
	}

	try {
		// Read request body
		let body = '';
		for await (const chunk of req) {
			body += chunk.toString();
		}

		// Parse JSON body (roomIds is optional)
		const requestData = body ? JSON.parse(body) : {};
		const roomIds: string[] | undefined = requestData.roomIds;

		// Get participant counts
		const counts = serverManager.getParticipantCounts(roomIds);

		// Send response
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(counts));
	} catch (error) {
		logger.error('Error handling participant counts request: %o', error);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Internal server error' }));
	}
});

const close = () => {
	logger.debug('close()');

	serverManager.close();
	webServer.close();

	process.exit(0);
};

process.once('SIGINT', close);
process.once('SIGQUIT', close);
process.once('SIGTERM', close);

logger.debug('Started!');
