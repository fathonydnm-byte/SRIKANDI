# API Sprint 2 — Registrasi (Penerimaan, Pemberkasan, Unggah)

Status: **implemented** in `v4/supabase/migrations/0010`–`0015` (0015 = integration follow-ups), with tests in `v4/tests/db/s2_*.test.mjs`. This file matches the SQL.

All functions are called with supabase-js `rpc(name, params)`; parameter names are the SQL names below (with the `p_` prefix). All return `jsonb`.

## 1. Conventions

### 1.1 Errors

Every business error is raised with SQLSTATE `P0001`, and:

- `message` = `"<CODE>: <pesan Indonesia yang bisa ditindaklanjuti>"`
- `hint` = `<CODE>` (the same code, machine-readable)
- `detail` = optional JSON text with structured context (e.g. `{"field":"items[2].page_count"}`)

`CODE` matches `^[A-Z][A-Z0-9_]+$` and is stable. In supabase-js: `error.hint` (preferred) or `error.message.split(':')[0]`. Postgres/system errors (e.g. `57014` timeout) keep their own SQLSTATE and have no code: treat them as `INTERNAL`.

| Code | Meaning |
| --- | --- |
| `AUTH_REQUIRED` | No `auth.uid()` (not logged in). |
| `ACCOUNT_INACTIVE` | No profile, the profile is inactive, or the unit is inactive. |
| `FORBIDDEN_ROLE` | The role may not perform this operation (e.g. PIMPINAN writing). |
| `FORBIDDEN_UNIT` | The object or the requested unit belongs to another unit. |
| `UNIT_REQUIRED` | ADMIN_PUSAT must pass `p_unit_id` for operations that create data. |
| `UNIT_NOT_FOUND` | `p_unit_id` is unknown or inactive. |
| `INVALID_INPUT` | A parameter is missing or malformed; `detail.field` names it. |
| `NOT_FOUND` | The referenced object does not exist in the caller's scope. |
| `IDEMPOTENCY_CONFLICT` | The same `p_request_id` was used before with a different operation or payload. |
| others | Listed per function below. |

### 1.2 Authorization

Every write RPC is `SECURITY DEFINER` with an empty `search_path`. Its first step resolves the caller from `auth.uid()`:

- **Writers:** active profile and active unit, role ∈ {`ADMIN_PUSAT`, `ADMIN_UNIT`, `PETUGAS`}. `PIMPINAN` gets `FORBIDDEN_ROLE` on every write.
- **Unit resolution:**
  - Unit users act on their own unit. Passing another `p_unit_id`, or an object of another unit, gives `FORBIDDEN_UNIT`.
  - `ADMIN_PUSAT` must pass `p_unit_id` to create data. For functions that address an existing object (receipt, session), the object's unit is used.
- Read RPCs (`*_options`, `receipt_print_prepare`) are `SECURITY INVOKER`: RLS applies, so every active role, PIMPINAN included, can read its own unit.

Execute is granted to `authenticated` only; `anon` and `service_role` cannot call them. Tables stay non-writable by clients.

### 1.3 Idempotency

- Every write RPC takes `p_request_id uuid`, a fresh UUID per user action, reused on retry.
- **First call:** the effect plus the stored response, both in one transaction.
- **Retry with the same request id and the same payload:** returns the stored response with `"replayed": true`. There is never a second effect.
- **Same request id with a different payload, or for a different operation:** raises `IDEMPOTENCY_CONFLICT`.
- Requests are serialized per unit with a transaction advisory lock, so concurrent retries of the same request also produce one effect.
- Exception: `receipt_print_confirm` is idempotent on `p_print_token` (legacy behaviour).

### 1.4 Data conventions

- Dates are `YYYY-MM-DD` (Asia/Jakarta calendar dates). Timestamps are ISO 8601 with offset.
- IDs are legacy-style text, generated server-side: `RCV-…`, `RCVI-…`, `ARS-…`, `ITM-…`, `BRK-…`, `PGW-…`, `HIS-…`, `LOG-…`, `RCPL-…`. A receipt's ID is `RCV-` + upper(request id).
- Display numbers (`TRM-YYYY-NNNN`, berkas/item numbers) are separate from IDs, and IDs never change.
- Audit actor: `audit_log.actor_user_id` = `auth.uid()`, `actor_email_snapshot` = auth email, `actor_name_snapshot` = profile name. `created_by`/`updated_by` columns hold the email, as in 3.x.

