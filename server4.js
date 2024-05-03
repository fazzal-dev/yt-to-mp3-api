const express = require("express");
const app = express();
const http = require("http").Server(app);
const cors = require("cors");
const path = require("path");
const ytdl = require("ytdl-core");
const fs = require("fs");
const jwt = require("jsonwebtoken");

const SECRET_KEY = "1125";

const tempDir = path.join(__dirname, "temp", "audio.mp3");

app.use(cors({ origin: "*", credentials: true }));

const PORT = 3002;

const io = require("socket.io")(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

io.on("connection", (socket) => {
  console.log("A User Connected: ", socket.id);
  socket.on("startDownloading", (data) => {
    try {
      const { videoId, videoTitle } = jwt.verify(data.token, SECRET_KEY);
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const writeStream = fs.createWriteStream(tempDir);
      let audioStream = ytdl(videoUrl, {
        quality: "highestaudio",
        filter: "audioonly",
      });

      audioStream.on("progress", (_, downloaded, total) => {
        const percent = ((downloaded / total) * 100).toFixed(1);
        console.log(percent);
        socket.emit("progress", percent);
      });

      audioStream.pipe(writeStream);
      console.log("Video Downloaded and Converted Successfully");

      const downloadToken = jwt.sign(
        {
          videoTitle,
          downloadUrl: `http:localhost:3002/download/${videoId}`,
        },
        SECRET_KEY,
        { expiresIn: "15" }
      );
      socket.emit("downloadReady", downloadToken);

      audioStream.on("error", (error) => {
        console.log("Error downloading video: ", error);
        res.status(500).json({ error: "Error downloading video" });
      });
    } catch (error) {
      console.log("Error verifying token: ", error);
      socket.emit("error", "Invalid token");
      res.status(500).json({ error: "Error verify token" });
    }
  });
});

app.get("/download/:videoId", (req, res) => {
  const videoId = req.params.videoId;
  const filePath = path.join(__dirname, "temp", `audio-${videoId}.mp3`);

  // Verify the JWT token from the client
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    if (decoded.downloadUrl !== `http:localhost:3002/download/${videoId}`) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Send the MP3 file for download
    res.download(filePath, `${decoded.videoTitle}.mp3`, (err) => {
      if (err) {
        console.log("Error sending file: ", err);
        res.status(500).json({ error: "Error sending file" });
      } else {
        console.log("File downloaded successfully");
        // Delete the file after download
        fs.unlink(filePath, (err) => {
          if (err) {
            console.log("Error deleting file: ", err);
          }
        });
      }
    });
  } catch (err) {
    console.log("Error verifying token: ", err);
    res.status(401).json({ error: "Unauthorized" });
  }
});

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
