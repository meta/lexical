---
'lexical': patch
---

[fix] Keep the parent of an empty destination when $splitAtPointCaretNext removes it, so ListItemNode orphan repair inside a link does not throw

Verify: editors that register ListNode, ListItemNode and LinkNode without NodeStructureExtension repair a list item nested in a link inside the first list item to `list > listitem > "item"` instead of throwing; direct callers of $splitAtPointCaretNext with removeEmptyDestination: true now keep the removed destination's parent for the next split to remove.
