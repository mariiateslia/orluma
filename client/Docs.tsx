import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { FileText, Pencil, Plus, Archive, CircleCheck, Save } from 'lucide-react';
import { api, ApiError, dateLabel } from './api';
import { useApp } from './context';
import { Heading, Empty, Comments, ErrorMessage } from './ui';
import { DocumentDialog } from './forms';
import { ProjectTabs } from './Work';
import type { Document, Project } from './types';

export function DocumentsPage({ project }: { project?: Project }) {
  const { data, canEdit, go } = useApp();
  const [create, setCreate] = useState(false);
  const [query, setQuery] = useState('');
  const docs = data.documents.filter(
    (d) =>
      (!project || d.projectId === project.id) &&
      !data.projects.find((p) => p.id === d.projectId)?.archived &&
      (!query || d.title.toLowerCase().includes(query.toLowerCase())),
  );
  return (
    <>
      <Heading
        muted={project ? 'Project' : 'Shared'}
        title="documents"
        sub="Keep the thinking behind the work close."
        actions={
          canEdit &&
          data.projects.some((p) => !p.archived) &&
          !project?.archived && (
            <button className="button primary" onClick={() => setCreate(true)}>
              <Plus />
              New document
            </button>
          )
        }
      />
      {project && <ProjectTabs project={project} active="docs" />}
      <label className="search-field document-search">
        <span className="sr-only">Search documents</span>
        <input
          type="search"
          placeholder="Search documents"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {docs.length ? (
        docs.map((document) => (
          <div className="work-row" key={document.id}>
            <div className="row-main">
              <span className="emboss-icon small">
                <FileText />
              </span>
              <div>
                <button
                  className="row-title text-button"
                  onClick={() => go(`/w/${data.workspace.id}/documents/${document.id}`)}
                >
                  {document.title}
                </button>
                <div className="row-meta">
                  {data.projects.find((p) => p.id === document.projectId)?.name}
                  <span>Updated {dateLabel(document.updatedAt)}</span>
                </div>
              </div>
            </div>
            <button
              className="button"
              onClick={() => go(`/w/${data.workspace.id}/documents/${document.id}`)}
            >
              Open
            </button>
          </div>
        ))
      ) : (
        <Empty
          title="Give your ideas a home"
          body="Create a brief, meeting note or shared decision for a project."
        />
      )}
      {create && <DocumentDialog projectId={project?.id} onClose={() => setCreate(false)} />}
    </>
  );
}

