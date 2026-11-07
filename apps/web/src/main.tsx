import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HealthResponse } from '@paso/shared';

function App() {
  const [status, setStatus] = useState('Comprobando servidor…');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${document.querySelector<HTMLMetaElement>('meta[name="paso-session-token"]')?.content ?? ''}` },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Servidor no disponible');
        const health: HealthResponse = await response.json();
        setStatus(health.status === 'ok' ? 'Servidor accesible' : 'Servidor no disponible');
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('Servidor no disponible');
      });
    return () => controller.abort();
  }, []);

  return <main><h1>Paso</h1><p>{status}</p></main>;
}

createRoot(document.getElementById('root')!).render(<App />);
