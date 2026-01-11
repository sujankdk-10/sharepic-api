// index.js (FULL FILE)
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");

const app = express();

// ----- CORS -----
// Set CORS_ORIGIN to your static site domain (recommended), or "*" for demo
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin }));

// JSON for non-multipart endpoints
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Helper to get container name from env (your env uses BLOB_CONTAINER_NAME)
function getContainerName() {
  return process.env.PHOTOS_CONTAINER || process.env.BLOB_CONTAINER_NAME;
}

function getBlobServiceClient() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING is missing");
  return BlobServiceClient.fromConnectionString(conn);
}

// Health check (useful for demo + debugging)
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ----- LIST PHOTOS (for index.html) -----
app.get("/api/photos", async (req, res) => {
  try {
    const containerName = getContainerName();
    if (!containerName) {
      return res.status(500).json({
        message: "Container env var missing. Set BLOB_CONTAINER_NAME (or PHOTOS_CONTAINER).",
      });
    }

    const blobServiceClient = getBlobServiceClient();
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Optional: check container exists
    const exists = await containerClient.exists();
    if (!exists) {
      return res.status(500).json({
        message: `Container '${containerName}' does not exist or cannot be accessed.`,
      });
    }

    const photos = [];
    for await (const blob of containerClient.listBlobsFlat()) {
      const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
      photos.push({
        imageUrl: blockBlobClient.url,
        title: blob.name, // TODO: replace with Cosmos title if you store metadata
        name: blob.name,
      });
    }

    // show newest-ish first (works because we prefix with uuid; not perfect but fine)
    photos.reverse();

    res.json(photos);
  } catch (err) {
    console.error("LIST ERROR:", err);
    res.status(500).json({ message: "Failed to list photos" });
  }
});

// ----- UPLOAD PHOTO (for creator.html) -----
app.post("/api/photos", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        message: "No image received. Ensure form field name is 'image'.",
      });
    }

    const containerName = getContainerName();
    if (!containerName) {
      return res.status(500).json({
        message: "Container env var missing. Set BLOB_CONTAINER_NAME (or PHOTOS_CONTAINER).",
      });
    }

    const blobServiceClient = getBlobServiceClient();
    const containerClient = blobServiceClient.getContainerClient(containerName);

    const exists = await containerClient.exists();
    if (!exists) {
      return res.status(500).json({
        message: `Container '${containerName}' does not exist or cannot be accessed.`,
      });
    }

    const safeOriginalName = req.file.originalname.replace(/[^\w.\-]/g, "_");
    const fileName = `${uuidv4()}-${safeOriginalName}`;

    const blockBlobClient = containerClient.getBlockBlobClient(fileName);

    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
    });

    res.status(201).json({
      message: "Upload successful",
      imageUrl: blockBlobClient.url,
      title: req.body.title || "",
      name: fileName,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

// ----- START SERVER -----
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
  console.log(`CORS origin: ${corsOrigin}`);
  console.log(`Container: ${getContainerName() || "(missing)"}`);
});

