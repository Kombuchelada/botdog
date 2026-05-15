import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

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

export function isSpacesConfigured() {
  return !!(
    process.env.DO_SPACES_ENDPOINT &&
    process.env.DO_SPACES_KEY &&
    process.env.DO_SPACES_SECRET &&
    process.env.DO_SPACES_BUCKET &&
    process.env.DO_SPACES_PUBLIC_BASE
  );
}
