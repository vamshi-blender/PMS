import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Archive03Icon,
  Cancel01Icon,
  Delete02Icon,
  Edit03Icon,
  Moon02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  SaveIcon,
  Search01Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { applyTheme, getSavedTheme, type Theme } from "../theme";
import { getBackendUrl, saveBackendUrl } from "../api/backend";
import "./Sidebar.css";
import { PMS_ENVIRONMENTS, type PmsEnvironment } from "../api/pmsEnvironment";
import EnvironmentOptions from "./EnvironmentOptions";

const TRANSITION_MS = 220;

export interface SidebarChat {
  id: string;
  title: string;
  titlePending: boolean;
  pinned: boolean;
}

interface SidebarProps {
  open: boolean;
  environmentMenuOpen: boolean;
  onEnvironmentMenuOpenChange: (open: boolean) => void;
  // Real name from the PMS session; empty while it loads.
  userName: string;
  environment: PmsEnvironment;
  onEnvironmentChange: (environment: PmsEnvironment) => void;
  chats: SidebarChat[];
  activeChatId: string | null;
  busy: boolean;
  onClose: () => void;
  onSearchChats: (query: string) => string[];
  onNewChat: () => void;
  onSelectChat: (chatId: string) => void;
  onRenameChat: (chatId: string, title: string) => void;
  onTogglePinChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => Promise<boolean>;
}