## 2. Penerimaan Arsip

### `receipt_options(p_unit_id uuid default null)` — read · replaces `apiGetReceiptOptions`

Returns:

```json
{ "unit_id", "employees": [{ "id", "name", "unit", "label" }],
  "receipts": [{ "id", "number", "year", "received_at", "sender_employee_id", "sender_name", "sender_unit",
                 "receiver_name", "receiver_unit", "location", "notes", "item_count", "total_pages", "status",
                 "evidence_file_id", "evidence_name", "cancellation_reason", "cancellation_evidence_file_id",
                 "cancelled_at", "filed_count", "pending_count", "incomplete_count", "print_count",
                 "can_edit_header", "can_edit", "can_complete_metadata",
                 "items": [{ "id", "archive_id", "number", "description", "page_count", "development_level",
                             "condition", "security_classification", "primary_letter_number",
                             "alternate_letter_number", "document_date", "notes", "filing_status",
                             "filed_berkas_id", "filed_item_id", "filed_berkas_number", "filed_item_number",
                             "metadata_complete", "can_edit" }] }],
  "defaults": { "receiver_name", "receiver_unit", "location": "Surabaya" },
  "development_levels": ["ASLI","COPY"],
  "conditions": ["BAIK","RUSAK RINGAN","RUSAK SEDANG","RUSAK BERAT"],
  "security_classifications": ["BIASA/TERBUKA","TERBATAS","RAHASIA","SANGAT RAHASIA"],
  "summary": { "total", "active", "with_evidence", "cancelled" } }
```

- Receipts are sorted newest first; items by number.
- Defaults come from the unit settings `RECEIPT_RECEIVER_NAME` and `RECEIPT_RECEIVER_UNIT`.

### `pegawai_add(p_request_id uuid, p_name text, p_unit_kerja text, p_unit_id uuid default null)` — write · `apiAddReceiptEmployee`

- Matches an existing employee by name and work unit, case-insensitively with whitespace collapsed.
- If the match is inactive, it is reactivated. Otherwise a new `PGW-…` is created.
- Returns `{ ok, employee: { id, name, unit, label }, created: bool, reactivated: bool, message }`.
- Errors: `INVALID_INPUT`.

### `receipt_save(p_request_id uuid, p_payload jsonb, p_unit_id uuid default null)` — write · `apiSaveReceipt`

`p_payload`:

```json
{ "receipt_id": null | "RCV-…",
  "sender_employee_id": "PGW-…", "receiver_name": "…", "receiver_unit": "…", "notes": "…",
  "items": [ { "receipt_item_id": null | "RCVI-…", "archive_id": null | "ARS-…",
               "description": "…", "page_count": 1, "development_level": "ASLI|COPY",
               "condition": "BAIK|RUSAK RINGAN|RUSAK SEDANG|RUSAK BERAT",
               "security_classification": "BIASA/TERBUKA|TERBATAS|RAHASIA|SANGAT RAHASIA",
               "primary_letter_number": "…", "alternate_letter_number": "…",
               "document_date": "YYYY-MM-DD", "notes": "…" } ] }
```

**Create** (`receipt_id` null):

- Receipt id is `RCV-` + upper(request id).
- Number is `TRM-<year>-<NNNN>`: the Jakarta year at server time, sequence per unit and year. It comes from `next_counter`, kept ≥ the highest existing number.
- `tanggal_waktu_terima` is the server time and cannot be changed afterwards.
- Item `NO_ITEM` = position in the list. Each item gets new `RCVI-` and `ARS-` ids and status `BELUM DIBERKASKAN`.

**Edit** (`receipt_id` set) follows the 3.x rules:

- A cancelled receipt cannot be edited: `RECEIPT_CANCELLED`.
- After signed evidence exists, or once any item is filed, the header (sender, receiver, notes) is locked: `RECEIPT_LOCKED`.
- After evidence, items can be neither added nor removed: `RECEIPT_LOCKED`.
- Printed fields (description, pages, development level, condition) are locked after evidence: `RECEIPT_LOCKED`.
- After evidence, only items still `PERLU DILENGKAPI` may change their other metadata.
- A filed item cannot be changed or removed: `ITEM_ALREADY_FILED`.
- An item missing from the list is soft-deleted.
- An unknown `receipt_item_id` gives `NOT_FOUND`; an `archive_id` mismatch gives `INVALID_INPUT`; the same item twice gives `INVALID_INPUT`.

