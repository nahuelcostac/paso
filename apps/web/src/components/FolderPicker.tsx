import { useCallback, useEffect, useState } from 'react';
import { ArrowUp, ChevronRight, Folder, FolderPlus, House } from 'lucide-react';
import { ApiClient, type FolderListing } from '../lib/api';
import { workspaceErrorText } from '../state/projects-store';
import { Dialog } from './Dialog';
import { NameField } from './NameField';

type Props = {
  api: ApiClient;
  /** A folder whose parent the explorer opens in, such as the open workspace's. Without it, the home folder. */
  near?: string;
  /** Adds the chosen folder as a workspace. Rejects with the words to show if it could not. */
  onChoose: (path: string) => Promise<void>;
  onClose: () => void;
};

const plural = (count: number) => count === 1 ? '1 project' : `${count} projects`;

/**
 * “New workspace”: a folder explorer served by the local service. Clicking a folder goes into it; the folder on show
 * is the one chosen. It lists folder names only, and a new folder can be made where the person is.
 */
export function FolderPicker({ api, near, onChoose, onClose }: Props) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const go = useCallback(async (path?: string) => {
    setError(null); setCreating(false);
    try { setListing(await api.listFolders(path)); }
    catch (failure) { setError(`Couldn't open the folder. ${workspaceErrorText(failure)}`); }
  }, [api]);
  useEffect(() => {
    void (async () => {
      const beside = near ? await api.listFolders(near).catch(() => null) : null;
      await go(beside?.parent ?? undefined);
    })();
  }, [api, near, go]);

  const choose = async () => {
    if (!listing) return;
    setBusy(true); setError(null);
    try { await onChoose(listing.path); }
    catch (failure) { setError(`Couldn't add the folder. ${workspaceErrorText(failure)}`); setBusy(false); }
  };

  // The way down to the folder on show, from the home folder, as steps to click.
  const crumbs = listing?.crumbs ?? [];

  return (
    <Dialog title="New workspace" role="dialog" className="dialog--folders" onClose={() => { if (!busy) onClose(); }}>
      <p className="dialog__text">Choose a folder on this computer. Its projects appear in the sidebar; Paso doesn't move or delete anything.</p>
      <div className="folders">
        <div className="folders__bar">
          <button type="button" className="icon-btn" aria-label="Home folder" title="Home folder" disabled={!listing} onClick={() => void go(listing?.home)}>
            <House className="i" aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" aria-label="Up one level" title="Up one level" disabled={!listing?.parent} onClick={() => void go(listing?.parent ?? undefined)}>
            <ArrowUp className="i" aria-hidden="true" />
          </button>
          <nav className="folders__path" aria-label="Current folder" title={listing?.path}>
            {crumbs.map((crumb, index) => (
              <span key={crumb.path} className="folders__crumb">
                {index > 0 && <ChevronRight className="i" aria-hidden="true" />}
                {index === crumbs.length - 1
                  ? <span aria-current="location">{crumb.name}</span>
                  : <button type="button" onClick={() => void go(crumb.path)}>{crumb.name}</button>}
              </span>
            ))}
          </nav>
        </div>
        <ul className="folders__list" aria-label="Folders" aria-busy={!listing}>
          {creating && listing && (
            <li className="folders__draft">
              <Folder className="i" aria-hidden="true" />
              <NameField
                initial="" label="Name of the new folder" placeholder="Folder name"
                onSave={async (name) => {
                  try { const { path } = await api.createFolder(listing.path, name); await go(path); }
                  catch (failure) { throw new Error(`Couldn't create the folder. ${workspaceErrorText(failure)}`); }
                }}
                onCancel={() => setCreating(false)}
                onAbandon={(message) => { setCreating(false); setError(message); }}
              />
            </li>
          )}
          {listing?.folders.map((folder) => (
            <li key={folder.path}>
              <button type="button" onClick={() => void go(folder.path)}>
                <Folder className="i" aria-hidden="true" /><span>{folder.name}</span><ChevronRight className="i folders__go" aria-hidden="true" />
              </button>
            </li>
          ))}
          {listing && listing.folders.length === 0 && !creating && <li className="folders__empty">No folders inside.</li>}
        </ul>
        <div className="folders__foot">
          <button type="button" className="btn" disabled={!listing || creating} onClick={() => setCreating(true)}>
            <FolderPlus className="i" aria-hidden="true" />New folder
          </button>
          {listing && <span className="folders__count" role="status">{listing.projects ? `Has ${plural(listing.projects)}` : 'No projects yet'}</span>}
        </div>
      </div>
      {error && <p className="dialog__error" role="alert">{error}</p>}
      <div className="dialog__actions">
        <button type="button" className="btn btn--soft" data-autofocus onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn--primary" disabled={!listing || busy} onClick={() => void choose()}>Use this folder</button>
      </div>
    </Dialog>
  );
}
