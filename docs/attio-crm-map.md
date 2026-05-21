# Attio CRM Map

Workspace ID: `24758d0d-258e-46a4-ab64-180f47785b71`

API Base: `https://api.attio.com/v2`
Auth: `Authorization: Bearer $ATTIO_API_KEY`

## Objects

### People (api_slug: `people`)
Object ID: `0f437023-a00e-4298-bb95-7465f78c4236`

| Attribute | api_slug | Type | Writable | Multiselect | Notes |
|---|---|---|---|---|---|
| Record ID | `record_id` | text | no | no | unique |
| Name | `name` | personal-name | yes | no | |
| Email addresses | `email_addresses` | email-address | yes | yes | unique |
| Description | `description` | text | yes | no | |
| Company | `company` | record-reference | yes | no | → companies.team |
| Job title | `job_title` | text | yes | no | |
| Phone numbers | `phone_numbers` | phone-number | yes | yes | |
| Primary location | `primary_location` | location | yes | no | |
| Associated deals | `associated_deals` | record-reference | yes | yes | → deals.associated_people |
| LinkedIn | `linkedin` | text | yes | no | |
| Facebook | `facebook` | text | yes | no | |
| Instagram | `instagram` | text | yes | no | |
| Twitter | `twitter` | text | yes | no | |
| Created at | `created_at` | timestamp | no | no | auto |
| Created by | `created_by` | actor-reference | no | no | auto |

System/read-only interaction attributes: `first_calendar_interaction`, `last_calendar_interaction`, `next_calendar_interaction`, `first_email_interaction`, `last_email_interaction`, `first_interaction`, `last_interaction`, `next_interaction`, `strongest_connection_strength`, `strongest_connection_user`, `avatar_url`, `twitter_follower_count`.

### Deals (api_slug: `deals`)
Object ID: `1ec7de82-968c-4a65-9f3e-8c3c9bdbb84b`

| Attribute | api_slug | Type | Writable | Required | Notes |
|---|---|---|---|---|---|
| Record ID | `record_id` | text | no | no | unique |
| Deal name | `name` | text | yes | **yes** | |
| Deal stage | `stage` | status | yes | **yes** | see statuses below |
| Deal owner | `owner` | actor-reference | yes | **yes** | |
| Deal value | `value` | currency | yes | no | default USD |
| Associated people | `associated_people` | record-reference | yes | no | multiselect → people.associated_deals |
| Associated company | `associated_company` | record-reference | yes | no | → companies.associated_deals |
| Data konsultacji | `data_konsultacji` | timestamp | yes | no | Calendly consultation date |
| Opiekun | `opiekun` | actor-reference | yes | no | Deal caretaker (empty = unassigned) |
| Nieodebrane | `nieodebrane` | number | yes | no | Missed calls count |
| Created at | `created_at` | timestamp | no | no | auto |
| Created by | `created_by` | actor-reference | no | no | auto |

**Deal stages:**

| Status | status_id |
|---|---|
| Lead | `2abf780a-98ed-47d2-9a83-3e9e31aa6762` |
| In Progress | `3300a36a-eac1-477c-9f6a-3167017cfcd0` |
| Won | `45abe18b-bac9-4790-b065-f5c9a81acf74` |
| Lost | `9b7f4ada-181d-45e5-bd6f-dba113573b53` |

### Companies (api_slug: `companies`)
Object ID: `33a40212-f847-43dc-84c4-04170c1c0a68`

Not actively used in automations currently.

Key attributes: `name`, `domains` (unique, multiselect), `description`, `team` (→ people.company), `categories` (select, multiselect), `primary_location`, `associated_deals` (→ deals.associated_company), social fields, `employee_range`, `estimated_arr_usd`, `foundation_date`.

---

## Lists (Deal Pipelines)

All lists have `parent_object: deals`.

### Kampania: Raport Strategiczny
- List ID: `2e7cb019-4c0e-45c9-8998-c58590a733ef`
- api_slug: `kampania_raport_strategiczny`
- Status attribute: `kanban_kampania_raport_strategiczny`
- Stages: Pobrał raport → Kontakt nawiązany → Zainteresowany → Przekazany → Nieaktywny

### Kampania: Akademia Biznesu
- List ID: `a87fbbdf-8cab-4630-a3cc-9f5756dc944a`
- api_slug: `kampania_akademia_biznesu`
- Status attribute: `status_kampania_akademia_biznesu`
- Custom attributes: `data_konsultacji` (timestamp — Calendly date)
- Stages: Nowy lead → Nie odbiera → W kontakcie → Konsultacja umówiona → Nie chce konsultacji → Konsultacja odbyta → Oferta wysłana → Negocjacje → Podpisany → Przegrany

### BookClinic: Pipeline
- List ID: `458f6004-0552-4abc-aca5-f480bf48642b`
- api_slug: `bookclinic_pipeline`
- Status attribute: `pipeline_stage`
- Stages: Potencjalny → Umówiony na rozmowę → Todo po naszej stronie → Final sales call zaplanowany → Umowa wysłana → Onboarding call zaplanowany → Wdrożenie

### Klienci
- List ID: `0441013d-8d9d-4192-b818-fd67157d79d3`
- api_slug: `klienci`
- Status attribute: `kanban_klienci`
- Stages: (none configured yet)

---

## Notes API

**Create note:** `POST /v2/notes`

```json
{
  "data": {
    "parent_object": "people",
    "parent_record_id": "<person_record_id>",
    "title": "Note title (plaintext only)",
    "format": "markdown",
    "content": "# Heading\n\n**bold** text, - lists, etc."
  }
}
```

Required fields: `parent_object`, `parent_record_id`, `title`, `format` ("plaintext" or "markdown"), `content`.
Optional: `created_at` (ISO 8601, cannot be in the future), `meeting_id`.

Notes are scoped to ONE parent record. To attach a note to both a deal and a person, create two separate notes.

Supported markdown: headings (1-3), lists, bold, italic, strikethrough, highlight, links.

**List notes:** `GET /v2/notes` — returns all notes, can filter by parent.

---

## Relationships Graph

```
Person ←→ Deal       (many-to-many via associated_people / associated_deals)
Person  → Company    (many-to-one via company / team)
Deal    → Company    (many-to-one via associated_company / associated_deals)
Deal    → Lists      (deal can be in multiple lists as entries)
Note    → Record     (note belongs to one parent: person, deal, or company)
```

---

## Key IDs Reference

| Entity | ID |
|---|---|
| Workspace | `24758d0d-258e-46a4-ab64-180f47785b71` |
| People object | `0f437023-a00e-4298-bb95-7465f78c4236` |
| Deals object | `1ec7de82-968c-4a65-9f3e-8c3c9bdbb84b` |
| Companies object | `33a40212-f847-43dc-84c4-04170c1c0a68` |
| List: Kampania Raport Strategiczny | `2e7cb019-4c0e-45c9-8998-c58590a733ef` |
| List: Kampania Akademia Biznesu | `a87fbbdf-8cab-4630-a3cc-9f5756dc944a` |
| List: BookClinic Pipeline | `458f6004-0552-4abc-aca5-f480bf48642b` |
| List: Klienci | `0441013d-8d9d-4192-b818-fd67157d79d3` |