Validation:

- 1–100 items; `page_count` an integer ≥ 1.
- `development_level`, `condition` and `security_classification` from the lists above.
- `document_date` required; `description` required.
- `sender_employee_id` must be an active employee of the unit: `NOT_FOUND`.
- `receiver_name` and `receiver_unit` required.

Returns `{ ok, receipt_id, number, is_update, item_count, total_pages, message }`.

### `receipt_recover(p_request_id uuid, p_unit_id uuid default null)` — write-role read · `apiRecoverReceiptSave`

Returns `{ ok, found: bool, receipt_id, number, message }` for the receipt created by that request, without any effect.

### `receipt_print_prepare(p_receipt_id text)` — read · `apiPrepareReceiptPrint`

- Returns `{ ok, print_token, receipt_id, number, received_at, sender_name, sender_unit, receiver_name, receiver_unit, location, notes, status, cancellation_reason, cancelled_at, is_reprint, print_number, generated_at, file_name, items: [...] }`.
- `print_token` is `RCPRINT-<uuid>`; `file_name` is `<TRM>_Tanda-Terima-Penyerahan-Arsip.pdf`.
- A cancelled receipt still prints; the web adds the BATAL watermark.
- Errors: `NOT_FOUND`, including "no active items".

### `receipt_print_confirm(p_receipt_id text, p_print_token text, p_file_name text default null)` — write · `apiConfirmReceiptPrint`

- Appends a row to `penerimaan_cetak_log`: `cetak_ke` = previous count + 1, `jenis_cetak` = `PERTAMA` or `CETAK ULANG`.
- Audit action `GENERATE_PDF`.
- Idempotent on `p_print_token`: the same token returns the same `cetak_ke` and adds no row.
- Returns `{ ok, print_count }`.

### `receipt_cancel(p_request_id uuid, p_receipt_id text, p_reason text, p_confirmation text, p_evidence_session_id uuid default null)` — write · `apiCancelReceipt` + finalize of cancel evidence

Guards:

- `p_reason` must be at least 10 characters, else `INVALID_INPUT`.
- `p_confirmation` must be `BATALKAN` (case-insensitive), else `INVALID_INPUT`.
- If any non-deleted `item` still references the receipt, the cancel is refused with `RECEIPT_HAS_FILED_ITEMS`. `detail.items` lists up to 5 `"<no berkas>/<no item>"`.
- An already-cancelled receipt returns `{ok, already_cancelled: true}`.

Optional evidence: `p_evidence_session_id` must be a `RECEIPT_CANCEL_EVIDENCE` session for this receipt, owned by the caller and committed but not yet used. Otherwise `UPLOAD_SESSION_STATE`. The session is consumed.

Effect:

- `status = 'DIBATALKAN'`, the reason, evidence fields, `dibatalkan_at` / `dibatalkan_by`, `version + 1`.
- Every non-deleted receipt item gets `STATUS_PEMBERKASAN = 'DIBATALKAN'`.
- Existing signed evidence is kept. Audit action `CANCEL`.
- Returns `{ ok, receipt_id, evidence_file_id, message }`.

Signed evidence ("bukti tertandatangani") is attached through the upload flow (§4, purpose `RECEIPT_EVIDENCE`). After it exists, the receipt is locked (see `receipt_save`); correction is cancel + new receipt.

## 3. Pemberkasan

### `registration_options(p_unit_id uuid default null)` — read · `apiGetBootstrap` (registration parts)

```json
{ "unit_id",
  "berkas": [{ "id", "number", "title", "classification_code", "security_classification", "label" }],
  "classifications": [{ "id", "parent_id", "level", "code", "description", "label", "selectable" }],
  "jenis_naskah": [{ "jenis_naskah_id", "kategori", "subjenis_naskah_id", "subjenis", "pola_default", "periode_default",
                     "template_judul_berkas", "perlu_kelengkapan", "opsi_kelengkapan" }],
  "retention_units": ["TAHUN","BULAN"], "final_dispositions": ["MUSNAH","PERMANEN","DINILAI KEMBALI"],
  "security_classifications": [...], "development_levels": [...] }
```

