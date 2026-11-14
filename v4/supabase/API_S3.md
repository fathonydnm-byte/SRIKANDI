# API Sprint 3 — Edit/Perubahan, Koreksi & Pembatalan, Karantina

Status: **implemented** in `v4/supabase/migrations/0018_s3_koreksi_foundation.sql`, `0019_s3_edit_batal.sql`, `0020_s3_edit_batal_security.sql`, with tests in `v4/tests/db/s3_edit.test.mjs` and `v4/tests/db/s3_batal.test.mjs`. This file matches the SQL.

Conventions are those of `API_S2.md` §1 (errors `P0001` + `"<CODE>: <pesan>"` + `hint`, authorization, idempotency, data). In short:

- Write RPCs are `SECURITY DEFINER`, resolve the caller first, take the per-unit lock, are idempotent on `p_request_id` (same payload → stored response with `"replayed": true`; other payload or operation → `IDEMPOTENCY_CONFLICT`), and audit.
- `PIMPINAN` gets `FORBIDDEN_ROLE` on every write. Objects of another unit give `NOT_FOUND`. `ADMIN_PUSAT` acts on the object's unit.
- Read RPCs are `SECURITY INVOKER` (RLS applies). `ADMIN_PUSAT` passes `p_unit_id`, else `UNIT_REQUIRED`.
- EXECUTE is granted to `authenticated` only.

New codes in this sprint:

| Code | Meaning |
| --- | --- |
| `NO_CHANGES` | The edit changes nothing ("Tidak ada perubahan yang perlu disimpan."). |
| `OBJECT_BORROWED` | The berkas or item is on loan (same code as S2). |
| `LAST_ITEM_IN_BERKAS` | Cancelling the last active item alone; cancel the whole berkas instead. |
| `ALREADY_CANCELLED` | The berkas or item was already cancelled (by another request). |
| `UPLOAD_SESSION_STATE`, `UPLOAD_FILE_IN_USE`, `FILE_TYPE`, `FILE_TOO_LARGE`, `UPLOAD_ATTESTATION_*` | As in S2 §4. |

## 1. Edit / Perubahan

### `edit_options(p_unit_id uuid default null)` — read · replaces `apiGetEditOptions`

Every active role (PIMPINAN included) may read its own unit.

```json
{ "ok": true, "unit_id",
  "berkas": [{ "id", "number", "title", "classification_code", "classification_description",
               "security_classification", "loan_status", "can_edit", "label",
               "items": [{ "id", "number", "description", "document_date", "page_count", "development_level",
                           "condition", "security_classification", "primary_letter_number", "alternate_letter_number",
                           "file_name", "file_url", "has_file", "file_status", "loan_status", "can_edit", "version", "label" }] }],
  "development_levels": ["ASLI","COPY"],
  "conditions": ["BAIK","RUSAK RINGAN","RUSAK SEDANG","RUSAK BERAT"],
  "security_classifications": ["BIASA/TERBUKA","TERBATAS","RAHASIA","SANGAT RAHASIA"],
  "min_reason_length": 10, "replacement_max_bytes": 104857599 }
```

- Non-deleted berkas ordered by number (drafts last); non-deleted items ordered by number.
- 3.x returned `{berkas, itemsByBerkas}`; v4 nests the items in their berkas, as `media_options` does.
- `development_level` defaults to `ASLI` when empty, as in 3.x.
- `can_edit` is false when the berkas or the item is on loan.

### `item_update(p_request_id uuid, p_item_id text, p_payload jsonb, p_reason text, p_replacement_session_id uuid default null, p_validate_only boolean default false)` — write · replaces `apiUpdateArchiveItem` and `apiFinalizeEditReplacementUpload`

`p_payload` contains the full edit form, with every field sent each time (as the 3.x form):

```json
{ "berkas_id": "BRK-…", "description": "…", "page_count": 1, "document_date": "YYYY-MM-DD",
  "development_level": "ASLI|COPY", "condition": "" | "BAIK|RUSAK RINGAN|RUSAK SEDANG|RUSAK BERAT",
  "security_classification": "BIASA/TERBUKA|TERBATAS|RAHASIA|SANGAT RAHASIA" }
```

Guards, in the 3.x order:

