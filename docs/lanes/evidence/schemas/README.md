# Evidence schemas

Proposed by the evidence lane on September 8, 2026, after Alex approved Q04. These are documents, not code. The coordinator decides where they land once the stack is chosen. Until then they live here.

Files:

- `evidence-record.schema.json`. One observation. Written by the recorder, never by hand. Reruns add a record and name the old one in `supersedes`.
- `scenario.schema.json`. One proof unit. Groups requirement IDs and says which evidence categories must exist before the requirement counts.
- `scenarios.json`. The twelve scenarios as data. In the app they split into one file each under `evidence/scenarios/`. Every one of the 37 requirement IDs in `docs/wiki/requirements.json` appears in exactly one scenario except SUBMIT-01 and SUBMIT-02, which span the scenarios that produce their IDs.

Rules the schema cannot express, so the generator checks them:

1. `reviewer` differs from `owner` when status is `verified`.
2. `artifact_hashes` keys equal `artifact_paths` and match the files.
3. A record's `requirement_ids` is a subset of its scenario's.
4. A `fixture` record never satisfies a requirement whose proof column in `requirements.md` says sandbox, provider, hosted, human or actual.
5. A record with `sample_payload` true never satisfies SUBMIT-04 on its own.
6. No artifact matches the secret patterns list.

The scenario commands are placeholders until the architecture lane answers Q02. Owners are unassigned until contracts are frozen. No record files exist yet because nothing has run.

Checked on September 8, 2026 with a stdlib structural pass: both schemas parse, all twelve scenarios carry the required fields and no others, every requirement ID is covered, handover steps are unique. The `jsonschema` package is not installed locally, so full draft 2020-12 validation has not run.
