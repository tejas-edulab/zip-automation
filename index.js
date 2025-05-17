import inquirer from "inquirer";
import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import os from "os";
import { exec } from "child_process";
import archiver from "archiver";
import directory from "inquirer-directory";
import pdf from "pdf-parse";
import dns from "node:dns";

// Initialization
const CSV_LOG_FILE = "scan-log.csv";
const LOG_FILE = "scan-log.txt";
const PDF_REPORT_FILE = "pdf-report.csv";
const MAX_FILES_PER_UPLOAD = 5; // Maximum files to upload in one batch
let SCANNER_NAME, PC_NAME;

// Initialize folder paths
const DEFAULT_PATHS = {
  SCANNED_FOLDER: path.join(process.cwd(), "SCANNED_FOLDER"),
  COMPRESSED_FOLDER: path.join(process.cwd(), "COMPRESSED_FOLDER"),
  READY_TO_UPLOAD_ZIPS: path.join(process.cwd(), "READY_TO_UPLOAD_FOLDER"),
  LINEARIZED_FOLDER: path.join(process.cwd(), "LINEARIZED_FOLDER"),
  UPLOAD_FOLDER: path.join(process.cwd(), "UPLOAD_FOLDER"),
  ERROR_FOLDER: path.join(process.cwd(), "ERROR_FOLDER"),
  SYSTEM_UPLOADED: path.join(process.cwd(), "SYSTEM_UPLOADED"),
  UPLOAD_ERROR: path.join(process.cwd(), "UPLOAD_ERROR"),
};

let SCANNED_FOLDER = DEFAULT_PATHS.SCANNED_FOLDER;
let COMPRESSED_FOLDER = DEFAULT_PATHS.COMPRESSED_FOLDER;
let READY_TO_UPLOAD_ZIPS = DEFAULT_PATHS.READY_TO_UPLOAD_ZIPS;
let LINEARIZED_FOLDER = DEFAULT_PATHS.LINEARIZED_FOLDER;
let UPLOAD_FOLDER = DEFAULT_PATHS.UPLOAD_FOLDER;
let ERROR_FOLDER = DEFAULT_PATHS.ERROR_FOLDER;
let SYSTEM_UPLOADED = DEFAULT_PATHS.SYSTEM_UPLOADED;
let UPLOAD_ERROR = DEFAULT_PATHS.UPLOAD_ERROR;

const isWin = process.platform === "win32";
const gsPackage = isWin ? "gswin64c" : "gs";
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
inquirer.registerPrompt("directory", directory);

// CSV Logger
function logCsvEvent({ folder, file, status, action, message }) {
  const timestamp = new Date().toISOString();
  const row = `"${timestamp}","${SCANNER_NAME}","${PC_NAME}","${folder}","${file}","${status}","${action}","${message.replace(/"/g, '""')}"\n`;
  fs.appendFileSync(CSV_LOG_FILE, row);
}

