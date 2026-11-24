import { useRef, useState } from 'react';
import { Layers } from 'lucide-react';
import type { ApiClient } from '../lib/api';
import { nativeFolderChooser } from '../lib/desktop';
import { workspaceErrorText, type ProjectsStore, type StoreState } from '../state/projects-store';
import { FolderPicker } from './FolderPicker';
import { WorkspaceMenu } from './WorkspaceMenu';

type Props = {
  api: ApiClient;
  store: ProjectsStore;
  state: StoreState;
  /** Opens another workspace. The app saves the open step first. */
  onSwitchWorkspace: (open: () => Promise<void>) => Promise<void>;
  /** A failure to say, or null to clear it. The app shows it with its other notices. */
  onNotice: (message: string | null) => void;
  /** The toolbar's roving tab stop (ActivityBar). */
  tabIndex: number;
  onFocus: () => void;
};

/**
 * The workspace switcher, a button in the activity bar above the gear. Its menu opens beside it: every workspace, the
 * open one checked, then “New workspace…”, “Open folder” and, for a folder the person added, “Remove from list”.
 */
export function WorkspaceSwitcher({ api, store, state, onSwitchWorkspace, onNotice, tabIndex, onFocus }: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [switching, setSwitching] = useState(false);
  const listing = state.workspaces;
  const active = listing?.workspaces.find((workspace) => workspace.id === listing.activeId);
  const near = active && !active.default ? active.path : undefined;

  const act = async (action: () => Promise<void>, failure: string) => {
    setSwitching(true); onNotice(null);
    try { await onSwitchWorkspace(action); }
    catch (error) { onNotice(`${failure} ${workspaceErrorText(error)}`); }
    finally { setSwitching(false); }
  };
  /** “New workspace…”: the system's folder dialog in the desktop app, the in-app explorer in a browser. */
  const add = async () => {
    const choose = nativeFolderChooser();
    if (!choose) { setChoosingFolder(true); return; }
    onNotice(null);
    const path = await choose(near).catch(() => undefined);
    if (path === undefined) { onNotice("Couldn't open the folder chooser."); return; }
    if (path) await act(() => store.addWorkspace(path), "Couldn't add the folder.");
  };

  const label = `Workspace: ${active?.name ?? 'loading'}`;
  return <>
    <button
      ref={button} type="button" className="sidebar__button" data-id="workspace" aria-label={label}
      title={active ? `${label}\n${active.path}` : label} aria-haspopup="menu" aria-expanded={open}
      aria-busy={switching || undefined} disabled={!listing || switching} tabIndex={tabIndex} onFocus={onFocus}
      onClick={() => setOpen(!open)}
    >
      <Layers className="i" aria-hidden="true" />
    </button>
    {open && listing && button.current && (
      <WorkspaceMenu
        anchor={button.current} side="right" workspaces={listing.workspaces} activeId={listing.activeId}
        onClose={() => setOpen(false)}
        onSwitch={(id) => void act(() => store.switchWorkspace(id), "Couldn't open the workspace.")}
        onAdd={() => void add()}
        onReveal={() => { onNotice(null); void store.revealWorkspace(listing.activeId).catch(() => onNotice("Couldn't open the workspace's folder.")); }}
        onRemove={() => void act(() => store.removeWorkspace(listing.activeId), "Couldn't remove the workspace.")}
      />
    )}
    {choosingFolder && (
      <FolderPicker
        api={api} near={near} onClose={() => setChoosingFolder(false)}
        onChoose={async (path) => {
          // Errors stay in the explorer, where the person can pick another folder.
          await onSwitchWorkspace(() => store.addWorkspace(path));
          setChoosingFolder(false);
        }}
      />
    )}
  </>;
}
