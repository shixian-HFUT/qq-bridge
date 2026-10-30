"""IDENTITY_INJECTION acceptance at the formatting boundary (pure functions,
no disk, no network): owner/kind/revision/assertion survive into results and
the injection block keeps two same-text owners separately labelled."""

from __future__ import annotations

from sidecar.engine import build_injection_block, format_recall_entry
from sidecar.scopes import Scope

GROUP = Scope(chat_type="group", group_id="100000004", user_id=None)


def meta(kind, subject, content_extra=None, **over):
    m = {"session_id": GROUP.session_key, "memory_type": kind, "origin": "imported",
         "asserted_by": subject, "assertion": "asserted", "revision": 3}
    m.update(content_extra or {})
    m.update(over)
    return m


def test_two_owners_same_text_keep_distinct_identity():
    a = format_recall_entry(GROUP, meta("FACT", "12345"), "喜欢红色", 11, 0.9)
    b = format_recall_entry(GROUP, meta("FACT", "67890"), "喜欢红色", 12, 0.8)
    assert a["subject"] == "12345" and b["subject"] == "67890"
    assert a["kind"] == "FACT" and a["revision"] == 3
    assert a["asserted"] is True
    block, truncated = build_injection_block([a, b], 1600)
    assert "[FACT:12345|asserted] 喜欢红色" in block
    assert "[FACT:67890|asserted] 喜欢红色" in block
    assert not truncated


def test_missing_assertion_never_defaults_to_asserted():
    bare = format_recall_entry(GROUP, {"session_id": GROUP.session_key,
                                       "memory_type": "GENERAL", "origin": "imported"},
                               "群公告提到周五上线", 13, 0.5)
    assert bare["asserted"] is False and bare["assertion"] == "unverified"


def test_reflection_labelled_inferred():
    refl = format_recall_entry(GROUP, {"session_id": GROUP.session_key, "origin": "reflection"},
                               "近期多次提到加班", 14, 0.4)
    assert refl["assertion"] == "inferred" and refl["asserted"] is False
    block, _ = build_injection_block([refl], 1600)
    assert "|inferred]" in block


def test_injection_respects_char_cap_and_truncation_flag():
    entries = [format_recall_entry(GROUP, meta("FACT", str(100000 + i)), "内容" * 40, 20 + i, 0.5)
               for i in range(20)]
    block, truncated = build_injection_block(entries, 200)
    assert truncated is True
    assert len(block) <= 200
