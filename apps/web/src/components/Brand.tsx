import { brandMark, brandMarkLayout } from '@paso/shared';

const mark = brandMarkLayout();

/** Paso's mark: a rising step on an ink tile, and the name.
 *  The mark's geometry comes from @paso/shared's brandMark, like the tab and desktop icons.
 *  Its colours are --ink and --on-ink, so the tile inverts in the dark theme. */
export function Brand() {
  return (
    <div className="brand">
      <svg className="brand__mark" width={mark.size} height={mark.size} viewBox={`0 0 ${mark.size} ${mark.size}`} aria-hidden="true">
        <rect className="brand__tile" x={mark.tile.x} y={mark.tile.y} width={mark.tile.size} height={mark.tile.size} rx={mark.tile.radius} />
        <path className="brand__step" d={mark.step.d} transform={mark.step.transform} strokeWidth={brandMark.strokeWidth}
          strokeLinecap={brandMark.strokeLinecap} strokeLinejoin={brandMark.strokeLinejoin} />
      </svg>
      <span className="brand__name">Paso</span>
    </div>
  );
}
