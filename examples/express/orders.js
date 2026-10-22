// The two upstream calls the service makes. Kept apart from server.js so a
// test can import them without starting a server.
import axios from 'axios';

const upstream = () => process.env.UPSTREAM_URL ?? 'http://localhost:8081';

// Native fetch: captured by the fetch hook.
export async function getOrder(id) {
  const res = await fetch(`${upstream()}/api/orders/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`orders API answered ${res.status}`);
  return res.json();
}

// axios: captured by the http hook. A 404 is a normal answer here, not an error.
export async function getUser(id) {
  const res = await axios.get(`${upstream()}/api/users/${encodeURIComponent(id)}`, {
    validateStatus: () => true,
  });
  return res.status === 404 ? null : res.data;
}
