import { useCallback, useEffect, useRef, useState } from 'react';
import {
  House,
  CircleCheck,
  Layers2,
  FileText,
  Wallet,
  Users,
  Settings,
  LogOut,
  Wifi,
  WifiOff,
  X,
  Plus,
} from 'lucide-react';
import { api, ApiError, readRoute } from './api';
import type { Route, User, Workspace, WorkspaceData } from './types';
import { AppContext } from './context';
import { Auth, AcceptInvitation } from './Auth';
import { Brand, Avatar, Loading, ErrorMessage, AsyncForm, Field, Dialog } from './ui';
import { WorkspacePages } from './pages';

const navItems = [
  ['home', 'Home', House],
  ['my-work', 'My work', CircleCheck],
  ['projects', 'Projects', Layers2],
  ['docs', 'Docs', FileText],
  ['spending', 'Spending', Wallet],
  ['team', 'Team', Users],
] as const;
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [starting, setStarting] = useState(true);
  const [startupError, setStartupError] = useState<unknown>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [route, setRoute] = useState<Route>(readRoute);
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [dataError, setDataError] = useState<unknown>(null);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>(
    'connecting',
  );
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [workspaceDialog, setWorkspaceDialog] = useState(false);
  const dirty = useRef(false);
  const lastHash = useRef(window.location.hash);
  const refreshSequence = useRef(0);
  const notify = useCallback((message: string, error = false) => setToast({ message, error }), []);
  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const go = useCallback((path: string) => {
    if (dirty.current && !window.confirm('You have unsaved changes. Leave without saving?')) return;
    dirty.current = false;
    window.location.hash = path;
  }, []);
  useEffect(() => {
    function changed() {
      if (dirty.current && !window.confirm('You have unsaved changes. Leave without saving?')) {
        window.history.replaceState(null, '', lastHash.current || '#');
        return;
      }
      dirty.current = false;
      lastHash.current = window.location.hash;
      setRoute(readRoute());
    }
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    const expired = () => {
      setUser(null);
      setData(null);
      setWorkspaces([]);
      notify('Your session expired. Please sign in again.', true);
    };
    window.addEventListener('orluma:session-expired', expired);
    return () => window.removeEventListener('orluma:session-expired', expired);
  }, [notify]);
  useEffect(() => {
    if (!toast || toast.error) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const refreshWorkspaces = useCallback(async () => {
    const response = await api<{ workspaces: Workspace[] }>('/workspaces');
    setWorkspaces(response.workspaces);
    return response.workspaces;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<{ user: User | null }>('/auth/me', 'GET', undefined, controller.signal)
      .then(async (response) => {
        setUser(response.user);
        if (response.user) await refreshWorkspaces();
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setStartupError(e);
      })
      .finally(() => setStarting(false));
    return () => controller.abort();
  }, [refreshWorkspaces]);
  useEffect(() => {
    if (!user || route.section === 'invite' || !workspaces.length) return;
    const selected = workspaces.find((w) => w.id === route.workspaceId);
    if (!selected) {
      const saved = localStorage.getItem('orluma.workspace');
      const workspace = workspaces.find((w) => w.id === saved) || workspaces[0];
      go(`/w/${workspace.id}/home`);
    } else localStorage.setItem('orluma.workspace', selected.id);
  }, [user, workspaces, route.workspaceId, route.section, go]);
  const workspaceId =
    route.workspaceId && workspaces.some((w) => w.id === route.workspaceId)
      ? route.workspaceId
      : null;
  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const sequence = ++refreshSequence.current;
    try {
      const response = await api<WorkspaceData>(`/workspaces/${workspaceId}/data`);
      if (sequence === refreshSequence.current) {
        setData(response);
        setDataError(null);
      }
    } catch (e) {
      if (sequence !== refreshSequence.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setUser(null);
        setData(null);
      } else if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        setData(null);
        await refreshWorkspaces();
        notify('Your workspace access changed.', true);
      } else setDataError(e);
      throw e;
    }
  }, [workspaceId, refreshWorkspaces, notify]);
  useEffect(() => {
    if (!user || !workspaceId) return;
    let active = true;
    setData(null);
    setDataError(null);
    setConnection('connecting');
    void refresh().catch(() => {});
    const stream = new EventSource(`/api/workspaces/${workspaceId}/events`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    stream.addEventListener('ready', () => {
      if (active) setConnection('live');
    });
    stream.addEventListener('update', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (active) void refresh().catch(() => {});
      }, 80);
    });
    stream.onerror = () => {
      if (active) setConnection('reconnecting');
    };
    const focus = () => {
      if (active) void refresh().catch(() => {});
    };
    window.addEventListener('focus', focus);
    const poll = setInterval(() => {
      if (active && !document.hidden) void refresh().catch(() => {});
    }, 20000);
    return () => {
      active = false;
      refreshSequence.current++;
      clearTimeout(timer);
      clearInterval(poll);
      stream.close();
      window.removeEventListener('focus', focus);
    };
  }, [workspaceId, user?.id, refresh]);
  async function logout() {
    if (dirty.current && !window.confirm('Leave without saving your draft?')) return;
    await api('/auth/logout', 'POST', {});
    dirty.current = false;
    setUser(null);
    setData(null);
    setWorkspaces([]);
    if (route.section !== 'invite') go('/');
  }
  async function signedIn(value: User, joined?: string) {
    setUser(value);
    const spaces = await refreshWorkspaces();
    if (joined) go(`/w/${joined}/home`);
    else if (route.section === 'invite' && route.inviteToken) return;
    else if (spaces.length) go(`/w/${spaces[0].id}/home`);
    else go('/');
  }
  async function createWorkspace(form: FormData) {
    const result = await api<{ workspace: Workspace }>('/workspaces', 'POST', {
      name: String(form.get('name')),
      sample: form.get('sample') === 'on',
    });
    await refreshWorkspaces();
    setWorkspaceDialog(false);
    go(`/w/${result.workspace.id}/home`);
  }
  const workspaceForm = (
    <AsyncForm submitLabel="Create workspace" onSubmit={createWorkspace}>
      <Field label="Workspace name">
        <input name="name" required maxLength={100} placeholder="Your team or company" autoFocus />
      </Field>
      <label className="check-field">
        <input type="checkbox" name="sample" defaultChecked />
        <span>
          Start with the sample Website launch project
          <small>
            Fictional tasks, a brief and a $5,000 budget. You can archive it whenever you’re ready.
          </small>
        </span>
      </label>
    </AsyncForm>
  );
  if (starting)
    return (
      <div className="startup">
        <Brand />
        <Loading />
      </div>
    );
  if (startupError)
    return (
      <div className="startup">
        <Brand />
        <ErrorMessage error={startupError} />
        <button className="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!user)
    return (
      <Auth
        inviteToken={route.inviteToken}
        onSignedIn={(u, w) => {
          void signedIn(u, w);
        }}
      />
    );
  if (route.section === 'invite' && route.inviteToken)
    return (
      <AcceptInvitation
        token={route.inviteToken}
        user={user}
        onJoined={async (id) => {
          await refreshWorkspaces();
          go(`/w/${id}/home`);
        }}
        onLogout={() => {
          void logout();
        }}
      />
    );
  if (!workspaces.length)
    return (
      <div className="onboarding">
        <Brand />
        <section className="onboarding-card">
          <h1>
            <span>Make room</span>
            <br />
            for your team.
          </h1>
          <p>One space for the work, the thinking and the spending behind it.</p>
          {workspaceForm}
          <button
            className="text-button muted"
            onClick={() => {
              void logout();
            }}
          >
            Sign out
          </button>
        </section>
      </div>
    );
  if (!workspaceId || !data || data.workspace.id !== workspaceId)
    return (
      <div className="startup">
        <Brand />
        {dataError ? (
          <>
            <ErrorMessage error={dataError} />
            <button
              className="button"
              onClick={() => {
                void refresh().catch(() => {});
              }}
            >
              Try again
            </button>
          </>
        ) : (
          <Loading />
        )}
      </div>
    );
  const admin = ['owner', 'admin'].includes(data.workspace.role);
  const canEdit = data.workspace.role !== 'viewer';
  const context = {
    user,
    data,
    workspaces,
    route,
    admin,
    canEdit,
    go,
    refresh,
    refreshWorkspaces: async () => {
      await refreshWorkspaces();
    },
    notify,
    logout,
    newWorkspace: () => setWorkspaceDialog(true),
    connection,
    setDirty,
  };
  const selectedSection = ['tasks', 'documents', 'requests', 'expenses'].includes(route.section)
    ? 'projects'
    : route.section;
  const pending = data.requests.filter(
    (r) => r.status === 'pending' && r.approverId === user.id,
  ).length;
  return (
    <AppContext.Provider value={context}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      <div className="app-shell">
        <aside className="sidebar">
          <button
            className="brand-button"
            onClick={() => go(`/w/${workspaceId}/home`)}
            aria-label="Orluma home"
          >
            <Brand />
          </button>
          <label className="workspace-select">
            <span className="sr-only">Workspace</span>
            <select
              value={workspaceId}
              onChange={(e) =>
                e.target.value === 'new'
                  ? setWorkspaceDialog(true)
                  : go(`/w/${e.target.value}/home`)
              }
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
              <option value="new">+ New workspace</option>
            </select>
            <span className="metadata">
              {data.members.length} {data.members.length === 1 ? 'person' : 'people'} /{' '}
              {data.workspace.role}
            </span>
          </label>
          <nav className="main-nav" aria-label="Workspace">
            {navItems.map(([path, label, Icon]) => (
              <button
                key={path}
                aria-label={label}
                aria-current={selectedSection === path ? 'page' : undefined}
                onClick={() => go(`/w/${workspaceId}/${path}`)}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
                {path === 'spending' && pending > 0 && <b className="nav-count">{pending}</b>}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button className="text-button" onClick={() => go(`/w/${workspaceId}/settings`)}>
              <Settings aria-hidden="true" />
              <span>Settings</span>
            </button>
            <button
              className="text-button"
              onClick={() => {
                void logout().catch((e) => notify(e.message, true));
              }}
            >
              <LogOut aria-hidden="true" />
              <span>Sign out</span>
            </button>
            <a
              href="https://github.com/mariiateslia/orluma"
              target="_blank"
              rel="noreferrer"
              className="metadata"
            >
              Open source / v0.1
            </a>
          </div>
        </aside>
        <div className="main-surface">
          <header className="topbar">
            <div className="breadcrumb">
              <button className="text-button" onClick={() => go(`/w/${workspaceId}/home`)}>
                {data.workspace.name}
              </button>
              <span>/</span>
              <span>{data.workspace.isSample ? 'Sample workspace' : 'Team workspace'}</span>
            </div>
            <div className="topbar-right">
              <span className={'connection ' + connection} role="status">
                {connection === 'live' ? (
                  <Wifi aria-hidden="true" />
                ) : (
                  <WifiOff aria-hidden="true" />
                )}
                <span>
                  {connection === 'live'
                    ? 'Synced'
                    : connection === 'connecting'
                      ? 'Connecting'
                      : 'Reconnecting'}
                </span>
              </span>
              <button
                className="avatar-button"
                onClick={() => go(`/w/${workspaceId}/settings`)}
                aria-label={'Account settings for ' + user.name}
              >
                <Avatar name={user.name} dark />
              </button>
            </div>
          </header>
          <main id="main-content" className="main-content" tabIndex={-1}>
            {Boolean(dataError) && (
              <div className="error-banner" role="alert">
                <ErrorMessage error={dataError} />
                <button
                  className="text-button"
                  onClick={() => {
                    void refresh().catch(() => {});
                  }}
                >
                  Retry sync
                </button>
              </div>
            )}
            <WorkspacePages key={workspaceId} />
          </main>
        </div>
      </div>
      {toast && (
        <div
          className={'toast' + (toast.error ? ' toast-error' : '')}
          role={toast.error ? 'alert' : 'status'}
        >
          <span>{toast.message}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X />
          </button>
        </div>
      )}
      {workspaceDialog && (
        <Dialog title="Create a workspace" onClose={() => setWorkspaceDialog(false)}>
          {workspaceForm}
        </Dialog>
      )}
    </AppContext.Provider>
  );
}
