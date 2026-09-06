import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.SIYUE_SERVER_PORT ?? 8787);
await app.listen({ port, host: '127.0.0.1' });
