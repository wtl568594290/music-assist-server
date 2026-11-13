export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
}

interface ImgBrief {
  name: string;
  number: number;
  hash: string;
  ext: string;
}

interface FileInfoShort {
  name: string;
  imgs: ImgBrief[];
}

interface ImageRow {
  img_key: string;
  filename: string;
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
};

function mimeFromExt(ext: string): string {
  const normalized = ext.toLowerCase();
  const withDot = normalized.startsWith('.') ? normalized : `.${normalized}`;
  return MIME_TYPES[withDot] ?? 'application/octet-stream';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function imgKey(hash: string, name: string): string {
  return hash + name;
}

function imgFilename(hash: string, ext: string): string {
  return hash + ext;
}

// POST /doc：整体替换文档列表，并同步图片映射（返回本次需要上传的图片）
async function setDocs(request: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (err) {
    return json({ message: err instanceof Error ? err.message : String(err) }, 400);
  }
  if (!Array.isArray(payload)) {
    return json({ message: 'invalid doc list' }, 400);
  }
  const docs = payload as FileInfoShort[];

  // 按 img_key 去重，收集新列表中的全部图片
  const briefs = new Map<string, ImgBrief>();
  for (const doc of docs) {
    for (const img of doc?.imgs ?? []) {
      if (!img || typeof img.name !== 'string' || typeof img.hash !== 'string') continue;
      const key = imgKey(img.hash, img.name);
      if (!briefs.has(key)) briefs.set(key, img);
    }
  }

  const existing = await env.DB.prepare('SELECT img_key, filename FROM images').all<ImageRow>();
  const existingKeys = new Set(existing.results.map((row) => row.img_key));

  const addList: ImgBrief[] = [];
  const removedRows: ImageRow[] = [];
  for (const row of existing.results) {
    if (briefs.has(row.img_key)) continue;
    removedRows.push(row);
  }
  for (const [key, img] of briefs) {
    if (!existingKeys.has(key)) addList.push(img);
  }

  // 被删除映射对应的文件需要清理；仍被保留映射或新列表引用的文件除外
  const staleFilenames = new Set(removedRows.map((row) => row.filename));
  for (const row of existing.results) {
    if (briefs.has(row.img_key)) staleFilenames.delete(row.filename);
  }
  for (const img of briefs.values()) {
    staleFilenames.delete(imgFilename(img.hash, img.ext));
  }

  // 文档列表整体替换；图片映射只保留仍在上传列表中的 key（新映射由 POST /img 写入）
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM docs'),
  ];
  docs.forEach((doc, index) => {
    statements.push(
      env.DB.prepare('INSERT INTO docs (position, name, imgs) VALUES (?, ?, ?)').bind(
        index,
        doc?.name ?? '',
        JSON.stringify(doc?.imgs ?? []),
      ),
    );
  });
  for (const row of removedRows) {
    statements.push(env.DB.prepare('DELETE FROM images WHERE img_key = ?').bind(row.img_key));
  }
  await env.DB.batch(statements);

  await Promise.all([...staleFilenames].map((filename) => env.IMAGES.delete(filename)));

  return json({ message: 'success', data: addList });
}

// GET /doc：按原始顺序返回文档列表
async function getDocs(env: Env): Promise<Response> {
  const rows = await env.DB.prepare('SELECT name, imgs FROM docs ORDER BY position').all<{
    name: string;
    imgs: string;
  }>();
  if (rows.results.length === 0) {
    return json({ message: 'doc list is empty' }, 400);
  }
  const data: FileInfoShort[] = rows.results.map((row) => ({
    name: row.name,
    imgs: JSON.parse(row.imgs) as ImgBrief[],
  }));
  return json({ message: 'success', data });
}

// POST /img：上传图片到 R2，并记录 hash+name -> hash+ext 的映射
async function uploadImg(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    return json({ message: err instanceof Error ? err.message : String(err) }, 400);
  }

  const name = String(form.get('name') ?? '');
  const hash = String(form.get('hash') ?? '');
  const ext = String(form.get('ext') ?? '');
  if (!name || !hash || !ext) {
    return json({ message: 'some params are empty' }, 400);
  }

  const key = imgKey(hash, name);
  const filename = imgFilename(hash, ext);

  const exists = await env.DB.prepare('SELECT 1 AS ok FROM images WHERE img_key = ?')
    .bind(key)
    .first();
  if (exists) {
    return json({ message: 'img already exists' });
  }

  // 同一 hash+ext 的文件可能已存在，此时只补映射
  const head = await env.IMAGES.head(filename);
  if (!head) {
    const file = form.get('file');
    if (!(file instanceof File)) {
      return json({ message: 'file is missing' }, 400);
    }
    await env.IMAGES.put(filename, file.stream(), {
      httpMetadata: { contentType: file.type || mimeFromExt(ext) },
    });
  }

  await env.DB.prepare(
    'INSERT OR REPLACE INTO images (img_key, name, hash, ext, filename) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(key, name, hash, ext, filename)
    .run();

  return json({ message: 'success', data: filename });
}

// GET /img：按 hash+name 查映射，从 R2 读取对象
async function getImg(url: URL, env: Env): Promise<Response> {
  const name = url.searchParams.get('name') ?? '';
  const hash = url.searchParams.get('hash') ?? '';
  if (!name || !hash) {
    return json({ message: 'name or hash is empty' }, 400);
  }

  const row = await env.DB.prepare('SELECT filename FROM images WHERE img_key = ?')
    .bind(imgKey(hash, name))
    .first<{ filename: string }>();
  if (!row) {
    return json({ message: 'img not found' }, 400);
  }

  const object = await env.IMAGES.get(row.filename);
  if (!object) {
    return json({ message: 'img not found' }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', mimeFromExt(row.filename.slice(hash.length)));
  }
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=3600');
  return new Response(object.body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === '/ping' && method === 'GET') {
      return json({ message: 'pong' });
    }
    if (pathname === '/doc') {
      if (method === 'POST') return setDocs(request, env);
      if (method === 'GET') return getDocs(env);
    }
    if (pathname === '/img') {
      if (method === 'POST') return uploadImg(request, env);
      if (method === 'GET') return getImg(url, env);
    }

    // 静态资源（index.html 等）
    return env.ASSETS.fetch(request);
  },
};