1. `berkas_id` is required (`INVALID_INPUT`).
2. `p_reason` must be at least 10 characters (`INVALID_INPUT`, `detail.field = "p_reason"`).
3. The berkas must not be deleted, and the item must be a non-deleted item of that berkas (`NOT_FOUND`).
4. Neither the berkas nor the item may be on loan (`OBJECT_BORROWED`).
5. Field rules, all `INVALID_INPUT` with `detail.field = "p_payload.<field>"`:
   - `description` is required (≤ 2000 characters);
   - `page_count` is an integer ≥ 1;
   - `document_date` is a valid date;
   - `development_level` is `ASLI` or `COPY`;
   - `condition` is empty or a value of the list;
   - `security_classification` is required and valid. It is never defaulted, with or without a PDF (FIX 3.30.5).
6. If `p_replacement_session_id` is given, it must be an `ITEM_PDF_REPLACE` session of **this caller**, for **this item**, in this unit, `COMMITTED` and not yet consumed. Otherwise `UPLOAD_SESSION_STATE`. Its Drive file must not be bound to anything else (`UPLOAD_FILE_IN_USE`).
7. Nothing changed (metadata equal and no replacement): `NO_CHANGES`.

`p_validate_only = true` runs guards 1–6 without any effect, lock or idempotency row. It returns `{ ok, valid: true, item_id, berkas_id, changed_fields, has_file }`, and in this mode `changed_fields` may be empty. Use it before uploading a replacement PDF; it ports 3.x "invalid input fails before the Drive upload".

Effect, in one transaction under the unit lock:

