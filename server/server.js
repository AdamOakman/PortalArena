import { GameServer } from './core/GameServer.js';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const gameServer = new GameServer(port);

gameServer.start();

export { gameServer, GameServer };
export default gameServer;