- `berkas` lists non-deleted berkas not yet transferred, ordered by number (drafts last).
- 0015 adds:
  - `archive_categories: [{ key: "arsip_vital", label, default: false }, { key: "arsip_terjaga", label, default: false }]`
  - `media_sources: ["TEKSTUAL","AUDIO VISUAL","DIGITAL"]`
  - `media_berkas_values: ["TEKSTUAL","AUDIO VISUAL","DIGITAL","KOMBINASI","BELUM DITETAPKAN"]` (read-only, derived)
  - `archive_creator: { name, unit_name }`
- `classifications` contains active rows only. `selectable` follows the 3.x rule: secondary always; otherwise only when the row has no active children. So a primary *with* children is not selectable, while a leaf primary is.

### `filing_options(p_unit_id uuid default null)` — read · `apiGetReceiptFilingOptions`

- Returns `{ items: [...max 500], total_queue, truncated, summary: { pending, incomplete, filed }, max_batch_size: 100 }`.
- Items come from active receipts with status `BELUM DIBERKASKAN` or `PERLU DILENGKAPI`. They are ordered by received time, then receipt number, then line number.
- Each item: `{ id, archive_id, receipt_id, receipt_number, receipt_item_number, received_at, sender_name, sender_unit, primary_letter_number, alternate_letter_number, document_date, description, page_count, development_level, condition, security_classification, notes, status, selectable }`.

### `filing_commit(p_request_id uuid, p_receipt_item_ids text[], p_target jsonb, p_unit_id uuid default null)` — write · `apiCommitReceiptFiling`

`p_target`:

- `{ "mode": "EXISTING", "berkas_id": "BRK-…" }`, or
- `{ "mode": "NEW", "title", "classification_id", "active_retention_value", "active_retention_unit", "inactive_retention_value", "inactive_retention_unit", "final_disposition", "filing_cabinet"?, "drawer"?, "notes"?, "kategori_naskah_id"?, "pola_pemberkasan"?, "arsip_vital"?, "arsip_terjaga"? }`

CF-01 berkas metadata on a new berkas (0015):

- `arsip_vital` / `arsip_terjaga`: optional booleans (JSON `true`/`false`, or the strings `"true"`/`"false"`). Default `false`, as the 3.x backfill. Anything else gives `INVALID_INPUT`.
- `pencipta_arsip_snapshot`, `unit_pencipta_id`, `unit_pencipta_snapshot` are taken from the unit settings `ARCHIVE_CREATOR_NAME` (default `UIN Sunan Ampel Surabaya`), `UNIT_ID` and `UNIT_NAME` — the values 3.x fills by backfill. They are not parameters.
- `media_berkas`, `jumlah_item_fisik`, `jumlah_item_born_digital` and `jumlah_item_alih_media` are **derived** from the berkas' active items each time the berkas is a filing or manual-input target. The rules are those of 3.x `centralFileMetadataSummarizeItems_`: one source → that source; several → `KOMBINASI`; none → `BELUM DITETAPKAN`. They are not parameters, because 3.x never takes them as input.

Guards:

- 1–100 distinct ids, else `INVALID_INPUT` / `BATCH_LIMIT`.
- All ids must exist in the unit: `NOT_FOUND`. The source receipt must be active: `RECEIPT_CANCELLED`.
- Status `SUDAH DIBERKASKAN`: `ITEM_ALREADY_FILED`. Not `BELUM DIBERKASKAN`, or metadata incomplete: `ITEM_NOT_READY`.
- An active `item` already exists for the same receipt line or the same `ARSIP_ID`: `SOURCE_ALREADY_ACTIVE`.
- Target berkas: must exist and not be deleted (`NOT_FOUND`), and not be transferred (`BERKAS_TRANSFERRED`).
- New-berkas classification: `CLASSIFICATION_INVALID`.

Effect, in one transaction under the unit lock:

- One new `ITM-…` per source. `ARSIP_ID` is kept from the source; `ITEM_ID` belongs to this filing.
- Metadata and security are inherited from the receipt line. The source is marked `SUDAH DIBERKASKAN` with its target and number snapshots.
- Then chronological renumbering of the whole unit (§3.1), riwayat_nomor rows, and the berkas aggregates.
- Drive rename tasks are queued for existing folders and files whose number changed.
- Audit action `FILE_BATCH`.

Returns `{ ok, request_id, berkas_id, berkas_number, berkas_title, item_count, total_pages, renumbered_item_count, renumbered_berkas_count, items: [{ receipt_item_id, item_id, berkas_number, item_number, description }], drive_tasks: [{ id, kind, drive_id, new_name }], message }`.

