import express from 'express';
import stubsmith from 'stubsmith';
import { getOrder, getUser } from './orders.js';

// Reads STUBSMITH_API_KEY (and the other STUBSMITH_* variables) from the
// environment. Without a key the SDK disables itself and the service runs
// unchanged. Call install() before anything that issues requests.
const client = stubsmith.install();

const app = express();

app.get('/orders/:id', async (req, res) => {
  try {
    res.json(await getOrder(req.params.id));
  } catch (err) {
    res.status(502).json({ error: String(err.message) });
  }
});

app.get('/users/:id', async (req, res) => {
  try {
    const user = await getUser(req.params.id);
    if (user === null) return res.status(404).json({ error: 'no such user' });
    res.json(user);
  } catch (err) {
    res.status(502).json({ error: String(err.message) });
  }
});

const server = app.listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`listening on ${server.address().port}, capture ${client.enabled ? 'on' : 'off (no STUBSMITH_API_KEY)'}`);
});

// A server never drains its event loop, so the SDK's exit hook never fires.
// Flush queued captures explicitly on shutdown.
process.on('SIGTERM', () => {
  server.close(async () => {
    await client.close();
    process.exit(0);
  });
});
