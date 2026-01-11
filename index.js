const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require("uuid");

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

function getBlobConnectionString() {
  return process.env.AZURE_STORAGE_CONNECTION_STRING;
}

function getBlobContainerName() {
  return process.env.BLOB_CONTAINER_NAME || process.env.PHOTOS_CONTAINER;
}

function getCosmosConfig() {
  return {
    endpoint: process.env.COSMOS_ENDPOINT,
    key: process.env.COSMOS_KEY,
    dbName: process.env.COSMOS_DB_NAME,
    photosContainerName: process.env.COSMOS_CONTAINER, // photos
    commentsContainerName: process.env.COSMOS_COMMENT_CONTAINER, // comments
  };
}

async function verifyAndGetCosmosContainers() {
  const cfg = getCosmosConfig();

  if (!cfg.endpoint || !cfg.key || !cfg.dbName) {
    throw new Error("Cosmos missing: COSMOS_ENDPOINT / COSMOS_KEY / COSMOS_DB_NAME");
  }
  if (!cfg.photosContainerName) {
    throw new Error("Cosmos missing: COSMOS_CONTAINER (expected 'photos')");
  }
  if (!cfg.commentsContainerName) {
    throw new Error("Cosmos missing: COSMOS_COMMENT_CONTAINER (expected 'comments')");
  }

  const client = new CosmosClient({ endpoint: cfg.endpoint, key: cfg.key });
  const db = client.database(cfg.dbName);

  // Verify DB exists
  await db.read().catch(() => {
    throw new Error(
      `Cosmos database '${cfg.dbName}' not found. (Most likely COSMOS_DB_NAME is wrong — it must be the DATABASE name from Data Explorer, not the account name.)`
    );
  });

  const photos = db.container(cfg.photosContainerName);
  const comments = db.container(cfg.commentsContainerName);

  // Verify containers exist
  await photos.read().catch(() => {
    throw new Error(
      `Cosmos container '${cfg.photosContainerName}' not found in database '${cfg.dbName}'.`
    );
  });

  await comments.read().catch(() => {
    throw new Error(
      `Cosmos container '${cfg.commentsContainerName}' not found in database '${cfg.dbName}'.`
    );
  });

  return { photos, comments };
}

app.get("/api/health", async (req, res) => {
  const cfg = getCosmosConfig();

  const base = {
    ok: true,
    time: new Date().toISOString(),
    corsOrigin,
    hasStorageConn: !!getBlobConnectionString(),
    blobContainer: getBlobContainerName() || null,
    hasCosmosEndpoint: !!cfg.endpoint,
    cosmosDb: cfg.dbName || null,
    cosmosPhotosContainer: cfg.photosContainerName || null,
    cosmosCommentsContainer: cfg.commentsContainerName || null,
  };

  try {
    await verifyAndGetCosmosContainers();
    res.json({ ...base, cosmosStatus: "OK (DB + containers readable)" });
  } catch (e) {
    res.json({ ...base, cosmosStatus: "NOT OK", cosmosError: e.message });
  }
});

app.get("/api/photos", async (req, res) => {
  try {
    const cosmos = await verifyAndGetCosmosContainers();
    const { resources } = await cosmos.photos.items
      .query({ query: "SELECT * FROM c ORDER BY c.createdAt DESC" })
      .fetchAll();
    res.json(resources);
  } catch (err) {
    console.error("LIST PHOTOS ERROR:", err);
    res.status(500).json({ message: err.message || "Failed to list photos" });
  }
});

app.post("/api/photos", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        message: "No image received. Frontend must send FormData field name 'image'.",
      });
    }

    const conn = getBlobConnectionString();
    if (!conn) {
      return res.status(500).json({
        message: "AZURE_STORAGE_CONNECTION_STRING missing in App Service settings.",
      });
    }

    const containerName = getBlobContainerName();
    if (!containerName) {
      return res.status(500).json({
        message: "Blob container missing. Set BLOB_CONTAINER_NAME (recommended).",
      });
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(conn);
    const containerClient = blobServiceClient.getContainerClient(containerName);

    const containerExists = await containerClient.exists();
    if (!containerExists) {
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

    const cosmos = await verifyAndGetCosmosContainers();

    const photoDoc = {
      id: uuidv4(), // partition key /id
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
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});

app.get("/api/photos/:photoId/comments", async (req, res) => {
  try {
    const cosmos = await verifyAndGetCosmosContainers();
    const { photoId } = req.params;

    const { resources } = await cosmos.comments.items
      .query({
        query: "SELECT * FROM c WHERE c.photoId = @photoId ORDER BY c.createdAt DESC",
        parameters: [{ name: "@photoId", value: photoId }],
      })
      .fetchAll();

    res.json(resources);
  } catch (err) {
    console.error("GET COMMENTS ERROR:", err);
    res.status(500).json({ message: err.message || "Failed to get comments" });
  }
});

app.post("/api/photos/:photoId/comments", async (req, res) => {
  try {
    const cosmos = await verifyAndGetCosmosContainers();
    const { photoId } = req.params;

    const text = (req.body.text || "").trim();
    const author = (req.body.author || "anonymous").trim();

    if (!text) return res.status(400).json({ message: "Comment text is required." });

    const commentDoc = {
      id: uuidv4(),
      photoId, // partition key /photoId
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API listening on port ${port}`));
