"""Host-bound scope model and content fingerprints (CONTRACT §6b, §9).

QQ identity/persona/session scope is derived here from normalized host input.
Requests never choose the internal engine key format, and the model cannot
supply a scope — the bridge host does, and the service validates strictly.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass

_ID = re.compile(r"^[1-9][0-9]{4,11}$")
_SESSION_PREFIX = "livingmemory:qq"


class ScopeError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Scope:
    chat_type: str  # group | private
    group_id: str | None
    user_id: str | None

    @property
    def session_key(self) -> str:
        if self.chat_type == "group":
            return f"{_SESSION_PREFIX}:group:{self.group_id}"
        return f"{_SESSION_PREFIX}:private:{self.user_id}"

    @property
    def label(self) -> str:
        """Display label carrying only the host-visible part (masked later)."""
        return f"{'group' if self.chat_type == 'group' else 'private'}:"

    def mask(self) -> str:
        ident = self.group_id or self.user_id or ""
        if len(ident) <= 4:
            return f"{self.chat_type}:****"
        return f"{self.chat_type}:{ident[:2]}****{ident[-2:]}"


def parse_scope(raw: object) -> Scope:
    if not isinstance(raw, dict):
        raise ScopeError("scope must be an object")
    chat_type = str(raw.get("chatType") or "").strip().lower()
    if chat_type == "group":
        group_id = str(raw.get("groupId") or "").strip()
        if not _ID.match(group_id):
            raise ScopeError("groupId must be a 5-12 digit QQ group number")
        return Scope(chat_type=chat_type, group_id=group_id, user_id=None)
    if chat_type == "private":
        user_id = str(raw.get("userId") or "").strip()
        if not _ID.match(user_id):
            raise ScopeError("userId must be a 5-12 digit QQ number")
        return Scope(chat_type=chat_type, group_id=None, user_id=user_id)
    raise ScopeError("chatType must be 'group' or 'private'")


def legacy_scope_to_key(value: str) -> str:
    """Map bridge legacy scope strings (``group:123``/``private:123``) to keys."""
    scope = parse_scope(
        {
            "chatType": value.split(":", 1)[0],
            "groupId": value.split(":", 1)[1] if ":" in value else "",
            "userId": value.split(":", 1)[1] if ":" in value else "",
        }
    )
    return scope.session_key


def normalize_content(text: str) -> str:
    """NFKC → collapse whitespace → casefold (fingerprint input)."""
    folded = unicodedata.normalize("NFKC", text or "").casefold()
    return re.sub(r"\s+", " ", folded).strip()


def content_fingerprint(text: str) -> str:
    return hashlib.sha256(normalize_content(text).encode("utf-8")).hexdigest()


def identity_fingerprint(session_key: str, kind: str, subject: str, text: str) -> str:
    """Scoped forget identity (INTEGRATION_GAPS item 1).

    Raw normalized content is deliberately NOT a global forget key: identical
    preference text from two users must not cross-block. The identity binds
    session scope + memory kind + stable subject (asserted-by person, '' when
    the memory has no personal subject, e.g. a group reflection digest).
    Legacy opaque fingerprints (already encoding kind/subject/scope upstream)
    are imported verbatim and only ever matched exactly — never reinterpreted.
    """
    payload = "\x1f".join(
        (session_key, (kind or "").casefold(), (subject or "").strip(), normalize_content(text))
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def subject_of(metadata: dict, scope: Scope) -> str:
    """Stable subject for forget identity from memory metadata."""
    meta = metadata or {}
    explicit = meta.get("asserted_by") or meta.get("subject")
    if explicit:
        return str(explicit)
    if scope.chat_type == "private":
        return scope.user_id or ""
    return ""


def asserted_identity(metadata: dict, scope: Scope) -> tuple[str, str]:
    """ONE derivation of (kind, subject) shared by every write/edit/forget/
    block path (UI_AUTHORITY item 2: an asserted preference — private or
    group — carries its owner and uses FACT semantics; a group announcement
    or non-asserted observation stays GENERAL with no subject; model-derived
    reflections carry neither)."""
    meta = metadata or {}
    kind = str(meta.get("memory_type") or meta.get("origin") or "")
    if kind == "REFLECTION" or meta.get("origin") == "reflection":
        return "REFLECTION", ""
    subject = subject_of(meta, scope)
    if subject:
        return "FACT", subject
    return kind if kind in ("GENERAL",) else "GENERAL", ""
