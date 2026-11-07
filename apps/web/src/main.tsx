import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HealthResponse } from '@paso/shared';

function App() {
  const [status, setStatus] = useState('Checking server...');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Server unavailable');
        const health: HealthResponse = await response.json();
        setStatus(health.status === 'ok' ? 'Server reachable' : 'Server unavailable');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('Server unavailable');
      });
    return () => controller.abort();
  }, []);

  return <main><h1>Paso</h1><p>{status}</p></main>;
}

createRoot(document.getElementById('root')!).render(<App />);