- `ITEM_ID`, `ARSIP_ID`, the receipt links and the berkas classification never change.
- Item fields: `tanggal_naskah`, `tahun_kurun_waktu`, `uraian_lengkap`, `uraian_nama_file`, `jumlah_halaman`, `tingkat_perkembangan`, `kondisi_fisik` (empty → NULL), `klasifikasi_keamanan_akses`, `status_verifikasi_metadata = TERVERIFIKASI`, `metadata_schema_version = 4`, `version + 1`.
- **Replacement** (when the session is given):
  - The item gets the new `drive_file_id`, url, size, md5, `nama_file` (= the session's `drive_name`) and `status_file = TERSEDIA`. `drive_file_sha256` is reset. `status_bentuk_digital` becomes `ALIH MEDIA` when it was `TIDAK ADA`. `file_replaced_at` is set.
  - The session is consumed.
  - The **old file is never deleted.** It gets a `karantina` row (module `EDIT_ARSIP`, reason, request id, item and berkas, name, url, size, md5, `app_owned`). From then on it is readable by admins only (§4) and can never be bound to another record.
  - `app.invalidate_file_derivatives` runs. It supersedes pending Drive renames of the old file, and it is the Sprint 6 hook for the content index (§5).
  - Replacing an item that has no PDF yet is allowed, as in 3.x; nothing is quarantined then.
- `app.renumber_unit(…, [berkas], 'Penomoran ulang kronologis setelah perubahan metadata item')` runs: the S2 renumbering (`API_S2.md` §3.1). It covers:
  - the order of items and berkas when dates change, with `riwayat_nomor` rows;
  - the berkas aggregates, dates, retention and `kurun_waktu`;
  - **berkas security = strictest active item**, upwards and downwards;
  - the media summary;
  - rename tasks for app-owned objects whose name changed.
- Audit `UPDATE` / `EDIT_ARSIP` / `ITEM`:
  - `summary` is the 3.x text `Sebelum: tanggal …, n lembar, …, kondisi …, "…" | Sesudah: …`.
  - `reason` is the given reason, plus `| File alih media diganti; versi lama dipindahkan ke karantina.` on a replacement.
  - `before_data` / `after_data` are JSON.

Returns:

```json
{ "ok": true, "request_id", "item_id", "berkas_id", "berkas_number", "item_number",
  "changed_fields": ["description","page_count","document_date","development_level","condition","security_classification","pdf"],
  "file_replaced": bool, "drive_file_id", "old_drive_file_id" | null, "quarantine_id" | null,
  "security_classification", "berkas_security_classification",
  "renumbered_item_count", "renumbered_berkas_count", "drive_tasks": [{ "id","kind","drive_id","new_name" }],
  "warnings": [], "message", "replayed": bool }
```

Not editable, as in 3.x: letter numbers, berkas, classification and retention.

#### PDF replacement flow (port of the 3.x edit replacement upload)

1. `item_update(…, p_validate_only => true)` validates the metadata.
2. `upload_begin(p_request_id, 'ITEM_PDF_REPLACE', item_id, file_name, mime, size)`.
3. The gateway uploads the file and attests it, then calls `upload_commit(...)`.
4. `item_update(new request id, item_id, payload, reason, p_replacement_session_id => session_id)`.

An abandoned committed replacement can be cancelled with `upload_cancel` (the gateway may then trash the file).

### `berkas_update_title(p_request_id uuid, p_berkas_id text, p_title text, p_reason text)` — write · replaces `apiUpdateBerkasTitle` (3.27)

Guards:

- `p_title` is required (≤ 500 characters, whitespace collapsed): `INVALID_INPUT`.
- The reason must be at least 10 characters: `INVALID_INPUT`.
- The berkas must not be deleted: `NOT_FOUND`.
- The berkas must not be on loan: `OBJECT_BORROWED`. As in 3.x, items are not checked.
- A title equal to the current one gives `NO_CHANGES`.

Effect:

- Sets `judul_berkas` and `version + 1`.
- When the berkas has an **app-owned v4 folder** (`v4_drive_folder_id`), queues one `RENAME_FOLDER` task `<no|DRAFT>_<clean title>`. The legacy folder is not touched (see Deviations).
- Audit `UPDATE_TITLE` / `EDIT_ARSIP` / `BERKAS`, summary `Sebelum: "…" | Sesudah: "…"`.

Returns `{ ok, request_id, berkas_id, berkas_number, old_title, title, drive_tasks, warnings, message, replayed }`.

## 2. Koreksi & Pembatalan

### `cancel_options(p_unit_id uuid default null)` — read · replaces `apiGetDeletionOptions`

```json
{ "ok": true, "unit_id",
  "berkas": [{ "id", "number", "title", "item_count", "page_count", "loan_status", "can_cancel", "label",
               "items": [{ "id", "number", "description", "document_date", "page_count", "loan_status", "has_file",
                           "from_receipt", "receipt_number", "is_last_item", "can_cancel", "label" }] }],
  "scopes": ["ITEM","BERKAS"], "confirmation_word": "HAPUS", "min_reason_length": 10,
  "evidence": { "optional": true, "max_bytes": 26214400, "extensions": ["pdf","jpg","jpeg","png"],
                "mime_types": ["application/pdf","image/jpeg","image/png"] } }
```

- `berkas.can_cancel` is false when the berkas or any of its items is on loan.
- `item.can_cancel` is false for the last active item, for an item on loan, and for an item in a berkas on loan.

### `archive_cancel(p_request_id uuid, p_scope text, p_berkas_id text, p_item_id text, p_reason text, p_confirmation text, p_evidence_session_id uuid default null, p_validate_only boolean default false)` — write · replaces `apiDeleteArchive` and `apiFinalizeDeletionEvidenceUpload`

Guards (3.x `resolveDeletionContext_`):

| Rule | Error |
| --- | --- |
| `p_scope` is `ITEM` or `BERKAS` | `INVALID_INPUT` (`p_scope`) |
| The reason is at least 10 characters | `INVALID_INPUT` (`p_reason`) |
| `p_confirmation` is `HAPUS` (trimmed, case-insensitive) | `INVALID_INPUT` (`p_confirmation`) |
| The berkas exists in the caller's scope | `NOT_FOUND` |
| The berkas is not already cancelled | `ALREADY_CANCELLED` |
| Loans: berkas, plus every active item (`BERKAS`) or the target item (`ITEM`) | `OBJECT_BORROWED` |
| `ITEM`: `p_item_id` is required | `INVALID_INPUT` |
| `ITEM`: the item belongs to this berkas | `NOT_FOUND` |
| `ITEM`: the item is not already cancelled | `ALREADY_CANCELLED` |
| `ITEM`: the item is not the last active item of the berkas | `LAST_ITEM_IN_BERKAS` |
| Evidence session: a `DELETION_EVIDENCE` session of this caller, for the target object (item id for `ITEM`, berkas id for `BERKAS`), committed and not yet consumed | `UPLOAD_SESSION_STATE` |

`p_validate_only = true` runs all guards with no effect. It returns `{ ok, valid: true, scope, berkas_id, item_id, item_count }`, so it can be called before uploading evidence.

Effect, in one transaction under the unit lock. Nothing is ever hard-deleted, and audit and files remain.

1. **Quarantine bindings.**
   - Every file of a cancelled item gets a `karantina` row (module `PENGHAPUSAN_ITEM` / `PENGHAPUSAN_BERKAS`, the reason, `pembatalan_id`, the request id).
   - Scope `BERKAS`: the berkas folders (legacy `drive_folder_id` and v4 `v4_drive_folder_id`) get `FOLDER` rows.
   - Pending Drive renames of these objects are superseded.
2. **Soft delete.**
   - Items: `is_deleted = true`, `status_file = 'DIHAPUS'`, `deleted_at`, `version + 1`, and `catatan` gets `[DIHAPUS <ISO+07:00>] <alasan>` appended (3.x `appendDeletionNote_`).
   - Scope `BERKAS` also sets the berkas `is_deleted = true`, `status_berkas = 'DIHAPUS'`, `deleted_at` and the note.
   - Cancelled records keep their numbers.
3. **The evidence session** is consumed.
4. **Audit**, 3.x texts, module `PENGHAPUSAN`:
   - one `DELETE` per item and one per berkas;
   - `RELEASE_SOURCE` when receipt lines were released;
   - the reason carries `| Bukti disposisi: <url>`.
5. **Receipt lines return to the filing queue** (`releaseReceiptItemsAfterDeletion_`).
   - For every cancelled item with a `penerimaan_item_id`, the source line becomes `BELUM DIBERKASKAN`, or `PERLU DILENGKAPI` when its metadata is incomplete.
   - `berkas_id_tujuan`, `item_id_definitif`, the number snapshots, `diberkaskan_*` and `pemberkasan_request_id` are cleared.
   - The line can be filed again: new `ITEM_ID`, same `ARSIP_ID`.
   - **This is what unblocks `receipt_cancel`** (`RECEIPT_HAS_FILED_ITEMS`) for receipts whose lines were filed. Tested end to end.
6. **Renumbering** of what remains, with history:
   - scope `BERKAS`: `app.renumber_unit(a, '{}', 'Penomoran ulang kronologis setelah penghapusan berkas')`, i.e. 3.x `buildReindexPlan_([])`;
   - scope `ITEM`: `app.renumber_unit(a, [berkas], '… setelah penghapusan item')`. The berkas aggregates and its strictest-active security are recomputed.
7. **One `pembatalan_arsip` row** with:
   - scope, berkas, item, all cancelled item ids;
   - number/title snapshots and the reason;
   - the evidence file (id, url, name, mime, size, md5);
   - the released receipt line ids and the quarantine ids;
   - the request id and the actor.

Returns:

```json
{ "ok": true, "request_id", "cancellation_id": "BTL-…", "scope", "berkas_id", "item_id" | null,
  "cancelled_item_ids": [...], "cancelled_item_count", "released_receipt_item_ids": [...], "quarantine_ids": [...],
  "evidence_file_id" | null, "renumbered_item_count", "renumbered_berkas_count", "drive_tasks": [...],
  "warnings": [], "message", "replayed": bool }
```

`message` is the 3.x text:

- `BERKAS`: "Berkas dan n item berhasil dihapus dari arsip aktif."
- `ITEM`: "Item berhasil dihapus dan nomor item telah disusun ulang."

Concurrency:

- Two cancels of the same item with different request ids: exactly one succeeds, the other gets `ALREADY_CANCELLED`.
- The same request id sent twice in parallel: one effect, and the second call is `replayed`.
- Parallel edits and cancels on one berkas never leave gaps or duplicate numbers.

#### Evidence flow (optional, port of the 3.x deletion evidence upload)

1. `archive_cancel(…, p_validate_only => true)`.
2. `upload_begin(p_request_id, 'DELETION_EVIDENCE', <item id for ITEM | berkas id for BERKAS>, name, mime, size)`.
3. The gateway uploads the file, then calls `upload_commit` with the attestation.
4. `archive_cancel(new request id, …, p_evidence_session_id => session_id)`.

## 3. Upload purposes added (extends `API_S2.md` §4)

| Purpose | Object | Rules | drive_name | Folder (`folder_path` / `known_folder_id`) |
| --- | --- | --- | --- | --- |
| `ITEM_PDF_REPLACE` | `item.id` | Item and berkas not deleted, not on loan (`app.assert_not_borrowed`). `.pdf`, mime `application/pdf` / `application/octet-stream`, size 1 … 104857599 (< 100 MB). The item may or may not have a PDF. | `<no berkas>_<no item>_<uraian_nama_file>.pdf` | berkas folder `<no>_<judul>` / `berkas.v4_drive_folder_id` |
| `DELETION_EVIDENCE` | `item.id` (scope ITEM) or `berkas.id` (scope BERKAS) | Object not deleted, not on loan (item: the item and its berkas; berkas: the berkas and all its items). For an item, not the last active item (`LAST_ITEM_IN_BERKAS`). Extension `pdf/jpg/jpeg/png`, mime `application/pdf`, `image/jpeg`, `image/png` or `application/octet-stream`; size 1 … 26214400 (≤ 25 MB). | `<yyyyMMdd-HHmmss WIB>_<ITEM\|BERKAS>_<no berkas>[-<no item>]_<uraian/judul>.<ext>` | `BUKTI PENGHAPUSAN` / unit setting `V4_DELETION_EVIDENCE_FOLDER_ID` |

Commit rules:

- `upload_commit` checks the attestation, freshness, size and `UPLOAD_FILE_IN_USE` exactly as before.
- The mime type at commit must be `application/pdf` for `ITEM_PDF_REPLACE`, and pdf/jpeg/png/octet-stream for `DELETION_EVIDENCE` (`FILE_TYPE`).
- Both purposes **store the file on the session only**. `item_update` / `archive_cancel` consume it inside the business transaction.
- Results: `{ ok, session_id, purpose, object_id, drive_file_id, file_name, drive_tasks: [], message, replayed }`.

Other functions:

- `upload_cancel`: a committed-but-unconsumed session of `ITEM_PDF_REPLACE` or `DELETION_EVIDENCE` can be cancelled (as `RECEIPT_CANCEL_EVIDENCE`). It returns the Drive id so the gateway can trash it.
- `upload_register_folder(…, 'TARGET', …)`:
  - `ITEM_PDF_REPLACE` → `berkas.v4_drive_folder_id`;
  - `DELETION_EVIDENCE` → unit setting `V4_DELETION_EVIDENCE_FOLDER_ID` (canonical strings unchanged).
- Audit modules: `EDIT_ARSIP` / `PDF_PENGGANTI` and `PENGHAPUSAN` / `BUKTI_DISPOSISI`, the 3.x names.

`app.drive_id_in_use` (used by `upload_commit`) now also counts:

- `karantina.object_id`;
- `pembatalan_arsip.bukti_file_id`.

So a quarantined file — including a legacy one that is no longer referenced by any upload session — can never be re-bound to an active record, where every role could read it. A user of unit B cannot bind unit A's file: the id is in use, and the attestation is bound to B's own session.

## 4. Karantina (SYSTEM_QUARANTINE) and file access

### Tables

**`public.karantina`** ports the legacy columns `QUARANTINE_ID → id`, `TIMESTAMP → occurred_at`, `USER_EMAIL`, `OBJECT_TYPE (FILE|FOLDER)`, `OBJECT_ID`, `ORIGINAL_NAME`, `ORIGINAL_URL`, `ORIGINAL_PARENT_IDS`, `QUARANTINE_FOLDER_ID`, `QUARANTINE_URL`, `MODULE`, `REASON`, `STATUS (QUARANTINED|FAILED)` and `NOTES`.

v4 adds:

- `actor_user_id`;
- `related_object_type` / `related_object_id` (ITEM|BERKAS) and `berkas_id`;
- `mime_type`, `size_bytes`, `md5`;
- `app_owned` (created by the app, so writable by the gateway);
- `request_id` and `pembatalan_id`.

Rows are never deleted.

**`public.pembatalan_arsip`** is append-only (see §2).

The importer maps `SYSTEM_QUARANTINE` → `karantina` (`v4/tools/import-legacy/lib/spec.mjs`). For legacy rows, the v4-only columns stay NULL.

### RLS

RLS on both tables is enabled and forced. **SELECT is for `ADMIN_PUSAT` (all units) and `ADMIN_UNIT` (own unit) only.** `PETUGAS`, `PIMPINAN` and inactive users see nothing. No client role can write.

### `quarantine_list(p_unit_id uuid default null, p_limit integer default 200)` — read, admins only

- `PETUGAS` / `PIMPINAN` get `FORBIDDEN_ROLE`.
- `ADMIN_PUSAT` passes `p_unit_id`; `ADMIN_UNIT` with another unit gets `FORBIDDEN_UNIT`.
- `p_limit` is clamped to 1…1000.

Returns:

```json
{ "ok": true, "unit_id", "total",
  "items": [{ "id", "occurred_at", "user_email", "object_type", "object_id", "original_name", "original_url", "module",
              "reason", "status", "notes", "related_object_type", "related_object_id", "berkas_id", "pembatalan_id",
              "request_id", "app_owned", "moved_in_drive", "quarantine_url", "downloadable" }] }
```

### Download bridge

`app.resolve_file_access` (0008, extended in 0018) now resolves two more kinds of file. Both are **admin-only**, like the 3.x "90 KARANTINA APLIKASI" folder:

- quarantined files (`object_type` `KARANTINA`, `object_id` = quarantine id), e.g. the PDF from before a replacement;
- cancellation evidence (`object_type` `PEMBATALAN`, `object_id` = `BTL-…`).

The file of a cancelled item stays reachable through its item row for admins only, as in 0008. `get_file_access` / `log_file_access` return NULL / `42501` for everyone else.

## 5. Loan guard and Sprint 6 hook

### Loan guard

`app.assert_not_borrowed(unit, berkas_id, item_ids[], 'EDIT'|'HAPUS')` is the **only** loan guard. All of these call it:

- `upload_begin` / `upload_commit` (ITEM_PDF, ITEM_PDF_REPLACE, DELETION_EVIDENCE);
- `item_update`, `berkas_update_title`, `archive_cancel`.

In Sprint 3 it reads `berkas.status_peminjaman` / `item.status_peminjaman` (≠ `TERSEDIA` = borrowed). **Sprint 4** re-points this one function to the loan table (an active loan on the berkas or one of the items), as 3.x also checked `PEMINJAMAN.STATUS = DIPINJAM`. Callers do not change. The error code stays `OBJECT_BORROWED`, with the 3.x messages.

### Sprint 6 hook

`app.invalidate_file_derivatives(unit, item_id, old_drive_id, request_id)` runs for every file that stops being the current file of an item (replaced or cancelled).

- **Now:** it supersedes pending Drive renames of that object. It returns `content_index: "NOT_INSTALLED"` while there is no content index, and `item.file_replaced_at` records the replacement.
- **Sprint 6 contract:** when `public.content_documents(unit_id, item_id, source_pdf_id, status, …)` exists, the hook marks rows of the old PDF `STALE` (tested with a temporary table). This mirrors 3.x `ContentDocumentService`, which reports `STALE` when `SOURCE_PDF_ID ≠ DB_ITEM.DRIVE_FILE_ID`. Sprint 6 must key its index by the source PDF id, keep these four column names (or update the hook), and also compare the source with `item.drive_file_id` at read time.

## 6. Deviations from 3.32.5 (justified)

1. **Replacement is a two-step commit.** In 3.x, finalize called `updateArchiveItem_(form, fileId)` with the form stored in the session. That is where FIX 3.30.5 lost classification and condition.
   - v4 never stores metadata in the upload session. `item_update` receives the full form and the session id.
   - Classification and condition therefore cannot be lost (tested for replace-only).
   - Invalid input before the upload is caught by `p_validate_only`.
2. **The old file is quarantined logically, not moved in Drive.**
   - 3.x moved it to `90 KARANTINA APLIKASI/<case>` and wrote `QUARANTINE_METADATA.json`.
   - The DB cannot call Drive, and the gateway cannot move legacy (not app-created) objects.
   - The binding in `karantina` plus `resolve_file_access` gives the same effect (admin-only, never re-used, reason/action recorded). `quarantine_folder_id` stays NULL for v4 rows (`moved_in_drive: false`).
   - `app_owned` marks rows a later job could physically move. See question 2.
3. **Berkas cancellation binds every item file as well as the folder(s).** 3.x quarantined only the berkas folder. v4 uploads can live in a v4 folder other than the legacy one, so each file is bound explicitly.
4. **Cancellation evidence is admin-only for download.**
   - In 3.x the URL was in the audit reason and the file in `BUKTI PENGHAPUSAN`.
   - It is now stored in `pembatalan_arsip`, which is readable by admins, like the audit log; the uploader (PETUGAS) gets the id in the RPC response.
   - Evidence limits are kept: PDF/JPG/JPEG/PNG, ≤ 25 MB.
5. **`pembatalan_arsip` record** (new). 3.x kept the cancellation only in AUDIT_LOG and in `CATATAN`. Both are still written; the record adds the structured binding (items, evidence, released lines, quarantine ids).
6. **A second cancel of an already-cancelled object returns `ALREADY_CANCELLED`.** 3.x said "tidak ditemukan atau sudah dihapus" (NOT_FOUND), or, through finalize, "sudah dihapus" as a success. A replay of the *same* request still returns the stored success.
7. **Berkas title (3.27) renames the app-owned v4 folder.**
   - 3.27 deliberately did not rename the Drive folder "so shared links stay valid".
   - Drive links are id-based, so a rename does not break them. The legacy folder is left untouched (the gateway could not write it anyway).
   - Only the v4 folder, whose name `<no>_<judul>` would otherwise be stale, gets a `RENAME_FOLDER` task. See question 3.
8. **Replacement allowed on an item without a PDF**, as in 3.x Edit. For this case `ITEM_PDF` (Alih Media) remains the normal path.
9. **Release of receipt lines** clears only lines whose `item_id_definitif` is the cancelled item, or empty. This is defensive against a line already re-filed elsewhere; 3.x matched by `PENERIMAAN_ITEM_ID` only.
10. **Renumber history timestamps.** `app.renumber_unit` is re-created in 0019 unchanged except that the batch id and `riwayat_nomor.created_at` / `dikonfirmasi_at` use `clock_timestamp()` instead of `now()`.
    - With `now()` (transaction start), an operation that waited for the unit lock wrote history that sorted *before* the operation it waited for.
    - The S3 concurrency test caught this ("latest history row = current number" failed).
11. **No report rebuild step.** 3.x called `rebuildReports_()` after every edit or cancel. v4 reports are computed from the tables, so there is nothing to refresh and no `REPORT_WARNING`.
12. **Idempotency is stricter** (as S2): a reused request id with another payload gives `IDEMPOTENCY_CONFLICT`. 3.x `findCommitted*Result_` matched by state instead.

## 7. Open questions for the owner

1. **Transferred berkas / active transfer proposals.** 3.x lets Edit and Koreksi & Pembatalan act on a berkas with `STATUS_PEMINDAHAN = SUDAH DIPINDAHKAN` or `USUL_PINDAH_ID_AKTIF`. v4 keeps that for now. Should both be refused, as `filing_commit` refuses a transferred berkas? This should be decided before Sprint 5.
2. **Physical quarantine.** Should app-owned files (`app_owned = true`) be moved by the gateway into a v4 "90 KARANTINA APLIKASI" folder, through a new drive task kind? Or is the logical, DB-enforced quarantine enough?
3. **Berkas title and folders.** Should renaming the v4 folder on a title change stay (deviation 7), or follow 3.27 strictly and rename nothing?
4. **Confirmation word.** It is `HAPUS` (3.x deletion), while the menu is "Koreksi & Pembatalan" and receipts use `BATALKAN`. Keep `HAPUS`?
5. **Should PETUGAS see cancellation evidence** they uploaded, as they can for receipt cancel evidence (ops-only)? It is currently admin-only.