export default function Sidebar({
  open,
  environmentMenuOpen,
  onEnvironmentMenuOpenChange: setEnvironmentMenuOpen,
  userName,
  environment,
  onEnvironmentChange,
  chats,
  activeChatId,
  busy,
  onClose,
  onSearchChats,
  onNewChat,
  onSelectChat,
  onRenameChat,
  onTogglePinChat,
  onDeleteChat,
}: SidebarProps) {
  const [mounted, setMounted] = useState(open);
  const environmentMenuRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteErrorFor, setDeleteErrorFor] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme | null>(null);
  const [searchValue, setSearchValue] = useState("");
  // null = no search ran yet (empty query); otherwise ranked chat ids.
  const [searchResultIds, setSearchResultIds] = useState<string[] | null>(null);
  const [appVersion] = useState(() => chrome.runtime.getManifest().version);
  const [backendUrl, setBackendUrl] = useState("");
  const [backendDraft, setBackendDraft] = useState("");
  const [backendHint, setBackendHint] = useState("");
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!environmentMenuOpen) return;
    function dismiss(event: PointerEvent) {
      if (!environmentMenuRef.current?.contains(event.target as Node)) setEnvironmentMenuOpen(false);
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); setEnvironmentMenuOpen(false); }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [environmentMenuOpen, setEnvironmentMenuOpen]);

  useEffect(() => {
    if (!open || !visible || !environmentMenuOpen) return;
    environmentMenuRef.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, [open, visible, environmentMenuOpen]);

  useEffect(() => {
    getSavedTheme().then(setTheme);
    getBackendUrl().then((url) => {
      setBackendUrl(url);
      setBackendDraft(url);
    });
  }, []);

  async function onToggleTheme() {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    applyTheme(next);
    await chrome.storage.sync.set({ theme: next });
  }

  async function onSaveBackend() {
    setBackendHint("");
    try {
      const saved = await saveBackendUrl(backendDraft);
      setBackendUrl(saved);
      setBackendDraft(saved);
      setBackendHint("Backend saved.");
    } catch (error) {
      setBackendHint(error instanceof Error ? error.message : "Could not save backend.");
    }
  }

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true);
      return;
    }

    setVisible(false);
    setEnvironmentMenuOpen(false);
    setMenuOpenFor(null);
    setRenamingId(null);
    setSearchValue("");
    setSearchResultIds(null);
    const timeout = setTimeout(() => setMounted(false), TRANSITION_MS);
    return () => clearTimeout(timeout);
  }, [open, setEnvironmentMenuOpen]);

  // Debounced search-as-you-type.
  useEffect(() => {
    const query = searchValue.trim();
    if (!query) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchResultIds(null);
      return;
    }

    const timeout = setTimeout(() => setSearchResultIds(onSearchChats(query)), 250);
    return () => clearTimeout(timeout);
  }, [searchValue, onSearchChats]);

  function clearSearch() {
    setSearchValue("");
    setSearchResultIds(null);
  }

  useEffect(() => {
    if (!open || !mounted) return;

    let enterFrame = 0;
    const mountedFrame = requestAnimationFrame(() => {
      enterFrame = requestAnimationFrame(() => setVisible(true));
    });

    return () => {
      cancelAnimationFrame(mountedFrame);
      cancelAnimationFrame(enterFrame);
    };
  }, [mounted, open]);

  useEffect(() => {
    if (!open) return;

    function handleGlobalKeyDown(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target;
      const isEditable =
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');

      if (event.key === "Escape") {
        if (!isEditable) {
          event.preventDefault();
          onClose();
        }
        return;
      }

      if (
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        Array.from(event.key).length !== 1 ||
        isEditable
      ) {
        return;
      }

      const input = searchInputRef.current;
      if (!input || input.disabled) return;

      event.preventDefault();
      const selectionStart = input.selectionStart ?? input.value.length;
      const selectionEnd = input.selectionEnd ?? input.value.length;
      input.setRangeText(event.key, selectionStart, selectionEnd, "end");
      setSearchValue(input.value);
      input.focus();
    }

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!menuOpenFor) return;

    function handlePointerDown(event: PointerEvent) {
      if (!menuAnchorRef.current?.contains(event.target as Node)) {
        setMenuOpenFor(null);
        setDeleteErrorFor(null);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpenFor]);

  function startRename(chat: SidebarChat) {
    setRenameValue(chat.title);
    setRenamingId(chat.id);
    setMenuOpenFor(null);
  }

  function commitRename(chatId: string, cancelled = false) {
    if (cancelled) return;
    const title = renameValue.trim();
    if (title) onRenameChat(chatId, title);
    setRenamingId(null);
  }

  async function deleteChat(chat: SidebarChat) {
    setDeletingId(chat.id);
    setDeleteErrorFor(null);
    const deleted = await onDeleteChat(chat.id);
    setDeletingId(null);

    if (deleted) {
      setMenuOpenFor(null);
    } else {
      setDeleteErrorFor(chat.id);
    }
  }

  function renderChatList(sectionChats: SidebarChat[]) {
    return (
      <ul className="sidebar-chat-list">
        {sectionChats.map((chat) => {
          const active = chat.id === activeChatId;
          const renaming = chat.id === renamingId;

          return (
            <li
              key={chat.id}
              className={`sidebar-chat-item${
                active ? " sidebar-chat-item--active" : ""
              }`}
            >
              {renaming ? (
                <input
                  className="sidebar-chat-rename-input"
                  value={renameValue}
                  maxLength={56}
                  autoFocus
                  aria-label={`Rename ${chat.title}`}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={(event) => {
                    commitRename(chat.id, event.currentTarget.dataset.cancelled === "true");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename(chat.id);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.currentTarget.dataset.cancelled = "true";
                      setRenamingId(null);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="sidebar-chat-link"
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    onSelectChat(chat.id);
                    onClose();
                  }}
                >
                  {chat.titlePending ? (
                    <span
                      className="sidebar-chat-title-loading"
                      role="status"
                      aria-label="Generating conversation title"
                    >
                      <span className="sidebar-chat-title-spinner" aria-hidden="true" />
                      <span>Generating title</span>
                    </span>
                  ) : (
                    <span className="sidebar-chat-title">{chat.title}</span>
                  )}
                </button>
              )}
              {!chat.titlePending && (
                <div
                  className="sidebar-chat-menu-anchor"
                  ref={menuOpenFor === chat.id ? menuAnchorRef : undefined}
                >
                  <button
                    type="button"
                    className="sidebar-chat-menu-btn"
                    aria-label={`Open conversation options for ${chat.title}`}
                    aria-expanded={menuOpenFor === chat.id}
                    onClick={() => {
                      setDeleteErrorFor(null);
                      setMenuOpenFor((current) =>
                        current === chat.id ? null : chat.id,
                      );
                    }}
                  >
                    <HugeiconsIcon icon={MoreHorizontalIcon} size={18} />
                  </button>
                  {menuOpenFor === chat.id && (
                    <div className="sidebar-chat-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="sidebar-chat-menu-item"
                      onClick={() => startRename(chat)}
                    >
                      <HugeiconsIcon icon={Edit03Icon} size={18} />
                      <span>Rename</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="sidebar-chat-menu-item"
                      onClick={() => {
                        onTogglePinChat(chat.id);
                        setMenuOpenFor(null);
                      }}
                    >
                      <HugeiconsIcon icon={chat.pinned ? PinOffIcon : PinIcon} size={18} />
                      <span>{chat.pinned ? "Unpin" : "Pin"}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="sidebar-chat-menu-item"
                      disabled
                      title="Archive will be available later"
                    >
                      <HugeiconsIcon icon={Archive03Icon} size={18} />
                      <span>Archive</span>
                      <span className="sidebar-coming-soon">Later</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="sidebar-chat-menu-item sidebar-chat-menu-item--danger"
                      disabled={deletingId === chat.id || (busy && active)}
                      title={busy && active ? "Stop the response before deleting" : undefined}
                      onClick={() => void deleteChat(chat)}
                    >
                      <HugeiconsIcon icon={Delete02Icon} size={18} />
                      <span>{deletingId === chat.id ? "Deleting…" : "Delete"}</span>
                    </button>
                    {deleteErrorFor === chat.id && (
                      <p className="sidebar-chat-menu-error" role="alert">
                        Could not delete this chat. Try again.
                      </p>
                    )}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  if (!mounted) return null;

  const pinnedChats = chats.filter((chat) => chat.pinned);
  const recentChats = chats.filter((chat) => !chat.pinned);
  const searching = searchValue.trim().length > 0;
  const searchResults = (searchResultIds ?? [])
    .map((id) => chats.find((chat) => chat.id === id))
    .filter((chat): chat is SidebarChat => chat !== undefined);

  return (
    <>
      <div
        className={`sidebar-backdrop ${visible ? "sidebar-backdrop--visible" : ""}`}
        onClick={onClose}
      />
      <aside
        className={`sidebar-panel ${visible ? "sidebar-panel--visible" : ""}`}
        aria-label="Conversation history"
      >
        <div className="sidebar-header">
          <span className="sidebar-brand">
            <img
              src="/icons/Full-logo.svg"
              alt="Donna"
              className="sidebar-brand-icon"
            />
          </span>
          <button
            type="button"
            className="sidebar-icon-btn"
            onClick={onClose}
            aria-label="Close sidebar"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={20} />
          </button>
        </div>

        <nav className="sidebar-primary-nav">
          <button
            type="button"
            className={`sidebar-nav-row${
              activeChatId === null ? " sidebar-nav-row--active" : ""
            }`}
            aria-current={activeChatId === null ? "page" : undefined}
            onClick={() => {
              onNewChat();
              onClose();
            }}
          >
            <HugeiconsIcon icon={PencilEdit02Icon} size={18} />
            <span>New chat</span>
          </button>
          <div className="sidebar-search-row">
            <HugeiconsIcon icon={Search01Icon} size={18} />
            <input
              ref={searchInputRef}
              className="sidebar-search-input"
              value={searchValue}
              placeholder="Search"
              aria-label="Search chats"
              spellCheck={false}
              onChange={(event) => setSearchValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  clearSearch();
                  event.currentTarget.blur();
                }
              }}
            />
            {searchValue.length > 0 && (
              <button
                type="button"
                className="sidebar-search-clear"
                aria-label="Clear search"
                onClick={clearSearch}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={14} />
              </button>
            )}
          </div>
        </nav>

        <div className="sidebar-history">
          {searching ? (
            <section className="sidebar-history-section" aria-labelledby="results-heading">
              <h2 className="sidebar-section-heading" id="results-heading">
                Results
              </h2>
              {searchResultIds === null ? null : searchResults.length > 0 ? (
                renderChatList(searchResults)
              ) : (
                <p className="sidebar-empty-state">No chats match your search.</p>
              )}
            </section>
          ) : chats.length === 0 ? (
            <>
              <h2 className="sidebar-section-heading">Recents</h2>
              <p className="sidebar-empty-state">Your conversations will appear here.</p>
            </>
          ) : (
            <>
              {pinnedChats.length > 0 && (
                <section className="sidebar-history-section" aria-labelledby="pinned-heading">
                  <h2 className="sidebar-section-heading" id="pinned-heading">
                    Pinned
                  </h2>
                  {renderChatList(pinnedChats)}
                </section>
              )}
              {recentChats.length > 0 && (
                <section className="sidebar-history-section" aria-labelledby="recents-heading">
                  <h2 className="sidebar-section-heading" id="recents-heading">
                    Recents
                  </h2>
                  {renderChatList(recentChats)}
                </section>
              )}
            </>
          )}
        </div>

        <div className="sidebar-backend-row">
          <label className="backend-url-label" htmlFor="sidebar-backend-url">
            Donna backend URL
          </label>
          <div className="backend-url-row">
            <input
              id="sidebar-backend-url"
              type="url"
              value={backendDraft}
              onChange={(event) => setBackendDraft(event.target.value)}
              placeholder="https://worklogs-wheat.vercel.app"
              spellCheck={false}
            />
            <button
              type="button"
              className="backend-url-save-btn"
              onClick={onSaveBackend}
              disabled={!backendDraft.trim() || backendDraft === backendUrl}
              aria-label="Save backend URL"
            >
              <HugeiconsIcon icon={SaveIcon} size={16} />
            </button>
          </div>
          {backendHint && <p className="hint">{backendHint}</p>}
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-profile" ref={environmentMenuRef}>
            {environmentMenuOpen && (
              <div className="sidebar-environment-menu">
                <EnvironmentOptions environment={environment} onChange={next => {
                  setEnvironmentMenuOpen(false);
                  if (next !== environment) onEnvironmentChange(next);
                }} />
              </div>
            )}
            <button
              type="button"
              className="sidebar-user-row"
              aria-expanded={environmentMenuOpen}
              aria-label={`Profile and PMS environment: ${PMS_ENVIRONMENTS[environment].label}`}
              onClick={() => setEnvironmentMenuOpen(!environmentMenuOpen)}
            >
              <span className="sidebar-user-avatar" aria-hidden="true">
                {userName.charAt(0)}
              </span>
              <span className="sidebar-user-info">
                <span className="sidebar-user-name">{userName || "PMS profile"}</span>
                <span className="sidebar-user-plan">
                  {PMS_ENVIRONMENTS[environment].label}
                  <span aria-hidden="true"> · </span>
                  <span className="sidebar-user-version">v{appVersion}</span>
                </span>
              </span>
            </button>
          </div>

          <button
            type="button"
            className="theme-toggle-btn"
            aria-pressed={theme === "light"}
            onClick={onToggleTheme}
            aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
          >
            <HugeiconsIcon icon={theme === "light" ? Moon02Icon : Sun03Icon} size={18} />
          </button>
        </div>
      </aside>
    </>
  );
}
