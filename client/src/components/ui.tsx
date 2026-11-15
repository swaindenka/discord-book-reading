import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Crown, Shield, ShieldCheck, Upload, X } from 'lucide-react';
import type { MemberRole } from '../../../shared/types';
import { ACCEPTED_EXTENSIONS } from '../../../shared/types';
import { ConversionError, KINDLE_EXTENSIONS, convertKindleToEpub, isKindleFile } from '../convert/kindle';
import { colorFor, cx, formatBytes, initials } from '../util';

export function Avatar({
  id,
  name,
  url,
  size = 32,
  online,
}: {
  id: string;
  name: string;
  url: string | null;
  size?: number;
  online?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {url && !failed ? (
        <img src={url} alt="" width={size} height={size} onError={() => setFailed(true)} referrerPolicy="no-referrer" />
      ) : (
        <span className="avatar-fallback" style={{ background: colorFor(id) }} aria-hidden>
          {initials(name)}
        </span>
      )}
      {online !== undefined && <span className={cx('presence-dot', online ? 'on' : 'off')} />}
    </span>
  );
}

export function RoleBadge({ role }: { role: MemberRole }) {
  if (role === 'member') return null;
  const info = {
    owner: { Icon: Crown, label: 'Owner' },
    admin: { Icon: ShieldCheck, label: 'Admin' },
    mod: { Icon: Shield, label: 'Moderator' },
  }[role];
  return (
    <span className={`role-badge role-${role}`} title={info.label}>
      <info.Icon size={12} aria-hidden />
      <span className="sr-only">{info.label}</span>
    </span>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, textarea, button:not(.modal-close)')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'modal-wide')} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn ghost modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function FileDrop({
  file,
  onFile,
  maxMb,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  maxMb: number;
}) {
  const [dragging, setDragging] = useState(false);
  const [converting, setConverting] = useState<{ name: string; progress: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Kindle books are turned into EPUBs right here, before anything is uploaded.
  const choose = async (picked: File | null) => {
    setProblem(null);
    if (!picked || !isKindleFile(picked.name)) {
      onFile(picked);
      return;
    }
    if (converting) return;
    setConverting({ name: picked.name, progress: 0 });
    try {
      const epub = await convertKindleToEpub(picked, (progress) => setConverting({ name: picked.name, progress }));
      onFile(epub);
    } catch (err) {
      console.warn(err);
      setProblem(err instanceof ConversionError ? err.message : "This Kindle book couldn't be converted. Try an EPUB or PDF copy.");
    } finally {
      setConverting(null);
    }
  };

  return (
    <div
      className={cx('file-drop', dragging && 'dragging', file && 'has-file', converting && 'busy')}
      aria-busy={Boolean(converting)}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const dropped = e.dataTransfer.files[0];
        if (dropped) void choose(dropped);
      }}
      onClick={() => !converting && input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
    >
      <input
        ref={input}
        type="file"
        hidden
        accept={[...ACCEPTED_EXTENSIONS, ...KINDLE_EXTENSIONS].join(',')}
        onChange={(e) => {
          void choose(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
      <Upload size={22} aria-hidden />
      {converting ? (
        <div>
          <strong>{converting.name}</strong>
          <div className="muted small">Converting the Kindle book to EPUB… {Math.round(converting.progress * 100)}%</div>
        </div>
      ) : file ? (
        <div>
          <strong>{file.name}</strong>
          <div className="muted small">{formatBytes(file.size)} · click to change</div>
          {problem && <div className="small error-text">{problem}</div>}
        </div>
      ) : (
        <div>
          <strong>Drop a book here or click to browse</strong>
          <div className="muted small">
            PDF, EPUB, MOBI, AZW3, TXT, Markdown or CBZ · up to {maxMb} MB
          </div>
          {problem && <div className="small error-text">{problem}</div>}
        </div>
      )}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={cx('toggle-row', disabled && 'disabled')}>
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="muted small block">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
    </label>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap">
      <span className="spinner" aria-hidden />
      {label && <span className="muted">{label}</span>}
    </div>
  );
}

/** A small dropdown menu anchored to its trigger. */
export function Menu({
  trigger,
  children,
  label,
  align = 'end',
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  label: string;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className="icon-btn ghost"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div className={cx('menu', `menu-${align}`)} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button className={cx('menu-item', danger && 'danger')} role="menuitem" onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  );
}
