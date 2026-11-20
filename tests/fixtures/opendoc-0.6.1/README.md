# OpenDoc 0.6.1 comment code

`comments.ts.txt` and `files.ts.txt` are `src/server/comments.ts` and `src/server/files.ts` of OpenDoc 0.6.1, kept verbatim (hence the `.txt` ending, so they are neither compiled nor checked). `tests/multi-comments.test.ts` runs them to prove that the release already on people's devices keeps `targets` when it rewrites a comments file.

Verified 2026-11-18 against the published package:

```sh
npm pack @ryanyahya/opendoc@0.6.1          # ryanyahya-opendoc-0.6.1.tgz
# integrity: sha512-/VkqQEzJWhtjBOSSgTTrDqcysgSwVY0R+Sh/U+scz3QbCnD3RB6TP8viGkRFXYCpEh7Z6gkx6ZQ6mg7w2gxLHQ==
# shasum:    01ac775287bc1941e93f5f2100691714f0a8e7d9 (matches `npm view @ryanyahya/opendoc@0.6.1 dist.integrity dist.shasum`)
tar -xzf ryanyahya-opendoc-0.6.1.tgz package/src/server/comments.ts package/src/server/files.ts
sha256sum package/src/server/comments.ts package/src/server/files.ts
```

| File | sha256 |
|---|---|
| `comments.ts` | `b553f8596ce9d3f56f29922eaadded3ee60c752392ad6c17a100a3c820c3849a` |
| `files.ts` | `315ce1d1e225f87d54b5ebbc4204d7614766ab165c7041aefcba38e655f65b31` |

Both are also identical to `git show 6bf397d:src/server/comments.ts` and `files.ts`.
