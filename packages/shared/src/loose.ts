/**
 * Loose diagrams: scenes that belong to no project. They live in one reserved project per workspace, so the data model
 * stays project > scenes > steps. Its folder is hidden (a leading dot), and project lists never show it.
 */
export const LOOSE_PROJECT_ID = '_loose';
/** The reserved project's folder inside the workspace. A leading dot hides it in Finder and in `ls`. */
export const LOOSE_PROJECT_FOLDER = '.loose';
/** The reserved project's `name`, for anyone reading `project.json`. The app never shows it. */
export const LOOSE_PROJECT_NAME = 'Diagramas sueltos';

export const isLooseProject = (id: string | null | undefined) => id === LOOSE_PROJECT_ID;
