/**
 * “Keep previous step's framing”: the corners of “Frame” (lucide's Scan) around an arrow going back, so it
 * reads as the camera from before. Drawn like a lucide icon; svg.i gives the stroke.
 */
export function KeepCameraIcon({ className = 'i' }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" data-icon="keep-camera">
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="m10.5 8.5-3 3 3 3M7.5 11.5H14a2.5 2.5 0 0 1 0 5h-2" />
    </svg>
  );
}
