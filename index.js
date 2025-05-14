const inquirer = require("inquirer");
const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const os = require("os");
const { exec } = require("child_process");
const archiver = require("archiver");
const directory = require("inquirer-directory");

// Initialization
const LOG_FILE = "scan-log.txt";
let SCANNED_FOLDER, COMPRESSED_FOLDER, READY_TO_UPLOAD_ZIPS;
const isWin = process.platform === "win32";
const gsPackage = isWin ? "gswin64c" : "gs"; // or use a relative path to bundled gs
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
inquirer.registerPrompt('directory', directory);


// Asking for Folder Names
async function promptForFolders() {
  const responses = await inquirer.prompt([
    {
      type: directory,
      name: "scanned",
      message: "📥 Enter path for SCANNED_FOLDER:",
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
    {
      type: directory,
      name: "compressed",
      message: "📦 Enter path for COMPRESSED_FOLDER:",
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
    {
      type: directory,
      name: "ready",
      message: "🚀 Enter path for READY_TO_UPLOAD_ZIPS:",
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
  ]);

  SCANNED_FOLDER = responses.scanned;
  COMPRESSED_FOLDER = responses.compressed;
  READY_TO_UPLOAD_ZIPS = responses.ready;
}

// Function to log with timestamp
function logEvent(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}${os.EOL}`;
  console.log(logMessage.trim());
  logStream.write(logMessage);
}

// Compress a PDF using Ghostscript
function compressPDF(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Ghostscript command explanation:
    // - "gswin64c"            → Windows 64-bit console version of Ghostscript // If mac/linx use gs
    // - -sDEVICE=pdfwrite     → Output device set to PDF (we are generating a PDF)
    // - -dCompatibilityLevel=1.4 → Sets the PDF version (1.4 is widely compatible)
    // - -dPDFSETTINGS=/ebook  → Compression quality preset (good balance of quality and size)
    //   Other options: /screen (lower quality), /printer (higher quality), /prepress (highest), /default
    // - -dNOPAUSE             → Don’t prompt and pause between pages
    // - -dQUIET               → Suppress routine information messages
    // - -dBATCH               → Exit after processing (no interactive mode)
    // - -sOutputFile=...      → Output file path
    // - inputPath             → Input file to compress
    const gsCmd = `"${gsPackage}" -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;

    // Execute the command
    exec(gsCmd, (error, stdout, stderr) => {
      if (error) {
        reject(`Compression failed: ${error.message}`);
      } else {
        resolve();
      }
    });
  });
}

function zipFolder(sourceFolder, zipFilePath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver("zip", {
      zlib: { level: 9 }, // Best compression
    });

    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    archive.directory(sourceFolder, false); // false to not include the folder itself
    archive.finalize();
  });
}

function waitForFolderToStabilize(folderPath, durationMs = 3000, interval = 1000) {
  return new Promise((resolve) => {
    let previousCount = 0;
    let stableTime = 0;

    const intervalId = setInterval(() => {
      const files = fs.readdirSync(folderPath).filter((f) => f.toLowerCase().endsWith(".pdf"));
      const currentCount = files.length;

      if (currentCount === previousCount) {
        stableTime += interval;
        if (stableTime >= durationMs) {
          clearInterval(intervalId);
          resolve();
        }
      } else {
        previousCount = currentCount;
        stableTime = 0; // reset if change is detected
      }
    }, interval);
  });
}

// Handle new folder
async function handleNewFolder(folderPath) {
  logEvent(`📂 New folder detected: ${folderPath}`);

  await waitForFolderToStabilize(folderPath, 4000); // wait 4 sec of file stability

  // Get folder name
  const folderName = path.basename(folderPath);
  const compressedTargetPath = path.join(COMPRESSED_FOLDER, folderName);

  // Ensure target compressed folder exists
  if (!fs.existsSync(compressedTargetPath)) {
    fs.mkdirSync(compressedTargetPath, { recursive: true });
  }

  // Extract only PDF files
  const files = fs.readdirSync(folderPath);
  console.log(files);
  const pdfs = files.filter((f) => f.toLowerCase().endsWith(".pdf"));
  console.log(pdfs);

  if (pdfs.length === 0) {
    logEvent(`⚠️ No PDFs found in ${folderPath}`);
    return;
  } else {
    logEvent(`📄 ${pdfs.length} PDF(s) found in ${folderPath}`);
  }

  for (const file of pdfs) {
    const fullPath = path.join(folderPath, file);
    const outputPath = path.join(compressedTargetPath, file);

    try {
      logEvent(`🔄 Compressing ${file}...`);
      await compressPDF(fullPath, outputPath);
      logEvent(`✅ Compressed: ${outputPath}`);
    } catch (err) {
      logEvent(`❌ Failed to compress ${file}: ${err}`);
    }
  }

  // After compressing all PDFs, zip the folder
  const zipFileName = `${folderName}.zip`;
  const zipFilePath = path.join(READY_TO_UPLOAD_ZIPS, zipFileName);

  try {
    logEvent(`📦 Zipping compressed folder: ${compressedTargetPath}`);
    await zipFolder(compressedTargetPath, zipFilePath);
    logEvent(`✅ Zipped folder stored at: ${zipFilePath}`);
  } catch (err) {
    logEvent(`❌ Failed to zip folder ${folderName}: ${err}`);
  }
}

const main = async () => {

  // Handle Input from the User
  await promptForFolders();

  // Watch for newly added folders only
  const watcher = chokidar.watch(SCANNED_FOLDER, {
    ignoreInitial: true,
    depth: 0, // Only top-level folders
    awaitWriteFinish: {
      stabilityThreshold: 10000,
      pollInterval: 500,
    },
  });

  watcher.on("addDir", (dirPath) => {
    handleNewFolder(dirPath); // Trigger compression logic
  });

  watcher.on("error", (error) => {
    logEvent(`❌ Watcher error: ${error}`);
  });

  logEvent(`📡 Watching folder: ${SCANNED_FOLDER}`)
};

main();
