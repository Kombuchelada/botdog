import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

let cachedClient = null;

function client() {
  if (cachedClient) return cachedClient;
  const endpoint = process.env.DO_SPACES_ENDPOINT;
  const key = process.env.DO_SPACES_KEY;
  const secret = process.env.DO_SPACES_SECRET;
  if (!endpoint || !key || !secret) {
    throw new Error(
      "DO Spaces is not configured (need DO_SPACES_ENDPOINT, DO_SPACES_KEY, DO_SPACES_SECRET)",
    );
  }
  // Pull region out of the endpoint (e.g. "https://sfo3.digitaloceanspaces.com" -> "sfo3").
  // The S3 SDK insists on a region for signing; DO ignores its value but requires it set.
  const region = endpoint.replace(/^https?:\/\//, "").split(".")[0] || "us-east-1";
  cachedClient = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: key, secretAccessKey: secret },
    forcePathStyle: false, // DO Spaces uses bucket-as-subdomain
  });
  return cachedClient;
}

function publicBase() {
  const base = process.env.DO_SPACES_PUBLIC_BASE;
  if (!base) throw new Error("DO_SPACES_PUBLIC_BASE not set");
  return base.replace(/\/+$/, "");
}

function bucket() {
  const b = process.env.DO_SPACES_BUCKET;
  if (!b) throw new Error("DO_SPACES_BUCKET not set");
  return b;
}

/**
 * Upload a Buffer/Uint8Array to DO Spaces under `key`. Returns the public URL.
 * Objects are uploaded with ACL=public-read so the browser can fetch them directly.
 */
export async function uploadObject(key, body, contentType) {
  await client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
      ACL: "public-read",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return `${publicBase()}/${encodeURI(key)}`;
}

/**
 * Delete every object under a given key prefix. Returns the number deleted.
 * Paginates 1000 keys at a time via ListObjectsV2 + DeleteObjects.
 */
export async function deletePrefix(prefix) {
  const c = client();
  const b = bucket();
  let token = undefined;
  let totalDeleted = 0;
  do {
    const list = await c.send(
      new ListObjectsV2Command({
        Bucket: b,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    const keys = (list.Contents || []).map((o) => ({ Key: o.Key }));
    if (keys.length > 0) {
      await c.send(
        new DeleteObjectsCommand({
          Bucket: b,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
      totalDeleted += keys.length;
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  return totalDeleted;
}

/**
 * List every object under a key prefix as `{ key, size, lastModified }`.
 * Paginates like deletePrefix does; a prefix with no matches returns [].
 */
export async function listObjects(prefix) {
  const c = client();
  const b = bucket();
  let token = undefined;
  const out = [];
  do {
    const list = await c.send(
      new ListObjectsV2Command({
        Bucket: b,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    for (const o of list.Contents || []) {
      out.push({ key: o.Key, size: o.Size, lastModified: o.LastModified });
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/**
 * Delete an explicit list of keys. Unlike deletePrefix this deletes only what
 * it is handed, which is what any retention policy needs — a prefix delete
 * cannot express "keep some of these". Returns the number deleted.
 */
export async function deleteObjects(keys) {
  if (!keys.length) return 0;
  const c = client();
  const b = bucket();
  let totalDeleted = 0;
  // DeleteObjects caps at 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map((Key) => ({ Key }));
    await c.send(
      new DeleteObjectsCommand({
        Bucket: b,
        Delete: { Objects: batch, Quiet: true },
      }),
    );
    totalDeleted += batch.length;
  }
  return totalDeleted;
}

export function isSpacesConfigured() {
  return !!(
    process.env.DO_SPACES_ENDPOINT &&
    process.env.DO_SPACES_KEY &&
    process.env.DO_SPACES_SECRET &&
    process.env.DO_SPACES_BUCKET &&
    process.env.DO_SPACES_PUBLIC_BASE
  );
}
