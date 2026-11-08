/** Paso's mark: a rising step on a soft violet tile, and the name with a violet full stop. */
export function Brand() {
  return (
    <div className="brand">
      <span className="brand__mark" aria-hidden="true">
        <svg viewBox="0 0 16 16"><path d="M1.5 14.5h4v-4h4.5V6h4.5V1.5" /></svg>
      </span>
      <span className="brand__name">Paso<span className="brand__dot">.</span></span>
    </div>
  );
}
