const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

// Multer setup (in-memory storage)
const upload = multer({ storage: multer.memoryStorage() });

// Azure Blob setup
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME || "photos";

const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);

// Health check
app.get("/", (req, res) => res.send("SharePic API is running"));

// GET photos (mock)
app.get("/api/photos", (req, res) => {
  console.log("GET /api/photos hit!");
  res.json([{ id: 1, title: "Sample Photo", url: "https://via.placeholder.com/150" }]);
});

// POST photo (upload file to Azure Blob)
app.post("/api/photos", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.body.title) {
      return res.status(400).json({ error: "File and title are required" });
    }

    const blobName = `${uuidv4()}-${req.file.originalname}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
    });

    const imageUrl = blockBlobClient.url;
    console.log("Upload success:", imageUrl);

    res.json({ message: "Upload successful", imageUrl, title: req.body.title });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

// POST comment
app.post("/api/photos/:id/comments", (req, res) => {
  console.log(`POST /api/photos/${req.params.id}/comments hit! Body:`, req.body);
  res.json({ message: `Comment added for photo ${req.params.id}` });
});

// POST rating
app.post("/api/photos/:id/rating", (req, res) => {
  console.log(`POST /api/photos/${req.params.id}/rating hit! Body:`, req.body);
  res.json({ message: `Rating added for photo ${req.params.id}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
