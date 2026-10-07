import { buildProviderLabServer } from './server.js';

const PORT = Number(process.env.PROVIDER_LAB_PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = await buildProviderLabServer();
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[Provider Lab] Controlled failure provider server running at http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  main();
}
