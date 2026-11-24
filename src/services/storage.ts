import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import type { Readable } from "node:stream";
import { config } from "../config.js";
import { notFound, unavailable } from "../http/errors.js";

export const MAX_FILE_BYTES = 52_428_800; // Same 50 MB limit as the Supabase bucket.

let service: BlobServiceClient | undefined;
let ready: Promise<ContainerClient> | undefined;

function container(): Promise<ContainerClient> {
  if (!ready) {
    if (!config.storage.connectionString) {
      throw unavailable("File storage is not configured");
    }
    service ??= BlobServiceClient.fromConnectionString(config.storage.connectionString);
    const client = service.getContainerClient(config.storage.container);
    // Created without public access, so blobs are reachable only through this API.
    ready = client.createIfNotExists().then(() => client);
    ready.catch(() => {
      ready = undefined;
    });
  }
  return ready;
}

export async function putObject(
  path: string,
  data: Buffer,
  contentType = "application/octet-stream"
): Promise<void> {
  const client = await container();
  await client.getBlockBlobClient(path).uploadData(data, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

export async function getObjectStream(
  path: string
): Promise<{ stream: Readable; contentType?: string; contentLength?: number }> {
  const client = await container();
  try {
    const response = await client.getBlobClient(path).download();
    return {
      stream: response.readableStreamBody as Readable,
      contentType: response.contentType,
      contentLength: response.contentLength,
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) throw notFound("File content not found");
    throw err;
  }
}

export async function getObjectBuffer(path: string): Promise<Buffer> {
  const client = await container();
  try {
    return await client.getBlobClient(path).downloadToBuffer();
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) throw notFound("File content not found");
    throw err;
  }
}

export async function objectExists(path: string): Promise<boolean> {
  const client = await container();
  return client.getBlobClient(path).exists();
}

export async function removeObjects(paths: string[]): Promise<void> {
  const client = await container();
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
      await client.getBlobClient(path).deleteIfExists();
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}
