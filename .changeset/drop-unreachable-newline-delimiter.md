---
'@nanocollective/nanotune': patch
---

Semantic match mode no longer carries a newline delimiter check that could never run: the response is whitespace-normalized first, so a newline after the expected answer is already matched as a space. No change in which answers pass; tests now pin newline, CRLF, tab and blank-line delimiters. Closes #141.