### `filing_recover(p_request_id uuid, p_unit_id uuid default null)` — write-role read · `apiRecoverReceiptFiling`

Returns the stored response of that filing request with `found: true`, or `{found: false}`.

### `item_create_manual(p_request_id uuid, p_target jsonb, p_item jsonb, p_unit_id uuid default null)` — write · `apiCommitItemMetadata` (Input Manual)

`p_target`: as for `filing_commit`. `p_item`:

```json
{ "primary_letter_number"?, "alternate_letter_number"?, "document_date": "YYYY-MM-DD", "description": "…",
  "page_count": 1, "development_level": "ASLI|COPY", "security_classification": "…", "notes"? }
```

- Creates one item with `ARSIP_ID = ITEM_ID`, `SUMBER_REGISTRASI = INPUT_MANUAL`, media `TEKSTUAL`, digital status `TIDAK ADA` and file status `BELUM DIUNGGAH`, then renumbers the unit as `filing_commit` does.
- The PDF is optional and comes afterwards via `upload_begin(ITEM_PDF, item_id)`. 3.x could upload it within the same step; see Deviations.
- Returns `{ ok, item_id, berkas_id, berkas_number, item_number, file_status, renumbered_item_count, renumbered_berkas_count, drive_tasks, message }`.

### 3.1 Numbering (port of `buildBatchNumberingPlan_` / `buildNumberingOperations_`)

Inside the unit lock, after inserting the new rows:

1. Take every non-deleted berkas of the unit that has ≥ 1 non-deleted item. Transferred berkas take part too, as in 3.x.
2. Order the items within each berkas by:
   1. `tanggal_naskah`;
   2. the normalised letter number (`NO_SURAT_UTAMA`, or else `NO_SURAT_ALTERNATIF`, uppercased, non-alphanumerics → space, empty → `ZZZZZZ`), compared in natural order, case-insensitively;
   3. `SORT_CREATED_AT` / `created_at` / id, natural order.
3. Order the berkas by:
   1. earliest item date;
   2. old number (none = last);
   3. `created_at`, then id.
4. Number berkas 1..n and items 1..m per berkas.
5. **Berkas updates.** For the target berkas, and for every berkas whose number changed:
   - `no_berkas_definitif`, `no_folder`, `tgl_item_awal`, `tgl_item_akhir`, `tgl_urut_berkas`, `tgl_acuan_retensi`;
   - `batas_aktif` = latest item date + active retention, `batas_inaktif` = `batas_aktif` + inactive retention. Uses JavaScript `setMonth`/`setFullYear` semantics, e.g. 31 Jan + 1 month = 3 Mar;
   - `status_retensi`: `AKTIF` / `H-n` (n ≤ 7) / `HABIS AKTIF – PERLU PERSETUJUAN PEMINDAHAN`;
   - `jumlah_item`, `total_halaman`, `kurun_waktu` (`YYYY` or `YYYY–YYYY`);
   - security = strictest active item;
   - `status_berkas = AKTIF`, `version + 1`.
6. **Item updates.** For every item whose number, berkas-number snapshot or file name changed: `no_item_definitif`, `no_berkas_snapshot`, `nama_file` = `<no berkas>_<no item>_<uraian_nama_file>.pdf`, `version + 1`.
7. **History.** A `riwayat_nomor` row is written for each changed berkas or item number: old → new; the old value is empty for new rows. `batch_renumber_id` = `REN-<timestamp>`.
8. **Drive renames.** A task is queued for each berkas folder (`<no>_<judul>`) or item file whose name must change. Rename failures never undo the data, as in 3.x.

## 4. Unggah file (Drive via the trusted Pages Function)

The browser never registers a Drive file id by itself. Flow:

