const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "4 escenas · 17 pasos". A project with no scenes says so instead of showing two zeros. */
export function formatSize(scenes: number, steps: number) {
  if (scenes === 0) return 'Sin escenas';
  return `${plural(scenes, 'escena', 'escenas')} · ${plural(steps, 'paso', 'pasos')}`;
}

/** "4 escenas y 17 pasos", for sentences. */
export const describeContents = (scenes: number, steps: number) => `${plural(scenes, 'escena', 'escenas')} y ${plural(steps, 'paso', 'pasos')}`;

/** Lower case without accents, so "dibujo" finds "Dibujo" and "diseño" finds "diseno". */
export const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** The service's own message for a project it cannot open, in terms a person can act on. */
export function explainProjectError(message: string) {
  if (/newer than supported version/i.test(message)) {
    return { short: 'Creado con una versión más nueva de Paso', long: 'Este diagrama se creó con una versión más nueva de Paso. Actualiza Paso para abrirlo.' };
  }
  return { short: 'No se puede leer: archivos dañados', long: 'Los archivos de este diagrama no son válidos. Repáralos en el disco o restaura una copia; el resto de diagramas siguen funcionando.' };
}

/** "4 pasos" for a scene's heading. An empty scene says so. */
export const formatSteps = (count: number) => count === 0 ? 'Sin pasos' : plural(count, 'paso', 'pasos');

export type RecencyGroup<T> = { label: 'Hoy' | 'Este mes' | 'Anteriores'; items: T[] };

/**
 * The sidebar's groups, by when each project last changed: today, earlier this month, and before. Dates are compared on
 * the person's own calendar. A date in the future, from another computer's clock, counts as today. Empty groups are left out.
 */
export function groupByRecency<T>(items: T[], changedAt: (item: T) => string, now = new Date()): RecencyGroup<T>[] {
  const groups: RecencyGroup<T>[] = [{ label: 'Hoy', items: [] }, { label: 'Este mes', items: [] }, { label: 'Anteriores', items: [] }];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  for (const item of items) {
    const at = new Date(changedAt(item)).getTime();
    groups[Number.isNaN(at) ? 2 : at >= today ? 0 : at >= month ? 1 : 2].items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}