// Ask for folders
async function promptForFolders() {
  // Create default folders if they don't exist
  Object.values(DEFAULT_PATHS).forEach((folder) => {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
  });

  const responses = await inquirer.prompt([
    {
      type: "input",
      name: "scanner",
      message: "🧍 Scanner Name / ID:",
      default: `Scanner-01`,
      validate: (input) => input.trim() !== "" || "Scanner name required",
    },
    {
      type: "input",
      name: "pc",
      message: "💻 PC Name / No:",
      default: os.hostname(),
      validate: (input) => input.trim() !== "" || "PC name required",
    },
    {
      type: "input",
      name: "scanned",
      message: "📥 Enter path for SCANNED_FOLDER:",
      default: DEFAULT_PATHS.SCANNED_FOLDER,
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
    {
      type: "input",
      name: "compressed",
      message: "📦 Enter path for COMPRESSED_FOLDER:",
      default: DEFAULT_PATHS.COMPRESSED_FOLDER,
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
    {
      type: "input",
      name: "ready",
      message: "🚀 Enter path for READY_TO_UPLOAD_FOLDER:",
      default: DEFAULT_PATHS.READY_TO_UPLOAD_ZIPS,
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
    {
      type: "input",
      name: "linearized",
      message: "📄 Enter path for LINEARIZED_FOLDER:",
      default: DEFAULT_PATHS.LINEARIZED_FOLDER,
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
  ]);

  SCANNED_FOLDER = responses.scanned;
  COMPRESSED_FOLDER = responses.compressed;
  READY_TO_UPLOAD_ZIPS = responses.ready;
  SCANNER_NAME = responses.scanner;
  PC_NAME = responses.pc;
  LINEARIZED_FOLDER = responses.linearized;

  // Create additional folders if they don't exist
  [UPLOAD_FOLDER, ERROR_FOLDER, SYSTEM_UPLOADED, UPLOAD_ERROR].forEach((folder) => {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
  });
}

// Plain logger
function logEvent(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}${os.EOL}`;
  console.log(logMessage.trim());
  logStream.write(logMessage);
}

// Compress PDF
function compressPDF(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Ghostscript command explanation:
    // - "gswin64c"            → Windows 64-bit console version of Ghostscript // If mac/linx use gs
    // - -sDEVICE=pdfwrite     → Output device set to PDF (we are generating a PDF)
    // - -dCompatibilityLevel=1.4 → Sets the PDF version (1.4 is widely compatible)
    // - -dPDFSETTINGS=/ebook  → Compression quality preset (good balance of quality and size)
    //   Other options: /screen (lower quality), /printer (higher quality), /prepress (highest), /default
    // - -dNOPAUSE             → Don't prompt and pause between pages
    // - -dQUIET               → Suppress routine information messages
    // - -dBATCH               → Exit after processing (no interactive mode)
    // - -sOutputFile=...      → Output file path
    // - inputPath             → Input file to compress
    const gsCmd = `"${gsPackage}" -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;

    exec(gsCmd, (error, stdout, stderr) => {
      if (error) {
        reject(`Compression failed: ${error.message}`);
      } else {
        resolve();
      }
    });
  });
}

// Zip folder
function zipFolder(sourceFolder, zipFilePath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver("zip", {
      zlib: { level: 9 },
    });

    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    archive.directory(sourceFolder, false);
    archive.finalize();
  });
}

// Wait for folder stability
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
        stableTime = 0;
      }
    }, interval);
  });
}

// Enhanced PDF Report function with proper error handling
async function generatePDFReport(pdfPath) {
  try {
    if (!fs.existsSync(pdfPath)) {
      throw new Error("PDF file does not exist");
    }

    const dataBuffer = fs.readFileSync(pdfPath);

    let pdfData;
    try {
      pdfData = await pdf(dataBuffer, {
        max: 1, // Only process first page for quick metadata access
      });
    } catch (pdfError) {
      // If PDF parsing fails, continue with basic file info
      pdfData = {
        numpages: 0,
        info: {},
      };
      logEvent(`⚠️ PDF parsing warning for ${pdfPath}: ${pdfError.message}`);

      console.log(pdfError);
      throw new Error(pdfError);
    }

    const fileStats = fs.statSync(pdfPath);
    const fileSizeInMB = (fileStats.size / (1024 * 1024)).toFixed(2);
    const baseFolder = path.basename(path.dirname(pdfPath));
    const fileName = path.basename(pdfPath);

    console.log("PDF Data ", pdfData);

    const reportData = {
      timestamp: new Date().toISOString(),
      scannerName: SCANNER_NAME || "Unknown",
      pcName: PC_NAME || "Unknown",
      fileName: fileName,
      baseFolder: baseFolder,
      location: pdfPath,
      pageCount: pdfData.numpages || 0,
      fileSizeInMB: fileSizeInMB,
      title: pdfData.info?.Title || "N/A",
      author: pdfData.info?.Author || "N/A",
      creationDate: pdfData.info?.CreationDate || "N/A",
    };

    return reportData;
  } catch (error) {
    logEvent(`⚠️ Error generating PDF report for ${pdfPath}: ${error.message}`);
    // Return basic file information even if detailed PDF parsing fails
    const fileStats = fs.statSync(pdfPath);
    const fileSizeInMB = (fileStats.size / (1024 * 1024)).toFixed(2);
    return {
      timestamp: new Date().toISOString(),
      scannerName: SCANNER_NAME || "Unknown",
      pcName: PC_NAME || "Unknown",
      fileName: path.basename(pdfPath),
      baseFolder: path.basename(path.dirname(pdfPath)),
      location: pdfPath,
      pageCount: 0,
      fileSizeInMB: fileSizeInMB,
      title: "N/A",
      author: "N/A",
      creationDate: "N/A",
    };
  }
}