1. `upload_begin(...)`: the DB validates and returns where and how to name the file.
2. The Pages Function performs the resumable upload to Drive, using the instansi token.
3. The Pages Function verifies the file in Drive (id, size, md5, mime, parent folder). It then computes `attestation = hex(HMAC-SHA256(UPLOAD_ATTEST_SECRET, canonical))`, where `canonical = "CFUP1\n<session_id>\n<drive_file_id>\n<size>\n<md5>\n<mime>\n<attested_at>"`. `attested_at` is unix seconds and `size` is the decimal byte count. Every value goes in **exactly as it is passed to `upload_commit`** (trimmed only; the DB stores md5 lowercased). Lowercase hex is used for the attestation itself.
4. The Pages Function (with the user's JWT), or the browser passing those values through, calls `upload_commit(...)`.

`app.server_secret('UPLOAD_ATTEST_SECRET')` reads Supabase Vault (`vault.decrypted_secrets`). Locally, when the vault schema is absent, it reads `current_setting('app.secret.UPLOAD_ATTEST_SECRET')`. The secret is never returned to clients.

### `upload_begin(p_request_id uuid, p_purpose text, p_object_id text, p_file_name text, p_mime text, p_size bigint, p_unit_id uuid default null)` — write

Purposes:

| Purpose | Object | Rules | drive_name | Folder |
| --- | --- | --- | --- | --- |
| `ITEM_PDF` | `item.id` | Item non-deleted, berkas non-deleted, item has no PDF yet (replacement is Edit, Sprint 3), item and berkas not borrowed. `.pdf`, mime `application/pdf` or `application/octet-stream`, size 1 … 104857599 (< 100 MB). | `<no berkas>_<no item>_<uraian_nama_file>.pdf` | berkas folder `<no>_<judul>` in the v4 tree |
| `RECEIPT_EVIDENCE` | `penerimaan.id` | No signed evidence yet. `.pdf`, size 1 … 10485760 (≤ 10 MB). | `<TRM>_Tanda-Terima-Tertandatangani.pdf` | `BUKTI PENERIMAAN ARSIP` |
| `RECEIPT_CANCEL_EVIDENCE` | `penerimaan.id` | Receipt active. Same file rules as above. | `<TRM>_Bukti-Pembatalan.pdf` | `BUKTI PENERIMAAN ARSIP` |

Returns:

```json
{ "session_id", "unit_id", "unit_code", "folder_path": ["<segment>", ...], "drive_name",
  "known_folder_id": "<drive folder id>" | null, "root_folder_id": "<unit ARCHIVE_FOLDER_ID setting>" | null,
  "max_bytes", "expires_at", "replayed": bool }
```

- **App-owned Drive tree (0015).** The gateway token can only write folders it created, so every folder id returned here is a v4 one:
  - `known_folder_id` = `berkas.v4_drive_folder_id` for `ITEM_PDF`, or the unit setting `V4_RECEIPT_PROOF_FOLDER_ID` for evidence. It is never the legacy `berkas.drive_folder_id` or `RECEIPT_PROOF_FOLDER_ID`.
  - `root_folder_id` = the unit setting `V4_ROOT_FOLDER_ID`, or `null` when no v4 root has been registered yet. It is never the legacy `ARCHIVE_FOLDER_ID`.
  - `folder_path` is relative to `root_folder_id`. When `root_folder_id` is null, the gateway creates the unit root (where it is configured to) and registers it with `upload_register_folder(..., p_kind => 'ROOT')`.
  - When `known_folder_id` is set, upload straight into it.
- Legacy folder columns stay as they are, for reading only.
- `max_bytes` is inclusive.

Sessions:

- One `OPEN` session per (purpose, object).
- A new begin by the same user supersedes that user's older open session for the same object. If the open session belongs to another user, the begin fails with `UPLOAD_SESSION_ACTIVE`.
- The same `p_request_id` returns the same session.
- Sessions expire 24 h after begin.

Errors: `NOT_FOUND`, `ITEM_HAS_FILE`, `OBJECT_BORROWED`, `EVIDENCE_EXISTS`, `RECEIPT_CANCELLED`, `FILE_TYPE`, `FILE_TOO_LARGE`, `UPLOAD_SESSION_ACTIVE`, `INVALID_INPUT`.

### `upload_commit(p_session_id uuid, p_drive_file_id text, p_drive_url text, p_size bigint, p_md5 text, p_mime text, p_attested_at bigint, p_attestation text)` — write

Guards:

- Only the session owner may commit; anyone else gets `NOT_FOUND`.
- The attestation must be valid (`UPLOAD_ATTESTATION_INVALID`) and fresh, `|floor(now) − attested_at| ≤ 300 s` in whole unix seconds (`UPLOAD_ATTESTATION_EXPIRED`).
- The session must be `OPEN` and not expired: `UPLOAD_SESSION_EXPIRED` / `UPLOAD_SESSION_STATE`.
- The file must satisfy the session's limits: `FILE_TOO_LARGE` / `FILE_TYPE`.
- A Drive file id already referenced by any record gives `UPLOAD_FILE_IN_USE`.

Effects, in the same transaction:

- **`ITEM_PDF`:** re-checks that the item still has no file and is not borrowed. Sets `drive_file_id`, `drive_file_url`, `mime_type`, `drive_file_size_bytes`, `drive_file_md5`, `nama_file`, `status_file = TERSEDIA`, `status_bentuk_digital = ALIH MEDIA` (when it was `TIDAK ADA`/empty) and `version + 1`. Queues a rename task when the item's numbers changed since begin. Audit `UPLOAD` / `ALIH_MEDIA`.
- **`RECEIPT_EVIDENCE`:** sets the `bukti_ttd_*` fields. If evidence was attached meanwhile, fails with `EVIDENCE_EXISTS`. Audit `UPLOAD` / `BUKTI_TTD`.
- **`RECEIPT_CANCEL_EVIDENCE`:** stores the file on the session only. `receipt_cancel` consumes it.

Replaying the identical commit returns the stored result with `replayed: true`.

Returns `{ ok, session_id, purpose, object_id, drive_file_id, drive_tasks: [...], message, replayed }`.

### `upload_cancel(p_session_id uuid)` — write

- Owner only.
- `OPEN`, or committed-but-unconsumed cancel evidence → `CANCELLED`.
- Returns `{ ok, drive_file_id | null }`; the gateway may trash that file.
- A committed `ITEM_PDF` or `RECEIPT_EVIDENCE` session cannot be cancelled: `UPLOAD_SESSION_STATE`.

### `upload_register_folder(p_session_id uuid, p_folder_id text, p_kind text, p_attested_at bigint, p_attestation text)` — write

The 4-argument form `(p_session_id, p_folder_id, p_attested_at, p_attestation)` means `p_kind = 'TARGET'`.

Caches a folder of the **v4 tree** the gateway created or found for an open or committed session of the caller. Legacy columns are never written; a value already set is never overwritten.

- `p_kind 'TARGET'`:
  - `ITEM_PDF` → `berkas.v4_drive_folder_id`;
  - evidence → unit setting `V4_RECEIPT_PROOF_FOLDER_ID`;
  - `canonical = "CFFD1\n<session_id>\n<folder_id>\n<attested_at>"`.
- `p_kind 'ROOT'`:
  - unit setting `V4_ROOT_FOLDER_ID`;
  - `canonical = "CFFD1\n<session_id>\n<folder_id>\n<attested_at>\nROOT"`.

Returns `{ ok, folder_id, kind, registered: bool }`.

### `media_options(p_unit_id uuid default null)` — read · `apiGetMediaUploadOptions`

- Returns `{ berkas: [{ id, number, title, label, items: [{ id, number, description, document_date, page_count, file_status, planned_file_name, label }] }], total_missing }`.
- Lists non-deleted items of non-deleted berkas that have no PDF.

### Drive tasks (renames after renumbering)

- `drive_task_list(p_unit_id uuid default null)` — writers. Returns `{ tasks: [{ id, kind: "RENAME_FOLDER"|"RENAME_FILE", drive_id, new_name, object_type, object_id, attempts, created_at }] }`, pending tasks oldest first. A newer rename of the same Drive object supersedes the older one.
- `drive_task_complete(p_task_id uuid, p_ok boolean, p_error text, p_permanent boolean, p_attested_at bigint, p_attestation text)` — writers. The 5-argument form without `p_permanent` means `false`.
  - Attestation `canonical = "CFDT1\n<task_id>\n<ok|fail>\n<attested_at>"`; `p_permanent` is not part of it.
  - `p_ok = true` → `DONE`.
  - Failure with `p_permanent = true` (e.g. `NOT_APP_FILE`, `NOT_FOUND`) → `FAILED` immediately.
  - Transient failure → `attempts + 1`, `FAILED` at the 5th attempt.
  - Each failure report writes exactly one `RENAME_WARNING` audit row (`after_data.task_id`).
  - A task that is no longer `PENDING` returns `{status, replayed: true}` and writes nothing.
  - Returns `{ ok, status, attempts, permanent?, replayed }`.
- **Which renames are queued (0015).** Only app-owned Drive objects get rename tasks: the v4 berkas folder (`v4_drive_folder_id`), and item files committed through `upload_commit`. Legacy folders and files keep their old names; the gateway cannot rename them, and the database numbers remain the reference.

## 5. Tables added in S2

- `jenis_naskah` (MASTER_JENIS_NASKAH, PK unit + subjenis_naskah_id)
- `penerimaan_cetak_log` (LOG_CETAK_PENERIMAAN, append-only)
- `upload_sessions`
- `drive_tasks`

All of them have RLS enabled and forced. `jenis_naskah` and `penerimaan_cetak_log` are readable per unit; `upload_sessions` and `drive_tasks` are not readable by clients (use the RPCs).

## 6. Deviations from 3.32.5 (justified)

1. **PDF goes in after the item exists.** `upload_begin(ITEM_PDF)` requires an existing item. Input Manual and filing first commit the metadata, then the PDF is attached through the same path as Alih Media.
   - In 3.x the PDF could ride along in the same submit.
   - Since 3.12, an item without a PDF (`BELUM DIUNGGAH`) is a valid state, so the intermediate state is legal.
   - The file only ever links after the attested commit, so a database row is never committed for a file that is incomplete.
2. **Drive folders and renames are asynchronous, and only for the app-owned tree (0015).** New uploads go into a v4 folder tree, not into the legacy berkas folders, and legacy objects are not renamed. The DB cannot call Drive.
   - The gateway creates the folder from `folder_path` (or uses `known_folder_id`) and caches it with `upload_register_folder`.
   - Renames after renumbering are queued in `drive_tasks` and returned in the RPC response.
   - As in 3.x, a rename failure never undoes the data; 3.x likewise recorded it as a warning.
3. **Alih media sets `STATUS_BENTUK_DIGITAL = ALIH MEDIA`** when it was `TIDAK ADA`/empty. 3.x MediaService left the value untouched, while the CF-01 backfill rule ("item with file → ALIH MEDIA") produces this value. Doing it at commit keeps the data consistent without a backfill.
4. **Signed evidence uploaded when evidence already exists is refused** with `EVIDENCE_EXISTS`. 3.x answered "sudah tersimpan" and left the second file orphaned; the error lets the gateway trash it. Attaching signed evidence to a cancelled receipt is still allowed, as in 3.x.
5. **Creating a receipt ignores a client-sent `archive_id`.** `ARS-…` ids are always generated by the server, so a client cannot collide with another source's ARSIP_ID. On edit, new lines may carry one.
6. **Receipt id** is `RCV-` + upper(request id), the same form as 3.x, where the client's `RCV-…` request id became the receipt id.
7. **Numbering tie-breaks.**
   - When date, letter number and `SORT_CREATED_AT` are all equal, the final tie-break is the item/berkas id. 3.x used sheet row order (stable sort), which a database does not have.
   - The `SORT_CREATED_AT` suffix of filed receipt lines follows (receipt line created_at, receipt, line no) instead of sheet row order.
   - On the pilot data, the ported algorithm reproduces every legacy number, date, total and security level exactly: 0 differences across all 28 berkas.
8. **Classification.** A primary *without* children is accepted, exactly as 3.x `validateClassification_` and its test `secondary-classification.test.cjs` do. A primary *with* children is refused. See the open question.
9. **`kategori_naskah_id` / `pola_pemberkasan` are optional on a new berkas**, validated against `jenis_naskah`. 3.x always wrote `''`; the default keeps that behaviour.
10. **TRM counter.** Before each number, the counter is raised to at least the highest existing `TRM-<year>-NNNN` of the unit, so imported numbers are never reused. 3.x used max+1 on every save; the result is identical.
11. **Upload sessions.**
    - One open session per object and purpose: the same user supersedes; another user gets `UPLOAD_SESSION_ACTIVE`.
    - Sessions expire after 24 h; 3.x purged uncommitted sessions after 7 days.
    - Commit requires size = declared size, as 3.x refused "Ukuran PDF berubah selama upload".
12. **CF-01 metadata of a new berkas (0015).** 3.x registration did not capture vital/terjaga/media. Its backfill set vital/terjaga to `false` and the creator from settings, and derived media and counts from the items. v4 takes vital/terjaga as optional inputs (default `false`), fills the creator at creation, and derives media and counts when the berkas is a target.
13. **Idempotency is stricter.** A reused request id with a different payload raises `IDEMPOTENCY_CONFLICT`, where 3.x silently returned the first result.
