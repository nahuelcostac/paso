// Vite and its HMR WebSocket share one loopback origin.
export function isDevRequestAllowed(rawUrl, origin) {
  try {
    const url = new URL(rawUrl);
    return ((url.protocol === 'http:' || url.protocol === 'ws:') && url.host === new URL(origin).host) || ['data:', 'blob:', 'devtools:'].includes(url.protocol);
  } catch { return false; }
}
