const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require("uuid");

const app = express();

// CORS
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin }));

// JSON (needed for comments)
app.use(express.json());

// Multer for multipart/form-data uploads
const upload = multer({ storage: multer.memoryStorage() });

// Helpers
function getBlobConnectionString() {
  return process.env.AZURE_STORAGE_CONNECTION_STRING;
}

function getBlobContainerName() {
  // Support both names so your current App Service settings work
  return process.env.BLOB_CONTAINER_NAME || process.env.PHOTOS_CONTAINER;
}

function getCosmos() {
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  const dbName = process.env.COSMOS_DB_NAME;
  const photosContainerName = process.env.COSMOS_CONTAINER; // photos
  const commentsContainerName = process.env.COSMOS_COMMENT_CONTAINER; // comments

  if (!endpoint || !key || !dbName) {
    throw new Error("Cosmos missing: COSMOS_ENDPOINT / COSMOS_KEY / COSMOS_DB_NAME");
  }
  if (!photosContainerName) throw new Error("Cosmos missing: COSMOS_CONTAINER (photos)");
  if (!commentsContainerName) throw new Error("Cosmos missing: COSMOS_COMMENT_CONTAINER (comments)");

  const client = new CosmosClient({ endpoint, key });
  const db = client.database(dbName);
  return {
    photos: db.container(photosContainerName),
    comments: db.container(commentsContainerName),
  };
}

// Health endpoint to verify env vars quickly
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    corsOrigin,
    hasStorageConn: !!process.env.AZURE_STORAGE_CONNECTION_STRING,
    blobContainer: getBlobContainerName() || null,
    hasCosmosEndpoint: !!process.env.COSMOS_ENDPOINT,
    cosmosDb: process.env.COSMOS_DB_NAME || null,
    cosmosPhotosContainer: process.env.COSMOS_CONTAINER || null,
    cosmosCommentsContainer: process.env.COSMOS_COMMENT_CONTAINER || null,
  });
});

/**
 * GET /api/photos
 * Returns photo metadata from Cosmos (preferred).
 * If Cosmos is misconfigured, returns a clear error message.
 */
app.get("/api/photos", async (req, res) => {
  try {
    const cosmos = getCosmos();
    const { resources } = await cosmos.photos.items
      .query({ query: "SELECT * FROM c ORDER BY c.createdAt DESC" })
      .fetchAll();
    res.json(resources);
  } catch (err) {
    console.error("LIST PHOTOS ERROR:", err);
    res.status(500).json({ message: err.message || "Failed to list photos" });
  }
});

/**
 * POST /api/photos
 * Uploads image to Blob Storage and saves metadata to Cosmos.
 * Returns clear error messages for debugging.
 */
app.post("/api/photos", upload.single("image"), async (req, res) => {
  try {
    // Validate file
    if (!req.file) {
      return res.status(400).json({
        message: "No image received. Frontend must send FormData field name 'image'.",
      });
    }

    // Validate storage config
    const conn = getBlobConnectionString();
    if (!conn) {
      return res.status(500).json({
        message: "AZURE_STORAGE_CONNECTION_STRING is missing in App Service settings.",
      });
    }

    const containerName = getBlobContainerName();
    if (!containerName) {
      return res.status(500).json({
        message: "Blob container env var missing. Set BLOB_CONTAINER_NAME (recommended).",
      });
    }

    // Blob upload
    const blobServiceClient = BlobServiceClient.fromConnectionString(conn);
    const containerClient = blobServiceClient.getContainerClient(containerName);

    const exists = await containerClient.exists();
    if (!exists) {
      return res.status(500).json({
        message: `Blob container '${containerName}' does not exist or cannot be accessed.`,
      });
    }

    const safeOriginalName = req.file.originalname.replace(/[^\w.\-]/g, "_");
    const blobName = `${uuidv4()}-${safeOriginalName}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
    });

    // Cosmos metadata save
    const cosmos = getCosmos();

    const photoDoc = {
      id: uuidv4(), // partition key in photos container is /id
      imageUrl: blockBlobClient.url,
      blobName,
      title: (req.body.title || "").trim(),
      caption: (req.body.caption || "").trim(),
      location: (req.body.location || "").trim(),
      people: ((req.body.people || "").trim())
        ? req.body.people.split(",").map(s => s.trim()).filter(Boolean)
        : [],
      createdAt: new Date().toISOString(),
    };

    await cosmos.photos.items.create(photoDoc);

    res.status(201).json({ message: "Upload successful", photo: photoDoc });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    // IMPORTANT: return the real message so you can debug quickly
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});

/**
 * COMMENTS (partition key in comments container is /photoId)
 * We use photoId = photo.id (from Cosmos photos list)
 */

// Get comments for a photo
app.get("/api/photos/:photoId/comments", async (req, res) => {
  try {
    const cosmos = getCosmos();
    const { photoId } = req.params;

    const { resources } = await cosmos.comments.items.query({
      query: "SELECT * FROM c WHERE c.photoId = @photoId ORDER BY c.createdAt DESC",
      parameters: [{ name: "@photoId", value: photoId }],
    }).fetchAll();

    res.json(resources);
  } catch (err) {
    console.error("GET COMMENTS ERROR:", err);
    res.status(500).json({ message: err.message || "Failed to get comments" });
  }
});

// Add comment to a photo
app.post("/api/photos/:photoId/comments", async (req, res) => {
  try {
    const cosmos = getCosmos();
    const { photoId } = req.params;
    const text = (req.body.text || "").trim();
    const author = (req.body.author || "anonymous").trim();

    if (!text) {
      return res.status(400).json({ message: "Comment text is required." });
    }

    const commentDoc = {
      id: uuidv4(),
      photoId, // partition key value for comments
      author,
      text,
      createdAt: new Date().toISOString(),
    };

    await cosmos.comments.items.create(commentDoc);

    res.status(201).json({ message: "Comment added", comment: commentDoc });
  } catch (err) {
    console.error("ADD COMMENT ERROR:", err);
    res.status(500).json({ message: err.message || "Failed to add comment" });
  }
});

// Start
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
  console.log(`CORS origin: ${corsOrigin}`);
  console.log(`Blob container: ${getBlobContainerName() || "(missing)"}`);
});
