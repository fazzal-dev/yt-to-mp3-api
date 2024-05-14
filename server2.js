const express = require("express");
const ytdl = require("ytdl-core");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ytsr = require("ytsr");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const requestIp = require("request-ip");
const dotenv = require("dotenv");
const tempDir = path.join(__dirname, "temp");
const geoip = require("geoip-lite");

dotenv.config();
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

if (!fs.existsSync(tempDir)) {
  try {
    fs.mkdir(tempDir);
  } catch (err) {
    console.error(`Error creating directory: ${err.message}`);
  }
}

const io = require("socket.io")(3002, {
  cors: {
    origin: "*",
  },
});

const SECRET_KEY = process.env.SECRET_KEY;

const app = express();
app.use(cors({ origin: "*" }));
const PORT = 3001;

app.use((req, res, next) => {
  const ip = req.clientIp;
  const geo = geoip.lookup(ip);
  const country = geo ? geo.country : "Unknown";
  req.clientCountry = country;
  next();
});

app.get("/", async (req, res) => {
  try {
    const { videoId } = req.query;
    if (!videoId) {
      return res.status(400).json({ error: "Missing required parameters" });
    }
    const { videoTitle, videoInfo } = await getVideoInfo(videoId);
    const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    const duration = formatDuration(videoInfo.videoDetails.lengthSeconds);
    const formats = videoInfo.formats;
    const mp4Formats = videoInfo.formats
      .filter(
        (format) =>
          format.codecs === "vp9" &&
          format.qualityLabel &&
          parseInt(format.qualityLabel.replace("p", "")) <= 1080
      )
      .map((format) => ({
        mimeType: format.mimeType,
        qualityLabel: format.qualityLabel,
        bitrate: format.bitrate,
        size: format.contentLength
          ? Math.ceil(parseInt(format.contentLength) / 1048576)
          : null,
      }));

    const mp3Format = {
      mimeType: "audio/mp3",
      qualityLabel: "128kbps",
      bitrate: 128000,
      size: null,
    };

    res.json({
      title: videoTitle,
      thumbnail: thumbnailUrl,
      duration: duration,
      //   formats,
      mp4Formats,
      mp3Format,
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "An error occurred" });
  }
});

io.on("connection", async (socket) => {
  const ip = socket.request.connection.remoteAddress;
  const geo = geoip.lookup(ip);
  const country = geo ? geo.country : "Unknown";

  const logMessage = `User connected: ${socket.id}\nCountry: ${country}`;
  printBoxedLog(logMessage);

  socket.emit("secretkey", SECRET_KEY);
  socket.on("downloadMp3", async (data) => {
    try {
      const payload = jwt.verify(data, SECRET_KEY);
      const { videoTitle, videoUrl } = await getVideoInfo(payload.id);
      const outputPath = `${tempDir}/${Date.now()}${Math.round(
        Math.random() * 1e9
      )}-${payload.id}.mp3`;
      const writeStream = fs.createWriteStream(outputPath);
      const audio = ytdl(videoUrl, { quality: "highest", filter: "audioonly" });

      audio.on("progress", (_, downloaded, total) => {
        const percent = ((downloaded / total) * 100).toFixed(1);
        io.emit("progress", percent);
      });
      audio.pipe(writeStream);
      audio.on("finish", () => {
        console.log("Conversion to Mp3 Complete");
        const fileName = path.basename(outputPath);
        const token = jwt.sign(
          {
            title: videoTitle,
            fileName: fileName,
          },
          SECRET_KEY
        );
        io.emit(
          "finish",
          jwt.sign(
            {
              videoTitle,
              url: `http://162.55.212.83:3001/download/${token}`,
            },
            SECRET_KEY
          )
        );
      });
    } catch (error) {
      console.error("Error fetching video info:", error);
    }
  });
  socket.on("downloadMp4", async (data) => {
    try {
      const payload = jwt.verify(data, SECRET_KEY);
      if (!payload.id) {
        socket.emit("error", { error: "Missing videoId parameter" });
        return;
      }
      const videoUrl = `https://www.youtube.com/watch?v=${payload.id}`;

      const { videoTitle } = await getVideoInfo(payload.id);

      const audio = ytdl(videoUrl, { quality: "highestaudio" });
      const video = ytdl(videoUrl, { quality: "highestvideo" });

      const filePathBase = `${tempDir}/${Date.now()}${Math.round(
        Math.random() * 1e9
      )}-${payload.id}`;
      const audioPath = `${filePathBase}-audio.mp3`;
      const videoPath = `${filePathBase}-video.mp4`;
      const outputPath = `${filePathBase}.mp4`;

      audio.pipe(fs.createWriteStream(audioPath));
      video.pipe(fs.createWriteStream(videoPath));

      let audioDownloaded = false;
      let videoDownloaded = false;

      audio.on("end", () => {
        console.log("Audio downloaded");
        audioDownloaded = true;
        checkIfDownloaded();
      });

      video.on("end", () => {
        console.log("Video downloaded");
        videoDownloaded = true;
        checkIfDownloaded();
      });

      function checkIfDownloaded() {
        if (audioDownloaded && videoDownloaded) {
          console.log("Start merging");
          ffmpeg()
            .input(audioPath)
            .input(videoPath)
            .outputOptions(["-c:v copy", "-c:a aac", "-strict experimental"])
            .on("progress", (progress) => {
              console.log("Merging progress:", progress.percent);
              socket.emit("progress", progress.percent);
            })
            .on("end", () => {
              console.log("Merging completed");
              const fileName = path.basename(outputPath);
              const token = jwt.sign(
                {
                  title: videoTitle,
                  fileName: fileName,
                },
                SECRET_KEY
              );
              socket.emit(
                "finish",
                jwt.sign(
                  {
                    videoTitle,
                    url: `http://162.55.212.83:3001/download/${token}`,
                  },
                  SECRET_KEY
                )
              );
              deleteFile(audioPath);
              deleteFile(videoPath);
            })
            .on("error", (err) => {
              console.error("Error during merging:", err);
              socket.emit("error", {
                error: "An error occurred during merging",
              });
              deleteFile(audioPath);
              deleteFile(videoPath);
            })
            .save(outputPath);
        }
      }
    } catch (err) {
      console.error("Error:", err);
      socket.emit("error", { error: "An error occurred" });
    }
  });
});