// Add function to save PDF report to CSV
function savePDFReport(reportData) {
  if (!reportData) return;

  const csvLine = `"${reportData.timestamp}","${reportData.scannerName}","${reportData.pcName}","${reportData.fileName}","${reportData.baseFolder}","${reportData.location}","${reportData.pageCount}","${reportData.fileSizeInMB}","${reportData.title}","${reportData.author}","${reportData.creationDate}"\n`;

  // Create header if file doesn't exist
  if (!fs.existsSync(PDF_REPORT_FILE)) {
    const header = "Timestamp,ScannerName,PCName,FileName,BaseFolder,Location,PageCount,FileSizeMB,Title,Author,CreationDate\n";
    fs.writeFileSync(PDF_REPORT_FILE, header);
  }

  fs.appendFileSync(PDF_REPORT_FILE, csvLine);
}

// Move PDFs to linearized folder
async function moveToLinearizedFolder(folderPath, pdfs) {
  for (const file of pdfs) {
    const sourcePath = path.join(folderPath, file);
    const destPath = path.join(LINEARIZED_FOLDER, file);

    try {
      // Move the file
      fs.renameSync(sourcePath, destPath);
      logEvent(`📄 Moved ${file} to linearized folder`);
      logCsvEvent({
        folder: folderPath,
        file,
        status: "Pass",
        action: "Move to Linearized",
        message: `Moved to ${destPath}`,
      });
    } catch (err) {
      logEvent(`❌ Failed to move ${file}: ${err}`);
      logCsvEvent({
        folder: folderPath,
        file,
        status: "Fail",
        action: "Move to Linearized",
        message: err.toString(),
      });
    }
  }
}

// Clean up original folder
function cleanupOriginalFolder(folderPath) {
  try {
    fs.rmdirSync(folderPath);
    logEvent(`🗑️ Removed original folder: ${folderPath}`);
    logCsvEvent({
      folder: folderPath,
      file: "",
      status: "Pass",
      action: "Cleanup",
      message: "Original folder removed",
    });
  } catch (err) {
    logEvent(`⚠️ Failed to remove original folder: ${err}`);
    logCsvEvent({
      folder: folderPath,
      file: "",
      status: "Fail",
      action: "Cleanup",
      message: err.toString(),
    });
  }
}

// Stabilize and prepare folder
async function stabilizeAndPrepareFolder(folderPath) {
  logEvent(`📂 New folder detected: ${folderPath}`);
  logCsvEvent({ folder: folderPath, file: "", status: "Info", action: "Folder Detected", message: folderPath });

  await waitForFolderToStabilize(folderPath, 4000);

  const folderName = path.basename(folderPath);
  const files = fs.readdirSync(folderPath);
  const pdfs = files.filter((f) => f.toLowerCase().endsWith(".pdf"));

  if (pdfs.length === 0) {
    logEvent(`⚠️ No PDFs found in ${folderPath}`);
    logCsvEvent({ folder: folderPath, file: "", status: "Fail", action: "No PDFs", message: "No PDF files found" });
    cleanupOriginalFolder(folderPath);
    return null;
  }

  logEvent(`📄 ${pdfs.length} PDF(s) found in ${folderPath}`);
  logCsvEvent({ folder: folderPath, file: "", status: "Pass", action: "PDFs Found", message: `${pdfs.length} PDFs` });

  // Move PDFs to linearized folder before compression
  await moveToLinearizedFolder(folderPath, pdfs);

  // Clean up the original folder after moving files
  cleanupOriginalFolder(folderPath);

  return { folderName, pdfs };
}

