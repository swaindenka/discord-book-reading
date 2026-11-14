import { useEffect, useState, type FormEvent } from 'react';
import { Lock, ShieldPlus, Trash2 } from 'lucide-react';
import type { SiteAdmin } from '../../../shared/types';
import { api } from '../api';
import { useSession } from '../session';
import { useToast } from './Toasts';
import { Avatar, Modal, Spinner } from './ui';

/** Lists site-wide admins. Root admins (ADMIN_USER_IDS) can add and remove others by Discord ID. */
export function SiteAdminsDialog({ onClose }: { onClose: () => void }) {
  const { user } = useSession();
  const toast = useToast();
  const [admins, setAdmins] = useState<SiteAdmin[] | null>(null);
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const canManage = Boolean(user?.isRootAdmin);

  useEffect(() => {
    api
      .admins()
      .then((r) => setAdmins(r.admins))
      .catch((err) => {
        toast.error(err);
        onClose();
      });
  }, [toast, onClose]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setAdmins((await api.addAdmin(userId.trim())).admins);
      setUserId('');
      toast.show('Admin added. They have owner rights in every room now.', 'success');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (admin: SiteAdmin) => {
    if (!window.confirm(`Remove ${admin.name ?? admin.userId} as a site admin?`)) return;
    try {
      setAdmins((await api.removeAdmin(admin.userId)).admins);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Modal title="Site admins" onClose={onClose}>
      <p className="muted small">
        Site admins have owner rights in every room: they can moderate, highlight, manage books and delete rooms.
      </p>
      {admins === null ? (
        <Spinner />
      ) : (
        <ul className="admin-list">
          {admins.map((admin) => (
            <li key={admin.userId} className="admin-row">
              <Avatar id={admin.userId} name={admin.name ?? '?'} url={admin.avatarUrl} size={32} />
              <div className="admin-text">
                <strong>{admin.name ?? 'Not signed in yet'}</strong>
                <span className="muted small">
                  {admin.userId}
                  {admin.addedByName && ` · added by ${admin.addedByName}`}
                </span>
              </div>
              {admin.fromConfig ? (
                <span className="pill small" title="Set in ADMIN_USER_IDS on the server">
                  <Lock size={12} /> Server setting
                </span>
              ) : (
                canManage && (
                  <button className="icon-btn ghost" aria-label={`Remove ${admin.name ?? admin.userId}`} onClick={() => remove(admin)}>
                    <Trash2 size={15} />
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form className="form admin-form" onSubmit={add}>
          <label className="field">
            <span>Add an admin by Discord user ID</span>
            <div className="row">
              <input
                className="input"
                inputMode="numeric"
                placeholder="e.g. 214716433790140416"
                value={userId}
                onChange={(e) => setUserId(e.target.value.trim())}
              />
              <button className="btn primary" disabled={busy || userId.length < 5}>
                <ShieldPlus size={16} /> Add
              </button>
            </div>
          </label>
          <p className="muted small">
            In Discord: Settings → Advanced → turn on Developer Mode, then right-click a person → Copy User ID.
          </p>
        </form>
      ) : (
        <p className="muted small">Only the admins set in the server's ADMIN_USER_IDS can add or remove admins.</p>
      )}
    </Modal>
  );
}
