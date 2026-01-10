const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());

// ---------- MULTER (memory upload) ----------
const upload = multer({ storage: multer.memoryStorage() });

// ---------- AZURE BLOB ----------
const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING
);
const containerClient = blobServiceClient.getContainerClient(
  process.env.BLOB_CONTAINER_NAME
);

// ---------- COSMOS ----------
const cosmosClient = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY
});
const database = cosmosClient.database(process.env.COSMOS_DB_NAME);
const photosContainer = database.container(process.env.COSMOS_CONTAINER);

// ---------- HEALTH ----------
app.get("/", (req, res) => {
  res.send("SharePic API is running");
});

// ---------- GET ALL PHOTOS ----------
app.get("/api/photos", async (req, res) => {
  try {
    const { resources } = await photosContainer.items
      .query("SELECT * FROM c ORDER BY c.createdAt DESC")
      .fetchAll();

    res.json(resources);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch photos" });
  }
});

// ---------- POST PHOTO (REAL UPLOAD) ----------
app.post("/api/photos", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.body.title) {
      return res.status(400).json({ error: "Title and file required" });
    }

    const id = uuidv4();
    const blobName = `${id}-${req.file.originalname}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype }
    });

    const imageUrl = blockBlobClient.url;

    const photoDoc = {
      id,
      title: req.body.title,
      imageUrl,
      createdAt: new Date().toISOString()
    };

    await photosContainer.items.create(photoDoc);

    res.json({
      message: "Upload successful",
      imageUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ---------- COMMENTS ----------
app.post("/api/photos/:id/comments", async (req, res) => {
  res.json({ message: "Comment endpoint ready" });
});

// ---------- RATING ----------
app.post("/api/photos/:id/rating", async (req, res) => {
  res.json({ message: "Rating endpoint ready" });
});

// ---------- START ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