// Generate PDF report
async function generateAndSaveReport(file, fullPath) {
  logEvent(`📊 Generating report for ${file}...`);
  const pdfReport = await generatePDFReport(fullPath);
  savePDFReport(pdfReport);
  logEvent(`📝 Report generated for ${file}`);
}

// Compress PDF in memory
async function compressPDFInMemory(inputPath) {
  const tempOutputPath = path.join(os.tmpdir(), `compressed_${Date.now()}_${path.basename(inputPath)}`);

  try {
    await compressPDF(inputPath, tempOutputPath);
    const compressedBuffer = fs.readFileSync(tempOutputPath);
    fs.unlinkSync(tempOutputPath); // Clean up temp file
    return compressedBuffer;
  } catch (err) {
    if (fs.existsSync(tempOutputPath)) {
      fs.unlinkSync(tempOutputPath); // Clean up temp file if it exists
    }
    throw err;
  }
}

// Process files in batches
function splitIntoBatches(files, batchSize) {
  const batches = [];
  for (let i = 0; i < files.length; i += batchSize) {
    batches.push(files.slice(i, i + batchSize));
  }
  return batches;
}

// Upload files to system API
async function uploadToSystem(files) {
  try {
    const formData = new FormData();

    // Process each file
    for (const filePath of files) {
      try {
        logEvent(`🔄 Compressing ${path.basename(filePath)} before upload`);

        // Compress the PDF
        const compressedBuffer = await compressPDFInMemory(filePath);

        // Create a Blob from the compressed buffer
        const blob = new Blob([compressedBuffer], { type: "application/pdf" });
        ƒˇ;
        // Add compressed file to form data
        formData.append("files", blob, path.basename(filePath));

        logEvent(`✅ Compressed ${path.basename(filePath)} successfully`);
      } catch (compressionError) {
        logEvent(`⚠️ Compression failed for ${path.basename(filePath)}, using original file: ${compressionError}`);
        // If compression fails, use original file
        const fileStream = fs.createReadStream(filePath);
        formData.append("files", fileStream);
      }
    }

    logEvent(`📤 Uploading batch of ${files.length} file(s) to system`);
    logCsvEvent({
      folder: UPLOAD_FOLDER,
      file: files.join(", "),
      status: "Info",
      action: "System Upload Started",
      message: "Initiating upload to system API",
    });

    const response = await fetch("https://devpahsu.paperevaluation.com/v1/assessment/answer-code-bulk", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Upload failed with status: ${response.status}`);
    }

    const result = await response.json();
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Move files after upload attempt
function moveFilesAfterUpload(files, success) {
  const targetFolder = success ? SYSTEM_UPLOADED : UPLOAD_ERROR;

  files.forEach((filePath) => {
    const fileName = path.basename(filePath);
    const targetPath = path.join(targetFolder, fileName);

    try {
      fs.renameSync(filePath, targetPath);
      logEvent(`${success ? "✅" : "❌"} Moved ${fileName} to ${path.basename(targetFolder)}`);
      logCsvEvent({
        folder: targetFolder,
        file: fileName,
        status: success ? "Pass" : "Fail",
        action: "Move After Upload",
        message: `Moved to ${targetFolder}`,
      });
    } catch (err) {
      logEvent(`❌ Error moving ${fileName}: ${err}`);
      logCsvEvent({
        folder: UPLOAD_FOLDER,
        file: fileName,
        status: "Fail",
        action: "Move After Upload",
        message: err.toString(),
      });
    }
  });
}

// Process files in upload folder
async function processUploadFolder() {
  const files = fs
    .readdirSync(UPLOAD_FOLDER)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => path.join(UPLOAD_FOLDER, f));

  if (files.length === 0) return;

  logEvent(`📄 Found ${files.length} PDF(s) to upload in upload folder`);

  // Split files into batches
  const batches = splitIntoBatches(files, MAX_FILES_PER_UPLOAD);
  logEvent(`📦 Split files into ${batches.length} batch(es) of maximum ${MAX_FILES_PER_UPLOAD} files`);

  // Process each batch
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    logEvent(`🔄 Processing batch ${i + 1} of ${batches.length} (${batch.length} files)`);

    const { success, result, error } = await uploadToSystem(batch);

    if (success) {
      logEvent(`✅ Successfully uploaded batch ${i + 1} (${batch.length} files)`);
      logCsvEvent({
        folder: UPLOAD_FOLDER,
        file: batch.join(", "),
        status: "Pass",
        action: "System Upload",
        message: JSON.stringify(result),
      });
      moveFilesAfterUpload(batch, true);
    } else {
      logEvent(`❌ Failed to upload batch ${i + 1}: ${error}`);
      logCsvEvent({
        folder: UPLOAD_FOLDER,
        file: batch.join(", "),
        status: "Fail",
        action: "System Upload",
        message: error,
      });
      moveFilesAfterUpload(batch, false);
    }

    // Add a small delay between batches
    if (i < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Setup upload folder watcher
function setupUploadWatcher() {
  // Create necessary folders if they don't exist
  [SYSTEM_UPLOADED, UPLOAD_ERROR].forEach((folder) => {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
  });

  const uploadWatcher = chokidar.watch(UPLOAD_FOLDER, {
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
  });

  uploadWatcher.on("add", async (filePath) => {
    if (!filePath.toLowerCase().endsWith(".pdf")) return;

    // Wait for potential additional files
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await processUploadFolder();
  });

  uploadWatcher.on("error", (error) => {
    logEvent(`❌ Upload folder watcher error: ${error}`);
    logCsvEvent({
      folder: UPLOAD_FOLDER,
      file: "",
      status: "Fail",
      action: "Watcher Error",
      message: error.toString(),
    });
  });

  logEvent(`📡 Watching upload folder for system uploads`);
  logCsvEvent({
    folder: UPLOAD_FOLDER,
    file: "",
    status: "Info",
    action: "Upload Watcher Started",
    message: "Started watching upload folder for system uploads",
  });
}

// Main runner
const main = async () => {
  if (!fs.existsSync(CSV_LOG_FILE)) {
    fs.writeFileSync(CSV_LOG_FILE, "Timestamp,Scanner,PC,Folder,File,Status,Action,Message\n");
  }

  await promptForFolders();

  // Setup all watchers
  const scanWatcher = chokidar.watch(SCANNED_FOLDER, {
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 10000,
      pollInterval: 500,
    },
    ignored: /(^|[\/\\])\../, // Ignore hidden files
  });

  // Handle new folders
  scanWatcher.on("addDir", (dirPath) => {
    if (dirPath !== SCANNED_FOLDER) {
      handleNewFolder(dirPath);
    }
  });

  // Handle new PDF files
  scanWatcher.on("add", (filePath) => {
    if (path.dirname(filePath) === SCANNED_FOLDER && filePath.toLowerCase().endsWith(".pdf")) {
      handleNewPDF(filePath);
    }
  });

  scanWatcher.on("error", (error) => {
    logEvent(`❌ Watcher error: ${error}`);
    logCsvEvent({ folder: SCANNED_FOLDER, file: "", status: "Fail", action: "Watcher Error", message: error.toString() });
  });

  logEvent(`📡 Watching folder: ${SCANNED_FOLDER}`);
  logCsvEvent({ folder: SCANNED_FOLDER, file: "", status: "Info", action: "Watcher Started", message: "Started watching scanned folder for PDFs and folders" });

  // Setup upload folder watcher
  setupUploadWatcher();
};

main();
