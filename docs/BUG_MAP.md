# TOX INTL Platform Stabilization — Bug Map

Investigation notes and fix documentation for the target bugs, plus one environment-level blocker encountered during setup.

---

## Environment Blocker: MongoDB Connectivity (Not an Application Bug)

**Status:** Resolved at the environment level. No application code changed to arrive at this conclusion.

### Symptom
The API container failed to start, repeatedly throwing:
while attempting to connect to `mongodb://mongo:27017/tox_documents`.

### Investigation
1. Confirmed MongoDB was healthy internally — `mongosh --eval "db.runCommand({ping:1})"` returned `{ok: 1}`.
2. Confirmed Docker DNS resolved the `mongo` hostname correctly to its container IP from other containers.
3. Confirmed a direct TCP connection to MongoDB's raw IP (bypassing DNS entirely) also timed out — ruling out DNS as the cause.
4. Confirmed MongoDB was configured with `--bind_ip_all`, ruling out a localhost-only bind.
5. Confirmed the failure was reproducible from multiple containers (worker, task-gateway, api), ruling out an API/Mongoose-specific defect.
6. Inspected the Docker bridge network — all services were correctly attached to the same subnet.
7. Checked the `iptables` (nftables) `FORWARD` chain — showed `ACCEPT`, which was misleading.
8. Checked `iptables-legacy` — the table Docker's rules actually populate in this environment — and found `FORWARD` policy set to `DROP`, with hundreds of packets already dropped, and no explicit `ACCEPT` rule for the project's custom bridge network (only the default `docker0` bridge had one).

### Root Cause
GitHub Codespaces runs Docker in a nested environment with two coexisting `iptables` backends (nftables and legacy). Docker's actual forwarding rules live in the legacy table, whose `FORWARD` chain policy was `DROP`. This silently dropped all container-to-container TCP traffic outside the default bridge, while leaving DNS resolution and same-container operations unaffected.

### Fix
```bash
sudo iptables-legacy -P FORWARD ACCEPT
```
A host/OS-level networking change, not a code or repository change. Not persistent across Codespace rebuilds.

### Why This Isn't Counted as a Target Bug
No application code, MongoDB connection logic, or Compose configuration required modification to resolve this. It is purely a limitation of the nested-container dev environment.

---

## Bug 1: Cross-Tenant Document Access (Insecure Direct Object Reference)

**Severity:** High — direct data leak between organisations.
**File:** `services/api/src/routes/documents.ts`

### Description
`GET /api/documents/:id` fetched a document using only its ID:
```ts
const item = await DocumentRecord.findById(req.params.id)
```
It never verified that the requesting user's organisation matched the document's `organisationId`. Any authenticated user could retrieve any other organisation's document by ID. The other two document routes (`GET /` and `POST /:id/retry`) already scoped their queries by `organisationId` — this route was the sole exception.

### Reproduction
1. Uploaded a document as `alice` (org: Northwind), captured its `_id`.
2. Requested that same `_id` with header `x-demo-user: bob` (org: Contoso).
3. **Result:** API returned Alice's full document to Bob with `200 OK`.

### Fix
```ts
const item = await DocumentRecord.findOne({
  _id: req.params.id,
  organisationId: req.demoUser.organisationId
})
```

### Verification
- Backend (curl): bob's request for Alice's ID now returns `404 Document not found`; alice can still retrieve her own document normally.
- Frontend (UI): confirmed via browser — switching from alice to bob on the same document URL now shows a not-found error with no leaked content (fixed alongside a related stale-state bug in `DocumentDetail.tsx`, where the previous document remained rendered underneath the error banner).

---

## Bug 2: Duplicate Document/Job Creation on Repeated Upload

**Severity:** Medium — wasted processing resources, duplicate records, duplicate downstream jobs.
**File:** `services/api/src/routes/documents.ts`

### Description
Every upload computed an `uploadFingerprint` (SHA-256 of `organisationId + fileName + content`), stored on the record, but no code checked for an existing matching record before creating a new one. Identical content uploaded repeatedly created a new document and job every time.

### Reproduction
1. Submitted identical content three times.
2. Each request returned a different `_id`, all sharing the same `uploadFingerprint`.
3. MongoDB confirmed three separate document records for one logical upload.

### Fix
```ts
const existing = await DocumentRecord.findOne({
  organisationId: req.demoUser.organisationId,
  uploadFingerprint
});

if (existing) {
  res.status(200).json({ item: existing.toObject() });
  return;
}
```

### Verification
- Backend (curl): re-submitting identical content returns the original record (`200`, same `_id`); document count in MongoDB does not increase.
- Frontend (UI): confirmed — re-uploading identical content produces no new entry in the document list; Network tab confirmed the response returns the original document's `_id`, not a new one.

---

## Bug 3: Worker Race Condition on Document Retry

**Severity:** High — silent data corruption; inconsistent state.
**File:** `services/worker/app/tasks.py`

### Description
Worker status/result writes were filtered only by document `_id`, with no awareness of which `attempt` they belonged to:
```python
records.update_one({"_id": object_id}, {"$set": {...}})
```
A stale, slower attempt finishing after a newer retry attempt has already completed would silently overwrite the newer, correct result.

### Reproduction
1. Uploaded a document; attempt 1 began processing (~8s mock delay).
2. Triggered `/retry` mid-flight, incrementing `attempt` to 2 and queuing a faster (~2s) second task.
3. Attempt 2 completed first, correctly wrote `status: completed`.
4. Attempt 1 completed afterward and overwrote the record.
5. **Result:** final document showed `attempt: 2` alongside attempt 1's stale result — an internally inconsistent state.

### Fix
```python
records.update_one({"_id": object_id, "attempt": attempt}, {"$set": {...}})
```
Applied to all three write paths (`processing`, `completed`, `failed`). This is an optimistic-concurrency guard: a stale attempt's write now matches zero documents once the record has moved to a newer attempt, and is silently discarded instead of corrupting state.

### Verification
- Backend: bug reproduced live pre-fix (confirmed inconsistent `attempt`/summary mismatch); fix applied to all three write paths.
- Backend (post-fix live race re-test): confirmed — final document state showed consistent `attempt: 2` with matching `(attempt 2)` summary text, no stale overwrite.

---

## Summary

| Item | Type | Status | Fix Location |
|---|---|---|---|
| MongoDB connectivity | Environment blocker | Resolved (OS-level, no code change) | N/A |
| Cross-tenant document access | Application bug (IDOR) | Fixed | `services/api/src/routes/documents.ts` |
| Duplicate document/job creation | Application bug | Fixed | `services/api/src/routes/documents.ts` |
| Worker race condition on retry | Application bug (concurrency) | Fixed | `services/worker/app/tasks.py` |

## Note on Tooling

Primary background is Python; less fluent in the Node/Express/Mongoose and Next.js portions of this stack. Used AI assistance (Claude) to help interpret error messages and stack traces, confirm correct syntax for TypeScript/Mongoose queries and Celery task patterns, and reason through the Docker networking failure above. All findings were independently reproduced and verified against the running application (via `curl`, `mongosh`, and Docker logs, plus browser UI testing) before any fix was applied.
