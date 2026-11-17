import { useEffect, useState } from 'react';

/** How long loading may take before it is mentioned. Below this a message would only flash. */
export const LOADING_DELAY_MS = 300;

/** «Cargando…» in the canvas's place, only once loading takes long enough to notice. Until then the place stays quiet. */
export function Loading({ children }: { children: string }) {
  const [late, setLate] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setLate(true), LOADING_DELAY_MS); return () => clearTimeout(timer); }, []);
  return <div className="editor-message" aria-busy="true">{late ? children : null}</div>;
}
