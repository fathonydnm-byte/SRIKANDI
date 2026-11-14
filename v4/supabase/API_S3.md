# API Sprint 3 — Edit/Perubahan, Koreksi & Pembatalan, Karantina

Status: **DRAFT — signatures fixed, details being implemented** in `v4/supabase/migrations/0018`–`0020`.
Conventions (errors, authorization, idempotency, data) are those of `API_S2.md` §1 and are not repeated.

## RPC list (signatures)

| RPC | Kind | Replaces (3.32.5) |
| --- | --- | --- |
| `edit_options(p_unit_id uuid default null)` | read | `apiGetEditOptions` |
| `item_update(p_request_id uuid, p_item_id text, p_payload jsonb, p_reason text, p_replacement_session_id uuid default null, p_validate_only boolean default false)` | write | `apiUpdateArchiveItem`, `apiFinalizeEditReplacementUpload` |
| `berkas_update_title(p_request_id uuid, p_berkas_id text, p_title text, p_reason text)` | write | `apiUpdateBerkasTitle` |
| `cancel_options(p_unit_id uuid default null)` | read | `apiGetDeletionOptions` |
| `archive_cancel(p_request_id uuid, p_scope text, p_berkas_id text, p_item_id text, p_reason text, p_confirmation text, p_evidence_session_id uuid default null, p_validate_only boolean default false)` | write | `apiDeleteArchive`, `apiFinalizeDeletionEvidenceUpload` |
| `quarantine_list(p_unit_id uuid default null, p_limit integer default 200)` | read (admins) | SYSTEM_QUARANTINE sheet |
| `upload_begin(...)` purposes `ITEM_PDF_REPLACE`, `DELETION_EVIDENCE` | write | `apiStartEditReplacementUpload`, `apiStartDeletionEvidenceUpload` |