export function DocumentPage({ document }: { document: Document }) {
  const { data, canEdit, go, refresh, notify, setDirty } = useApp();
  const project = data.projects.find((p) => p.id === document.projectId)!;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(document.title);
  const [body, setBody] = useState(document.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<Document | null>(null);
  const base = useRef({ version: document.version, title: document.title, body: document.body });
  const changed = editing && (title !== base.current.title || body !== base.current.body);
  useEffect(() => {
    setDirty(changed);
    return () => setDirty(false);
  }, [changed, setDirty]);
  useEffect(() => {
    if (!editing) {
      setTitle(document.title);
      setBody(document.body);
      base.current = { version: document.version, title: document.title, body: document.body };
    }
  }, [document.version, document.title, document.body, editing]);
  useEffect(() => {
    if (!changed) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [changed]);
  function begin() {
    base.current = { version: document.version, title: document.title, body: document.body };
    setTitle(document.title);
    setBody(document.body);
    setConflict(null);
    setError(null);
    setEditing(true);
  }
  function cancel() {
    if (changed && !window.confirm('Discard your unsaved document changes?')) return;
    setEditing(false);
    setConflict(null);
    setError(null);
    setDirty(false);
  }
  async function save(asCopy = false) {
    setBusy(true);
    setError(null);
    try {
      if (!title.trim()) throw new Error('Give the document a title.');
      if (asCopy) {
        const response = await api<{ document: Document }>(
          '/projects/' + project.id + '/documents',
          'POST',
          { title: title + ' (draft copy)', body },
        );
        setDirty(false);
        await refresh();
        setEditing(false);
        go(`/w/${data.workspace.id}/documents/${response.document.id}`);
        notify('Your draft was saved as a separate document.');
      } else {
        await api('/documents/' + document.id, 'PATCH', {
          title,
          body,
          version: base.current.version,
        });
        setEditing(false);
        setDirty(false);
        await refresh();
        notify('Document saved.');
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict' && e.details.current)
        setConflict(e.details.current as Document);
      else setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    if (!window.confirm('Archive this document? It will be removed from the active document list.'))
      return;
    try {
      await api('/documents/' + document.id, 'PATCH', {
        version: document.version,
        archived: true,
      });
      await refresh();
      go(`/w/${data.workspace.id}/projects/${project.id}/docs`);
      notify('Document archived.');
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  const author = data.members.find((m) => m.id === document.createdBy);
  return (
    <>
      <Heading
        muted="Project"
        title="document"
        sub={project.name}
        actions={
          canEdit &&
          !project.archived &&
          (!editing ? (
            <>
              <button className="button" onClick={begin}>
                <Pencil />
                Edit document
              </button>
              <button
                className="icon-button"
                onClick={() => {
                  void archive();
                }}
                aria-label="Archive document"
              >
                <Archive />
              </button>
            </>
          ) : (
            <>
              <button className="button" disabled={busy} onClick={cancel}>
                Cancel editing
              </button>
              <button
                className="button primary"
                disabled={busy || !changed}
                onClick={() => {
                  void save();
                }}
              >
                <Save />
                {busy ? 'Saving…' : 'Save document'}
              </button>
            </>
          ))
        }
      />
      <ProjectTabs project={project} active="docs" />
      <article className="document-page">
        <div className="document-motif" aria-hidden="true" />
        {editing ? (
          <label className="field document-title-field">
            <span className="sr-only">Document title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
              disabled={busy}
            />
          </label>
        ) : (
          <h2>{document.title}</h2>
        )}
        <p className="metadata">
          Created by {author?.name || 'a former member'} / Updated {dateLabel(document.updatedAt)} /{' '}
          {editing
            ? changed
              ? 'Unsaved changes'
              : 'No unsaved changes'
            : 'Version ' + document.version}
        </p>
        <ErrorMessage error={error} />
        {conflict && (
          <section className="conflict-panel" role="alert">
            <h3>A teammate saved a newer version.</h3>
            <p>Your draft is still here. Compare it with the latest version before continuing.</p>
            <details>
              <summary>Read the latest version</summary>
              <pre>{conflict.body}</pre>
            </details>
            <div className="form-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  void save(true);
                }}
              >
                Save my draft as a copy
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Replace your draft with the latest version?')) {
                    setTitle(conflict.title);
                    setBody(conflict.body);
                    base.current = {
                      version: conflict.version,
                      title: conflict.title,
                      body: conflict.body,
                    };
                    setConflict(null);
                  }
                }}
              >
                Use latest version
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  base.current = { ...base.current, version: conflict.version };
                  setConflict(null);
                  notify('Review your merged text, then save the document.');
                }}
              >
                I’ve merged the changes
              </button>
            </div>
          </section>
        )}
        {editing ? (
          <div className="field editor-field">
            <label htmlFor="document-content">Document content</label>
            <textarea
              id="document-content"
              aria-describedby="document-content-hint"
              className="markdown-editor"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={200000}
              disabled={busy}
              spellCheck
              rows={20}
            />
            <small id="document-content-hint">
              Markdown supports headings, lists and links. Changes are saved when you choose Save
              document.
            </small>
          </div>
        ) : (
          <div className="markdown-body">
            <Markdown
              components={{
                img: ({ alt }) => <span className="muted">[Image: {alt || 'attachment'}]</span>,
              }}
            >
              {document.body || '_This document is ready for your first thought._'}
            </Markdown>
          </div>
        )}
        <section className="related-section">
          <h3>Project context</h3>
          <button
            className="context-link"
            onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/tasks`)}
          >
            <CircleCheckIcon />
            Project tasks
          </button>
          <button
            className="context-link"
            onClick={() => go(`/w/${data.workspace.id}/projects/${project.id}/budget`)}
          >
            Project budget
          </button>
        </section>
      </article>
      <Comments type="document" id={document.id} />
    </>
  );
}
function CircleCheckIcon() {
  return <CircleCheck aria-hidden="true" />;
}
