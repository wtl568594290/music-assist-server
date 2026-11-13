# music-assist-server

A small Cloudflare Workers service that stores a music document list and its images. Metadata lives in D1, image binaries live in R2, and a static page is served from Workers Assets.

## Tech Stack

- Cloudflare Workers (TypeScript, ESM)
- Cloudflare D1 for metadata
- Cloudflare R2 for image storage
- Workers Assets for the static frontend (`public/`)

## Project Structure

```
.
├── public/
│   └── index.html        # Static page served through the ASSETS binding
├── src/
│   └── index.ts          # Worker entry point and HTTP routes
├── schema.sql            # D1 table definitions
├── wrangler.toml         # Worker, R2, and D1 bindings
├── package.json
└── tsconfig.json
```

## Bindings

| Binding  | Type         | Resource              | Purpose                        |
| -------- | ------------ | --------------------- | ------------------------------ |
| `DB`     | D1 database  | `music_assist_db`     | Document list and image mapping |
| `IMAGES` | R2 bucket    | `music-assist-data`   | Image binaries                 |
| `ASSETS` | Workers Assets | `./public`          | Static assets                  |

## Data Model

Defined in [schema.sql](schema.sql):

- `docs` — `position` (original order), `name`, `imgs` (JSON array of image briefs)
- `images` — `img_key` (`hash + name`, primary key), `name`, `hash`, `ext`, `filename` (`hash + ext`, also the R2 object key)

Images are deduplicated by file content: many `img_key` entries may point to the same R2 object, and the object is only removed when no mapping references it anymore.

## API

All JSON responses use the shape `{ "message": string, "data"?: unknown }`.

| Method | Path   | Description |
| ------ | ------ | ----------- |
| GET    | `/ping` | Liveness probe, returns `pong`. |
| GET    | `/doc` | Returns the document list in its original order. Responds `400` when the list is empty. |
| POST   | `/doc` | Replaces the whole document list. Body is a JSON array of `{ name, imgs }`, where each image is `{ name, number, hash, ext }`. Returns the images that still need to be uploaded via `POST /img`. |
| POST   | `/img` | Uploads an image. `multipart/form-data` with fields `name`, `hash`, `ext`, and `file`. Returns the stored filename, or `img already exists` when the mapping is already present. |
| GET    | `/img` | Reads an image. Query params `name` and `hash`. Responds with the image bytes, otherwise `400` / `404`. |

### Typical Flow

1. `POST /doc` with the full document list.
2. For every image returned in `data`, call `POST /img` with the file.
3. Clients read images through `GET /img?name=...&hash=...`.

## Getting Started

### Prerequisites

- Node.js 18+
- A Cloudflare account with Workers, D1, and R2 access
- Wrangler (installed as a dev dependency)

### Install

```bash
npm install
npx wrangler login
```

### Create Resources

```bash
npx wrangler r2 bucket create music-assist-data
npx wrangler d1 create music_assist_db
```

Copy the returned `database_id` into `wrangler.toml` under `[[d1_databases]]`.

### Initialize the Database

```bash
# Local development database
npm run db:init:local

# Remote database
npm run db:init:remote
```

### Run Locally

```bash
npm run dev
```

### Deploy

```bash
npm run deploy
```

### Scripts

| Script | Description |
| ------ | ----------- |
| `npm run dev` | Start the local Workers runtime with the frontend assets. |
| `npm run deploy` | Deploy the Worker to Cloudflare. |
| `npm run typecheck` | Type-check with `tsc --noEmit`. |
| `npm run db:init:local` | Apply `schema.sql` to the local D1 database. |
| `npm run db:init:remote` | Apply `schema.sql` to the remote D1 database. |
