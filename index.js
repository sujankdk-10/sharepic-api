const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require("uuid");

const app = express();

// ---- middleware ----
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// Multer for multipart/form-data image upload
const upload = multer({ storage: multer.memoryStorage() });

// ---- helpers ----
function getContainerName() {
  return process.env.PHOTOS_CONTAINER || process.env.BLOB_CONTAINER_NAME;
}

function getBlobServiceClient() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING missing");
  return BlobServiceClient.fromConnectionString(conn);
}

// Cosmos (create once)
function getCosmosContainers() {
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  const dbName = process.env.COSMOS_DB_NAME;
  const photosContainerName = process.env.COSMOS_CONTAINER; // photos
  const commentsContainerName = process.env.COSMOS_COMMENT_CONTAINER; // comments

  if (!endpoint || !key || !dbName) {
    throw new Error("Cosmos env vars missing: COSMOS_ENDPOINT/COSMOS_KEY/COSMOS_DB_NAME");
  }
  if (!photosContainerName) throw new Error("COSMOS_CONTAINER missing");
  if (!commentsContainerName) throw new Error("COSMOS_COMMENT_CONTAINER missing");

  const client = new CosmosClient({ endpoint, key });
  const db = client.database(dbName);

  return {
    photos: db.container(photosContainerName),
    comments: db.container(commentsContainerName),
  };
}

const cosmos = getCosmosContainers();

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---- GET photos (from Cosmos metadata) ----
app.get("/api/photos", async (req, res) => {
  try {
    const querySpec = {
      query: "SELECT * FROM c ORDER BY c.createdAt DESC",
    };

    const { resources } = await cosmos.photos.items.query(querySpec).fetchAll();
    res.json(resources);
  } catch (err) {
    console.error("LIST PHOTOS ERROR:", err);
    res.status(500).json({ message: "Failed to list photos" });
  }
});

// ---- POST upload photo (Blob + Cosmos metadata) ----
app.post("/api/photos", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No image received. Field name must be 'image'." });
    }

    const containerName = getContainerName();
    if (!containerName) {
      return res.status(500).json({ message: "Missing container env var (BLOB_CONTAINER_NAME or PHOTOS_CONTAINER)" });
    }

    const blobServiceClient = getBlobServiceClient();
    const containerClient = blobServiceClient.getContainerClient(containerName);

    const safeOriginalName = req.file.originalname.replace(/[^\w.\-]/g, "_");
    const blobName = `${uuidv4()}-${safeOriginalName}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
    });

    // Save metadata to Cosmos (photos container partition key is /id)
    const photoDoc = {
      id: uuidv4(), // partition key
      imageUrl: blockBlobClient.url,
      blobName,

      title: (req.body.title || "").trim(),
      caption: (req.body.caption || "").trim(),
      location: (req.body.location || "").trim(),
      people: (() => {
        const raw = (req.body.people || "").trim();
        if (!raw) return [];
        return raw.split(",").map(s => s.trim()).filter(Boolean);
      })(),

      createdAt: new Date().toISOString(),
    };

    await cosmos.photos.items.create(photoDoc);

    res.status(201).json({ message: "Upload successful", photo: photoDoc });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

// ---- COMMENTS ----
// comments container partition key is /photoId

// Get comments for photo
app.get("/api/photos/:photoId/comments", async (req, res) => {
  try {
    const { photoId } = req.params;

    const querySpec = {
      query: "SELECT * FROM c WHERE c.photoId = @photoId ORDER BY c.createdAt DESC",
      parameters: [{ name: "@photoId", value: photoId }],
    };

    const { resources } = await cosmos.comments.items.query(querySpec).fetchAll();
    res.json(resources);
  } catch (err) {
    console.error("GET COMMENTS ERROR:", err);
    res.status(500).json({ message: "Failed to get comments" });
  }
});

// Add comment to photo
app.post("/api/photos/:photoId/comments", async (req, res) => {
  try {
    const { photoId } = req.params;
    const text = (req.body.text || "").trim();
    const author = (req.body.author || "anonymous").trim();

    if (!text) return res.status(400).json({ message: "Comment text is required" });

    const commentDoc = {
      id: uuidv4(),
      photoId, // partition key value
      author,
      text,
      createdAt: new Date().toISOString(),
    };

    await cosmos.comments.items.create(commentDoc);

    res.status(201).json({ message: "Comment added", comment: commentDoc });
  } catch (err) {
    console.error("ADD COMMENT ERROR:", err);
    res.status(500).json({ message: "Failed to add comment" });
  }
});

// ---- start ----
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
  console.log(`CORS origin: ${corsOrigin}`);
  console.log(`Blob container: ${getContainerName() || "(missing)"}`);
});
