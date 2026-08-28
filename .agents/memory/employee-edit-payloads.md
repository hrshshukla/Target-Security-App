---
name: Employee edit payload compatibility
description: Compatibility rules for employee edit request values returned by the API.
---

Employee edit requests may be built directly from employee GET responses. Optional values can therefore arrive as `null`, and PostgreSQL DATE values can serialize as ISO timestamps. The PATCH validation must accept those representations and normalize dates back to `YYYY-MM-DD` before writing.

**Why:** The edit form reused the fetched employee object, while the route schema was stricter than its own response serialization.

**How to apply:** When changing employee response or edit fields, trace the JSON round trip and keep nullable optional fields and date serialization consistent across UI, validation, and database writes.