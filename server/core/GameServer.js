import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { MatchSession } from '../match/MatchSession.js';
import { BotAgent } from '../bots/BotAgent.js';
import { TICK_RATE } from '../../shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../../dist');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

/**
 * GameServer — Object-Oriented Composition Root for the authoritative multiplayer backend.
 */
export class GameServer {
  constructor(port = 3001) {
    this.port = port;
    this.match = new MatchSession();
    this.players = new Map();
    this.spectators = new Map();
    this.tickInterval = null;
    this.tickCount = 0;

    this.httpServer = http.createServer((req, res) => this._handleHttpRequest(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws, req) => this._handleWsConnection(ws, req));
  }

  _handleHttpRequest(req, res) {
    const reqUrl = req.url === '/' ? '/index.html' : (req.url || '').split('?')[0];
    const safePath = path.normalize(reqUrl).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(DIST_DIR, safePath);

    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found - Ensure `npm run build` has been executed.');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  _handleWsConnection(ws) {
    ws.on('message', () => {
      // Message handling delegate
    });
    ws.on('close', () => {
      // Disconnection cleanup
    });
  }

  broadcast(messageObj) {
    const payload = JSON.stringify(messageObj);
    this.wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  addBot() {
    const existingNames = new Set(Array.from(this.players.values()).map(p => p.name));
    const taken = new Set(Array.from(this.players.values()).map(p => p.playerIndex));
    const playerIndex = taken.has(0) ? (taken.has(1) ? 0 : 1) : 0;
    const spawnIdx = this.match.pickSpawn();
    const spawn = this.match.mapData.spawns[spawnIdx];

    const bot = new BotAgent(playerIndex, spawn, existingNames);
    bot.spawnIdx = spawnIdx;
    this.players.set(bot.botId, bot.toPlayerState());
    return bot.botId;
  }

  start() {
    return new Promise((resolve) => {
      this.httpServer.listen(this.port, () => {
        console.log(`Portal Arena Server running at http://localhost:${this.port} and ws://localhost:${this.port}`);
        this.tickInterval = setInterval(() => this.tick(), 1000 / TICK_RATE);
        resolve();
      });
    });
  }

  tick() {
    this.tickCount++;
    // Authoritative game simulation tick
  }

  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.wss.close();
    this.httpServer.close();
  }
}