app.get("/download/:token", async (req, res) => {
  try {
    const { format } = req.query;
    const payload = await jwt.verify(req.params.token, SECRET_KEY);
    const filePath = `${tempDir}/${payload.fileName}`;

    const ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
    const geo = geoip.lookup(ip);
    const country = geo ? geo.country : "Unknown";
    const message = `File downloaded: ${payload.title}\nUser country: ${country}`;
    printBoxedLog(message);
    if (format === "mp4") {
      res.download(
        filePath,
        `${process.env.DOMAIN} - ${payload.title}.mp4`,
        (err) => {
          if (err) {
            deleteFile(filePath);
            console.error("Error downloading file:", err);
            if (!res.headersSent) {
              deleteFile(filePath);
              res
                .status(500)
                .json({ error: "An error occurred while downloading" });
            }
          } else {
            console.log("File downloaded successfully");
          }
        }
      );
    } else if (format === "mp3") {
      res.download(
        filePath,
        `${process.env.DOMAIN} - ${payload.title}.mp3`,
        (err) => {
          if (err) {
            deleteFile(filePath);
            console.error("Error downloading file:", err);
            if (!res.headersSent) {
              deleteFile(filePath);
              res
                .status(500)
                .json({ error: "An error occurred while downloading" });
            }
          } else {
            console.log("File downloaded successfully");
          }
        }
      );
    } else {
      res.status(400).json({ error: "Invalid format. Use 'mp3' or 'mp4'." });
    }

    res.on("finish", () => {
      deleteFile(filePath);
    });
  } catch (err) {
    deleteFile(filePath);
    console.error("Error:", err);
    res.status(500).json({ error: "An error occurred" });
  }
});

app.get("/search", async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword) {
      return res.status(400).json({ error: "Missing keyword parameter" });
    }
    const sanitizedKeyword = keyword.replace(/\s+/g, "");

    const searchResults = await ytsr(sanitizedKeyword, { limit: 20 });
    const videos = searchResults.items
      .filter((item) => item.type === "video")
      .map((item) => ({
        title: item.title,
        videoId: item.id,
        thumbnail: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
      }));

    res.json({ videos });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "An error occurred" });
  }
});

async function getVideoInfo(videoId) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const videoInfo = await ytdl.getInfo(videoUrl);
  const videoTitle = videoInfo.videoDetails.title;
  const sanitizedTitle = videoTitle.replace(/[^\w]/g, "");
  const fileName = `${sanitizedTitle}.mp3`;
  return { videoInfo, videoTitle, sanitizedTitle, fileName, videoUrl };
}

function deleteFile(filePath) {
  fs.access(filePath, fs.constants.F_OK, (accessErr) => {
    if (!accessErr) {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          console.error("Error deleting file:", unlinkErr);
        } else {
          console.log("File deleted successfully");
        }
      });
    }
  });
}

function formatDuration(durationInSeconds) {
  const minutes = Math.floor(durationInSeconds / 60);
  const seconds = durationInSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const printBoxedLog = (message) => {
  const boxWidth = 60;
  const horizontalLine = "-".repeat(boxWidth);
  const emptyLine = "|" + " ".repeat(boxWidth - 2) + "|";

  const now = new Date();
  const dateTime = now.toLocaleString();

  const fullMessage = `[${dateTime}]\n${message}`;
  const wrappedMessage = fullMessage
    .match(new RegExp(".{1," + (boxWidth - 4) + "}", "g"))
    .map((line) => {
      const padding = boxWidth - 2 - line.length;
      return "|" + line + " ".repeat(padding) + "|";
    })
    .join("\n");

  console.log(horizontalLine);
  console.log(emptyLine);
  console.log(wrappedMessage);
  console.log(emptyLine);
  console.log(horizontalLine);
};

// Example usage:
printBoxedLog(
  "This is a test message to demonstrate the boxed log with date and time."
);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
