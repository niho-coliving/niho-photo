# @niho/cloud-contract

Versioned public wire types for NIHO Docs and NIHO Photo. The source of truth is this directory on `niho-docs/main`; consumers must pin the exact commit SHA and never copy edits by hand.

- v1 types: [`src/v1.ts`](src/v1.ts)
- shared `CloudClient` and mock adapter: [`src/mock.ts`](src/mock.ts)
- adversarial contract cases: [`v1/security-cases.json`](v1/security-cases.json)
- test-only reference model: [`test-support/reference-model.ts`](test-support/reference-model.ts)
- behavior and server obligations: [`../../docs/security/cloud-contract-v1.md`](../../docs/security/cloud-contract-v1.md)

The types describe public request/response shapes only. The mock and reference model run deterministic client scenarios and negative cases; they are not production code and do not prove that the private API enforces authorization. Credentials and bearer URLs must not be logged or persisted.
